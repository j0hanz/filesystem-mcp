import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import type { BigIntStats, Dir, Dirent, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  chmod as fsChmod,
  cp as fsCp,
  lchown as fsLchown,
  lstat as fsLstat,
  mkdir as fsMkdir,
  open as fsOpen,
  opendir as fsOpendir,
  readdir as fsReaddir,
  readFile as fsReadFile,
  readlink as fsReadlink,
  rename as fsRename,
  rm as fsRm,
  rmdir as fsRmdir,
  stat as fsStat,
  symlink as fsSymlink,
  unlink as fsUnlink,
  utimes as fsUtimes,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { runExclusive, withAbort } from './concurrency.ts';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  isFsError,
  isMissing,
  isNodeError,
  isNotFoundErrno,
  Problem,
  rethrowIfAborted,
  unlessMissing,
} from './errors.ts';
import { detectMimeFromContent, type FileKind } from './mime.ts';
import { Logger } from './observability.ts';
import type { EntryType as FileType } from './path-utils.ts';
import {
  isPathInsideDirectory,
  isSamePath,
  normalizePath,
  resolveEntryType,
} from './path-utils.ts';
import type { PathGuard } from './path.ts';
import type { ReadFileResult, ReadSpec } from './read.ts';
import {
  APPEND_CREATE_NOFOLLOW,
  APPEND_NOFOLLOW,
  assertFileStats,
  createTooLargeError,
  O_NOFOLLOW,
  READ_NOFOLLOW,
  readFileWithStats,
  readProbe,
  WRITE_NOFOLLOW,
} from './read.ts';
import {
  identityOf as fileIdentityOf,
  NOT_RECORDING,
  type PathCapture,
  plannedMkdirChain,
  saveOld,
  snapshotTree,
} from './undo.ts';
import type { SavedFile, UndoCapture, UndoRecord } from './undo.ts';
import { getMaxTextFileSize, sha256Hex } from './util.ts';

export type { FileType };
export type { Stats };

// Directory open for countEntries. O_NOFOLLOW refuses a symlink named as the
// directory; used only under COUNT_THROUGH_FD, like the re-check it feeds.
const DIR_NOFOLLOW = constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW;
// Descriptor open for stat. O_PATH opens no file content, so a FIFO cannot block it and a
// mode-000 entry still stats. Node does not export O_PATH; 0o10000000 is its value on every
// Linux architecture Node builds for. Used only under COUNT_THROUGH_FD.
const STAT_NOFOLLOW = 0o10000000 | O_NOFOLLOW;
// The descriptor re-check and the read through /proc/self/fd need Linux with procfs mounted,
// as the read path's re-check does; elsewhere the count reads the directory by path, and
// stat stats it by path.
const COUNT_THROUGH_FD = process.platform === 'linux' && existsSync('/proc/self/fd');

// ─── Domain primitives ────────────────────────────────────────────────────────

const CHAR_LF = 10;

const LINE_COUNT_CHUNK_BYTES = 64 * 1024;
/** A name component's limit: bytes on Linux and macOS, UTF-16 units on Windows, and bytes are never fewer. */
const MAX_NAME_BYTES = 255;
/** `.` + 12 hex + `.tmp`, the part a temp file adds to the name it sits beside. */
const TEMP_SUFFIX_BYTES = 17;

/** The raw ops a test swaps to force a cross-device rename or a failed removal. */
export interface RawOps {
  readonly rename?: typeof fsRename;
  readonly rm?: typeof fsRm;
}

export type TransferOp = 'move' | 'copy';

const TRANSFER_VERB: Readonly<Record<TransferOp, string>> = { move: 'Move', copy: 'Copy' };

/** What a copy always asks of `fs.cp`: the whole tree, links as links, times kept. */
const TRANSFER_COPY_OPTIONS = {
  recursive: true,
  verbatimSymlinks: true,
  preserveTimestamps: true,
  force: true,
} as const;

/**
 * A Transfer settled by `planTransfer`, before any change and before any
 * Confirmation. Plain data: a Confirmation ends the call, so the next round
 * plans again rather than holding one open.
 */
export interface TransferPlan {
  readonly op: TransferOp;
  /** The pair as the caller spelled it; error messages name these. */
  readonly request: { readonly source: string; readonly destination: string };
  /** A Self-move, or a copy onto its own Respelling: execute changes nothing. */
  readonly noop: boolean;
  /** A move onto its own Respelling: real work, exempt from the destination checks. */
  readonly respelling: boolean;
  /** What the mutation acts on: the Entry for a move (a link stays a link), the Landing for a copy. */
  readonly entry: string;
  /** The source resolved through links; every same-target comparison uses it. */
  readonly landing: string;
  /** The validated destination. */
  readonly destination: string;
  /** What sat at the destination when planned; undefined when absent or a Respelling. */
  readonly existing: EntryIdentity | undefined;
}

export interface ExecuteTransferOptions {
  /** Create the destination's missing parent directories first (recorded for undo). */
  readonly createParents?: boolean;
  /** Move only: false rethrows EXDEV instead of copying across devices. */
  readonly crossDevice?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * The validation regime: what an operation does to a path decides which
 * PathGuard check it gets. Every GuardedFileSystem method declares its kind
 * through `#guard`; none picks a validator itself, so a new method adds a call
 * of an existing kind, or one row here.
 *
 * The read-only-probe rule (ADR-010): a `probe` names the entry itself, as a
 * delete does (a link stays a link; containment, the denylist and symlink
 * resolution of its parent all apply), but it mutates nothing, so the
 * read-only-dir refusal is skipped. That keeps `stat` on a link inside a
 * read-only dir working and lets a copy read its source out of one. Anything
 * that removes or replaces its entry is `delete`, which keeps the refusal, so a
 * real move out of a read-only dir stays refused.
 */
const GUARD_REGIME = {
  /** Read through links: the resolved target must exist and be allowed. */
  read: (guard: PathGuard, path: string) => guard.validateExistingPath(path),
  /** As `read`, also reporting the requested spelling and whether it was a link. */
  inspect: (guard: PathGuard, path: string) => guard.validateExistingPathDetailed(path),
  /** The entry itself, read-only: lstat, readlink, a copy's source. */
  probe: (guard: PathGuard, path: string) =>
    guard.validatePathForDelete(path, { allowReadOnly: true }),
  /** Create or replace at the resolved target. */
  write: (guard: PathGuard, path: string) => guard.validatePathForWrite(path),
  /** Remove or move the entry itself. */
  delete: (guard: PathGuard, path: string) => guard.validatePathForDelete(path),
  /** A transfer's mapped descendant: a write whose sensitive-name rule the Relocation walk owns. */
  relocate: (guard: PathGuard, path: string) => guard.validateTransferPathForWrite(path),
} as const satisfies Record<string, (guard: PathGuard, path: string) => Promise<unknown>>;

type GuardKind = keyof typeof GUARD_REGIME;

type Guarded<K extends GuardKind> = Awaited<ReturnType<(typeof GUARD_REGIME)[K]>>;

export class GuardedFileSystem {
  readonly pathGuard: PathGuard;
  readonly #capture: UndoCapture | undefined;
  readonly #rawRename: typeof fsRename;
  readonly #rawRm: typeof fsRm;

  constructor(pathGuard: PathGuard, capture?: UndoCapture, raw: RawOps = {}) {
    this.pathGuard = pathGuard;
    this.#capture = capture;
    this.#rawRename = raw.rename ?? fsRename;
    this.#rawRm = raw.rm ?? fsRm;
  }

