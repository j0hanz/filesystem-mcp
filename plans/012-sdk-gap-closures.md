# Plan 012: Close the four small SDK gaps the 2026-09-26 audit found

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8d9bd0c2..HEAD -- src/transport/http.ts src/server.ts src/resources.ts src/transport/http-policy.ts src/core/errors.ts __tests__/http-transport.test.ts __tests__/resources.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `8d9bd0c2`, 2026-09-26

## Why this matters

A full cross-audit of this codebase against the installed
`@modelcontextprotocol/server@2.1.0` (`node@2.1.0`, `express@2.0.1`) found the
server is already on the SDK surface almost everywhere. Exactly four small
gaps remain where the SDK offers something the custom code hand-rolls or
skips: a silent failure path in the Node adapter (it answers 500 with no log
at all), a notification burst that the SDK can coalesce for free, a wire
channel (`JSON-RPC error.data`) the server never populates with structured
failure detail, and a misnamed-but-identical SDK helper used for origin
defaults. Each is one call site or one small block; together they remove the
last "SDK covers this" findings from the audit.

All four SDK claims were verified against the installed type declarations
(`node_modules/@modelcontextprotocol/*/dist/*.d.mts`) — not against the docs
site, which runs ahead of 2.1.0.

## Current state

The files this plan touches, each with its role:

- `src/transport/http.ts` — assembles the express app and the modern HTTP
  handler. Line 322 wraps the web-standard handler for Node **without
  options**:

  ```ts
  // src/transport/http.ts:317-322
    onerror: (error: Error) => {
      Logger.error('[HTTP] modern leg error:', formatUnknownErrorMessage(error));
    },
  });
  const modernNodeHandler = toNodeHandler(modernHandler);
  ```

  (Abridged for reading; the live lines `},` and `);` at :320-321 close the
  options object and the `createMcpHandler` call.)

  The `onerror` above belongs to `createMcpHandler` and observes
  entry-internal failures only. When the **Node adapter** itself answers 500
  (request conversion or `handler.fetch` throws — e.g. a closed handler), the
  installed SDK logs nothing and the 500 goes out unobserved. The SDK exposes
  the fix (verified `node_modules/@modelcontextprotocol/node/dist/index.d.mts:228-260`):

  ```ts
  interface ToNodeHandlerOptions {
    /**
     * Called when the adapter answers `500` because request conversion or
     * `handler.fetch` itself threw (e.g. a closed handler). ...
     */
    onerror?: (error: Error) => void;
    ...
  }
  declare function toNodeHandler(handler: FetchLikeMcpHandler, opts?: ToNodeHandlerOptions): NodeMcpRequestHandler;
  ```

- `src/server.ts` — builds one `McpServer` per instance. The constructor
  config has no notification-debounce entry (verified
  `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-Bt6U_Fqb.d.mts:2013-2018`
  — the option exists in `ProtocolOptions`):

  ```ts
  // src/server.ts:92-117 (abridged)
  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
    capabilities,
    enforceStrictCapabilities: true,
    cacheHints: { ... },
    requestState: { verify: requestStateCodec.verify },
  };
  ```

  Why it matters here: `ResourceStore.putText` fires its `onListChanged`
  callback on **every** externalization and on every expiry prune it performs
  (`src/core/store.ts:121,131,143`), and each fire sends one
  `notifications/resources/list_changed` that makes clients refetch
  `resources/list`. Two or more in-flight `tools/call` requests on one
  connection can fire these in the same event-loop tick. The SDK coalesces
  same-tick duplicates when the method is listed in
  `debouncedNotificationMethods`.

