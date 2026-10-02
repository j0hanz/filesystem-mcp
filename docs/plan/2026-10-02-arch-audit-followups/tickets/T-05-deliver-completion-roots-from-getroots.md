---
kind: frontier-ticket
id: T-05
title: "Deliver completion roots from getRoots()"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-01, T-02]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Deliver finding 1 ([audit findings](../assets/audit-findings.md#1-completion-uses-the-containment-set-as-roots)). `suggestPaths` in `src/core/path-completer.ts` reads `getRoots()` to pick, name and list roots, and uses `getAllowedDirectories()` only for containment. Add an aliased-root completion case to `__tests__/aliased-root.test.ts`. Add a one-line note to `plans/011` saying its path-completer entry was superseded by this effort.

## Resolution

Delivered. Completion check: the stated move is in the diff; `npm run check` exits 0 (551 tests: 548 pass, 0 fail, 3 skipped); and [PR #45](https://github.com/j0hanz/filesystem-mcp/pull/45) merged to `main` as `71b1098e` after the user confirmed. CI is green on ubuntu and windows. Net line delta: +24 (28 added, 4 removed).

`suggestPaths` now reads `getRoots()` to pick, name and list roots, and keeps `getAllowedDirectories()` only for `findMatchesInDirectory`. The new case "completes as one root" in `__tests__/aliased-root.test.ts` failed on `main` before the fix: TDD red, then green. `plans/011` carries a note that its path-completer entry is superseded.

Material uncertainty: none. The behavior change is deliberate: a root reached by its realpath spelling is no longer offered as a second root name. An absolute realpath still completes, because the directory listing keeps the containment set.
