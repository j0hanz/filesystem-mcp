import * as z from 'zod/v4';

import { SearchStoppedReasonSchema } from '../core/concurrency.js';
import { paginate } from '../core/cursor.js';
import { ErrorCode } from '../core/errors.js';
import { formatCount, pageTrailer, truncateProgressPattern } from '../core/fmt.js';
import { DEFAULT_EXCLUDE_PATTERNS } from '../core/glob.js';
import { toPosixRelative } from '../core/path.js';
import {
  CursorSchema,
  includeHiddenField,
  includeIgnoredField,
  maxDepthField,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  SafeGlobPattern,
} from '../core/schema.js';
import { searchFiles } from '../core/search.js';
import type { JsonResourceResult } from '../core/store.js';
import { putJsonResource } from '../core/store.js';
import {
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_RESULTS,
} from '../core/util.js';
import { defineTool, type ToolCtx } from './define.js';

// ---------------------------------------------------------------------------

const SearchFilesInputSchema = z.strictObject({
  path: OptionalPath.describe('Base directory to search under (default: first allowed root)'),
  pattern: SafeGlobPattern.describe('Glob pattern to match file paths (e.g. **/*.ts, src/**/*.js)'),
  maxResults: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS)
    .describe('Maximum number of matching files to return per page'),
  includeIgnored: includeIgnoredField(),
  includeHidden: includeHiddenField(),
  sortBy: z
    .enum(['name', 'path'])
    .optional()
    .default('path')
    .describe('Sort order: path = full path (default), name = basename only'),
  maxDepth: maxDepthField(),
  cursor: CursorSchema,
});

const SearchFilesOutputSchema = z.strictObject({
  root: z.string().describe('Resolved base directory used as the search root'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('File path relative to the search root'),
      }),
    )
    .describe('Matched files ordered by sortBy'),
  totalMatches: NonNegInt.optional().describe('Total number of matching files found'),
  filesScanned: NonNegInt.optional().describe('Total number of files examined during the search'),
  skippedInaccessible: NonNegInt.optional().describe(
    'Files skipped due to permission or access errors',
  ),
  stoppedReason: SearchStoppedReasonSchema.describe(
    'Why the search ended early: maxResults = result cap reached, timeout = time limit hit or the request was cancelled. Absent when the scan ran to completion.',
  ),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'URI to the full results JSON in the resource store; first page only, whenever the response is incomplete — more pages follow, or the result cap cut the search',
    ),
  nextCursor: NextCursorSchema,
});

function buildRelativeResults(
  basePath: string,
  displayResults: readonly { path: string }[],
): NonNullable<z.infer<typeof SearchFilesOutputSchema>['results']> {
  const relativeResults: NonNullable<z.infer<typeof SearchFilesOutputSchema>['results']> = [];
  for (const entry of displayResults) {
    relativeResults.push({
      path: toPosixRelative(basePath, entry.path),
    });
  }
  return relativeResults;
}

type SearchFileResult = NonNullable<z.infer<typeof SearchFilesOutputSchema>['results']>[number];

interface SearchFilesPageMetadata {
  readonly root: string;
  readonly totalMatches: number;
  readonly filesScanned: number;
  readonly skippedInaccessible?: number;
  readonly stoppedReason?: z.infer<typeof SearchFilesOutputSchema>['stoppedReason'];
}

function searchFilesQueryKey(
  args: z.infer<typeof SearchFilesInputSchema>,
  basePath: string,
): string {
  return JSON.stringify({
    method: 'find_files',
    path: basePath,
    pattern: args.pattern,
    includeIgnored: args.includeIgnored,
    includeHidden: args.includeHidden,
    sortBy: args.sortBy,
    maxDepth: args.maxDepth,
  });
}

