import { glob as fsGlob, readFile as fsReadFile, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve } from 'node:path';

import type { Ignore } from 'ignore';
import ignore from 'ignore';

import { processInParallel } from './concurrency.ts';
import { formatUnknownErrorMessage } from './errors.ts';
import { Logger } from './observability.ts';
import type { DirentLike } from './path-utils.ts';
import { isPathInsideDirectory, isWindowsDriveRelativePath, toPosixPath } from './path-utils.ts';
import { MIB } from './util.ts';

/**
 * Brace expansion as fs.glob's vendored minimatch applies it (the
 * `brace-expansion` package), used only to validate a pattern. A sequence
 * (`{1..9}`, `{a..z}`) yields one value per kind of character it produces,
 * since digits and letters are never `.` or `/`; nothing is truncated: past
 * `MAX_EXPANSIONS` the caller gets `undefined` and must refuse the pattern.
 */

/** More distinct alternatives than this and the pattern is not expanded at all. */
const MAX_EXPANSIONS = 4096;
/** Mirrors brace-expansion's bound on `{a},b}` rescans and on nesting depth. */
const MAX_REWRITES = 1000;
const MAX_DEPTH = 1000;

// A `}` brace-expansion has decided is literal. NUL never reaches here: the
// schema rejects it in every pattern.
const ESC_OPEN = '\0OPEN\0';
const ESC_CLOSE = '\0CLOSE\0';

const NUMERIC_SEQUENCE_RE = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/u;
const ALPHA_SEQUENCE_RE = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/u;
const REWRITE_RE = /,(?!,).*\}/u;

class ExpansionLimitError extends Error {}

interface Balanced {
  pre: string;
  body: string;
  post: string;
}

/** The first balanced `{…}` in `str`, as balanced-match finds it. */
function balanced(str: string): Balanced | undefined {
  let ai = str.indexOf('{');
  let bi = str.indexOf('}', ai + 1);
  if (ai < 0 || bi <= 0) return undefined;
  const begs: number[] = [];
  let left = str.length;
  let right = -1;
  let result: [number, number] | undefined;
  let i = ai;
  while (i >= 0 && !result) {
    if (i === ai) {
      begs.push(i);
      ai = str.indexOf('{', i + 1);
    } else if (begs.length === 1) {
      result = [begs.pop() ?? ai, bi];
    } else {
      const beg = begs.pop();
      if (beg !== undefined && beg < left) {
        left = beg;
        right = bi;
      }
      bi = str.indexOf('}', i + 1);
    }
    i = ai < bi && ai >= 0 ? ai : bi;
  }
  if (!result && begs.length && right >= 0) result = [left, right];
  if (!result) return undefined;
  return {
    pre: str.slice(0, result[0]),
    body: str.slice(result[0] + 1, result[1]),
    post: str.slice(result[1] + 1),
  };
}

/** `str.split(',')` that keeps nested brace sets whole: `a,{b,c},d`. */
function parseCommaParts(input: string): string[] {
  const parts: string[] = [];
  let carry = '';
  let str = input;
  for (;;) {
    const m = balanced(str);
    if (!m) {
      const tail = str.split(',');
      tail[0] = carry + (tail[0] ?? '');
      parts.push(...tail);
      return parts;
    }
    const p = m.pre.split(',');
    p[0] = carry + (p[0] ?? '');
    p.push(`${p.pop() ?? ''}{${m.body}}`);
    if (!m.post.length) {
      parts.push(...p);
      return parts;
    }
    carry = p.pop() ?? '';
    parts.push(...p);
    str = m.post;
  }
}

function sequenceValues(body: string, isAlpha: boolean): string[] {
  // Digits (and a leading `-`) can never form `.` or `/`; one stands for all.
  if (!isAlpha) return ['0'];
  const [from = '', to = '', step] = body.split('..');
  const x = from.charCodeAt(0);
  const y = to.charCodeAt(0);
  const incr = Math.max(Math.abs(step === undefined ? 1 : Number.parseInt(step, 10) || 0), 1);
  const values = new Set<string>();
  // At most 58 characters lie between two ASCII letters: cheap to walk. The
  // letters collapse to one; the punctuation between `Z` and `a` stays, since
  // `[` and `]` can build a character class. `\` expands to nothing.
  for (let i = x; y < x ? i >= y : i <= y; i += y < x ? -incr : incr) {
    const c = String.fromCharCode(i);
    values.add(/[a-z]/iu.test(c) ? 'a' : c === '\\' ? '' : c);
  }
  return [...values];
}

