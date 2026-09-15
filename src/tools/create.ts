import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.js';
import { ErrorCode, formatUnknownErrorMessage, FsError, rethrowIfAborted } from '../core/errors.js';
import {
  buildFileResourceLink,
  buildFileResourceUri,
  buildWrittenFileMeta,
  type WrittenFileMeta,
} from '../core/file-uri.js';
import { countFileLines, destExists, type Stats } from '../core/fs.js';
import {
  choiceInput,
  confirmKey,
  pendingRoundTrip,
  readAcceptedChoice,
} from '../core/input-required.js';
import { detectMimeFromContent, MIME_SAMPLE_SIZE } from '../core/mime.js';
import { Logger } from '../core/observability.js';
import {
  FileKind,
  IsoDateTime,
  NonNegInt,
  PathFailureSchema,
  RequiredPath,
} from '../core/schema.js';
import { getMaxTextFileSize, PARALLEL_CONCURRENCY } from '../core/util.js';
import { isTotalFailure, runOverPaths } from './batch.js';
import { defineTool } from './define.js';

const EPOCH = new Date(0);

const CreateFileItemSchema = z.strictObject({
  path: RequiredPath.describe('Absolute path where the file will be created'),
  content: z
    .string()
    .refine((val) => val.length <= getMaxTextFileSize(), {
      message: 'Content exceeds maximum allowed text file size',
    })
    .describe('Text content to write, verbatim.'),
  append: z
    .boolean()
    .optional()
    .describe(
      'Append the content to the end of the file instead of overwriting; creates the file if it does not exist',
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      'Replace an existing file without asking the user; without it an existing file prompts for confirmation',
    ),
});

const CreateFileResultSchema = z.strictObject({
  path: z.string().describe('Resolved absolute path of the created file'),
  size: NonNegInt.describe('File size in bytes after writing'),
  lineCount: NonNegInt.describe('Number of lines in the written file'),
  mimeType: z.string().describe('Detected MIME type of the file'),
  kind: FileKind.describe('Broad file kind: text, binary, image, audio, or pdf'),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'Resource URI pointing to the created file content in the resource store; omitted when the resulting file exceeds the text-size cap, which the store would reject',
    ),
  created: IsoDateTime.describe('File creation timestamp (ISO 8601 UTC)'),
  modified: IsoDateTime.describe('File last-modification timestamp (ISO 8601 UTC)'),
});

const CreateInputSchema = z.strictObject({
  files: z
    .array(CreateFileItemSchema)
    .min(1)
    .max(100)
    .describe('List of files to create (max 100); each entry requires path and content'),
});

type CreateFailureItem = z.infer<typeof PathFailureSchema>;

const CreateOutputSchema = z.strictObject({
  files: z.array(CreateFileResultSchema).describe('Successfully created files'),
  failures: z
    .array(PathFailureSchema)
    .optional()
    .describe('Files that failed to create with per-file error details'),
  skipped: z
    .array(z.string())
    .optional()
    .describe('Paths left untouched because the user chose Skip'),
});

type CreateFileResult = z.infer<typeof CreateFileResultSchema>;

