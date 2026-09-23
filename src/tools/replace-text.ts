import type { ContentBlock } from '@modelcontextprotocol/server';

import { Buffer, isUtf8 } from 'node:buffer';
import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import type { StoppedReason } from '../core/concurrency.ts';
import { processEntriesConcurrently, StoppedReasonSchema } from '../core/concurrency.ts';
import { unifiedPatch } from '../core/diff.ts';
import { ErrorCode, FsError, Problem } from '../core/errors.ts';
import { buildWrittenFileMeta } from '../core/file-uri.ts';
import { stoppedEarlyLine, truncateProgressPattern } from '../core/fmt.ts';
import type { GuardedFileSystem } from '../core/fs.ts';
import { globEntries } from '../core/glob.ts';
import { toPosixRelative } from '../core/path.ts';
import { readFileBufferWithLimit } from '../core/read.ts';
import {
  defaultFalseBoolean,
  IncludeHidden,
  IncludeIgnored,
  isBlank,
  MaxDepth,
  NonNegInt,
  OperationSummarySchema,
  OptionalPath,
  PerFileErrorSchema,
  SafeGlobPattern,
} from '../core/schema.ts';
import type { Regex } from '../core/search.ts';
import { compileRegex, execMatches, freeRegex } from '../core/search.ts';
import {
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  getMaxTextFileSize,
  MAX_SEARCH_RESULTS,
  PARALLEL_CONCURRENCY,
} from '../core/util.ts';
import { isTotalFailure } from './batch.ts';
import { defineTool, type ToolCtx } from './define.ts';

const SearchAndReplaceInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'File to rewrite, or directory to rewrite under. Omitting it targets the ENTIRE first allowed root — ' +
      'scope it deliberately, and pair a wide scope with dryRun=true first',
  ),
  pattern: SafeGlobPattern.optional().describe(
    'Glob to restrict replacements to specific file types (e.g. **/*.ts); default: all text files',
  ),
  searchPattern: z
    .string()
    .min(1)
    .max(10000)
    .refine((val) => !isBlank(val), {
      message: 'searchPattern cannot be empty or whitespace-only',
    })
    .describe(
      'Exact literal text or RE2 regex pattern to search for. When isRegex=true, uses RE2 syntax (no lookahead, lookbehind, or backreferences are supported). Cannot be empty or whitespace-only.',
    )
    .meta({ examples: ['TODO', 'function\\s+(\\w+)', 'import.*from'] }),
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
  caseSensitive: defaultFalseBoolean('Enable case-sensitive matching (default: case-insensitive)'),
  wholeWord: defaultFalseBoolean('Match whole words only (word boundary anchoring)'),
  dryRun: defaultFalseBoolean(
    'Preview replacements without writing to disk (default: false = apply changes)',
  ),
  returnDiff: defaultFalseBoolean('Include a unified diff of all changes in the response'),
  maxResults: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS)
    .describe('Maximum total match count across all files before stopping'),
  maxFiles: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .describe('Maximum number of files to process'),
  maxDepth: MaxDepth,
});

const ReplacePerPathSchema = z.strictObject({
  path: z.string().describe('File path relative to the search root'),
  value: z
    .strictObject({ matches: NonNegInt.describe('Replacements applied in this file') })
    .optional()
    .describe('Replacement outcome; present on success'),
  error: PerFileErrorSchema.optional().describe('Error details; present on failure'),
});

// The same `{ results, summary }` envelope `read`, `stat`, and `delete` use, so
// a caller learns one shape for every tool that spans many paths. The former
// `filesModified` / `failedFiles` counters are `summary.succeeded` / `.failed`,
// and the old `primaryFile` block is gone — the resource_link content block
// already points at the first modified file.
const SearchAndReplaceOutputSchema = z.strictObject({
  results: z
    .array(ReplacePerPathSchema)
    .describe('Per-file results: modified files, then any that could not be processed'),
  summary: OperationSummarySchema,
  totalMatches: NonNegInt.describe('Total number of replacements made across all files'),
  filesScanned: NonNegInt.describe('Total number of files examined'),
  skippedBinary: NonNegInt.optional().describe(
    'Matching files left untouched because they are binary or not valid UTF-8 text',
  ),
  resultsTruncated: z
    .boolean()
    .optional()
    .describe(
      'True when the results list holds fewer entries than summary.total: the changed-file or failed-file cap was hit. Trust summary over results.length.',
    ),
  diff: z
    .string()
    .optional()
    .describe('Unified diff of all changes (present when returnDiff=true or dryRun=true)'),
  diffTruncated: z
    .boolean()
    .optional()
    .describe('True when the diff was cut due to the size limit'),
  stoppedReason: StoppedReasonSchema.describe(
    'Why enumeration stopped early: maxResults = match cap reached, maxFiles = file cap reached, timeout = time limit hit or cancelled. Absent when every matching file was enumerated. Marks the sweep incomplete, not the writes; files already dispatched still complete.',
  ),
});

