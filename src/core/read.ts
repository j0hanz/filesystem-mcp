// File reading pipeline split out of fs.ts. fs.ts imports from here; never the reverse.
import type { Stats } from 'node:fs';
import { open as fsOpen } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

import { withAbort } from './concurrency.js';
import { ErrorCode, formatUnknownErrorMessage, FsError, isFsError } from './errors.js';
import { isBinarySample, isKnownBinaryExtension, MIME_SAMPLE_SIZE } from './mime.js';
import { Logger } from './observability.js';
import { getMaxTextFileSize } from './util.js';

const STREAM_CHUNK_SIZE = 64 * 1024;

const READ_ONLY_FILE_FLAG = 'r';

function assertPositiveIntegerOption(name: string, value: unknown, message?: string): void {
  if (
    value === undefined ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1)
  )
    return;
  throw new FsError(ErrorCode.INVALID_INPUT, message ?? `${name} must be a positive integer`);
}

async function openReadableFileHandle(filePath: string, signal?: AbortSignal): Promise<FileHandle> {
  const handlePromise = fsOpen(filePath, READ_ONLY_FILE_FLAG);
  if (!signal) return handlePromise;
  try {
    return await withAbort(handlePromise, signal);
  } catch (error) {
    void handlePromise
      .then((handle) => {
        void handle.close().catch((closeErr: unknown) => {
          Logger.warn(
            `Failed to close file handle for ${filePath} after abort: ${formatUnknownErrorMessage(closeErr)}`,
          );
        });
      })
      .catch(() => {
        /* ignore open error */
      });
    throw error;
  }
}

async function readProbe(handle: FileHandle, signal?: AbortSignal): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MIME_SAMPLE_SIZE);
  const { bytesRead } = await withAbort(handle.read(buffer, 0, MIME_SAMPLE_SIZE, 0), signal);

  if (bytesRead === 0) {
    return Buffer.alloc(0);
  }

  return buffer.subarray(0, bytesRead);
}

async function isProbablyBinary(
  filePath: string,
  existingHandle?: FileHandle,
  signal?: AbortSignal,
): Promise<boolean> {
  if (isKnownBinaryExtension(filePath)) {
    return true;
  }

  if (existingHandle) {
    const slice = await readProbe(existingHandle, signal);
    return isBinarySample(slice);
  }

  await using handle = await openReadableFileHandle(filePath, signal);
  const slice = await readProbe(handle, signal);
  return isBinarySample(slice);
}

export type ReadSpec =
  | { kind: 'full'; signal?: AbortSignal }
  | { kind: 'head'; lines: number; signal?: AbortSignal }
  | { kind: 'tail'; lines: number; signal?: AbortSignal }
  | { kind: 'range'; start: number; end?: number; signal?: AbortSignal };

interface NormalizedBase {
  maxSize: number;
  signal?: AbortSignal;
}

type NormalizedSpec =
  | (NormalizedBase & { kind: 'full' })
  | (NormalizedBase & { kind: 'head'; lines: number })
  | (NormalizedBase & { kind: 'tail'; lines: number })
  | (NormalizedBase & { kind: 'range'; start: number; end?: number });

interface PartialReadResult {
  content: string;
  linesRead: number;
  hasMoreLines: boolean;
}

export interface ReadFileResult {
  path: string;
  content: string;
  totalLines?: number;
  readMode: ReadSpec['kind'];
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  linesRead?: number;
  hasMoreLines?: boolean;
}

function buildBaseOptions(spec: ReadSpec): NormalizedBase {
  return {
    maxSize: getMaxTextFileSize(),
    ...(spec.signal ? { signal: spec.signal } : {}),
  };
}

function normalizeRangeSpec(
  spec: Extract<ReadSpec, { kind: 'range' }>,
  base: NormalizedBase,
): NormalizedSpec {
  assertPositiveIntegerOption('start', spec.start, 'start must be at least 1');
  if (spec.end !== undefined) {
    assertPositiveIntegerOption('end', spec.end, 'end must be at least 1');
    if (spec.end < spec.start) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'end must be greater than or equal to start (default: 1)',
      );
    }
  }
  return {
    ...base,
    kind: 'range',
    start: spec.start,
    ...(spec.end !== undefined ? { end: spec.end } : {}),
  };
}

