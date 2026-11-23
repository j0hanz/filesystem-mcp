import { type InputRequiredResult, isInputRequiredResult } from '@modelcontextprotocol/server';

import { processInParallel } from '../core/concurrency.ts';
import { confirm, type Confirmed, type ConfirmItem, type ConfirmOp } from '../core/confirmation.ts';
import { ErrorCode, FsError, type PerPathResult, Problem } from '../core/errors.ts';
import { normalizePath } from '../core/path-utils.ts';
import { firstRepeat } from '../core/path.ts';
import { PARALLEL_CONCURRENCY } from '../core/util.ts';
import type { ToolCtx } from './define.ts';

const MAX_FAILURE_LINES = 3;

export interface BatchResult<T> {
  results: PerPathResult<T>[];
  summary: { total: number; succeeded: number; failed: number };
}

export type BatchSlot<T> =
  | { readonly status: 'settled'; readonly path: string; readonly value: T }
  | { readonly status: 'failure'; readonly path: string; readonly error: Problem }
  | { readonly status: 'omitted' }
  | {
      readonly status: 'pending';
      readonly path: string;
      readonly run: (ctx: ToolCtx) => Promise<T>;
    };

export interface BatchExecutionOptions {
  readonly defaultErrorCode?: ErrorCode;
  readonly progressOffset?: number;
  readonly progressTotal?: number;
}

export function toProblem(error: unknown, defaultCode: ErrorCode, path: string): Problem {
  if (
    typeof error === 'object' &&
    error !== null &&
    !(error instanceof Error) &&
    'code' in error &&
    'message' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return error as Problem;
  }
  return Problem.fromUnknown(error, defaultCode, path);
}

/**
 * Executes a batch of indexed slots while strictly preserving caller input order.
 * Pre-settled and failed slots are placed without execution; pending slots run
 * concurrently under PARALLEL_CONCURRENCY and cancellation rules. On abort, completed
 * results are preserved and unstarted slots are marked with the abort Problem.
 * Omitted slots (e.g. deduplicated inputs) are excluded from the returned results.
 */
export async function executeBatchSlots<T>(
  slots: readonly BatchSlot<T>[],
  ctx: ToolCtx,
  options?: BatchExecutionOptions,
): Promise<BatchResult<T>> {
  const totalSlots = slots.length;
  const defaultErrorCode = options?.defaultErrorCode ?? ErrorCode.UNKNOWN;
  const results = new Array<PerPathResult<T> | undefined>(totalSlots);

  for (let i = 0; i < totalSlots; i++) {
    const slot = slots[i];
    if (slot === undefined) continue;
    if (slot.status === 'settled') {
      results[i] = { path: slot.path, value: slot.value };
    } else if (slot.status === 'failure') {
      results[i] = { path: slot.path, error: slot.error };
    }
  }

  const pending: { slot: Extract<BatchSlot<T>, { status: 'pending' }>; index: number }[] = [];
  for (let i = 0; i < totalSlots; i++) {
    const slot = slots[i];
    if (slot?.status === 'pending') {
      pending.push({ slot, index: i });
    }
  }

  if (pending.length === 0) {
    const nonOmitted = results.filter((r): r is PerPathResult<T> => r !== undefined);
    return { results: nonOmitted, summary: summarize(nonOmitted) };
  }

  const total = options?.progressTotal ?? pending.length;
  let completed = options?.progressOffset ?? 0;

  const tick = (): void => {
    completed += 1;
    ctx.onProgress({ current: completed, total });
  };

  try {
    await processInParallel(
      pending,
      async ({ slot, index }) => {
        try {
          const value = await slot.run(ctx);
          results[index] = { path: slot.path, value };
        } catch (error: unknown) {
          results[index] = {
            path: slot.path,
            error: toProblem(error, defaultErrorCode, slot.path),
          };
        } finally {
          tick();
        }
      },
      PARALLEL_CONCURRENCY,
      ctx.signal,
    );
  } catch (error: unknown) {
    // The signal fired before some items started. Finished items may have
    // written, so the caller must still see them to know what a retry repeats.
    for (const { slot, index } of pending) {
      results[index] ??= {
        path: slot.path,
        error: toProblem(error, defaultErrorCode, slot.path),
      };
    }
  }

  const nonOmitted = results.filter((r): r is PerPathResult<T> => r !== undefined);
  return { results: nonOmitted, summary: summarize(nonOmitted) };
}

