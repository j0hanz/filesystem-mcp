import { basename } from 'node:path';

import * as z from 'zod/v4';

import { formatCount, truncateProgressPattern } from '../core/fmt.ts';
import { type ExcludedDirs, scan, type ScanOutcome, type StoppedReason } from '../core/scan.ts';
import {
  CursorSchema,
  IncludeHidden,
  IncludeIgnored,
  mapOptionalPath,
  MaxDepth,
  OptionalPath,
  SafeGlobPattern,
} from '../core/schema.ts';
import { putJsonResource } from '../core/store.ts';
import { DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS, PARALLEL_CONCURRENCY } from '../core/util.ts';
import { defineTool } from './define.ts';
import { pagedScan } from './paged-scan.ts';

// ---------------------------------------------------------------------------

const SearchFilesInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'Existing directory to search under. Required with several roots. Patterns with / match from here.',
  ),
  pattern: SafeGlobPattern.describe(
    'Glob. Without / it matches file names at any depth (*.ts). With / it matches paths relative to path (src/**/*.ts).',
  ),
  maxResults: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS)
    .describe('Files per page; totalMatches counts all kept matches.'),
  includeIgnored: IncludeIgnored,
  includeHidden: IncludeHidden,
  sortBy: z
    .enum(['name', 'path'])
    .optional()
    .default('path')
    .describe(
      'name: by file name across folders, ties by path. Sorts the first 10,000 kept matches before paging.',
    ),
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
  excludedDirs?: ExcludedDirs;
  stoppedReason?: StoppedReason;
  resourceUri?: string;
  nextCursor?: string;
}

interface SearchFilesPageMetadata {
  readonly root: string;
  matched: number;
  filesScanned: number;
  truncated: boolean;
  skippedInaccessible: number;
  excludedDirs?: ExcludedDirs;
  stoppedReason?: StoppedReason;
}

/**
 * Concurrent admission can overrun the cap: keep the first `cap` results in
 * walk order, and say a drop stopped the scan unless it already stopped.
 */
export function keepFirstResults<R>(
  outcome: ScanOutcome<R>,
  cap: number,
): { results: readonly R[]; stoppedReason?: StoppedReason } {
  const { results, stoppedReason } = outcome;
  if (results.length > cap) {
    return { results: results.slice(0, cap), stoppedReason: stoppedReason ?? 'maxResults' };
  }
  return { results, ...(stoppedReason ? { stoppedReason } : {}) };
}

export const FIND_FILES = defineTool<typeof SearchFilesInputSchema, SearchFilesOutput>({
  name: 'find_files',
  title: 'Find Files',
  description:
    'Find files whose name or path matches a glob under a directory. ' +
    'Use when you know a name or path pattern but not the location. ' +
    'Do not use it for file contents; use `search_text` instead. To browse a folder, use `list`. ' +
    'Matches files, never directories. Skips hidden entries, .gitignore matches, and build folders unless includeHidden or includeIgnored. ' +
    'Scanning stops at 10,000 matches (stoppedReason maxResults) or the time limit (FS_TOOL_TIMEOUT_MS, default 5 s; stoppedReason timeout) and still returns what it found. ' +
    'path must be an existing directory; a file path is rejected. maxResults sizes a page, not the scan; page on with nextCursor (expires after about 60 s, then search again without it). ' +
    'Returns root, results[{ path }], totalMatches, filesScanned, and when set nextCursor, stoppedReason, skippedInaccessible (entries it could not read), excludedDirs (skipped folders: total and first 5), resourceUri (all kept matches). ' +
    'Paths are relative to root when unambiguous, otherwise absolute.',
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
  run: async (args, ctx) =>
    await pagedScan({
      tool: 'find_files',
      args,
      ctx,
      produce: async ({ scope, paths }) => {
        const scanned = await scan(
          scope,
          {
            pathGuard: ctx.fs.pathGuard,
            pattern: args.pattern,
            baseNameMatch: true,
            includeHidden: args.includeHidden,
            includeIgnored: args.includeIgnored,
            onlyFiles: true,
            ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
            concurrency: PARALLEL_CONCURRENCY,
            cap: MAX_SEARCH_RESULTS,
            signal: ctx.signal,
          },
          (entry) => Promise.resolve(entry.path),
        );
        const { results, stoppedReason } = keepFirstResults(scanned, MAX_SEARCH_RESULTS);
        // Sorted after the scan, on the kept results.
        const found =
          args.sortBy === 'name'
            ? results
                .map((path) => ({ path, name: basename(path) }))
                .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
                .map((item) => item.path)
            : results.toSorted((x, y) => x.localeCompare(y));
        return {
          items: found.map((path): SearchFileResult => ({ path: paths.show(path) })),
          metadata: {
            root: paths.root,
            matched: found.length,
            filesScanned: scanned.scanned,
            truncated: stoppedReason !== undefined,
            skippedInaccessible: scanned.skippedInaccessible,
            ...(stoppedReason ? { stoppedReason } : {}),
            ...(scanned.excludedDirs ? { excludedDirs: scanned.excludedDirs } : {}),
          } satisfies SearchFilesPageMetadata,
          truncated: stoppedReason !== undefined,
        };
      },
      // The whole result, root included: its paths are relative to that root.
      externalize: (results, metadata) =>
        putJsonResource(ctx.resourceStore, `${args.pattern} files`, {
          root: metadata.root,
          results,
        }),
      trailer: (metadata) => ({
        total: metadata.matched,
        noun: 'files',
        stoppedReason: metadata.stoppedReason,
        skippedInaccessible: metadata.skippedInaccessible,
        excludedDirs: metadata.excludedDirs,
      }),
      render: ({ page, metadata, trailer }) => {
        const structured: SearchFilesOutput = {
          root: metadata.root,
          results: [...page],
          totalMatches: metadata.matched,
          filesScanned: metadata.filesScanned,
          ...(metadata.skippedInaccessible
            ? { skippedInaccessible: metadata.skippedInaccessible }
            : {}),
          ...(metadata.excludedDirs ? { excludedDirs: metadata.excludedDirs } : {}),
          ...(metadata.stoppedReason !== undefined
            ? { stoppedReason: metadata.stoppedReason }
            : {}),
        };
        const body =
          page.length > 0
            ? page.map((r) => r.path).join('\n')
            : `No files matching '${args.pattern}'`;
        return { structured, text: body + trailer };
      },
    }),
});