function combine(acc: readonly string[], pre: string, values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const a of acc) {
    for (const v of values) {
      out.add(a + pre + v);
      if (out.size > MAX_EXPANSIONS) throw new ExpansionLimitError();
    }
  }
  return [...out];
}

function expand(input: string, depth: number): string[] {
  if (depth > MAX_DEPTH) throw new ExpansionLimitError();
  let str = input;
  let acc = [''];
  let rewrites = 0;
  for (;;) {
    const m = balanced(str);
    if (!m) return combine(acc, str, ['']);

    const { pre, body, post } = m;
    if (pre.endsWith('$')) {
      acc = combine(acc, `${pre}{${body}}`, ['']);
      if (!post.length) return acc;
      str = post;
      continue;
    }

    const isAlpha = ALPHA_SEQUENCE_RE.test(body);
    const isSequence = isAlpha || NUMERIC_SEQUENCE_RE.test(body);
    if (!isSequence && !body.includes(',')) {
      // `{a},b}`: the first `}` is literal and the set closes at the next one.
      if (REWRITE_RE.test(post)) {
        if (++rewrites > MAX_REWRITES) throw new ExpansionLimitError();
        str = `${pre}{${body}${ESC_CLOSE}${post}`;
        continue;
      }
      return combine(acc, `${pre}{${body}}${post}`, ['']);
    }

    let values: string[];
    if (isSequence) {
      values = sequenceValues(body, isAlpha);
    } else {
      const parts = parseCommaParts(body);
      // `x{{a,b}}y` expands to `x{a}y x{b}y`.
      const members =
        parts.length === 1 ? expand(parts[0] ?? '', depth + 1).map((v) => `{${v}}`) : parts;
      if (members.length === 1) {
        values = members;
      } else {
        values = [];
        for (const member of members) {
          values.push(...expand(member, depth + 1));
          if (values.length > MAX_EXPANSIONS) throw new ExpansionLimitError();
        }
      }
    }

    acc = combine(acc, pre, values);
    if (!post.length) return acc;
    str = post;
  }
}

/**
 * Every alternative `pattern` expands to, or `undefined` when there are more
 * than can be checked. Backslashes must already be `/`: fs.glob reads them as
 * separators, never as escapes.
 */
function expandBraces(pattern: string): string[] | undefined {
  // brace-expansion keeps a leading `{}` literal.
  const str = pattern.startsWith('{}') ? `${ESC_OPEN}${ESC_CLOSE}${pattern.slice(2)}` : pattern;
  try {
    return expand(str, 0).map((alt) => alt.replaceAll(ESC_OPEN, '{').replaceAll(ESC_CLOSE, '}'));
  } catch (error) {
    if (error instanceof ExpansionLimitError) return undefined;
    throw error;
  }
}

/** True when `segment` is, or compiles to, the literal name `..` (`..`, `[.][.]`, `.[.]`). */
function isTraversalSegment(segment: string): boolean {
  // Only a literal `.` or a one-character class can stand for a dot, and
  // `..` needs two of them; skip the matcher for every other segment.
  if (segment.split('.').length < 3) return false;
  return segment === '..' || matchesGlob('..', segment);
}

function isUnsafeAlternative(alternative: string): boolean {
  return (
    isAbsolute(alternative) ||
    isWindowsDriveRelativePath(alternative) ||
    alternative.split('/').some(isTraversalSegment)
  );
}

export function isSafeGlobSyntax(pattern: string): boolean {
  if (!pattern || pattern.trim().length === 0) {
    return false;
  }
  // fs.glob reads `\` as a separator and expands braces before it walks, so
  // `..{,x}`, `.{.,}` and `{/etc,x}` reach `..` or an absolute path that the
  // pattern as written never shows. Check every alternative the walk will
  // see. `..` inside a segment (`[...slug]`, `v1..2.md`, `[..]`) is a literal
  // name or a character class, and PathGuard re-checks containment on every
  // resolved entry regardless.
  const alternatives = expandBraces(toPosixPath(pattern));
  if (alternatives === undefined) {
    return false;
  }
  return !alternatives.some(isUnsafeAlternative);
}

