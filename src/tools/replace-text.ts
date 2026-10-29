import type { ContentBlock } from '@modelcontextprotocol/server';

import { Buffer } from 'node:buffer';

import * as z from 'zod/v4';

import type { StoppedReason } from '../core/concurrency.ts';
import { unifiedPatch } from '../core/diff.ts';
import {
  ErrorCode,
  FsError,
  isFsError,
  isSkippableErrno,
  Problem,
  SKIPPABLE_FS_CODES,
} from '../core/errors.ts';
import { stoppedEarlyLine, truncateProgressPattern, zeroMatchHint } from '../core/fmt.ts';
import type { GuardedFileSystem } from '../core/fs.ts';
import type { ResultPaths } from '../core/path.ts';
import { createTooLargeError, NOT_UTF8_MESSAGE } from '../core/read.ts';
import type { Rewritten } from '../core/rewrite.ts';
import { rewriteEntry } from '../core/rewrite.ts';
import type { ScanOutcome } from '../core/scan.ts';
import { resolveScanScope, scan } from '../core/scan.ts';
import {
  defaultFalseBoolean,
  IncludeHidden,
  IncludeIgnored,
  mapOptionalPath,
  MaxDepth,
  nonBlankString,
  OptionalPath,
  SafeGlobPattern,
} from '../core/schema.ts';
import type { LiteralMatcher, Regex } from '../core/search.ts';
import {
  compileRegex,
  createLiteralMatcher,
  createYielder,
  execMatches,
  foldAsciiCase,
  freeRegex,
  RE2_MAX_INPUT_BYTES,
} from '../core/search.ts';
import {
  DEFAULT_SEARCH_RESULTS,
  escapeRegExp,
  getMaxTextFileSize,
  MAX_SEARCH_RESULTS,
  PARALLEL_CONCURRENCY,
} from '../core/util.ts';
import { type BatchResult, isTotalFailure } from './batch.ts';
import { defineTool, type ToolCtx } from './define.ts';

const SearchAndReplaceInputSchema = z
  .strictObject({
    path: OptionalPath.describe(
      'File to rewrite, or directory to rewrite under. Omitting it targets the ENTIRE first allowed root — ' +
        'scope it deliberately, and pair a wide scope with dryRun=true first',
    ),
    pattern: SafeGlobPattern.optional().describe(
      'Glob to restrict replacements to specific file types (e.g. **/*.ts); default: all text files',
    ),
    searchPattern: nonBlankString('searchPattern')
      .max(10000)
      .describe(
        'Exact literal text or RE2 regex pattern to search for. When isRegex=true, uses RE2 syntax (no lookahead, lookbehind, or backreferences are supported). Cannot be empty or whitespace-only.',
      ),
    replacement: z
      .string()
      .max(10000)
      .describe(
        'Replacement text. Use capture group references ($1, $2, etc.) when isRegex=true. Use an empty string to delete all matches.',
      )
      .meta({ examples: ['$1_renamed', '', 'TODO: fix'] }),
    isRegex: defaultFalseBoolean(
      'Treat searchPattern as a RE2 regex (default: literal text match)',
    ),
    includeHidden: IncludeHidden,
    includeIgnored: IncludeIgnored,
    caseSensitive: defaultFalseBoolean(
      'Enable case-sensitive matching (default: case-insensitive)',
    ),
    wholeWord: defaultFalseBoolean('Match whole words only (word boundary anchoring)'),
    dryRun: defaultFalseBoolean(
      'Preview replacements without writing to disk (default: false = apply changes)',
    ),
    returnDiff: defaultFalseBoolean('Include a unified diff of all changes in the response'),
    maxMatches: z
      .uint32()
      .min(1)
      .max(MAX_SEARCH_RESULTS)
      .optional()
      .describe(
        `Maximum total match count across all files before stopping (default: ${String(DEFAULT_SEARCH_RESULTS)})`,
      ),
    // shortcut: maxResults alias ships one release; then drop together the field
    // + superRefine, the `?? args.maxResults` fallback, and BUDGET_CHARS 20_750 in tools.test.ts.
    maxResults: z
      .uint32()
      .min(1)
      .max(MAX_SEARCH_RESULTS)
      .optional()
      .describe('Deprecated alias of maxMatches; removed in the next release')
      .meta({ deprecated: true }),
    maxFiles: z
      .uint32()
      .min(1)
      .max(MAX_SEARCH_RESULTS)
      .optional()
      .describe('Maximum number of files to process'),
    maxDepth: MaxDepth,
  })
  .superRefine((value, ctx) => {
    if (value.maxMatches !== undefined && value.maxResults !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxResults'],
        message: "Cannot use both 'maxMatches' and 'maxResults'",
      });
    }
  });

