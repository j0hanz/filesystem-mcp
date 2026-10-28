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

[`36253c19`]: https://github.com/j0hanz/filesystem-mcp/commit/36253c19
[`b42a063a`]: https://github.com/j0hanz/filesystem-mcp/commit/b42a063a
[`297392b6`]: https://github.com/j0hanz/filesystem-mcp/commit/297392b6
