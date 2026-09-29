# Run: Rejected cancellation requests preserve stdio subscriptions

Executing [stdio-cancellation-envelope.plan.md](stdio-cancellation-envelope.plan.md),
started 2026-09-29 at `105fb972`.

## Orientation

- Drift check: no changes since the plan's commit in the three implementation
  files. The worktree initially contained only the untracked plan effort.
- No previous run log existed. Starting at step 1.
- Installed guard contract: the plan's runtime assertions exited 0.
- Confirmed seam: the real CLI's stdio JSON-RPC boundary, observed through
  acknowledgements, error responses, resource-update notifications, and
  admission under a one-watcher budget. Cases cover active/queued listens
  with string and numeric-zero IDs; genuine notifications remain compatible.
- No spec requirement IDs are attached to this fix.

## Steps

- **1** 2026-09-29 - done (expected RED). `npm test -- __tests__\stdio.test.ts`
  exited 1: 17 existing cases passed and all four new cases failed because
  listen B was acknowledged after the invalid cancellation. Both active and
  queued scenarios reproduced for string and numeric-zero IDs.
  `npm run type-check:test` exited 0; the failures were behavioral, not
  compilation failures.
- **2** 2026-09-29 - done (GREEN). Added the SDK notification guard after the
  cheap cancellation-method check and added the Unreleased changelog entry.
  `npm test -- __tests__\stdio.test.ts` passed all 21 cases, with zero
  failures, cancellations, or skips. Type checking, scoped ESLint and
  scoped Prettier checks all exited 0. The first lint run rejected the
  response-count loop's index form; changing it to a countdown resolved the
  warning, and all gates passed on rerun.

## Done

| Plan criterion | Evidence |
| --- | --- |
| RED before production change | Step 1: all four new cases failed, while the existing 17 passed; type checking remained green. |
| Both scenario IDs and both ID kinds | STDIO-015 and STDIO-016 each passed for a string target and numeric `0`. |
| Preserve active delivery and queued admission | Both scenarios assert A's acknowledgement, B's capacity refusal, and the resource-update notification for A's exact URI and original ID. |
| Preserve invalid request error correlation | Both scenarios require method-not-found errors with the invalid request's own ID. |
| Preserve genuine cancellation | Each scenario sends a notification without a top-level ID and requires a subsequent listen for B to succeed. |
| Final verification gates | 21/21 stdio tests; no-emit source/test type checking, scoped lint, scoped formatting, and `git diff --check` exit 0. |
| Narrow production diff | Only the SDK runtime import and one method-first guard changed in the stdio implementation. |
| Scope | Implementation changes are limited to the stdio source, its four parameterized regression cases, and one changelog bullet. The existing plan and plan-hunt were not edited during execution. |

## Deviations

No scope or behavioral deviations. The lint-only countdown correction in
step 2 does not change the plan's three-response, order-independent check.

## Review handoff

[Correctness review](stdio-cancellation-envelope.hunt.md): zero confirmed
or suspected findings.

Independent structural QC: approved with no blocking regressions or missed
net-deletion opportunities. The reviewer read the complete stdio source,
stdio test file, and changelog against `105fb972`, checking all six QC
standards. The helper owns the guard, the phase/ID matrix shares substantive
assertions, and no new production indirection or type escape was introduced.

No verify-specs artifact is required: the plan names no spec requirement IDs.
All implementation steps and review handoffs are complete.
