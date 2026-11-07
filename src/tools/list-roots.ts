import * as z from 'zod/v4';

import { NO_POSITIONAL_ROOTS_GUIDANCE } from '../core/config.ts';
import { defineTool } from './define.ts';

const RootsInputSchema = z.strictObject({});

interface RootsOutput {
  roots: string[];
  /** Configured read-only directories; writes, moves, and deletes under them are refused. */
  readOnlyDirs: string[];
  hint?: string;
}

export const LIST_ROOTS = defineTool<typeof RootsInputSchema, RootsOutput>({
  name: 'list_roots',
  title: 'Workspace Roots',
  description:
    'List the workspace directory roots this server can access, including session-granted roots. ' +
    'Use when starting a session or checking accessible directory boundaries. ' +
    'Returns { roots, readOnlyDirs } as absolute paths. Mutating operations under readOnlyDirs are refused with ACCESS_DENIED. ' +
    'Other tools prompt for approval when accessing paths outside these roots.',
  input: RootsInputSchema,
  readOnlyHint: true,
  run: (_args, ctx) => {
    const dirs = ctx.fs.pathGuard.getRoots();
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
        readOnlyDirs: ctx.fs.pathGuard.getReadOnlyDirs(),
        ...(dirs.length === 0 ? { hint: NO_POSITIONAL_ROOTS_GUIDANCE } : {}),
      },
    });
  },
});
