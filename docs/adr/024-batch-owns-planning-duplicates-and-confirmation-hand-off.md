# ADR-024: The Batch module owns planning, duplicates and the Confirmation hand-off

**Status**: accepted, 2026-11-23
**Deciders**: j0hanz, in the architecture review of 2026-11-23 (Candidate 1)

## Context

`src/tools/batch.ts` owned only the two ends of a Batch: `planIntoSlots` and
`executeBatchSlots`. Each of `create`, `delete` and `move` hand-wrote the middle:
keying plans through `PathGuard.entryKeys` (with its own single-path skip),
settling duplicates, building Confirmation items, and mapping each verdict to a
slot. `move` did not use `planIntoSlots` at all. One same-Entry rule was fixed
across several tool files in `ee3dd6e7`, `ffef4ee6`, `4ca96851`, `08074d48`
and `9e645207`.

The copies had also drifted apart:

- On a declined Confirmation, `move` cancels the whole call, while `create` and
  `delete` fail only that item, with two different error types.
- On duplicate Landings, `move` fails the later item at plan time, `create`
  waits for the Confirmation when both items are pending overwrites, and
  `delete` collapses repeats that share an identity.

## Decision

`batch.ts` is deepened in place into the Batch plan module. `create`, `delete`
and `move` hand it their items, a per-item plan, the Landing of each plan, a
duplicate policy, a refusal policy and an optional Confirmation item. It plans,
keys, settles duplicates, runs an optional cross-item refusal hook, asks the
Confirmation, and returns either `input_required` or a ready batch that the
tool executes with its own progress offset.

- **Duplicate policies**: `fail` (the first item per Landing proceeds; later
  ones fail at plan time, unless the tool lets the pair land, as `create`
  does for two appends) for `create` and `move`; `collapse` for `delete`
  (exact input repeats drop before planning; respellings that saw one
  identity collapse after it). `create`'s pending-twin rule is dropped: the
  twin of a declined overwrite now reports a duplicate, not CANCELLED.
- **Refusal policies**: `fail call` for `move`, whose description promises
  that a declined overwrite cancels every pair; `fail slot` for `create` and
  `delete`. Each declined item uses `Problem.cancelled`.
- **Cross-item rules** stay with their tool and run through the refusal hook,
  after duplicates settle and before the Confirmation: `move`'s overlap and
  directory-merge checks, `delete`'s nesting check.
- **Up-front repeat check**: one exported function refuses a call whose input
  paths name one entry twice; `create` and `edit` use it.
- **Scope**: `edit` keeps `runOverPaths`; it has no plan and no Confirmation.
- `planIntoSlots` and `cancelMessage` become internal to the module.

ADR-007 still holds: `confirm` keeps its round and no shared round engine is
added. ADR-021 still holds: the key rule stays in `PathGuard`.

## Considered options

- **One refusal policy for every tool.** Rejected: per-item for `move` breaks
  its documented contract, and whole-call for `create` and `delete` throws
  away work a person approved.
- **Keep `create`'s pending-twin rule as a third duplicate policy.** Rejected:
  only `create` would use it, and the twin fails either way.
- **Cross-item rules run by the tool between two module calls.** Rejected:
  widens the interface to two calls.
- **One call that also executes, with a before-execute hook.** Rejected: the
  hook exists only for `create`'s directories.
- **A separate `batch-plan.ts`.** Rejected: two modules for one concept.

## Consequences

- Duplicate, policy and hook cases are tested through the module in
  `__tests__/batch.test.ts` with stub plans over a temp root. The
  `planIntoSlots` and `cancelMessage` tests go, and each tool keeps one wire
  test per policy it uses.
- The changed message for `create`'s declined twin needs a changelog line.
- Input order, not plan completion order, picks the first of two duplicates;
  `delete` and `move` used completion order before.
