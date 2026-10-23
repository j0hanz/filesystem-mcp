import * as z from 'zod/v4';

import { pageQueryKey, paginate } from '../core/cursor.ts';
import { formatCount, pageTrailer, truncateProgressPattern } from '../core/fmt.ts';
import {
  CursorSchema,
  IncludeHidden,
  IncludeIgnored,
  mapOptionalPath,
  MaxDepth,
  OptionalPath,
  SafeGlobPattern,
} from '../core/schema.ts';
import { searchFiles } from '../core/search.ts';
import type { JsonResourceResult } from '../core/store.ts';
import { putJsonResource } from '../core/store.ts';
import { DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS } from '../core/util.ts';
import { defineTool } from './define.ts';

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

interface SearchFileResult {
  path: string;
}
interface SearchFilesOutput {
  root: string;
  results: SearchFileResult[];
  totalMatches?: number;
  filesScanned?: number;
  skippedInaccessible?: number;
  stoppedReason?: 'maxResults' | 'timeout';
  resourceUri?: string;
  nextCursor?: string;
}

/** The engine's own summary plus its root is the page metadata; nothing is copied out of it. */
type SearchFilesPageMetadata = Awaited<ReturnType<typeof searchFiles>>['summary'] & {
  readonly root: string;
};

export const FIND_FILES = defineTool<typeof SearchFilesInputSchema, SearchFilesOutput>({
  name: 'find_files',
  title: 'Find Files',
  description:
    'Find files by name or glob pattern; returns file paths relative to the root, ready to pass to read. ' +
    'A pattern without / matches file names at any depth. search_text searches contents.',
  input: SearchFilesInputSchema,
  readOnlyHint: true,
  deadline: true,
  progress: (args) => ({
    label: 'Find',
    subject: truncateProgressPattern(args.pattern),
  }),
  progressDone: (_args, result) => ({
    detail: formatCount(result.totalMatches ?? 0, 'match', 'matches'),
  }),
  mapPaths: mapOptionalPath,
  run: async (args, ctx) => {
    const requestedBasePath = ctx.fs.pathGuard.resolvePathOrRoot(args.path);
    const paged = await paginate<SearchFileResult, SearchFilesPageMetadata, JsonResourceResult>({
      store: ctx.pageStore,
      queryKey: pageQueryKey('find_files', { ...args, path: requestedBasePath }, [
        'cursor',
        'maxResults',
      ]),
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
        // Relative to the root, not to basePath: `a.ts` from a search of
        // `src` would name `<root>/a.ts` when passed back.
        const paths = ctx.fs.pathGuard.resultPaths(result.basePath);
        return {
          items: result.results.map((r) => ({ path: paths.show(r.path) })),
          metadata: { root: paths.root, ...result.summary },
          truncated: result.summary.truncated,
        };
      },
      // The whole result, root included: its paths are relative to that root.
      externalize: (results, metadata) =>
        putJsonResource(ctx.resourceStore, `${args.pattern} files`, {
          root: metadata.root,
          results,
        }),
    });

    const { metadata, offset } = paged;
    const structured: SearchFilesOutput = {
      root: metadata.root,
      results: [...paged.page],
      totalMatches: metadata.matched,
      filesScanned: metadata.filesScanned,
      ...(metadata.skippedInaccessible
        ? { skippedInaccessible: metadata.skippedInaccessible }
        : {}),
      ...(metadata.stoppedReason !== undefined ? { stoppedReason: metadata.stoppedReason } : {}),
      ...(paged.resource ? { resourceUri: paged.resource.entry.uri } : {}),
      ...(paged.nextCursor !== undefined ? { nextCursor: paged.nextCursor } : {}),
    };
    const body =
      structured.results.length > 0
        ? structured.results.map((r) => r.path).join('\n')
        : `No files matching '${args.pattern}'`;
    const text =
      body +
      pageTrailer({
        offset,
        shown: structured.results.length,
        total: metadata.matched,
        noun: 'files',
        tool: 'find_files',
        nextCursor: structured.nextCursor,
        nextArgs: args,
        stoppedReason: structured.stoppedReason,
        skippedInaccessible: structured.skippedInaccessible,
      });
    return { structured, text, resources: paged.resource ? [paged.resource.link] : [] };
  },
});
