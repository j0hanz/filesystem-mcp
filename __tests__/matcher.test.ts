import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isFsError } from '../src/core/errors.ts';
import {
  compileRegex,
  createCaseInsensitiveLiteralMatcher,
  createCaseSensitiveLiteralMatcher,
  createRegexReplacementMatcher,
  planMatch,
  type ReplaceLimits,
} from '../src/core/matcher.ts';
import { escapeRegExp } from '../src/core/util.ts';

// planMatch is the single Match plan entry (GLOSSARY.md): what a search or a
// replacement settles about its needle before any text is read — the native
// literal pass when the needle allows one, and the RE2 source otherwise.
describe('planMatch', () => {
  it('PLAN-001: a case-sensitive literal needle keeps a literal pass and an escaped source', () => {
    const plan = planMatch('a.b', { isRegex: false, caseSensitive: true });
    assert.ok(plan.literal, 'a plain needle earns a literal pass');
    assert.strictEqual(plan.literal.needsRe2('aKb'), false);
    assert.strictEqual(plan.source, escapeRegExp('a.b'));
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
      // escapeRegExp spells 'f' as \x66 — \f would read as a form-feed escape — so
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

describe('replacement matchers', () => {
  it('MTCH-001: dollar tokens follow RegExp precedence', async () => {
    const twelve = createRegexReplacementMatcher(
      compileRegex('(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)', { caseSensitive: true }),
      true,
      false,
    );
    assert.strictEqual(
      (await twelve.replace('abcdefghijkl', '$12', undefined, limits())).content,
      'l',
      '$12 prefers group 12',
    );

    const two = createRegexReplacementMatcher(
      compileRegex('(a)(b)', { caseSensitive: true }),
      true,
      false,
    );
    assert.strictEqual(
      (await two.replace('ab', '$12', undefined, limits())).content,
      'a2',
      '$12 with two groups falls back to group 1 plus a literal 2',
    );

    const one = createRegexReplacementMatcher(
      compileRegex('(a)', { caseSensitive: true }),
      true,
      false,
    );
    assert.strictEqual(
      (await one.replace('a', '$2', undefined, limits())).content,
      '$2',
      'an out-of-range group stays literal',
    );

    const named = createRegexReplacementMatcher(
      compileRegex('(?<x>a)', { caseSensitive: true }),
      true,
      false,
    );
    assert.strictEqual((await named.replace('a', '$<x>', undefined, limits())).content, 'a');
    assert.strictEqual(
      (await named.replace('a', '$<y>', undefined, limits())).content,
      '$<y>',
      'an absent named group renders literally',
    );

    const whole = createRegexReplacementMatcher(
      compileRegex('b', { caseSensitive: true }),
      true,
      false,
    );
    assert.strictEqual(
      (await whole.replace('abc', "$&$`$'", undefined, limits())).content,
      'abacc',
      'whole match, before, and after',
    );
    twelve.dispose();
    two.dispose();
    one.dispose();
    named.dispose();
    whole.dispose();
  });

  it('MTCH-002: wholeWord resumes over the trail and finds a match at text start', async () => {
    const plan = planMatch('foo', { isRegex: false, caseSensitive: false, wholeWord: true });
    const matcher = createRegexReplacementMatcher(
      compileRegex(plan.source, { caseSensitive: false }),
      false,
      true,
    );
    const done = await matcher.replace('foo foo foo', 'X', undefined, limits());
    assert.strictEqual(done.content, 'X X X');
    assert.strictEqual(done.matchCount, 3);

    const atStart = await matcher.replace('foo bar', 'X', undefined, limits());
    assert.strictEqual(atStart.content, 'X bar', 'a match right after TEXT_START is found (#158)');

    const lead = await matcher.replace('afoo foo', 'X', undefined, limits());
    assert.strictEqual(lead.content, 'afoo X', 'a word-char lead is no boundary');

    const verbatim = await matcher.replace('foo', '$&', undefined, limits());
    assert.strictEqual(verbatim.content, '$&', 'a literal replacement is inserted verbatim');

    // A consumed text ending in a non-word char backs up, so its last char may
    // lead the next match: the needle's final '-' leads here (the wire twin is
    // tools.test.ts 'wholeWord lets a needle trailing non-word char lead the next match').
    const trailPlan = planMatch('-x-', { isRegex: false, caseSensitive: false, wholeWord: true });
    const trailMatcher = createRegexReplacementMatcher(
      compileRegex(trailPlan.source, { caseSensitive: false }),
      false,
      true,
    );
    const trail = await trailMatcher.replace('-x--x-', 'X', undefined, limits());
    assert.strictEqual(trail.content, 'XX');
    assert.strictEqual(trail.matchCount, 2);

    trailMatcher.dispose();
    matcher.dispose();
  });

  it('MTCH-003: the case-sensitive literal splices once and honours the cap', async () => {
    const matcher = createCaseSensitiveLiteralMatcher('foo');
    assert.ok(matcher);
    const done = await matcher.replace('foo foo foo', 'X', undefined, limits(2));
    assert.strictEqual(done.content, 'X X foo');
    assert.strictEqual(done.matchCount, 2);
    assert.strictEqual(done.more, true);

    assert.strictEqual(createCaseSensitiveLiteralMatcher('�'), undefined);
    assert.strictEqual(createCaseSensitiveLiteralMatcher('\uD800'), undefined);

    matcher.dispose();
  });

  it('MTCH-004: the case-insensitive literal folds and delegates fold characters to RE2', async () => {
    const plan = planMatch('foo', { isRegex: false, caseSensitive: false });
    assert.ok(plan.literal);
    const matcher = createCaseInsensitiveLiteralMatcher(
      'foo',
      plan.literal,
      createRegexReplacementMatcher(
        compileRegex(plan.source, { caseSensitive: false }),
        false,
        false,
      ),
    );
    const done = await matcher.replace('FOO foo FOO', 'X', undefined, limits());
    assert.strictEqual(done.content, 'X X X');
    assert.strictEqual(done.matchCount, 3);

    const kelvinPlan = planMatch('k', { isRegex: false, caseSensitive: false });
    assert.ok(kelvinPlan.literal);
    const kelvin = createCaseInsensitiveLiteralMatcher(
      'k',
      kelvinPlan.literal,
      createRegexReplacementMatcher(
        compileRegex(kelvinPlan.source, { caseSensitive: false }),
        false,
        false,
      ),
    );
    const judged = await kelvin.replace('aKb', 'X', undefined, limits());
    assert.strictEqual(judged.content, 'aXb');
    assert.strictEqual(judged.matchCount, 1);

    matcher.dispose();
    kelvin.dispose();
  });

  it('MTCH-005: dispose is idempotent', () => {
    const matcher = createRegexReplacementMatcher(
      compileRegex('a', { caseSensitive: true }),
      false,
      false,
    );
    matcher.dispose();
    matcher.dispose();
  });

  it('MTCH-006: a replacement past the byte cap refuses', async () => {
    const matcher = createCaseSensitiveLiteralMatcher('foo');
    assert.ok(matcher);
    await assert.rejects(
      async () =>
        matcher.replace('foofoo', 'way-too-long-replacement', undefined, {
          maxMatches: Number.POSITIVE_INFINITY,
          maxBytes: 4,
          path: 'matcher-test',
        }),
      (error: unknown) => isFsError(error),
    );

    matcher.dispose();
  });
});
