import {
  glob as fsGlob,
  readdir as fsReaddir,
  readFile as fsReadFile,
  lstat,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import type { Ignore } from 'ignore';
import ignore from 'ignore';

import { processInParallel } from './concurrency.ts';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  isNotFoundErrno,
  rethrowIfAborted,
} from './errors.ts';
import { Logger } from './observability.ts';
import type { DirentLike } from './path-utils.ts';
import {
  IS_CASE_INSENSITIVE_FS,
  isPathInsideDirectory,
  isSamePath,
  normalizeCaseForComparison,
  normalizePath,
  toPosixPath,
} from './path-utils.ts';
import type { PathGuard } from './path.ts';
import { ALPHA_RANGE_RE, NUMERIC_RANGE_RE } from './schema.ts';
import { MIB } from './util.ts';

/** A .gitignore past this size is not a .gitignore; skip it rather than read it. */
const MAX_GITIGNORE_BYTES = MIB;
const GLOB_BATCH_CONCURRENCY = 64;

async function readGitignoreMatcher(
  absPath: string,
  signal?: AbortSignal,
): Promise<Ignore | undefined> {
  try {
    // lstat, not stat: a symlinked .gitignore may point at a device, a
    // FIFO or a huge file outside the root. Only a plain, small file is a
    // rule set worth reading.
    const info = await lstat(absPath);
    if (!info.isFile() || info.size > MAX_GITIGNORE_BYTES) return undefined;
    const contents = await fsReadFile(absPath, { encoding: 'utf-8', signal });
    return ignore().add(contents);
  } catch (error) {
    if (signal?.aborted) throw error;
    rethrowIfAborted(error);
    if (!isNotFoundErrno(error)) {
      Logger.warn(`Failed to read .gitignore at ${absPath}: ${formatUnknownErrorMessage(error)}`);
    }
    return undefined;
  }
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
    if (isSamePath(dir, normalizedCeiling) || dirname(dir) === dir) {
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
      if (signal?.aborted) throw error;
      rethrowIfAborted(error);
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
    pathGuard?: Pick<PathGuard, 'isSensitive'>,
  ): Promise<GitignoreManager | null> {
    const resolvedRoot = resolve(root);
    const manager = new GitignoreManager();
    try {
      if (ignoreCeiling !== undefined) {
        await loadAncestorGitignores(resolvedRoot, ignoreCeiling, manager, signal);
      }
      let frontier: string[] = [''];
      for (let depth = 0; frontier.length > 0; depth++) {
        signal?.throwIfAborted();
        const nextFrontier: string[] = [];
        const canDescend = maxDepth === undefined || depth < maxDepth;
        await processInParallel(
          frontier,
          async (dir) => {
            const absDir = dir === '' ? resolvedRoot : join(resolvedRoot, dir);
            if (!canDescend) {
              const matcher = await readGitignoreMatcher(join(absDir, '.gitignore'), signal);
              if (matcher) manager.addMatcher(dir, matcher);
              return;
            }
            const entries = await fsReaddir(absDir, { withFileTypes: true }).catch(() => undefined);
            if (!entries) return;
            const gitignoreEntry = entries.find(
              (entry) => normalizeCaseForComparison(entry.name) === '.gitignore',
            );
            if (gitignoreEntry) {
              const matcher = await readGitignoreMatcher(join(absDir, gitignoreEntry.name), signal);
              if (matcher) manager.addMatcher(dir, matcher);
            }
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              const name = entry.name;
              if (!includeHidden && name.startsWith('.')) continue;
              if (name === '.hg' || name === '.svn' || isDefaultExcludedName(name)) continue;
              if (pathGuard?.isSensitive(join(absDir, name))) continue;
              const childRel = dir === '' ? name : `${dir}/${name}`;
              if (manager.isIgnored(childRel, true)) continue;
              nextFrontier.push(childRel);
            }
          },
          GLOB_BATCH_CONCURRENCY,
          signal,
        );
        frontier = nextFrontier;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      rethrowIfAborted(error);
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
  pathGuard?: Pick<PathGuard, 'isSensitive' | 'reachesRemoteLink'>;
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
  /**
   * Called once per directory `skipIgnored` pruned by a default name that has no
   * leading dot and that `.gitignore` does not already ignore: the folders a
   * caller would not expect to be skipped. Gets the posix path relative to `cwd`.
   */
  onExcludedDir?: (posixRelativePath: string) => void;
  /**
   * Called once per directory `skipIgnored` pruned for any reason, at or above
   * `maxDepth`, unless a sensitive name hides it. Gets the posix path relative to `cwd`.
   */
  onIgnoredDir?: (posixRelativePath: string) => void;
}

const GLOB_MAGIC_RE = /[*?[\]{}!]/u;
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
      // A class even where case cannot differ: fs.glob descends a directory link
      // only under a literal segment, and that opens a link to a network path
      // with no exclude call first. Doubled, as `[1]` alone collapses to a literal.
      // shortcut: a segment with none of these characters (`日本`) stays literal; class those too if clients can be steered into such patterns.
    } else if (/[0-9_]/u.test(ch)) {
      out += `[${ch}${ch}]`;
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
 * The literal leading directories of `prefix`, spelled as on disk. A segment is
 * its exact entry, else the one entry equal to it under ASCII case folding; with
 * none or several, it stays as written and fs.glob finds nothing there, as on a
 * case-sensitive filesystem. Only names come back; the walk filters its results as before.
 */
async function resolvePrefixOnDisk(prefix: string, cwd: string): Promise<string> {
  let dir = cwd;
  const out: string[] = [];
  for (const segment of prefix.slice(0, -SEP.length).split(SEP)) {
    const names = await fsReaddir(dir).catch((): string[] => []);
    const key = normalizeCaseForComparison(segment);
    const folded = names.filter((name) => normalizeCaseForComparison(name) === key);
    const name = names.includes(segment) || folded.length !== 1 ? segment : (folded[0] ?? segment);
    out.push(name);
    dir = join(dir, name);
  }
  return out.join(SEP) + SEP;
}

/**
 * foldPatternCase for a walk under `cwd`, with the literal leading directories
 * spelled as on disk. fs.glob descends a directory symlink only when its segment
 * is literal, so a folded `alias` would stop the walk at the link.
 */
async function foldPatternInWalk(pattern: string, cwd: string): Promise<string> {
  if (!IS_CASE_INSENSITIVE_FS) return pattern;
  const { prefix, remainder } = splitPatternPrefix(pattern);
  if (prefix === '') return foldPatternCase(pattern);
  return (await resolvePrefixOnDisk(prefix, cwd)) + foldPatternCase(remainder);
}

/**
 * Refuses a pattern whose literal leading folders pass through a link to a
 * network or device path. fs.glob and resolvePrefixOnDisk read those folders
 * with no exclude call first, which connects to the host named by the link.
 */
async function assertLeadingFoldersStayLocal(
  patterns: readonly string[],
  cwd: string,
  pathGuard: Pick<PathGuard, 'reachesRemoteLink'>,
): Promise<void> {
  for (const pattern of patterns) {
    const segments = pattern.split(SEP);
    const magic = segments.findIndex((seg) => GLOB_MAGIC_RE.test(seg));
    const literal = magic === -1 ? segments : segments.slice(0, magic);
    if (
      literal.length > 0 &&
      (await pathGuard.reachesRemoteLink(normalizePath(join(cwd, ...literal))))
    ) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        `Pattern "${pattern}" passes through a link to a network or device path.`,
        pattern,
      );
    }
  }
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

const TRAILING_GLOBSTAR_RE = /^(.+\/)\*\*(?:\/\*)?$/u;

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

  // A globstar ending a longer remainder (`**/hooks/**`, `*/hooks/**/*`) skips
  // the same two complements under its stem.
  const stem = TRAILING_GLOBSTAR_RE.exec(remainder)?.[1];
  if (stem) {
    patterns.add(`${prefix}${stem}**/.*`);
    patterns.add(`${prefix}${stem}**/.*/**`);
  }

  if (!remainder.startsWith('**/')) return;

  const afterGlobstar = remainder.slice(3);
  // Node fs.glob skips leading-dot entries unless the matching segment itself
  // starts with '.', and its `dot` option is not honored. So `**/*` alone misses
  // hidden files. Two depth-agnostic patterns cover everything the per-depth
  // unroll did: contents of dot-directories anywhere, and dotfiles/dotdirs
  // anywhere (when the first segment after the globstar can match a dot).
  patterns.add(`${prefix}**/.*/**/${afterGlobstar}`);
  if (stem?.startsWith('**/')) {
    patterns.add(`${prefix}**/.*/**/${stem.slice(3)}**/.*`);
    patterns.add(`${prefix}**/.*/**/${stem.slice(3)}**/.*/**`);
  }
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
  onExcludedDir: ((posixRelativePath: string) => void) | undefined,
  onIgnoredDir: ((posixRelativePath: string) => void) | undefined,
): WalkFilter {
  // fs.glob asks once per pattern variant, so a directory is asked about repeatedly.
  const reportedDirs = new Set<string>();
  const reportedExcluded = new Set<string>();
  const reportedIgnored = new Set<string>();
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
      if (excluded(posixRel, isDir)) {
        if (
          isDir &&
          onIgnoredDir &&
          !reportedIgnored.has(posixRel) &&
          (maxDepth === undefined || posixRel.split('/').length - 1 <= maxDepth) &&
          !sensitiveDir(match) &&
          !sensitiveTree(posixRel)
        ) {
          reportedIgnored.add(posixRel);
          onIgnoredDir(posixRel);
        }
        if (isDir && onExcludedDir && !reportedExcluded.has(posixRel)) {
          const name = posixRel.slice(posixRel.lastIndexOf('/') + 1);
          if (
            isDefaultExcludedName(name) &&
            !name.startsWith('.') &&
            !sensitiveDir(match) &&
            !sensitiveTree(posixRel) &&
            gitignoreMatcher?.isIgnored(posixRel, true) !== true
          ) {
            reportedExcluded.add(posixRel);
            onExcludedDir(posixRel);
          }
        }
        return true;
      }
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
        options.pathGuard,
      )
    : null;

  const cwd = resolve(options.cwd);
  const pattern = normalizePattern(options.pattern, options.baseNameMatch ?? false);
  // One walk for every variant: fs.glob reads each directory once and matches
  // all of them, where a walk per variant re-read the tree for each.
  const patterns = options.includeHidden ? buildHiddenPatterns(pattern) : [pattern];
  if (options.pathGuard) await assertLeadingFoldersStayLocal(patterns, cwd, options.pathGuard);
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
    options.onExcludedDir,
    options.onIgnoredDir,
  );

  const iterable = fsGlob(await Promise.all(patterns.map((p) => foldPatternInWalk(p, cwd))), {
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
  [...DEFAULT_EXCLUDED_NAMES].map(normalizeCaseForComparison),
);

// ASCII fold only: toLowerCase would equate U+212A (Kelvin) with k, hiding `.svelte-kit` spelled with it.
function isDefaultExcludedName(name: string): boolean {
  return DEFAULT_EXCLUDED_KEYS.has(normalizeCaseForComparison(name));
}
