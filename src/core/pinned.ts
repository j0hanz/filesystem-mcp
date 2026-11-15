import { randomBytes } from 'node:crypto';
import {
  type BigIntStats,
  close as closeFd,
  fchmod as fchmodFd,
  fchown as fchownFd,
  fsync as fsyncFd,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmdirSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFile as writeFd,
} from 'node:fs';
import {
  chmod as fsChmod,
  lchown as fsLchown,
  lstat as fsLstat,
  mkdir as fsMkdir,
  rename as fsRename,
  rm as fsRm,
  rmdir as fsRmdir,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { isMainThread } from 'node:worker_threads';

import {
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  isFsError,
  isNotFoundErrno,
} from './errors.ts';
import { Logger } from './observability.ts';
import { IS_WINDOWS } from './path-utils.ts';

const DARWIN_DATA_VOLUME = '/System/Volumes/Data';

// Retry transient EPERM/EBUSY/EACCES on Windows when an indexer or antivirus holds the target open.
const WRITE_RENAME_RETRY = { maxRetries: 3, retryDelay: 100 } as const;

/** process.chdir throws in a worker; on Windows the working directory is a string and proves nothing. */
const CAN_PIN = !IS_WINDOWS && isMainThread;

function stripDataVolume(path: string): string {
  return path.startsWith(`${DARWIN_DATA_VOLUME}/`) ? path.slice(DARWIN_DATA_VOLUME.length) : path;
}

/** Compares getcwd output with a directory: exact, except macOS may report the Data volume prefix. */
function isSameDirectory(cwd: string, directory: string): boolean {
  if (process.platform === 'darwin') return stripDataVolume(cwd) === stripDataVolume(directory);
  return cwd === directory;
}

function swapped(directory: string): FsError {
  return new FsError(
    ErrorCode.ACCESS_DENIED,
    'Path changed under validation and now resolves outside the allowed roots (TOCTOU).',
    directory,
  );
}

/**
 * Runs `action` with `directory` as the working directory, after reading getcwd back: the kernel
 * reports the directory actually entered, not the string given (ADR-019). `action` must be
 * synchronous: the working directory is process-wide, so no other request may run while it is
 * borrowed. The previous working directory is restored, or the root when that one is gone.
 */
function inPinnedDirectory<T>(directory: string, action: () => T): T {
  const root = parse(directory).root;
  let saved: string;
  try {
    saved = process.cwd();
  } catch {
    saved = root; // the server's own cwd was deleted
  }
  try {
    process.chdir(directory);
    if (!isSameDirectory(process.cwd(), directory)) throw swapped(directory);
    return action();
  } finally {
    try {
      process.chdir(saved);
    } catch {
      try {
        process.chdir(root);
      } catch {
        // the original error, if any, must win over a failed restore
      }
    }
  }
}

/** lstat of `validPath`, pinned to its directory where supported. */
export async function lstatPinned(validPath: string): Promise<BigIntStats> {
  if (!CAN_PIN) return fsLstat(validPath, { bigint: true });
  return inPinnedDirectory(dirname(validPath), () =>
    lstatSync(basename(validPath), { bigint: true }),
  );
}

/** True when getcwd `cwd` is the component `name` made under `current` (NFC-folded, Data prefix tolerated). */
function isMkdirStep(cwd: string, current: string, name: string): boolean {
  return (
    isSameDirectory(dirname(cwd), current) &&
    basename(cwd).normalize('NFC') === name.normalize('NFC')
  );
}

/**
 * Creates `validPath`; when `recursive` is requested on a pinnable host, `mkdir -p` runs in one
 * borrowed working directory by entering the deepest existing ancestor and creating/checking each
 * missing component via getcwd.
 */
// Port of createDirectoryInPlace, upstream src/filesystem/pinned-directory.ts @ e1dc4b18dbb948921da37f3d4224a628730b43b0
export async function mkdirPinned(
  validPath: string,
  options?: Parameters<typeof fsMkdir>[1],
): Promise<void> {
  if (!(CAN_PIN && typeof options === 'object' && options?.recursive === true)) {
    await fsMkdir(validPath, options);
    return;
  }
  const missing: string[] = [];
  let existing = validPath;
  while (statSync(existing, { throwIfNoEntry: false })?.isDirectory() !== true) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  inPinnedDirectory(existing, () => {
    let current = existing;
    for (const name of missing) {
      let exists: unknown;
      try {
        mkdirSync(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        exists = error;
      }
      try {
        process.chdir(name);
      } catch (error) {
        throw exists ?? error; // a non-directory in the way
      }
      const cwd = process.cwd();
      if (!isMkdirStep(cwd, current, name)) throw swapped(validPath);
      current = cwd;
    }
  });
}

function stagingName(): string {
  return `.mcp-${randomBytes(8).toString('hex')}.moving`;
}

/**
 * True when `dest` is another hard link of `source`'s inode, where POSIX rename does nothing. A
 * respelling (case or Unicode form) is the same entry on a folding filesystem and must still move.
 */
function isSecondLink(
  source: { dev: bigint; ino: bigint },
  dest: { dev: bigint; ino: bigint } | undefined,
  respelling: boolean,
): boolean {
  return !respelling && dest?.dev === source.dev && dest.ino === source.ino;
}

export interface RenamePinnedOptions {
  /** A move onto another spelling of the same entry (case or Unicode form). */
  readonly respelling?: boolean;
  /** Test seam: an injected rename keeps the path-based route so its tests see the call. */
  readonly rawRename?: typeof fsRename;
}

/**
 * Moves `validOld` to `validNew`. On pinnable hosts using the native rename, each step runs
 * anchored to one validated directory via a fresh staging name and inode identity verification; on
 * failure the source goes back to its own name and the error is rethrown with its code (EXDEV
 * reaches the caller's cross-device fallback). Otherwise delegates to `rawRename`.
 */
// Port of renameIntoDirectory and returnStaged, upstream src/filesystem/pinned-directory.ts @ e1dc4b18dbb948921da37f3d4224a628730b43b0
export async function renamePinned(
  validOld: string,
  validNew: string,
  options?: RenamePinnedOptions,
): Promise<void> {
  const rawRename = options?.rawRename ?? fsRename;
  const respelling = options?.respelling ?? false;
  if (!CAN_PIN || rawRename !== fsRename) {
    await rawRename(validOld, validNew);
    return;
  }
  const sourceDir = dirname(validOld);
  const destDir = dirname(validNew);
  const first = stagingName();
  const second = stagingName();
  const identity = inPinnedDirectory(sourceDir, () => {
    const source = lstatSync(basename(validOld), { bigint: true });
    const dest = lstatSync(validNew, { bigint: true, throwIfNoEntry: false });
    if (isSecondLink(source, dest, respelling)) return undefined;
    renameSync(basename(validOld), first);
    try {
      const { dev, ino } = lstatSync(first, { bigint: true });
      return { dev, ino };
    } catch (error) {
      renameSync(first, basename(validOld));
      throw error;
    }
  });
  if (identity === undefined) return;
  let crossed = false as boolean; // set inside the anchored callback
  try {
    inPinnedDirectory(destDir, () => {
      renameSync(join(sourceDir, first), second);
      crossed = true;
      const moved = lstatSync(second, { bigint: true });
      if (moved.dev !== identity.dev || moved.ino !== identity.ino) throw swapped(destDir);
      renameSync(second, basename(validNew));
    });
  } catch (error) {
    let left = crossed
      ? { name: second, directory: destDir }
      : { name: first, directory: sourceDir };
    try {
      // Deviation from upstream: the send-back is anchored at the source directory and checks
      // identity, so a source directory swapped since step 1 cannot receive the entry.
      inPinnedDirectory(sourceDir, () => {
        if (crossed) {
          renameSync(join(destDir, second), first);
          const back = lstatSync(first, { bigint: true });
          if (back.dev !== identity.dev || back.ino !== identity.ino) {
            try {
              renameSync(first, join(destDir, second));
            } catch {
              left = { name: first, directory: sourceDir };
            }
            throw swapped(sourceDir);
          }
          left = { name: first, directory: sourceDir };
        }
        renameSync(first, basename(validOld));
      });
    } catch {
      const message = `${error instanceof Error ? error.message : String(error)}. The entry being moved could not be put back at ${validOld} and was left as ${left.name} in ${left.directory}`;
      throw new FsError(
        isFsError(error) ? error.problem.code : ErrorCode.IO_ERROR,
        message,
        validOld,
        error,
      );
    }
    throw error;
  }
}

/**
 * Removes `validPath`. A non-directory on a pinnable host unlinks anchored to its parent;
 * directories and non-pinnable hosts fall back to `fs.promises.rm`.
 */
export async function rmPinned(
  validPath: string,
  options?: Parameters<typeof fsRm>[1],
): Promise<void> {
  // A directory keeps the path-based rm (ADR-019's stated residual).
  if (CAN_PIN && lstatSync(validPath, { throwIfNoEntry: false })?.isDirectory() === false) {
    inPinnedDirectory(dirname(validPath), () => {
      try {
        unlinkSync(basename(validPath));
      } catch (error) {
        if (!(options?.force === true && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
          throw error;
        }
      }
    });
    return;
  }
  await fsRm(validPath, options);
}

/** Removes an empty directory `validPath`, anchored to its parent where supported. */
export async function rmdirPinned(
  validPath: string,
  options?: Parameters<typeof fsRmdir>[1],
): Promise<void> {
  if (CAN_PIN) {
    inPinnedDirectory(dirname(validPath), () => {
      rmdirSync(basename(validPath));
    });
    return;
  }
  await fsRmdir(validPath, options);
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
 * The anchored temp write (ADR-019): only the open borrows the working directory. The descriptor
 * names the inode, so filling, syncing and narrowing it run async and never block the event loop.
 * A failed temp file is left for the caller's dropTemp.
 */
async function writeTempAnchored(
  validPath: string,
  tempPath: string,
  content: string | Buffer,
  mode: number | undefined,
  existing: Pick<Stats, 'uid' | 'gid'> | undefined,
): Promise<void> {
  // `wx` fails on a name collision instead of overwriting.
  const fd = inPinnedDirectory(dirname(validPath), () =>
    openSync(basename(tempPath), 'wx', mode ?? 0o666),
  );
  try {
    await promisify(writeFd)(fd, content);
    // The rename publishes these bytes, so they must reach the disk first.
    await promisify(fsyncFd)(fd);
    // keepOwner's rule, through the descriptor: best effort, POSIX only.
    if (existing !== undefined && process.getuid !== undefined) {
      try {
        await promisify(fchownFd)(fd, existing.uid, existing.gid);
      } catch (error) {
        Logger.debug(
          `Could not keep the owner of ${tempPath}: ${formatUnknownErrorMessage(error)}`,
        );
      }
    }
    // Restores bits the umask masked off at creation.
    if (mode !== undefined) await promisify(fchmodFd)(fd, mode);
  } finally {
    await promisify(closeFd)(fd);
  }
}

async function dropTemp(
  validPath: string,
  tempPath: string,
  anchored: boolean,
  cause?: unknown,
): Promise<void> {
  try {
    if (anchored) {
      inPinnedDirectory(dirname(validPath), () => {
        unlinkSync(basename(tempPath));
      });
    } else {
      await fsUnlink(tempPath);
    }
  } catch (cleanupError) {
    if (isNotFoundErrno(cleanupError)) return;
    Logger.warn(
      `Failed to clean up temp file ${tempPath}${cause === undefined ? '' : ` after write error (${formatUnknownErrorMessage(cause)})`}: ${formatUnknownErrorMessage(cleanupError)}`,
    );
  }
}

/** Windows refuses a rename over a file another process holds open: retry, then report 'blocked' so the caller writes in place. */
async function renameIntoPlace(
  tempPath: string,
  validPath: string,
  existing: Stats | undefined,
  rawRename: typeof fsRename,
): Promise<'renamed' | 'blocked'> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rawRename(tempPath, validPath);
      return 'renamed';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (!IS_WINDOWS || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      if (attempt >= WRITE_RENAME_RETRY.maxRetries) {
        if (existing?.isFile()) return 'blocked';
        throw error;
      }
      await sleep(WRITE_RENAME_RETRY.retryDelay);
    }
  }
}

export interface WriteStagedOptions {
  readonly mode?: number | undefined;
  readonly existingStats?: Stats | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Test seam: an injected rename keeps the path-based route so its tests see the call. */
  readonly rawRename?: typeof fsRename | undefined;
}

/**
 * Writes `content` to `tempPath`, flushes it with owner and mode applied, and commits it over
 * `validPath`. Uses directory pinning on POSIX main thread unless a custom `rawRename` is injected.
 * Cleans up the temp file on failure or when Windows blocks overwriting an open target (`'blocked'`).
 */
export async function writeStagedPinned(
  validPath: string,
  tempPath: string,
  content: string | Buffer,
  options: WriteStagedOptions = {},
): Promise<'renamed' | 'blocked'> {
  const { mode, existingStats, signal, rawRename = fsRename } = options;
  signal?.throwIfAborted();
  // ADR-019: an injected rename keeps the path-based route, so its tests still see the call.
  const anchored = CAN_PIN && rawRename === fsRename;
  try {
    if (anchored) {
      await writeTempAnchored(validPath, tempPath, content, mode, existingStats);
    } else {
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
    }
    // Last cancellation point. The rename IS the commit: once it starts the
    // target may already be replaced, so it is never raced against the
    // signal — a withAbort race would report a finished write as failed, and
    // a client retry would apply it twice (same reasoning as appendFile).
    signal?.throwIfAborted();
    if (anchored) {
      // Both names sit in one directory, so one anchor covers both sides.
      inPinnedDirectory(dirname(validPath), () => {
        renameSync(basename(tempPath), basename(validPath));
      });
      return 'renamed';
    }
    const outcome = await renameIntoPlace(tempPath, validPath, existingStats, rawRename);
    if (outcome === 'blocked') {
      await dropTemp(validPath, tempPath, false);
    }
    return outcome;
  } catch (error) {
    await dropTemp(validPath, tempPath, anchored, error);
    throw error;
  }
}
