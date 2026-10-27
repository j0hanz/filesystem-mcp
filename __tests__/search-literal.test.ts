import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { PathGuard } from '../src/core/path.ts';
import { searchContent } from '../src/core/search.ts';
import { escapeRegExp } from '../src/core/util.ts';
import { cleanupTestRoot, createTestRoot, makeGuard } from './helpers.ts';

const KELVIN = String.fromCodePoint(0x212a); // RE2 folds it onto k
const LONG_S = String.fromCodePoint(0x017f); // RE2 folds it onto s
const DOTTED_I = String.fromCodePoint(0x0130); // RE2 does not fold it onto i
const EMOJI = String.fromCodePoint(0x1f600);
const REPLACEMENT = String.fromCodePoint(0xfffd);

// A literal needle is matched natively instead of through RE2. Every case runs
// both ways — as a literal, and as the same text escaped into a regex, which
// RE2 matches — and the two must report the same lines, columns and counts.
const CASES: { name: string; content: string | Buffer; needle: string; hits: number }[] = [
  { name: 'Kelvin sign', content: `x ${KELVIN}ey\nkey KEY\n`, needle: 'key', hits: 2 },
  { name: 'long s', content: `${LONG_S}tate STATE\nstate\n`, needle: 'state', hits: 2 },
  { name: 'dotted capital I', content: `${DOTTED_I}d id ID\n`, needle: 'id', hits: 1 },
  {
    name: 'astral text before the match',
    content: `${EMOJI}${EMOJI} Needle needle\n`,
    needle: 'needle',
    hits: 1,
  },
  { name: 'overlapping occurrences', content: 'aaaa aa\naAaA\n', needle: 'aa', hits: 2 },
  {
    name: 'invalid UTF-8',
    content: Buffer.concat([Buffer.from('ab'), Buffer.from([0xff]), Buffer.from('cd needle\n')]),
    needle: 'needle',
    hits: 1,
  },
  {
    name: 'a needle holding U+FFFD',
    content: Buffer.concat([Buffer.from('b'), Buffer.from([0xff]), Buffer.from('c\n')]),
    needle: `b${REPLACEMENT}c`,
    hits: 1,
  },
  { name: 'CRLF lines', content: 'one needle\r\ntwo\r\nneedle\r\n', needle: 'needle', hits: 2 },
  { name: 'mixed-case needle', content: 'needle NEEDLE\nnEeDlE\n', needle: 'NeEdLe', hits: 2 },
  { name: 'non-ASCII needle', content: 'STRASSE straße Straße\n', needle: 'Straße', hits: 1 },
  { name: 'Latin-1 letters', content: 'É e E é\n', needle: 'e', hits: 1 },
  { name: 'regex metacharacters', content: 'a.b*c axbbc a.B*C\n', needle: 'a.b*c', hits: 1 },
  { name: 'no match', content: 'nothing here\n', needle: 'needle', hits: 0 },
];

describe('literal search matches what RE2 would', () => {
  let root: string;
  let guard: PathGuard;

  before(async () => {
    root = await createTestRoot();
    guard = await makeGuard([root]);
  });

  after(async () => {
    await cleanupTestRoot(root);
  });

  for (const [index, { name, content, needle, hits }] of CASES.entries()) {
    for (const caseSensitive of [true, false]) {
      it(`${name}, ${caseSensitive ? 'case-sensitive' : 'case-insensitive'}`, async () => {
        const file = join(root, `case-${String(index)}.txt`);
        await writeFile(file, content);
        const search = async (pattern: string, isRegex: boolean) =>
          (
            await searchContent(
              { root, explicitFile: file },
              pattern,
              { isRegex, caseSensitive, maxResults: 1000 },
              guard,
            )
          ).matches;
        const literal = await search(needle, false);
        assert.deepStrictEqual(literal, await search(escapeRegExp(needle), true));
        if (!caseSensitive) assert.strictEqual(literal.length, hits);
      });
    }
  }
});

// procfs reports a size of 0 for files that hold text; a read sized by fstat
// would search them as empty.
describe('a file whose size reads as 0 while it holds text', () => {
  const procDir = `/proc/${String(process.pid)}`;
  const skip = !existsSync(join(procDir, 'status')) && 'needs Linux procfs';

  for (const isRegex of [false, true]) {
    it(`is searched to its end (${isRegex ? 'regex' : 'literal'})`, { skip }, async () => {
      const guard = await makeGuard([procDir]);
      const outcome = await searchContent(
        { root: procDir, explicitFile: join(procDir, 'status') },
        'Name',
        { isRegex, caseSensitive: true },
        guard,
      );
      assert.strictEqual(outcome.summary.filesMatched, 1, JSON.stringify(outcome.summary));
    });
  }
});

// A search reads a file in chunks and checks its signal before each, as
// FileHandle#readFile did, so a cancelled search stops reading at the next one.
describe('reading a file for a search', () => {
  let root: string;

  before(async () => {
    root = await createTestRoot();
  });

  after(async () => {
    await cleanupTestRoot(root);
  });

  it('stops before the next chunk once the search is cancelled', async () => {
    const file = join(root, 'three-chunks.txt');
    await writeFile(file, 'x'.repeat(3 * 512 * 1024));
    const probe = await open(file);
    const proto = Object.getPrototypeOf(probe) as {
      read: (...args: unknown[]) => Promise<unknown>;
    };
    await probe.close();
    const original = proto.read;
    const controller = new AbortController();
    let reads = 0;
    proto.read = async function (this: unknown, ...args: unknown[]) {
      reads++;
      const result = await original.apply(this, args);
      controller.abort();
      return result;
    };
    try {
      const outcome = await searchContent(
        { root, explicitFile: file },
        'needle',
        { isRegex: false, signal: controller.signal },
        await makeGuard([root]),
      );
      assert.strictEqual(reads, 1, 'no read after the cancel');
      assert.strictEqual(outcome.summary.filesScanned, 0, JSON.stringify(outcome.summary));
      assert.strictEqual(outcome.summary.stoppedReason, 'timeout');
    } finally {
      proto.read = original;
    }
  });
});
