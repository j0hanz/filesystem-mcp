---
kind: frontier-ticket
id: T-09
title: "Deliver the listen cap pre-check in prepareListenWatchers"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-01, T-02]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Deliver finding 5 ([audit findings](../assets/audit-findings.md#5-listen-cap-pre-check-exists-only-on-http)). Move the pre-check, with the HTTP wording, into `prepareListenWatchers` in `src/transport/shared.ts`. Remove the inline block in `http.ts`, update the row in `docs/plan/2026-09-15-sdk-listen-hook/deletion-map.md:15`, and add an over-cap test for both stdio and HTTP. stdio adopts the HTTP error wording.

## Resolution

Delivered. Completion check: the stated move is in the diff; after rebasing onto #47, `npm run check` exits 0 (561 tests: 558 pass, 0 fail, 3 skipped); and [PR #48](https://github.com/j0hanz/filesystem-mcp/pull/48) merged to `main` as `3168aa41` after the user confirmed the chain. CI is green on ubuntu and windows. Net line delta: +91 (139 added, 48 removed across 12 files; most of the added lines are the new disposal and over-cap tests). Delivered through [`http-batch.plan.md`](../http-batch.plan.md); plan-hunt found one defect, which was fixed (`grep` replaced by `git grep`). The run log is [`http-batch.run.md`](../http-batch.run.md). Independent code review found no issues, and the reviewer saw every new test except STDIO-019 fail with its fix disabled; STDIO-019 still passes without the fix.

The listen cap pre-check now opens `prepareListenWatchers`, so stdio adopts the HTTP wording. `MAX_WATCHERS` is gone from `http.ts`, and the deletion map is updated. Audit premise corrected: HTTP already had an over-cap test, which is now tightened. The new stdio tests are STDIO-018 and STDIO-019, renumbered because STDIO-017 was already taken.
