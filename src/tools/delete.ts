import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.js';
import {
  ErrorCode,
  FsError,
  isFsError,
  isNodeError,
  isNotFoundErrno,
  Problem,
} from '../core/errors.js';
import { joinRoster, pathLabel } from '../core/fmt.js';
import type { FileType, GuardedFileSystem } from '../core/fs.js';
import {
  choiceInput,
  confirmKey,
  pendingRoundTrip,
  readAcceptedChoice,
} from '../core/input-required.js';
import { resolveEntryType } from '../core/primitives.js';
import {
  defaultFalseBoolean,
  OperationSummarySchema,
  PerFileErrorSchema,
  RequiredPath,
} from '../core/schema.js';
import { PARALLEL_CONCURRENCY } from '../core/util.js';
import { isTotalFailure } from './batch.js';
import type { ToolCtx } from './define.js';
import { defineTool } from './define.js';

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

const DeletePerPathValueSchema = z.strictObject({
  deleted: z.boolean().describe('True when the path was removed; false when the user chose Skip'),
});

const DeletePerPathSchema = z.strictObject({
  path: z.string().describe('Requested path'),
  value: DeletePerPathValueSchema.optional().describe('Delete outcome; present on success'),
  error: PerFileErrorSchema.optional().describe('Error details; present on failure'),
});

// One envelope for every batch tool: `read` and `stat` already answer with
// `{ results, summary }`, so `delete` does too. The old shape switched between
// `{ ok, path }` and `{ ok: false, failures }` depending on the outcome, which
// left a caller parsing two schemas for one tool and never named the paths in a
// multi-delete's text.
const DeleteOutputSchema = z.strictObject({
  results: z
    .array(DeletePerPathSchema)
    .describe('Per-path results ordered to match the input paths'),
  summary: OperationSummarySchema,
});

type DeleteInput = z.infer<typeof DeleteInputSchema>;
type DeleteOutput = z.infer<typeof DeleteOutputSchema>;
type DeletePerPathResult = z.infer<typeof DeletePerPathSchema>;

// Internal types for error handling
interface DeletedItem {
  path: string;
}
interface DeleteFailure {
  path: string;
  error: Problem;
}

const ERR_NOT_EMPTY = new Error('Directory not empty. Set recursive: true.');

function toDeleteFailure(path: string, error: unknown): DeleteFailure {
  // A missing path reached here as the raw errno text ("ENOENT: no such file or
  // directory, lstat 'c:\...'"), while `stat` reported the same condition as
  // "Path not found". One condition, one message — and the syscall name stays
  // off the wire.
  if (isNotFoundErrno(error)) {
    return {
      path,
      error: Problem.fromUnknown(
        new FsError(ErrorCode.NOT_FOUND, 'Path not found', path),
        ErrorCode.NOT_FOUND,
        path,
      ),
    };
  }
  if (
    isNodeError(error) &&
    (error.code === 'ENOTEMPTY' || error.code === 'EISDIR' || error.code === 'EEXIST')
  ) {
    return {
      path,
      error: Problem.fromUnknown(ERR_NOT_EMPTY, ErrorCode.INVALID_INPUT, path),
    };
  }
  return { path, error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, path) };
}

type LstatResult = Awaited<ReturnType<GuardedFileSystem['lstat']>>;
type ItemType = FileType;

/** A path's pre-checked plan: validated, statted, and flagged if it needs confirmation. */
interface DeletePlan {
  inputPath: string;
  validPath: string;
  itemType: ItemType;
  firstStats: LstatResult;
  /** Recursive + non-empty directory: needs a round-trip confirmation. */
  pending: boolean;
}

type PlanResult =
  | { status: 'fail'; failure: DeleteFailure }
  | { status: 'noop'; item: DeletedItem }
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
    if (
      args.ignoreIfNotExists &&
      ((isFsError(error) && error.code === ErrorCode.NOT_FOUND) || isNotFoundErrno(error))
    ) {
      return { status: 'noop', item: { path: inputPath } };
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
      return { status: 'noop', item: { path: inputPath } };
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
  const pending = hasChildren;
  return { status: 'plan', plan: { inputPath, validPath, itemType, firstStats, pending } };
}

