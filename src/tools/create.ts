import type { ContentBlock } from '@modelcontextprotocol/server';
import { type InputRequiredResult, isInputRequiredResult } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { getMaxTextFileSize } from '../core/config.ts';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  isRefusal,
  Problem,
} from '../core/errors.ts';
import { buildWrittenFileMeta, writtenFileLinks, type WrittenFileMeta } from '../core/file-uri.ts';
import type { CreatePlan, Stats } from '../core/fs.ts';
import { detectMimeFromContent, type FileKind } from '../core/mime.ts';
import { isEquivalentPath, isPathInsideDirectory, normalizePath } from '../core/path-utils.ts';
import { modifiedAfterWrite, statAfterWrite } from '../core/rewrite.ts';
import { RequiredPath } from '../core/schema.ts';
import {
  type BatchResult,
  type BatchSlot,
  executeBatchSlots,
  isTotalFailure,
  planBatch,
  repeatedEntry,
} from './batch.ts';
import { defineTool, type ToolCtx } from './define.ts';

const EPOCH = new Date(0);

const CreateFileItemSchema = z.strictObject({
  path: RequiredPath.describe(
    'File path inside a writable root, absolute or relative to it; one entry per file.',
  ),
  content: z
    .string()
    .refine((val) => Buffer.byteLength(val, 'utf8') <= getMaxTextFileSize(), {
      error: 'Content is over the text file size limit',
    })
    .describe('Full text to write, verbatim, as UTF-8.'),
  append: z
    .boolean()
    .optional()
    .describe(
      'Add content to the end, starting a new line if needed; creates a missing file. Never asks; wins over overwrite. lineCount is 0 past FS_MAX_FILE_SIZE.',
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      'Replace an existing file without asking. Without it, a client that cannot show the prompt fails the whole call with INVALID_INPUT.',
    ),
});

type CreateFileResult = Omit<WrittenFileMeta, 'resourceLink'> & {
  path: string;
  created: string;
  modified: string;
};

const CreateInputSchema = z
  .strictObject({
    files: z
      .array(CreateFileItemSchema)
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Files to write. Give files, directories, or both. Combined content per call is at most FS_MAX_FILE_SIZE (default 10 MiB).',
      ),
    directories: z
      .array(RequiredPath)
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Empty directories, created recursively; an existing directory succeeds; a path also listed in files is rejected.',
      ),
  })
  .superRefine((value, ctx) => {
    if (value.files === undefined && value.directories === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'Provide files, directories, or both',
        input: value,
      });
    }
    const files = value.files ?? [];
    const dirs = value.directories ?? [];
    for (const [fileIndex, file] of files.entries()) {
      const normFile = normalizePath(file.path);
      const dirIndex = dirs.findIndex((dir) => {
        const normDir = normalizePath(dir);
        return isEquivalentPath(normDir, normFile) || isPathInsideDirectory(normFile, normDir);
      });
      if (dirIndex !== -1) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', fileIndex, 'path'],
          message: `conflicts with directories[${String(dirIndex)}]; path cannot be both a file and a directory`,
          input: value,
        });
      }
    }
    // One call's content is what one inbound message carries; the transports
    // size their message bound from this same limit (getMaxInboundMessageBytes),
    // so a batch that passes here always fits on the wire. Counted in UTF-8 bytes,
    // like the per-file refine above and like read/edit measure the file on disk.
    const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
    const limit = getMaxTextFileSize();
    if (total > limit) {
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: `combined content is ${String(total)} bytes; the limit per call is ${String(limit)} (FS_MAX_FILE_SIZE). Split the batch.`,
        input: value,
      });
    }
  });

interface CreateFailureItem {
  path: string;
  error: Problem;
}

interface CreateOutput {
  files: CreateFileResult[];
  directories?: string[];
  failures?: CreateFailureItem[];
  skipped?: string[];
}

type CreateInput = z.infer<typeof CreateInputSchema>;
type CreateFileItem = z.infer<typeof CreateFileItemSchema>;