type SearchAndReplaceOutput = BatchResult<{ matches: number }> & {
  /** The root `results[].path` is relative to; a path that would not read back from it is absolute. */
  root: string;
  totalMatches: number;
  filesScanned: number;
  skippedBinary?: number;
  skippedTooLarge?: number;
  skippedInaccessible?: number;
  resultsTruncated?: boolean;
  diff?: string;
  diffTruncated?: boolean;
  stoppedReason?: StoppedReason;
};

const MAX_FAILURES = 20;
const REPLACE_CONCURRENCY = Math.min(PARALLEL_CONCURRENCY, 8);
const MAX_CHANGED_FILES = 100;
const MAX_DIFF_SIZE = 20 * 1024; // 20KB limit for diff output

interface Failure {
  index: number;
  path: string;
  error: Problem;
}

interface FailureRow {
  index: number;
  path: string;
  error: unknown;
}

/** Keeps the MAX_FAILURES failures first in walk order, sorted by index. */
function keepFailure(rows: FailureRow[], row: FailureRow): void {
  rows.push(row);
  rows.sort((a, b) => a.index - b.index);
  if (rows.length > MAX_FAILURES) rows.pop();
}

function recordChangedFile(
  summary: ReplaceSummary,
  index: number,
  filePath: string,
  matches: number,
): void {
  const relativePath = summary.paths.show(filePath);
  if (summary.changedFiles.length < MAX_CHANGED_FILES) {
    summary.changedFiles.push({ index, path: relativePath, matches });
    return;
  }
  summary.changedFilesTruncated = true;
}

interface ReplacementMatcher {
  /** Yields periodically and throws on abort: a partial splice must never be written. */
  replace(
    content: string,
    replacement: string,
    signal: AbortSignal | undefined,
  ): Promise<{ content: string; matchCount: number }>;
  testBuffer(buffer: Buffer): boolean;
  /** Releases any compiled pattern this matcher owns. Idempotent. */
  dispose(): void;
}

const DOLLAR_TOKEN = /\$(\$|&|`|'|<([^>]*)>|\d{1,2})/g;

/**
 * Expand `$`-substitutions in a replacement template the way `RegExp` does.
 *
 * We cannot hand the template to RE2's own string replacer: it throws
 * `Invalid replacement string` on any `$` not followed by a substitution it
 * recognises (so a replacement of `$100` or a trailing `$` fails outright,
 * where `RegExp` inserts the `$` literally), and it renders an out-of-range
 * `$5` as `$4`. The matcher splices matches itself, so this is the single owner
 * of the syntax.
 */
function expandDollarTokens(
  template: string,
  match: string,
  groups: (string | undefined)[],
  offset: number,
  input: string,
  named: Record<string, string> | undefined,
): string {
  return template.replace(DOLLAR_TOKEN, (token: string, kind: string, name?: string) => {
    if (kind === '$') return '$';
    if (kind === '&') return match;
    if (kind === '`') return input.slice(0, offset);
    if (kind === "'") return input.slice(offset + match.length);
    if (name !== undefined) {
      if (named && Object.hasOwn(named, name)) return named[name] ?? '';
      return token;
    }
    // `$12` prefers group 12, then falls back to group 1 followed by a literal
    // `2`, and stays literal when neither exists — RegExp's own precedence.
    const two = Number.parseInt(kind, 10);
    if (kind.length === 2 && two >= 1 && two <= groups.length) return groups[two - 1] ?? '';
    const one = Number.parseInt(kind.slice(0, 1), 10);
    if (one >= 1 && one <= groups.length) {
      return (groups[one - 1] ?? '') + (kind.length === 2 ? kind.slice(1) : '');
    }
    return token;
  });
}

