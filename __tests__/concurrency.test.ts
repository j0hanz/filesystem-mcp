import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { processInParallel, withAbort } from '../src/core/concurrency.ts';

describe('withAbort', () => {
  it('a pre-aborted call leaves no unhandled rejection behind', async () => {
    // The server shuts down on an unhandled rejection (src/index.ts).
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const late = new Promise((_, reject) => setTimeout(() => reject(new Error('ENOENT')), 5));
      assert.throws(() => withAbort(late, AbortSignal.abort()), { name: 'AbortError' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('Concurrency Tests', () => {
  it('TC-CONC-001: an abort after every item ran still returns the results', async () => {
    // A batch that finished every item is complete, deadline or not: an
    // item's result may be a write already committed to disk, and
    // reporting the batch as failed invites a retry that appends twice.
    const controller = new AbortController();
    const { results, errors } = await processInParallel(
      ['a', 'b'],
      async (item: string) => {
        if (item === 'b') controller.abort();
        return `done-${item}`;
      },
      1,
      controller.signal,
    );
    assert.strictEqual(results.length, 2);
    assert.deepStrictEqual(
      results.map((r) => r.value),
      ['done-a', 'done-b'],
    );
    assert.strictEqual(errors.length, 0);
  });

  it('TC-CONC-002: an abort that skipped items still rejects the run', async () => {
    const controller = new AbortController();
    await assert.rejects(
      processInParallel(
        ['a', 'b', 'c'],
        async (item: string) => {
          if (item === 'a') controller.abort();
          return item;
        },
        1,
        controller.signal,
      ),
    );
  });
});
