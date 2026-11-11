import { basename } from 'node:path';

import * as z from 'zod/v4';

import { DIFF_TIMEOUT_MS, twoFilesPatch } from '../core/diff.ts';
import { ErrorCode, FsError } from '../core/errors.ts';
import { readNamedText } from '../core/scan.ts';
import { PositiveInt, RequiredPath } from '../core/schema.ts';
import { defineTool } from './define.ts';

const DiffInputSchema = z.strictObject({
  a: RequiredPath.describe('Original file; its lines are the - side'),
  b: RequiredPath.describe('Changed file; its lines are the + side'),
  context: PositiveInt.max(50)
    .default(3)
    .describe('Unchanged lines shown around each hunk; output size only'),
});

interface DiffOutput {
  a: string;
  b: string;
  linesAdded: number;
  linesRemoved: number;
}

export const DIFF = defineTool<typeof DiffInputSchema, DiffOutput>({
  name: 'diff',
  title: 'Diff',
  description:
    'Compare two text files and return a unified diff from a to b. Use when you need line differences between two files on disk. ' +
    'Do not use it to find text across files; use `search_text` instead. ' +
    'To preview your own pending change, use the dryRun option of the write tools. ' +
    'Neither file is changed. Binary and non-UTF-8 files fail. ' +
    'A file over the size limit fails with TOO_LARGE. So does a diff not done within 1 s, or a full diff queue; retry once, then `read` matching line ranges. ' +
    'a is the - side and b the + side; swap them to reverse the diff. ' +
    'context only sets how many unchanged lines surround each hunk, not what counts as a change. ' +
    'Returns ---/+++ headers (basenames) and @@ hunks; identical files give headers only.',
  input: DiffInputSchema,
  readOnlyHint: true,
  progress: (args) => ({
    label: 'Diff',
    subject: basename(args.a),
  }),
  mapPaths: (args, fn) => ({ ...args, a: fn(args.a), b: fn(args.b) }),
  run: async (args, ctx) => {
    const [{ validPath: validA, content: contentA }, { validPath: validB, content: contentB }] =
      await Promise.all([
        readNamedText(ctx.fs, args.a, { signal: ctx.signal, tool: 'diff' }),
        readNamedText(ctx.fs, args.b, { signal: ctx.signal, tool: 'diff' }),
      ]);

    // Synchronous Myers diff; `timeout` is the only thing that can stop it.
    const generated = await twoFilesPatch(
      basename(validA),
      basename(validB),
      contentA,
      contentB,
      'a',
      'b',
      {
        context: args.context,
        timeout: DIFF_TIMEOUT_MS,
      },
    );
    if (generated === undefined) {
      throw new FsError(
        ErrorCode.TOO_LARGE,
        `Diff not computed: the files differ too much to diff within ${String(DIFF_TIMEOUT_MS)} ms, or the server is busy with other diffs. Retry once. If it fails again, compare smaller sections with read and startLine/endLine.`,
        args.a,
      );
    }

    // The text block is the one copy of the diff; a model reads that, and a
    // structured duplicate or a store entry would only ship the same bytes again.
    return {
      structured: {
        a: validA,
        b: validB,
        linesAdded: generated.linesAdded,
        linesRemoved: generated.linesRemoved,
      },
      text: generated.text,
    };
  },
});
