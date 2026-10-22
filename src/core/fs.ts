import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import type { Dir, Dirent, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  chmod as fsChmod,
  cp as fsCp,
  lstat as fsLstat,
  mkdir as fsMkdir,
  open as fsOpen,
  opendir as fsOpendir,
  readFile as fsReadFile,
  readlink as fsReadlink,
  rename as fsRename,
  rm as fsRm,
  rmdir as fsRmdir,
  stat as fsStat,
  symlink as fsSymlink,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { runExclusive, withAbort } from './concurrency.ts';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  isMissing,
  isNodeError,
  isNotFoundErrno,
} from './errors.ts';
import { detectMimeFromContent, type FileKind, MIME_SAMPLE_SIZE } from './mime.ts';
import { Logger } from './observability.ts';
import type { EntryType as FileType } from './path-utils.ts';
import { isSamePath, normalizePath, respellSpellingOnlyTarget } from './path-utils.ts';
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
} from './read.ts';
import { identityOf, plannedMkdirChain, snapshotTree } from './undo.ts';
import type { UndoCapture, UndoRecord } from './undo.ts';
import { getMaxTextFileSize, sha256Hex } from './util.ts';

export type { FileType };
export type { Stats };

// Directory open for countEntries. O_NOFOLLOW refuses a symlink named as the
// directory; used only under COUNT_THROUGH_FD, like the re-check it feeds.
const DIR_NOFOLLOW = constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW;
// The descriptor re-check and the read through /proc/self/fd need Linux with procfs mounted,
// as the read path's re-check does; elsewhere the count reads the directory by path.
const COUNT_THROUGH_FD = process.platform === 'linux' && existsSync('/proc/self/fd');

// ─── Domain primitives ────────────────────────────────────────────────────────

const CHAR_LF = 10;

const LINE_COUNT_CHUNK_BYTES = 64 * 1024;

export class GuardedFileSystem {
  readonly pathGuard: PathGuard;
  readonly #capture: UndoCapture | undefined;

  constructor(pathGuard: PathGuard, capture?: UndoCapture) {
    this.pathGuard = pathGuard;
    this.#capture = capture;
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

  /** The one read open: O_NOFOLLOW, then the descriptor re-check above. */
  async #openVerified(
    validPath: string,
    requestedPath: string,
    signal?: AbortSignal,
  ): Promise<FileHandle> {
    const opening = fsOpen(validPath, READ_NOFOLLOW);
    let handle: FileHandle;
    try {
      handle = await withAbort(opening, signal);
    } catch (error) {
      // An open the signal abandoned still lands; close it then.
      void opening
        .then(
          (late) => late.close(),
          () => undefined,
        )
        .catch((closeErr: unknown) => {
          Logger.warn(
            `Failed to close file handle for ${validPath} after abort: ${formatUnknownErrorMessage(closeErr)}`,
          );
        });
      throw error;
    }
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
    const key = await this.pathGuard.validatePathForWrite(filePath);
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
    // `b` is the entry being moved, kept as itself so a symlink is locked as
    // the link, not its target. A `b` whose parent is gone (a dry-run
    // intermediate) falls back to write validation.
    const keyA = await this.pathGuard.validatePathForWrite(a);
    const keyB = await this.pathGuard
      .validatePathForDelete(b)
      .catch(() => this.pathGuard.validatePathForWrite(b));
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
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    const stats = await withAbort(fsStat(validPath), options?.signal);
    return { stats, validPath };
  }

