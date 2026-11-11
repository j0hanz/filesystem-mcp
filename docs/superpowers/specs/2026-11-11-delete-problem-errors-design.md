# Delete execution error flow design

## Goal

Remove Delete's conversion from `FsError` to `Problem`, back to `FsError`, and back to `Problem`. Batch already converts thrown failures into per-path results.

## Decisions

- Change only Delete execution. `planPath`, `PlanResult`, and `planIntoSlots` stay unchanged.
- Keep Confirmation verdict mapping and the `DELETE_ERRNOS` versus `DELETE_ERRNOS_NO_CONFIRM` selection in `executePlan`.
- Return successful and skipped outcomes from `executePlan`. Throw `Problem.cancelled` for a refused Confirmation and `Problem.fromUnknown` for an execution failure.
- Let the existing `BatchSlot.run` catch in `executeBatchSlots` receive the thrown `Problem`. Do not reconstruct `FsError` in the slot.
- Keep the existing DELETE custom-suggestion regression. Add a Batch test that proves a thrown non-`Error` `Problem` keeps object identity.
- Keep the MCP tool output and error text unchanged.

## Test scenarios

- An execution `FsError` with a custom suggestion keeps its code and suggestion through DELETE.
- A pending Batch slot that throws a plain `Problem` returns that exact object in the per-path result.
- A skipped directory remains in place and reports `deleted: false`.
- A declined delete reports `CANCELLED` and leaves the directory in place.
- An abort during the protected-file walk reports `CANCELLED`, not `UNKNOWN`.

## Out of scope

- Transfer planning and Batch plan folding.
- Changes to `Problem`, `FsError`, `executeBatchSlots`, or the advertised MCP contract.
- New dependencies, glossary terms, or ADRs.
