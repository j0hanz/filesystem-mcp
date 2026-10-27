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
[`src/transport/stdio.ts`](../../src/transport/stdio.ts), wired only
when `era === 'legacy'`, calls the deprecated `listRoots()` to push-seed
allowed roots (it is also the only caller of
`PathGuard.applyGrant(dir, 'workspace')` in
[`src/core/path.ts`](../../src/core/path.ts); the `'workspace'` kind, the
`accessGrants` list and the `accessGrants` clause of the `bases` filter in
`recomputeAllowedDirectories` exist only to tell a declared root from an
approved grant); the `resources/subscribe` / `resources/unsubscribe` request
handlers in `registerResources`
([`src/resources.ts`](../../src/resources.ts)), registered only when `deps.era !== 'modern'`; and the deprecated
`getClientCapabilities()` fallback in `toToolCtx`
([`src/tools/define.ts`](../../src/tools/define.ts)), reached
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
- The text that describes legacy roots seeding goes with the removal, since
  it describes a flow the removal deletes and becomes stale the moment it
  lands:
  - [`docs/configuration.md`](../configuration.md#choosing-folders): the
    workspace row in Choosing folders (and the "five ways" count above it),
    the tip that removing a folder from your editor does not remove access,
    the "client's workspace folders" mention under Folders that are never
    added automatically, and the Folders over HTTP paragraph;
  - the README: the VS Code tip in the
    [quick start](../../README.md#quick-start) and the protocol note under
    "Build your own client" (formerly "For MCP client developers");
  - [`docs/client-guide.md`](../client-guide.md): the 2025 columns and rows
    of Protocol versions, the `roots/list` and 2025-era sentences in Folders
    and paths and Resources and file subscriptions, and the `--legacy` modes
    of the fsq, tail, and python examples it lists;
  - the `legacy_roots` line in
    [`src/instructions.ts:67`](../../src/instructions.ts#L67).
- A client that still opens with `initialize` after removal gets the SDK's
  own unsupported-protocol-version error; this server adds no further
  compatibility shim for that case.
- This record must be revisited if the spec extends the SEP-2577 deprecation
  window past twelve months, or if a future SEP changes what replaces
  `resources/subscribe` before this server removes it.
- **Amended 2026-09-29:** the marker grep returns five sites, not three. Two
  legacy-only branches had landed without it: the capability gate in
  `src/server.ts` (`legacyHttp` and the `resources: { subscribe, listChanged }`
  pair it drives, roughly 7 lines) and the `era === 'legacy'` block in
  `src/transport/stdio.ts` that wires `oninitialized` and
  `notifications/roots/list_changed` to `seedRootsFromClient` (roughly 12
  lines). Both now carry the marker. The removal also retires the `era`
  discriminator that exists only to reach these sites: the `era?` option and
  its forward in `src/server.ts`, the `era` field on the registrar deps in
  `src/resources.ts`, `src/tools/index.ts` and `src/tools/define.ts`, and the
  `({ era })` factory argument and its forward in `src/transport/http.ts` and
  `src/transport/stdio.ts` (roughly 10 lines across six files). The
  `legacyHttp` predicate is deliberately spelled twice (`server.ts`,
  `resources.ts`) rather than passed through `deps`: adding a field to
  plumbing this record schedules for deletion would be a new seam in code
  meant to be temporary.
- **Amended 2026-10-13:** the Decision's "six test files" undercounts.
  `grep -l "createTestClientPair\|createLinkedPair" __tests__/*.ts`
  without `__tests__/helpers.ts` returned 15 files on 2026-10-13. The
  migration that blocks removal is that grep's file list, not a fixed
  number. Also, `src/tools/index.ts` no longer declares its own `era`
  field: its registrar deps extend `ToolDeps` in `src/tools/define.ts`,
  so the `era` removal there is one field, not two.
- **Amended 2026-10-27:** the marker grep returns three more sites, in
  `src/core/path.ts`. The `'workspace'` grant kind landed in b34b6310
  (2026-10-14), after the last amendment, without the marker. Its only caller
  is `seedRootsFromClient`. With workspace grants gone every grant is an
  access grant, so the removal also deletes the `kind` parameter of
  `applyGrant` and its branch, the `accessGrants` list, and the
  `accessGrants` clause of the `bases` filter in
  `recomputeAllowedDirectories`. The filter itself stays, keeping only
  configured roots, so a relative path still never resolves against a grant.
