import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import {
  DELETE_ERRNOS,
  DELETE_ERRNOS_NO_CONFIRM,
  ErrorCode,
  isRefusal,
  Problem,
} from '../core/errors.ts';
import { joinRoster, pathLabel } from '../core/fmt.ts';
import {
  type DeletePlan,
  type GuardedFileSystem,
  identityOf,
  sameIdentity,
  UNKNOWN_IDENTITY,
} from '../core/fs.ts';
import { canElicit } from '../core/input-required.ts';
import { normalizeCaseForComparison } from '../core/path-utils.ts';
import { defaultFalseBoolean, RequiredPath } from '../core/schema.ts';
import {
  type BatchResult,
  failureLines,
  isTotalFailure,
  planBatch,
  type PlanOutcome,
} from './batch.ts';
import type { ToolCtx } from './define.ts';
import { defineTool } from './define.ts';

const DeleteInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(1)
    .max(1000)
    .describe('Exact paths (no globs): files, directories, or symlinks. Duplicates collapse'),
  recursive: defaultFalseBoolean('Required for a non-empty directory, else INVALID_INPUT.'),
  ignoreIfNotExists: defaultFalseBoolean(
    'True: a missing path returns deleted: true instead of failing NOT_FOUND',
  ),
});

type DeleteInput = z.infer<typeof DeleteInputSchema>;
type DeleteOutput = BatchResult<{ deleted: boolean }>;

// Internal types for error handling
interface DeleteFailure {
  path: string;
  error: Problem;
}

function toDeleteFailure(path: string, error: unknown): DeleteFailure {
  return { path, error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, path, DELETE_ERRNOS) };
}

type PlanResult = PlanOutcome<DeletePlan, { deleted: boolean }>;

/**
 * Phase 1 (no mutation): plan every path through the guarded filesystem.
 */
async function planPath(
  inputPath: string,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  fs: GuardedFileSystem,
  signal?: AbortSignal,
): Promise<PlanResult> {
  try {
    const plan = await fs.planDelete(inputPath, {
      recursive: args.recursive,
      ignoreIfNotExists: args.ignoreIfNotExists,
      signal,
    });
    if (plan.noop) {
      return {
        status: 'settled',
        path: plan.validPath,
        value: { deleted: true },
        landing: plan.validPath,
      };
    }
    return { status: 'plan', plan };
  } catch (error) {
    return { status: 'fail', failure: toDeleteFailure(inputPath, error) };
  }
}

/**
 * Execute one approved plan through the guarded filesystem.
 */
async function executePlan(
  plan: DeletePlan,
  ctx: Pick<ToolCtx, 'fs' | 'log' | 'signal' | 'clientCapabilities'>,
): Promise<{ deleted: boolean }> {
  try {
    await ctx.fs.executeDelete(plan, { signal: ctx.signal });
    ctx.log('info', `rm: ${plan.inputPath}`, 'delete');
    return { deleted: true };
  } catch (error) {
    const rows = canElicit(ctx.clientCapabilities) ? DELETE_ERRNOS : DELETE_ERRNOS_NO_CONFIRM;
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Batch catches and preserves non-Error Problem
    throw Problem.fromUnknown(error, ErrorCode.UNKNOWN, plan.validPath, rows);
  }
}

/** What the Confirmation asks. A person cannot see protected files in any listing, so it names them. */
function deletePrompt(plan: DeletePlan): string {
  if (plan.itemType !== 'directory') return `Delete "${plan.validPath}"?`;
  const question = `Delete "${plan.validPath}" and all its contents?`;
  return plan.holdsProtected
    ? `${question} It holds protected files that listings hide, so this delete cannot be undone.`
    : question;
}

async function handleDelete(
  args: DeleteInput,
  ctx: ToolCtx,
): Promise<DeleteOutput | InputRequiredResult> {
  const ready = await planBatch<string, DeletePlan, { deleted: boolean }>(
    {
      op: 'delete',
      accept: 'delete',
      items: args.paths,
      pathOf: (inputPath) => inputPath,
      plan: (inputPath) => planPath(inputPath, args, ctx.fs, ctx.signal),
      slotPath: (plan) => plan.validPath,
      landing: (plan) => plan.validPath,
      // Duplicate paths collapse: results are keyed by path, so a repeated
      // entry would emit two rows for one deletion and inflate `summary.total`.
      duplicates: {
        policy: 'collapse',
        sameEntry: (plan, earlier) =>
          plan.firstStats !== undefined &&
          earlier.firstStats !== undefined &&
          sameIdentity(identityOf(earlier.firstStats.stats), identityOf(plan.firstStats.stats)),
      },
      // One entry inside another would race the other's recursive delete, and
      // accepting the parent would remove a child whose own prompt was skipped.
      // Refuse both sides before any prompt or mutation.
      refuse: (plans) => {
        const hits = nestedIndexes(plans.map(({ plan }) => plan.validPath));
        return Promise.resolve(
          new Map(
            plans.flatMap(({ plan, index }, i) =>
              hits.has(i)
                ? [
                    [
                      index,
                      Problem.invalidInput(
                        'Delete refused: this path contains or is inside another path in the batch. Delete the outer one alone.',
                        { path: plan.validPath },
                      ),
                    ] as const,
                  ]
                : [],
            ),
          ),
        );
      },
      // Recursive non-empty directories need the client's approval.
      confirmItem: (plan) => ({
        path: plan.validPath,
        identity: plan.firstStats ? identityOf(plan.firstStats.stats) : UNKNOWN_IDENTITY,
        required: plan.pending,
        message: deletePrompt(plan),
        warned: plan.holdsProtected,
      }),
      onRefusal: 'fail slot',
      skipped: () => ({ deleted: false }),
      run: (plan, _path, c) => executePlan(plan, c),
    },
    ctx,
  );
  if (isInputRequiredResult(ready)) return ready;
  return ready.execute();
}

