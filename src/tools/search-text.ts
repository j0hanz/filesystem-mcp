import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import { SearchStoppedReasonSchema } from '../core/concurrency.ts';
import { paginate } from '../core/cursor.ts';
import { ErrorCode, FsError } from '../core/errors.ts';
import { formatCount, pageTrailer, truncateProgressPattern } from '../core/fmt.ts';
import { toPosixRelative } from '../core/path.ts';
import {
  CursorSchema,
  defaultFalseBoolean,
  IncludeHidden,
  IncludeIgnored,
  isBlank,
  MaxDepth,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  PositiveInt,
  SafeGlobPattern,
} from '../core/schema.ts';
import type { SearchContentOptions } from '../core/search.ts';
import { searchContent } from '../core/search.ts';
import type { JsonResourceResult } from '../core/store.ts';
import { putJsonResource } from '../core/store.ts';
import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_RESULTS,
} from '../core/util.ts';
import { defineTool, type ToolCtx } from './define.ts';

// Type Definitions
type SearchInput = z.infer<typeof GrepInputSchema>;
type SearchOutput = z.infer<typeof GrepOutputSchema>;
type SearchMatchPayload = NonNullable<SearchOutput['matches']>[number];
type SearchResultValue = Awaited<ReturnType<typeof searchContent>>;
/** The engine's own summary is the page metadata; nothing is copied out of it. */
type SearchContentPageMetadata = SearchResultValue['summary'];

const GrepInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'File to search, or directory to search under (default: the whole first allowed root). Naming a file searches that file alone: pattern is ignored and hidden/ignored filtering does not apply.',
  ),
  pattern: SafeGlobPattern.optional().describe(
    'Glob to restrict search to specific file types (e.g. **/*.ts); default: all text files',
  ),
  searchPattern: z
    .string()
    .min(1)
    .max(10000)
    .refine((val) => !isBlank(val), {
      message: 'searchPattern cannot be empty or whitespace-only',
    })
    .describe(
      'Exact literal text or RE2 regex pattern to search for in file contents. When isRegex=true, uses RE2 syntax (no lookahead, lookbehind, or backreferences). Cannot be empty or whitespace-only.',
    )
    .meta({ examples: ['TODO', 'function\\s+(\\w+)', 'import.*from'] }),
  isRegex: defaultFalseBoolean('Treat searchPattern as a regex (default: literal text match)'),
  includeHidden: IncludeHidden,
  includeIgnored: IncludeIgnored,
  caseSensitive: defaultFalseBoolean('Enable case-sensitive matching (default: case-insensitive)'),
  maxResults: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_CONTENT_RESULTS)
    .describe('Maximum number of matching lines to return per page'),
  context: z
    .uint32()
    .max(10)
    .optional()
    .default(0)
    .describe(
      'Lines of context to return either side of each match, like grep -C (default: 0, max: 10)',
    ),
  maxDepth: MaxDepth,
  cursor: CursorSchema,
});

const GrepOutputSchema = z.strictObject({
  matches: z
    .array(
      z.strictObject({
        file: z.string().describe('File path relative to the search root'),
        line: PositiveInt.describe('1-indexed line number of the match'),
        column: NonNegInt.optional().describe('0-indexed column offset of the match start'),
        content: z.string().describe('Full text of the matching line'),
        matchCount: NonNegInt.optional().describe('Number of pattern occurrences on this line'),
        before: z
          .array(z.string())
          .optional()
          .describe('Lines immediately before the match; present when context > 0'),
        after: z
          .array(z.string())
          .optional()
          .describe('Lines immediately after the match; present when context > 0'),
      }),
    )
    .describe('Flat list of matches sorted by file path then line number'),
  totalMatches: NonNegInt.optional().describe(
    "Total matching lines, one per entry in matches (not per occurrence); see that entry's matchCount for occurrences on a line.",
  ),
  filesMatched: NonNegInt.optional().describe('Number of files containing at least one match'),
  filesScanned: NonNegInt.optional().describe('Total number of files examined'),
  skippedInaccessible: NonNegInt.optional().describe(
    'Files skipped unread due to permission or access errors',
  ),
  skippedTooLarge: NonNegInt.optional().describe(
    'Files skipped unread because they exceed the text-file size limit; raise the limit or narrow pattern if a match was expected in one',
  ),
  truncated: z
    .boolean()
    .optional()
    .describe(
      'True when the search engine cut the match list — the hard result cap or the time limit. Paging is not truncation: a set that spans pages has nextCursor instead.',
    ),
  stoppedReason: SearchStoppedReasonSchema.describe(
    'Why the search ended early: maxResults = result cap reached, timeout = time limit hit or the request was cancelled. Absent when the scan ran to completion.',
  ),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'URI to the full match list in the resource store; first page only, whenever the response is incomplete — more pages follow, or the engine cut the search',
    ),
  nextCursor: NextCursorSchema,
});

