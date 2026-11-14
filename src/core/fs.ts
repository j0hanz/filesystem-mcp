import { AsyncLocalStorage } from 'node:async_hooks';
import { isUtf8 } from 'node:buffer';
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
import { getMaxTextFileSize } from './config.ts';
import {
  binaryRefusal,
  createTooLargeError,
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  isFsError,
  isMissing,
  isNodeError,
  isNotFoundErrno,
  NOT_UTF8_MESSAGE,
  Problem,
  rethrowIfAborted,
  unlessMissing,
} from './errors.ts';
import { detectMimeType, type FileKind, MIME_SAMPLE_SIZE } from './mime.ts';
import { Logger } from './observability.ts';
import type { EntryType as FileType } from './path-utils.ts';
import {
  isPathInsideDirectory,
  isSamePath,
  normalizePath,
  resolveEntryType,
} from './path-utils.ts';
import type { PathGuard } from './path.ts';
import type { ReadFileResult, ReadLimits, ReadSlice, ReadSpec } from './read.ts';
import {
  APPEND_CREATE_NOFOLLOW,
  APPEND_NOFOLLOW,
  assertFileStats,
  binaryKind,
  O_NOFOLLOW,
  READ_NOFOLLOW,
  READ_NONBLOCK_NOFOLLOW,
  readByMode,
  readProbe,
  WRITE_NOFOLLOW,
} from './read.ts';
import type { SkipVerdict } from './scan.ts';
import {
  identityOf as fileIdentityOf,
  NOT_RECORDING,
  type PathCapture,
  planCopyUndo,
  plannedMkdirChain,
  recordCopyUndo,
  saveOld,
  snapshotTree,
} from './undo.ts';
import type { SavedFile, UndoCapture, UndoRecord } from './undo.ts';
import { sha256Hex } from './util.ts';

export type { Stats };

/** The chunk `FileHandle#readFile` reads in, and checks its signal between. */
const READ_CHUNK_BYTES = 512 * 1024;
/** The read past a sized read, which nearly always returns 0 at EOF. */
const EOF_PROBE_BYTES = 4 * 1024;

// ─── Read surface (ADR-015) ───────────────────────────────────────────────────

/**
 * What `read` does with a file that is not UTF-8 text: `refuse` it, return
 * image/audio bytes (`media`), return any binary but UTF-16 (`allow`), or
 * return every file as bytes (`raw`).
 */
type BinaryPolicy = 'refuse' | 'media' | 'allow' | 'raw';

/** What `read` knows before it reads the body: the File class and the stat. */
export interface ReadProbeMeta {
  readonly validPath: string;
  readonly stats: Stats;
  readonly mimeType: string;
  readonly kind: FileKind;
}

interface ReadOptionsBase {
  readonly signal?: AbortSignal | undefined;
  readonly maxSize?: number;
  /** A slice past `maxSize` fails instead of coming back short. */
  readonly hardCap?: boolean;
  /** Runs after classification, before the body; a throw stops the read. */
  readonly beforeBody?: (meta: ReadProbeMeta) => void;
}

export type ReadOptions = ReadOptionsBase &
  (
    | { readonly slice?: undefined; readonly binary?: BinaryPolicy }
    | { readonly slice: ReadSlice; readonly binary?: 'refuse' }
  );

export type ReadTextResult = ReadFileResult & { readonly type: 'text' };

export interface ReadBytesResult {
  readonly type: 'bytes';
  readonly content: Buffer;
  readonly mimeType: string;
  readonly kind: FileKind;
  readonly validPath: string;
  readonly modified: string;
}

export type ReadResult = ReadTextResult | ReadBytesResult;

export type TextVerdict =
  | { readonly kind: 'text'; readonly bytes: Buffer; readonly stats: Stats }
  | { readonly kind: 'undecodable'; readonly bytes: Buffer; readonly stats: Stats }
  | { readonly kind: 'binary'; readonly utf16: boolean }
  | { readonly kind: 'tooLarge'; readonly size: number };

export interface ReadTextOptions {
  readonly signal?: AbortSignal | undefined;
  /** The client's spelling of the path, for errors. */
  readonly requestedPath?: string | undefined;
}

export interface ReadNamedTextOptions {
  readonly signal?: AbortSignal | undefined;
  /** Names the tool in the too-large refusal. */
  readonly tool?: string;
}

