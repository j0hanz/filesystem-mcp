# Plan 123: Tests record what a path swapped after validation does on Windows and macOS

> **Executor instructions**: This plan adds tests that characterize existing
> behavior. It changes no source. Follow it step by step. If anything in the
> "STOP conditions" section occurs, stop and report; do not improvise. When
> done, update the status row for this plan in `plans/README.md`, unless a
> reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/core/fs.ts src/core/read.ts __tests__/core-fs.test.ts`
> Plans 104, 105 and 122 change `src/core/fs.ts`; that is expected. If the
> excerpts in "Current state" no longer match, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (tests only)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

The server validates a path and then opens it. Between those two steps an
outside process can swap the file, or one of its parent folders, for a link
that points outside the allowed roots. Two defenses exist:

- `O_NOFOLLOW` on the open refuses a **final** component that became a
  symlink.
- A re-check of the opened descriptor's real path refuses a swapped
  **parent**. It needs `/proc/self/fd`, so it runs on Linux only.

All fourteen tests of these races are skipped unless the platform is Linux.
On the Windows and macOS CI legs, nothing states what happens. In
particular, `O_NOFOLLOW` is not defined on Windows, where the code
substitutes `0`, so the first defense may not exist there at all. The
residual window is a documented design decision (ADR-010), but an
undocumented, untested platform difference is how a regression goes
unnoticed. This plan writes down the actual outcome per platform as tests.

## Current state

`src/core/read.ts:18-23`:

```ts
const { O_NOFOLLOW = 0, O_NONBLOCK = 0 } = constants as {
  // ...
export const READ_NOFOLLOW = constants.O_RDONLY | O_NOFOLLOW;
```

`src/core/fs.ts:358-372`:

```ts
  /**
   * O_NOFOLLOW only guards the final component; an ANCESTOR directory swapped
   * for a symlink after validation still passes. Re-read the open descriptor's
   * real path (Linux `/proc/self/fd`; skipped elsewhere) and require it to stay
   * inside the roots. Run before any byte is read or written through `handle`.
   * Resolves to the normalized real path checked, or undefined when /proc is unreadable.
   */
  async #assertFdWithinRoots(
    handle: FileHandle,
    requestedPath: string,
  ): Promise<string | undefined> {
    let fdPath: string;
    try {
      fdPath = await fsReadlink(`/proc/self/fd/${String(handle.fd)}`);
    } catch {
      return undefined;
    }
```

`src/core/fs.ts:486-498`, the one read open:

```ts
  async #openVerified(validPath: string, requestedPath: string, signal?: AbortSignal): Promise<FileHandle> {
    const handle = await this.#abandonOnAbort(
      fsOpen(validPath, READ_NOFOLLOW),
```

`fsOpen` is `open` imported from `node:fs/promises`.

Existing Linux-only test, `__tests__/core-fs.test.ts:1572-1575`:

```ts
  it('an ancestor directory swapped for a symlink never leaks through any read path', async (t) => {
    // #assertFdWithinRoots reads /proc/self/fd, so only Linux re-checks an
    // ancestor; elsewhere this swap is the residual path.ts's TOCTOU note names.
    if (process.platform !== 'linux') return t.skip('fd re-check is Linux-only');
```

That test races a background "flipper" against 400 reads. This plan does
NOT race: it swaps deterministically, at the exact moment between
validation and open, by wrapping the built-in `open`.

The deterministic-injection pattern, `__tests__/core-fs.test.ts:1012-1033`:

```ts
const originalWriteFile = fsPromises.writeFile;
mock.method(
  fsPromises,
  'writeFile',
  async (...args: Parameters<typeof fsPromises.writeFile>): Promise<void> => {
    await originalWriteFile(...args);
    controller.abort(new Error('abort before commit'));
  },
);
syncBuiltinESMExports();
try {
  // ...
} finally {
  mock.restoreAll();
  syncBuiltinESMExports();
}
```

Link helper, `__tests__/helpers.ts:53-61`: `trySymlink(target, linkPath, skip, type = 'junction')`
with `type: 'junction' | 'file' | undefined`. A junction (directories only)
needs no privilege on Windows; a file symlink may, and the helper calls
`skip` when it is refused.

Node's runner: `it('name', { todo: 'reason' }, fn)` reports a failing test
without failing the run.

## Commands you will need

| Purpose    | Command                                                                    | Expected on success |
| :--------- | :------------------------------------------------------------------------- | :------------------ |
| One file   | `node --test --test-timeout=60000 __tests__/swap-after-validation.test.ts` | exit 0              |
| Full check | `npm run check`                                                            | exit 0              |

## Scope

**In scope**:

- `__tests__/swap-after-validation.test.ts` (create)
- `plans/123-swap-race-outcomes-pinned-on-every-platform.md` (append "Findings")
- `plans/README.md`

**Out of scope**:

- Everything under `src/`.
- The fourteen existing Linux-only tests in `__tests__/core-fs.test.ts`.
- `__tests__/helpers.ts` (do not widen `trySymlink`'s type here).

## Git workflow

- Branch: `test/swap-after-validation`
- One commit: `test(security): record what a path swapped after validation does on each platform`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Scaffolding

Create the test file with the same imports and setup shape as the top of
`__tests__/core-fs.test.ts` (lines 1-80): a `base` temp directory from
`createTestRoot()`, a `root` folder inside it that is the only allowed root,
an `outside` folder beside it holding `victim.txt` with the text
`TOP_SECRET`, a server context from `createTestServer([root])`, and
`fs = new GuardedFileSystem(ctx.pathGuard)`.

Write one helper:

```ts
/** Runs `swap` once, immediately before the first open of `path`, then opens for real. */
function swapBeforeOpen(path: string, swap: () => Promise<void>): void;
```

It replaces `fsPromises.open` with a wrapper that, the first time it is
called with `path`, awaits `swap()` and then calls the original `open` with
the same arguments; calls `syncBuiltinESMExports()`. Tests restore with
`mock.restoreAll(); syncBuiltinESMExports();` in `finally`.

**Verify**: `npm run type-check:test` → exit 0.

### Step 2: Final component swapped for a file link

Test A: `root/a.txt` exists with `in-root`. The swap deletes it and creates a
file symlink `root/a.txt` → `outside/victim.txt` (use `trySymlink(..., 'file')`;
skip the test when links are refused). Then call
`fs.read(join(root, 'a.txt'))`.

Expected, by design: the read is refused on every platform, and the returned
content is never `TOP_SECRET`.

Write the assertion as "rejects, and if it resolves the content must not
contain `TOP_SECRET`". Run it.

- Passes on your platform → keep as a normal test.
- Fails (content from outside the root is returned) → wrap it with
  `{ todo: 'plan 123: final-component swap is followed on <platform>' }`,
  restricted to that platform with a `process.platform` condition, and
  record it in Findings. See STOP conditions.

### Step 3: Parent directory swapped for a link

Test B: `root/dir/a.txt` exists with `in-root`; `outside/a.txt` exists with
`TOP_SECRET`. The swap renames `root/dir` to `root/dir.real` and creates a
directory link `root/dir` → `outside` (default junction type on Windows,
symlink elsewhere). Then call `fs.read(join(root, 'dir', 'a.txt'))`.

Expected:

- Linux: rejects with `ACCESS_DENIED` (the descriptor re-check).
- macOS and Windows: by the documented residual window, the read follows
  the swapped parent. Assert the actual outcome you observe and put this
  comment above the assertion:
  `// Documented residual (ADR-010, fs.ts #assertFdWithinRoots): no descriptor re-check off Linux. This pins today's outcome so a change is noticed, not approved.`

Use `if (process.platform === 'linux') { ... } else { ... }` inside one test,
so each CI leg asserts its own outcome.

### Step 4: The same two swaps for a write

Tests C and D: repeat A and B with `fs.writeFile(path, 'new')`. A write does
not go through `open` for the temp-and-rename path, so wrap
`fsPromises.writeFile` instead (swap before the first call whose path starts
with the target's temp-file prefix: the target path followed by `.`).
Assert whether `outside/` gained or changed a file. Record the outcome per
platform the same way: by-design refusal as a normal assertion, residual as
a pinned outcome with the comment.

### Step 5: Record findings

Append to this plan file:

```md
## Findings (<date>)

| Case                 | Linux | macOS | Windows |
| :------------------- | :---- | :---- | :------ |
| A read, final link   |       |       |         |
| B read, parent link  |       |       |         |
| C write, final link  |       |       |         |
| D write, parent link |       |       |         |
```

Fill in the column for the platform you ran on (`refused` or `followed`).
Leave the others for CI: after the branch runs in CI, the test results fill
them in; say so in your report.

**Verify**: `npm run check` → exit 0.

## Test plan

Four tests in the new file. They are deterministic (no background flipper,
no sleeps) and run on every CI leg.

## Done criteria

- [ ] `__tests__/swap-after-validation.test.ts` exists; `npm run check` exits 0
- [ ] No `sleep`/`setTimeout` in the new file
- [ ] The plan file has a "Findings" table with at least one platform column filled
- [ ] No file under `src/` is modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- Case A (final component, read) returns outside content on any platform.
  That is not the documented residual; it means `O_NOFOLLOW` gives no
  protection there. Record it, mark the status row
  `DONE: FINDING, final-component swap followed on <platform>`, and tell the
  operator directly; it falls under `SECURITY.md`.
- Wrapping `fsPromises.open` does not intercept the server's open (the read
  succeeds with `in-root` and the swap never ran).
- A test leaves a junction or link behind that makes `cleanupTestRoot`
  delete files in `outside` you did not create (always remove the link
  first, in `finally`).

## Maintenance notes

- If the maintainer later closes the non-Linux window (for example by
  re-validating the real path of the opened handle with a platform API),
  the pinned-outcome assertions in B and D flip, which is the signal this
  plan exists to give.
- Plan 104 makes a detected swap stop a write on Linux; case D on Linux
  should then show `refused` when undo capture is on. This file tests
  without a capture; add a capture variant only if plan 104 has landed.

## Findings (2026-11-14)

| Case                 | Linux | macOS | Windows  |
| :------------------- | :---- | :---- | :------- |
| A read, final link   |       |       | followed |
| B read, parent link  |       |       |          |
| C write, final link  |       |       |          |
| D write, parent link |       |       |          |
