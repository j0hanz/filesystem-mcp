import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, Problem } from '../src/core/errors.ts';
import { PARALLEL_CONCURRENCY } from '../src/core/util.ts';
import {
  type BatchSlot,
  cancelMessage,
  executeBatchSlots,
  type PlanFailure,
  planIntoSlots,
  runOverPaths,
  summarize,
} from '../src/tools/batch.ts';
import type { ToolCtx } from '../src/tools/define.ts';

describe('executeBatchSlots', () => {
  it('preserves input order across settled, failure, omitted, and pending slots', async () => {
    const slots: BatchSlot<{ val: number }>[] = [
      { status: 'settled', path: 'a.txt', value: { val: 1 } },
      { status: 'omitted' },
      {
        status: 'failure',
        path: 'c.txt',
        error: { code: ErrorCode.NOT_FOUND, message: 'c.txt not found', path: 'c.txt' },
      },
      { status: 'pending', path: 'd.txt', run: async () => ({ val: 4 }) },
    ];
    const ctx = { onProgress: () => undefined } as unknown as ToolCtx;
    const res = await executeBatchSlots(slots, ctx);
    assert.strictEqual(res.results.length, 3);
    const first = res.results[0];
    assert.strictEqual(first?.path, 'a.txt');
    assert.ok(first && 'value' in first);
    assert.deepStrictEqual(first.value, { val: 1 });
    assert.strictEqual(res.results[1]?.path, 'c.txt');
    assert.ok(res.results[1] && 'error' in res.results[1]);
    const third = res.results[2];
    assert.strictEqual(third?.path, 'd.txt');
    assert.ok(third && 'value' in third);
    assert.deepStrictEqual(third.value, { val: 4 });
    assert.deepStrictEqual(res.summary, { total: 3, succeeded: 2, failed: 1 });
  });

  it('preserves completed items when aborted and marks unstarted items', async () => {
    const controller = new AbortController();
    const ctx = { signal: controller.signal, onProgress: () => undefined } as unknown as ToolCtx;
    const slots: BatchSlot<string>[] = Array.from({ length: PARALLEL_CONCURRENCY + 2 }, (_, i) => ({
      status: 'pending',
      path: `p${String(i)}`,
      run: async () => {
        controller.abort(new DOMException('cancelled', 'AbortError'));
        await Promise.resolve();
        return `done-${String(i)}`;
      },
    }));

    const res = await executeBatchSlots(slots, ctx, { defaultErrorCode: ErrorCode.UNKNOWN });
    assert.strictEqual(res.results.length, slots.length);
    assert.deepStrictEqual(res.results[0], { path: 'p0', value: 'done-0' });
    const last = res.results.at(-1);
    assert.strictEqual(last?.path, `p${String(slots.length - 1)}`);
    assert.ok(last && 'error' in last);
    assert.strictEqual(last.error.code, ErrorCode.CANCELLED);
    assert.strictEqual(res.summary.succeeded, 1);
    assert.strictEqual(res.summary.failed, slots.length - 1);
  });

  it('honors progressOffset and progressTotal for multi-stage tracking', async () => {
    const ticks: { current: number; total: number }[] = [];
    const ctx = {
      onProgress: (p: { current: number; total: number }) => {
        ticks.push(p);
      },
    } as unknown as ToolCtx;

    const slots: BatchSlot<number>[] = [
      { status: 'pending', path: '1', run: async () => 1 },
      { status: 'pending', path: '2', run: async () => 2 },
    ];

    await executeBatchSlots(slots, ctx, { progressOffset: 3, progressTotal: 10 });
    assert.strictEqual(ticks.length, 2);
    assert.deepStrictEqual(ticks[0], { current: 4, total: 10 });
    assert.deepStrictEqual(ticks[1], { current: 5, total: 10 });
  });

  it('handles an empty slot array without calling onProgress', async () => {
    let called = false;
    const ctx = {
      onProgress: () => {
        called = true;
      },
    } as unknown as ToolCtx;
    const res = await executeBatchSlots([], ctx);
    assert.deepStrictEqual(res, { results: [], summary: { total: 0, succeeded: 0, failed: 0 } });
    assert.strictEqual(called, false);
  });
});

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

describe('planIntoSlots', () => {
  type R = { status: 'plan'; n: number } | PlanFailure;
  const plan = async (item: string): Promise<R> => {
    if (item === 'boom') throw new Error('exploded');
    if (item === 'bad') {
      return { status: 'fail', failure: { path: item, error: Problem.invalidInput('no') } };
    }
    return { status: 'plan', n: item.length };
  };

  it('fails only the items whose plan failed or threw, in input order', async () => {
    const { slots, planned } = await planIntoSlots<string, R, number>(
      ['a', 'boom', 'bad', 'ccc'],
      (item) => item,
      plan,
      undefined,
    );
    assert.strictEqual(slots.length, 4);
    assert.deepStrictEqual(
      [slots[0], slots[3]].map((slot) => slot?.status),
      [undefined, undefined],
    );
    assert.deepStrictEqual(
      [slots[1], slots[2]].map((slot) => slot?.status === 'failure' && slot.path),
      ['boom', 'bad'],
    );
    assert.match(slots[1]?.status === 'failure' ? slots[1].error.message : '', /exploded/);
    assert.deepStrictEqual(planned.map(({ index, value }) => [index, value.n]).sort(), [
      [0, 1],
      [3, 3],
    ]);
  });

  it('rejects when the signal is already aborted', async () => {
    await assert.rejects(
      planIntoSlots<string, R, number>(['a'], (item) => item, plan, AbortSignal.abort()),
    );
  });
});

describe('cancelMessage', () => {
  it('names the op and the path for a replaced entry', () => {
    assert.strictEqual(
      cancelMessage('delete', '/r/dir', 'changed'),
      'Delete cancelled: "/r/dir" was replaced again while the prompt was open.',
    );
  });

  it('names the op and the path for a refusal', () => {
    for (const [op, verb] of [
      ['create', 'create'],
      ['delete', 'Delete'],
      ['move', 'Move'],
      ['copy', 'Copy'],
    ] as const) {
      assert.strictEqual(
        cancelMessage(op, '/r/x', { refused: 'declined by the user' }),
        `${verb} cancelled: approval for "/r/x" was declined by the user`,
      );
    }
  });
});
