# Plan 049: A confirmation the SDK dropped is asked again, not reported as a refusal

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat fb51aee1..HEAD -- src/core/input-required.ts src/tools/define.ts src/tools/create.ts src/tools/delete.ts src/tools/move.ts __tests__/input-required.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW — one extra `input_required` round for clients that answered
  in a shape the SDK discards; the R9 path binding and the HMAC codec are
  untouched, and the re-issue is capped at one by a flag sealed inside the
  state.
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `fb51aee1`, 2026-09-29

## Why this matters

On a 2026-07-28 retry the SDK partitions `params.inputResponses`: an entry
that is not a bare result — in particular the `{ method, result }` wrapper
"some peers emit" — is dropped **before the handler runs**, and its key is
surfaced as `ctx.mcpReq.droppedInputResponseKeys` precisely so a server can
ask again instead of hard-failing. This server never reads that field. The
readers in `input-required.ts` see a missing key, `describeRefusal` calls it
"not answered", and the tool reports `CANCELLED`: a user who clicked
"delete" or "overwrite" in a host with that quirk is told they cancelled,
on every recursive delete, every overwrite and every out-of-root grant.
After this plan the server re-issues the same confirmation once (the
sealed `requestState` remembers it already did) on all four flows —
delete, create/move overwrite, and the out-of-root grant. If the second
answer is dropped too, delete/create/move name the real cause in their
`CANCELLED` refusal; the grant flow keeps its existing fail-closed outcome
(no grant applied, the path fails `ACCESS_DENIED` at `validateAccess`),
which is already the message a declined grant produces.

## Current state

- SDK: `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-*.d.mts:2160-2167`
  — `mcpReq.droppedInputResponseKeys?: string[]`: "Keys of `inputResponses`
  entries the SDK dropped because they were not bare response objects (for
  example the wrapped `{method, result}` shape some peers emit). Surfaced so
  a handler can re-issue the corresponding input request rather than
  hard-fail." Runtime (`dist/src-*.mjs:6948-6964`, `partitionInputResponses`):
  an entry is dropped when it is not a plain object or has a `method` or
  `result` key. The retry members are lifted off `params` before any schema
  check (`dist/src-*.mjs:6085-6120`: `params.inputResponses`,
  `params.requestState`), so a wrapped entry reaches the handler as a dropped
  key, not as a `-32602`.
- `src/core/input-required.ts:37-46`:

```ts
export interface PendingState {
  readonly op: PendingOp;
  readonly paths: readonly string[];
}
```

- `src/core/input-required.ts:143-161` — `buildInputRequired(pending, inputs, ctx)`
  mints `{ op: pending.op, paths: [...pending.paths].sort() }`.
- `src/core/input-required.ts:180-192` — `PendingRoundTripOpts` has `op`,
  `pending`, `requestState`, `clientCapabilities?`, `buildInputs`, `serverCtx`.
- `src/core/input-required.ts:238-268` — `pendingRoundTrip`:

```ts
const state = opts.requestState?.();
if (state?.op !== opts.op) {
  assertCanElicit(opts.op, opts.clientCapabilities);
  return buildInputRequired(
    { op: opts.op, paths: opts.pending },
    opts.buildInputs(opts.pending),
    opts.serverCtx,
  );
}
// Retry for THIS op (R9): the verified state must bind the same pending set.
if (!pathsEqual(state.paths, opts.pending)) {
  throw new FsError(
    ErrorCode.INVALID_INPUT,
    `${opts.op}: confirmation does not match the requested paths`,
  );
}
return undefined;
```

- `src/core/input-required.ts:332-341` — `describeRefusal(responses, key)`:
  `'not answered'` when the key is absent, else decline / cancel / no valid
  choice wording.
- `src/tools/define.ts:40-92` — `ToolCtx` has `inputResponses?` and
  `requestState?` but nothing for dropped keys.
- `src/tools/define.ts:160-180` — `toToolCtx` builds the ctx:
  `inputResponses: ctx.mcpReq.inputResponses, requestState: ctx.mcpReq.requestState, serverCtx: ctx,`.
- Call sites of `pendingRoundTrip`: `src/tools/define.ts:304` (grant, in
  `precheckGrant`, uses `this.toolCtx.*`), `src/tools/create.ts:136`,
  `src/tools/delete.ts:307`, `src/tools/move.ts:317`. Each passes
  `requestState: ctx.requestState, clientCapabilities: ctx.clientCapabilities, serverCtx: ctx.serverCtx`.
