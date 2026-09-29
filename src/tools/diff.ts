import { basename } from 'node:path';

import * as z from 'zod/v4';
import { createTwoFilesPatch } from 'diff';

import { DIFF_TIMEOUT_MS, diffStatsFromPatch } from '../core/diff.ts';
import { ErrorCode, FsError } from '../core/errors.ts';
import { PositiveInt, RequiredPath } from '../core/schema.ts';
import { defineTool } from './define.ts';

const DiffInputSchema = z.strictObject({
  a: RequiredPath.describe('First file to compare'),
  b: RequiredPath.describe('Second file to compare'),
  context: PositiveInt.max(50)
    .default(3)
    .describe('Number of context lines surrounding each change (default: 3)'),
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
  description: 'Compare two text files and return a unified diff from a to b, like diff -u.',
  input: DiffInputSchema,
  readOnlyHint: true,
  progress: (args) => ({
    label: 'Diff',
    subject: basename(args.a),
  }),
  accessPaths: (args) => [args.a, args.b],
  run: async (args, ctx) => {
    const [{ validPath: validA, content: contentA }, { validPath: validB, content: contentB }] =
      await Promise.all([
        ctx.fs.readEditableText(args.a, { signal: ctx.signal, tool: 'diff' }),
        ctx.fs.readEditableText(args.b, { signal: ctx.signal, tool: 'diff' }),
      ]);

    // Synchronous Myers diff; `timeout` is the only thing that can stop it.
    const diffText = createTwoFilesPatch(
      basename(validA),
      basename(validB),
      contentA,
      contentB,
      'a',
      'b',
      { context: args.context, timeout: DIFF_TIMEOUT_MS },
    );
    if (diffText === undefined) {
      throw new FsError(
        ErrorCode.TOO_LARGE,
        `Diff not computed: the files differ in too many lines to diff within ${String(DIFF_TIMEOUT_MS)} ms. Compare smaller sections with read + startLine/endLine.`,
        args.a,
      );
    }

    const { linesAdded, linesRemoved } = diffStatsFromPatch(diffText);

    // The text block is the one copy of the diff; a model reads that, and a
    // structured duplicate or a store entry would only ship the same bytes again.
    return {
      structured: { a: validA, b: validB, linesAdded, linesRemoved },
      text: diffText,
    };
  },
});
