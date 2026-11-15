import { type BigIntStats, lstatSync } from 'node:fs';
import { basename, dirname, parse } from 'node:path';
import { isMainThread } from 'node:worker_threads';

import { ErrorCode, FsError } from './errors.ts';
import { IS_WINDOWS } from './path-utils.ts';

const DARWIN_DATA_VOLUME = '/System/Volumes/Data';

function stripDataVolume(path: string): string {
  return path.startsWith(`${DARWIN_DATA_VOLUME}/`) ? path.slice(DARWIN_DATA_VOLUME.length) : path;
}

/** Compares getcwd output with a directory: exact, except macOS may report the Data volume prefix. */
export function isSameDirectory(
  cwd: string,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'darwin') return stripDataVolume(cwd) === stripDataVolume(directory);
  return cwd === directory;
}

/** process.chdir throws in a worker; on Windows the working directory is a string and proves nothing. */
export const CAN_PIN = !IS_WINDOWS && isMainThread;

/**
 * Runs `action` with `directory` as the working directory, after reading getcwd back: the kernel
 * reports the directory actually entered, not the string given (ADR-019). `action` must be
 * synchronous: the working directory is process-wide, so no other request may run while it is
 * borrowed. The previous working directory is restored, or the root when it is gone.
 */
export function inPinnedDirectory<T>(directory: string, action: () => T): T {
  const root = parse(directory).root;
  let saved: string;
  try {
    saved = process.cwd();
  } catch {
    saved = root; // the server's own cwd was deleted
  }
  try {
    process.chdir(directory);
    if (!isSameDirectory(process.cwd(), directory)) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Path changed under validation and now resolves outside the allowed roots (TOCTOU).',
        directory,
      );
    }
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

/** lstat of `validPath` with its directory pinned. */
export function lstatPinned(validPath: string): BigIntStats {
  return inPinnedDirectory(dirname(validPath), () =>
    lstatSync(basename(validPath), { bigint: true }),
  );
}
