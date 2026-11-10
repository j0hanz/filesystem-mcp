import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode } from '../src/core/errors.ts';
import {
  createLfEngine,
  createMatchEngine,
  replaceMatches,
  type TextMatch,
} from '../src/core/matcher.ts';
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

  it('a pattern that can cross a line matches nothing after the final newline', async () => {
    assert.deepEqual(await spans('^\\s*$', 'a\n\nb\n', re), [[2, 2]]);
    assert.deepEqual(await spans('(?m)^', 'a\nb\n', re), [
      [0, 0],
      [2, 2],
    ]);
  });

  it('a pattern that can cross a line matches nothing in an empty text', async () => {
    assert.deepEqual(await spans('^\\s*', '', re), []);
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

  it('wholeWord keeps ^ at the start of each line', async () => {
    assert.deepEqual(await spans('^foo', 'foo bar\nfoo', { ...re, wholeWord: true }), [
      [0, 3],
      [8, 11],
    ]);
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

  it('createLfEngine matches a literal typed with CRLF in LF view text, and skips a regex', async () => {
    const flags = { isRegex: false, caseSensitive: true };
    assert.equal(createLfEngine('one', flags), undefined);
    assert.equal(createLfEngine('one\r\ntwo', { ...flags, isRegex: true }), undefined);
    const lf = createLfEngine('one\r\ntwo', flags);
    assert.ok(lf);
    try {
      const found: number[] = [];
      for await (const m of lf.matches('one\ntwo\n')) found.push(m.start);
      assert.deepEqual(found, [0]);
    } finally {
      lf.dispose();
    }
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

  for (const [label, needle, flags] of [
    ['a literal', 'a', {}],
    ['a case-insensitive literal', 'A', { caseSensitive: false }],
    ['a regex', 'a+?', re],
    ['a wholeWord regex', 'a', { ...re, wholeWord: true }],
  ] as [string, string, Flags][]) {
    it(`${label} yields maxPerLine matches from a line, then goes on to the next`, async () => {
      const engine = createMatchEngine(needle, { isRegex: false, caseSensitive: true, ...flags });
      const text = flags.wholeWord === true ? 'a a a a a\na a\n' : 'aaaaa\naa\n';
      try {
        const starts: number[] = [];
        for await (const m of engine.matches(text, { maxPerLine: 2 })) starts.push(m.start);
        assert.deepEqual(starts, flags.wholeWord === true ? [0, 2, 10, 12] : [0, 1, 6, 7]);
      } finally {
        engine.dispose();
      }
    });
  }
});

const LIMITS = { maxMatches: 1000, maxBytes: 1 << 20, path: 'p' };

async function rep(
  needle: string,
  text: string,
  replacement: string,
  flags: Flags = {},
): Promise<string> {
  const engine = createMatchEngine(needle, { isRegex: false, caseSensitive: true, ...flags });
  try {
    const done = await replaceMatches(engine, text, replacement, {
      expand: Boolean(flags.isRegex),
      limits: LIMITS,
    });
    return done.content;
  } finally {
    engine.dispose();
  }
}

describe('replaceMatches', () => {
  it('^ follows the lines a search reports', async () => {
    assert.equal(await rep('^', 'a\nb\n', 'x', re), 'xa\nxb\n');
    assert.equal(await rep('$', 'a\nb\n', 'x', re), 'ax\nbx\n');
    assert.equal(await rep('^', '', 'x', re), '');
  });

  it('a pattern that can cross a line adds nothing after the final newline or to an empty text', async () => {
    assert.equal(await rep('^\\s*$', 'a\n\nb\n', 'X', re), 'a\nX\nb\n');
    assert.equal(await rep('(?m)^', 'a\nb\n', 'X', re), 'Xa\nXb\n');
    assert.equal(await rep('^\\s*', '', 'X', re), '');
  });

  it('expands $1 and $& for a regex only', async () => {
    assert.equal(await rep('(a)(b)', 'ab', '$2$1-$&', re), 'ba-ab');
    assert.equal(await rep('ab', 'ab', '$&', {}), '$&');
  });

  it("$` and $' see the whole text, not the line", async () => {
    assert.equal(await rep('b', 'a\nb\nc', "[$`|$']", re), 'a\n[a\n|\nc]\nc');
  });

  it('stops at maxMatches and says more', async () => {
    const engine = createMatchEngine('a', { isRegex: false, caseSensitive: true });
    try {
      const done = await replaceMatches(engine, 'aaa', 'x', {
        expand: false,
        limits: { ...LIMITS, maxMatches: 1 },
      });
      assert.deepEqual(done, { content: 'xaa', matchCount: 1, more: true });
    } finally {
      engine.dispose();
    }
  });

  it('refuses a result past maxBytes', async () => {
    const engine = createMatchEngine('a', { isRegex: false, caseSensitive: true });
    try {
      await assert.rejects(
        replaceMatches(engine, 'aa', 'xxxx', { expand: false, limits: { ...LIMITS, maxBytes: 4 } }),
        fsErrorMatcher(ErrorCode.TOO_LARGE),
      );
    } finally {
      engine.dispose();
    }
  });
});

describe('a search previews its replacement', () => {
  const cases: { needle: string; flags: Flags; text: string; lines: number[]; count: number }[] = [
    { needle: 'foo$', flags: re, text: 'foo\nfoo bar\nfoo\n', lines: [1, 3], count: 2 },
    { needle: '^', flags: re, text: 'a\nb\n', lines: [1, 2], count: 2 },
    { needle: 'a\\s+b', flags: re, text: 'a\nb\na b\n', lines: [1, 3], count: 2 },
    { needle: 'K', flags: { caseSensitive: false }, text: 'k\nK\nK\n', lines: [1, 2, 3], count: 3 },
    { needle: 'a\nb', flags: {}, text: 'a\nb\na\nb', lines: [1, 3], count: 2 },
    { needle: '^\\s*$', flags: re, text: 'a\n\nb\n', lines: [2], count: 1 },
    { needle: '(?m)^', flags: re, text: 'a\nb\n', lines: [1, 2], count: 2 },
    { needle: '^\\s*', flags: re, text: '', lines: [], count: 0 },
  ];
  for (const c of cases) {
    it(`${JSON.stringify(c.needle)} in ${JSON.stringify(c.text)}`, async () => {
      const engine = createMatchEngine(c.needle, {
        isRegex: false,
        caseSensitive: true,
        ...c.flags,
      });
      try {
        const starts = new Set<number>();
        for await (const m of engine.matches(c.text)) {
          starts.add(c.text.slice(0, m.start).split('\n').length);
        }
        assert.deepEqual([...starts], c.lines);
        const done = await replaceMatches(engine, c.text, '#', {
          expand: Boolean(c.flags.isRegex),
          limits: LIMITS,
        });
        assert.equal(done.matchCount, c.count);
      } finally {
        engine.dispose();
      }
    });
  }
});
