import type { InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { confirm, type Confirmed, type ConfirmItem } from '../src/core/confirmation.ts';
import { type EntryIdentity, UNKNOWN_IDENTITY } from '../src/core/fs.ts';
import {
  describeRefusal,
  type PendingCtx,
  type PendingState,
  requestStateCodec,
} from '../src/core/input-required.ts';

/** The two fields `requestStateBinding` reads; everything else is unused. */
function bindContext(): ServerContext {
  return { mcpReq: { method: 'tools/call' } } as unknown as ServerContext;
}

const id = (ino: number): EntryIdentity => ({ itemType: 'file', dev: 1, ino, birthtimeMs: 1 });

const item = (path: string, ino = 1, required = true): ConfirmItem => ({
  path,
  identity: id(ino),
  required,
  message: `Overwrite "${path}"?`,
});

const accept = (choice: string) => ({ action: 'accept', content: { choice } });

/** A sealed state as `confirm` itself would mint it. */
function sealed(paths: Record<string, number>, extra: Partial<PendingState> = {}): PendingState {
  return {
    op: 'create',
    paths: Object.keys(paths).sort(),
    identities: Object.keys(paths)
      .sort()
      .map((path) => ({ path, ...id(paths[path] ?? 0) })),
    ...extra,
  };
}

function ctx(
  state: PendingState | undefined,
  inputResponses?: Record<string, unknown>,
  droppedInputResponseKeys?: string[],
): PendingCtx {
  return {
    requestState: () => state,
    serverCtx: bindContext(),
    ...(inputResponses ? { inputResponses } : {}),
    ...(droppedInputResponseKeys ? { droppedInputResponseKeys } : {}),
  };
}

async function run(
  c: PendingCtx,
  items: readonly ConfirmItem[],
): Promise<InputRequiredResult | Confirmed> {
  return confirm(c, 'create', 'overwrite', items);
}

async function asRound(result: InputRequiredResult | Confirmed): Promise<PendingState> {
  assert.ok(isInputRequiredResult(result), 'expected input_required');
  return requestStateCodec.verify(result.requestState ?? '', bindContext());
}

function asConfirmed(result: InputRequiredResult | Confirmed): Confirmed {
  assert.ok(!isInputRequiredResult(result), 'expected Confirmed');
  return result;
}

describe('Confirmation', () => {
  it('nothing-required: proceeds without a round', async () => {
    const done = asConfirmed(await run(ctx(undefined), [item('a', 1, false), item('b', 2, false)]));
    assert.strictEqual(done.verdict('a'), 'proceed');
    assert.strictEqual(done.verdict('b'), 'proceed');
  });

  it('first-round: seals the sorted paths and their identities', async () => {
    const result = await run(ctx(undefined), [item('b', 2), item('a', 1)]);
    const state = await asRound(result);
    assert.deepStrictEqual(state.paths, ['a', 'b']);
    assert.deepStrictEqual(state.identities, [
      { path: 'a', ...id(1) },
      { path: 'b', ...id(2) },
    ]);
    assert.strictEqual(state.reprompted, undefined);
    assert.ok(isInputRequiredResult(result));
    assert.deepStrictEqual(Object.keys(result.inputRequests ?? {}), ['confirm_0', 'confirm_1']);
  });

  it('accepted: proceeds', async () => {
    const done = asConfirmed(
      await run(ctx(sealed({ a: 1 }), { confirm_0: accept('overwrite') }), [item('a')]),
    );
    assert.strictEqual(done.verdict('a'), 'proceed');
  });

  it('skipped and declined', async () => {
    const skipped = asConfirmed(
      await run(ctx(sealed({ a: 1 }), { confirm_0: accept('skip') }), [item('a')]),
    );
    assert.strictEqual(skipped.verdict('a'), 'skipped');
    const declined = asConfirmed(
      await run(ctx(sealed({ a: 1 }), { confirm_0: { action: 'decline' } }), [item('a')]),
    );
    assert.deepStrictEqual(declined.verdict('a'), { refused: 'declined by the user' });
  });

  const both = { confirm_0: accept('skip'), confirm_1: accept('overwrite') };

  it('vanish-first: reads the survivor at its sealed index', async () => {
    const done = asConfirmed(await run(ctx(sealed({ a: 1, b: 2 }), both), [item('b', 2)]));
    assert.strictEqual(done.verdict('b'), 'proceed');
  });

  it('vanish-last: reads the survivor at its sealed index', async () => {
    const done = asConfirmed(await run(ctx(sealed({ a: 1, b: 2 }), both), [item('a', 1)]));
    assert.strictEqual(done.verdict('a'), 'skipped');
  });

  it('vanish-all: proceeds', async () => {
    asConfirmed(await run(ctx(sealed({ a: 1 })), []));
  });

  it('swap: re-prompts once with the new identity', async () => {
    const state = await asRound(
      await run(ctx(sealed({ a: 1 }), { confirm_0: accept('overwrite') }), [item('a', 2)]),
    );
    assert.strictEqual(state.reprompted, true);
    assert.deepStrictEqual(state.identities, [{ path: 'a', ...id(2) }]);
  });

  it('appear: re-prompts the whole pending set', async () => {
    const state = await asRound(
      await run(ctx(sealed({ a: 1 }), { confirm_0: accept('overwrite') }), [
        item('a', 1),
        item('b', 2),
      ]),
    );
    assert.strictEqual(state.reprompted, true);
    assert.deepStrictEqual(state.paths, ['a', 'b']);
  });

  it('foreign-path: never proceeds for an unsealed path', async () => {
    await asRound(
      await run(ctx(sealed({ a: 1 }), { confirm_0: accept('overwrite') }), [item('b', 1)]),
    );
  });

  it('swap-after-reprompt: the changed item is refused, the rest proceeds', async () => {
    const done = asConfirmed(
      await run(
        ctx(sealed({ a: 1, b: 2 }, { reprompted: true }), {
          confirm_0: accept('overwrite'),
          confirm_1: accept('overwrite'),
        }),
        [item('a', 9), item('b', 2)],
      ),
    );
    assert.strictEqual(done.verdict('a'), 'changed');
    assert.strictEqual(done.verdict('b'), 'proceed');
  });

  it('keep-pending: a sealed path stays pending when no longer required', async () => {
    const done = asConfirmed(
      await run(ctx(sealed({ a: 1 }), { confirm_0: accept('skip') }), [item('a', 1, false)]),
    );
    assert.strictEqual(done.verdict('a'), 'skipped');
  });

  it('old-shape: a state without identities is no state', async () => {
    const state = await asRound(
      await run(ctx({ op: 'create', paths: ['a'] }, { confirm_0: accept('overwrite') }), [
        item('a'),
      ]),
    );
    assert.strictEqual(state.reprompted, undefined);
  });

  it('foreign-op: another op’s state is no state', async () => {
    await asRound(
      await run(ctx({ op: 'grant', paths: ['a'] }, { confirm_0: accept('overwrite') }), [
        item('a'),
      ]),
    );
  });

  it('dropped-answer: re-issues once with the sealed identities', async () => {
    const state = await asRound(await run(ctx(sealed({ a: 1 }), {}, ['confirm_0']), [item('a')]));
    assert.strictEqual(state.reissued, true);
    assert.deepStrictEqual(state.identities, [{ path: 'a', ...id(1) }]);
  });

  it('reissued-dropped-again: refuses without a new round', async () => {
    const done = asConfirmed(
      await run(ctx(sealed({ a: 1 }, { reissued: true }), {}, ['confirm_0']), [item('a')]),
    );
    assert.deepStrictEqual(done.verdict('a'), {
      refused: describeRefusal({ droppedInputResponseKeys: ['confirm_0'] }, 'confirm_0'),
    });
  });

  it('vanish-then-dropped: a vanished entry’s dropped key does not re-issue', async () => {
    const done = asConfirmed(
      await run(ctx(sealed({ a: 1, b: 2 }), both, ['confirm_0']), [item('b', 2)]),
    );
    assert.strictEqual(done.verdict('b'), 'proceed');
  });

  it('unknown-identity: an unchanged unknown identity proceeds', async () => {
    const state: PendingState = {
      op: 'create',
      paths: ['a'],
      identities: [{ path: 'a', ...UNKNOWN_IDENTITY }],
    };
    const done = asConfirmed(
      await run(ctx(state, { confirm_0: accept('overwrite') }), [
        { ...item('a'), identity: UNKNOWN_IDENTITY },
      ]),
    );
    assert.strictEqual(done.verdict('a'), 'proceed');
  });
});
