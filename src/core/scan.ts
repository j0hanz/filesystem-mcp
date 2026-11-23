import { lstatSync, readFileSync } from 'node:fs';
import {
  glob as fsGlob,
  readFile as fsReadFile,
  lstat,
  opendir,
  readdir,
  realpath,
} from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';

import type { Ignore } from 'ignore';
import ignore from 'ignore';

import { withAbort } from './concurrency.ts';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  isNotFoundErrno,
  rethrowIfAborted,
} from './errors.ts';
import { type GuardedFileSystem, refusalOf } from './fs.ts';
import { Logger } from './observability.ts';
import type { DirentLike, EntryType } from './path-utils.ts';
import {
  IS_CASE_INSENSITIVE_FS,
  isPathInsideDirectory,
  isSamePath,
  normalizeCaseForComparison,
  normalizePath,
  resolveEntryType,
  toPosixPath,
} from './path-utils.ts';
import { type PathGuard, withLinkFreeDirs } from './path.ts';
import { ALPHA_RANGE_RE, NUMERIC_RANGE_RE } from './schema.ts';
import { MIB } from './util.ts';

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

/** A non-text content verdict as a skip. */
export function skipOf(verdict: SkipVerdict): ScanSkip {
  return new ScanSkip(verdict);
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
  /** Globs the walk leaves out, pruned before a folder is read; a named file ignores them. */
  readonly exclude?: readonly string[];
  readonly entryType?: 'file' | 'directory' | 'any';
  /** 0-based directory depth limit below the scan root. */
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
  /** Non-sensitive dot entries directly in the scope root, sorted; absent under includeHidden or when none. */
  readonly hiddenEntries?: ExcludedDirs;
}

/**
 * The one Scan every walking tool runs: walk the scope, rule on each entry
 * (sensitive is dropped, inaccessible counted, ok handed to `onEntry`), probe
 * each directory the walk reads, and say why it stopped early. The signal
 * wins over the caps, and an abort that cut work short resolves as `'timeout'`,
 * never rejects.
 */
export function scan<R>(
  scope: ScanScope,
  options: ScanOptions<R>,
  onEntry: (entry: ScanEntry) => Promise<R | ScanSkip | undefined>,
): Promise<ScanOutcome<R>> {
  return withLinkFreeDirs(() => scanWalk(scope, options, onEntry));
}

async function scanWalk<R>(
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
  const walk: WalkAccounting = {
    shown: pathGuard.resultPaths(scope.root),
    probes: [scope.root],
    excludedFirst: [],
    excludedTotal: 0,
    ignoredFirst: [],
    ignoredTotal: 0,
  };
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

  const probe = async (dir: string): Promise<void> => {
    try {
      if (await probeDirectory(dir, pathGuard, signal)) countInaccessible(dir);
    } catch (error) {
      if (!signal?.aborted) throw error;
      cut = true;
    }
  };
  const drainProbes = async (): Promise<void> => {
    for (let dir = walk.probes.shift(); dir !== undefined; dir = walk.probes.shift()) {
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
  const ceiling = pathGuard.allowedRootContaining(scope.root);
  // shortcut: a pattern's literal prefix dir is not probed; probe it if clients scope by prefix
  const entries = walkEntries(scope.root, options, ceiling, walk);

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
    if (signal?.aborted) cut ||= walk.probes.length > 0;
    else if (capped === undefined) await drainProbes();
  } catch (error) {
    // A walk the signal cut short throws its reason (see walkEntries): that is
    // the timeout below, not a failed walk.
    if (signal?.aborted) cut = true;
    else walkError = error;
  }
  await Promise.allSettled([...pending]);

  if (fatal !== undefined) throw fatal.error as Error;
  if (walkError !== undefined) throw walkError as Error;
  // A cut scan skips the count: its readdir is not bounded by the scan's deadline.
  const hiddenEntries =
    options.includeHidden || cut
      ? undefined
      : await countHidden(scope.root, pathGuard, !options.includeIgnored);
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
    ...(walk.excludedTotal > 0
      ? { excludedDirs: { total: walk.excludedTotal, first: walk.excludedFirst } }
      : {}),
    ...(walk.ignoredTotal > 0
      ? { ignoredDirs: { total: walk.ignoredTotal, first: walk.ignoredFirst } }
      : {}),
    ...(hiddenEntries ? { hiddenEntries } : {}),
  };
}