function matchRow(m: SearchMatchPayload): string {
  return `${m.file}:${String(m.line)}: ${m.content}`;
}

/**
 * grep -C layout: `file-line- text` for a context line, `--` between groups
 * that are not adjacent. Every match's window lands in a per-file line map
 * where a match wins over context, so a line two windows share prints once,
 * and as a match when it is one. The maps iterate in line order without a
 * sort: matches arrive sorted, each window is contiguous, and setting an
 * existing key keeps its slot. Without context the rows are the bare match
 * lines, byte-identical to before the option existed.
 */
function renderRows(matches: readonly SearchMatchPayload[], withContext: boolean): string[] {
  if (!withContext) return matches.map(matchRow);
  const byFile = new Map<string, Map<number, string>>();
  for (const m of matches) {
    const lines = byFile.get(m.file) ?? new Map<number, string>();
    byFile.set(m.file, lines);
    const setContext = (n: number, text: string): void => {
      if (!lines.has(n)) lines.set(n, `${m.file}-${String(n)}- ${text}`);
    };
    const before = m.before ?? [];
    before.forEach((text, k) => {
      setContext(m.line - before.length + k, text);
    });
    lines.set(m.line, matchRow(m));
    (m.after ?? []).forEach((text, k) => {
      setContext(m.line + 1 + k, text);
    });
  }
  const rows: string[] = [];
  for (const lines of byFile.values()) {
    let prev: number | undefined;
    for (const [n, row] of lines) {
      if (prev === undefined ? rows.length > 0 : n > prev + 1) rows.push('--');
      rows.push(row);
      prev = n;
    }
  }
  return rows;
}

function buildSearchMatchDetail(totalMatches: number, filesMatched: number): string {
  const matchDetail = formatCount(totalMatches, 'match', 'matches');
  if (filesMatched <= 0) return matchDetail;
  return `${matchDetail} · ${formatCount(filesMatched, 'file', 'files')}`;
}