const MAX_FAILURES = 20;
const REPLACE_CONCURRENCY = Math.min(PARALLEL_CONCURRENCY, 8);
const MAX_CHANGED_FILES = 100;
const MAX_DIFF_SIZE = 20 * 1024; // 20KB limit for diff output
const DIFF_APPEND_BUFFER = 1024;

interface Failure {
  path: string;
  error: NonNullable<z.infer<typeof ReplacePerPathSchema>['error']>;
}

function recordFailure(failures: Failure[], failure: Failure): void {
  if (failures.length >= MAX_FAILURES) return;
  failures.push(failure);
}

function recordChangedFile(summary: ReplaceSummary, plan: ReplacementPlan, filePath: string): void {
  const relativePath = toPosixRelative(summary.root, filePath);
  // The first changed file is the one the resource_link points at; keep what
  // was written so the link needs no read-back.
  summary.primary ??= { path: filePath, content: plan.updatedContent };
  if (summary.changedFiles.length < MAX_CHANGED_FILES) {
    summary.changedFiles.push({ path: relativePath, matches: plan.matchCount });
    return;
  }
  summary.changedFilesTruncated = true;
}

interface ReplacementMatcher {
  replace(content: string, replacement: string): { content: string; matchCount: number };
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
      // The regex is global and shared across every file in the batch, so a
      // previous file's match would otherwise start this scan mid-string.
      regex.lastIndex = 0;
      return regex.test(buffer.toString('utf-8'));
    },
    replace(content: string, replacement: string): { content: string; matchCount: number } {
      // Splicing by hand rather than through `String.replace(regex, …)`: RE2's
      // own replacer indexes the JS string with the code-point offsets it
      // reports, which lands the replacement short by one per astral character
      // (most emoji) earlier in the file. execMatches reports UTF-16 offsets.
      let matchCount = 0;
      let updated = '';
      let cursor = 0;
      for (const match of execMatches(regex, content)) {
        matchCount++;
        // Only isRegex=true opts into $1/$& substitution. A literal search
        // reaches this matcher too (case-insensitive and wholeWord both need a
        // regex), and there the replacement must be inserted verbatim.
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
      }
      return { content: updated + content.slice(cursor), matchCount };
    },
    dispose(): void {
      freeRegex(regex);
    },
  };
}

function createCaseSensitiveLiteralMatcher(searchPattern: string): ReplacementMatcher {
  const searchBuffer = Buffer.from(searchPattern, 'utf8');

  return {
    testBuffer(buffer: Buffer): boolean {
      return buffer.indexOf(searchBuffer) !== -1;
    },
    replace(content: string, replacement: string): { content: string; matchCount: number } {
      let matchCount = 0;
      const updated = content.replaceAll(searchPattern, () => {
        matchCount++;
        return replacement;
      });
      return { content: updated, matchCount };
    },
    dispose(): void {
      // no compiled pattern to release
    },
  };
}

type SearchAndReplaceArgs = z.infer<typeof SearchAndReplaceInputSchema>;
type SearchAndReplaceOutput = z.infer<typeof SearchAndReplaceOutputSchema>;

interface ReplaceContext {
  options: { dryRun: boolean; returnDiff: boolean };
  replacement: string;
  matcher: ReplacementMatcher;
  maxFileSize: number;
  signal: AbortSignal | undefined;
  summary: ReplaceSummary;
  fs: GuardedFileSystem;
  singleFile: boolean;
}

