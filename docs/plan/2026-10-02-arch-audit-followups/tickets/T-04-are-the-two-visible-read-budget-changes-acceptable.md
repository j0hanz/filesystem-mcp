---
kind: frontier-ticket
id: T-04
title: "Are the two visible read-budget changes acceptable?"
map: M-01
status: closed
type: grilling
priority: 100
blocked_by: []
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Finding 3 ([audit findings](../assets/audit-findings.md#3-read-rebuilds-batch-order-and-summary)) sends budget-skipped paths through `runOverPaths`. That move makes two visible changes, and no test pins either one:

1. A budget-skipped `TOO_LARGE` result passes through `Problem.fromUnknown` and gains the default suggestion "Use head/tail or line ranges to read partially."
2. The `read` progress total counts every requested path, not only the paths that survive the budget.

Decide whether to accept both changes, or to accept the move only if a change is suppressed. A suppressed change costs lines back and may fail the net-deletion gate.

## Resolution

Decided. The user's answer was "accept": both visible changes ship with finding 3, and neither is suppressed.

1. A budget-skipped `TOO_LARGE` result carries the default suggestion "Use head/tail or line ranges to read partially."
2. The `read` progress total counts every requested path.

Neither change is pinned by a test today. [Deliver read budget skips through runOverPaths](T-08-deliver-read-budget-skips-through-runoverpaths.md) may add tests that pin them.

Redraw: T-08 was waiting only on this ticket and is now unblocked. Every other open ticket was read against this answer and recorded unaffected. No tickets were created and no fog changed.