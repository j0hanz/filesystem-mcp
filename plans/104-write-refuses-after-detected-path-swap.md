# Plan 104: A write stops when the undo capture detects a swapped path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/core/fs.ts __tests__/core-fs.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

Before a write replaces a file, the server saves the old bytes for `undo`.
That read goes through a verified open which, on Linux, re-checks that the
opened descriptor is still inside the allowed roots. When a parent directory
was swapped for a symlink that points outside the roots, the re-check throws
`ACCESS_DENIED` ("Path changed under validation ... (TOCTOU)").

The write path catches that error together with ordinary stat failures, logs
it as "cannot read the mode", gives up on undo, and then writes the temp file
and renames it through the swapped parent anyway. The server detected the
attack and then completed it. After this plan the refusal propagates and
nothing is written.

## Current state

`src/core/fs.ts`, method `#writeValid` (lines 1194-1226 at the planned
commit):

```ts
try {
  const existing = await fsStat(validPath);
  existingStats = existing;
  existingMode = existing.mode & 0o777;
  inodeKey = hardLinkKey(existing);
  inPlace = inodeKey !== undefined;
  // ...
  relock = inPlace && !relocked;
  // ...
  if (own.recording && !relock) {
    if (!existing.isFile()) {
      own.abandon('cannot capture a write over a non-regular file');
    } else {
      saved = await saveOld(own, this, validPath, existing);
    }
  }
} catch (error) {
  // ENOENT is the normal new-file case: the default mode is correct there.
  // Anything else (EACCES, EIO) means the mode about to be overwritten could
  // not be read, and the write will silently widen the file — say so rather
  // than swallowing it.
  if (!isNotFoundErrno(error)) {
    Logger.warn(
      `atomicWriteFile: cannot read the mode of ${validPath}, so the write uses the default mode:${formatUnknownErrorMessage(error)}`,
    );
    own.abandon('could not read the old content');
  }
}
```

`saveOld` (`src/core/undo.ts:547-561`) calls `fs.readSaved(path)`.
`readSaved` (`src/core/fs.ts:567-570`) is a **public** method that opens
through `#openVerified`, which calls `#assertFdWithinRoots`
(`src/core/fs.ts:365-388`). That method throws:

```ts
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Path changed under validation and now resolves outside the allowed roots (TOCTOU).',
        requestedPath,
```

`fs.ts` already imports `ErrorCode`, `FsError` and `isFsError` from
`./errors.ts`. `FsError` has a `.code` property holding an `ErrorCode`.

Test conventions (`__tests__/core-fs.test.ts`): Node's built-in runner,
`node:assert/strict`, `mock` from `node:test`. A capturing filesystem is built
like this (line 612-618):

```ts
const journal = new UndoJournal(1024 * 1024);
const cap = journal.beginCapture();
const tracked = new GuardedFileSystem(ctx.pathGuard, cap);
await tracked.writeFile(path, text);
```

`fsErrorMatcher(ErrorCode.X, message?)` from `__tests__/helpers.ts` is the
matcher used with `assert.rejects`.

## Commands you will need

| Purpose          | Command                                                      | Expected on success |
| :--------------- | :----------------------------------------------------------- | :------------------ |
| Build            | `npm run build`                                              | exit 0              |
| Type-check tests | `npm run type-check:test`                                    | exit 0              |
| Lint             | `npm run lint`                                               | exit 0              |
| One test file    | `node --test --test-timeout=60000 __tests__/core-fs.test.ts` | all pass            |
| Full check       | `npm run check`                                              | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/fs.ts` (the catch block shown above, nothing else)
- `__tests__/core-fs.test.ts` (one new test)
- `CHANGELOG.md` (one line under `## [Unreleased]`)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):

- `src/core/undo.ts`: `saveOld` is correct; it should keep throwing.
- The in-place (hard-link) branch and the rename branch below the catch.
- `appendFile` and every other method of `GuardedFileSystem`.

