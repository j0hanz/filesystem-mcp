import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.ts';
import {
  BINARY_FILE_MESSAGE,
  createTooLargeError,
  ErrorCode,
  formatDetailedError,
  FsError,
  isBinaryRefusal,
} from '../core/errors.ts';
import { buildFileResourceLinkFor, buildFileResourceUri } from '../core/file-uri.ts';
import type { ReadBytesResult, ReadOptions, ReadResult, ReadTextResult } from '../core/fs.ts';
import {
  detectMimeFromContent,
  detectMimeType,
  type FileKind,
  isKnownBinaryExtension,
} from '../core/mime.ts';
import {
  base64EncodedBytes,
  canLinkFile,
  MAX_OUTBOUND_RESULT_BYTES,
  type Transport,
} from '../core/outbound.ts';
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
  head: rangeField('First N lines. Not with tail or startLine/endLine.', true),
  tail: rangeField('Last N lines. Not with head, startLine/endLine, or lineNumbers.', true),
  startLine: rangeField('First line, 1-based. Without endLine, reads to the end.'),
  endLine: rangeField('Last line, inclusive. Requires startLine.'),
};

/** A slice read: only a full read returns media or a binary resource. */
const hasLineRange = (args: ReadRange): boolean =>
  [args.head, args.tail, args.startLine, args.endLine].some((line) => line !== undefined);

const ReadFileInputSchema = singleOrBatchPathsInput({
  includeHash: defaultFalseBoolean(
    'Include SHA-256 of the returned content (the slice for a partial read).',
  ),
  binary: defaultFalseBoolean(
    'Return a non-image, non-audio binary file as a base64 resource. Whole reads only. Without it, such a file fails with BINARY_FILE.',
  ),
  lineNumbers: defaultFalseBoolean(
    'Prefix each line with its number and a tab. Not with tail. Leave the prefix out of edit text.',
  ),
  ...readRangeFields,
}).superRefine((value, ctx) => {
  validateReadRange(value, ctx);
  if (value.lineNumbers && value.tail !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['lineNumbers'],
      message: "Cannot use 'lineNumbers' with 'tail': a tail read does not count lines.",
      input: value,
    });
  }
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
  args: { path: string; startLine: number; endLine: number; lineNumbers?: true };
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

function buildReadOptions(args: ReadFileInput, signal?: AbortSignal): ReadOptions {
  const base = {
    ...(signal ? { signal } : {}),
    ...(args.paths !== undefined && hasLineRange(args)
      ? { maxSize: READ_MANY_MAX_TOTAL_BYTES, hardCap: true }
      : {}),
  };
  const { head, tail, startLine, endLine } = args;

  if (head !== undefined) return { slice: { kind: 'head', lines: head }, ...base };
  if (tail !== undefined) return { slice: { kind: 'tail', lines: tail }, ...base };
  if (startLine !== undefined || endLine !== undefined) {
    return {
      slice: {
        kind: 'range',
        start: startLine ?? 1,
        ...(endLine !== undefined ? { end: endLine } : {}),
      },
      ...base,
    };
  }
  // A full read returns image/audio as a media block; binary: true also returns other binary.
  return { binary: args.binary ? 'allow' : 'media', ...base };
}

// No `totalLines`: only `readFull` counts them and a full read never leaves
// more behind, so a continuation cannot know the total without a second pass.
function buildReadContinuation(
  result: ReadTextResult,
  requestedPath: string,
  lineNumbers: boolean,
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
    args: {
      path: requestedPath,
      startLine: nextStart,
      endLine: nextEnd,
      ...(lineNumbers ? { lineNumbers: true as const } : {}),
    },
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
  binary: boolean;
}

/**
 * What a full read costs the batch: base64 size for media/binary, raw size otherwise.
 */
function budgetBytes(path: string, size: number, { binary }: BudgetMode): number {
  const { kind } = detectMimeType(path);
  const base64 = kind === 'image' || kind === 'audio' || (binary && isKnownBinaryExtension(path));
  return base64 ? base64EncodedBytes(size) : size;
}