/** What planning one item settled, with no mutation. */
export type PlanOutcome<TPlan, TValue> =
  | { readonly status: 'plan'; readonly plan: TPlan }
  | {
      readonly status: 'settled';
      readonly path: string;
      readonly value: TValue;
      /** The entry a settled item already stands for; only `collapse` reads it. */
      readonly landing?: string;
    }
  | {
      readonly status: 'fail';
      readonly failure: { readonly path: string; readonly error: Problem };
    };

/** How a Batch settles two items that land on one entry. */
type DuplicatePolicy<TPlan> =
  | {
      /** The first item proceeds; a later one fails with the returned Problem, or also lands on undefined. */
      readonly policy: 'fail';
      readonly refuse: (plan: TPlan, first: TPlan) => Problem | undefined;
    }
  | {
      /** Exact input repeats drop before planning; a later plan that saw the same entry drops after it. */
      readonly policy: 'collapse';
      readonly sameEntry: (plan: TPlan, earlier: TPlan) => boolean;
    };

/** One tool's Batch: how to plan, key, confirm and run each item. */
export interface BatchPlan<TItem, TPlan, TValue> {
  readonly op: ConfirmOp;
  readonly accept: 'delete' | 'overwrite';
  readonly items: readonly TItem[];
  /** The item's requested path: names an unplanned item and the exact-repeat check. */
  readonly pathOf: (item: TItem) => string;
  readonly plan: (item: TItem) => Promise<PlanOutcome<TPlan, TValue>>;
  /** The path that names a planned item in the results. */
  readonly slotPath: (plan: TPlan) => string;
  /** The path a plan lands on; two plans whose Landings key alike are duplicates. */
  readonly landing: (plan: TPlan) => string;
  readonly duplicates: DuplicatePolicy<TPlan>;
  /** Rules across items, run after duplicates settle and before the Confirmation: a refusal per index. */
  readonly refuse?: (
    plans: readonly { readonly plan: TPlan; readonly index: number }[],
  ) => Promise<ReadonlyMap<number, Problem>>;
  /** What the Confirmation asks about this plan, or undefined when it destroys nothing. */
  readonly confirmItem: (plan: TPlan) => ConfirmItem | undefined;
  /** A declined item cancels the whole call, or only its own slot. */
  readonly onRefusal: 'fail call' | 'fail slot';
  readonly skipped: (plan: TPlan) => TValue;
  readonly run: (plan: TPlan, item: TItem, ctx: ToolCtx) => Promise<TValue>;
}

/** A Batch settled up to execution; the tool chooses when it runs. */
export interface ReadyBatch<T> {
  execute(options?: BatchExecutionOptions): Promise<BatchResult<T>>;
}

const CANCEL_VERB: Readonly<Record<ConfirmOp, string>> = {
  create: 'create',
  delete: 'Delete',
  move: 'Move',
  copy: 'Copy',
};

/** The CANCELLED text for a Confirmation that did not approve `path`. */
function cancelMessage(
  op: ConfirmOp,
  path: string,
  verdict: 'changed' | { readonly refused: string },
): string {
  return verdict === 'changed'
    ? `${CANCEL_VERB[op]} cancelled: "${path}" was replaced again while the prompt was open.`
    : `${CANCEL_VERB[op]} cancelled: approval for "${path}" was ${verdict.refused}`;
}

type Verdict = ReturnType<Confirmed['verdict']>;

function isRefused(verdict: Verdict): verdict is Exclude<Verdict, 'proceed' | 'skipped'> {
  return verdict !== 'proceed' && verdict !== 'skipped';
}

/**
 * The first input path naming the same entry as an earlier one, as
 * `[index, firstIndex]`, keyed by the path guard so respellings repeat.
 */
export async function repeatedEntry(
  paths: readonly string[],
  ctx: Pick<ToolCtx, 'fs' | 'signal'>,
): Promise<[number, number] | undefined> {
  // One path cannot repeat: skip the guard's directory reads.
  if (paths.length < 2) return undefined;
  return firstRepeat(await ctx.fs.pathGuard.entryKeys(paths.map(normalizePath), ctx.signal));
}

