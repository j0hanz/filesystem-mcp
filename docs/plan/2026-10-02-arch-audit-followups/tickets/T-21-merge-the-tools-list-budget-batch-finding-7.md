---
kind: frontier-ticket
id: T-21
title: "Merge the tools/list budget batch (finding 7)"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-02, T-15]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Batch: finding 7. Delivery ticket: [Deliver tightened tools/list budget ceilings](T-11-deliver-tightened-tools-list-budget-ceilings.md). It shares `__tests__/tools.test.ts` with the http.ts batch, so it merges in the order T-15 sets. Measure the ceilings again on the final rebased base before merging.

Open this batch's PR from the branch carrying its delivery tickets' diffs. Merge it to `main` once `npm run check` is green and the user confirms. Rebase onto `main` first if an earlier batch in the merge order has landed. Record the PR link, the `npm run check` test counts, and the net line delta in the Resolution. Copy the same evidence into each delivery ticket the batch carries, then close them together: under the execution contract, a delivery ticket counts as Delivered only once its PR merges.

A delivery ticket is not a `blocked_by` edge here. Its completion check needs this merge, so an edge would deadlock. Start this ticket only once every listed delivery ticket's diff is ready on the batch branch.

## Resolution

Delivered. Completion check: the stated move is in the diff; `npm run check` exits 0 (561 tests: 558 pass, 0 fail, 3 skipped); and [PR #49](https://github.com/j0hanz/filesystem-mcp/pull/49) merged to `main` as `31d4c49a` under the merge chain the user confirmed in T-15. CI is green on ubuntu and windows. Net line delta: −15 (8 added, 23 removed).

This batch carried [Deliver tightened tools/list budget ceilings](T-11-deliver-tightened-tools-list-budget-ceilings.md), which closed with the same evidence. It was the last link in the T-15 chain.

Redraw: no open tickets remain and **Not yet specified** is empty, so the map's closure gate can be evaluated.
