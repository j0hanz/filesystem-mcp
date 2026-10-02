---
kind: frontier-map
id: M-01
title: Fix the 2026-10-02 architecture audit findings
status: closed
created: 2026-10-02T00:00:00Z
---

## Destination

All 8 findings from the 2026-10-02 architecture audit are on `main`.
Findings 1–7 change code or tests, and finding 8 amends ADR-001. They land
in batches grouped by shared file, each merged with `npm run check` green.

## Notes

- Scope source: [audit findings](assets/audit-findings.md), audited at
  `72d448ea`. Line numbers drift, so re-grep before every edit.
- Skills every session consults: `grilling` for decision tickets,
  `research` for research tickets, `write-adr` for finding 8. Each delivery
  task uses the process the batching and process decisions settle.
- Standing preferences:
  - Never hand-edit versions (`AGENTS.md`).
  - The release type is the user's call.
  - Grep every caller of a touched function before dispatch.
  - Commits and pushes need the user's go-ahead, and so does every merge.
- Shared-file overlaps that drive batching:
  - `delete.ts`: findings 2 and 3
  - `input-required.test.ts`: findings 2 and 4
  - `http.ts`: findings 4 and 5
  - `tools.test.ts`: findings 4 and 7

### Execution contract

- Scope: the move each finding states in
  [audit findings](assets/audit-findings.md), as refined by this map's
  decision tickets, and nothing beyond it.
- Completion: the stated move is present in the diff, `npm run check` exits
  0, and the batch PR carrying it is merged to `main` with the user's
  confirmation.
- Evidence: the task ticket's Resolution records the `npm run check` result
  (test counts), the net line delta, and the PR link.

## Decisions so far

- [How should the audit findings be batched into PRs?](tickets/T-01-how-should-the-audit-findings-be-batched-into-prs.md) — By production file, in six PRs: {2,3} delete.ts, {4,5} http.ts, {7}, {1}, {6}, {8}. Test-file overlaps are rebased between merges, and the merge order is open in T-15.
- [Which delivery process does each batch follow?](tickets/T-02-which-delivery-process-does-each-batch-follow.md) — Split by size. Findings 1, 6, 7 and 8 are edited directly, through tdd or refactor, then bug-hunt and qc. Findings 2–5 get one plan per batch, through write-plan, plan-hunt and run-plan.
- [Amend ADR-001 for the move protection walk](tickets/T-03-amend-adr-001-for-the-move-protection-walk.md) — Delivered in #44: a dated amendment names the move protection walk as an internal `skipIgnored: false` exception.
- [Merge the ADR-001 amendment batch (finding 8)](tickets/T-16-merge-the-adr-001-amendment-batch-finding-8.md) — Delivered: #44 merged as `211adaed`, check green, +7 lines.
- [Deliver completion roots from getRoots()](tickets/T-05-deliver-completion-roots-from-getroots.md) — Delivered in #45: `suggestPaths` picks and lists roots from `getRoots()`, and an aliased root completes as one.
- [Merge the completion roots batch (finding 1)](tickets/T-17-merge-the-completion-roots-batch-finding-1.md) — Delivered: #45 merged as `71b1098e`, check green, +24 lines.
- [Are the two visible read-budget changes acceptable?](tickets/T-04-are-the-two-visible-read-budget-changes-acceptable.md) — Accepted, both: the default `TOO_LARGE` suggestion on budget skips, and a progress total counting every requested path.
- [Should an omitted maxDepth mean unlimited or a shared cap?](tickets/T-12-should-an-omitted-maxdepth-mean-unlimited-or-a-shared-cap.md) — Unlimited everywhere: `search.ts` forwards `maxDepth` only when set, and the schema stays "omit for unlimited".
- [Should confirmation context be PendingCtx alone or include readPendingChoice?](tickets/T-13-should-confirmation-context-be-pendingctx-alone-or-include-r.md) — `PendingCtx` alone. Each site keeps reading its own choice and its own failure shape.
- [Deliver one meaning for an omitted maxDepth](tickets/T-06-deliver-one-meaning-for-an-omitted-maxdepth.md) — Delivered in #46: `search.ts` forwards `maxDepth` only when set, and a new test pins an omitted depth as unlimited in all three walks.
- [Merge the maxDepth batch (finding 6)](tickets/T-20-merge-the-maxdepth-batch-finding-6.md) — Delivered: #46 merged as `fada7b47`, check green, +46 lines.
- [In what order do the batch PRs merge?](tickets/T-15-in-what-order-do-the-batch-prs-merge.md) — A fixed chain: #47 (delete.ts), then #48 (http.ts) rebased, then finding 7 measured last on the final base.
- [Deliver PendingCtx for the confirmation hand-off](tickets/T-07-deliver-pendingctx-for-the-confirmation-hand-off.md) — Delivered in #47: a structural `PendingCtx` replaces the four hand-threaded fields at seven sites.
- [Deliver read budget skips through runOverPaths](tickets/T-08-deliver-read-budget-skips-through-runoverpaths.md) — Delivered in #47: every read path is a batch item, and `summarize()` is shared with delete.
- [Merge the delete.ts batch (findings 2 and 3)](tickets/T-18-merge-the-delete-ts-batch-findings-2-and-3.md) — Delivered: #47 merged as `c2534b8d`, check green, +41 lines.
- [Deliver the per-request dispose hook in createServer](tickets/T-10-deliver-the-per-request-dispose-hook-in-createserver.md) — Delivered in #48: `createServer` chains `onclose` to its own dispose, and the copies are gone.
- [Deliver the listen cap pre-check in prepareListenWatchers](tickets/T-09-deliver-the-listen-cap-pre-check-in-preparelistenwatchers.md) — Delivered in #48: both legs share the pre-check and the HTTP wording.
- [Merge the http.ts batch (findings 4 and 5)](tickets/T-19-merge-the-http-ts-batch-findings-4-and-5.md) — Delivered: #48 merged as `3168aa41` after the rebase, check green, +91 lines.
- [Deliver tightened tools/list budget ceilings](tickets/T-11-deliver-tightened-tools-list-budget-ceilings.md) — Delivered in #49: the ceilings are 18,500 and 9,150 against a measured 18,154 and 8,950, and the vacuous assert is gone.
- [Merge the tools/list budget batch (finding 7)](tickets/T-21-merge-the-tools-list-budget-batch-finding-7.md) — Delivered: #49 merged as `31d4c49a`, check green, −15 lines.
- [Why does search.ts cap an omitted maxDepth at 100, and what does an unbounded walk risk?](tickets/T-14-why-does-search-ts-cap-an-omitted-maxdepth-at-100-and-what-d.md) — The cap is an unrecorded stand-in from `71fb2074`, not a cycle guard (`**` never follows symlinks). The 5 s deadline and the result caps are the real bounds.