/** A .gitignore past this size is not a .gitignore; skip it rather than read it. */
const MAX_GITIGNORE_BYTES = MIB;

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
        // lstat, not stat: a symlinked .gitignore may point at a device, a
        // FIFO or a huge file outside the root. Only a plain, small file is a
        // rule set worth reading.
        const info = await lstat(absPath);
        if (!info.isFile() || info.size > MAX_GITIGNORE_BYTES) return;
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

/**
 * Load `.gitignore` from each ancestor of `root` up to and including `ceiling`,
 * farthest first. A rule set that ignores `root` itself is skipped: the caller
 * named that directory on purpose, and applying the rule would empty the walk.
 */
async function loadAncestorGitignores(
  root: string,
  ceiling: string,
  manager: GitignoreManager,
  signal?: AbortSignal,
): Promise<void> {
  const normalizedCeiling = resolve(ceiling);
  const chain: string[] = [];
  for (let dir = dirname(resolve(root)); ; dir = dirname(dir)) {
    if (!isPathInsideDirectory(normalizedCeiling, dir)) break;
    chain.push(dir);
    if (
      (isPathInsideDirectory(dir, normalizedCeiling) &&
        isPathInsideDirectory(normalizedCeiling, dir)) ||
      dirname(dir) === dir
    ) {
      break;
    }
  }
  for (const dir of chain.reverse()) {
    signal?.throwIfAborted();
    const file = join(dir, '.gitignore');
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > MAX_GITIGNORE_BYTES) continue;
      const matcher = ignore().add(await fsReadFile(file, { encoding: 'utf-8', signal }));
      const prefix = toPosixPath(relative(dir, root));
      if (matcher.test(`${prefix}/`).ignored) continue;
      manager.addAncestorMatcher(prefix, matcher);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // ENOENT is the normal case (no .gitignore at this level); anything else is not worth a warning per walk
    }
  }
}

class GitignoreManager {
  private matchers = new Map<string, Ignore>();
  /** Rules from directories above the walk root, farthest first; `prefix` re-bases a walk-relative path to that directory. */
  private ancestors: { prefix: string; matcher: Ignore }[] = [];

  addMatcher(dir: string, matcher: Ignore): void {
    this.matchers.set(dir, matcher);
  }

  addAncestorMatcher(prefix: string, matcher: Ignore): void {
    this.ancestors.push({ prefix, matcher });
  }