## Git workflow

- Branch: `fix/write-refuses-after-path-swap`
- One commit. Message style is conventional commits, for example
  `fix(fs): serialize hard-linked writes, rewrites, appends, and undo captures by inode`.
  Use: `fix(fs): stop a write when the undo capture detects a swapped path`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing test

In `__tests__/core-fs.test.ts`, inside the top-level `describe` that owns
`TC-FUNC-047e` (search for `TC-FUNC-047e`), add a test after it:

- Create a file with `writeTestFile(tmpDir, 'swap_refused.txt', 'old\n')`.
- Build `const cap = new UndoJournal(1024 * 1024).beginCapture();` and
  `const tracked = new GuardedFileSystem(ctx.pathGuard, cap);`.
- Replace `readSaved` on that instance so it throws what the descriptor
  re-check throws:
  `mock.method(tracked, 'readSaved', async () => { throw new FsError(ErrorCode.ACCESS_DENIED, 'Path changed under validation and now resolves outside the allowed roots (TOCTOU).', filePath); });`
- Assert `await assert.rejects(tracked.writeFile(filePath, 'new\n'), fsErrorMatcher(ErrorCode.ACCESS_DENIED, 'TOCTOU'));`
- Assert the file still reads `'old\n'`.
- Assert no sibling whose name starts with `swap_refused.txt.` exists (same
  `readdir(dirname(filePath))` filter that `TC-FUNC-047e` uses).
- Call `mock.restoreAll()` in a `finally`.

**Verify**: `node --test --test-timeout=60000 --test-name-pattern="swap" __tests__/core-fs.test.ts`
→ the new test FAILS (the write succeeds and the file reads `new\n`).

### Step 2: Rethrow the guard's refusals

In the catch block shown in "Current state", add as its first statement:

```ts
// A refusal from the capture's verified read (a parent swapped for a link) is not a stat failure: stop the write.
if (
  isFsError(error) &&
  (error.code === ErrorCode.ACCESS_DENIED || error.code === ErrorCode.SYMLINK_NOT_ALLOWED)
) {
  throw error;
}
```

Leave the rest of the catch unchanged.

**Verify**: `node --test --test-timeout=60000 __tests__/core-fs.test.ts` → all
pass, including the new test.

### Step 3: Changelog

Under `## [Unreleased]` in `CHANGELOG.md`, add a `### Security` heading if it
is not there (place it before `### Changed`) and one bullet:

```md
- **Writes**: when saving a file's old bytes for undo finds that a parent folder was swapped for a link out of the allowed roots, the write now fails with `ACCESS_DENIED`; before, the refusal was logged and the write went ahead.
```

**Verify**: `npx prettier --check CHANGELOG.md` → exit 0.

### Step 4: Full check

**Verify**: `npm run check` → exit 0.

## Test plan

- One new test in `__tests__/core-fs.test.ts`, described in Step 1. It runs
  on every platform because it injects the refusal instead of racing a real
  swap.
- Pattern: `TC-FUNC-047e` in the same file.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] The new test passes and failed before Step 2
- [ ] `git diff --stat` lists only `src/core/fs.ts`, `__tests__/core-fs.test.ts`, `CHANGELOG.md`, `plans/README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

- The catch block in `#writeValid` does not match the excerpt.
- `mock.method(tracked, 'readSaved', ...)` has no effect because `saveOld` no
  longer calls `fs.readSaved` (check `src/core/undo.ts:557`).
- Any existing test fails after Step 2. Some test may rely on a swallowed
  `ACCESS_DENIED`; report which one instead of changing it.

## Maintenance notes

- A `PERMISSION_DENIED` errno (EACCES on the old file) still only abandons
  undo and continues. That is deliberate: the file may be write-only.
- The rename branch has no descriptor re-check of its own on any platform;
  that residual window is documented in ADR-010. This plan only stops the
  server from discarding a detection it already made.
