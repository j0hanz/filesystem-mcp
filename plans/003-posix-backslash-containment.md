# Plan 003: Root containment treats `\` as a path separator only on Windows

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7ee3d49f..HEAD -- src/core/path-utils.ts __tests__/path-helpers.test.ts __tests__/security.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `7ee3d49f`, 2026-09-25

## Why this matters

This server is a sandbox: every tool may only touch paths inside the allowed
roots, and `isPathInsideDirectory` is the lexical containment check every
guard path runs through (`src/core/path.ts` calls it via
`isPathWithinDirectories` at lines 450, 484-485, 529, 684-685, 727, 746). It
decides "is the next character after the root prefix a separator?" with
`isSlash`, which accepts both `/` and `\` **on every platform**. On Linux and
macOS `\` is an ordinary filename character, so for root `/srv/data` a
_sibling_ entry literally named `data\x` inside `/srv` is judged to be inside
the root. Both the lexical check and the post-`realpath` check use the same
function, so an existing sibling whose name starts with `<root-basename>\` can
be read, stat'd and overwritten; when the sibling is a directory, the entries
inside it can also be deleted (the delete path checks the _parent_, which is
then the sibling itself). New siblings cannot be created (the
parent `/srv` fails containment), so this needs a pre-existing entry — rare,
but it defeats the guard the product exists to provide. The fix is one
character-class decision in one shared function.

## Current state

- `src/core/path-utils.ts` — path primitives. `isSlash` (line 73) and
  `isPathInsideDirectory` (lines 201-213).
- Other `isSlash` users that must **not** change behavior:
  `isWindowsDriveRelativePath` (`path-utils.ts:145`, deliberately
  cross-platform so a Windows-style `C:foo` from any client is rejected even on
  a POSIX host) and `src/core/path-completer.ts:21` (trailing-slash detection
  on user-typed completion input).
- `__tests__/path-helpers.test.ts` — pure containment tests (TC-PH-001..006),
  all forward-slash POSIX paths.
- `__tests__/security.test.ts` — PathGuard boundary tests; uses `makeGuard`,
  `createTestRoot`, `cleanupTestRoot` from `__tests__/helpers.ts`, and skips
  platform-specific cases with `t.skip(...)` (see TC-SEC-011 at line ~128).

`src/core/path-utils.ts:71-73`:

```ts
export const IS_WINDOWS = process.platform === 'win32';

export const isSlash = (code: number): boolean => code === 47 || code === 92;
```

`src/core/path-utils.ts:201-213`:

```ts
export function isPathInsideDirectory(
  normalizedDirectory: string,
  normalizedCandidate: string,
): boolean {
  const root = normalizeCaseForComparison(normalizedDirectory);
  const candidate = normalizeCaseForComparison(normalizedCandidate);

  if (root === candidate) return true;
  if (!candidate.startsWith(root)) return false;

  if (isSlash(root.charCodeAt(root.length - 1))) return true;
  return isSlash(candidate.charCodeAt(root.length));
}
```

Inputs reaching this function are `normalizePath`/`realpath` outputs: on
Windows they use `\` (and may contain `/` from user input before `resolve`);
on POSIX `resolve` leaves `\` untouched as a literal character. No code path
converts `\` to `/` on POSIX before the guard (checked: `validateAccess` in
`src/core/path.ts:414-458` does not).

Test style exemplar (`__tests__/security.test.ts:128-135`):

```ts
it('TC-SEC-011: Prevents NTFS ADS bypass attempt', (t) => {
  const matcher = new SensitiveMatcher();
  if (process.platform !== 'win32') {
    t.skip('NTFS ADS stripping is Windows-only');
    return;
  }
  assert.strictEqual(matcher.isSensitive('.env:stream'), true);
});
```

## Commands you will need

| Purpose      | Command                                      | Expected on success |
| ------------ | -------------------------------------------- | ------------------- |
| Install      | `npm ci`                                     | exit 0              |
| Typecheck    | `npm run type-check:test`                    | exit 0              |
| Unit tests   | `node --test __tests__/path-helpers.test.ts` | all pass            |
| Guard tests  | `node --test __tests__/security.test.ts`     | all pass            |
| Lint         | `npm run lint`                               | exit 0              |
| Format files | `npx prettier --write <files>`               | exit 0              |
| Full gate    | `npm run check`                              | exit 0              |

## Scope

**In scope**:

- `src/core/path-utils.ts` — `isPathInsideDirectory` only, plus one new
  non-exported constant.
- `__tests__/path-helpers.test.ts`
- `__tests__/security.test.ts`

**Out of scope**:

- `isSlash` itself and its other callers (`isWindowsDriveRelativePath`,
  `path-completer.ts`) — changing `isSlash` would stop rejecting `C:foo`-style
  input on POSIX hosts.
- `src/core/path.ts` — the guard already routes through the fixed function.
- `src/core/sensitive.ts` — separate matcher, separate semantics.

## Git workflow

- Branch: `advisor/003-posix-backslash-containment` from `main`.
- One commit, e.g. `fix(path): only treat backslash as a separator on Windows`;
  body explains the sibling-name case. If you are an AI agent, end with a
  `Co-Authored-By:` trailer naming your model, as recent commits do.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing unit tests

In `__tests__/path-helpers.test.ts`, inside the `describe`, add:

```ts
it('TC-PH-007: backslash after the root is a separator only on Windows', () => {
  // On POSIX `\` is a filename character: `/foo\bar` is a sibling of `/foo`.
  assert.strictEqual(isPathInsideDirectory('/foo', '/foo\\bar'), process.platform === 'win32');
});

