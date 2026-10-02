---
kind: frontier-ticket
id: T-17
title: "Merge the completion roots batch (finding 1)"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-02]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Batch: finding 1. Delivery ticket: [Deliver completion roots from getRoots()](T-05-deliver-completion-roots-from-getroots.md). This batch is not in the test-file chain.

Open this batch's PR from the branch carrying its delivery tickets' diffs. Merge it to `main` once `npm run check` is green and the user confirms. Rebase onto `main` first if an earlier batch in the merge order has landed. Record the PR link, the `npm run check` test counts, and the net line delta in the Resolution. Copy the same evidence into each delivery ticket the batch carries, then close them together: under the execution contract, a delivery ticket counts as Delivered only once its PR merges.

A delivery ticket is not a `blocked_by` edge here. Its completion check needs this merge, so an edge would deadlock. Start this ticket only once every listed delivery ticket's diff is ready on the batch branch.

## Resolution

Delivered. Completion check: the stated move is in the diff; `npm run check` exits 0 (551 tests: 548 pass, 0 fail, 3 skipped); and [PR #45](https://github.com/j0hanz/filesystem-mcp/pull/45) merged to `main` as `71b1098e` after the user confirmed. CI is green on ubuntu and windows. Net line delta: +24 (28 added, 4 removed).

This batch carried [Deliver completion roots from getRoots()](T-05-deliver-completion-roots-from-getroots.md), which closed with the same evidence.

Redraw, after #44 and #45 merged: each open ticket (T-04, T-06 through T-13, T-15, T-18 through T-21) was read against these deliveries and recorded unaffected. Neither PR touches tool descriptions, so T-11's ceilings stand, and neither touches a file in the chain batches. No tickets were created and no fog changed.