/**
 * Settle a Batch up to execution: plan every item with no mutation, settle
 * duplicates by the guard's Entry keys, apply the tool's cross-item rules,
 * then ask the Confirmation. Returns the round while one is due, else a
 * batch whose slots keep the client's input order.
 */
export async function planBatch<TItem, TPlan, TValue>(
  spec: BatchPlan<TItem, TPlan, TValue>,
  ctx: ToolCtx,
): Promise<InputRequiredResult | ReadyBatch<TValue>> {
  const { items, duplicates } = spec;
  const slots = new Array<BatchSlot<TValue>>(items.length);

  const repeats = new Set<number>();
  if (duplicates.policy === 'collapse') {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      const path = spec.pathOf(item);
      if (seen.has(path)) repeats.add(index);
      seen.add(path);
    }
  }

  const { results, errors } = await processInParallel(
    items,
    (item, index) => (repeats.has(index) ? Promise.resolve(undefined) : spec.plan(item)),
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );
  for (const index of repeats) slots[index] = { status: 'omitted' };
  for (const { index, error } of errors) {
    const item = items[index];
    const path = item === undefined ? '(unknown)' : spec.pathOf(item);
    slots[index] = {
      status: 'failure',
      path,
      error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, path),
    };
  }

  // Input order, not completion order, decides which duplicate is first.
  type Keyed =
    | { readonly index: number; readonly landing: string; readonly plan: TPlan }
    | {
        readonly index: number;
        readonly landing: string | undefined;
        readonly settled: { readonly path: string; readonly value: TValue };
      };
  const keyed: Keyed[] = [];
  for (const { index, value } of [...results].sort((a, b) => a.index - b.index)) {
    if (value === undefined) continue;
    if (value.status === 'fail') {
      slots[index] = { status: 'failure', path: value.failure.path, error: value.failure.error };
    } else if (value.status === 'settled') {
      keyed.push({ index, landing: value.landing, settled: value });
    } else {
      keyed.push({ index, landing: spec.landing(value.plan), plan: value.plan });
    }
  }

  const toKey = keyed.filter((entry) => entry.landing !== undefined);
  // One Landing cannot repeat: skip the guard's directory reads.
  const keys =
    toKey.length < 2
      ? []
      : await ctx.fs.pathGuard.entryKeys(
          toKey.map((entry) => entry.landing ?? ''),
          ctx.signal,
        );
  const keyOf = new Map(toKey.map((entry, i) => [entry, keys[i] ?? entry.landing ?? '']));

  let survivors: { plan: TPlan; index: number }[] = [];
  if (duplicates.policy === 'fail') {
    const firstByKey = new Map<string, TPlan>();
    for (const entry of keyed) {
      if ('settled' in entry) {
        slots[entry.index] = { status: 'settled', ...entry.settled };
        continue;
      }
      const key = keyOf.get(entry) ?? entry.landing;
      const first = firstByKey.get(key);
      const refusal = first === undefined ? undefined : duplicates.refuse(entry.plan, first);
      if (refusal !== undefined) {
        slots[entry.index] = {
          status: 'failure',
          path: spec.slotPath(entry.plan),
          error: refusal,
        };
        continue;
      }
      if (first === undefined) firstByKey.set(key, entry.plan);
      survivors.push({ plan: entry.plan, index: entry.index });
    }
  } else {
    // A repeated validated path is one entry. A shared key is one only when
    // both plans also saw one entry: a link or a replaced entry can share a
    // key and not an Entry, and two on-disk names that fold alike stay apart.
    const seenLandings = new Set<string>();
    const kept: { plan: TPlan; key: string }[] = [];
    for (const entry of keyed) {
      const key = keyOf.get(entry) ?? entry.landing;
      const repeated =
        (entry.landing !== undefined && seenLandings.has(entry.landing)) ||
        ('plan' in entry &&
          kept.some(
            (earlier) => earlier.key === key && duplicates.sameEntry(entry.plan, earlier.plan),
          ));
      if (repeated) {
        slots[entry.index] = { status: 'omitted' };
        continue;
      }
      if (entry.landing !== undefined) seenLandings.add(entry.landing);
      if ('settled' in entry) {
        slots[entry.index] = { status: 'settled', ...entry.settled };
      } else {
        kept.push({ plan: entry.plan, key: key ?? '' });
        survivors.push({ plan: entry.plan, index: entry.index });
      }
    }
  }

  if (spec.refuse !== undefined && survivors.length > 0) {
    const refused = await spec.refuse(survivors);
    for (const { plan, index } of survivors) {
      const error = refused.get(index);
      if (error !== undefined)
        slots[index] = { status: 'failure', path: spec.slotPath(plan), error };
    }
    survivors = survivors.filter(({ index }) => !refused.has(index));
  }

  // While an approval is due, the round returns input_required atomically
  // (R14): nothing has changed yet, not even the items that ask nothing.
  const asked = survivors.map(({ plan }) => spec.confirmItem(plan));
  const confirmed = await confirm(
    ctx,
    spec.op,
    spec.accept,
    asked.filter((item) => item !== undefined),
  );
  if (isInputRequiredResult(confirmed)) return confirmed;
  const verdictOf = (at: number): { verdict: Verdict; path: string } => {
    const item = asked[at];
    return item === undefined
      ? { verdict: 'proceed', path: '' }
      : { verdict: confirmed.verdict(item.path), path: item.path };
  };

  if (spec.onRefusal === 'fail call') {
    for (const at of survivors.keys()) {
      const { verdict, path } = verdictOf(at);
      if (isRefused(verdict)) {
        throw new FsError(ErrorCode.CANCELLED, cancelMessage(spec.op, path, verdict), path);
      }
    }
  }

  for (const [at, { plan, index }] of survivors.entries()) {
    const item = items[index];
    if (item === undefined) continue;
    const { verdict, path } = verdictOf(at);
    slots[index] = {
      status: 'pending',
      path: spec.slotPath(plan),
      run: async (c) => {
        if (verdict === 'skipped') return spec.skipped(plan);
        if (isRefused(verdict)) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- Batch catches and preserves non-Error Problem
          throw Problem.cancelled(cancelMessage(spec.op, path, verdict), { path });
        }
        return spec.run(plan, item, c);
      },
    };
  }

  for (const [index, item] of items.entries()) {
    const path = spec.pathOf(item);
    slots[index] ??= {
      status: 'failure',
      path,
      error: Problem.fromUnknown(new Error(`Unknown ${spec.op} failure`), ErrorCode.UNKNOWN, path),
    };
  }

  return {
    execute: (options) =>
      executeBatchSlots(slots, ctx, { defaultErrorCode: ErrorCode.UNKNOWN, ...options }),
  };
}

