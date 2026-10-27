import type { Stats } from 'node:fs';
import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { runExclusive, withAbort } from './concurrency.ts';
import { cli } from './config.ts';
import {
  classifyCauseChain,
  ErrorCode,
  FsError,
  isFsError,
  isNotFoundErrno,
  rethrowIfAborted,
} from './errors.ts';
import { Logger } from './observability.ts';
import { findProjectRoot, isUnsafeCwdPath, resolveConfiguredDirs } from './path-discovery.ts';
import {
  escapeNonAscii,
  expandHome,
  getReservedDeviceNameForPath,
  IS_WINDOWS,
  isPathInsideDirectory,
  isPathWithinDirectories,
  isSamePath,
  isUnresolvableDrivePath,
  isWindowsDrivePath,
  isWindowsDriveRelativePath,
  mayHaveEquivalentSpelling,
  normalizeAllowedDirectory,
  normalizePath,
  toPosixRelative,
  unicodeMatchKey,
} from './path-utils.ts';
import { SensitiveMatcher } from './sensitive.ts';
import { parseTrueEnvFlag, ROOTS_TIMEOUT_MS } from './util.ts';

// Allowed-directory assembly and the PathGuard that enforces it. The
// sensitive-file denylist lives in sensitive.ts, and the character-level
// primitives (IS_WINDOWS, isAlpha, isSlash, toPosixPath) live in
// path-utils.ts.

/** Links followed, or respelling rounds run, before a path is refused (Linux ELOOP's 40). */
const MAX_SYMLINK_HOPS = 40;

/** What a move, copy or rename does: see `PathGuard.resolveTransferDestination`. */
export type TransferKind = 'distinct' | 'respelling' | 'self';

/**
 * A write target that already exists is realpathed to its on-disk spelling,
 * so a rename that changes only case (`foo.txt` -> `Foo.txt` on a
 * case-insensitive filesystem) or only Unicode spelling (`cafe\u0301.txt` ->
 * `caf\u00e9.txt`) resolves to the source itself. Returns the resolved target
 * re-spelled with the requested basename when the two differ only that way;
 * otherwise the resolved target unchanged. Parent segments are not re-spelled.
 */
function respellSpellingOnlyTarget(requestedPath: string, resolvedTarget: string): string {
  const requestedName = basename(requestedPath);
  const resolvedName = basename(resolvedTarget);
  if (requestedName === resolvedName) return resolvedTarget;
  return unicodeMatchKey(requestedName) === unicodeMatchKey(resolvedName)
    ? join(dirname(resolvedTarget), requestedName)
    : resolvedTarget;
}

export interface ValidatedPathDetails {
  requestedPath: string;
  resolvedPath: string;
  isSymlink: boolean;
}

/** How one walk prints the paths it found; see `PathGuard.resultPaths`. */
export interface ResultPaths {
  /** The root the relative paths are relative to, as configured; the walked directory when there is none. */
  readonly root: string;
  /** The walked directory is that root itself. */
  readonly atRoot: boolean;
  show(absolutePath: string): string;
}

/** A root and every spelling that names it: as configured, and its realpath when that differs. */
interface RootSpellings {
  readonly root: string;
  readonly spellings: readonly string[];
}

export interface ServerOptions {
  allowCwd?: boolean;
  cliAllowedDirs?: string[];
  readOnly?: boolean;
}

/**
 * The real path of `normalizedPath`, or the one it would have if it does not
 * exist yet: realpath of its nearest existing ancestor plus the missing suffix.
 * Lets a missing root be checked against a realpath-canonicalized boundary even
 * when the boundary itself is reached through a symlink. `undefined` when an
 * ancestor exists but cannot be resolved (EACCES and friends).
 */
