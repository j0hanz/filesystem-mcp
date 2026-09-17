# Plan 003: Bind confirmation `requestState` to the request method and caller

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 2d3b112f..HEAD -- src/core/input-required.ts src/tools/define.ts src/tools/create.ts src/tools/delete.ts src/tools/move.ts __tests__/input-required.test.ts CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `2d3b112f`, 2026-09-17

## Why this matters

Destructive tools (`delete` of a non-empty directory, `move`/`copy`/`create`
onto an existing file, an out-of-root access grant) ask the user to confirm
through the MCP `input_required` multi-round-trip flow. The server returns an
opaque `requestState` token; the client echoes it on the retry. That token is
HMAC-sealed by the SDK's `createRequestStateCodec`, and its payload binds the
operation kind and the sorted target paths (the R9 check in
`pendingRoundTrip`). It does not bind _who_ minted it or _which request_ it
was minted for: any bearer of a valid token can echo it into any retry whose
op and paths match. The codec has a `bind` option for exactly this — the SDK
documentation recommends binding to the request method and the authenticated
principal (https://ts.sdk.modelcontextprotocol.io/v2/servers/input-required.md,
"Protect requestState with the codec"). After this plan a token minted for one
caller or method is refused, with the SDK's frozen `-32602 Invalid or expired
requestState`, when echoed by another. With today's single static API key
the caller id is constant (`'api-key'`), so the immediate gain is method
binding; the principal binding pays off the day the HTTP endpoint serves more
than one credential (see `docs/plan/2026-09-15-oauth-resource-server/design.md`).

## Current state

Files and roles:

- `src/core/input-required.ts` — the shared `input_required` infrastructure:
  the lazily built codec (lines 86-107), `buildInputRequired` (173-189),
  `pendingRoundTrip` and its options (205-282).
- `src/tools/define.ts` — `ToolCtx` (the per-call context every tool handler
  receives, lines 46-87), `toToolCtx` (builds it from the SDK's
  `ServerContext`, lines 149-193), and the access-grant pre-check that calls
  `pendingRoundTrip` (line 334).
- `src/tools/create.ts:148`, `src/tools/delete.ts:335`,
  `src/tools/move.ts:313` — the three tool call sites of `pendingRoundTrip`.
- `src/server.ts:116` — installs `requestStateCodec.verify` as
  `ServerOptions.requestState.verify`; the SDK runs it with the live handler
  context before every retried round. **Unchanged by this plan.**
- `__tests__/input-required.test.ts` — unit tests for the module; uses a
  `NO_BIND_CONTEXT` placeholder because no bind callback exists yet.

`src/core/input-required.ts:19-25` today (imports):

```ts
import type {
  ClientCapabilities,
  InputRequest,
  InputRequiredResult,
  RequestStateCodec,
} from '@modelcontextprotocol/server';
```

`src/core/input-required.ts:89-107` today:

```ts
let codec: RequestStateCodec<PendingState> | undefined;

function getRequestStateCodec(): RequestStateCodec<PendingState> {
  codec ??= createRequestStateCodec<PendingState>({
    key: configuredRequestStateKey() ?? randomBytes(32),
  });
  return codec;
}

/**
 * The codec: `mint` seals a `PendingState` into the opaque wire string a
 * handler returns from `inputRequired({ requestState })`; `verify` drops into
 * `ServerOptions.requestState.verify` and throws on tamper, expiry, or bind
 * mismatch (the seam answers with the frozen `-32602`).
 */
