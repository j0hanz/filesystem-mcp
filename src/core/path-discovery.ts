import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';

import { formatUnknownErrorMessage } from './errors.ts';
import { Logger } from './observability.ts';
import { isPathWithinDirectories, isSamePath, normalizePath, splitDirList } from './path-utils.ts';

// Resolve a configured env-var directory list (FS_ALLOWED_DIRS / FS_ROOT_BOUNDARY)
// into normalized, verified directories. Each entry is stat'd; a non-directory
// warns and is dropped, a missing entry warns unless `allowMissing` is set (in
// which case the normalized path is kept). When `resolveReal` is set, a
// directory entry is pushed as its realpath (normalized) instead of the raw
// path — FS_ROOT_BOUNDARY uses this so a symlinked root resolves to its target.
// A CLI override supplies `rawValue`, which beats the environment entirely.
// Both warning messages are templated on `envVar` so operator output is stable.
export async function resolveConfiguredDirs(
  envVar: string,
  opts: { allowMissing?: boolean; resolveReal?: boolean; rawValue?: string } = {},
): Promise<string[]> {
  const raw = splitDirList(opts.rawValue ?? process.env[envVar]);
  const result: string[] = [];
  for (const rawPath of raw) {
    const normalized = normalizePath(rawPath);
    try {
      const s = await stat(normalized);
      if (s.isDirectory()) {
        result.push(opts.resolveReal ? normalizePath(await realpath(normalized)) : normalized);
      } else {
        Logger.emit('warning', `Path configured in ${envVar} is not a directory: ${rawPath}`);
      }
    } catch (error) {
      if (opts.allowMissing) {
        result.push(normalized);
      } else {
        Logger.emit(
          'warning',
          `Path configured in ${envVar} is invalid or does not exist: ${rawPath} (${formatUnknownErrorMessage(error)})`,
        );
      }
    }
  }
  return result;
}

export function isUnsafeCwdPath(normalizedCwd: string): boolean {
  const norm = normalizedCwd.toLowerCase();

  // 1. Filesystem root check
  const root = parse(normalizedCwd).root;
  if (isSamePath(normalizedCwd, root)) {
    return true;
  }

  // 2. Home directory check
  if (isSamePath(normalizedCwd, homedir())) {
    return true;
  }

  // 3. Hard-coded unsafe paths check
  const unsafePaths = new Set(
    [
      '/usr',
      '/etc',
      '/bin',
      '/sbin',
      '/System',
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
    ].map((p) => normalizePath(p).toLowerCase()),
  );

  if (unsafePaths.has(norm)) {
    return true;
  }

  return false;
}

const MAX_PROJECT_ROOT_WALK_DEPTH = 32;

export async function findProjectRoot(startDir: string, ceiling: string[]): Promise<string> {
  const normCeiling = ceiling.map(normalizePath);
  let current = normalizePath(startDir);
  let depth = 0;

  for (;;) {
    if (depth++ >= MAX_PROJECT_ROOT_WALK_DEPTH) {
      break;
    }
    // Check if the current directory contains any markers
    const markers = ['.git', 'package.json', 'pyproject.toml'];
    for (const marker of markers) {
      const markerPath = join(current, marker);
      try {
        const s = await stat(markerPath);
        if (s.isDirectory() || s.isFile()) {
          return current;
        }
      } catch (_error) {
        // Skip and try next marker
      }
    }

    // Move to parent directory
    const parent = normalizePath(dirname(current));

    // Check if we hit the filesystem root
    if (parent === current) {
      break;
    }

    // Check if the parent is still within the ceiling
    if (!isPathWithinDirectories(parent, normCeiling)) {
      break;
    }

    current = parent;
  }

  return normalizePath(startDir);
}
