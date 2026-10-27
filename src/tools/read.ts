import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.ts';
import { ErrorCode, FsError } from '../core/errors.ts';
import { buildFileResourceLinkFor, buildFileResourceUri } from '../core/file-uri.ts';
import {
  detectMimeFromContent,
  detectMimeType,
  type FileKind,
  isKnownBinaryExtension,
} from '../core/mime.ts';
import { base64EncodedBytes, canLinkFile, type Transport } from '../core/outbound.ts';
import {
  BINARY_FILE_MESSAGE,
  isBinaryRefusal,
  type ReadFileResult,
  type ReadSpec,
} from '../core/read.ts';
import {
  defaultFalseBoolean,
  mapSingleOrBatchPaths,
  type ReadRange,
  singleOrBatchPathsInput,
  validateReadRange,
} from '../core/schema.ts';
import {
  DEFAULT_CONTINUATION_CHUNK_SIZE,
  getMaxTextFileSize,
  PARALLEL_CONCURRENCY,
  READ_MANY_MAX_TOTAL_BYTES,
  sha256Hex,
} from '../core/util.ts';
import type { BatchResult } from './batch.ts';
import { isTotalFailure, runOverPaths } from './batch.ts';
import type { ToolCtx } from './define.ts';
import { defineTool } from './define.ts';

/**
 * `z.int32()`'s own ceiling on startLine/endLine, named so a continuation
 * never asks for more. Not restated as `.max()`: that reports it twice.
 */
const MAX_LINE_NUMBER = 2_147_483_647;

const rangeField = (description: string, count = false) => {
  const field = z.int32().min(1, { message: 'Min: 1' });
  return (count ? field.max(100000, { message: 'Max: 100,000' }) : field)
    .optional()
    .describe(description);
};

const readRangeFields = {
  head: rangeField('Return first N lines', true),
  tail: rangeField('Return last N lines', true),
  startLine: rangeField('Start line (1-indexed)'),
  endLine: rangeField('End line (1-indexed); requires startLine'),
};

/** A slice read: only a full read returns media or a binary resource. */
const hasLineRange = (args: ReadRange): boolean =>
  [args.head, args.tail, args.startLine, args.endLine].some((line) => line !== undefined);

const ReadFileInputSchema = singleOrBatchPathsInput({
  includeHash: defaultFalseBoolean('Include SHA-256 hash of the returned content in the response'),
  binary: defaultFalseBoolean(
    'Return a binary file that is not an image or audio whole, as a base64 embedded resource. Full reads only.',
  ),
  ...readRangeFields,
}).superRefine((value, ctx) => {
  validateReadRange(value, ctx);
  if (value.binary && hasLineRange(value)) {
    ctx.addIssue({
      code: 'custom',
      path: ['binary'],
      message:
        "Cannot use 'binary' with 'head'/'tail'/'startLine'/'endLine'. A binary file is read whole.",
      input: value,
    });
  }
});

interface ReadContinuation {
  tool: 'read';
  args: { path: string; startLine: number; endLine: number };
  hint: string;
}

// File bytes ride content blocks, never the structured metadata.
interface ReadPerPathValue {
  mimeType?: string;
  kind?: FileKind;
  resourceUri?: string;
  /** Bytes in the file; set when the bytes ride a media or resource block. */
  size?: number;
  /** ISO-8601 mtime at read time; also rides the resource_link. */
  modified?: string;
  continuation?: ReadContinuation;
  totalLines?: number;
  linesRead?: number;
  hasMoreLines?: boolean;
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  contentHash?: string;
}

type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

const READ_TOOL_LABEL = 'Read';

function buildReadSpec(args: ReadFileInput, signal?: AbortSignal): ReadSpec {
  const signalPart = signal ? { signal } : {};
  const { head, tail, startLine, endLine } = args;

  if (head !== undefined) return { kind: 'head', lines: head, ...signalPart };
  if (tail !== undefined) return { kind: 'tail', lines: tail, ...signalPart };
  if (startLine !== undefined || endLine !== undefined) {
    return {
      kind: 'range',
      start: startLine ?? 1,
      ...(endLine !== undefined ? { end: endLine } : {}),
      ...signalPart,
    };
  }
  return { kind: 'full', ...signalPart };
}