export function normalizeSpec(spec: ReadSpec): NormalizedSpec {
  const base = buildBaseOptions(spec);
  spec.signal?.throwIfAborted();

  switch (spec.kind) {
    case 'head':
    case 'tail':
      assertPositiveIntegerOption('lines', spec.lines, 'lines must be at least 1');
      return { ...base, kind: spec.kind, lines: spec.lines };
    case 'range':
      return normalizeRangeSpec(spec, base);
    case 'full':
      return { ...base, kind: 'full' };
    default: {
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
}

export function createTooLargeError(
  bytesRead: number,
  maxSize: number,
  requestedPath: string,
): FsError {
  return new FsError(
    ErrorCode.TOO_LARGE,
    `File exceeds size limit (${bytesRead} > ${maxSize} bytes)`,
    requestedPath,
  );
}

export async function readFileBufferWithLimit(
  handle: FileHandle,
  maxSize: number,
  requestedPath: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const stream = handle.createReadStream({
    start: 0,
    highWaterMark: STREAM_CHUNK_SIZE,
    autoClose: false,
    emitClose: false,
    signal,
  });

  const chunks: Buffer[] = [];
  let totalSize = 0;

  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      totalSize += buffer.length;

      if (totalSize > maxSize) {
        stream.destroy();
        throw createTooLargeError(totalSize, maxSize, requestedPath);
      }

      chunks.push(buffer);
    }
  } finally {
    if (!stream.destroyed) {
      stream.on('error', (_err: unknown) => {
        /* suppress post-destroy error event */
      });
      stream.destroy();
    }
  }

  return Buffer.concat(chunks, totalSize);
}

export const countLines = (content: string): number => {
  if (content.length === 0) return 0;
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  return trimmed.split('\n').length;
};

async function peekHasMore(iterator: AsyncIterator<string>): Promise<boolean> {
  try {
    const { done } = await iterator.next();
    return !done;
  } catch (error) {
    // The peek only asks "is there another line", and the caller keeps nothing
    // it returns. An over-long line past the requested range still answers yes
    // — failing the whole read over a line outside it would reject e.g. lines
    // 1-2 of a file whose line 3 is one 50 KB blob.
    if (isFsError(error) && error.code === ErrorCode.TOO_LARGE) return true;
    throw error;
  }
}

const LF = 0x0a;

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Line iterator bounded by bytes rather than by the decoded string, so a file
 * that is one enormous line cannot be materialized before the size check runs.
 * `handle.readLines` decodes the whole line first and can OOM on such a file.
 *
 * Yields lines from `startLine` onward, 1-indexed. Lines before `startLine` are
 * counted and discarded without accumulating, so an over-long line the caller
 * skipped past does not fail the read. Line endings match `readLines`: split on
 * `\n`, with a preceding `\r` stripped, so CRLF input decodes identically.
 */
async function* readLinesBounded(
  handle: FileHandle,
  options: NormalizedBase,
  filePath: string,
  startLine: number,
): AsyncGenerator<string, void, undefined> {
  const stream = handle.createReadStream({
    start: 0,
    highWaterMark: STREAM_CHUNK_SIZE,
    autoClose: false,
    emitClose: false,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const decoder = new StringDecoder('utf-8');
  let pending = '';
  let pendingBytes = 0;
  let lineNumber = 0;

  const tooLong = (bytes: number): FsError =>
    new FsError(
      ErrorCode.TOO_LARGE,
      `File too large (single line ${bytes} > ${options.maxSize} bytes). Use a narrower range or head.`,
      filePath,
    );

  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      let offset = 0;

      // Search loop: each iteration finds the next LF and advances offset past
      // it. Written as while-with-assignment so the re-search is visible, rather
      // than buried in a for "increment" slot that re-runs indexOf.
      let nl = buffer.indexOf(LF, offset);
      while (nl !== -1) {
        const segment = buffer.subarray(offset, nl);
        const lineBytes = pendingBytes + segment.length;
        lineNumber++;
        // Decode even when skipping: the decoder carries multi-byte
        // continuation state into the first line the caller keeps.
        const decoded = decoder.write(segment);
        if (lineNumber >= startLine) {
          if (lineBytes > options.maxSize) throw tooLong(lineBytes);
          yield stripCarriageReturn(pending + decoded);
        }
        pending = '';
        pendingBytes = 0;
        offset = nl + 1;
        nl = buffer.indexOf(LF, offset);
      }

      const rest = buffer.subarray(offset);
      pendingBytes += rest.length;
      if (lineNumber + 1 < startLine) {
        decoder.write(rest); // still skipping; drop the text, keep decoder state
      } else {
        if (pendingBytes > options.maxSize) throw tooLong(pendingBytes);
        pending += decoder.write(rest);
      }
    }

    // Trailing line with no final newline. A file ending in `\n` leaves
    // pendingBytes at 0 and emits nothing, matching readLines.
    if (pendingBytes > 0) {
      lineNumber++;
      if (lineNumber >= startLine) {
        if (pendingBytes > options.maxSize) throw tooLong(pendingBytes);
        yield pending + decoder.end();
      }
    }
  } finally {
    if (!stream.destroyed) {
      stream.on('error', (_err: unknown) => {
        /* suppress post-destroy error event */
      });
      stream.destroy();
    }
  }
}

