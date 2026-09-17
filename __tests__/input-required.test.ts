import type { ServerContext } from '@modelcontextprotocol/server';
import { createRequestStateCodec, isInputRequiredResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.js';
import {
  buildInputRequired,
  choiceInput,
  describeRefusal,
  multiSelectInput,
  pendingRoundTrip,
  readAcceptedChoice,
  readAcceptedConfirm,
  readAcceptedMultiChoice,
  requestStateBinding,
  requestStateCodec,
} from '../src/core/input-required.js';

/** The two fields `requestStateBinding` reads; everything else is unused. */
function bindContext(method = 'tools/call', clientId?: string): ServerContext {
  return {
    mcpReq: { method },
    ...(clientId === undefined ? {} : { http: { authInfo: { clientId } } }),
  } as unknown as ServerContext;
}

/** The converted `requestedSchema` an embedded elicitation carries, keyed by its one field. */
interface FormRequest<K extends string> {
  params?: {
    requestedSchema?: {
      properties?: Partial<
        Record<K, { type?: string; title?: string; enum?: string[]; items?: { enum?: string[] } }>
      >;
    };
  };
}

describe('request-state key initialization', () => {
  it('binds the codec to a key configured after import, on first use', async () => {
    const stateKey = 'a'.repeat(32);
    const saved = process.env['FS_REQUEST_STATE_KEY'];
    process.env['FS_REQUEST_STATE_KEY'] = stateKey;
    try {
      // The codec is built lazily, so the first mint is what reads the env var.
      const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/fleet'] }, bindContext());
      const reference = createRequestStateCodec<{ op: string; paths: string[] }>({
        key: stateKey,
        bind: requestStateBinding,
      });
      const decoded = await reference.verify(wire, bindContext());
      assert.deepStrictEqual(decoded, { op: 'delete', paths: ['/fleet'] });
    } finally {
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, 'FS_REQUEST_STATE_KEY');
      } else {
        process.env['FS_REQUEST_STATE_KEY'] = saved;
      }
    }
  });
});

