# Plan 030: Windows reserved device names are refused only on Windows

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/path.ts src/cli.ts src/core/path-utils.ts __tests__/security.test.ts`
> If `path.ts:440-455` or `cli.ts:29-44` changed, compare against the
> excerpts before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

`CON`, `AUX`, `NUL`, `PRN`, `COM1`–`COM9`, `LPT1`–`LPT9` are reserved device
names on Windows; opening `aux.ts` there talks to a device. The guard refuses
any path segment whose stem is one of these names — on **every** platform.
On Linux and macOS, `src/aux.ts`, `con.js`, `nul.c` or a directory named
`con/` are ordinary files, yet `read`/`edit` answer `ACCESS_DENIED` and,
because `ACCESS_DENIED` is a skippable errno for walks, `list`, `find_files`
and `search_text` silently drop them. The CLI refuses such a root the same
way. Reproduced at function level:
`getReservedDeviceNameForPath('/home/u/proj/src/aux.ts')` → `AUX`.

The drive-relative check next to it is deliberately cross-platform (its
comment explains why: `C:relative` must not be resolved against the cwd on a
POSIX host). The device-name check has no such reason: on POSIX there is no
device to reach.

## Current state

```ts
// src/core/path-utils.ts:71
export const IS_WINDOWS = process.platform === 'win32';

// src/core/path-utils.ts:110-126
function getReservedDeviceName(segment: string): string | undefined { … }

