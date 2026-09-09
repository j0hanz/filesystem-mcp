import type { ContentBlock } from '@modelcontextprotocol/server';

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { basename } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.js';
import { ErrorCode } from '../core/errors.js';
import { buildFileResourceLinkFor, buildFileResourceUri } from '../core/file-uri.js';
import { detectMimeFromContent, detectMimeType } from '../core/mime.js';
import type { ReadFileResult, ReadSpec } from '../core/read.js';
import { readFileWithStats } from '../core/read.js';
import {
  ContinuationSchema,
  defaultFalseBoolean,
  FileKind,
  NonNegInt,
  OperationSummarySchema,
  PerFileErrorSchema,
  PositiveInt,
  Sha256Hex,
  singleOrBatchAccessPaths,
  singleOrBatchPathsInput,
  validateReadRange,
} from '../core/schema.js';
import {
  DEFAULT_CONTINUATION_CHUNK_SIZE,
  DEFAULT_SEARCH_TIMEOUT_MS,
  getDefaultReadManyMaxTotalSize,
  getMaxTextFileSize,
  PARALLEL_CONCURRENCY,
} from '../core/util.js';
import type { PerPathResult } from './batch.js';
import { isTotalFailure, runOverPaths } from './batch.js';
import type { ToolCtx } from './define.js';
import { defineTool } from './define.js';

const rangeField = (description: string) =>
  z
    .int32()
    .min(1, { message: 'Min: 1' })
    .max(100000, { message: 'Max: 100,000' })
    .optional()
    .describe(description);

const readRangeFields = {
  head: rangeField('Return first N lines'),
  tail: rangeField('Return last N lines'),
  startLine: rangeField('Start line (1-indexed)'),
  endLine: rangeField('End line (1-indexed)'),
};

const ReadFileInputSchema = singleOrBatchPathsInput({
  includeHash: defaultFalseBoolean('Include SHA-256 hash of the returned content in the response'),
  ...readRangeFields,
})
  .superRefine((value, ctx) => {
    validateReadRange(
      {
        head: value.head,
        tail: value.tail,
        startLine: value.startLine,
        endLine: value.endLine,
      },
      ctx,
    );
  })
  // Mirror `validateReadRange` on the wire. Without this the four line params
  // published as four independent optional integers, so `{ path, head, tail }`
  // passed the advertised schema and was rejected only at call time.
  //
  // `oneOf` is restated because `.meta()` replaces the entry
  // `singleOrBatchPathsInput` set rather than merging into it — dropping it here
  // would silently un-publish the path/paths rule.
  .meta({
    // The line-param exclusivity that used to sit here as a five-branch
    // `not/anyOf` is one sentence in the description instead: validateReadRange
    // rejects every conflicting combination by name at runtime, so the wire copy
    // was paying for a second statement of a rule the model reads better in
    // prose.
    oneOf: [{ required: ['path'] }, { required: ['paths'] }],
    dependentRequired: { endLine: ['startLine'] },
  });

// File bytes are NOT here: text rides the text content block, image/audio ride
// a media block. This schema is the metadata a caller cannot recover from
// those blocks. `readOnePath` carries the bytes internally via
// `PerPathReadValue` and `run` drops them before the structured half goes out.
const ReadPerPathValueSchema = z.strictObject({
  mimeType: z.string().optional().describe('Detected MIME type (e.g. text/typescript)'),
  kind: FileKind.optional().describe('Broad file kind: text, binary, image, audio, or pdf'),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'Resource URI for externalized content (present when file is stored in resource store)',
    ),
  continuation: ContinuationSchema.optional().describe(
    'Next-read arguments; present when content was truncated due to size limits',
  ),
  totalLines: NonNegInt.optional().describe('Total line count in the full file'),
  linesRead: NonNegInt.optional().describe('Number of lines returned in this response'),
  hasMoreLines: z
    .boolean()
    .optional()
    .describe('True when additional lines remain beyond what was returned'),
  head: PositiveInt.optional().describe('Head lines requested'),
  tail: PositiveInt.optional().describe('Tail lines requested'),
  startLine: PositiveInt.optional().describe('Start line'),
  endLine: PositiveInt.optional().describe('End line'),
  contentHash: Sha256Hex.optional().describe(
    'SHA-256 hex digest of the returned content (present when includeHash=true)',
  ),
});