function createRegexReplacementMatcher(
  regex: Regex,
  expandReplacement: boolean,
): ReplacementMatcher {
  return {
    testBuffer(buffer: Buffer): boolean {
      if (buffer.length > RE2_MAX_INPUT_BYTES) {
        throw new FsError(
          ErrorCode.TOO_LARGE,
          `File too large for a regex replace (${String(buffer.length)} > ${String(RE2_MAX_INPUT_BYTES)} bytes). Regex mode is used for isRegex, wholeWord, or a case-insensitive search for non-ASCII text (or a file holding U+212A or U+017F); pass caseSensitive: true with a literal searchPattern, or split the file.`,
        );
      }
      // The regex is global and shared across every file in the batch, so a
      // previous file's match would otherwise start this scan mid-string.
      regex.lastIndex = 0;
      return regex.test(buffer.toString('utf-8'));
    },
    async replace(content, replacement, signal) {
      // Splicing by hand rather than through `String.replace(regex, …)`: RE2's
      // own replacer indexes the JS string with the code-point offsets it
      // reports, which lands the replacement short by one per astral character
      // (most emoji) earlier in the file. execMatches reports UTF-16 offsets.
      let matchCount = 0;
      let updated = '';
      let cursor = 0;
      const tick = createYielder(signal);
      for (const match of execMatches(regex, content)) {
        matchCount++;
        // Only isRegex=true opts into $1/$& substitution. A literal search
        // reaches this matcher too (wholeWord, or a case-insensitive needle
        // RE2 must judge), and there the replacement must be inserted verbatim.
        updated +=
          content.slice(cursor, match.start) +
          (expandReplacement
            ? expandDollarTokens(
                replacement,
                match.text,
                match.groups,
                match.start,
                content,
                match.named,
              )
            : replacement);
        cursor = match.end;
        if (await tick()) signal?.throwIfAborted();
      }
      return { content: updated + content.slice(cursor), matchCount };
    },
    dispose(): void {
      freeRegex(regex);
    },
  };
}

/** An ASCII needle matched case-insensitively in native code, as RE2 would match it; `fallback` judges the files RE2 must. */
function createCaseInsensitiveLiteralMatcher(
  searchPattern: string,
  literal: LiteralMatcher,
  fallback: ReplacementMatcher,
): ReplacementMatcher {
  const lower = searchPattern.toLowerCase();
  return {
    testBuffer(buffer) {
      return literal.needsRe2(buffer) ? fallback.testBuffer(buffer) : literal.mayMatch(buffer);
    },
    // One native O(n) pass, like the case-sensitive matcher; nothing to yield for.
    replace(content, replacement, signal) {
      if (literal.needsRe2(content)) return fallback.replace(content, replacement, signal);
      // foldAsciiCase keeps every UTF-16 offset, so a hit in `folded` splices `content`.
      const folded = foldAsciiCase(content);
      let matchCount = 0;
      let updated = '';
      let cursor = 0;
      for (let at = folded.indexOf(lower); at !== -1; at = folded.indexOf(lower, cursor)) {
        updated += content.slice(cursor, at) + replacement;
        cursor = at + lower.length;
        matchCount++;
      }
      return Promise.resolve({ content: updated + content.slice(cursor), matchCount });
    },
    dispose(): void {
      fallback.dispose();
    },
  };
}

