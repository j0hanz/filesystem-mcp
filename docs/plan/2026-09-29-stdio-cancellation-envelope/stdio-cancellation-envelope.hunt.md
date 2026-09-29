# Bug hunt: Stdio cancellation envelopes

## 2026-09-29 - zero findings

**Verdict:** no remaining correctness defect found in the scoped change.
The method-first SDK guard prevents request-shaped cancellations from
changing local subscription state while preserving genuine notifications.

Reviewed the unstaged implementation against `105fb972`, following
[the plan](stdio-cancellation-envelope.plan.md). This was an in-thread,
static correctness review. No candidate remained to send to a blind
refuter; no independent correctness-agent review is claimed.

## Confirmed

None.

## Suspected

None.

## Checks resolved

- **Envelope and ID handling:** the new
  [guard](../../../src/transport/stdio.ts#L42-L52) follows the cheap method
  check. Failed validation returns `null`, not a truthy/falsy ID decision.
  Numeric `0` still reaches the cancellation path when the message is a
  genuine notification.
- **Dispatch and state:** a rejected cancellation falls through the
  [ordinary delivery branch](../../../src/transport/stdio.ts#L264-L289).
  The unchanged [listen parser](../../../src/transport/shared.ts#L58-L65)
  rejects its method without allocating a watcher. The message then reaches
  the SDK without marking a pending listen cancelled or releasing an active
  lease.
- **SDK contract:** the installed
  [notification guard implementation](../../../node_modules/@modelcontextprotocol/server/dist/src-BHSMhZ_W.mjs#L4475)
  uses the JSON-RPC notification schema. The SDK's own
  [stdio cancellation branch](../../../node_modules/@modelcontextprotocol/server/dist/stdio.mjs#L378-L381)
  requires the same guard. No new API, dependency, or wire shape is invented.
- **Regression sensitivity:** the
  [four new cases](../../../__tests__/stdio.test.ts#L614-L731) assert actual
  error codes, original ID types, watcher-capacity behavior, file-update
  delivery, and subsequent genuine cancellation. The queued case correlates
  independent replies by ID rather than relying on their order. The
  [run record](stdio-cancellation-envelope.run.md#steps) records their RED
  failures before the source change and GREEN results afterward.
- **Async brief tells:** the existing
  [timeout promise](../../../__tests__/stdio.test.ts#L33-L39) is a participant
  in `Promise.race`, not an unobserved rejection. The
  [admission chain](../../../src/transport/stdio.ts#L298-L329) ends in a catch
  that releases leases and reports the failure. Neither is introduced by
  this change.
- **Resources and scope:** the new cases use isolated roots and
  `try`/`finally` cleanup, and their response reads are bounded. Production
  lease accounting, shutdown, roots seeding, auth, and filesystem access
  policy are unchanged. No persistence migration or new secret-handling
  path is involved.

## Coverage

Read in full:

- [`src/transport/stdio.ts`](../../../src/transport/stdio.ts), 344 lines.
- [`__tests__/stdio.test.ts`](../../../__tests__/stdio.test.ts), 732 lines.

Blast-radius reads were limited to the relevant contracts:

- [`src/index.ts`](../../../src/index.ts#L110-L122) and the complete
  [`src/transport.ts` facade](../../../src/transport.ts) retain the same
  starter API.
- [`__tests__/dist-smoke.test.ts`](../../../__tests__/dist-smoke.test.ts) and
  [`__tests__/roots-seeding.test.ts`](../../../__tests__/roots-seeding.test.ts)
  were read in full to check the callers named by the brief; their public
  contracts are unchanged.
- [`__tests__/helpers.ts`](../../../__tests__/helpers.ts#L460-L532) was read
  for raw frame delivery, queueing, teardown, and fixture creation.
- [`src/transport/shared.ts`](../../../src/transport/shared.ts#L29-L65) was
  read for rejected-message forwarding and request-ID handling.
- Installed SDK guard and cancellation branches are cited above.

The one changed [changelog entry](../../../CHANGELOG.md#L12) matches the
implementation. Released changelog history, unchanged HTTP/auth/filesystem
subsystems, and the rest of the SDK were not independently re-audited:
they are outside this private-parser change's contract.

No application or test code was executed during this static hunt. Runtime
evidence and verification commands belong to the
[execution log](stdio-cancellation-envelope.run.md#done), which records
Windows results; no new Linux/macOS execution is claimed.
