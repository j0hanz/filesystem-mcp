---
kind: frontier-ticket
id: T-03
title: "Amend ADR-001 for the move protection walk"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-01]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Deliver finding 8 ([audit findings](../assets/audit-findings.md#8-skipignored-false-contradicts-adr-001)) through write-adr. Scope line 46 to tools that translate their public `includeIgnored` input. Add a dated amendment naming `assertTreeHasNoProtectedEntries` in `src/tools/move.ts` as an internal security walk that must pass `skipIgnored: false`. This is documentation only, so it waits only on batching.

## Resolution

Delivered. Completion check: the stated move is in the diff; `npm run check` exits 0 (550 tests: 547 pass, 0 fail, 3 skipped); and [PR #44](https://github.com/j0hanz/filesystem-mcp/pull/44) merged to `main` as `211adaed` after the user confirmed. CI is green on ubuntu and windows. Net line delta: +7.

A dated amendment (2026-10-02) was added to the Consequences of ADR-001 ([`docs/adr/001-one-skipignored-flag-owns-both-exclusion-rules.md`](../../../adr/001-one-skipignored-flag-owns-both-exclusion-rules.md)). It limits the rule "the only form a call site may take" to tools that translate their public `includeIgnored` input. It also names `assertTreeHasNoProtectedEntries` (`move.ts:443`) as an internal walk that must pass `skipIgnored: false`. The Decision text is unchanged, following the repo's convention for dated amendments.