  async lstat(
    filePath: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<{ stats: Stats; validPath: string }> {
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    const stats = await withAbort(fsLstat(validPath), options?.signal);
    return { stats, validPath };
  }

  async readlink(
    filePath: string,
    options?: Parameters<typeof fsReadlink>[1],
  ): Promise<{ linkString: string; validPath: string }> {
    // validateExistingPath resolves through the symlink, so readlink would always
    // be handed the final target — a regular file — and fail EINVAL. This guard
    // keeps the link itself while still enforcing containment and the denylist.
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    const raw = await fsReadlink(validPath, options);
    const linkString = Buffer.isBuffer(raw) ? raw.toString('utf-8') : raw;
    return { linkString, validPath };
  }

  async mkdir(filePath: string, options?: Parameters<typeof fsMkdir>[1]): Promise<void> {
    const validPath = await this.pathGuard.validatePathForWrite(filePath);
    // Undo capture: collect the chain of directories this call is about to
    // create (each one currently absent), outermost first.
    const capture = this.#capture;
    let created: string[] = [];
    if (capture && !capture.unavailable) {
      created = await plannedMkdirChain(capture, validPath);
    }
    await fsMkdir(validPath, options);
    if (capture && !capture.unavailable) {
      capture.push(...created.map((path): UndoRecord => ({ op: 'rmdir', path })));
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    // Not validateExistingPath: that resolves through a symlink, so renaming a
    // link would rename its target and leave the link dangling.
    const validOld = await this.pathGuard.validatePathForDelete(oldPath);
    let validNew = await this.pathGuard.validatePathForWrite(newPath);
    // A new path naming the old entry itself, in another case or Unicode
    // spelling, renames that entry. Probed without following a final link:
    // validatePathForWrite resolved a link to its target, and renaming onto
    // that would replace the target with the link.
    const sameEntry = await this.pathGuard.validatePathForDelete(newPath).then(
      (entry) => isSamePath(entry, validOld),
      () => false,
    );
    const spellingOnly = sameEntry || validOld === validNew;
    if (spellingOnly) {
      validNew = respellSpellingOnlyTarget(newPath, sameEntry ? validOld : validNew);
    }
    // Undo capture: snapshot the destination before the rename replaces it.
    // A spelling-only rename IS the source; there is no second entry to save.
    const capture = this.#capture;
    let destBytes: Buffer | undefined;
    let destMode: number | undefined;
    let destWas: ReturnType<typeof identityOf> | undefined;
    if (capture && !capture.unavailable && !spellingOnly) {
      try {
        const dest = await fsLstat(validNew).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
          return undefined;
        });
        if (dest === undefined) {
          // absent: nothing to save, the rename record alone restores it.
        } else if (dest.isDirectory()) {
          capture.abandon('move replaced a directory');
        } else if (dest.isFile()) {
          if (capture.reserve(dest.size)) {
            destBytes = await this.readSaved(validNew);
            destMode = dest.mode & 0o777;
            destWas = identityOf(dest);
          }
        } else {
          capture.abandon('could not inspect the move destination');
        }
      } catch {
        capture.abandon('could not read the old content');
      }
    }
    await fsRename(validOld, validNew);
    // ponytail: the rename check is identity only. A moved directory whose
    // contents changed after the move is still moved back; upgrade by hashing
    // the tree under `to` before recording it.
    if (this.#capture && !this.#capture.unavailable) {
      if (destBytes !== undefined && destMode !== undefined) {
        this.#capture.push({
          op: 'write',
          path: validNew,
          bytes: destBytes,
          mode: destMode,
          expect: null,
          was: destWas,
        });
      }
      const identity = await fsLstat(validNew).then(
        (s) => ({ dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs }),
        () => undefined,
      );
      if (identity !== undefined) {
        this.#capture.push({ op: 'rename', from: validOld, to: validNew, identity });
      } else {
        this.#capture.abandon('could not inspect the moved entry');
      }
    }
  }

  async writeFile(
    filePath: string,
    content: string | Buffer,
    options: { signal?: AbortSignal | undefined; mode?: number | undefined } = {},
  ): Promise<{ validPath: string }> {
    const { signal } = options;
    const validPath = await this.pathGuard.validatePathForWrite(filePath);

    const tempSuffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const tempPath = `${validPath}.${tempSuffix}.tmp`;

    // The rename below swaps in the temp file's inode, so the target would
    // inherit fsWriteFile's default 0o666 & ~umask — silently widening a 0600
    // file to 0644 on every write. Carry the existing mode across instead.
    let existingMode: number | undefined;
    let oldBytes: Buffer | undefined;
    let oldWas: ReturnType<typeof identityOf> | undefined;
    try {
      const existing = await fsStat(validPath);
      existingMode = existing.mode & 0o777;
      // Undo capture: save the bytes about to be overwritten. A write over a
      // non-regular entry (FIFO, socket) cannot be undone — the remove record
      // would delete the replacement and report restored while the original
      // entry is gone — so the capture refuses instead of lying.
      if (this.#capture && !this.#capture.unavailable) {
        if (!existing.isFile()) {
          this.#capture.abandon('cannot capture a write over a non-regular file');
        } else if (this.#capture.reserve(existing.size)) {
          oldBytes = await this.readSaved(validPath);
          oldWas = identityOf(existing);
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
        this.#capture?.abandon('could not read the old content');
      }
    }
    const mode = existingMode ?? options.mode;

    try {
      signal?.throwIfAborted();
      // Create the temp file already narrowed to the target's mode: a 0600
      // file's new bytes must never sit at 0644 while the write is in flight.
      // `wx` fails on a name collision instead of overwriting; the chmod below
      // still restores bits the umask masked off at creation.
      await fsWriteFile(tempPath, content, {
        signal,
        flag: 'wx',
        ...(mode !== undefined ? { mode } : {}),
      });
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
    if (this.#capture && !this.#capture.unavailable) {
      const contentBytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      if (oldBytes !== undefined && existingMode !== undefined) {
        this.#capture.push({
          op: 'write',
          path: validPath,
          bytes: oldBytes,
          mode: existingMode,
          expect: sha256Hex(contentBytes),
          was: oldWas,
        });
      } else {
        this.#capture.push({ op: 'remove', path: validPath, expect: sha256Hex(contentBytes) });
      }
    }
    return { validPath };
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
    const { signal } = options;
    const validPath = await this.pathGuard.validatePathForWrite(filePath);
    // Non-regular targets must be rejected before the open: 'a' on a FIFO
    // (POSIX) blocks until a reader appears, and fsOpen takes no signal, so
    // the call would hang unabortable and pin its concurrency slot. The
    // overwrite path can't hang — it writes a temp file and renames over.
    // resolveForWrite has already resolved any symlink to its target, so the
    // lstat here doubles as the new-vs-existing probe for the cleanup below.
    let existing: Stats | undefined;
    try {
      existing = await fsLstat(validPath);
      assertFileStats(validPath, existing);
    } catch (error) {
      if (!isNotFoundErrno(error)) throw error;
    }
    // Undo capture: the whole old file is saved, not its size — a multi-GB
    // append goes over the budget and reads as not undoable.
    // ponytail: upgrade path is a `truncate` record with a streamed after-hash.
    let oldBytes: Buffer | undefined;
    let oldMode: number | undefined;
    let oldWas: ReturnType<typeof identityOf> | undefined;
    if (this.#capture && !this.#capture.unavailable && existing) {
      try {
        if (this.#capture.reserve(existing.size)) {
          oldBytes = await this.readSaved(validPath);
          oldMode = existing.mode & 0o777;
          oldWas = identityOf(existing);
        }
      } catch {
        this.#capture.abandon('could not read the old content');
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
    try {
      signal?.throwIfAborted();
      // A file we just O_EXCL-created is a fresh regular file; only an existing one
      // can have been reached through a swapped ancestor.
      if (!created) await this.#assertFdWithinRoots(handle, filePath);
      // Ceiling: an append is not transactional, so an abort landing
      // mid-write can leave a prefix of the content on disk. Unwiring the
      // signal would trade that for a silently-completed write; a client
      // that retries is double-appending either way, so the abortable
      // write stays.
      await handle.writeFile(content, { signal });
    } catch (error) {
      // A failure after the open can leave a prefix of the content behind,
      // which no record covers; the call is then not undoable.
      this.#capture?.abandon('the append failed part-way');
      if (created) {
        await fsUnlink(validPath).catch((unlinkError: unknown) => {
          Logger.warn(
            `Failed to remove newly created ${validPath} after a failed append: ${formatUnknownErrorMessage(unlinkError)}`,
          );
        });
      }
      throw error;
    } finally {
      await handle.close();
    }
    if (this.#capture && !this.#capture.unavailable) {
      if (oldBytes !== undefined && oldMode !== undefined) {
        this.#capture.push({
          op: 'write',
          path: validPath,
          bytes: oldBytes,
          mode: oldMode,
          expect: sha256Hex(Buffer.concat([oldBytes, Buffer.from(content, 'utf8')])),
          was: oldWas,
        });
      } else {
        this.#capture.push({ op: 'remove', path: validPath, expect: sha256Hex(content) });
      }
    }
    return { validPath };
  }

  /**
   * Leading bytes of a file, for MIME sniffing without loading the whole
   * file — an append's result must describe the resulting file (which may be
   * a multi-GB log), not the chunk that was appended.
   */
  async readLeadingSample(filePath: string): Promise<Buffer> {
    await using handle = await this.open(filePath);
    const buffer = Buffer.alloc(MIME_SAMPLE_SIZE);
    const { bytesRead } = await handle.read(buffer, 0, MIME_SAMPLE_SIZE, 0);
    return buffer.subarray(0, bytesRead);
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

  async rm(filePath: string, options?: Parameters<typeof fsRm>[1]): Promise<void> {
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    // Undo capture: the tree snapshot is pushed BEFORE the raw call — a
    // recursive rm can fail halfway with files already gone.
    const capture = this.#capture;
    if (capture && !capture.unavailable) {
      await snapshotTree(capture, this, validPath);
    }
    await fsRm(validPath, options);
  }

  async rmdir(filePath: string, options?: Parameters<typeof fsRmdir>[1]): Promise<void> {
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    const was = this.#capture
      ? await fsLstat(validPath).then(identityOf, () => undefined)
      : undefined;
    await fsRmdir(validPath, options);
    this.#capture?.push({ op: 'mkdir', path: validPath, was });
  }

  async symlink(target: string, linkPath: string, type: 'file' | 'junction'): Promise<void> {
    const validPath = await this.pathGuard.validatePathForWrite(linkPath);
    await fsSymlink(
      type === 'junction' ? resolve(dirname(validPath), target) : target,
      validPath,
      type,
    );
  }

  async cp(
    source: string,
    destination: string,
    options?: Parameters<typeof fsCp>[2],
  ): Promise<void> {
    // As in rename: keep the link itself so callers passing verbatimSymlinks
    // actually copy the link rather than a dereferenced target.
    const validSource = await this.pathGuard.validatePathForDelete(source);
    const validDest = await this.pathGuard.validatePathForWrite(destination);
    // Undoing a forced cp means telling new files apart from overwritten ones
    // across a merged tree.
    // ponytail: upgrade path is snapshotting destination entries here before
    // fsCp, the way #snapshotTree does.
    this.#capture?.abandon('copies are not undoable yet');
    await fsCp(validSource, validDest, options);
  }

  async readFile(filePath: string, spec: ReadSpec): Promise<ReadFileResult> {
    spec.signal?.throwIfAborted();
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    const stats = await withAbort(fsStat(validPath), spec.signal);
    return readFileWithStats(filePath, validPath, stats, spec, () =>
      this.#openVerified(validPath, filePath, spec.signal),
    );
  }

  async readEditableText(
    filePath: string,
    options?: { signal?: AbortSignal; tool?: string },
  ): Promise<{ validPath: string; content: string; stats: Stats }> {
    const { stats, validPath } = await this.stat(filePath, options);
    const maxSize = getMaxTextFileSize();
    if (stats.size > maxSize) {
      // `tool` labels the TOO_LARGE message so the client sees which tool refused.
      throw new FsError(
        ErrorCode.TOO_LARGE,
        `File too large for ${options?.tool ?? 'edit'} (${stats.size} bytes > ${maxSize} bytes)`,
        filePath,
        { size: stats.size, maxFileSize: maxSize },
      );
    }
    const { content } = await readFileWithStats(
      filePath,
      validPath,
      stats,
      {
        kind: 'full',
        strictUtf8: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
      () => this.#openVerified(validPath, filePath, options?.signal),
    );
    return { validPath, content, stats };
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
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    options?.signal?.throwIfAborted();
    const stats = await withAbort(fsStat(validPath), options?.signal);
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

  async open(filePath: string): Promise<FileHandle> {
    return this.#openVerified(await this.pathGuard.validateExistingPath(filePath), filePath);
  }

  // Single resolution + stat: validateExistingPathDetailed resolves the real
  // path (following symlinks, re-checking sensitivity) once, then we stat the
  // resolved target. Replaces the tool-side validateExistingPathDetailed +
  // fs.stat pair that re-validated through the free stat() guard.
  async statDetailed(
    filePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ requestedPath: string; isSymlink: boolean; stats: Stats }> {
    const { requestedPath, resolvedPath, isSymlink } =
      await this.pathGuard.validateExistingPathDetailed(filePath);
    const stats = await withAbort(fsStat(resolvedPath), options?.signal);
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
    const { resolvedPath } = await withAbort(
      this.pathGuard.validateExistingPathDetailed(dirPath),
      signal,
    );
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
 * Returns whether `path` exists, treating "not found" as absent and logging any
 * other stat failure. Used for TOCTOU re-checks between plan and execute phases.
 */
export async function destExists(
  fs: Pick<GuardedFileSystem, 'stat'>,
  path: string,
  label: string,
): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (err) {
    if (!isMissing(err)) {
      Logger.warn(`${label}: dest stat failed unexpectedly for "${path}": ${String(err)}`);
    }
    return false;
  }
}