  /** Validate `path` for an operation of `kind`; see GUARD_REGIME. */
  /** Run one path's mutation under its own capture; with no Capture it records nothing. */
  #forMutation<T>(path: string, run: (own: PathCapture) => Promise<T>): Promise<T> {
    return this.#capture ? this.#capture.forMutation(path, run) : run(NOT_RECORDING);
  }

  #guard<K extends GuardKind>(kind: K, path: string): Promise<Guarded<K>> {
    return GUARD_REGIME[kind](this.pathGuard, path) as Promise<Guarded<K>>;
  }

  /**
   * O_NOFOLLOW only guards the final component; an ANCESTOR directory swapped
   * for a symlink after validation still passes. Re-read the open descriptor's
   * real path (Linux `/proc/self/fd`; skipped elsewhere) and require it to stay
   * inside the roots. Run before any byte is read or written through `handle`.
   * Resolves to the normalized real path checked, or undefined when /proc is unreadable.
   */
  async #assertFdWithinRoots(
    handle: FileHandle,
    requestedPath: string,
  ): Promise<string | undefined> {
    let fdPath: string;
    try {
      fdPath = await fsReadlink(`/proc/self/fd/${String(handle.fd)}`);
    } catch {
      return undefined;
    }
    // A replaced target reads back as "<path> (deleted)".
    const inRoots =
      isAbsolute(fdPath) &&
      !fdPath.endsWith(' (deleted)') &&
      this.pathGuard.allowedRootContaining(normalizePath(fdPath)) !== undefined &&
      !this.pathGuard.isSensitive(normalizePath(fdPath));
    if (!inRoots) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Path changed under validation and now resolves outside the allowed roots (TOCTOU).',
        requestedPath,
      );
    }
    return normalizePath(fdPath);
  }

  assertNoReadOnlyHardLink(path: string, stats: { nlink: number }): void {
    if (stats.nlink > 1 && this.pathGuard.getReadOnlyDirs().length > 0) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        `Cannot modify multiply-linked file ${path} while read-only directories are configured.`,
        path,
      );
    }
  }

  /**
   * The Relocation walk: one pass under a directory `entry` that checks both
   * rules a transfer of it must keep. Every mapped destination must pass the
   * write check (read-only dirs, the denylist), or, when the destination does
   * not exist yet, only the read-only rule under where it now resolves (a
   * missing destination holds no link). Every entry must keep its
   * sensitive-file status (`PathGuard.relocationKeepsProtection`). A link, or
   * any other non-directory, has nothing under it to relocate. A directory
   * that cannot be listed fails closed.
   * `fs.cp` stats a link to type it, which opens the target, so anything that
   * copies (a copy, or a move with `acrossDevices`) refuses a link to a network
   * or device path; a rename follows nothing.
   */
  async #relocationWalk(
    op: TransferOp,
    entry: string,
    requestedFrom: string,
    destination: string,
    signal?: AbortSignal,
    acrossDevices = false,
  ): Promise<void> {
    const refuseRemoteLink = async (path: string): Promise<void> => {
      if (await this.pathGuard.reachesRemoteLink(normalizePath(path))) {
        throw new FsError(
          ErrorCode.ACCESS_DENIED,
          `${TRANSFER_VERB[op]} refused: ${path} is a link to a network or device path.`,
          requestedFrom,
        );
      }
    };
    const copying = op === 'copy' || acrossDevices;
    const entryStats = await fsLstat(entry);
    if (copying && entryStats.isSymbolicLink()) await refuseRemoteLink(entry);
    if (!entryStats.isDirectory()) return;
    // A missing destination holds no link, so only the read-only rule can differ
    // per entry, and it reads no disk. Its ancestors can still change while a
    // Confirmation is open, so that rule runs under where it lands, resolved once.
    // The protection check below stays on the spelling: a re-spelling can change it.
    const fresh = (await unlessMissing(fsLstat(destination))) === undefined;
    const landing = fresh ? await this.#guard('relocate', destination) : destination;
    const relocate = fresh
      ? (path: string) => {
          this.pathGuard.assertWritable(join(landing, relative(destination, path)));
          return Promise.resolve();
        }
      : (path: string) => this.#guard('relocate', path);
    async function* names(): AsyncGenerator<string> {
      const pending = [''];
      for (let rel = pending.pop(); rel !== undefined; rel = pending.pop()) {
        let dirents: Dirent[];
        try {
          dirents = await fsReaddir(join(entry, rel), { withFileTypes: true });
        } catch (error) {
          rethrowIfAborted(error);
          throw new FsError(
            ErrorCode.ACCESS_DENIED,
            `${TRANSFER_VERB[op]} refused: the directory could not be fully inspected for protected entries`,
            requestedFrom,
            error,
          );
        }
        for (const dirent of dirents) {
          signal?.throwIfAborted();
          const name = rel === '' ? dirent.name : join(rel, dirent.name);
          if (copying && dirent.isSymbolicLink()) await refuseRemoteLink(join(entry, name));
          await relocate(join(destination, name));
          yield name;
          if (dirent.isDirectory()) pending.push(name);
        }
      }
    }
    const keeps = await this.pathGuard.relocationKeepsProtection(
      names(),
      { from: entry, requestedFrom },
      destination,
    );
    if (!keeps) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        `${TRANSFER_VERB[op]} refused: the directory contains protected entries matching the sensitive-file policy; move or copy individual files instead`,
        requestedFrom,
      );
    }
  }

  /** The one read open: O_NOFOLLOW, then the descriptor re-check above. */
  async #openVerified(
    validPath: string,
    requestedPath: string,
    signal?: AbortSignal,
  ): Promise<FileHandle> {
    const handle = await this.#abandonOnAbort(
      fsOpen(validPath, READ_NOFOLLOW),
      signal,
      (late) => late.close(),
      `file handle for ${validPath}`,
    );
    try {
      await this.#assertFdWithinRoots(handle, requestedPath);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /**
   * Waits for `pending` until `signal` fires. A result that lands after the abort goes to
   * `release` without anyone waiting on it, so a stalled open or read never holds the caller.
   */
  async #abandonOnAbort<T>(
    pending: Promise<T>,
    signal: AbortSignal | undefined,
    release: (late: T) => Promise<unknown>,
    label: string,
  ): Promise<T> {
    try {
      return await withAbort(pending, signal);
    } catch (error) {
      void pending
        .then(release, () => undefined)
        .catch((releaseErr: unknown) => {
          Logger.warn(
            `Failed to release ${label} after abort: ${formatUnknownErrorMessage(releaseErr)}`,
          );
        });
      throw error;
    }
  }

  /**
   * Serialize a read-modify-write on the resolved write target, so two writers
   * of one file (any spelling, including via a symlinked parent) cannot both
   * read the same base and have the last rename win. `writeFile`/`appendFile`
   * do not take the lock, so `fn` may call them.
   */
  async lockForWrite<T>(filePath: string, fn: (resolvedTarget: string) => Promise<T>): Promise<T> {
    const key = await this.#guard('write', filePath);
    return runExclusive(key, () => fn(key));
  }

  /**
   * Serialize an operation across BOTH of its paths (a restore's check-then-
   * rename). The two keys are taken in a fixed order and deduped, so two
   * concurrent pairs can never deadlock, and a nested same-key call cannot
   * happen (`runExclusive` is not re-entrant).
   */
  async lockPairForWrite<T>(a: string, b: string, fn: () => Promise<T>): Promise<T> {
    // `a` is where a rename lands (resolved like the move tool's destination);
    // `b` is the entry being moved.
    const keyA = await this.#guard('write', a);
    const keyB = await this.pathGuard.entryLockKey(b);
    if (keyA === keyB) return runExclusive(keyA, fn);
    const [first, second] = keyA < keyB ? [keyA, keyB] : [keyB, keyA];
    return runExclusive(first, () => runExclusive(second, fn));
  }

  /**
   * Bytes of a regular file for undo capture, read through the same
   * O_NOFOLLOW, descriptor-verified open as every other reader: a path swapped
   * for a symlink after validation fails instead of pulling outside bytes in.
   */
  async readSaved(validPath: string): Promise<Buffer> {
    await using handle = await this.#openVerified(validPath, validPath);
    return await handle.readFile();
  }

  async stat(
    filePath: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<{ stats: Stats; validPath: string }> {
    // A late validation result is a plain string, so a stalled realpath needs no release.
    const validPath = await withAbort(this.#guard('read', filePath), options?.signal);
    return { stats: await this.#statVerified(validPath, filePath, options?.signal), validPath };
  }

  /**
   * Stats `validPath` through a descriptor under COUNT_THROUGH_FD, by path elsewhere: an
   * ancestor swapped for a symlink after validation fails the re-check, and a final
   * component swapped for one opens as the link itself.
   */
  async #statVerified(
    validPath: string,
    requestedPath: string,
    signal: AbortSignal | undefined,
  ): Promise<Stats> {
    if (!COUNT_THROUGH_FD) return await withAbort(fsStat(validPath), signal);
    const handle = await this.#abandonOnAbort(
      fsOpen(validPath, STAT_NOFOLLOW),
      signal,
      (late) => late.close(),
      `stat descriptor for ${validPath}`,
    );
    let pendingStat: Promise<Stats> | undefined;
    try {
      await this.#assertFdWithinRoots(handle, requestedPath);
      pendingStat = handle.stat();
      const stats = await withAbort(pendingStat, signal);
      pendingStat = undefined;
      if (stats.isSymbolicLink()) {
        throw new FsError(
          ErrorCode.SYMLINK_NOT_ALLOWED,
          'Path changed under validation and is now a symlink (TOCTOU).',
          requestedPath,
        );
      }
      return stats;
    } finally {
      // A failed close must not replace the stat result or refusal, so it is logged, not thrown.
      const close = () =>
        handle.close().catch((closeErr: unknown) => {
          Logger.warn(
            `Failed to close stat descriptor for ${validPath}: ${formatUnknownErrorMessage(closeErr)}`,
          );
        });
      // close() queues behind an fstat still in flight (a stalled mount), so after an abort
      // close once that fstat settles, without waiting for it.
      if (pendingStat) void pendingStat.then(close, close);
      else await close();
    }
  }

  async lstat(
    filePath: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<{ stats: Stats; validPath: string }> {
    const validPath = await this.#guard('probe', filePath);
    const stats = await withAbort(fsLstat(validPath), options?.signal);
    return { stats, validPath };
  }

  /** As `lstat`, with exact (bigint) fields: what undo identities are built from. */
  async lstatExact(filePath: string): Promise<{ stats: BigIntStats; validPath: string }> {
    const validPath = await this.#guard('probe', filePath);
    return { stats: await fsLstat(validPath, { bigint: true }), validPath };
  }

  async readlink(
    filePath: string,
    options?: Parameters<typeof fsReadlink>[1],
  ): Promise<{ linkString: string; validPath: string }> {
    // A `read` resolves through the symlink, so readlink would always be handed
    // the final target — a regular file — and fail EINVAL. A `probe` keeps the
    // link itself.
    const validPath = await this.#guard('probe', filePath);
    const raw = await fsReadlink(validPath, options);
    const linkString = Buffer.isBuffer(raw) ? raw.toString('utf-8') : raw;
    return { linkString, validPath };
  }

  async mkdir(filePath: string, options?: Parameters<typeof fsMkdir>[1]): Promise<void> {
    const validPath = await this.#guard('write', filePath);
    // Undo capture: collect the chain of directories this call is about to
    // create (each one currently absent), outermost first.
    await this.#forMutation(validPath, async (own) => {
      const created = own.recording ? await plannedMkdirChain(own, validPath) : [];
      await fsMkdir(validPath, options);
      own.push(...created.map((path): UndoRecord => ({ op: 'rmdir', path })));
      own.changed();
    });
  }

  /**
   * Settle a Transfer of `pair` without changing anything: the source's two
   * views, the destination's spelling and kind, the Relocation walk, and
   * what sits at the destination now. Throws the pair's refusal as an
   * `FsError`; a caller with many pairs folds it into that pair's failure.
   *
   * A move acts on its Entry, so moving a link renames the link, not the file
   * it points at; a copy reads through the link. Every comparison uses the
   * Landing, or a link moved onto its own target would read as a real move
   * and replace that target with the link.
   */
  async planTransfer(
    op: TransferOp,
    pair: { source: string; destination: string },
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<TransferPlan> {
    const { entry, landing } = await this.#transferSource(op, pair.source, signal);
    const { destination, kind } = await this.pathGuard.resolveTransferDestination(
      pair.destination,
      { entry, landing },
    );
    const respelling = kind === 'respelling';
    const base = {
      op,
      request: pair,
      entry,
      landing,
      destination,
    };
    // A copy onto its own Respelling is the same file; the same rename is
    // real work for a move and proceeds.
    if (kind === 'self' || (respelling && op === 'copy')) {
      return { ...base, noop: true, respelling, existing: undefined };
    }
    if (!respelling && isPathInsideDirectory(resolve(landing), resolve(destination))) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        `Cannot ${op} a directory into its own subdirectory`,
        pair.source,
      );
    }
    // On the final destination spelling: a re-spelled directory moves its
    // entries in or out of a spelling-specific allow or deny rule.
    await this.#relocationWalk(op, entry, pair.source, destination, signal);
    const existing = respelling ? undefined : await destIdentity(this, destination, op);
    return { ...base, noop: false, respelling, existing };
  }

  /**
   * Carry out a planned Transfer. The Relocation walk runs again and the
   * destination must still be what the plan saw, so nothing that changed
   * while a Confirmation was open is acted on: a destination that appeared
   * fails as created, and one replaced by another entry fails as replaced.
   * A move's source must still name what the plan saw: a link retargeted
   * since could otherwise be renamed over the very file it now points at.
   * A move renames, falling back on EXDEV to a staged copy and removal
   * unless `crossDevice` is false: a copy gives every descendant a new
   * identity, which undo's records cannot follow, so a restore rethrows.
   */
  async executeTransfer(
    plan: TransferPlan,
    { createParents = false, crossDevice = true, signal }: ExecuteTransferOptions = {},
  ): Promise<{ from: string; to: string }> {
    const { op, entry, destination, request } = plan;
    const done = { from: entry, to: destination };
    if (plan.noop) {
      // A self-move changes nothing, but a missing source still fails as the
      // rename would; lstat, so a dangling link counts as present.
      await fsLstat(entry);
      return done;
    }
    if (op === 'move') {
      const now = await this.#transferSource(op, request.source, signal);
      if (!isSamePath(now.entry, entry) || !isSamePath(now.landing, plan.landing)) {
        throw new FsError(
          ErrorCode.CANCELLED,
          `Move cancelled: source "${request.source}" changed after it was planned.`,
          request.source,
        );
      }
    }
    await this.#relocationWalk(op, entry, request.source, destination, signal);
    if (!plan.respelling) {
      const now = await destIdentity(this, destination, op);
      if (plan.existing === undefined && now !== undefined) {
        throw new FsError(
          ErrorCode.CANCELLED,
          `${TRANSFER_VERB[op]} cancelled: destination "${request.destination}" was created during confirmation.`,
          request.destination,
        );
      }
      // shortcut: transfers take no write lock, so a swap between this check and the rename still lands; lock the destination if that window matters
      if (plan.existing !== undefined && now !== undefined && !sameIdentity(now, plan.existing)) {
        throw new FsError(
          ErrorCode.CANCELLED,
          `${TRANSFER_VERB[op]} cancelled: destination "${request.destination}" was replaced after the overwrite was approved.`,
          request.destination,
        );
      }
    }
    if (createParents) await this.mkdir(dirname(destination), { recursive: true });
    if (op === 'copy') await this.#copy(entry, destination);
    else await this.#move(plan, crossDevice);
    return done;
  }

  /**
   * One-shot move: `planTransfer` then `executeTransfer`, with no
   * Confirmation between them.
   */
  async rename(
    oldPath: string,
    newPath: string,
    { crossDevice = true }: { crossDevice?: boolean } = {},
  ): Promise<void> {
    const plan = await this.planTransfer('move', { source: oldPath, destination: newPath });
    await this.executeTransfer(plan, { crossDevice });
  }

  /**
   * A move needs two views of its source: the Entry it renames (a link stays a
   * link) and the Landing every check compares. A link whose target is gone
   * or cannot be validated stands for itself: the move renames the link and
   * never touches what it points at. A copy reads through the link, so both
   * views are the Landing.
   */
  async #transferSource(
    op: TransferOp,
    source: string,
    signal: AbortSignal | undefined,
  ): Promise<{ entry: string; landing: string }> {
    try {
      if (op === 'move') {
        const entry = await this.#guard('delete', source);
        try {
          const { validPath: landing } = await this.stat(source, { signal });
          return { entry, landing };
        } catch (err) {
          if (!isFsError(err)) throw err;
          const link = await unlessMissing(this.lstat(source, { signal }));
          if (!link?.stats.isSymbolicLink()) throw err;
          return { entry, landing: entry };
        }
      }
      const { validPath: landing } = await this.stat(source, { signal });
      return { entry: landing, landing };
    } catch (error) {
      if (isFsError(error) || signal?.aborted) throw error;
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        `${TRANSFER_VERB[op]} failed for ${source}`,
        source,
      );
    }
  }

  /** The move half of `executeTransfer`: Capture, raw rename, cross-device fallback. */
  async #move(plan: TransferPlan, crossDevice: boolean): Promise<void> {
    // Validated again right before the rename, as every mutation is.
    const validOld = await this.#guard('delete', plan.entry);
    const validNew = plan.respelling
      ? plan.destination
      : await this.#guard('write', plan.destination);
    // Undo capture: snapshot the destination before the rename replaces it.
    // A spelling-only rename IS the source; there is no second entry to save.
    // Its own capture: a destination that cannot be saved must not cost its siblings their undo.
    await this.#forMutation(validNew, async (own) => {
      let saved: SavedFile | undefined;
      if (own.recording && !plan.respelling) {
        try {
          const dest = await unlessMissing(fsLstat(validNew));
          if (dest === undefined) {
            // absent: nothing to save, the rename record alone restores it.
          } else if (dest.isDirectory()) {
            own.abandon('move replaced a directory');
          } else if (dest.isFile()) {
            saved = await saveOld(own, this, validNew, dest);
          } else {
            own.abandon('could not inspect the move destination');
          }
        } catch {
          own.abandon('could not read the old content');
        }
      }
      try {
        await this.#rawRename(validOld, validNew);
      } catch (error: unknown) {
        rethrowIfAborted(error);
        if (!crossDevice || !isNodeError(error) || error.code !== 'EXDEV') throw error;
        own.abandon('a move across devices is not undoable yet');
        await this.#moveAcrossDevices(validOld, validNew, plan.request.source, own);
        return;
      }
      // ponytail: the rename check is identity only. A moved directory whose
      // contents changed after the move is still moved back; upgrade by hashing
      // the tree under `to` before recording it.
      if (own.recording) {
        if (saved) own.push({ op: 'write', path: validNew, ...saved, expect: null });
        const identity = await fsLstat(validNew, { bigint: true }).then(
          fileIdentityOf,
          () => undefined,
        );
        if (identity !== undefined) {
          own.push({ op: 'rename', from: validOld, to: validNew, identity });
        } else {
          own.abandon('could not inspect the moved entry');
        }
        own.changed();
      }
    });
  }

  async writeFile(
    filePath: string,
    content: string | Buffer,
    options: { signal?: AbortSignal | undefined; mode?: number | undefined } = {},
  ): Promise<{ validPath: string }> {
    const validPath = await this.#guard('write', filePath);
    // Its own capture: a file that cannot be saved must not cost its siblings their undo.
    await this.#forMutation(validPath, (own) =>
      this.#writeValid(validPath, filePath, content, options, own),
    );
    return { validPath };
  }

  async #writeValid(
    validPath: string,
    filePath: string,
    content: string | Buffer,
    options: { signal?: AbortSignal | undefined; mode?: number | undefined },
    own: PathCapture,
  ): Promise<void> {
    const { signal } = options;

    const tempSuffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const tempPath = atomicTempPath(validPath, tempSuffix);

    // The rename below swaps in the temp file's inode, so the target would
    // inherit fsWriteFile's default 0o666 & ~umask — silently widening a 0600
    // file to 0644 on every write. Carry the existing mode across instead.
    let existingMode: number | undefined;
    let inPlace = false;
    // Names of one inode share its bytes, so in-place writes through any of them serialize on this key.
    let inodeKey = '';
    let existingStats: Stats | undefined;
    let saved: SavedFile | undefined;
    try {
      const existing = await fsStat(validPath);
      existingStats = existing;
      existingMode = existing.mode & 0o777;
      inPlace = existing.isFile() && existing.nlink > 1;
      inodeKey = `inode:${existing.dev}:${existing.ino}`;
      // Undo capture: save the bytes about to be overwritten. A write over a
      // non-regular entry (FIFO, socket) cannot be undone — the remove record
      // would delete the replacement and report restored while the original
      // entry is gone — so the capture refuses instead of lying.
      if (own.recording) {
        if (!existing.isFile()) {
          own.abandon('cannot capture a write over a non-regular file');
        } else {
          saved = await saveOld(own, this, validPath, existing);
        }
      }
    } catch (error) {
      // ENOENT is the normal new-file case: the default mode is correct there.
      // Anything else (EACCES, EIO) means the mode about to be overwritten could
      // not be read, and the write will silently widen the file — say so rather
      // than swallowing it.
      if (!isNotFoundErrno(error)) {
        Logger.warn(
          `atomicWriteFile: cannot read the existing mode of ${validPath}; the write will use the default mode: ${formatUnknownErrorMessage(error)}`,
        );
        own.abandon('could not read the old content');
      }
    }
    if (existingStats) this.assertNoReadOnlyHardLink(validPath, existingStats);
    const mode = existingMode ?? options.mode;
    // Called once the bytes have landed, before a descriptor closes: a failed close must not hide them.
    const recordWrite = (): void => {
      if (!own.recording) return;
      // A string hashes as its UTF-8 bytes, which is what the write stored.
      const expect = sha256Hex(content);
      own.push(
        saved
          ? { op: 'write', path: validPath, ...saved, expect }
          : { op: 'remove', path: validPath, expect },
      );
      own.changed();
    };

    if (inPlace) {
      // shortcut: in-place write is not crash-atomic; a rename would give this path a new inode and strand the other links on the old bytes.
      signal?.throwIfAborted();
      await runExclusive(inodeKey, async () => {
        await using handle = await fsOpen(validPath, WRITE_NOFOLLOW);
        await this.#assertFdWithinRoots(handle, filePath);
        // The last cancellation point, outside the try: an abort here wrote nothing, so the undo capture stays usable.
        signal?.throwIfAborted();
        try {
          // No signal on the write: once truncated, an abort would leave the file empty.
          await handle.truncate(0);
          await handle.writeFile(content);
          await handle.sync();
        } catch (error) {
          // The old bytes are gone, so this exit reports.
          own.abandon('the write failed part-way');
          own.changed();
          throw error;
        }
        recordWrite();
      });
    } else {
      try {
        signal?.throwIfAborted();
        // Create the temp file already narrowed to the target's mode: a 0600
        // file's new bytes must never sit at 0644 while the write is in flight.
        // `wx` fails on a name collision instead of overwriting; the chmod below
        // still restores bits the umask masked off at creation.
        await fsWriteFile(tempPath, content, {
          signal,
          flag: 'wx',
          // The rename publishes these bytes, so they must reach the disk first: a
          // crash in between could otherwise leave the name on an empty file.
          flush: true,
          ...(mode !== undefined ? { mode } : {}),
        });
        await keepOwner(tempPath, existingStats);
        if (mode !== undefined) {
          await fsChmod(tempPath, mode);
        }
        // Last cancellation point. The rename IS the commit: once it starts the
        // target may already be replaced, so it is never raced against the
        // signal — a withAbort race would report a finished write as failed, and
        // a client retry would apply it twice (same reasoning as appendFile).
        signal?.throwIfAborted();
        await fsRename(tempPath, validPath);
      } catch (error) {
        try {
          await fsUnlink(tempPath);
        } catch (cleanupError) {
          Logger.warn(
            `Failed to clean up temp file ${tempPath} after write error (${formatUnknownErrorMessage(error)}): ${formatUnknownErrorMessage(cleanupError)}`,
          );
        }
        throw error;
      }
      recordWrite();
    }
  }

  /**
   * Append to the existing file (created if missing). Deliberately NOT the
   * writeFile temp+rename dance: the rename would swap in a fresh inode,
   * and the whole point of appending is to extend the file that's already
   * there — inode and mode survive by construction.
   */
  async appendFile(
    filePath: string,
    content: string,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<{ validPath: string }> {
    const validPath = await this.#guard('write', filePath);
    await this.#forMutation(validPath, (own) =>
      this.#appendValid(validPath, filePath, content, options.signal, own),
    );
    return { validPath };
  }

  async #appendValid(
    validPath: string,
    filePath: string,
    content: string,
    signal: AbortSignal | undefined,
    own: PathCapture,
  ): Promise<void> {
    // Non-regular targets must be rejected before the open: 'a' on a FIFO
    // (POSIX) blocks until a reader appears, and fsOpen takes no signal, so
    // the call would hang unabortable and pin its concurrency slot. The
    // overwrite path can't hang — it writes a temp file and renames over.
    // The `write` guard has already resolved any symlink to its target, so the
    // lstat here doubles as the new-vs-existing probe for the cleanup below.
    let existing: Stats | undefined;
    try {
      existing = await fsLstat(validPath);
      assertFileStats(validPath, existing);
      this.assertNoReadOnlyHardLink(validPath, existing);
    } catch (error) {
      if (!isNotFoundErrno(error)) throw error;
    }
    // Undo capture: the whole old file is saved, not its size — a multi-GB
    // append goes over the budget and reads as not undoable.
    // ponytail: upgrade path is a `truncate` record with a streamed after-hash.
    let saved: SavedFile | undefined;
    if (own.recording && existing) {
      try {
        saved = await saveOld(own, this, validPath, existing);
      } catch {
        own.abandon('could not read the old content');
      }
    }
    // fs.promises.appendFile takes no signal, so a withAbort race would
    // report failure while the append still lands — a client retry then
    // appends twice. A handle opened with 'a' gets a genuinely abortable
    // FileHandle.writeFile instead, same as the writeFile path. 'a' on a
    // missing target CREATES it, so: check the signal before the open, and
    // if the call then fails after creating the file, remove what it made —
    // an aborted or errored call must not leave a phantom file behind.
    // The pre-open lstat only proves the file was missing a moment ago:
    // 'ax' makes creation exclusive, so a racer that created it in between
    // fails EEXIST, reopens plainly, and never claims cleanup rights over
    // the winner's file.
    signal?.throwIfAborted();
    let created = false;
    let handle: FileHandle;
    if (existing) {
      handle = await fsOpen(validPath, APPEND_NOFOLLOW);
    } else {
      try {
        handle = await fsOpen(validPath, APPEND_CREATE_NOFOLLOW);
        created = true;
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
        handle = await fsOpen(validPath, APPEND_NOFOLLOW);
      }
    }
    let writing = false;
    try {
      signal?.throwIfAborted();
      // A file we just O_EXCL-created is a fresh regular file; only an existing one
      // can have been reached through a swapped ancestor.
      if (!created) await this.#assertFdWithinRoots(handle, filePath);
      writing = true;
      // Ceiling: an append is not transactional, so an abort landing
      // mid-write can leave a prefix of the content on disk. Unwiring the
      // signal would trade that for a silently-completed write; a client
      // that retries is double-appending either way, so the abortable
      // write stays.
      await handle.writeFile(content, { signal });
      // Before the close in `finally`: a failed close must not hide bytes that landed.
      if (own.recording) {
        own.push(
          saved
            ? {
                op: 'write',
                path: validPath,
                ...saved,
                expect: sha256Hex(Buffer.concat([saved.bytes, Buffer.from(content, 'utf8')])),
              }
            : { op: 'remove', path: validPath, expect: sha256Hex(content) },
        );
        own.changed();
      }
    } catch (error) {
      // A failed write can leave a prefix of the content behind, which no record
      // covers, so this path is not undoable. A file this call made and removed again leaves nothing.
      let remains = writing && !created;
      if (created) {
        await fsUnlink(validPath).catch((unlinkError: unknown) => {
          remains = true;
          Logger.warn(
            `Failed to remove newly created ${validPath} after a failed append: ${formatUnknownErrorMessage(unlinkError)}`,
          );
        });
      }
      if (remains) {
        own.abandon('the append failed part-way');
        own.changed();
      }
      throw error;
    } finally {
      await handle.close();
    }
  }

  /**
   * Leading bytes of a file, for MIME sniffing without loading the whole
   * file — an append's result must describe the resulting file (which may be
   * a multi-GB log), not the chunk that was appended.
   */
  async readLeadingSample(filePath: string): Promise<Buffer> {
    await using handle = await this.open(filePath);
    return await readProbe(handle);
  }

  /**
   * Line count for a file on disk, counting newline bytes in fixed 64 KiB
   * chunks so an arbitrarily large file (one append's result metadata) costs
   * bounded memory. NOT FileHandle.readLines: it decodes each physical line
   * whole, so a multi-GB single-line log OOMs the server after the append has
   * already landed — a reported failure invites a retry that appends twice.
   * Matches read.ts's countLines semantics: a trailing newline does not open
   * a new line, an unterminated final line counts, an empty file is 0.
   */
  async countFileLines(filePath: string): Promise<number> {
    await using handle = await this.open(filePath);
    let newlines = 0;
    let lastByte = 0;
    let totalBytes = 0;
    const chunk = Buffer.alloc(LINE_COUNT_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      for (let i = 0; i < bytesRead; i++) {
        const byte = chunk[i] ?? 0;
        if (byte === CHAR_LF) newlines++;
        lastByte = byte;
      }
    }
    // totalBytes is the empty-file sentinel: a NUL (0x00) final byte is real
    // content and must count as an unterminated final line, not "empty".
    return totalBytes === 0 ? 0 : lastByte === CHAR_LF ? newlines : newlines + 1;
  }

  async rm(
    filePath: string,
    options?: Parameters<typeof fsRm>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    const validPath = await this.#guard('delete', filePath);
    // Undo capture: the tree snapshot is pushed BEFORE the raw call — a
    // recursive rm can fail halfway with files already gone.
    // Its own capture: a path that cannot be saved must not cost its siblings their undo.
    await this.#forMutation(validPath, async (own) => {
      if (own.recording) {
        await snapshotTree(own, this, validPath, signal);
      }
      // The snapshot can run long. A cancel during it stops here, the last point
      // where nothing is gone, and no undo id is offered for a delete that never ran.
      signal?.throwIfAborted();
      own.changed();
      await fsRm(validPath, options);
    });
  }

  async rmdir(filePath: string, options?: Parameters<typeof fsRmdir>[1]): Promise<void> {
    const validPath = await this.#guard('delete', filePath);
    await this.#forMutation(validPath, async (own) => {
      const before = own.recording
        ? await fsLstat(validPath, { bigint: true }).catch(() => undefined)
        : undefined;
      await fsRmdir(validPath, options);
      own.push({
        op: 'mkdir',
        path: validPath,
        mode: before && Number(before.mode) & 0o777,
        was: before && fileIdentityOf(before),
      });
      own.changed();
    });
  }

  async symlink(target: string, linkPath: string, type: 'file' | 'junction'): Promise<void> {
    const validPath = await this.#guard('write', linkPath);
    await fsSymlink(target, validPath, type);
  }

  /** The copy half of `executeTransfer`. */
  async #copy(source: string, destination: string): Promise<void> {
    const validSource = await this.#guard('probe', source);
    const validDest = await this.#guard('write', destination);
    // Undoing a forced cp means telling new files apart from overwritten ones
    // across a merged tree.
    // ponytail: upgrade path is snapshotting destination entries here before
    // fsCp, the way snapshotTree does.
    this.#capture?.abandon('copies are not undoable yet');
    // One file copied over one existing file stages instead: fs.cp with force
    // unlinks the destination before it copies, so a failed copy lost the old
    // bytes. The staged copy renames into place, leaving the destination
    // untouched on any failure (and no temporary file behind).
    const kind = await bothOfKind(validSource, validDest);
    if (kind === 'file') return this.#copyIntoPlace(validSource, validDest);
    // A directory merged into an existing one cannot stage as a whole (a
    // rename never merges), so it walks: only the entries that would lose old
    // bytes stage; everything else copies exactly as the plain cp did.
    if (kind === 'directory') return this.#copyMerging(validSource, validDest);
    await fsCp(validSource, validDest, {
      ...TRANSFER_COPY_OPTIONS,
      filter: async (_sourcePath, destinationPath) => {
        await this.#guard('relocate', destinationPath);
        return true;
      },
    });
  }

  /**
   * The cross-device half of a move, after the raw rename failed with EXDEV:
   * copy into place on the destination's device, and only then remove the
   * source.
   */
  async #moveAcrossDevices(
    source: string,
    destination: string,
    label: string,
    own: PathCapture,
  ): Promise<void> {
    // Validated again after the failed rename, as the public copy helper did:
    // an ancestor swapped for a link in between must not steer the copy.
    const validSource = await this.#guard('delete', source);
    const validDest = await this.#guard('write', destination);
    await this.#relocationWalk('move', validSource, label, validDest, undefined, true);
    let copied = false;
    try {
      await this.#copyIntoPlace(validSource, validDest);
      copied = true;
      // The destination has changed by now, so a failed source removal still reports.
      own.changed();
      // Re-check containment, as the guarded rm did: an ancestor swapped for an
      // out-of-root link during the copy must not steer the removal outside.
      await this.#guard('delete', validSource);
      await this.#rawRm(validSource, { recursive: true, force: true });
    } catch (copyOrRemoveError: unknown) {
      rethrowIfAborted(copyOrRemoveError);
      if (copied) {
        // cp succeeded but rm failed: the destination already holds a complete
        // copy and the source remains. Surface the rm error as the cause so the
        // caller can recover (clean up the duplicate) instead of a silent generic
        // failure that hides the partial completion.
        const baseProblem = Problem.fromUnknown(copyOrRemoveError, ErrorCode.UNKNOWN, label);
        throw new FsError(
          baseProblem.code,
          `Cross-device move of ${label}: copy succeeded but source removal failed (destination holds a copy): ${baseProblem.message}`,
          label,
          copyOrRemoveError,
        );
      }
      throw copyOrRemoveError;
    }
  }

  /**
   * Copy `validSource` (a link stays a link) into a fresh staging directory
   * beside `validDest`, then rename it into place. That rename stays on one
   * device, so it refuses what a plain rename would (a non-empty directory is
   * never merged into), and a partial copy never reaches the destination. The
   * staging directory is removed either way.
   */
  async #copyIntoPlace(validSource: string, validDest: string): Promise<void> {
    // Not validated on its own: it sits under the validated destination's
    // parent, and the denylist has ruled on the destination, which a rooted
    // allow or deny entry names exactly and the staged spelling would miss.
    const staged = crossDeviceStagingPath(validDest);
    const stagingDir = dirname(staged);
    await fsMkdir(stagingDir, { mode: 0o700 });
    try {
      await fsCp(validSource, staged, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
      // Raw, not this.rename: both ends are validated, and the guarded rename
      // would read a relative link that now resolves to the destination as a
      // move onto itself, and do nothing.
      await fsRename(staged, validDest);
    } finally {
      await fsRm(stagingDir, { recursive: true, force: true }).catch((cleanupError: unknown) => {
        Logger.warn(
          `Failed to remove staging directory ${stagingDir} after a cross-device move: ${formatUnknownErrorMessage(cleanupError)}`,
        );
      });
    }
  }

  /**
   * A copy of one directory merged into another. Not transactional: entries
   * copied before a failure stay. Only the one shape that loses old bytes on a
   * failure — a file landing on an existing file — stages through
   * `#copyIntoPlace`; every other entry copies exactly as the whole-tree
   * `fs.cp` it replaces, so refusals, links and timestamps are unchanged. The
   * merged destination directory keeps the source's times, as `fs.cp` set
   * them.
   */
  async #copyMerging(validSource: string, validDest: string): Promise<void> {
    try {
      await this.#copyMergedDir(validSource, validDest);
    } catch (error) {
      rethrowIfAborted(error);
      const baseProblem = Problem.fromUnknown(error, ErrorCode.UNKNOWN, validSource);
      throw new FsError(
        baseProblem.code,
        `Copy stopped part-way after some entries were copied: ${baseProblem.message}`,
        validSource,
        error,
      );
    }
  }

  async #copyMergedDir(source: string, destination: string): Promise<void> {
    const dirents = await fsReaddir(source, { withFileTypes: true });
    const sourceStats = await fsLstat(source);
    for (const dirent of dirents) {
      const srcChild = join(source, dirent.name);
      const destChild = join(destination, dirent.name);
      let destStats: Stats | undefined;
      try {
        destStats = await fsLstat(destChild);
      } catch {
        // Nothing there yet: the plain cp creates it, as before.
      }
      if (dirent.isFile() && destStats?.isFile()) {
        // Revalidated here, not only in the pre-copy walk: an ancestor
        // swapped for an out-of-root link while an earlier entry copied must
        // not steer the staged rename outside the roots. The delegated
        // branch's filter revalidates its entries the same way.
        await this.#guard('relocate', destChild);
        await this.#copyIntoPlace(srcChild, destChild);
      } else if (dirent.isDirectory() && destStats?.isDirectory()) {
        await this.#copyMergedDir(srcChild, destChild);
      } else {
        await fsCp(srcChild, destChild, {
          ...TRANSFER_COPY_OPTIONS,
          filter: async (_sourcePath, destinationPath) => {
            await this.#guard('relocate', destinationPath);
            return true;
          },
        });
      }
    }
    await fsUtimes(destination, sourceStats.atime, sourceStats.mtime);
  }

  async readFile(filePath: string, spec: ReadSpec): Promise<ReadFileResult> {
    spec.signal?.throwIfAborted();
    const validPath = await this.#guard('read', filePath);
    const stats = await this.#statVerified(validPath, filePath, spec.signal);
    return readFileWithStats(filePath, validPath, stats, spec, () =>
      this.#openVerified(validPath, filePath, spec.signal),
    );
  }

  async readRaw(
    filePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<{
    content: Buffer;
    mimeType: string;
    kind: FileKind;
    isBinary: boolean;
    validPath: string;
    modified: string;
  }> {
    options?.signal?.throwIfAborted();
    const validPath = await this.#guard('read', filePath);
    options?.signal?.throwIfAborted();
    const stats = await this.#statVerified(validPath, filePath, options?.signal);
    assertFileStats(filePath, stats);
    // Enforce size limit before reading to avoid loading large files into memory.
    // Binary detection is best-effort, but this is a hard limit.
    const maxTextFileSize = getMaxTextFileSize();
    if (stats.size > maxTextFileSize) {
      throw createTooLargeError(stats.size, maxTextFileSize, filePath);
    }
    let content: Buffer;
    await using handle = await this.#openVerified(validPath, filePath);
    try {
      content = await fsReadFile(handle, options);
    } catch (error) {
      // Node wraps even a TimeoutError signal reason in AbortError.
      if (error instanceof Error && error.name === 'AbortError') {
        options?.signal?.throwIfAborted();
      }
      throw error;
    }
    const mimeInfo = detectMimeFromContent(validPath, content);
    return {
      content,
      mimeType: mimeInfo.mimeType,
      kind: mimeInfo.kind,
      isBinary: mimeInfo.kind !== 'text',
      validPath,
      modified: stats.mtime.toISOString(),
    };
  }

  /** `requestedPath` names the client's spelling in errors; `signal` abandons a stalled open. */
  async open(
    filePath: string,
    options?: {
      readonly signal?: AbortSignal | undefined;
      readonly requestedPath?: string | undefined;
    },
  ): Promise<FileHandle> {
    return this.#openVerified(
      // A late validation result is a plain string, so a stalled realpath needs no release.
      await withAbort(this.#guard('read', filePath), options?.signal),
      options?.requestedPath ?? filePath,
      options?.signal,
    );
  }

  // Single resolution + stat: an `inspect` resolves the real path (following
  // symlinks, re-checking sensitivity) once, then we stat the resolved target.
  async statDetailed(
    filePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ requestedPath: string; isSymlink: boolean; stats: Stats }> {
    const { requestedPath, resolvedPath, isSymlink } = await this.#guard('inspect', filePath);
    const stats = await this.#statVerified(resolvedPath, filePath, options?.signal);
    return { requestedPath, isSymlink, stats };
  }

  async hasChildrenUnchecked(dirPath: string): Promise<boolean> {
    const dir = await fsOpendir(dirPath);
    try {
      const entry = await dir.read();
      return entry !== null;
    } finally {
      await dir.close().catch((closeErr: unknown) => {
        Logger.warn(
          `Failed to close dir handle for ${dirPath}: ${formatUnknownErrorMessage(closeErr)}`,
        );
      });
    }
  }

  /**
   * True when a directory a delete would remove holds an entry the sensitive-file
   * policy protects, under its validated or requested spelling. Listings hide
   * such entries and a Capture refuses them, so the Confirmation must say so.
   * Links are not followed. A directory that cannot be read refuses the delete:
   * the failure may clear before the delete runs, and the Confirmation could
   * not say what the directory holds.
   */
  async holdsProtectedEntry(
    validPath: string,
    requestedPath: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const pending = [''];
    for (let rel = pending.pop(); rel !== undefined; rel = pending.pop()) {
      signal?.throwIfAborted();
      let dirents: Dirent[];
      try {
        dirents = await withAbort(fsReaddir(join(validPath, rel), { withFileTypes: true }), signal);
      } catch (error) {
        rethrowIfAborted(error);
        // A deadline's TimeoutError is not read as aborted, so the signal decides.
        signal?.throwIfAborted();
        // An entry that vanished mid-walk holds nothing to warn about.
        if (isNotFoundErrno(error)) continue;
        throw new FsError(
          ErrorCode.ACCESS_DENIED,
          'Delete refused: the directory could not be fully inspected for protected entries',
          requestedPath,
          error,
        );
      }
      for (const dirent of dirents) {
        const name = join(rel, dirent.name);
        if (
          this.pathGuard.isSensitive(join(validPath, name)) ||
          this.pathGuard.isSensitive(join(requestedPath, name))
        ) {
          return true;
        }
        if (dirent.isDirectory()) pending.push(name);
      }
    }
    // A deadline that fired during the last read still ends the call, even with no entries left.
    signal?.throwIfAborted();
    return false;
  }

  /**
   * Direct children of a directory, leaving out entries the guard treats as
   * sensitive so the count never reveals what listings hide. Hidden and
   * ignored entries count: this answers "is it empty?", not "what would list show?".
   * A symlinked child counts only when list would show it. The path validation, open, opendir,
   * each read and each link check race the signal, so a stalled mount ends the call at its
   * deadline.
   */
  async countEntries(dirPath: string, options?: { signal?: AbortSignal }): Promise<number> {
    const signal = options?.signal;
    // Refuse an already-cancelled call before any validation or I/O.
    signal?.throwIfAborted();
    // A late validation result is a plain object, so a stalled realpath needs no release.
    const { resolvedPath } = await withAbort(this.#guard('inspect', dirPath), signal);
    // With procfs (COUNT_THROUGH_FD), open the directory itself with O_NOFOLLOW and check where
    // the open descriptor really is, so a directory or ancestor swapped for a symlink after
    // validation is refused. Then read entries through the descriptor, which a later swap cannot
    // redirect.
    const handle = COUNT_THROUGH_FD
      ? await this.#abandonOnAbort(
          fsOpen(resolvedPath, DIR_NOFOLLOW),
          signal,
          (late) => late.close(),
          `directory descriptor for ${resolvedPath}`,
        )
      : undefined;
    let dir: Dir | undefined;
    let pendingRead: Promise<Dirent | null> | undefined;
    try {
      const openedPath = handle ? await this.#assertFdWithinRoots(handle, dirPath) : undefined;
      // An in-root swap passes the roots check, but the children would be filtered under the
      // validated directory's spelling, not the one actually opened.
      if (openedPath !== undefined && !isSamePath(openedPath, resolvedPath)) {
        throw new FsError(
          ErrorCode.ACCESS_DENIED,
          'Path changed under validation and now resolves to another directory (TOCTOU).',
          dirPath,
        );
      }
      const readPath = handle ? `/proc/self/fd/${String(handle.fd)}` : resolvedPath;
      dir = await this.#abandonOnAbort(
        fsOpendir(readPath),
        signal,
        (late) => late.close(),
        `directory stream for ${resolvedPath}`,
      );
      let count = 0;
      for (;;) {
        // Each read races the signal, so a read that stalls ends the call at its deadline.
        const read = dir.read();
        pendingRead = read;
        const entry = await withAbort(read, signal);
        pendingRead = undefined;
        if (entry === null) break;
        if (this.pathGuard.isSensitive(join(dirPath, entry.name))) continue;
        // list walks the real directory, so it checks every child, links
        // included, under its real spelling: a deny rule naming the real
        // directory hides the child under an alias too.
        if (this.pathGuard.isSensitive(join(resolvedPath, entry.name))) continue;
        // A link counts only when list would show it: same rule, same error policy.
        if (
          entry.isSymbolicLink() &&
          !(await withAbort(
            this.pathGuard.isEntryAccessible(join(resolvedPath, entry.name)),
            signal,
          ))
        ) {
          continue;
        }
        count += 1;
      }
      // A deadline that fired during the last read still ends the call, even with no entries left.
      signal?.throwIfAborted();
      return count;
    } finally {
      if (dir) {
        const stream = dir;
        if (pendingRead) {
          // close() queues behind a read still in flight, so awaiting it would hold the TIMEOUT
          // response on a stalled mount. Close once that read settles, without waiting for it.
          void pendingRead
            .then(
              () => stream.close(),
              () => stream.close(),
            )
            .catch((closeErr: unknown) => {
              Logger.warn(
                `Failed to close dir handle for ${resolvedPath} after abort: ${formatUnknownErrorMessage(closeErr)}`,
              );
            });
        } else {
          await stream.close().catch((closeErr: unknown) => {
            Logger.warn(
              `Failed to close dir handle for ${resolvedPath}: ${formatUnknownErrorMessage(closeErr)}`,
            );
          });
        }
      }
      // A failed close must not replace the error the count threw, so it is logged, not thrown.
      await handle?.close().catch((closeErr: unknown) => {
        Logger.warn(
          `Failed to close dir descriptor for ${resolvedPath}: ${formatUnknownErrorMessage(closeErr)}`,
        );
      });
    }
  }
}

