---
kind: frontier-ticket
id: T-20
title: "Merge the maxDepth batch (finding 6)"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-02, T-12]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Batch: finding 6. Delivery ticket: [Deliver one meaning for an omitted maxDepth](T-06-deliver-one-meaning-for-an-omitted-maxdepth.md). This batch is not in the test-file chain.

Open this batch's PR from the branch carrying its delivery tickets' diffs. Merge it to `main` once `npm run check` is green and the user confirms. Rebase onto `main` first if an earlier batch in the merge order has landed. Record the PR link, the `npm run check` test counts, and the net line delta in the Resolution. Copy the same evidence into each delivery ticket the batch carries, then close them together: under the execution contract, a delivery ticket counts as Delivered only once its PR merges.

A delivery ticket is not a `blocked_by` edge here. Its completion check needs this merge, so an edge would deadlock. Start this ticket only once every listed delivery ticket's diff is ready on the batch branch.

## Resolution

Delivered. Completion check: the stated move is in the diff; `npm run check` exits 0 (552 tests: 549 pass, 0 fail, 3 skipped); and [PR #46](https://github.com/j0hanz/filesystem-mcp/pull/46) merged to `main` as `fada7b47` after the user confirmed. CI is green on ubuntu and windows. Net line delta: +46 (48 added, 2 removed).

This batch carried [Deliver one meaning for an omitted maxDepth](T-06-deliver-one-meaning-for-an-omitted-maxdepth.md), which closed with the same evidence.

Redraw: each open ticket was read against this delivery and recorded unaffected. `search.ts` lies outside every remaining batch, and the PR changes no tool descriptions, so T-11's ceilings stand.