- Call sites of `describeRefusal`: `src/tools/create.ts:164`,
  `src/tools/delete.ts:254` (inside a function whose `ctx` is
  `Pick<ToolCtx, 'fs' | 'inputResponses' | 'log'>`, line 240),
  `src/tools/move.ts:194`.
- Tests: `__tests__/input-required.test.ts` — `bindContext()` (line 33)
  fakes a `ServerContext`; tests 3–6 (lines 187-260) exercise
  `pendingRoundTrip` with `requestState: () => decoded` where `decoded` is
  `await requestStateCodec.verify(await requestStateCodec.mint({...}, bindContext()), bindContext())`;
  `describe('describeRefusal')` (line 447) tabulates wording.
  `SDK-AUDIT-MODES-002` (line 97) shows a raw modern `createMcpHandler` +
  `Client` pinned to `2026-07-28` via `handler.fetch`.
- Modern-era raw wire facts (from `__tests__/stdio.test.ts:27-31`): a request
  needs `params._meta` with `'io.modelcontextprotocol/protocolVersion': '2026-07-28'`,
  `'io.modelcontextprotocol/clientCapabilities': {}` (use
  `{ elicitation: { form: {} } }` here so `assertCanElicit` passes) and
  `'io.modelcontextprotocol/clientInfo'`. A retry carries
  `params.inputResponses` and `params.requestState` (byte-exact echo).

Conventions: the `readAccepted*` readers never trust client values; every
refusal wording lives in `describeRefusal`; `FsError(ErrorCode.CANCELLED …)`
is how a refused confirmation surfaces; tests are `node:test` +
`node:assert/strict`.

## Commands you will need

| Purpose         | Command                                                  | Expected on success |
| --------------- | -------------------------------------------------------- | ------------------- |
| Build           | `npm run build`                                          | exit 0              |
| Typecheck tests | `npm run type-check:test`                                | exit 0              |
| Lint            | `npm run lint`                                           | exit 0              |
| Focused tests   | `npm test -- __tests__/input-required.test.ts`           | all pass            |
| Tool tests      | `npm test -- --test-name-pattern="delete\|create\|move"` | all pass            |
| Full check      | `npm run check`                                          | exit 0; `fail 0`    |

Baseline at planning time: 536 tests, 533 pass, 3 skipped, 0 fail.

## Scope

**In scope**:

- `src/core/input-required.ts`
- `src/tools/define.ts` (ctx field + the grant call site)
- `src/tools/create.ts`, `src/tools/delete.ts`, `src/tools/move.ts` (pass-through only)
- `__tests__/input-required.test.ts`
- `plans/README.md` — status row

**Out of scope**:

- `readAcceptedConfirm` / `readAcceptedChoice` / `readAcceptedMultiChoice`
  semantics — a dropped key still reads as "no answer" there; the re-issue
  happens one level up.
- The legacy shim path (2025-era connections): the SDK fulfils rounds itself
  there and never produces dropped keys.
- `requestStateBinding`, the codec key, `maxRounds` — unchanged.

## Git workflow

- Branch: `advisor/049-reissue-dropped-input-responses`
- Commit e.g. `fix(input-required): re-issue a confirmation the SDK dropped`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Carry the dropped keys into the tool context

In `src/tools/define.ts`:

1. Add to `ToolCtx` after `inputResponses`:

```ts
  /**
   * Keys of `inputResponses` entries the SDK dropped on this round because
   * they were not bare results (the `{ method, result }` wrapper some hosts
   * send). `pendingRoundTrip` re-issues a confirmation whose key is listed
   * here once; `describeRefusal` names the cause after that.
   */
  readonly droppedInputResponseKeys?: readonly string[] | undefined;
```

2. In `toToolCtx`, after `inputResponses: ctx.mcpReq.inputResponses,` add
   `droppedInputResponseKeys: ctx.mcpReq.droppedInputResponseKeys,`.

**Verify**: `npm run build` → exit 0.

### Step 2: Seal the "already re-issued" flag and re-issue once

In `src/core/input-required.ts`:

1. Extend `PendingState`:

```ts
export interface PendingState {
  readonly op: PendingOp;
  readonly paths: readonly string[];
  /**
   * Set on the state of a round minted because the previous round's answer
   * was dropped by the SDK (`droppedInputResponseKeys`). Sealed in the HMAC
   * payload, so a client cannot clear it: the re-issue happens once.
   */
  readonly reissued?: true;
}
```