async function readRangeContent(
  handle: FileHandle,
  startLine: number,
  endLine: number | undefined,
  options: NormalizedBase,
  filePath: string,
): Promise<PartialReadResult> {
  options.signal?.throwIfAborted();

  const lines: string[] = [];
  let lineNumber = startLine - 1;
  let estimatedBytes = 0;
  const newlineBytes = Buffer.byteLength('\n', 'utf-8');
  const stopAt = endLine ?? Number.POSITIVE_INFINITY;

  let hasMoreLines = false;

  // Byte-bounded: an over-long line throws TOO_LARGE while still a partial
  // buffer, before it can be decoded into one huge string.
  const iterator = readLinesBounded(handle, options, filePath, startLine)[Symbol.asyncIterator]();

  try {
    for (;;) {
      const { value: line, done } = await iterator.next();
      if (done) {
        break;
      }
      lineNumber++;

      if (lineNumber > stopAt) {
        hasMoreLines = true;
        break;
      }

      lines.push(line);

      estimatedBytes += Buffer.byteLength(line, 'utf-8') + newlineBytes;
      if (estimatedBytes > options.maxSize) {
        hasMoreLines = await peekHasMore(iterator);
        break;
      }

      if (lineNumber === stopAt) {
        hasMoreLines = await peekHasMore(iterator);
        break;
      }
    }
  } finally {
    await iterator.return();
  }

  return {
    content: lines.join('\n'),
    linesRead: lines.length,
    hasMoreLines,
  };
}

async function readTailContent(
  handle: FileHandle,
  tail: number,
  options: NormalizedBase,
  filePath: string,
): Promise<PartialReadResult> {
  options.signal?.throwIfAborted();

  const stats = await handle.stat();
  const fileSize = stats.size;
  if (fileSize === 0) {
    return {
      content: '',
      linesRead: 0,
      hasMoreLines: false,
    };
  }

  const encoding = 'utf-8';
  // Accumulate raw bytes from the end: decoding a chunk ending mid-codepoint
  // corrupts the trailing UTF-8 sequence into U+FFFD. 0x0A is single-byte and
  // never part of a multibyte sequence, so count newlines on the raw buffer and
  // decode the whole bounded buffer once at the end.
  let position = fileSize;
  const chunks: Buffer[] = [];
  let totalLen = 0;
  let newlines = 0;
  let stoppedByLimit = false;

  while (position > 0) {
    options.signal?.throwIfAborted();
    const chunkSize = Math.min(position, STREAM_CHUNK_SIZE);
    const buffer = Buffer.allocUnsafe(chunkSize);
    const { bytesRead } = await handle.read(buffer, 0, chunkSize, position - chunkSize);
    if (bytesRead < chunkSize) {
      // The file shrank under us. Bytes from `position` on are still a
      // contiguous suffix, so keep those and stop — splicing this short chunk in
      // would leave a hole (and, with an alloc'd buffer, NULs) mid-content.
      // `position` stays put, so the result is reported as having more lines.
      break;
    }
    position -= chunkSize;

    for (const byte of buffer) {
      if (byte === 0x0a) newlines++;
    }

    chunks.unshift(buffer);
    totalLen += chunkSize;

    // One newline more than `tail`: the oldest segment in the buffer starts
    // mid-line whenever we stop before the file start, and gets dropped below.
    if (newlines > tail) break;
    if (totalLen > options.maxSize) {
      stoppedByLimit = true;
      break;
    }
  }

  const allBytes = Buffer.concat(chunks, totalLen);
  let lines = allBytes.toString(encoding).split('\n');

  // A trailing newline produces a spurious empty final segment; drop it.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1);
  }
  // Normalize CRLF.
  lines = lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

  // We stopped before the file start, so the first segment is the tail of a
  // line whose beginning was never read. Drop it instead of reporting a
  // fragment as a complete line.
  if (position > 0 && lines.length > 0) {
    lines = lines.slice(1);
  }

  if (stoppedByLimit && lines.length < tail) {
    throw new FsError(
      ErrorCode.TOO_LARGE,
      `File too large (${totalLen} > ${options.maxSize} bytes, could not collect ${tail} lines). Use a narrower tail or head.`,
      filePath,
    );
  }

  let hasMoreLines = stoppedByLimit || position > 0;
  if (lines.length > tail) {
    hasMoreLines = true;
    lines = lines.slice(lines.length - tail);
  }

  const content = lines.join('\n');
  return {
    content,
    linesRead: lines.length,
    hasMoreLines,
  };
}