function createCaseSensitiveLiteralMatcher(searchPattern: string): ReplacementMatcher {
  const searchBuffer = Buffer.from(searchPattern, 'utf8');

  return {
    testBuffer(buffer: Buffer): boolean {
      return buffer.indexOf(searchBuffer) !== -1;
    },
    // One native O(n) pass; nothing to yield for.
    replace(content, replacement) {
      let matchCount = 0;
      const updated = content.replaceAll(searchPattern, () => {
        matchCount++;
        return replacement;
      });
      return Promise.resolve({ content: updated, matchCount });
    },
    dispose(): void {
      // no compiled pattern to release
    },
  };
}

type SearchAndReplaceArgs = z.infer<typeof SearchAndReplaceInputSchema>;

interface ReplaceContext {
  dryRun: boolean;
  replacement: string;
  matcher: ReplacementMatcher;
  signal: AbortSignal | undefined;
  fs: GuardedFileSystem;
  transport: 'stdio' | 'http' | undefined;
  singleFile: boolean;
}

/** Whether a file's patch was refused up front; the patch text itself lives in the DiffBudget. */
interface Patch {
  diffTruncated?: true;
}

type EntryOutcome =
  | ({ kind: 'changed'; path: string; matches: number } & Patch)
  | { kind: 'binary' }
  | { kind: 'tooLarge' }
  | { kind: 'failed'; path: string; error: unknown };

/** What scan holds until the walk ends: a failure's error never reaches it. */
type ScannedOutcome = Exclude<EntryOutcome, { kind: 'failed' }> & { index: number };

/** `onChanged` receives the rewrite, whose contents the outcome does not carry, and says if its diff was refused. */
async function processEntry(
  entryPath: string,
  ctx: ReplaceContext,
  onChanged: (done: Rewritten<number>) => Patch,
): Promise<EntryOutcome | undefined> {
  const { dryRun, signal, matcher, replacement } = ctx;
  // Discovery/read failures on a walked file are counted as inaccessible; a
  // failed write is the caller's edit not landing, so it is always reported.
  const write = { started: false };

  try {
    // The Rewrite locks the read→write per file so a concurrent writer is not
    // lost; a dry run never writes and skips the lock.
    const done = await rewriteEntry(
      { fs: ctx.fs, path: entryPath, dryRun, signal, transport: ctx.transport },
      async (bytes) => {
        if (!matcher.testBuffer(bytes)) return undefined;
        const before = bytes.toString('utf-8');
        const { content, matchCount } = await matcher.replace(before, replacement, signal);
        if (matchCount === 0) return undefined;
        // The write is the Rewrite's next step: from here a failure is the
        // caller's edit not landing.
        write.started = true;
        return { content, result: matchCount, write: true, before };
      },
    );
    if (done === undefined) return undefined;
    if (done.kind !== 'text') {
      // A named file is the whole request: refuse it, don't skip it.
      if (ctx.singleFile) {
        throw done.kind === 'tooLarge'
          ? createTooLargeError(done.size, getMaxTextFileSize(), entryPath)
          : new FsError(ErrorCode.INVALID_INPUT, NOT_UTF8_MESSAGE, entryPath);
      }
      // Only bytes that decode to UTF-8 losslessly survive the string round
      // trip, so an undecodable file is skipped as a binary one is.
      return done.kind === 'tooLarge' ? { kind: 'tooLarge' } : { kind: 'binary' };
    }

    // Reached only after the write succeeds (or in dryRun, where there is no
    // write): a failed write must not count the file as changed.
    return { kind: 'changed', path: entryPath, matches: done.result, ...onChanged(done) };
  } catch (error) {
    // A timeout/cancel aborts the whole scan, not just this file: scan reports
    // the run as stoppedReason 'timeout' and counts nothing for it.
    if (signal?.aborted) throw error;
    // Rethrown, scan counts the walked file as inaccessible. A named file's
    // failure is the whole request, so it stays a failure row.
    if (
      !ctx.singleFile &&
      !write.started &&
      ((isFsError(error) && SKIPPABLE_FS_CODES.has(error.code)) || isSkippableErrno(error))
    ) {
      throw error;
    }
    return { kind: 'failed', path: entryPath, error };
  }
}

