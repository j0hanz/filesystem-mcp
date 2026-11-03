import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, Problem } from '../src/core/errors.ts';
import { PARALLEL_CONCURRENCY } from '../src/core/util.ts';
import { runOverPaths, summarize } from '../src/tools/batch.ts';
import type { ToolCtx } from '../src/tools/define.ts';

describe('runOverPaths', () => {
  it('a deadline before the last items start keeps finished results and fails the rest', async () => {
    const controller = new AbortController();
    const ctx = { signal: controller.signal, onProgress: () => undefined } as unknown as ToolCtx;
    const items = Array.from({ length: PARALLEL_CONCURRENCY + 2 }, (_, i) => `p${String(i)}`);

    const { results, summary } = await runOverPaths(items, ctx, ErrorCode.UNKNOWN, async (path) => {
      controller.abort(new DOMException('deadline', 'TimeoutError'));
      await Promise.resolve();
      return path;
    });

    assert.deepStrictEqual(results[0], { path: 'p0', value: 'p0' });
    const last = results.at(-1);
    assert.strictEqual(last?.path, `p${String(items.length - 1)}`);
    assert.ok(last && 'error' in last);
    assert.strictEqual(last.error.code, ErrorCode.TIMEOUT);
    assert.deepStrictEqual(summary, {
      total: items.length,
      succeeded: 1,
      failed: items.length - 1,
    });
  });
});

describe('summarize', () => {
  it('an empty batch counts nothing', () => {
    assert.deepStrictEqual(summarize([]), { total: 0, succeeded: 0, failed: 0 });
  });

  it('counts a value and an error separately', () => {
    const results = [
      { path: 'a', value: 1 },
      { path: 'b', error: Problem.cancelled('no', { path: 'b' }) },
    ];
    assert.deepStrictEqual(summarize(results), { total: 2, succeeded: 1, failed: 1 });
  });

  it('a batch of only errors fails every item', () => {
    const results = [
      { path: 'a', error: Problem.cancelled('no', { path: 'a' }) },
      { path: 'b', error: Problem.cancelled('no', { path: 'b' }) },
    ];
    const summary = summarize(results);
    assert.strictEqual(summary.failed, 2);
    assert.strictEqual(summary.failed, summary.total);
  });
});