/**
 * fs.glob never asks `exclude` about dot entries, so one readdir counts them. A sensitive name is
 * never counted, nor a default-excluded one (`.git`) that includeHidden would still skip.
 */
async function countHidden(
  root: string,
  pathGuard: PathGuard,
  skipIgnored: boolean,
): Promise<ExcludedDirs | undefined> {
  try {
    const names = (await readdir(root))
      .filter(
        (name) =>
          name.startsWith('.') &&
          !pathGuard.isSensitive(join(root, name)) &&
          !(skipIgnored && isDefaultExcludedName(name)),
      )
      .sort();
    return names.length > 0 ? { total: names.length, first: names.slice(0, 5) } : undefined;
  } catch {
    return undefined;
  }
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

/** A .gitignore past this size is not a .gitignore; skip it rather than read it. */
const MAX_GITIGNORE_BYTES = MIB;

async function readGitignoreMatcher(
  absPath: string,
  signal?: AbortSignal,
): Promise<Ignore | undefined> {
  try {
    // lstat, not stat: a symlinked .gitignore may point at a device, a
    // FIFO or a huge file outside the root. Only a plain, small file is a
    // rule set worth reading.
    const info = await lstat(absPath);
    if (!info.isFile() || info.size > MAX_GITIGNORE_BYTES) return undefined;
    const contents = await fsReadFile(absPath, { encoding: 'utf-8', signal });
    return ignore().add(contents);
  } catch (error) {
    if (signal?.aborted) throw error;
    rethrowIfAborted(error);
    if (!isNotFoundErrno(error)) {
      Logger.warn(`Failed to read .gitignore at ${absPath}: ${formatUnknownErrorMessage(error)}`);
    }
    return undefined;
  }
}

/**
 * Load `.gitignore` from each ancestor of `root` up to and including `ceiling`,
 * farthest first. A rule set that ignores `root` itself is skipped: the caller
 * named that directory on purpose, and applying the rule would empty the walk.
 */
async function loadAncestorGitignores(
  root: string,
  ceiling: string,
  manager: GitignoreManager,
  signal?: AbortSignal,
): Promise<void> {
  const normalizedCeiling = resolve(ceiling);
  const chain: string[] = [];
  for (let dir = dirname(resolve(root)); ; dir = dirname(dir)) {
    if (!isPathInsideDirectory(normalizedCeiling, dir)) break;
    chain.push(dir);
    if (isSamePath(dir, normalizedCeiling) || dirname(dir) === dir) {
      break;
    }
  }
  for (const dir of chain.reverse()) {
    signal?.throwIfAborted();
    const file = join(dir, '.gitignore');
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > MAX_GITIGNORE_BYTES) continue;
      const matcher = ignore().add(await fsReadFile(file, { encoding: 'utf-8', signal }));
      const prefix = toPosixPath(relative(dir, root));
      if (matcher.test(`${prefix}/`).ignored) continue;
      manager.addAncestorMatcher(prefix, matcher);
    } catch (error) {
      if (signal?.aborted) throw error;
      rethrowIfAborted(error);
      // ENOENT is the normal case (no .gitignore at this level); anything else is not worth a warning per walk
    }
  }
}

class GitignoreManager {
  private matchers = new Map<string, Ignore>();
  /** Rules from directories above the walk root, farthest first; `prefix` re-bases a walk-relative path to that directory. */
  private ancestors: { prefix: string; matcher: Ignore }[] = [];
  private dirCache = new Map<string, boolean>();
  /** Per folder: whether its own `.gitignore` (and those below it) are looked for. */
  private searched = new Map<string, boolean>([['', true]]);

  private readonly root: string;
  private readonly includeHidden: boolean;
  private readonly pathGuard: Pick<PathGuard, 'isSensitive'> | undefined;

  private constructor(
    root: string,
    includeHidden: boolean,
    pathGuard?: Pick<PathGuard, 'isSensitive'>,
  ) {
    this.root = root;
    this.includeHidden = includeHidden;
    this.pathGuard = pathGuard;
  }

  addAncestorMatcher(prefix: string, matcher: Ignore): void {
    this.ancestors.push({ prefix, matcher });
  }

