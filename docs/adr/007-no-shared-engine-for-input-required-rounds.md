# ADR-007: The Confirmation and the access grant keep their own rounds

**Status**: accepted, 2026-10-28
**Deciders**: j0hanz, in the grilling of the round-engine candidate from that day's architecture review

## Context

Two flows ask the client a question through an `input_required` round: the
**Confirmation** (`confirm()` in
[`confirmation.ts`](../../src/core/confirmation.ts), used by `create`,
`move`/`copy` and `delete`) and the access grant (`pendingRoundTrip` in
[`input-required.ts`](../../src/core/input-required.ts), called only from
`precheckGrant` in [`define.ts`](../../src/tools/define.ts)). The review
proposed one round engine to own both.

A fact-finding pass found they already share everything that is the same:
the state codec and its bind, `buildInputRequired`, `assertCanElicit`,
`confirmKey`, `acceptedContent` and the sealed `reissued` flag. The only
duplicated logic is the dropped-shape reissue, about six lines
(`input-required.ts` and `confirmation.ts`). Every other part of a round
differs on purpose:

- **What is sealed.** The Confirmation seals each entry's identity; the
  grant seals only paths.
- **A mismatch on retry.** The Confirmation asks again, once, about an
  entry replaced while the prompt was open; the grant refuses with
  `INVALID_INPUT` (R9), since a directory has no identity to re-check.
- **What a reissue asks.** The Confirmation re-asks only the unchanged
  entries, under their sealed-index keys; the grant rebuilds every input.
- **Answer shape.** The Confirmation offers a single choice per entry; the
  grant offers a boolean for one directory, a multi-select for several.
- **Refusal.** The Confirmation reports a refusal per entry; the grant
  skips the directory and the path fails closed later.

An engine would need a hook for each difference, so its interface would be
about as wide as its implementation: a shallow module.

## Decision

No shared round engine. Each flow keeps its round. `pendingRoundTrip`
stays where it is: it is a one-caller pass-through, and inlining it into
`define.ts` moves its lines without removing any.

Two Confirmation rules are settled instead:

- A reprompt carries `reissued` forward, so one Confirmation runs three
  rounds at most (fresh, reprompt, reissue, in any order of the last two).
  Before this, a reprompt cleared the flag and allowed a fourth round.
- A reprompt does not re-run the capability gate: the client already
  answered an elicitation in the same call.

## Consequences

- A dropped answer after a reprompt that follows a reissue is a refusal
  (`CANCELLED`), not a fourth round.
- Revisit this decision when a third `input_required` round is needed (a
  new op, or `prompts/get` or `resources/read` eliciting). Three users may
  share enough to justify a seam; two that differ in all but one step do
  not.

## Addendum, 2026-10-28: no write-time check behind the Confirmation

The same review proposed that the Confirmation also own the check made at
write time: an approved entry replaced since is refused. `create`, `move`
and `copy` share about nine lines of it (re-stat, compare, refuse). `delete`
differs on purpose:

- It checks the **Entry** with `lstat`; an overwrite checks the **Landing**.
- A vanished entry follows its `ignoreIfNotExists` contract.
- It re-checks entries that were never pending, for which the Confirmation
  seals no identity.

A check behind the Confirmation would take the view, the vanished-entry
policy, the wording and the result key from each caller: as wide as the
code it hides. Each tool keeps its own check. What differed by accident is
aligned instead: an entry replaced after approval, or one that appeared at
an overwrite's landing during the Confirmation, is refused with
`CANCELLED` in every tool, and `delete` checks every entry type, sockets
and FIFOs included.