/**
 * Give a temp file the owner of the file it will replace: the rename swaps in a
 * new inode, which otherwise belongs to whoever runs the server. Best effort,
 * because only root can give a file away, and a refused write would be worse
 * than a changed owner. POSIX only: Windows has no `process.getuid`.
 * shortcut: POSIX ACLs, extended attributes and Windows ACLs are still lost; copy them if a client reports it.
 */
export async function keepOwner(
  tempPath: string,
  existing: Pick<Stats, 'uid' | 'gid'> | undefined,
  lchown: typeof fsLchown = fsLchown,
): Promise<void> {
  if (existing === undefined || process.getuid === undefined) return;
  // No same-owner shortcut: a temp file can take its group from a setgid
  // directory, so matching the process's ids proves nothing.
  try {
    // lchown: the temp file's directory may be writable by others, so a symlink
    // swapped in must not redirect the ownership change.
    await lchown(tempPath, existing.uid, existing.gid);
  } catch (error) {
    Logger.debug(`Could not keep the owner of ${tempPath}: ${formatUnknownErrorMessage(error)}`);
  }
}

/**
 * Where `writeFile` stages new bytes: beside the target, in the same directory,
 * so the rename stays on one device. The target's own name is kept when it fits,
 * since it says what the file is if a crash leaves it behind. A name too long to
 * take the suffix gets a short one, or a file that exists could not be rewritten.
 */
