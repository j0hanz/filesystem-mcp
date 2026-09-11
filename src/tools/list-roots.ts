import * as z from 'zod/v4';

import { NO_POSITIONAL_ROOTS_GUIDANCE } from '../core/config.js';
import { ErrorCode } from '../core/errors.js';
import { defineTool } from './define.js';

const RootsInputSchema = z.strictObject({});

const RootsOutputSchema = z.strictObject({
  roots: z.array(z.string()).describe('Absolute paths of the allowed workspace root directories'),
  hint: z
    .string()
    .optional()
    .describe('How to configure roots; present only when there are none to list'),
});

export const LIST_ROOTS = defineTool({
  name: 'list_roots',
  title: 'Workspace Roots',
  description:
    'List the allowed workspace root directories. Call this first to discover what paths are accessible; all other tools are scoped to these roots. Allowed directories are configured via CLI arguments, the FS_ALLOWED_DIRS environment variable, or --allow-cwd.',
  input: RootsInputSchema,
  output: RootsOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  run: (_args, ctx) => {
    const dirs = ctx.fs.pathGuard.getAllowedDirectories();
    // No `text` on purpose. A newline-joined path list and the JSON say the
    // same thing, and the JSON is the shape every caller of this tool parses.
    // Supplying no text makes this a data tool, so `define.ts` renders the JSON
    // and keeps it in `structuredContent`.
    //
    // `hint` rides the same JSON so the recovery reaches every client. An empty
    // `roots` says the call failed to be useful but not what to do about it,
    // and the elicitation route out — call a tool with a concrete path and
    // approve the grant — appears in no tool description. It is conditional
    // because a configured server pays nothing to be told how to configure.
    return Promise.resolve({
      structured: {
        roots: [...dirs],
        ...(dirs.length === 0 ? { hint: NO_POSITIONAL_ROOTS_GUIDANCE } : {}),
      },
    });
  },

  defaultErrorCode: ErrorCode.UNKNOWN,
});
