import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.ts';
import {
  ErrorCode,
  FsError,
  isMissing,
  isNodeError,
  isNotFoundErrno,
  type PerPathResult,
  Problem,
} from '../core/errors.ts';
import { joinRoster, pathLabel } from '../core/fmt.ts';
import type { FileType, GuardedFileSystem } from '../core/fs.ts';
import {
  confirmKey,
  type PendingDeleteIdentity,
  pendingRoundTrip,
  type PendingState,
  readPendingVerdict,
} from '../core/input-required.ts';
import { isPathInsideDirectory, resolveEntryType } from '../core/path-utils.ts';
import { defaultFalseBoolean, RequiredPath } from '../core/schema.ts';
import { PARALLEL_CONCURRENCY } from '../core/util.ts';
import { type BatchResult, isTotalFailure, summarize } from './batch.ts';
import type { ToolCtx } from './define.ts';
import { defineTool } from './define.ts';

/**
 * One path over time: a replacement made after the plan has a later birth
 * time, so number fields are exact enough here (undo needs bigint ones).
 */
const sameIdentity = (
  a: { dev: number; ino: number; birthtimeMs: number },
  b: { dev: number; ino: number; birthtimeMs: number },
): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;

const DeleteInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(1)
    .max(1000)
    .describe('Paths to delete (max 1000); accepts files, directories, or symlinks'),
  recursive: defaultFalseBoolean(
    'Delete directory contents recursively (required for non-empty directories)',
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
  // A missing path reached here as the raw errno text ("ENOENT: no such file or
  // directory, lstat 'c:\...'"), while `stat` reported the same condition as
  // "Path not found". One condition, one message — and the syscall name stays
  // off the wire.
  if (isNotFoundErrno(error)) {
    return { path, error: new FsError(ErrorCode.NOT_FOUND, 'Path not found', path).problem };
  }
  if (
    isNodeError(error) &&
    (error.code === 'ENOTEMPTY' || error.code === 'EISDIR' || error.code === 'EEXIST')
  ) {
    return {
      path,
      error: Problem.invalidInput('Directory not empty. Set recursive: true.', { path }),
    };
  }
  return { path, error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, path) };
}

type LstatResult = Awaited<ReturnType<GuardedFileSystem['lstat']>>;

/** A path's pre-checked plan: validated, statted, and flagged if it needs confirmation. */
interface DeletePlan {
  inputPath: string;
  validPath: string;
  itemType: FileType;
  firstStats: LstatResult;
  /** Recursive + non-empty directory: needs a round-trip confirmation. */
  pending: boolean;
}

type PlanResult =
  | { status: 'fail'; failure: DeleteFailure }
  | { status: 'noop'; deleted: string }
  | { status: 'plan'; plan: DeletePlan };

/**
 * Phase 1 (no mutation): validate, stat, and decide whether a path needs a
 * confirmation before anything is deleted. A pending path is a recursive
 * non-empty directory; everything else is ready to delete directly.
 */
async function planPath(
  inputPath: string,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  fs: Pick<GuardedFileSystem, 'pathGuard' | 'lstat' | 'hasChildrenUnchecked'>,
): Promise<PlanResult> {
  let validPath: string;
  try {
    validPath = await fs.pathGuard.validatePathForDelete(inputPath);
  } catch (error) {
    if (args.ignoreIfNotExists && isMissing(error)) {
      return { status: 'noop', deleted: inputPath };
    }
    return { status: 'fail', failure: toDeleteFailure(inputPath, error) };
  }

  if (fs.pathGuard.isAllowedRoot(validPath)) {
    return {
      status: 'fail',
      // Keyed by the REQUESTED path, like every other failure here: handleDelete
      // orders results by input path, and a resolved key would not be found for
      // a relative request.
      failure: {
        path: inputPath,
        error: Problem.accessDenied('Deleting a workspace root directory is not allowed', {
          path: validPath,
        }),
      },
    };
  }

  let firstStats: LstatResult;
  try {
    firstStats = await fs.lstat(validPath);
  } catch (error) {
    if (isNotFoundErrno(error) && args.ignoreIfNotExists) {
      return { status: 'noop', deleted: inputPath };
    }
    return { status: 'fail', failure: toDeleteFailure(inputPath, error) };
  }

  const itemType = resolveEntryType(firstStats.stats);
  let hasChildren = false;
  if (args.recursive && itemType === 'directory') {
    try {
      hasChildren = await fs.hasChildrenUnchecked(validPath);
    } catch (error) {
      return { status: 'fail', failure: toDeleteFailure(inputPath, error) };
    }
  }
  return {
    status: 'plan',
    plan: { inputPath, validPath, itemType, firstStats, pending: hasChildren },
  };
}

