import * as z from 'zod/v4';

import { normalizeUnknownError } from './errors.js';
import { PARALLEL_CONCURRENCY } from './util.js';

export type StoppedReason = 'maxResults' | 'maxFiles' | 'timeout';

export const StoppedReasonSchema = z.enum(['maxResults', 'maxFiles', 'timeout']).optional();

/**
 * The subset `search_text` and `find_files` can actually emit. Their scans call
 * only `hitMaxResults` and `hitAbort` (search.ts), never `hitMaxFiles`, so the
 * three-value enum published a value no response can carry and disagreed with
 * both tools' own descriptions.
 */
export const SearchStoppedReasonSchema = z.enum(['maxResults', 'timeout']).optional();

/**
 * Accumulates why an enumeration stopped early. maxResults wins over maxFiles
 * wins over timeout (the most specific cap is the definite cause even if the
 * abort also fired on the same iteration). Call `resolve()` once at the end.
 */
export class StopReasonTracker {
  #reason?: StoppedReason;

  hitMaxResults(): void {
    this.#reason = 'maxResults';
  }

  hitMaxFiles(): void {
    if (this.#reason !== 'maxResults') this.#reason = 'maxFiles';
  }

  hitAbort(): void {
    this.#reason ??= 'timeout';
  }

  get truncated(): boolean {
    return this.#reason !== undefined;
  }

  resolve(): StoppedReason | undefined {
    return this.#reason;
  }
}

interface ParallelResult<R> {
  results: { index: number; value: R }[];
  errors: { index: number; error: Error }[];
}

export async function processInParallel<T, R>(
  items: readonly T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = PARALLEL_CONCURRENCY,
  signal?: AbortSignal,
): Promise<ParallelResult<R>> {
  const itemCount = items.length;
  if (itemCount === 0) return { results: [], errors: [] };

  const results: { index: number; value: R }[] = [];
  const errors: { index: number; error: Error }[] = [];

  signal?.throwIfAborted();

  let nextIndex = 0;

  const next = async (): Promise<void> => {
    while (nextIndex < itemCount) {
      signal?.throwIfAborted();

      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) {
        continue;
      }

      try {
        const value = await processor(item);
        signal?.throwIfAborted();
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
  // signal.reason — a TimeoutError — rather than a fresh AbortError, so callers
  // see TIMEOUT, not CANCELLED. The per-item throws above are swallowed by
  // allSettled.
  signal?.throwIfAborted();

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
 * are checked before dispatch, so the returned tracker names exactly one
 * reason — the loop breaks on the first that fires.
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
): Promise<StopReasonTracker> {
  const pending = new Set<Promise<void>>();
  const { signal, concurrency, maxEntries, shouldStop, onEntry, onError, runEntry } = options;
  const tracker = new StopReasonTracker();
  let dispatched = 0;

  const waitForSlot = async (): Promise<void> => {
    if (pending.size < concurrency) return;
    await Promise.race(pending);
  };

  for await (const entry of entries) {
    // The signal is cancellation OR the caller's timeout: stop dispatching and
    // let the caller report the run as incomplete rather than as a full sweep.
    if (signal?.aborted) {
      tracker.hitAbort();
      break;
    }
    if (maxEntries !== undefined && dispatched >= maxEntries) {
      tracker.hitMaxFiles();
      break;
    }
    // Check the result cap before waiting for a slot so an in-flight task that
    // already crossed the cap stops dispatch without an extra wait...
    if (shouldStop?.()) {
      tracker.hitMaxResults();
      break;
    }
    await waitForSlot();
    // ...and again after the slot frees, since tasks settle concurrently. The
    // cap can still be exceeded by at most `concurrency - 1` already-dispatched
    // tasks that are mid-flight; that overrun is inherent to concurrent dispatch.
    if (shouldStop?.()) {
      tracker.hitMaxResults();
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

  return tracker;
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
