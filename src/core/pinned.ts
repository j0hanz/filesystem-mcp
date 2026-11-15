import { type BigIntStats, lstatSync } from 'node:fs';
import { basename, dirname, parse } from 'node:path';

import { ErrorCode, FsError } from './errors.ts';

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

/**
 * lstat of `validPath` with its directory pinned: chdir into it and read getcwd back, since the
 * kernel reports the directory actually entered, not the string given. Fully synchronous: the
 * working directory is process-wide, so no other request may run while it is changed.
 */
export function lstatPinned(validPath: string): BigIntStats {
  const directory = dirname(validPath);
  const root = parse(validPath).root;
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
        validPath,
      );
    }
    return lstatSync(basename(validPath), { bigint: true });
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