- `src/resources.ts` — `wrapRead` wraps every resource read callback.
  A `resources/read` failure that is an `FsError` but not not-found-ish
  (e.g. `NOT_FILE`, `TOO_LARGE`) flattens the problem to a plain message —
  the structured `Problem` fields never reach the client:

  ```ts
  // src/resources.ts:391-413 (abridged; the final branch verbatim)
  if (error instanceof ProtocolError) throw error;
  if (isNotFoundish(error)) {
    throw new ResourceNotFoundError(uri.toString(), error.message);
  }
  // A remaining FsError (NOT_FILE, TOO_LARGE, ...) traces to the
  // caller-supplied URI; anything else is a server-side failure and must
  // not be blamed on the request.
  const msg = isFsError(error) ? error.message : formatUnknownErrorMessage(error);
  throw new ProtocolError(fsErrorCode(error), msg);
  ```

  The SDK `ProtocolError` round-trips a structured channel on the wire
  (verified `createMcpHandler-Bt6U_Fqb.d.mts:1587-1606`):

  ```ts
  declare class ProtocolError extends Error {
    readonly code: number;
    readonly data?: unknown | undefined;
    ...
    constructor(code: number, message: string, data?: unknown | undefined);
  }
  ```

  Safety constraint from the same d.mts (lines 1607-1617): the SDK's
  `ResourceNotFoundError` convention is "`error.data` is exactly
  `{ uri: string }` and nothing else" — clients treat any other `-32602`
  as an ordinary Invalid Params. This plan's payload uses different keys
  (`code`, `path`, `suggestion`), so it cannot collide with that convention.

  `Problem` fields available for the payload (`src/core/errors.ts:21-26`):
  `{ code, message, path?, suggestion? }` — `message` stays the wire
  message, so `data` carries `code` plus the optional `path`/`suggestion`.

- `src/core/errors.ts` — owns `Problem`/`FsError` and the `fsErrorCode`
  helper. `fsErrorCode` (lines 170-173: doc comment, signature, body,
  closing brace) maps any error to a protocol code
  (`InvalidParams` for `FsError`, `InternalError` otherwise) and is
  `ProtocolErrorCode`'s only use in this file (import at line 1). Step 3
  inlines its two outcomes in `src/resources.ts` — its only caller — and
  deletes the helper, so knip's unused-export check stays green.
- `src/transport/http-policy.ts` — HTTP policy. Two call sites use the
  **hostnames** helper as an _origins_ default; the SDK exports a
  name-accurate mirror with a byte-identical return value (verified
  `node_modules/@modelcontextprotocol/server/dist/index.mjs:1531-1536` vs
  `1609-1614`: both return `["localhost", "127.0.0.1", "[::1]"]`):

  ```ts
  // src/transport/http-policy.ts:2
  import { localhostAllowedHostnames, validateOriginHeader } from '@modelcontextprotocol/server';

  // src/transport/http-policy.ts:84 (isOriginAllowed — CORS reflection default)
  const allowed = allowedHostnames.length > 0 ? [...allowedHostnames] : localhostAllowedHostnames();

  // src/transport/http-policy.ts:149 (Host-header validation — hostname
  // semantics, DO NOT change this one)
  if (isLoopbackHttpHost(httpHost)) return localhostAllowedHostnames();

  // src/transport/http-policy.ts:317 (computeAllowedOriginHostnames —
  // origins default)
  return originsEnv ? splitCsvList(originsEnv) : localhostAllowedHostnames();
  ```

Repo conventions that apply:

- Comment style: load-bearing comments explain _why_, cite spec sections and
  SDK contracts inline. Match the density of the excerpts above.
- Error handling follows `Problem`/`FsError` in `src/core/errors.ts` — see
  `src/tools/define.ts:289-298` (`failProgress`) for the existing
  text-flattening consumer.
- Tests: `node:test` + `node:assert/strict`, helpers in
  `__tests__/helpers.ts` (`createTestRoot`, `cleanupTestRoot`,
  `createTestClientPair`, `waitFor`). Wire-level resource tests live in the
  `describe` block starting at `__tests__/resources.test.ts:499` (`harness`
  declared at :501, `harness = await createTestClientPair([clientTmpDir])`
  at :505). Adapter
  tests live in `__tests__/http-transport.test.ts` (`HTTP-001`..`HTTP-005`).
- Prettier checks `plans/` too — run `npx prettier --write plans/` after any
  plan edit.

## Commands you will need

| Purpose      | Command                                       | Expected on success |
| ------------ | --------------------------------------------- | ------------------- |
| Static check | `npm run check:static`                        | exit 0              |
| All tests    | `npm test`                                    | all pass            |
| One suite    | `npm test -- --test-name-pattern="resources"` | suite passes        |
| Format plans | `npx prettier --write plans/`                 | exit 0              |

`npm run check:static` = build + `tsc -p tsconfig.test.json` + eslint
(`--max-warnings=0`) + `prettier --check .` + knip.

## Scope

**In scope** (the only files you should modify):

