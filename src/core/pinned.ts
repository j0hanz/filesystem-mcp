import { randomBytes } from 'node:crypto';
import { type BigIntStats, lstatSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join, parse } from 'node:path';
import { isMainThread } from 'node:worker_threads';

import { ErrorCode, FsError, isFsError } from './errors.ts';
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

/** lstat of `validPath` with its directory pinned. */
export function lstatPinned(validPath: string): BigIntStats {
  return inPinnedDirectory(dirname(validPath), () =>
    lstatSync(basename(validPath), { bigint: true }),
  );
}

/**
 * `mkdir -p` of `directory` in one borrowed working directory: enters the deepest existing
 * ancestor, then creates and enters each missing component, checking getcwd after every step.
 */
// Port of createDirectoryInPlace, upstream src/filesystem/pinned-directory.ts @ e1dc4b18dbb948921da37f3d4224a628730b43b0
export function mkdirPinned(directory: string): void {
  const missing: string[] = [];
  let existing = directory;
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
      if (dirname(cwd) !== current || basename(cwd).normalize('NFC') !== name.normalize('NFC')) {
        throw swapped(directory);
      }
      current = cwd;
    }
  });
}

function stagingName(): string {
  return `.mcp-${randomBytes(8).toString('hex')}.moving`;
}

/**
 * Moves `validOld` to `validNew` with each rename anchored to one validated directory. Node has no
 * renameat, so the side not anchored is named by a fresh staging name and the entry's identity is
 * checked after it crosses. On failure the source goes back to its own name and the error is
 * rethrown with its code (EXDEV reaches the caller's cross-device fallback).
 */
// Port of renameIntoDirectory and returnStaged, upstream src/filesystem/pinned-directory.ts @ e1dc4b18dbb948921da37f3d4224a628730b43b0
export function renamePinned(validOld: string, validNew: string): void {
  const sourceDir = dirname(validOld);
  const destDir = dirname(validNew);
  const first = stagingName();
  const second = stagingName();
  const identity = inPinnedDirectory(sourceDir, () => {
    renameSync(basename(validOld), first);
    try {
      const { dev, ino } = lstatSync(first, { bigint: true });
      return { dev, ino };
    } catch (error) {
      renameSync(first, basename(validOld));
      throw error;
    }
  });
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
      if (crossed) {
        inPinnedDirectory(destDir, () => {
          renameSync(second, join(sourceDir, first));
        });
        left = { name: first, directory: sourceDir };
      }
      inPinnedDirectory(sourceDir, () => {
        renameSync(first, basename(validOld));
      });
    } catch {
      const message = `${(error as Error).message}. The entry being moved could not be put back at ${validOld} and was left as ${left.name} in ${left.directory}`;
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