function searchContentOutput(
  matches: readonly SearchMatchPayload[],
  metadata: SearchContentPageMetadata,
  nextCursor: string | undefined,
  resourceUri: string | undefined,
): SearchOutput {
  return {
    matches: [...matches],
    totalMatches: metadata.matchingLines,
    filesScanned: metadata.filesScanned,
    ...(metadata.filesMatched ? { filesMatched: metadata.filesMatched } : {}),
    ...(metadata.truncated ? { truncated: true } : {}),
    ...(metadata.stoppedReason !== undefined ? { stoppedReason: metadata.stoppedReason } : {}),
    ...(metadata.skippedInaccessible ? { skippedInaccessible: metadata.skippedInaccessible } : {}),
    ...(metadata.skippedTooLarge ? { skippedTooLarge: metadata.skippedTooLarge } : {}),
    ...(resourceUri !== undefined ? { resourceUri } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function buildSortedPayloads(result: SearchResultValue): SearchMatchPayload[] {
  const relativeByFile = new Map<string, string>();

  const getRelativeFile = (file: string): string => {
    const cached = relativeByFile.get(file);
    if (cached !== undefined) return cached;

    const rel = toPosixRelative(result.basePath, file);
    relativeByFile.set(file, rel);
    return rel;
  };

  const payloads = result.matches.map((match): SearchMatchPayload => ({
    file: getRelativeFile(match.file),
    line: match.line,
    column: match.column,
    content: match.content,
    matchCount: match.matchCount,
    ...(match.before !== undefined ? { before: match.before } : {}),
    ...(match.after !== undefined ? { after: match.after } : {}),
  }));

  payloads.sort((l, r) => l.file.localeCompare(r.file) || l.line - r.line);
  return payloads;
}

function buildSearchContentOptions(args: SearchInput, signal?: AbortSignal): SearchContentOptions {
  return {
    includeHidden: args.includeHidden,
    filePattern: args.pattern ?? '**/*',
    caseSensitive: args.caseSensitive,
    isRegex: args.isRegex,
    maxResults: args.maxResults,
    skipIgnored: !args.includeIgnored,
    context: args.context,
    ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
    ...(signal ? { signal } : {}),
  };
}

/**
 * `path` is documented as "file to search, or directory to search under", but
 * the scan itself only walks directories. A file path is therefore rewritten
 * into the scan it means: its parent as the base, its own name as the glob.
 * Naming a file is an explicit request for that file, so hidden/ignored
 * filtering is lifted for it — otherwise `search_text` on a path the caller can
 * see returned nothing.
 */
async function resolveSearchScope(
  args: SearchInput,
  ctx: ToolCtx,
): Promise<{ basePath: string; args: SearchInput }> {
  const requested = ctx.fs.pathGuard.resolvePathOrRoot(args.path);
  // One resolution, one stat: validateExistingDirectory would redo both.
  const resolved = await ctx.fs.pathGuard.validateExistingPath(requested);
  const stats = await stat(resolved);
  if (!stats.isFile()) {
    if (!stats.isDirectory()) {
      throw new FsError(ErrorCode.NOT_DIRECTORY, 'Not a directory', requested);
    }
    return { basePath: resolved, args };
  }
  return {
    basePath: dirname(resolved),
    // The `./` anchors the name to the parent: a bare name is a basename glob
    // that would also match every namesake anywhere below it.
    // ponytail: the name goes through as a glob, so a file whose name contains
    // glob metacharacters (`[id].ts`) matches as a pattern rather than
    // literally. Escape it here if that ever bites.
    args: {
      ...args,
      pattern: `./${basename(resolved)}`,
      includeHidden: true,
      includeIgnored: true,
    },
  };
}

async function handleSearchContent(
  args: SearchInput,
  ctx: ToolCtx,
): Promise<{
  structured: SearchOutput;
  offset: number;
  total: number;
  link?: ReturnType<typeof putJsonResource>['link'];
}> {
  const requestedPath = ctx.fs.pathGuard.resolvePathOrRoot(args.path);
  const queryKey = JSON.stringify({
    method: 'search_text',
    path: requestedPath,
    pattern: args.pattern,
    searchPattern: args.searchPattern,
    isRegex: args.isRegex,
    includeHidden: args.includeHidden,
    includeIgnored: args.includeIgnored,
    caseSensitive: args.caseSensitive,
    maxDepth: args.maxDepth,
    context: args.context,
  });
  const { resourceStore } = ctx;

  const paged = await paginate<SearchMatchPayload, SearchContentPageMetadata, JsonResourceResult>({
    store: ctx.pageStore,
    queryKey,
    cursor: args.cursor,
    pageSize: args.maxResults,
    produce: async () => {
      const { basePath, args: scoped } = await resolveSearchScope(args, ctx);

      const result = await searchContent(
        basePath,
        scoped.searchPattern,
        buildSearchContentOptions({ ...scoped, maxResults: MAX_SEARCH_RESULTS }, ctx.signal),
        ctx.fs.pathGuard,
      );

      return {
        items: buildSortedPayloads(result),
        metadata: result.summary,
        truncated: result.summary.truncated,
      };
    },
    externalize: resourceStore
      ? (matches, metadata) =>
          putJsonResource(
            resourceStore,
            `'${args.searchPattern}' matches`,
            searchContentOutput(matches, metadata, undefined, undefined),
          )
      : undefined,
  });

  return {
    structured: searchContentOutput(
      paged.page,
      paged.metadata,
      paged.nextCursor,
      paged.resource?.entry.uri,
    ),
    offset: paged.offset,
    total: paged.metadata.matchingLines,
    ...(paged.resource ? { link: paged.resource.link } : {}),
  };
}

export const SEARCH_TEXT = defineTool({
  name: 'search_text',
  title: 'Search Content',
  description:
    'Search file contents for literal text or an RE2 regex, like grep; returns matching lines with line numbers ' +
    'and paths relative to the searched directory. Patterns match within one line. find_files matches file names.',
  input: GrepInputSchema,
  output: GrepOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Search',
    subject: truncateProgressPattern(args.searchPattern),
  }),
  progressDone: (_args, result) => ({
    detail: buildSearchMatchDetail(result.totalMatches ?? 0, result.filesMatched ?? 0),
  }),
  accessPaths: (args) => (args.path ? [args.path] : []),
  run: async (args, ctx) => {
    const { structured, offset, total, link } = await handleSearchContent(args, ctx);
    const rows = renderRows(structured.matches, args.context > 0);
    const body = rows.length > 0 ? rows.join('\n') : `No matches for '${args.searchPattern}'`;
    const text =
      body +
      pageTrailer({
        offset,
        shown: structured.matches.length,
        total,
        noun: 'matches',
        tool: 'search_text',
        nextCursor: structured.nextCursor,
        stoppedReason: structured.stoppedReason,
        skippedTooLarge: structured.skippedTooLarge,
        skippedInaccessible: structured.skippedInaccessible,
      });
    if (link) {
      return { structured, text, resources: [link] };
    }
    return { structured, text };
  },
});
