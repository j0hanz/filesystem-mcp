import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type * as z from 'zod/v4';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { MAX_MATCH_LINE_CHARS } from '../src/core/search.ts';
import { PATCH } from '../src/tools/patch.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  fsErrorMatcher,
  makeGuard,
} from './helpers.ts';
import { runToolBodyResult, schemaIssues } from './tool-harness.ts';

type PatchArgs = z.input<typeof PATCH.def.input>;

const DIFF = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';

describe('patch body', () => {
  let root: string;
  let fs: GuardedFileSystem;

  beforeEach(async () => {
    root = await createTestRoot();
    fs = new GuardedFileSystem(await makeGuard([root]));
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  const patch = (args: PatchArgs) => runToolBodyResult(PATCH, args, { fs });

  it('applies a unified diff and summarizes it', async () => {
    const f = join(root, 'patch_target.txt');
    await writeFile(f, 'a\nb\nc\n');
    const result = await patch({ path: f, diff: DIFF });
    assert.strictEqual(result.text, 'patch: patch_target.txt +1 -1');
    assert.strictEqual(result.structured.linesAdded, 1);
    assert.strictEqual(result.structured.linesRemoved, 1);
    assert.strictEqual(result.structured.diff, undefined);
    assert.ok(result.structured.resourceUri, 'a real write links the file');
    assert.ok(result.resources?.some((block) => block.type === 'resource_link'));
    assert.strictEqual(await readFile(f, 'utf-8'), 'X\nb\nc\n');
  });

  it('writes nothing when the patch changes nothing', async () => {
    const file = join(root, 'f.txt');
    await writeFile(file, 'a\nb\n');
    const before = (await stat(file)).mtimeMs;
    await sleep(20);
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n a\n b\n';
    await patch({ path: file, diff });
    assert.strictEqual((await stat(file)).mtimeMs, before);
    assert.strictEqual(await readFile(file, 'utf-8'), 'a\nb\n');
  });

  it('refuses a diff whose context does not match', async () => {
    const f = join(root, 'patch_bad.txt');
    await writeFile(f, 'q\nb\nc\n');
    await assert.rejects(
      patch({ path: f, diff: DIFF }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /did not apply cleanly/),
    );
    assert.strictEqual(await readFile(f, 'utf-8'), 'q\nb\nc\n');
  });

  it('names the failing hunk', async () => {
    const f = join(root, 'patch_stale_hunk.txt');
    await writeFile(f, 'a\nb\nc\nZ\ne\nf\n');
    const diff =
      '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n@@ -4,3 +4,3 @@\n-d\n+Y\n e\n f\n';
    await assert.rejects(patch({ path: f, diff }), (error: unknown) => {
      assert.ok(isFsError(error), 'expected FsError');
      const message = error.message ?? '';
      assert.match(message, /did not apply cleanly: hunk 2 \(starting at line 4\) does not match/u);
      assert.match(message, /at line 4: expected "d", found "Z" \(hunks must be in file order\)/u);
      return true;
    });
    assert.strictEqual(await readFile(f, 'utf-8'), 'a\nb\nc\nZ\ne\nf\n');
  });

  it('names the mismatched line for a single stale hunk', async () => {
    const f = join(root, 'patch_one_stale.txt');
    await writeFile(f, 'q\nb\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
    await assert.rejects(patch({ path: f, diff }), (error: unknown) => {
      assert.ok(isFsError(error), 'expected FsError');
      const message = error.message ?? '';
      assert.match(
        message,
        /hunk 1 \(starting at line 1\) does not match file content at line 1: expected "a", found "q"/u,
      );
      assert.doesNotMatch(message, /file order/u);
      return true;
    });
  });

  it('names the first differing line when the first context line matches', async () => {
    const f = join(root, 'patch_second_stale.txt');
    await writeFile(f, 'a\nX\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n';
    await assert.rejects(patch({ path: f, diff }), (error: unknown) => {
      assert.ok(isFsError(error), 'expected FsError');
      assert.match(error.message ?? '', /at line 2: expected "b", found "X"/u);
      return true;
    });
  });

  it('counts a blank context line with no leading space', async () => {
    const f = join(root, 'patch_blank_ctx.txt');
    await writeFile(f, '\nfoo\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n\n-bar\n+baz\n';
    await assert.rejects(patch({ path: f, diff }), (error: unknown) => {
      assert.ok(isFsError(error), 'expected FsError');
      assert.match(error.message ?? '', /at line 2: expected "bar", found "foo"/u);
      return true;
    });
  });

  it('strips CR from both sides of a CRLF mismatch', async () => {
    const f = join(root, 'patch_crlf.txt');
    await writeFile(f, 'a\r\nb\r\n');
    const diff = '--- f.txt\r\n+++ f.txt\r\n@@ -1,2 +1,2 @@\r\n-q\r\n+X\r\n b\r\n';
    await assert.rejects(patch({ path: f, diff }), (error: unknown) => {
      assert.ok(isFsError(error), 'expected FsError');
      assert.match(error.message ?? '', /at line 1: expected "q", found "a"/u);
      return true;
    });
  });

  it('a CRLF diff applies to an all-CRLF file', async () => {
    const f = join(root, 'patch_crlf_ok.txt');
    await writeFile(f, 'a\r\nb\r\n');
    await patch({ path: f, diff: '--- a\r\n+++ a\r\n@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n' });
    assert.strictEqual(await readFile(f, 'utf-8'), 'a\r\nc\r\n');
  });

  it('an LF diff applies to an all-CRLF file', async () => {
    const f = join(root, 'patch_lf_on_crlf.txt');
    await writeFile(f, 'a\r\nb\r\n');
    await patch({ path: f, diff: '--- a\n+++ a\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n' });
    assert.strictEqual(await readFile(f, 'utf-8'), 'a\r\nc\r\n');
  });

  it('a diff whose first line carries the BOM applies to a BOM file', async () => {
    const f = join(root, 'patch_bom_in_diff.txt');
    await writeFile(f, '\uFEFFa\nb\n');
    await patch({ path: f, diff: '--- a\n+++ a\n@@ -1,2 +1,2 @@\n-\uFEFFa\n+\uFEFFz\n b\n' });
    assert.strictEqual(await readFile(f, 'utf-8'), '\uFEFFz\nb\n');
  });

  it('a diff without the BOM applies to a BOM file', async () => {
    const f = join(root, 'patch_bom_not_in_diff.txt');
    await writeFile(f, '\uFEFFa\nb\n');
    await patch({ path: f, diff: '--- a\n+++ a\n@@ -1,2 +1,2 @@\n-a\n+z\n b\n' });
    assert.strictEqual(await readFile(f, 'utf-8'), '\uFEFFz\nb\n');
  });

  it('a raw-copied first context line loses only the BOM, not a second U+FEFF', async () => {
    const f = join(root, 'patch_bom_twice.txt');
    await writeFile(f, '\uFEFF\uFEFFa\nb\n');
    await patch({ path: f, diff: '--- a\n+++ a\n@@ -1,2 +1,2 @@\n \uFEFF\uFEFFa\n-b\n+c\n' });
    assert.strictEqual(await readFile(f, 'utf-8'), '\uFEFF\uFEFFa\nc\n');
  });

  it('a leading U+FEFF on an added line after line 1 is kept', async () => {
    const f = join(root, 'patch_bom_line2.txt');
    await writeFile(f, '\uFEFF\nb\n');
    // The blank context line is written bare, without its leading space.
    await patch({ path: f, diff: '--- a\n+++ a\n@@ -1,2 +1,2 @@\n\n-b\n+\uFEFFc\n' });
    assert.strictEqual(await readFile(f, 'utf-8'), '\uFEFF\n\uFEFFc\n');
  });

  it('names end of file for a line the file does not have', async () => {
    const f = join(root, 'patch_eof.txt');
    await writeFile(f, 'a\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,3 +1,3 @@\n a\n \n-b\n+B\n';
    await assert.rejects(patch({ path: f, diff }), (error: unknown) => {
      assert.ok(isFsError(error), 'expected FsError');
      assert.match(error.message ?? '', /at line 2: expected "", found end of file/u);
      return true;
    });
  });

  it('shows where long lines differ, not only their shared start', async () => {
    const f = join(root, 'patch_long_tail.txt');
    const shared = 'p'.repeat(1500);
    await writeFile(f, `${shared}Y\nb\n`);
    const diff = `--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-${shared}X\n+Z\n b\n`;
    await assert.rejects(patch({ path: f, diff }), (error: unknown) => {
      assert.ok(isFsError(error), 'expected FsError');
      assert.match(
        error.message ?? '',
        /expected "…\[\d+ chars\] p+X", found "…\[\d+ chars\] p+Y"/u,
      );
      return true;
    });
  });

  it('never splits a surrogate pair when clipping', async () => {
    const f = join(root, 'patch_emoji.txt');
    await writeFile(f, 'q\nb\n');
    const diff = `--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-x${'😀'.repeat(600)}\n+Z\n b\n`;
    await assert.rejects(patch({ path: f, diff }), (error: unknown) => {
      assert.ok(isFsError(error), 'expected FsError');
      assert.ok((error.message ?? '').isWellFormed(), 'lone surrogate in message');
      return true;
    });
  });

  it('truncates long lines in the mismatch detail', async () => {
    const f = join(root, 'patch_long_stale.txt');
    await writeFile(f, `${'q'.repeat(5000)}\nb\n`);
    const diff = `--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-${'a'.repeat(5000)}\n+X\n b\n`;
    await assert.rejects(patch({ path: f, diff }), (error: unknown) => {
      assert.ok(isFsError(error), 'expected FsError');
      const message = error.message ?? '';
      assert.match(message, /expected "a+ \[…\d+ chars\]", found "q+ \[…\d+ chars\]"/u);
      assert.ok(message.length < 2 * MAX_MATCH_LINE_CHARS + 300, String(message.length));
      return true;
    });
  });

  it('keeps the generic refusal when the diagnosis is over budget', async () => {
    const f = join(root, 'patch_big_stale.txt');
    const lines = Array.from({ length: 10_000 }, (_, i) => `l${String(i)}`);
    await writeFile(f, `${lines.join('\n')}\n`);
    // 3 diff lines in hunk 1, 598 stale context lines in hunk 2: the line
    // product (10,000 x 601) passes the apply guard, but times the hunk count
    // it is over MAX_PATCH_LINE_PRODUCT, so no prefix diagnosis runs.
    const stale = Array.from({ length: 598 }, (_, i) => ` nope${String(i)}`).join('\n');
    const diff =
      '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-l0\n+L0\n l1\n@@ -5000,598 +5000,598 @@\n' +
      stale +
      '\n';
    await assert.rejects(patch({ path: f, diff }), (error: unknown) => {
      assert.ok(isFsError(error), 'expected FsError');
      const message = error.message ?? '';
      assert.match(message, /did not apply cleanly: hunk context does not match/u);
      assert.doesNotMatch(message, /hunk 2/u);
      assert.match(message, /\(hunks must be in file order\)/u);
      return true;
    });
  });

  it('names the failing hunk across thousands of empty-target hunks', async () => {
    const f = join(root, 'patch_empty_many.txt');
    await writeFile(f, '');
    const hunks = Array.from(
      { length: 4_000 },
      (_, i) => `@@ -${String(i + 1)},0 +${String(i + 1)},1 @@\n+l${String(i)}\n`,
    );
    // A stale context line the empty file cannot match, so the apply fails.
    const diff = `--- f.txt\n+++ f.txt\n${hunks.join('')}@@ -500,1 +500,2 @@\n nope\n+X\n`;
    await assert.rejects(
      patch({ path: f, diff }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /did not apply cleanly: hunk 4001/u),
    );
  });

  it('bounds the diagnosis on a huge single-line target', async () => {
    const f = join(root, 'patch_big_single.txt');
    await writeFile(f, `${'x'.repeat(8 * 1024 * 1024)}\n`);
    const hunks = Array.from({ length: 1_500 }, () => '@@ -1,0 +1,1 @@\n+l\n');
    const diff = `--- f.txt\n+++ f.txt\n${hunks.join('')}@@ -1,1 +1,2 @@\n nope\n+X\n`;
    const started = Date.now();
    await assert.rejects(
      patch({ path: f, diff }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /did not apply cleanly: hunk 1501/u),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `diagnosis took ${String(elapsed)}ms`);
  });

  it('names the failing hunk among zero-line hunks', async () => {
    const f = join(root, 'patch_zero_line.txt');
    await writeFile(f, 'seed\n');
    const hunks = Array.from(
      { length: 20_000 },
      (_, i) => `@@ -${String(i + 1)},0 +${String(i + 1)},0 @@\n`,
    );
    const diff = `--- f.txt\n+++ f.txt\n${hunks.join('')}@@ -1,1 +1,2 @@\n nope\n+X\n`;
    await assert.rejects(
      patch({ path: f, diff }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /did not apply cleanly: hunk 20001/u),
    );
  });

  it('names the failing hunk by its submitted start line', async () => {
    const f = join(root, 'patch_order_line.txt');
    await writeFile(f, 'a\nb\nc\nd\ne\nf\ng\nh\n');
    // Hunk 1 consumes lines 1-2, so the clamp moves hunk 2's search start to
    // 2; its header still says 1, and the refusal names the header, the line
    // the caller can find in the diff they submitted.
    const diff =
      '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n@@ -1,3 +1,3 @@\n-z\n+Y\n c\n d\n';
    await assert.rejects(
      patch({ path: f, diff }),
      fsErrorMatcher(
        ErrorCode.INVALID_INPUT,
        /did not apply cleanly: hunk 2 \(starting at line 1\) does not match/u,
      ),
    );
  });

  it('refuses a zero-context hunk past the end of the file and writes nothing', async () => {
    const f = join(root, 'patch_past_end.txt');
    await writeFile(f, 'a\nb\n');
    for (const diff of [
      '--- f.txt\n+++ f.txt\n@@ -10,0 +11,1 @@\n+X\n',
      '--- f.txt\n+++ f.txt\n@@ -3,0 +4,1 @@\n+X\n',
    ]) {
      await assert.rejects(
        patch({ path: f, diff }),
        fsErrorMatcher(ErrorCode.INVALID_INPUT, /would duplicate or drop lines/u),
      );
      assert.strictEqual(await readFile(f, 'utf-8'), 'a\nb\n');
    }
  });

  it('dryRun counts the lines its diff shows, not the ones the input re-adds', async () => {
    const f = join(root, 'patch_dry_counts.txt');
    await writeFile(f, 'a\nb\nc\n');
    const diff = '--- f\n+++ f\n@@ -1,3 +1,3 @@\n-a\n-b\n-c\n+a\n+X\n+c\n';
    const dry = await patch({ path: f, diff, dryRun: true });
    assert.match(dry.text ?? '', /\+1 -1 \[dry run\]/);
    assert.strictEqual(dry.structured.linesAdded, 1);
    assert.strictEqual(dry.structured.linesRemoved, 1);
    const real = await patch({ path: f, diff });
    assert.strictEqual(real.structured.linesAdded, 3, 'a real reply does not change');
  });

  it('dryRun on a large file returns the hunk, not the file', async () => {
    const f = join(root, 'patch_dry_large.txt');
    const rest = Array.from({ length: 5000 }, (_, i) => `line ${String(i)}`).join('\n');
    await writeFile(f, `a\nb\nc\n${rest}\n`);
    const dry = await patch({ path: f, diff: DIFF, dryRun: true });
    assert.doesNotMatch(dry.text ?? '', /line 4000/);
    assert.ok((await readFile(f, 'utf-8')).startsWith('a\n'), 'a dry run writes nothing');
  });

  it('dryRun returns a labelled diff and advertises no resourceUri or resource_link', async () => {
    const f = join(root, 'patch_dry.txt');
    await writeFile(f, 'a\nb\nc\n');
    const dry = await patch({ path: f, diff: DIFF, dryRun: true });
    assert.match(dry.text ?? '', /^patch: patch_dry\.txt \+1 -1 \[dry run\]\n\n/);
    assert.match(dry.text ?? '', /^-a$/m);
    assert.match(dry.text ?? '', /^\+X$/m);
    assert.ok((dry.text ?? '').endsWith(dry.structured.diff ?? 'missing'));
    assert.strictEqual(dry.structured.resourceUri, undefined);
    assert.strictEqual(dry.resources, undefined, 'a dry run links nothing');
    assert.strictEqual(await readFile(f, 'utf-8'), 'a\nb\nc\n');
  });

  it('rejects out-of-order hunks instead of duplicating text', async () => {
    const f = join(root, 'patch_order.txt');
    const original = 'abcdefghijklmnopqrst'.split('').join('\n') + '\n';
    await writeFile(f, original);
    const swapped = '--- f.txt\n+++ f.txt\n@@ -5,1 +5,1 @@\n-e\n+E\n@@ -1,1 +1,1 @@\n-a\n+A\n';
    for (const dryRun of [true, false]) {
      await assert.rejects(
        patch({ path: f, diff: swapped, dryRun }),
        fsErrorMatcher(ErrorCode.INVALID_INPUT, /file order/),
        `dryRun=${String(dryRun)}`,
      );
    }
    assert.strictEqual(await readFile(f, 'utf-8'), original);

    // Same hunks in order, both headers off by +2: offset tolerance still applies.
    const offset = '--- f.txt\n+++ f.txt\n@@ -3,1 +3,1 @@\n-a\n+A\n@@ -7,1 +7,1 @@\n-e\n+E\n';
    await patch({ path: f, diff: offset });
    assert.strictEqual(await readFile(f, 'utf-8'), original.replace('a', 'A').replace('e', 'E'));

    // Hand-written headers can be wrong by different amounts, even descending,
    // while the hunks themselves are in order; jsdiff places those correctly.
    await writeFile(f, original);
    const misnumbered = '--- f.txt\n+++ f.txt\n@@ -9,1 +9,1 @@\n-a\n+A\n@@ -3,1 +3,1 @@\n-e\n+E\n';
    await patch({ path: f, diff: misnumbered });
    assert.strictEqual(await readFile(f, 'utf-8'), original.replace('a', 'A').replace('e', 'E'));

    // A later hunk whose header points back to text that also appears earlier
    // must land after the previous hunk, not on that earlier copy.
    const repeated = join(root, 'patch_repeat.txt');
    await writeFile(repeated, 'x\n1\n2\n3\nx\n5\n');
    const back = '--- f\n+++ f\n@@ -2,1 +2,1 @@\n-1\n+ONE\n@@ -1,1 +1,1 @@\n-x\n+X\n';
    await patch({ path: repeated, diff: back });
    assert.strictEqual(await readFile(repeated, 'utf-8'), 'x\nONE\n2\n3\nX\n5\n');
  });

  it('refuses a non-UTF-8 file and leaves its bytes intact', async () => {
    const path = join(root, 'late.txt');
    // First 512 bytes are plain ASCII; the bad byte (0xe9) lands past the binary probe.
    const bytes = Buffer.concat([
      Buffer.from('a'.repeat(600) + '\nhello\n'),
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    ]);
    await writeFile(path, bytes);
    // Line 1 is the 600 `a`s, line 2 is `hello`; this hunk would apply cleanly to
    // a UTF-8 file, so a refusal here can only come from the strict-UTF-8 check.
    await assert.rejects(
      patch({ path, diff: '--- f\n+++ f\n@@ -2,1 +2,1 @@\n-hello\n+bye\n' }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT),
    );
    assert.deepStrictEqual(await readFile(path), bytes);
  });

  it('a dry run previews through a held write lock; a live run waits for it', async () => {
    const f = join(root, 'patch_locked.txt');
    await writeFile(f, 'a\nb\nc\n');
    const gate = Promise.withResolvers<undefined>();
    const acquired = Promise.withResolvers<undefined>();
    const held = fs.lockForWrite(f, () => {
      acquired.resolve(undefined);
      return gate.promise;
    });
    await acquired.promise;
    let live: Promise<unknown> | undefined;
    try {
      const dry = await patch({ path: f, diff: DIFF, dryRun: true });
      assert.match(dry.text ?? '', /\[dry run\]/);

      let settled = false;
      live = patch({ path: f, diff: DIFF }).finally(() => {
        settled = true;
      });
      await sleep(50);
      assert.strictEqual(settled, false, 'a live patch must wait for the lock');
      assert.strictEqual(await readFile(f, 'utf-8'), 'a\nb\nc\n');
    } finally {
      gate.resolve(undefined);
      await held;
    }
    await live;
    assert.strictEqual(await readFile(f, 'utf-8'), 'X\nb\nc\n');
  });
});

describe('patch work limit', () => {
  let root: string;
  let fs: GuardedFileSystem;

  beforeEach(async () => {
    root = await createTestRoot();
    fs = new GuardedFileSystem(await makeGuard([root]));
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  const patch = (args: PatchArgs) => runToolBodyResult(PATCH, args, { fs });
  // A file of F lines of "x" and a one-hunk diff of N hunk lines: N-1 context
  // lines, then a removal that never matches.
  const shape = (fileLines: number, hunkLines: number) => ({
    content: 'x\n'.repeat(fileLines),
    diff: `--- f.txt\n+++ f.txt\n@@ -1,${hunkLines} +1,${hunkLines - 1} @@\n${' x\n'.repeat(hunkLines - 1)}-y\n`,
  });
  const tooLarge = (error: unknown) =>
    isFsError(error) &&
    error.code === ErrorCode.TOO_LARGE &&
    error.message.includes('10,000,000') &&
    (error.problem.suggestion ?? '').includes('use edit');

  it('refuses a combination over the limit', async () => {
    const f = join(root, 'limit.txt');
    const { content, diff } = shape(10_001, 1_000);
    await writeFile(f, content);
    await assert.rejects(patch({ path: f, diff }), tooLarge);
    assert.strictEqual(await readFile(f, 'utf-8'), content);
  });

  it('ends the refusal with the patch advice, not the read advice', async () => {
    const f = join(root, 'limit-wire.txt');
    const { content, diff } = shape(10_001, 1_000);
    await writeFile(f, content);
    const pair = await createTestClientPair([root]);
    try {
      const result = await pair.client.callTool({ name: 'patch', arguments: { path: f, diff } });
      const text = firstTextBlock(result).text ?? '';
      assert.strictEqual(result.isError, true);
      assert.match(text, /use edit/u);
      assert.doesNotMatch(text, /head\/tail/u);
    } finally {
      await pair.close();
    }
  });

  it('refuses under dryRun too', async () => {
    const f = join(root, 'limit-dry.txt');
    const { content, diff } = shape(10_001, 1_000);
    await writeFile(f, content);
    await assert.rejects(patch({ path: f, diff, dryRun: true }), tooLarge);
  });

  it('does not start applyPatch when over the limit', async () => {
    const f = join(root, 'limit-fast.txt');
    const { content, diff } = shape(80_000, 6_000);
    await writeFile(f, content);
    const start = performance.now();
    await assert.rejects(patch({ path: f, diff }), tooLarge);
    assert.ok(performance.now() - start < 2000);
  });

  it('applies at exactly the limit', async () => {
    const f = join(root, 'limit-exact.txt');
    const lines = Array.from({ length: 10_000 }, (_, i) => `line ${String(i)}`);
    await writeFile(f, `${lines.join('\n')}\n`);
    const diff = `--- f.txt\n+++ f.txt\n@@ -1,999 +1,999 @@\n${lines
      .slice(0, 999)
      .map((l, i) => (i === 500 ? `-${l}\n+changed` : ` ${l}`))
      .join('\n')}\n`;
    await patch({ path: f, diff });
    assert.match(await readFile(f, 'utf-8'), /^changed$/mu);
  });

  it('refuses a diff past the limit', async () => {
    const f = join(root, 'limit-diff.txt');
    await writeFile(f, 'a\n');
    const issues = await schemaIssues(patch({ path: f, diff: 'a'.repeat(1_048_577) }));
    assert.ok(
      issues.some((m) => m.includes('1,048,576')),
      issues.join('; '),
    );
  });
});