  /**
   * Reads the ancestor and root rules now. A subfolder's `.gitignore` is read
   * the first time a path below it is checked, so the walk itself finds the
   * rules: no second pass over the tree before the first result.
   */
  static async load(
    root: string,
    includeHidden: boolean,
    signal?: AbortSignal,
    ignoreCeiling?: string,
    pathGuard?: Pick<PathGuard, 'isSensitive'>,
  ): Promise<GitignoreManager> {
    const resolvedRoot = resolve(root);
    const manager = new GitignoreManager(resolvedRoot, includeHidden, pathGuard);
    if (ignoreCeiling !== undefined) {
      await loadAncestorGitignores(resolvedRoot, ignoreCeiling, manager, signal);
    }
    const rootMatcher = await readGitignoreMatcher(join(resolvedRoot, '.gitignore'), signal);
    if (rootMatcher) manager.matchers.set('', rootMatcher);
    return manager;
  }

  /**
   * Loads `dir`'s `.gitignore` once; false when the folder is one whose rules
   * are never looked for (hidden without includeHidden, a VCS or default-excluded
   * folder, a sensitive folder, a link, or gone), and so neither are its children's.
   * shortcut: sync lstat/read, because fs.glob's exclude callback is sync; one
   * missing-file lstat per entered folder blocks the loop briefly, a slow network
   * drive would feel it. Upgrade to a custom async walk if that shows up.
   */
  private enter(dir: string): boolean {
    const known = this.searched.get(dir);
    if (known !== undefined) return known;
    const name = dir.slice(dir.lastIndexOf('/') + 1);
    const absDir = join(this.root, dir);
    let searched =
      (this.includeHidden || !name.startsWith('.')) &&
      name !== '.hg' &&
      name !== '.svn' &&
      !isDefaultExcludedName(name) &&
      this.pathGuard?.isSensitive(absDir) !== true;
    if (searched) {
      const file = join(absDir, '.gitignore');
      try {
        if (!lstatSync(absDir).isDirectory()) {
          searched = false;
        } else {
          // lstat, not stat: only a plain, small file is a rule set worth reading.
          const info = lstatSync(file);
          if (info.isFile() && info.size <= MAX_GITIGNORE_BYTES) {
            this.matchers.set(dir, ignore().add(readFileSync(file, 'utf-8')));
          }
        }
      } catch (error) {
        if (!isNotFoundErrno(error)) {
          Logger.warn(`Failed to read .gitignore at ${file}: ${formatUnknownErrorMessage(error)}`);
        }
      }
    }
    this.searched.set(dir, searched);
    return searched;
  }

  isIgnored(relativePath: string, isDirectory: boolean): boolean {
    const normalized = toPosixPath(relativePath);
    if (normalized === '' || normalized === '.') return false;
    const parts = normalized.split('/');

    // 1. Check parent directories first, loading each one's rules once it is known not ignored
    let currentDir = '';
    let searching = true;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;
      currentDir = currentDir ? `${currentDir}/${part}` : part;

      if (this.checkDir(currentDir)) {
        return true;
      }
      if (searching) searching = this.enter(currentDir);
    }

    // 2. Check the file/directory itself
    return isDirectory ? this.checkDir(normalized) : this.checkPath(normalized, false);
  }

  private checkDir(dir: string): boolean {
    const cached = this.dirCache.get(dir);
    if (cached !== undefined) return cached;
    const res = this.checkPath(dir, true);
    this.dirCache.set(dir, res);
    return res;
  }

  private checkPath(posixPath: string, isDirectory: boolean): boolean {
    // Later rule sets override earlier ones, as nested .gitignore files do.
    let ignored = false;
    const apply = (matcher: Ignore, path: string): void => {
      const res = matcher.test(isDirectory && !path.endsWith('/') ? `${path}/` : path);
      if (res.ignored) ignored = true;
      if (res.unignored) ignored = false;
    };

    for (const { prefix, matcher } of this.ancestors) apply(matcher, `${prefix}/${posixPath}`);

    // Check root level
    const rootMatcher = this.matchers.get('');
    if (rootMatcher) apply(rootMatcher, posixPath);

    // Check subdirectories
    const parts = posixPath.split('/');
    let currentDir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;
      currentDir = currentDir ? `${currentDir}/${part}` : part;
      const matcher = this.matchers.get(currentDir);
      if (matcher) apply(matcher, parts.slice(i + 1).join('/'));
    }

    return ignored;
  }
}

