import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.ts';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  type Problem,
  rethrowIfAborted,
} from '../core/errors.ts';
import { buildWrittenFileMeta, writtenFileLinks, type WrittenFileMeta } from '../core/file-uri.ts';
import { countFileLines, destExists, type Stats } from '../core/fs.ts';
import {
  confirmKey,
  describeRefusal,
  pendingRoundTrip,
  readAcceptedChoice,
} from '../core/input-required.ts';
import { detectMimeFromContent, type FileKind, MIME_SAMPLE_SIZE } from '../core/mime.ts';
import { isSamePath } from '../core/path-utils.ts';
import { RequiredPath } from '../core/schema.ts';
import { getMaxTextFileSize, PARALLEL_CONCURRENCY } from '../core/util.ts';
import { isTotalFailure, runOverPaths } from './batch.ts';
import { defineTool } from './define.ts';

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
      .describe(
        'List of files to create (max 100); each entry requires path and content; combined content is capped at the file-size limit',
      ),
  })
  .superRefine((value, ctx) => {
    // Entries write in parallel and each replaces its file whole, so two
    // entries for one path race: the last rename wins and the other's
    // content is lost while both report success. One entry per file.
    for (const [index, file] of value.files.entries()) {
      const first = value.files.findIndex((other) => isSamePath(other.path, file.path));
      if (first < index) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: `duplicate of files[${String(first)}].path; one entry per file`,
          input: value,
        });
      }
    }
    // One call's content is what one inbound message carries; the transports
    // size their message bound from this same limit (getMaxInboundMessageBytes),
    // so a batch that passes here always fits on the wire. Counted in the same
    // UTF-16 units as the per-file refine above.
    const total = value.files.reduce((sum, file) => sum + file.content.length, 0);
    const limit = getMaxTextFileSize();
    if (total > limit) {
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: `combined content is ${String(total)} characters; one create call carries at most ${String(limit)} (FS_MAX_FILE_SIZE). Split the batch.`,
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
  failures?: CreateFailureItem[];
  skipped?: string[];
}

export const CREATE = defineTool<typeof CreateInputSchema, CreateOutput>({
  name: 'create',
  title: 'Create Files',
  description:
    'Write whole text files: create new ones, overwrite, or append. Missing parent directories are created. ' +
    'edit or patch changes part of an existing file.',
  input: CreateInputSchema,
  readOnlyHint: false,
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
        droppedInputResponseKeys: ctx.droppedInputResponseKeys,
        clientCapabilities: ctx.clientCapabilities,
        serverCtx: ctx.serverCtx,
        buildInputs: (paths) =>
          paths.map((target, i) => ({
            key: confirmKey(i),
            message: `"${target}" already exists. Overwrite it?`,
            choices: ['overwrite', 'skip'],
          })),
      });
      if (round !== undefined) return round;
    }

    const batch = await runOverPaths<
      z.infer<typeof CreateFileItemSchema>,
      { file: CreateFileResult; resourceLink?: ContentBlock } | { skipped: string }
    >(args.files, ctx, ErrorCode.UNKNOWN, async ({ path, content, append }) => {
      const pendingPath = pendingByPath.get(path);
      if (pendingPath !== undefined) {
        const key = confirmKey(pendingSorted.indexOf(pendingPath));
        const choice = readAcceptedChoice(ctx.inputResponses, key);
        if (choice === 'skip') return { skipped: path };
        if (choice !== 'overwrite') {
          throw new FsError(
            ErrorCode.CANCELLED,
            `create cancelled: overwrite of "${path}" was ${describeRefusal(ctx.inputResponses, key, ctx.droppedInputResponseKeys)}`,
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
      if (append) {
        const appended = await ctx.fs.appendFile(path, content, {
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
          ctx.log?.(
            'warning',
            `create append: result metadata degraded for ${appended.validPath}: ${formatUnknownErrorMessage(error)}`,
            'create',
          );
          // A POSIX mode-0222 file appends fine but cannot be opened 'r';
          // fall back to the chunk for MIME (an approximation) and report
          // the line count as unknown-as-zero rather than fail the append.
          const mimeInfo = detectMimeFromContent(appended.validPath, content);
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
            appended.validPath,
            mimeType,
            stats?.size,
            false,
            stats?.mtime.toISOString(),
          ),
        };
        created = (stats?.birthtime ?? EPOCH).toISOString();
        modified = (stats?.mtime ?? EPOCH).toISOString();
      } else {
        const written = await ctx.fs.writeFile(path, content, {
          signal: ctx.signal,
        });
        validPath = written.validPath;
        const fileStats = (await ctx.fs.stat(path, { signal: ctx.signal })).stats;
        created = fileStats.birthtime.toISOString();
        modified = fileStats.mtime.toISOString();
        meta = buildWrittenFileMeta({
          validPath: written.validPath,
          content,
          lastModified: modified,
        });
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
    });

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
});
