# Plan 125: Block final-component symlink swap after validation on Windows

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/core/fs.ts src/core/read.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: `plans/123-test-swap-after-validation.md` (reproducer test)
- **Category**: security
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

Plan 123 proved that on `win32`, swapping a regular file inside an allowed root for a symlink pointing outside the roots between path validation and `fsOpen` succeeds and leaks the outside file's contents. On Windows, `constants.O_NOFOLLOW` is `undefined` (defaulted to `0` in `src/core/read.ts:18`) and `/proc/self/fd` does not exist (`#assertFdWithinRoots` in `src/core/fs.ts:365-389` returns `undefined`), leaving `#openVerified` (`src/core/fs.ts:487-505`) with no defense against a final-component symlink swap.

## Current state

- `src/core/read.ts:18-23`:

  ```ts
  const { O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants as {
    O_NOFOLLOW?: number;
    O_NONBLOCK?: number;
  };
  export { O_NOFOLLOW };
  export const READ_NOFOLLOW = constants.O_RDONLY | O_NOFOLLOW;
  ```

- `src/core/fs.ts:365-389` — `#assertFdWithinRoots` only checks `/proc/self/fd/${String(handle.fd)}` and returns `undefined` when `/proc` is unavailable (always on `win32` and `darwin`).
- `src/core/fs.ts:486-505` — `#openVerified`:

  ```ts
  /** The one read open: O_NOFOLLOW, then the descriptor re-check above. */
  async #openVerified(
    validPath: string,
    requestedPath: string,
    signal?: AbortSignal,
  ): Promise<FileHandle> {
    const handle = await this.#abandonOnAbort(
      fsOpen(validPath, READ_NOFOLLOW),
      signal,
      (late) => late.close(),
      `file handle for ${validPath}`,
    );
    try {
      await this.#assertFdWithinRoots(handle, requestedPath);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  ```

- `__tests__/swap-after-validation.test.ts` (from Plan 123, or created here if not yet merged) — marks Test A (`A: final component swapped for a file link`) as `todo` on `win32`.

## Commands you will need

| Purpose        | Command                                               | Expected on success        |
| -------------- | ----------------------------------------------------- | -------------------------- |
| Static checks  | `npm run check:static`                                | exit 0                     |
| Targeted tests | `node --test __tests__/swap-after-validation.test.ts` | exit 0, 0 failures, 0 todo |
| Full suite     | `npm run check`                                       | exit 0                     |

## Scope

**In scope**:

- `src/core/fs.ts`
- `__tests__/swap-after-validation.test.ts` (remove `win32` `todo` once fixed, or add from Plan 123 if absent)

**Out of scope**:

- Changing `READ_NOFOLLOW` / `O_NOFOLLOW` constants in `src/core/read.ts` (Windows CRT does not support `O_NOFOLLOW`).
- Any changes to `package.json`, version files, or `plans/README.md` (unless instructed otherwise).

## Git workflow

- Branch: `fix/win32-swap-after-validation`

## Steps

1. **Drift check**: Run `git diff --stat 366c4c96..HEAD -- src/core/fs.ts src/core/read.ts`.
   - Expected: empty output (or match "Current state" excerpts).

2. **Add descriptor & link verification on platforms without `O_NOFOLLOW` / `/proc/self/fd`**:
   - In `src/core/fs.ts` (`#openVerified`, and any sibling open helpers that rely solely on `O_NOFOLLOW` + `#assertFdWithinRoots`), when `O_NOFOLLOW === 0` or `#assertFdWithinRoots` returns `undefined`:
     - Before returning `handle`, run `lstat(validPath)` and `realpath(validPath)` (or compare `handle.stat()`'s `(dev, ino)` against `lstat(validPath)`'s `(dev, ino)` and require `!linkStat.isSymbolicLink()`), and verify `allowedRootContaining(normalizePath(real)) !== undefined && !isSensitive(normalizePath(real))`.
     - If `lstat(validPath)` reveals a symlink, or if `handle.stat()`'s `(dev, ino)` does not match `lstat(validPath)` (indicating a swap-and-swap-back or symlink follow), close `handle` and throw `FsError(ErrorCode.ACCESS_DENIED, ..., requestedPath)`.
     - Also check `realpath(validPath)`: if the path was swapped for a symlink to an outside file, `lstat(validPath).isSymbolicLink()` is `true` and `realpath(validPath)` resolves outside roots — both catch it before any bytes are read from `handle`.

3. **Run static checks**:
   - Run `npm run check:static`.
   - Expected: exit 0.

4. **Enable and run the reproducer test**:
   - Ensure `__tests__/swap-after-validation.test.ts` is present and remove the `win32` `todo` option from Test A (`A: final component swapped for a file link`).
   - Run `node --test __tests__/swap-after-validation.test.ts`.
   - Expected on `win32`: Test A passes (or skips cleanly if Developer Mode / symlink creation is disabled on the host), and never leaks `TOP_SECRET`.

5. **Run full verification**:
   - Run `npm run check`.
   - Expected: exit 0, all tests pass with 0 failures.

## STOP conditions

- If adding `lstat` / `realpath` verification in `#openVerified` breaks any existing test in `__tests__/core-fs.test.ts` (for example, mocks that wrap `fsPromises.open` without creating a real file on disk), inspect the failing test and stop if a mock contract conflicts with real `lstat`.
- If `trySymlink` skips on the Windows host due to lack of symlink privilege (`EPERM`), report that Test A skipped on this host and verify via mocked `lstat` / `handle.stat` unit test.
