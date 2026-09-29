# Bug hunt: SDK audit follow-ups

Reviewed the uncommitted implementation against `bfe5ac37` on 2026-09-29.
Two minor correctness regressions survived the initial green suite; both were
independently blind-refuted and confirmed before returning to implementation.

## Confirmed

### BH1 - Minor: startup consumes the first work tick's rate-limit allowance

- **Site:** [`ProgressSession`](../../../src/tools/progress.ts), the lazy-start
  call followed by the rate-limited positive tick.
- **Trigger:** a default-rate session's first item completes after 100 ms and
  reports `current: 1, total: 2`.
- **Impact:** the peer receives zero without the completed-item count or total,
  although the previous constructor-start behavior admitted the positive tick.
- **Ruled out:** the blind refuter found the startup emission updates the same
  timestamp tested by `if (now - this.#lastSentMs < window) return;`.
  The [executor](../../../src/tools/define.ts#L223-L226) supplies no rate override,
  while the existing unit fixture used zero. Flush cannot recover an event that
  was never enqueued.
- **Fix:** keep startup lazy but exclude its synthetic zero from the work-tick
  throttle budget. Add a deterministic-clock regression with a nonzero limit.

### BH2 - Minor: native cancellation turns raw-read timeouts into cancellation

- **Site:** [`GuardedFileSystem.readRaw`](../../../src/core/fs.ts), its direct
  native read and propagation of the native rejection.
- **Trigger:** a media read's deadline aborts the signal while the native read
  is pending.
- **Impact:** callers receive `CANCELLED` instead of `TIMEOUT` and lose the
  timeout-specific recovery suggestion.
- **Ruled out:** the blind refuter found
  `if (aborted) return Problem.cancelled(message);` precedes timeout handling in
  [the classifier](../../../src/core/errors.ts#L150-L156), and
  [the batch caller](../../../src/tools/batch.ts#L41-L46) classifies that error
  without consulting the signal reason. The final batch abort guard only runs
  for truncated dispatch, not a single already-dispatched file.
- **Runtime uncertainty settled:** a controlled native-boundary probe on Node
  24.15.0 observed native `AbortError`, cause `TimeoutError`, signal reason
  `TimeoutError`, and resulting `CANCELLED`. No file was mutated.
- **Fix:** preserve the supplied signal reason when a native read rejects with
  its cancellation wrapper. Keep native signal propagation, unrelated I/O
  errors, global error precedence, and mutation commit behavior unchanged.

## Suspected

None remaining. BH2 began as runtime-dependent suspicion and was confirmed only
after the controlled probe and separate blind refutation.

## Coverage

The separate reviewer read all twelve changed files in full: five production
modules, six test files, and the changelog. It also read the concurrency/batch
helpers and the plan. Blast-radius reads covered the executor, create/move/delete
confirmation phases, media-read caller, HTTP middleware ordering, server
registration, error classification, path guards, and fixture cleanup.

Both brief tells at the HTTP tests' `void json(res).then(...)` sites were
dismissed: each promise has a rejection handler wired to the awaited/returned
response promise; the unfinished-upload helper also destroys its request and
clears its deadline.

Applicable checks covered contracts, nullability, state/re-entry, failure
classification, concurrency, cleanup, input validation, path authorization,
confirmation-state binding, and header exposure. No changed source/test file
was left unread. Unrelated pre-existing defects, distribution work, historical
plan artifacts, and mutation/post-commit redesign were excluded.

SDK runtime normalization, legacy shim and transport ordering, Express/adapter
header handling, and test-runner isolation were taken on their declared
contracts plus the implementation gates, not dependency-source audits. Browser
tests establish response headers, not an actual browser session.

## QC axis

The separate structure review approved the same diff with no blocking comments
and no qualifying net-deletion move. No source/test file crosses 1,000 lines;
the changelog already exceeded that threshold before this change. Correctness
follow-ups above remain separate from that structural approval.

## 2026-09-29 follow-up review

Both confirmed findings are resolved; no new correctness candidate or suspicion
was found in the follow-up. The separate reviewer retained its prior full-file
coverage and reviewed the changes in the progress/filesystem modules and their
two test files.

- **BH1 resolved:** startup now uses a distinct internal event kind and does
  not update the work-tick timestamp. `SDK-AUDIT-PROGRESS-005` was red with
  `[0]`, then green with `[0, 1]` and the supplied total. Case `006` preserves
  the subsequent throttle and exact 50 ms boundary with `[0, 1, 3]`.
- **BH2 resolved:** native cancellation restores the actual signal reason,
  but only for an `AbortError` with an aborted signal. `SDK-AUDIT-CANCEL-005`
  was red with `CANCELLED`, then green with `TIMEOUT`; case `003` also pins
  abort-reason identity. Case `006` preserves an unrelated native I/O error
  even if the signal aborts concurrently.
- **QC follow-up:** approved, no blocking regression or qualifying net-deletion
  move in the four follow-up files.
- **Final implementation gates:** full repository check exits 0, 529 passed,
  three existing platform skips, zero failures. The reviewer remained static;
  execution results are recorded in [the run log](sdk-audit-followups.run.md).

**Final disposition: no open correctness or structure findings.**
