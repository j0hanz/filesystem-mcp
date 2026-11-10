import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import { confirm, type Confirmed } from '../core/confirmation.ts';
import {
  DELETE_ERRNOS,
  DELETE_ERRNOS_NO_CONFIRM,
  ErrorCode,
  FsError,
  Problem,
} from '../core/errors.ts';
import { joinRoster, pathLabel } from '../core/fmt.ts';
import {
  type DeletePlan,
  type GuardedFileSystem,
  identityOf,
  UNKNOWN_IDENTITY,
} from '../core/fs.ts';
import { canElicit } from '../core/input-required.ts';
import { normalizeCaseForComparison } from '../core/path-utils.ts';
import { defaultFalseBoolean, RequiredPath } from '../core/schema.ts';
import {
  type BatchResult,
  cancelMessage,
  executeBatchSlots,
  failureLines,
  isTotalFailure,
  planIntoSlots,
} from './batch.ts';
import type { ToolCtx } from './define.ts';
import { defineTool } from './define.ts';

const DeleteInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(1)
    .max(1000)
    .describe('Paths to delete (max 1000); accepts files, directories, or symlinks'),
  recursive: defaultFalseBoolean(
    'Delete directory contents recursively (required for non-empty directories). A recursive delete of a non-empty directory asks the user to confirm; a client that cannot show a prompt fails with INVALID_INPUT.',
  ),
  ignoreIfNotExists: defaultFalseBoolean(
    'Silently succeed if a path does not exist instead of returning an error',
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

type PlanResult =
  | { status: 'fail'; failure: DeleteFailure }
  | { status: 'noop'; deleted: string }
  | { status: 'plan'; plan: DeletePlan };

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
    if (plan.noop) return { status: 'noop', deleted: plan.validPath };
    return { status: 'plan', plan };
  } catch (error) {
    return { status: 'fail', failure: toDeleteFailure(inputPath, error) };
  }
}

/**
 * Execute one planned path on the retry round through the guarded filesystem.
 * A pending path deletes only on an accepted choice; decline, cancel, a missing key,
 * or an entry replaced again after the re-prompt report CANCELLED for that path.
 */
async function executePlan(
  plan: DeletePlan,
  ctx: Pick<ToolCtx, 'fs' | 'log' | 'signal' | 'clientCapabilities'>,
  confirmed: Confirmed,
): Promise<{ deleted: string } | { failure: DeleteFailure } | { skipped: true; path: string }> {
  const verdict = confirmed.verdict(plan.validPath);
  if (verdict === 'skipped') return { skipped: true as const, path: plan.validPath };
  if (verdict !== 'proceed') {
    const message = cancelMessage('delete', plan.validPath, verdict);
    return {
      failure: {
        path: plan.validPath,
        error: Problem.cancelled(message, { path: plan.validPath }),
      },
    };
  }
  try {
    const res = await ctx.fs.executeDelete(plan, { signal: ctx.signal });
    ctx.log('info', `rm: ${plan.inputPath}`, 'delete');
    return res;
  } catch (error) {
    const rows = canElicit(ctx.clientCapabilities) ? DELETE_ERRNOS : DELETE_ERRNOS_NO_CONFIRM;
    return {
      failure: {
        path: plan.validPath,
        error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, plan.validPath, rows),
      },
    };
  }
}

/** What the Confirmation asks. A person cannot see protected files in any listing, so it names them. */
function deletePrompt(plan: DeletePlan): string {
  if (plan.itemType !== 'directory') return `Delete "${plan.validPath}"?`;
  const question = `Delete "${plan.validPath}" and all its contents?`;
  return plan.holdsProtected
    ? `${question} It holds files protected by the sensitive-file policy, which listings hide, so this delete cannot be undone.`
    : question;
}