const ReadPerPathSchema = z.strictObject({
  path: z.string().describe('Requested file path'),
  value: ReadPerPathValueSchema.optional().describe('Read result; present on success'),
  error: PerFileErrorSchema.optional().describe('Error details; present on failure'),
});

const ReadFileOutputSchema = z.strictObject({
  results: z.array(ReadPerPathSchema).describe('Per-path results ordered to match the input paths'),
  summary: OperationSummarySchema,
});

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
function buildReadContinuation(result: {
  path: string;
  hasMoreLines?: boolean;
  linesRead?: number;
  startLine?: number;
  endLine?: number;
  head?: number;
}): z.infer<typeof ContinuationSchema> | undefined {
  if (!result.hasMoreLines) return undefined;
  const linesRead = result.linesRead ?? 0;
  const nextStart = (result.startLine ?? 1) + linesRead;
  let chunkSize: number;
  if (result.head !== undefined) {
    chunkSize = result.head;
  } else if (result.startLine !== undefined && result.endLine !== undefined) {
    chunkSize = result.endLine - result.startLine + 1;
  } else {
    chunkSize = DEFAULT_CONTINUATION_CHUNK_SIZE;
  }
  const nextEnd = nextStart + chunkSize - 1;
  return {
    tool: 'read',
    args: { path: result.path, startLine: nextStart, endLine: nextEnd },
    hint: `More lines remain from ${String(nextStart)}. Read next chunk with these args.`,
  };
}

/**
 * The published metadata plus the bytes this call read. `content` and
 * `mediaData` exist only between `readOnePath` and the content blocks `run`
 * builds from them — they are stripped before the structured half is returned,
 * which is why they are not in `ReadPerPathValueSchema`.
 */
type PerPathReadValue = z.infer<typeof ReadPerPathValueSchema> & {
  content?: string;
  mediaData?: string;
};

interface BatchFileInfo {
  index: number;
  size: number;
  validPath: string;
  stats: Stats;
}

