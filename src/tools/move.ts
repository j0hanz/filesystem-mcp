import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import { basename, dirname, resolve } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.js';
import {
  ErrorCode,
  FsError,
  isFsError,
  isNodeError,
  Problem,
  rethrowIfAborted,
} from '../core/errors.js';
import { joinRoster, pathLabel } from '../core/fmt.js';
import { destExists } from '../core/fs.js';
import type { GuardedFileSystem } from '../core/fs.js';
import { choiceInput, pendingRoundTrip, readAcceptedChoice } from '../core/input-required.js';
import { IS_CASE_INSENSITIVE_FS, isPathInsideDirectory, isSamePath } from '../core/path-utils.js';
import { defaultFalseBoolean, PerFileErrorSchema, RequiredPath } from '../core/schema.js';
import { PARALLEL_CONCURRENCY } from '../core/util.js';
import type { ToolCtx } from './define.js';
import { defineTool } from './define.js';

const MoveItemSchema = z.strictObject({
  source: RequiredPath.describe('Path of the file or directory to move or copy'),
  destination: RequiredPath.describe('Destination path'),
});

const MoveItemResultSchema = z.strictObject({
  from: z.string().describe('Resolved absolute source path'),
  to: z.string().describe('Resolved absolute destination path'),
});

const MoveInputSchema = z.strictObject({
  moves: z.array(MoveItemSchema).min(1).max(100).describe('Operations to perform (max 100)'),
  copy: defaultFalseBoolean('Copy instead of move; sources are left in place'),
  overwrite: defaultFalseBoolean(
    'Copy mode only: overwrite existing destinations without confirmation',
  ),
});

const MoveFailureItemSchema = z.strictObject({
  source: z.string().describe('Source path that could not be moved'),
  destination: z.string().describe('Intended destination path for the failed move'),
  error: PerFileErrorSchema,
});

type MoveFailureItem = z.infer<typeof MoveFailureItemSchema>;

const MoveOutputSchema = z.strictObject({
  moves: z.array(MoveItemResultSchema).describe('Successfully completed operations'),
  failures: z
    .array(MoveFailureItemSchema)
    .optional()
    .describe('Operations that failed with per-item error details'),
  skipped: z
    .array(z.string())
    .optional()
    .describe('Destinations skipped because the user chose Skip'),
});

type MoveItemResult = z.infer<typeof MoveItemResultSchema>;

type PairOp = 'move' | 'copy';

const VERB: Readonly<Record<PairOp, string>> = { move: 'Move', copy: 'Copy' };

/** A move or copy pre-checked up to the point a confirmation decision is needed. */
interface TransferPlan {
  pair: { source: string; destination: string };
  /**
   * The path the mutation runs on: the link itself for a move, the resolved
   * target for a copy. Every collision check uses the resolved source instead
   * — see {@link validateTransferSource}.
   */
  opSource: string;
  validDest: string;
  /**
   * A rename that only changes the destination's case. Move must perform it —
   * it is real work — so it is exempt from the destination-exists checks that
   * would otherwise read the source itself as an existing destination. Never
   * true for a copy, which treats a case-only target as a self-copy and skips.
   */
  isCaseOnlyRename: boolean;
  /** Whether the destination existed when planned (drives the TOCTOU guard). */
  destExistedOriginally: boolean;
  /** Destination exists and is not a self/case-only target → needs overwrite confirmation. */
  pending: boolean;
}

/**
 * Phase 1 (no mutation): validate source and destination, reject self-targets
 * and transfers into a subdirectory of the source, and stat the destination to
 * decide whether this pair needs an overwrite confirmation. No `mkdir` happens
 * here — the old flow created the destination's parent before asking, which
 * mutated the filesystem before a confirmation; that now waits for phase 2 (R14).
 *
 * `overwrite` is copy-only — move has no confirmation bypass — so a move always
 * passes false.
 */
