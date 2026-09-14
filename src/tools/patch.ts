import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';
import { applyPatch, parsePatch } from 'diff';

import { ErrorCode, FsError } from '../core/errors.js';
import { buildWrittenFileMeta } from '../core/file-uri.js';
import {
  defaultFalseBoolean,
  FileKind,
  IsoDateTime,
  NonNegInt,
  RequiredPath,
} from '../core/schema.js';
import { defineTool, type ToolCtx } from './define.js';

const PatchInputSchema = z.strictObject({
  path: RequiredPath.describe('File to apply the diff to'),
  diff: z
    .string()
    .min(1)
    .describe('Single-file unified diff to apply (as produced by the diff tool or edit dry-run)'),
  dryRun: defaultFalseBoolean('Preview the result without writing (default: false)'),
});

const PatchOutputSchema = z.strictObject({
  path: z.string().describe('Resolved absolute path of the patched file'),
  size: NonNegInt.describe('File size in bytes after patching'),
  lineCount: NonNegInt.describe('Number of lines in the file after patching'),
  mimeType: z.string().describe('Detected MIME type of the file'),
  kind: FileKind.describe('Broad file kind: text, binary, image, audio, or pdf'),
  resourceUri: z.string().optional().describe('Resource URI pointing to the patched file content'),
  modified: IsoDateTime.describe('Last modification timestamp after patching (ISO 8601 UTC)'),
  linesAdded: NonNegInt.describe('Number of lines added by the patch'),
  linesRemoved: NonNegInt.describe('Number of lines removed by the patch'),
  diff: z.string().optional().describe('Unified diff preview (present only in dryRun mode)'),
});

// Hunk lines are the raw unified lines with their +/-/ leading prefix (no
// +++/--- file headers inside hunks), so the first char is a reliable marker.
function countAddedRemoved(parsedPatch: ReturnType<typeof parsePatch>[number]): {
  linesAdded: number;
  linesRemoved: number;
} {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const hunk of parsedPatch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) linesAdded += 1;
      else if (line.startsWith('-')) linesRemoved += 1;
    }
  }
  return { linesAdded, linesRemoved };
}

async function handlePatch(
  args: z.infer<typeof PatchInputSchema>,
  ctx: ToolCtx,
): Promise<{
  structured: z.infer<typeof PatchOutputSchema>;
  text: string;
  resources?: ContentBlock[];
}> {
  const { validPath, content, stats } = await ctx.fs.readEditableText(args.path, {
    signal: ctx.signal,
    tool: 'patch',
  });

  // patch is single-file only: a multi-file unified diff (parsePatch length > 1)
  // is rejected. Multi-file application needs per-file PathGuard-resolved loaders
  // and is deferred (out of scope).
  const parsed = parsePatch(args.diff);
  if (parsed.length !== 1) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      `patch accepts a single-file unified diff; received ${parsed.length} file(s)`,
      args.path,
    );
  }
  const parsedPatch = parsed[0];
  if (!parsedPatch || parsedPatch.hunks.length === 0) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      'patch accepts a single-file unified diff with at least one hunk; received an empty patch',
      args.path,
    );
  }
  // applyPatch returns false (strict) on hunk mismatch — not a falsy empty string,
  // so `=== false` distinguishes a no-op patch ('') from a failed one.
  const patched = applyPatch(content, parsedPatch);
  if (patched === false) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      'patch did not apply cleanly: hunk context does not match file content',
      args.path,
    );
  }

  const { linesAdded, linesRemoved } = countAddedRemoved(parsedPatch);
  // The patched file used to come back whole in the text block, so a one-line
  // hunk against a 5000-line file returned 5000 lines. Every other write tool
  // answers with a summary; the result is reachable via `resourceUri` or a
  // follow-up `read` when the caller actually wants the bytes.
  const summaryText = `patch: ${basename(args.path)} +${String(linesAdded)} -${String(linesRemoved)}`;

  if (args.dryRun) {
    const meta = buildWrittenFileMeta(validPath, patched, ctx.resourceStore);
    return {
      structured: {
        path: validPath,
        size: meta.size,
        lineCount: meta.lineCount,
        mimeType: meta.mimeType,
        kind: meta.kind,
        modified: stats.mtime.toISOString(),
        linesAdded,
        linesRemoved,
        ...(meta.resourceUri !== undefined ? { resourceUri: meta.resourceUri } : {}),
        diff: args.diff,
      },
      // A dry run exists to be previewed, so it keeps returning the patched
      // text; only the write path summarizes, where the bytes are on disk.
      text: patched,
      ...(meta.resourceLink !== undefined ? { resources: [meta.resourceLink] } : {}),
    };
  }

  await ctx.fs.writeFile(args.path, patched, { encoding: 'utf-8', signal: ctx.signal });
  ctx.log?.('info', `patch: ${args.path} (+${linesAdded}/-${linesRemoved})`, 'patch');

  // `modified` is read from a post-write stat and is advisory: under a concurrent
  // writer it may reflect that writer's mtime while `size`/content come from this
  // patch's atomic write. The file content itself is always consistent.
  const { stats: fileStats } = await ctx.fs.stat(args.path, { signal: ctx.signal });
  const meta = buildWrittenFileMeta(validPath, patched, ctx.resourceStore);
  return {
    structured: {
      path: validPath,
      size: meta.size,
      lineCount: meta.lineCount,
      mimeType: meta.mimeType,
      kind: meta.kind,
      modified: fileStats.mtime.toISOString(),
      linesAdded,
      linesRemoved,
      ...(meta.resourceUri !== undefined ? { resourceUri: meta.resourceUri } : {}),
    },
    text: summaryText,
    ...(meta.resourceLink !== undefined ? { resources: [meta.resourceLink] } : {}),
  };
}

export const PATCH = defineTool({
  name: 'patch',
  title: 'Patch',
  description:
    'Apply a single-file unified diff to one file and write the result. Pass { path, diff }. ' +
    'Use after inspecting a diff tool dry-run: pass the diff blob directly instead of re-expressing it as line edits. ' +
    'Rejects multi-file diffs and diffs whose hunk context does not match the file. ' +
    'Set dryRun=true to preview the result without writing.',
  input: PatchInputSchema,
  output: PatchOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  progress: (args) => ({
    label: args.dryRun ? 'Patch [dry run]' : 'Patch',
    subject: basename(args.path),
  }),
  accessPaths: (args) => [args.path],
  run: (args, ctx) => handlePatch(args, ctx),
});
