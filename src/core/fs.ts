import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
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

import { withAbort } from './concurrency.ts';
import { ErrorCode, formatUnknownErrorMessage, FsError, isFsError, isNodeError } from './errors.ts';
import { detectMimeFromContent } from './mime.ts';
import { Logger } from './observability.ts';
import type { EntryType as FileType } from './path-utils.ts';
import type { PathGuard } from './path.ts';
import type { ReadFileResult, ReadSpec } from './read.ts';
import { assertFileStats, createTooLargeError, readFileWithStats } from './read.ts';
import { getMaxTextFileSize } from './util.ts';

export type { FileType };
export type { Stats };
export type { FileHandle };

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
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  return validPath;
}

async function atomicWriteFile(
  filePath: string,
  content: string,
  pathGuard: PathGuard,
  options: { encoding?: BufferEncoding; signal?: AbortSignal | undefined } = {},
): Promise<{ validPath: string }> {
  const { encoding = 'utf-8', signal } = options;
  const validPath = await resolveForWrite(pathGuard, filePath);

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
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      Logger.warn(
        `atomicWriteFile: cannot read the existing mode of ${validPath}; the write will use the default mode: ${formatUnknownErrorMessage(error)}`,
      );
    }
  }

  try {
    signal?.throwIfAborted();
    await fsWriteFile(tempPath, content, { encoding, signal });
    if (existingMode !== undefined) {
      await fsChmod(tempPath, existingMode);
    }
    await withAbort(fsRename(tempPath, validPath), signal);
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

export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

const CHAR_LF = 10;
const LINE_COUNT_CHUNK_BYTES = 64 * 1024;

/**
 * Line count for a file on disk, counting newline bytes in fixed 64 KiB
 * chunks so an arbitrarily large file (one append's result metadata) costs
 * bounded memory. NOT FileHandle.readLines: it decodes each physical line
 * whole, so a multi-GB single-line log OOMs the server after the append has
 * already landed — a reported failure invites a retry that appends twice.
 * Matches read.ts's countLines semantics: a trailing newline does not open
 * a new line, an unterminated final line counts, an empty file is 0.
 */
export async function countFileLines(filePath: string, signal?: AbortSignal): Promise<number> {
  const handle = await fsOpen(filePath, 'r');
  try {
    let newlines = 0;
    let lastByte = 0;
    let totalBytes = 0;
    const chunk = Buffer.alloc(LINE_COUNT_CHUNK_BYTES);
    for (;;) {
      signal?.throwIfAborted();
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

  async mkdir(
    filePath: string,
    options?: Parameters<typeof fsMkdir>[1],
  ): Promise<{ validPath: string; result: string | undefined }> {
    const validPath = await this.pathGuard.validatePathForWrite(filePath);
    const result = await fsMkdir(validPath, options);
    return { validPath, result };
  }

  async rename(oldPath: string, newPath: string): Promise<{ validOld: string; validNew: string }> {
    // Not validateExistingPath: that resolves through a symlink, so renaming a
    // link would rename its target and leave the link dangling.
    const validOld = await this.pathGuard.validatePathForDelete(oldPath);
    const validNew = await this.pathGuard.validatePathForWrite(newPath);
    await fsRename(validOld, validNew);
    return { validOld, validNew };
  }

  async writeFile(
    filePath: string,
    content: string,
    options: { encoding?: BufferEncoding; signal?: AbortSignal | undefined } = {},
  ): Promise<{ validPath: string }> {
    return atomicWriteFile(filePath, content, this.pathGuard, options);
  }

  /**
   * Append to the existing file (created if missing). Deliberately NOT the
   * atomicWriteFile temp+rename dance: the rename would swap in a fresh inode,
   * and the whole point of appending is to extend the file that's already
   * there — inode and mode survive by construction.
   */
  async appendFile(
    filePath: string,
    content: string,
    options: { encoding?: BufferEncoding; signal?: AbortSignal | undefined } = {},
  ): Promise<{ validPath: string }> {
    const { encoding = 'utf-8', signal } = options;
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
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
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
      handle = await fsOpen(validPath, 'a');
    } else {
      try {
        handle = await fsOpen(validPath, 'ax');
        created = true;
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
        handle = await fsOpen(validPath, 'a');
      }
    }
    try {
      signal?.throwIfAborted();
      // Ceiling: an append is not transactional, so an abort landing
      // mid-write can leave a prefix of the content on disk. Unwiring the
      // signal would trade that for a silently-completed write; a client
      // that retries is double-appending either way, so the abortable
      // write stays.
      await handle.writeFile(content, { encoding, signal });
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
  async readLeadingSample(
    filePath: string,
    size: number,
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<Buffer> {
    const { validPath } = await this.stat(filePath, options);
    const handle = await fsOpen(validPath, 'r');
    try {
      options.signal?.throwIfAborted();
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async rm(filePath: string, options?: Parameters<typeof fsRm>[1]): Promise<{ validPath: string }> {
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    await fsRm(validPath, options);
    return { validPath };
  }

  async rmdir(
    filePath: string,
    options?: Parameters<typeof fsRmdir>[1],
  ): Promise<{ validPath: string }> {
    const validPath = await this.pathGuard.validatePathForDelete(filePath);
    await fsRmdir(validPath, options);
    return { validPath };
  }

  async cp(
    source: string,
    destination: string,
    options?: Parameters<typeof fsCp>[2],
  ): Promise<{ validSource: string; validDest: string }> {
    // As in rename: keep the link itself so callers passing verbatimSymlinks
    // actually copy the link rather than a dereferenced target.
    const validSource = await this.pathGuard.validatePathForDelete(source);
    const validDest = await this.pathGuard.validatePathForWrite(destination);
    await fsCp(validSource, validDest, options);
    return { validSource, validDest };
  }

  async readFile(filePath: string, spec: ReadSpec): Promise<ReadFileResult> {
    spec.signal?.throwIfAborted();
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    const stats = await withAbort(fsStat(validPath), spec.signal);
    return readFileWithStats(filePath, validPath, stats, spec);
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
    const { content } = await readFileWithStats(filePath, validPath, stats, {
      kind: 'full',
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    return { validPath, content, stats };
  }

  async readRaw(
    filePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ content: Buffer; mimeType: string; isBinary: boolean }> {
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    const stats = await withAbort(fsStat(validPath), options?.signal);
    assertFileStats(filePath, stats);
    // Enforce size limit before reading to avoid loading large files into memory.
    // Binary detection is best-effort, but this is a hard limit.
    const maxTextFileSize = getMaxTextFileSize();
    if (stats.size > maxTextFileSize) {
      throw createTooLargeError(stats.size, maxTextFileSize, filePath);
    }
    const content = await withAbort(fsReadFile(validPath), options?.signal);
    const mimeInfo = detectMimeFromContent(validPath, content);
    return {
      content,
      mimeType: mimeInfo.mimeType,
      isBinary: mimeInfo.kind !== 'text',
    };
  }

  async open(filePath: string): Promise<FileHandle> {
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    return fsOpen(validPath, 'r');
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
    const missing =
      (isNodeError(err) && err.code === 'ENOENT') ||
      (isFsError(err) && err.code === ErrorCode.NOT_FOUND);
    if (!missing) {
      Logger.warn(`${label}: dest stat failed unexpectedly for "${path}": ${String(err)}`);
    }
    return false;
  }
}
