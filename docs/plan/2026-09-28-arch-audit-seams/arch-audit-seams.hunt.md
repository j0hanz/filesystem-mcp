# Bug hunt: registrar enforcement and internal forwarding collapses

**Date:** 2026-09-28

**Scope:** current working-tree implementation against `b2a6fac5`

**Verdict:** zero confirmed defects and zero suspected defects in the change.

The highest-risk changed boundary, atomic overwrite, retains its pre-rename
cancellation check, exclusive temporary creation, mode handling, cleanup, and
error propagation. No new failing input path was established.

## Confirmed

None.

## Suspected

None.

## Checks settled

- **Contract migration:** the four callers now pass either string paths or
  complete file entries to
  [runOverPaths](../../../src/tools/batch.ts#L13-L64). Required create
  content remains enforced by its unchanged schema, and edit's unchanged
  schema requires edits in each accepted input mode. No caller still uses
  the removed envelope or optional override.
- **Empty and partial batches:** the executor retains its explicit empty
  input refusal, input-index result slots, per-item error conversion,
  progress tick, and total-failure policy.
  [Read's all-skipped branch](../../../src/tools/read.ts#L423-L432)
  still bypasses the executor. The
  [scheduler](../../../src/core/concurrency.ts#L32-L101) continues to
  distinguish incomplete aborted work from an already completed batch.
- **Mutation semantics:** create retains confirmation before mutation and
  per-item append selection. Edit retains dry-run behavior, validation, and
  metadata handling. Neither callback mutates the original input item.
- **Atomic write:** [writeFile](../../../src/core/fs.ts#L160-L221)
  preserves the previous implementation, with the shared path resolver
  supplied through the instance. Rename is not raced against cancellation.
  No extra stat or metadata operation was introduced after the commit.
- **Boundary regression:** the
  [existing lint rule](../../../eslint.config.mjs#L149-L166) now matches
  both source and emitted import extensions. The
  [new tests](../../../__tests__/registrar-boundaries.test.ts) exercise
  actual ESLint configuration, not a reconstructed regular expression;
  parser errors and ignored contexts cannot produce a false success.
- **Mechanical tells:** the test token at
  [tools.test.ts:200](../../../__tests__/tools.test.ts#L200) is an artificial
  sentinel used to detect disclosure, not a credential. The equality-like
  text at [create.ts:192](../../../src/tools/create.ts#L192) is a comment,
  not a loose-comparison operator.

Logic, null/type safety, edge cases, error handling, concurrency, lifecycle,
state, API contracts, persistence, bounded work, and dependency changes were
considered against the edited paths. The filesystem-facing paths were also
checked for changed validation, permission, replay, disclosure, and
time-of-check/time-of-use behavior. No claim about unrelated pre-existing
repository behavior is made.

## Coverage

All nine changed implementation files were read end to end, including the
untracked new test omitted by ordinary `git diff`:

- [eslint.config.mjs](../../../eslint.config.mjs)
- [registrar-boundaries.test.ts](../../../__tests__/registrar-boundaries.test.ts)
- [tools.test.ts](../../../__tests__/tools.test.ts)
- [batch.ts](../../../src/tools/batch.ts)
- [create.ts](../../../src/tools/create.ts)
- [edit.ts](../../../src/tools/edit.ts)
- [read.ts](../../../src/tools/read.ts)
- [stat.ts](../../../src/tools/stat.ts)
- [fs.ts](../../../src/core/fs.ts)

Blast-radius reads covered relevant contracts and callsites in
[define.ts](../../../src/tools/define.ts),
[schema.ts](../../../src/core/schema.ts),
[concurrency.ts](../../../src/core/concurrency.ts),
[errors.ts](../../../src/core/errors.ts),
[tools/index.ts](../../../src/tools/index.ts),
[instructions.ts](../../../src/instructions.ts),
[resources.ts](../../../src/resources.ts),
[delete.ts](../../../src/tools/delete.ts),
[move.ts](../../../src/tools/move.ts),
[patch.ts](../../../src/tools/patch.ts),
[replace-text.ts](../../../src/tools/replace-text.ts),
[core-fs.test.ts](../../../__tests__/core-fs.test.ts), and
[move-exdev.test.ts](../../../__tests__/move-exdev.test.ts).
The apparent batch caller in the move module is only a comment; its transfer
executor is separate. Other consumers use unchanged filesystem methods,
tool descriptors, or the unchanged total-failure helper.

No changed file was skipped. Unrelated portions of blast-radius files,
generated output, dependencies, release infrastructure, and other efforts
were not audited. Node filesystem semantics, SDK schema dispatch, Zod
validation, and ESLint internals were taken on trust at their API boundaries;
there was no dependency vulnerability audit.

This pass was static: the brief generator inspected metadata, source was
read, and no application or tests were executed during the hunt. Earlier
execution results belong to the [run log](arch-audit-seams.run.md).
No candidate survived to require blind refutation, and no code was edited
by this review.
