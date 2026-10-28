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
`copyIntoPlace` is private and takes the paths `rename` already validated.
`performRenameWithFallback` is deleted; the move tool calls `rename`.

Every caller of `rename` gets the fallback, including undo's restore
(`world.rename` in `src/core/undo.ts`). A move completed by a copy abandons
the Capture, as a copy does, for the move tool and for undo alike: a
cross-device undo is not recorded yet.

The partial-completion error keeps its code and wording: the code of the
removal error, and the message `Cross-device move of <oldPath>: copy succeeded
but source removal failed (destination holds a copy): …`, where `<oldPath>` is
the source as the caller passed it to `rename`.

Tests force a cross-device rename through the constructor's third argument,
`RawOps`, which swaps the raw `rename` and `rm`. That is the one seam: node's
`fs/promises` in production, a once-failing wrapper in tests. The move tool
has no fake-based test of the fallback any more.

## Consequences

- Locality: a staging or denylist bug on the cross-device path is fixed in
  `fs.ts` alone, and `__tests__/move-exdev.test.ts` exercises the real copy.
- An undo of a move that crossed devices now moves the entry back by copying,
  where it failed with `EXDEV` before.
- A separate `fs.move` beside `rename` would split the fallback again. Do not
  add one; extend `rename`.

[`36253c19`]: https://github.com/j0hanz/filesystem-mcp/commit/36253c19
[`b42a063a`]: https://github.com/j0hanz/filesystem-mcp/commit/b42a063a
[`297392b6`]: https://github.com/j0hanz/filesystem-mcp/commit/297392b6