// No `totalLines`: only `readFull` counts them and a full read never leaves
// more behind, so a continuation cannot know the total without a second pass.
function buildReadContinuation(
  result: ReadFileResult,
  requestedPath: string,
): ReadContinuation | undefined {
  if (!result.hasMoreLines) return undefined;
  const linesRead = result.linesRead ?? 0;
  const nextStart = (result.startLine ?? 1) + linesRead;
  // Args the schema would reject are no continuation; clamp the end into it.
  if (nextStart > MAX_LINE_NUMBER) return undefined;
  let chunkSize: number;
  if (result.head !== undefined) {
    chunkSize = result.head;
  } else if (result.startLine !== undefined && result.endLine !== undefined) {
    chunkSize = result.endLine - result.startLine + 1;
  } else {
    chunkSize = DEFAULT_CONTINUATION_CHUNK_SIZE;
  }
  const nextEnd = Math.min(nextStart + chunkSize - 1, MAX_LINE_NUMBER);
  return {
    tool: 'read',
    args: { path: requestedPath, startLine: nextStart, endLine: nextEnd },
    hint: `More lines remain from ${String(nextStart)}. Read next chunk with these args.`,
  };
}

/**
 * The published metadata plus the bytes this call read. `content`, `mediaData`
 * and `blobData` exist only between `readOnePath` and the content blocks `run`
 * builds from them — they are stripped before the structured half is returned,
 * which is why they are not in `ReadPerPathValue`.
 */
type PerPathReadValue = ReadPerPathValue & {
  content?: string;
  fileSize?: number;
  mediaData?: string;
  blobData?: string;
};

interface BudgetItem {
  path: string;
  skip?: FsError;
}

interface BudgetMode {
  fullRead: boolean;
  binary: boolean;
}

/**
 * What a file costs the batch: one whose bytes ship as base64 costs that size.
 * Only a full read ships base64; a slice of an svg is text.
 */
function budgetBytes(path: string, size: number, { fullRead, binary }: BudgetMode): number {
  if (!fullRead) return size;
  const { kind } = detectMimeType(path);
  const base64 = kind === 'image' || kind === 'audio' || (binary && isKnownBinaryExtension(path));
  return base64 ? base64EncodedBytes(size) : size;
}

async function collectFileBudget(
  filePaths: readonly string[],
  maxTotalSize: number,
  maxSize: number,
  ctx: Pick<ToolCtx, 'fs' | 'signal' | 'log'>,
  mode: BudgetMode,
): Promise<BudgetItem[]> {
  const { results } = await processInParallel(
    filePaths,
    async (path): Promise<number | undefined> => {
      try {
        const out = await ctx.fs.stat(path);
        return budgetBytes(path, Math.min(out.stats.size, maxSize), mode);
      } catch (err: unknown) {
        ctx.log('debug', `collectFileBudget: stat failed for "${path}": ${String(err)}`, 'read');
        return undefined;
      }
    },
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );
  const sizes = new Map(results.map(({ index, value }) => [index, value]));

  let total = 0;
  return filePaths.map((path, i): BudgetItem => {
    const size = sizes.get(i);
    // A failed stat is not skipped, so its read surfaces the
    // real error, not a misleading TOO_LARGE.
    if (size === undefined) return { path };
    // Skip this file only; a later, smaller file that still fits is read.
    if (total + size > maxTotalSize) {
      return {
        path,
        skip: new FsError(
          ErrorCode.TOO_LARGE,
          `Skipped: this file alone would push the batch past maxTotalSize (${String(maxTotalSize)} bytes). Read it on its own with path instead of paths.`,
          path,
        ),
      };
    }
    total += size;
    return { path };
  });
}