export function getReservedDeviceNameForPath(requestedPath: string): string | undefined {
  const segments = requestedPath.split(/[\\/]/u);
  for (const segment of segments) {
    const reserved = getReservedDeviceName(segment);
    if (reserved) {
      return reserved;
    }
  }
  return undefined;
}
```

```ts
// src/core/path.ts:440-454 (inside PathGuard.validateAccess)
if (isWindowsDriveRelativePath(requestedPath)) {
  throw new FsError(
    ErrorCode.INVALID_INPUT,
    'Drive-relative paths are not allowed. Use C:\\path or C:/path instead of C:path.',
    requestedPath,
  );
}
const reservedDevice = getReservedDeviceNameForPath(requestedPath);
if (reservedDevice) {
  throw new FsError(
    ErrorCode.ACCESS_DENIED,
    `Reserved Windows device name not allowed: ${reservedDevice}.`,
    requestedPath,
  );
}
```

`path.ts` line 35 is a comment saying the primitives (`IS_WINDOWS`, …) live in
`path-utils.ts`; check the import list at the top of `path.ts` for whether
`IS_WINDOWS` is already imported (`grep -n "IS_WINDOWS" src/core/path.ts`
prints only the comment at `8c2a82cd`, so it is **not**).

```ts
// src/cli.ts:29-44
function validateCliPath(inputPath: string): void {
  if (inputPath.includes('\0')) {
    throw new CliExitError('Path contains null bytes.');
  }

  if (isWindowsDriveRelativePath(inputPath)) {
    throw new CliExitError(
      'Windows drive-relative paths are not allowed. Use C:\\path or C:/path instead of C:path.',
    );
  }

  const reserved = getReservedDeviceNameForPath(inputPath);
  if (reserved) {
    throw new CliExitError(`Windows reserved device name not allowed: ${reserved}.`);
  }
}
```

`cli.ts:8-13` imports `getReservedDeviceNameForPath, isWindowsDriveRelativePath, normalizePath, parseTrueEnvFlag` from `./core/path-utils.ts`.

Test conventions: `__tests__/security.test.ts` has a `describe` with a
`PathGuard` named `guard` over a root `root` and tests such as `TC-SEC-009`
(line 85) that call `guard.validateExistingPath(path)` with
`fsErrorMatcher(ErrorCode.ACCESS_DENIED)`; `writeTestFile(root, name, content)`
creates a file. No test today mentions reserved names.

## Commands you will need

| Purpose        | Command                                                                       | Expected on success |
| -------------- | ----------------------------------------------------------------------------- | ------------------- |
| Static check   | `npm run check:static`                                                        | exit 0              |
| All tests      | `npm test`                                                                    | all pass            |
| Filter by name | `npm test -- --test-name-pattern="reserved device"`                           | passes              |
| Format         | `npx prettier --write src/core/path.ts src/cli.ts __tests__/security.test.ts` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/path.ts` — the one `if` block and an import
- `src/cli.ts` — the one `if` block and an import
- `__tests__/security.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope**: `getReservedDeviceNameForPath` itself (keep it pure);
the drive-relative check (cross-platform by design); `sensitive.ts`.

## Git workflow

- Branch: `advisor/030-reserved-device-names-windows-only`.
- One commit: `fix(path): refuse Windows reserved device names on Windows only`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Regression test (it must fail now on POSIX)

In `__tests__/security.test.ts`, directly after `TC-SEC-010` (ends line 103),
add:

```ts
it('TC-SEC-011: a reserved device name is refused on Windows and ordinary elsewhere', async () => {
  const auxPath = join(root, 'src', 'aux.ts');
  if (process.platform === 'win32') {
    // Not created: on Windows the name is a device, not a file.
    await assert.rejects(
      guard.validateExistingPath(auxPath),
      fsErrorMatcher(ErrorCode.ACCESS_DENIED, /Reserved Windows device name/),
    );
    return;
  }
  await writeTestFile(root, 'src/aux.ts', 'export const x = 1;\n');
  const resolved = await guard.validateExistingPath(auxPath);
  assert.ok(resolved.endsWith('aux.ts'));
});
```

(`join`, `writeTestFile`, `fsErrorMatcher`, `ErrorCode` are already imported.)

**Verify**: on Linux/macOS, `npm test -- --test-name-pattern="reserved device"`
→ **fails** with `ACCESS_DENIED`. On Windows it passes before and after; if
you are on Windows, note that the pre-fix failure could not be observed here
and rely on the ubuntu CI job.

### Step 2: Gate both checks on the platform

1. `src/core/path.ts`: add `IS_WINDOWS` to the value import from
   `'./path-utils.ts'` (the import that already brings
   `getReservedDeviceNameForPath`). Wrap lines 447–454:

   ```ts
       // A device name is only a device on Windows; on POSIX `aux.ts` is a file.
       const reservedDevice = IS_WINDOWS ? getReservedDeviceNameForPath(requestedPath) : undefined;
       if (reservedDevice) {
   ```

   (keep the `throw` block as it is).

2. `src/cli.ts`: add `IS_WINDOWS` to the import from `'./core/path-utils.ts'`
   and change line 40 to
   `const reserved = IS_WINDOWS ? getReservedDeviceNameForPath(inputPath) : undefined;`.

Run `npx prettier --write src/core/path.ts src/cli.ts __tests__/security.test.ts`.

**Verify**: `npm test -- --test-name-pattern="reserved device"` → passes on
every platform; `node --test __tests__/security.test.ts __tests__/path-helpers.test.ts`
→ all pass.

### Step 3: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- New `TC-SEC-011`: Windows still refuses `src/aux.ts` with the reserved-name
  message; POSIX resolves a real `src/aux.ts`.
- Existing: `path-helpers.test.ts` (pure helpers untouched), all guard tests.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "IS_WINDOWS ? getReservedDeviceNameForPath" src/core/path.ts src/cli.ts` prints 2 lines
- [ ] The new test exists and passes
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 030 updated

## STOP conditions

Stop and report back (do not improvise) if:

- On POSIX the regression test passes before Step 2.
- `path.ts` already imports `IS_WINDOWS` under another name or re-declares it
  — do not create a second constant; report.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If a Windows client ever drives a POSIX server against a checkout that
  will later be used on Windows, files named `aux.ts` are its problem, not
  the server's; this guard exists to keep the **server** off device handles.
- Reviewer focus: both sites gate identically; the pure helper stays
  platform-independent so `path-helpers.test.ts` keeps its Windows-name
  fixtures.
