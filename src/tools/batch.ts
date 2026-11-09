import { processInParallel } from '../core/concurrency.ts';
import { ErrorCode, type PerPathResult, Problem } from '../core/errors.ts';
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

function toProblem(error: unknown, defaultCode: ErrorCode, path: string): Problem {
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
