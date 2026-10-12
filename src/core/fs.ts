import { randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
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
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { withAbort, withPathWriteLock } from './concurrency.ts';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  isFsError,
  isNodeError,
  isNotFoundErrno,
} from './errors.ts';
import { detectMimeFromContent } from './mime.ts';
import { Logger } from './observability.ts';
import type { EntryType as FileType } from './path-utils.ts';
import { normalizePath, respellCaseOnlyTarget } from './path-utils.ts';
import type { PathGuard } from './path.ts';
import type { ReadFileResult, ReadSpec } from './read.ts';
import { assertFileStats, createTooLargeError, readFileWithStats } from './read.ts';
import { getMaxTextFileSize } from './util.ts';

export type { FileType };
export type { Stats };

// ─── Domain primitives ────────────────────────────────────────────────────────

/**
 * validatePathForWrite + symlink resolution: a write aimed at a link must land
 * on its revalidated target, not create a new file beside the link. ENOENT is
 * the normal new-file case, so it falls through with the original path.
 */
async function resolveForWrite(pathGuard: PathGuard, filePath: string): Promise<string> {
  let validPath = await pathGuard.validatePathForWrite(filePath);

  try {
    const stats = await fsLstat(validPath);
    if (stats.isSymbolicLink()) {
      const target = await fsReadlink(validPath);
      const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(validPath), target);
      validPath = await pathGuard.validatePathForWrite(resolvedTarget);
    }
  } catch (error) {
    if (!isNotFoundErrno(error)) {
      throw error;
    }
  }

  return validPath;
}

const CHAR_LF = 10;

const LINE_COUNT_CHUNK_BYTES = 64 * 1024;

// O_NOFOLLOW makes the kernel refuse (ELOOP) to open a path whose FINAL
// component is a symlink, closing the TOCTOU where a validated regular file is
// swapped for a symlink between validation and open (so a read returns, or an
// append writes through, a link pointing outside the sandbox). Every open below
// is handed the realpath-resolved target, whose final component is a real file,
// so O_NOFOLLOW never trips a legitimate in-root symlink. It is 0 on Windows,
// where symlink creation needs privilege; the numeric flags are passed to
// fs.open in place of the 'r'/'a'/'ax' string modes.
// @types/node declares every fs constant as an always-present number, but
// O_NOFOLLOW and O_NONBLOCK are absent on Windows at runtime, so read them
// through a type that admits undefined and fall back to 0 (a no-op flag bit).
const platformConstants = fsConstants as { O_NOFOLLOW?: number; O_NONBLOCK?: number };
const O_NOFOLLOW = platformConstants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = platformConstants.O_NONBLOCK ?? 0;
const READ_NOFOLLOW = fsConstants.O_RDONLY | O_NOFOLLOW;
// O_NONBLOCK turns an append to a symlink-swapped FIFO (which O_NOFOLLOW does
// not reject — a FIFO is not a symlink) from an unabortable open hang into an
// immediate error; it is a no-op for a regular file.
const APPEND_NOFOLLOW = fsConstants.O_WRONLY | fsConstants.O_APPEND | O_NOFOLLOW | O_NONBLOCK;
const APPEND_CREATE_NOFOLLOW =
  fsConstants.O_WRONLY |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  O_NOFOLLOW;

/**
 * Line count for a file on disk, counting newline bytes in fixed 64 KiB
 * chunks so an arbitrarily large file (one append's result metadata) costs
 * bounded memory. NOT FileHandle.readLines: it decodes each physical line
 * whole, so a multi-GB single-line log OOMs the server after the append has
 * already landed — a reported failure invites a retry that appends twice.
 * Matches read.ts's countLines semantics: a trailing newline does not open
 * a new line, an unterminated final line counts, an empty file is 0.
 */
export async function countFileLines(filePath: string): Promise<number> {
  const handle = await fsOpen(filePath, READ_NOFOLLOW);
  try {
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
  } finally {
    await handle.close();
  }
}

export class GuardedFileSystem {
  readonly pathGuard: PathGuard;

  constructor(pathGuard: PathGuard) {
    this.pathGuard = pathGuard;
  }

