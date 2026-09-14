import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import { ErrorCode } from '../core/errors.js';
import {
  buildFileResourceLink,
  buildFileResourceUri,
  buildWrittenFileMeta,
  type WrittenFileMeta,
} from '../core/file-uri.js';
import { countFileLines, type Stats } from '../core/fs.js';
import { detectMimeFromContent, MIME_SAMPLE_SIZE } from '../core/mime.js';
import {
  FileKind,
  IsoDateTime,
  NonNegInt,
  PathFailureSchema,
  RequiredPath,
} from '../core/schema.js';
import { getMaxTextFileSize } from '../core/util.js';
import { isTotalFailure, runOverPaths } from './batch.js';
import { defineTool } from './define.js';

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
});

const CreateFileResultSchema = z.strictObject({
  path: z.string().describe('Resolved absolute path of the created file'),
  size: NonNegInt.describe('File size in bytes after writing'),
  lineCount: NonNegInt.describe('Number of lines in the written file'),
  mimeType: z.string().describe('Detected MIME type of the file'),
  kind: FileKind.describe('Broad file kind: text, binary, image, audio, or pdf'),
  resourceUri: z
    .string()
    .describe('Resource URI pointing to the created file content in the resource store'),
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
});

type CreateFileResult = z.infer<typeof CreateFileResultSchema>;

export const CREATE = defineTool({
  name: 'create',
  title: 'Create Files',
  description:
    'Create one or more files (max 100), writing or overwriting content and creating parent directories as needed. ' +
    'Pass files: [{ path, content }] — there is no single-path form. ' +
    'Silently overwrites existing files — read first if you need to preserve existing content. ' +
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
    const batch = await runOverPaths<
      { content: string; append?: boolean | undefined },
      { file: CreateFileResult; resourceLink?: ContentBlock }
    >(
      { files: args.files },
      ctx,
      async ({ path, override }) => {
        const content = override?.content ?? '';

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
        let fileStats: Stats;
        if (override?.append) {
          const appended = await ctx.fs.appendFile(path, content, {
            encoding: 'utf-8',
            signal: ctx.signal,
          });
          const statted = await ctx.fs.stat(path, { signal: ctx.signal });
          // Sniff the resulting file's leading bytes, not the appended chunk:
          // text appended to a binary file is still a binary file.
          const sample = await ctx.fs.readLeadingSample(path, MIME_SAMPLE_SIZE, {
            signal: ctx.signal,
          });
          const mimeInfo = detectMimeFromContent(appended.validPath, sample);
          validPath = appended.validPath;
          fileStats = statted.stats;
          meta = {
            size: statted.stats.size,
            lineCount: await countFileLines(appended.validPath, ctx.signal),
            mimeType: mimeInfo.mimeType,
            kind: mimeInfo.kind,
            resourceUri: buildFileResourceUri(appended.validPath),
            resourceLink: ctx.resourceStore
              ? buildFileResourceLink(appended.validPath, mimeInfo.mimeType, statted.stats.size)
              : undefined,
          };
        } else {
          const written = await ctx.fs.writeFile(path, content, {
            encoding: 'utf-8',
            signal: ctx.signal,
          });
          validPath = written.validPath;
          fileStats = (await ctx.fs.stat(path, { signal: ctx.signal })).stats;
          meta = buildWrittenFileMeta(written.validPath, content, ctx.resourceStore);
        }

        const file: CreateFileResult = {
          path: validPath,
          size: meta.size,
          lineCount: meta.lineCount,
          mimeType: meta.mimeType,
          kind: meta.kind,
          resourceUri: meta.resourceUri,
          created: fileStats.birthtime.toISOString(),
          modified: fileStats.mtime.toISOString(),
        };

        return meta.resourceLink ? { file, resourceLink: meta.resourceLink } : { file };
      },
      { defaultErrorCode: ErrorCode.UNKNOWN },
    );

    const results: CreateFileResult[] = [];
    const failures: CreateFailureItem[] = [];
    const links: ContentBlock[] = [];
    for (const r of batch.results) {
      if ('error' in r) {
        failures.push({ path: r.path, error: r.error });
        continue;
      }
      results.push(r.value.file);
      if (r.value.resourceLink) links.push(r.value.resourceLink);
    }

    const structured = {
      files: results,
      ...(failures.length > 0 ? { failures } : {}),
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
