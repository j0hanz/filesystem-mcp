import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isFsError } from '../src/core/errors.ts';
import { createMatchEngine, planMatch, type ReplaceLimits } from '../src/core/matcher.ts';
import { viewText } from '../src/core/text-view.ts';

// planMatch is the single Match plan entry (GLOSSARY.md): what a search or a
// replacement settles about its needle before any text is read — the native
// literal pass when the needle allows one, and the RE2 source otherwise.
describe('planMatch', () => {
  it('PLAN-001: a case-sensitive literal needle keeps a literal pass and an escaped source', () => {
    const plan = planMatch('a.b', { isRegex: false, caseSensitive: true });
    assert.ok(plan.literal, 'a plain needle earns a literal pass');
    assert.strictEqual(plan.literal.needsRe2('aKb'), false);
    assert.strictEqual(plan.source, RegExp.escape('a.b'));
  });

  it('PLAN-002: a regex needle has no literal pass and a raw source', () => {
    const plan = planMatch('a+', { isRegex: true, caseSensitive: false });
    assert.strictEqual(plan.literal, undefined);
    assert.strictEqual(plan.source, 'a+');
  });

  it('PLAN-003: needles RE2 must judge earn no literal pass', () => {
    assert.strictEqual(planMatch('�', { isRegex: false, caseSensitive: true }).literal, undefined);
    assert.strictEqual(
      planMatch('\uD800', { isRegex: false, caseSensitive: true }).literal,
      undefined,
    );
    assert.strictEqual(
      planMatch('\uD800', { isRegex: false, caseSensitive: false }).literal,
      undefined,
    );
    assert.strictEqual(planMatch('é', { isRegex: false, caseSensitive: false }).literal, undefined);
  });

  it('PLAN-004: wholeWord wraps the source in boundary groups, literal or regex', () => {
    const word = String.raw`([^\p{L}\p{N}\p{M}_])`;
    assert.strictEqual(
      planMatch('foo', { isRegex: false, caseSensitive: false, wholeWord: true }).source,
      // RegExp.escape spells 'f' as \x66 — \f would read as a form-feed escape — so
      // the literal needle arrives in the boundary groups already escaped.
      `${word}(?:\\x66oo)${word.slice(0, -1)}|$)`,
    );
    assert.strictEqual(
      planMatch('a+', { isRegex: true, caseSensitive: true, wholeWord: true }).source,
      `${word}(?:a+)${word.slice(0, -1)}|$)`,
    );
  });

  it('PLAN-005: a case-insensitive literal bails to RE2 on fold characters, on either form', () => {
    const plan = planMatch('k', { isRegex: false, caseSensitive: false });
    assert.ok(plan.literal);
    assert.strictEqual(plan.literal.needsRe2('aKb'), true, 'Kelvin sign folds onto k');
    assert.strictEqual(
      plan.literal.needsRe2(Buffer.from('aKb', 'utf-8')),
      true,
      'the Buffer form of the same text',
    );
    assert.strictEqual(plan.literal.needsRe2('abc'), false);
  });
});

const limits = (maxMatches = Number.POSITIVE_INFINITY): ReplaceLimits => ({
  maxMatches,
  maxBytes: 10 * 1024 * 1024,
  path: 'matcher-test',
});

async function replaceWith(
  needle: string,
  flags: { isRegex: boolean; caseSensitive: boolean; wholeWord?: boolean },
  text: string,
  replacement: string,
  replaceLimits: ReplaceLimits = limits(),
): Promise<{ content: string; matchCount: number; more: boolean }> {
  const engine = createMatchEngine(needle, flags);
  try {
    return await engine.replace(viewText(text), replacement, {
      expand: flags.isRegex,
      limits: replaceLimits,
    });
  } finally {
    engine.dispose();
  }
}

const regex = { isRegex: true, caseSensitive: true };