describe('input_required multi-round-trip infrastructure', () => {
  it('1. requestStateCodec mint/verify round-trip', async () => {
    const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/a', '/b'] }, bindContext());
    const decoded = await requestStateCodec.verify(wire, bindContext());
    assert.strictEqual(decoded.op, 'delete');
    assert.deepStrictEqual(decoded.paths, ['/a', '/b']);
  });

  it('2. requestStateCodec.verify rejects a tampered token', async () => {
    const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/a'] }, bindContext());
    assert.ok(wire.length > 10);
    const tampered = wire.slice(0, 10) + (wire[10] === 'X' ? 'Y' : 'X') + wire.slice(11);
    await assert.rejects(async () => {
      await requestStateCodec.verify(tampered, bindContext());
    });
  });

  it('2b. requestStateCodec.verify rejects an expired token', async () => {
    const codec = createRequestStateCodec<{ op: string; paths: string[] }>({
      key: 'k'.repeat(32),
      ttlSeconds: 1,
    });
    const wire = await codec.mint({ op: 'delete', paths: ['/a'] });
    await new Promise((r) => setTimeout(r, 2100));
    await assert.rejects(() => codec.verify(wire, bindContext()));
  });

  it('2c. requestStateCodec.verify rejects a malformed token', async () => {
    await assert.rejects(() => requestStateCodec.verify('not-a-valid-state-string', bindContext()));
  });

  it('2d. requestStateCodec.verify rejects a token echoed under another method', async () => {
    const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/a'] }, bindContext());
    await assert.rejects(() => requestStateCodec.verify(wire, bindContext('prompts/get')));
  });

  it('2e. requestStateCodec.verify rejects a token echoed by another caller', async () => {
    const minted = bindContext('tools/call', 'api-key');
    const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/a'] }, minted);
    const same = await requestStateCodec.verify(wire, bindContext('tools/call', 'api-key'));
    assert.strictEqual(same.op, 'delete');
    await assert.rejects(() => requestStateCodec.verify(wire, bindContext('tools/call', 'other')));
    await assert.rejects(() => requestStateCodec.verify(wire, bindContext()));
  });

  it('3. pendingRoundTrip with no requestState mints a fresh input_required', async () => {
    const result = await pendingRoundTrip({
      op: 'delete',
      pending: ['/a'],
      requestState: undefined,
      buildInputs: (paths) =>
        paths.map((p, idx) => ({ key: `confirm_${idx}`, message: `Delete ${p}?` })),
      serverCtx: bindContext(),
    });
    assert.ok(result !== undefined);
    assert.strictEqual(isInputRequiredResult(result), true);
  });

  it('4. pendingRoundTrip same-op + same paths returns undefined (proceed)', async () => {
    const wire = await requestStateCodec.mint({ op: 'move', paths: ['/x'] }, bindContext());
    const decoded = await requestStateCodec.verify(wire, bindContext());
    const result = await pendingRoundTrip({
      op: 'move',
      pending: ['/x'],
      requestState: () => decoded,
      buildInputs: (paths) =>
        paths.map((p, idx) => ({ key: `confirm_${idx}`, message: `Move ${p}?` })),
      serverCtx: bindContext(),
    });
    assert.strictEqual(result, undefined);
  });

  it('5. pendingRoundTrip same-op + different paths throws FsError(INVALID_INPUT) (R9)', async () => {
    const wire = await requestStateCodec.mint({ op: 'move', paths: ['/x'] }, bindContext());
    const decoded = await requestStateCodec.verify(wire, bindContext());
    await assert.rejects(
      async () => {
        await pendingRoundTrip({
          op: 'move',
          pending: ['/y'],
          requestState: () => decoded,
          buildInputs: (paths) =>
            paths.map((p, idx) => ({ key: `confirm_${idx}`, message: `Move ${p}?` })),
          serverCtx: bindContext(),
        });
      },
      (e: unknown) => isFsError(e) && e.code === ErrorCode.INVALID_INPUT,
    );
  });

  it('5b. pendingRoundTrip rejects a pending set that merely EXTENDS the bound one (R9)', async () => {
    // The bound set is a prefix of the retried one: a confirmation minted for
    // /x must not authorize /x AND /y.
    const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/x'] }, bindContext());
    const decoded = await requestStateCodec.verify(wire, bindContext());
    await assert.rejects(
      async () => {
        await pendingRoundTrip({
          op: 'delete',
          pending: ['/x', '/y'],
          requestState: () => decoded,
          buildInputs: (paths) =>
            paths.map((p, idx) => ({ key: `confirm_${idx}`, message: `Delete ${p}?` })),
          serverCtx: bindContext(),
        });
      },
      (e: unknown) => isFsError(e) && e.code === ErrorCode.INVALID_INPUT,
    );
  });

  it('6. pendingRoundTrip different-op mints fresh input_required', async () => {
    const wire = await requestStateCodec.mint({ op: 'grant', paths: ['/x'] }, bindContext());
    const decoded = await requestStateCodec.verify(wire, bindContext());
    const result = await pendingRoundTrip({
      op: 'delete',
      pending: ['/x'],
      requestState: () => decoded,
      buildInputs: (paths) =>
        paths.map((p, idx) => ({ key: `confirm_${idx}`, message: `Delete ${p}?` })),
      serverCtx: bindContext(),
    });
    assert.ok(result !== undefined);
    assert.strictEqual(isInputRequiredResult(result), true);
  });

  it('7. buildInputRequired shape', async () => {
    const r = await buildInputRequired(
      { op: 'delete', paths: ['/a'] },
      [{ key: 'confirm_0', message: 'Delete /a?' }],
      bindContext(),
    );
    assert.strictEqual(isInputRequiredResult(r), true);
    assert.ok(r.inputRequests);
    assert.ok(r.inputRequests['confirm_0'] !== undefined);
    assert.strictEqual(typeof r.requestState, 'string');
    assert.ok(typeof r.requestState === 'string' && r.requestState.length > 0);
    const request = r.inputRequests['confirm_0'] as FormRequest<'confirm'>;
    assert.strictEqual(request.params?.requestedSchema?.properties?.confirm?.type, 'boolean');
    assert.strictEqual(request.params?.requestedSchema?.properties?.confirm?.title, 'Confirm');
  });

  it('8. readAcceptedConfirm accept-true -> true', () => {
    const accepted = readAcceptedConfirm(
      { confirm_0: { action: 'accept', content: { confirm: true } } },
      'confirm_0',
    );
    assert.strictEqual(accepted, true);
  });

  it('9. readAcceptedConfirm decline / cancel / missing-key / accept-without-confirm -> false', () => {
    assert.strictEqual(
      readAcceptedConfirm({ confirm_0: { action: 'decline' } }, 'confirm_0'),
      false,
    );
    assert.strictEqual(
      readAcceptedConfirm({ confirm_0: { action: 'cancel' } }, 'confirm_0'),
      false,
    );
    assert.strictEqual(
      readAcceptedConfirm(
        { other_key: { action: 'accept', content: { confirm: true } } },
        'confirm_0',
      ),
      false,
    );
    assert.strictEqual(
      readAcceptedConfirm({ confirm_0: { action: 'accept', content: {} } }, 'confirm_0'),
      false,
    );
  });

  const overwriteSkipChoices = ['overwrite', 'skip'] as const;

  it('10. buildInputRequired with choiceInput returns InputRequiredResult with requestState', async () => {
    const r = await buildInputRequired(
      { op: 'copy', paths: ['/dst'] },
      [
        choiceInput(
          'confirm_0',
          'Destination "/dst" exists. Overwrite or skip?',
          overwriteSkipChoices,
        ),
      ],
      bindContext(),
    );
    assert.strictEqual(isInputRequiredResult(r), true);
    assert.ok(r.inputRequests);
    assert.ok(r.inputRequests['confirm_0'] !== undefined);
    assert.strictEqual(typeof r.requestState, 'string');
    assert.ok(typeof r.requestState === 'string' && r.requestState.length > 0);
    const request = r.inputRequests['confirm_0'] as FormRequest<'choice'>;
    assert.deepStrictEqual(request.params?.requestedSchema?.properties?.choice?.enum, [
      'overwrite',
      'skip',
    ]);
    assert.strictEqual(request.params?.requestedSchema?.properties?.choice?.title, 'Action');
  });

  it('11. readAcceptedChoice accept-skip -> "skip"', () => {
    assert.strictEqual(
      readAcceptedChoice(
        { confirm_0: { action: 'accept', content: { choice: 'skip' } } },
        'confirm_0',
      ),
      'skip',
    );
  });

  it('12. readAcceptedChoice accept-overwrite -> "overwrite"', () => {
    assert.strictEqual(
      readAcceptedChoice(
        { confirm_0: { action: 'accept', content: { choice: 'overwrite' } } },
        'confirm_0',
      ),
      'overwrite',
    );
  });

  it('13. readAcceptedChoice decline -> undefined', () => {
    assert.strictEqual(
      readAcceptedChoice({ confirm_0: { action: 'decline' } }, 'confirm_0'),
      undefined,
    );
  });

  it('14. readAcceptedChoice accept-without-choice -> undefined', () => {
    assert.strictEqual(
      readAcceptedChoice({ confirm_0: { action: 'accept', content: {} } }, 'confirm_0'),
      undefined,
    );
  });

  it('15. readAcceptedChoice missing-key -> undefined', () => {
    assert.strictEqual(
      readAcceptedChoice({ other: { action: 'accept', content: { choice: 'skip' } } }, 'confirm_0'),
      undefined,
    );
  });

  const grantChoices = ['/dir/a', '/dir/b'] as const;

  it('16. buildInputRequired with multiSelectInput returns InputRequiredResult', async () => {
    const r = await buildInputRequired(
      { op: 'grant', paths: ['/dir/a', '/dir/b'] },
      [multiSelectInput('grant', 'Grant access to these directories?', grantChoices)],
      bindContext(),
    );
    assert.strictEqual(isInputRequiredResult(r), true);
    assert.ok(r.inputRequests);
    assert.ok(r.inputRequests['grant'] !== undefined);
    assert.strictEqual(typeof r.requestState, 'string');
    const request = r.inputRequests['grant'] as FormRequest<'choice'>;
    assert.deepStrictEqual(request.params?.requestedSchema?.properties?.choice?.items?.enum, [
      '/dir/a',
      '/dir/b',
    ]);
    assert.strictEqual(request.params?.requestedSchema?.properties?.choice?.title, 'Allow');
  });

  it('17. readAcceptedMultiChoice accept-array -> array', () => {
    assert.deepStrictEqual(
      readAcceptedMultiChoice(
        { grant: { action: 'accept', content: { choice: ['/dir/a'] } } },
        'grant',
      ),
      ['/dir/a'],
    );
  });

  it('18. readAcceptedMultiChoice decline -> undefined', () => {
    assert.strictEqual(
      readAcceptedMultiChoice({ grant: { action: 'decline' } }, 'grant'),
      undefined,
    );
  });

  it('19. readAcceptedMultiChoice accept-with-non-array-choice -> undefined', () => {
    assert.strictEqual(
      readAcceptedMultiChoice(
        { grant: { action: 'accept', content: { choice: '/dir/a' } } },
        'grant',
      ),
      undefined,
    );
  });

  it('20. readAcceptedMultiChoice accept-with-empty-content -> undefined', () => {
    assert.strictEqual(
      readAcceptedMultiChoice({ grant: { action: 'accept', content: {} } }, 'grant'),
      undefined,
    );
  });

  it('21. readAcceptedMultiChoice missing-key -> undefined', () => {
    assert.strictEqual(
      readAcceptedMultiChoice(
        { other: { action: 'accept', content: { choice: ['/dir/a'] } } },
        'grant',
      ),
      undefined,
    );
  });
});

describe('describeRefusal', () => {
  it('names each refusal kind', () => {
    const cases: [Record<string, unknown> | undefined, string][] = [
      [{ confirm_0: { action: 'decline' } }, 'declined by the user'],
      [{ confirm_0: { action: 'cancel' } }, 'dismissed by the user'],
      [{ confirm_0: { action: 'accept', content: {} } }, 'answered without a valid choice'],
      [{}, 'not answered'],
      [undefined, 'not answered'],
    ];
    for (const [responses, expected] of cases) {
      assert.strictEqual(describeRefusal(responses, 'confirm_0'), expected);
    }
  });
});