/** Kept patches by walk index at or above the prefix, and which walk indices are done. */
interface DiffBudget {
  stored: Map<number, string>;
  settled: Set<number>;
  /** Every walk index below this one is settled. */
  prefix: number;
  /** What the first-fit pass keeps of the patches below the prefix: the diff so far. */
  folded: string;
  /** A patch below the prefix did not fit. */
  truncated: boolean;
}

/** Folds one patch into `folded` by first-fit, in walk order. */
function fold(budget: DiffBudget, index: number): void {
  const patch = budget.stored.get(index);
  if (patch === undefined) return;
  if (budget.folded.length + patch.length <= MAX_DIFF_SIZE) budget.folded += patch;
  else budget.truncated = true;
  budget.stored.delete(index);
}

/** Folds each patch the prefix passes into `folded`, in walk order. */
function settle(budget: DiffBudget, index: number): void {
  budget.settled.add(index);
  while (budget.settled.delete(budget.prefix)) {
    fold(budget, budget.prefix);
    budget.prefix++;
  }
}

/** Folds what is still stored once the scan returns, in walk order. */
function finishDiff(budget: DiffBudget): void {
  for (const index of [...budget.stored.keys()].sort((a, b) => a - b)) fold(budget, index);
}

/**
 * Diffs one file as it finishes, so no file's contents outlive it. A patch is
 * refused only when the first-fit fold would drop it in any order.
 */
function patchWithinBudget(
  budget: DiffBudget,
  index: number,
  header: string,
  done: Rewritten<number>,
): Patch {
  // First-fit over the settled walk-order prefix is final, and later patches
  // only add to what the final pass uses before this index. A lower patch
  // still running may displace a kept one, so the unsettled ones do not count.
  const remaining = MAX_DIFF_SIZE - budget.folded.length;
  // Budget first: a full budget must not pay for a diff it will discard, and a
  // diff past its deadline counts as truncated output, not a failed file.
  if (remaining === 0) return { diffTruncated: true };
  const patch = unifiedPatch(header, done.before, done.after);
  if (patch === undefined || patch.length > remaining) return { diffTruncated: true };
  budget.stored.set(index, patch);
  return {};
}

interface ReplaceSummary {
  /** How changed files, failures and diff headers name a path: relative to the root. */
  paths: ResultPaths;
  totalMatches: number;
  filesChanged: number;
  failedFiles: number;
  skippedBinary: number;
  skippedTooLarge: number;
  failures: Failure[];
  changedFiles: { index: number; path: string; matches: number }[];
  changedFilesTruncated: boolean;
  diff: string;
  diffTruncated: boolean;
}

function createReplaceSummary(paths: ResultPaths): ReplaceSummary {
  return {
    paths,
    totalMatches: 0,
    filesChanged: 0,
    failedFiles: 0,
    skippedBinary: 0,
    skippedTooLarge: 0,
    failures: [],
    changedFiles: [],
    changedFilesTruncated: false,
    diff: '',
    diffTruncated: false,
  };
}

function buildSearchPattern(args: SearchAndReplaceArgs): string {
  if (args.isRegex) {
    return args.wholeWord ? `\\b(?:${args.searchPattern})\\b` : args.searchPattern;
  }
  const escaped = escapeRegExp(args.searchPattern);
  return args.wholeWord ? `\\b(?:${escaped})\\b` : escaped;
}

function createReplacementMatcher(args: SearchAndReplaceArgs): ReplacementMatcher {
  if (!args.isRegex && !args.wholeWord && args.caseSensitive) {
    return createCaseSensitiveLiteralMatcher(args.searchPattern);
  }
  const regex = compileRegex(buildSearchPattern(args), { caseSensitive: args.caseSensitive });
  const matcher = createRegexReplacementMatcher(regex, args.isRegex);
  // A case-insensitive literal is matched natively unless RE2 must judge the needle.
  const literal =
    args.isRegex || args.wholeWord ? undefined : createLiteralMatcher(args.searchPattern, false);
  return literal
    ? createCaseInsensitiveLiteralMatcher(args.searchPattern, literal, matcher)
    : matcher;
}

