---
kind: frontier-ticket
id: T-13
title: "Should confirmation context be PendingCtx alone or include readPendingChoice?"
map: M-01
status: closed
type: grilling
priority: 100
blocked_by: []
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Finding 2 ([audit findings](../assets/audit-findings.md#2-confirmation-context-threaded-by-hand-at-seven-sites)). Both pricers agree on a structural `PendingCtx` in `src/core/input-required.ts`, taken by `pendingRoundTrip` and `describeRefusal(ctx, key)`.

They disagree on adding `readPendingChoice(ctx, sorted, path, verb)`, which returns `'proceed' | 'skip' | refusal text`. In favour: it keeps the key format and the dropped-keys knowledge inside `input-required.ts`. Against: the union mixes two kinds of string; create and move fail with `FsError` while delete returns `Problem.cancelled`; and it saves about one line per site.

Decide: `PendingCtx` alone, or `PendingCtx` plus `readPendingChoice`.

## Resolution

Decided. The user's answer was "alone": `PendingCtx` with no `readPendingChoice`. `src/core/input-required.ts` declares a structural `PendingCtx`. `pendingRoundTrip` and `describeRefusal(ctx, key)` take it, and `ToolCtx` satisfies it, so core imports nothing from tools. Each call site keeps reading its own choice, along with its own failure shape: `FsError` in create and move, and `Problem.cancelled` in delete.

Rejected: `readPendingChoice`. Its `'proceed' | 'skip' | refusal text` union mixes two kinds of string. It would also hide the sites' different failure shapes, and it saves about one line per site.

Redraw: [Deliver PendingCtx for the confirmation hand-off](T-07-deliver-pendingctx-for-the-confirmation-hand-off.md) is now unblocked; its Question already defers to this ticket. Every other open ticket was read against this answer and recorded unaffected. No tickets were created and no fog changed.