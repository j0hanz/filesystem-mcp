# Plan 085: The delete guard fails closed when an existing entry cannot be resolved

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat d799cc5e..HEAD -- src/core/path.ts __tests__/path-guard-grant.test.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (an entry that cannot be resolved now gets an error instead of a delete)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `d799cc5e`, 2026-11-10

## Why this matters

`PathGuard.validatePathForDelete` validates the source of every delete and
move, and the source of every copy. For an entry that exists and is not a
symlink, it resolves the real path and then runs four checks on it: root
containment, the sensitive-file denylist, the read-only-root rule, and the
"allowed root inside / read-only root inside" rule for directories. If the
resolve step throws, the function returns the path as typed and skips all
four. The comment above it says this is "sufficient for a path that does not
exist", but that branch only runs for entries `lstat` just found.

No real trigger was reproduced. Plausible ones are Windows reparse points that
`realpath` cannot resolve and handle exhaustion. The read path already fails
closed in the same situation ("Cannot access path"); delete should too.

## Current state

Files:

- `src/core/path.ts`: `PathGuard`; `validatePathForDelete` starts at line 1403.
- `__tests__/path-guard-grant.test.ts`: `PathGuard` tests, including two for
  `validatePathForDelete` (TC-PG-009 at line 419, TC-PG-010 at line 431).
- `__tests__/core-fs.test.ts`: exemplar for stubbing a `node:fs/promises`
  function (lines 139-157).

`src/core/path.ts:2`: the functions are named imports:

```ts
import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises';
```

`src/core/path.ts:1475-1483`: the branch for a target that does not exist.
It spells the target through the validated real parent:

```ts
// A target that does not exist needs only the parent check above. It does
// not exist to realpath, so the read-only check spells it through the
// validated real parent — a symlinked ancestor cannot alias its way past.
if (stats === undefined) {
  if (!opts?.allowReadOnly) {
    this.assertWritable(join(normalizedRealParent, basename(target)));
  }
  return target;
}
```

`src/core/path.ts:1508-1523`: the defect:

```ts
    // Not a symlink: resolve to catch path escapes (e.g. /allowed/dir/../../etc)
    // and block sensitive files. A probe failure (ENOENT and friends) falls
    // back to the parent check, which is sufficient for a path that does not
    // exist.
    let realTarget: string;
    try {
      realTarget = normalizePath(await realpath(target));
    } catch {
      return target;
    }
    if (!isPathWithinDirectories(realTarget, allowedDirs)) {
      this.throwAccessDenied(requestedPath, accessDeniedHint);
    }
    this.assertNotSensitiveFile(realTarget, requestedPath);
    if (!opts?.allowReadOnly) {
      this.assertWritable(realTarget);
```

`src/core/path.ts:813-819`: how the read path reports the same failure. Match
its shape (`classifyCauseChain` and `FsError` are already imported in this
file):

```ts
const mapped = classifyCauseChain(error);
throw new FsError(
  mapped.code,
  'Cannot access path',
  requestedPath,
  error instanceof Error ? error : undefined,
);
```

`isNotFoundErrno(error)` (from `src/core/errors.ts:256`) is already used in
this function at line 1447.

`__tests__/core-fs.test.ts:139-157`: the stub pattern. Named imports of a
builtin only see the stub after `syncBuiltinESMExports()`:

```ts
t.mock.method(fsPromises, 'readFile', () => {
  controller.abort(new DOMException('Deadline elapsed', 'TimeoutError'));
  return Promise.reject(failure);
});
syncBuiltinESMExports();
try {
  // ... assertions ...
} finally {
  t.mock.restoreAll();
  syncBuiltinESMExports();
}
```

There `fsPromises` is `import fsPromises from 'node:fs/promises'` and
`syncBuiltinESMExports` is imported from `node:module`.

Conventions to match:

- Tests: `describe` / `it` from `node:test`, `node:assert/strict`,
  `fsErrorMatcher(ErrorCode.X)` from `__tests__/helpers.ts` for rejections,
  `makeGuard([root])` to build a `PathGuard`, `createTestRoot()` /
  `cleanupTestRoot()` for temp roots.
- Comments say why, in one or two lines.
- Commit messages are Conventional Commits, for example
  `fix(core): use isSamePath for watcher filename comparison on case-insensitive filesystems`.
- ADR-010 (`docs/adr/010-per-root-read-only.md`) decides that a read-only root
  refuses deletes and moves of anything inside it. This plan makes one more
  code path honour it; it changes no decision.

## Commands you will need

| Purpose       | Command                                                               | Expected on success |
| :------------ | :-------------------------------------------------------------------- | :------------------ |
| Install       | `npm ci`                                                              | exit 0              |
| One test file | `node --test --test-timeout=60000 __tests__/path-guard-grant.test.ts` | all pass            |
| Full check    | `npm run check`                                                       | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/path.ts`: only the `try { realTarget = … } catch { … }` block at
  lines 1508-1517 and its comment.
- `__tests__/path-guard-grant.test.ts`
- `CHANGELOG.md` (one bullet under `## [Unreleased]` → `### Fixed`)
- `plans/README.md` (your status row)

