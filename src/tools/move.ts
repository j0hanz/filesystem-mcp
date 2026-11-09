import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import { normalize, resolve, sep } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.ts';
import { confirm, type Confirmed } from '../core/confirmation.ts';
import { ErrorCode, FsError, Problem, rethrowIfAborted } from '../core/errors.ts';
import { joinRoster, pathLabel } from '../core/fmt.ts';
import type { TransferOp, TransferPlan } from '../core/fs.ts';
import { isPathInsideDirectory, unicodeMatchKey } from '../core/path-utils.ts';
import { defaultFalseBoolean, RequiredPath } from '../core/schema.ts';
import { PARALLEL_CONCURRENCY } from '../core/util.ts';
import { type BatchSlot, executeBatchSlots, failureLines } from './batch.ts';
import type { ToolCtx } from './define.ts';
import { defineTool } from './define.ts';

const MoveItemSchema = z.strictObject({
  source: RequiredPath.describe('Path of the file or directory to move or copy'),
  destination: RequiredPath.describe('Destination path'),
});

interface MoveItemResult {
  from: string;
  to: string;
}

const MoveInputSchema = z.strictObject({
  moves: z.array(MoveItemSchema).min(1).max(100).describe('Operations to perform (max 100)'),
  copy: defaultFalseBoolean('Copy instead of move; sources are left in place'),
  overwrite: defaultFalseBoolean(
    'Copy mode only: overwrite existing destinations without confirmation',
  ),
});

interface MoveFailureItem {
  source: string;
  destination: string;
  error: Problem;
}

interface MoveOutput {
  moves: MoveItemResult[];
  failures?: MoveFailureItem[];
  skipped?: string[];
}

type PairOp = TransferOp;

const VERB: Readonly<Record<PairOp, string>> = { move: 'Move', copy: 'Copy' };

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

/** The Confirmation's verdict on a pair, as the error that stops it. */
function cancelled(
  op: PairOp,
  plan: TransferPlan,
  verdict: Exclude<ReturnType<Confirmed['verdict']>, 'proceed' | 'skipped'>,
): FsError {
  const { destination } = plan.request;
  return new FsError(
    ErrorCode.CANCELLED,
    verdict === 'changed'
      ? `${VERB[op]} cancelled: destination "${destination}" was replaced again while the prompt was open.`
      : `${VERB[op]} cancelled: overwrite of "${destination}" was ${verdict.refused}`,
    destination,
  );
}

