---
kind: frontier-ticket
id: T-15
title: "In what order do the batch PRs merge?"
map: M-01
status: closed
type: grilling
priority: 100
blocked_by: []
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

[How should the audit findings be batched into PRs?](T-01-how-should-the-audit-findings-be-batched-into-prs.md) settled six production-file batches, but the user did not answer its merge-order half. The delete.ts {2,3}, http.ts {4,5} and tools/list budget {7} batches share test files (`input-required.test.ts`: findings 2 and 4; `tools.test.ts`: findings 4 and 7), so whichever lands later rebases.

Decide between two options:

- A fixed chain: delete.ts → http.ts → tools/list budget. Completion roots {1} and ADR-001 {8} merge at any time, and maxDepth {6} merges once T-12 settles. Finding 7's ceilings are then measured after the other batches.
- No fixed order: whichever batch lands second rebases.

Recommended: the fixed chain.

## Resolution

Decided. The user's answer was "proceed recommendation": a fixed chain. The delete.ts batch ([#47](https://github.com/j0hanz/filesystem-mcp/pull/47)) merges first. The http.ts batch ([#48](https://github.com/j0hanz/filesystem-mcp/pull/48)) then rebases onto `main`, passes `npm run check` again, and merges second. The tools/list budget batch (finding 7) is delivered last, on the final base, so its ceilings are measured once. The off-chain batches (findings 1, 6 and 8) had already merged.

Redraw: T-18, T-19 and T-21 are now unblocked, and their Questions already defer to this order. Every other open ticket was read against this answer and recorded unaffected. No tickets were created and no fog changed.