export function atomicTempPath(validPath: string, suffix: string): string {
  const name = basename(validPath);
  return Buffer.byteLength(name, 'utf8') + TEMP_SUFFIX_BYTES <= MAX_NAME_BYTES
    ? `${validPath}.${suffix}.tmp`
    : join(dirname(validPath), `.${suffix}.tmp`);
}

/**
 * Where a cross-device `rename` stages its copy: `<parent>/.<12 hex>.tmp/<name>`. Every
 * segment of the destination survives, so a deny rule that is not rooted at an
 * absolute path covers an entry staged as it does in place.
 */
export function crossDeviceStagingPath(validDest: string): string {
  const stagingDir = `.${randomUUID().replace(/-/g, '').slice(0, 12)}.tmp`;
  return join(dirname(validDest), stagingDir, basename(validDest));
}

/**
 * The kind both ends of a copy share, for the two shapes that can lose old bytes:
 * a file over a file (a forced `fs.cp` unlinks the destination first, so a failure
 * after that loses it) and a directory into a directory (a whole-tree `fs.cp`
 * overwrites entry by entry). Anything else, links and missing ends included, keeps
 * the plain cp path.
 */
async function bothOfKind(
  source: string,
  destination: string,
): Promise<'file' | 'directory' | undefined> {
  try {
    const [src, dst] = await Promise.all([fsLstat(source), fsLstat(destination)]);
    if (src.isFile() && dst.isFile()) return 'file';
    return src.isDirectory() && dst.isDirectory() ? 'directory' : undefined;
  } catch {
    return undefined;
  }
}