it('TC-PH-008: Windows-shaped paths nest with either separator on Windows', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows path shapes only resolve on win32');
    return;
  }
  assert.strictEqual(isPathInsideDirectory('c:\\foo', 'c:\\foo\\bar'), true);
  assert.strictEqual(isPathInsideDirectory('c:\\foo', 'c:\\foo/bar'), true);
  assert.strictEqual(isPathInsideDirectory('c:\\foo', 'c:\\foobar'), false);
});
```

**Verify**: on Linux/macOS, `node --test __tests__/path-helpers.test.ts` →
TC-PH-007 **fails**. On Windows it passes before and after the fix (that is
expected — the bug is POSIX-only); continue.

### Step 2: Fix the separator decision

In `src/core/path-utils.ts`, directly above `isPathInsideDirectory`, add:

```ts
// `\` separates path segments only on Windows. On POSIX it is a filename
// character, so `/root\x` names a sibling of `/root`, not a child.
const isPathSeparator = (code: number): boolean => code === 47 || (IS_WINDOWS && code === 92);
```

and replace both `isSlash(` calls inside `isPathInsideDirectory` with
`isPathSeparator(`. Do not touch any other `isSlash` call.

**Verify**: `node --test __tests__/path-helpers.test.ts` → all pass.

### Step 3: Add the PathGuard-level regression test

In `__tests__/security.test.ts`, inside `describe('PathGuard boundary enforcement', …)`,
add `TC-SEC-020: a sibling whose name starts with the root name and a backslash stays outside`
(if `TC-SEC-020` is taken, use the next free number; `grep -n "TC-SEC-0" __tests__/security.test.ts`):

- `if (process.platform === 'win32') { t.skip('backslash is a separator on Windows'); return; }`
- Build the sibling path with one literal backslash — a file in `root`'s
  parent directory whose name is `<basename(root)>\secret.txt`:

  ```ts
  const sibling = `${root}\\secret.txt`;
  ```

- `await writeFile(sibling, 'outside');` (import `writeFile` from
  `node:fs/promises`), and remove it in a `finally` with
  `await rm(sibling, { force: true })` (import `rm`).
- Also create a sibling _directory_ with a file in it:
  `const siblingDir = \`${root}\\dir\``(one literal backslash, as above),`await mkdir(siblingDir)`, `await writeFile(join(siblingDir, 'f.txt'), 'x')`(import`mkdir`), and remove it in the same `finally`with`await rm(siblingDir, { recursive: true, force: true })`.
- Assert each of these rejects with `isFsError(err) && err.code === ErrorCode.ACCESS_DENIED`
  (same `assert.rejects` shape as TC-SEC-005):
  `guard.validateExistingPath(sibling)`, `guard.validatePathForWrite(sibling)`,
  `guard.validatePathForDelete(join(siblingDir, 'f.txt'))`.
  (A delete of `sibling` itself is already refused by the parent check, so it
  proves nothing; the file inside the sibling directory is the case that
  leaked.)

**Verify**: `node --test __tests__/security.test.ts` → all pass (on Windows
the new test reports as skipped).

### Step 4: Format and full gate

`npx prettier --write src/core/path-utils.ts __tests__/path-helpers.test.ts __tests__/security.test.ts`

**Verify**: `npm run check` → exit 0.

## Test plan

- TC-PH-007: POSIX `\` is not a separator; on Windows it is.
- TC-PH-008 (Windows only): mixed separators still nest; prefix sibling still rejected.
- TC-SEC-020 (POSIX only): read, write and delete of a `root\name` sibling all
  get `ACCESS_DENIED`.
- Existing: all of `path-helpers.test.ts`, `security.test.ts`,
  `path-guard-grant.test.ts`, and the `move` tests in `tools.test.ts`
  (`move.ts:144` uses `isPathInsideDirectory` for "destination inside source").

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "isPathSeparator" src/core/path-utils.ts` → 3 lines (definition, 2 uses)
- [ ] `grep -n "isSlash(" src/core/path-utils.ts` still shows the `isWindowsDriveRelativePath` use (line ~145) and no use inside `isPathInsideDirectory`
- [ ] New tests exist: `grep -c "TC-PH-007\|TC-PH-008" __tests__/path-helpers.test.ts` → 2
- [ ] `git status` shows only the three in-scope files modified
- [ ] `plans/README.md` status row updated

> CI runs on Linux, so the POSIX-only assertions run there. If you are on
> Windows, TC-SEC-020 is skipped locally — that is expected, not a failure.

## STOP conditions

Stop and report back (do not improvise) if:

- Some code converts `\` to `/` before the guard on POSIX (then the attack
  shape differs and this plan's test would not exercise it).
- Any existing test fails after Step 2 — especially in `path-guard-grant.test.ts`
  or `roots-seeding.test.ts`, which build roots from client URIs.
- The fix appears to require changing `isSlash` or `normalizePath`.

## Maintenance notes

- `isSlash` stays platform-agnostic on purpose (input _rejection_ checks).
  Containment and equality use the platform's real separator. A future helper
  that compares paths must use `isPathSeparator`-style logic, not `isSlash`.
- Reviewer: confirm no other containment helper hand-rolls the separator
  check (`grep -rn "charCodeAt(root.length)" src`).
- `sensitive.ts` normalizes separators with `toPosixPath` for _matching_
  names, which is a different question (deny-listing), and is untouched.