/**
 * Phase 2 (mutation): TOCTOU re-stat against the plan's first stat, then
 * delete. A type or identity change across the confirmation gap fails closed
 * rather than deleting a replacement object the user never confirmed.
 */
async function finalizeDeletion(
  plan: DeletePlan,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  ctx: Pick<ToolCtx, 'fs' | 'log'>,
): Promise<{ deleted: string } | { failure: DeleteFailure }> {
  let currentStats: LstatResult;
  try {
    currentStats = await ctx.fs.lstat(plan.validPath);
  } catch (error) {
    if (isNotFoundErrno(error) && args.ignoreIfNotExists) {
      return { deleted: plan.validPath };
    }
    return { failure: toDeleteFailure(plan.inputPath, error) };
  }

  const currentItemType = resolveEntryType(currentStats.stats);
  // Identity comparison, not just the coarse category: a swap during the
  // confirmation gap (delete original, create a same-named replacement) keeps
  // the type but changes dev/ino/birthtimeMs. birthtimeMs is the primary
  // cross-platform signal — dev/ino can read 0 on some non-POSIX drivers — so
  // combine all three rather than trusting dev/ino alone.
  const identityChanged = !sameIdentity(plan.firstStats.stats, currentStats.stats);
  if (plan.itemType !== 'other' && (currentItemType !== plan.itemType || identityChanged)) {
    return {
      failure: {
        path: plan.validPath,
        error: Problem.invalidInput(
          `Delete failed: item type changed from ${plan.itemType} to ${currentItemType} during confirmation.`,
          { path: plan.validPath },
        ),
      },
    };
  }

  try {
    if (currentStats.stats.isDirectory() && !args.recursive) await ctx.fs.rmdir(plan.validPath);
    else
      await ctx.fs.rm(plan.validPath, { recursive: args.recursive, force: args.ignoreIfNotExists });
  } catch (error) {
    return { failure: toDeleteFailure(plan.inputPath, error) };
  }

  ctx.log('info', `rm: ${plan.inputPath}`, 'delete');
  return { deleted: plan.validPath };
}

/**
 * Execute one planned path on the retry round. A pending path deletes only on
 * an accepted `confirm: true`; decline, cancel, or a missing key report
 * `CANCELLED` for that path (R3 proceed, R4/R5 cancelled). A non-pending path
 * deletes directly (R14: non-pending items proceed alongside accepted ones).
 */