export interface NamedTextResult {
  readonly validPath: string;
  readonly content: string;
  readonly stats: Stats;
}

/** The refusal a named file gets for a non-text verdict; `tool` labels the too-large message. */
export function refusalOf(
  verdict: SkipVerdict,
  filePath: string,
  tool: string | undefined,
): FsError {
  switch (verdict.kind) {
    case 'tooLarge': {
      const maxSize = getMaxTextFileSize();
      return new FsError(
        ErrorCode.TOO_LARGE,
        `File too large for ${tool ?? 'edit'} (${verdict.size} bytes > ${maxSize} bytes)`,
        filePath,
        { size: verdict.size, maxFileSize: maxSize },
      );
    }
    case 'binary':
      return binaryRefusal(verdict.utf16 ? 'utf16' : 'binary', filePath);
    case 'undecodable':
      return new FsError(ErrorCode.INVALID_INPUT, NOT_UTF8_MESSAGE, filePath);
  }
}

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

// A recursive rm meets files an indexer or antivirus holds for a moment
// (EBUSY, EPERM on Windows). Node retries those only when asked; without it
// the removal stops part-way through the tree.
const RM_RETRY = { maxRetries: 3, retryDelay: 100 } as const;

// Inode locks this async chain holds. Module-wide like the `runExclusive` keys, so a lock taken
// through one GuardedFileSystem is not re-taken (self-deadlock) through another.
// A holder must not start parallel or detached writes to the same inode: work it spawns inherits this held set and skips the lock.
const heldInodes = new AsyncLocalStorage<ReadonlySet<string>>();

/** Names of one inode share its bytes, so writes through any of them serialize on this key. */
function hardLinkKey(stats: Stats): string | undefined {
  return stats.isFile() && stats.nlink > 1 ? `inode:${stats.dev}:${stats.ino}` : undefined;
}

/** Run `fn` under the inode lock unless this chain already holds it: `runExclusive` is not re-entrant. */
function withInodeLock<T>(inodeKey: string | undefined, fn: () => Promise<T>): Promise<T> {
  const held = heldInodes.getStore();
  if (inodeKey === undefined || held?.has(inodeKey)) return fn();
  return runExclusive(inodeKey, () => heldInodes.run(new Set([...(held ?? []), inodeKey]), fn));
}

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
 * A Deletion settled by `planDelete`, before any change and before any
 * Confirmation. Plain data: a Confirmation ends the call, so the next round
 * plans again rather than holding one open.
 */
/** A settled Creation: what planCreate ruled about one write. */
export interface CreatePlan {
  readonly inputPath: string;
  readonly validPath: string;
  readonly kind: 'append' | 'overwrite' | 'clear' | 'pending';
  /** The sealed Landing identity; present iff kind is 'pending'. */
  readonly identity?: EntryIdentity;
}

