import { basename } from 'node:path';

import * as z from 'zod/v4';
import { applyPatch, parsePatch } from 'diff';

import { ErrorCode, FsError } from '../core/errors.ts';
import { buildWrittenFileMeta } from '../core/file-uri.ts';
import { countLines } from '../core/read.ts';
import {
  defaultFalseBoolean,
  FileKind,
  IsoDateTime,
  NonNegInt,
  RequiredPath,
} from '../core/schema.ts';
import { defineTool } from './define.ts';

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

export const PATCH = defineTool({
  name: 'patch',
  title: 'Patch',
  description:
    'Apply a single-file unified diff to one existing text file, like git apply. ' +
    'Nothing is written unless every hunk applies in file order with exactly matching context; ' +
    'hunks are found by their context, so start line numbers may be off.',
  input: PatchInputSchema,
  output: PatchOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  progress: (args) => ({
    label: args.dryRun ? 'Patch [dry run]' : 'Patch',
    subject: basename(args.path),
  }),
  accessPaths: (args) => [args.path],
  run: async (args, ctx) => {
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
    // jsdiff tries each hunk at its header line before bounding the search by
    // the previous hunk, so a header pointing back into text an earlier hunk
    // already consumed applies there and emits that region twice. Start each
    // hunk no earlier than where the previous hunk's changes end; its trailing
    // context may still overlap, as jsdiff allows.
    let floor = 0;
    const hunks = parsedPatch.hunks.map((hunk) => {
      const oldStart = Math.max(hunk.oldStart, floor);
      let trailingContext = 0;
      for (const line of hunk.lines) {
        if (line === '' || line.startsWith(' ')) trailingContext++;
        else if (line.startsWith('+') || line.startsWith('-')) trailingContext = 0;
      }
      floor = oldStart + hunk.oldLines - trailingContext;
      return { ...hunk, oldStart };
    });
    // applyPatch returns false (strict) on hunk mismatch — not a falsy empty string,
    // so `=== false` distinguishes a no-op patch ('') from a failed one.
    const patched = applyPatch(content, { ...parsedPatch, hunks });
    if (patched === false) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'patch did not apply cleanly: hunk context does not match file content (hunks must be in file order)',
        args.path,
      );
    }

    const { linesAdded, linesRemoved } = countAddedRemoved(parsedPatch);
    // Backstop for placements the clamp cannot see, such as zero-context hunks
    // whose headers point past the end of the file: refuse rather than write.
    if (countLines(patched) !== countLines(content) + linesAdded - linesRemoved) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'patch would duplicate or drop lines: a hunk overlaps an earlier one or starts past the end of the file',
        args.path,
      );
    }
    // The patched file used to come back whole in the text block, so a one-line
    // hunk against a 5000-line file returned 5000 lines. Every other write tool
    // answers with a summary; the result is reachable via `resourceUri` or a
    // follow-up `read` when the caller actually wants the bytes.
    const summaryText = `patch: ${basename(args.path)} +${String(linesAdded)} -${String(linesRemoved)}`;

    if (!args.dryRun) {
      await ctx.fs.writeFile(args.path, patched, { encoding: 'utf-8', signal: ctx.signal });
      ctx.log?.('info', `patch: ${args.path} (+${linesAdded}/-${linesRemoved})`, 'patch');
    }

    // `modified` is read from a post-write stat and is advisory: under a concurrent
    // writer it may reflect that writer's mtime while `size`/content come from this
    // patch's atomic write. The file content itself is always consistent.
    const fileStats = args.dryRun
      ? stats
      : (await ctx.fs.stat(args.path, { signal: ctx.signal })).stats;
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
        ...(args.dryRun ? { diff: args.diff } : {}),
      },
      // A dry run exists to be previewed, so it keeps returning the patched
      // text; only the write path summarizes, where the bytes are on disk.
      text: args.dryRun ? patched : summaryText,
      ...(meta.resourceLink !== undefined ? { resources: [meta.resourceLink] } : {}),
    };
  },
});
