# Plan 124: Enforce per-directory case sensitivity in PathGuard on Windows and macOS

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/core/path-utils.ts src/core/path.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: `plans/115-test-case-sensitive-volume-probe.md` (reproducer test)
- **Category**: security
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

Plan 115 reproduced a real root-containment escape on Windows 11 (`fsutil.exe file setCaseSensitiveInfo <dir> enable`, no administrator elevation required). Because `IS_CASE_INSENSITIVE_FS` (`src/core/path-utils.ts:187`) is a process-wide constant (`IS_WINDOWS || platform() === 'darwin'`), `PathGuard` folds ASCII case for every path on Windows and macOS. When an allowed root `base/Proj` sits inside a case-sensitive directory alongside `base/proj`, `PathGuard` treats `base/proj/secret.txt` as inside `base/Proj`, allowing unauthorized reads and writes outside the root.

## Current state

- `src/core/path-utils.ts:187-205` — defines `IS_CASE_INSENSITIVE_FS = IS_WINDOWS || platform() === 'darwin'`, `normalizeCaseForComparison`, `foldNameCase`, and `isSamePath`:

  ```ts
  export const IS_CASE_INSENSITIVE_FS = IS_WINDOWS || platform() === 'darwin';

  export function normalizeCaseForComparison(value: string): string {
    return IS_CASE_INSENSITIVE_FS ? value.replace(/[A-Z]/gu, (c) => c.toLowerCase()) : value;
  }

  function foldNameCase(value: string): string {
    return IS_CASE_INSENSITIVE_FS ? value.toLowerCase() : value;
  }

  export function isSamePath(left: string, right: string): boolean {
    if (left === right) {
      return true;
    }
    const leftResolved = normalizeCaseForComparison(resolve(left));
    const rightResolved = normalizeCaseForComparison(resolve(right));
    return leftResolved === rightResolved;
  }
  ```

- `src/core/path.ts:1288-1316` — `findEquivalentEntry` uses `unicodeMatchKey` (which calls `foldNameCase`) to match entries differing in Unicode form, spaces, or case.
- `__tests__/case-sensitive-volume.test.ts` (from Plan 115, or created here if not yet merged) — reproduces the escape with `{ todo: 'plan 115: remove when the guard is per-volume' }`.

## Commands you will need

| Purpose        | Command                                               | Expected on success        |
| -------------- | ----------------------------------------------------- | -------------------------- |
| Static checks  | `npm run check:static`                                | exit 0                     |
| Targeted tests | `node --test __tests__/case-sensitive-volume.test.ts` | exit 0, 0 failures, 0 todo |
| Full suite     | `npm run check`                                       | exit 0                     |

## Scope

**In scope**:

- `src/core/path-utils.ts`
- `src/core/path.ts`
- `__tests__/case-sensitive-volume.test.ts` (remove `todo` marker once fixed, or add from Plan 115 if absent)

**Out of scope**:

- `src/core/glob.ts`, `src/core/undo.ts`, `src/tools/create.ts`, `src/tools/move.ts` — keep existing `IS_CASE_INSENSITIVE_FS` / `unicodeMatchKey` callers working without breaking POSIX/Windows/macOS normalizations.
- Any changes to `package.json`, version files, or `plans/README.md` (unless instructed otherwise).

## Git workflow

- Branch: `fix/per-volume-case-sensitivity`

## Steps

1. **Drift check**: Run `git diff --stat 366c4c96..HEAD -- src/core/path-utils.ts src/core/path.ts`.
   - Expected: empty output (or match "Current state" excerpts).

2. **Analyze root containment under case-sensitive directories**:
   - In `src/core/path.ts`, when `PathGuard` resolves and checks whether a candidate path is inside an allowed root (`allowedRootContaining` / `validateAccess` / symlink resolution), a case-folded prefix match (`isPathInsideDirectory`) is only valid if the matched root prefix on disk actually resolves to the same directory (or has exact casing).
   - Specifically, on `IS_CASE_INSENSITIVE_FS` platforms (`win32` and `darwin`):
     - When comparing a resolved candidate path against an allowed root, if the candidate's prefix at the root's depth differs in case from the allowed root's canonical `realpath.native` (or if `lstat` of that prefix has a different `(dev, ino)` than the allowed root), the prefix is a distinct case-sensitive sibling directory (e.g., `base/proj` vs `base/Proj`) and MUST NOT match the allowed root.
     - Also check `findEquivalentEntry` (`src/core/path.ts:1288-1316`): on a case-sensitive directory, two entries differing only in ASCII case (`Proj` and `proj`) are distinct files/directories. Ensure `findEquivalentEntry` does not fold ASCII case onto a different existing entry in a case-sensitive directory (or treat case-only differences as non-equivalent when the directory is case-sensitive).

3. **Implement per-directory / canonical-prefix verification**:
   - Update `src/core/path.ts` (and `src/core/path-utils.ts` if helper adjustments are needed) so `PathGuard` refuses `base/proj/*` when only `base/Proj` is an allowed root on a case-sensitive directory, while preserving case-insensitive matching on standard NTFS/APFS directories.
   - Run `npm run check:static`. Expected: exit 0.

4. **Enable and run the reproducer test**:
   - Ensure `__tests__/case-sensitive-volume.test.ts` is present and remove `{ todo: 'plan 115: remove when the guard is per-volume' }`.
   - Run `node --test __tests__/case-sensitive-volume.test.ts`.
   - Expected on Windows 11 (and case-sensitive macOS): the test runs (not skipped, not todo) and passes, confirming `fs.read` and `fs.writeFile` reject with `ErrorCode.ACCESS_DENIED` and `base/proj/new.txt` is never created.

5. **Run full verification**:
   - Run `npm run check`.
   - Expected: exit 0, all tests pass with 0 failures.

## STOP conditions

- If any existing case-insensitive Windows/macOS tests in `__tests__/security.test.ts`, `__tests__/path-helpers.test.ts`, or `__tests__/unicode-path.test.ts` fail and cannot be reconciled cleanly, stop and report which test failed and why.
- If `fsutil.exe file setCaseSensitiveInfo` is unavailable on the test host, note that the live test skipped and verify the unit/mocked behavior separately.
