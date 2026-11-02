# ADR-008: The guarded rename owns the cross-device fallback

**Status**: accepted, 2026-10-28
**Deciders**: j0hanz, in the grilling of the cross-device move candidate from that day's architecture review

## Context

A move across devices fails the raw rename with `EXDEV`, so the server copies
the source into place on the destination's device and then removes it. Three
fixes to that path landed in one day ([`36253c19`], [`b42a063a`],
[`297392b6`]), and each had to change both `src/tools/move.ts`, which held
`performRenameWithFallback`, and `src/core/fs.ts`, which held the public
`copyIntoPlace` it called. The tool decided which of `fs.rename` and
`fs.copyIntoPlace` ran, so the Capture decision (record a rename, or abandon
as a copy) was split across the two files as well.

`performRenameWithFallback` was exported from a tool file only so its tests
could reach it, and those tests drove it through a
`Pick<GuardedFileSystem, 'rename' | 'copyIntoPlace' | 'rm'>` of fakes. The
bugs lived in `copyIntoPlace`, which the fakes replaced. By the deletion test
the helper added no depth: deleting it moves its branch into `fs.ts` whole.

## Decision

`GuardedFileSystem.rename` owns the whole move: validation, the self-move and
Respelling rules, the Capture snapshot, the raw rename, and on `EXDEV` the
staged copy, the rename into place and the removal of the source.
`copyIntoPlace` is private; the fallback validates both paths again after the
failed rename, as the public helper did, before it copies.
`performRenameWithFallback` is deleted; the move tool calls `rename`.

A move completed by a copy abandons the Capture, as a copy does: a
cross-device move is not undoable yet. Undo's restore (`world.rename` in
`src/core/undo.ts`) opts out of the fallback and rethrows `EXDEV`: a copy
gives every descendant a new identity, and an older record that tracks one of
them would then read as modified since. The source is validated once more
before the copy is removed, as the guarded `rm` did, so an ancestor swapped
for an out-of-root link during the copy cannot steer the removal outside.

The partial-completion error keeps its code and wording: the code of the
removal error, and the message `Cross-device move of <oldPath>: copy succeeded
but source removal failed (destination holds a copy): …`. `<oldPath>` is the
source as the caller passed it to `rename`: for the move tool that is now the
validated spelling, where it was the client's spelling before. No test or
snapshot pins that label.

Tests force a cross-device rename through the constructor's third argument,
`RawOps`, which swaps the raw `rename` and `rm`. That is the one seam: node's
`fs/promises` in production, a once-failing wrapper in tests. The move tool
has no fake-based test of the fallback any more.

## Consequences

- Locality: a staging or denylist bug on the cross-device path is fixed in
  `fs.ts` alone, and `__tests__/move-exdev.test.ts` exercises the real copy.
- An undo whose source parent became another mount after the move still
  fails with `EXDEV` and changes nothing, as it did before.
- A separate `fs.move` beside `rename` would split the fallback again. Do not
  add one; extend `rename`.

## Amendment, 2026-11-02: the guarded filesystem owns the whole Transfer

**Deciders**: j0hanz, in the grilling of the transfer candidate from that day's
architecture review.

The decision above left the planning half of a move in `src/tools/move.ts`.
`planTransfer` resolved the source views and the destination, and its
`assertTreeHasNoProtectedEntries` walked the tree for the Relocation rule.
`fs.rename` then resolved both ends again, and `#validateMappedDescendants`
walked the tree a second time for the descendant write check. Read-only
bypasses (`e143203b`, `15906452`, `c6d1f2c1`) got in through the gaps
between those copies.

`GuardedFileSystem` now owns the whole **Transfer** (see `GLOSSARY.md`) for
both move and copy, in two phases:

- **Plan** (`planTransfer`) makes no changes. It runs on every round, because
  a Confirmation ends the call and the client re-sends it. No callback is
  held open across the Confirmation (ADR-007).
- **Execute** (`executeTransfer`) re-checks the destination against what the
  plan saw, then renames or copies.
- **One Relocation walk** checks both rules: every entry keeps its protection,
  and every mapped destination passes the write check. It runs at plan, so a
  refusal comes before the Confirmation, and again at execute, which covers
  the gap while the Confirmation was open.
- **No approval flag.** Execute always compares the destination with the plan,
  so no caller can skip the check.
- **`rename` and `cp`** stay as one-shot plan-then-execute calls.
- **The move tool** keeps only batch policy (duplicate and overlapping pairs),
  the Confirmation, and its report.
- **A link source whose target is gone or fails validation stands for
  itself.** The move renames the link and never touches its target. The move
  tool used to refuse a link whose target was outside the roots; it now moves
  the link, as the guarded rename (and undo's restore through it) always did.

Out of scope, not reversed:

- Undo's restore keeps its own Relocation check (`assertTreeKeepsPolicy`),
  because a dry run must walk the preview's tree, not the disk.
- Transfers still take no write lock.
- Read-only stays a containment check in the PathGuard (ADR-010).

The consequence above still holds, now for the Transfer as a whole: do not add
a second module beside it; extend `planTransfer` and `executeTransfer`.

[`36253c19`]: https://github.com/j0hanz/filesystem-mcp/commit/36253c19
[`b42a063a`]: https://github.com/j0hanz/filesystem-mcp/commit/b42a063a
[`297392b6`]: https://github.com/j0hanz/filesystem-mcp/commit/297392b6
