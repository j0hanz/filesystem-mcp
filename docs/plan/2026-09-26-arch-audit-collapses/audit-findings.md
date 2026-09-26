# Architecture audit — surviving findings (2026-09-26)

Source: repo-wide architecture audit at `045ca359` (5 zone probes, every `src`
file opened; 31 candidates priced against the four-gate bar; 8 adversarially
verified; 3 survived). The bar: net deletion, a real seam (2+ users), churn,
and no record blessing the current shape.

## Finding 1 — errno knowledge leaks out of `errors.ts`

`errors.ts` owns classification — `ERRNO_MAP` (`:79-94`), `SKIPPABLE_ERRNOS`
(`:110`), `classifyCauseChain` (`:151-162`, private), `isNotFoundErrno`
(`:193`) — but call sites hand-list raw errnos:

- `src/core/fs.ts:54`, `:241` — `!isNodeError(error) || error.code !== 'ENOENT'`
- `src/core/fs.ts:436` — first half of the missing-probe is the same hand-check
- `src/core/path-completer.ts:73`, `:155` — `{ENOENT,EACCES}` hand lists next
  to the owned `SKIPPABLE_ERRNOS {ENOENT,EACCES,ELOOP}`
- `src/core/path.ts:667` — `lstatErr.code !== 'ENOENT'`
- `src/core/path.ts:516-523` — re-applies the raw `ERRNO_MAP` instead of
  `classifyCauseChain`, losing the abort/timeout cause-chain scan and the
  `IO_ERROR` fallback (`errors.ts:157`) every other classification path uses.

Accepted deltas (verified benign):

- `path-completer.ts:73`/`:155` gain `ELOOP` tolerance — a debug-log line and a
  warn line disappear for a path that is unusable either way.
- `path.ts:516-523`: unmapped errnos become `IO_ERROR` (matching `errors.ts`'s
  own fallback) instead of `UNKNOWN`; abort/timeout in the cause chain map to
  `CANCELLED`/`TIMEOUT` (latent — `fs.realpath` takes no signal today). The
  thrown message stays `'Cannot access path'`.

Explicitly out of scope:

- `src/core/fs.ts:265` — the `EEXIST` exclusive-create race probe stays
  hand-written: one site is not a seam, and it is a race protocol, not a
  tolerance rule.
- `src/tools/delete.ts:100-103` — the `{ENOTEMPTY, EISDIR, EEXIST}` map to
  `ERR_NOT_EMPTY` is a deliberate one-condition-one-message UX mapping;
  `ERRNO_MAP` would change the user-facing code and message. Separate change
  if ever wanted.

## Finding 2 — test rules re-implemented; `__tests__/helpers.ts` owns fragments

- Env pin-and-restore: `security.test.ts:275-291` has a file-local Record-shaped
  `withEnv` (sync, ~20 sites, with the FIFO after-hook ordering rationale in
  its comment at `:267-274`); `helpers.ts:74-83` has `withBoundary` for exactly
  one var; ~5 inline try/finally sites elsewhere. Two spellings
  (`delete` vs `Reflect.deleteProperty`).
- Rejection matcher `isFsError(err) && err.code === X` (~33 hits / 7 files), named
  only file-locally: `assertAccessDenied` (`path-guard-grant.test.ts:238`),
  `assertInvalidCursor` (`page-store.test.ts:8-13`). ~10 sites also match
  message content.
- Resource-update wait fixture: `setNotificationHandler('notifications/resources/updated',
  …)` + count + `waitFor` at 15 real sites / 4 files; ~7 fit a wait-for-one-uri
  helper. Count-based, multi-client cross-talk, and drain-and-reregister sites
  keep local handlers.

Sites that stay (verified): `core-fs.test.ts:157` (message-only matcher),
`:357` (OR with raw errno), `path-guard-grant.test.ts:125/155/189/211` and
`http-server.test.ts:414-431` (mid-test unsets paired with beforeEach/afterEach
save-restore), and `page-store.test.ts`'s hand-forged cursors (the codec is
module-private; test-only exports were rejected as net-additive).

## Finding 3 — stop-reason precedence duplicated, citing a deleted class

The cap-beats-same-iteration-abort ternary appears at `search.ts:317-318` and
`:417-418`; `search.ts:315` cites `StopReasonTracker` — a class deleted in
`c12f089c` (confirmed `git log -S StopReasonTracker`). `hitMaxResults` /
`hitAbort` / `hitMaxFiles` at `concurrency.ts:12`, `search.ts:201-202`, `:383`
are comment-only names of the same dead class. No test pins the precedence.

Refuted candidates (do not reopen without new evidence): settings getters
(recorded design, `config.ts:1-8` + commit `b24f50c3`); search-sweep/binary
unification (per-site policies documented, `plans/001`, `plans/006`); registry
`releaseAll` (one-line loops, per-lease identity deferred by
`watcher-registry.ts:43-49`); cursor codec exports for tests (surface-narrowing
precedent `7a0227f4`).