async function performDeletion(
  validPath: string,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  isDirectory: boolean,
  fsOps: Pick<GuardedFileSystem, 'rm' | 'rmdir'>,
): Promise<void> {
  if (isDirectory && !args.recursive) {
    await fsOps.rmdir(validPath);
  } else {
    await fsOps.rm(validPath, {
      recursive: args.recursive,
      force: args.ignoreIfNotExists,
    });
  }
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
): Promise<{ item: DeletedItem } | { failure: DeleteFailure }> {
  let currentStats: LstatResult;
  try {
    currentStats = await ctx.fs.lstat(plan.validPath);
  } catch (error) {
    if (isNotFoundErrno(error) && args.ignoreIfNotExists) {
      return { item: { path: plan.validPath } };
    }
    return { failure: toDeleteFailure(plan.inputPath, error) };
  }

  const currentItemType = resolveEntryType(currentStats.stats);
  // Identity comparison, not just the coarse category: a swap during the
  // confirmation gap (delete original, create a same-named replacement) keeps
  // the type but changes dev/ino/birthtimeMs. birthtimeMs is the primary
  // cross-platform signal — dev/ino can read 0 on some non-POSIX drivers — so
  // combine all three rather than trusting dev/ino alone.
  const identityChanged =
    plan.firstStats.stats.dev !== currentStats.stats.dev ||
    plan.firstStats.stats.ino !== currentStats.stats.ino ||
    plan.firstStats.stats.birthtimeMs !== currentStats.stats.birthtimeMs;
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
    await performDeletion(plan.validPath, args, currentStats.stats.isDirectory(), ctx.fs);
  } catch (error) {
    return { failure: toDeleteFailure(plan.inputPath, error) };
  }

  ctx.log?.('info', `rm: ${plan.inputPath}`, 'delete');
  return { item: { path: plan.validPath } };
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
  ctx: Pick<ToolCtx, 'fs' | 'inputResponses' | 'log'>,
  pendingSorted: readonly string[],
): Promise<{ item: DeletedItem } | { failure: DeleteFailure } | { skipped: true; path: string }> {
  if (plan.pending) {
    const key = confirmKey(pendingSorted.indexOf(plan.validPath));
    const choice = readAcceptedChoice(ctx.inputResponses, key);
    if (choice === 'skip') {
      return { skipped: true as const, path: plan.validPath };
    }
    if (choice !== 'delete') {
      return {
        failure: {
          path: plan.validPath,
          error: Problem.cancelled('Delete cancelled: confirmation was declined or missing', {
            path: plan.validPath,
          }),
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
  // would emit two rows for one deletion and inflate `summary.total`.
  const paths = [...new Set(args.paths)];

  // Phase 1 (no mutation): plan every path.
  const planned = await processInParallel(
    paths,
    (inputPath) => planPath(inputPath, args, ctx.fs),
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  const out = new Array<DeletePerPathResult | undefined>(paths.length).fill(undefined);
  const plans: { plan: DeletePlan; index: number }[] = [];
  for (const { index, value: r } of planned.results) {
    if (r.status === 'fail') out[index] = { path: r.failure.path, error: r.failure.error };
    else if (r.status === 'noop') out[index] = { path: r.item.path, value: { deleted: true } };
    else plans.push({ plan: r.plan, index });
  }
  for (const { index, error } of planned.errors) {
    out[index] = {
      path: paths[index] ?? '(unknown)',
      error: { code: ErrorCode.UNKNOWN, message: error.message },
    };
  }

  // Pending set: recursive + non-empty directories, sorted and de-duplicated.
  // `buildInputRequired` seals exactly this set into the requestState, and the
  // retried round recomputes it from the same args so a swapped retry (accept
  // for X, retry with Y) is rejected — the codec only proves the state was not
  // tampered, not that it matches the current request (R9).
  const pendingSorted = [
    ...new Set(plans.filter((p) => p.plan.pending).map((p) => p.plan.validPath)),
  ].sort();

  if (pendingSorted.length > 0) {
    // Round 1 returns input_required (atomic — R14: nothing deleted yet, not
    // even the non-pending items in the same call); a retry whose verified
    // state does not bind this pending set throws (R9) via `pendingRoundTrip`.
    const round = await pendingRoundTrip({
      op: 'delete',
      pending: pendingSorted,
      requestState: ctx.requestState,
      clientCapabilities: ctx.clientCapabilities,
      buildInputs: (ps) =>
        ps.map((p, i) =>
          choiceInput(
            confirmKey(i),
            `Permanently delete "${p}" and all its contents? This cannot be undone.`,
            [
              { value: 'delete', title: 'Delete' },
              { value: 'skip', title: 'Skip' },
            ],
          ),
        ),
    });
    if (round !== undefined) return round;
  }

  // Phase 2 (mutation): execute deletions for every planned path.
  const executed = await processInParallel(
    plans,
    ({ plan }) => executePlan(plan, args, ctx, pendingSorted),
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
    } else if (r.item.path) {
      out[slot] = { path: r.item.path, value: { deleted: true } };
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
  const results: DeletePerPathResult[] = paths.map((requested, i) => {
    const entry = out[i];
    return (
      entry ?? {
        path: requested,
        error: { code: ErrorCode.UNKNOWN, message: 'Unknown delete failure' },
      }
    );
  });

  const failed = results.filter((r) => r.error !== undefined).length;
  return {
    results,
    summary: { total: results.length, succeeded: results.length - failed, failed },
  };
}

export const DELETE = defineTool({
  name: 'delete',
  title: 'Delete File',
  description:
    'Permanently delete one or more files, directories, or symlinks (max 1000 per call). This action is irreversible. ' +
    'Pass paths: [...] — there is no single-path form. ' +
    'Non-empty directories require recursive=true and additionally prompt the user to confirm each one, ' +
    'so the call returns without deleting anything until that confirmation comes back; ' +
    'a client that cannot prompt gets an error naming the alternative. ' +
    'Workspace root directories cannot be deleted.',
  input: DeleteInputSchema,
  output: DeleteOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => ({
    label: 'Delete',
    subject:
      args.paths.length === 1
        ? basename(args.paths[0] ?? '')
        : `${String(args.paths.length)} paths`,
  }),
  accessPaths: (args) => [...args.paths],
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
        text: `delete: ${only?.path ?? ''} FAILED — ${only?.error?.message ?? 'unknown error'}`,
        isError,
      };
    }
    const tokens = structured.results.map((r) => {
      const label = pathLabel(r.path);
      if (r.error) return `${label} FAILED`;
      return r.value?.deleted ? label : `${label} SKIPPED`;
    });
    const ratio = failed > 0 ? ` (${String(total - failed)}/${String(total)} ok)` : '';
    return { structured, text: `delete: ${joinRoster(tokens)}${ratio}`, isError };
  },
});