function buildPerPathReadValue(
  result: ReadFileResult,
  options: { includeHash?: boolean; requestedPath: string; transport: Transport },
): PerPathReadValue {
  const mimeInfo = detectMimeFromContent(result.path, result.content);
  const continuation =
    result.hasMoreLines && result.readMode !== 'tail'
      ? buildReadContinuation(result, options.requestedPath)
      : undefined;
  const contentHash = options.includeHash ? sha256Hex(result.content) : undefined;

  // A slice is not the file, so the link rule gets its size, not its content.
  const canLink =
    (result.fileSize === undefined || result.fileSize <= getMaxTextFileSize()) &&
    canLinkFile(options.transport, {
      uri: buildFileResourceUri(result.path),
      mimeType: mimeInfo.mimeType,
      size: result.fileSize ?? Buffer.byteLength(result.content, 'utf8'),
      // resources/read picks base64 by this kind, so an svg slice is held to that rule.
      kind: mimeInfo.kind,
    });

  return {
    content: result.content,
    ...(result.fileSize !== undefined ? { fileSize: result.fileSize } : {}),
    mimeType: mimeInfo.mimeType,
    kind: mimeInfo.kind,
    ...(continuation ? { continuation } : {}),
    ...(result.totalLines !== undefined ? { totalLines: result.totalLines } : {}),
    ...(result.linesRead !== undefined ? { linesRead: result.linesRead } : {}),
    ...(result.hasMoreLines ? { hasMoreLines: true } : {}),
    ...(result.head !== undefined ? { head: result.head } : {}),
    ...(result.tail !== undefined ? { tail: result.tail } : {}),
    ...(result.startLine !== undefined ? { startLine: result.startLine } : {}),
    ...(result.endLine !== undefined ? { endLine: result.endLine } : {}),
    ...(contentHash !== undefined ? { contentHash } : {}),
    ...(canLink ? { resourceUri: buildFileResourceUri(result.path) } : {}),
    modified: result.modified,
  };
}

/**
 * The two facts the model cannot act on without: that lines were dropped, and
 * the exact args to get the next chunk. Both used to live only in the structured
 * half, which no longer reaches the model. Each line is `//` prefixed and set
 * off by a blank line so it cannot be read as file bytes — do not drop either
 * guard.
 */
function readTrailer(v: PerPathReadValue): string[] {
  const lines: string[] = [];
  if (v.continuation) {
    lines.push(
      `// truncated: ${v.continuation.hint} Continue: read ${JSON.stringify(v.continuation.args)}`,
    );
  } else if (v.hasMoreLines && v.linesRead !== undefined) {
    // A tail read gets no continuation — there are no args that read *backwards*
    // — so say what was shown rather than leaving the truncation silent.
    lines.push(`// truncated: showing last ${String(v.linesRead)} lines`);
  }
  if (v.contentHash !== undefined) lines.push(`// sha256: ${v.contentHash}`);
  return lines;
}

/**
 * `binary: true` after the text path refused the file as binary. readRaw
 * re-validates the path (roots, denylist) and enforces the same size cap.
 * A file refused by its extension can still probe as text: it ships as the
 * extension says, octet-stream.
 */
async function readBinaryResource(
  filePath: string,
  args: ReadFileInput,
  ctx: ToolCtx,
): Promise<PerPathReadValue> {
  const raw = await ctx.fs.readRaw(filePath, { signal: ctx.signal });
  const asText = raw.kind === 'text';
  const kind: FileKind = asText ? 'binary' : raw.kind;
  const mimeType = asText ? 'application/octet-stream' : raw.mimeType;
  const size = raw.content.length;
  return {
    content: `[binary ${kind} content: ${String(size)} bytes (${mimeType}); returned as an embedded resource block]`,
    mimeType,
    kind,
    size,
    // Not gated by canLinkFile: the embedded block needs it, and a blob too
    // large for stdio makes refuseOversized refuse the whole result anyway.
    resourceUri: buildFileResourceUri(raw.validPath),
    modified: raw.modified,
    blobData: raw.content.toString('base64'),
    ...(args.includeHash ? { contentHash: sha256Hex(raw.content) } : {}),
  };
}

