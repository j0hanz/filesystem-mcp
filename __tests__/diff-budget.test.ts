import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type DiffBudget,
  finishDiff,
  MAX_DIFF_SIZE,
  patchWithinBudget,
  settle,
} from '../src/core/diff-budget.ts';
import type { Rewritten } from '../src/core/rewrite.ts';

// The diff budget owns first-fit patch folding in walk order, bounded by
// scan's admission seam. These unit pins mirror the wire pins at
// tools.test.ts:4265-4414, which drive the same rules through the tool.
// The budget reads only `before` and `after`; the report thunk is never called,
// so the fixture pins just the fields under test (the suite's hand-built-fake pattern).
const done = (before: string, after: string): Rewritten<number> =>
  ({
    kind: 'text',
    validPath: '/diff-budget-test/file',
    before,
    after,
    result: 1,
    written: true,
    modified: 'test',
  }) as unknown as Rewritten<number>;

const budget = (): DiffBudget => ({
  stored: new Map(),
  settled: new Set(),
  prefix: 0,
  folded: '',
  truncated: false,
});

describe('diff budget', () => {
  it('DB-001: folds first-fit in walk order, not completion order', async () => {
    const b = budget();
    assert.deepStrictEqual(
      await patchWithinBudget(b, 0, 'f0', done('a\n', `a\n${'x'.repeat(9000)}\n`)),
      {},
    );
    assert.deepStrictEqual(
      await patchWithinBudget(b, 1, 'f1', done('b\n', `b\n${'y'.repeat(9000)}\n`)),
      {},
    );
    assert.deepStrictEqual(
      await patchWithinBudget(b, 2, 'f2', done('c\n', `c\n${'z'.repeat(9000)}\n`)),
      {},
    );
    settle(b, 2);
    settle(b, 0);
    settle(b, 1);
    assert.ok(b.folded.includes('f0') && b.folded.includes('f1'));
    assert.ok(!b.folded.includes('f2'));
    assert.strictEqual(b.truncated, true);
    assert.ok(b.folded.length <= MAX_DIFF_SIZE);
  });

  it('DB-002: a patch alone over the whole budget is refused; a small one is kept', async () => {
    const b = budget();
    assert.deepStrictEqual(
      await patchWithinBudget(b, 0, 'big', done('', 'x'.repeat(MAX_DIFF_SIZE + 5000))),
      { diffTruncated: true },
    );
    assert.deepStrictEqual(await patchWithinBudget(b, 1, 'small', done('', 'y'.repeat(100))), {});
    // The admission seam settles every dispatched index, refused ones included.
    settle(b, 0);
    settle(b, 1);
    assert.ok(b.folded.includes('small'));
    assert.ok(!b.folded.includes('big'));
  });

  it('DB-003: room is judged against the settled prefix only, then against the remainder', async () => {
    const b = budget();
    // f0 is stored but unsettled: it does not consume a later patch's room.
    assert.deepStrictEqual(await patchWithinBudget(b, 0, 'f0', done('', 'x'.repeat(9000))), {});
    assert.deepStrictEqual(await patchWithinBudget(b, 5, 'f5', done('', 'y'.repeat(9000))), {});
    // Every dispatched index settles, so the prefix walks through 1-4 (empty) to 5.
    for (let index = 0; index <= 5; index++) settle(b, index);
    assert.ok(b.folded.includes('f0') && b.folded.includes('f5'));
    // The budget is near full now: a third patch longer than the remainder is refused.
    assert.deepStrictEqual(await patchWithinBudget(b, 9, 'f9', done('', 'z'.repeat(9000))), {
      diffTruncated: true,
    });
  });

  it('DB-004: finishDiff drains the stored patches in index order', async () => {
    const b = budget();
    assert.deepStrictEqual(await patchWithinBudget(b, 3, 'f3', done('', 'x'.repeat(100))), {});
    assert.deepStrictEqual(await patchWithinBudget(b, 1, 'f1', done('', 'y'.repeat(100))), {});
    finishDiff(b);
    assert.ok(b.folded.indexOf('f1') < b.folded.indexOf('f3'));
  });

  it('DB-005: settle advances only over the contiguous prefix', async () => {
    const b = budget();
    assert.deepStrictEqual(await patchWithinBudget(b, 0, 'f0', done('', 'x'.repeat(100))), {});
    assert.deepStrictEqual(await patchWithinBudget(b, 1, 'f1', done('', 'y'.repeat(100))), {});
    settle(b, 1);
    assert.strictEqual(b.folded, '');
    assert.strictEqual(b.prefix, 0);
    settle(b, 0);
    assert.ok(b.folded.includes('f0') && b.folded.includes('f1'));
    assert.strictEqual(b.prefix, 2);
  });

  it('DB-006: returns diffTruncated immediately when folded length exceeds or equals MAX_DIFF_SIZE', async () => {
    const b = budget();
    b.folded = 'x'.repeat(MAX_DIFF_SIZE + 10);
    // Passing invalid before/after: if unifiedPatch is called, it throws TypeError
    const badDone = { before: undefined, after: undefined } as unknown as Rewritten<number>;
    const result = await patchWithinBudget(b, 0, 'f0', badDone);
    assert.deepStrictEqual(result, { diffTruncated: true });
  });
});
