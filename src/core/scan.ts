import { lstat, opendir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { withAbort } from './concurrency.ts';
import { ErrorCode, formatUnknownErrorMessage, FsError } from './errors.ts';
import { type GuardedFileSystem, refusalOf, type TextVerdict } from './fs.ts';
import { globEntries } from './glob.ts';
import { Logger } from './observability.ts';
import type { EntryType } from './path-utils.ts';
import { normalizePath, resolveEntryType } from './path-utils.ts';
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

/** A content verdict a Scan does not hand on: what it counts, without the bytes. */
export type SkipVerdict =
  | { readonly kind: 'binary'; readonly utf16: boolean }
  | { readonly kind: 'undecodable' }
  | { readonly kind: 'tooLarge'; readonly size: number };

/** Returned from a Scan callback in place of a result: the Scan counts it and drops it. */
export class ScanSkip {
  readonly verdict: SkipVerdict;

  constructor(verdict: SkipVerdict) {
    this.verdict = verdict;
  }
}

/** A non-text content verdict as a skip; drops an undecodable file's bytes. */
export function skipOf(verdict: Exclude<TextVerdict, { kind: 'text' }>): ScanSkip {
  return new ScanSkip(verdict.kind === 'undecodable' ? { kind: 'undecodable' } : verdict);
}

export interface ScanEntry {
  readonly path: string;
  readonly type: EntryType;
  /** Walk order. */
  readonly index: number;
  /** A regular file's size, under `includeSizes`; absent when its lstat failed. */
  readonly size?: number;
}

/**
 * Why a scan stopped early, in the caller's own words: each cap is named after
 * the argument that sets it, so no tool renames a reason at output.
 */
export type StoppedReason = 'maxResults' | 'maxMatches' | 'maxFiles' | 'timeout';

export interface ScanOptions<R> {
  readonly pathGuard: PathGuard;
  /** Names the tool in a named file's too-large refusal. */
  readonly tool?: string;
  readonly pattern: string;
  readonly baseNameMatch: boolean;
  readonly includeHidden: boolean;
  readonly includeIgnored: boolean;
  readonly onlyFiles: boolean;
  /** 0-based, as globEntries takes it. */
  readonly maxDepth?: number;
  readonly concurrency: number;
  readonly cap?: number;
  /** The stop reason `cap` (or `keep`) reports. Default: 'maxResults'. */
  readonly capReason?: 'maxResults' | 'maxMatches';
  /**
   * onEntry retains at most this many entries itself: the walk runs on to count
   * the rest, and the outcome reports `capReason` once more were scanned.
   */
  readonly keep?: number;
  /** Default: 1 per defined result. */
  readonly weigh?: (result: R) => number;
  readonly maxEntries?: number;
  readonly signal?: AbortSignal;
  /** lstat each admitted regular file once and hand its size to onEntry. */
  readonly includeSizes?: boolean;
  /** Called after each onEntry resolves. */
  readonly onScanned?: (scanned: number) => void;
  /** Called once per walk index when it is done: onEntry settled, or it was never admitted. */
  readonly onSettled?: (index: number) => void;
  /**
   * Walk index i is admitted only once every index below `i - window` has settled. This pair
   * is scan's admission seam: a consumer bounds how far the walk may run ahead of its
   * settled prefix, and every dispatched index settles, admitted or refused, so a refusal
   * never stalls the prefix. The sole consumer today is the diff budget (core/diff-budget.ts).
   */
  readonly window?: number;
}

/** Default-named folders a walk skipped; `first` holds at most 5. */
export interface ExcludedDirs {
  readonly total: number;
  readonly first: readonly string[];
}

export interface ScanOutcome<R> {
  /** Walk order; undefined returns are dropped. */
  readonly results: readonly R[];
  /** Entries whose onEntry resolved. */
  readonly scanned: number;
  readonly skippedInaccessible: number;
  /** Skips whose verdict was binary or undecodable. */
  readonly skippedBinary: number;
  /** Skips whose verdict was too large. */
  readonly skippedTooLarge: number;
  readonly stoppedReason?: StoppedReason;
  /** Absent when the walk skipped none. */
  readonly excludedDirs?: ExcludedDirs;
  /** Every folder the ignore rules hid; absent when none. A hidden folder counts only under includeHidden. */
  readonly ignoredDirs?: ExcludedDirs;
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
  onEntry: (entry: ScanEntry) => Promise<R | ScanSkip | undefined>,
): Promise<ScanOutcome<R>> {
  const { signal } = options;
  if (scope.explicitFile !== undefined) {
    return scanNamedFile(scope.explicitFile, options, onEntry);
  }

  const { pathGuard, cap, maxEntries, onScanned, window, keep } = options;
  const capReason = options.capReason ?? 'maxResults';
  const weigh = options.weigh ?? (() => 1);
  const results = new Map<number, R>();
  let scanned = 0;
  let skippedInaccessible = 0;
  let skippedBinary = 0;
  let skippedTooLarge = 0;
  // A directory can fail both its probe and its verdict: count each path once.
  const counted = new Set<string>();
  const countInaccessible = (path: string): void => {
    const key = normalizePath(path);
    if (counted.has(key)) return;
    counted.add(key);
    skippedInaccessible++;
  };
  const excludedFirst: string[] = [];
  let excludedTotal = 0;
  const ignoredFirst: string[] = [];
  let ignoredTotal = 0;
  let total = 0;
  let started = 0;
  let capped: StoppedReason | undefined;
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
      if (await probeDirectory(dir, pathGuard, signal)) countInaccessible(dir);
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
  const inFlight = new Set<Promise<undefined>>();
  // Every walk index below `prefix` has settled; `advanced` fires when it moves.
  const settledAbove = new Set<number>();
  let prefix = 0;
  let advanced = Promise.withResolvers<undefined>();
  const settle = (index: number): void => {
    settledAbove.add(index);
    while (settledAbove.delete(prefix)) prefix++;
    advanced.resolve(undefined);
    advanced = Promise.withResolvers();
  };
  /** Resolves to the callback that frees the entry's inFlight slot, or undefined when refused. */
  const admit = async (
    path: string,
    index: number,
    previous: Promise<void>,
    release: () => void,
  ): Promise<(() => void) | undefined> => {
    try {
      const verdict = await pathGuard.entryVerdict(path);
      await previous;
      // A count after a fatal error is moot: the scan rethrows it.
      if (verdict === 'sensitive') return undefined;
      if (verdict === 'inaccessible') {
        countInaccessible(path);
        return undefined;
      }
      // Backpressure: the entries below hold pool slots and were admitted
      // first, so they progress; an abort wakes the wait and is refused below.
      while (window !== undefined && prefix < index - window && !signal?.aborted) {
        await withAbort(advanced.promise, signal).catch(() => undefined);
      }
      for (;;) {
        if (fatal !== undefined) return undefined;
        if (signal?.aborted) {
          cut = true;
          return undefined;
        }
        if (cap !== undefined && total >= cap) {
          capped ??= capReason;
          return undefined;
        }
        if (maxEntries !== undefined && started >= maxEntries) {
          if (inFlight.size > 0) {
            await Promise.race(inFlight);
            continue;
          }
          capped ??= 'maxFiles';
          return undefined;
        }
        started++;
        // Visible to later admissions before the chain is released, so a refusal
        // waits for this entry even if it has not started running yet.
        const slot = Promise.withResolvers<undefined>();
        inFlight.add(slot.promise);
        return () => {
          inFlight.delete(slot.promise);
          slot.resolve(undefined);
        };
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
    try {
      await visitAdmitted(path, type, index, previous, release);
    } finally {
      if (window !== undefined) settle(index);
      options.onSettled?.(index);
    }
  };

  const visitAdmitted = async (
    path: string,
    type: EntryType,
    index: number,
    previous: Promise<void>,
    release: () => void,
  ): Promise<void> => {
    const free = await admit(path, index, previous, release);
    if (free === undefined) return;
    const done = await (async () => {
      try {
        const size = await entrySize(path, type, options);
        return { result: await onEntry({ path, type, index, ...size }) };
      } catch {
        // A file swapped for a sensitive link after admission leaves no trace;
        // a re-check that throws counts the entry, as the failure does.
        const verdict = signal?.aborted
          ? undefined
          : await pathGuard.entryVerdict(path).catch(() => undefined);
        // An abort is the stop, not this entry's failure.
        if (signal?.aborted) cut = true;
        else {
          if (verdict !== 'sensitive') countInaccessible(path);
          // Dropped or counted as inaccessible, it frees its maxEntries slot.
          started--;
        }
        return undefined;
      }
    })();
    free();
    if (done === undefined) return;
    const { result } = done;
    scanned++;
    onScanned?.(scanned);
    if (result instanceof ScanSkip) {
      if (result.verdict.kind === 'tooLarge') skippedTooLarge++;
      else skippedBinary++;
    } else if (result !== undefined) {
      results.set(index, result);
      total += weigh(result);
    }
  };

  // As the tool prints its results: a later call resolves the name from the root, not this walk.
  const shown = pathGuard.resultPaths(scope.root);
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
    onExcludedDir: (rel) => {
      excludedTotal++;
      if (excludedFirst.length < 5) excludedFirst.push(shown.show(join(scope.root, rel)));
    },
    onIgnoredDir: (rel) => {
      if (!options.includeHidden && rel.split('/').some((seg) => seg.startsWith('.'))) return;
      ignoredTotal++;
      if (ignoredFirst.length < 5) ignoredFirst.push(shown.show(join(scope.root, rel)));
    },
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
  const stoppedReason: StoppedReason | undefined = cut
    ? 'timeout'
    : (capped ?? (keep !== undefined && scanned > keep ? capReason : undefined));
  return {
    results: [...results.entries()].sort(([a], [b]) => a - b).map(([, result]) => result),
    scanned,
    skippedInaccessible,
    skippedBinary,
    skippedTooLarge,
    ...(stoppedReason ? { stoppedReason } : {}),
    ...(excludedTotal > 0 ? { excludedDirs: { total: excludedTotal, first: excludedFirst } } : {}),
    ...(ignoredTotal > 0 ? { ignoredDirs: { total: ignoredTotal, first: ignoredFirst } } : {}),
  };
}

/**
 * True when `dir` counts as skipped: fs.glob reads an unreadable directory as
 * empty, so opening it is how the Scan learns it skipped one. Any failure but
 * an abort counts, as it does for an entry's verdict. A sensitive
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
    if (pathGuard.isSensitive(dir)) return false;
    try {
      return !pathGuard.isSensitive(await realpath(dir));
    } catch {
      return true;
    }
  }
}

/**
 * The size `includeSizes` asks for: one lstat of a regular file. A file gone
 * since the walk keeps its place without one; an abort is the scan's stop.
 */
async function entrySize(
  path: string,
  type: EntryType,
  options: Pick<ScanOptions<unknown>, 'includeSizes' | 'signal'>,
): Promise<{ size?: number }> {
  if (!options.includeSizes || type !== 'file') return {};
  try {
    return { size: (await withAbort(lstat(path), options.signal)).size };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return {};
  }
}

/** A named file: the guard's errors, onEntry's and a skip fail the call, unless the signal aborted. */
async function scanNamedFile<R>(
  explicitFile: string,
  options: ScanOptions<R>,
  onEntry: (entry: ScanEntry) => Promise<R | ScanSkip | undefined>,
): Promise<ScanOutcome<R>> {
  const { signal } = options;
  const timedOut: ScanOutcome<R> = {
    results: [],
    scanned: 0,
    skippedInaccessible: 0,
    skippedBinary: 0,
    skippedTooLarge: 0,
    stoppedReason: 'timeout',
  };
  await options.pathGuard.validateExistingPath(explicitFile);
  if (signal?.aborted) return timedOut;
  let result: R | ScanSkip | undefined;
  try {
    // resolveScanScope already proved it is a file.
    const size = await entrySize(explicitFile, 'file', options);
    result = await onEntry({ path: explicitFile, type: 'file', index: 0, ...size });
  } catch (error) {
    if (signal?.aborted) return timedOut;
    throw error;
  }
  if (result instanceof ScanSkip) throw refusalOf(result.verdict, explicitFile, options.tool);
  options.onScanned?.(1);
  return {
    results: result === undefined ? [] : [result],
    scanned: 1,
    skippedInaccessible: 0,
    skippedBinary: 0,
    skippedTooLarge: 0,
  };
}