/** What an approval round pins an entry to: a swapped entry differs in at least one field. */
export interface EntryIdentity {
  readonly itemType: FileType;
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

export function identityOf(stats: Stats): EntryIdentity {
  return {
    itemType: resolveEntryType(stats),
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  };
}

// On FAT/exFAT the file id comes from the directory slot, so a recreated file can
// match every field; swaps there go undetected.
// Numbers, not undo's bigints: NTFS file ids pass 2^53 and round, so about 2% of
// siblings share a tuple, yet a 500-trial probe never saw a swap of one path match.
// Undo keys many entries at once and needs the exact form.
// shortcut: on ext4 a file deleted and recreated within a few ms keeps its inode
// and birth ms (83-88% of fast swaps matched, bigint too), so a swap inside the
// write-time window goes undetected; Node exposes no inode generation, so closing
// it needs the mutation to act on a descriptor held since the check.
export function sameIdentity(a: EntryIdentity, b: EntryIdentity): boolean {
  return (
    a.itemType === b.itemType &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.birthtimeMs === b.birthtimeMs
  );
}

/** Stands for a destination whose stat was refused: present, but not nameable. */
export const UNKNOWN_IDENTITY: EntryIdentity = {
  itemType: 'other',
  dev: 0,
  ino: 0,
  birthtimeMs: 0,
};

/**
 * Returns the identity of what `path` resolves to, or `undefined` when absent
 * ("not found" counts as absent). Any other stat failure is logged and yields
 * `UNKNOWN_IDENTITY`, so a destination whose stat is refused is confirmed before
 * it is overwritten, never written over as if absent.
 */
export async function destIdentity(
  fs: Pick<GuardedFileSystem, 'stat'>,
  path: string,
  label: string,
): Promise<EntryIdentity | undefined> {
  try {
    return identityOf((await fs.stat(path)).stats);
  } catch (err) {
    // A path under a regular file cannot exist, so it is absent, not refused.
    const underFile =
      (isFsError(err) && err.code === ErrorCode.NOT_DIRECTORY) ||
      (isNodeError(err) && err.code === 'ENOTDIR');
    if (isMissing(err) || underFile) return undefined;
    Logger.warn(`${label}: dest stat failed unexpectedly for "${path}": ${String(err)}`);
    return UNKNOWN_IDENTITY;
  }
}
