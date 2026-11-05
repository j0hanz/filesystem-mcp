import { basename } from 'node:path';

import * as z from 'zod/v4';
import { applyPatch, parsePatch } from 'diff';

import { unifiedPatch } from '../core/diff.ts';
import { ErrorCode, FsError } from '../core/errors.ts';
import type { WrittenFileMeta } from '../core/file-uri.ts';
import { countLines } from '../core/read.ts';
import { rewriteFile } from '../core/rewrite.ts';
import { defaultFalseBoolean, RequiredPath } from '../core/schema.ts';
import { MIB } from '../core/util.ts';
import { defineTool, type ToolCtx } from './define.ts';

// jsdiff compares a hunk at each file line and cannot be interrupted, so its
// cost follows file lines x diff lines. Worst case (identical lines, a hunk
// failing at its last line), 2026-11-03, jsdiff 9, Node 26: 10,000 x 1,000 lines
// of 1,000 chars took 0.8 s. A product of 5e7 reached 4.4 s on long lines.
// At FS_MAX_FILE_SIZE 100 MiB the same product took 1898 ms (31,622 file lines
// x 316 diff lines of 3,162 chars).
const MAX_PATCH_LINE_PRODUCT = 10_000_000;
const MAX_DIFF_CHARS = MIB;

const PatchInputSchema = z.strictObject({
  path: RequiredPath.describe('File to apply the diff to'),
  diff: z
    .string()
    .min(1)
    .max(MAX_DIFF_CHARS, { message: 'diff too long (max 1,048,576 chars)' })
    .describe('Single-file unified diff to apply (as produced by the diff tool or edit dry-run)'),
  dryRun: defaultFalseBoolean('Preview the diff without writing (default: false)'),
});

type PatchOutput = Omit<WrittenFileMeta, 'resourceLink'> & {
  path: string;
  modified: string;
  linesAdded: number;
  linesRemoved: number;
  diff?: string;
};

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

export const PATCH = defineTool<typeof PatchInputSchema, PatchOutput>({
  name: 'patch',
  title: 'Patch',
  description:
    'Apply a single-file unified diff to one existing text file, like git apply. ' +
    'Nothing is written unless every hunk applies in file order with exactly matching context; ' +
    'hunks are found by their context, so start line numbers may be off.',
  input: PatchInputSchema,
  readOnlyHint: false,
  progress: (args) => ({
    label: args.dryRun ? 'Patch [dry run]' : 'Patch',
    subject: basename(args.path),
  }),
  mapPaths: (args, fn) => ({ ...args, path: fn(args.path) }),
  run: (args, ctx) => applyPatchOnce(args, ctx),
});

async function applyPatchOnce(args: z.infer<typeof PatchInputSchema>, ctx: ToolCtx) {
  const done = await rewriteFile(
    {
      fs: ctx.fs,
      path: args.path,
      dryRun: args.dryRun,
      signal: ctx.signal,
      transport: ctx.transport,
      tool: 'patch',
    },
    (content) => {
      const result = patchContent(args, content);
      return { content: result.patched, result, write: true };
    },
  );
  const { linesAdded, linesRemoved } = done.result;
  // The patched file used to come back whole in the text block, so a one-line
  // hunk against a 5000-line file returned 5000 lines. Every other write tool
  // answers with a summary; the result is reachable via `resourceUri` or a
  // follow-up `read` when the caller actually wants the bytes.
  const summaryText = `patch: ${basename(args.path)} +${String(linesAdded)} -${String(linesRemoved)}`;

  if (done.written) {
    ctx.log('info', `patch: ${args.path} (+${linesAdded}/-${linesRemoved})`, 'patch');
  }

  // A dry run shows where the hunks landed, like edit's. The caller's own diff
  // stands in when the Myers pass hits DIFF_TIMEOUT_MS.
  const preview = args.dryRun
    ? (unifiedPatch(basename(done.validPath), done.before, done.after) ?? args.diff)
    : undefined;

  const { resourceLink, validPath, modified, ...fileMeta } = done.report();
  return {
    structured: {
      path: validPath,
      ...fileMeta,
      modified,
      linesAdded,
      linesRemoved,
      ...(preview !== undefined ? { diff: preview } : {}),
    },
    // A no-op patch yields a header-only diff; it previews nothing.
    text:
      preview === undefined
        ? summaryText
        : `${summaryText} [dry run]${preview.includes('\n@@') || preview.startsWith('@@') ? `\n\n${preview}` : ''}`,
    ...(resourceLink !== undefined ? { resources: [resourceLink] } : {}),
  };
}

/** The transform: parse, clamp, apply, and the line-count backstop. */
function patchContent(
  args: z.infer<typeof PatchInputSchema>,
  content: string,
): { patched: string; linesAdded: number; linesRemoved: number } {
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
  const fileLines = countLines(content);
  const diffLines = parsedPatch.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  if (fileLines * diffLines > MAX_PATCH_LINE_PRODUCT) {
    throw new FsError(
      ErrorCode.TOO_LARGE,
      `patch refused: ${String(fileLines)} file lines x ${String(diffLines)} diff lines is over the limit of 10,000,000.`,
      args.path,
      undefined,
      'Patch fewer lines at once, or use edit.',
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
  return { patched, linesAdded, linesRemoved };
}
