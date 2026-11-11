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
import { type BatchSlot, cancelMessage, executeBatchSlots, failureLines } from './batch.ts';
import type { ToolCtx } from './define.ts';
import { defineTool } from './define.ts';

const MoveItemSchema = z.strictObject({
  source: RequiredPath.describe('Existing file, directory, or symlink'),
  destination: RequiredPath.describe(
    'Full target path including the new name, not a parent folder',
  ),
});

interface MoveItemResult {
  from: string;
  to: string;
}

const MoveInputSchema = z.strictObject({
  moves: z
    .array(MoveItemSchema)
    .min(1)
    .max(100)
    .describe(
      'Pairs run independently, with no rollback; a declined overwrite still cancels them all',
    ),
  copy: defaultFalseBoolean('Copy and leave sources in place instead of moving'),
  overwrite: defaultFalseBoolean('Copy only: replace existing destinations without confirmation'),
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
type TransferExecResult =
  | { readonly kind: 'noop' }
  | { readonly kind: 'skipped'; readonly destination: string }
  | { readonly kind: 'value'; readonly value: MoveItemResult };

interface IndexedPlan {
  readonly plan: TransferPlan;
  readonly index: number;
}

function isProblem(error: unknown): error is Problem {
  return (
    typeof error === 'object' &&
    error !== null &&
    !(error instanceof Error) &&
    'code' in error &&
    'message' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

function pairFailure(
  pair: { source: string; destination: string },
  error: unknown,
): MoveFailureItem {
  return {
    source: pair.source,
    destination: pair.destination,
    error: isProblem(error) ? error : Problem.fromUnknown(error, ErrorCode.UNKNOWN, pair.source),
  };
}

/** The Confirmation's verdict on a pair, as the error that stops it. */
function cancelled(
  op: PairOp,
  plan: TransferPlan,
  verdict: Exclude<ReturnType<Confirmed['verdict']>, 'proceed' | 'skipped'>,
): FsError {
  const { destination } = plan.request;
  return new FsError(ErrorCode.CANCELLED, cancelMessage(op, destination, verdict), destination);
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
  const slots = new Array<BatchSlot<TransferExecResult>>(items.length);

  const { results: planned, errors: planErrors } = await processInParallel(
    items,
    async (
      pair,
      index,
    ): Promise<
      | IndexedPlan
      | { readonly error: MoveFailureItem; readonly index: number }
      | { readonly noop: true; readonly index: number }
    > => {
      try {
        const plan = await ctx.fs.planTransfer(op, pair, { signal: ctx.signal });
        if (plan.noop) return { noop: true, index };
        return { plan, index };
      } catch (error) {
        rethrowIfAborted(error);
        return { error: pairFailure(pair, error), index };
      }
    },
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );
  const firstPlanError = planErrors[0];
  if (firstPlanError) throw firstPlanError.error;

  const candidates: IndexedPlan[] = [];
  for (const { value } of planned) {
    if ('error' in value) {
      slots[value.index] = {
        status: 'failure',
        path: items[value.index]?.source ?? '',
        error: value.error.error,
      };
    } else if ('noop' in value) {
      slots[value.index] = {
        status: 'settled',
        path: items[value.index]?.source ?? '',
        value: { kind: 'noop' },
      };
    } else {
      candidates.push(value);
    }
  }

  // Two sources targeting the same destination in one batch would otherwise
  // collapse to a single shared overwrite confirmation and let the second
  // one silently clobber the first's freshly-written content. Fail closed:
  // only the first plan per destination proceeds; later ones targeting the
  // same destination are reported as a per-item failure.
  const seenDest = new Set<string>();
  const ready: IndexedPlan[] = [];
  for (const candidate of candidates) {
    // Unicode-folded too: two spellings of one missing name land on one file
    // once the first move creates it (#101).
    const destKey = unicodeMatchKey(candidate.plan.destination);
    if (seenDest.has(destKey)) {
      slots[candidate.index] = {
        status: 'failure',
        path: candidate.plan.request.source,
        error: pairFailure(
          candidate.plan.request,
          new FsError(
            ErrorCode.INVALID_INPUT,
            `${VERB[op]} cancelled: another entry in this batch already targets "${candidate.plan.request.destination}"`,
            candidate.plan.request.destination,
          ),
        ).error,
      };
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
          (isPathInsideDirectory(a.plan.entry, b.plan.entry) ||
            isPathInsideDirectory(b.plan.entry, a.plan.entry))) ||
        touches(resolve(a.plan.landing), b.plan.destination) ||
        touches(resolve(b.plan.landing), a.plan.destination) ||
        touches(a.plan.destination, b.plan.destination)
      ) {
        overlapping.add(a.plan);
        overlapping.add(b.plan);
      }
    }
  }
  const independent: IndexedPlan[] = [];
  for (const item of ready) {
    if (overlapping.has(item.plan)) {
      slots[item.index] = {
        status: 'failure',
        path: item.plan.request.source,
        error: pairFailure(
          item.plan.request,
          new FsError(
            ErrorCode.INVALID_INPUT,
            `${VERB[op]} cancelled: "${item.plan.request.source}" or "${item.plan.request.destination}" overlaps another entry's source or destination in this batch. Run dependent moves one at a time.`,
            item.plan.request.source,
          ),
        ).error,
      };
      continue;
    }
    independent.push(item);
  }

  const { results: mergeChecked, errors: mergeErrors } = await processInParallel(
    independent,
    async (
      item,
    ): Promise<IndexedPlan | { readonly error: MoveFailureItem; readonly index: number }> => {
      try {
        await ctx.fs.refuseDirectoryMerge(item.plan);
        return item;
      } catch (error) {
        rethrowIfAborted(error);
        return { error: pairFailure(item.plan.request, error), index: item.index };
      }
    },
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );
  const firstMergeError = mergeErrors[0];
  if (firstMergeError) throw firstMergeError.error;

  const safe: IndexedPlan[] = [];
  for (const { value } of mergeChecked) {
    if ('error' in value) {
      slots[value.index] = {
        status: 'failure',
        path: items[value.index]?.source ?? '',
        error: value.error.error,
      };
    } else {
      safe.push(value);
    }
  }

  // Round 1 returns input_required while an overwrite needs approval (R14).
  // `overwrite` is copy-only: move has no confirmation bypass.
  const confirmed = await confirm(
    ctx,
    op,
    'overwrite',
    overwrite
      ? []
      : safe.flatMap(({ plan }) =>
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

  for (const { plan } of safe) {
    const verdict = confirmed.verdict(plan.destination);
    if (verdict !== 'proceed' && verdict !== 'skipped') {
      throw cancelled(op, plan, verdict);
    }
  }

  for (const { plan, index } of safe) {
    const verdict = confirmed.verdict(plan.destination);
    if (verdict === 'skipped') {
      slots[index] = {
        status: 'settled',
        path: plan.request.source,
        value: { kind: 'skipped', destination: plan.request.destination },
      };
    } else {
      slots[index] = {
        status: 'pending',
        path: plan.request.source,
        run: async (c) => {
          const moved = await c.fs.executeTransfer(plan, {
            createParents: true,
            signal: c.signal,
          });
          if (op === 'move') {
            c.log('info', `move: ${plan.request.source} -> ${plan.request.destination}`, 'move');
          }
          return { kind: 'value', value: moved };
        },
      };
    }
  }

  const batchRes = await executeBatchSlots(slots, ctx, { defaultErrorCode: ErrorCode.UNKNOWN });

  const results: MoveItemResult[] = [];
  const skipped: string[] = [];
  const failures: MoveFailureItem[] = [];
  for (const [index, r] of batchRes.results.entries()) {
    const item = items[index];
    if (!item) continue;
    if ('error' in r) {
      failures.push(pairFailure(item, r.error));
    } else if (r.value.kind === 'skipped') {
      skipped.push(r.value.destination);
    } else if (r.value.kind === 'value') {
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
    'Move, rename, or copy files and directories inside the roots. ' +
    'Use when you need to rename, relocate, or duplicate (copy: true). ' +
    'Do not use to change contents (`edit`, `patch`) or remove paths (`delete`). ' +
    'Missing parents are created. An existing destination asks to confirm; declining cancels the call, skipping drops that pair. Only copies can bypass the prompt (overwrite: true). ' +
    'A directory move never merges into a non-empty directory; a copy merges. ' +
    'Pairs that share a destination or overlap another pair fail; run dependent moves separately. ' +
    'Returns summary lines naming each pair and failure, and { moves: [{ from, to }], failures?, skipped?, undo id for `undo` (30 minutes) or undoUnavailable }; an error only if every pair failed.',
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
