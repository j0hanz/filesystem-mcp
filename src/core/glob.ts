import { glob as fsGlob, readFile as fsReadFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';

import type { Ignore } from 'ignore';
import ignore from 'ignore';

import { processInParallel } from './concurrency.js';
import { formatUnknownErrorMessage } from './errors.js';
import { Logger } from './observability.js';
import { isWindowsDriveRelativePath } from './path-utils.js';
import { type DirentLike, toPosixPath } from './primitives.js';
import type { EntryType } from './primitives.js';

export type { EntryType };

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
  if (pattern.includes('..')) {
    return false;
  }
  // Reject glob-engine-specific traversal bypass forms that some engines
  // expand as path separators or parent-directory references.
  if (/\{[^}]*\.\.[^}]*\}/u.test(pattern)) {
    return false;
  }
  if (pattern.includes('[..]')) {
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

  static async load(root: string, signal?: AbortSignal): Promise<GitignoreManager> {
    const manager = new GitignoreManager();
    try {
      const gitignorePaths: string[] = [];
      const gitignoreEntries = fsGlob('**/.gitignore', {
        cwd: root,
        exclude: (entry: string) => {
          const name = basename(entry);
          if (name === 'node_modules' || name === '.git' || name === '.hg' || name === '.svn') {
            return true;
          }
          return false;
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
    return manager;
  }

  size(): number {
    return this.matchers.size;
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

async function loadRootGitignore(
  root: string,
  signal?: AbortSignal,
): Promise<GitignoreManager | null> {
  const manager = await GitignoreManager.load(root, signal);
  if (manager.size() === 0) {
    return null;
  }
  return manager;
}

interface GlobDirentLike extends DirentLike {
  name: string;
  parentPath?: string;
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
  /** Skip what a walk should not surface: DEFAULT_EXCLUDE_PATTERNS and .gitignore. */
  skipIgnored?: boolean;
  /** Bounds the `.gitignore` discovery `skipIgnored` runs before the walk. */
  signal?: AbortSignal;
}

interface NormalizedGlob {
  cwd: string;
  patterns: readonly string[];
  exclude: readonly string[];
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
    exclude: options.skipIgnored ? DEFAULT_EXCLUDE_PATTERNS.map(toPosixPath) : [],
    suppressErrors: options.suppressErrors ?? false,
  };

  if (options.maxDepth !== undefined) {
    normalized.maxDepth = options.maxDepth;
  }

  return normalized;
}

function resolveDirentBase(cwd: string, parentPath: string | undefined): string {
  if (!parentPath) return cwd;
  return isAbsolute(parentPath) ? parentPath : resolve(cwd, parentPath);
}

function* processDirentMatch(
  match: GlobDirentLike,
  cwd: string,
  maxDepth: number | undefined,
  seen: Set<string>,
  onlyFiles: boolean,
): Generator<GlobEntry> {
  const base = resolveDirentBase(cwd, match.parentPath);
  const absolutePath = resolve(base, match.name);

  if (maxDepth !== undefined) {
    const rel = relative(cwd, absolutePath);
    if (rel.split(/[/\\]/u).length - 1 > maxDepth) return;
  }

  if (seen.has(absolutePath)) return;
  seen.add(absolutePath);

  if (onlyFiles && !match.isFile()) return;
  yield { path: absolutePath, dirent: match };
}

function createExcludeFilter(
  cwd: string,
  excludePatterns: readonly string[],
  gitignoreMatcher?: GitignoreManager | null,
): ((match: GlobDirentLike) => boolean) | readonly string[] {
  if (!gitignoreMatcher) {
    return excludePatterns;
  }

  return (match: GlobDirentLike) => {
    const relPath = match.parentPath
      ? relative(cwd, join(match.parentPath, match.name))
      : match.name;

    const posixRel = toPosixPath(relPath);

    // Gitignore check
    const isDir = match.isDirectory();
    if (gitignoreMatcher.isIgnored(posixRel, isDir)) {
      return true;
    }

    // Also check explicit exclude patterns
    if (excludePatterns.length > 0) {
      for (const ex of excludePatterns) {
        if (posix.matchesGlob(posixRel, ex)) return true;
      }
    }

    return false;
  };
}

async function* processGlobPattern(
  pattern: string,
  plan: NormalizedGlob,
  seen: Set<string>,
  onlyFiles: boolean,
  excludeFunc: ((match: GlobDirentLike) => boolean) | readonly string[],
): AsyncGenerator<GlobEntry> {
  const { cwd, maxDepth, suppressErrors } = plan;
  let iterable: AsyncIterable<GlobDirentLike>;
  try {
    iterable = fsGlob(pattern, {
      cwd,
      exclude: excludeFunc,
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
      // An array `exclude` drops both. Re-apply the predicate so the two agree.
      if (typeof excludeFunc === 'function' && excludeFunc(match)) continue;
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
  let gitignoreMatcher: GitignoreManager | null = null;
  if (options.skipIgnored) {
    gitignoreMatcher = await loadRootGitignore(options.cwd, options.signal);
  }

  const plan = normalizeGlobOptions(options);
  const seen = new Set<string>();
  const onlyFiles = options.onlyFiles ?? true;
  const excludeFunc = createExcludeFilter(plan.cwd, plan.exclude, gitignoreMatcher);

  for (const pattern of plan.patterns) {
    yield* processGlobPattern(pattern, plan, seen, onlyFiles, excludeFunc);
  }
}

const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules',
  '**/node_modules/**',
  '**/dist',
  '**/dist/**',
  '**/build',
  '**/build/**',
  '**/coverage',
  '**/coverage/**',
  '**/.git',
  '**/.git/**',
  '**/.vscode',
  '**/.vscode/**',
  '**/.idea',
  '**/.idea/**',
  '**/.DS_Store',
  '**/.next',
  '**/.next/**',
  '**/.nuxt',
  '**/.nuxt/**',
  '**/.output',
  '**/.output/**',
  '**/.svelte-kit',
  '**/.svelte-kit/**',
  '**/.cache',
  '**/.cache/**',
  '**/.yarn',
  '**/.yarn/**',
  '**/jspm_packages',
  '**/jspm_packages/**',
  '**/bower_components',
  '**/bower_components/**',
  '**/out',
  '**/out/**',
  '**/tmp',
  '**/tmp/**',
  '**/.temp',
  '**/.temp/**',
  '**/npm-debug.log',
  '**/yarn-debug.log',
  '**/yarn-error.log',
  '**/Thumbs.db',
];
