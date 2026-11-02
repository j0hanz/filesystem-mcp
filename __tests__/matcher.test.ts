import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planMatch } from '../src/core/matcher.ts';
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
