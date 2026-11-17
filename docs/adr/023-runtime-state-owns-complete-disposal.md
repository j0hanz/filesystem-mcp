# ADR-023: RuntimeState owns complete, no-throw disposal

**Status**: accepted, 2026-11-17
**Deciders**: j0hanz, in the architecture review of RuntimeState disposal

## Context

`RuntimeState.dispose` sets one global `disposed` flag and then runs four
owned cleanup operations sequentially. The first throw skips the rest, and a
later call does nothing. HTTP catches and logs so the real server can close;
stdio guards different steps and orders them differently. The recent transport
fixes protect process shutdown, but the owned-state module still leaves
partial-failure policy to its callers.

`createServer` also has two lifetimes: per-instance resource registrations and
shared RuntimeState. A context that created its own state must trigger that
state's disposal; injected endpoint or connection state has an external owner.

## Decision

`RuntimeState` owns complete disposal of its changed-notification timer,
watcher registry, page store, undo journal, and resource store.

- **Attempt every owned cleanup**, even after an earlier cleanup fails.
- **Log every failure and never throw.** Owned-state failure cannot interrupt
  transport or server closure, and callers no longer need a defensive catch
  around RuntimeState disposal.
- **Retry only failed cleanups.** Each owned cleanup records completion;
  repeated disposal never repeats a successful cleanup and retries one that
  previously failed. The first disposal stops new resource-change
  notifications even when failed cleanups remain.
- **Per-instance registration cleanup follows the same no-throw policy.** It
  attempts registration disposal and any creator-owned state disposal, logging
  every failure.
- **The creator triggers owned-state disposal.** A server context that created
  its RuntimeState disposes it on close after releasing its registrations.
  Injected shared state remains the caller's responsibility and is never
  destroyed by an individual server context.
- **Leases end before registry destruction.** Pending listens are cancelled
  and instance leases released before shared registry disposal. HTTP still
  aborts in-flight exchanges and closes its handler before endpoint state;
  stdio still finishes its transport-specific stdin handling.

No generic teardown engine is introduced. The two transport adapters keep
only SDK closure, server closure, and their genuinely different transport
handling.

## Considered options

- **Throw AggregateError after all cleanup.** Rejected: every caller must keep
  a catch or finally to protect closure, preserving the leaked failure policy.
- **Rethrow the first failure.** Rejected: later failures need separate
  reporting and callers still defend their own cleanup.
- **Attempt cleanup only once.** Rejected: a failed owned object remains
  stranded after its failure is logged.
- **Retry every cleanup.** Rejected: successful cleanups need not tolerate
  repetition; completion is tracked per owned operation instead.
- **Always dispose injected state from the server context.** Rejected: one
  instance could destroy endpoint or connection state still used by others.

## Consequences

- Locality: partial-failure, retry, logging, and cleanup-order rules live with
  the owned state rather than transport-specific catches.
- Leverage: stdio and HTTP inherit the same disposal guarantee.
- RuntimeState tests inject one failing owned cleanup and assert no throw,
  later cleanup, failure logging, and retry of only the failed operation.
  Instance cleanup gets the same failure-policy tests; HTTP and stdio retain
  wiring pins rather than acting as the primary cleanup test surface.
- No advertised MCP schema or tool description changes are expected.