describe('replaceMatches', () => {
  it('MTCH-001: dollar tokens follow RegExp precedence', async () => {
    assert.strictEqual(
      (await replaceWith('(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)', regex, 'abcdefghijkl', '$12'))
        .content,
      'l',
      '$12 prefers group 12',
    );
    assert.strictEqual(
      (await replaceWith('(a)(b)', regex, 'ab', '$12')).content,
      'a2',
      '$12 with two groups falls back to group 1 plus a literal 2',
    );
    assert.strictEqual(
      (await replaceWith('(a)', regex, 'a', '$2')).content,
      '$2',
      'an out-of-range group stays literal',
    );
    assert.strictEqual((await replaceWith('(?<x>a)', regex, 'a', '$<x>')).content, 'a');
    assert.strictEqual(
      (await replaceWith('(?<x>a)', regex, 'a', '$<y>')).content,
      '$<y>',
      'an absent named group renders literally',
    );
    assert.strictEqual(
      (await replaceWith('b', regex, 'abc', "$&$`$'")).content,
      'abacc',
      'whole match, before, and after',
    );
  });

  it('MTCH-002: wholeWord resumes over the trail and finds a match at text start', async () => {
    const word = { isRegex: false, caseSensitive: false, wholeWord: true };
    const done = await replaceWith('foo', word, 'foo foo foo', 'X');
    assert.strictEqual(done.content, 'X X X');
    assert.strictEqual(done.matchCount, 3);

    const atStart = await replaceWith('foo', word, 'foo bar', 'X');
    assert.strictEqual(atStart.content, 'X bar', 'a match right after TEXT_START is found (#158)');

    const lead = await replaceWith('foo', word, 'afoo foo', 'X');
    assert.strictEqual(lead.content, 'afoo X', 'a word-char lead is no boundary');

    const verbatim = await replaceWith('foo', word, 'foo', '$&');
    assert.strictEqual(verbatim.content, '$&', 'a literal replacement is inserted verbatim');

    // A consumed text ending in a non-word char backs up, so its last char may
    // lead the next match: the needle's final '-' leads here (the wire twin is
    // tools.test.ts 'wholeWord lets a needle trailing non-word char lead the next match').
    const trail = await replaceWith('-x-', word, '-x--x-', 'X');
    assert.strictEqual(trail.content, 'XX');
    assert.strictEqual(trail.matchCount, 2);
  });

  it('MTCH-003: a case-sensitive literal splices once and honours the cap', async () => {
    const literal = { isRegex: false, caseSensitive: true };
    const done = await replaceWith('foo', literal, 'foo foo foo', 'X', limits(2));
    assert.strictEqual(done.content, 'X X foo');
    assert.strictEqual(done.matchCount, 2);
    assert.strictEqual(done.more, true);
  });

  it('MTCH-004: a case-insensitive literal folds, and RE2 judges fold characters', async () => {
    const folding = { isRegex: false, caseSensitive: false };
    const done = await replaceWith('foo', folding, 'FOO foo FOO', 'X');
    assert.strictEqual(done.content, 'X X X');
    assert.strictEqual(done.matchCount, 3);

    const judged = await replaceWith('k', folding, 'a\u212Ab', 'X');
    assert.strictEqual(judged.content, 'aXb');
    assert.strictEqual(judged.matchCount, 1);
  });

  it('MTCH-005: dispose is idempotent', async () => {
    const engine = createMatchEngine('a', regex);
    await engine.replace(viewText('a'), 'b', { expand: true, limits: limits() });
    engine.dispose();
    engine.dispose();
  });

  it('MTCH-006: a replacement past the byte cap refuses', async () => {
    await assert.rejects(
      replaceWith(
        'foo',
        { isRegex: false, caseSensitive: true },
        'foofoo',
        'way-too-long-replacement',
        {
          maxMatches: Number.POSITIVE_INFINITY,
          maxBytes: 4,
          path: 'matcher-test',
        },
      ),
      (error: unknown) => isFsError(error),
    );
  });
});
