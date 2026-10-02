# Plan: `createServer` owns the per-request dispose hook and `prepareListenWatchers` owns the listen cap pre-check

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence. Do not commit: end at a
> green `npm run check` with uncommitted changes (commits need the user's
> go-ahead). Never hand-edit versions.
>
> **Written against** commit `fada7b47`, 2026-10-02.
> **Drift check (run first)**:
> `git diff --stat fada7b47..HEAD -- src/server.ts src/transport __tests__/helpers.ts __tests__/input-required.test.ts __tests__/stdio.test.ts __tests__/http-server.test.ts __tests__/resources-subscribe.test.ts docs/plan/2026-09-15-sdk-listen-hook/deletion-map.md`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

Two audit findings, one PR, branch `refactor/http-batch-dispose-listen-cap`
(create it from `main`: `git switch -c refactor/http-batch-dispose-listen-cap main`).

**Finding 4.** The per-request `onclose -> disposeRuntimeState()` hook lives in
[`http.ts`](../../../src/transport/http.ts#L330-L334) and is copy-pasted into two test factories
in [`input-required.test.ts`](../../../__tests__/input-required.test.ts#L98), while the other harness factories
([`helpers.ts`](../../../__tests__/helpers.ts#L224), [`helpers.ts`](../../../__tests__/helpers.ts#L299), [`cli.test.ts`](../../../__tests__/cli.test.ts#L125)) omit it and leak
leases. `createServer` should own it.

**Finding 5.** The listen-cap pre-check (reject before the ack) exists only in
[`http.ts`](../../../src/transport/http.ts#L204-L221); stdio hits the cap late, after creating and tearing down
watchers, with different wording. It moves to the top of
[`prepareListenWatchers`](../../../src/transport/shared.ts#L94) so both legs share it, with the HTTP wording.

Requirements covered: none, this is a refactor. Tickets:
[T-10](tickets/T-10-deliver-the-per-request-dispose-hook-in-createserver.md),
[T-09](tickets/T-09-deliver-the-listen-cap-pre-check-in-preparelistenwatchers.md),
batch ticket [T-19](tickets/T-19-merge-the-http-ts-batch-findings-4-and-5.md).

## Current state

Audit line numbers (from `72d448ea`) had drifted; everything below was
re-grepped at `fada7b47`.

### Finding 4

- [`server.ts:144`](../../../src/server.ts#L144) `const server = new McpServer(...)`;
  [`server.ts:191-202`](../../../src/server.ts#L191-L202) is the return:

  ```ts
  let cleanedUp = false;
  return {
    mcp: server,
    pathGuard,
    disposeRuntimeState() {
      if (cleanedUp) return;          // idempotent
      cleanedUp = true;
      if (ownsPages) pageStore.clear();
      resourceDisposable.dispose();
    },
  };
  ```

  `disposeRuntimeState` **is idempotent** (`cleanedUp` guard), so double
  disposal is harmless.
- `onclose` is owned by the low-level `Server` at `mcp.server` (SDK `Protocol`
  field; `Protocol._onclose()` calls `this.onclose?.()` when the transport
  closes — `node_modules/@modelcontextprotocol/server/dist/src-BHSMhZ_W.mjs:6401-6413`).
  It is **not** on `McpServer` itself and not on the transport. The SDK's
  `createMcpHandler` per-exchange wrapper itself chains the previous handler
  (`dist/index.mjs:1407-1414`: `previousOnClose = server.onclose; ... previousOnClose?.()`),
  so a handler installed inside `createServer` (before the factory returns) is
  still called. `close()` on a server with **no transport** never fires `onclose`.
- The copy to move, [`http.ts:321-335`](../../../src/transport/http.ts#L321-L335):

  ```ts
  const c = await createServer(options, { ... });
  const previousOnClose = c.mcp.server.onclose;
  c.mcp.server.onclose = () => {
    previousOnClose?.();
    c.disposeRuntimeState();
  };
  return c.mcp;
  ```

- The same 5-line copy at [`input-required.test.ts:98-102`](../../../__tests__/input-required.test.ts#L98-L102) and
  [`:577-581`](../../../__tests__/input-required.test.ts#L577-L581) (`context.mcp.server.onclose = ...`).
- [`resources.ts:302-308`](../../../src/resources.ts#L302-L308) (`destroy()`): "Release what this connection still
  holds before the registry goes: on the shared (modern) registry nothing else
  would ever end these leases." Confirms why the HTTP leg needs the hook; the
  comment stays accurate and needs no edit.

**Every caller of `createServer`** ([`server.ts:36`](../../../src/server.ts#L36)), re-grepped across `src/` and `__tests__/`:

| Caller | Connected? | Notes |
| --- | --- | --- |
| [`http.ts:321`](../../../src/transport/http.ts#L321) | yes (per-request, via `createMcpHandler`) | has the copy to delete |
| [`stdio.ts:134`](../../../src/transport/stdio.ts#L134) | yes, except the `closed` early-return at [`:145`](../../../src/transport/stdio.ts#L145) | see Step 5 |
| [`helpers.ts:154`](../../../__tests__/helpers.ts#L154) `createTestServer` | by its callers | callers listed below |
| [`helpers.ts:224`](../../../__tests__/helpers.ts#L224) `createElicitationClientPair` | yes (handler) | had no hook; gains it free |
| [`helpers.ts:299`](../../../__tests__/helpers.ts#L299) `createTestHttpHarness` | yes (handler) | had no hook; gains it free |
| [`cli.test.ts:125`](../../../__tests__/cli.test.ts#L125) | yes (handler) | had no hook; gains it free |
| [`input-required.test.ts:97`](../../../__tests__/input-required.test.ts#L97), [`:576`](../../../__tests__/input-required.test.ts#L576) | yes (handler) | copies to delete |
| [`capabilities.test.ts:65`](../../../__tests__/capabilities.test.ts#L65) | **no** | `ctx.mcp.getCapabilities()` only |
| [`resources.test.ts:743`](../../../__tests__/resources.test.ts#L743) | **no** | capabilities check only |
| [`tools.test.ts:1436`](../../../__tests__/tools.test.ts#L1436) | yes | connects at `:1448` |

**Every caller of `disposeRuntimeState`** (all verified connected/unconnected by
reading the file; the audit's classification **holds for all eight**):

| Site | Connected? | Action |
| --- | --- | --- |
| [`helpers.ts:180`](../../../__tests__/helpers.ts#L180) (`createTestClientPair.close`) | yes: `serverCtx.mcp.connect(serverTransport)` at `:173`, `client.close()` first | remove |
| [`progress.test.ts:154`](../../../__tests__/progress.test.ts#L154) | yes: `context.mcp.connect(serverTransport)` at `:146` | remove |
| [`roots-seeding.test.ts:42`](../../../__tests__/roots-seeding.test.ts#L42) | yes: `serverCtx.mcp.connect` at `:37` (in `before`) | remove |
| [`tools.test.ts:1467`](../../../__tests__/tools.test.ts#L1467) | yes: `serverCtx.mcp.connect` at `:1450` | remove |
| [`stdio.ts:145`](../../../src/transport/stdio.ts#L145) | no: returned unactivated, "nothing serves it" | **keep** |
| [`stdio.ts:212`](../../../src/transport/stdio.ts#L212) (`cleanupConnection`) | connected, but wraps `wire.onclose` with its own ordering and a documented throw guard | **keep** (not in the audit list; safe to double-dispose by idempotence) |
| [`capabilities.test.ts:74`](../../../__tests__/capabilities.test.ts#L74) | no | **keep** |
| [`core-fs.test.ts:39`](../../../__tests__/core-fs.test.ts#L39) | no: `createTestServer` at `:33`, no `connect` in the file | **keep** |
| [`resources.test.ts:747`](../../../__tests__/resources.test.ts#L747) | no | **keep** |

`onclose` is only assigned in `http.ts` and the two `input-required.test.ts`
copies (grep `onclose` in `src/` and `__tests__/`; `stdio.ts:253` wraps the
*transport's* `wire.onclose`, a different object).

### Finding 5

- [`http.ts:204-221`](../../../src/transport/http.ts#L204-L221), the inline block to remove (comment included):

  ```ts
  const newUris = requestedUris.filter((uri) => !sharedRegistry.hasWatcher(uri));
  const available = MAX_WATCHERS - sharedRegistry.size();
  if (newUris.length > available) {
    sendJsonRpcError(res, 400, ProtocolErrorCode.InvalidParams,
      `subscriptions/listen names ${newUris.length} not-yet-watched URIs but only ${available} watcher slots remain (cap ${MAX_WATCHERS}). Reduce the resourceSubscriptions list.`,
      jsonRpcRequestId(parsedBody));
    return;
  }
  ```

  It is followed by [`prepareListenWatchers(...)` at `:223`](../../../src/transport/http.ts#L223), whose `!prepared.ok`
  branch already sends `400 InvalidParams` with `prepared.message` and the
  request id, so the response shape is unchanged. `MAX_WATCHERS` is imported at
  [`http.ts:32`](../../../src/transport/http.ts#L32) and used **only** in this block (grep: lines 32, 211, 217).
- [`shared.ts:94-109`](../../../src/transport/shared.ts#L94-L109): `prepareListenWatchers(uris, pathGuard, registry, notify): Promise<ListenPreparation>`
  with `ListenPreparation = { ok: true; acquiredUris } | { ok: false; message }`
  ([`shared.ts:68-70`](../../../src/transport/shared.ts#L68-L70)). `MAX_WATCHERS` is already imported there ([`:10`](../../../src/transport/shared.ts#L10)), and
  `WATCHER_FAILURE_REASONS.capped` ([`:74`](../../../src/transport/shared.ts#L74)) stays: it still covers a cap hit by a
  concurrent acquire between the pre-check and the attach.
- [`stdio.ts:319`](../../../src/transport/stdio.ts#L319) calls it and already turns `!prepared.ok` into `jsonRpcError(InvalidParams, prepared.message, id)`
  ([`:320-323`](../../../src/transport/stdio.ts#L320-L323)). So stdio adopts the new wording with no edit to `stdio.ts`. Today stdio's
  message is `Cannot subscribe to <uri>: watcher limit N reached`.
- Both legs pass a de-duplicated URI list (`listenSubscriptionUris`, [`shared.ts:54-61`](../../../src/transport/shared.ts#L54-L61)), which the count relies on.
- `WatcherRegistry` exposes `hasWatcher(uri)` and `size()` ([`watcher-registry.ts:238-241`](../../../src/core/watcher-registry.ts#L238-L241)); `MAX_WATCHERS` comes from `FS_MAX_WATCHERS`
  ([`watcher-registry.ts:13`](../../../src/core/watcher-registry.ts#L13)).
- **Every caller of `prepareListenWatchers`**: [`http.ts:223`](../../../src/transport/http.ts#L223), [`stdio.ts:319`](../../../src/transport/stdio.ts#L319). Nothing in
  `__tests__/` calls it directly (`http-shared-guard.test.ts:75` only mentions it in a comment). **Audit premise false**:
  the audit says neither leg has an over-cap test. HTTP has one:
  [`http-server.test.ts:323-346`](../../../__tests__/http-server.test.ts#L323-L346) (`MAX_WATCHERS + 1` fake URIs, asserts 400, `InvalidParams`, message
  includes `watcher slots`). Only stdio lacks one.
- stdio tests spawn the real `src/index.ts` and can set `FS_MAX_WATCHERS=1`:
  [`stdio.test.ts:339-382`](../../../__tests__/stdio.test.ts#L339-L382) STDIO-007 and [`:384-431`](../../../__tests__/stdio.test.ts#L384-L431) STDIO-008 use `createRawStdioServer(tmpDir, { FS_MAX_WATCHERS: '1' })`,
  `discoverModern(harness)`, `harness.send(...)`, `harness.nextMessage()`, `MODERN_META`. Imitate
  STDIO-008 ([`stdio.test.ts:384`](../../../__tests__/stdio.test.ts#L384)).
- Deletion map row to update: [`deletion-map.md:14-15`](../../../docs/plan/2026-09-15-sdk-listen-hook/deletion-map.md#L14-L15) (the `shared.ts` and `http.ts` rows).

### Conventions

- Tests: Node test runner, `node:assert/strict`; no mocks of the code under test.
  Exemplar for a new stdio over-the-wire test: [`stdio.test.ts:384-431`](../../../__tests__/stdio.test.ts#L384-L431).
  Exemplar for a shared-registry + in-memory pair test: [`resources-subscribe.test.ts:17-60`](../../../__tests__/resources-subscribe.test.ts#L17-L60).
- Comments only where needed; Prettier formatting (`npx prettier --write <files>`).

## Commands

All run against `fada7b47` on `main` and passed there. Baseline: `npm run check`
passes with 552 tests, 549 pass, 3 skipped.

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Full check | `npm run check` | exit 0; tests `pass` = 549 + the tests this plan adds, `fail 0`, `skipped 3` |
| Static only | `npm run check:static` | exit 0 (build, test typecheck, eslint, prettier, knip) |
| Test typecheck | `npm run type-check:test` | exit 0 |
| One file | `node --test __tests__/stdio.test.ts` | `fail 0` (22 tests on main) |
| One file | `node --test __tests__/http-server.test.ts` | `fail 0` (30 on main) |
| One file | `node --test __tests__/input-required.test.ts` | `fail 0` (63 on main) |
| By name | `node --test --test-name-pattern="STDIO-017" __tests__/stdio.test.ts` | named test runs |
| Text search | `git grep -n "<text>" -- <paths>` | matching lines; no match prints nothing and exits 1 (the Windows executor has no `grep` binary) |
| Format | `npx prettier --write <files>` | files rewritten |

## Scope

**In scope** — the only files to modify:

- [`src/server.ts`](../../../src/server.ts)
- [`src/transport/http.ts`](../../../src/transport/http.ts)
- [`src/transport/shared.ts`](../../../src/transport/shared.ts)
- [`__tests__/helpers.ts`](../../../__tests__/helpers.ts) (`:180` only)
- [`__tests__/input-required.test.ts`](../../../__tests__/input-required.test.ts) (the two factories only)
- [`__tests__/progress.test.ts`](../../../__tests__/progress.test.ts), [`__tests__/roots-seeding.test.ts`](../../../__tests__/roots-seeding.test.ts), [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts) (one line each)
- [`__tests__/resources-subscribe.test.ts`](../../../__tests__/resources-subscribe.test.ts) (new dispose test), [`__tests__/stdio.test.ts`](../../../__tests__/stdio.test.ts) (new over-cap tests), [`__tests__/http-server.test.ts`](../../../__tests__/http-server.test.ts) (tighten test 7)
- [`docs/plan/2026-09-15-sdk-listen-hook/deletion-map.md`](../../../docs/plan/2026-09-15-sdk-listen-hook/deletion-map.md)

**Files out of scope** — leave alone even though they look related:

- [`src/transport/stdio.ts`](../../../src/transport/stdio.ts) — `:145` and `:212` disposals stay; stdio adopts the new wording through `prepared.message` with no edit.
- [`__tests__/capabilities.test.ts`](../../../__tests__/capabilities.test.ts), [`__tests__/core-fs.test.ts`](../../../__tests__/core-fs.test.ts), [`__tests__/resources.test.ts`](../../../__tests__/resources.test.ts) — unconnected servers; `close()` never fires `onclose`, so their explicit dispose is the only disposal.
- [`__tests__/cli.test.ts`](../../../__tests__/cli.test.ts), and the factories at [`helpers.ts:224`](../../../__tests__/helpers.ts#L224) / [`:299`](../../../__tests__/helpers.ts#L299) — gain the hook through `createServer`; no edit.
- [`src/resources.ts`](../../../src/resources.ts) — the lease comment at `:302-305` stays accurate.
- `__tests__/input-required.test.ts` direct `pendingRoundTrip` / `describeRefusal` calls — owned by the delete.ts batch (findings 2+3). This batch edits only the two factories at `:97-103` and `:576-582`; the hunks are distinct from that batch's, but a rebase may be needed if it merges first (see [T-15](tickets/T-15-in-what-order-do-the-batch-prs-merge.md)). `__tests__/tools.test.ts` is also edited by the tools/list budget batch; its hunk here is the one line at `:1467`.
- `package.json`, `server.json`, `mcpb/manifest.json` — versions are bumped only by the Release workflow.
- `src/core/watcher-registry.ts` — `capped` reason and cap constant unchanged.

## Steps

### 1. Create the branch and confirm the baseline

`git switch -c refactor/http-batch-dispose-listen-cap main`, then run the drift
check at the top.

**Verify**: `git branch --show-current` → `refactor/http-batch-dispose-listen-cap`; `node --test __tests__/stdio.test.ts __tests__/http-server.test.ts` → `fail 0`.

### 2. Test first (finding 4): a connected server's close releases its leases

In [`resources-subscribe.test.ts`](../../../__tests__/resources-subscribe.test.ts), after the existing `describe` ([`:139`](../../../__tests__/resources-subscribe.test.ts#L139)), add
a `describe('createServer disposal on connection close')` with one test:
build `const registry = createWatcherRegistry()` (from `../src/core/watcher-registry.ts`),
`const ctx = await createServer({ cliAllowedDirs: [root] }, { watcherRegistry: registry })`
(from `../src/server.ts`), link an `InMemoryTransport` pair (import `Client`,
`InMemoryTransport` from `@modelcontextprotocol/client`, as
[`helpers.ts`](../../../__tests__/helpers.ts) does), connect both, `await client.subscribeResource({ uri })` for a real file
(`writeTestFile` + `buildFileResourceUri`), assert `registry.hasWatcher(uri) === true`, then
`await client.close()` **without** calling `ctx.disposeRuntimeState()` and assert
`registry.hasWatcher(uri) === false`. Clean up in `finally` (`registry.destroy()`, `cleanupTestRoot`). No explicit dispose anywhere in the test: the point is that closing the connection is enough.

**Verify**: `node --test --test-name-pattern="disposal on connection close" __tests__/resources-subscribe.test.ts` → **fails** with `true !== false` on the second assertion (a probe of this exact shape was run against `fada7b47` and failed that way). If it passes before Step 3, STOP.

### 3. `createServer` owns the `onclose` hook

In [`server.ts`](../../../src/server.ts#L191-L202), build the context object first, then wrap `server.server.onclose` (the `Server` inside the `McpServer`) and chain any previous handler:

```ts
const context: FilesystemServerContext = { mcp: server, pathGuard, disposeRuntimeState() { ... } };
const previousOnClose = server.server.onclose;
server.server.onclose = () => {
  previousOnClose?.();
  context.disposeRuntimeState();
};
return context;
```

Keep the existing `cleanedUp` / `ownsPages` / `resourceDisposable` body unchanged. Do this before returning, so the SDK's per-exchange wrapper (`dist/index.mjs:1407`) captures it as `previousOnClose`. The `http.ts` copy still runs; double-dispose is harmless (idempotent).

**Verify**: `node --test --test-name-pattern="disposal on connection close" __tests__/resources-subscribe.test.ts` → passes; `npm run type-check:test` → exit 0; `node --test __tests__/http-server.test.ts __tests__/input-required.test.ts __tests__/stdio.test.ts` → `fail 0`.

### 4. Delete the three copies

- [`http.ts:330-334`](../../../src/transport/http.ts#L330-L334): remove the `previousOnClose` block; the factory becomes `const c = await createServer(...); return c.mcp;` (or `return (await createServer(...)).mcp`).
- [`input-required.test.ts:98-102`](../../../__tests__/input-required.test.ts#L98-L102) and [`:577-581`](../../../__tests__/input-required.test.ts#L577-L581): same, `return context.mcp;` directly.

**Verify**: `git grep -n "previousOnClose" -- src __tests__` → only matches inside `src/server.ts`; `node --test __tests__/http-server.test.ts __tests__/input-required.test.ts` → `fail 0`.

### 5. Remove the explicit dispose at the four connected teardowns

Delete exactly one line each: [`helpers.ts:180`](../../../__tests__/helpers.ts#L180), [`progress.test.ts:154`](../../../__tests__/progress.test.ts#L154),
[`roots-seeding.test.ts:42`](../../../__tests__/roots-seeding.test.ts#L42), [`tools.test.ts:1467`](../../../__tests__/tools.test.ts#L1467). Each is preceded by `client.close()` on a connected
in-memory pair, so the server's `onclose` fires and disposes. **Keep** every other
`disposeRuntimeState()` ([`stdio.ts:145`](../../../src/transport/stdio.ts#L145), [`:212`](../../../src/transport/stdio.ts#L212), [`capabilities.test.ts:74`](../../../__tests__/capabilities.test.ts#L74),
[`core-fs.test.ts:39`](../../../__tests__/core-fs.test.ts#L39), [`resources.test.ts:747`](../../../__tests__/resources.test.ts#L747)). If the `try/finally` around a removed line is left
with only `await ...mcp.close()`, leave it as is.

**Verify**: `git grep -n "disposeRuntimeState" -- src __tests__` → exactly these sites: `src/server.ts` (interface, definition, and the `onclose` call), `stdio.ts` (2 calls), `capabilities.test.ts`, `core-fs.test.ts`, `resources.test.ts`; then `npm test -- --test-name-pattern="Resource subscriptions|Client roots|progress|disposal"` → `fail 0`, and `node --test __tests__/tools.test.ts __tests__/progress.test.ts __tests__/roots-seeding.test.ts` → `fail 0`.

### 6. Test first (finding 5): stdio over-cap listen is rejected before any watcher

In [`stdio.test.ts`](../../../__tests__/stdio.test.ts), after STDIO-008 (ends [`:431`](../../../__tests__/stdio.test.ts#L431)), add, imitating STDIO-008 (`createRawStdioServer(tmpDir, { FS_MAX_WATCHERS: '1' })`, `discoverModern`):

- `STDIO-017: a listen naming more new URIs than remaining slots is rejected before the ack`: send one `subscriptions/listen` (id `'over'`) naming two distinct real files; `nextMessage()` must be an error (`'error' in msg`), `error.code === ProtocolErrorCode.InvalidParams` (already imported), message includes `watcher slots remain (cap 1)` and `Reduce the resourceSubscriptions list`. Then send a one-URI listen and assert its ack is `notifications/subscriptions/acknowledged` (no capacity leaked).
- `STDIO-018: re-listening an already watched URI at the cap is accepted`: listen on file A (ack), then listen on file A again under a new id (ack). Passes before and after; it pins that the pre-check counts only not-yet-watched URIs.

Also tighten [`http-server.test.ts:345`](../../../__tests__/http-server.test.ts#L345) so test 7 pins the shared wording and request-id echo: keep `watcher slots`, add `includes('Reduce the resourceSubscriptions list')` and `body.id === 1` if the body type is widened to include `id`. (HTTP already has an over-cap test; this only makes it pin what stdio must now match.)

**Verify**: `node --test --test-name-pattern="STDIO-017" __tests__/stdio.test.ts` → **fails** (the message today is `Cannot subscribe to ...: watcher limit 1 reached`, no `watcher slots`). `STDIO-018` and the tightened HTTP test pass. If STDIO-017 passes before Step 7, STOP.

### 7. Move the pre-check into `prepareListenWatchers`

In [`shared.ts`](../../../src/transport/shared.ts#L94), at the top of the function body (before `const acquired`):

```ts
// Reject an over-cap listen before the ack: the per-URI `capped` failure below
// would also reject, but only after creating and tearing down watchers up to the cap.
// Only URIs without a live watcher consume a slot.
const newUris = uris.filter((uri) => !registry.hasWatcher(uri));
const available = MAX_WATCHERS - registry.size();
if (newUris.length > available) {
  return {
    ok: false,
    message: `subscriptions/listen names ${newUris.length} not-yet-watched URIs but only ${available} watcher slots remain (cap ${MAX_WATCHERS}). Reduce the resourceSubscriptions list.`,
  };
}
```

Update the doc comment above the function to mention the pre-check. In [`http.ts`](../../../src/transport/http.ts#L204-L221) delete the inline block (comment + `newUris` / `available` / `sendJsonRpcError` return) and drop `MAX_WATCHERS` from the import at [`:32`](../../../src/transport/http.ts#L32); leave `jsonRpcRequestId`, `ProtocolErrorCode`, `sharedRegistry` (all still used). Do not touch `stdio.ts`.

**Verify**: `node --test __tests__/stdio.test.ts __tests__/http-server.test.ts __tests__/subscriptions-listen.test.ts __tests__/http-shared-guard.test.ts` → `fail 0`, including STDIO-017/018 and test 7; `npm run type-check:test` → exit 0; `git grep -n "MAX_WATCHERS" -- src/transport/http.ts` → prints nothing and exits 1.

### 8. Update the deletion map

In [`deletion-map.md`](../../../docs/plan/2026-09-15-sdk-listen-hook/deletion-map.md), row `src/transport/http.ts` ("What it is" column): remove `cap pre-check, ` so it reads `body pre-parse, response-close release`. In the `src/transport/shared.ts` row add `the cap pre-check inside` `prepareListenWatchers`, and set its "Replaced by" to `hook callbacks; cap via` `maxSubscriptions` (the pre-check's replacement moves with it). Leave the line ranges and the measurement notes alone (not re-measured here). Then `npx prettier --write docs/plan/2026-09-15-sdk-listen-hook/deletion-map.md` to re-pad the table.

**Verify**: `git grep -n "cap pre-check" -- docs/plan/2026-09-15-sdk-listen-hook/deletion-map.md` → one match, on the `shared.ts` row; `npx prettier --check docs/plan/2026-09-15-sdk-listen-hook/deletion-map.md` → `All matched files use Prettier code style!`.

### 9. Format and run the full check

`npx prettier --write` the changed `src/` and `__tests__/` files, then run the full check.

**Verify**: `npm run check` → exit 0; `fail 0`; `skipped 3`; `pass` = 549 + 3 (the new disposal test, STDIO-017, STDIO-018) = 552. `git status --short` lists only the in-scope files plus `docs/plan/2026-10-02-arch-audit-followups/`.

## Done

- [ ] `npm run check` exits 0, `fail 0`, `skipped 3`, `pass` 552
- [ ] `git grep -n "previousOnClose" -- src __tests__` matches only `src/server.ts`
- [ ] `git grep -n "MAX_WATCHERS" -- src/transport/http.ts` prints nothing (exit 1)
- [ ] `disposeRuntimeState()` remains only at the five kept sites (`stdio.ts` ×2, `capabilities.test.ts`, `core-fs.test.ts`, `resources.test.ts`)
- [ ] The new disposal test and STDIO-017 each failed before their fix step and pass after
- [ ] `git status --short` shows no files outside the in-scope list; no commit made

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its excerpt.
- A step's verification fails twice after one fix attempt.
- Step 2's test or STDIO-017 **passes before its fix** (the red/green premise is false).
- Setting `server.server.onclose` inside `createServer` does not fire when a `createMcpHandler` exchange ends (the SDK wrapper at `dist/index.mjs:1407-1414` overwrote rather than chained, e.g. after an SDK upgrade): the HTTP leg would leak leases. The `http-server` / `input-required` suites staying green does not prove it; the Step 2 shape through the handler would.
- Removing a connected-teardown dispose makes a test hang or fail (the "connected" classification would be wrong for that site; restore it and report).
- Making stdio's wording change breaks an existing stdio test asserting `watcher limit` (none found at `fada7b47`; the only match is `shared.ts:74`).
- The fix appears to require an out-of-scope file, or a rebase over the delete.ts batch conflicts in `input-required.test.ts` beyond the two factory hunks.

## Notes

- Audit premise corrected: HTTP already has an over-cap test ([`http-server.test.ts:323`](../../../__tests__/http-server.test.ts#L323)); only stdio gains a new one, and HTTP's is tightened.
- Reviewer focus: `onclose` ownership is `mcp.server`, not `McpServer`; `stdio.ts:212` double-dispose is intentional and safe via `cleanedUp`; the pre-check runs on both legs' de-duplicated URI list, and empty lists never reach it on stdio (`:297` short-circuits) and pass it on HTTP (`0 > available` is false).
- Net size is about −24 lines of source/test plus ~70 added test lines.