async function planTransfer(
  op: PairOp,
  pair: { source: string; destination: string },
  fs: ToolCtx['fs'],
  overwrite: boolean,
): Promise<TransferPlanResult> {
  let realSource: string;
  let opSource: string;
  let validDest: string;
  try {
    ({ realSource, opSource } = await validateTransferSource(op, pair.source, fs));
    validDest = await fs.pathGuard.validatePathForWrite(pair.destination);
  } catch (error) {
    return { status: 'fail', failure: pairFailure(pair, error) };
  }

  // Comparisons run on the resolved source; only the fs call in phase 2 uses
  // opSource. validatePathForWrite resolves the destination through a symlink
  // too, so both sides of every check must be resolved to match.
  const resolvedSource = resolve(realSource);
  const resolvedDest = resolve(validDest);

  const isSelf = resolvedSource === resolvedDest;
  const isCaseOnlyRename = !isSelf && isSamePath(resolvedSource, resolvedDest);

  // A copy onto a case-only variant of its own source is the same file, so it
  // is a no-op; the same rename is real work for move and proceeds.
  if (isSelf || (isCaseOnlyRename && op === 'copy')) {
    return { status: 'noop' };
  }

  if (!isCaseOnlyRename && isPathInsideDirectory(resolvedSource, resolvedDest)) {
    return {
      status: 'fail',
      failure: pairFailure(
        pair,
        new FsError(
          ErrorCode.INVALID_INPUT,
          `Cannot ${op} a directory into its own subdirectory`,
          pair.source,
        ),
      ),
    };
  }

  const destExistedOriginally = !isCaseOnlyRename && (await destExists(fs, validDest, op));
  const pending = destExistedOriginally && !overwrite;

  return {
    status: 'plan',
    plan: { pair, opSource, validDest, isCaseOnlyRename, destExistedOriginally, pending },
  };
}

/**
 * Phase 2 (mutation): confirm an overwrite if needed, TOCTOU-check the
 * destination, create its parent, then rename (with cross-device fallback) or
 * copy. A declined/missing confirmation throws `CANCELLED`, collected as a
 * per-pair failure by the caller. A destination that appeared between plan and
 * mutation (created during the confirmation gap) also fails closed.
 */
async function executeTransfer(
  op: PairOp,
  plan: TransferPlan,
  ctx: Pick<ToolCtx, 'fs' | 'signal' | 'inputResponses' | 'log'>,
  pendingSorted: readonly string[],
): Promise<TransferExecResult> {
  if (plan.pending) {
    const key = `confirm_${pendingSorted.indexOf(plan.validDest)}`;
    const choice = readAcceptedChoice(ctx.inputResponses, key);
    if (choice === 'skip') {
      return { skipped: plan.pair.destination };
    }
    if (choice !== 'overwrite') {
      throw new FsError(
        ErrorCode.CANCELLED,
        `${VERB[op]} cancelled: overwrite of "${plan.pair.destination}" was declined or missing`,
        plan.pair.destination,
      );
    }
  }

  // TOCTOU check before any mutation: a destination that did not exist when
  // planned but exists now was created during the confirmation gap.
  if (
    !plan.isCaseOnlyRename &&
    !plan.destExistedOriginally &&
    (await destExists(ctx.fs, plan.validDest, op))
  ) {
    throw new FsError(
      ErrorCode.CANCELLED,
      `${VERB[op]} cancelled: destination "${plan.pair.destination}" was created during confirmation.`,
      plan.pair.destination,
    );
  }

  await ctx.fs.mkdir(dirname(plan.validDest), { recursive: true });

  if (op === 'move') {
    await performRenameWithFallback(plan.opSource, plan.validDest, ctx.fs, plan.pair.source);
    ctx.log?.('info', `move: ${plan.pair.source} -> ${plan.pair.destination}`, 'move');
  } else {
    await ctx.fs.cp(plan.opSource, plan.validDest, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      force: true,
    });
  }
  return { value: { from: plan.opSource, to: plan.validDest } };
}

type TransferPlanResult =
  | { status: 'fail'; failure: MoveFailureItem }
  | { status: 'noop' }
  | { status: 'plan'; plan: TransferPlan };

/** A discriminated union, so the fold below narrows without a generic cast. */
type TransferExecResult = { readonly skipped: string } | { readonly value: MoveItemResult };

function pairFailure(
  pair: { source: string; destination: string },
  error: unknown,
): MoveFailureItem {
  return {
    source: pair.source,
    destination: pair.destination,
    error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, pair.source),
  };
}

/**
 * The source→destination sibling of `runOverPaths`: plan every pair, fail closed
 * on a duplicated destination, round-trip the overwrite confirmations as one
 * set, then execute what survived in parallel. `copy` and `move` differ only in
 * their `plan` and `execute` callbacks.
 */
async function runTransfers(
  items: readonly z.infer<typeof MoveItemSchema>[],
  ctx: ToolCtx,
  op: PairOp,
  overwrite: boolean,
): Promise<
  | { results: MoveItemResult[]; skipped: string[]; failures: MoveFailureItem[] }
  | InputRequiredResult