**Out of scope** (do NOT touch):

- The symlink branch (`path.ts:1487-1506`): a link is deleted without
  resolving its target, on purpose.
- The missing-target branch (`path.ts:1478-1483`): correct as written.
- `validatePathForWrite`, `handleRealpathError`, and every other caller of
  `realpath` in the file.
- `src/core/fs.ts`: its callers need no change.

## Git workflow

- Branch: `advisor/085-delete-guard-fails-closed` from `main`.
- One commit, for example
  `fix(core): fail closed when the delete guard cannot resolve an existing entry`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing tests

In `__tests__/path-guard-grant.test.ts`, next to TC-PG-010, add two tests.
Add the imports they need at the top of the file if they are missing:
`import fsPromises from 'node:fs/promises';` and
`import { syncBuiltinESMExports } from 'node:module';`.

Both tests stub `fsPromises.realpath` so that it rejects **only for the one
target file** and calls the original for every other path (the guard also
resolves the parent directory, which must keep working). Keep a reference to
the original first: `const original = fsPromises.realpath.bind(fsPromises);`.
Compare paths with `String(path) === target`. Restore in `finally` exactly as
the exemplar does.

1. `validatePathForDelete refuses an existing entry whose realpath fails`:
   create `target = await writeTestFile(root, 'stuck.txt', 'x')`, stub
   `realpath` to reject for it with
   `Object.assign(new Error('EACCES'), { code: 'EACCES' })`, and assert
   `guard.validatePathForDelete(target)` rejects with an `FsError` whose
   message is `Cannot access path`
   (`fsErrorMatcher` takes an optional message substring as its second
   argument: see its use at `__tests__/core-fs.test.ts:181`).
2. `validatePathForDelete treats an entry that vanished before realpath as missing`:
   same setup, but reject with
   `Object.assign(new Error('ENOENT'), { code: 'ENOENT' })`, and assert the
   call resolves (`assert.doesNotReject`).

**Verify**:
`node --test --test-timeout=60000 __tests__/path-guard-grant.test.ts` → test 1
FAILS (the call resolves instead of rejecting); test 2 passes; all others pass.

### Step 2: Fail closed

In `src/core/path.ts`, replace the comment and `try`/`catch` at lines
1508-1517 with:

```ts
// Not a symlink: resolve to catch path escapes (e.g. /allowed/dir/../../etc)
// and block sensitive files. An entry that vanished since the lstat is a
// missing target; any other failure is refused, because the checks below
// cannot run on an entry that will not resolve.
let realTarget: string;
try {
  realTarget = normalizePath(await realpath(target));
} catch (error) {
  if (!isNotFoundErrno(error)) {
    throw new FsError(
      classifyCauseChain(error).code,
      'Cannot access path',
      requestedPath,
      error instanceof Error ? error : undefined,
    );
  }
  if (!opts?.allowReadOnly) {
    this.assertWritable(join(normalizedRealParent, basename(target)));
  }
  return target;
}
```

The lines after it (`if (!isPathWithinDirectories(realTarget, …` onward) stay
unchanged.

**Verify**:
`node --test --test-timeout=60000 __tests__/path-guard-grant.test.ts` → all
pass, including both new tests.

### Step 3: Changelog and full check

In `CHANGELOG.md`, under `## [Unreleased]` → `### Fixed`, add:

```md
- **Path guard**: a delete, move or copy source that exists but cannot be resolved is now refused with "Cannot access path" instead of skipping the root, denylist and read-only checks.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- Two new tests in `__tests__/path-guard-grant.test.ts`: the regression
  (non-ENOENT resolve failure is refused) and the kept behaviour (an entry
  that vanished is still treated as missing).
- Pattern: stub from `__tests__/core-fs.test.ts:139-157`; structure from
  TC-PG-010 at `__tests__/path-guard-grant.test.ts:431-449`.
- Verification: `npm run check` → exit 0.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "return target;" src/core/path.ts` shows no match inside a bare `catch {` block in `validatePathForDelete`
- [ ] Both new tests exist and pass
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- The `realpath` stub does not take effect (test 1 still resolves after step
  2). Do not add a test-only seam to `PathGuard`; report it.
- Any existing test in `__tests__/delete.test.ts`, `__tests__/move.test.ts`,
  `__tests__/transfer.test.ts` or `__tests__/path-guard-*.test.ts` starts
  failing after step 2: that would mean a caller depends on the fail-open
  path.
- `classifyCauseChain` or `isNotFoundErrno` is not in scope in `path.ts`.

## Maintenance notes

- `path.ts:1573` and `:1599` call `validatePathForDelete(...).catch(...)` as a
  probe; both already swallow every rejection, so the new error changes
  nothing there. A reviewer should confirm that by reading those two lines.
- If Windows users report "Cannot access path" on deletes of cloud
  placeholders or app-execution aliases, the answer is a targeted exception
  for that reparse tag, with the checks spelled through the real parent: not
  a return to the lexical path.
