import * as z from 'zod/v4';

import { normalizeUnknownError } from './errors.ts';
import { PARALLEL_CONCURRENCY } from './util.ts';

export type StoppedReason = 'maxResults' | 'maxFiles' | 'timeout';

export const StoppedReasonSchema = z.enum(['maxResults', 'maxFiles', 'timeout']).optional();

/**
 * The subset `search_text` and `find_files` can actually emit. Their scans call
 * only `hitMaxResults` and `hitAbort` (search.ts), never `hitMaxFiles`, so the
 * three-value enum published a value no response can carry and disagreed with
 * both tools' own descriptions.
 */
export const SearchStoppedReasonSchema = z.enum(['maxResults', 'timeout']).optional();

interface ParallelResult<R> {
  results: { index: number; value: R }[];
  errors: { index: number; error: Error }[];
}

export async function processInParallel<T, R>(
  items: readonly T[],
  processor: (item: T, index: number) => Promise<R>,
  concurrency: number = PARALLEL_CONCURRENCY,
  signal?: AbortSignal,
): Promise<ParallelResult<R>> {
  const itemCount = items.length;
  if (itemCount === 0) return { results: [], errors: [] };

  const results: { index: number; value: R }[] = [];
  const errors: { index: number; error: Error }[] = [];

  signal?.throwIfAborted();

  let nextIndex = 0;
  // Set when a worker saw the signal fire before an item ran — the only
  // shape in which the batch is genuinely incomplete. The annotation
  // matters: without it control-flow analysis keeps the `false` narrowing
  // from the initializer and cannot see the closure assignment.
  let truncated = false as boolean;

  const next = async (): Promise<void> => {
    while (nextIndex < itemCount) {
      if (signal?.aborted) {
        truncated = true;
        signal.throwIfAborted();
      }

      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) {
        continue;
      }

      try {
        // No abort check after the processor: once an item has run, its
        // result is real work that a write caller may have committed to
        // disk. Discarding it here would report a finished append as
        // failed, and a client retry would append twice.
        const value = await processor(item, index);
        results.push({ index, value });
      } catch (error) {
        errors.push({
          index,
          error: normalizeUnknownError(error),
        });
      }
    }
  };

  const workerCount = Math.min(itemCount, concurrency);
  const workers: Promise<void>[] = new Array<Promise<void>>(workerCount);
  for (let index = 0; index < workerCount; index += 1) {
    workers[index] = next();
  }

  await Promise.allSettled(workers);
  // A deadline (AbortSignal.timeout) hit during the run surfaces here as
  // signal.reason — a TimeoutError — rather than a fresh AbortError, so
  // callers see TIMEOUT, not CANCELLED. Only a run that actually skipped
  // items reports the abort: a deadline firing after the last item
  // finished leaves a complete batch, and returning it beats telling the
  // caller that committed writes failed. The per-item throws above are
  // swallowed by allSettled.
  if (truncated) signal?.throwIfAborted();

  results.sort((left, right) => left.index - right.index);
  return { results, errors };
}

/**
 * The streaming sibling of {@link processInParallel}: bounded-concurrency
 * dispatch over an AsyncIterable that may be far larger than the caller wants
 * to walk, so it stops early and reports why.
 *
 * `maxEntries` caps how many entries are dispatched (maxFiles); `shouldStop`
 * lets the caller stop on its own accumulating result count (maxResults). Both
 * are checked before dispatch, so the returned reason is exactly one — the
 * loop breaks on the first that fires. `undefined` means every entry was
 * dispatched.
 */
export async function processEntriesConcurrently(
  entries: AsyncIterable<{ path: string }> | Iterable<{ path: string }>,
  options: {
    signal: AbortSignal | undefined;
    concurrency: number;
    maxEntries?: number;
    shouldStop?: () => boolean;
    onEntry: () => void;
    onError?: (entryPath: string, err: unknown) => void;
    runEntry: (entryPath: string) => Promise<void>;
  },
): Promise<StoppedReason | undefined> {
  const pending = new Set<Promise<void>>();
  const { signal, concurrency, maxEntries, shouldStop, onEntry, onError, runEntry } = options;
  let stoppedReason: StoppedReason | undefined;
  let dispatched = 0;

  const waitForSlot = async (): Promise<void> => {
    if (pending.size < concurrency) return;
    await Promise.race(pending);
  };

  for await (const entry of entries) {
    // The signal is cancellation OR the caller's timeout: stop dispatching and
    // let the caller report the run as incomplete rather than as a full sweep.
    if (signal?.aborted) {
      stoppedReason = 'timeout';
      break;
    }
    if (maxEntries !== undefined && dispatched >= maxEntries) {
      stoppedReason = 'maxFiles';
      break;
    }
    // Check the result cap before waiting for a slot so an in-flight task that
    // already crossed the cap stops dispatch without an extra wait...
    if (shouldStop?.()) {
      stoppedReason = 'maxResults';
      break;
    }
    await waitForSlot();
    // ...and again after the slot frees, since tasks settle concurrently. The
    // cap can still be exceeded by at most `concurrency - 1` already-dispatched
    // tasks that are mid-flight; that overrun is inherent to concurrent dispatch.
    if (shouldStop?.()) {
      stoppedReason = 'maxResults';
      break;
    }
    onEntry();
    dispatched++;

    // Track a non-rejecting wrapper so a rejected task can never propagate out of
    // Promise.race(pending) in waitForSlot() and abort the loop before the final
    // drain below (which would silently abandon other in-flight tasks).
    // runEntry is expected to catch its own errors; if it unexpectedly throws,
    // record it as a failure rather than silently dropping it.
    const tracked = runEntry(entry.path).catch((err: unknown) => {
      onError?.(entry.path, err);
    });
    pending.add(tracked);
    void tracked.finally(() => {
      pending.delete(tracked);
    });
  }

  if (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }

  return stoppedReason;
}

export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Operation aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }),
  ]).finally(() => {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  });
}
