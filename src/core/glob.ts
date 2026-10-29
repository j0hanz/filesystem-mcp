import { glob as fsGlob, readFile as fsReadFile, lstat } from 'node:fs/promises';
import { basename, dirname, join, matchesGlob, relative, resolve, win32 } from 'node:path';

import type { Ignore } from 'ignore';
import ignore from 'ignore';

import { processInParallel } from './concurrency.ts';
import { formatUnknownErrorMessage } from './errors.ts';
import { Logger } from './observability.ts';
import type { DirentLike } from './path-utils.ts';
import {
  IS_CASE_INSENSITIVE_FS,
  IS_WINDOWS,
  isPathInsideDirectory,
  toPosixPath,
} from './path-utils.ts';
import type { PathGuard } from './path.ts';
import { MIB } from './util.ts';

/**
 * More brace alternatives than this is not a file filter. fs.glob's matcher
 * dedupes its alternatives pairwise, synchronously: `{1..100000}` pins the
 * event loop for most of a minute, where 1024 costs tens of milliseconds.
 */
export const MAX_BRACE_ALTERNATIVES = 1024;

/** Bound synchronous glob compilation when checking candidate traversal segments. */
export const MAX_DOTDOT_CHECK_CHARS = 4096;

/**
 * fs.glob tests each name against a regex compiled from the segment,
 * synchronously. Every run of `*` and every extglob group (`?(`, `+(`, `@(`,
 * `!(`, `*(`) adds a degree of backtracking: on a 255-character name three cost
 * under 100 ms, four about 1 s, and five do not finish; a chain of `?(a|aa)`
 * groups grows the same way.
 */
export const MAX_SEGMENT_WILDCARDS = 3;

// The range bodies fs.glob's brace expansion recognises, as it writes them.
const NUMERIC_RANGE_RE = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/u;
const ALPHA_RANGE_RE = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/u;

/** The values a range body (`x..y`, `x..y..step`) expands to, or `undefined` past the cap. */
function rangeValues(body: string): string[] | undefined {
  const alpha = ALPHA_RANGE_RE.test(body);
  const [from = '', to = '', step = '1'] = body.split('..');
  const bound = (end: string): number => (alpha ? end.charCodeAt(0) : Number.parseInt(end, 10));
  const start = bound(from);
  const stop = bound(to);
  const stride = Math.max(Math.abs(Number.parseInt(step, 10)), 1);
  // Past 2^53 a step no longer moves the number (2^53 + 1 === 2^53), and past
  // Number.MAX_VALUE it reads as Infinity: either way the loop below would
  // never end. Refuse them like any other long range.
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stop)) return undefined;
  if (Math.floor(Math.abs(stop - start) / stride) >= MAX_BRACE_ALTERNATIVES) return undefined;
  const values: string[] = [];
  const direction = stop < start ? -1 : 1;
  for (let i = start; (stop - i) * direction >= 0; i += stride * direction) {
    // The engine drops a `\` a letter range passes through (`{Z..a}`), and
    // digits can never spell a root or a `..`, so their padding is moot.
    const char = String.fromCharCode(i);
    values.push(alpha ? (char === '\\' ? '' : char) : String(i));
  }
  return values;
}

interface BraceSet {
  pre: string;
  /** `undefined` when the set alone expands past the cap. */
  alternatives: string[] | undefined;
  post: string;
}

/**
 * The leftmost `{…}` that fs.glob would expand: a comma list or a range.
 * The expansion is textual, as fs.glob's is: a brace inside `[…]` still
 * counts (unlike SensitiveMatcher's own glob dialect in sensitive.ts).
 */
function firstBraceSet(pattern: string): BraceSet | undefined {
  const open: { at: number; commas: number[] }[] = [];
  let first: { at: number; commas: number[]; close: number } | undefined;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '{') open.push({ at: i, commas: [] });
    else if (char === ',') open.at(-1)?.commas.push(i);
    else if (char === '}') {
      const set = open.pop();
      if (!set || (first && first.at < set.at)) continue;
      const body = pattern.slice(set.at + 1, i);
      if (set.commas.length > 0 || NUMERIC_RANGE_RE.test(body) || ALPHA_RANGE_RE.test(body)) {
        first = { ...set, close: i };
      }
    }
  }
  if (!first) return undefined;
  let alternatives: string[] | undefined;
  if (first.commas.length > 0) {
    alternatives = [];
    let start = first.at + 1;
    for (const end of [...first.commas, first.close]) {
      alternatives.push(pattern.slice(start, end));
      start = end + 1;
    }
  } else {
    alternatives = rangeValues(pattern.slice(first.at + 1, first.close));
  }
  return { pre: pattern.slice(0, first.at), alternatives, post: pattern.slice(first.close + 1) };
}

