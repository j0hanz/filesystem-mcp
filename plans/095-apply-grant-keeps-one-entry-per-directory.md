# Plan 095: `applyGrant` keeps one entry per granted directory

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- src/core/path.ts __tests__/roots-seeding.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

On a legacy (2025-era) stdio connection the server reads the client's roots
when the client initializes and again on every
`notifications/roots/list_changed`. Each time it calls
`PathGuard.applyGrant` for every root, and `applyGrant` appends the directory
to an internal list without checking whether it is already there. The list
grows by the number of roots on every notification and never shrinks. Each
grant then recomputes the allowed directories over the whole list while
holding the guard's mutation lock, so a client that sends the notification
often makes every later grant slower without bound.

## Current state

Files:

- `src/core/path.ts`: `PathGuard`: allowed roots and per-path validation.
- `src/transport/stdio.ts`: `seedRootsFromClient` calls `applyGrant` per
  client root (not changed by this plan).
- `__tests__/roots-seeding.test.ts`: tests for the seeding.

The private state (`src/core/path.ts:260`, `:268`):

```ts
  private grantedDirectories: string[] = [];
  private accessGrants: string[] = [];
```

The append (`src/core/path.ts:641-654`), inside `applyGrant`:

```ts
    return runExclusive(this, async () => {
      const previous = this.grantedDirectories;
      const previousAccess = this.accessGrants;
      const dir = normalizePath(targetDir);
      this.grantedDirectories = [...previous, dir];
      this.accessGrants =
        kind === 'access'
          ? [...previousAccess, dir]
          : previousAccess.filter((grant) => !isSamePath(grant, dir));
      const rollBack = (): void => {
        this.grantedDirectories = previous;
        this.accessGrants = previousAccess;
      };
```

After this block the method recomputes the allowed directories and verifies
the grant landed. Leave that part alone.

`isSamePath(left, right)` is already imported in `path.ts`; it compares two
paths after resolving them and folding case where the filesystem folds case.

The re-seed handler (`src/transport/stdio.ts:188-192`), for context:

```ts
// Re-list and grant anything new. Grants are session-additive (R8): a
// root the client withdrew is not revoked mid-session.
c.mcp.server.setNotificationHandler('notifications/roots/list_changed', () => {
  void seedRootsFromClient(c);
});
```

The existing test that claims dedupe but does not check it
(`__tests__/roots-seeding.test.ts:59-65`):

```ts
it('TC-ROOTS-002: re-seeding is idempotent', async () => {
  // Every root already granted or refused: nothing new to add.
  const granted = await seedRootsFromClient(serverCtx);
  assert.equal(granted, 1); // applyGrant is a dedup no-op but still reports true
  const dirs = serverCtx.pathGuard.getAllowedDirectories();
  assert.equal(dirs.length, 1);
});
```

`getAllowedDirectories()` returns the de-duplicated result, so this test
passes while the internal list grows.

Meaning of the two lists, so the fix keeps it: `grantedDirectories` is every
directory a client was granted; `accessGrants` is the subset granted through
an access prompt (`kind === 'access'`). A `'workspace'` grant removes the
directory from `accessGrants`.

## Commands you will need

| Purpose          | Command                                                               | Expected on success |
| ---------------- | --------------------------------------------------------------------- | ------------------- |
| Install          | `npm ci`                                                              | exit 0              |
| Type-check tests | `npm run type-check:test`                                             | exit 0              |
| Lint             | `npm run lint`                                                        | exit 0, no warnings |
| Seeding tests    | `node --test --test-timeout=60000 __tests__/roots-seeding.test.ts`    | `# fail 0`          |
| Grant tests      | `node --test --test-timeout=60000 __tests__/path-guard-grant.test.ts` | `# fail 0`          |
| Full check       | `npm run check`                                                       | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/path.ts` (the block shown above only)
- `__tests__/roots-seeding.test.ts`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `src/transport/stdio.ts`: the seeding and its handler are a legacy path
  with a recorded sunset (ADR-002); do not restructure it.
- `recomputeAllowedDirectories` and the boundary checks in `applyGrant`.
- Revoking withdrawn roots: grants are session-additive by decision.

## Git workflow

- Branch: `advisor/095-apply-grant-keeps-one-entry-per-directory`
- One commit: `fix(path): keep one grant entry per directory`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make the test check the internal list

In `__tests__/roots-seeding.test.ts`, replace the body of `TC-ROOTS-002` with:

```ts
it('TC-ROOTS-002: re-seeding is idempotent', async () => {
  // Every root already granted or refused: nothing new to add.
  const grants = (): number =>
    (serverCtx.pathGuard as unknown as { grantedDirectories: string[] }).grantedDirectories.length;
  const before = grants();
  for (let round = 0; round < 3; round++) {
    assert.equal(await seedRootsFromClient(serverCtx), 1);
  }
  assert.equal(grants(), before, 'a repeated grant adds no entry');
  assert.equal(serverCtx.pathGuard.getAllowedDirectories().length, 1);
});
```

**Verify**: `node --test --test-timeout=60000 __tests__/roots-seeding.test.ts`
→ `TC-ROOTS-002` FAILS with "a repeated grant adds no entry".

### Step 2: Append only a directory that is not already listed

In `src/core/path.ts`, in the block shown in "Current state", replace the two
assignments with:

```ts
const dir = normalizePath(targetDir);
// A client re-lists its roots on every roots/list_changed: a directory
// already granted adds no entry, or the list grows without bound.
const same = (granted: string): boolean => isSamePath(granted, dir);
this.grantedDirectories = previous.some(same) ? previous : [...previous, dir];
this.accessGrants =
  kind === 'access'
    ? previousAccess.some(same)
      ? previousAccess
      : [...previousAccess, dir]
    : previousAccess.filter((grant) => !same(grant));
```

Keep `const previous`, `const previousAccess`, `rollBack` and everything after
unchanged.

**Verify**: `node --test --test-timeout=60000 __tests__/roots-seeding.test.ts`
→ `# fail 0`.

### Step 3: Grant suites and full check

**Verify**: `node --test --test-timeout=60000 __tests__/path-guard-grant.test.ts`
→ `# fail 0`, then `npm run check` → exit 0.

## Test plan

- `TC-ROOTS-002` now asserts that the grant list length is stable across
  three re-seeds (Step 1).
- No changelog line: nothing a client can observe changes.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "\[\.\.\.previous, dir\]" src/core/path.ts` shows the append only inside the conditional expression
- [ ] `grep -n "a repeated grant adds no entry" __tests__/roots-seeding.test.ts` returns 1 match
- [ ] `git status --short` lists only `src/core/path.ts`, `__tests__/roots-seeding.test.ts`, `plans/README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `applyGrant` block does not match the excerpt.
- `TC-ROOTS-002` passes before Step 2 (the list did not grow: the premise is
  wrong).
- A test in `__tests__/path-guard-grant.test.ts` fails after Step 2 because it
  expects a duplicate entry.
- Lint rejects the `as unknown as` cast in the test. Then look in
  `__tests__/path-guard-grant.test.ts` for how other tests read private guard
  state and use that form; if there is none, report.

## Maintenance notes

- The recompute still runs on every repeated grant; only the list growth is
  fixed. An early return for an already-granted `'workspace'` directory would
  save that too, but it must still demote the directory out of
  `accessGrants`, so it was left out.
- This code path goes away with the legacy protocol paths (ADR-002).