export const requestStateCodec: RequestStateCodec<PendingState> = {
  mint: (payload, ctx) => getRequestStateCodec().mint(payload, ctx),
  verify: (state, ctx) => getRequestStateCodec().verify(state, ctx),
};
```

`src/core/input-required.ts:173-189` today:

```ts
export async function buildInputRequired(
  pending: PendingState,
  inputs: readonly PendingInput[],
): Promise<InputRequiredResult> {
  const inputRequests: Record<string, InputRequest> = {};
  for (const input of inputs) {
    inputRequests[input.key] = inputRequired.elicit({
      message: input.message,
      requestedSchema: requestedSchemaFor(input),
    });
  }
  const requestState = await requestStateCodec.mint({
    op: pending.op,
    paths: [...pending.paths].sort(),
  });
  return inputRequired({ inputRequests, requestState });
}
```

`src/core/input-required.ts:205-216` today:

```ts
interface PendingRoundTripOpts {
  readonly op: PendingOp;
  readonly pending: readonly string[];
  readonly requestState: (() => PendingState | undefined) | undefined;
  /**
   * What the client declared it can do, or `undefined` when this connection
   * cannot say. Only a positively-absent `elicitation` short-circuits; see
   * {@link assertCanElicit}.
   */
  readonly clientCapabilities?: ClientCapabilities | undefined;
  readonly buildInputs: (pending: readonly string[]) => readonly PendingInput[];
}
```

`src/core/input-required.ts:270-273` today (inside `pendingRoundTrip`):

```ts
if (state?.op !== opts.op) {
  assertCanElicit(opts.op, opts.clientCapabilities);
  return buildInputRequired({ op: opts.op, paths: opts.pending }, opts.buildInputs(opts.pending));
}
```

`src/tools/define.ts:80-87` today (end of `ToolCtx`):

```ts
   * Two sources, because the eras differ: a legacy connection negotiated them
   * at `initialize` (`Server.getClientCapabilities()`), a modern one carries
   * them per request in the `_meta` envelope and never runs `initialize` at
   * all. `undefined` means "cannot tell" — never "no capabilities".
   */
  readonly clientCapabilities?: ClientCapabilities | undefined;
}
```

`src/tools/define.ts:178-192` today (the object `toToolCtx` returns; `ctx`
is the SDK `ServerContext` parameter):

```ts
return {
  signal: ctx.mcpReq.signal,
  ...(ctx.mcpReq._meta ? { _meta: ctx.mcpReq._meta } : {}),
  requestId: ctx.mcpReq.id,
  ...(typeof ctx.mcpReq._meta?.[TRACEPARENT_META_KEY] === 'string'
    ? { traceparent: ctx.mcpReq._meta[TRACEPARENT_META_KEY] }
    : {}),
  fs: new GuardedFileSystem(deps.pathGuard),
  pageStore: deps.pageStore,
  resourceStore: deps.resourceStore,
  sendNotification: async (notification) => ctx.mcpReq.notify(notification),
  inputResponses: ctx.mcpReq.inputResponses,
  requestState: ctx.mcpReq.requestState,
  ...(clientCapabilities ? { clientCapabilities } : {}),
};
```

The four `pendingRoundTrip` call sites all have this shape (this one is
`src/tools/delete.ts:335-348`; `create.ts:148`, `move.ts:313` are the same
with `ctx`, `define.ts:334` uses `this.toolCtx`):

```ts
    const round = await pendingRoundTrip({
      op: 'delete',
      pending: pendingSorted,
      requestState: ctx.requestState,
      clientCapabilities: ctx.clientCapabilities,
      buildInputs: (ps) =>
```

`__tests__/input-required.test.ts:19-21` today:

```ts
// The installed codec type requires a ServerContext even when no bind callback
// is configured; its implementation does not read the context in that mode.
const NO_BIND_CONTEXT = undefined as never;
```

Every `mint(...)`, `verify(..., NO_BIND_CONTEXT)`, `buildInputRequired(...)`
and `pendingRoundTrip({...})` in that file (tests 1, 2, 2b, 2c, 3, 4, 5, 5b,
6, 7, 10, 16 and the `request-state key initialization` test at lines 34-55)
will need a context after this plan.

The SDK contract, from
`node_modules/@modelcontextprotocol/server/dist/index.d.mts` (installed
2.0.0):

```ts
interface RequestStateCodecOptions {
  key: Uint8Array | string;
  ttlSeconds?: number;
  /**
   * Optional context binding. Called at mint time and again at verify time;
   * a `requestState` minted under one binding value is rejected when echoed
   * under a different one. ... for example:
   *   bind: ctx => `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ''}`
   * ... When configured, RequestStateCodec.mint requires its `ctx` argument.
   */
  bind?: (ctx: ServerContext) => string;
}
interface RequestStateCodec<T = unknown> {
  mint(payload: T, ctx?: ServerContext): Promise<string>;
  verify(state: string, ctx: ServerContext): Promise<T>; // throws 'bind' on mismatch
}
```

`ServerContext` is exported as a type from `@modelcontextprotocol/server`.
`ctx.http` is present only on HTTP transports; on stdio it is `undefined`, so
the binding value there is `tools/call\0` on every round — consistent, which
is all the binding needs.

Conventions: `exactOptionalPropertyTypes` is on (see the `...(x ? {...} : {})`
spreads above — never assign `undefined` to an optional field). Imports are
sorted by `@trivago/prettier-plugin-sort-imports`; run `npm run fix` rather
than ordering by hand. Type-only imports use `import type`.

## Commands you will need

| Purpose       | Command                                                                               | Expected on success |
| ------------- | ------------------------------------------------------------------------------------- | ------------------- |
| Static checks | `npm run check:static`                                                                | exit 0              |
| Unit tests    | `npm test -- --test-name-pattern="input_required\|request-state"`                     | all pass            |
| Round-trips   | `npm test -- --test-name-pattern="TC-FUNC-009\|Delete guards\|PathGuard grant\|HTTP"` | all pass            |
| Full check    | `npm run check`                                                                       | exit 0              |
| Format        | `npm run fix`                                                                         | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/input-required.ts`
- `src/tools/define.ts`
- `src/tools/create.ts`
- `src/tools/delete.ts`
- `src/tools/move.ts`
- `__tests__/input-required.test.ts`
- `CHANGELOG.md` (one entry under `## [Unreleased]` → `### Changed`)

**Out of scope** (do NOT touch, even though they look related):

- `src/server.ts` — the `verify` hook is already installed; the SDK passes it
  the live context.
- `src/transport/http-policy.ts` — where `req.auth.clientId = 'api-key'` is
  set; changing the principal model is a separate design (the OAuth spike).
- `configuredRequestStateKey` / `FS_REQUEST_STATE_KEY` handling — key policy
  is unchanged.
- `ttlSeconds` — keep the SDK default (600 s).
- `__tests__/tools.test.ts` and `__tests__/helpers.ts` — the existing
  end-to-end confirmation tests must pass unchanged; they are the proof.

## Git workflow

- Branch: `fix/bind-request-state` from `main`.
- Commit per step or per logical unit. Subject style from `git log`:
  `fix(input-required): bind requestState to method and caller`,
  `test: ...`. Conventional prefix, lower case, no trailing period.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Configure the codec's `bind`

In `src/core/input-required.ts`:

1. Add `ServerContext` to the type-only import from
   `@modelcontextprotocol/server` (lines 19-25).
2. Above `getRequestStateCodec`, add and export the binding function so the
   tests can build a reference codec with the same binding:

```ts
/**
 * What a minted `requestState` is bound to: the JSON-RPC method of the
 * request that minted it and the authenticated caller (`ctx.http` is absent
 * on stdio, so the caller part is empty there and constant across rounds).
 * The SDK stores an HMAC tag of this value in the token and refuses an echo
 * whose context yields a different value.
 */
export function requestStateBinding(ctx: ServerContext): string {
  return `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ''}`;
}
```

3. Pass it to the codec:

```ts
codec ??= createRequestStateCodec<PendingState>({
  key: configuredRequestStateKey() ?? randomBytes(32),
  bind: requestStateBinding,
});
```

**Verify**: `npx tsc -p tsconfig.json --noEmit` → exit 0 (nothing calls
`mint` differently yet; the compile still passes).

### Step 2: Thread the context into `buildInputRequired` and `pendingRoundTrip`

Still in `src/core/input-required.ts`:

1. `buildInputRequired` takes a third, required parameter and passes it to
   `mint`:

```ts
export async function buildInputRequired(
  pending: PendingState,
  inputs: readonly PendingInput[],
  ctx: ServerContext,
): Promise<InputRequiredResult> {
  ...
  const requestState = await requestStateCodec.mint(
    { op: pending.op, paths: [...pending.paths].sort() },
    ctx,
  );
```

2. `PendingRoundTripOpts` gains a required field, documented:

```ts
  /** The live handler context; the codec binds the minted state to its method and caller. */
  readonly serverCtx: ServerContext;
```

3. The mint branch of `pendingRoundTrip` becomes:

```ts
return buildInputRequired(
  { op: opts.op, paths: opts.pending },
  opts.buildInputs(opts.pending),
  opts.serverCtx,
);
```

**Verify**: `npx tsc -p tsconfig.json --noEmit` → errors ONLY at the four
`pendingRoundTrip` call sites (missing `serverCtx`). Any other error is a
STOP condition.

### Step 3: Expose the `ServerContext` on `ToolCtx`

In `src/tools/define.ts`:

1. Add to the `ToolCtx` interface (after `clientCapabilities`):

```ts
  /** The SDK request context this call runs under; `pendingRoundTrip` binds minted state to it. */
  readonly serverCtx: ServerContext;
```

`ServerContext` is already imported (type import at the top of the file).

2. In the object `toToolCtx` returns, add `serverCtx: ctx,` after
   `requestState: ctx.mcpReq.requestState,`.

3. At `src/tools/define.ts:334-338`, add `serverCtx: this.toolCtx.serverCtx,`
   after the `clientCapabilities:` line.

**Verify**: `npx tsc -p tsconfig.json --noEmit` → errors only in
`create.ts`, `delete.ts`, `move.ts`.

### Step 4: Update the three tool call sites

In `src/tools/create.ts` (line 148 block), `src/tools/delete.ts` (line 335
block) and `src/tools/move.ts` (line 313 block), add
`serverCtx: ctx.serverCtx,` after the `clientCapabilities: ctx.clientCapabilities,`
line.

**Verify**: `npm run check:static` → exit 0.

### Step 5: Rewrite the unit tests for a bound codec

In `__tests__/input-required.test.ts`:

1. Import the type and the binding: add `import type { ServerContext } from
'@modelcontextprotocol/server';` and add `requestStateBinding` to the
   import from `../src/core/input-required.js`.
2. Replace the `NO_BIND_CONTEXT` block (lines 19-21) with a stub builder.
   The binding reads only `mcpReq.method` and `http.authInfo.clientId`, so a
   cast stub is sufficient:

```ts
/** The two fields `requestStateBinding` reads; everything else is unused. */
function bindContext(method = 'tools/call', clientId?: string): ServerContext {
  return {
    mcpReq: { method },
    ...(clientId === undefined ? {} : { http: { authInfo: { clientId } } }),
  } as unknown as ServerContext;
}
```

3. In the `request-state key initialization` test: mint with
   `requestStateCodec.mint({...}, bindContext())`; build the reference codec
   with `{ key: stateKey, bind: requestStateBinding }`; verify with
   `bindContext()`.
4. Tests 1, 2, 4, 5, 5b, 6: every `requestStateCodec.mint(payload)` becomes
   `requestStateCodec.mint(payload, bindContext())`; every
   `verify(x, NO_BIND_CONTEXT)` becomes `verify(x, bindContext())`.
5. Tests 2b and 2c keep their own bind-less codec; replace `NO_BIND_CONTEXT`
   with `bindContext()` (a bind-less codec ignores the context).
6. Tests 3, 4, 5, 5b, 6: add `serverCtx: bindContext(),` to each
   `pendingRoundTrip({...})` call.
7. Tests 7, 10, 16: add `bindContext()` as the third `buildInputRequired`
   argument.
8. Add two tests after 2c:

```ts
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
```

**Verify**: `npm test -- --test-name-pattern="input_required|request-state"`
→ all pass, including `2d` and `2e`; `grep -n NO_BIND_CONTEXT
__tests__/input-required.test.ts` → no output.

### Step 6: Prove the live round-trips still complete

The end-to-end confirmation tests drive real `input_required` rounds through
the SDK on the modern era (`createElicitationClientPair` in
`__tests__/helpers.ts:165`) and through the legacy shim
(`createTestClientPair`). They pass only if the binding value is identical on
the minting round and the retry.

**Verify**:
`npm test -- --test-name-pattern="TC-FUNC-009|Delete guards|PathGuard grant|HTTP"`
→ all pass. A failure whose message contains `Invalid or expired requestState`
is a STOP condition (see below).

### Step 7: Changelog and format

Add under `## [Unreleased]` → `### Changed` in `CHANGELOG.md`, matching the
bold-lead style of the entries there:

```markdown
- **Confirmation tokens are bound to their request and caller.** The
  `requestState` a `delete`, `move`, `copy`, `create` or access-grant
  confirmation carries is now HMAC-bound to the JSON-RPC method that minted
  it and to the authenticated caller (`clientId` on the HTTP leg; empty on
  stdio), on top of the operation and path binding it already had. A token
  echoed under another method or by another caller is refused with the SDK's
  `-32602 Invalid or expired requestState`. A well-behaved client sees no
  change: it echoes the token on the same connection it received it on.
```

**Verify**: `npm run fix` → exit 0; `npm run check` → exit 0.

## Test plan

- New: `2d` (method mismatch rejected) and `2e` (caller mismatch rejected,
  same caller accepted, absent caller rejected) in
  `__tests__/input-required.test.ts`, modeled on tests `2`/`2b` in the same
  file.
- Updated: every existing test in that file passes a stub context.
- Regression proof: the unchanged end-to-end tests in `__tests__/tools.test.ts`
  (calls to `createElicitationClientPair` at lines 232-353 and 1301-1398),
  `__tests__/path-guard-grant.test.ts` and `__tests__/http-server.test.ts`
  (`3. Full MCP handshake + tool call over real HTTP with bearer`).
- Verification: `npm test` → all pass, 2 more tests than before.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "bind: requestStateBinding" src/core/input-required.ts` → one match
- [ ] `grep -n "serverCtx" src/tools/create.ts src/tools/delete.ts src/tools/move.ts src/tools/define.ts` → at least one match per file
- [ ] `grep -n NO_BIND_CONTEXT __tests__/input-required.test.ts` → no output
- [ ] Tests named `2d.` and `2e.` exist in `__tests__/input-required.test.ts` and pass
- [ ] `CHANGELOG.md` has the new `Changed` entry under `[Unreleased]`
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the live code.
- An end-to-end confirmation test fails with `Invalid or expired
requestState` after Step 4: the binding value differs between the minting
  round and the retry (for example `ctx.http.authInfo` present on one and
  absent on the other). Do NOT weaken the binding to make it pass; report
  which test and which transport.
- The reference codec in the `request-state key initialization` test rejects
  the token even with `bind: requestStateBinding` configured.
- Step 2's type-check reports errors anywhere other than the four
  `pendingRoundTrip` call sites.
- Any change appears to require editing `src/server.ts` or
  `src/transport/http-policy.ts`.

## Maintenance notes

- When the HTTP leg gains per-principal credentials (the OAuth resource-server
  design), `clientId` becomes distinct per caller and this binding is what
  keeps one caller's confirmation from being replayed by another. Keep
  `requestStateBinding` the single source of that rule.
- The binding value includes `\0`; the SDK stores an HMAC tag of it, never
  the raw string, so no principal identifier reaches the wire.
- Reviewer: check that every `pendingRoundTrip` caller passes the context
  that produced the tool call, not a cached one, and that the CHANGELOG entry
  states the refusal code.
- Deferred: binding the tool name. `ctx.mcpReq.method` is `tools/call` for
  every tool; the payload's `op` already distinguishes the flows.