interface GlobDirentLike extends DirentLike {
  name: string;
  parentPath: string;
}

interface WalkEntry {
  path: string;
  dirent: DirentLike;
}

interface WalkAccounting {
  readonly shown: ReturnType<PathGuard['resultPaths']>;
  readonly probes: string[];
  readonly excludedFirst: string[];
  excludedTotal: number;
  readonly ignoredFirst: string[];
  ignoredTotal: number;
}

type WalkOptions = Pick<
  ScanOptions<unknown>,
  | 'pattern'
  | 'baseNameMatch'
  | 'includeHidden'
  | 'includeIgnored'
  | 'onlyFiles'
  | 'entryType'
  | 'exclude'
  | 'pathGuard'
  | 'maxDepth'
  | 'signal'
>;

const GLOB_MAGIC_RE = /[*?[\]{}!]/u;
const SEP = '/';

function normalizePattern(pattern: string, baseNameMatch: boolean): string {
  const normalized = toPosixPath(pattern);

  if (!baseNameMatch) return normalized;
  if (normalized.includes(SEP)) return normalized;
  return `**/${normalized}`;
}

/**
 * On a case-insensitive filesystem, turn each ASCII letter outside a `[...]`
 * class into `[xX]`. fs.glob matches literal segments case-sensitively but
 * wildcard segments case-insensitively, and yields on-disk names only for the
 * latter, so a class forces both. A brace range (`{a..c}`) is copied whole:
 * a class inside it would stop it being a range.
 */
