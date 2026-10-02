---
kind: frontier-ticket
id: T-11
title: "Deliver tightened tools/list budget ceilings"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-01, T-02]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Deliver finding 7 ([audit findings](../assets/audit-findings.md#7-toolslist-budget-counts-dead-schemas)). Measure `tools/list` on the batch's base, set each ceiling to about 2% above the measurement, rewrite the TOOL-SURFACE-002 comment as a baseline after `f9199c80`, and delete the vacuous `outputSchema?.$defs` assert.

## Resolution

Delivered. Completion check: the stated move is in the diff; `npm run check` exits 0 (561 tests: 558 pass, 0 fail, 3 skipped); and [PR #49](https://github.com/j0hanz/filesystem-mcp/pull/49) merged to `main` as `31d4c49a` under the merge chain the user confirmed in T-15. CI is green on ubuntu and windows. Net line delta: −15 (8 added, 23 removed).

Measured on the final base, after #47 and #48: 18,154 characters full and 8,950 read-only, with no output schemas published. The ceilings were set to 18,500 and 9,150, about 2% above. The comment is now a dated baseline after `f9199c80`. The always-passing `outputSchema?.$defs` assert was deleted; `tools.test.ts:3198-3206` still pins that no tool publishes an output schema.