async function projectRealPath(
  normalizedPath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const missing: string[] = [];
  let current = normalizedPath;
  for (;;) {
    try {
      signal?.throwIfAborted();
      const real = await withAbort(realpath(current), signal);
      return normalizePath(missing.length === 0 ? real : join(real, ...missing.reverse()));
    } catch (error) {
      rethrowIfAborted(error);
      if (!isNotFoundErrno(error)) return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Every root — configured or granted — must fall under FS_ROOT_BOUNDARY. An
 * existing root must *resolve* inside the boundary; a missing root is projected
 * through its nearest existing ancestor before comparison so symlinked boundary
 * spellings still compare against realpath-canonicalized bounds.
 */
async function partitionRootsWithin(
  roots: readonly string[],
  bounds: readonly string[],
  signal?: AbortSignal,
): Promise<{ kept: string[]; dropped: string[] }> {
  const normalizedBounds = normalizeAllowedDirectories(bounds);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const root of roots.map(normalizePath)) {
    const real = await projectRealPath(root, signal);
    (real !== undefined && isPathWithinDirectories(real, normalizedBounds) ? kept : dropped).push(
      root,
    );
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Resolver pipeline
// ---------------------------------------------------------------------------

export function normalizeAllowedDirectories(dirs: readonly string[]): string[] {
  return [...new Set(dirs.map(normalizeAllowedDirectory).filter((entry) => entry.length > 0))];
}

async function resolveRealPath(normalized: string, signal?: AbortSignal): Promise<string | null> {
  try {
    signal?.throwIfAborted();
    const realPath = await withAbort(realpath(normalized), signal);
    return normalizeAllowedDirectory(realPath);
  } catch (error) {
    rethrowIfAborted(error);
    // Only suppress ENOENT — the path genuinely does not exist.
    // EACCES, EIO, and other unexpected errors are rethrown so callers
    // cannot silently operate with a narrowed allowed-directory set.
    if (isNotFoundErrno(error)) {
      return null;
    }
    throw error;
  }
}

async function resolveRootSpellings(
  dirs: readonly string[],
  signal?: AbortSignal,
): Promise<RootSpellings[]> {
  const roots = normalizeAllowedDirectories(dirs);
  const reals = await Promise.all(roots.map((dir) => resolveRealPath(dir, signal)));
  return roots.map((root, i) => {
    const real = reals[i];
    return { root, spellings: real && !isSamePath(real, root) ? [root, real] : [root] };
  });
}

export async function resolveAllowedDirectoriesState(
  dirs: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const entries = await resolveRootSpellings(dirs, signal);
  return [...new Set(entries.flatMap((entry) => entry.spellings))];
}

/** How a walked entry rules: usable, hidden by the denylist, or out of reach. */
export type EntryVerdict = 'ok' | 'sensitive' | 'inaccessible';

/**
 * TOCTOU note: validation returns a plain string and the fs operation is a
 * later syscall, so a symlink swapped in between could redirect it. Reads and
 * appends in core/fs.ts open with O_NOFOLLOW (final component) and re-check the
 * fd's real path on Linux (ancestor swap). stat's directory count opens and
 * re-checks the directory, and reads entries through that descriptor, only on
 * Linux with procfs; elsewhere it reads the directory by path, so the swap
 * window stays there, like the read path's non-Linux residual. Residuals: the
 * directory walker behind list and the search tools (core/glob.ts) still
 * resolves each entry by path, as the count does for a symlinked entry;
 * write paths that resolve a parent by name
 * (`rename`, `mkdir`, `rm`, `cp`) would need openat()-relative-to-dirfd, which
 * Node lacks; non-Linux skips the fd re-check.
 */
export class PathGuard {
  private allowedDirectoriesState: string[] | undefined;
  /** One entry per configured or granted root, without the realpath aliases. */
  private rootsState: string[] | undefined;
  private readonly sensitive = new SensitiveMatcher();
  /**
   * Directories added by an accepted access grant (R8) — from the tool
   * executor's grant round-trip, or from a client's declared workspace roots on
   * the legacy stdio leg. Held separately from the configured baseline because
   * `recomputeAllowedDirectories` rebuilds that baseline from CLI args and env
   * on every call: anything merged into it would be recomputed away.
   *
   * These are NOT filtered against the baseline. A granted directory is
   * out-of-baseline by definition, so a baseline filter dropped every one while
   * `applyGrant` still reported success — the whole round-trip prompted the
   * user and then changed nothing. FS_ROOT_BOUNDARY and the unsafe-path denylist
   * remain the limits, both checked in `applyGrant` — the only writer of this
   * field — so the recompute can rebuild from it without re-filtering.
   */
  private grantedDirectories: string[] = [];
  /**
   * The grants a user approved for a path a tool asked about, as opposed to
   * the workspace roots a client declared. Relative paths never resolve
   * against these: one approval must not change what a relative path names,
   * neither in a later round of the same call nor in a later call.
   * sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.
   */
  private accessGrants: string[] = [];
  /**
   * Where relative paths resolve: the roots minus `accessGrants`, each with
   * its spellings, plus every spelling flattened for containment.
   */
  private relativeBases:
    { entries: readonly RootSpellings[]; roots: string[]; expanded: string[] } | undefined;
  private rootBoundaries: string[] = [];

  private readonly options: ServerOptions | undefined;

  constructor(options?: ServerOptions) {
    this.options = options;
  }

  /**
   * `expanded` is the containment set (each root plus its realpath alias);
   * `roots` is what a caller choosing "the root" sees, one entry per root.
   * `relativeBases` lists the roots relative paths resolve against, with
   * their spellings; without it, every root, each spelled only as given.
   */
  initialize(
    expanded: readonly string[],
    roots: readonly string[] = expanded,
    relativeBases?: readonly RootSpellings[],
  ): void {
    this.allowedDirectoriesState = normalizeAllowedDirectories(expanded);
    this.rootsState = normalizeAllowedDirectories(roots);
    const entries = (
      relativeBases ?? this.rootsState.map((root) => ({ root, spellings: [root] }))
    ).map((entry) => ({
      root: normalizeAllowedDirectory(entry.root),
      spellings: normalizeAllowedDirectories(entry.spellings),
    }));
    this.relativeBases = {
      entries,
      roots: entries.map((entry) => entry.root),
      expanded: relativeBases
        ? normalizeAllowedDirectories(entries.flatMap((entry) => entry.spellings))
        : this.allowedDirectoriesState,
    };
  }

  isInitialized(): boolean {
    return this.allowedDirectoriesState !== undefined;
  }

  getAllowedDirectories(): string[] {
    if (!this.allowedDirectoriesState) {
      return [];
    }
    return [...this.allowedDirectoriesState];
  }

  /**
   * The allowed directory that contains `resolvedPath` — the longest match,
   * so a nested root wins over its parent — or `undefined` when none does.
   * Walks use it as the `.gitignore` ceiling: rules above an allowed root are
   * never read.
   */
  allowedRootContaining(resolvedPath: string): string | undefined {
    const normalized = normalizePath(resolvedPath);
    let best: string | undefined;
    for (const dir of this.getAllowedDirectories()) {
      if (
        isPathInsideDirectory(dir, normalized) &&
        (best === undefined || dir.length > best.length)
      ) {
        best = dir;
      }
    }
    return best;
  }

  /**
   * The roots as configured or granted, one per root. getAllowedDirectories()
   * also holds each root's realpath alias for containment, so an aliased root
   * (symlink, junction, 8.3 short name) appears there twice.
   */
  getRoots(): string[] {
    return this.rootsState ? [...this.rootsState] : [];
  }

  isSensitive(filePath: string): boolean {
    return this.sensitive.isSensitive(filePath);
  }

  /**
   * True when relocating a directory from `from` to `to` keeps every entry's
   * sensitive-file status. Path rules (`secrets/**`) follow the path, not the
   * file, so an entry may neither leave nor enter the protected set; name rules
   * match on both sides and need no help. `names` are paths relative to the
   * directory; `requestedFrom` is the spelling the client asked for, which
   * counts as protected too. A failed walk rejects, so callers fail closed.
   */
  async relocationKeepsProtection(
    names: AsyncIterable<string> | Iterable<string>,
    { from, requestedFrom }: { from: string; requestedFrom?: string },
    to: string,
  ): Promise<boolean> {
    for await (const name of names) {
      const before =
        this.isSensitive(join(from, name)) ||
        (requestedFrom !== undefined && this.isSensitive(join(requestedFrom, name)));
      if (before !== this.isSensitive(join(to, name))) return false;
    }
    return true;
  }

  /**
   * Rules on a walked entry without throwing for the expected cases. Every entry
   * is realpath-resolved: a symlinked ancestor pointing outside the sandbox would
   * otherwise pass the lexical check (fs.glob follows symlinks and yields
   * external entries as non-symlink dirents). 'sensitive' means the denylist
   * matched the requested or resolved path; 'inaccessible' covers escapes and
   * every other error on the entry (EBUSY, EMFILE, races). Only an abort and an
   * uninitialized guard throw. The accepted TOCTOU window is documented on
   * this class.
   */
  async entryVerdict(entryPath: string): Promise<EntryVerdict> {
    if (this.isSensitive(entryPath) || this.isSensitive(normalizePath(entryPath))) {
      return 'sensitive';
    }
    try {
      await this.validateExistingPathDetailed(entryPath);
      return 'ok';
    } catch (error) {
      rethrowIfAborted(error);
      // A server bug, not an entry the scan can skip.
      if (!this.allowedDirectoriesState) throw error;
      if (isFsError(error) && error.code === ErrorCode.ACCESS_DENIED) {
        // The denylist and the out-of-root check share this code; the real path tells them apart.
        try {
          return this.isSensitive(await realpath(entryPath)) ? 'sensitive' : 'inaccessible';
        } catch {
          return 'inaccessible';
        }
      }
      return 'inaccessible';
    }
  }

  /** True when a walked entry is inside the allowed directories and not sensitive. */
  async isEntryAccessible(entryPath: string): Promise<boolean> {
    return (await this.entryVerdict(entryPath)) === 'ok';
  }

  async validateExistingPath(requestedPath: string): Promise<string> {
    const details = await this.validateExistingPathDetailed(requestedPath);
    return details.resolvedPath;
  }

  /**
   * True when a grant must never admit `targetDir` — an unsafe path (home,
   * /etc, C:\Windows, ...). Checked on the lexical path AND on the one it
   * resolves to: `recomputeAllowedDirectories` pushes each root's realpath
   * into the allowed set, so a lexical-only check let a symlink or junction
   * aliasing $HOME/C:\Windows in under an innocuous name — and the confirmation
   * prompt showed the alias, not the target. A target that cannot be resolved
   * is judged lexically; it does not exist to escape into.
   */
  private async isUnsafeGrantTarget(targetDir: string): Promise<boolean> {
    const normalized = normalizePath(targetDir);
    if (isUnsafeCwdPath(normalized)) return true;
    let resolved: string;
    try {
      resolved = normalizePath(await realpath(normalized));
    } catch {
      return false;
    }
    return !isSamePath(resolved, normalized) && isUnsafeCwdPath(resolved);
  }

  /** Walk up from a blocked path to the closest existing ancestor directory. */
  private async resolveGrantTargetDir(blockedPath: string): Promise<string> {
    let targetDir = blockedPath;
    for (;;) {
      const parent = dirname(targetDir);
      try {
        // An existing directory is the grant target; an existing file grants
        // its parent directory.
        return (await stat(targetDir)).isDirectory() ? targetDir : parent;
      } catch {
        // Missing — keep walking up.
      }
      if (parent === targetDir) return targetDir;
      targetDir = parent;
    }
  }

  /**
   * Pre-check (no mutation, no callback): given the paths a tool is about to
   * operate on, return the sorted, de-duplicated grant-target directories for
   * those that are outside the allowed roots AND grantable (within FS_ROOT_BOUNDARY
   * when it is configured). A path whose nearest existing ancestor escapes the
   * boundary is NOT grantable and is omitted — the operation will fail with
   * ACCESS_DENIED for it rather than prompt. The caller returns an
   * `input_required` result carrying exactly this set (R7), and on retry applies
   * each accepted grant via {@link applyGrant} (R8). `requestState` binds this
   * set so a grant accepted for X cannot authorize Y (R9).
   */
  async precheckAccess(paths: readonly string[]): Promise<string[]> {
    if (!this.allowedDirectoriesState || paths.length === 0) {
      return [];
    }
    const allowedDirs = this.allowedDirectoriesState;
    const grantDirs: string[] = [];
    for (const requested of paths) {
      if (!requested) {
        continue;
      }
      // Validation refuses it for its shape whatever is granted, so asking the
      // user to grant the working directory it resolves under is pointless.
      if (
        isUnresolvableDrivePath(requested) ||
        (IS_WINDOWS && getReservedDeviceNameForPath(requested) !== undefined)
      ) {
        continue;
      }
      const normalized = normalizePath(requested);
      if (this.isSensitive(requested) || this.isSensitive(normalized)) {
        continue;
      }
      if (isPathWithinDirectories(normalized, allowedDirs)) {
        continue;
      }
      const targetDir = normalizePath(await this.resolveGrantTargetDir(normalized));
      // Never offer a grant into a bare filesystem root or an unsafe path (home,
      // /etc, C:\Windows, ...). Without FS_ROOT_BOUNDARY, isWithinBoundary returns
      // true for everything, so this is the one guard that still rejects roots a
      // misleading grant could reach. Mirrors the check gating --allow-cwd.
      if (await this.isUnsafeGrantTarget(targetDir)) {
        continue;
      }
      if (grantDirs.some((dir) => isSamePath(dir, targetDir))) {
        continue;
      }
      if (!(await this.isWithinBoundary(targetDir))) {
        continue;
      }
      grantDirs.push(targetDir);
    }
    return grantDirs.sort();
  }

  /**
   * Apply an accepted access grant: enforce FS_ROOT_BOUNDARY again (a TOCTOU
   * re-check against the boundary resolved at config time), then extend the
   * allowed roots for the remainder of the session (R8, A4). Returns false when
   * the boundary or the unsafe-path denylist blocks the grant, AND when the
   * recompute did not actually admit the directory — the return value now
   * reports what the guard's allowed set really holds, not merely that the
   * pre-checks passed. The caller leaves a refused path to fail with
   * ACCESS_DENIED during the operation. Idempotent: re-granting an already
   * allowed directory is a no-op via the dedup in `initialize`.
   *
   * `kind` says where the grant came from: `access` for a path the user
   * approved when a tool asked, `workspace` for a root the client declared.
   * Only a workspace root becomes a place relative paths resolve.
   * sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.
   */
  async applyGrant(targetDir: string, kind: 'access' | 'workspace' = 'access'): Promise<boolean> {
    // Defense-in-depth: even a tampered/accepted grant cannot extend roots into
    // an unsafe path. The precheckAccess guard already refuses to offer these;
    // this catches a grant that arrived by another route — the legacy stdio
    // `roots/list` seeding, which has no confirmation round-trip at all.
    if (await this.isUnsafeGrantTarget(targetDir)) {
      return false;
    }
    if (!(await this.isWithinBoundary(targetDir))) {
      return false;
    }
    // Read + write under the mutation lock so a concurrent grant cannot
    // interleave and lose this grant (GRANT-1). runExclusive is not reentrant:
    // nothing in this body may take the lock again.
    return runExclusive(this, async () => {
      const previous = this.grantedDirectories;
      const previousAccess = this.accessGrants;
      const dir = normalizePath(targetDir);
      this.grantedDirectories = [...previous, dir];
      this.accessGrants =
        kind === 'access'
          ? [...previousAccess, dir]
          : previousAccess.filter((grant) => !isSamePath(grant, dir));
      const rollBack = (): void => {
        this.grantedDirectories = previous;
        this.accessGrants = previousAccess;
      };
      try {
        await this.recomputeAllowedDirectories();
      } catch (error) {
        // A failed recompute leaves the guard with its previous, consistent view.
        rollBack();
        throw error;
      }
      // Verify rather than assume: a boundary that no longer covers this
      // directory would drop it in the recompute above, and reporting success
      // for a grant that did not land is exactly the failure this replaces.
      if (isPathWithinDirectories(dir, this.getAllowedDirectories())) {
        return true;
      }
      rollBack();
      await this.recomputeAllowedDirectories();
      return false;
    });
  }

  // One boundary rule for startup roots and grants: a missing target is
  // projected through its nearest existing ancestor, an unresolvable one is
  // refused. No boundary configured means no constraint; partitionRootsWithin
  // with no bounds would drop everything, so that case returns first.
  private async isWithinBoundary(targetDir: string): Promise<boolean> {
    if (this.rootBoundaries.length === 0) {
      return true;
    }
    const { kept } = await partitionRootsWithin([targetDir], this.rootBoundaries);
    return kept.length > 0;
  }

  private validateAccess(requestedPath: string): {
    normalizedRequested: string;
    allowedDirs: string[];
    accessDeniedHint: string;
  } {
    if (!this.allowedDirectoriesState) {
      throw new FsError(
        ErrorCode.UNKNOWN,
        'PathGuard not initialized. Call initialize() first.',
        requestedPath,
      );
    }
    // Before the drive-relative check, whose advice (`use C:\path`) is wrong here.
    if (!IS_WINDOWS && isWindowsDrivePath(requestedPath)) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        `Windows-style path received on a POSIX host (${process.platform}). Use a POSIX path, such as one under an allowed root.`,
        requestedPath,
        undefined,
        'Run list_roots to see the allowed directories.',
      );
    }
    if (isWindowsDriveRelativePath(requestedPath)) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'Drive-relative paths are not allowed. Use C:\\path or C:/path instead of C:path.',
        requestedPath,
      );
    }
    // A device name is only a device on Windows; on POSIX `aux.ts` is a file.
    const reservedDevice = IS_WINDOWS ? getReservedDeviceNameForPath(requestedPath) : undefined;
    if (reservedDevice) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        `Reserved Windows device name not allowed: ${reservedDevice}.`,
        requestedPath,
      );
    }

    const normalizedRequested = normalizePath(requestedPath);
    const allowedDirs = this.allowedDirectoriesState;

    const accessDeniedHint =
      allowedDirs.length > 0
        ? `Allowed: ${allowedDirs.join(', ')}`
        : 'No allowed directories configured.';

    if (!isPathWithinDirectories(normalizedRequested, allowedDirs)) {
      // Out of root. The access-grant `input_required` round-trip is driven by
      // the executor's pre-check (precheckAccess) BEFORE the operation runs, so
      // by the time validation reaches here any grantable out-of-root path has
      // already been accepted and added to the allowed set. A path still out of
      // root here was either declined, ungrantable (outside FS_ROOT_BOUNDARY), or
      // never pre-checked — fail closed.
      this.throwAccessDenied(requestedPath, accessDeniedHint);
    }
    this.assertNotSensitiveFile(requestedPath, requestedPath);
    this.assertNotSensitiveFile(normalizedRequested, requestedPath);

    return {
      normalizedRequested,
      allowedDirs: this.allowedDirectoriesState,
      accessDeniedHint,
    };
  }

  private async handleRealpathError(
    error: unknown,
    normalizedRequested: string,
    allowedDirs: string[],
    accessDeniedHint: string,
    requestedPath: string,
  ): Promise<never> {
    if (isNotFoundErrno(error)) {
      // Resolve the nearest existing ancestor to detect out-of-sandbox symlinks.
      // e.g. if `link -> C:\external` and path is `link\nonexistent.txt`, the
      // ancestor resolves outside allowed dirs → ACCESS_DENIED, not NOT_FOUND.
      try {
        const { realAncestor, resolvedTarget } = await this.resolveNearestExistingAncestor(
          requestedPath,
          normalizedRequested,
        );
        if (
          !isPathWithinDirectories(realAncestor, allowedDirs) ||
          !isPathWithinDirectories(resolvedTarget, allowedDirs)
        ) {
          this.throwAccessDenied(requestedPath, accessDeniedHint);
        }
      } catch (ancestorErr) {
        // Rethrow any FsError — collapsing e.g. UNKNOWN to NOT_FOUND would mask
        // incomplete sandbox checks and make bugs invisible to callers.
        if (isFsError(ancestorErr)) {
          throw ancestorErr;
        }
      }

      throw new FsError(ErrorCode.NOT_FOUND, 'Path not found', requestedPath, error);
    }

    const mapped = classifyCauseChain(error);
    throw new FsError(
      mapped.code,
      'Cannot access path',
      requestedPath,
      error instanceof Error ? error : undefined,
    );
  }

  async validateExistingPathDetailed(requestedPath: string): Promise<ValidatedPathDetails> {
    const { normalizedRequested, allowedDirs, accessDeniedHint } =
      this.validateAccess(requestedPath);

    let spelled = normalizedRequested;
    let realPath: string;
    try {
      realPath = await realpath(spelled);
    } catch (error) {
      // Not on disk as typed; it may be under another Unicode spelling (#101).
      const respelled = isNotFoundErrno(error)
        ? await this.respellMissing(spelled, allowedDirs, accessDeniedHint, requestedPath)
        : undefined;
      if (respelled === undefined) {
        realPath = await this.handleRealpathError(
          error,
          spelled,
          allowedDirs,
          accessDeniedHint,
          requestedPath,
        );
      } else {
        this.assertNotSensitiveFile(respelled, requestedPath);
        spelled = respelled;
        try {
          realPath = await realpath(spelled);
        } catch (retryError) {
          realPath = await this.handleRealpathError(
            retryError,
            spelled,
            allowedDirs,
            accessDeniedHint,
            requestedPath,
          );
        }
      }
    }

    const normalizedReal = normalizePath(realPath);

    if (!isPathWithinDirectories(normalizedReal, allowedDirs)) {
      this.throwAccessDenied(requestedPath, accessDeniedHint);
    }

    // Re-check the resolved real path: a symlink inside an allowed root may
    // point at a sensitive file (e.g. link -> .env). The early check above only
    // sees the requested/normalized path, not the symlink target.
    this.assertNotSensitiveFile(normalizedReal, requestedPath);

    return {
      requestedPath: spelled,
      resolvedPath: normalizedReal,
      isSymlink: !isSamePath(spelled, normalizedReal),
    };
  }

  async validateExistingDirectory(requestedPath: string): Promise<string> {
    const details = await this.validateExistingPathDetailed(requestedPath);

    let stats: Stats;
    try {
      stats = await stat(details.resolvedPath);
    } catch (error) {
      throw new FsError(
        ErrorCode.UNKNOWN,
        'Cannot access directory',
        requestedPath,
        error instanceof Error ? error : undefined,
      );
    }

    if (!stats.isDirectory()) {
      throw new FsError(ErrorCode.NOT_DIRECTORY, 'Not a directory', requestedPath);
    }

    return details.resolvedPath;
  }

  resolvePathOrRoot(pathValue: string | undefined): string {
    if (pathValue && pathValue.trim().length > 0) {
      return pathValue;
    }
    const roots = this.getRoots();
    const [root] = roots;
    if (root === undefined) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'No roots configured. Use the roots tool or --allow-cwd.',
      );
    }
    if (roots.length > 1) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'Multiple roots configured. Provide an explicit path.',
      );
    }
    return root;
  }

  /**
   * Where the relative paths a caller sent should point, keyed by the spelling
   * sent; a path that keeps its meaning is absent. A relative path resolves
   * against the working directory, as it always has, while that lands inside
   * a root. When it does not — a desktop host starts the server outside the
   * project, and an HTTP client never shares its working directory — it
   * resolves against the roots: the one root, or with several, the one it
   * exists under. Searches print paths relative to the root (`resultPaths`),
   * so this is what lets one tool's output feed the next.
   *
   * "Roots" here are the configured ones and those a client declared, never an
   * access grant (see `accessGrants`). Absolute, `~` and drive paths keep their
   * meaning, as does every path when there is no such root; validation judges
   * them as before. A Windows drive path on POSIX is left for validation to
   * refuse: joined to a root, `C:\x` would be an absolute path that passes. A
   * relative path that exists under several roots, or under none of several,
   * is refused rather than guessed.
   */
  async resolveRelativePaths(paths: readonly string[]): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    const bases = this.relativeBases;
    if (!bases || bases.roots.length === 0) return resolved;
    for (const requested of new Set(paths)) {
      if (
        requested.trim().length === 0 ||
        isUnresolvableDrivePath(requested) ||
        isAbsolute(expandHome(requested)) ||
        isPathWithinDirectories(normalizePath(requested), bases.expanded)
      ) {
        continue;
      }
      resolved.set(requested, await this.resolveAgainstRoots(requested, bases.roots));
    }
    return resolved;
  }

  private async resolveAgainstRoots(requested: string, roots: readonly string[]): Promise<string> {
    const candidates = roots.map((root) => join(root, requested));
    const [first] = candidates;
    if (first === undefined || candidates.length === 1) return first ?? requested;
    // Each candidate is probed through validation itself, so the probe learns
    // nothing validation would not tell the caller: a denylisted name is
    // refused before the filesystem is touched, and a path through a symlink
    // out of the roots is refused whether or not its target exists.
    const existing: string[] = [];
    let refused: string | undefined;
    for (const candidate of candidates) {
      try {
        await this.validateExistingPath(candidate);
        existing.push(candidate);
      } catch (error) {
        if (isFsError(error) && error.code === ErrorCode.NOT_FOUND) continue;
        refused ??= candidate;
      }
    }
    const [only] = existing;
    if (only !== undefined && existing.length === 1) return only;
    // Validation then refuses it again, with its own reason.
    if (existing.length === 0 && refused !== undefined) return refused;
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      existing.length === 0
        ? `Relative path exists under none of the ${String(roots.length)} roots, so it names no one file. Pass an absolute path under one of: ${roots.join(', ')}.`
        : `Relative path exists under more than one root: ${existing.join(', ')}. Pass the absolute path you mean.`,
      requested,
    );
  }

  /**
   * How a tool prints the paths a walk of `walkedDir` found, so the caller can
   * pass each one straight back: relative to the root holding `walkedDir`
   * when `resolveRelativePaths` maps that spelling back to the same path,
   * absolute otherwise. A scoped search of `src` prints `src/a.ts`, not
   * `a.ts`, which would name `<root>/a.ts`. `root` is the root as configured,
   * as `list_roots` shows it, even when the walk went through its realpath.
   *
   * The absolute fallback covers a working directory in a subfolder of a root
   * (relative paths resolve there), a directory under an access grant only
   * (relative paths never resolve there), several roots with the working
   * directory outside them (a name two roots share would read back as
   * ambiguous, and which names are shared can change between the print and
   * the read), and a name that would not read back as given: `~`, blank, or a
   * POSIX name holding a backslash or starting with a drive (`C:`).
   */
  resultPaths(walkedDir: string): ResultPaths {
    const walked = normalizePath(walkedDir);
    const bases = this.relativeBases;
    let found: { root: string; spelling: string } | undefined;
    for (const entry of bases?.entries ?? []) {
      for (const spelling of entry.spellings) {
        if (
          isPathInsideDirectory(spelling, walked) &&
          (found === undefined || spelling.length > found.spelling.length)
        ) {
          found = { root: entry.root, spelling };
        }
      }
    }
    if (found === undefined || bases === undefined) {
      return { root: walked, atRoot: false, show: (absolutePath) => absolutePath };
    }
    const { root, spelling } = found;
    const allowed = bases.expanded;
    const severalRoots = bases.roots.length > 1;
    return {
      root,
      atRoot: isSamePath(spelling, walked),
      show: (absolutePath) => {
        // Windows separators become `/`, which every tool accepts there; on
        // POSIX a backslash is part of a name and must stay one.
        const rel = IS_WINDOWS
          ? toPosixRelative(spelling, absolutePath)
          : relative(spelling, absolutePath);
        if (
          rel.trim().length === 0 ||
          rel === '..' ||
          rel.startsWith('../') ||
          isAbsolute(rel) ||
          isUnresolvableDrivePath(rel) ||
          expandHome(rel) !== rel ||
          !isSamePath(resolve(spelling, rel), absolutePath)
        ) {
          return absolutePath;
        }
        // Mirrors resolveRelativePaths: a spelling that lands inside a root
        // from the working directory resolves there, so it must land here.
        const fromCwd = normalizePath(rel);
        if (isPathWithinDirectories(fromCwd, allowed)) {
          return isSamePath(fromCwd, absolutePath) ? rel : absolutePath;
        }
        return severalRoots ? absolutePath : rel;
      },
    };
  }

  isAllowedRoot(normalizedPath: string): boolean {
    // isSamePath case-folds on case-insensitive filesystems (win + darwin),
    // matching the containment checks used everywhere else in the guard. The
    // previous IS_WINDOWS-only fold left darwin doing exact-case compares here
    // while isPathInsideDirectory folded — a root matched case-insensitively
    // everywhere else was missed.
    return this.getAllowedDirectories().some((dir) => isSamePath(dir, normalizedPath));
  }

  // Checks ONLY the sensitive-file denylist. Root containment and symlink
  // resolution must be verified separately (e.g. via validateExistingPath).
  private assertNotSensitiveFile(checkPath: string, requestedPath: string): void {
    if (this.isSensitive(checkPath)) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Sensitive file blocked by the server denylist. To unblock one built-in secret-file pattern, restart the server with --allow <pattern> (or FS_ALLOWLIST); --allow-sensitive (or FS_ALLOW_SENSITIVE=1) turns the whole built-in list off. Paths blocked with --deny or FS_DENYLIST stay blocked.',
        requestedPath,
      );
    }
  }

  private throwAccessDenied(requestedPath: string, hint?: string): never {
    throw new FsError(
      ErrorCode.ACCESS_DENIED,
      hint ? `Outside allowed directories. ${hint}` : 'Outside allowed directories.',
      requestedPath,
    );
  }
  private async resolveNearestExistingAncestor(
    requestedPath: string,
    currentPath: string,
  ): Promise<{ realAncestor: string; resolvedTarget: string }> {
    const missingSegments: string[] = [];
    let current = currentPath;
    let hops = 0;
    for (;;) {
      try {
        const realAncestor = normalizePath(await realpath(current));
        const resolvedTarget =
          missingSegments.length === 0
            ? realAncestor
            : normalizePath(join(realAncestor, ...missingSegments.reverse()));
        return { realAncestor, resolvedTarget };
      } catch (error) {
        try {
          const stats = await lstat(current);
          if (stats.isSymbolicLink()) {
            if (++hops > MAX_SYMLINK_HOPS) {
              throw new FsError(
                ErrorCode.SYMLINK_NOT_ALLOWED,
                'Too many symbolic links encountered',
                requestedPath,
              );
            }
            const allowedDirs = this.getAllowedDirectories();
            const linkParent = normalizePath(await realpath(dirname(current)));
            if (!isPathWithinDirectories(linkParent, allowedDirs)) {
              this.throwAccessDenied(requestedPath);
            }
            const target = await readlink(current);
            const resolvedTarget = isAbsolute(target) ? target : resolve(linkParent, target);
            const normalizedTarget = normalizePath(resolvedTarget);
            if (!isPathWithinDirectories(normalizedTarget, allowedDirs)) {
              this.throwAccessDenied(requestedPath);
            }
            current =
              missingSegments.length === 0
                ? normalizedTarget
                : normalizePath(join(normalizedTarget, ...missingSegments.reverse()));
            missingSegments.length = 0;
            continue;
          }
        } catch (lstatErr) {
          if (isFsError(lstatErr)) {
            throw lstatErr;
          }
          // ENOENT is expected during ancestor walk — the entry simply doesn't exist.
          // Any other error (EACCES, EIO, ELOOP) is unexpected; fail safe.
          if (!isNotFoundErrno(lstatErr)) {
            throw new FsError(
              ErrorCode.UNKNOWN,
              'Cannot probe symlink ancestor',
              requestedPath,
              lstatErr instanceof Error ? lstatErr : undefined,
            );
          }
        }
        const parent = dirname(current);
        if (parent === current) {
          throw new FsError(
            ErrorCode.UNKNOWN,
            'Cannot resolve path',
            requestedPath,
            error instanceof Error ? error : undefined,
          );
        }
        missingSegments.push(basename(current));
        current = parent;
      }
    }
  }

  /**
   * `normalized` re-spelled with the on-disk names of the components that are
   * missing as typed but present under another Unicode spelling (#101), or
   * `undefined` when no component changed. Only names below a root are
   * matched, never the root's own. Each directory is scanned only after its
   * real path is checked to be inside the roots, and each matched entry is
   * realpathed and checked again, so a link found this way cannot lead out
   * (`resolveLast: false` leaves the last one unresolved, for delete). The
   * first component with no match ends the walk; it and the rest stay as
   * typed, so a write still creates them. The result is a spelling only:
   * the caller runs its own containment and denylist checks on it.
   */
  private async respellMissing(
    normalized: string,
    allowedDirs: readonly string[],
    accessDeniedHint: string,
    requestedPath: string,
    resolveLast = true,
  ): Promise<string | undefined> {
    const root = this.allowedRootContaining(normalized);
    if (root === undefined || !mayHaveEquivalentSpelling(normalized.slice(root.length))) {
      return undefined;
    }
    const missing: string[] = [];
    let ancestor = normalized;
    let real: string;
    for (;;) {
      try {
        real = normalizePath(await realpath(ancestor));
        break;
      } catch (error) {
        if (!isNotFoundErrno(error) || isSamePath(ancestor, root)) return undefined;
        missing.unshift(basename(ancestor));
        ancestor = dirname(ancestor);
      }
    }
    // An ancestor that resolves out of the roots is the caller's to refuse.
    if (!isPathWithinDirectories(real, allowedDirs)) return undefined;

    const spelled: string[] = [];
    for (const [index, name] of missing.entries()) {
      let onDisk: string | undefined = name;
      if (mayHaveEquivalentSpelling(name)) {
        // The scan must not reveal what the denylist hides: a name it covers
        // under the resolved parent is refused as the exact spelling is, and
        // a directory `list` would refuse is never read.
        this.assertNotSensitiveFile(join(real, ...missing.slice(index)), requestedPath);
        if (this.isSensitive(real)) break;
        onDisk = await this.findEquivalentEntry(real, name, requestedPath);
      }
      if (onDisk === undefined) break;
      spelled.push(onDisk);
      if (!resolveLast && index === missing.length - 1) break;
      try {
        real = normalizePath(await realpath(join(ancestor, ...spelled)));
      } catch {
        // Missing as typed, or a dangling link: the caller's checks judge it.
        break;
      }
      if (!isPathWithinDirectories(real, allowedDirs)) {
        this.throwAccessDenied(requestedPath, accessDeniedHint);
      }
    }
    if (spelled.every((name, index) => name === missing[index])) return undefined;
    return join(ancestor, ...spelled, ...missing.slice(spelled.length));
  }

  /**
   * The entry of `realDir` that `name` names: `name` itself when it is
   * there, else the one entry with the same `unicodeMatchKey`. Two or more
   * such entries are refused, never chosen between. `undefined` when none
   * matches or the directory cannot be read.
   */
  private async findEquivalentEntry(
    realDir: string,
    name: string,
    requestedPath: string,
  ): Promise<string | undefined> {
    let entries: string[];
    try {
      entries = await readdir(realDir);
    } catch {
      return undefined;
    }
    if (entries.includes(name)) return name;
    const key = unicodeMatchKey(name);
    const matches = entries.filter((entry) => unicodeMatchKey(entry) === key);
    // A match the denylist covers is refused here, as a lone one would be by
    // the caller, so the ambiguity error below never lists a hidden name.
    for (const match of matches) this.assertNotSensitiveFile(join(realDir, match), requestedPath);
    if (matches.length > 1) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        `Ambiguous Unicode path component "${name}": ${String(matches.length)} entries in ${realDir} match it (${matches.map(escapeNonAscii).join(', ')}). Pass the exact name, using \\u escapes for the characters shown that way.`,
        requestedPath,
      );
    }
    return matches[0];
  }

  async validatePathForWrite(requestedPath: string): Promise<string> {
    const { normalizedRequested, allowedDirs, accessDeniedHint } =
      this.validateAccess(requestedPath);

    let { realAncestor, resolvedTarget } = await this.resolveNearestExistingAncestor(
      requestedPath,
      normalizedRequested,
    );
    const assertInside = (): void => {
      if (
        !isPathWithinDirectories(realAncestor, allowedDirs) ||
        !isPathWithinDirectories(resolvedTarget, allowedDirs)
      ) {
        this.throwAccessDenied(requestedPath, accessDeniedHint);
      }
    };
    assertInside();
    // Part of it is not on disk as typed; it may be under another Unicode
    // spelling (#101). A followed link may also name a missing target spelled
    // differently on disk, and respelling a parent can expose such a link, so
    // repeat until the resolution settles, re-running the checks each round.
    let candidate = normalizedRequested;
    for (let round = 0; realAncestor !== resolvedTarget && round < MAX_SYMLINK_HOPS; round++) {
      const respelled =
        (await this.respellMissing(candidate, allowedDirs, accessDeniedHint, requestedPath)) ??
        (isSamePath(resolvedTarget, candidate)
          ? undefined
          : await this.respellMissing(
              resolvedTarget,
              allowedDirs,
              accessDeniedHint,
              requestedPath,
            ));
      if (respelled === undefined) break;
      this.assertNotSensitiveFile(respelled, requestedPath);
      ({ realAncestor, resolvedTarget } = await this.resolveNearestExistingAncestor(
        requestedPath,
        respelled,
      ));
      assertInside();
      candidate = respelled;
    }
    // Re-check the resolved target: a symlink inside an allowed root may point
    // at a sensitive file. Writing through such a link must be blocked too.
    this.assertNotSensitiveFile(resolvedTarget, requestedPath);
    return resolvedTarget;
  }

  async validatePathForDelete(requestedPath: string): Promise<string> {
    const { normalizedRequested, allowedDirs, accessDeniedHint } =
      this.validateAccess(requestedPath);

    // A workspace root is refused here, before the parent-containment check
    // below reaches for a parent that is out-of-root by construction and
    // reports "Outside allowed directories" for the one directory the caller
    // can see IS allowed. delete-file.ts keeps its own root check for the
    // nested-root case, where the parent is itself an allowed root and this
    // path is never taken.
    if (this.isAllowedRoot(normalizedRequested)) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Deleting a workspace root directory is not allowed',
        requestedPath,
      );
    }

    // Probe the final component before the parent, so a target that is not on
    // disk as typed can be re-spelled (#101) before either is checked.
    let target = normalizedRequested;
    let stats: Stats | undefined;
    try {
      stats = await lstat(target);
    } catch (error) {
      // The link itself is deleted, so the last component stays unresolved.
      const respelled = isNotFoundErrno(error)
        ? await this.respellMissing(target, allowedDirs, accessDeniedHint, requestedPath, false)
        : undefined;
      if (respelled !== undefined) {
        this.assertNotSensitiveFile(respelled, requestedPath);
        target = respelled;
        stats = await lstat(target).catch(() => undefined);
      }
    }

    const parent = dirname(target);
    let realParent: string;
    try {
      realParent = await realpath(parent);
    } catch (error) {
      throw new FsError(
        ErrorCode.NOT_FOUND,
        'Parent directory not found',
        requestedPath,
        error instanceof Error ? error : undefined,
      );
    }
    const normalizedRealParent = normalizePath(realParent);

    if (!isPathWithinDirectories(normalizedRealParent, allowedDirs)) {
      this.throwAccessDenied(requestedPath, accessDeniedHint);
    }

    // A target that does not exist needs only the parent check above.
    if (stats === undefined) return target;
    // For deletion, we ONLY block if the real target is outside the sandbox
    // IF the target is NOT a symlink. Deleting a symlink is safe even if it
    // points outside.
    if (stats.isSymbolicLink()) {
      // Symlink: check link sensitivity but don't resolve target.
      // The parent check above ensures the link itself is in an allowed root.
      // Spelled through the validated real parent, so every path to one link
      // (an aliased parent, another Unicode spelling) names it the same way.
      const link = join(normalizedRealParent, basename(target));
      this.assertNotSensitiveFile(target, requestedPath);
      this.assertNotSensitiveFile(link, requestedPath);
      return link;
    }

    // Not a symlink: resolve to catch path escapes (e.g. /allowed/dir/../../etc)
    // and block sensitive files. A probe failure (ENOENT and friends) falls
    // back to the parent check, which is sufficient for a path that does not
    // exist.
    let realTarget: string;
    try {
      realTarget = normalizePath(await realpath(target));
    } catch {
      return target;
    }
    if (!isPathWithinDirectories(realTarget, allowedDirs)) {
      this.throwAccessDenied(requestedPath, accessDeniedHint);
    }
    this.assertNotSensitiveFile(realTarget, requestedPath);
    return realTarget;
  }

  /**
   * Where a move, copy or rename of `source` to `destination` acts, and what
   * kind of transfer it is. `source.entry` is what the operation moves (a link
   * is the link) and `source.landing` where it lands (a link's target, or the
   * entry itself when that cannot be named); the caller derives both, since a
   * copy moves its landing and a move verifies it through a descriptor.
   *
   * A destination naming the source's own entry in another case or Unicode
   * spelling is a respelling of that entry, acted on under the requested
   * name: of the link itself when the source is a link, which the landing
   * resolved to its target. A destination landing on the source, in either
   * direction (a link onto its target, or onto a separate link to it), is a
   * self-move: acting on it would replace that file with the link, or the
   * link with its target. Throws as `validatePathForWrite` does.
   */
  async resolveTransferDestination(
    destination: string,
    source: { readonly entry: string; readonly landing: string },
  ): Promise<{ readonly destination: string; readonly kind: TransferKind }> {
    let landing = await this.validatePathForWrite(destination);
    const entry = await this.validatePathForDelete(destination).catch(() => undefined);
    const sameEntry = entry !== undefined && isSamePath(entry, source.entry);
    if (sameEntry) landing = respellSpellingOnlyTarget(destination, source.entry);
    const resolvedSource = resolve(source.landing);
    const resolvedDest = resolve(landing);
    const isSelf = sameEntry
      ? resolvedDest === resolve(source.entry)
      : resolvedSource === resolvedDest;
    // Only a destination naming the source's own entry is renamed in place:
    // onto a separate `a\u202fb.txt`, a move of `a\u00a0b.txt` is an overwrite.
    const kind: TransferKind = isSelf
      ? 'self'
      : sameEntry || isSamePath(resolvedSource, resolvedDest)
        ? 'respelling'
        : 'distinct';
    return { destination: landing, kind };
  }

  /**
   * The lock key of a path an operation moves away: its entry, so a link is
   * locked as the link, not its target. A path whose entry cannot be named (a
   * dry-run intermediate whose parent is gone) is keyed by its landing.
   */
  async entryLockKey(path: string): Promise<string> {
    return this.validatePathForDelete(path).catch(() => this.validatePathForWrite(path));
  }

  async recomputeAllowedDirectories(): Promise<void> {
    const cliAllowedDirs = normalizeAllowedDirectories(this.options?.cliAllowedDirs ?? []);

    // Parse allowed directories from environment variable
    const allowMissing =
      cli.allowMissingRoots ??
      parseTrueEnvFlag(process.env['FS_ALLOW_MISSING_ROOTS'], 'FS_ALLOW_MISSING_ROOTS');
    const envAllowedDirs = await resolveConfiguredDirs('FS_ALLOWED_DIRS', { allowMissing });

    // Parse FS_ROOT_BOUNDARY (the --root-boundary flag beats the env var)
    const boundaries = await resolveConfiguredDirs('FS_ROOT_BOUNDARY', {
      resolveReal: true,
      ...(cli.rootBoundary !== undefined ? { rawValue: cli.rootBoundary } : {}),
    });

    const allowCwd = Boolean(this.options?.allowCwd);
    const allowCwdDirs: string[] = [];
    if (allowCwd) {
      let cwd = normalizePath(process.cwd());
      const walkCwd =
        cli.allowCwdWalk ?? parseTrueEnvFlag(process.env['FS_ALLOW_CWD_WALK'], 'FS_ALLOW_CWD_WALK');
      if (walkCwd) {
        cwd = await findProjectRoot(cwd, [...boundaries, homedir()]);
      }
      if (isUnsafeCwdPath(cwd)) {
        Logger.warn(`Skipped adding unsafe current working directory to allowed list: ${cwd}`);
      } else {
        allowCwdDirs.push(cwd);
      }
    }

    const signal = AbortSignal.timeout(ROOTS_TIMEOUT_MS);
    let baseline = [...cliAllowedDirs, ...envAllowedDirs, ...allowCwdDirs];
    // FS_ROOT_BOUNDARY is the only filter grants answer to (see
    // `grantedDirectories`); without one they pass through as accepted.
    let grantsToInclude = this.grantedDirectories;
    if (boundaries.length > 0) {
      const { kept, dropped } = await partitionRootsWithin(baseline, boundaries, signal);
      for (const root of dropped) {
        Logger.warn(
          `Skipped allowed root outside FS_ROOT_BOUNDARY (${boundaries.join(', ')}): ${root}`,
        );
      }
      baseline = kept;
      grantsToInclude = (await partitionRootsWithin(this.grantedDirectories, boundaries, signal))
        .kept;
    }

    const combined = [...baseline, ...grantsToInclude];
    const spellings = await resolveRootSpellings(combined, signal);
    const nextState = [...new Set(spellings.flatMap((entry) => entry.spellings))];
    // sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.
    // A configured root stays a base even when it was also granted.
    const accessGrants = this.accessGrants;
    const bases = spellings.filter(
      (entry) =>
        baseline.some((dir) => isSamePath(dir, entry.root)) ||
        !accessGrants.some((grant) => isSamePath(grant, entry.root)),
    );
    // Commit boundaries and the allowed set together, after every await has
    // resolved, so a rejecting recompute leaves the guard's previous,
    // consistent view intact.
    this.rootBoundaries = boundaries;
    this.initialize(nextState, combined, bases);
  }
}