function foldPatternCase(pattern: string): string {
  if (!IS_CASE_INSENSITIVE_FS) return pattern;
  const braceRange = /\{[^{},]*\}/uy;
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? '';
    if (ch === '[') {
      // A `]` first in the class (after `!`/`^`) is literal, as in groupClose.
      let end = i + 1;
      if (pattern[end] === '!' || pattern[end] === '^') end++;
      if (pattern[end] === ']') end++;
      const close = pattern.indexOf(']', end);
      if (close === -1) {
        // Unclosed: a literal `[`, not a class that would fold the rest of the pattern into it.
        out += '[[]';
        continue;
      }
      out += pattern.slice(i, close + 1);
      i = close;
    } else if (ch === '{') {
      braceRange.lastIndex = i;
      const set = braceRange.exec(pattern)?.[0];
      const body = set?.slice(1, -1) ?? '';
      if (set && (NUMERIC_RANGE_RE.test(body) || ALPHA_RANGE_RE.test(body))) {
        out += set;
        i += set.length - 1;
      } else out += ch;
    } else if (/[A-Za-z]/u.test(ch)) {
      out += `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
      // A class even where case cannot differ: fs.glob descends a directory link
      // only under a literal segment, and that opens a link to a network path
      // with no exclude call first. Doubled, as `[1]` alone collapses to a literal.
      // shortcut: a segment with none of these characters (`日本`) stays literal; class those too if clients can be steered into such patterns.
    } else if (/[0-9_]/u.test(ch)) {
      out += `[${ch}${ch}]`;
    } else out += ch;
  }
  return out;
}

function splitPatternPrefix(normalizedPattern: string): {
  prefix: string;
  remainder: string;
} {
  const segments = normalizedPattern.split(SEP);
  const splitIndex = segments.findIndex((seg) => GLOB_MAGIC_RE.test(seg));

  if (splitIndex <= 0) {
    return { prefix: '', remainder: normalizedPattern };
  }

  return {
    prefix: segments.slice(0, splitIndex).join(SEP) + SEP,
    remainder: segments.slice(splitIndex).join(SEP),
  };
}

/**
 * The literal leading directories of `prefix`, spelled as on disk. A segment is
 * its exact entry, else the one entry equal to it under ASCII case folding; with
 * none or several, it stays as written and fs.glob finds nothing there, as on a
 * case-sensitive filesystem. Only names come back; the walk filters its results as before.
 */
async function resolvePrefixOnDisk(prefix: string, cwd: string): Promise<string> {
  let dir = cwd;
  const out: string[] = [];
  for (const segment of prefix.slice(0, -SEP.length).split(SEP)) {
    const names = await readdir(dir).catch((): string[] => []);
    const key = normalizeCaseForComparison(segment);
    const folded = names.filter((name) => normalizeCaseForComparison(name) === key);
    const name = names.includes(segment) || folded.length !== 1 ? segment : (folded[0] ?? segment);
    out.push(name);
    dir = join(dir, name);
  }
  return out.join(SEP) + SEP;
}

/**
 * foldPatternCase for a walk under `cwd`, with the literal leading directories
 * spelled as on disk. fs.glob descends a directory symlink only when its segment
 * is literal, so a folded `alias` would stop the walk at the link.
 */
async function foldPatternInWalk(pattern: string, cwd: string): Promise<string> {
  if (!IS_CASE_INSENSITIVE_FS) return pattern;
  const { prefix, remainder } = splitPatternPrefix(pattern);
  if (prefix === '') return foldPatternCase(pattern);
  return (await resolvePrefixOnDisk(prefix, cwd)) + foldPatternCase(remainder);
}

/**
 * Refuses a pattern whose literal leading folders pass through a link to a
 * network or device path. fs.glob and resolvePrefixOnDisk read those folders
 * with no exclude call first, which connects to the host named by the link.
 */
async function assertLeadingFoldersStayLocal(
  patterns: readonly string[],
  cwd: string,
  pathGuard: Pick<PathGuard, 'reachesRemoteLink'>,
): Promise<void> {
  for (const pattern of patterns) {
    const segments = pattern.split(SEP);
    const magic = segments.findIndex((seg) => GLOB_MAGIC_RE.test(seg));
    const literal = magic === -1 ? segments : segments.slice(0, magic);
    if (
      literal.length > 0 &&
      (await pathGuard.reachesRemoteLink(normalizePath(join(cwd, ...literal))))
    ) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        `Pattern "${pattern}" passes through a link to a network or device path.`,
        pattern,
      );
    }
  }
}

/**
 * The segment matching the dot-prefixed names `segment` would match if fs.glob
 * did not skip them, or `undefined` when there are none. Only a leading `*` or `?`
 * stands for that dot: a literal never does, and a character class or a
 * brace set is left as written rather than parsed.
 */
function dotVariant(segment: string): string | undefined {
  // `*(…)`, `?(…)` and `!(…)` are extglobs, not wildcards.
  if (segment[1] === '(') return undefined;
  if (segment.startsWith('*')) return `.${segment}`;
  if (!segment.startsWith('?')) return undefined;
  // `?` is exactly one character, so the dot replaces it, unless what follows
  // could leave just `.` or `..` (`?`, `?.`, `?{.,x}`, `?[.]`): the directory
  // and its parent, not a dot-prefixed entry.
  const rest = segment.slice(1);
  return rest === '' || /^[.[{]/u.test(rest) ? undefined : `.${rest}`;
}

function addFirstDotSegment(patterns: Set<string>, prefix: string, remainder: string): void {
  if (remainder.length === 0) return;
  const segments = remainder.split(SEP);
  const idx = segments.findIndex((seg) => seg !== '**' && seg.length > 0);

  if (idx !== -1) {
    const original = segments[idx];
    const dotted = original ? dotVariant(original) : undefined;
    if (dotted) {
      const newSegments = [...segments];
      newSegments[idx] = dotted;
      patterns.add(`${prefix}${newSegments.join(SEP)}`);
    }
  }
}

const TRAILING_GLOBSTAR_RE = /^(.+\/)\*\*(?:\/\*)?$/u;

function expandHiddenGlobstars(patterns: Set<string>, prefix: string, remainder: string): void {
  // Trailing bare globstar — `src/**`, `**` (remainder is exactly `**`, no
  // following segment). The pattern itself already matches every non-dot
  // entry under the prefix; add the two hidden complements fs.glob skips:
  // dotfiles/dot-dirs anywhere, and the contents of dot-dirs anywhere.
  if (remainder === '**') {
    patterns.add(`${prefix}**/.*`);
    patterns.add(`${prefix}**/.*/**`);
    return;
  }

  // A globstar ending a longer remainder (`**/hooks/**`, `*/hooks/**/*`) skips
  // the same two complements under its stem.
  const stem = TRAILING_GLOBSTAR_RE.exec(remainder)?.[1];
  if (stem) {
    patterns.add(`${prefix}${stem}**/.*`);
    patterns.add(`${prefix}${stem}**/.*/**`);
  }

  if (!remainder.startsWith('**/')) return;

  const afterGlobstar = remainder.slice(3);
  // Node fs.glob skips leading-dot entries unless the matching segment itself
  // starts with '.', and its `dot` option is not honored. So `**/*` alone misses
  // hidden files. Two depth-agnostic patterns cover everything the per-depth
  // unroll did: contents of dot-directories anywhere, and dotfiles/dotdirs
  // anywhere (when the first segment after the globstar can match a dot).
  patterns.add(`${prefix}**/.*/**/${afterGlobstar}`);
  if (stem?.startsWith('**/')) {
    patterns.add(`${prefix}**/.*/**/${stem.slice(3)}**/.*`);
    patterns.add(`${prefix}**/.*/**/${stem.slice(3)}**/.*/**`);
  }
  const [firstSegment = '', ...rest] = afterGlobstar.split(SEP);
  const dotted = dotVariant(firstSegment);
  if (dotted) patterns.add(`${prefix}**/${[dotted, ...rest].join(SEP)}`);
}

function buildHiddenPatterns(normalizedPattern: string): readonly string[] {
  const patterns = new Set<string>([normalizedPattern]);
  const { prefix, remainder } = splitPatternPrefix(normalizedPattern);

  addFirstDotSegment(patterns, prefix, remainder);
  expandHiddenGlobstars(patterns, prefix, remainder);

  return Array.from(patterns);
}

function* processDirentMatch(
  match: GlobDirentLike,
  cwd: string,
  maxDepth: number | undefined,
  seen: Set<string>,
  entryFilter: 'file' | 'directory' | 'any' | 'all',
): Generator<WalkEntry> {
  const absolutePath = resolve(cwd, match.parentPath, match.name);
  // The walk's scope is its cwd, whatever the pattern spells: a `..` or a root
  // the validator did not foresee must not reach a caller, where it would be
  // read, rewritten, or counted and named as inaccessible.
  if (isSamePath(cwd, absolutePath) || !isPathInsideDirectory(cwd, absolutePath)) return;

  if (maxDepth !== undefined) {
    const rel = relative(cwd, absolutePath);
    if (rel.split(/[/\\]/u).length - 1 > maxDepth) return;
  }

  if (seen.has(absolutePath)) return;
  seen.add(absolutePath);

  if (entryFilter === 'file' && !match.isFile()) return;
  if (entryFilter === 'directory' && !match.isDirectory()) return;
  if (entryFilter === 'any' && !match.isFile() && !match.isDirectory()) return;
  yield { path: absolutePath, dirent: match };
}

interface WalkFilter {
  /** Given to fs.glob: true stops descent into a directory. */
  prune: (match: GlobDirentLike) => boolean;
  /** Re-applied to yielded entries: the ignore rules only, never the depth bound. */
  isExcluded: (match: GlobDirentLike) => boolean;
}

function createWalkFilter(
  cwd: string,
  options: WalkOptions,
  gitignoreMatcher: GitignoreManager | null,
  accounting: WalkAccounting,
): WalkFilter {
  const { includeHidden, maxDepth, signal, pathGuard } = options;
  const skipIgnored = !options.includeIgnored;
  // Same spelling rules as `pattern`: a leading ./ or trailing / is no part of the match, and case folds where the disk does.
  const exclude = (options.exclude ?? []).map((glob) =>
    foldPatternCase(
      toPosixPath(glob)
        .replace(/^(?:\.\/)+/u, '')
        .replace(/\/+$/u, ''),
    ),
  );
  // An entry is out when it, or any folder above it, matches a pattern.
  const userExcluded = (segments: readonly string[]): boolean => {
    if (exclude.length === 0) return false;
    return exclude.some((glob) =>
      glob.includes('/')
        ? segments.some((_, i) => posix.matchesGlob(segments.slice(0, i + 1).join('/'), glob))
        : segments.some((name) => posix.matchesGlob(name, glob)),
    );
  };
  // fs.glob asks once per pattern variant, so a directory is asked about repeatedly.
  const reportedDirs = new Set<string>();
  const reportedExcluded = new Set<string>();
  const reportedIgnored = new Set<string>();
  // fs.glob can hand the predicate a dirent whose parentPath is "." — the walk
  // root, not the process cwd — when it re-visits a directory under `**` whose
  // name also exists in the process cwd. Resolving against `cwd` names the
  // entry the dirent describes; `join` would resolve it against the process.
  const absoluteOf = (match: GlobDirentLike): string => resolve(cwd, match.parentPath, match.name);
  // Every default exclude is a bare name that applies at any depth, so a Set
  // lookup per segment replaces compiling dozens of globs per entry.
  const excluded = (posixRel: string, segments: readonly string[], isDir: boolean): boolean =>
    skipIgnored &&
    (segments.some(isDefaultExcludedName) ||
      (gitignoreMatcher?.isIgnored(posixRel, isDir) ?? false));
  // A sensitive directory's subtree is hidden with the directory: pruning
  // stops descent, and the yielded dirent is dropped below. The guard checks
  // the directory's own path, so this never fires on a clean-named entry inside
  // a denylisted tree — the tree never gets walked.
  const sensitiveDir = (absolute: string, isDir: boolean): boolean =>
    isDir && pathGuard.isSensitive(absolute);
  // A sensitive directory anywhere above an entry hides the entry, whatever
  // the pattern spelled: a literal prefix (`vault.key/*.txt`) never asks the
  // descent prune, and a sensitive-named symlink is not isDirectory() so the
  // prune misses it — but every yielded path names its ancestors. The entry's
  // own final name stays with the per-entry guard every caller already runs.
  const sensitiveTreeCache = new Map<string, boolean>();
  const sensitiveTree = (segments: readonly string[]): boolean => {
    for (let i = 1; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      let hit = sensitiveTreeCache.get(prefix);
      if (hit === undefined) {
        hit = pathGuard.isSensitive(resolve(cwd, prefix));
        sensitiveTreeCache.set(prefix, hit);
      }
      if (hit) return true;
    }
    return false;
  };

  return {
    prune: (match) => {
      // fs.glob takes no signal and calls this for every entry it visits, so
      // pruning everything is the only way to stop a walk that yields nothing.
      if (signal?.aborted) return true;
      const absolute = absoluteOf(match);
      // fs.glob asks before it queues a directory, so a walk that would
      // climb to `../` or start at `/` stops at the edge instead of reading
      // there. Not every climb asks (`**/..` does not): processDirentMatch is
      // the gate, this only saves the walk.
      if (!isPathInsideDirectory(cwd, absolute)) return true;
      const posixRel = toPosixPath(relative(cwd, absolute));
      const segments = posixRel.split('/');
      const isDir = match.isDirectory();
      if (userExcluded(segments)) return true;
      if (excluded(posixRel, segments, isDir)) {
        if (isDir && !sensitiveDir(absolute, isDir) && !sensitiveTree(segments)) {
          const depth = segments.length - 1;
          if (
            !reportedIgnored.has(posixRel) &&
            (maxDepth === undefined || depth <= maxDepth) &&
            (includeHidden || !segments.some((seg) => seg.startsWith('.')))
          ) {
            reportedIgnored.add(posixRel);
            accounting.ignoredTotal++;
            if (accounting.ignoredFirst.length < 5) {
              accounting.ignoredFirst.push(accounting.shown.show(join(cwd, posixRel)));
            }
          }
          if (!reportedExcluded.has(posixRel)) {
            const name = segments.at(-1) ?? '';
            if (
              isDefaultExcludedName(name) &&
              !name.startsWith('.') &&
              gitignoreMatcher?.isIgnored(posixRel, true) !== true
            ) {
              reportedExcluded.add(posixRel);
              accounting.excludedTotal++;
              if (accounting.excludedFirst.length < 5) {
                accounting.excludedFirst.push(accounting.shown.show(join(cwd, posixRel)));
              }
            }
          }
        }
        return true;
      }
      if (sensitiveDir(absolute, isDir) || sensitiveTree(segments)) return true;
      // Stop descent one level past the depth bound. Pruning a directory *at*
      // the bound would drop it where fs.glob treats it as top-level, so prune
      // its children instead; processDirentMatch drops that extra level.
      const depth = segments.length - 1;
      if (maxDepth !== undefined && isDir && depth > maxDepth) return true;
      // A directory at the bound is listed but not read: none of its contents are wanted.
      if (isDir && (maxDepth === undefined || depth < maxDepth)) {
        if (!reportedDirs.has(absolute)) {
          reportedDirs.add(absolute);
          // Runs inside fs.glob's exclude callback, so it only queues.
          accounting.probes.push(absolute);
        }
      }
      return false;
    },
    isExcluded: (match) => {
      const absolute = absoluteOf(match);
      const posixRel = toPosixPath(relative(cwd, absolute));
      const segments = posixRel.split('/');
      const isDir = match.isDirectory();
      return (
        userExcluded(segments) ||
        excluded(posixRel, segments, isDir) ||
        sensitiveDir(absolute, isDir) ||
        sensitiveTree(segments)
      );
    },
  };
}

async function* walkEntries(
  cwd: string,
  options: WalkOptions,
  ceiling: string | undefined,
  accounting: WalkAccounting,
): AsyncGenerator<WalkEntry> {
  const { maxDepth, signal } = options;
  const skipIgnored = !options.includeIgnored;
  const gitignoreMatcher = skipIgnored
    ? await GitignoreManager.load(cwd, options.includeHidden, signal, ceiling, options.pathGuard)
    : null;

  const resolvedCwd = resolve(cwd);
  const pattern = normalizePattern(options.pattern, options.baseNameMatch);
  // One walk for every variant: fs.glob reads each directory once and matches
  // all of them, where a walk per variant re-read the tree for each.
  const patterns = options.includeHidden ? buildHiddenPatterns(pattern) : [pattern];
  await assertLeadingFoldersStayLocal(patterns, resolvedCwd, options.pathGuard);
  const seen = new Set<string>();
  const entryFilter = options.entryType ?? (!options.onlyFiles ? 'all' : 'file');
  const filter = createWalkFilter(resolvedCwd, options, gitignoreMatcher, accounting);

  const iterable = fsGlob(
    await Promise.all(patterns.map((p) => foldPatternInWalk(p, resolvedCwd))),
    {
      cwd: resolvedCwd,
      exclude: filter.prune,
      withFileTypes: true,
    },
  ) as AsyncIterable<GlobDirentLike>;

  try {
    for await (const match of iterable) {
      if (signal?.aborted) break;
      // A function `exclude` only prunes descent in fs.glob — it still yields
      // the rejected dirent itself, and any rejected entry below the top level.
      // Re-apply the ignore rules (not the depth bound) to drop those.
      if (filter.isExcluded(match)) continue;
      yield* processDirentMatch(match, resolvedCwd, maxDepth, seen, entryFilter);
    }
  } catch (error) {
    Logger.warn(
      `walkEntries: suppressed mid-walk error for pattern "${patterns.join(', ')}": ${formatUnknownErrorMessage(error)}`,
    );
  }
  // A pruned walk ends like a finished one. Say it was cut short, so no caller
  // reads "the walk ended" as "the whole tree was seen".
  signal?.throwIfAborted();
}

/** Names a `skipIgnored` walk never enters or yields, at any depth. */
const DEFAULT_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.vscode',
  '.idea',
  '.DS_Store',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.cache',
  '.yarn',
  'jspm_packages',
  'bower_components',
  'out',
  'tmp',
  '.temp',
  'npm-debug.log',
  'yarn-debug.log',
  'yarn-error.log',
  'Thumbs.db',
]);

// On a case-insensitive filesystem, fs.glob yields on-disk spellings (`Node_Modules`).
const DEFAULT_EXCLUDED_KEYS: ReadonlySet<string> = new Set(
  [...DEFAULT_EXCLUDED_NAMES].map(normalizeCaseForComparison),
);

// ASCII fold only: toLowerCase would equate U+212A (Kelvin) with k, hiding `.svelte-kit` spelled with it.
function isDefaultExcludedName(name: string): boolean {
  return DEFAULT_EXCLUDED_KEYS.has(normalizeCaseForComparison(name));
}
