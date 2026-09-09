import type { ContentBlock } from '@modelcontextprotocol/server';

import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';

import * as z from 'zod/v4';

import type { StoppedReason, StopReasonTracker } from '../core/concurrency.js';
import { processEntriesConcurrently, StoppedReasonSchema } from '../core/concurrency.js';
import { unifiedPatch } from '../core/diff.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  Problem,
  rethrowIfAborted,
} from '../core/errors.js';
import { buildFileResourceLink } from '../core/file-uri.js';
import { truncateProgressPattern } from '../core/fmt.js';
import type { GuardedFileSystem } from '../core/fs.js';
import { DEFAULT_EXCLUDE_PATTERNS, globEntries } from '../core/glob.js';
import { toPosixRelative } from '../core/path.js';
import { escapeRegexLiteral } from '../core/primitives.js';
import { readFileBufferWithLimit } from '../core/read.js';
import {
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
  isBlank,
  maxDepthField,
  NonNegInt,
  OperationSummarySchema,
  OptionalPath,
  PerFileErrorSchema,
  SafeGlobPattern,
} from '../core/schema.js';
import type { Regex } from '../core/search.js';
import { compileRegex, freeRegex } from '../core/search.js';
import {
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  getMaxTextFileSize,
  MAX_SEARCH_RESULTS,
  PARALLEL_CONCURRENCY,
} from '../core/util.js';
import { isTotalFailure } from './batch.js';
import { defineTool, type ToolCtx } from './define.js';

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
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
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
  maxDepth: maxDepthField(),
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

function recordChangedFile(summary: ReplaceSummary, filePath: string, matchCount: number): void {
  const relativePath = toPosixRelative(summary.root, filePath);
  if (summary.changedFiles.length < MAX_CHANGED_FILES) {
    summary.changedFiles.push({ path: relativePath, matches: matchCount });
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
 * `$5` as `$4`. Passing a function to `String.replace` disables RE2's handling
 * entirely, which leaves this the single owner of the syntax.
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
      regex.lastIndex = 0;
      let matchCount = 0;
      // Only isRegex=true opts into $1/$& substitution. A literal search reaches
      // this matcher too (case-insensitive and wholeWord both need a regex), and
      // there the replacement must be inserted verbatim.
      if (!expandReplacement) {
        const updated = content.replace(regex, () => {
          matchCount++;
          return replacement;
        });
        return { content: updated, matchCount };
      }
      const updated = content.replace(regex, (match: string, ...rest: unknown[]): string => {
        matchCount++;
        // In ECMAScript/RE2, trailing arguments are [offset, input] or [offset, input, namedGroups].
        const named =
          rest.length >= 3 && typeof rest[rest.length - 3] === 'number'
            ? (rest.pop() as Record<string, string> | undefined)
            : undefined;
        const input = rest.pop() as string;
        const offset = rest.pop() as number;
        return expandDollarTokens(
          replacement,
          match,
          rest as (string | undefined)[],
          offset,
          input,
          named,
        );
      });
      return { content: updated, matchCount };
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
}

interface ReplacementPlan {
  matchCount: number;
  originalContent: string;
  updatedContent: string;
}

function buildReplacementPlan(
  content: string,
  replacement: string,
  matcher: ReplacementMatcher,
): ReplacementPlan | undefined {
  const { content: updatedContent, matchCount } = matcher.replace(content, replacement);
  if (matchCount === 0) {
    return undefined;
  }

  return {
    matchCount,
    originalContent: content,
    updatedContent,
  };
}

async function processEntry(entryPath: string, ctx: ReplaceContext): Promise<void> {
  const { options, signal, summary } = ctx;
  const validPath = entryPath;

  try {
    const plan = await readReplacementPlan(validPath, ctx);
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

    recordChangedFile(summary, validPath, plan.matchCount);

    maybeAppendPatchDiff(summary, {
      filePath: validPath,
      originalContent: plan.originalContent,
      updatedContent: plan.updatedContent,
      includeDiff: options.dryRun || options.returnDiff,
    });
  } catch (error) {
    summary.failedFiles++;
    recordFailure(summary.failures, {
      path: toPosixRelative(summary.root, validPath),
      error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, validPath),
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

  return buildReplacementPlan(buffer.toString('utf-8'), replacement, matcher);
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
  failures: Failure[];
  changedFiles: { path: string; matches: number }[];
  changedFilesTruncated: boolean;
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
  const escaped = escapeRegexLiteral(args.searchPattern);
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
  // The async generator matches globEntries' AsyncIterable contract; it needs
  // no await (single yield), hence the disable.
  const entries: AsyncIterable<{ path: string }> = singleFile
    ? // eslint-disable-next-line @typescript-eslint/require-await
      (async function* singleFileEntry() {
        yield { path: singleFile };
      })()
    : globEntries({
        cwd: root,
        pattern: effectivePattern,
        excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
        includeHidden: args.includeHidden,
        respectGitignore: !args.includeIgnored,
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
  let scan: StopReasonTracker;
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
    };

    scan = await processEntriesConcurrently(entries, {
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
  const stoppedReason = scan.resolve();
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

  // Store primary file in resource store if available (skip in dryRun to avoid reading stale disk content)
  if (
    !args.dryRun &&
    ctx.resourceStore &&
    summary.changedFiles.length > 0 &&
    summary.filesChanged > 0
  ) {
    const primaryFile = summary.changedFiles[0];
    if (!primaryFile) return { structured };

    const primaryFilePath = primaryFile.path;
    const fullPath = join(summary.root, primaryFilePath);

    try {
      const { content: rawBuffer, mimeType } = await ctx.fs.readRaw(fullPath, {
        signal: ctx.signal,
      });
      const link = buildFileResourceLink(fullPath, mimeType, rawBuffer.length);
      return { structured, link };
    } catch (error) {
      rethrowIfAborted(error);
      // Gracefully fall back if resource storage fails
      ctx.log?.(
        'error',
        `Failed to store primary file in resource store: ${formatUnknownErrorMessage(error)}`,
        'replace_text',
      );
    }
  }

  return { structured };
}

export const SEARCH_AND_REPLACE = defineTool({
  name: 'replace_text',
  title: 'Search and Replace',
  description:
    'Bulk search-and-replace across files matching a glob pattern. ' +
    'Replaces ALL occurrences per file (unlike edit, which replaces only the first match). ' +
    'Set returnDiff=true to preview changes as a unified diff before or after writing. ' +
    'Literal matching by default; set isRegex=true to enable RE2 regex with capture groups ($1, $2).',
  input: SearchAndReplaceInputSchema,
  output: SearchAndReplaceOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
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
      (structured.summary.failed > 0 ? ` \u00b7 ${String(structured.summary.failed)} failed` : '');
    const isError = isTotalFailure(structured.summary);
    if (link) {
      return { structured, text: summaryText, resources: [link], isError };
    }
    return { structured, text: summaryText, isError };
  },
});
