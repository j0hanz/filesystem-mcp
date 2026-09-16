# Deletion map: if the SDK ships a `subscriptions/listen` attach/detach hook

> Written 2026-09-15 against commit `e1489b1a`. Every line range below was
> re-checked with `grep -n` / `sed -n` against the live tree in this session
> (not copied from the plan) — see the plan's "Current state" section for the
> ranges the plan predicted; this table records what was actually measured.
> Nothing in this repo changes until upstream ships one of the two shapes
> proposed in [`issue-draft.md`](issue-draft.md). This is a map for later,
> not a change made now.

| File                            | Range                                            | What it is                                                 | Replaced by                                          |
| -------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `src/transport/stdio.ts`         | 221-333 (assert at 255-258)                        | `send`/`onmessage` wrap, listen state map, cancel routing   | hook callbacks                                        |
| `src/transport/shared.ts`        | 36-118                                             | `isStructurallyValidListen`, `listenSubscriptionUris`, `prepareListenWatchers` | hook callbacks                     |
| `src/transport/http.ts`          | 164-237 (route starts 153)                         | body pre-parse, cap pre-check, response-close release       | hook callbacks; cap via `maxSubscriptions`            |
| `src/resources.ts`               | 452-559                                            | legacy `resources/subscribe`/`unsubscribe` handlers          | SDK-served from template callbacks (if shape (a) ships) |
| `src/core/watcher-registry.ts`   | `markSubscribe` (254, 259, 278), `desiredState` (52, 64-68, 139, 142, 156, 166, 332) | subscribe-in-flight bookkeeping                | per-subscription-id leases                            |
| `__tests__/stdio.test.ts`        | STDIO-006 (225), STDIO-007 (249), STDIO-008 (306), STDIO-009 (368), STDIO-010 (433), STDIO-011 (511), STDIO-012 (138), STDIO-013 (572) | lease-lifecycle tests of the gate | tests of the hook                                     |

Notes on measurement (this session, against `e1489b1a`, no drift found —
`git diff --stat e1489b1a..HEAD` on all five in-scope files was empty):

- `stdio.ts`: the plan's "Current state" section cites `230-333`. Measured:
  the `send` wrap that starts the whole gate is one statement earlier, at
  line 221 (`const send = wire.send.bind(wire);`); the `serveStdio(...)` call
  the plan's line pointed at is 230; the `onmessage` wrap it installs closes
  at 333. 221-333 is what would actually need deleting as one unit, since
  the `send` wrap exists only to release watcher leases the `onmessage` wrap
  acquires.
- `shared.ts`: measured 36-118, matching the plan's "Current state" section
  (not the stale `~25-118` in the plan's own Step 3 table, which the
  executor instructions flagged as stale — `RuntimeConfig` occupies lines
  21-35 at this commit, so line 25 falls inside an unrelated type).
- `http.ts`: the plan's "Current state" section cites `170-237`. Measured:
  the POST `/mcp` route itself opens at line 153; the body pre-parse this
  deletion is actually about starts three lines earlier than the plan's
  number, at 164 (`const parsedBody = req.body as unknown;`); the gate logic
  (pre-parse, cap check, watcher attach, close-release) runs through 237,
  where the route's async IIFE ends.
- `resources.ts`: measured 452-559, exactly matching the plan.
- `watcher-registry.ts`: `markSubscribe` and `desiredState` are not a single
  contiguous range — `markSubscribe` is a parameter/branch threaded through
  `release()` (254, 259, 278); `desiredState` is a `Map` declared at 52 and
  read/written at 64-68, 139, 142, 156, 166, and cleared at 332 (`destroy`).
  Both exist solely to reconstruct, from URI-keyed ref-counts, information a
  per-subscription-id hook would hand the server directly. The `ponytail:`
  note documenting the underlying gap (no per-subscription id in the SDK
  unsubscribe contract) is at line 43.
- `__tests__/stdio.test.ts`: all eight of STDIO-006 through STDIO-013 exist
  today (confirmed by `grep -n "STDIO-0" __tests__/stdio.test.ts`); they are
  not in numeric file order (STDIO-012 sits at line 138, before 006-011,
  which start at line 225) — line numbers above are the `it(...)` line for
  each, not a contiguous block.

## What must stay regardless of which shape ships

- **`WatcherRegistry` itself** — `fs.watch` ownership, debounce, and the
  watcher cap (`MAX_WATCHERS`) are this server's own concern; the SDK hook
  only tells the server *when* to start or stop a watch, never *how*. Nothing
  proposed in `issue-draft.md` touches `fs.watch`, debounce timing, or the
  cap constant.
- **`MAX_WATCHERS`** — the cap is server policy (how many concurrent
  filesystem watchers this process is willing to run), not a wire-protocol
  concept. Shape (b)'s `maxSubscriptions` option caps *SDK-tracked
  subscriptions*, which is a related but distinct budget (subscriptions vs.
  watchers are 1:1 today only because the current code makes them 1:1); this
  server would still need to decide, in its own `subscribe` callback,
  whether to accept or reject once its own watcher cap is hit.
- **All-or-nothing rejection semantics** — `__tests__/stdio.test.ts` STDIO-007
  and STDIO-011 pin that an SDK-rejected or over-cap listen releases every
  watcher it acquired rather than leaving a partial set attached. A hook
  removes the *code* that currently implements this by hand, but the
  *requirement* is unchanged and equally pinned by a test either way — see
  "Required semantics" in `issue-draft.md`'s Proposed API section, which
  states the same all-or-nothing rule as what any replacement hook must
  guarantee.
