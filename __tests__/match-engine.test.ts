import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode } from '../src/core/errors.ts';
import { createMatchEngine, type TextMatch } from '../src/core/matcher.ts';
import { fsErrorMatcher } from './helpers.ts';

interface Flags {
  isRegex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

async function spans(needle: string, text: string, flags: Flags = {}): Promise<[number, number][]> {
  const engine = createMatchEngine(needle, { isRegex: false, caseSensitive: true, ...flags });
  try {
    const out: [number, number][] = [];
    for await (const m of engine.matches(text)) out.push([m.start, m.end]);
    return out;
  } finally {
    engine.dispose();
  }
}
const crosses = (needle: string, isRegex = true): boolean => {
  const engine = createMatchEngine(needle, { isRegex, caseSensitive: true });
  try {
    return engine.crossesLines;
  } finally {
    engine.dispose();
  }
};
const re = { isRegex: true };

describe('MatchEngine', () => {
  // crossesLines: line-bound
  for (const p of [
    'foo',
    'a.b',
    '^a$',
    '\\d+\\w*',
    'a\\.b',
    '\\bfoo\\b',
    '[abc]+',
    'a|b',
    '\\S+',
    'a\\tb',
    '[a-z]+',
    '[A-Za-z0-9_-]+',
  ])
    it(`${p} cannot cross a line`, () => assert.equal(crosses(p), false));

  // crossesLines: Review Focus 3
  for (const p of [
    'a\\nb',
    'a\\s+b',
    '[^x]',
    '\\W',
    '\\D',
    '\\x0a',
    '\\p{Cc}',
    '(?s)a.b',
    '[[:space:]]',
    'a\nb',
    '\\Afoo',
    'foo\\z',
    '\\Qa\\E',
    '\\012',
    '\\r',
    '[\\t-~]+',
    'a[\\t-\\-]b',
    `[${String.fromCharCode(1)}-~]+`,
    '[\\b-~]',
    // A known conservative false positive: a tab then `-x`, outside any class.
    '\\t-x',
  ])
    it(`${JSON.stringify(p)} may cross a line`, () => assert.equal(crosses(p), true));

  it('a literal crosses a line only when it holds a newline', () => {
    assert.equal(crosses('a.b[^x]', false), false);
    assert.equal(crosses('a\nb', false), true);
  });

  it('^ and $ match once per line and not after the final newline', async () => {
    assert.deepEqual(await spans('^', 'a\nb\n', re), [
      [0, 0],
      [2, 2],
    ]);
    assert.deepEqual(await spans('$', 'a\nb\n', re), [
      [1, 1],
      [3, 3],
    ]);
  });

  it('an empty text has no lines', async () => {
    assert.deepEqual(await spans('^', '', re), []);
  });

  it('$ matches before a CR a mixed-ending file kept', async () => {
    assert.deepEqual(await spans('foo$', 'foo\r\nbar\n', re), [[0, 3]]);
  });

  it('a regex that can cross a line matches across it', async () => {
    assert.deepEqual(await spans('a\\s+b', 'a\nb\n', re), [[0, 3]]);
  });

  it('a dot never crosses a line', async () => {
    assert.deepEqual(await spans('a.b', 'a\nb\naxb', re), [[4, 7]]);
  });

  it('a literal with a newline matches across lines natively', async () => {
    assert.deepEqual(await spans('a\nb', 'xa\nb\n'), [[1, 4]]);
  });

  it('offsets are UTF-16 units after an astral character on an earlier line', async () => {
    assert.deepEqual(await spans('b+', '😀\nabb', re), [[4, 6]]);
  });

  it('a case-insensitive literal folds ASCII only', async () => {
    assert.deepEqual(await spans('k', 'K K', { caseSensitive: false }), [
      [0, 1],
      [2, 3],
    ]);
  });

  it('wholeWord reports the needle without its boundaries, with only its own groups', async () => {
    const engine = createMatchEngine('(c)(?<rest>at)', {
      isRegex: true,
      caseSensitive: true,
      wholeWord: true,
    });
    try {
      const found: TextMatch[] = [];
      for await (const m of engine.matches('x\n cat.')) found.push(m);
      assert.deepEqual(found, [
        { start: 3, end: 6, text: 'cat', groups: ['c', 'at'], named: { rest: 'at' } },
      ]);
    } finally {
      engine.dispose();
    }
  });

  it('wholeWord skips a match inside a word', async () => {
    assert.deepEqual(await spans('cat', 'cat concat\ncat', { wholeWord: true }), [
      [0, 3],
      [11, 14],
    ]);
  });

  it('a line-bound regex matches a text over 4 MiB', async () => {
    const text =
      'x'
        .repeat(1024)
        .concat('\n')
        .repeat(5 * 1024) + 'needle1\n';
    assert.equal((await spans('needle\\d', text, re)).length, 1);
  });

  it('a regex that can cross a line refuses a text over 4 MiB', async () => {
    const text = 'x'
      .repeat(1024)
      .concat('\n')
      .repeat(5 * 1024);
    await assert.rejects(spans('a\\s+b', text, re), fsErrorMatcher(ErrorCode.TOO_LARGE));
  });

  it('a case-sensitive literal matches a text over 4 MiB without the regex engine', async () => {
    const text = 'x'.repeat(5 * 1024 * 1024) + 'needle';
    assert.equal((await spans('needle', text)).length, 1);
  });

  it('stops when the signal aborts', async () => {
    const engine = createMatchEngine('a', { isRegex: true, caseSensitive: true });
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    try {
      await assert.rejects(async () => {
        for await (const m of engine.matches('a'.repeat(10), { signal: controller.signal })) {
          assert.fail(`matched at ${String(m.start)} after abort`);
        }
      }, /stop/);
    } finally {
      engine.dispose();
    }
  });
});