/**
 * The source→destination sibling of `runOverPaths`: plan every pair, fail closed
 * on a duplicated destination, round-trip the overwrite confirmations as one
 * set, then execute what survived in parallel. The Transfer itself (source
 * views, Self-move, Respelling, the Relocation walk, the destination checks)
 * is `GuardedFileSystem`'s; this owns only what spans pairs.
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
    async (pair): Promise<TransferPlan | MoveFailureItem> => {
      try {
        return await ctx.fs.planTransfer(op, pair, { signal: ctx.signal });
      } catch (error) {
        rethrowIfAborted(error);
        return pairFailure(pair, error);
      }
    },
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );
  const firstPlanError = planErrors[0];
  if (firstPlanError) throw firstPlanError.error;

  const failures: MoveFailureItem[] = [];
  const candidates: TransferPlan[] = [];
  for (const { value } of planned) {
    if ('error' in value) failures.push(value);
    else if (!value.noop) candidates.push(value);
    // A no-op (self-copy / self-move) is silently skipped.
  }

  // Two sources targeting the same destination in one batch would otherwise
  // collapse to a single shared overwrite confirmation and let the second
  // one silently clobber the first's freshly-written content. Fail closed:
  // only the first plan per destination proceeds; later ones targeting the
  // same destination are reported as a per-item failure.
  const seenDest = new Set<string>();
  const ready: TransferPlan[] = [];
  for (const candidate of candidates) {
    // Unicode-folded too: two spellings of one missing name land on one file
    // once the first move creates it (#101).
    const destKey = unicodeMatchKey(candidate.destination);
    if (seenDest.has(destKey)) {
      failures.push(
        pairFailure(
          candidate.request,
          new FsError(
            ErrorCode.INVALID_INPUT,
            `${VERB[op]} cancelled: another entry in this batch already targets destination "${candidate.request.destination}"`,
            candidate.request.destination,
          ),
        ),
      );
      continue;
    }
    seenDest.add(destKey);
    ready.push(candidate);
  }

  // One entry's (resolved) source overlapping another's destination means the
  // two race and a file is lost: a swap [A->B, B->A] or a chain [B->C, A->B].
  // Destination subtrees must also be disjoint: two recursive copies otherwise
  // race over shared descendants even when their destination paths differ.
  // Refuse both sides so the survivors are independent and can run concurrently.
  // isPathInsideDirectory covers equality and containment, case-folded; the
  // keys fold Unicode spelling too, parents included. Two moves compare the
  // entries they rename, not where a link points, and unfolded: validated
  // sources are on-disk names, so two that fold alike are distinct.
  const touches = (x: string, y: string): boolean => {
    const [keyX, keyY] = [unicodeMatchKey(x), unicodeMatchKey(y)];
    return isPathInsideDirectory(keyX, keyY) || isPathInsideDirectory(keyY, keyX);
  };
  const overlapping = new Set<TransferPlan>();
  for (const [i, a] of ready.entries()) {
    for (const b of ready.slice(i + 1)) {
      if (
        (op === 'move' &&
          (isPathInsideDirectory(a.entry, b.entry) || isPathInsideDirectory(b.entry, a.entry))) ||
        touches(resolve(a.landing), b.destination) ||
        touches(resolve(b.landing), a.destination) ||
        touches(a.destination, b.destination)
      ) {
        overlapping.add(a);
        overlapping.add(b);
      }
    }
  }
  const independent: TransferPlan[] = [];
  for (const plan of ready) {
    if (overlapping.has(plan)) {
      failures.push(
        pairFailure(
          plan.request,
          new FsError(
            ErrorCode.INVALID_INPUT,
            `${VERB[op]} cancelled: "${plan.request.source}" or "${plan.request.destination}" overlaps another entry's source or destination in this batch. Issue dependent moves one at a time.`,
            plan.request.source,
          ),
        ),
      );
      continue;
    }
    independent.push(plan);
  }

  const { results: mergeChecked, errors: mergeErrors } = await processInParallel(
    independent,
    async (plan): Promise<TransferPlan | MoveFailureItem> => {
      try {
        await ctx.fs.refuseDirectoryMerge(plan);
        return plan;
      } catch (error) {
        rethrowIfAborted(error);
        return pairFailure(plan.request, error);
      }
    },
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );
  const firstMergeError = mergeErrors[0];
  if (firstMergeError) throw firstMergeError.error;

  const safe: TransferPlan[] = [];
  for (const { value } of mergeChecked) {
    if ('error' in value) failures.push(value);
    else safe.push(value);
  }

  // Round 1 returns input_required while an overwrite needs approval (R14).
  // `overwrite` is copy-only: move has no confirmation bypass.
  const confirmed = await confirm(
    ctx,
    op,
    'overwrite',
    overwrite
      ? []
      : safe.flatMap((plan) =>
          plan.existing === undefined
            ? []
            : [
                {
                  path: plan.destination,
                  identity: plan.existing,
                  required: true,
                  message:
                    op === 'move'
                      ? `"${plan.destination}" already exists. Overwrite it?`
                      : `Destination "${plan.destination}" already exists. Overwrite it?`,
                },
              ],
        ),
  );
  if (isInputRequiredResult(confirmed)) return confirmed;

  for (const plan of safe) {
    const verdict = confirmed.verdict(plan.destination);
    if (verdict !== 'proceed' && verdict !== 'skipped') {
      throw cancelled(op, plan, verdict);
    }
  }

  const slots: BatchSlot<TransferExecResult>[] = safe.map((plan) => {
    const verdict = confirmed.verdict(plan.destination);
    if (verdict === 'skipped') {
      return {
        status: 'settled',
        path: plan.destination,
        value: { skipped: plan.request.destination },
      };
    }
    return {
      status: 'pending',
      path: plan.destination,
      run: async (c) => {
        const moved = await c.fs.executeTransfer(plan, {
          createParents: true,
          signal: c.signal,
        });
        if (op === 'move') {
          c.log('info', `move: ${plan.request.source} -> ${plan.request.destination}`, 'move');
        }
        return { value: moved };
      },
    };
  });

  const batchRes = await executeBatchSlots(slots, ctx, { defaultErrorCode: ErrorCode.UNKNOWN });

  const results: MoveItemResult[] = [];
  const skipped: string[] = [];
  for (const [index, r] of batchRes.results.entries()) {
    const plan = safe[index];
    if (!plan) continue;
    if ('error' in r) {
      failures.push(pairFailure(plan.request, r.error));
    } else if ('skipped' in r.value) {
      skipped.push(r.value.skipped);
    } else {
      results.push(r.value.value);
    }
  }

  return { results, skipped, failures };
}

/**
 * A pair as `from → to`, base names only unless they match: `README.md →
 * README.md` hides the change of folder, so that shows the paths past their
 * shared folders.
 */
