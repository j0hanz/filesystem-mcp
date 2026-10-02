---
kind: frontier-ticket
id: T-16
title: "Merge the ADR-001 amendment batch (finding 8)"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-02]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Batch: finding 8. Delivery ticket: [Amend ADR-001 for the move protection walk](T-03-amend-adr-001-for-the-move-protection-walk.md). This batch is not in the test-file chain.

Open this batch's PR from the branch carrying its delivery tickets' diffs. Merge it to `main` once `npm run check` is green and the user confirms. Rebase onto `main` first if an earlier batch in the merge order has landed. Record the PR link, the `npm run check` test counts, and the net line delta in the Resolution. Copy the same evidence into each delivery ticket the batch carries, then close them together: under the execution contract, a delivery ticket counts as Delivered only once its PR merges.

A delivery ticket is not a `blocked_by` edge here. Its completion check needs this merge, so an edge would deadlock. Start this ticket only once every listed delivery ticket's diff is ready on the batch branch.

## Resolution

Delivered. Completion check: the stated move is in the diff; `npm run check` exits 0 (550 tests: 547 pass, 0 fail, 3 skipped); and [PR #44](https://github.com/j0hanz/filesystem-mcp/pull/44) merged to `main` as `211adaed` after the user confirmed. CI is green on ubuntu and windows. Net line delta: +7.

This batch carried [Amend ADR-001 for the move protection walk](T-03-amend-adr-001-for-the-move-protection-walk.md), which closed with the same evidence.
