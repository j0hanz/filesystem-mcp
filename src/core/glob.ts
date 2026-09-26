import { glob as fsGlob, readFile as fsReadFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { Ignore } from 'ignore';
import ignore from 'ignore';

import { processInParallel } from './concurrency.ts';
import { formatUnknownErrorMessage } from './errors.ts';
import { Logger } from './observability.ts';
import type { DirentLike } from './path-utils.ts';
import { isWindowsDriveRelativePath, toPosixPath } from './path-utils.ts';

export function isSafeGlobSyntax(pattern: string): boolean {
  if (!pattern || pattern.trim().length === 0) {
    return false;
  }
  if (isAbsolute(pattern)) {
    return false;
  }
  if (isWindowsDriveRelativePath(pattern)) {
    return false;
  }
  // Covers every engine-specific traversal form too — `{a,..}` and `[..]` both
  // contain '..', so they are rejected here. Keep this check whole-string: the
  // per-form guards that used to follow it were unreachable because of it.
  if (pattern.includes('..')) {
    return false;
  }
  return true;
}

async function loadGitignoreFiles(
  root: string,
  gitignorePaths: readonly string[],
  manager: GitignoreManager,
  signal?: AbortSignal,
): Promise<void> {
  await processInParallel(
    gitignorePaths,
    async (relPath) => {
      const absPath = join(root, relPath);
      try {
        const contents = await fsReadFile(absPath, { encoding: 'utf-8', signal });
        const matcher = ignore();
        matcher.add(contents);
        const dir = toPosixPath(dirname(relPath));
        manager.addMatcher(dir === '.' ? '' : dir, matcher);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        Logger.warn(`Failed to read .gitignore at ${absPath}: ${formatUnknownErrorMessage(error)}`);
      }
    },
    GLOB_BATCH_CONCURRENCY,
    signal,
  );
}

class GitignoreManager {
  private matchers = new Map<string, Ignore>();

  addMatcher(dir: string, matcher: Ignore): void {
    this.matchers.set(dir, matcher);
  }

  /** `null` when no `.gitignore` was found, so callers skip the filter entirely. */
  static async load(
    root: string,
    signal?: AbortSignal,
    maxDepth?: number,
  ): Promise<GitignoreManager | null> {
    const manager = new GitignoreManager();
    try {
      const gitignorePaths: string[] = [];
      const gitignoreEntries = fsGlob('**/.gitignore', {
        cwd: root,
        // Skip what the walk itself skips, and stop one level past its depth
        // bound: a .gitignore at depth d only affects entries at depth >= d.
        exclude: (entry: string) => {
          const name = basename(entry);
          if (name === '.hg' || name === '.svn' || DEFAULT_EXCLUDED_NAMES.has(name)) return true;
          return maxDepth !== undefined && toPosixPath(entry).split('/').length - 1 > maxDepth;
        },
      });
      for await (const match of gitignoreEntries) {
        if (signal?.aborted) break;
        gitignorePaths.push(match);
      }

      await loadGitignoreFiles(root, gitignorePaths, manager, signal);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      Logger.warn(
        `Failed to enumerate .gitignore files under ${root}: ${formatUnknownErrorMessage(error)}`,
      );
    }
    return manager.matchers.size === 0 ? null : manager;
  }

  isIgnored(relativePath: string, isDirectory: boolean): boolean {
    const normalized = toPosixPath(relativePath);
    if (normalized === '' || normalized === '.') return false;
    const parts = normalized.split('/');

    // 1. Check parent directories first
    let currentDir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;
      currentDir = currentDir ? `${currentDir}/${part}` : part;

      if (this.checkPath(currentDir, true)) {
        return true;
      }
    }

    // 2. Check the file/directory itself
    return this.checkPath(normalized, isDirectory);
  }

  private checkPath(posixPath: string, isDirectory: boolean): boolean {
    const parts = posixPath.split('/');
    const pathToCheck = isDirectory
      ? posixPath.endsWith('/')
        ? posixPath
        : `${posixPath}/`
      : posixPath;

    let ignored = false;

    // Check root level
    const rootMatcher = this.matchers.get('');
    if (rootMatcher) {
      const res = rootMatcher.test(pathToCheck);
      if (res.ignored) ignored = true;
      if (res.unignored) ignored = false;
    }

    // Check subdirectories
    let currentDir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;
      currentDir = currentDir ? `${currentDir}/${part}` : part;

      const matcher = this.matchers.get(currentDir);
      if (matcher) {
        const relParts = parts.slice(i + 1);
        const relPath = relParts.join('/');
        const relPathToCheck = isDirectory
          ? relPath.endsWith('/')
            ? relPath
            : `${relPath}/`
          : relPath;

        const res = matcher.test(relPathToCheck);
        if (res.ignored) ignored = true;
        if (res.unignored) ignored = false;
      }
    }

    return ignored;
  }
}

