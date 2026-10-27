// The Confirmation of delete, move, copy and create: which entries the client
// must approve before they are destroyed, and how it answered. The round seals
// each pending entry's identity; the retry re-plans and compares. An entry
// swapped or newly pending is asked about again, once; one that vanished needs
// no approval. The access grant keeps `pendingRoundTrip` (input-required.ts).
import type { InputRequiredResult } from '@modelcontextprotocol/server';

import { type EntryIdentity, sameIdentity } from './fs.ts';
import {
  assertCanElicit,
  buildInputRequired,
  confirmKey,
  describeRefusal,
  type PendingCtx,
  type PendingInput,
  type PendingState,
  readAcceptedChoice,
} from './input-required.ts';

export type ConfirmOp = 'delete' | 'move' | 'copy' | 'create';

/** One entry the call would destroy, as planned this round. */
export interface ConfirmItem {
  readonly path: string;
  readonly identity: EntryIdentity;
  /** Whether the tool's own rule asks for approval this round. */
  readonly required: boolean;
  readonly message: string;
}

type Verdict = 'proceed' | 'skipped' | 'changed' | { readonly refused: string };

export interface Confirmed {
  /** A path not pending, or not among the items, answers `'proceed'`. */
  verdict(path: string): Verdict;
}

/**
 * Ask for, or read, the approval `items` need. Returns the round to send while
 * one is due; callers discriminate with `isInputRequiredResult`.
 */
export async function confirm(
  ctx: PendingCtx,
  op: ConfirmOp,
  acceptChoice: 'delete' | 'overwrite',
  items: readonly ConfirmItem[],
): Promise<InputRequiredResult | Confirmed> {
  const state = ctx.requestState?.();
  // A state of another op or without identities (minted before identities
  // were sealed) is no state: the client is asked afresh.
  const sealed = state?.op === op && state.identities !== undefined ? state : undefined;
  const identities = sealed?.identities ?? [];
  // A sealed path stays pending even when the tool no longer requires it, so
  // a directory emptied while its prompt was open still honors skip.
  const pending = items
    .filter((item) => item.required || sealed?.paths.includes(item.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (pending.length === 0) return { verdict: () => 'proceed' };

  const ask = (next: PendingState, inputs: readonly PendingInput[]) =>
    buildInputRequired(next, inputs, ctx.serverCtx);
  const input = (item: ConfirmItem, key: string): PendingInput => ({
    key,
    message: item.message,
    choices: [acceptChoice, 'skip'],
  });
  const freshRound = (reprompted: boolean) =>
    ask(
      {
        op,
        paths: pending.map((item) => item.path),
        identities: pending.map((item) => ({ path: item.path, ...item.identity })),
        ...(reprompted ? { reprompted: true as const } : {}),
      },
      pending.map((item, i) => input(item, confirmKey(i))),
    );

  if (sealed === undefined) {
    assertCanElicit(op, ctx.clientCapabilities);
    return freshRound(false);
  }

  const changed = new Set(
    pending
      .filter((item) => {
        const shown = identities.find((entry) => entry.path === item.path);
        return (
          !sealed.paths.includes(item.path) ||
          shown === undefined ||
          !sameIdentity(shown, item.identity)
        );
      })
      .map((item) => item.path),
  );
  if (changed.size > 0 && sealed.reprompted !== true) return freshRound(true);

  // Answers are keyed by the index in the SEALED list: an entry that vanished
  // since must not shift the keys of the ones after it.
  const keyOf = (path: string): string => confirmKey(sealed.paths.indexOf(path));
  const answered = pending.filter((item) => !changed.has(item.path));
  // The client answered in a shape the SDK drops before the handler runs. Ask
  // the same question once more; the sealed `reissued` flag stops a loop.
  if (sealed.reissued !== true && ctx.droppedInputResponseKeys?.length) {
    const dropped = new Set(ctx.droppedInputResponseKeys);
    if (answered.some((item) => dropped.has(keyOf(item.path)))) {
      return ask(
        { ...sealed, reissued: true },
        answered.map((item) => input(item, keyOf(item.path))),
      );
    }
  }

  const verdicts = new Map<string, Verdict>();
  for (const item of pending) {
    if (changed.has(item.path)) {
      verdicts.set(item.path, 'changed');
      continue;
    }
    const key = keyOf(item.path);
    const choice = readAcceptedChoice(ctx.inputResponses, key);
    verdicts.set(
      item.path,
      choice === acceptChoice
        ? 'proceed'
        : choice === 'skip'
          ? 'skipped'
          : { refused: describeRefusal(ctx, key) },
    );
  }
  return { verdict: (path) => verdicts.get(path) ?? 'proceed' };
}
