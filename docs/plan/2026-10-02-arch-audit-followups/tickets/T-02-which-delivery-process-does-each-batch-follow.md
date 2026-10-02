---
kind: frontier-ticket
id: T-02
title: "Which delivery process does each batch follow?"
map: M-01
status: closed
type: grilling
priority: 10
blocked_by: []
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Decide how a delivery task turns a finding into code. Option one: write-plan, then plan-hunt, then run-plan, with one plan per batch in this effort directory. Option two: direct edits test-first through tdd or refactor, then bug-hunt and qc on the diff. A third option is a split by size: findings 1, 6, 7 and 8 edited directly, and findings 2 to 5 planned.

Earlier stacked runs found plan-premise defects in review. The lesson recorded from them: grep every caller before dispatch.

Priority 10: every delivery task waits on this decision.

## Resolution

Decided. The user's answer was "split": the process depends on the size of each finding.

- **Direct**, with test-first edits through tdd or refactor and then bug-hunt and qc on the diff:
  - finding 1 ([Deliver completion roots from getRoots()](T-05-deliver-completion-roots-from-getroots.md))
  - finding 6 ([Deliver one meaning for an omitted maxDepth](T-06-deliver-one-meaning-for-an-omitted-maxdepth.md))
  - finding 7 ([Deliver tightened tools/list budget ceilings](T-11-deliver-tightened-tools-list-budget-ceilings.md))
  - finding 8 ([Amend ADR-001 for the move protection walk](T-03-amend-adr-001-for-the-move-protection-walk.md)), which goes through write-adr instead of tdd because it is documentation only.
- **Planned**, through write-plan, then plan-hunt, then run-plan:
  - findings 2 and 3 (T-07, T-08)
  - findings 4 and 5 (T-10, T-09)

  Following option one's wording, there is one plan per batch. The delete.ts batch gets one plan and the http.ts batch gets one. Each plan sits in this effort directory.

Carried over from the question: grep every caller of a touched function before dispatch or plan-hunt.

Redraw: each open ticket (T-03 through T-21) was read against this answer and recorded unaffected. No ticket names a process in its Question, and the map's Notes already route delivery through this decision. No tickets were created, no fog was cleared, and no edges changed.