async function readOnePath(
  filePath: string,
  args: ReadFileInput,
  ctx: ToolCtx,
): Promise<PerPathReadValue> {
  // Image/audio full read: return a media content block instead of throwing
  // INVALID_INPUT ("Binary file detected."). Line-range reads are
  // text-oriented and stay rejected. `readRaw` enforces the same size cap as
  // the text path (getMaxTextFileSize), so a too-large image surfaces TOO_LARGE
  // rather than blowing memory. svg is kind 'image' in EXT_MAP, so readRaw
  // reports it binary and it returns as an image block.
  const isRangeRead = hasLineRange(args);
  if (!isRangeRead) {
    const mime = detectMimeType(filePath);
    if (mime.kind === 'image' || mime.kind === 'audio') {
      const raw = await ctx.fs.readRaw(filePath, { signal: ctx.signal });
      if (raw.isBinary) {
        const size = raw.content.length;
        const canLink = canLinkFile(ctx.transport, {
          uri: buildFileResourceUri(raw.validPath),
          mimeType: raw.mimeType,
          size,
          kind: mime.kind,
        });
        return {
          content: `[binary ${mime.kind} content: ${String(raw.content.length)} bytes; returned as a ${mime.kind} content block]`,
          mimeType: raw.mimeType,
          kind: mime.kind,
          size,
          ...(canLink ? { resourceUri: buildFileResourceUri(raw.validPath) } : {}),
          modified: raw.modified,
          mediaData: raw.content.toString('base64'),
          ...(args.includeHash ? { contentHash: sha256Hex(raw.content) } : {}),
        };
      }
    }
  }

  const spec = buildReadSpec(args, ctx.signal);
  // The read re-validates and re-stats: the budget pass's stat is only a
  // size estimate, never a substitute for the guarded open.
  let result: ReadFileResult;
  try {
    result = await ctx.fs.readFile(filePath, spec);
  } catch (error: unknown) {
    if (!isBinaryRefusal(error)) throw error;
    // The schema refuses binary with a range, so this is always a full read.
    if (args.binary) return await readBinaryResource(filePath, args, ctx);
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      isRangeRead
        ? `${BINARY_FILE_MESSAGE} It has no lines; read it whole with binary: true to get it as a base64 embedded resource.`
        : `${BINARY_FILE_MESSAGE} Pass binary: true to get it as a base64 embedded resource.`,
      filePath,
      error,
    );
  }

  return buildPerPathReadValue(result, {
    includeHash: args.includeHash,
    // The continuation is args the caller pastes back, so it echoes the path
    // they wrote, or the root-resolved one a relative path was rewritten to.
    // `result.path` is the real path — on Windows that is a backslash-doubling
    // JSON string that also spells out the server root.
    requestedPath: filePath,
    transport: ctx.transport,
  });
}