async function readFullContent(
  handle: FileHandle,
  maxSize: number,
  requestedPath: string,
  signal?: AbortSignal,
): Promise<{ content: string; totalLines: number }> {
  const buffer = await readFileBufferWithLimit(handle, maxSize, requestedPath, signal);
  const content = buffer.toString('utf-8');
  return { content, totalLines: countLines(content) };
}

async function assertNotBinary(
  validPath: string,
  filePath: string,
  handle: FileHandle,
  normalized: NormalizedBase,
): Promise<void> {
  normalized.signal?.throwIfAborted();
  const isBinary = await isProbablyBinary(validPath, handle, normalized.signal);
  if (!isBinary) return;
  throw new FsError(ErrorCode.INVALID_INPUT, 'Binary file detected.', filePath);
}

function assertSizeWithinLimit(size: number, maxSize: number, filePath: string): void {
  if (size <= maxSize) return;
  throw new FsError(
    ErrorCode.TOO_LARGE,
    `File too large (${size} > ${maxSize} bytes). Use head to preview.`,
    filePath,
  );
}

interface ReadModeContext {
  handle: FileHandle;
  validPath: string;
  filePath: string;
  stats: Stats;
  spec: NormalizedSpec;
}

async function readHead(
  context: ReadModeContext,
  spec: Extract<NormalizedSpec, { kind: 'head' }>,
): Promise<ReadFileResult> {
  const { content, linesRead, hasMoreLines } = await readRangeContent(
    context.handle,
    1,
    spec.lines,
    spec,
    context.filePath,
  );

  return {
    path: context.validPath,
    content,
    readMode: 'head',
    head: spec.lines,
    linesRead,
    hasMoreLines,
  };
}

async function readRange(
  context: ReadModeContext,
  spec: Extract<NormalizedSpec, { kind: 'range' }>,
): Promise<ReadFileResult> {
  const { content, linesRead, hasMoreLines } = await readRangeContent(
    context.handle,
    spec.start,
    spec.end,
    spec,
    context.filePath,
  );

  return {
    path: context.validPath,
    content,
    readMode: 'range',
    startLine: spec.start,
    ...(spec.end !== undefined ? { endLine: spec.end } : {}),
    linesRead,
    hasMoreLines,
  };
}

async function readFull(
  context: ReadModeContext,
  spec: Extract<NormalizedSpec, { kind: 'full' }>,
): Promise<ReadFileResult> {
  assertSizeWithinLimit(context.stats.size, spec.maxSize, context.filePath);
  const { content, totalLines } = await readFullContent(
    context.handle,
    spec.maxSize,
    context.filePath,
    spec.signal,
  );

  return {
    path: context.validPath,
    content,
    totalLines,
    readMode: 'full',
    linesRead: totalLines,
    hasMoreLines: false,
  };
}

async function readTail(
  context: ReadModeContext,
  spec: Extract<NormalizedSpec, { kind: 'tail' }>,
): Promise<ReadFileResult> {
  const { content, linesRead, hasMoreLines } = await readTailContent(
    context.handle,
    spec.lines,
    spec,
    context.validPath,
  );

  return {
    path: context.validPath,
    content,
    readMode: 'tail',
    tail: spec.lines,
    linesRead,
    hasMoreLines,
  };
}

async function readByMode(context: ReadModeContext): Promise<ReadFileResult> {
  switch (context.spec.kind) {
    case 'head':
      return readHead(context, context.spec);
    case 'range':
      return readRange(context, context.spec);
    case 'full':
      return readFull(context, context.spec);
    case 'tail':
      return readTail(context, context.spec);
    default: {
      const _exhaustive: never = context.spec;
      return _exhaustive;
    }
  }
}

export function assertFileStats(filePath: string, stats: Stats): void {
  if (!stats.isFile()) {
    throw new FsError(ErrorCode.NOT_FILE, 'Not a regular file', filePath);
  }
}

export async function readNormalized(
  filePath: string,
  validPath: string,
  stats: Stats,
  spec: NormalizedSpec,
): Promise<ReadFileResult> {
  spec.signal?.throwIfAborted();

  assertFileStats(filePath, stats);

  await using handle = await openReadableFileHandle(validPath, spec.signal);

  await assertNotBinary(validPath, filePath, handle, spec);
  spec.signal?.throwIfAborted();

  return await readByMode({ handle, validPath, filePath, stats, spec });
}

export async function readFileWithStats(
  filePath: string,
  validPath: string,
  stats: Stats,
  spec: ReadSpec | undefined,
): Promise<ReadFileResult> {
  return readNormalized(filePath, validPath, stats, normalizeSpec(spec ?? { kind: 'full' }));
}