function buildSearchAndReplaceStructuredResult(
  summary: ReplaceSummary,
  outcome: ScanOutcome<ScannedOutcome>,
  args: SearchAndReplaceArgs,
): SearchAndReplaceOutput {
  const results = [
    ...summary.changedFiles.map((f) => ({
      index: f.index,
      result: { path: f.path, value: { matches: f.matches } },
    })),
    ...summary.failures.map((f) => ({
      index: f.index,
      result: { path: f.path, error: f.error },
    })),
  ]
    .sort((a, b) => a.index - b.index)
    .map(({ result }) => result);
  return {
    root: summary.paths.root,
    results,
    // `failedFiles` counts every failure; `failures` itself is capped at
    // MAX_FAILURES, so the summary must not be derived from the array length.
    summary: {
      total: summary.filesChanged + summary.failedFiles,
      succeeded: summary.filesChanged,
      failed: summary.failedFiles,
    },
    totalMatches: summary.totalMatches,
    filesScanned: outcome.scanned,
    ...(summary.skippedBinary ? { skippedBinary: summary.skippedBinary } : {}),
    ...(summary.skippedTooLarge ? { skippedTooLarge: summary.skippedTooLarge } : {}),
    ...(outcome.skippedInaccessible ? { skippedInaccessible: outcome.skippedInaccessible } : {}),
    // Failures are capped at MAX_FAILURES independently of the changed-file
    // cap, so either cap can leave `results` shorter than `summary.total`.
    ...(summary.changedFilesTruncated || summary.failures.length < summary.failedFiles
      ? { resultsTruncated: true }
      : {}),
    ...((args.dryRun || args.returnDiff) && summary.diff ? { diff: summary.diff } : {}),
    ...(summary.diffTruncated ? { diffTruncated: true } : {}),
    // The scan names its cap `maxResults`; replace_text's argument is `maxMatches`.
    ...(outcome.stoppedReason
      ? {
          stoppedReason:
            outcome.stoppedReason === 'maxResults' ? 'maxMatches' : outcome.stoppedReason,
        }
      : {}),
  };
}

