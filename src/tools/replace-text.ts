import type { ContentBlock } from '@modelcontextprotocol/server';

import { Buffer } from 'node:buffer';

import * as z from 'zod/v4';

import {
  type DiffBudget,
  finishDiff,
  MAX_DIFF_SIZE,
  type Patch,
  patchWithinBudget,
  settle,
} from '../core/diff-budget.ts';
import { ErrorCode, isSkippable, Problem } from '../core/errors.ts';
import {
  skippedLine,
  stoppedEarlyLine,
  truncateProgressPattern,
  zeroMatchHint,
} from '../core/fmt.ts';
import type { GuardedFileSystem } from '../core/fs.ts';
import {
  createReplacementMatcher,
  outputTooLarge,
  type ReplaceLimits,
  type ReplacementMatcher,
} from '../core/matcher.ts';
import type { ResultPaths } from '../core/path.ts';
import type { Rewritten } from '../core/rewrite.ts';
import { rewriteEntry } from '../core/rewrite.ts';
import type { ScanOutcome, StoppedReason } from '../core/scan.ts';
import { resolveScanScope, scan, ScanSkip } from '../core/scan.ts';
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
import {
  DEFAULT_SEARCH_RESULTS,
  getMaxTextFileSize,
  MAX_SEARCH_RESULTS,
  PARALLEL_CONCURRENCY,
  toCrlf,
  usesCrlf,
} from '../core/util.ts';
import { type BatchResult, failureLines, isTotalFailure } from './batch.ts';
import { defineTool, type ToolCtx } from './define.ts';