const SLICE_SKIP_SUGGESTION = 'Read it on its own with path, or ask for fewer lines.';

function budgetSkip(path: string, maxTotalSize: number, suggestion?: string): FsError {
  // undefined falls back to the TOO_LARGE default via the constructor's default param.
  return new FsError(
    ErrorCode.TOO_LARGE,
    `Skipped: this file would push the batch past maxTotalSize (${String(maxTotalSize)} bytes). Read it alone with path, not paths.`,
    path,
    undefined,
    suggestion,
  );
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
      return { path, skip: budgetSkip(path, maxTotalSize) };
    }
    total += size;
    return { path };
  });
}

function buildPerPathReadValue(
  result: ReadTextResult,
  options: {
    includeHash?: boolean;
    lineNumbers: boolean;
    requestedPath: string;
    transport: Transport;
  },
): PerPathReadValue {
  const mimeInfo = detectMimeFromContent(result.path, result.content);
  const continuation =
    result.hasMoreLines && result.readMode !== 'tail'
      ? buildReadContinuation(result, options.requestedPath, options.lineNumbers)
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
 * `cat -n` for `read`. `count` decides what is a line: a final newline ends one
 * in a whole file but separates a blank last line in a slice, and the text alone
 * cannot tell them apart.
 */
function numberLines(content: string, firstLine: number, count: number): string {
  return content
    .split('\n')
    .map((line, i) => (i < count ? `${String(firstLine + i)}\t${line}` : line))
    .join('\n');
}

/** What numbering adds: a tab per line plus each line number's digits, counted without building them. */
function numberingBytes(firstLine: number, count: number): number {
  const last = firstLine + count - 1;
  let bytes = count;
  for (let digits = 1, floor = 1; floor <= last; digits++, floor *= 10) {
    const lines = Math.min(last, floor * 10 - 1) - Math.max(firstLine, floor) + 1;
    if (lines > 0) bytes += lines * digits;
  }
  return bytes;
}

/**
 * Numbering a newline-heavy file multiplies it many times over, so refuse before
 * building the text: the executor's size refusal only runs after it exists.
 */
function assertNumberingFits(result: ReadTextResult, filePath: string, transport: Transport): void {
  const max = getMaxTextFileSize();
  const limit = transport === 'stdio' ? Math.min(max, MAX_OUTBOUND_RESULT_BYTES) : max;
  const bytes =
    Buffer.byteLength(result.content, 'utf8') +
    numberingBytes(result.startLine ?? 1, result.linesRead ?? 0);
  if (bytes > limit) {
    throw createTooLargeError(bytes, limit, filePath, {
      label: 'with line numbers',
      suggestion: 'Read a slice with head or startLine/endLine, or leave out lineNumbers.',
    });
  }
}

/** A partial read the size limit cut short, as opposed to a slice returned whole. */
function wasCut(v: PerPathReadValue): boolean {
  const asked =
    v.head ??
    v.tail ??
    (v.startLine !== undefined && v.endLine !== undefined
      ? v.endLine - v.startLine + 1
      : undefined);
  return asked === undefined || (v.linesRead ?? 0) < asked;
}

/**
 * The two facts the model cannot act on without: that lines remain, and the
 * exact args to get the next chunk. Both used to live only in the structured
 * half, which no longer reaches the model. `truncated` means the size limit cut
 * the read; a slice returned as asked only says more lines remain. Each line is
 * `//` prefixed and set off by a blank line so it cannot be read as file bytes —
 * do not drop either guard.
 */
function readTrailer(v: PerPathReadValue): string[] {
  const lines: string[] = [];
  if (v.continuation) {
    const args = JSON.stringify(v.continuation.args);
    lines.push(
      wasCut(v)
        ? `// truncated: ${v.continuation.hint} Continue: read ${args}`
        : `// more lines from ${String(v.continuation.args.startLine)}. Continue: read ${args}`,
    );
  } else if (v.hasMoreLines && v.linesRead !== undefined) {
    // A tail read gets no continuation — there are no args that read *backwards*
    // — so say what was shown rather than leaving the rest silent.
    lines.push(
      wasCut(v)
        ? `// truncated: showing last ${String(v.linesRead)} lines`
        : `// more lines above: showing last ${String(v.linesRead)} lines`,
    );
  } else if (v.startLine !== undefined && v.linesRead === 0) {
    lines.push(`// no lines at or after line ${String(v.startLine)}`);
  }
  if (v.contentHash !== undefined) {
    const slice = v.head !== undefined || v.tail !== undefined || v.startLine !== undefined;
    lines.push(`// sha256${slice ? ' (slice)' : ''}: ${v.contentHash}`);
  }
  return lines;
}

/** A full read's bytes: image/audio as a media block, other binary as an embedded resource. */
function bytesReadValue(
  raw: ReadBytesResult,
  args: ReadFileInput,
  transport: Transport,
): PerPathReadValue {
  const size = raw.content.length;
  const uri = buildFileResourceUri(raw.validPath);
  const contentHash = args.includeHash ? { contentHash: sha256Hex(raw.content) } : {};
  if (raw.kind === 'image' || raw.kind === 'audio') {
    const canLink = canLinkFile(transport, { uri, mimeType: raw.mimeType, size, kind: raw.kind });
    return {
      content: `[binary ${raw.kind} content: ${String(size)} bytes; returned as a ${raw.kind} content block]`,
      mimeType: raw.mimeType,
      kind: raw.kind,
      size,
      ...(canLink ? { resourceUri: uri } : {}),
      modified: raw.modified,
      mediaData: raw.content.toString('base64'),
      ...contentHash,
    };
  }
  return {
    content: `[binary ${raw.kind} content: ${String(size)} bytes (${raw.mimeType}); returned as an embedded resource block]`,
    mimeType: raw.mimeType,
    kind: raw.kind,
    size,
    // Not gated by canLinkFile: the embedded block needs it, and a blob too
    // large for stdio makes refuseOversized refuse the whole result anyway.
    resourceUri: uri,
    modified: raw.modified,
    blobData: raw.content.toString('base64'),
    ...contentHash,
  };
}

async function readOnePath(
  filePath: string,
  args: ReadFileInput,
  ctx: ToolCtx,
): Promise<PerPathReadValue> {
  // One guarded open: read classifies the file from its leading bytes and
  // either returns its bytes (media, or any binary with binary: true) or its
  // text. A line slice is text only, so binary is refused there.
  const isRangeRead = hasLineRange(args);
  let result: ReadResult;
  try {
    result = await ctx.fs.read(filePath, buildReadOptions(args, ctx.signal));
  } catch (error: unknown) {
    if (
      args.paths !== undefined &&
      isRangeRead &&
      error instanceof FsError &&
      error.code === ErrorCode.TOO_LARGE
    ) {
      throw budgetSkip(filePath, READ_MANY_MAX_TOTAL_BYTES, SLICE_SKIP_SUGGESTION);
    }
    if (!isBinaryRefusal(error)) throw error;
    throw new FsError(
      ErrorCode.BINARY_FILE,
      isRangeRead
        ? `${BINARY_FILE_MESSAGE} It has no lines. Read it whole with binary: true to get a base64 embedded resource.`
        : `${BINARY_FILE_MESSAGE} Pass binary: true to get a base64 embedded resource.`,
      filePath,
      error,
    );
  }
  if (result.type === 'bytes') return bytesReadValue(result, args, ctx.transport);

  if (args.lineNumbers) assertNumberingFits(result, filePath, ctx.transport);

  return buildPerPathReadValue(result, {
    includeHash: args.includeHash,
    lineNumbers: args.lineNumbers,
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
    'Read one file or up to 1000, whole or as a line slice. ' +
    'Use when you know the path. ' +
    'Do not use it to check size or existence; use `stat` instead. ' +
    'To locate content, use `search_text`, `find_files`, or `list`. ' +
    'Only whole reads return images and audio as media; other binary files fail with BINARY_FILE unless binary: true. ' +
    'Past the size limit, a whole read fails with TOO_LARGE; a single-path head or range is truncated. ' +
    'A batch shares a 512 KiB budget: an overflowing file is skipped and later files still read. isError means every path failed. ' +
    'Pick one slice (head, tail, or startLine/endLine); it applies to every batch file. ' +
    'Returns text plus per-path results[]: an error, or linesRead, hasMoreLines, continuation args, modified, optional contentHash. ' +
    'Full reads add totalLines; a tail gets no continuation.',
  input: ReadFileInputSchema,
  // Claude Code spills a text result over 50,000 characters to a file, which
  // may sit outside the roots where this server's own tools cannot read it.
  listMeta: { 'anthropic/maxResultSizeChars': 200_000 },
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
    const slice = args.paths !== undefined && hasLineRange(args);
    const rawItems: BudgetItem[] =
      args.paths === undefined
        ? [{ path: args.path ?? '' }]
        : slice
          ? args.paths.map((path) => ({ path }))
          : await collectFileBudget(
              args.paths,
              READ_MANY_MAX_TOTAL_BYTES,
              getMaxTextFileSize(),
              ctx,
              {
                binary: args.binary,
              },
            );
    const items = rawItems.map((item, index) => ({ ...item, index }));
    let charged = 0;
    let nextToCharge = 0;
    const waiters = new Map<number, () => void>();
    const waitForTurn = (index: number): Promise<void> =>
      nextToCharge === index
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.set(index, resolve);
          });
    const advanceTurn = (): void => {
      nextToCharge += 1;
      const wake = waiters.get(nextToCharge);
      if (wake) {
        waiters.delete(nextToCharge);
        wake();
      }
    };
    const { results: ordered, summary } = await runOverPaths(
      items,
      ctx,
      ErrorCode.NOT_FILE,
      async ({ path, skip, index }) => {
        let value: PerPathReadValue | undefined;
        try {
          if (skip) throw skip;
          value = await readOnePath(path, args, ctx);
        } finally {
          if (slice) {
            await waitForTurn(index);
            if (value !== undefined) {
              const size = Buffer.byteLength(value.content ?? '', 'utf8');
              if (charged + size <= READ_MANY_MAX_TOTAL_BYTES) {
                charged += size;
              } else {
                value = undefined;
              }
            }
            advanceTurn();
          }
        }
        if (value === undefined) {
          throw budgetSkip(path, READ_MANY_MAX_TOTAL_BYTES, SLICE_SKIP_SUGGESTION);
        }
        return value;
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
      const bytes = v.content ?? 'read failed';
      // A media or binary placeholder is a note about the file, not its lines.
      const content =
        args.lineNumbers && v.mediaData === undefined && v.blobData === undefined
          ? numberLines(bytes, v.startLine ?? 1, v.linesRead ?? 0)
          : bytes;
      const trailer = readTrailer(v);
      if (trailer.length === 0) return content;
      // Exactly one blank line between the bytes and the trailer, whether or not
      // the file ended in a newline.
      return `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${trailer.join('\n')}`;
    };
    const text =
      ordered.length === 1 && firstOrdered !== undefined
        ? 'error' in firstOrdered
          ? formatDetailedError(firstOrdered.error)
          : body(firstOrdered.value)
        : ordered
            .map((r) => {
              const header = `// ${r.path}`;
              if ('value' in r) return `${header}\n${body(r.value)}`;
              const { code, message, suggestion } = r.error;
              const next = suggestion ? `\n// ${suggestion}` : '';
              return `${header}\n// Error: ${code}: ${message}${next}`;
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
      return 'This media file is too large for the stdio transport. Connect over HTTP, or use a smaller file.';
    }
    if (types.has('resource')) {
      return 'This binary file is too large for the stdio transport. Connect over HTTP.';
    }
    return 'Read a slice with head, tail, or startLine/endLine.';
  },
});