export const CREATE = defineTool<typeof CreateInputSchema, CreateOutput>({
  name: 'create',
  title: 'Create Files',
  description:
    'Write whole text files (new, overwrite, or append) and create empty directories, with missing parents. ' +
    'Use when you have full content or need folders. ' +
    'Do not use it for partial edits; use `edit`, `replace_text`, or `patch` instead, and `move` to copy or rename. ' +
    'Whole-file writes are atomic (temp file, then rename); appends are not. ' +
    'An existing file is replaced only with overwrite: true or after one user confirmation for the batch; nothing is written before the answer. ' +
    'Declined entries fail with CANCELLED; skipped ones land in skipped. ' +
    'Entries fail alone; the call errors only when all fail. ' +
    'Returns files (path, size, lineCount, mimeType, kind, resourceUri, created, modified), directories, failures, skipped, and an undo id for `undo` (30 min), or undoUnavailable.',
  input: CreateInputSchema,
  readOnlyHint: false,
  mapPaths: (args, fn) => ({
    ...args,
    ...(args.files ? { files: args.files.map((file) => ({ ...file, path: fn(file.path) })) } : {}),
    ...(args.directories ? { directories: args.directories.map((dir) => fn(dir)) } : {}),
  }),
  run: async (args, ctx) => {
    const r = await handleCreate(args, ctx);
    // input_required is a return value, not a completed call: surface it
    // verbatim so the executor short-circuits before building a CallToolResult.
    if (isInputRequiredResult(r)) return r;
    const { dirBatch, batch } = r;

    const results: CreateFileResult[] = [];
    const directories: string[] = [];
    const failures: CreateFailureItem[] = [];
    const skipped: string[] = [];
    const links: ContentBlock[] = [];
    for (const r of dirBatch.results) {
      if ('error' in r) {
        failures.push({ path: r.path, error: r.error });
      } else {
        directories.push(r.value);
      }
    }
    for (const r of batch.results) {
      if ('error' in r) {
        failures.push({ path: r.path, error: r.error });
        continue;
      }
      if ('skipped' in r.value) {
        skipped.push(r.value.skipped);
        continue;
      }
      results.push(r.value.file);
      if (r.value.resourceLink) links.push(r.value.resourceLink);
    }

    const structured = {
      files: results,
      ...(directories.length > 0 ? { directories } : {}),
      ...(failures.length > 0 ? { failures } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
    };
    // Failed only when every directory and every file failed, across both lists.
    const summary = {
      total: dirBatch.summary.total + batch.summary.total,
      succeeded: dirBatch.summary.succeeded + batch.summary.succeeded,
      failed: dirBatch.summary.failed + batch.summary.failed,
    };
    // No `text` on purpose. The one-line roster this used to build named the
    // paths and dropped every per-file size, line count and error the caller
    // asked `create` for. Supplying no text makes this a data tool, so
    // `define.ts` renders the JSON and keeps it in `structuredContent`.
    // A refusal is an answer the model can report; only a real failure is an
    // error. Directories never take a confirmation, so only file rows can be
    // refusals — but a directory failure is still a hard failure, so both
    // lists are scanned for one.
    const isError =
      isTotalFailure(summary) &&
      [...dirBatch.results, ...batch.results].some((r) => 'error' in r && !isRefusal(r.error));
    return { structured, resources: links, isError };
  },
  progress: (args) => {
    const files = args.files ?? [];
    const dirs = args.directories ?? [];
    if (files.length + dirs.length === 1) {
      return { label: 'Create', subject: basename(files[0]?.path ?? dirs[0] ?? '') };
    }
    const counts: string[] = [];
    if (files.length > 0) counts.push(`${String(files.length)} files`);
    if (dirs.length > 0) counts.push(`${String(dirs.length)} directories`);
    return { label: 'Create', subject: counts.join(', ') };
  },
});

interface CreateFailure {
  path: string;
  error: Problem;
}

function toCreateFailure(path: string, error: unknown): CreateFailure {
  return { path, error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, path) };
}