  /**
   * Defense against an ancestor-DIRECTORY symlink swap in the validate→open
   * window: O_NOFOLLOW only rejects a swapped final component, so once a handle
   * is open, re-derive the file descriptor's real path and require it still
   * lands inside the allowed roots and is not sensitive. Checks containment,
   * not inode identity, so a benign same-path rewrite (new inode, same path)
   * does not trip it. Linux-only and best-effort: `/proc/self/fd` resolves the
   * descriptor's current real path; where it is unavailable (non-Linux) the
   * check is skipped and O_NOFOLLOW still guards the final component. Callers
   * must run this BEFORE reading or writing through the handle.
   */
  async #assertFdWithinRoots(handle: FileHandle, requestedPath: string): Promise<void> {
    let fdRealPath: string;
    try {
      fdRealPath = await fsReadlink(`/proc/self/fd/${String(handle.fd)}`);
    } catch {
      return; // no /proc (non-Linux): rely on O_NOFOLLOW for the final component
    }
    // A target deleted and replaced mid-flight reads back as "<path> (deleted)";
    // treat anything that is not a plain absolute path as changed under us.
    const changed = !isAbsolute(fdRealPath) || fdRealPath.endsWith(' (deleted)');
    const normalized = changed ? undefined : normalizePath(fdRealPath);
    if (
      normalized === undefined ||
      this.pathGuard.allowedRootContaining(normalized) === undefined ||
      this.pathGuard.isSensitive(normalized)
    ) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Path changed under validation and now resolves outside the allowed roots (TOCTOU).',
        requestedPath,
      );
    }
  }

  /**
   * Serialize a read-modify-write against the resolved write target so two
   * calls (or two batch entries) touching one file cannot both read the same
   * base and silently clobber each other (the last atomic rename wins). The key
   * is the resolved target `writeFile` would compute — every spelling of one
   * file, including through a symlinked parent, collapses to one chain, while
   * distinct files stay fully parallel. `writeFile`/`appendFile` themselves do
   * NOT take the lock, so `fn` may call them without re-entering it. A thrown
   * `fn` (ambiguous edit, no match, too large) still releases the chain.
   */
  async lockForWrite<T>(filePath: string, fn: (resolvedTarget: string) => Promise<T>): Promise<T> {
    const key = await resolveForWrite(this.pathGuard, filePath);
    return withPathWriteLock(key, () => fn(key));
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
    options?: { signal?: AbortSignal },
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
    await fsMkdir(validPath, options);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    // Not validateExistingPath: that resolves through a symlink, so renaming a
    // link would rename its target and leave the link dangling.
    const validOld = await this.pathGuard.validatePathForDelete(oldPath);
    let validNew = await this.pathGuard.validatePathForWrite(newPath);
    // Renaming a path onto itself is only meaningful as a case-only rename.
    if (validOld === validNew) validNew = respellCaseOnlyTarget(newPath, validNew);
    await fsRename(validOld, validNew);
  }

  async writeFile(
    filePath: string,
    content: string,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<{ validPath: string }> {
    const { signal } = options;
    const validPath = await resolveForWrite(this.pathGuard, filePath);

    const tempSuffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const tempPath = `${validPath}.${tempSuffix}.tmp`;

    // The rename below swaps in the temp file's inode, so the target would
    // inherit fsWriteFile's default 0o666 & ~umask — silently widening a 0600
    // file to 0644 on every write. Carry the existing mode across instead.
    let existingMode: number | undefined;
    try {
      existingMode = (await fsStat(validPath)).mode & 0o777;
    } catch (error) {
      // ENOENT is the normal new-file case: the default mode is correct there.
      // Anything else (EACCES, EIO) means the mode about to be overwritten could
      // not be read, and the write will silently widen the file — say so rather
      // than swallowing it.
      if (!isNotFoundErrno(error)) {
        Logger.warn(
          `atomicWriteFile: cannot read the existing mode of ${validPath}; the write will use the default mode: ${formatUnknownErrorMessage(error)}`,
        );
      }
    }

    try {
      signal?.throwIfAborted();
      // Create the temp file already narrowed to the target's mode: a 0600
      // file's new bytes must never sit at 0644 while the write is in flight.
      // `wx` fails on a name collision instead of overwriting; the chmod below
      // still restores bits the umask masked off at creation.
      await fsWriteFile(tempPath, content, {
        signal,
        flag: 'wx',
        ...(existingMode !== undefined ? { mode: existingMode } : {}),
      });
      if (existingMode !== undefined) {
        await fsChmod(tempPath, existingMode);
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
    const validPath = await resolveForWrite(this.pathGuard, filePath);
    // Non-regular targets must be rejected before the open: 'a' on a FIFO
    // (POSIX) blocks until a reader appears, and fsOpen takes no signal, so
    // the call would hang unabortable and pin its concurrency slot. The
    // overwrite path can't hang — it writes a temp file and renames over.
    // resolveForWrite has already resolved any symlink to its target, so the
    // lstat here doubles as the new-vs-existing probe for the cleanup below.
    let existed = true;
    try {
      assertFileStats(validPath, await fsLstat(validPath));
    } catch (error) {
      if (!isNotFoundErrno(error)) throw error;
      existed = false;
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
    if (existed) {
      // O_NOFOLLOW: refuse to append through a symlink swapped onto the target
      // after resolveForWrite — the exact TOCTOU that let an append write
      // outside the sandbox.
      handle = await fsOpen(validPath, APPEND_NOFOLLOW);
    } else {
      try {
        // O_CREAT|O_EXCL|O_NOFOLLOW: create exclusively and never through a
        // final-component symlink.
        handle = await fsOpen(validPath, APPEND_CREATE_NOFOLLOW);
        created = true;
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
        handle = await fsOpen(validPath, APPEND_NOFOLLOW);
      }
    }
    try {
      signal?.throwIfAborted();
      // A target reached through a swapped ANCESTOR directory passes
      // O_NOFOLLOW (the final component is a real file) but resolves outside the
      // roots; reject before writing, even when this call created the file.
      await this.#assertFdWithinRoots(handle, filePath);
      // Ceiling: an append is not transactional, so an abort landing
      // mid-write can leave a prefix of the content on disk. Unwiring the
      // signal would trade that for a silently-completed write; a client
      // that retries is double-appending either way, so the abortable
      // write stays.
      await handle.writeFile(content, { signal });
    } catch (error) {
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
    return { validPath };
  }

  /**
   * Leading bytes of a file, for MIME sniffing without loading the whole
   * file — an append's result must describe the resulting file (which may be
   * a multi-GB log), not the chunk that was appended.
   */
  async readLeadingSample(filePath: string, size: number): Promise<Buffer> {
    const { validPath } = await this.stat(filePath);
    const handle = await fsOpen(validPath, READ_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async rm(filePath: string, options?: Parameters<typeof fsRm>[1]): Promise<void> {
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    await fsRm(validPath, options);
  }

  async rmdir(filePath: string, options?: Parameters<typeof fsRmdir>[1]): Promise<void> {
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    await fsRmdir(validPath, options);
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
    await fsCp(validSource, validDest, options);
  }

  async readFile(
    filePath: string,
    spec: ReadSpec,
    known?: { validPath: string; stats: Stats },
  ): Promise<ReadFileResult> {
    spec.signal?.throwIfAborted();
    const { validPath, stats } = known ?? (await this.stat(filePath, { signal: spec.signal }));
    return readFileWithStats(filePath, validPath, stats, spec, (handle) =>
      this.#assertFdWithinRoots(handle, filePath),
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
      (handle) => this.#assertFdWithinRoots(handle, filePath),
    );
    return { validPath, content, stats };
  }

  async readRaw(
    filePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ content: Buffer; mimeType: string; isBinary: boolean }> {
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
    // Open with O_NOFOLLOW and read THROUGH the handle (fsReadFile accepts a
    // FileHandle), so a symlink swapped onto the target after validation is
    // refused (ELOOP) rather than followed outside the sandbox; the
    // ancestor-directory swap is caught by the fd containment re-check before
    // any bytes are read. The read still goes through the module-level
    // fsReadFile so its signal/abort-reason handling is unchanged.
    const handle = await fsOpen(validPath, READ_NOFOLLOW);
    try {
      await this.#assertFdWithinRoots(handle, filePath);
      content = await fsReadFile(handle, options);
    } catch (error) {
      // Node wraps even a TimeoutError signal reason in AbortError.
      if (error instanceof Error && error.name === 'AbortError') {
        options?.signal?.throwIfAborted();
      }
      throw error;
    } finally {
      await handle.close();
    }
    const mimeInfo = detectMimeFromContent(validPath, content);
    return {
      content,
      mimeType: mimeInfo.mimeType,
      isBinary: mimeInfo.kind !== 'text',
    };
  }

  async open(filePath: string): Promise<FileHandle> {
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    // O_NOFOLLOW + fd containment re-check: refuse a final-component or
    // ancestor-directory symlink swapped onto the target after validation.
    const handle = await fsOpen(validPath, READ_NOFOLLOW);
    try {
      await this.#assertFdWithinRoots(handle, filePath);
    } catch (error) {
      await handle.close();
      throw error;
    }
    return handle;
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
    const missing = isNotFoundErrno(err) || (isFsError(err) && err.code === ErrorCode.NOT_FOUND);
    if (!missing) {
      Logger.warn(`${label}: dest stat failed unexpectedly for "${path}": ${String(err)}`);
    }
    return false;
  }
}
