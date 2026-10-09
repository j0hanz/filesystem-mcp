import { parse } from 'node:path';

import { ErrorCode, rethrowIfAborted } from '../core/errors.ts';
import type { GuardedFileSystem, Stats } from '../core/fs.ts';
import { detectMimeType } from '../core/mime.ts';
import { type EntryType, resolveEntryType } from '../core/path-utils.ts';
import { singleOrBatchAccessPaths, singleOrBatchPathsInput } from '../core/schema.ts';
import { DEFAULT_SEARCH_TIMEOUT_MS } from '../core/util.ts';
import type { BatchResult } from './batch.ts';
import { isTotalFailure, runOverPaths } from './batch.ts';
import type { ToolCtx } from './define.ts';
import { defineTool } from './define.ts';

interface FileInfo {
  name: string;
  path: string;
  type: EntryType;
  size?: number;
  tokenEstimate?: number;
  created: string;
  modified: string;
  accessed: string;
  permissions?: string;
  readOnly?: boolean;
  isHidden: boolean;
  mimeType?: string;
  symlinkTarget?: string;
}

const StatInputSchema = singleOrBatchPathsInput({});

type StatOutput = BatchResult<FileInfo>;

function getPermissions(mode: number): string {
  let out = '';
  for (const shift of [6, 3, 0]) {
    const bits = (mode >> shift) & 0b111;
    out += (bits & 0b100 ? 'r' : '-') + (bits & 0b010 ? 'w' : '-') + (bits & 0b001 ? 'x' : '-');
  }
  return out;
}

// On Windows libuv never consults the ACL: mode is 0666, or 0444 when
// FILE_ATTRIBUTE_READONLY is set. A POSIX triad would claim group/other access
// it never checked (issue #56), so report the one fact the mode encodes.
function accessFields(mode: number): Pick<FileInfo, 'permissions' | 'readOnly'> {
  if (process.platform === 'win32') return { readOnly: (mode & 0o222) === 0 };
  return { permissions: getPermissions(mode) };
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
    // A directory's st_size is 0 on Windows and the block size on POSIX; neither
    // describes its contents, and a literal 0 reads as "empty" (issue #56).
    ...(stats.isDirectory() ? {} : { size: stats.size }),
    ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
    created: stats.birthtime.toISOString(),
    modified: stats.mtime.toISOString(),
    accessed: stats.atime.toISOString(),
    ...accessFields(stats.mode),
    isHidden: name.startsWith('.'),
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
      log('warning', `stat: lstat failed for "${requestedPath}": ${String(error)}`, 'stat');
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

export const STAT = defineTool<typeof StatInputSchema, StatOutput>({
  name: 'stat',
  title: 'Get File Info',
  description:
    'Get metadata without reading contents, like ls -ld: type, size (files only; use list for directory contents), ' +
    'tokenEstimate, timestamps, permissions (readOnly on Windows), MIME type guessed from the extension, and symlink target. ' +
    'Also checks whether paths exist.',
  input: StatInputSchema,
  readOnlyHint: true,
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
    const paths = args.path !== undefined ? [args.path] : (args.paths ?? []);

    const batch = await runOverPaths(paths, ctx, ErrorCode.NOT_FOUND, async (path) =>
      getFileInfo(path, ctx),
    );

    // No `text` on purpose. The one-liner this used to build (`AGENTS.md: file,
    // 751 B`) dropped tokenEstimate, modified, mimeType and isHidden — the very
    // fields a caller asks `stat` for. Supplying no text makes this a data tool,
    // so `define.ts` renders the JSON and keeps it in `structuredContent`.
    return {
      structured: { results: batch.results, summary: batch.summary },
      isError: isTotalFailure(batch.summary),
    };
  },
});
