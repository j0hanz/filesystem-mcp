import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';

import { diffStatsFromPatch, unifiedPatch } from '../src/core/diff.ts';
import { ErrorCode, FsError } from '../src/core/errors.ts';
import { DIFF } from '../src/tools/diff.ts';
import { cleanupTestRoot, createTestRoot, makeGuard, writeTestFile } from './helpers.ts';
import { runToolBodyResult } from './tool-harness.ts';

const lines = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`).join('\n') + '\n';

describe('core/diff', () => {
  it('counts added and removed lines from a patch', () => {
    const a = 'one\ntwo\nthree\n';
    const b = 'one\n2\nthree\nfour\n';
    const patch = unifiedPatch('f', a, b);
    assert.ok(patch);
    assert.deepStrictEqual(diffStatsFromPatch(patch), { linesAdded: 2, linesRemoved: 1 });
  });

  it('counts content lines that start with -- or ++ (not just the file header)', () => {
    const a = '---\ntitle: x\n---\nbody\n';
    const b = 'title: x\nbody\n++new\n';
    const patch = unifiedPatch('f', a, b);
    assert.ok(patch);
    assert.deepStrictEqual(diffStatsFromPatch(patch), { linesAdded: 1, linesRemoved: 2 });
  });

  it('gives up past the deadline instead of blocking', () => {
    const a = lines('a', 4000);
    const b = lines('b', 4000);
    assert.strictEqual(unifiedPatch('f', a, b, 1), undefined);
  });
});

// Payload assembly of the diff tool, driven through the tool body with no MCP
// pair (the wire-level response shape is the executor's, pinned in
// tools.test.ts).
describe('diff body', () => {
  let root: string;
  let guard: Awaited<ReturnType<typeof makeGuard>>;

  before(async () => {
    root = await createTestRoot();
    guard = await makeGuard([root]);
  });

  after(async () => {
    await cleanupTestRoot(root);
  });

  it('returns a unified diff with per-file line counts (#TC-FUNC-060)', async () => {
    const a = await writeTestFile(root, 'diff_a.txt', 'x\ny\nz\n');
    const b = await writeTestFile(root, 'diff_b.txt', 'x\nY\nz\n');
    const result = await runToolBodyResult(DIFF, { a, b }, { guard });
    assert.strictEqual(result.structured.linesAdded, 1);
    assert.strictEqual(result.structured.linesRemoved, 1);
    // The diff itself is the one copy: the authored text, not the metadata.
    assert.ok(result.text?.includes('-y') && result.text?.includes('+Y'));
  });

  it('reports "too large" instead of freezing on files that share no lines', async () => {
    const a = await writeTestFile(root, 'diff_huge/a.txt', lines('a', 8000));
    const b = await writeTestFile(root, 'diff_huge/b.txt', lines('b', 8000));
    const started = Date.now();
    await assert.rejects(
      () => runToolBodyResult(DIFF, { a, b }, { guard }),
      (err) =>
        err instanceof FsError &&
        err.code === ErrorCode.TOO_LARGE &&
        err.message.includes('Diff not computed'),
    );
    assert.ok(Date.now() - started < 5000, 'the diff must give up within its deadline');
  });

  it('refuses a non-UTF-8 file and leaves its bytes intact', async () => {
    const path = await writeTestFile(root, 'nonutf8/late.txt', '');
    // First 512 bytes are plain ASCII; the bad byte (0xe9) lands past the binary probe.
    const bytes = Buffer.concat([
      Buffer.from('a'.repeat(600) + '\nhello\n'),
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    ]);
    await writeFile(path, bytes);

    // The same file against itself would be an empty diff, so a refusal here
    // can only come from the strict-UTF-8 check.
    await assert.rejects(
      () => runToolBodyResult(DIFF, { a: path, b: path }, { guard }),
      (err) => err instanceof FsError && err.code === ErrorCode.INVALID_INPUT,
    );
    assert.deepStrictEqual(await readFile(path), bytes);
  });
});
