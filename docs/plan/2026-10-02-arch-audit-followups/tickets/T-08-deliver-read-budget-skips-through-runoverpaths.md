---
kind: frontier-ticket
id: T-08
title: "Deliver read budget skips through runOverPaths"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-01, T-02, T-04]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Deliver finding 3 ([audit findings](../assets/audit-findings.md#3-read-rebuilds-batch-order-and-summary)). `collectFileBudget` returns one item per path with an optional `skip`, every item goes through `runOverPaths`, and `summarize()` is exported from `batch.ts` and shared with `delete.ts`. `delete` keeps `processInParallel` and its R14 confirmation round.

## Resolution

Delivered. Completion check: the stated move is in the diff; `npm run check` exits 0 (558 tests: 555 pass, 0 fail, 3 skipped); and [PR #47](https://github.com/j0hanz/filesystem-mcp/pull/47) merged to `main` as `c2534b8d` after the user confirmed. CI is green on ubuntu and windows. Net line delta: +41 (281 added, 240 removed across 13 files; the added lines include about 100 lines of new tests). Delivered through [`delete-batch.plan.md`](../delete-batch.plan.md), which plan-hunt passed with zero findings. The run log is [`delete-batch.run.md`](../delete-batch.run.md). Independent code review found no issues.

`collectFileBudget` returns one item per path, with an optional `skip: FsError`. Every item goes through `runOverPaths`, and `summarize()` from `batch.ts` is shared with `delete`. Both visible changes accepted in T-04 are pinned by tests.

Material uncertainty: none. Review noted one edge outside the accepted changes. If a call is aborted between the stat pass and the read pass, a batch whose every file was budget-skipped now ends as cancelled instead of returning its `TOO_LARGE` rows. That only happens on abort, so it was judged acceptable.
