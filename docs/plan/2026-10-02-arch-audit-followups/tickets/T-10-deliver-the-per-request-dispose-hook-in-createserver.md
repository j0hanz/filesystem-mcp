---
kind: frontier-ticket
id: T-10
title: "Deliver the per-request dispose hook in createServer"
map: M-01
status: closed
type: task
priority: 100
blocked_by: [T-01, T-02]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Deliver finding 4 ([audit findings](../assets/audit-findings.md#4-per-request-dispose-hook-copied-and-missed)). `createServer` owns the `onclose` dispose hook and chains any previous handler. Delete the copies in `http.ts` and in the two `input-required.test.ts` factories. Remove the explicit `disposeRuntimeState()` only at connected teardowns, and keep it on the paths that never connect.

## Resolution

Delivered. Completion check: the stated move is in the diff; after rebasing onto #47, `npm run check` exits 0 (561 tests: 558 pass, 0 fail, 3 skipped); and [PR #48](https://github.com/j0hanz/filesystem-mcp/pull/48) merged to `main` as `3168aa41` after the user confirmed the chain. CI is green on ubuntu and windows. Net line delta: +91 (139 added, 48 removed across 12 files; most of the added lines are the new disposal and over-cap tests). Delivered through [`http-batch.plan.md`](../http-batch.plan.md); plan-hunt found one defect, which was fixed (`grep` replaced by `git grep`). The run log is [`http-batch.run.md`](../http-batch.run.md). Independent code review found no issues, and the reviewer saw every new test except STDIO-019 fail with its fix disabled; STDIO-019 still passes without the fix.

`createServer` chains `mcp.server.onclose` to its idempotent `disposeRuntimeState()`. The copies in `http.ts` and the `input-required.test.ts` factories are deleted. Explicit disposes were removed at the four connected teardowns, and the unconnected ones keep theirs. stdio's pinned instance is unaffected: `serveStdio` pins one instance per connection.