async function handleSearchAndReplace(
  args: SearchAndReplaceArgs,
  ctx: ToolCtx,
): Promise<{
  structured: SearchAndReplaceOutput;
  link?: ContentBlock;
}> {
  // No signal: a deadline that already fired still yields a timeout result.
  const scope = await resolveScanScope(args.path, ctx.fs, { allowFile: true });

  // The matcher may own a compiled RE2 pattern, whose wasm memory re2-wasm
  // never reclaims on its own. Nothing past the scan touches it, so free it the
  // moment the scan is done — success, failure, or abort alike.
  const matcher = createReplacementMatcher(args);
  // The first changed file in walk order is the one the resource_link points
  // at; keep its report so the link needs no read-back.
  let primary: { index: number; report: Rewritten<number>['report'] } | undefined;
  // Relative to the root, not to the walked directory: `a.ts` from a run over
  // `src` would name `<root>/a.ts` when passed back.
  const paths = ctx.fs.pathGuard.resultPaths(scope.root);
  const includeDiff = args.dryRun || args.returnDiff;
  const budget: DiffBudget = {
    stored: new Map(),
    settled: new Set(),
    prefix: 0,
    folded: '',
    truncated: false,
  };
  // Failures stay here, not in scan's results: only MAX_FAILURES rows are ever held.
  const failureRows: FailureRow[] = [];
  let failedFiles = 0;
  let outcome: ScanOutcome<ScannedOutcome>;
  try {
    const context: ReplaceContext = {
      dryRun: args.dryRun,
      replacement: args.replacement,
      matcher,
      signal: ctx.signal,
      fs: ctx.fs,
      transport: ctx.transport,
      singleFile: scope.explicitFile !== undefined,
    };

    // An explicit single-file target bypasses baseNameMatch/exclude/hidden/
    // gitignore filtering — it is always processed as the one file named.
    outcome = await scan<ScannedOutcome>(
      scope,
      {
        pathGuard: ctx.fs.pathGuard,
        pattern: args.pattern ?? '**/*',
        baseNameMatch: true,
        includeHidden: args.includeHidden,
        includeIgnored: args.includeIgnored,
        onlyFiles: true,
        ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
        concurrency: REPLACE_CONCURRENCY,
        cap: args.maxMatches ?? args.maxResults ?? DEFAULT_SEARCH_RESULTS,
        weigh: (o) => (o.kind === 'changed' ? o.matches : 0),
        ...(args.maxFiles !== undefined ? { maxEntries: args.maxFiles } : {}),
        // Bounds the patches held above an unsettled prefix.
        ...(includeDiff ? { window: 2 * REPLACE_CONCURRENCY } : {}),
        signal: ctx.signal,
        onScanned: (n) => {
          ctx.onProgress({ current: n });
        },
        onSettled: (index) => {
          settle(budget, index);
        },
      },
      async (entry) => {
        const o = await processEntry(entry.path, context, (done) => {
          if (primary === undefined || entry.index < primary.index) {
            primary = { index: entry.index, report: done.report };
          }
          return includeDiff
            ? patchWithinBudget(budget, entry.index, paths.show(entry.path), done)
            : {};
        });
        if (o === undefined) return undefined;
        if (o.kind !== 'failed') return { ...o, index: entry.index };
        failedFiles++;
        keepFailure(failureRows, { index: entry.index, path: o.path, error: o.error });
        return undefined;
      },
    );
  } finally {
    matcher.dispose();
  }
  ctx.onProgress({ current: outcome.scanned });

  finishDiff(budget);
  const summary = createReplaceSummary(paths);
  summary.diff = budget.folded;
  summary.diffTruncated = budget.truncated;
  summary.failedFiles = failedFiles;
  summary.failures = failureRows.map((f) => ({
    index: f.index,
    path: paths.show(f.path),
    error: Problem.fromUnknown(f.error, ErrorCode.UNKNOWN, f.path),
  }));
  for (const o of outcome.results) {
    switch (o.kind) {
      case 'binary':
        summary.skippedBinary++;
        break;
      case 'tooLarge':
        summary.skippedTooLarge++;
        break;
      case 'changed':
        summary.totalMatches += o.matches;
        summary.filesChanged++;
        recordChangedFile(summary, o.index, o.path, o.matches);
        if (o.diffTruncated) summary.diffTruncated = true;
        break;
    }
  }

  if (!args.dryRun && summary.totalMatches > 0) {
    ctx.log(
      'info',
      `${summary.filesChanged} file(s) changed, ${summary.totalMatches} match(es)`,
      'replace_text',
    );
  }

  const structured = buildSearchAndReplaceStructuredResult(summary, outcome, args);

  // Each written file was stat'd right after its write, inside its lock.
  const link = primary?.report().resourceLink;
  return link ? { structured, link } : { structured };
}

