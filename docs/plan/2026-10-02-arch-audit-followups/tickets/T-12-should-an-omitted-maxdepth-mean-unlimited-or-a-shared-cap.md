---
kind: frontier-ticket
id: T-12
title: "Should an omitted maxDepth mean unlimited or a shared cap?"
map: M-01
status: closed
type: grilling
priority: 100
blocked_by: [T-14]
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Finding 6 ([audit findings](../assets/audit-findings.md#6-hidden-maxdepth--100-default)). Today an omitted `maxDepth` means 100 in `search_text` and `find_files`, and unbounded in `replace_text`. The schema says "omit for unlimited" but caps an explicit value at 100.

Decide between two options:

- Unlimited everywhere: forward `maxDepth` only when set. One file changes, net 0 lines.
- `MAX_SEARCH_DEPTH` in all three walks, with the schema reworded to "omit for 100". Three files change.

This waits on the research ticket for why the cap exists and what an unbounded walk risks.

## Resolution

Decided. The user's answer was "unlimited": an omitted `maxDepth` means an unbounded depth in `search_text`, `find_files`, and `replace_text`. `src/core/search.ts` forwards `maxDepth` only when the caller set it, the way `replace-text.ts` already does. The schema's "omit for unlimited" stays as written, and `MAX_SEARCH_DEPTH` remains only the upper limit for an explicit value.

Evidence: [Why does search.ts cap an omitted maxDepth at 100, and what does an unbounded walk risk?](T-14-why-does-search-ts-cap-an-omitted-maxdepth-at-100-and-what-d.md). The cap was an unrecorded stand-in, `**` never follows symlinks, and the 5 s deadline and the result caps are the real bounds.

Redraw: [Deliver one meaning for an omitted maxDepth](T-06-deliver-one-meaning-for-an-omitted-maxdepth.md) is now unblocked; its Question already defers to this ticket. Every other open ticket was read against this answer and recorded unaffected. No tickets were created and no fog changed.