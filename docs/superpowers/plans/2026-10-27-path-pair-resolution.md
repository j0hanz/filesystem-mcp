# Path pair resolution implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the "where does this transfer land, and is it a respelling or a
self-move?" rule one home in `PathGuard`, so `GuardedFileSystem.rename` and the
move tool stop carrying their own copies, and fix the direct-`rename` inputs on
which the copies disagree.

**Architecture:** `PathGuard.resolveTransferDestination(destination, source)`
takes the source's entry and landing (the caller derives them: the move tool
through its descriptor-verified `fs.stat`, a copy with both set to the landing)
and returns the destination to act on plus a verdict: `distinct`, `respelling`
or `self`. The rule is the move tool's (`move.ts` `planTransfer`), moved
verbatim. `PathGuard.entryLockKey(path)` owns the "entry, else landing" lock-key
fallback that `lockPairForWrite` and the undo preview's `#locked` both copy.
`respellSpellingOnlyTarget` becomes private to `path.ts`. Terms: `GLOSSARY.md`
(entry, landing, respelling, self-move).

**Tech Stack:** TypeScript, Node built-in test runner.

## Behavior change (Task 1 only)

A direct `GuardedFileSystem.rename` adopts the move tool's self-move rule:

- `rename(F, L)`, L a separate link to F: today a no-op `fsRename(F, F)`, or,
  when L's name is a Unicode/case variant of F's, F renames over the link. After:
  a self-move, nothing happens and no undo record is pushed.
- `rename(L, F)`, L a link to F: today F is replaced by the link. After: a
  self-move.

No current caller sends either input (the move tool skips both as `noop` before
it reaches `rename`), so tool behavior is unchanged.

## Out of scope

- `cp` keeps its two single-view validations: it does no respelling, so the
  pair resolution gives it nothing.
- The single-view validators (`validatePathForWrite`, `validatePathForDelete`)
  stay public and keep their names.

## Tasks

### Task 1: self-move in `rename`

- [ ] Add to `__tests__/unicode-paths.test.ts` (`through the tools`):
      `rename onto a separate link to the source changes nothing` (F = `NBSP_NAME`,
      L = `ASCII_NAME` linking to F) and `rename of a link onto its own target
changes nothing`. Run; both fail.
- [ ] In `GuardedFileSystem.rename`, derive the old path's landing and return
      before any capture or `fsRename` when the move tool's `isSelf` rule holds.
- [ ] Run the two tests and `undo.test.ts`; commit
      `fix(fs): treat a rename that lands on its source as a self-move`.

### Task 2: `PathGuard.resolveTransferDestination`

- [ ] Add the method and `TransferKind` to `src/core/path.ts`; move
      `respellSpellingOnlyTarget` in as a module-private function.
- [ ] Port TC-PH-009/010/011/014 from `path-helpers.test.ts` to PathGuard tests
      over a temp root (`unicode-paths.test.ts`, `PathGuard` block), keeping the ids.
- [ ] Switch `move.ts` `planTransfer` and `fs.ts` `rename` to it.

### Task 3: `PathGuard.entryLockKey`

- [ ] Add the method; tests: a link is keyed as the link, a path whose parent
      is missing falls back to its landing.
- [ ] Switch `fs.ts` `lockPairForWrite` and `undo.ts` `#locked` to it.

### Task 4: verify

- [ ] `npm run check`; commit `refactor(path): give the transfer destination
rule one home in PathGuard`.