async function handleDelete(
  args: DeleteInput,
  ctx: ToolCtx,
): Promise<DeleteOutput | InputRequiredResult> {
  // Duplicate paths collapse: results are keyed by path, so a repeated entry
  // would emit two rows for one deletion and inflate `summary.total`. Exact
  // repeats go here; other spellings of one entry collapse after planning,
  // by validated path, so two on-disk names that fold alike both stay.
  const paths = [...new Set(args.paths)];

  // Phase 1 (no mutation): plan every path.
  const { slots, planned } = await planIntoSlots<string, PlanResult, { deleted: boolean }>(
    paths,
    (inputPath) => inputPath,
    (inputPath) => planPath(inputPath, args, ctx.fs, ctx.signal),
    ctx.signal,
  );

  let plans: { plan: DeletePlan; index: number }[] = [];
  const seenTargets = new Set<string>();

  for (const { index, value: r } of planned) {
    const target = r.status === 'noop' ? r.deleted : r.plan.validPath;
    if (seenTargets.has(target)) {
      slots[index] = { status: 'omitted' };
      continue;
    }
    seenTargets.add(target);
    if (r.status === 'noop') {
      slots[index] = { status: 'settled', path: r.deleted, value: { deleted: true } };
    } else {
      plans.push({ plan: r.plan, index });
    }
  }

  // One entry inside another would race the other's recursive delete, and
  // accepting the parent would remove a child whose own prompt was skipped.
  // Refuse both sides before any prompt or mutation.
  const hits = nestedIndexes(plans.map(({ plan }) => plan.validPath));
  const nested = new Set(plans.flatMap(({ index }, i) => (hits.has(i) ? [index] : [])));
  if (nested.size > 0) {
    for (const { plan, index } of plans) {
      if (!nested.has(index)) continue;
      slots[index] = {
        status: 'failure',
        path: plan.validPath,
        error: Problem.invalidInput(
          'Delete refused: this path contains, or is inside, another path in the batch. Delete the outer one alone.',
          { path: plan.validPath },
        ),
      };
    }
    plans = plans.filter(({ index }) => !nested.has(index));
  }

  // Recursive non-empty directories need the client's approval. While one is
  // due, the round returns input_required atomically (R14: nothing deleted
  // yet, not even the non-pending items in the same call).
  const confirmed = await confirm(
    ctx,
    'delete',
    'delete',
    plans.map(({ plan }) => ({
      path: plan.validPath,
      identity: plan.firstStats ? identityOf(plan.firstStats.stats) : UNKNOWN_IDENTITY,
      required: plan.pending,
      message: deletePrompt(plan),
      warned: plan.holdsProtected,
    })),
  );
  if (isInputRequiredResult(confirmed)) return confirmed;

  // Phase 2 (mutation): execute deletions for every planned path.
  for (const { plan, index } of plans) {
    slots[index] = {
      status: 'pending',
      path: plan.validPath,
      run: async (c) => {
        const r = await executePlan(plan, c, confirmed);
        if ('skipped' in r) return { deleted: false };
        if ('failure' in r) {
          throw new FsError(
            r.failure.error.code,
            r.failure.error.message,
            r.failure.path,
            undefined,
            r.failure.error.suggestion,
          );
        }
        return { deleted: true };
      },
    };
  }

  for (let i = 0; i < paths.length; i++) {
    slots[i] ??= {
      status: 'failure',
      path: paths[i] ?? '(unknown)',
      error: Problem.fromUnknown(new Error('Unknown delete failure'), ErrorCode.UNKNOWN, paths[i]),
    };
  }

  return executeBatchSlots(slots, ctx, { defaultErrorCode: ErrorCode.UNKNOWN });
}

export const DELETE = defineTool<typeof DeleteInputSchema, DeleteOutput>({
  name: 'delete',
  title: 'Delete File',
  description:
    'Delete files, directories, or symlinks, like rm or rm -r. ' +
    'Use when permanently removing paths. Paths are exact (globs are not expanded). ' +
    'While any confirmation is pending, nothing is deleted; on a retry, a path left declined or unanswered reports CANCELLED and the others run. ' +
    'Paths nested inside each other are refused, so delete the outer one alone. ' +
    'One failed path does not stop the others. Paths in read-only directories fail with ACCESS_DENIED. ' +
    'Returns { path, deleted } per path and an undo id; deleting a directory that holds sensitive files cannot be undone. ' +
    'Use move to relocate a path instead.',
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
    const isError = isTotalFailure(structured.summary);
    // A lone failure carries its reason in the text. "delete: . FAILED (0/1 ok)"
    // made the model re-read structuredContent to learn it was ACCESS_DENIED;
    // with one path there is no ambiguity about which message applies.
    if (total === 1 && failed === 1) {
      const only = structured.results[0];
      return {
        structured,
        text: `delete: ${only?.path ?? ''} FAILED — ${only && 'error' in only ? only.error.message : 'unknown error'}`,
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