- `src/transport/http.ts`
- `src/server.ts`
- `src/resources.ts`
- `src/core/errors.ts` (delete `fsErrorCode` only — Step 3)
- `src/transport/http-policy.ts`
- `__tests__/http-transport.test.ts` (new test)
- `__tests__/resources.test.ts` (two new tests)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/transport/shared.ts` (`jsonRpcError`) — the audit's larger
  "thread `data` through pre-ack refusals" idea was cut; keep this plan to
  `resources/read`.
- `src/core/store.ts` — a store-level debounce would be the cross-tick fix;
  deliberately deferred (see Maintenance notes).
- `src/transport/http-policy.ts:149` — that is Host-header validation;
  hostname form is semantically correct there.
- `src/core/errors.ts` beyond Step 3's one deletion — the `Problem`/`FsError`
  shapes and every other export stay as they are.
- The `resources/subscribe` handler in `src/resources.ts` — its errors
  already carry `data.uri` via `ResourceNotFoundError` or stay text-only by
  design.
- Any SDK dependency version — pins are deliberate.

## Git workflow

- Branch: `advisor/012-sdk-gap-closures` from `main`.
- Commit per step, conventional-commit style matching the log, e.g.
  `feat(http): observe node-adapter 500s via toNodeHandler onerror`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pass `onerror` to `toNodeHandler`; unit-test the 500 fallback

In `src/transport/http.ts:322`, replace:

```ts
const modernNodeHandler = toNodeHandler(modernHandler);
```

with:

```ts
const modernNodeHandler = toNodeHandler(modernHandler, {
  // The adapter answers 500 when request conversion or handler.fetch
  // itself throws (e.g. a request racing handler.close()); the entry's
  // own onerror above never sees those. Log the adapter-level refusal so
  // the 500 is not silent.
  onerror: (error: Error) => {
    Logger.error('[HTTP] node adapter error:', formatUnknownErrorMessage(error));
  },
});
```

`Logger` and `formatUnknownErrorMessage` are already imported in this file.

Add one test to `__tests__/http-transport.test.ts` (new
`describe('Node adapter (toNodeHandler)')` block, after the existing
describes; model structure after `HTTP-001`, same imports style). The test:

1. Builds a stub handler whose `fetch` throws:
   `{ fetch: async () => { throw new Error('adapter boom'); }, close: async () => {} }`
   cast `as unknown as FetchLikeMcpHandler`.
2. Wraps it: `const handler = toNodeHandler(stub, { onerror: (e) => { seen.push(e); } });`.
3. Invokes `handler(req, res, parsedBody)` where `req`/`res` are minimal mock
   objects satisfying the exported `NodeIncomingMessageLike` /
   `NodeServerResponseLike` interfaces and `parsedBody` is `{}` (a parsed
   body skips the adapter's stream buffering, so the req mock needs no
   readable body). Build the mocks from the interfaces' declared members —
   the type-checker is the source of truth; if a member the adapter actually
   reads is missing from the interface declaration, that is a STOP
   condition, not a license for wide casts.
4. Asserts: `seen.length === 1` with message `'adapter boom'`, and the res
   mock recorded a 500 status (assert against whatever the mock captured).

Both `toNodeHandler` and `FetchLikeMcpHandler` come from
`@modelcontextprotocol/node` — the test file imports nothing from that
package today, so add
`import { toNodeHandler } from '@modelcontextprotocol/node';` and
`import type { FetchLikeMcpHandler } from '@modelcontextprotocol/node';`
(follow the file's existing import order and the prettier sort-imports
plugin).

**Verify**:
`npm test -- --test-name-pattern="toNodeHandler"` → the new test passes;
`npm run check:static` → exit 0.

### Step 2: Coalesce same-tick `resources/list_changed` via `debouncedNotificationMethods`

In `src/server.ts`, add one entry to `serverConfig` (after `requestState`,
keeping the object's existing key order):

```ts
    // The ResourceStore fires list-changed on every externalization and on
    // every expiry prune (store.ts), so parallel tools/call on one
    // connection can send the same notification several times in one tick;
    // each copy makes the client refetch an unchanged list. The SDK
    // coalesces same-tick duplicates for methods listed here.
    // ponytail: same-tick coalescing only — cross-tick bursts (batch
    // externalizations separated by fs awaits) still fan out; a store-level
    // debounce is the fix if clients ever report that. The modern HTTP leg
    // publishes through the ServerEventBus, which this option does not
    // touch, so it protects the stdio/in-memory leg.
    debouncedNotificationMethods: ['notifications/resources/list_changed'],