  /** `null` when no `.gitignore` was found, so callers skip the filter entirely. */
  static async load(
    root: string,
    includeHidden: boolean,
    signal?: AbortSignal,
    maxDepth?: number,
    ignoreCeiling?: string,
  ): Promise<GitignoreManager | null> {
    const manager = new GitignoreManager();
    try {
      const gitignorePaths: string[] = [];
      // Search dot-directories (.venv, .terraform, ...) for rules only when the
      // walk includes hidden entries; for any other walk, enumerating every
      // hidden tree would cost more than the walk itself.
      const gitignorePatterns = includeHidden
        ? [...buildHiddenPatterns('**/.gitignore')]
        : ['**/.gitignore'];
      const gitignoreEntries = fsGlob(gitignorePatterns, {
        cwd: root,
        // Skip what the walk itself skips, and stop one level past its depth
        // bound: a .gitignore at depth d only affects entries at depth >= d.
        exclude: (entry: string) => {
          if (signal?.aborted) return true;
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
      if (ignoreCeiling !== undefined) {
        await loadAncestorGitignores(root, ignoreCeiling, manager, signal);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      Logger.warn(
        `Failed to enumerate .gitignore files under ${root}: ${formatUnknownErrorMessage(error)}`,
      );
    }
    return manager.matchers.size === 0 && manager.ancestors.length === 0 ? null : manager;
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

    for (const { prefix, matcher } of this.ancestors) {
      const res = matcher.test(`${prefix}/${pathToCheck}`);
      if (res.ignored) ignored = true;
      if (res.unignored) ignored = false;
    }

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
  /**
   * Topmost directory whose `.gitignore` may apply to this walk — the allowed
   * root containing `cwd`. Ancestors of `cwd` up to and including it are
   * consulted; nothing above it is ever read. Ignored without `skipIgnored`.
   */
  ignoreCeiling?: string;
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

/**
 * The segment matching the dot-prefixed names `segment` would match if fs.glob
 * did not skip them, or `undefined` when there are none. Only a leading `*` or
 * `?` stands for that dot: a literal never does, and a character class or a
 * brace set is left as written rather than parsed.
 */
function dotVariant(segment: string): string | undefined {
  // `*(…)` and `?(…)` are extglobs, not wildcards.
  if (segment[1] === '(') return undefined;
  if (segment.startsWith('*')) return `.${segment}`;
  if (!segment.startsWith('?')) return undefined;
  // `?` is exactly one character, so the dot replaces it, unless what follows
  // could leave just `.` or `..` (`?`, `?.`, `?{.,x}`, `?[.]`): the directory
  // and its parent, not a dot-prefixed entry.
  const rest = segment.slice(1);
  return rest === '' || /^[.[{]/u.test(rest) ? undefined : `.${rest}`;
}

function addFirstDotSegment(patterns: Set<string>, prefix: string, remainder: string): void {
  if (remainder.length === 0) return;
  const segments = remainder.split(SEP);
  const idx = segments.findIndex((seg) => seg !== '**' && seg.length > 0);

  if (idx !== -1) {
    const original = segments[idx];
    const dotted = original ? dotVariant(original) : undefined;
    if (dotted) {
      const newSegments = [...segments];
      newSegments[idx] = dotted;
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
  // anywhere (when the first segment after the globstar can match a dot).
  patterns.add(`${prefix}**/.*/**/${afterGlobstar}`);
  const [firstSegment = '', ...rest] = afterGlobstar.split(SEP);
  const dotted = dotVariant(firstSegment);
  if (dotted) patterns.add(`${prefix}**/${[dotted, ...rest].join(SEP)}`);
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

  // Validation keeps `..` and absolute alternatives out of the pattern; this
  // keeps any gap in it from widening the walk past the root it was given.
  if (!isPathInsideDirectory(cwd, absolutePath)) return;

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
  signal: AbortSignal | undefined,
): WalkFilter | undefined {
  if (!skipIgnored && maxDepth === undefined && signal === undefined) return undefined;

  // fs.glob can hand the predicate a dirent whose parentPath is "." — the walk
  // root, not the process cwd — when it re-visits a directory under `**` whose
  // name also exists in the process cwd. Resolving against `cwd` names the
  // entry the dirent describes; `join` would resolve it against the process.
  const isOutside = (match: GlobDirentLike): boolean =>
    !isPathInsideDirectory(cwd, resolve(cwd, match.parentPath, match.name));
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
      // fs.glob takes no signal and calls this for every entry it visits, so
      // pruning everything is the only way to stop a walk that yields nothing.
      if (signal?.aborted) return true;
      if (isOutside(match)) return true;
      const posixRel = relativeOf(match);
      const isDir = match.isDirectory();
      if (excluded(posixRel, isDir)) return true;
      // Stop descent one level past the depth bound. Pruning a directory *at*
      // the bound would drop it where fs.glob treats it as top-level, so prune
      // its children instead; processDirentMatch drops that extra level.
      if (maxDepth === undefined || !isDir) return false;
      return posixRel.split('/').length - 1 > maxDepth;
    },
    isExcluded: (match) => isOutside(match) || excluded(relativeOf(match), match.isDirectory()),
  };
}

async function* processGlobPattern(
  pattern: string,
  plan: NormalizedGlob,
  seen: Set<string>,
  onlyFiles: boolean,
  filter: WalkFilter | undefined,
  signal: AbortSignal | undefined,
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
      if (signal?.aborted) break;
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
  // A pruned walk ends like a finished one. Say it was cut short, so no caller
  // reads "the walk ended" as "the whole tree was seen".
  signal?.throwIfAborted();
}

export async function* globEntries(options: GlobEntriesOptions): AsyncGenerator<GlobEntry> {
  const gitignoreMatcher = options.skipIgnored
    ? await GitignoreManager.load(
        options.cwd,
        options.includeHidden ?? false,
        options.signal,
        options.maxDepth,
        options.ignoreCeiling,
      )
    : null;

  const plan = normalizeGlobOptions(options);
  const seen = new Set<string>();
  const onlyFiles = options.onlyFiles ?? true;
  const filter = createWalkFilter(
    plan.cwd,
    options.skipIgnored ?? false,
    gitignoreMatcher,
    plan.maxDepth,
    options.signal,
  );

  for (const pattern of plan.patterns) {
    yield* processGlobPattern(pattern, plan, seen, onlyFiles, filter, options.signal);
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
