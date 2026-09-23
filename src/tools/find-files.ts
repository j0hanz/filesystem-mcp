import * as z from 'zod/v4';

import { SearchStoppedReasonSchema } from '../core/concurrency.ts';
import { paginate } from '../core/cursor.ts';
import { ErrorCode } from '../core/errors.ts';
import { formatCount, pageTrailer, truncateProgressPattern } from '../core/fmt.ts';
import { toPosixRelative } from '../core/path.ts';
import {
  CursorSchema,
  IncludeHidden,
  IncludeIgnored,
  MaxDepth,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  SafeGlobPattern,
} from '../core/schema.ts';
import { searchFiles } from '../core/search.ts';
import type { JsonResourceResult } from '../core/store.ts';
import { putJsonResource } from '../core/store.ts';
import {
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_RESULTS,
} from '../core/util.ts';
import { defineTool, type ToolCtx } from './define.ts';

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
  includeIgnored: IncludeIgnored,
  includeHidden: IncludeHidden,
  sortBy: z
    .enum(['name', 'path'])
    .optional()
    .default('path')
    .describe('Sort order: path = full path (default), name = basename only'),
  maxDepth: MaxDepth,
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

type SearchFileResult = z.infer<typeof SearchFilesOutputSchema>['results'][number];

/** The engine's own summary plus its root is the page metadata; nothing is copied out of it. */
type SearchFilesPageMetadata = Awaited<ReturnType<typeof searchFiles>>['summary'] & {
  readonly root: string;
};

function searchFilesOutput(
  results: readonly SearchFileResult[],
  metadata: SearchFilesPageMetadata,
  nextCursor: string | undefined,
  resourceUri: string | undefined,
): z.infer<typeof SearchFilesOutputSchema> {
  return {
    root: metadata.root,
    results: [...results],
    totalMatches: metadata.matched,
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
  const queryKey = JSON.stringify({
    method: 'find_files',
    path: requestedBasePath,
    pattern: args.pattern,
    includeIgnored: args.includeIgnored,
    includeHidden: args.includeHidden,
    sortBy: args.sortBy,
    maxDepth: args.maxDepth,
  });
  const { resourceStore } = ctx;

  const paged = await paginate<SearchFileResult, SearchFilesPageMetadata, JsonResourceResult>({
    store: ctx.pageStore,
    queryKey,
    cursor: args.cursor,
    pageSize: args.maxResults,
    produce: async () => {
      const basePath = await ctx.fs.pathGuard.validateExistingDirectory(requestedBasePath);
      const searchOptions: Parameters<typeof searchFiles>[2] = {
        maxResults: MAX_SEARCH_RESULTS,
        includeHidden: args.includeHidden,
        sortBy: args.sortBy,
        skipIgnored: !args.includeIgnored,
        ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
        signal: ctx.signal,
      };
      const result = await searchFiles(basePath, args.pattern, searchOptions, ctx.fs.pathGuard);
      return {
        items: result.results.map((r) => ({ path: toPosixRelative(result.basePath, r.path) })),
        metadata: { root: result.basePath, ...result.summary },
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
    total: paged.metadata.matched,
    ...(paged.resource ? { link: paged.resource.link } : {}),
  };
}

export const FIND_FILES = defineTool({
  name: 'find_files',
  title: 'Find Files',
  description:
    'Find files by name or glob pattern; returns file paths relative to the searched directory. ' +
    'A pattern without / matches file names at any depth. search_text searches contents.',
  input: SearchFilesInputSchema,
  output: SearchFilesOutputSchema,
  annotations: {
    readOnlyHint: true,
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
        skippedInaccessible: structured.skippedInaccessible,
      });
    if (link) {
      return { structured, text, resources: [link] };
    }
    return { structured, text };
  },
});