async function executePlan(
  plan: DeletePlan,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  ctx: Pick<ToolCtx, 'fs' | 'inputResponses' | 'droppedInputResponseKeys' | 'log'>,
  pendingSorted: readonly string[],
  confirmationState: PendingState | undefined,
): Promise<{ deleted: string } | { failure: DeleteFailure } | { skipped: true; path: string }> {
  if (plan.pending) {
    const verdict = readPendingVerdict(ctx, pendingSorted, plan.validPath, 'delete');
    if (verdict === 'skipped') {
      return { skipped: true as const, path: plan.validPath };
    }
    if (verdict !== 'accepted') {
      return {
        failure: {
          path: plan.validPath,
          error: Problem.cancelled(`Delete cancelled: confirmation was ${verdict.refused}`, {
            path: plan.validPath,
          }),
        },
      };
    }
    const identity = confirmationState?.deleteIdentities?.find(
      (entry) => entry.path === plan.validPath,
    );
    if (identity?.itemType !== plan.itemType || !sameIdentity(identity, plan.firstStats.stats)) {
      return {
        failure: {
          path: plan.validPath,
          error: Problem.invalidInput(
            'Delete failed: item identity changed or is missing from the confirmation.',
            { path: plan.validPath },
          ),
        },
      };
    }
  }
  return finalizeDeletion(plan, args, ctx);
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
    (inputPath) => planPath(inputPath, args, ctx.fs),
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  const out = new Array<DeletePerPathResult | undefined>(paths.length).fill(undefined);
  let plans: { plan: DeletePlan; index: number }[] = [];
  const confirmationState = ctx.requestState?.<PendingState>();
  const previouslyPendingPaths = new Set(
    confirmationState?.op === 'delete' ? confirmationState.paths : [],
  );
  const seenTargets = new Set<string>();
  const duplicates = new Set<number>();
  for (const { index, value: r } of planned.results) {
    if (r.status === 'fail') {
      out[index] = { path: r.failure.path, error: r.failure.error };
      continue;
    }
    const target = r.status === 'noop' ? r.deleted : r.plan.validPath;
    if (seenTargets.has(target)) {
      duplicates.add(index);
      continue;
    }
    seenTargets.add(target);
    if (r.status === 'noop') out[index] = { path: r.deleted, value: { deleted: true } };
    else {
      // Emptying a directory while its prompt is open must not discard the
      // answer. Keep that path pending so the verified retry still honors skip.
      r.plan.pending ||= previouslyPendingPaths.has(r.plan.validPath);
      plans.push({ plan: r.plan, index });
    }
  }
  // planPath returns its failures; a slot it never filled falls to the fallback below.

  // One entry inside another would race the other's recursive delete, and
  // accepting the parent would remove a child whose own prompt was skipped.
  // Refuse both sides before any prompt or mutation.
  const nested = new Set<number>();
  for (const [i, a] of plans.entries()) {
    for (const b of plans.slice(i + 1)) {
      if (
        isPathInsideDirectory(a.plan.validPath, b.plan.validPath) ||
        isPathInsideDirectory(b.plan.validPath, a.plan.validPath)
      ) {
        nested.add(a.index).add(b.index);
      }
    }
  }
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

  // Pending set: recursive + non-empty directories, sorted and de-duplicated.
  // `buildInputRequired` seals exactly this set into the requestState, and the
  // retried round recomputes it from the same args so a swapped retry (accept
  // for X, retry with Y) is rejected — the codec only proves the state was not
  // tampered, not that it matches the current request (R9).
  const pendingSorted = [
    ...new Set(plans.filter((p) => p.plan.pending).map((p) => p.plan.validPath)),
  ].sort();

  // With no actionable plans, preserve per-path NOT_FOUND / ignoreIfNotExists
  // results. Otherwise even an empty pending set must be checked before an
  // unrelated non-pending batch entry can mutate.
  if (pendingSorted.length > 0 || (confirmationState?.op === 'delete' && plans.length > 0)) {
    // Round 1 returns input_required (atomic — R14: nothing deleted yet, not
    // even the non-pending items in the same call); a retry whose verified
    // state does not bind this pending set throws (R9) via `pendingRoundTrip`.
    const round = await pendingRoundTrip(ctx, {
      op: 'delete',
      pending: pendingSorted,
      deleteIdentities: plans
        .filter(({ plan }) => plan.pending)
        .map(({ plan }): PendingDeleteIdentity => {
          const { dev, ino, birthtimeMs } = plan.firstStats.stats;
          return { path: plan.validPath, itemType: plan.itemType, dev, ino, birthtimeMs };
        }),
      buildInputs: (ps) =>
        ps.map((p, i) => ({
          key: confirmKey(i),
          message: `Delete "${p}" and all its contents?`,
          choices: ['delete', 'skip'],
        })),
    });
    if (round !== undefined) return round;
  }

  // Phase 2 (mutation): execute deletions for every planned path.
  const executed = await processInParallel(
    plans,
    ({ plan }) => executePlan(plan, args, ctx, pendingSorted, confirmationState),
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
    'Delete files, directories, or symlinks, like rm or rm -r. Paths are exact; globs are not expanded. ' +
    'undo reverts a delete whose result gives an undo id.',
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
    return { structured, text: `delete: ${joinRoster(tokens)}${ratio}`, isError };
  },
});