> {
  const { results: planned, errors: planErrors } = await processInParallel(
    items,
    (pair) => planTransfer(op, pair, ctx.fs, overwrite),
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );
  // plan callbacks are fail-closed (they return { status: 'fail' }, never
  // throw), so planErrors should always be empty. Surface the first rather
  // than silently dropping the item if a future plan callback violates that.
  const firstPlanError = planErrors[0];
  if (firstPlanError) throw firstPlanError.error;

  const failures: MoveFailureItem[] = [];
  const candidates: TransferPlan[] = [];
  for (const { value } of planned) {
    if (value.status === 'fail') failures.push(value.failure);
    else if (value.status === 'plan') candidates.push(value.plan);
    // 'noop' (self-copy / self-move) is silently skipped.
  }

  // Two sources targeting the same destination in one batch would otherwise
  // collapse to a single shared overwrite confirmation and let the second
  // one silently clobber the first's freshly-written content. Fail closed:
  // only the first plan per destination proceeds; later ones targeting the
  // same destination are reported as a per-item failure.
  const seenDest = new Set<string>();
  const ready: TransferPlan[] = [];
  for (const candidate of candidates) {
    const destKey = IS_CASE_INSENSITIVE_FS
      ? candidate.validDest.toLowerCase()
      : candidate.validDest;
    if (seenDest.has(destKey)) {
      failures.push(
        pairFailure(
          candidate.pair,
          new FsError(
            ErrorCode.INVALID_INPUT,
            `${VERB[op]} cancelled: another entry in this batch already targets destination "${candidate.pair.destination}"`,
            candidate.pair.destination,
          ),
        ),
      );
      continue;
    }
    seenDest.add(destKey);
    ready.push(candidate);
  }

  const pendingSorted = ready
    .filter((p) => p.pending)
    .map((p) => p.validDest)
    .sort();
  if (pendingSorted.length > 0) {
    // Round 1 returns input_required; a retry whose verified state does not
    // bind this overwrite set throws (R9) via `pendingRoundTrip`.
    const round = await pendingRoundTrip({
      op,
      pending: pendingSorted,
      requestState: ctx.requestState,
      clientCapabilities: ctx.clientCapabilities,
      buildInputs: (dests) =>
        dests.map((dest, i) =>
          choiceInput(
            `confirm_${i}`,
            op === 'move'
              ? `"${dest}" already exists. Overwrite it?`
              : `Destination "${dest}" already exists. Overwrite it?`,
            [
              { value: 'overwrite', title: 'Overwrite' },
              { value: 'skip', title: 'Skip' },
            ],
          ),
        ),
    });
    if (round !== undefined) return round;
  }

  const total = ready.length;
  let completed = 0;
  const tick = (): void => {
    completed += 1;
    ctx.onProgress?.({ current: completed, total });
  };
  const { results: execResults, errors: execErrors } = await processInParallel(
    ready,
    async (readyPlan) => {
      try {
        return await executeTransfer(op, readyPlan, ctx, pendingSorted);
      } finally {
        tick();
      }
    },
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  for (const { error, index } of execErrors) {
    rethrowIfAborted(error);
    const failed = ready[index];
    if (failed) failures.push(pairFailure(failed.pair, error));
  }

  const results: MoveItemResult[] = [];
  const skipped: string[] = [];
  for (const { value } of execResults) {
    if ('skipped' in value) skipped.push(value.skipped);
    else results.push(value.value);
  }

  return { results, skipped, failures };
}

/**
 * Two-phase move: pre-check every move (no mutation) to build the overwrite
 * pending set; if any move is pending and the round carries no verified
 * `requestState`, return `input_required` moving nothing (R14). On retry, R9
 * checks the state binds this move set, then each pending move proceeds only on
 * an accepted overwrite. Non-pending moves proceed alongside them.
 */
async function handleMove(
  args: z.infer<typeof MoveInputSchema>,
  ctx: ToolCtx,
): Promise<z.infer<typeof MoveOutputSchema> | InputRequiredResult> {
  const op: PairOp = args.copy ? 'copy' : 'move';
  // `overwrite` is copy-only; move has no confirmation bypass.
  const overwrite = args.copy && args.overwrite;
  const outcome = await runTransfers(args.moves, ctx, op, overwrite);
  if (isInputRequiredResult(outcome)) return outcome;

  const { results, skipped, failures } = outcome;

  return {
    moves: results,
    ...(failures.length > 0 ? { failures } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}

function buildSummary(
  verb: 'move' | 'copy',
  results: readonly MoveItemResult[],
  failures: readonly MoveFailureItem[],
  skipped: readonly string[],
): string {
  const successCount = results.length;
  const failCount = failures.length;
  if (failCount === 0 && skipped.length === 0 && successCount === 1) {
    const result = results[0];
    if (result) {
      return `${verb}: ${pathLabel(result.from)} → ${pathLabel(result.to)}`;
    }
  }
  // Name each pair. "move: 2 items" left the caller to open structuredContent
  // to learn which two, and a partial failure was unreadable without it.
  // Skipped destinations are an outcome the user chose, not a failure — name
  // them, or an all-skipped call reads as "copy: nothing".
  const tokens = [
    ...results.map((r) => `${pathLabel(r.from)} → ${pathLabel(r.to)}`),
    ...skipped.map((dest) => `${pathLabel(dest)} SKIPPED`),
  ];
  const parts = [`${verb}: ${joinRoster(tokens) || 'nothing'}`];
  if (failCount > 0) parts.push(`${String(failCount)} failed`);
  return parts.join(' · ');
}

interface TransferSource {
  /** Symlink resolved — the identity used for every same-target comparison. */
  realSource: string;
  /** The path the mutation runs on: symlink preserved for move, resolved for copy. */
  opSource: string;
}

/**
 * A move needs two views of its source. Renaming must operate on the link
 * itself, or moving a symlink would rename the file it points at and leave the
 * link dangling. Every collision check must instead compare the resolved
 * target, or a link moved onto itself (or onto its own target) reads as a real
 * move and renames the link over that target, destroying it. A copy reads
 * through the link, so both views are the resolved one.
 */
async function validateTransferSource(
  op: PairOp,
  source: string,
  fs: ToolCtx['fs'],
): Promise<TransferSource> {
  try {
    const realSource = await fs.pathGuard.validateExistingPath(source);
    const opSource = op === 'move' ? await fs.pathGuard.validatePathForDelete(source) : realSource;
    return { realSource, opSource };
  } catch (error) {
    if (isFsError(error)) throw error;
    throw new FsError(ErrorCode.ACCESS_DENIED, `${VERB[op]} failed for ${source}`, source);
  }
}

async function performRenameWithFallback(
  validSource: string,
  validDest: string,
  fsOps: Pick<GuardedFileSystem, 'rename' | 'cp' | 'rm'>,
  originalSource: string,
): Promise<void> {
  try {
    await fsOps.rename(validSource, validDest);
  } catch (error: unknown) {
    rethrowIfAborted(error);

    if (!isNodeError(error) || error.code !== 'EXDEV') {
      throw error;
    }

    // EXDEV: cross-device rename. Copy then remove, preserving symlinks and
    // timestamps so link semantics survive the move.
    let copied = false;
    try {
      await fsOps.cp(validSource, validDest, {
        recursive: true,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
      copied = true;
      await fsOps.rm(validSource, { recursive: true, force: true });
    } catch (copyOrRemoveError) {
      rethrowIfAborted(copyOrRemoveError);
      if (copied) {
        // cp succeeded but rm failed: the destination already holds a complete
        // copy and the source remains. Surface the rm error as the cause so the
        // caller can recover (clean up the duplicate) instead of a silent generic
        // failure that hides the partial completion.
        const baseProblem = Problem.fromUnknown(
          copyOrRemoveError,
          ErrorCode.UNKNOWN,
          originalSource,
        );
        throw new FsError(
          baseProblem.code,
          `Cross-device move of ${originalSource}: copy succeeded but source removal failed (destination holds a copy): ${baseProblem.message}`,
          originalSource,
          copyOrRemoveError,
        );
      }
      throw copyOrRemoveError;
    }
  }
}

export const MOVE = defineTool({
  name: 'move',
  title: 'Move or Copy Files',
  description:
    'Move, rename, or copy files and directories to explicit destination paths (max 100 operations per call). ' +
    'Pass moves: [{ source, destination }] — there is no single-pair form. ' +
    'Parent directories are created automatically. Set copy=true to copy instead of move (sources are kept). ' +
    'An existing destination prompts the user to confirm the overwrite, so the call returns without moving ' +
    'anything until that confirmation comes back; copy=true with overwrite=true skips the prompt, move has no ' +
    'such bypass. Self-moves are silently skipped.',
  input: MoveInputSchema,
  output: MoveOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  progress: (args) => {
    const label = args.copy ? 'Copy' : 'Move';
    if (args.moves.length === 1) {
      const move = args.moves[0];
      return {
        label,
        subject: `${basename(move?.source ?? '')} → ${basename(move?.destination ?? '')}`,
      };
    }
    return { label, subject: `${String(args.moves.length)} files` };
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
  accessPaths: (args) => args.moves.flatMap((m) => [m.source, m.destination]),
  run: async (args, ctx) => {
    const output = await handleMove(args, ctx);
    // input_required is a return value, not a completed call: surface it
    // verbatim so the executor short-circuits before building a CallToolResult.
    if (isInputRequiredResult(output)) return output;
    const failures = output.failures ?? [];
    const skipped = output.skipped ?? [];
    return {
      structured: output,
      text: buildSummary(args.copy ? 'copy' : 'move', output.moves, failures, skipped),
      // Every requested pair failed: no move, no copy, no user-chosen skip - the
      // call did nothing. A skip is work the caller asked for, so it counts.
      isError: failures.length > 0 && output.moves.length + skipped.length === 0,
    };
  },
});
