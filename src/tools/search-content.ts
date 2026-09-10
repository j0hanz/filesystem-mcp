import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import { SearchStoppedReasonSchema } from '../core/concurrency.js';
import { pageQueryKey, paginate } from '../core/cursor.js';
import { ErrorCode, FsError } from '../core/errors.js';
import { formatCount, pageTrailer, truncateProgressPattern } from '../core/fmt.js';
import { DEFAULT_EXCLUDE_PATTERNS } from '../core/glob.js';
import { Logger } from '../core/observability.js';
import { toPosixRelative } from '../core/path.js';
import {
  CursorSchema,
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
  isBlank,
  maxDepthField,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  PositiveInt,
  SafeGlobPattern,
} from '../core/schema.js';
import type { SearchContentOptions } from '../core/search.js';
import { searchContent } from '../core/search.js';
import type { JsonResourceResult } from '../core/store.js';
import { putJsonResource } from '../core/store.js';
import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_RESULTS,
} from '../core/util.js';
import { defineTool, type ToolCtx } from './define.js';

/**
 * `FS_MAX_INLINE_MATCHES` used to cap how many matches a page showed inline
 * and, past it, push the rest into the resource store. `maxResults` is the one
 * page size now, and the full list is externalized whenever a response is
 * incomplete, so the variable does nothing. It is still read so an operator who
 * set it hears why it stopped mattering; the read goes at the next major.
 */
if (process.env['FS_MAX_INLINE_MATCHES'] !== undefined) {
  Logger.warn(
    'FS_MAX_INLINE_MATCHES is deprecated and ignored: maxResults sets the search_text page size. It will be removed in the next major release.',
  );
}

// Type Definitions
type SearchInput = z.infer<typeof GrepInputSchema>;
type SearchOutput = z.infer<typeof GrepOutputSchema>;
type SearchMatchPayload = NonNullable<SearchOutput['matches']>[number];
type SearchResultValue = Awaited<ReturnType<typeof searchContent>>;

interface SearchContentPageMetadata {
  readonly totalMatches: number;
  readonly filesScanned: number;
  readonly filesMatched?: number;
  readonly truncated: boolean;
  readonly stoppedReason?: SearchOutput['stoppedReason'];
  readonly skippedInaccessible?: number;
  readonly skippedTooLarge?: number;
}

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
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  caseSensitive: defaultFalseBoolean('Enable case-sensitive matching (default: case-insensitive)'),
  maxResults: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_CONTENT_RESULTS)
    .describe('Maximum number of matching lines to return per page'),
  maxDepth: maxDepthField(),
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
    totalMatches: metadata.totalMatches,
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
  }));

  payloads.sort((l, r) => l.file.localeCompare(r.file) || l.line - r.line);
  return payloads;
}

function buildSearchContentOptions(args: SearchInput, signal?: AbortSignal): SearchContentOptions {
  return {
    includeHidden: args.includeHidden,
    excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
    filePattern: args.pattern ?? '**/*',
    caseSensitive: args.caseSensitive,
    isRegex: args.isRegex,
    maxResults: args.maxResults,
    respectGitignore: !args.includeIgnored,
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
    // ponytail: the name goes through as a glob, so a file whose name contains
    // glob metacharacters (`[id].ts`) matches as a pattern rather than
    // literally. Escape it here if that ever bites.
    args: { ...args, pattern: basename(resolved), includeHidden: true, includeIgnored: true },
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
  const queryKey = pageQueryKey({
    method: 'search_text',
    path: requestedPath,
    pattern: args.pattern,
    searchPattern: args.searchPattern,
    isRegex: args.isRegex,
    includeHidden: args.includeHidden,
    includeIgnored: args.includeIgnored,
    caseSensitive: args.caseSensitive,
    maxDepth: args.maxDepth,
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

      const items = buildSortedPayloads(result);
      return {
        items,
        metadata: {
          totalMatches: result.summary.matchingLines,
          filesScanned: result.summary.filesScanned,
          ...(result.summary.filesMatched ? { filesMatched: result.summary.filesMatched } : {}),
          truncated: result.summary.truncated,
          ...(result.summary.stoppedReason !== undefined
            ? { stoppedReason: result.summary.stoppedReason }
            : {}),
          ...(result.summary.skippedInaccessible
            ? { skippedInaccessible: result.summary.skippedInaccessible }
            : {}),
          ...(result.summary.skippedTooLarge
            ? { skippedTooLarge: result.summary.skippedTooLarge }
            : {}),
        },
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
    total: paged.metadata.totalMatches,
    ...(paged.resource ? { link: paged.resource.link } : {}),
  };
}

export const SEARCH_CONTENT = defineTool({
  name: 'search_text',
  title: 'Search Content',
  description:
    'Search file contents by text or regex (grep-style). Returns matching lines with file path, ' +
    '1-indexed line number and 0-indexed column offset. ' +
    'Scope to specific file types with pattern (e.g. **/*.ts). ' +
    'Set includeHidden=true to include dotfiles. Use find_files to search by filename instead.',
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
    const rows = structured.matches.map((m) => `${m.file}:${String(m.line)}: ${m.content}`);
    const body = rows.length > 0 ? rows.join('\n') : `No matches for '${args.searchPattern}'`;
    const text =
      body +
      pageTrailer({
        offset,
        shown: rows.length,
        total,
        noun: 'matches',
        tool: 'search_text',
        nextCursor: structured.nextCursor,
        stoppedReason: structured.stoppedReason,
      });
    if (link) {
      return { structured, text, resources: [link] };
    }
    return { structured, text };
  },
});