function searchFilesOutput(
  results: readonly SearchFileResult[],
  metadata: SearchFilesPageMetadata,
  nextCursor: string | undefined,
  resourceUri: string | undefined,
): z.infer<typeof SearchFilesOutputSchema> {
  return {
    root: metadata.root,
    results: [...results],
    totalMatches: metadata.totalMatches,
    filesScanned: metadata.filesScanned,
    ...(metadata.skippedInaccessible ? { skippedInaccessible: metadata.skippedInaccessible } : {}),
    ...(metadata.stoppedReason !== undefined ? { stoppedReason: metadata.stoppedReason } : {}),
    ...(resourceUri !== undefined ? { resourceUri } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

async function handleSearchFiles(
  args: z.infer<typeof SearchFilesInputSchema>,
  ctx: ToolCtx,
): Promise<{
  structured: z.infer<typeof SearchFilesOutputSchema>;
  offset: number;
  total: number;
  link?: ReturnType<typeof putJsonResource>['link'];
}> {
  const requestedBasePath = ctx.fs.pathGuard.resolvePathOrRoot(args.path);
  const queryKey = searchFilesQueryKey(args, requestedBasePath);
  const { resourceStore } = ctx;

  const paged = await paginate<SearchFileResult, SearchFilesPageMetadata, JsonResourceResult>({
    store: ctx.pageStore,
    queryKey,
    cursor: args.cursor,
    pageSize: args.maxResults,
    produce: async () => {
      const basePath = await ctx.fs.pathGuard.validateExistingDirectory(requestedBasePath);
      const excludePatterns = args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS;
      const searchOptions: Parameters<typeof searchFiles>[3] = {
        maxResults: MAX_SEARCH_RESULTS,
        includeHidden: args.includeHidden,
        sortBy: args.sortBy,
        respectGitignore: !args.includeIgnored,
        ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
        signal: ctx.signal,
      };
      const result = await searchFiles(
        basePath,
        args.pattern,
        excludePatterns,
        searchOptions,
        ctx.fs.pathGuard,
      );
      return {
        items: buildRelativeResults(result.basePath, result.results),
        metadata: {
          root: result.basePath,
          totalMatches: result.summary.matched,
          filesScanned: result.summary.filesScanned,
          ...(result.summary.skippedInaccessible
            ? { skippedInaccessible: result.summary.skippedInaccessible }
            : {}),
          ...(result.summary.stoppedReason !== undefined
            ? { stoppedReason: result.summary.stoppedReason }
            : {}),
        },
        truncated: result.summary.truncated,
      };
    },
    externalize: resourceStore
      ? (results) => putJsonResource(resourceStore, `${args.pattern} files`, results)
      : undefined,
  });

  return {
    structured: searchFilesOutput(
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

export const SEARCH_FILES = defineTool({
  name: 'find_files',
  title: 'Find Files',
  description:
    'Find files matching a glob pattern. Returns matched paths with optional metadata. ' +
    'Pagination cursors reference a query-bound snapshot that expires after 60 seconds. ' +
    'For content search use search_text; for bulk regex replacements use replace_text with the same glob.',
  input: SearchFilesInputSchema,
  output: SearchFilesOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Find',
    subject: truncateProgressPattern(args.pattern),
  }),
  progressDone: (_args, result) => ({
    detail: formatCount(result.totalMatches ?? 0, 'match', 'matches'),
  }),
  accessPaths: (args) => (args.path ? [args.path] : []),
  run: async (args, ctx) => {
    const { structured, offset, total, link } = await handleSearchFiles(args, ctx);
    const body =
      structured.results.length > 0
        ? structured.results.map((r) => r.path).join('\n')
        : `No files matching '${args.pattern}'`;
    const text =
      body +
      pageTrailer({
        offset,
        shown: structured.results.length,
        total,
        noun: 'files',
        tool: 'find_files',
        nextCursor: structured.nextCursor,
        stoppedReason: structured.stoppedReason,
      });
    if (link) {
      return { structured, text, resources: [link] };
    }
    return { structured, text };
  },
});