export interface DeletePlan {
  readonly inputPath: string;
  readonly validPath: string;
  readonly itemType: FileType;
  readonly firstStats?: { stats: Stats; validPath: string } | undefined;
  readonly pending: boolean;
  readonly holdsProtected: boolean;
  readonly noop: boolean;
  readonly recursive: boolean;
  readonly ignoreIfNotExists: boolean;
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
        `${TRANSFER_VERB[op]} refused: the directory has protected entries under the sensitive-file policy. Move or copy files one at a time.`,
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
   * do not take the path lock and skip an inode lock this chain holds, so `fn` may call them.
   */
  async lockForWrite<T>(filePath: string, fn: (resolvedTarget: string) => Promise<T>): Promise<T> {
    const key = await this.#guard('write', filePath);
    // Path lock, then inode lock: another link's writer must not read the same base.
    return runExclusive(key, async () => {
      const inodeKey = await fsStat(key).then(hardLinkKey, () => undefined);
      return withInodeLock(inodeKey, () => fn(key));
    });
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
      // A destination filled while a Confirmation was open keeps its identity.
      await this.refuseDirectoryMerge(plan);
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
   * Plan a Deletion (see GLOSSARY.md): validate the path, enforce root
   * protection, inspect entry type, check children and sensitive policies.
   * Makes no mutations. A missing path with `ignoreIfNotExists` returns `noop: true`.
   */
  async planDelete(
    path: string,
    options?: {
      recursive?: boolean | undefined;
      ignoreIfNotExists?: boolean | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<DeletePlan> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    const recursive = Boolean(options?.recursive);
    const ignoreIfNotExists = Boolean(options?.ignoreIfNotExists);

    let validPath: string;
    try {
      validPath = await this.pathGuard.validatePathForDelete(path);
    } catch (error) {
      if (ignoreIfNotExists && isMissing(error)) {
        return {
          inputPath: path,
          validPath: path,
          itemType: 'file',
          pending: false,
          holdsProtected: false,
          noop: true,
          recursive,
          ignoreIfNotExists,
        };
      }
      throw error;
    }

    if (this.pathGuard.isAllowedRoot(validPath)) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Deleting a workspace root directory is not allowed',
        path,
      );
    }

    let firstStats: { stats: Stats; validPath: string };
    try {
      firstStats = await this.lstat(validPath, { signal });
    } catch (error) {
      if (isNotFoundErrno(error) && ignoreIfNotExists) {
        return {
          inputPath: path,
          validPath,
          itemType: 'file',
          pending: false,
          holdsProtected: false,
          noop: true,
          recursive,
          ignoreIfNotExists,
        };
      }
      throw error;
    }

    const itemType = resolveEntryType(firstStats.stats);
    let hasChildren = false;
    let holdsProtected = false;
    if (recursive && itemType === 'directory') {
      hasChildren = await this.hasChildrenUnchecked(validPath);
      holdsProtected = hasChildren && (await this.holdsProtectedEntry(validPath, path, signal));
    }

    return {
      inputPath: path,
      validPath,
      itemType,
      firstStats,
      pending: hasChildren,
      holdsProtected,
      noop: false,
      recursive,
      ignoreIfNotExists,
    };
  }

