import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ClientCapabilities, ServerContext } from '@modelcontextprotocol/server';
import {
  createMcpHandler,
  createRequestStateCodec,
  isInputRequiredResult,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

  it('6b. pendingRoundTrip re-issues once when the answer key was dropped by the SDK', async () => {
    const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/x'] }, bindContext());
    const decoded = await requestStateCodec.verify(wire, bindContext());
    const buildInputs = (paths: readonly string[]) =>
      paths.map((p, idx) => ({ key: `confirm_${idx}`, message: `Delete ${p}?` }));

    const reissued = await pendingRoundTrip({
      op: 'delete',
      pending: ['/x'],
      requestState: () => decoded,
      droppedInputResponseKeys: ['confirm_0'],
      buildInputs,
      serverCtx: bindContext(),
    });
    assert.ok(reissued !== undefined && isInputRequiredResult(reissued));
    assert.deepStrictEqual(Object.keys(reissued.inputRequests ?? {}), ['confirm_0']);

    // The re-issued state is sealed with the flag: a second dropped answer
    // is not asked again.
    const second = await requestStateCodec.verify(reissued.requestState ?? '', bindContext());
    assert.strictEqual(second.reissued, true);
    const proceed = await pendingRoundTrip({
      op: 'delete',
      pending: ['/x'],
      requestState: () => second,
      droppedInputResponseKeys: ['confirm_0'],
      buildInputs,
      serverCtx: bindContext(),
    });
    assert.strictEqual(proceed, undefined);
  });

  it('6c. a dropped key that is not one of this round’s inputs does not re-issue', async () => {
    const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/x'] }, bindContext());
    const decoded = await requestStateCodec.verify(wire, bindContext());
    const result = await pendingRoundTrip({
      op: 'delete',
      pending: ['/x'],
      requestState: () => decoded,
      droppedInputResponseKeys: ['unrelated'],
      buildInputs: (paths) => paths.map((p, idx) => ({ key: `confirm_${idx}`, message: p })),
      serverCtx: bindContext(),
    });
    assert.strictEqual(result, undefined);
  });

  it('6d. the R9 path check still runs before a re-issue', async () => {
    const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/x'] }, bindContext());
    const decoded = await requestStateCodec.verify(wire, bindContext());
    await assert.rejects(
      pendingRoundTrip({
        op: 'delete',
        pending: ['/y'],
        requestState: () => decoded,
        droppedInputResponseKeys: ['confirm_0'],
        buildInputs: (paths) => paths.map((p, idx) => ({ key: `confirm_${idx}`, message: p })),
        serverCtx: bindContext(),
      }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT),
    );
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

  it('names a dropped answer when told the dropped keys', () => {
    assert.match(describeRefusal({}, 'confirm_0', ['confirm_0']), /wrapped result/);
    assert.strictEqual(describeRefusal({}, 'confirm_0', ['other']), 'not answered');
  });
});

describe('wrapped inputResponses over the modern wire', () => {
  const META = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
    'io.modelcontextprotocol/clientInfo': { name: 'raw-modern-test', version: '1.0.0' },
  };

  async function post(
    handler: ReturnType<typeof createMcpHandler>,
    id: number,
    params: Record<string, unknown>,
  ): Promise<{ result?: Record<string, unknown>; error?: { message?: string } }> {
    const res = await handler.fetch(
      new Request('http://test.local/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          // The modern HTTP binding's standard headers: the entry refuses a
          // 2026-07-28 request missing any of them before dispatch
          // (`validateStandardRequestHeaders` in the SDK). `Mcp-Name` must
          // equal `params.name` for tools/call.
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': String(params['name']),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params }),
      }),
    );
    const text = await res.text();
    // Tolerate an SSE-framed reply by taking the last `data:` line.
    const json = res.headers.get('content-type')?.includes('text/event-stream')
      ? (
          text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .at(-1) ?? ''
        ).slice(5)
      : text;
    return JSON.parse(json) as { result?: Record<string, unknown>; error?: { message?: string } };
  }

  it('a wrapped confirmation is asked again once, then named in the refusal', async () => {
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
    try {
      const dir = join(root, 'victim');
      await writeTestFile(root, 'victim/f.txt', 'x');
      const args = { paths: [dir], recursive: true };

      const first = await post(handler, 1, { name: 'delete', arguments: args, _meta: META });
      assert.strictEqual(first.result?.['resultType'], 'input_required', JSON.stringify(first));
      const requestState = first.result?.['requestState'] as string;
      const [key] = Object.keys(first.result?.['inputRequests'] as object);
      assert.ok(key);

      const wrapped = {
        [key]: {
          method: 'elicitation/create',
          result: { action: 'accept', content: { choice: 'delete' } },
        },
      };
      const second = await post(handler, 2, {
        name: 'delete',
        arguments: args,
        _meta: META,
        inputResponses: wrapped,
        requestState,
      });
      assert.strictEqual(
        second.result?.['resultType'],
        'input_required',
        `re-issued once: ${JSON.stringify(second)}`,
      );
      const requestState2 = second.result?.['requestState'] as string;
      assert.notStrictEqual(requestState2, requestState);

      const third = await post(handler, 3, {
        name: 'delete',
        arguments: args,
        _meta: META,
        inputResponses: wrapped,
        requestState: requestState2,
      });
      assert.notStrictEqual(third.result?.['resultType'], 'input_required');
      assert.strictEqual(third.result?.['isError'], true, JSON.stringify(third));
      // The refusal wording lives in the per-path failure and may or may not
      // be echoed in the text block; match the whole result.
      assert.match(JSON.stringify(third.result), /wrapped result/);
      await access(join(dir, 'f.txt')); // nothing was deleted
    } finally {
      await handler.close();
      await cleanupTestRoot(root);
    }
  });
});