interface ReplacementPlan {
  matchCount: number;
  originalContent: string;
  updatedContent: string;
}

async function processEntry(entryPath: string, ctx: ReplaceContext): Promise<void> {
  const { options, signal, summary } = ctx;

  try {
    const plan = await readReplacementPlan(entryPath, ctx);
    if (!plan) {
      return;
    }

    if (!options.dryRun) {
      await ctx.fs.writeFile(entryPath, plan.updatedContent, {
        encoding: 'utf-8',
        signal,
      });
    }

    // Bookkeep only after the write succeeds (or in dryRun, where there is no
    // write): a failed write must not count the file as changed.
    summary.totalMatches += plan.matchCount;
    summary.filesChanged++;

    recordChangedFile(summary, plan, entryPath);

    maybeAppendPatchDiff(summary, {
      filePath: entryPath,
      originalContent: plan.originalContent,
      updatedContent: plan.updatedContent,
      includeDiff: options.dryRun || options.returnDiff,
    });
  } catch (error) {
    summary.failedFiles++;
    recordFailure(summary.failures, {
      path: toPosixRelative(summary.root, entryPath),
      error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, entryPath),
    });
  }
}

async function readReplacementPlan(
  validPath: string,
  ctx: ReplaceContext,
): Promise<ReplacementPlan | undefined> {
  const { matcher, replacement, maxFileSize, signal } = ctx;
  await using fileHandle = await ctx.fs.open(validPath);
  const stats = await fileHandle.stat();
  if (stats.size > maxFileSize) {
    throw new FsError(
      ErrorCode.TOO_LARGE,
      `File too large: ${validPath} (${String(stats.size)} bytes > ${String(maxFileSize)} bytes)`,
    );
  }

  const buffer = await readFileBufferWithLimit(fileHandle, maxFileSize, validPath, signal);
  if (!matcher.testBuffer(buffer)) return undefined;
  // Only bytes that decode to UTF-8 losslessly survive the string round trip;
  // anything else would be written back with U+FFFD in place of every bad byte.
  // NUL is valid UTF-8 but marks a binary file, as it does for `read`.
  if (!isUtf8(buffer) || buffer.includes(0)) {
    if (ctx.singleFile) {
      throw new FsError(ErrorCode.INVALID_INPUT, 'Binary or non-UTF-8 file detected.', validPath);
    }
    ctx.summary.skippedBinary++;
    return undefined;
  }

  const originalContent = buffer.toString('utf-8');
  const { content: updatedContent, matchCount } = matcher.replace(originalContent, replacement);
  return matchCount === 0 ? undefined : { matchCount, originalContent, updatedContent };
}

function maybeAppendPatchDiff(
  summary: ReplaceSummary,
  params: {
    filePath: string;
    originalContent: string;
    updatedContent: string;
    includeDiff: boolean;
  },
): void {
  if (!params.includeDiff) return;
  const header = toPosixRelative(summary.root, params.filePath);

  const patch = unifiedPatch(header, params.originalContent, params.updatedContent);

  if (summary.diff.length >= MAX_DIFF_SIZE) {
    summary.diffTruncated = true;
    return;
  }

  if (summary.diff.length + patch.length <= MAX_DIFF_SIZE + DIFF_APPEND_BUFFER) {
    summary.diff += patch;
    return;
  }

  summary.diffTruncated = true;
}

interface ReplaceSummary {
  root: string;
  totalMatches: number;
  filesChanged: number;
  failedFiles: number;
  processedFiles: number;
  skippedBinary: number;
  failures: Failure[];
  changedFiles: { path: string; matches: number }[];
  changedFilesTruncated: boolean;
  /** First file changed, as written. */
  primary?: { path: string; content: string };
  diff: string;
  diffTruncated: boolean;
  stoppedReason?: StoppedReason;
}

function createReplaceSummary(root: string): ReplaceSummary {
  return {
    root,
    totalMatches: 0,
    filesChanged: 0,
    failedFiles: 0,
    processedFiles: 0,
    skippedBinary: 0,
    failures: [],
    changedFiles: [],
    changedFilesTruncated: false,
    diff: '',
    diffTruncated: false,
  };
}

