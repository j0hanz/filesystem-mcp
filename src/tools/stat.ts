import type { ContentBlock } from '@modelcontextprotocol/server';

import { parse } from 'node:path';

import * as z from 'zod/v4';

import { ErrorCode, rethrowIfAborted } from '../core/errors.js';
import type { GuardedFileSystem, Stats } from '../core/fs.js';
import { isHidden } from '../core/fs.js';
import { detectMimeType } from '../core/mime.js';
import { resolveEntryType } from '../core/primitives.js';
import {
  FileInfoSchema,
  NonNegInt,
  OperationSummarySchema,
  PerFileErrorSchema,
  singleOrBatchAccessPaths,
  singleOrBatchPathsInput,
} from '../core/schema.js';
import { putJsonResource } from '../core/store.js';
import { DEFAULT_SEARCH_TIMEOUT_MS } from '../core/util.js';
import type { PerPathResult } from './batch.js';
import { isTotalFailure, runOverPaths } from './batch.js';
import type { ToolCtx } from './define.js';
import { defineTool } from './define.js';

type FileInfo = z.infer<typeof FileInfoSchema>;

const StatInputSchema = singleOrBatchPathsInput({});

const StatPerPathSchema = z.strictObject({
  path: z.string().describe('Requested path'),
  value: FileInfoSchema.optional().describe('File metadata; present on success'),
  error: PerFileErrorSchema.optional().describe('Error details; present on failure'),
});

const StatOutputSchema = z.strictObject({
  results: z
    .array(StatPerPathSchema)
    .describe('Per-path metadata results ordered to match the input paths'),
  summary: OperationSummarySchema,
  fileCount: NonNegInt.optional().describe('Number of regular files in the results'),
  dirCount: NonNegInt.optional().describe('Number of directories in the results'),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'URI to aggregated stats.json in the resource store (present when resource store is available)',
    ),
});

function getPermissions(mode: number): string {
  let out = '';
  for (const shift of [6, 3, 0]) {
    const bits = (mode >> shift) & 0b111;
    out += (bits & 0b100 ? 'r' : '-') + (bits & 0b010 ? 'w' : '-') + (bits & 0b001 ? 'x' : '-');
  }
  return out;
}

function buildFileInfoResult(
  name: string,
  requestedPath: string,
  isSymlink: boolean,
  stats: Stats,
  mimeType: string | undefined,
  symlinkTarget: string | undefined,
): FileInfo {
  const tokenEstimate = stats.isFile() ? Math.ceil(stats.size / 4) : undefined;
  return {
    name,
    path: requestedPath,
    type: isSymlink ? 'symlink' : resolveEntryType(stats),
    size: stats.size,
    ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
    created: stats.birthtime.toISOString(),
    modified: stats.mtime.toISOString(),
    accessed: stats.atime.toISOString(),
    permissions: getPermissions(stats.mode),
    isHidden: isHidden(name),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(symlinkTarget !== undefined ? { symlinkTarget } : {}),
  };
}

async function getSymlinkTarget(
  pathToRead: string,
  fs: GuardedFileSystem,
  signal?: AbortSignal,
  log?: ToolCtx['log'],
): Promise<string | undefined> {
  signal?.throwIfAborted();
  try {
    const { linkString } = await fs.readlink(pathToRead);
    return linkString;
  } catch (error) {
    rethrowIfAborted(error);
    log?.('warning', `stat: readlink failed for "${pathToRead}": ${String(error)}`, 'stat');
    return undefined;
  }
}