const SearchAndReplaceInputSchema = z.strictObject({
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
  isRegex: defaultFalseBoolean('Treat searchPattern as a RE2 regex (default: literal text match)'),
  includeHidden: IncludeHidden,
  includeIgnored: IncludeIgnored,
  caseSensitive: z
    .boolean()
    .default(true)
    .describe('Match case exactly (default: true). Pass false to ignore case.'),
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
  maxFiles: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .describe('Maximum number of files to process'),
  maxDepth: MaxDepth,
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

type SearchAndReplaceArgs = z.infer<typeof SearchAndReplaceInputSchema>;

interface ReplaceContext {
  dryRun: boolean;
  replacement: string;
  matcher: ReplacementMatcher;
  signal: AbortSignal | undefined;
  fs: GuardedFileSystem;
  transport: 'stdio' | 'http' | undefined;
  singleFile: boolean;
  maxBytes: number;
  /** Matches still replaceable under an explicit cap; Infinity without one. Walked sequentially, so no lock. */
  remaining: number;
  /** A file had a match left unreplaced because the cap ran out. */
  cut: boolean;
  /** Literal search whose LF text is CRLF-converted for an all-CRLF file. Present only when that changes the text. */
  crlf?: { matcher: ReplacementMatcher; replacement: string };
  /** `dev:ino` of each multi-link file already claimed this run: a later name for it is skipped. */
  linked: Set<string>;
}

type EntryOutcome =
  | ({ kind: 'changed'; path: string; matches: number } & Patch)
  | { kind: 'failed'; path: string; error: unknown };

/** What scan holds until the walk ends: a failure's error never reaches it. */
type ScannedOutcome = Exclude<EntryOutcome, { kind: 'failed' }> & { index: number };

/** `onChanged` receives the rewrite, whose contents the outcome does not carry, and says if its diff was refused. */
async function processEntry(
  entryPath: string,
  ctx: ReplaceContext,
  onChanged: (done: Rewritten<number>) => Patch,
): Promise<EntryOutcome | ScanSkip | undefined> {
  const { dryRun, signal, matcher, replacement } = ctx;
  // Discovery/read failures on a walked file are counted as inaccessible; a
  // failed write is the caller's edit not landing, so it is always reported.
  const write = { started: false };

  try {
    // The Rewrite locks the read→write per file so a concurrent writer is not
    // lost; a dry run never writes and skips the lock.
    const done = await rewriteEntry(
      { fs: ctx.fs, path: entryPath, dryRun, signal, transport: ctx.transport },
      async (bytes, stats) => {
        // Hard links share one inode, so a write through one name is seen by every
        // other name: a second name would transform the same bytes again.
        if (stats.nlink > 1) {
          const id = `${stats.dev}:${stats.ino}`;
          if (ctx.linked.has(id)) return undefined;
          ctx.linked.add(id);
        }
        // Same rule as edit: an all-CRLF file gets its LF literal text converted.
        const eol =
          ctx.crlf && bytes.includes('\r\n') && usesCrlf(bytes.toString('utf-8'))
            ? ctx.crlf
            : undefined;
        if (!(eol?.matcher ?? matcher).testBuffer(bytes)) return undefined;
        const before = bytes.toString('utf-8');
        const limits: ReplaceLimits = {
          maxMatches: ctx.remaining,
          maxBytes: ctx.maxBytes,
          path: entryPath,
        };
        const { content, matchCount, more } = await (eol?.matcher ?? matcher).replace(
          before,
          eol?.replacement ?? replacement,
          signal,
          limits,
        );
        // An exhausted budget leaves matches unreplaced with nothing to replace, so the cut is marked here.
        if (matchCount === 0) {
          if (more) ctx.cut = true;
          return undefined;
        }
        // Multi-byte growth is only visible in UTF-8 bytes; the unit-count bails cannot see it.
        if (Buffer.byteLength(content, 'utf8') > limits.maxBytes) throw outputTooLarge(limits);
        // Spent before the write: a failed write still uses its share, so the cap is never exceeded.
        ctx.remaining -= matchCount;
        if (more) ctx.cut = true;
        // The write is the Rewrite's next step: from here a failure is the
        // caller's edit not landing.
        write.started = true;
        return { content, result: matchCount, write: true, before };
      },
    );
    if (done === undefined) return undefined;
    // Only bytes that decode to UTF-8 losslessly survive the string round trip,
    // so an undecodable file is skipped as a binary one is.
    if (done instanceof ScanSkip) return done;

    // Reached only after the write succeeds (or in dryRun, where there is no
    // write): a failed write must not count the file as changed.
    return { kind: 'changed', path: entryPath, matches: done.result, ...onChanged(done) };
  } catch (error) {
    // A timeout/cancel aborts the whole scan, not just this file: scan reports
    // the run as stoppedReason 'timeout' and counts nothing for it.
    if (signal?.aborted) throw error;
    // Rethrown, scan counts the walked file as inaccessible. A named file's
    // failure is the whole request, so it stays a failure row.
    if (!ctx.singleFile && !write.started && isSkippable(error)) {
      throw error;
    }
    return { kind: 'failed', path: entryPath, error };
  }
}

interface ReplaceSummary {
  /** How changed files, failures and diff headers name a path: relative to the root. */
  paths: ResultPaths;
  totalMatches: number;
  filesChanged: number;
  failedFiles: number;
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
    failures: [],
    changedFiles: [],
    changedFilesTruncated: false,
    diff: '',
    diffTruncated: false,
  };
}

/** Literal text only: a regex and its $-template are taken as written (use \r?\n). Reuses `matcher` when only the replacement changes. */
function createCrlfVariant(
  args: SearchAndReplaceArgs,
  matcher: ReplacementMatcher,
): ReplaceContext['crlf'] {
  if (args.isRegex) return undefined;
  const pattern = toCrlf(args.searchPattern);
  const replacement = toCrlf(args.replacement);
  if (pattern === args.searchPattern && replacement === args.replacement) return undefined;
  return {
    matcher:
      pattern === args.searchPattern
        ? matcher
        : createReplacementMatcher({ ...args, searchPattern: pattern }),
    replacement,
  };
}

function buildSearchAndReplaceStructuredResult(
  summary: ReplaceSummary,
  outcome: ScanOutcome<ScannedOutcome>,
  args: SearchAndReplaceArgs,
  cut: boolean,
): SearchAndReplaceOutput {
  // A cut inside a file stops the run even when the scan itself did not reach its cap.
  const stop = outcome.stoppedReason ?? (cut ? 'maxMatches' : undefined);
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
    ...(outcome.skippedBinary ? { skippedBinary: outcome.skippedBinary } : {}),
    ...(outcome.skippedTooLarge ? { skippedTooLarge: outcome.skippedTooLarge } : {}),
    ...(outcome.skippedInaccessible ? { skippedInaccessible: outcome.skippedInaccessible } : {}),
    // Failures are capped at MAX_FAILURES independently of the changed-file
    // cap, so either cap can leave `results` shorter than `summary.total`.
    ...(summary.changedFilesTruncated || summary.failures.length < summary.failedFiles
      ? { resultsTruncated: true }
      : {}),
    ...((args.dryRun || args.returnDiff) && summary.diff ? { diff: summary.diff } : {}),
    ...(summary.diffTruncated ? { diffTruncated: true } : {}),
    ...(stop ? { stoppedReason: stop } : {}),
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
  let crlf: ReplaceContext['crlf'];
  try {
    crlf = createCrlfVariant(args, matcher);
  } catch (error) {
    matcher.dispose();
    throw error;
  }
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
  // An explicit cap is a strict bound, so its matches are claimed one file at a time, in walk order.
  const explicitCap = args.maxMatches;
  const context: ReplaceContext = {
    dryRun: args.dryRun,
    replacement: args.replacement,
    matcher,
    signal: ctx.signal,
    fs: ctx.fs,
    transport: ctx.transport,
    singleFile: scope.explicitFile !== undefined,
    maxBytes: getMaxTextFileSize(),
    remaining: explicitCap ?? Infinity,
    cut: false,
    ...(crlf ? { crlf } : {}),
    linked: new Set(),
  };
  let outcome: ScanOutcome<ScannedOutcome>;
  try {
    // An explicit single-file target bypasses baseNameMatch/exclude/hidden/
    // gitignore filtering — it is always processed as the one file named.
    outcome = await scan<ScannedOutcome>(
      scope,
      {
        pathGuard: ctx.fs.pathGuard,
        tool: 'replace_text',
        pattern: args.pattern ?? '**/*',
        baseNameMatch: true,
        includeHidden: args.includeHidden,
        includeIgnored: args.includeIgnored,
        onlyFiles: true,
        ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
        concurrency: explicitCap !== undefined ? 1 : REPLACE_CONCURRENCY,
        cap: explicitCap ?? DEFAULT_SEARCH_RESULTS,
        capReason: 'maxMatches',
        weigh: (o) => o.matches,
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
        if (o === undefined || o instanceof ScanSkip) return o;
        if (o.kind !== 'failed') return { ...o, index: entry.index };
        failedFiles++;
        keepFailure(failureRows, { index: entry.index, path: o.path, error: o.error });
        return undefined;
      },
    );
  } finally {
    matcher.dispose();
    if (crlf && crlf.matcher !== matcher) crlf.matcher.dispose();
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
    summary.totalMatches += o.matches;
    summary.filesChanged++;
    recordChangedFile(summary, o.index, o.path, o.matches);
    if (o.diffTruncated) summary.diffTruncated = true;
  }

  if (!args.dryRun && summary.totalMatches > 0) {
    ctx.log(
      'info',
      `${summary.filesChanged} file(s) changed, ${summary.totalMatches} match(es)`,
      'replace_text',
    );
  }

  const structured = buildSearchAndReplaceStructuredResult(summary, outcome, args, context.cut);

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
      (structured.summary.failed > 0 ? ` \u00b7 ${String(structured.summary.failed)} failed` : '');
    // The structured half ships under `_meta`, which clients do not show the
    // model, so the stop state and the diff preview must ride the text.
    const lines = [summaryText];
    const stop = structured.stoppedReason;
    if (stop !== undefined) lines.push(stoppedEarlyLine(stop));
    const skipped = skippedLine(structured);
    if (skipped) lines.push(skipped);
    if (stop !== undefined && !args.dryRun && structured.summary.succeeded > 0) {
      // A live run writes as it scans, so any early stop leaves the files it reached
      // rewritten. The paths ship under `_meta`, which the model does not see; name
      // them here, or a re-run of a self-matching replacement applies it twice.
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
    lines.push(...failureLines(structured.results));
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
