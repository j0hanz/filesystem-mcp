import { normalizeUnknownError } from './errors.ts';
import { PARALLEL_CONCURRENCY } from './util.ts';

export type StoppedReason = 'maxResults' | 'maxMatches' | 'maxFiles' | 'timeout';

const exclusiveChains = new Map<unknown, Promise<unknown>>();

/**
 * Run `fn` as the next holder of `key`'s lock: a read-`await`-write under one
 * key never interleaves with another. A rejected `fn` does not poison the next
 * waiter, and the entry is dropped once the chain drains. Keys: a PathGuard
 * instance (allowed-set grants) or a resolved write target (per-file writes).
 */
export async function runExclusive<T>(key: unknown, fn: () => Promise<T>): Promise<T> {
  const run = (exclusiveChains.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  exclusiveChains.set(key, tail);
  try {
    return await run;
  } finally {
    if (exclusiveChains.get(key) === tail) exclusiveChains.delete(key);
  }
}

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

  await Promise.allSettled(Array.from({ length: Math.min(itemCount, concurrency) }, next));
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

export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    // The caller already started `promise`; nothing else awaits it, so a late
    // rejection would be unhandled, and the server exits on one.
    promise.catch(() => undefined);
    signal.throwIfAborted();
  }
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