```

Add one test to the wire-level `describe` in `__tests__/resources.test.ts`
(starting at :501; follow the `client.readResource()` tests for style):

```ts
it('two same-tick list_changed sends coalesce into one client notification', async () => {
  const seen: unknown[] = [];
  harness.client.setNotificationHandler('notifications/resources/list_changed', (n) => {
    seen.push(n);
  });
  void harness.serverCtx.mcp.server.sendResourceListChanged();
  void harness.serverCtx.mcp.server.sendResourceListChanged();
  await waitFor(() => seen.length >= 1);
  // Room for a straggler: if the second send was not coalesced it
  // lands in this window and fails the strict assert below.
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(seen.length, 1);
});
```

`waitFor` is already imported in this file. The two `sendResourceListChanged`
calls must stay in the same tick (no `await` between them).

**Verify**:
`npm test -- --test-name-pattern="resources"` → suite passes including the
new test; then **full** `npm test` → all pass (the debounce could in
principle affect any test that counts `list_changed` notifications — the
full run is the regression gate for this step).

### Step 3: Carry `Problem` identity fields in `ProtocolError` `data`

In `src/resources.ts` `wrapRead` (excerpt above), replace the final two
lines of the catch with:

```ts
// A remaining FsError (NOT_FILE, TOO_LARGE, ...) traces to the
// caller-supplied URI; anything else is a server-side failure and must
// not be blamed on the request. The Problem's identity fields ride the
// SDK's error.data channel: `message` stays the wire message, and
// code/path/suggestion give clients a machine-readable view. Keyed by
// `code`, so it cannot collide with the ResourceNotFoundError
// convention (data: { uri } and nothing else).
if (isFsError(error)) {
  const { code, path, suggestion } = error.problem;
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message, {
    code,
    ...(path !== undefined ? { path } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
  });
}
throw new ProtocolError(ProtocolErrorCode.InternalError, formatUnknownErrorMessage(error));
```

This inlines the two `fsErrorCode` outcomes (`InvalidParams` for `FsError`,
`InternalError` otherwise), which deletes its only call site. Finish the
step:

1. Remove `fsErrorCode` from the `./core/errors.ts` import at the top of
   `src/resources.ts` (line 23). `ProtocolErrorCode`, `ProtocolError`,
   `isFsError`, `formatUnknownErrorMessage` stay imported.
2. Delete the `fsErrorCode` function from `src/core/errors.ts:170-173`
   (doc comment, signature, body, closing brace). It is now an orphaned
   export and `npm run check:static` ends with knip's unused-export check,
   which fails on it. Deleting it also orphans
   `src/core/errors.ts:1`'s `import { ProtocolErrorCode } from
