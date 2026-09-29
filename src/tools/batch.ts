import { processInParallel } from '../core/concurrency.ts';
import { ErrorCode, FsError, Problem } from '../core/errors.ts';
import { PARALLEL_CONCURRENCY } from '../core/util.ts';
import type { ToolCtx } from './define.ts';

export type PerPathResult<T> = { path: string; value: T } | { path: string; error: Problem };

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
  if (items.length === 0) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      "runOverPaths: at least one of 'path', 'paths', or 'files' must be provided",
    );
  }

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

  let succeeded = 0;
  for (const result of results) {
    if (!('error' in result)) succeeded += 1;
  }

  return {
    results,
    summary: { total, succeeded, failed: total - succeeded },
  };
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
