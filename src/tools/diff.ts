import { basename } from 'node:path';

import * as z from 'zod/v4';
import { createTwoFilesPatch } from 'diff';

import { computeDiffStats } from '../core/diff.ts';
import { NonNegInt, PositiveInt, RequiredPath } from '../core/schema.ts';
import { defineTool, type ToolCtx } from './define.ts';

const DiffInputSchema = z.strictObject({
  a: RequiredPath.describe('First file to compare'),
  b: RequiredPath.describe('Second file to compare'),
  context: PositiveInt.max(50)
    .default(3)
    .describe('Number of context lines surrounding each change (default: 3)'),
});

const DiffOutputSchema = z.strictObject({
  a: z.string().describe('Resolved absolute path of the first file'),
  b: z.string().describe('Resolved absolute path of the second file'),
  // The unified diff itself rides the text content block.
  linesAdded: NonNegInt.describe('Number of lines added'),
  linesRemoved: NonNegInt.describe('Number of lines removed'),
});

async function handleDiff(
  args: z.infer<typeof DiffInputSchema>,
  ctx: ToolCtx,
): Promise<{ structured: z.infer<typeof DiffOutputSchema>; text: string }> {
  const [{ validPath: validA, content: contentA }, { validPath: validB, content: contentB }] =
    await Promise.all([
      ctx.fs.readEditableText(args.a, { signal: ctx.signal, tool: 'diff' }),
      ctx.fs.readEditableText(args.b, { signal: ctx.signal, tool: 'diff' }),
    ]);

  // createTwoFilesPatch returns the unified diff string synchronously on diff v9
  // (the { callback } option does not fire on this version — verified).
  const diffText = createTwoFilesPatch(
    basename(validA),
    basename(validB),
    contentA,
    contentB,
    'a',
    'b',
    { context: args.context },
  );

  const { linesAdded, linesRemoved } = computeDiffStats(contentA, contentB);

  // The text block is the one copy of the diff; a model reads that, and a
  // structured duplicate or a store entry would only ship the same bytes again.
  return {
    structured: { a: validA, b: validB, linesAdded, linesRemoved },
    text: diffText,
  };
}

export const DIFF = defineTool({
  name: 'diff',
  title: 'Diff',
  description: 'Compare two text files and return a unified diff from a to b, like diff -u.',
  input: DiffInputSchema,
  output: DiffOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  progress: (args) => ({
    label: 'Diff',
    subject: basename(args.a),
  }),
  accessPaths: (args) => [args.a, args.b],
  run: (args, ctx) => handleDiff(args, ctx),
});
