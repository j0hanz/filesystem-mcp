# ADR-022: WatcherRegistry owns independent Watcher lease lifetimes

**Status**: accepted, 2026-11-17
**Deciders**: j0hanz, in the architecture review of WatcherRegistry lease ownership

## Context

`WatcherRegistry.acquire` retains a watcher by URI, but its callers own the
resulting lifetime and call `release(uri)`. The filesystem resource therefore
keeps four compensating collections for leased URIs, in-flight acquisition,
cancellation, and callback disabling. Stdio and HTTP listen each reconstruct
release around their own request or response lifetime.

The current comments already identify two consequences: a departed direct
notification callback can linger until the final URI lease ends, and raw
unsubscribe-by-URI can release another holder's lease without caller-side
compensation. Cancellation before acquisition settles needs a second,
URI-keyed state machine in the resource module.

The seam is real: resource subscribe, stdio listen, and HTTP listen are three
adapters with different protocol policy but the same watcher lifetime.

## Decision

`WatcherRegistry` owns the whole **Watcher lease** defined in `GLOSSARY.md`.

- **Acquisition returns a lease handle immediately**, with a completion promise
  for the acquisition result. A caller can dispose the handle before, during,
  or after acquisition.
- **Every successful acquisition owns an independent lease**, including
  repeated acquisitions of one URI. Per-connection subscribe idempotence stays
  in the resource adapter; it does not merge leases in the registry.
- **Disposal is exactly-once.** Disposing a pending lease cancels it and its
  completion resolves as cancelled, not as an acquisition failure. Disposing a
  settled lease releases it. Repeated disposal changes nothing.
- **Callbacks belong to leases.** The registry tracks each lease's callback and
  detaches it when no other live lease uses that callback. Identical callbacks
  remain safe for HTTP's shared bus-publishing callback.
- **Adapters keep only protocol mapping**: resource URI idempotence, stdio
  request IDs and cancellation, and HTTP response lifetime. Raw URI release
  leaves the interface.
- **All three adapters migrate atomically.** No temporary raw-release interface
  remains beside owned leases, and no shared stdio/HTTP request state machine
  is introduced.

Existing watcher cap, aliasing, debounce, watcher-error, and root-revocation
behavior stays unchanged. Legacy HTTP remains unable to accept subscriptions
under ADR-003. Instance leases are released before registry destruction.

## Considered options

- **An AbortSignal parameter.** Rejected: the caller still owns a controller
  and separate cancellation state, while no lease exists to dispose until
  acquisition succeeds.
- **One shared lease per URI.** Rejected: one caller can release another
  caller's subscription, and protocol idempotence leaks into the registry.
- **A unique callback per lease.** Rejected: it simplifies the registry by
  making every adapter satisfy a new invariant; the ownership belongs behind
  the lease seam.
- **A temporary dual interface.** Rejected: raw URI release and owned leases
  preserve two lifetime models during migration and leave the compensation in
  place.

## Consequences

- Locality: over-release, pending cancellation, callback detachment, and
  duplicate disposal become registry invariants.
- Leverage: all three subscription paths share one lifetime implementation.
- Registry tests drive independent same-URI leases, duplicate disposal,
  cancelled acquisition, and shared-callback detachment through the lease
  interface. Existing resource, stdio, and HTTP suites remain wiring and
  protocol coverage.
- No advertised MCP schema or tool description changes are expected.