/** Every brace alternative of `pattern`, or `undefined` past the cap. */
function expandBraceSets(pattern: string, out: string[] = []): string[] | undefined {
  const set = firstBraceSet(pattern);
  if (!set) {
    out.push(pattern);
    return out.length > MAX_BRACE_ALTERNATIVES ? undefined : out;
  }
  if (!set.alternatives) return undefined;
  for (const alternative of set.alternatives) {
    if (!expandBraceSets(`${set.pre}${alternative}${set.post}`, out)) return undefined;
  }
  return out;
}

/** The characters minimatch can spell a literal `..` with: dots and one-character classes. */
const DOTDOT_SPELLING_RE = /^[.[\]-]+$/u;

/**
 * Whether the glob engine reads this brace-free segment as `..`. readdir never
 * yields `..`, so only a literal reaches it, and minimatch spells a literal dot
 * as `.`, `[.]` or `[.-.]`. Any other character (`*`, `?`, an extglob, a
 * letter) either makes the segment a pattern the walk never follows to `..`,
 * or puts that character in the name. Only the rest is worth asking the engine
 * about, so a long or exotic segment costs no compile; one the engine cannot
 * compile is refused.
 */
const isTraversalSegment = (segment: string): boolean => {
  try {
    return matchesGlob('..', segment);
  } catch {
    return true;
  }
};

/**
 * An alternative that starts at a root: `/x`, `//host/share`, `C:/x`, `C:x`,
 * on any host. On Windows fs.glob also reads a literal first segment ending in
 * `:` as a drive (`[C]:/x`); elsewhere that is an ordinary name (`logs:`).
 */
const isRooted = (alternative: string): boolean =>
  win32.parse(alternative).root !== '' ||
  (IS_WINDOWS && (alternative.split('/')[0] ?? '').endsWith(':'));

/**
 * Index of the `)` that closes the group opened at `open`, or -1. A `[...]`
 * class is skipped whole: a `)` or `|` inside one is a literal, not syntax.
 */