export const DELETE = defineTool<typeof DeleteInputSchema, DeleteOutput>({
  name: 'delete',
  title: 'Delete Paths',
  description:
    'Delete files, directories, and symlinks. Use when a path should no longer exist. ' +
    'Do not use it to rename or relocate; use `move` instead, and `undo` to restore. ' +
    'A symlink is removed, never its target. ' +
    'A non-empty directory needs `recursive: true`; without it, that path fails INVALID_INPUT. ' +
    'With it, the user must confirm. Nothing is deleted until every prompt is answered. ' +
    'A client that cannot prompt fails the whole call INVALID_INPUT. ' +
    'Deleting a folder that holds protected files cannot be undone. ' +
    'Other failures hit only their own path: ACCESS_DENIED for a root, read-only, or outside path; CANCELLED when refused or changed; INVALID_INPUT for a nested pair. ' +
    'Returns per-path { deleted } or { error } (a skipped prompt gives deleted: false), a summary, and an undo id valid 30 minutes, or undoUnavailable with the reason.',
  input: DeleteInputSchema,
  readOnlyHint: false,
  progress: (args) => ({
    label: 'Delete',
    subject:
      args.paths.length === 1
        ? basename(args.paths[0] ?? '')
        : `${String(args.paths.length)} paths`,
  }),
  mapPaths: (args, fn) => ({ ...args, paths: args.paths.map(fn) }),
  run: async (args, ctx) => {
    const structured = await handleDelete(args, ctx);
    // input_required is a return value, not a completed call: surface it
    // verbatim so the executor short-circuits before building a CallToolResult.
    if (isInputRequiredResult(structured)) return structured;
    // Name every path and its outcome. The old text said "deleted 2 paths"
    // without saying which two, so a partial failure was unreadable without
    // parsing the structured half.
    const { failed, total } = structured.summary;
    // A refusal is an answer the model can report; only a real failure is an error.
    const isError =
      isTotalFailure(structured.summary) &&
      structured.results.some((r) => 'error' in r && !isRefusal(r.error));
    // A lone failure carries its reason in the text. "delete: . FAILED (0/1 ok)"
    // made the model re-read structuredContent to learn it was ACCESS_DENIED;
    // with one path there is no ambiguity about which message applies.
    if (total === 1 && failed === 1) {
      const only = structured.results[0];
      return {
        structured,
        text: `delete: ${only?.path ?? ''} FAILED: ${only && 'error' in only ? only.error.message : 'unknown error'}`,
        isError,
      };
    }
    const tokens = structured.results.map((r) => {
      const label = pathLabel(r.path);
      if ('error' in r) return `${label} FAILED`;
      return r.value.deleted ? label : `${label} SKIPPED`;
    });
    const ratio = failed > 0 ? ` (${String(total - failed)}/${String(total)} ok)` : '';
    const text = [`delete: ${joinRoster(tokens)}${ratio}`, ...failureLines(structured.results)];
    return { structured, text: text.join('\n'), isError };
  },
});

/** Positions of every path that contains, equals or sits inside another. Linear in paths x depth. */
export function nestedIndexes(paths: readonly string[]): Set<number> {
  const groups = new Map<string, number[]>();
  for (const [i, path] of paths.entries()) {
    const key = normalizeCaseForComparison(path);
    const group = groups.get(key);
    if (group) group.push(i);
    else groups.set(key, [i]);
  }
  const nested = new Set<number>();
  for (const group of groups.values()) {
    if (group.length > 1) {
      const exact = new Set(group.map((i) => paths[i]));
      if (exact.size < group.length) for (const i of group) nested.add(i);
    }
  }
  for (const [i, path] of paths.entries()) {
    for (let dir = dirname(path), up = dirname(dir); ; dir = up, up = dirname(dir)) {
      const group = groups.get(normalizeCaseForComparison(dir));
      if (group) {
        nested.add(i);
        for (const j of group) nested.add(j);
      }
      if (up === dir) break;
    }
  }
  return nested;
}
