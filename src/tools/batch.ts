import type { Stats } from 'node:fs';

import { processInParallel } from '../core/concurrency.ts';
import { type ErrorCode, type PerPathResult, Problem } from '../core/errors.ts';
import { PARALLEL_CONCURRENCY } from '../core/util.ts';
import type { ToolCtx } from './define.ts';

export interface BatchResult<T> {
  results: PerPathResult<T>[];
  summary: { total: number; succeeded: number; failed: number };
}

export async function runOverPaths<TItem extends string | { path: string }, TPerPath>(
  items: readonly TItem[],
  ctx: ToolCtx,
  defaultErrorCode: ErrorCode,
  perPath: (item: TItem, ctx: ToolCtx) => Promise<TPerPath>,
): Promise<BatchResult<TPerPath>> {
  const total = items.length;
  let completed = 0;
  const results: PerPathResult<TPerPath>[] = new Array<PerPathResult<TPerPath>>(total);

  const tick = (): void => {
    completed += 1;
    ctx.onProgress({ current: completed, total });
  };

  await processInParallel(
    items,
    async (item, index) => {
      const path = typeof item === 'string' ? item : item.path;
      try {
        const value = await perPath(item, ctx);
        results[index] = { path, value };
      } catch (error: unknown) {
        results[index] = {
          path,
          error: Problem.fromUnknown(error, defaultErrorCode, path),
        };
      } finally {
        tick();
      }
    },
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  return { results, summary: summarize(results) };
}

export function summarize(
  results: readonly PerPathResult<unknown>[],
): BatchResult<unknown>['summary'] {
  const failed = results.filter((r) => 'error' in r).length;
  return { total: results.length, succeeded: results.length - failed, failed };
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

/** Post-write stat for advisory metadata: undefined when the stat fails
 * (concurrent delete, etc.), so callers fall back exactly as before. */
export async function postWriteStat(ctx: ToolCtx, validPath: string): Promise<Stats | undefined> {
  try {
    return (await ctx.fs.stat(validPath)).stats;
  } catch {
    return undefined;
  }
}
