# ADR-012: The guarded filesystem owns Creation

**Status**: accepted, 2026-11-09
**Deciders**: j0hanz — in the grilling of the Creation candidate from that day's architecture review

## Context

ADR-008 Amendment gave `GuardedFileSystem` the whole **Transfer**; ADR-011 gave
it **Deletion**. **Creation** (see `GLOSSARY.md`) existed as neither a term nor
a lifecycle: `src/tools/create.ts` coordinated it by hand. It planned inline —
`PathGuard.validatePathForWrite` plus `destIdentity` and the folder verdict
(`src/tools/create.ts:190-197`) — and executed inline inside its batch slots —
the write lock, the `sameIdentity` re-check of a pending overwrite, and the
refusal of a file that appeared while the prompt was open
(`src/tools/create.ts:268-290`). The overwrite identity rules sat in three
hand-aligned copies: that block, `executeTransfer`'s destination re-check and
`executeDelete`'s `firstStats` re-check (both in `src/core/fs.ts`). Three
`fix(create)` commits in the preceding month — home-path expansion,
file-directory ancestor collisions, duplicate directories — each had to find
those invariants in the tool layer.

## Decision

`GuardedFileSystem` owns the whole Creation lifecycle, in the same two phases
as Transfer and Deletion:

- **Plan** (`planCreate(path, { append, overwrite })`) makes no mutations and
  classifies the write. An append, or an overwrite the client declared up
  front, destroys nothing and returns a pre-settled plan with no identity
  (a Batch slot taken without mutation). A path that names a directory
  throws `NOT_FILE` at plan, so the refusal lands before the Confirmation
  round — the refusal-before-prompt rule ADR-008 gave the Transfer. A clear
  path returns a plan that execute guards against an entry appearing later.
  A path that would replace an existing file returns a plan sealing the
  **Landing** identity, which the tool passes to the Confirmation.
- **Execute** (`executeCreate(plan)`) takes the write lock, re-checks — a
  pending entry replaced since the plan is refused with `CANCELLED`, and a
  clear entry that appeared since the plan is refused with `CANCELLED` —
  then creates the parent directory and dispatches the write or append,
  with the Capture taken where it is today, inside the write. It returns
  `{ validPath, writtenAt }` only.
- **One-shot** (`create`) runs plan then execute with no Confirmation,
  mirroring `delete`, for non-interactive callers and tests.
- Every file write crosses the seam: append and `overwrite: true` take
  pre-settled plans rather than a side path.
- Directories keep the one-shot `mkdir` in their batch slot: no identity to
  seal, no overwrite question.
- The create tool keeps what ADR-011 left the delete tool: batch policy (the
  schema's duplicate, file-directory-conflict and combined-content rules),
  the Confirmation round and its verdict mapping, and result metadata — the
  post-write stat, MIME sniff, line count and resource links, which are
  transport-aware and best-effort by design.

## Relationship to other ADRs

- **ADR-011**: identical shape; the create tool ends with the same three
  responsibilities the delete tool kept.
- **ADR-007 Addendum** ("each tool keeps its own check") is superseded at
  this seam, as Deletion already superseded it in `executeDelete`: the
  write-time check moves into `GuardedFileSystem`, not into
  `confirmation.ts`, which the addendum still forbids.

## Consequences

- Locality: the overwrite identity rules live in one module; the next
  identity-swap bug is fixed once.
- The folder refusal fires at plan instead of inside the batch, so in a
  mixed call it lands before the user answers rather than after. Message
  and error code are unchanged (`Not a regular file`), and no advertised
  surface changes, so the contract snapshot does not either.
- Creation invariants — identity swap after approval, appeared-after
  refusal, folder refusal at plan, pre-settled append and overwrite — are
  exercised at `GuardedFileSystem`'s interface in `__tests__/core-fs.test.ts`;
  `__tests__/create.test.ts` keeps the Confirmation flow, batch policy,
  metadata degradation and wire behavior.
- `GLOSSARY.md` gains the **Creation** term.
- **Residual, accepted 2026-11-09:** `executeCreate` releases the write lock
  before the tool reads result metadata, so two symlink-aliased entries in one
  batch can interleave: a result row may report a size from before and a line
  count from after the second entry's append. Writes stay serialized; only
  the reported metadata can mix versions. Fixing it would widen the plan/execute
  interface this record settled on a minimal return.
