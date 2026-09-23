import * as z from 'zod/v4';

import { NO_POSITIONAL_ROOTS_GUIDANCE } from '../core/config.ts';
import { ErrorCode } from '../core/errors.ts';
import { defineTool } from './define.ts';

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
    'List the directories this server can access, as absolute paths, including any the user granted during this session. ' +
    'Other tools can ask the user to grant access to a path outside them.',
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
    // `roots` says the call failed to be useful but not what to do about it;
    // the description names the grant route only in passing. It is conditional
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
