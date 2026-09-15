# ADR-002: The 2025-era-only paths stay until a dated trigger, then go together

**Status**: accepted, 2026-09-15
**Deciders**: j0hanz

## Context

Protocol revision 2026-07-28 changed how a connection carries state. Requests
now declare capabilities in a per-request envelope instead of fixing them once
at an `initialize` handshake, so a 2026-07-28 connection never sends
`initialize` at all. `subscriptions/listen` replaced the push-style
`resources/subscribe` / `resources/unsubscribe` pair. SEP-2577 separately
deprecated Roots, Sampling and Logging as first-class features; the spec's
feature-lifecycle policy guarantees a deprecation window of at least twelve
months from that date, so the earliest the SDK can remove the deprecated
`Server.listRoots()` and `Server.getClientCapabilities()` accessors is
2027-07-28.

This server keeps three code paths that exist only to serve a 2025-era
connection, each already commented as legacy-only but with no date attached:
`seedRootsFromClient` in
[`src/transport/stdio.ts:63`](../../src/transport/stdio.ts#L63), wired only
when `era === 'legacy'`, calls the deprecated `listRoots()` to push-seed
allowed roots; the `resources/subscribe` / `resources/unsubscribe` request
handlers in [`src/resources.ts:452-559`](../../src/resources.ts#L452-L559),
registered only when `deps.era !== 'modern'`; and the deprecated
`getClientCapabilities()` fallback in
[`src/tools/define.ts:159-162`](../../src/tools/define.ts#L159-L162), reached
only when a request carries no modern capabilities envelope.

They exist today because every mainstream MCP host still opens a connection
with the 2025 handshake — `initialize`, then `roots/list`, then
`resources/subscribe` where a client wants live updates — and the installed
SDK (`@modelcontextprotocol/server@2.0.0`) serves both eras from one factory
(`serveStdio` with `legacy: 'serve'`, `createMcpHandler` with
`legacy: 'stateless'`). Dropping either era's path today would break every
client that has not yet moved to the 2026-07-28 wire.

## Options

- **Remove now** — breaks every 2025-era client on stdio; rejected.
- **Keep indefinitely** — dead code the day the SDK drops `listRoots` /
  `getClientCapabilities`, with no plan on file; rejected.
- **Keep with a dated trigger and a grep-able marker** (chosen).

## Decision

The three paths stay. They are removed together, in one change, at the
earliest of:

1. the first `@modelcontextprotocol/server` release that removes
   `Server.listRoots()` or `Server.getClientCapabilities()`, or
2. the first major release of this server after 2027-07-28.

Each site carries the comment marker `sunset(SEP-2577)` so
`grep -rn "sunset(SEP-2577)" src` enumerates exactly what the removal touches.
Removal is blocked until the 2025-era test harness (`createTestClientPair`,
`InMemoryTransport.createLinkedPair()`) has been migrated to the modern
in-process harness (`createTestHttpHarness`) in the six test files that use
it; that migration is the first step of the removal change, not a separate
project.

## Consequences

- The marker buys a single, exact removal checklist: the next person to touch
  this does not need to re-derive which lines are legacy-only, and a version
  bump PR can grep for the trigger instead of re-litigating the audit.
- The removal will delete roughly 45 lines from `src/transport/stdio.ts`
  (`seedRootsFromClient` and its call site), roughly 110 lines from
  `src/resources.ts` (the subscribe/unsubscribe handlers and their registry),
  and roughly 4 lines from `src/tools/define.ts` (the fallback expression and
  its disable comment).
- README's sentence about legacy roots seeding
  ([`README.md:294`](../../README.md#L294)) and the `legacy_roots` line in
  [`src/instructions.ts:67`](../../src/instructions.ts#L67) go with the
  removal — both describe a flow the removal deletes and become stale the
  moment it lands.
- A client that still opens with `initialize` after removal gets the SDK's
  own unsupported-protocol-version error; this server adds no further
  compatibility shim for that case.
- This record must be revisited if the spec extends the SEP-2577 deprecation
  window past twelve months, or if a future SEP changes what replaces
  `resources/subscribe` before this server removes it.