async function resolveSearchRoot(
  pathValue: string | undefined,
  fs: GuardedFileSystem,
): Promise<{ root: string; singleFile?: string }> {
  if (!pathValue) {
    return { root: fs.pathGuard.resolvePathOrRoot(undefined) };
  }
  const resolvedPath = await fs.pathGuard.validateExistingPath(pathValue);
  const { stats: fileStats } = await fs.stat(resolvedPath);
  if (fileStats.isFile()) {
    // A single explicit file target bypasses the glob machinery entirely:
    // routing it through globEntries with baseNameMatch would rewrite the
    // escaped basename to `**/${basename}` and match every same-named file
    // under the parent tree, not just this one.
    return {
      root: dirname(resolvedPath),
      singleFile: resolvedPath,
    };
  }
  return { root: resolvedPath };
}

function buildSearchPattern(args: SearchAndReplaceArgs): string {
  if (args.isRegex) {
    return args.wholeWord ? `\\b(?:${args.searchPattern})\\b` : args.searchPattern;
  }
  const escaped = RegExp.escape(args.searchPattern);
  return args.wholeWord ? `\\b(?:${escaped})\\b` : escaped;
}

function createReplacementMatcher(args: SearchAndReplaceArgs): ReplacementMatcher {
  // Use regex when isRegex, wholeWord, or case-insensitive (all require RE2)
  if (args.isRegex || args.wholeWord || !args.caseSensitive) {
    const regex = compileRegex(buildSearchPattern(args), { caseSensitive: args.caseSensitive });
    return createRegexReplacementMatcher(regex, args.isRegex);
  }
  return createCaseSensitiveLiteralMatcher(args.searchPattern);
}

function buildSearchAndReplaceStructuredResult(
  summary: ReplaceSummary,
  args: SearchAndReplaceArgs,
): SearchAndReplaceOutput {
  const results = [
    ...summary.changedFiles.map((f) => ({ path: f.path, value: { matches: f.matches } })),
    ...summary.failures.map((f) => ({ path: f.path, error: f.error })),
  ];
  return {
    results,
    // `failedFiles` counts every failure; `failures` itself is capped at
    // MAX_FAILURES, so the summary must not be derived from the array length.
    summary: {
      total: summary.filesChanged + summary.failedFiles,
      succeeded: summary.filesChanged,
      failed: summary.failedFiles,
    },
    totalMatches: summary.totalMatches,
    filesScanned: summary.processedFiles,
    ...(summary.skippedBinary ? { skippedBinary: summary.skippedBinary } : {}),
    // Failures are capped at MAX_FAILURES independently of the changed-file
    // cap, so either cap can leave `results` shorter than `summary.total`.
    ...(summary.changedFilesTruncated || summary.failures.length < summary.failedFiles
      ? { resultsTruncated: true }
      : {}),
    ...((args.dryRun || args.returnDiff) && summary.diff ? { diff: summary.diff } : {}),
    ...(summary.diffTruncated ? { diffTruncated: true } : {}),
    ...(summary.stoppedReason ? { stoppedReason: summary.stoppedReason } : {}),
  };
}

