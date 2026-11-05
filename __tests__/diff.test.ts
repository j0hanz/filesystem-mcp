import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';

import { createTwoFilesPatch, parsePatch } from 'diff';

import { diffStatsFromPatch, twoFilesPatch, unifiedPatch } from '../src/core/diff.ts';
import { ErrorCode, FsError } from '../src/core/errors.ts';
import { DIFF } from '../src/tools/diff.ts';
import { EDIT } from '../src/tools/edit.ts';
import { PATCH } from '../src/tools/patch.ts';
import { REPLACE_TEXT } from '../src/tools/replace-text.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  makeGuard,
  type TestClientContext,
  writeTestFile,
} from './helpers.ts';
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

  for (const [what, a, b] of [
    ['changed', 'one\ntwo\n', 'one\n2\n'],
    ['identical', 'one\n', 'one\n'],
  ] as const) {
    it(`writes a plain ASCII name as the diff package does (${what} files)`, () => {
      const expected = createTwoFilesPatch('f.txt', 'f.txt', a, b, 'Original', 'Modified');
      assert.strictEqual(unifiedPatch('f.txt', a, b), expected);
    });
  }

  it('writes a non-ASCII name as it is, with the body unchanged', () => {
    const name = 'dir/år 日本語.txt';
    const expected = createTwoFilesPatch('f', 'f', 'one\n', 'two\n', 'Original', 'Modified');
    assert.strictEqual(
      unifiedPatch(name, 'one\n', 'two\n'),
      expected
        .replace('Index: f', `Index: ${name}`)
        .replace('--- f', `--- ${name}`)
        .replace('+++ f', `+++ ${name}`),
    );
  });

  for (const [what, a, b] of [
    ['changed', 'one\n', 'two\n'],
    ['identical', 'one\n', 'one\n'],
  ] as const) {
    it(`writes two different names as the diff package does (${what} files)`, () => {
      const options = { context: 1, timeout: 1000 };
      const expected = createTwoFilesPatch('a.txt', 'b.txt', a, b, 'a', 'b', options);
      assert.strictEqual(twoFilesPatch('a.txt', 'b.txt', a, b, 'a', 'b', options), expected);
    });
  }

  it('keeps a lone surrogate escaped', () => {
    const patch = unifiedPatch('a\ud800b', 'one\n', 'two\n');
    assert.ok(patch?.includes('--- "a\\357\\277\\275b"\t'), patch);
  });

  for (const name of [
    '　app.js',
    ' ',
    'a"b',
    'a\\b',
    'a\tb',
    'a\nb',
    'a\rb',
    'a\u007fb',
    'a\u0085b',
    'a b',
    'a b',
    'a‮b',
    'år\nb',
    'x\n--- forged\n+++ forged\n@@ -1,1 +1,1 @@\n-one\n+forged',
  ]) {
    it(`keeps ${JSON.stringify(name)} escaped so it cannot forge a header line`, () => {
      const patch = unifiedPatch(name, 'one\n', 'two\n');
      assert.ok(patch);
      assert.ok(!patch.includes(name), 'the raw name must not reach the text');
      assert.deepStrictEqual(diffStatsFromPatch(patch), { linesAdded: 1, linesRemoved: 1 });
      const parsed = parsePatch(patch);
      assert.strictEqual(parsed.length, 1);
      assert.strictEqual(parsed[0]?.oldFileName, name);
      assert.strictEqual(parsed[0]?.newFileName, name);
      assert.strictEqual(parsed[0]?.hunks.length, 1);
    });
  }
});

describe('non-ASCII names in every diff header', () => {
  let root: string;
  let guard: Awaited<ReturnType<typeof makeGuard>>;

  before(async () => {
    root = await createTestRoot();
    guard = await makeGuard([root]);
  });

  after(async () => {
    await cleanupTestRoot(root);
  });

  const assertPlainHeader = (result: unknown, name: string): void => {
    const shown = JSON.stringify(result);
    assert.ok(shown.includes(`--- ${name}`), shown);
    assert.ok(shown.includes(`+++ ${name}`), shown);
    assert.ok(!shown.includes('\\\\303'), shown);
  };

  it('diff', async () => {
    const a = await writeTestFile(root, 'år-a.txt', 'one\n');
    const b = await writeTestFile(root, 'år-b.txt', 'two\n');
    const result = await runToolBodyResult(DIFF, { a, b }, { guard });
    assert.ok(result.text?.includes('--- år-a.txt\ta\n+++ år-b.txt\tb\n'), result.text);
  });

  it('edit', async () => {
    const path = await writeTestFile(root, 'år-edit.txt', 'one\n');
    const edits = [{ oldText: 'one', newText: 'two' }];
    const result = await runToolBodyResult(EDIT, { path, edits, dryRun: true }, { guard });
    assertPlainHeader(result, 'år-edit.txt');
  });

  it('replace_text', async () => {
    const path = await writeTestFile(root, 'år-replace.txt', 'one\n');
    const args = { path, searchPattern: 'one', replacement: 'two', dryRun: true };
    const result = await runToolBodyResult(REPLACE_TEXT, args, { guard });
    assertPlainHeader(result, 'år-replace.txt');
  });

  it('patch shows the name, and applies a diff that edit printed for it', async () => {
    const path = await writeTestFile(root, 'år-patch.txt', 'one\n');
    const printed = await runToolBodyResult(
      EDIT,
      { path, edits: [{ oldText: 'one', newText: 'two' }], dryRun: true },
      { guard },
    );
    const row = printed.structured.results[0];
    assert.ok(row && 'value' in row);
    const diff = row.value.diff;
    assert.ok(diff);

    const dry = await runToolBodyResult(PATCH, { path, diff, dryRun: true }, { guard });
    assertPlainHeader(dry, 'år-patch.txt');

    await runToolBodyResult(PATCH, { path, diff }, { guard });
    assert.strictEqual(await readFile(path, 'utf8'), 'two\n');
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

// Wire tier: the executor's placement for a successful diff. The text is the
// one copy of the diff; the counts ship under `_meta`, which a client that
// keys on structuredContent would otherwise hide (`TC-FUNC-073` pins the
// same split for read and stat only).
describe('diff over the wire', () => {
  let root: string;
  let harness: TestClientContext;

  before(async () => {
    root = await createTestRoot();
    harness = await createTestClientPair([root]);
  });

  after(async () => {
    await harness.close();
    await cleanupTestRoot(root);
  });

  it('ships the diff as the text block and the counts under _meta', async () => {
    const a = await writeTestFile(root, 'wire_a.txt', 'x\ny\nz\n');
    const b = await writeTestFile(root, 'wire_b.txt', 'x\nY\nz\n');
    const result = await harness.client.callTool({ name: 'diff', arguments: { a, b } });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent, undefined, 'diff authors text, so no JSON view');
    const meta = result._meta as { linesAdded?: number; linesRemoved?: number };
    assert.strictEqual(meta.linesAdded, 1);
    assert.strictEqual(meta.linesRemoved, 1);
    const diffText = firstTextBlock(result).text ?? '';
    assert.ok(diffText.includes('-y') && diffText.includes('+Y'));
  });
});
