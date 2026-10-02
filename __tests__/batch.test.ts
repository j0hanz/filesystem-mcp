import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Problem } from '../src/core/errors.ts';
import { summarize } from '../src/tools/batch.ts';

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