export const REPLACE_TEXT = defineTool<typeof SearchAndReplaceInputSchema, SearchAndReplaceOutput>({
  name: 'replace_text',
  title: 'Search and Replace',
  description:
    'Find and replace every occurrence of literal text or an RE2 regex, like sed -i, in one file or all files ' +
    'under a directory, optionally filtered by glob. The pattern runs over the whole file: it can span lines, ' +
    'and ^ and $ anchor to file start and end. edit replaces one unique exact match.',
  input: SearchAndReplaceInputSchema,
  readOnlyHint: false,
  deadline: true,
  progress: (args) => {
    const dryLabel = args.dryRun ? ' [dry run]' : '';
    return {
      label: `Replace${dryLabel}`,
      subject: `${truncateProgressPattern(args.searchPattern)} → ${truncateProgressPattern(args.replacement)}`,
    };
  },
  mapPaths: mapOptionalPath,
  run: async (args, ctx) => {
    const truncatedPattern = truncateProgressPattern(args.searchPattern);
    const { structured, link } = await handleSearchAndReplace(args, ctx);
    const dryLabel = args.dryRun ? ' [dry run]' : '';
    const summaryText =
      `replace_text: '${truncatedPattern}'${dryLabel}` +
      ` \u00b7 ${String(structured.totalMatches)} match(es)` +
      ` in ${String(structured.summary.succeeded)} file(s)` +
      (structured.summary.failed > 0 ? ` \u00b7 ${String(structured.summary.failed)} failed` : '') +
      (structured.skippedBinary
        ? ` \u00b7 ${String(structured.skippedBinary)} binary skipped`
        : '') +
      (structured.skippedTooLarge
        ? ` \u00b7 ${String(structured.skippedTooLarge)} too large skipped`
        : '') +
      (structured.skippedInaccessible
        ? ` \u00b7 ${String(structured.skippedInaccessible)} inaccessible skipped`
        : '');
    // The structured half ships under `_meta`, which clients do not show the
    // model, so the stop state and the diff preview must ride the text.
    const lines = [summaryText];
    const stop = structured.stoppedReason;
    if (stop === 'timeout') {
      lines.push(stoppedEarlyLine(stop));
      // A live run writes as it scans, so a timeout leaves the files it reached
      // rewritten. The paths ship under `_meta`, which the model does not see; name
      // them here, or a re-run of a self-matching replacement applies it twice.
      if (!args.dryRun && structured.summary.succeeded > 0) {
        const total = structured.summary.succeeded;
        const shown = structured.results
          .filter((x) => !('error' in x))
          .slice(0, 5)
          .map((x) => x.path)
          .join(', ');
        const more = total > 5 ? `, and ${String(total - 5)} more` : '';
        lines.push(
          `// ${String(total)} file(s) were already rewritten and stay changed: ${shown}${more}. ` +
            'Re-running the same replacement applies it to them again; exclude them, or use dryRun first.',
        );
      }
    } else if (stop !== undefined) {
      // maxMatches/maxFiles here are the caller's own caps, so raising one is
      // what reaches the rest; the search engine's advice to narrow is not.
      lines.push(
        `// scan stopped early: hit the ${stop} limit; later files were not scanned. A higher ${stop} reaches them.`,
      );
    }
    const hint =
      structured.totalMatches === 0
        ? zeroMatchHint({
            ...args,
            filesScanned: structured.filesScanned,
            // A failed, unreadable, or binary file the needle did hit explains
            // the zero better than a guess about the pattern.
            incomplete:
              stop !== undefined ||
              structured.summary.failed > 0 ||
              Boolean(structured.skippedBinary) ||
              Boolean(structured.skippedTooLarge) ||
              Boolean(structured.skippedInaccessible),
          })
        : undefined;
    if (hint) lines.push(hint);
    // A failure's reason lives in `results`, which ships under `_meta`. The
    // full relative path, not the basename: the error message may not carry
    // the path, and two same-named files in different directories must not
    // render as the same row.
    for (const r of structured.results.filter((x) => 'error' in x).slice(0, 3)) {
      lines.push(`// ${r.path}: ${r.error.code} ${r.error.message}`);
    }
    if (structured.diffTruncated) {
      lines.push(
        `// diff cut at ${String(MAX_DIFF_SIZE / 1024)} KB: some files' changes are not shown.`,
      );
    }
    const text = lines.join('\n') + (structured.diff ? `\n\n${structured.diff}` : '');
    return {
      structured,
      text,
      resources: link ? [link] : [],
      isError: isTotalFailure(structured.summary),
    };
  },
});