async function getFileInfo(
  filePath: string,
  { signal, fs, log }: Pick<ToolCtx, 'fs' | 'signal' | 'log'>,
): Promise<FileInfo> {
  signal.throwIfAborted();

  const {
    requestedPath,
    isSymlink,
    stats: followedStats,
  } = await fs.statDetailed(filePath, { signal });

  const { base: name, ext: rawExt } = parse(requestedPath);
  const mimeType = rawExt.length > 0 ? detectMimeType(requestedPath).mimeType : undefined;

  // For a symlink, fsStat follows the link and reports the target's metadata.
  // Report the link's own metadata instead so size/permissions/timestamps
  // describe the link the user asked about, not its target.
  let stats = followedStats;
  if (isSymlink) {
    try {
      ({ stats } = await fs.lstat(requestedPath, { signal }));
    } catch (error) {
      // A cancelled request is not a "link metadata unavailable" fallback.
      rethrowIfAborted(error);
      // Guarded lstat can be refused where raw lstat succeeded (e.g. an allowed
      // root that is itself a symlink, whose parent sits outside the roots).
      // Falling back to the followed stats degrades the report to the target's
      // metadata, so leave a trace instead of degrading silently.
      log?.('warning', `stat: lstat failed for "${requestedPath}": ${String(error)}`, 'stat');
      stats = followedStats;
    }
  }

  // isSymlink above is true whenever ANY ancestor is a symlink, because it
  // compares the requested path with its fully-resolved real path. Only the
  // entry's own lstat says whether THIS path is a link, so a regular file under
  // a symlinked parent is reported as a file and no readlink is attempted.
  const isOwnSymlink = stats.isSymbolicLink();
  const symlinkTarget = isOwnSymlink
    ? await getSymlinkTarget(requestedPath, fs, signal, log)
    : undefined;

  return buildFileInfoResult(name, requestedPath, isOwnSymlink, stats, mimeType, symlinkTarget);
}

function classifyTypeCounts(results: readonly PerPathResult<FileInfo>[]): {
  fileCount: number;
  dirCount: number;
} {
  let fileCount = 0;
  let dirCount = 0;
  for (const result of results) {
    if ('error' in result) continue;
    if (result.value.type === 'directory') dirCount += 1;
    else fileCount += 1;
  }
  return { fileCount, dirCount };
}

export const GET_FILE_INFO = defineTool({
  name: 'stat',
  title: 'Get File Info',
  description:
    'Get metadata for one or more files or directories: size, type, permissions, MIME type, timestamps, and tokenEstimate. ' +
    'Use tokenEstimate to pre-screen read cost before calling read. ' +
    'Single path: pass path. Batch mode: pass paths[].',
  input: StatInputSchema,
  output: StatOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.NOT_FOUND,
  progress: (args) => {
    if (args.paths !== undefined) {
      return { label: 'Stat', subject: `${String(args.paths.length)} paths` };
    }
    return { label: 'Stat', subject: args.path ?? '' };
  },
  accessPaths: singleOrBatchAccessPaths,
  run: async (args, ctx) => {
    const batchInput = args.path !== undefined ? { path: args.path } : { paths: args.paths ?? [] };

    const batch = await runOverPaths<undefined, FileInfo>(
      batchInput,
      ctx,
      async ({ path }) => getFileInfo(path, ctx),
      { defaultErrorCode: ErrorCode.NOT_FOUND },
    );

    const { fileCount, dirCount } = classifyTypeCounts(batch.results);
    const perPathPayload = batch.results;

    let resourceUri: string | undefined;
    const resources: ContentBlock[] = [];
    if (ctx.resourceStore && batch.summary.total > 1) {
      const { entry, link } = putJsonResource(
        ctx.resourceStore,
        `${String(batch.summary.total)} paths`,
        perPathPayload,
      );
      resourceUri = entry.uri;
      resources.push(link);
    }

    // No `text` on purpose. The one-liner this used to build (`AGENTS.md: file,
    // 751 B`) dropped tokenEstimate, modified, mimeType and isHidden — the very
    // fields a caller asks `stat` for. Supplying no text makes this a data tool,
    // so `define.ts` renders the JSON and keeps it in `structuredContent`.
    return {
      structured: {
        results: perPathPayload,
        summary: batch.summary,
        fileCount,
        dirCount,
        ...(resourceUri ? { resourceUri } : {}),
      },
      isError: isTotalFailure(batch.summary),
      ...(resources.length > 0 ? { resources } : {}),
    };
  },
});