type CreateSlotValue =
  { file: CreateFileResult; resourceLink?: ContentBlock } | { skipped: string };

type CreateFilePlanResult =
  { status: 'plan'; plan: CreatePlan } | { status: 'fail'; failure: CreateFailure };

/**
 * Phase 1 (no mutation): plan one file through the guarded filesystem.
 */
async function planFile(
  file: CreateFileItem,
  ctx: Pick<ToolCtx, 'fs' | 'signal'>,
): Promise<CreateFilePlanResult> {
  try {
    const plan = await ctx.fs.planCreate(file.path, {
      append: file.append,
      overwrite: file.overwrite,
      signal: ctx.signal,
    });
    return { status: 'plan', plan };
  } catch (error) {
    return { status: 'fail', failure: toCreateFailure(file.path, error) };
  }
}

/**
 * Plan every file, ask the Confirmation for the overwrites that need the
 * user's word (R14), then execute the plans and the directories. A path that
 * names a directory is refused at plan, unasked, before the round.
 */
async function handleCreate(
  args: CreateInput,
  ctx: ToolCtx,
): Promise<
  InputRequiredResult | { dirBatch: BatchResult<string>; batch: BatchResult<CreateSlotValue> }
> {
  const files = args.files ?? [];
  const dirs = args.directories ?? [];

  // Entries write in parallel and each replaces its file whole, so two
  // entries for one path race: the last rename wins and the other's content
  // is lost while both report success. The path guard keys each path by the
  // Entry it names, so Unicode respellings count as one.
  const dirRepeat = await repeatedEntry(dirs, ctx);
  if (dirRepeat) {
    const [index, first] = dirRepeat;
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      `directories.${String(index)}: duplicate of directories[${String(first)}]; one entry per directory`,
    );
  }
  const fileRepeat = await repeatedEntry(
    files.map((file) => file.path),
    ctx,
  );
  if (fileRepeat) {
    const [index, first] = fileRepeat;
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      `files.${String(index)}.path: duplicate of files[${String(first)}].path; one entry per file`,
    );
  }

  const ready = await planBatch<CreateFileItem, CreatePlan, CreateSlotValue>(
    {
      op: 'create',
      accept: 'overwrite',
      items: files,
      pathOf: (file) => file.path,
      plan: (file) => planFile(file, ctx),
      slotPath: (plan) => plan.inputPath,
      landing: (plan) => plan.validPath,
      // Two entries that land on one file (through a linked folder, say) race
      // as two spellings do: the last write wins and both report success.
      // Two appends both land.
      duplicates: {
        policy: 'fail',
        refuse: (plan, first) =>
          plan.kind === 'append' && first.kind === 'append'
            ? undefined
            : toCreateFailure(
                plan.inputPath,
                new FsError(
                  ErrorCode.INVALID_INPUT,
                  `create cancelled: another entry in this batch already writes "${first.inputPath}"`,
                  plan.inputPath,
                ),
              ).error,
      },
      // append never destroys, and overwrite: true is that word given up
      // front, so neither asks.
      confirmItem: (plan) =>
        plan.kind !== 'pending' || plan.identity === undefined
          ? undefined
          : {
              path: plan.validPath,
              identity: plan.identity,
              required: true,
              message: `"${plan.validPath}" already exists. Overwrite it?`,
            },
      onRefusal: 'fail slot',
      skipped: (plan) => ({ skipped: plan.inputPath }),
      run: async (plan, file, c) => {
        const { validPath, writtenAt } = await c.fs.executeCreate(plan, file.content, {
          signal: c.signal,
        });
        return createOne(validPath, writtenAt, file.content, file.append, c);
      },
    },
    ctx,
  );
  if (isInputRequiredResult(ready)) return ready;

  // Directories wait for the overwrite question above, so nothing is written
  // before the user answers.
  const progressTotal = dirs.length + files.length;
  const dirSlots: BatchSlot<string>[] = dirs.map((dir) => ({
    status: 'pending',
    path: dir,
    run: async () => {
      await ctx.fs.mkdir(dir, { recursive: true });
      return dir;
    },
  }));
  const dirBatch = await executeBatchSlots(dirSlots, ctx, {
    progressOffset: 0,
    progressTotal,
    defaultErrorCode: ErrorCode.UNKNOWN,
  });

  const batch = await ready.execute({ progressOffset: dirs.length, progressTotal });
  return { dirBatch, batch };
}

