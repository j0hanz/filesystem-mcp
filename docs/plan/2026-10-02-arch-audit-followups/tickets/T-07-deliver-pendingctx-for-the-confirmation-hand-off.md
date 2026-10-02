---
kind: frontier-ticket
id: T-07
title: "Deliver PendingCtx for the confirmation hand-off"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-01, T-02, T-13]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Deliver finding 2 ([audit findings](../assets/audit-findings.md#2-confirmation-context-threaded-by-hand-at-seven-sites)) in the shape the PendingCtx decision ticket settles. Refusal text must stay byte-identical. The 13 direct calls in `__tests__/input-required.test.ts` change in the same commit.

## Resolution

Delivered. Completion check: the stated move is in the diff; `npm run check` exits 0 (558 tests: 555 pass, 0 fail, 3 skipped); and [PR #47](https://github.com/j0hanz/filesystem-mcp/pull/47) merged to `main` as `c2534b8d` after the user confirmed. CI is green on ubuntu and windows. Net line delta: +41 (281 added, 240 removed across 13 files; the added lines include about 100 lines of new tests). Delivered through [`delete-batch.plan.md`](../delete-batch.plan.md), which plan-hunt passed with zero findings. The run log is [`delete-batch.run.md`](../delete-batch.run.md). Independent code review found no issues.

`PendingCtx` lives in `src/core/input-required.ts`. `pendingRoundTrip(ctx, { op, pending, buildInputs })` and `describeRefusal(ctx, key)` take it at all seven sites and in the 13 test calls. The refusal text is byte-identical, and there is no `readPendingChoice`, per T-13.
