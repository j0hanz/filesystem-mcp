import { opendir, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { StoppedReason } from './concurrency.ts';
import { withAbort } from './concurrency.ts';
import { ErrorCode, formatUnknownErrorMessage, FsError, isSkippableErrno } from './errors.ts';
import type { GuardedFileSystem } from './fs.ts';
import { globEntries } from './glob.ts';
import { Logger } from './observability.ts';
import type { EntryType } from './path-utils.ts';
import { resolveEntryType } from './path-utils.ts';
import type { PathGuard } from './path.ts';

export interface ScanScope {
  readonly root: string;
  /** A file the client named: no walk, and any error on it fails the call. */
  readonly explicitFile?: string;
}

/** Explicit files bypass glob filtering; their parent is the scope root. */
export async function resolveScanScope(
  path: string | undefined,
  fs: GuardedFileSystem,
  options: { readonly signal?: AbortSignal; readonly allowFile: boolean },
): Promise<ScanScope> {
  const requested = fs.pathGuard.resolvePathOrRoot(path);
  // One resolution, one stat: validateExistingDirectory would redo both.
  const { stats, validPath: resolved } = await fs.stat(
    requested,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (!stats.isFile() || !options.allowFile) {
    if (!stats.isDirectory()) {
      throw new FsError(ErrorCode.NOT_DIRECTORY, 'Not a directory', requested);
    }
    return { root: resolved };
  }
  // The name is NOT turned into a glob: `[slug].tsx` would read as a
  // character class. The scan visits exactly this file instead, and
  // hidden/ignored filtering is moot for a file the caller named.
  return { root: dirname(resolved), explicitFile: resolved };
}

export interface ScanEntry {
  readonly path: string;
  readonly type: EntryType;
  /** Walk order. */
  readonly index: number;
}

export interface ScanOptions<R> {
  readonly pathGuard: PathGuard;
  readonly pattern: string;
  readonly baseNameMatch: boolean;
  readonly includeHidden: boolean;
  readonly includeIgnored: boolean;
  readonly onlyFiles: boolean;
  /** 0-based, as globEntries takes it. */
  readonly maxDepth?: number;
  readonly concurrency: number;
  readonly cap?: number;
  /** Default: 1 per defined result. */
  readonly weigh?: (result: R) => number;
  readonly maxEntries?: number;
  readonly signal?: AbortSignal;
  /** Called after each onEntry resolves. */
  readonly onScanned?: (scanned: number) => void;
}

export interface ScanOutcome<R> {
  /** Walk order; undefined returns are dropped. */
  readonly results: readonly R[];
  /** Entries whose onEntry resolved. */
  readonly scanned: number;
  readonly skippedInaccessible: number;
  readonly stoppedReason?: StoppedReason;
}

/**
 * The one Scan every walking tool runs: walk the scope, rule on each entry
 * (sensitive is dropped, inaccessible counted, ok handed to `onEntry`), probe
 * each directory the walk reads, and say why it stopped early. The signal
 * wins over the caps, and an abort that cut work short resolves as `'timeout'`,
 * never rejects.
 */
export async function scan<R>(
  scope: ScanScope,
  options: ScanOptions<R>,
  onEntry: (entry: ScanEntry) => Promise<R | undefined>,
): Promise<ScanOutcome<R>> {
  const { signal } = options;
  if (scope.explicitFile !== undefined) {
    return scanNamedFile(scope.explicitFile, options, onEntry);
  }

  const { pathGuard, cap, maxEntries, onScanned } = options;
  const weigh = options.weigh ?? (() => 1);
  const results = new Map<number, R>();
  let scanned = 0;
  let skippedInaccessible = 0;
  let total = 0;
  let started = 0;
  let capped: 'maxResults' | 'maxFiles' | undefined;
  let fatal: { error: unknown } | undefined;
  // The signal stopped work that had not finished: only then is it a 'timeout'.
  let cut = false;

  const pending = new Set<Promise<void>>();
  const run = async (task: () => Promise<void>): Promise<void> => {
    if (pending.size >= options.concurrency) await Promise.race(pending);
    // A task records its own outcome, so the tracked promise never rejects.
    const tracked = task().catch((error: unknown) => {
      fatal ??= { error };
    });
    pending.add(tracked);
    void tracked.finally(() => pending.delete(tracked));
  };

  const probes: string[] = [scope.root];
  const probe = async (dir: string): Promise<void> => {
    try {
      if (await probeDirectory(dir, pathGuard, signal)) skippedInaccessible++;
    } catch (error) {
      if (!signal?.aborted) throw error;
      cut = true;
    }
  };
  const drainProbes = async (): Promise<void> => {
    for (let dir = probes.shift(); dir !== undefined; dir = probes.shift()) {
      // No probe starts once the signal has aborted, the root's included.
      if (signal?.aborted) {
        cut = true;
        return;
      }
      const target = dir;
      await run(() => probe(target));
    }
  };

  // Verdicts run concurrently, but admission (the counts and the caps) runs in
  // walk order: each entry awaits the previous entry's admission, so
  // `maxEntries` admits exactly the first usable entries a caller may mutate.
  let admissions: Promise<void> = Promise.resolve();
  // Admitted entries whose onEntry has not settled: one may fail and free its slot.
  const inFlight = new Set<Promise<unknown>>();
  const admit = async (path: string, previous: Promise<void>, release: () => void) => {
    try {
      const verdict = await pathGuard.entryVerdict(path);
      await previous;
      // A count after a fatal error is moot: the scan rethrows it.
      if (verdict === 'sensitive') return false;
      if (verdict === 'inaccessible') {
        skippedInaccessible++;
        return false;
      }
      for (;;) {
        if (fatal !== undefined) return false;
        if (signal?.aborted) {
          cut = true;
          return false;
        }
        if (cap !== undefined && total >= cap) {
          capped ??= 'maxResults';
          return false;
        }
        if (maxEntries !== undefined && started >= maxEntries) {
          if (inFlight.size > 0) {
            await Promise.race(inFlight);
            continue;
          }
          capped ??= 'maxFiles';
          return false;
        }
        started++;
        return true;
      }
    } finally {
      release();
    }
  };

  const visit = async (
    path: string,
    type: EntryType,
    index: number,
    previous: Promise<void>,
    release: () => void,
  ): Promise<void> => {
    if (!(await admit(path, previous, release))) return;
    const settled = (async () => {
      try {
        return { result: await onEntry({ path, type, index }) };
      } catch {
        // An abort is the stop, not this entry's failure.
        if (signal?.aborted) cut = true;
        else {
          skippedInaccessible++;
          // Counted as inaccessible, it frees its maxEntries slot.
          started--;
        }
        return undefined;
      }
    })();
    inFlight.add(settled);
    const done = await settled;
    inFlight.delete(settled);
    if (done === undefined) return;
    const { result } = done;
    scanned++;
    onScanned?.(scanned);
    if (result !== undefined) {
      results.set(index, result);
      total += weigh(result);
    }
  };

  const ceiling = pathGuard.allowedRootContaining(scope.root);
  // shortcut: a pattern's literal prefix dir is not probed; probe it if clients scope by prefix
  const entries = globEntries({
    cwd: scope.root,
    pattern: options.pattern,
    baseNameMatch: options.baseNameMatch,
    includeHidden: options.includeHidden,
    onlyFiles: options.onlyFiles,
    skipIgnored: !options.includeIgnored,
    pathGuard,
    ...(ceiling !== undefined ? { ignoreCeiling: ceiling } : {}),
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    ...(signal ? { signal } : {}),
    suppressErrors: true,
    // Runs inside fs.glob's exclude callback, so it only queues.
    onDirectory: (dir) => probes.push(dir),
  });

  let walkError: unknown;
  let index = 0;
  try {
    await drainProbes();
    for await (const { path, dirent } of entries) {
      if (signal?.aborted) {
        cut = true;
        break;
      }
      if (capped !== undefined || fatal !== undefined) break;
      await drainProbes();
      const at = index++;
      const previous = admissions;
      let release!: () => void;
      admissions = new Promise((resolve) => {
        release = resolve;
      });
      await run(() => visit(path, resolveEntryType(dirent), at, previous, release));
    }
    if (signal?.aborted) cut ||= probes.length > 0;
    else if (capped === undefined) await drainProbes();
  } catch (error) {
    // A walk the signal cut short throws its reason (see globEntries): that is
    // the timeout below, not a failed walk.
    if (signal?.aborted) cut = true;
    else walkError = error;
  }
  await Promise.allSettled([...pending]);

  if (fatal !== undefined) throw fatal.error as Error;
  if (walkError !== undefined) throw walkError as Error;
  const stoppedReason: StoppedReason | undefined = cut ? 'timeout' : capped;
  return {
    results: [...results.entries()].sort(([a], [b]) => a - b).map(([, result]) => result),
    scanned,
    skippedInaccessible,
    ...(stoppedReason ? { stoppedReason } : {}),
  };
}

/**
 * True when `dir` counts as skipped: fs.glob reads an unreadable directory as
 * empty, so opening it is how the Scan learns it skipped one. A sensitive
 * directory, under either spelling, is never counted: the count would reveal it.
 * The open races the signal, so a stalled mount ends the probe at the deadline;
 * an abort rejects.
 */
export async function probeDirectory(
  dir: string,
  pathGuard: PathGuard,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    signal?.throwIfAborted();
    const opening = opendir(dir);
    const handle = await withAbort(opening, signal).catch((error: unknown) => {
      // A handle that arrives after the race was lost is closed, not leaked.
      void opening
        .then(
          (late) => late.close(),
          () => undefined,
        )
        .catch((closeErr: unknown) => {
          Logger.warn(
            `Failed to release directory probe of ${dir} after abort: ${formatUnknownErrorMessage(closeErr)}`,
          );
        });
      throw error;
    });
    await handle.close();
    return false;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!isSkippableErrno(error) || pathGuard.isSensitive(dir)) return false;
    try {
      return !pathGuard.isSensitive(await realpath(dir));
    } catch {
      return true;
    }
  }
}

/** A named file: the guard's errors and onEntry's fail the call, unless the signal aborted. */
async function scanNamedFile<R>(
  explicitFile: string,
  options: ScanOptions<R>,
  onEntry: (entry: ScanEntry) => Promise<R | undefined>,
): Promise<ScanOutcome<R>> {
  const { signal } = options;
  const timedOut: ScanOutcome<R> = {
    results: [],
    scanned: 0,
    skippedInaccessible: 0,
    stoppedReason: 'timeout',
  };
  await options.pathGuard.validateExistingPath(explicitFile);
  if (signal?.aborted) return timedOut;
  let result: R | undefined;
  try {
    // resolveScanScope already proved it is a file.
    result = await onEntry({ path: explicitFile, type: 'file', index: 0 });
  } catch (error) {
    if (signal?.aborted) return timedOut;
    throw error;
  }
  options.onScanned?.(1);
  return {
    results: result === undefined ? [] : [result],
    scanned: 1,
    skippedInaccessible: 0,
  };
}
