import { opendir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { StoppedReason } from './concurrency.ts';
import { ErrorCode, FsError, isSkippableErrno } from './errors.ts';
import type { GuardedFileSystem } from './fs.ts';
import { globEntries } from './glob.ts';
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
 * wins over the caps, and an abort resolves as `'timeout'`, never rejects.
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

  // fs.glob reads an unreadable directory as empty; opening it is how the
  // Scan learns it skipped one.
  const probes: string[] = [scope.root];
  const probe = async (dir: string): Promise<void> => {
    try {
      await (await opendir(dir)).close();
    } catch (error) {
      if (isSkippableErrno(error)) skippedInaccessible++;
    }
  };
  const drainProbes = async (): Promise<void> => {
    for (let dir = probes.shift(); dir !== undefined; dir = probes.shift()) {
      const target = dir;
      await run(() => probe(target));
    }
  };

  const visit = async (path: string, type: EntryType, index: number): Promise<void> => {
    const verdict = await pathGuard.entryVerdict(path);
    if (verdict === 'sensitive') return;
    if (verdict === 'inaccessible') {
      skippedInaccessible++;
      return;
    }
    if (signal?.aborted) return;
    if (cap !== undefined && total >= cap) {
      capped ??= 'maxResults';
      return;
    }
    if (maxEntries !== undefined && started >= maxEntries) {
      capped ??= 'maxFiles';
      return;
    }
    started++;
    let result: R | undefined;
    try {
      result = await onEntry({ path, type, index });
    } catch {
      // An abort is the stop, not this entry's failure.
      if (!signal?.aborted) skippedInaccessible++;
      return;
    }
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
      if (signal?.aborted || capped !== undefined || fatal !== undefined) break;
      await drainProbes();
      const at = index++;
      await run(() => visit(path, resolveEntryType(dirent), at));
    }
    if (!signal?.aborted && capped === undefined) await drainProbes();
  } catch (error) {
    // A walk the signal cut short throws its reason (see globEntries): that is
    // the timeout below, not a failed walk.
    if (!signal?.aborted) walkError = error;
  }
  await Promise.allSettled([...pending]);

  if (fatal !== undefined) throw fatal.error as Error;
  if (walkError !== undefined) throw walkError as Error;
  const stoppedReason: StoppedReason | undefined = signal?.aborted
    ? 'timeout'
    : cap !== undefined && total > cap
      ? 'maxResults'
      : capped;
  return {
    results: [...results.entries()].sort(([a], [b]) => a - b).map(([, result]) => result),
    scanned,
    skippedInaccessible,
    ...(stoppedReason ? { stoppedReason } : {}),
  };
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
  const results = result === undefined ? [] : [result];
  const weight = result === undefined ? 0 : (options.weigh?.(result) ?? 1);
  const stoppedReason: StoppedReason | undefined = signal?.aborted
    ? 'timeout'
    : options.cap !== undefined && weight > options.cap
      ? 'maxResults'
      : undefined;
  return {
    results,
    scanned: 1,
    skippedInaccessible: 0,
    ...(stoppedReason ? { stoppedReason } : {}),
  };
}
