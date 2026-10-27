import { isUtf8 } from 'node:buffer';
import type { Stats } from 'node:fs';
import { opendir, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { StoppedReason } from './concurrency.ts';
import { withAbort } from './concurrency.ts';
import { ErrorCode, formatUnknownErrorMessage, FsError } from './errors.ts';
import type { GuardedFileSystem } from './fs.ts';
import { globEntries } from './glob.ts';
import { MIME_SAMPLE_SIZE } from './mime.ts';
import { Logger } from './observability.ts';
import type { EntryType } from './path-utils.ts';
import { normalizePath, resolveEntryType } from './path-utils.ts';
import type { PathGuard } from './path.ts';
import { assertFileStats, binaryKind, binaryRefusal, NOT_UTF8_MESSAGE } from './read.ts';
import { getMaxTextFileSize } from './util.ts';

/** The chunk `FileHandle#readFile` reads in, and checks its signal between. */
const READ_CHUNK_BYTES = 512 * 1024;

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

export type TextVerdict =
  | { readonly kind: 'text'; readonly bytes: Buffer; readonly stats: Stats }
  | { readonly kind: 'undecodable'; readonly bytes: Buffer; readonly stats: Stats }
  | { readonly kind: 'binary'; readonly utf16: boolean }
  | { readonly kind: 'tooLarge'; readonly size: number };

/**
 * The one content verdict (ADR-005): guarded open, size, read's binary rule on
 * the leading bytes, then strict UTF-8 on the rest. Never decodes; a caller
 * that searches lossily decodes an `undecodable` file's bytes itself.
 */
export async function readText(
  fs: GuardedFileSystem,
  path: string,
  signal?: AbortSignal,
): Promise<TextVerdict> {
  const maxFileSize = getMaxTextFileSize();
  let bytes: Buffer;
  let stats: Stats;
  {
    // open() validates, refuses a swapped final symlink (O_NOFOLLOW) and
    // re-checks the descriptor's real path (H4), so these bytes are the
    // validated file's, not whatever the name points at by now.
    await using handle = await fs.open(path);
    stats = await handle.stat();
    const { size } = stats;
    if (size > maxFileSize) return { kind: 'tooLarge', size };
    // Read the size fstat reported: handle.readFile would fstat again and then
    // read once more to find EOF, two extra round trips on every file a walk
    // touches. A file that grows meanwhile is read as it was at the fstat.
    // A size of 0 is also what procfs and other virtual files report while
    // holding text, so those still read to EOF.
    if (size === 0) {
      bytes = await handle.readFile({ signal });
      if (bytes.length > maxFileSize) return { kind: 'tooLarge', size: bytes.length };
    } else {
      bytes = Buffer.allocUnsafe(size);
      let filled = 0;
      while (filled < size) {
        // In readFile's own chunks, with its check of the signal before each,
        // so a deadline on a slow filesystem lands as soon as it did there.
        signal?.throwIfAborted();
        const length = Math.min(size - filled, READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(bytes, filled, length, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      bytes = bytes.subarray(0, filled);
    }
  }
  // The probe is a slice of the bytes already read: no extra syscall.
  const binary = binaryKind(path, bytes.subarray(0, MIME_SAMPLE_SIZE));
  if (binary !== undefined) return { kind: 'binary', utf16: binary === 'utf16' };
  // The probe samples only the leading bytes. A caller that writes the text
  // back must refuse any byte the decode would replace with U+FFFD.
  if (!isUtf8(bytes) || bytes.includes(0)) return { kind: 'undecodable', bytes, stats };
  return { kind: 'text', bytes, stats };
}

/**
 * A file the client named is not a scan (ADR-005): any verdict but text fails
 * the call, with the refusals edit, patch and diff have always given.
 */
export async function readNamedText(
  fs: GuardedFileSystem,
  filePath: string,
  options?: { readonly signal?: AbortSignal | undefined; readonly tool?: string },
): Promise<{ validPath: string; content: string; stats: Stats }> {
  const signal = options?.signal;
  const { stats, validPath } = await fs.stat(filePath, { signal });
  assertFileStats(filePath, stats);
  const verdict = await readText(fs, validPath, signal);
  switch (verdict.kind) {
    case 'text':
      return { validPath, content: verdict.bytes.toString('utf8'), stats: verdict.stats };
    case 'tooLarge': {
      const maxSize = getMaxTextFileSize();
      // `tool` labels the TOO_LARGE message so the client sees which tool refused.
      throw new FsError(
        ErrorCode.TOO_LARGE,
        `File too large for ${options?.tool ?? 'edit'} (${verdict.size} bytes > ${maxSize} bytes)`,
        filePath,
        { size: verdict.size, maxFileSize: maxSize },
      );
    }
    case 'binary':
      throw binaryRefusal(verdict.utf16 ? 'utf16' : 'binary', filePath);
    case 'undecodable':
      throw new FsError(ErrorCode.INVALID_INPUT, NOT_UTF8_MESSAGE, filePath);
  }
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
  /** Called once per walk index when it is done: onEntry settled, or it was never admitted. */
  readonly onSettled?: (index: number) => void;
  /** Walk index i is admitted only once every index below `i - window` has settled. */
  readonly window?: number;
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

  const { pathGuard, cap, maxEntries, onScanned, window } = options;
  const weigh = options.weigh ?? (() => 1);
  const results = new Map<number, R>();
  let scanned = 0;
  let skippedInaccessible = 0;
  // A directory can fail both its probe and its verdict: count each path once.
  const counted = new Set<string>();
  const countInaccessible = (path: string): void => {
    const key = normalizePath(path);
    if (counted.has(key)) return;
    counted.add(key);
    skippedInaccessible++;
  };
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
          capped ??= 'maxResults';
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
        return { result: await onEntry({ path, type, index }) };
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