async function createOne(
  validPath: string,
  writtenAt: Date,
  content: string,
  append: boolean | undefined,
  ctx: ToolCtx,
): Promise<{ file: CreateFileResult; resourceLink?: ContentBlock }> {
  // Overwrite: file content == `content`, so content-derived meta is
  // exact and the atomic temp+rename write protects the existing mode.
  // Append: the resulting file is everything that was there plus
  // `content`, so size/created/modified come from a real post-append
  // stat, MIME from the resulting file's leading bytes, and the line
  // count streams the file — reading a multi-GB log back whole is the
  // round-trip append exists to avoid.
  let meta: WrittenFileMeta;
  let created: string;
  let modified: string;
  if (append) {
    // The append is the commit point: the bytes are on disk, so
    // everything below is best-effort RESULT METADATA, not part of the
    // write. It runs unwired to ctx.signal, and a metadata failure
    // degrades the result instead of failing it — either would report
    // the append as failed and a client retry would append twice. The
    // stat covers the committed validPath, never the input path: a
    // symlink there could have been swapped between write and stat,
    // and the result must describe the file the bytes landed in.
    let stats: Stats | undefined;
    let mimeType: string;
    let kind: FileKind;
    let lineCount = 0;
    try {
      stats = (await ctx.fs.stat(validPath)).stats;
      // Sniff the resulting file's leading bytes, not the appended
      // chunk: text appended to a binary file is still a binary file.
      const sample = await ctx.fs.readLeadingSample(validPath);
      const mimeInfo = detectMimeFromContent(validPath, sample);
      mimeType = mimeInfo.mimeType;
      kind = mimeInfo.kind;
      // Past the limit the scan costs seconds per append (5.9 s at 2 GiB), so
      // the count stays the unknown-as-zero the catch below also reports.
      if (stats.size <= getMaxTextFileSize()) {
        lineCount = await ctx.fs.countFileLines(validPath);
      }
    } catch (error) {
      ctx.log(
        'warning',
        `create append: could not read result metadata for ${validPath}: ${formatUnknownErrorMessage(error)}`,
        'create',
      );
      // A POSIX mode-0222 file appends fine but cannot be opened 'r';
      // fall back to the chunk for MIME (an approximation) and report
      // the line count as unknown-as-zero rather than fail the append.
      const mimeInfo = detectMimeFromContent(validPath, content);
      mimeType = mimeInfo.mimeType;
      kind = mimeInfo.kind;
    }
    // A failed stat leaves the size unknown, so nothing is advertised.
    meta = {
      size: stats?.size ?? 0,
      lineCount,
      mimeType,
      kind,
      ...writtenFileLinks(
        validPath,
        mimeType,
        stats?.size,
        false,
        stats?.mtime.toISOString(),
        ctx.transport,
        { kind },
      ),
    };
    // An append did not create the file, so the write time is no birth time.
    created = (stats?.birthtime ?? EPOCH).toISOString();
    modified = modifiedAfterWrite(stats, writtenAt);
  } else {
    const fileStats = await statAfterWrite(ctx.fs, validPath);
    created = (fileStats?.birthtime ?? writtenAt).toISOString();
    modified = modifiedAfterWrite(fileStats, writtenAt);
    meta = buildWrittenFileMeta({
      validPath,
      content,
      lastModified: modified,
      transport: ctx.transport,
    });
  }

  const { resourceLink, ...fileMeta } = meta;
  const file: CreateFileResult = { path: validPath, ...fileMeta, created, modified };

  return resourceLink ? { file, resourceLink } : { file };
}
