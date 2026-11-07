import { Buffer } from 'node:buffer';
import { basename } from 'node:path';

import * as z from 'zod/v4';
import { applyPatch, parsePatch } from 'diff';

import { diffStatsFromPatch, unifiedPatch } from '../core/diff.ts';
import { ErrorCode, FsError } from '../core/errors.ts';
import type { WrittenFileMeta } from '../core/file-uri.ts';
import { countLines } from '../core/read.ts';
import { rewriteFile } from '../core/rewrite.ts';
import { defaultFalseBoolean, RequiredPath } from '../core/schema.ts';
import { clipLine } from '../core/search.ts';
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
    'Apply a single-file unified diff to an existing text file, like git apply. ' +
    'Use when applying diffs produced by diff tools or git. ' +
    'Writes nothing unless every hunk applies in order with exact context; mismatched hunks fail and leave the file untouched. ' +
    'Returns lines added and removed, plus an undo id. Use dryRun to test applicability cleanly. ' +
    'Use edit for unique snippet replacements, and replace_text for regex across files.',
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
  // A dry run shows where the hunks landed, like edit's, and counts what it
  // shows: a hunk that re-adds unchanged lines counts more than it changes.
  const computed = args.dryRun
    ? await unifiedPatch(basename(done.validPath), done.before, done.after)
    : undefined;
  const { linesAdded, linesRemoved } = computed ? diffStatsFromPatch(computed) : done.result;
  // The patched file used to come back whole in the text block, so a one-line
  // hunk against a 5000-line file returned 5000 lines. Every other write tool
  // answers with a summary; the result is reachable via `resourceUri` or a
  // follow-up `read` when the caller actually wants the bytes.
  const summaryText = `patch: ${basename(args.path)} +${String(linesAdded)} -${String(linesRemoved)}`;

  if (done.written) {
    ctx.log('info', `patch: ${args.path} (+${linesAdded}/-${linesRemoved})`, 'patch');
  }

  // The caller's own diff stands in when the Myers pass hits DIFF_TIMEOUT_MS.
  const preview = args.dryRun ? (computed ?? args.diff) : undefined;
  const approximate =
    computed === undefined && args.dryRun
      ? '\n// Too many lines to diff: this is the diff as passed, and its line numbers may be off.'
      : '';

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
        : `${summaryText} [dry run]${approximate}${preview.includes('\n@@') || preview.startsWith('@@') ? `\n\n${preview}` : ''}`,
    ...(resourceLink !== undefined ? { resources: [resourceLink] } : {}),
  };
}

/** The binary search's applies: one per step, plus the one it starts from. */
const diagnosisApplies = (hunks: number): number => 1 + Math.ceil(Math.log2(hunks));

/** Whether the prefix search stays within one apply's cost, times its length. */
function diagnoseFits(
  content: string,
  fileLines: number,
  diffLines: number,
  hunks: number,
): boolean {
  const applies = diagnosisApplies(hunks);
  return (
    Math.max(fileLines, 1) * diffLines * applies <= MAX_PATCH_LINE_PRODUCT &&
    Buffer.byteLength(content) * applies <= 256 * MIB
  );
}

/**
 * The first hunk whose prefix fails to apply, by binary search: the smallest
 * prefix that fails, which the caller already knows exists (the full set failed).
 */
function firstFailingHunk(
  content: string,
  parsedPatch: ReturnType<typeof parsePatch>[number],
  hunks: ReturnType<typeof parsePatch>[number]['hunks'],
): number {
  let lo = 0;
  let hi = hunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (applyPatch(content, { ...parsedPatch, hunks: hunks.slice(0, mid + 1) }) === false) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return hi;
}

/** Index of the first char where `a` and `b` differ (the shorter length if one prefixes the other). */
const firstDiff = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

const stripCr = (line: string): string => line.replace(/\r$/u, '');

/**
 * ` at line N: expected "…", found "…"` for the hunk's first old line (context,
 * removed, or a blank context line stripped of its space) that differs from the
 * file at the submitted start; '' when all match there (clamp or order is the
 * cause). jsdiff's offset search may have looked nearby too.
 */
function mismatchDetail(
  content: string,
  hunk: ReturnType<typeof parsePatch>[number]['hunks'][number],
): string {
  if (hunk.oldStart < 1) return '';
  const old = hunk.lines
    .filter((line) => line === '' || line.startsWith(' ') || line.startsWith('-'))
    .map((line) => stripCr(line.slice(1)));
  // A line at or past this count is past the end, not blank: split pads with ''.
  const present = countLines(content) - (hunk.oldStart - 1);
  const file = content.split('\n', hunk.oldStart - 1 + old.length).slice(hunk.oldStart - 1);
  const at = old.findIndex((line, i) => i >= present || line !== stripCr(file[i] ?? ''));
  if (at < 0) return '';
  const expected = old[at] ?? '';
  const where = ` at line ${String(hunk.oldStart + at)}: expected`;
  if (at >= present) return `${where} "${clipLine(expected, 0)}", found end of file`;
  const found = stripCr(file[at] ?? '');
  const col = firstDiff(expected, found);
  return `${where} "${clipLine(expected, col)}", found "${clipLine(found, col)}"`;
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
    // jsdiff answers false for the whole diff; a binary search over hunk
    // prefixes names the first that fails. A prefix that fails means every
    // longer one fails too: each hunk lands on its own clamped region, so
    // adding hunks cannot rescue an earlier failure. The search runs
    // log-many applies, each the cost of one apply, so the diagnosis is
    // bounded by the search length: the line product times that length, and
    // the target bytes one apply copies times the same. An empty target still
    // costs one line of scan per apply, so it counts as one, not zero.
    const first =
      hunks.length > 0 && diagnoseFits(content, fileLines, diffLines, hunks.length)
        ? firstFailingHunk(content, parsedPatch, hunks)
        : -1;
    // The search cannot miss: the full clamped set is the last prefix and already failed.
    // The submitted header start, not the clamp's search floor: it is the line
    // the caller can find in the diff they sent.
    const failing = first >= 0 ? parsedPatch.hunks[first] : undefined;
    const where = failing
      ? `hunk ${String(first + 1)} (starting at line ${String(failing.oldStart)}) does not match file content${mismatchDetail(content, failing)}`
      : 'hunk context does not match file content';
    // Hunk 1 is never clamped, so its failure is its own context, not the order.
    const order = hunks.length > 1 && first !== 0 ? ' (hunks must be in file order)' : '';
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      `patch did not apply cleanly: ${where}${order}`,
      args.path,
    );
  }

  const { linesAdded, linesRemoved } = countAddedRemoved(parsedPatch);
  // Backstop for placements the clamp cannot see, such as zero-context hunks
  // whose headers point past the end of the file: refuse rather than write.
  if (countLines(patched) !== fileLines + linesAdded - linesRemoved) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      'patch would duplicate or drop lines: a hunk overlaps an earlier one or starts past the end of the file',
      args.path,
    );
  }
  return { patched, linesAdded, linesRemoved };
}
