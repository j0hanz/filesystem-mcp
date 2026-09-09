import { opendir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

import { isNodeError, isNotFoundErrno, rethrowIfAborted } from './errors.js';
import { Logger } from './observability.js';
import { isPathWithinDirectories, isSamePath, normalizePath } from './path-utils.js';
import type { PathGuard } from './path.js';
import { resolveRealPath } from './path.js';
import { isSlash, toPosixPath } from './primitives.js';

const MAX_COMPLETION_ITEMS = 100;
const COMPLETION_RATE_LIMIT_MS = 100;
const MAX_COMPLETION_CACHE_KEYS = 128;

interface CacheEntry {
  ms: number;
  result: string[];
}

// ─── pure path-completion helpers (no instance state) ───────────────────────
// Formerly static methods on PathCompleter. They take `allowed` explicitly and
// touch no state, so they read as plain functions rather than a class used as
// a namespace. PathCompleter keeps only the cache and the path guard.

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
    if (!isNotFoundErrno(err) && (!isNodeError(err) || err.code !== 'EACCES')) {
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
  const matches: string[] = [];
  for (const root of allowed) {
    if (predicate(root)) matches.push(withDirectorySeparator(root));
  }
  return matches;
}

function findRootPrefixMatches(currentValue: string, allowed: readonly string[]): string[] {
  const rootPrefix = parseNamedRootInput(currentValue)?.rootName.toLowerCase() ?? '';
  if (!rootPrefix) return collectAllowedRoots(allowed, () => true);
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

function sortCompletionMatches(matches: string[]): void {
  const sepCode = sep.charCodeAt(0);
  matches.sort((left, right) => {
    const leftIsDir = left.charCodeAt(left.length - 1) === sepCode;
    const rightIsDir = right.charCodeAt(right.length - 1) === sepCode;
    if (leftIsDir && !rightIsDir) return -1;
    if (!leftIsDir && rightIsDir) return 1;
    return left.localeCompare(right);
  });
}

function mergeCompletionMatches(...matchGroups: readonly (readonly string[])[]): string[] {
  const uniqueMatches = new Set<string>();
  for (const group of matchGroups) {
    for (const match of group) uniqueMatches.add(match);
  }
  const merged = Array.from(uniqueMatches);
  sortCompletionMatches(merged);
  return merged;
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
    // Stream via opendir and collect every match; the MAX_COMPLETION_ITEMS
    // cap is applied AFTER the alphabetical sort in mergeCompletionMatches
    // (slice at the call site). Capping here would keep the opendir-first
    // 100, not the alphabetically-first 100 — the sort would only reorder
    // an already-arbitrary subset.
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
    if (!isNodeError(err) || (err.code !== 'ENOENT' && err.code !== 'EACCES')) {
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

// ─── PathCompleter: cache + path guard ───────────────────────────────────────

export class PathCompleter {
  private cache = new Map<string, CacheEntry>();
  private readonly pathGuard: PathGuard;

  constructor(pathGuard: PathGuard) {
    this.pathGuard = pathGuard;
  }

  async suggest(value: string): Promise<string[]> {
    const now = Date.now();
    const cacheEntry = this.cache.get(value);

    if (cacheEntry && now - cacheEntry.ms < COMPLETION_RATE_LIMIT_MS) {
      return cacheEntry.result;
    }

    const results = await this.completePath(value);
    this.setCacheValue(value, { ms: now, result: results });
    return results;
  }

  private setCacheValue(key: string, entry: CacheEntry): void {
    // Entries are stale after COMPLETION_RATE_LIMIT_MS anyway, so the cap only
    // has to bound memory — dropping the whole map beats per-key LRU eviction.
    if (this.cache.size >= MAX_COMPLETION_CACHE_KEYS) this.cache.clear();
    this.cache.set(key, entry);
  }

  private async completePath(value: string): Promise<string[]> {
    const allowed = this.pathGuard.getAllowedDirectories();

    try {
      if (!value) {
        return allowed.slice(0, MAX_COMPLETION_ITEMS);
      }

      const context = getSearchContext(value, allowed);
      if (!context) {
        return findRootPrefixMatches(value, allowed).slice(0, MAX_COMPLETION_ITEMS);
      }

      const { searchDir, prefix } = context;
      const dirMatches = await findMatchesInDirectory(
        searchDir,
        prefix,
        allowed,
        this.pathGuard.isSensitive.bind(this.pathGuard),
      );
      const rootMatches = findMatchingRoots(searchDir, prefix, allowed);
      return mergeCompletionMatches(dirMatches, rootMatches).slice(0, MAX_COMPLETION_ITEMS);
    } catch (error) {
      rethrowIfAborted(error);
      Logger.warn('PathCompleter: completion failed, returning empty list', {
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      return [];
    }
  }
}
