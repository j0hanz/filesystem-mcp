/**
 * The diff budget: how replace_text holds each file's patch from the moment
 * its walk index settles, folding first-fit in walk order under the cap.
 * What keeps a stalled walk from parking one patch per walked file is
 * scan's admission seam (window/onSettled in core/scan.ts).
 */
import { unifiedPatch } from './diff.ts';
import type { Rewritten } from './rewrite.ts';

export const MAX_DIFF_SIZE = 20 * 1024; // 20KB limit for diff output
/** Whether a file's patch was refused up front; the patch text itself lives in the DiffBudget. */
export interface Patch {
  diffTruncated?: true;
}
/** Kept patches by walk index at or above the prefix, and which walk indices are done. */
export interface DiffBudget {
  stored: Map<number, string>;
  settled: Set<number>;
  /** Every walk index below this one is settled. */
  prefix: number;
  /** What the first-fit pass keeps of the patches below the prefix: the diff so far. */
  folded: string;
  /** A patch below the prefix did not fit. */
  truncated: boolean;
}

/** Folds one patch into `folded` by first-fit, in walk order. */
function fold(budget: DiffBudget, index: number): void {
  const patch = budget.stored.get(index);
  if (patch === undefined) return;
  if (budget.folded.length + patch.length <= MAX_DIFF_SIZE) budget.folded += patch;
  else budget.truncated = true;
  budget.stored.delete(index);
}

/** Folds each patch the prefix passes into `folded`, in walk order. */
export function settle(budget: DiffBudget, index: number): void {
  budget.settled.add(index);
  while (budget.settled.delete(budget.prefix)) {
    fold(budget, budget.prefix);
    budget.prefix++;
  }
}

/** Folds what is still stored once the scan returns, in walk order. */
export function finishDiff(budget: DiffBudget): void {
  for (const index of [...budget.stored.keys()].sort((a, b) => a - b)) fold(budget, index);
}

/**
 * Diffs one file as it finishes, so no file's contents outlive it. A patch is
 * refused only when the first-fit fold would drop it in any order.
 */
export function patchWithinBudget(
  budget: DiffBudget,
  index: number,
  header: string,
  done: Rewritten<number>,
): Patch {
  // First-fit over the settled walk-order prefix is final, and later patches
  // only add to what the final pass uses before this index. A lower patch
  // still running may displace a kept one, so the unsettled ones do not count.
  const remaining = MAX_DIFF_SIZE - budget.folded.length;
  // Budget first: a full budget must not pay for a diff it will discard, and a
  // diff past its deadline counts as truncated output, not a failed file.
  if (remaining === 0) return { diffTruncated: true };
  const patch = unifiedPatch(header, done.before, done.after);
  if (patch === undefined || patch.length > remaining) return { diffTruncated: true };
  budget.stored.set(index, patch);
  return {};
}