function pairLabel(from: string, to: string): string {
  const [fromName, toName] = [pathLabel(from), pathLabel(to)];
  if (fromName !== toName) return `${fromName} → ${toName}`;
  const [a, b] = [normalize(from).split(sep), normalize(to).split(sep)];
  let shared = 0;
  while (shared < a.length - 1 && shared < b.length - 1 && a[shared] === b[shared]) shared += 1;
  return `${a.slice(shared).join(sep)} → ${b.slice(shared).join(sep)}`;
}

function buildSummary(
  verb: 'move' | 'copy',
  results: readonly MoveItemResult[],
  failures: readonly MoveFailureItem[],
  skipped: readonly string[],
): string {
  const failCount = failures.length;
  // Name each pair. "move: 2 items" left the caller to open structuredContent
  // to learn which two, and a partial failure was unreadable without it.
  // Skipped destinations are an outcome the user chose, not a failure — name
  // them, or an all-skipped call reads as "copy: nothing".
  const tokens = [
    ...results.map((r) => pairLabel(r.from, r.to)),
    ...skipped.map((dest) => `${pathLabel(dest)} SKIPPED`),
  ];
  const parts = [`${verb}: ${joinRoster(tokens) || 'nothing'}`];
  if (failCount > 0) parts.push(`${String(failCount)} failed`);
  const reasons = failureLines(
    failures.map((f) => ({ path: `${f.source} → ${f.destination}`, error: f.error })),
  );
  return [parts.join(' · '), ...reasons].join('\n');
}

export const MOVE = defineTool<typeof MoveInputSchema, MoveOutput>({
  name: 'move',
  title: 'Move or Copy Files',
  description:
    'Move, rename, or copy files and directories, like mv or cp -r. ' +
    'Use when renaming paths, moving files between directories, or copying trees (copy: true). ' +
    'Each destination must be the full target path, not an existing directory to move into. ' +
    'Overwrite applies only to copies; moving onto an existing file requires confirmation. ' +
    'Returns moved paths and an undo id. Use delete to remove paths.',
  input: MoveInputSchema,
  readOnlyHint: false,
  progress: (args) => {
    const label = args.copy ? 'Copy' : 'Move';
    if (args.moves.length === 1) {
      const move = args.moves[0];
      return {
        label,
        subject: pairLabel(move?.source ?? '', move?.destination ?? ''),
      };
    }
    return { label, subject: `${String(args.moves.length)} files` };
  },
  mapPaths: (args, fn) => ({
    ...args,
    moves: args.moves.map((m) => ({ ...m, source: fn(m.source), destination: fn(m.destination) })),
  }),
  run: async (args, ctx) => {
    const op: PairOp = args.copy ? 'copy' : 'move';
    // `overwrite` is copy-only; move has no confirmation bypass.
    const outcome = await runTransfers(args.moves, ctx, op, args.copy && args.overwrite);
    // input_required is a return value, not a completed call: surface it
    // verbatim so the executor short-circuits before building a CallToolResult.
    if (isInputRequiredResult(outcome)) return outcome;
    const { results, skipped, failures } = outcome;
    return {
      structured: {
        moves: results,
        ...(failures.length > 0 ? { failures } : {}),
        ...(skipped.length > 0 ? { skipped } : {}),
      },
      text: buildSummary(op, results, failures, skipped),
      // Every requested pair failed: no move, no copy, no user-chosen skip - the
      // call did nothing. A skip is work the caller asked for, so it counts.
      isError: failures.length > 0 && results.length + skipped.length === 0,
    };
  },
});
