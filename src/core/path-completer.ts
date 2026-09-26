import { opendir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

import { isSkippableErrno, rethrowIfAborted } from './errors.ts';
import { Logger } from './observability.ts';
import {
  isPathWithinDirectories,
  isSamePath,
  isSlash,
  normalizePath,
  toPosixPath,
} from './path-utils.ts';
import type { PathGuard } from './path.ts';
import { resolveRealPath } from './path.ts';

// ─── pure path-completion helpers ───────────────────────────────────────────

function hasTrailingSeparator(value: string): boolean {
  return value.length > 0 && isSlash(value.charCodeAt(value.length - 1));
}

function resolveFromBase(
  base: string,
  rawValue: string,
  trailingSeparator: boolean,
): { searchDir: string; prefix: string } {
  const normalizedValue = normalizePath(resolve(base, rawValue));
  if (trailingSeparator) return { searchDir: normalizedValue, prefix: '' };
  return {
    searchDir: dirname(normalizedValue),
    prefix: basename(normalizedValue),
  };
}

function parseNamedRootInput(value: string): { rootName: string; remainder: string } | undefined {
  const normalizedInput = toPosixPath(value);
  if (!normalizedInput) return undefined;
  const slashIndex = normalizedInput.indexOf('/');
  if (slashIndex === -1) return { rootName: normalizedInput, remainder: '' };
  const rootName = normalizedInput.slice(0, slashIndex);
  if (!rootName) return undefined;
  return { rootName, remainder: normalizedInput.slice(slashIndex + 1) };
}

function findAllowedRootByName(rootName: string, allowed: readonly string[]): string | undefined {
  const normalizedRootName = rootName.toLowerCase();
  return allowed.find((candidate) => basename(candidate).toLowerCase() === normalizedRootName);
}

function resolveNamedRootContext(
  currentValue: string,
  allowed: readonly string[],
): { searchDir: string; prefix: string } | undefined {
  const parsed = parseNamedRootInput(currentValue);
  if (!parsed) return undefined;
  const root = findAllowedRootByName(parsed.rootName, allowed);
  if (!root) return undefined;
  const trailingSeparator = hasTrailingSeparator(currentValue);
  return resolveFromBase(root, parsed.remainder, trailingSeparator);
}

async function isAllowedCompletionDirectory(
  path: string,
  allowed: readonly string[],
): Promise<boolean> {
  if (!isPathWithinDirectories(path, allowed)) return false;
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) return false;
    const real = await resolveRealPath(path);
    return real !== null && isPathWithinDirectories(real, allowed);
  } catch (err) {
    if (!isSkippableErrno(err)) {
      Logger.debug('isAllowedCompletionDirectory: unexpected probe error', {
        path,
        error: String(err),
      });
    }
    return false;
  }
}

function withDirectorySeparator(value: string): string {
  return value.endsWith(sep) ? value : `${value}${sep}`;
}

function collectAllowedRoots(
  allowed: readonly string[],
  predicate: (root: string) => boolean,
): string[] {
  return allowed.filter(predicate).map(withDirectorySeparator);
}

function findRootPrefixMatches(currentValue: string, allowed: readonly string[]): string[] {
  const rootPrefix = parseNamedRootInput(currentValue)?.rootName.toLowerCase() ?? '';
  return collectAllowedRoots(allowed, (root) =>
    basename(root).toLowerCase().startsWith(rootPrefix),
  );
}

function findMatchingRoots(
  searchDir: string,
  prefix: string,
  allowed: readonly string[],
): string[] {
  const lowerPrefix = prefix.toLowerCase();
  const normalizedSearchDir = normalizePath(searchDir);
  return collectAllowedRoots(allowed, (root) => {
    const rootDir = dirname(root);
    if (!isSamePath(rootDir, normalizedSearchDir)) return false;
    return basename(root).toLowerCase().startsWith(lowerPrefix);
  });
}

function mergeCompletionMatches(
  dirMatches: readonly string[],
  rootMatches: readonly string[],
): string[] {
  const isDir = (v: string): boolean => v.endsWith(sep);
  return [...new Set([...dirMatches, ...rootMatches])].sort(
    (left, right) => Number(isDir(right)) - Number(isDir(left)) || left.localeCompare(right),
  );
}

async function findMatchesInDirectory(
  searchDir: string,
  prefix: string,
  allowed: readonly string[],
  isSensitive?: (path: string) => boolean,
): Promise<string[]> {
  const matches: string[] = [];
  if (!(await isAllowedCompletionDirectory(searchDir, allowed))) return matches;
  try {
    // Stream via opendir and collect every match. Do not cap here: the
    // SDK's completion result keeps the first 100 values and reports the
    // full length as `total` / `hasMore`, so the list must reach it whole
    // and already sorted (mergeCompletionMatches). Capping here would
    // keep the opendir-first 100, not the alphabetically-first 100, and
    // hide the true count from the client.
    const dir = await opendir(searchDir);
    try {
      const lowerPrefix = prefix.toLowerCase();
      for await (const entry of dir) {
        if (prefix !== '' && !entry.name.toLowerCase().startsWith(lowerPrefix)) continue;
        const fullPath = join(searchDir, entry.name);
        if (isSensitive?.(fullPath)) continue;
        matches.push(entry.isDirectory() ? `${fullPath}${sep}` : fullPath);
      }
    } finally {
      await dir.close().catch(() => {
        /* dir already closed or opendir never resolved */
      });
    }
  } catch (err) {
    if (!isSkippableErrno(err)) {
      Logger.warn('PathCompleter.findMatchesInDirectory: readdir failed', {
        searchDir,
        error: String(err),
      });
    }
  }
  return matches;
}

function getSearchContext(
  currentValue: string,
  allowed: readonly string[],
): { searchDir: string; prefix: string } | undefined {
  const trailingSeparator = hasTrailingSeparator(currentValue);
  if (isAbsolute(currentValue)) {
    return resolveFromBase(parse(currentValue).root || sep, currentValue, trailingSeparator);
  }
  const namedRootContext = resolveNamedRootContext(currentValue, allowed);
  if (namedRootContext) return namedRootContext;
  if (allowed.length === 1) {
    const base = allowed[0];
    if (base) return resolveFromBase(base, currentValue, trailingSeparator);
  }
  return undefined;
}

/**
 * Path suggestions for `completion/complete` on the file template. One
 * `opendir` per call; clients debounce, so nothing is cached here. Returns
 * every match, sorted; the SDK truncates to 100 and reports the total.
 */
export async function suggestPaths(pathGuard: PathGuard, value: string): Promise<string[]> {
  const allowed = pathGuard.getAllowedDirectories();

  try {
    if (!value) {
      return allowed;
    }

    const context = getSearchContext(value, allowed);
    if (!context) {
      return findRootPrefixMatches(value, allowed);
    }

    const { searchDir, prefix } = context;
    const dirMatches = await findMatchesInDirectory(searchDir, prefix, allowed, (p) =>
      pathGuard.isSensitive(p),
    );
    const rootMatches = findMatchingRoots(searchDir, prefix, allowed);
    return mergeCompletionMatches(dirMatches, rootMatches);
  } catch (error) {
    rethrowIfAborted(error);
    Logger.warn('suggestPaths: completion failed, returning empty list', {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return [];
  }
}