export const READ = defineTool<typeof ReadFileInputSchema, BatchResult<ReadPerPathValue>>({
  name: 'read',
  title: 'Read File',
  description:
    'Read text files, like cat: whole, or one slice via head, tail, or startLine/endLine. ' +
    'Images and audio return as media; pass binary: true to get any other binary file whole as a base64 embedded resource.',
  input: ReadFileInputSchema,
  readOnlyHint: true,
  deadline: true,
  defaultErrorCode: ErrorCode.NOT_FILE,
  progress: (args) => {
    const isBatch = args.paths !== undefined;
    const name = isBatch ? `${String(args.paths?.length ?? 0)} files` : basename(args.path ?? '');
    if (isBatch) {
      return { label: READ_TOOL_LABEL, subject: name };
    }
    let scope: string | undefined;
    if (args.startLine !== undefined) {
      const end = args.endLine ?? '...';
      scope = `${args.startLine}-${String(end)}`;
    } else if (args.head !== undefined) {
      scope = `head ${args.head}`;
    } else if (args.tail !== undefined) {
      scope = `tail ${args.tail}`;
    }
    return { label: READ_TOOL_LABEL, subject: name, ...(scope ? { scope } : {}) };
  },
  mapPaths: mapSingleOrBatchPaths,
  run: async (args, ctx) => {
    const items: BudgetItem[] =
      args.paths !== undefined
        ? await collectFileBudget(
            args.paths,
            READ_MANY_MAX_TOTAL_BYTES,
            getMaxTextFileSize(),
            ctx,
            { fullRead: !hasLineRange(args), binary: args.binary },
          )
        : [{ path: args.path ?? '' }];
    const { results: ordered, summary } = await runOverPaths(
      items,
      ctx,
      ErrorCode.NOT_FILE,
      ({ path, skip }) => {
        if (skip) throw skip;
        return readOnePath(path, args, ctx);
      },
    );

    const resources: ContentBlock[] = [];
    for (const result of ordered) {
      if ('error' in result) continue;
      const v = result.value;
      if (v.blobData !== undefined && v.resourceUri !== undefined && v.mimeType !== undefined) {
        resources.push({
          type: 'resource',
          resource: { uri: v.resourceUri, mimeType: v.mimeType, blob: v.blobData },
        });
        continue;
      }
      // Image/audio full read: emit the media content block alongside the
      // structured value. The base64 lives in v.mediaData (set in readOnePath).
      if (v.mediaData && v.mimeType && (v.kind === 'image' || v.kind === 'audio')) {
        resources.push(
          v.kind === 'image'
            ? { type: 'image', data: v.mediaData, mimeType: v.mimeType }
            : { type: 'audio', data: v.mediaData, mimeType: v.mimeType },
        );
        continue;
      }
      if (!v.resourceUri || v.content === undefined) continue;
      // `result.path` is the path as *requested*; `v.resourceUri` was built from
      // the *validated* one. Rebuilding from the request would emit a second URI
      // for the same file whenever the two differ in case — subscribe by one and
      // unsubscribe by the other and the watcher never goes away.
      resources.push(
        buildFileResourceLinkFor(
          v.resourceUri,
          basename(result.path),
          v.mimeType ?? 'application/octet-stream',
          v.fileSize ?? Buffer.byteLength(v.content, 'utf8'),
          v.modified,
        ),
      );
    }

    const [firstOrdered] = ordered;
    const body = (v: PerPathReadValue): string => {
      const content = v.content ?? 'read failed';
      const trailer = readTrailer(v);
      if (trailer.length === 0) return content;
      // Exactly one blank line between the bytes and the trailer, whether or not
      // the file ended in a newline.
      return `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${trailer.join('\n')}`;
    };
    const text =
      ordered.length === 1 && firstOrdered !== undefined
        ? 'error' in firstOrdered
          ? firstOrdered.error.message
          : body(firstOrdered.value)
        : ordered
            .map((r) => {
              const header = `// ${r.path}`;
              if ('value' in r) return `${header}\n${body(r.value)}`;
              return `${header}\n// Error: ${r.error.message}`;
            })
            .join('\n\n');

    // The bytes ship once. `text` above already carries every file's content
    // verbatim (and image/audio bytes ride the media content block), so
    // repeating them under `results[].value` doubled both the wire payload and
    // the model's token cost for every read. The structured half keeps the
    // metadata a client cannot recover from the text: paths, line counts,
    // hashes, continuations, resourceUri.
    const structuredResults = ordered.map((result) => {
      if ('error' in result) return result;
      const {
        content: _content,
        fileSize: _fileSize,
        mediaData: _mediaData,
        blobData: _blobData,
        ...value
      } = result.value;
      return { ...result, value };
    });

    return {
      structured: { results: structuredResults, summary },
      text,
      isError: isTotalFailure(summary),
      ...(resources.length > 0 ? { resources } : {}),
    };
  },
  // Media and binary resources cannot be sliced, so head/tail is no remedy.
  oversizeRemedy: (result) => {
    const types = new Set(result.resources?.map((b) => b.type));
    if (types.has('image') || types.has('audio')) {
      return 'This media file is too large to return over the stdio transport; connect over HTTP, or raise it as a smaller file.';
    }
    if (types.has('resource')) {
      return 'This binary file is too large to return over the stdio transport; connect over HTTP.';
    }
    return 'Read a slice with head, tail, or startLine/endLine.';
  },
});
