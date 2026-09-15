# ADR-003: HTTP serves 2025-era clients through the SDK's stateless legacy fallback

**Status**: accepted, 2026-09-15
**Deciders**: j0hanz — settled on plan 004

## Context

The `--port` leg builds its modern handler with
`createMcpHandler(..., { legacy: 'reject' })`
([`http.ts:312`](../../src/transport/http.ts#L312)), a posture pinned by
`http-server.test.ts` test 4: a client that opens with the 2025 `initialize`
handshake gets HTTP 400 with an unsupported-protocol-version error. Every
mainstream host today — Claude Desktop, Cursor, VS Code, the MCP Inspector's
default — opens that way unless explicitly configured for 2026-07-28
negotiation, so `'reject'` currently serves only clients that opted in to the
new era. The stdio leg already serves both eras from the same
`createServer` factory; HTTP does not.

No written rationale for `'reject'` exists in the repository.

A probe against the installed SDK (2.0.0) connecting a 2025-era `Client` (no
`versionNegotiation` option) through `handler.fetch` with `legacy:
'stateless'` showed:

- Reads and lists work unchanged; tools, prompts and resources are all
  reachable.
- A recursive, non-empty `delete` — which needs a client confirmation —
  fails closed, but with the SDK's own generic text rather than this
  server's hint:

  > Cannot request input 'confirm_0' (elicitation/create): the client on
  > this 2025-era connection did not declare the required capability (no
  > client capabilities are available on this connection — per-request
  > legacy serving cannot receive server-to-client requests)

- `resources/subscribe` is **accepted**: `subscribeResource` returns `{}`
  and the watcher registry grows by one lease, taken on a throwaway
  `McpServer` instance that the SDK discards at the end of the request. The
  lease is never delivered anywhere and is never cleaned up by the normal
  unsubscribe path.
- Each legacy request builds a fresh `McpServer` from the factory — the
  probe's five calls logged `era` as `legacy` five times, one instance per
  request, torn down through `onclose` after each exchange.

So the SDK's stateless fallback gets the read/list/search surface right for
free, but two things need this server's own handling before it can be turned
on: the confirmation flow needs the server's named hint instead of the SDK's
generic refusal, and `resources/subscribe` must be refused outright rather
than accepted onto an instance that is gone before any file change could
reach it.

## Options

- **Keep `legacy: 'reject'`** — no code changes, but leaves every host that
  has not opted into 2026-07-28 negotiation unable to use `--port` mode at
  all. Undocumented as a deliberate choice; the more likely explanation is
  that no one revisited the SDK's default after it changed.
- **`legacy: 'stateless'` (chosen)** — the SDK's default: each 2025-era
  request runs the same factory used everywhere else, no session, no new
  transport code. Tools, resources and prompts work without change. The gap
  is the two request shapes that need a return path to the client
  (`elicitation/create`, `resources/subscribe` notifications) — both already
  have, or gain here, a well-defined closed-loop failure instead of
  half-working.
- **Sessionful legacy via `NodeStreamableHTTPServerTransport` with a
  `sessionIdGenerator`** (rejected) — would let a subscription and a
  confirmation round-trip actually work over legacy HTTP, matching stdio's
  behavior. Rejected because it reintroduces the per-connection state
  (`Mcp-Session-Id`, an event store, connection-scoped watcher leases) that
  the 2026-07-28 model was designed to remove, on a code path (2025-era
  compatibility) whose whole point is to be temporary. The SDK's own docs
  route this composition through user-land `isLegacyRequest` branching in
  front of two differently-configured handlers, which is meaningfully more
  surface than the one-word change below — for a client population this
  server expects to shrink over time, not grow.

## Decision

Flip `src/transport/http.ts:312` to `legacy: 'stateless'`. Two guards make
the gap fail closed instead of half-working:

- **Confirmations**: `src/tools/index.ts` forwards `era` into `ToolDeps`,
  and `src/tools/define.ts`'s `toToolCtx` falls back to `{}` (declared
  capabilities: none) when `era === 'legacy'` and neither the request
  envelope nor the deprecated `getClientCapabilities()` accessor produced
  anything — the shape only a per-request legacy HTTP instance is in,
  since it never runs `initialize`. `assertCanElicit`
  (`src/core/input-required.ts`) then sees "no elicitation capability" and
  throws the server's own hint (e.g. "Deleting a non-empty directory needs a
  confirmation this client cannot show...") instead of the SDK's generic
  `-32021`/text refusal.
- **Subscriptions**: `src/resources.ts` only registers
  `resources/subscribe`/`unsubscribe` when `deps.era !== 'modern' &&
deps.notifier === undefined` — true for stdio and the in-memory legacy
  test pairs, false for the HTTP leg, which always supplies a `notifier`.
  On HTTP the handlers are absent, so the SDK itself answers `-32601 Method
not found` and no watcher lease is ever taken on a per-request instance
  that cannot outlive the exchange.

## Consequences

- A 2025-era client over HTTP gets tools, prompts, resources, reads,
  pagination and the externalized result store — the store and page cache
  are shared at the endpoint, not per-connection, so a paginated or
  externalized result from one request is readable by the next.
- It does **not** get `input_required` confirmations (recursive delete,
  overwrite on move/copy/create, an out-of-root access grant) or
  `resources/subscribe` — both need a return path to the same client
  connection that a stateless per-request instance does not have. Each
  answers with the server's own actionable message rather than the SDK's
  generic refusal or a silently-dropped lease.
- `listChanged` notifications (tools, prompts, resources) have nowhere to
  go on a legacy HTTP connection either, for the same reason — there is no
  standing connection to notify.
- Each legacy HTTP request now costs one full factory run
  (`createServer`), same as every modern request already does; this was
  already true under `'reject'` for the handshake itself, just never
  reached past it.
- The rate limiter and auth layer (`http-policy.ts`) are era-blind and
  unchanged: they count `initialize` (and every other request) per
  session/IP exactly as before, so a legacy client's lack of a session
  does not exempt it from the existing limits.
- Reopening this means either accepting the sessionful-legacy cost above or
  narrowing which 2025-era clients get served (e.g. only over stdio) — the
  first version of this decision found no case that needed the middle
  ground.
