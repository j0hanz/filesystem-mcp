# ADR-018: Client-declared workspace roots follow the client's latest `roots/list` answer

**Status**: accepted, 2026-11-15
**Deciders**: j0hanz, in the upstream parity review

## Context

On a 2025-era stdio connection, `seedRootsFromClient` in [`src/transport/stdio.ts`](../../src/transport/stdio.ts) calls `roots/list` after `notifications/initialized` and again on each `notifications/roots/list_changed`. It used to pass each root to `PathGuard.applyGrant(dir, 'workspace')`, so grants were session-additive (R8): a root the client withdrew stayed allowed until the connection closed.

The upstream reference server (`server.ts:1175-1186`) replaces its allow-list on each roots update and empties it when the client withdraws every root. It also discards a stale `roots/list` answer (`server.ts:1168`). The comparison found that a client that removes a folder from its workspace expects the server to lose access to it. Our server kept that access.

This path is legacy-era only. [ADR-002](002-legacy-protocol-paths-sunset.md) already schedules it for removal with the other SEP-2577 paths.

## Decision

- **Declared roots follow the client.** `PathGuard.replaceWorkspaceRoots(dirs)` makes the declared set exactly the roots of the latest answer that pass the unsafe-path and `FS_ROOT_BOUNDARY` checks. A declared root missing from the answer is revoked. An empty answer revokes every declared root.
- **Startup roots and prompted grants are never revoked.** Startup roots (CLI args, env, cwd) are the recomputed baseline, so a roots answer cannot touch them. A grant the user approved through the access prompt is never revoked. If the client names it as a root, it stays an access grant and is not promoted, so a later answer that omits it cannot revoke it. It still counts as allowed for that answer.
- **One recompute per answer, under the mutation lock.** A failed recompute rolls back to the previous view.
- **A failed or stale answer changes nothing.** A `roots/list` that throws or times out returns before any replace. `startServer` numbers each seed per connection, and an answer superseded by a newer request is discarded. The check runs again inside the lock, so an older answer that reaches the lock after a newer one has applied also changes nothing.

## Considered options

- **Keep the session-additive rule.** Rejected: a withdrawn folder stays readable and writable for the rest of the session, which the client cannot see or undo.
- **Replace every grant, as upstream does.** Rejected: upstream has no startup roots or access prompt. Revoking a startup root or a grant the user just approved would take away access the client never declared.
- **Track declared roots in a new set.** Rejected: the declared roots are already `grantedDirectories` minus `accessGrants`. No new state is needed.

## Consequences

- A client that sends an empty roots list loses access to every root it declared. Startup roots and user-approved grants still work.
- A client that withdraws a root mid-session sees later tool calls on that root fail with access denied. Tool calls wait for the re-list through `holdUntil`, as before.
- `__tests__/roots-seeding.test.ts` covers revoke, empty list, failed list, stale answer and startup roots. `__tests__/path-guard-grant.test.ts` covers the guard method.
- No wire schema or tool description changes. `__tests__/contract.test.ts` stays unchanged.
