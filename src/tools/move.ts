import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import { normalize, resolve, sep } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.ts';
import { ErrorCode, FsError, isRefusal, type Problem, rethrowIfAborted } from '../core/errors.ts';
import { joinRoster, pathLabel } from '../core/fmt.ts';
import type { TransferOp, TransferPlan } from '../core/fs.ts';
import { isPathInsideDirectory, unicodeMatchKey } from '../core/path-utils.ts';
import { defaultFalseBoolean, RequiredPath } from '../core/schema.ts';
import { PARALLEL_CONCURRENCY } from '../core/util.ts';
import { failureLines, planBatch, toProblem } from './batch.ts';
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

function pairFailure(
  pair: { source: string; destination: string },
  error: unknown,
): MoveFailureItem {
  return {
    source: pair.source,
    destination: pair.destination,
    error: toProblem(error, ErrorCode.UNKNOWN, pair.source),
  };
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
  const ready = await planBatch<z.infer<typeof MoveItemSchema>, TransferPlan, TransferExecResult>(
    {
      op,
      accept: 'overwrite',
      items,
      pathOf: (pair) => pair.source,
      plan: async (pair) => {
        try {
          const plan = await ctx.fs.planTransfer(op, pair, { signal: ctx.signal });
          if (plan.noop) return { status: 'settled', path: pair.source, value: { kind: 'noop' } };
          return { status: 'plan', plan };
        } catch (error) {
          rethrowIfAborted(error);
          return {
            status: 'fail',
            failure: { path: pair.source, error: pairFailure(pair, error).error },
          };
        }
      },
      slotPath: (plan) => plan.request.source,
      // The guard keys each destination by the Entry it names, so two spellings
      // of one missing name land on one file once the first move creates it
      // (#101). Fail closed: a second source would silently clobber the first's
      // freshly-written content under one shared overwrite confirmation.
      landing: (plan) => plan.destination,
      duplicates: {
        policy: 'fail',
        refuse: (plan) =>
          pairFailure(
            plan.request,
            new FsError(
              ErrorCode.INVALID_INPUT,
              `${VERB[op]} cancelled: another entry in this batch already targets "${plan.request.destination}"`,
              plan.request.destination,
            ),
          ).error,
      },
      refuse: (plans) => refuseAcrossPairs(plans, ctx, op),
      // `overwrite` is copy-only: move has no confirmation bypass.
      confirmItem: (plan) =>
        overwrite || plan.existing === undefined
          ? undefined
          : {
              path: plan.destination,
              identity: plan.existing,
              required: true,
              message:
                op === 'move'
                  ? `"${plan.destination}" already exists. Overwrite it?`
                  : `Destination "${plan.destination}" already exists. Overwrite it?`,
            },
      // The description promises that a declined overwrite cancels every pair.
      onRefusal: 'fail call',
      skipped: (plan) => ({ kind: 'skipped', destination: plan.request.destination }),
      run: async (plan, _pair, c) => {
        const moved = await c.fs.executeTransfer(plan, { createParents: true, signal: c.signal });
        if (op === 'move') {
          c.log('info', `move: ${plan.request.source} -> ${plan.request.destination}`, 'move');
        }
        return { kind: 'value', value: moved };
      },
    },
    ctx,
  );
  if (isInputRequiredResult(ready)) return ready;
  const batchRes = await ready.execute();

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
 * Rules that span pairs, run before any prompt: overlapping pairs, then a
 * directory merge each surviving pair would make. A refusal per index.
 */
async function refuseAcrossPairs(
  plans: readonly IndexedPlan[],
  ctx: ToolCtx,
  op: PairOp,
): Promise<Map<number, Problem>> {
  const refused = new Map<number, Problem>();

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
  for (const [i, a] of plans.entries()) {
    for (const b of plans.slice(i + 1)) {
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
  for (const item of plans) {
    if (overlapping.has(item.plan)) {
      refused.set(
        item.index,
        pairFailure(
          item.plan.request,
          new FsError(
            ErrorCode.INVALID_INPUT,
            `${VERB[op]} cancelled: "${item.plan.request.source}" or "${item.plan.request.destination}" overlaps another entry's source or destination in this batch. Run dependent moves one at a time.`,
            item.plan.request.source,
          ),
        ).error,
      );
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

  for (const { value } of mergeChecked) {
    if ('error' in value) refused.set(value.index, value.error.error);
  }
  return refused;
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
    'Returns a summary line per pair and failure, plus moves[{ from, to }], failures?, skipped?, and an undo id for `undo` (30 minutes) or undoUnavailable. ' +
    'The call is an error only if every pair failed.',
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
      // call did nothing. A skip is work the caller asked for, so it counts. A
      // refusal is an answer the model can report, so it does not fail the call.
      isError: failures.some((f) => !isRefusal(f.error)) && results.length + skipped.length === 0,
    };
  },
});
