---
kind: frontier-ticket
id: T-18
title: "Merge the delete.ts batch (findings 2 and 3)"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-02, T-15]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Batch: findings 2 and 3, which share `src/tools/delete.ts`. Delivery tickets: [Deliver PendingCtx for the confirmation hand-off](T-07-deliver-pendingctx-for-the-confirmation-hand-off.md) and [Deliver read budget skips through runOverPaths](T-08-deliver-read-budget-skips-through-runoverpaths.md). It shares `__tests__/input-required.test.ts` with the http.ts batch, so it merges in the order T-15 sets.

Open this batch's PR from the branch carrying its delivery tickets' diffs. Merge it to `main` once `npm run check` is green and the user confirms. Rebase onto `main` first if an earlier batch in the merge order has landed. Record the PR link, the `npm run check` test counts, and the net line delta in the Resolution. Copy the same evidence into each delivery ticket the batch carries, then close them together: under the execution contract, a delivery ticket counts as Delivered only once its PR merges.

A delivery ticket is not a `blocked_by` edge here. Its completion check needs this merge, so an edge would deadlock. Start this ticket only once every listed delivery ticket's diff is ready on the batch branch.

## Resolution

Delivered. Completion check: the stated move is in the diff; `npm run check` exits 0 (558 tests: 555 pass, 0 fail, 3 skipped); and [PR #47](https://github.com/j0hanz/filesystem-mcp/pull/47) merged to `main` as `c2534b8d` after the user confirmed. CI is green on ubuntu and windows. Net line delta: +41 (281 added, 240 removed across 13 files; the added lines include about 100 lines of new tests). Delivered through [`delete-batch.plan.md`](../delete-batch.plan.md), which plan-hunt passed with zero findings. The run log is [`delete-batch.run.md`](../delete-batch.run.md). Independent code review found no issues.

This batch carried T-07 and T-08, which closed with the same evidence. It merged first in the T-15 chain.
