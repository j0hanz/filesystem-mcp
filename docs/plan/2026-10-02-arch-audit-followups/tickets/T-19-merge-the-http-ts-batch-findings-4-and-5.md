---
kind: frontier-ticket
id: T-19
title: "Merge the http.ts batch (findings 4 and 5)"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-02, T-15]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Batch: findings 4 and 5, which share `src/transport/http.ts`. Delivery tickets: [Deliver the per-request dispose hook in createServer](T-10-deliver-the-per-request-dispose-hook-in-createserver.md) and [Deliver the listen cap pre-check in prepareListenWatchers](T-09-deliver-the-listen-cap-pre-check-in-preparelistenwatchers.md). It shares `input-required.test.ts` with the delete.ts batch and `tools.test.ts` with the tools/list budget batch, so it merges in the order T-15 sets.

Open this batch's PR from the branch carrying its delivery tickets' diffs. Merge it to `main` once `npm run check` is green and the user confirms. Rebase onto `main` first if an earlier batch in the merge order has landed. Record the PR link, the `npm run check` test counts, and the net line delta in the Resolution. Copy the same evidence into each delivery ticket the batch carries, then close them together: under the execution contract, a delivery ticket counts as Delivered only once its PR merges.

A delivery ticket is not a `blocked_by` edge here. Its completion check needs this merge, so an edge would deadlock. Start this ticket only once every listed delivery ticket's diff is ready on the batch branch.

## Resolution

Delivered. Completion check: the stated move is in the diff; after rebasing onto #47, `npm run check` exits 0 (561 tests: 558 pass, 0 fail, 3 skipped); and [PR #48](https://github.com/j0hanz/filesystem-mcp/pull/48) merged to `main` as `3168aa41` after the user confirmed the chain. CI is green on ubuntu and windows. Net line delta: +91 (139 added, 48 removed across 12 files; most of the added lines are the new disposal and over-cap tests). Delivered through [`http-batch.plan.md`](../http-batch.plan.md); plan-hunt found one defect, which was fixed (`grep` replaced by `git grep`). The run log is [`http-batch.run.md`](../http-batch.run.md). Independent code review found no issues, and the reviewer saw every new test except STDIO-019 fail with its fix disabled; STDIO-019 still passes without the fix.

This batch carried T-10 and T-09, which closed with the same evidence. It merged second in the T-15 chain, after a clean rebase onto #47.

Redraw: T-11 and T-21 now have the final base the T-15 chain names. Every other open ticket was read against this delivery and recorded unaffected.
