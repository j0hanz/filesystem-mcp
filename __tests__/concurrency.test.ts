import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { processInParallel, runExclusive, withAbort } from '../src/core/concurrency.ts';

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

describe('runExclusive argument isolation', () => {
  it('invokes fn with zero arguments', async () => {
    let argCount = -1;
    await runExclusive('test-arg-count', async (...args: unknown[]) => {
      argCount = args.length;
    });
    assert.strictEqual(argCount, 0, 'expected fn to be called with 0 arguments');
  });

  it('does not pass previous rejection reason as an argument to the next caller', async () => {
    const key = 'test-lock-key';
    let receivedArg: unknown = 'initial';

    const failingTask = runExclusive(key, async () => {
      throw new Error('previous failure');
    });

    const nextTask = runExclusive(key, async (optionalArg?: unknown) => {
      receivedArg = optionalArg;
      return 'success';
    });

    await assert.rejects(failingTask, { message: 'previous failure' });
    const result = await nextTask;
    assert.strictEqual(result, 'success');
    assert.strictEqual(receivedArg, undefined, 'expected optionalArg to be undefined');
  });
});

const gate = (): { promise: Promise<void>; open: () => void } => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

describe('runExclusive serialization', () => {
  it('same key never overlaps, in call order', async () => {
    const key = Symbol('serialization-key');
    const order: string[] = [];
    const gate1 = gate();
    const gate2 = gate();
    const gate3 = gate();

    const p1 = runExclusive(key, async () => {
      order.push('start-1');
      await gate1.promise;
      order.push('end-1');
    });

    const p2 = runExclusive(key, async () => {
      order.push('start-2');
      await gate2.promise;
      order.push('end-2');
    });

    const p3 = runExclusive(key, async () => {
      order.push('start-3');
      await gate3.promise;
      order.push('end-3');
    });

    gate3.open();
    gate2.open();
    gate1.open();

    await Promise.all([p1, p2, p3]);

    assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
  });

  it('different keys run together', async () => {
    const keyA = Symbol('key-A');
    const keyB = Symbol('key-B');
    const gateA = gate();
    let aFinished = false;

    const pA = runExclusive(keyA, async () => {
      await gateA.promise;
      aFinished = true;
    });

    const pB = runExclusive(keyB, async () => 'b-done');

    const resultB = await pB;
    assert.strictEqual(resultB, 'b-done');
    assert.strictEqual(aFinished, false, 'expected A to still be pending when B resolves');

    gateA.open();
    await pA;
    assert.strictEqual(aFinished, true);
  });

  it('a rejected holder does not block the next', async () => {
    const key = Symbol('rejection-key');

    const p1 = runExclusive(key, async () => {
      throw new Error('first failed');
    });

    const p2 = runExclusive(key, async () => 'second ok');

    await assert.rejects(p1, { message: 'first failed' });
    const result2 = await p2;
    assert.strictEqual(result2, 'second ok');
  });
});
