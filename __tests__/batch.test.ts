import { isInputRequiredResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as z from 'zod/v4';

import { ErrorCode, FsError, Problem } from '../src/core/errors.ts';
import { GuardedFileSystem, UNKNOWN_IDENTITY } from '../src/core/fs.ts';
import { PARALLEL_CONCURRENCY } from '../src/core/util.ts';
import {
  type BatchPlan,
  type BatchResult,
  type BatchSlot,
  executeBatchSlots,
  planBatch,
  type PlanOutcome,
  repeatedEntry,
  runOverPaths,
  summarize,
  toProblem,
} from '../src/tools/batch.ts';
import { defineTool, type ToolCtx } from '../src/tools/define.ts';
import { cleanupTestRoot, createTestRoot, makeGuard } from './helpers.ts';
import { choose, runToolBodyResult } from './tool-harness.ts';

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

  it('preserves a thrown Problem verbatim', async () => {
    const problem = Problem.accessDenied('Access denied', {
      path: 'a.txt',
      suggestion: 'Ask for access',
    });
    const slots: BatchSlot<string>[] = [
      {
        status: 'pending',
        path: 'a.txt',
        run: async () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- Batch intentionally preserves non-Error Problem
          throw problem;
        },
      },
    ];
    const ctx = { onProgress: () => undefined } as unknown as ToolCtx;
    const result = await executeBatchSlots(slots, ctx);
    const entry = result.results[0];
    assert.ok(entry && 'error' in entry);
    assert.strictEqual(entry.error, problem);
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

describe('planBatch', () => {
  /** A stub plan: the entry it lands on and whether destroying it needs approval. */
  interface Stub {
    readonly name: string;
    readonly landing: string;
    readonly ask?: boolean;
    readonly id?: number;
  }
  type Outcome = PlanOutcome<Stub, string>;

  const NoArgs = z.strictObject({});

  /** A tool whose body is one Batch, so Confirmation rounds run through the harness. */
  function probe(spec: (ctx: ToolCtx) => BatchPlan<string, Stub, string>) {
    return defineTool<typeof NoArgs, BatchResult<string>>({
      name: 'batch_probe',
      title: 'Batch probe',
      description: 'Drives planBatch in tests.',
      input: NoArgs,
      readOnlyHint: false,
      run: async (_args, ctx) => {
        const ready = await planBatch(spec(ctx), ctx);
        if (isInputRequiredResult(ready)) return ready;
        return { structured: await ready.execute() };
      },
    });
  }

  /** A spec over `items` whose plans come from `table`; `ran` records each executed plan. */
  function specOf(
    items: readonly string[],
    table: Readonly<Record<string, Outcome | Error>>,
    ran: string[],
    overrides: Partial<BatchPlan<string, Stub, string>> = {},
  ): BatchPlan<string, Stub, string> {
    return {
      op: 'delete',
      accept: 'delete',
      items,
      pathOf: (item) => item,
      plan: (item) => {
        const outcome = table[item];
        if (outcome instanceof Error) return Promise.reject(outcome);
        return Promise.resolve(outcome ?? { status: 'plan', plan: { name: item, landing: item } });
      },
      slotPath: (plan) => plan.name,
      landing: (plan) => plan.landing,
      duplicates: {
        policy: 'fail',
        refuse: (plan, first) => Problem.invalidInput(`${plan.name} repeats ${first.name}`),
      },
      confirmItem: (plan) =>
        plan.ask === true
          ? {
              path: plan.landing,
              identity: UNKNOWN_IDENTITY,
              required: true,
              message: `Delete ${plan.name}?`,
            }
          : undefined,
      onRefusal: 'fail slot',
      skipped: (plan) => `skipped ${plan.name}`,
      run: (plan) => {
        ran.push(plan.name);
        return Promise.resolve(`ran ${plan.name}`);
      },
      ...overrides,
    };
  }

  /** Each result as `path: value` or `path: CODE message`, in order. */
  function rows(results: BatchResult<string>['results']): string[] {
    return results.map((r) =>
      'error' in r ? `${r.path}: ${r.error.code} ${r.error.message}` : `${r.path}: ${r.value}`,
    );
  }

  let root = '';
  beforeEach(async () => {
    root = await createTestRoot();
  });
  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  // NFC and NFD spellings of one missing name: the guard folds Unicode form on
  // every filesystem, so they key alike without depending on letter case.
  const nfc = () => join(root, 'café.txt');
  const nfd = () => join(root, 'café.txt');

  it('fails only the items whose plan failed or threw, in input order', async () => {
    const ran: string[] = [];
    const tool = probe(() =>
      specOf(
        ['a', 'boom', 'bad', 'c'],
        {
          a: { status: 'plan', plan: { name: 'a', landing: join(root, 'a') } },
          boom: new Error('exploded'),
          bad: { status: 'fail', failure: { path: 'bad', error: Problem.invalidInput('no') } },
          c: { status: 'plan', plan: { name: 'c', landing: join(root, 'c') } },
        },
        ran,
      ),
    );
    const { structured } = await runToolBodyResult(tool, {}, { roots: [root] });
    assert.deepStrictEqual(rows(structured.results), [
      'a: ran a',
      'boom: UNKNOWN exploded',
      'bad: INVALID_INPUT no',
      'c: ran c',
    ]);
    assert.deepStrictEqual(ran.sort(), ['a', 'c']);
  });

  it('fail: the first item per Landing runs; a respelling fails, or also lands when refuse allows', async () => {
    const table = (): Record<string, Outcome> => ({
      first: { status: 'plan', plan: { name: 'first', landing: nfc() } },
      second: { status: 'plan', plan: { name: 'second', landing: nfd() } },
    });
    const ran: string[] = [];
    const refused = await runToolBodyResult(
      probe(() => specOf(['first', 'second'], table(), ran)),
      {},
      { roots: [root] },
    );
    assert.deepStrictEqual(rows(refused.structured.results), [
      'first: ran first',
      'second: INVALID_INPUT second repeats first',
    ]);

    const both: string[] = [];
    const allowed = await runToolBodyResult(
      probe(() =>
        specOf(['first', 'second'], table(), both, {
          duplicates: { policy: 'fail', refuse: () => undefined },
        }),
      ),
      {},
      { roots: [root] },
    );
    assert.strictEqual(allowed.structured.summary.succeeded, 2);
    assert.deepStrictEqual(both.sort(), ['first', 'second']);
  });

  it('collapse: an exact repeat is never planned, and a respelling drops only when it saw the same entry', async () => {
    const planned: string[] = [];
    const ran: string[] = [];
    const run = (sameEntry: boolean) =>
      runToolBodyResult(
        probe(() => {
          const spec = specOf(
            ['x', 'x', 'nfc', 'nfd'],
            {
              x: { status: 'plan', plan: { name: 'x', landing: join(root, 'x') } },
              nfc: { status: 'plan', plan: { name: 'nfc', landing: nfc(), id: 1 } },
              nfd: { status: 'plan', plan: { name: 'nfd', landing: nfd(), id: 1 } },
            },
            ran,
            {
              duplicates: {
                policy: 'collapse',
                sameEntry: (plan, earlier) => sameEntry && plan.id === earlier.id,
              },
            },
          );
          return {
            ...spec,
            plan: (item) => {
              planned.push(item);
              return spec.plan(item);
            },
          };
        }),
        {},
        { roots: [root] },
      );

    const collapsed = await run(true);
    assert.deepStrictEqual(rows(collapsed.structured.results), ['x: ran x', 'nfc: ran nfc']);
    assert.deepStrictEqual(planned.sort(), ['nfc', 'nfd', 'x'], 'the exact repeat is not planned');

    const apart = await run(false);
    assert.deepStrictEqual(rows(apart.structured.results), [
      'x: ran x',
      'nfc: ran nfc',
      'nfd: ran nfd',
    ]);
  });

  it('collapse: a settled item with a Landing absorbs a later plan on that path', async () => {
    const ran: string[] = [];
    const target = join(root, 'gone');
    const { structured } = await runToolBodyResult(
      probe(() =>
        specOf(
          ['noop', 'later'],
          {
            noop: { status: 'settled', path: 'noop', value: 'already gone', landing: target },
            later: { status: 'plan', plan: { name: 'later', landing: target } },
          },
          ran,
          { duplicates: { policy: 'collapse', sameEntry: () => false } },
        ),
      ),
      {},
      { roots: [root] },
    );
    assert.deepStrictEqual(rows(structured.results), ['noop: already gone']);
    assert.deepStrictEqual(ran, []);
  });

  it('runs the cross-item hook on the survivors of the duplicate check, before any prompt', async () => {
    const ran: string[] = [];
    let seen: string[] = [];
    const { structured, rounds } = await runToolBodyResult(
      probe(() =>
        specOf(
          ['a', 'b', 'c'],
          {
            a: { status: 'plan', plan: { name: 'a', landing: nfc(), ask: true } },
            b: { status: 'plan', plan: { name: 'b', landing: nfd(), ask: true } },
            c: { status: 'plan', plan: { name: 'c', landing: join(root, 'c'), ask: true } },
          },
          ran,
          {
            refuse: (plans) => {
              seen = plans.map(({ plan }) => plan.name);
              return Promise.resolve(new Map([[2, Problem.invalidInput('overlaps')]]));
            },
          },
        ),
      ),
      {},
      { roots: [root], confirm: choose('delete') },
    );
    assert.deepStrictEqual(seen, ['a', 'c'], 'the duplicate never reaches the hook');
    assert.deepStrictEqual(rows(structured.results), [
      'a: ran a',
      'b: INVALID_INPUT b repeats a',
      'c: INVALID_INPUT overlaps',
    ]);
    assert.strictEqual(rounds, 1, 'only the survivor is asked about');
  });

  it('returns the round while an approval is due, with nothing run', async () => {
    const ran: string[] = [];
    const tool = probe(() =>
      specOf(
        ['quiet', 'asks'],
        {
          quiet: { status: 'plan', plan: { name: 'quiet', landing: join(root, 'quiet') } },
          asks: { status: 'plan', plan: { name: 'asks', landing: join(root, 'asks'), ask: true } },
        },
        ran,
      ),
    );
    await assert.rejects(runToolBodyResult(tool, {}, { roots: [root] }), /asked for input/);
    assert.deepStrictEqual(ran, []);
  });

  const asking = (): Record<string, Outcome> => ({
    keep: { status: 'plan', plan: { name: 'keep', landing: join(root, 'keep'), ask: true } },
    skip: { status: 'plan', plan: { name: 'skip', landing: join(root, 'skip'), ask: true } },
    quiet: { status: 'plan', plan: { name: 'quiet', landing: join(root, 'quiet') } },
  });
  const answer = (prompt: { message: string }) =>
    prompt.message.includes('keep') ? ({ action: 'decline' } as const) : choose('skip')();

  it('fail slot: a declined item fails CANCELLED, a skipped one settles, the rest run', async () => {
    const ran: string[] = [];
    const { structured } = await runToolBodyResult(
      probe(() => specOf(['keep', 'skip', 'quiet'], asking(), ran)),
      {},
      { roots: [root], confirm: answer },
    );
    const [declined, skipped, quiet] = structured.results;
    assert.ok(declined && 'error' in declined);
    assert.strictEqual(declined.error.code, ErrorCode.CANCELLED);
    assert.match(declined.error.message, /^Delete cancelled: approval for ".*keep" was declined/);
    assert.deepStrictEqual(rows([skipped, quiet].filter((r) => r !== undefined)), [
      'skip: skipped skip',
      'quiet: ran quiet',
    ]);
    assert.deepStrictEqual(ran, ['quiet']);
  });

  it('fail call: a declined item cancels the whole call before anything runs', async () => {
    const ran: string[] = [];
    await assert.rejects(
      runToolBodyResult(
        probe(() =>
          specOf(['keep', 'skip', 'quiet'], asking(), ran, {
            op: 'move',
            accept: 'overwrite',
            onRefusal: 'fail call',
          }),
        ),
        {},
        { roots: [root], confirm: answer },
      ),
      (error: unknown) =>
        error instanceof FsError &&
        error.code === ErrorCode.CANCELLED &&
        /^Move cancelled: approval for ".*keep" was declined/.test(error.message),
    );
    assert.deepStrictEqual(ran, []);
  });
});

describe('repeatedEntry', () => {
  let root = '';
  beforeEach(async () => {
    root = await createTestRoot();
  });
  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  it('finds the first respelling of an earlier path', async () => {
    const fs = new GuardedFileSystem(await makeGuard([root]));
    const ctx = { fs, signal: new AbortController().signal };
    const paths = [join(root, 'a'), join(root, 'café'), join(root, 'café')];
    assert.deepStrictEqual(await repeatedEntry(paths, ctx), [2, 1]);
    assert.strictEqual(await repeatedEntry(paths.slice(0, 2), ctx), undefined);
    assert.strictEqual(await repeatedEntry(paths.slice(0, 1), ctx), undefined);
  });
});

describe('toProblem', () => {
  it('keeps plain Problem objects intact and classifies Error instances via Problem.fromUnknown', () => {
    const plain = { code: ErrorCode.NOT_FOUND, message: 'plain', path: '/p' };
    assert.strictEqual(toProblem(plain, ErrorCode.UNKNOWN, '/fallback'), plain);

    const fsErr = new FsError(ErrorCode.ACCESS_DENIED, 'denied', '/a');
    assert.deepStrictEqual(toProblem(fsErr, ErrorCode.UNKNOWN, '/fallback'), {
      code: ErrorCode.ACCESS_DENIED,
      message: 'denied',
      path: '/fallback',
    });

    const errnoErr = Object.assign(new Error('ENOENT: missing'), { code: 'ENOENT' });
    const mapped = toProblem(errnoErr, ErrorCode.UNKNOWN, '/missing');
    assert.strictEqual(mapped.code, ErrorCode.NOT_FOUND);
    assert.strictEqual(mapped.path, '/missing');
  });
});