export async function runOverPaths<TItem extends string | { path: string }, TPerPath>(
  items: readonly TItem[],
  ctx: ToolCtx,
  defaultErrorCode: ErrorCode,
  perPath: (item: TItem, ctx: ToolCtx) => Promise<TPerPath>,
): Promise<BatchResult<TPerPath>> {
  const pathOf = (item: TItem): string => (typeof item === 'string' ? item : item.path);
  const slots: BatchSlot<TPerPath>[] = items.map((item) => ({
    status: 'pending',
    path: pathOf(item),
    run: () => perPath(item, ctx),
  }));
  return executeBatchSlots(slots, ctx, { defaultErrorCode });
}

export function summarize(
  results: readonly PerPathResult<unknown>[],
): BatchResult<unknown>['summary'] {
  const failed = results.filter((r) => 'error' in r).length;
  return { total: results.length, succeeded: results.length - failed, failed };
}

/**
 * The first failures as text lines: the structured half ships under `_meta`,
 * which clients do not show the model, so the reasons must ride the text.
 */
export function failureLines(failures: readonly PerPathResult<unknown>[]): string[] {
  const lines: string[] = [];
  for (const f of failures) {
    if (!('error' in f)) continue;
    lines.push(`// ${f.path}: ${f.error.code} ${f.error.message}`);
    if (lines.length === MAX_FAILURE_LINES) break;
  }
  return lines;
}

/**
 * A batch where every requested item failed produced no work at all, so it is a
 * failed call - `isError` must say so. Partial failure is deliberately NOT an
 * error: the per-item entries carry which failed, and the succeeded ones really
 * were done. Zero items is not a failure either.
 */
export function isTotalFailure(summary: {
  readonly total: number;
  readonly failed: number;
}): boolean {
  return summary.total > 0 && summary.failed === summary.total;
}