function groupClose(segment: string, open: number): number {
  let depth = 0;
  for (let i = open; i < segment.length; i++) {
    const c = segment[i];
    if (c === '[') {
      // A `]` first in the class (or after `!`/`^`) is literal, so search past it.
      const first = segment[i + 1] === '!' || segment[i + 1] === '^' ? i + 2 : i + 1;
      const end = segment.indexOf(']', first + 1);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Whether matching this brace-free segment can backtrack for seconds on one
 * long name. Two shapes do: a repeated group (`*(…)`, `+(…)`) whose body can
 * match more than one way (`|`, `*`, or a nested group), and more than
 * MAX_SEGMENT_WILDCARDS `*` runs and extglob groups together.
 */
function canBacktrack(segment: string): boolean {
  if (segment === '**') return false;
  let wildcards = (segment.match(/\*+/gu) ?? []).length;
  for (let i = segment.indexOf('('); i !== -1; i = segment.indexOf('(', i + 1)) {
    const opener = segment[i - 1];
    if (opener === undefined || !'*+?@!'.includes(opener)) continue;
    // Each group can match more than one way, so it adds a degree of
    // backtracking like a `*` run does (`*(` is already counted as one).
    if (opener !== '*') wildcards++;
    if (opener !== '*' && opener !== '+') continue;
    const close = groupClose(segment, i);
    // Classes are literals: only `|`, `*` or a group outside one can backtrack.
    const body = segment
      .slice(i + 1, close === -1 ? undefined : close)
      .replace(/\[[!^]?\]?[^\]]*\]/gu, '');
    if (/[|*(]/u.test(body)) return true;
  }
  return wildcards > MAX_SEGMENT_WILDCARDS;
}

export function isSafeGlobSyntax(pattern: string): boolean {
  if (!pattern || pattern.trim().length === 0) {
    return false;
  }
  // The walk sees the pattern with `\` as `/` (normalizePattern), so check
  // that form: `\etc\x` is `/etc/x` there, an absolute walk on any host.
  // Brace sets can build a root or a `..` from parts (`{/etc,x}`, `..{,x}`,
  // `.{Z..a}.`), so check every alternative, not the pattern as written.
  // globEntries still drops any match outside its cwd: this check is what
  // turns such a pattern into an error rather than a quietly narrower walk.
  const alternatives = expandBraceSets(toPosixPath(pattern));
  if (!alternatives) return false;
  const segments = new Set<string>();
  for (const alternative of alternatives) {
    if (isRooted(alternative)) return false;
    for (const segment of alternative.split('/')) segments.add(segment);
  }
  let dotdotCheckChars = 0;
  for (const segment of segments) {
    if (canBacktrack(segment)) return false;
    if (!segment.includes('.') || !DOTDOT_SPELLING_RE.test(segment)) continue;
    dotdotCheckChars += segment.length;
    if (dotdotCheckChars > MAX_DOTDOT_CHECK_CHARS || isTraversalSegment(segment)) return false;
  }
  return true;
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
  private dirCache = new Map<string, boolean>();

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
          if (name === '.hg' || name === '.svn' || isDefaultExcludedName(name)) return true;
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

      if (this.checkDir(currentDir)) {
        return true;
      }
    }

    // 2. Check the file/directory itself
    return isDirectory ? this.checkDir(normalized) : this.checkPath(normalized, false);
  }

  private checkDir(dir: string): boolean {
    const cached = this.dirCache.get(dir);
    if (cached !== undefined) return cached;
    const res = this.checkPath(dir, true);
    this.dirCache.set(dir, res);
    return res;
  }

  private checkPath(posixPath: string, isDirectory: boolean): boolean {
    // Later rule sets override earlier ones, as nested .gitignore files do.
    let ignored = false;
    const apply = (matcher: Ignore, path: string): void => {
      const res = matcher.test(isDirectory && !path.endsWith('/') ? `${path}/` : path);
      if (res.ignored) ignored = true;
      if (res.unignored) ignored = false;
    };

    for (const { prefix, matcher } of this.ancestors) apply(matcher, `${prefix}/${posixPath}`);

    // Check root level
    const rootMatcher = this.matchers.get('');
    if (rootMatcher) apply(rootMatcher, posixPath);

    // Check subdirectories
    const parts = posixPath.split('/');
    let currentDir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;
      currentDir = currentDir ? `${currentDir}/${part}` : part;
      const matcher = this.matchers.get(currentDir);
      if (matcher) apply(matcher, parts.slice(i + 1).join('/'));
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
  /**
   * Prune directories whose own name the sensitive denylist covers: the walk
   * never descends into them nor yields them. Opt-in — a walk that must see
   * sensitive entries (the move-protection check) does not pass it.
   */
  pathGuard?: Pick<PathGuard, 'isSensitive'>;
  /** Bounds the `.gitignore` discovery `skipIgnored` runs before the walk. */
  signal?: AbortSignal;
  /**
   * Called once with the absolute path of each directory the walk descends into
   * (a directory at the `maxDepth` bound included: it is read, only its children
   * are pruned). Never for `cwd`, nor for a pruned directory. fs.glob turns a
   * failed readdir into an empty list, so this is how a caller learns which
   * directories to probe.
   */
  onDirectory?: (absolutePath: string) => void;
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

/**
 * On a case-insensitive filesystem, turn each ASCII letter outside a `[...]`
 * class into `[xX]`. fs.glob matches literal segments case-sensitively but
 * wildcard segments case-insensitively, and yields on-disk names only for the
 * latter, so a class forces both. A brace range (`{a..c}`) is copied whole:
 * a class inside it would stop it being a range.
 */
export function foldPatternCase(pattern: string): string {
  if (!IS_CASE_INSENSITIVE_FS) return pattern;
  const braceRange = /\{[^{},]*\}/uy;
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? '';
    if (ch === '[') {
      // A `]` first in the class (after `!`/`^`) is literal, as in groupClose.
      let end = i + 1;
      if (pattern[end] === '!' || pattern[end] === '^') end++;
      if (pattern[end] === ']') end++;
      const close = pattern.indexOf(']', end);
      if (close === -1) {
        // Unclosed: a literal `[`, not a class that would fold the rest of the pattern into it.
        out += '[[]';
        continue;
      }
      out += pattern.slice(i, close + 1);
      i = close;
    } else if (ch === '{') {
      braceRange.lastIndex = i;
      const set = braceRange.exec(pattern)?.[0];
      const body = set?.slice(1, -1) ?? '';
      if (set && (NUMERIC_RANGE_RE.test(body) || ALPHA_RANGE_RE.test(body))) {
        out += set;
        i += set.length - 1;
      } else out += ch;
    } else if (/[A-Za-z]/u.test(ch)) {
      out += `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
    } else out += ch;
  }
  return out;
}

function splitPatternPrefix(normalizedPattern: string): {
  prefix: string;
  remainder: string;
} {
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
 * did not skip them, or `undefined` when there are none. Only a leading `*` or `?`
 * stands for that dot: a literal never does, and a character class or a
 * brace set is left as written rather than parsed.
 */
function dotVariant(segment: string): string | undefined {
  // `*(…)`, `?(…)` and `!(…)` are extglobs, not wildcards.
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

function* processDirentMatch(
  match: GlobDirentLike,
  cwd: string,
  maxDepth: number | undefined,
  seen: Set<string>,
  onlyFiles: boolean,
): Generator<GlobEntry> {
  const absolutePath = resolve(cwd, match.parentPath, match.name);
  // The walk's scope is its cwd, whatever the pattern spells: a `..` or a root
  // the validator did not foresee must not reach a caller, where it would be
  // read, rewritten, or counted and named as inaccessible.
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
  pathGuard: Pick<PathGuard, 'isSensitive'> | undefined,
  onDirectory: ((absolutePath: string) => void) | undefined,
): WalkFilter {
  // fs.glob asks once per pattern variant, so a directory is asked about repeatedly.
  const reportedDirs = new Set<string>();
  // fs.glob can hand the predicate a dirent whose parentPath is "." — the walk
  // root, not the process cwd — when it re-visits a directory under `**` whose
  // name also exists in the process cwd. Resolving against `cwd` names the
  // entry the dirent describes; `join` would resolve it against the process.
  const absoluteOf = (match: GlobDirentLike): string => resolve(cwd, match.parentPath, match.name);
  const relativeOf = (match: GlobDirentLike): string =>
    toPosixPath(relative(cwd, absoluteOf(match)));
  // Every default exclude is a bare name that applies at any depth, so a Set
  // lookup per segment replaces compiling dozens of globs per entry.
  const excluded = (posixRel: string, isDir: boolean): boolean =>
    skipIgnored &&
    (posixRel.split('/').some(isDefaultExcludedName) ||
      (gitignoreMatcher?.isIgnored(posixRel, isDir) ?? false));
  // A sensitive directory's subtree is hidden with the directory: pruning
  // stops descent, and the yielded dirent is dropped below. The guard checks
  // the directory's own path, so this never fires on a clean-named entry inside
  // a denylisted tree — the tree never gets walked.
  const sensitiveDir = (match: GlobDirentLike): boolean =>
    pathGuard !== undefined && match.isDirectory() && pathGuard.isSensitive(absoluteOf(match));
  // A sensitive directory anywhere above an entry hides the entry, whatever
  // the pattern spelled: a literal prefix (`vault.key/*.txt`) never asks the
  // descent prune, and a sensitive-named symlink is not isDirectory() so the
  // prune misses it — but every yielded path names its ancestors. The entry's
  // own final name stays with the per-entry guard every caller already runs.
  const sensitiveTreeCache = new Map<string, boolean>();
  const sensitiveTree = (posixRel: string): boolean => {
    if (pathGuard === undefined) return false;
    const segments = posixRel.split('/');
    for (let i = 1; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      let hit = sensitiveTreeCache.get(prefix);
      if (hit === undefined) {
        hit = pathGuard.isSensitive(resolve(cwd, prefix));
        sensitiveTreeCache.set(prefix, hit);
      }
      if (hit) return true;
    }
    return false;
  };

  return {
    prune: (match) => {
      // fs.glob takes no signal and calls this for every entry it visits, so
      // pruning everything is the only way to stop a walk that yields nothing.
      if (signal?.aborted) return true;
      // fs.glob asks before it queues a directory, so a walk that would
      // climb to `../` or start at `/` stops at the edge instead of reading
      // there. Not every climb asks (`**/..` does not): processDirentMatch is
      // the gate, this only saves the walk.
      if (!isPathInsideDirectory(cwd, absoluteOf(match))) return true;
      const posixRel = relativeOf(match);
      const isDir = match.isDirectory();
      if (excluded(posixRel, isDir)) return true;
      if (sensitiveDir(match) || sensitiveTree(posixRel)) return true;
      // Stop descent one level past the depth bound. Pruning a directory *at*
      // the bound would drop it where fs.glob treats it as top-level, so prune
      // its children instead; processDirentMatch drops that extra level.
      const depth = posixRel.split('/').length - 1;
      if (maxDepth !== undefined && isDir && depth > maxDepth) return true;
      // A directory at the bound is listed but not read: none of its contents are wanted.
      if (isDir && onDirectory && (maxDepth === undefined || depth < maxDepth)) {
        const absolute = absoluteOf(match);
        if (!reportedDirs.has(absolute)) {
          reportedDirs.add(absolute);
          onDirectory(absolute);
        }
      }
      return false;
    },
    isExcluded: (match) => {
      const posixRel = relativeOf(match);
      return (
        excluded(posixRel, match.isDirectory()) || sensitiveDir(match) || sensitiveTree(posixRel)
      );
    },
  };
}

export async function* globEntries(options: GlobEntriesOptions): AsyncGenerator<GlobEntry> {
  const { maxDepth, signal, suppressErrors } = options;
  const gitignoreMatcher = options.skipIgnored
    ? await GitignoreManager.load(
        options.cwd,
        options.includeHidden ?? false,
        signal,
        maxDepth,
        options.ignoreCeiling,
      )
    : null;

  const cwd = resolve(options.cwd);
  const pattern = normalizePattern(options.pattern, options.baseNameMatch ?? false);
  // One walk for every variant: fs.glob reads each directory once and matches
  // all of them, where a walk per variant re-read the tree for each.
  const patterns = options.includeHidden ? buildHiddenPatterns(pattern) : [pattern];
  const seen = new Set<string>();
  const onlyFiles = options.onlyFiles ?? true;
  const filter = createWalkFilter(
    cwd,
    options.skipIgnored ?? false,
    gitignoreMatcher,
    maxDepth,
    signal,
    options.pathGuard,
    options.onDirectory,
  );

  const iterable = fsGlob(patterns.map(foldPatternCase), {
    cwd,
    exclude: filter.prune,
    withFileTypes: true,
  }) as AsyncIterable<GlobDirentLike>;

  try {
    for await (const match of iterable) {
      if (signal?.aborted) break;
      // A function `exclude` only prunes descent in fs.glob — it still yields
      // the rejected dirent itself, and any rejected entry below the top level.
      // Re-apply the ignore rules (not the depth bound) to drop those.
      if (filter.isExcluded(match)) continue;
      yield* processDirentMatch(match, cwd, maxDepth, seen, onlyFiles);
    }
  } catch (error) {
    if (!suppressErrors) throw error;
    Logger.warn(
      `globEntries: suppressed mid-walk error for pattern "${patterns.join(', ')}": ${formatUnknownErrorMessage(error)}`,
    );
  }
  // A pruned walk ends like a finished one. Say it was cut short, so no caller
  // reads "the walk ended" as "the whole tree was seen".
  signal?.throwIfAborted();
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

// On a case-insensitive filesystem, fs.glob yields on-disk spellings (`Node_Modules`).
const DEFAULT_EXCLUDED_KEYS: ReadonlySet<string> = new Set(
  [...DEFAULT_EXCLUDED_NAMES].map((name) => (IS_CASE_INSENSITIVE_FS ? name.toLowerCase() : name)),
);

function isDefaultExcludedName(name: string): boolean {
  return DEFAULT_EXCLUDED_KEYS.has(IS_CASE_INSENSITIVE_FS ? name.toLowerCase() : name);
}
