---
kind: frontier-ticket
id: T-06
title: "Deliver one meaning for an omitted maxDepth"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-01, T-02, T-12]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Deliver finding 6 ([audit findings](../assets/audit-findings.md#6-hidden-maxdepth--100-default)) as the maxDepth decision ticket settles it. Add a test that pins the chosen meaning of an omitted `maxDepth` in `search_text`, `find_files` and `replace_text`.

## Resolution

Delivered. Completion check: the stated move is in the diff; `npm run check` exits 0 (552 tests: 549 pass, 0 fail, 3 skipped); and [PR #46](https://github.com/j0hanz/filesystem-mcp/pull/46) merged to `main` as `fada7b47` after the user confirmed. CI is green on ubuntu and windows. Net line delta: +46 (48 added, 2 removed).

`searchContent` and `searchFiles` in `src/core/search.ts` forward `maxDepth` only when it is set. The new `__tests__/omitted-max-depth.test.ts` pins an omitted depth as unlimited in `find_files`, `search_text` and `replace_text`, using a file `MAX_SEARCH_DEPTH + 3` levels deep. It was red on `main` before the fix.

Material uncertainty: none.
