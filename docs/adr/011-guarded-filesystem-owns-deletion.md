# ADR-011: The guarded filesystem owns Deletion

**Status**: accepted, 2026-11-08
**Deciders**: j0hanz, in the architecture review of guarded deletion

## Context

ADR-008 Amendment (2026-11-02) gave `GuardedFileSystem` complete ownership of
the **Transfer** (move and copy) in two phases: `planTransfer` and
`executeTransfer`. That eliminated duplicate path validation, closed read-only
bypass gaps, and reduced `src/tools/move.ts` to batch policy, Confirmation
elicitation, and response reporting.

Guarded deletion remained split across the seam. `src/tools/delete.ts`
coordinated path validation (`PathGuard.validatePathForDelete`), root protection
checks (`PathGuard.isAllowedRoot`), metadata inspection (`fs.lstat`), directory
population checks (`fs.hasChildrenUnchecked`), sensitive-file policy checks
(`fs.holdsProtectedEntry`), and write-time replacement verification
(`sameIdentity`). `GuardedFileSystem.rm` was a shallow wrapper that merely
captured an undo snapshot before invoking the raw syscall.

Testing deletion required either driving the full tool harness or stubbing five
separate inspection methods on `GuardedFileSystem`. Furthermore, the workspace
root deletion refusal was enforced in tool code rather than as a core filesystem
invariant.

## Decision

`GuardedFileSystem` owns the complete **Deletion** lifecycle (see `GLOSSARY.md`),
mirroring the Transfer pattern established in ADR-008 Amendment:

- **Plan** (`planDelete`) validates the path, enforces the workspace root
  refusal, inspects entry type, and checks whether a directory has children or
  holds protected entries. It makes no mutations. If `ignoreIfNotExists` is set
  and the path is missing, it returns a plan marked `noop: true`.
- **Execute** (`executeDelete`) re-checks the entry's identity via `lstat` against
  what the plan saw. An entry replaced while a Confirmation was open is refused
  with `FsError(ErrorCode.CANCELLED, ...)`. It then dispatches the appropriate
  removal (`rmdir` for non-recursive directories, `rm` for files, links, or
  recursive directory trees) along with the corresponding undo capture.
- **One-shot delete** (`delete`) runs `planDelete` followed by `executeDelete`
  for non-interactive callers and tests.
- **The delete tool** (`src/tools/delete.ts`) retains only batch deduplication,
  the user Confirmation round-trip, and response reporting.
- **Inspection primitives become private**: `hasChildrenUnchecked` and
  `holdsProtectedEntry` are internal implementation details of
  `GuardedFileSystem`.

## Relationship to other ADRs

- **ADR-007 (Confirmation rounds)**: ADR-007 Addendum rejected placing write-time
  checks behind `confirmation.ts`. This decision respects that boundary: the
  Confirmation round stays in the tool layer, while write-time verification
  lives inside `GuardedFileSystem.executeDelete`, precisely matching
  `GuardedFileSystem.executeTransfer`.
- **ADR-008 Amendment (Transfer)**: Deletion adopts the identical two-phase
  planning and execution model.

## Consequences

- Locality: all filesystem mutation lifecycles (Transfer, Rewrite, Deletion)
  now reside in `GuardedFileSystem`.
- The public interface of `GuardedFileSystem` shrinks by removing public
  exposure of `hasChildrenUnchecked` and `holdsProtectedEntry`.
- Tests can exercise deletion invariants (root refusal, non-empty confirmation
  requirements, sensitive-file refusal, and write-time identity swap detection)
  directly at `GuardedFileSystem`'s interface without instantiating MCP tool
  wrappers.
