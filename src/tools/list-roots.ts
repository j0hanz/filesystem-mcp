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
    'List roots this server can access and its read-only directories. ' +
    'Use for allowed paths or after ACCESS_DENIED. ' +
    'Do not use it to browse; use `list`, `find_files`, or `stat` instead. ' +
    'Accepted grants add roots; call again after one. ' +
    'Outside paths prompt a grant only on elicitation clients, never for home, system paths, or anything outside FS_ROOT_BOUNDARY. ' +
    'Returns absolute { roots, readOnlyDirs (writes, moves, deletes refused), hint? when roots is empty }.',
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