2. In `buildInputRequired`, mint the flag through:

```ts
const requestState = await requestStateCodec.mint(
  {
    op: pending.op,
    paths: [...pending.paths].sort(),
    ...(pending.reissued ? { reissued: true as const } : {}),
  },
  ctx,
);
```

3. Add to `PendingRoundTripOpts`:

```ts
  /** `ctx.mcpReq.droppedInputResponseKeys` for this round; see `ToolCtx`. */
  readonly droppedInputResponseKeys?: readonly string[] | undefined;
```

4. In `pendingRoundTrip`, between the R9 `pathsEqual` check and
   `return undefined;`, add:

```ts
// The client answered, but in a shape the SDK discards before the handler
// runs (`{ method, result }` around the bare result). Ask the same question
// once more rather than report a refusal the user never made; the sealed
// `reissued` flag stops a second retry from looping.
if (state.reissued !== true && opts.droppedInputResponseKeys?.length) {
  const dropped = new Set(opts.droppedInputResponseKeys);
  const inputs = opts.buildInputs(opts.pending);
  if (inputs.some((input) => dropped.has(input.key))) {
    return buildInputRequired(
      { op: opts.op, paths: opts.pending, reissued: true },
      inputs,
      opts.serverCtx,
    );
  }
}
```

`assertCanElicit` is not re-run here: the first round already passed it
on this connection.

5. Extend `describeRefusal`:

```ts
export function describeRefusal(
  responses: Record<string, unknown> | undefined,
  key: string,
  droppedKeys?: readonly string[] | undefined,
): string {
  if (droppedKeys?.includes(key)) {
    return 'answered in a shape this server cannot read (a wrapped result instead of the bare elicitation result), twice';
  }
  const view = inputResponse(responses, key);
  ...
```

Update the function's doc comment: "…call after a `readAccepted*` reader
returned nothing. Pass the round's `droppedInputResponseKeys` so a dropped
answer is named as such rather than as 'not answered'."

**Verify**: `npm run build && npm run lint` → exit 0.

### Step 3: Thread the field through the four round-trip sites and three refusal sites

- `src/tools/define.ts:304` (`precheckGrant`): add
  `droppedInputResponseKeys: this.toolCtx.droppedInputResponseKeys,` to the
  `pendingRoundTrip({...})` options.
- `src/tools/create.ts:136`, `src/tools/delete.ts:307`, `src/tools/move.ts:317`:
  add `droppedInputResponseKeys: ctx.droppedInputResponseKeys,`.
- `src/tools/create.ts:164`, `src/tools/move.ts:194`: third argument
  `ctx.droppedInputResponseKeys`.
- `src/tools/delete.ts:240`: widen the `Pick` to
  `Pick<ToolCtx, 'fs' | 'inputResponses' | 'droppedInputResponseKeys' | 'log'>`;
  line 254: third argument `ctx.droppedInputResponseKeys`. Follow the
  `Pick` up to its caller if TypeScript reports a missing property and add
  the field there too — it comes from the tool's own `ctx`.

**Verify**: `npm run build && npm run type-check:test && npm run lint` → exit 0;
`npm test -- --test-name-pattern="delete|create|move|grant"` → all pass
(behaviour with no dropped keys is unchanged).

### Step 4: Unit tests

In `__tests__/input-required.test.ts`, after test "6." (line ~260) add:

```ts
it('7. pendingRoundTrip re-issues once when the answer key was dropped by the SDK', async () => {
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

it('7b. a dropped key that is not one of this round’s inputs does not re-issue', async () => {
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

it('7c. the R9 path check still runs before a re-issue', async () => {
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
```

In the `describe('describeRefusal')` block add:

```ts
it('names a dropped answer when told the dropped keys', () => {
  assert.match(describeRefusal({}, 'confirm_0', ['confirm_0']), /wrapped result/);
  assert.strictEqual(describeRefusal({}, 'confirm_0', ['other']), 'not answered');
});
```

`PendingState` is exported; if `reissued` is not visible on `second`, type
the `verify` result as `PendingState` (import the type from
`'../src/core/input-required.ts'`). The `inputRequests` / `requestState`
fields on `InputRequiredResult` are the SDK's (`dist/createMcpHandler-*.d.mts:706`).

**Verify**: `npm test -- __tests__/input-required.test.ts` → all pass,
4 new.

### Step 5: One end-to-end test over the raw modern wire