async function collectFileBudget(
  filePaths: readonly string[],
  maxTotalSize: number,
  maxSize: number,
  ctx: Pick<ToolCtx, 'fs' | 'signal' | 'log'>,
): Promise<{
  skippedBudget: Set<number>;
  known: Map<string, { validPath: string; stats: Stats }>;
}> {
  const indexed = filePaths.map((path, index) => ({ path, index }));
  const { results } = await processInParallel(
    indexed,
    async ({ path, index }): Promise<BatchFileInfo | undefined> => {
      try {
        const out = await ctx.fs.stat(path);
        return {
          index,
          size: Math.min(out.stats.size, maxSize),
          validPath: out.validPath,
          stats: out.stats,
        };
      } catch (err: unknown) {
        ctx.log?.('debug', `collectFileBudget: stat failed for "${path}": ${String(err)}`, 'read');
        return undefined;
      }
    },
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  const byIndex = new Map<number, number>();
  const known = new Map<string, { validPath: string; stats: Stats }>();
  for (const { value: item } of results) {
    if (!item) continue;
    byIndex.set(item.index, item.size);
    // Keyed by the ORIGINAL requested path string (not validPath) — that's
    // what readOnePath is called with downstream, and what filePaths[i]
    // holds.
    const requestedPath = filePaths[item.index];
    if (requestedPath !== undefined) {
      known.set(requestedPath, { validPath: item.validPath, stats: item.stats });
    }
  }

  let total = 0;
  const skippedBudget = new Set<number>();
  for (let i = 0; i < filePaths.length; i += 1) {
    const size = byIndex.get(i);
    if (size === undefined) continue;
    if (total + size > maxTotalSize) {
      // Only mark files that were actually stat'd as too large for the batch
      // budget. A file whose stat already failed (byIndex undefined) must fall
      // through to survivors so its read surfaces the real error (NOT_FILE /
      // permission) — not a misleading TOO_LARGE.
      for (let j = i; j < filePaths.length; j += 1) {
        if (byIndex.get(j) === undefined) continue;
        skippedBudget.add(j);
      }
      break;
    }
    total += size;
  }

  return { skippedBudget, known };
}

function preFilterByBudget(
  pathList: readonly string[],
  budgetState: { skippedBudget: Set<number>; maxTotalSize: number },
): { skippedResults: Map<number, PerPathResult<PerPathReadValue>>; survivors: string[] } {
  const skippedResults = new Map<number, PerPathResult<PerPathReadValue>>();
  const survivors: string[] = [];

  for (let i = 0; i < pathList.length; i += 1) {
    const path = pathList[i];
    if (path === undefined) continue;
    if (budgetState.skippedBudget.has(i)) {
      skippedResults.set(i, {
        path,
        error: {
          code: ErrorCode.TOO_LARGE,
          message: `Skipped: combined estimated read would exceed maxTotalSize (${String(
            budgetState.maxTotalSize,
          )} bytes)`,
          path,
        },
      });
      continue;
    }
    survivors.push(path);
  }

  return { skippedResults, survivors };
}

function buildPerPathReadValue(
  result: ReadFileResult,
  options: { includeHash?: boolean; hasResourceStore?: boolean; requestedPath: string },
): PerPathReadValue {
  const mimeInfo = detectMimeFromContent(result.path, result.content);
  const continuation =
    result.hasMoreLines && result.readMode !== 'tail'
      ? buildReadContinuation({
          path: options.requestedPath,
          hasMoreLines: true,
          ...(result.linesRead !== undefined ? { linesRead: result.linesRead } : {}),
          ...(result.startLine !== undefined ? { startLine: result.startLine } : {}),
          ...(result.endLine !== undefined ? { endLine: result.endLine } : {}),
          ...(result.head !== undefined ? { head: result.head } : {}),
        })
      : undefined;
  const contentHash = options.includeHash
    ? createHash('sha256').update(result.content, 'utf-8').digest('hex')
    : undefined;
  const resourceUri = options.hasResourceStore ? buildFileResourceUri(result.path) : undefined;

  return {
    content: result.content,
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
    ...(resourceUri !== undefined ? { resourceUri } : {}),
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

async function readOnePath(
  filePath: string,
  args: ReadFileInput,
  ctx: ToolCtx,
  known?: { validPath: string; stats: Stats },
): Promise<PerPathReadValue> {
  // Image/audio full read: return a media content block instead of throwing
  // INVALID_INPUT ("Binary file detected."). Line-range reads are
  // text-oriented and stay rejected. `readRaw` enforces the same size cap as
  // the text path (getMaxTextFileSize), so a too-large image surfaces TOO_LARGE
  // rather than blowing memory. svg carries kind:'image' but is XML text —
  // readRaw.isBinary is false for it, so it falls through to the text path.
  const isRangeRead =
    args.head !== undefined ||
    args.tail !== undefined ||
    args.startLine !== undefined ||
    args.endLine !== undefined;
  if (!isRangeRead) {
    const mime = detectMimeType(filePath);
    if (mime.kind === 'image' || mime.kind === 'audio') {
      const raw = await ctx.fs.readRaw(filePath, { signal: ctx.signal });
      if (raw.isBinary) {
        return {
          content: `[binary ${mime.kind} content: ${String(raw.content.length)} bytes; returned as a ${mime.kind} content block]`,
          mimeType: raw.mimeType,
          kind: mime.kind,
          mediaData: raw.content.toString('base64'),
        };
      }
    }
  }

  const spec = buildReadSpec(args, ctx.signal);
  const result = known
    ? await readFileWithStats(filePath, known.validPath, known.stats, spec)
    : await ctx.fs.readFile(filePath, spec);

  return buildPerPathReadValue(result, {
    includeHash: args.includeHash,
    hasResourceStore: ctx.resourceStore !== undefined,
    // The continuation is args the caller pastes back, so it echoes the path
    // they wrote. `result.path` is the resolved absolute one — on Windows that
    // is a backslash-doubling JSON string that also spells out the server root.
    requestedPath: filePath,
  });
}

export const READ_FILE = defineTool({
  name: 'read',
  title: 'Read File',
  description:
    'Read one or more text files and return content. ' +
    'Partial reads: head (first N lines), tail (last N lines), startLine/endLine (line range). ' +
    'Batch mode: pass paths[] instead of path; line params are shared across all files. ' +
    'head, tail, and startLine/endLine are mutually exclusive — use exactly one.',
  input: ReadFileInputSchema,
  output: ReadFileOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
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
  accessPaths: singleOrBatchAccessPaths,
  run: async (args, ctx) => {
    let pathList: string[];
    let skippedResults = new Map<number, PerPathResult<PerPathReadValue>>();
    let survivors: string[];
    let known = new Map<string, { validPath: string; stats: Stats }>();

    if (args.paths !== undefined) {
      pathList = args.paths;
      const defaultMaxTotalSize = getDefaultReadManyMaxTotalSize();
      const maxTextFileSize = getMaxTextFileSize();
      const budget = await collectFileBudget(pathList, defaultMaxTotalSize, maxTextFileSize, ctx);
      known = budget.known;
      const filtered = preFilterByBudget(pathList, {
        skippedBudget: budget.skippedBudget,
        maxTotalSize: defaultMaxTotalSize,
      });
      skippedResults = filtered.skippedResults;
      survivors = filtered.survivors;
    } else {
      pathList = [args.path ?? ''];
      survivors = [...pathList];
    }

    const batchInput = { paths: survivors };

    // Every path can be budget-skipped (a single file over maxTotalSize does
    // it), and runOverPaths rejects an empty list. The per-path TOO_LARGE
    // results are already built — return those rather than failing the call.
    const batch =
      survivors.length === 0
        ? { results: [] as PerPathResult<PerPathReadValue>[] }
        : await runOverPaths<undefined, PerPathReadValue>(
            batchInput,
            ctx,
            ({ path }) => readOnePath(path, args, ctx, known.get(path)),
            { defaultErrorCode: ErrorCode.NOT_FILE },
          );

    const resultMap = new Map(batch.results.map((r) => [r.path, r]));
    const ordered: PerPathResult<PerPathReadValue>[] = pathList.map((path, idx) => {
      const skipped = skippedResults.get(idx);
      if (skipped) return skipped;
      const result = resultMap.get(path);
      return (
        result ?? {
          path,
          error: { code: ErrorCode.UNKNOWN, message: 'Unknown read failure' },
        }
      );
    });

    const failed = ordered.filter((r) => 'error' in r).length;
    const summary = {
      total: ordered.length,
      succeeded: ordered.length - failed,
      failed,
    };

    const resources: ContentBlock[] = [];
    for (const result of ordered) {
      if ('error' in result) continue;
      const v = result.value;
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
      if (!v.resourceUri || !v.content) continue;
      // `result.path` is the path as *requested*; `v.resourceUri` was built from
      // the *validated* one. Rebuilding from the request would emit a second URI
      // for the same file whenever the two differ in case — subscribe by one and
      // unsubscribe by the other and the watcher never goes away.
      resources.push(
        buildFileResourceLinkFor(
          v.resourceUri,
          basename(result.path),
          v.mimeType ?? 'application/octet-stream',
          Buffer.byteLength(v.content, 'utf8'),
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
      const { content: _content, mediaData: _mediaData, ...value } = result.value;
      return { ...result, value };
    });

    return {
      structured: { results: structuredResults, summary },
      text,
      isError: isTotalFailure(summary),
      ...(resources.length > 0 ? { resources } : {}),
    };
  },
});