interface GlobDirentLike extends DirentLike {
  name: string;
  parentPath: string;
}

export interface GlobEntry {
  path: string;
  dirent: DirentLike;
}

export interface GlobEntriesOptions {
  cwd: string;
  pattern: string;
  includeHidden?: boolean;
  baseNameMatch?: boolean;
  maxDepth?: number;
  onlyFiles?: boolean;
  suppressErrors?: boolean;
  /** Skip what a walk should not surface: DEFAULT_EXCLUDED_NAMES and .gitignore. */
  skipIgnored?: boolean;
  /** Bounds the `.gitignore` discovery `skipIgnored` runs before the walk. */
  signal?: AbortSignal;
}

interface NormalizedGlob {
  cwd: string;
  patterns: readonly string[];
  suppressErrors: boolean;
  maxDepth?: number;
}

const GLOB_MAGIC_RE = /[*?[\]{}!]/u;
const GLOB_BATCH_CONCURRENCY = 64;
const SEP = '/';
const DOT_CHAR_CODE = 46;
function normalizePattern(pattern: string, baseNameMatch: boolean): string {
  const normalized = toPosixPath(pattern);

  if (!baseNameMatch) return normalized;
  if (normalized.includes(SEP)) return normalized;
  return `**/${normalized}`;
}

function splitPatternPrefix(normalizedPattern: string): {
  prefix: string;
  remainder: string;
} {
  if (!GLOB_MAGIC_RE.test(normalizedPattern)) {
    return { prefix: '', remainder: normalizedPattern };
  }

  const segments = normalizedPattern.split(SEP);
  const splitIndex = segments.findIndex((seg) => GLOB_MAGIC_RE.test(seg));

  if (splitIndex <= 0) {
    return { prefix: '', remainder: normalizedPattern };
  }

  return {
    prefix: segments.slice(0, splitIndex).join(SEP) + SEP,
    remainder: segments.slice(splitIndex).join(SEP),
  };
}

function addFirstDotSegment(patterns: Set<string>, prefix: string, remainder: string): void {
  if (remainder.length === 0) return;
  const segments = remainder.split(SEP);
  const idx = segments.findIndex((seg) => seg !== '**' && seg.length > 0);

  if (idx !== -1) {
    const original = segments[idx];
    if (original && original.charCodeAt(0) !== DOT_CHAR_CODE) {
      const newSegments = [...segments];
      newSegments[idx] = `.${original}`;
      patterns.add(`${prefix}${newSegments.join(SEP)}`);
    }
  }
}

function expandHiddenGlobstars(patterns: Set<string>, prefix: string, remainder: string): void {
  // Trailing bare globstar — `src/**`, `**` (remainder is exactly `**`, no
  // following segment). The pattern itself already matches every non-dot
  // entry under the prefix; add the two hidden complements fs.glob skips:
  // dotfiles/dot-dirs anywhere, and the contents of dot-dirs anywhere.
  if (remainder === '**') {
    patterns.add(`${prefix}**/.*`);
    patterns.add(`${prefix}**/.*/**`);
    return;
  }

  if (!remainder.startsWith('**/')) return;

  const afterGlobstar = remainder.slice(3);
  // Node fs.glob skips leading-dot entries unless the matching segment itself
  // starts with '.', and its `dot` option is not honored. So `**/*` alone misses
  // hidden files. Two depth-agnostic patterns cover everything the per-depth
  // unroll did: contents of dot-directories anywhere, and dotfiles/dotdirs
  // anywhere.
  patterns.add(`${prefix}**/.*/**/${afterGlobstar}`);
  const addDotFile = afterGlobstar.length > 0 && afterGlobstar.charCodeAt(0) !== DOT_CHAR_CODE;
  if (addDotFile) patterns.add(`${prefix}**/.${afterGlobstar}`);
}

function buildHiddenPatterns(normalizedPattern: string): readonly string[] {
  const patterns = new Set<string>([normalizedPattern]);
  const { prefix, remainder } = splitPatternPrefix(normalizedPattern);

  addFirstDotSegment(patterns, prefix, remainder);
  expandHiddenGlobstars(patterns, prefix, remainder);

  return Array.from(patterns);
}

function normalizeGlobOptions(options: GlobEntriesOptions): NormalizedGlob {
  const cwd = resolve(options.cwd);
  const normalizedPattern = normalizePattern(options.pattern, options.baseNameMatch ?? false);

  const patterns = options.includeHidden
    ? buildHiddenPatterns(normalizedPattern)
    : [normalizedPattern];

  const normalized: NormalizedGlob = {
    cwd,
    patterns,
    suppressErrors: options.suppressErrors ?? false,
  };

  if (options.maxDepth !== undefined) {
    normalized.maxDepth = options.maxDepth;
  }

  return normalized;
}