'@modelcontextprotocol/server';` — `fsErrorCode` is that symbol's only
   use in the file (grep to confirm before deleting) — remove that import
   line too.

Add one test to the same wire-level `describe` in
`__tests__/resources.test.ts`, next to the missing-file test at :587
(it is the structural model):

```ts
it('client.readResource() on a not-file URI rejects with structured error.data', async () => {
  const uri = buildFileResourceUri(clientTmpDir); // a directory, not a file
  await assert.rejects(harness.client.readResource({ uri }), (err: unknown) => {
    assert.ok(ProtocolError.isInstance(err), 'expected ProtocolError');
    assert.strictEqual(err.code, ProtocolErrorCode.InvalidParams);
    const data = (err as { data?: unknown }).data as Record<string, unknown>;
    assert.strictEqual(data.code, ErrorCode.NOT_FILE);
    assert.ok(typeof data.path === 'string');
    assert.strictEqual(data.suggestion, 'Target is a directory, not a file.');
    return true;
  });
});
```

`ErrorCode` is already imported in this test file
(`__tests__/resources.test.ts:16`). If the
client-side `ProtocolError` reconstruction does not surface `data`, the
assertion will fail — treat that as a STOP condition and report (do not
weaken the test to pass).

**Verify**:
`npm test -- --test-name-pattern="resources"` → both new resources tests
pass; `npm run check:static` → exit 0.

### Step 4: Use `localhostAllowedOrigins()` for the two origin defaults

In `src/transport/http-policy.ts`:

1. Line 2 import — add the mirror so both are available (prettier's member
   order is alphabetical):
   `import { localhostAllowedHostnames, localhostAllowedOrigins, validateOriginHeader } from '@modelcontextprotocol/server';`
2. Line 84 (`isOriginAllowed`): swap the default to
   `localhostAllowedOrigins()`.
3. Line 317 (`computeAllowedOriginHostnames`): swap the default to
   `localhostAllowedOrigins()`.
4. Leave line 149 (`resolveAllowedHosts`) on `localhostAllowedHostnames()` —
   that is Host-header validation; hostname form is correct there.

No behavior change anywhere: the two functions return identical lists
(verified against `index.mjs`, cited in Current state). The existing
`__tests__/http-policy.test.ts` suite is the regression gate — it must pass
unchanged.

**Verify**:
`npm test -- --test-name-pattern="http-policy"` → passes unchanged;
`npm run check:static` → exit 0.

## Test plan

Three new tests, no modified ones:

- `__tests__/http-transport.test.ts` — `toNodeHandler` unit test: stub
  `fetch` throws → adapter 500 + `onerror` observes the error (covers
  Step 1's wiring at the adapter level; the production call site is
  compile-time checked).
- `__tests__/resources.test.ts` — list_changed coalescing test (Step 2):
  two same-tick `sendResourceListChanged` → exactly one client notification.
- `__tests__/resources.test.ts` — structured `error.data` test (Step 3):
  directory-as-file read → `ProtocolError` with
  `{ code: 'NOT_FILE', path, suggestion }` in `data`.

Structural patterns: model after `__tests__/http-transport.test.ts` HTTP-001
and `__tests__/resources.test.ts:587-595` respectively.

Verification: `npm test` → all pass, including the 3 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run check:static` exits 0
- [ ] `npm test` exits 0; the 3 new tests exist and pass
- [ ] `grep -rn "fsErrorCode" src/` returns no matches (function deleted,
      call inlined)
- [ ] `grep -n "localhostAllowedHostnames()" src/transport/http-policy.ts`
      returns exactly one match (the `resolveAllowedHosts` line — the
      paren-less name still appears once in the line-2 import, which the
      call syntax excludes)
- [ ] `grep -n "toNodeHandler(modernHandler" src/transport/http.ts` shows
      the second-argument options object
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `npx prettier --write plans/` was run and `npm run check:static`
      (which prettier-checks `plans/`) still exits 0
- [ ] `plans/README.md` status row for 012 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows any in-scope file changed since `8d9bd0c2` and the
  excerpts no longer match the live code.
- The Step 2 coalescing test still sees 2 notifications with the option set —
  the installed SDK's "coalesce" may mean something narrower than this plan
  assumes; report the observed behavior instead of adding waits.
- The Step 3 test's client-side error carries no `data` — the SDK's
  client-side reconstruction may not round-trip it; report instead of
  weakening the assertion.
- The Step 1 req/res mocks cannot be made to compile against the exported
  `NodeIncomingMessageLike` / `NodeServerResponseLike` interfaces with at
  most one narrow cast — a wide cast suggests the adapter reads surface the
  types do not promise; report instead.
- Any step appears to require touching an out-of-scope file.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For whoever owns this code after it lands:

- **Reviewer focus**: the Step 3 payload keys (`code`/`path`/`suggestion`)
  must never become `{ uri }` — that shape is the SDK's `ResourceNotFoundError`
  wire convention, and mixing them breaks client-side discrimination.
- The store-level cross-tick debounce (out of scope here, ponytail-marked in
  Step 2's comment) is the follow-up if clients ever report list-refetch
  storms from batch externalizations.
- The full audit's rejected findings are recorded in `plans/README.md`
  ("Findings considered and rejected") so the next SDK bump re-checks only
  the two doc-only symbols (`parseListenFilter`/`createListenRouter`,
  `createServerNotifier`), not the whole surface.
- On the next `@modelcontextprotocol/*` version bump: re-run the audit
  digest in the session memory `sdk-2.1.0-audit-2026-09-26.md`; the
  listenRouter module exports, if released, would replace
  `listenSubscriptionUris` in `src/transport/shared.ts:58-66`.