export const CREATE = defineTool({
  name: 'create',
  title: 'Create Files',
  description:
    'Create one or more files (max 100), creating parent directories as needed. ' +
    'Pass files: [{ path, content }] — there is no single-path form. ' +
    'An existing file prompts the user to confirm the overwrite, so the call returns without writing ' +
    'anything until that confirmation comes back; set overwrite: true on an entry to replace it without the prompt. ' +
    'Set append: true on an entry to add to the end of an existing file (created if missing) instead of overwriting.',
  input: CreateInputSchema,
  output: CreateOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  accessPaths: (args) => args.files.map((f) => f.path),
  run: async (args, ctx) => {
    // Phase 1 (no mutation): which entries would replace a file that exists
    // right now? Those need the user's word before anything is written (R14).
    // append never destroys, and overwrite: true is that word given up front.
    // A path that fails validation here is left for runOverPaths to report.
    // A file that appears between rounds needs no re-stat before the write:
    // the retry re-plans, and the grown pending set fails the R9 check.
    const { results: planned } = await processInParallel(
      args.files,
      async (entry) => {
        if (entry.append || entry.overwrite) return undefined;
        try {
          const validPath = await ctx.fs.pathGuard.validatePathForWrite(entry.path);
          return (await destExists(ctx.fs, validPath, 'create')) ? validPath : undefined;
        } catch (error) {
          rethrowIfAborted(error);
          return undefined;
        }
      },
      PARALLEL_CONCURRENCY,
      ctx.signal,
    );
    const pendingByPath = new Map<string, string>();
    for (const { index, value } of planned) {
      const requested = args.files[index]?.path;
      if (value && requested) pendingByPath.set(requested, value);
    }
    const pendingSorted = [...new Set(pendingByPath.values())].sort();
    if (pendingSorted.length > 0) {
      // Round 1 returns input_required; a retry whose verified state does not
      // bind this overwrite set throws (R9) via `pendingRoundTrip`.
      const round = await pendingRoundTrip({
        op: 'create',
        pending: pendingSorted,
        requestState: ctx.requestState,
        clientCapabilities: ctx.clientCapabilities,
        buildInputs: (paths) =>
          paths.map((target, i) =>
            choiceInput(confirmKey(i), `"${target}" already exists. Overwrite it?`, [
              { value: 'overwrite', title: 'Overwrite' },
              { value: 'skip', title: 'Skip' },
            ]),
          ),
      });
      if (round !== undefined) return round;
    }

    const batch = await runOverPaths<
      { content: string; append?: boolean | undefined; overwrite?: boolean | undefined },
      { file: CreateFileResult; resourceLink?: ContentBlock } | { skipped: string }
    >(
      { files: args.files },
      ctx,
      async ({ path, override }) => {
        const content = override?.content ?? '';

        const pendingPath = pendingByPath.get(path);
        if (pendingPath !== undefined) {
          const key = confirmKey(pendingSorted.indexOf(pendingPath));
          const choice = readAcceptedChoice(ctx.inputResponses, key);
          if (choice === 'skip') return { skipped: path };
          if (choice !== 'overwrite') {
            throw new FsError(
              ErrorCode.CANCELLED,
              `create cancelled: overwrite of "${path}" was declined or missing`,
              path,
            );
          }
        }

        await ctx.fs.mkdir(dirname(path), { recursive: true });

        // Overwrite: file content == `content`, so content-derived meta is
        // exact and the atomic temp+rename write protects the existing mode.
        // Append: the resulting file is everything that was there plus
        // `content`, so size/created/modified come from a real post-append
        // stat, MIME from the resulting file's leading bytes, and the line
        // count streams the file — reading a multi-GB log back whole is the
        // round-trip append exists to avoid.
        let validPath: string;
        let meta: WrittenFileMeta;
        let created: string;
        let modified: string;
        if (override?.append) {
          const appended = await ctx.fs.appendFile(path, content, {
            encoding: 'utf-8',
            signal: ctx.signal,
          });
          validPath = appended.validPath;
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
            stats = (await ctx.fs.stat(appended.validPath)).stats;
            // Sniff the resulting file's leading bytes, not the appended
            // chunk: text appended to a binary file is still a binary file.
            const sample = await ctx.fs.readLeadingSample(appended.validPath, MIME_SAMPLE_SIZE);
            const mimeInfo = detectMimeFromContent(appended.validPath, sample);
            mimeType = mimeInfo.mimeType;
            kind = mimeInfo.kind;
            lineCount = await countFileLines(appended.validPath);
          } catch (error) {
            Logger.warn(
              `create append: result metadata degraded for ${appended.validPath}: ${formatUnknownErrorMessage(error)}`,
            );
            // A POSIX mode-0222 file appends fine but cannot be opened 'r';
            // fall back to the chunk for MIME (an approximation) and report
            // the line count as unknown-as-zero rather than fail the append.
            const mimeInfo = detectMimeFromContent(appended.validPath, content);
            mimeType = mimeInfo.mimeType;
            kind = mimeInfo.kind;
          }
          // The resource store serves this URI via readRaw, which rejects
          // files over the text-size cap with TOO_LARGE — never advertise a
          // link the store deterministically cannot serve. A failed stat
          // leaves the size unknown, so nothing is advertised either.
          const servable = stats !== undefined && stats.size <= getMaxTextFileSize();
          const size = stats?.size ?? 0;
          meta = {
            size,
            lineCount,
            mimeType,
            kind,
            resourceUri: servable ? buildFileResourceUri(appended.validPath) : undefined,
            resourceLink:
              servable && ctx.resourceStore
                ? buildFileResourceLink(appended.validPath, mimeType, size)
                : undefined,
          };
          created = (stats?.birthtime ?? EPOCH).toISOString();
          modified = (stats?.mtime ?? EPOCH).toISOString();
        } else {
          const written = await ctx.fs.writeFile(path, content, {
            encoding: 'utf-8',
            signal: ctx.signal,
          });
          validPath = written.validPath;
          const fileStats = (await ctx.fs.stat(path, { signal: ctx.signal })).stats;
          created = fileStats.birthtime.toISOString();
          modified = fileStats.mtime.toISOString();
          meta = buildWrittenFileMeta(written.validPath, content, ctx.resourceStore);
        }

        const file: CreateFileResult = {
          path: validPath,
          size: meta.size,
          lineCount: meta.lineCount,
          mimeType: meta.mimeType,
          kind: meta.kind,
          resourceUri: meta.resourceUri,
          created,
          modified,
        };

        return meta.resourceLink ? { file, resourceLink: meta.resourceLink } : { file };
      },
      { defaultErrorCode: ErrorCode.UNKNOWN },
    );

    const results: CreateFileResult[] = [];
    const failures: CreateFailureItem[] = [];
    const skipped: string[] = [];
    const links: ContentBlock[] = [];
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
      ...(failures.length > 0 ? { failures } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
    };
    // No `text` on purpose. The one-line roster this used to build named the
    // paths and dropped every per-file size, line count and error the caller
    // asked `create` for. Supplying no text makes this a data tool, so
    // `define.ts` renders the JSON and keeps it in `structuredContent`.
    if (links.length > 0) {
      return { structured, resources: links, isError: isTotalFailure(batch.summary) };
    }

    return { structured, isError: isTotalFailure(batch.summary) };
  },
  progress: (args) => ({
    label: 'Create',
    subject:
      args.files.length === 1
        ? basename(args.files[0]?.path ?? '')
        : `${String(args.files.length)} files`,
  }),
  defaultErrorCode: ErrorCode.UNKNOWN,
});