function* processDirentMatch(
  match: GlobDirentLike,
  cwd: string,
  maxDepth: number | undefined,
  seen: Set<string>,
  onlyFiles: boolean,
): Generator<GlobEntry> {
  const absolutePath = resolve(cwd, match.parentPath, match.name);

  if (maxDepth !== undefined) {
    const rel = relative(cwd, absolutePath);
    if (rel.split(/[/\\]/u).length - 1 > maxDepth) return;
  }

  if (seen.has(absolutePath)) return;
  seen.add(absolutePath);

  if (onlyFiles && !match.isFile()) return;
  yield { path: absolutePath, dirent: match };
}

interface WalkFilter {
  /** Given to fs.glob: true stops descent into a directory. */
  prune: (match: GlobDirentLike) => boolean;
  /** Re-applied to yielded entries: the ignore rules only, never the depth bound. */
  isExcluded: (match: GlobDirentLike) => boolean;
}

function createWalkFilter(
  cwd: string,
  skipIgnored: boolean,
  gitignoreMatcher: GitignoreManager | null,
  maxDepth: number | undefined,
): WalkFilter | undefined {
  if (!skipIgnored && maxDepth === undefined) return undefined;

  // fs.glob can hand the predicate a dirent whose parentPath is "." — the walk
  // root, not the process cwd — when it re-visits a directory under `**` whose
  // name also exists in the process cwd. Resolving against `cwd` names the
  // entry the dirent describes; `join` would resolve it against the process.
  const relativeOf = (match: GlobDirentLike): string =>
    toPosixPath(relative(cwd, resolve(cwd, match.parentPath, match.name)));
  // Every default exclude is a bare name that applies at any depth, so a Set
  // lookup per segment replaces compiling dozens of globs per entry.
  const excluded = (posixRel: string, isDir: boolean): boolean =>
    skipIgnored &&
    (posixRel.split('/').some((segment) => DEFAULT_EXCLUDED_NAMES.has(segment)) ||
      (gitignoreMatcher?.isIgnored(posixRel, isDir) ?? false));

  return {
    prune: (match) => {
      const posixRel = relativeOf(match);
      const isDir = match.isDirectory();
      if (excluded(posixRel, isDir)) return true;
      // Stop descent one level past the depth bound. Pruning a directory *at*
      // the bound would drop it where fs.glob treats it as top-level, so prune
      // its children instead; processDirentMatch drops that extra level.
      if (maxDepth === undefined || !isDir) return false;
      return posixRel.split('/').length - 1 > maxDepth;
    },
    isExcluded: (match) => excluded(relativeOf(match), match.isDirectory()),
  };
}

async function* processGlobPattern(
  pattern: string,
  plan: NormalizedGlob,
  seen: Set<string>,
  onlyFiles: boolean,
  filter: WalkFilter | undefined,
): AsyncGenerator<GlobEntry> {
  const { cwd, maxDepth, suppressErrors } = plan;
  let iterable: AsyncIterable<GlobDirentLike>;
  try {
    iterable = fsGlob(pattern, {
      cwd,
      ...(filter ? { exclude: filter.prune } : {}),
      withFileTypes: true,
    }) as AsyncIterable<GlobDirentLike>;
  } catch (error) {
    if (suppressErrors) return;
    throw error;
  }

  try {
    for await (const match of iterable) {
      // A function `exclude` only prunes descent in fs.glob — it still yields
      // the rejected dirent itself, and any rejected entry below the top level.
      // Re-apply the ignore rules (not the depth bound) to drop those.
      if (filter?.isExcluded(match)) continue;
      yield* processDirentMatch(match, cwd, maxDepth, seen, onlyFiles);
    }
  } catch (error) {
    if (!suppressErrors) throw error;
    Logger.warn(
      `globEntries: suppressed mid-walk error for pattern "${pattern}": ${formatUnknownErrorMessage(error)}`,
    );
  }
}

export async function* globEntries(options: GlobEntriesOptions): AsyncGenerator<GlobEntry> {
  const gitignoreMatcher = options.skipIgnored
    ? await GitignoreManager.load(options.cwd, options.signal, options.maxDepth)
    : null;

  const plan = normalizeGlobOptions(options);
  const seen = new Set<string>();
  const onlyFiles = options.onlyFiles ?? true;
  const filter = createWalkFilter(
    plan.cwd,
    options.skipIgnored ?? false,
    gitignoreMatcher,
    plan.maxDepth,
  );

  for (const pattern of plan.patterns) {
    yield* processGlobPattern(pattern, plan, seen, onlyFiles, filter);
  }
}

/** Names a `skipIgnored` walk never enters or yields, at any depth. */
const DEFAULT_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.vscode',
  '.idea',
  '.DS_Store',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.cache',
  '.yarn',
  'jspm_packages',
  'bower_components',
  'out',
  'tmp',
  '.temp',
  'npm-debug.log',
  'yarn-debug.log',
  'yarn-error.log',
  'Thumbs.db',
]);
