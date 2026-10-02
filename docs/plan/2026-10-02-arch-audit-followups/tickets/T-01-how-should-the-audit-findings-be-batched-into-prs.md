---
kind: frontier-ticket
id: T-01
title: "How should the audit findings be batched into PRs?"
map: M-01
status: closed
type: grilling
priority: 10
blocked_by: []
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

The user chose "batches by shared file". Shared test files chain five findings into one transitive batch:

- `src/tools/delete.ts`: findings 2 and 3
- `__tests__/input-required.test.ts`: findings 2 and 4
- `src/transport/http.ts`: findings 4 and 5
- `__tests__/tools.test.ts`: findings 4 and 7

Findings 1, 6 and 8 share no files with any other finding.

Decide between two options. Option one: a single batch for findings 2, 3, 4, 5 and 7. Option two: batches keyed by production file only, with test-file overlaps landed in order and rebased between merges. Also decide the order the batches merge in. See [audit findings](../assets/audit-findings.md).

Priority 10: every delivery task and every batch merge task waits on this decision.

## Resolution

Decided. The user's answer was "B": batches keyed by production file only. Test-file overlaps land in order and get rebased between merges. There are six batches, one PR each:

| Batch | Findings | Shared production file | Delivery tickets |
| :---- | :------- | :--------------------- | :--------------- |
| delete.ts | 2, 3 | `src/tools/delete.ts` | T-07, T-08 |
| http.ts | 4, 5 | `src/transport/http.ts` | T-10, T-09 |
| tools/list budget | 7 | — | T-11 |
| completion roots | 1 | — | T-05 |
| maxDepth | 6 | — | T-06 |
| ADR-001 amendment | 8 | — | T-03 |

The chain delete.ts → http.ts → tools/list budget remains through the test files. `__tests__/input-required.test.ts` is shared by findings 2 and 4, and `__tests__/tools.test.ts` by findings 4 and 7. Re-checked on `main`: the tests for finding 5 live in `stdio.test.ts` and `http-server.test.ts`, which no other finding touches.

Material uncertainty: the user did not answer the merge-order half of this question. It reopens as [In what order do the batch PRs merge?](T-15-in-what-order-do-the-batch-prs-merge.md). The recommendation on the table is delete.ts → http.ts → tools/list budget, with the rest merging in any order. Under that order, finding 7's ceilings are measured last.

Redraw: T-15 through T-21 were created through the barrier, and the batch-merge fog was cleared. Each open ticket was read against this answer and recorded unaffected: T-02 through T-13, none edited or re-blocked. T-03 had only T-01 as a blocker, so it is now on the frontier.