## Not yet specified

_None._

## Out of scope

- A non-yielding walk overruns the cooperative 5 s deadline, because `fs.glob` gets no signal (surfaced by T-14). This is a new defect beyond this map's 8 findings, and a candidate for a separate effort.

- Releasing these changes. A version bump runs through the Release workflow,
  on the user's call.

## Superseded

_None._

## Closure record

Closed 2026-10-02. The destination is reached: all 8 audit findings are on `main`. Findings 1–7 changed code or tests, and finding 8 amended ADR-001. They landed in six batches by shared file, and each merge had `npm run check` green and CI green on ubuntu and windows.

| Batch | Findings | PR | Merge commit |
| :-- | :-- | :-- | :-- |
| ADR-001 amendment | 8 | [#44](https://github.com/j0hanz/filesystem-mcp/pull/44) | `211adaed` |
| completion roots | 1 | [#45](https://github.com/j0hanz/filesystem-mcp/pull/45) | `71b1098e` |
| maxDepth | 6 | [#46](https://github.com/j0hanz/filesystem-mcp/pull/46) | `fada7b47` |
| delete.ts | 2, 3 | [#47](https://github.com/j0hanz/filesystem-mcp/pull/47) | `c2534b8d` |
| http.ts | 4, 5 | [#48](https://github.com/j0hanz/filesystem-mcp/pull/48) | `3168aa41` |
| tools/list budget | 7 | [#49](https://github.com/j0hanz/filesystem-mcp/pull/49) | `31d4c49a` |

Execution-contract evidence lives in each Delivered ticket's Resolution: test counts, net line delta, and PR link. Final `main` (`31d4c49a`) passes `npm run check` with 561 tests: 558 pass, 0 fail, 3 skipped. The planned batches carry their plan, plan-hunt report, and run log beside this map: [`delete-batch.plan.md`](delete-batch.plan.md) and [`http-batch.plan.md`](http-batch.plan.md).

Next handoff: none is needed for the destination. Nothing is left to specify or plan. Two follow-ons sit outside this map:

- **Release:** whether and how to version these changes is the user's call, through the Release workflow.
- **A new effort:** the out-of-scope defect that a non-yielding `fs.glob` walk overruns the cooperative 5 s deadline. It would start with write-specs or a fresh frontier map.

No ADR handoff: finding 8's ADR-001 amendment is already recorded. The other decisions (an omitted `maxDepth` means unlimited, and `PendingCtx` alone) are fixed in code, in tests, and in the schema's existing wording.