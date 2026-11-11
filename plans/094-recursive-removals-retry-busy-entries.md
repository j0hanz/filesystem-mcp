# Plan 094: Recursive removals retry an entry another process holds

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- src/core/fs.ts CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

The guarded filesystem removes trees with Node's `fs.promises.rm` in three
places and passes only `{ recursive, force }`. Node's default `maxRetries` is 0. On Windows, a search indexer or antivirus that holds one file open makes
the removal fail part-way with `EBUSY` or `EPERM`: a `delete` leaves half a
tree, a cross-device move leaves part of its source behind, and a staging
directory named `.<hex>.tmp` is left in the user's folder. Node retries
exactly these transient errors when asked. This was not reproduced; it is the
documented Node behavior.

## Current state

One file: `src/core/fs.ts` (`GuardedFileSystem`, the guarded facade every
tool writes through). It imports `rm as fsRm` from `node:fs/promises`.

Site 1, the public `rm` method (`src/core/fs.ts:1334-1352`):

```ts
  async rm(
    filePath: string,
    options?: Parameters<typeof fsRm>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    const validPath = await this.#guard('delete', filePath);
    // ...
    await this.#forMutation(validPath, async (own) => {
      // ...
      signal?.throwIfAborted();
      own.changed();
      await fsRm(validPath, options);
    });
```

Site 2, removing the source of a cross-device move (`src/core/fs.ts:1440-1442`):

```ts
// out-of-root link during the copy must not steer the removal outside.
await this.#guard('delete', validSource);
await this.#rawRm(validSource, { recursive: true, force: true });
```

Site 3, cleaning the staging directory (`src/core/fs.ts:1487`):

```ts
      await fsRm(stagingDir, { recursive: true, force: true }).catch((cleanupError: unknown) => {
```

`#rawRm` is `typeof fsRm` (`src/core/fs.ts:212`), injectable in tests.

Node semantics (from the Node `fs.rm` docs): `maxRetries` applies on `EBUSY`,
`EMFILE`, `ENFILE`, `ENOTEMPTY` and `EPERM`, with linear backoff of
`retryDelay` ms, and **is ignored unless `recursive` is true**. So adding the
options to a non-recursive call changes nothing.

Comment convention: comments say _why_, in one or two lines.

## Commands you will need

| Purpose      | Command                                                      | Expected on success |
| ------------ | ------------------------------------------------------------ | ------------------- |
| Install      | `npm ci`                                                     | exit 0              |
| Build        | `npm run build`                                              | exit 0              |
| Lint         | `npm run lint`                                               | exit 0, no warnings |
| fs tests     | `node --test --test-timeout=60000 __tests__/core-fs.test.ts` | `# fail 0`          |
| delete tests | `node --test --test-timeout=60000 __tests__/delete.test.ts`  | `# fail 0`          |
| move tests   | `node --test --test-timeout=60000 __tests__/move.test.ts`    | `# fail 0`          |
| Full check   | `npm run check`                                              | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/fs.ts`
- `CHANGELOG.md`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `rmdir` and `unlink` calls: `maxRetries` does not apply to them.
- `__tests__/`: test helpers call `rm` themselves; leave them.
- `src/core/undo.ts`: its removals are a separate path, not audited here.

## Git workflow

- Branch: `advisor/094-recursive-removals-retry-busy-entries`
- One commit: `fix(fs): retry a recursive removal that meets a busy entry`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add one constant and use it at the three sites

In `src/core/fs.ts`, near the other module-level constants (above the
`GuardedFileSystem` class), add:

```ts
// A recursive rm meets files an indexer or antivirus holds for a moment
// (EBUSY, EPERM on Windows). Node retries those only when asked; without it
// the removal stops part-way through the tree.
const RM_RETRY = { maxRetries: 3, retryDelay: 100 } as const;
```

Then:

- Site 1: change `await fsRm(validPath, options);` to
  `await fsRm(validPath, { ...options, ...RM_RETRY });`
- Site 2: change the options to `{ recursive: true, force: true, ...RM_RETRY }`.
- Site 3: change the options to `{ recursive: true, force: true, ...RM_RETRY }`.

**Verify**: `grep -c "RM_RETRY" src/core/fs.ts` → `4`. Then
`npm run build` → exit 0.

### Step 2: Run the affected suites

**Verify**: each of

- `node --test --test-timeout=60000 __tests__/core-fs.test.ts`
- `node --test --test-timeout=60000 __tests__/delete.test.ts`
- `node --test --test-timeout=60000 __tests__/move.test.ts`

→ `# fail 0`.

### Step 3: Changelog and full check

In `CHANGELOG.md`, under `## [Unreleased]` → `### Fixed`, append:

```markdown
- **delete** and **move**: a recursive removal now retries an entry another process holds for a moment (an indexer or antivirus on Windows); before, it could stop part-way through the tree.
```

**Verify**: `npm run check` → exit 0.

## Test plan

No new test. The change passes two options to a Node API; a test would need a
second process holding a file open on Windows and would be slow and flaky.
The existing delete, move and fs suites guard against a regression in the
call shape.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -c "RM_RETRY" src/core/fs.ts` returns 4
- [ ] `grep -n "recursive: true, force: true }" src/core/fs.ts` returns no matches
- [ ] `git status --short` lists only `src/core/fs.ts`, `CHANGELOG.md`, `plans/README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any of the three sites does not match its excerpt, or
  `grep -n "fsRm(\|#rawRm(" src/core/fs.ts` shows a fourth removal call site
  not listed here (report it; do not change it).
- A test asserts the exact options object passed to `rm` and fails after
  Step 1. Report the test name.
- TypeScript rejects the spread at Site 1 (the `options` parameter type is
  `Parameters<typeof fsRm>[1]`, which accepts `maxRetries` and `retryDelay`).

## Maintenance notes

- Worst case added delay per busy entry: 100 + 200 + 300 ms. A cancelled call
  is not interrupted during that wait; the signal is checked before the `rm`.
- The retry count is a judgment, not a measurement.
- Reviewer: confirm no non-recursive caller relied on an immediate failure
  (Node ignores the options there).
