import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { GuardedFileSystem } from '../src/core/fs.ts';
import { RE2_MAX_INPUT_BYTES } from '../src/core/matcher.ts';
import type { PathGuard } from '../src/core/path.ts';
import { searchContent } from '../src/core/search.ts';
import { cleanupTestRoot, createTestRoot, makeGuard, writeTestFile } from './helpers.ts';

describe('searchContent', () => {
  let root: string;
  let guard: PathGuard;

  beforeEach(async () => {
    root = await createTestRoot();
    guard = await makeGuard([root]);
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  it('keeps the first matches in walk order under its own cap', async () => {
    for (let i = 0; i < 30; i++) {
      await writeTestFile(root, `w${String(i).padStart(2, '0')}.txt`, 'CAP_HIT\nCAP_HIT\n');
    }
    const first = await searchContent(
      { root },
      'CAP_HIT',
      { maxResults: 7 },
      new GuardedFileSystem(guard),
    );
    const second = await searchContent(
      { root },
      'CAP_HIT',
      { maxResults: 7 },
      new GuardedFileSystem(guard),
    );
    const key = (result: typeof first) =>
      result.matches.map((match) => `${basename(match.file)}:${match.line}`);
    assert.deepStrictEqual(key(first), key(second));
    assert.strictEqual(first.matches.length, 7);
    assert.strictEqual(first.summary.stoppedReason, 'maxResults');
    assert.strictEqual(first.summary.truncated, true);
  });

  it('does not collect more matches from one file than its cap', async () => {
    await writeTestFile(
      root,
      'many.txt',
      Array.from({ length: 5000 }, () => 'CAP_ONE').join('\n') + '\n',
    );
    const result = await searchContent(
      { root },
      'CAP_ONE',
      { maxResults: 5 },
      new GuardedFileSystem(guard),
    );
    assert.strictEqual(result.matches.length, 5);
    assert.strictEqual(result.summary.matchingLines, 5);
    assert.strictEqual(result.summary.filesMatched, 1);
    assert.strictEqual(result.summary.stoppedReason, 'maxResults');
  });

  it('skips an overlong regex line without breaking later searches', async () => {
    const bigLine = `${'a'.repeat(RE2_MAX_INPUT_BYTES + 1024)} NEEDLE`;
    await writeTestFile(root, 'huge.txt', bigLine);
    await writeTestFile(root, 'ok.txt', 'hello NEEDLE world\n');

    const outcome = await searchContent(
      { root },
      'NEEDLE',
      { isRegex: true },
      new GuardedFileSystem(guard),
    );
    assert.strictEqual(outcome.summary.skippedTooLarge, 1);
    assert.strictEqual(outcome.matches.length, 1);
    const again = await searchContent(
      { root },
      'NEEDLE',
      { isRegex: true },
      new GuardedFileSystem(guard),
    );
    assert.strictEqual(again.matches.length, 1);

    const literal = await searchContent(
      { root },
      'NEEDLE',
      { isRegex: false },
      new GuardedFileSystem(guard),
    );
    assert.strictEqual(literal.summary.skippedTooLarge, 0);
    assert.deepStrictEqual(
      literal.matches.map((match) => match.file).sort(),
      [join(root, 'huge.txt'), join(root, 'ok.txt')].sort(),
    );
  });

  it('an aborted search over a dense-match file resolves as timeout', async () => {
    await writeTestFile(root, 'line.txt', 'needle\n'.repeat(200_000));
    const controller = new AbortController();
    const pending = searchContent(
      { root },
      'needle',
      { isRegex: false, maxResults: 100_000, signal: controller.signal },
      new GuardedFileSystem(guard),
    );
    const timer = setTimeout(
      () => controller.abort(new DOMException('deadline', 'TimeoutError')),
      50,
    );
    try {
      const outcome = await pending;
      assert.strictEqual(outcome.summary.stoppedReason, 'timeout');
      assert.ok(outcome.summary.truncated, 'an aborted scan is incomplete');
      assert.ok(outcome.summary.filesScanned > 0, 'the scan started before cancellation');
    } finally {
      clearTimeout(timer);
    }
  });
});
