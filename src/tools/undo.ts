import * as z from 'zod/v4';

import { ErrorCode, FsError } from '../core/errors.ts';
import { joinRoster, pathLabel } from '../core/fmt.ts';
import { defaultFalseBoolean } from '../core/schema.ts';
import type { UndoEntry, UndoFileResult } from '../core/undo.ts';
import { restoreEntry } from '../core/undo.ts';
import { defineTool } from './define.ts';

const UndoInputSchema = z.strictObject({
  // No `.refine`, no regex: the SDK answers a failed refine with a plain
  // `Input validation error` that carries no repo error code (see define.ts).
  // The cross-field rule is checked in `run`.
  id: z.string().min(1).max(16).optional().describe('The undo id from a tool result'),
  steps: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Revert the last N calls (not over HTTP)'),
  dryRun: defaultFalseBoolean('Preview which calls would restore, changing nothing'),
});

interface UndoOutput {
  steps: { id: string; tool: string; results: UndoFileResult[] }[];
}

const SKIPPED_OR_FAILED = (r: UndoFileResult): boolean => 'error' in r;

export const UNDO = defineTool<typeof UndoInputSchema, UndoOutput>({
  name: 'undo',
  title: 'Undo',
  description:
    'Revert earlier calls that changed files, by undo id or the last N calls. A file is restored only if unchanged since. dryRun lists the history.',
  input: UndoInputSchema,
  readOnlyHint: false,
  noUndo: true,
  defaultErrorCode: ErrorCode.NOT_FOUND,
  progress: (args) => ({
    label: 'Undo',
    subject: args.id !== undefined ? `id ${args.id}` : 'last calls',
  }),
  run: async (args, ctx) => {
    const journal = ctx.undoJournal;
    if (!journal.enabled) {
      throw new FsError(ErrorCode.INVALID_INPUT, 'Undo is disabled (FS_MAX_UNDO_BYTES=0).');
    }
    const { id, steps, dryRun } = args;
    if (id !== undefined && steps !== undefined) {
      throw new FsError(ErrorCode.INVALID_INPUT, 'Pass id or steps, not both.');
    }
    // The HTTP journal is shared by every client of the endpoint, so "the last
    // N calls" there are anyone's calls; only an undo id names your own.
    if (ctx.transport === 'http' && (steps !== undefined || (id === undefined && !dryRun))) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'Over HTTP, pass the undo id from the tool result (or call undo with dryRun: true to list them).',
      );
    }
    let entries: UndoEntry[];
    if (id !== undefined) {
      const entry = journal.get(id);
      if (entry === undefined) {
        throw new FsError(ErrorCode.NOT_FOUND, `Unknown or expired undo id "${id}".`);
      }
      entries = [entry];
    } else if (steps !== undefined) {
      entries = journal.newest(steps);
    } else if (dryRun) {
      entries = journal.list();
    } else {
      entries = journal.newest(1);
    }
    if (entries.length === 0) {
      return { structured: { steps: [] }, text: 'undo: nothing to undo' };
    }

    // Newest first: reverting the latest call first keeps the older checks
    // valid (their recorded bytes are what the latest call left behind only
    // once the later writes are gone).
    const stepResults: UndoOutput['steps'] = [];
    let total = 0;
    let skippedOrFailed = 0;
    // One simulated-state map across every entry: a dry run must see what
    // reverting the newer entries would change, or its per-step preview lies.
    const simulated = dryRun ? new Map<string, string | null>() : undefined;
    const relocations: [string, string][] = [];
    for (const entry of entries) {
      ctx.signal.throwIfAborted();
      const outcome = await restoreEntry(entry, ctx.fs, {
        dryRun,
        simulated,
        relocations,
        signal: ctx.signal,
        onRewrite: (was, identity) => {
          journal.reidentify(was, identity);
        },
      });
      if (!dryRun) journal.replaceRecords(entry.id, outcome.remaining);
      // A cancelled restore keeps what it finished: done records left the journal above.
      ctx.signal.throwIfAborted();
      stepResults.push({ id: entry.id, tool: entry.tool, results: outcome.results });
      total += outcome.results.length;
      skippedOrFailed += outcome.results.filter(SKIPPED_OR_FAILED).length;
    }

    const text = stepResults
      .map((step) => {
        const roster = step.results.map((r) => {
          const label = pathLabel(r.path);
          if (!('error' in r)) return label;
          return `${label}${r.error.code === ErrorCode.CANCELLED ? ' SKIPPED' : ' FAILED'}`;
        });
        return `undo: ${step.id} (${step.tool}) ${joinRoster(roster)}`;
      })
      .join(' · ');
    return {
      structured: { steps: stepResults },
      text,
      isError: total > 0 && skippedOrFailed === total,
    };
  },
});