Still in `__tests__/input-required.test.ts`, add a describe modelled on
`SDK-AUDIT-MODES-002` (line 97) but driving `handler.fetch` directly, since
the SDK `Client` always sends bare results:

```ts
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
    // auto mode answers with one JSON body unless a related message preceded
    // the result; a delete without a progressToken sends none. Tolerate SSE
    // anyway by taking the last `data:` line.
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
      assert.strictEqual(second.result?.['resultType'], 'input_required', 're-issued once');
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
      assert.strictEqual(third.result?.['isError'], true);
      // The refusal wording lives in the per-path failure (structured half,
      // under `_meta` or `structuredContent`) and may or may not be echoed in
      // the text block; match the whole result.
      assert.match(JSON.stringify(third.result), /wrapped result/);
      await access(join(dir, 'f.txt')); // nothing was deleted
    } finally {
      await handler.close();
      await cleanupTestRoot(root);
    }
  });
});
```

Imports to add: `access` from `'node:fs/promises'`, `join` from
`'node:path'`. If the first response is a JSON-RPC **error** naming the
envelope, print it and compare the `_meta` keys with `MODERN_META` in
`__tests__/stdio.test.ts:27-31` — do not change the server. If the error
names a header (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`), the
three headers in `post` are the SDK's standard-header rung
(`node_modules/@modelcontextprotocol/server/dist/src-*.mjs`,
`validateStandardRequestHeaders`) — check spelling and that `mcp-name`
equals `params.name`. If it is a `-32021` capability error, the
`clientCapabilities` in `META` lost its `elicitation.form`.

**Verify**: `npm test -- __tests__/input-required.test.ts` → all pass (5 new
in total). Then `npm run check` → exit 0, `fail 0`, ≥ 538 pass.

## Test plan

- Unit: re-issue once (7), flag sealed and honoured (7), unrelated dropped
  key ignored (7b), R9 precedes re-issue (7c), refusal wording (describeRefusal).
- E2E: raw 2026-07-28 `tools/call` with a wrapped `inputResponses` entry —
  second `input_required` with a different `requestState`, third round is a
  tool error naming the wrapped shape, file untouched.
- Pattern: `input-required.test.ts` tests 3–6 and `SDK-AUDIT-MODES-002`.

## Done criteria

Search commands are given for PowerShell (the repo's declared shell has no
`grep`); on POSIX substitute `grep -n`.

- [ ] `npm run check` exits 0; ≥ 538 pass, 0 fail
- [ ] `Select-String -Path src\core\input-required.ts,src\tools\define.ts,src\tools\create.ts,src\tools\delete.ts,src\tools\move.ts -Pattern "droppedInputResponseKeys" | Group-Object Path` → every one of the five files has ≥ 1 hit
- [ ] `Select-String -Path src\core\input-required.ts -Pattern "reissued"` shows the interface field, the mint and the guard
- [ ] Existing `input-required.test.ts` tests 1–6 and `SDK-AUDIT-MODES-*` unchanged and green
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `ctx.mcpReq.droppedInputResponseKeys` is not in the installed SDK's
  `BaseContext` typing (`Select-String -Path node_modules\@modelcontextprotocol\server\dist\*.d.mts -Pattern droppedInputResponseKeys`
  returns nothing) — the SDK was bumped past what this plan was written for.
- In step 5 the second POST is answered with `-32602 Invalid or expired requestState`
  — the codec `bind` rejected the echo; check that all three POSTs use the
  same `method` and no `http.authInfo` (they should under `createMcpHandler`
  without `authInfo`), and report if that holds.
- The SDK rejects the wrapped entry with a parse error instead of dropping
  it (step 5's second POST returns `error`, not `result`) — the runtime
  partition contract described in "Current state" has changed.
- Any existing R9 test (5, 5b) fails after step 2.

## Maintenance notes

- `reissued` is part of the sealed `PendingState`; the codec's payload is
  opaque to clients, so adding a field is not a wire-shape change for them,
  but any future field must likewise be added to the mint in
  `buildInputRequired` or it silently drops.
- Reviewer focus: the guard runs **after** the R9 `pathsEqual` check and
  **only** when a dropped key names one of this round's inputs — both are
  what keep the re-issue from becoming a bypass or a loop.
- Deferred: `readAccepted*` still treat a dropped key as "no answer" for the
  per-item `skip`/`overwrite` choice; after the single re-issue that is the
  correct fail-closed outcome, and `describeRefusal` now says why.