  /**
   * Carry out a planned Deletion. Re-checks the entry identity against the
   * plan's first stat; an entry replaced while a Confirmation was open is
   * refused with `CANCELLED`. Dispatches `rmdir` for non-recursive directories
   * and `rm` for everything else.
   */
  async executeDelete(
    plan: DeletePlan,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<{ deleted: string }> {
    if (plan.noop) {
      return { deleted: plan.validPath };
    }
    const signal = options?.signal;
    signal?.throwIfAborted();

    let currentStats: { stats: Stats; validPath: string };
    try {
      currentStats = await this.lstat(plan.validPath, { signal });
    } catch (error) {
      if (isNotFoundErrno(error) && plan.ignoreIfNotExists) {
        return { deleted: plan.validPath };
      }
      throw error;
    }

    if (plan.firstStats !== undefined) {
      const identityChanged = !sameIdentity(
        identityOf(plan.firstStats.stats),
        identityOf(currentStats.stats),
      );
      if (identityChanged) {
        throw new FsError(
          ErrorCode.CANCELLED,
          `Delete cancelled: "${plan.validPath}" was replaced after the delete was approved.`,
          plan.validPath,
        );
      }
    }

    if (currentStats.stats.isDirectory() && !plan.recursive) {
      await this.rmdir(plan.validPath);
    } else {
      await this.rm(
        plan.validPath,
        { recursive: plan.recursive, force: plan.ignoreIfNotExists },
        signal,
      );
    }

    return { deleted: plan.validPath };
  }

  /**
   * One-shot delete: `planDelete` then `executeDelete`, with no Confirmation.
   */
  async delete(
    path: string,
    options?: {
      recursive?: boolean | undefined;
      ignoreIfNotExists?: boolean | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<{ deleted: string }> {
    const plan = await this.planDelete(path, options);
    return this.executeDelete(plan, options);
  }

  /**
   * Plan a Creation (see GLOSSARY.md): validate the write path, name the
   * Landing identity of a file that would be replaced, and classify the
   * write. An append, or an overwrite the client declared up front, destroys
   * nothing and is pre-settled; a path that names a directory is refused
   * here, before the Confirmation round; a clear path is guarded at execute;
   * a pending path seals its identity for the Confirmation. Makes no
   * mutations. A destination whose stat was refused names UNKNOWN_IDENTITY,
   * so it is confirmed, never written over as absent.
   */
  async planCreate(
    path: string,
    options?: {
      append?: boolean | undefined;
      overwrite?: boolean | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<CreatePlan> {
    options?.signal?.throwIfAborted();
    const validPath = await this.pathGuard.validatePathForWrite(path);
    const identity = await destIdentity(this, validPath, 'create');
    if (identity?.itemType === 'directory') {
      throw new FsError(ErrorCode.NOT_FILE, 'Not a regular file', path);
    }
    const kind: CreatePlan['kind'] =
      options?.append === true
        ? 'append'
        : options?.overwrite === true
          ? 'overwrite'
          : identity !== undefined
            ? 'pending'
            : 'clear';
    if (kind === 'pending' && identity !== undefined) {
      return { inputPath: path, validPath, kind, identity };
    }
    return { inputPath: path, validPath, kind };
  }

  /**
   * Carry out a planned Creation. Takes the write lock, re-checks the Landing
   * identity of a pending overwrite — an entry replaced while a Confirmation
   * was open is refused with `CANCELLED` — refuses a clear path that gained a
   * file since the plan, then creates the parent directory and dispatches the
   * write or append. The Capture is taken inside `writeFile`/`appendFile`,
   * where it is today.
   */
  async executeCreate(
    plan: CreatePlan,
    content: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<{ validPath: string; writtenAt: Date }> {
    options?.signal?.throwIfAborted();
    return this.lockForWrite(plan.validPath, async (resolvedTarget) => {
      if (plan.kind === 'pending') {
        const now = await destIdentity(this, resolvedTarget, 'create');
        // shortcut: lockForWrite is in-process only, so an outside process can still swap between this re-check and the write; lock the file across processes if that window matters
        if (now !== undefined && plan.identity !== undefined && !sameIdentity(now, plan.identity)) {
          throw new FsError(
            ErrorCode.CANCELLED,
            `create cancelled: "${plan.inputPath}" was replaced after the overwrite was approved.`,
            plan.inputPath,
          );
        }
      }
      if (
        plan.kind === 'clear' &&
        (await destIdentity(this, resolvedTarget, 'create')) !== undefined
      ) {
        throw new FsError(
          ErrorCode.CANCELLED,
          `create refused: "${plan.inputPath}" appeared after overwrite confirmation was checked`,
          plan.inputPath,
        );
      }
      await this.mkdir(dirname(plan.validPath), { recursive: true });
      const written =
        plan.kind === 'append'
          ? await this.appendFile(plan.validPath, content, { signal: options?.signal })
          : await this.writeFile(plan.validPath, content, { signal: options?.signal });
      return { validPath: written.validPath, writtenAt: new Date() };
    });
  }

  /**
   * One-shot Creation: `planCreate` then `executeCreate`, with no
   * Confirmation, mirroring `delete`.
   */
  async create(
    path: string,
    content: string,
    options?: {
      append?: boolean | undefined;
      overwrite?: boolean | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<{ validPath: string; writtenAt: Date }> {
    const plan = await this.planCreate(path, options);
    return this.executeCreate(plan, content, options);
  }

  /**
   * A rename never merges directories, so refuse before a prompt or a
   * cross-device copy is spent on one. `entry` is read as itself, since moving
   * a link renames the link; `destination` is already resolved through links.
   * Not part of `planTransfer`: a batch asks only after its overlap check, as
   * another pair may be moving this destination away.
   */
  async refuseDirectoryMerge(plan: TransferPlan): Promise<void> {
    if (plan.op !== 'move' || plan.noop || plan.respelling) return;
    const { entry, destination } = plan;
    const requested = plan.request.destination;
    const [source, dest] = await Promise.all([
      unlessMissing(fsLstat(entry)),
      unlessMissing(fsLstat(destination)),
    ]);
    if (!source?.isDirectory() || !dest?.isDirectory()) return;
    // An unreadable destination falls through: the rename reports what it always did.
    if (!(await this.hasChildrenUnchecked(destination).catch(() => false))) return;
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      `A move cannot merge directories: destination "${requested}" is not empty. Pick a new destination name, or use copy: true to merge and keep the source.`,
      requested,
    );
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
    relocked = false,
  ): Promise<void> {
    const { signal } = options;

    const tempSuffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const tempPath = atomicTempPath(validPath, tempSuffix);

    // The rename below swaps in the temp file's inode, so the target would
    // inherit fsWriteFile's default 0o666 & ~umask — silently widening a 0600
    // file to 0644 on every write. Carry the existing mode across instead.
    let existingMode: number | undefined;
    let inPlace = false;
    let inodeKey: string | undefined;
    let existingStats: Stats | undefined;
    let saved: SavedFile | undefined;
    let relock = false;
    try {
      const existing = await fsStat(validPath);
      existingStats = existing;
      existingMode = existing.mode & 0o777;
      inodeKey = hardLinkKey(existing);
      inPlace = inodeKey !== undefined;
      // The capture's read and the write must share one inode lock, or another link's write can
      // truncate between them. Taken once: the second look, under the lock, does not retry.
      // shortcut: an outside process swapping in another linked inode between the two looks writes it unlocked; retry under the new key if that matters.
      relock = inPlace && !relocked;
      // Undo capture: save the bytes about to be overwritten. A write over a
      // non-regular entry (FIFO, socket) cannot be undone — the remove record
      // would delete the replacement and report restored while the original
      // entry is gone — so the capture refuses instead of lying.
      if (own.recording && !relock) {
        if (!existing.isFile()) {
          own.abandon('cannot capture a write over a non-regular file');
        } else {
          saved = await saveOld(own, this, validPath, existing);
        }
      }
    } catch (error) {
      // A refusal from the capture's verified read (a parent swapped for a link) is not a stat failure: stop the write.
      if (
        isFsError(error) &&
        (error.code === ErrorCode.ACCESS_DENIED || error.code === ErrorCode.SYMLINK_NOT_ALLOWED)
      ) {
        throw error;
      }
      // ENOENT is the normal new-file case: the default mode is correct there.
      // Anything else (EACCES, EIO) means the mode about to be overwritten could
      // not be read, and the write will silently widen the file — say so rather
      // than swallowing it.
      if (!isNotFoundErrno(error)) {
        Logger.warn(
          `atomicWriteFile: cannot read the mode of ${validPath}, so the write uses the default mode:${formatUnknownErrorMessage(error)}`,
        );
        own.abandon('could not read the old content');
      }
    }
    if (relock) {
      return withInodeLock(inodeKey, () =>
        this.#writeValid(validPath, filePath, content, options, own, true),
      );
    }
    if (existingStats) this.assertNoReadOnlyHardLink(validPath, existingStats);
    // An explicit mode (undo restoring a saved file) wins over the one a copy left.
    const mode = options.mode ?? existingMode;
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
      await using handle = await fsOpen(validPath, WRITE_NOFOLLOW);
      await this.#assertFdWithinRoots(handle, filePath);
      // The last cancellation point, outside the try: an abort here wrote nothing, so the undo capture stays usable.
      signal?.throwIfAborted();
      try {
        // Before the bytes: a restored secret must not sit readable at the copy's mode.
        if (options.mode !== undefined) await handle.chmod(options.mode);
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
    relocked = false,
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
    // As in #writeValid: the capture, the separator probe and the append share one inode lock.
    const inodeKey = existing && hardLinkKey(existing);
    if (inodeKey !== undefined && !relocked) {
      return withInodeLock(inodeKey, () =>
        this.#appendValid(validPath, filePath, content, signal, own, true),
      );
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
        own.abandon('file was created concurrently');
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
      const text = created
        ? content
        : (await this.#appendSeparator(validPath, handle, content)) + content;
      await handle.writeFile(text, { signal });
      // Before the close in `finally`: a failed close must not hide bytes that landed.
      if (own.recording) {
        own.push(
          saved
            ? {
                op: 'write',
                path: validPath,
                ...saved,
                expect: sha256Hex(Buffer.concat([saved.bytes, Buffer.from(text, 'utf8')])),
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
   * What an append writes before its content so the content starts on its own
   * line: nothing when the file is empty or already ends with a line feed, or
   * when the content is empty or opens with a newline itself. The newline
   * follows the content's own style, since the content is written verbatim.
   */
  async #appendSeparator(
    validPath: string,
    handle: FileHandle,
    content: string,
  ): Promise<'' | '\n' | '\r\n'> {
    if (content === '' || content.startsWith('\n') || content.startsWith('\r\n')) return '';
    const opened = await handle.stat();
    if (opened.size === 0) return '';
    const last = Buffer.alloc(1);
    try {
      // The append handle is write-only, so the last byte needs its own handle.
      // A file that cannot be read (POSIX mode 0222) gets no separator.
      // shortcut: another process writing between this read and the write can cost or double a newline, upgrade to a locked read if that is reported.
      await using tail = await fsOpen(validPath, READ_NONBLOCK_NOFOLLOW);
      // The path may name another entry by now (a swapped file, a FIFO): only
      // the file the append handle holds may decide, so anything else adds nothing.
      if (!sameIdentity(identityOf(await tail.stat()), identityOf(opened))) return '';
      if ((await tail.read(last, 0, 1, opened.size - 1)).bytesRead === 0) return '';
    } catch {
      return '';
    }
    if (last[0] === CHAR_LF) return '';
    return content.includes('\r\n') ? '\r\n' : '\n';
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
      await fsRm(validPath, { ...options, ...RM_RETRY });
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
    // Its own capture: a copy that cannot be undone must not cost its siblings their undo.
    await this.#forMutation(validDest, async (own) => {
      // Before the copy: which destination entries are new and which it replaces.
      const targets = own.recording ? await planCopyUndo(own, this, validSource, validDest) : [];
      try {
        await this.#copyValid(validSource, validDest);
      } catch (error) {
        own.abandon('the copy failed part-way');
        own.changed();
        throw error;
      }
      if (own.recording) await recordCopyUndo(own, this, targets);
      own.changed();
    });
  }

  async #copyValid(validSource: string, validDest: string): Promise<void> {
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
      await this.#rawRm(validSource, { recursive: true, force: true, ...RM_RETRY });
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
      await fsRm(stagingDir, { recursive: true, force: true, ...RM_RETRY }).catch(
        (cleanupError: unknown) => {
          Logger.warn(
            `Failed to remove staging directory ${stagingDir} after a cross-device move: ${formatUnknownErrorMessage(cleanupError)}`,
          );
        },
      );
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

  /**
   * The one client read (ADR-015): guard, stat, one verified open, the
   * 512-byte probe, then the binary policy, `beforeBody`, and the body. A
   * slice is text only, so it always refuses binary.
   */
  async read(filePath: string, options: ReadOptions & { binary: 'raw' }): Promise<ReadBytesResult>;
  async read(
    filePath: string,
    options?: ReadOptions & { binary?: 'refuse' },
  ): Promise<ReadTextResult>;
  async read(filePath: string, options?: ReadOptions): Promise<ReadResult>;
  async read(filePath: string, options: ReadOptions = {}): Promise<ReadResult> {
    const { signal } = options;
    signal?.throwIfAborted();
    const validPath = await this.#guard('read', filePath);
    signal?.throwIfAborted();
    const stats = await this.#statVerified(validPath, filePath, signal);
    assertFileStats(filePath, stats);
    await using handle = await this.#openVerified(validPath, filePath, signal);
    const probe = await readProbe(handle, signal);
    const { mimeType, kind } = detectMimeType(validPath, probe);
    const refusal = binaryKind(validPath, probe);
    const media = kind === 'image' || kind === 'audio';
    const policy = options.slice ? 'refuse' : (options.binary ?? 'refuse');
    // `allow` (binary: true) still refuses UTF-16 text: the caller converts it first. Media is media whatever its encoding.
    const bytes =
      policy === 'raw' ||
      (policy === 'media' && media) ||
      (policy === 'allow' && (media || refusal === 'binary'));
    if (!bytes && refusal !== undefined) throw binaryRefusal(refusal, filePath);
    options.beforeBody?.({ validPath, stats, mimeType, kind });
    const maxSize = options.maxSize ?? getMaxTextFileSize();

    if (bytes) {
      if (stats.size > maxSize) throw createTooLargeError(stats.size, maxSize, filePath);
      let content: Buffer;
      try {
        content = await fsReadFile(handle, signal ? { signal } : undefined);
      } catch (error) {
        // Node wraps even a TimeoutError signal reason in AbortError.
        if (error instanceof Error && error.name === 'AbortError') signal?.throwIfAborted();
        throw error;
      }
      return {
        type: 'bytes',
        content,
        mimeType,
        kind,
        validPath,
        modified: stats.mtime.toISOString(),
      };
    }

    const limits: ReadLimits = {
      maxSize,
      ...(options.hardCap ? { hardCap: true } : {}),
      ...(signal ? { signal } : {}),
    };
    const spec: ReadSpec = options.slice ?? { kind: 'full' };
    return {
      type: 'text',
      ...(await readByMode(handle, validPath, filePath, stats, spec, limits)),
    };
  }

  /**
   * The one content verdict (ADR-005): guarded open, size, read's binary rule
   * on the leading bytes, then strict UTF-8 on the rest. Never throws for a
   * file's content and never decodes; a caller that searches lossily decodes
   * an `undecodable` file's bytes itself.
   */
  async readText(filePath: string, options?: ReadTextOptions): Promise<TextVerdict> {
    const signal = options?.signal;
    const maxFileSize = getMaxTextFileSize();
    let bytes: Buffer;
    let stats: Stats;
    {
      // open() validates, refuses a swapped final symlink (O_NOFOLLOW) and
      // re-checks the descriptor's real path (H4), so these bytes are the
      // validated file's, not whatever the name points at by now. The signal
      // lets a stalled open (FIFO swapped in, hung mount) be abandoned.
      const handle = await this.open(filePath, {
        signal,
        requestedPath: options?.requestedPath,
      });
      // The fstat or read in flight, if any: the signal ends the wait for it, not the call.
      let pending: Promise<unknown> | undefined;
      const settled = async <T>(call: Promise<T>): Promise<T> => {
        pending = call;
        const result = await withAbort(call, signal);
        pending = undefined;
        return result;
      };
      try {
        stats = await settled(handle.stat());
        const { size } = stats;
        if (size > maxFileSize) return { kind: 'tooLarge', size };
        // Read the size fstat reported into one buffer: handle.readFile would fstat
        // again, an extra round trip on every file a walk touches. Then read on to
        // EOF, so a file that grew meanwhile is read whole (a Rewrite writes back
        // what it read), as is a procfs or other virtual file, which reports a
        // size of 0 while holding text. Usually that is one read that returns 0.
        const chunks: Buffer[] = [];
        let total = 0;
        if (size > 0) {
          const head = Buffer.allocUnsafe(size);
          while (total < size) {
            // In readFile's own chunks, with its check of the signal before each,
            // so a deadline on a slow filesystem lands as soon as it did there.
            signal?.throwIfAborted();
            const length = Math.min(size - total, READ_CHUNK_BYTES);
            const { bytesRead } = await settled(handle.read(head, total, length, total));
            if (bytesRead === 0) break;
            total += bytesRead;
          }
          chunks.push(head.subarray(0, total));
        }
        // A file that came up short has shrunk, so it is already at EOF.
        if (total === size) {
          // Each chunk is filled across reads before it is kept: procfs returns a
          // page per read, and a kept subarray holds its whole chunk. After a sized
          // read the first chunk is small, since it usually only finds EOF.
          let chunk = Buffer.allocUnsafe(size > 0 ? EOF_PROBE_BYTES : READ_CHUNK_BYTES);
          let used = 0;
          for (;;) {
            // Stop once past the cap: a virtual file may never end.
            signal?.throwIfAborted();
            const { bytesRead } = await settled(
              handle.read(chunk, used, chunk.length - used, total),
            );
            if (bytesRead === 0) break;
            total += bytesRead;
            used += bytesRead;
            if (total > maxFileSize) return { kind: 'tooLarge', size: total };
            if (used === chunk.length) {
              chunks.push(chunk);
              chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
              used = 0;
            }
          }
          if (used > 0) chunks.push(chunk.subarray(0, used));
        }
        const [only] = chunks;
        // The common case is the one head buffer: no copy.
        bytes = chunks.length === 1 && only ? only : Buffer.concat(chunks, total);
      } finally {
        // A failed close must not replace the verdict or the refusal, so it is logged, not thrown.
        const close = () =>
          handle.close().catch((closeErr: unknown) => {
            Logger.warn(
              `Failed to close read descriptor for ${filePath}: ${formatUnknownErrorMessage(closeErr)}`,
            );
          });
        // close() queues behind a call still in flight, so after an abort close once it settles.
        if (pending) void pending.then(close, close);
        else await close();
      }
    }
    // The probe is a slice of the bytes already read: no extra syscall.
    const binary = binaryKind(filePath, bytes.subarray(0, MIME_SAMPLE_SIZE));
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
  async readNamedText(filePath: string, options?: ReadNamedTextOptions): Promise<NamedTextResult> {
    const signal = options?.signal;
    const { stats, validPath } = await this.stat(filePath, { signal });
    assertFileStats(filePath, stats);
    const verdict = await this.readText(validPath, { signal, requestedPath: filePath });
    if (verdict.kind !== 'text') throw refusalOf(verdict, filePath, options?.tool);
    return { validPath, content: verdict.bytes.toString('utf8'), stats: verdict.stats };
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