async function handleSearchAndReplace(
  args: SearchAndReplaceArgs,
  ctx: ToolCtx,
): Promise<{
  structured: SearchAndReplaceOutput;
  link?: ContentBlock;
}> {
  const maxFileSize = getMaxTextFileSize();
  const { root, singleFile } = await resolveSearchRoot(args.path, ctx.fs);
  const effectivePattern = args.pattern ?? '**/*';

  // An explicit single-file target bypasses baseNameMatch/exclude/hidden/
  // gitignore filtering — it should always be processed as the one file named.
  const entries: AsyncIterable<{ path: string }> | Iterable<{ path: string }> = singleFile
    ? [{ path: singleFile }]
    : globEntries({
        cwd: root,
        pattern: effectivePattern,
        includeHidden: args.includeHidden,
        skipIgnored: !args.includeIgnored,
        signal: ctx.signal,
        baseNameMatch: true,
        onlyFiles: true,
        suppressErrors: true,
        ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
      });

  const summary = createReplaceSummary(root);

  // The matcher may own a compiled RE2 pattern, whose wasm memory re2-wasm
  // never reclaims on its own. Nothing past the scan touches it, so free it the
  // moment the scan is done — success, failure, or abort alike.
  const matcher = createReplacementMatcher(args);
  let stoppedReason: StoppedReason | undefined;
  try {
    const context: ReplaceContext = {
      options: {
        dryRun: args.dryRun,
        returnDiff: args.returnDiff,
      },
      replacement: args.replacement,
      matcher,
      maxFileSize,
      signal: ctx.signal,
      summary,
      fs: ctx.fs,
      singleFile: singleFile !== undefined,
    };

    stoppedReason = await processEntriesConcurrently(entries, {
      signal: ctx.signal,
      concurrency: REPLACE_CONCURRENCY,
      ...(args.maxFiles !== undefined ? { maxEntries: args.maxFiles } : {}),
      shouldStop: () => summary.totalMatches >= args.maxResults,
      onEntry: () => {
        summary.processedFiles++;
        ctx.onProgress?.({ current: summary.processedFiles });
      },
      onError: (entryPath, err) => {
        summary.failedFiles++;
        recordFailure(summary.failures, {
          path: toPosixRelative(summary.root, entryPath),
          error: Problem.fromUnknown(err, ErrorCode.UNKNOWN, entryPath),
        });
      },
      runEntry: (entryPath) => processEntry(entryPath, context),
    });
  } finally {
    matcher.dispose();
  }
  if (stoppedReason !== undefined) summary.stoppedReason = stoppedReason;

  ctx.onProgress?.({ current: summary.processedFiles });

  if (!args.dryRun && summary.totalMatches > 0) {
    ctx.log?.(
      'info',
      `${summary.filesChanged} file(s) changed, ${summary.totalMatches} match(es)`,
      'replace_text',
    );
  }

  const structured = buildSearchAndReplaceStructuredResult(summary, args);

  // A dry run wrote nothing, so there is no updated file to link.
  const link =
    !args.dryRun && summary.primary
      ? buildWrittenFileMeta(summary.primary.path, summary.primary.content, ctx.resourceStore)
          .resourceLink
      : undefined;
  return link ? { structured, link } : { structured };
}

export const REPLACE_TEXT = defineTool({
  name: 'replace_text',
  title: 'Search and Replace',
  description:
    'Find and replace every occurrence of literal text or an RE2 regex, like sed -i, in one file or all files ' +
    'under a directory, optionally filtered by glob. The pattern runs over the whole file: it can span lines, ' +
    'and ^ and $ anchor to file start and end. edit replaces one unique exact match.',
  input: SearchAndReplaceInputSchema,
  output: SearchAndReplaceOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => {
    const dryLabel = args.dryRun ? ' [dry run]' : '';
    return {
      label: `Replace${dryLabel}`,
      subject: `${truncateProgressPattern(args.searchPattern)} → ${truncateProgressPattern(args.replacement)}`,
    };
  },
  accessPaths: (args) => (args.path ? [args.path] : []),
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
        : '');
    // The structured half ships under `_meta`, which clients do not show the
    // model, so the stop state and the diff preview must ride the text.
    const lines = [summaryText];
    const stop = structured.stoppedReason;
    if (stop === 'timeout') lines.push(stoppedEarlyLine(stop));
    else if (stop !== undefined) {
      // maxResults/maxFiles here are the caller's own caps, so raising one is
      // what reaches the rest; the search engine's advice to narrow is not.
      lines.push(
        `// scan stopped early: hit the ${stop} limit; later files were not scanned. A higher ${stop} reaches them.`,
      );
    }
    // A failure's reason lives in `results`, which ships under `_meta`.
    for (const r of structured.results.filter((x) => x.error).slice(0, 3)) {
      if (r.error) lines.push(`// ${basename(r.path)}: ${r.error.code} ${r.error.message}`);
    }
    if (structured.diffTruncated) {
      lines.push(
        `// diff cut at ${String(MAX_DIFF_SIZE / 1024)} KB: some files' changes are not shown.`,
      );
    }
    const text = lines.join('\n') + (structured.diff ? `\n\n${structured.diff}` : '');
    const isError = isTotalFailure(structured.summary);
    if (link) {
      return { structured, text, resources: [link], isError };
    }
    return { structured, text, isError };
  },
});
