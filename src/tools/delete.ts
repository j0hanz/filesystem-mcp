import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.ts';
import { confirm, type Confirmed } from '../core/confirmation.ts';
import {
  DELETE_ERRNOS,
  DELETE_ERRNOS_NO_CONFIRM,
  ErrorCode,
  type PerPathResult,
  Problem,
} from '../core/errors.ts';
import { joinRoster, pathLabel } from '../core/fmt.ts';
import { type DeletePlan, type GuardedFileSystem, identityOf } from '../core/fs.ts';
import { canElicit } from '../core/input-required.ts';
import { normalizeCaseForComparison } from '../core/path-utils.ts';
import { defaultFalseBoolean, RequiredPath } from '../core/schema.ts';
import { PARALLEL_CONCURRENCY } from '../core/util.ts';
import { type BatchResult, failureLines, isTotalFailure, summarize } from './batch.ts';
import type { ToolCtx } from './define.ts';
import { defineTool } from './define.ts';

const DeleteInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(1)
    .max(1000)
    .describe('Paths to delete (max 1000); accepts files, directories, or symlinks'),
  recursive: defaultFalseBoolean(
    'Delete directory contents recursively (required for non-empty directories). A recursive delete of a non-empty directory asks the user to confirm; a client that cannot show a prompt fails with INVALID_INPUT and nothing in the call is deleted.',
  ),
  ignoreIfNotExists: defaultFalseBoolean(
    'Silently succeed if a path does not exist instead of returning an error',
  ),
});

type DeleteInput = z.infer<typeof DeleteInputSchema>;
type DeleteOutput = BatchResult<{ deleted: boolean }>;
type DeletePerPathResult = PerPathResult<{ deleted: boolean }>;

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
    const message =
      verdict === 'changed'
        ? `Delete cancelled: "${plan.validPath}" was replaced again while the prompt was open.`
        : `Delete cancelled: confirmation was ${verdict.refused}`;
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
  const planned = await processInParallel(
    paths,
    (inputPath) => planPath(inputPath, args, ctx.fs, ctx.signal),
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  const out = new Array<DeletePerPathResult | undefined>(paths.length).fill(undefined);
  let plans: { plan: DeletePlan; index: number }[] = [];
  const seenTargets = new Set<string>();
  const duplicates = new Set<number>();
  for (const { index, value: r } of planned.results) {
    if (r.status === 'fail') {
      out[index] = { path: r.failure.path, error: r.failure.error };
      continue;
    }
    const target = normalizeCaseForComparison(
      r.status === 'noop' ? r.deleted : r.plan.validPath,
    );
    if (seenTargets.has(target)) {
      duplicates.add(index);
      continue;
    }
    seenTargets.add(target);
    if (r.status === 'noop') out[index] = { path: r.deleted, value: { deleted: true } };
    else plans.push({ plan: r.plan, index });
  }
  // planPath returns its failures; a slot it never filled falls to the fallback below.

  // One entry inside another would race the other's recursive delete, and
  // accepting the parent would remove a child whose own prompt was skipped.
  // Refuse both sides before any prompt or mutation.
  const hits = nestedIndexes(plans.map(({ plan }) => plan.validPath));
  const nested = new Set(plans.flatMap(({ index }, i) => (hits.has(i) ? [index] : [])));
  if (nested.size > 0) {
    for (const { plan, index } of plans) {
      if (!nested.has(index)) continue;
      out[index] = {
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
      identity: plan.firstStats ? identityOf(plan.firstStats.stats) : undefined,
      required: plan.pending,
      message: deletePrompt(plan),
    })),
  );
  if (isInputRequiredResult(confirmed)) return confirmed;

  // Phase 2 (mutation): execute deletions for every planned path.
  const executed = await processInParallel(
    plans,
    ({ plan }) => executePlan(plan, ctx, confirmed),
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  for (const { index, value: r } of executed.results) {
    const slot = plans[index]?.index;
    if (slot === undefined) continue;
    if ('skipped' in r) {
      out[slot] = { path: r.path, value: { deleted: false } };
    } else if ('failure' in r) {
      out[slot] = { path: r.failure.path, error: r.failure.error };
    } else {
      out[slot] = { path: r.deleted, value: { deleted: true } };
    }
  }
  for (const { index, error } of executed.errors) {
    const slot = plans[index]?.index;
    if (slot === undefined) continue;
    out[slot] = {
      path: paths[slot] ?? '(unknown)',
      error: { code: ErrorCode.UNKNOWN, message: error.message },
    };
  }

  // Emit in the caller's input order so `results[i]` lines up with `paths[i]`
  // the way read/stat guarantee.
  const results: DeletePerPathResult[] = paths.flatMap((requested, i) => {
    if (duplicates.has(i)) return [];
    const entry = out[i];
    return [
      entry ?? {
        path: requested,
        error: { code: ErrorCode.UNKNOWN, message: 'Unknown delete failure' },
      },
    ];
  });

  return { results, summary: summarize(results) };
}

export const DELETE = defineTool<typeof DeleteInputSchema, DeleteOutput>({
  name: 'delete',
  title: 'Delete File',
  description:
    'Delete files, directories, or symlinks, like rm or rm -r. ' +
    'Use when permanently removing paths. Paths are exact (globs are not expanded). ' +
    'Non-empty directories require recursive: true and confirmation. ' +
    'Set ignoreIfNotExists: true to succeed cleanly if a path is already absent. ' +
    'Returns { path, deleted } per path and an undo id. Use move to relocate a path instead.',
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
  for (const group of groups.values()) if (group.length > 1) for (const i of group) nested.add(i);
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
