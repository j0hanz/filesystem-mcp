import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ClientCapabilities, ServerContext } from '@modelcontextprotocol/server';
import {
  createMcpHandler,
  createRequestStateCodec,
  isInputRequiredResult,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { ErrorCode } from '../src/core/errors.ts';
import {
  buildInputRequired,
  describeRefusal,
  pendingRoundTrip,
  readAcceptedChoice,
  readAcceptedConfirm,
  readAcceptedMultiChoice,
  requestStateCodec,
} from '../src/core/input-required.ts';
import { createServer } from '../src/server.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  firstTextBlock,
  fsErrorMatcher,
  writeTestFile,
} from './helpers.ts';

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

describe('input_required multi-round-trip infrastructure', () => {
  const modes: {
    name: string;
    capabilities: ClientCapabilities | undefined;
    canElicit: boolean;
  }[] = [
    { name: 'unknown', capabilities: undefined, canElicit: true },
    { name: 'none', capabilities: {}, canElicit: false },
    { name: 'implicit form', capabilities: { elicitation: {} }, canElicit: true },
    { name: 'form', capabilities: { elicitation: { form: {} } }, canElicit: true },
    { name: 'form and URL', capabilities: { elicitation: { form: {}, url: {} } }, canElicit: true },
    { name: 'URL only', capabilities: { elicitation: { url: {} } }, canElicit: false },
  ];
  const hints = {
    delete: 'Delete the entries inside it individually',
    move: 'Delete the destination first',
    copy: 'Pass overwrite=true',
    create: 'Pass overwrite: true',
    grant: 'Call list_roots',
  } as const;
  for (const op of ['delete', 'move', 'copy', 'create', 'grant'] as const) {
    for (const mode of modes) {
      it(`SDK-AUDIT-MODES-001: ${op} honors ${mode.name} capabilities`, async () => {
        const round = pendingRoundTrip({
          op,
          pending: ['/target'],
          requestState: undefined,
          clientCapabilities: mode.capabilities,
          buildInputs: () => [{ key: 'confirm', message: 'Confirm operation?' }],
          serverCtx: bindContext(),
        });

        if (mode.canElicit) {
          assert.strictEqual(isInputRequiredResult(await round), true);
        } else {
          await assert.rejects(round, fsErrorMatcher(ErrorCode.INVALID_INPUT, hints[op]));
        }
      });
    }
  }

  it('SDK-AUDIT-MODES-002: URL-only clients get a recoverable modern create error', async () => {
    const root = await createTestRoot();
    const handler = createMcpHandler(
      async ({ era }) => {
        const context = await createServer({ cliAllowedDirs: [root] }, { era });
        const previousOnClose = context.mcp.server.onclose;
        context.mcp.server.onclose = () => {
          previousOnClose?.();
          context.disposeRuntimeState();
        };
        return context.mcp;
      },
      { legacy: 'reject' },
    );
    const client = new Client(
      { name: 'url-only-test', version: '1.0.0' },
      {
        capabilities: { elicitation: { url: {} } },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    );
    let elicitations = 0;
    client.setRequestHandler('elicitation/create', () => {
      elicitations++;
      return { action: 'decline' };
    });
    try {
      const target = await writeTestFile(root, 'existing.txt', 'original body');
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
          fetch: (url, init) => handler.fetch(new Request(url, init)),
        }),
      );
      assert.strictEqual(client.getProtocolEra(), 'modern');

      const result = await client.callTool({
        name: 'create',
        arguments: { files: [{ path: target, content: 'replacement body' }] },
      });

      assert.strictEqual(result.isError, true);
      assert.match(firstTextBlock(result).text ?? '', /overwrite: true/);
      assert.strictEqual(elicitations, 0);
      assert.strictEqual(await readFile(target, 'utf8'), 'original body');
    } finally {
      await client.close();
      await handler.close();
      await cleanupTestRoot(root);
    }
  });

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
    await assert.rejects(async () => {
      await pendingRoundTrip({
        op: 'move',
        pending: ['/y'],
        requestState: () => decoded,
        buildInputs: (paths) =>
          paths.map((p, idx) => ({ key: `confirm_${idx}`, message: `Move ${p}?` })),
        serverCtx: bindContext(),
      });
    }, fsErrorMatcher(ErrorCode.INVALID_INPUT));
  });

  it('5b. pendingRoundTrip rejects a pending set that merely EXTENDS the bound one (R9)', async () => {
    // The bound set is a prefix of the retried one: a confirmation minted for
    // /x must not authorize /x AND /y.
    const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/x'] }, bindContext());
    const decoded = await requestStateCodec.verify(wire, bindContext());
    await assert.rejects(async () => {
      await pendingRoundTrip({
        op: 'delete',
        pending: ['/x', '/y'],
        requestState: () => decoded,
        buildInputs: (paths) =>
          paths.map((p, idx) => ({ key: `confirm_${idx}`, message: `Delete ${p}?` })),
        serverCtx: bindContext(),
      });
    }, fsErrorMatcher(ErrorCode.INVALID_INPUT));
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
        {
          key: 'confirm_0',
          message: 'Destination "/dst" exists. Overwrite or skip?',
          choices: overwriteSkipChoices,
        },
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
      [
        {
          key: 'grant',
          message: 'Grant access to these directories?',
          choices: grantChoices,
          multi: true,
        },
      ],
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
