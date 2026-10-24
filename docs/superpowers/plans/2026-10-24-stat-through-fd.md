# Stat through the descriptor implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Linux, `GuardedFileSystem.stat` and `statDetailed` stat an open descriptor instead of the path, so a path swapped for a symlink after validation cannot describe a file outside the roots. A FIFO must not block the call, an entry without read permission must still stat, and a refused stat must never let `create` or `move` overwrite a file without asking.

**Architecture:** A new private `#statVerified(validPath, requestedPath, signal)` in `src/core/fs.ts`, used by both `stat` and `statDetailed` (which backs the `stat` tool).

- On Linux with procfs, it opens with `O_PATH | O_NOFOLLOW` and runs the existing descriptor re-check (`#assertFdWithinRoots`). It refuses a descriptor that is a symlink, then calls `fstat`.
- Elsewhere it stats by path, because the re-check reads `/proc/self/fd` and does nothing on other platforms.

The change adds new refusals to `stat`, and `destExists` used to read every refusal as "absent". It now fails closed, so `create` and `move` ask before they overwrite. This replaces plan 076, whose unmerged branch opened with `O_RDONLY | O_NOFOLLOW`.

**Tech Stack:** TypeScript on Node 24 (type stripping), `node:fs/promises`, `node:test`.

**Spec:** `plans/076-bind-guarded-stat-to-fd.md` (the goal and threat), plus these findings. They were measured on 2026-10-24 in WSL Ubuntu (Node 24.21.0, uid 1000) against a copy of `381ca23e`:

| Open flags                         | FIFO         | mode-000 file / 0311 dir | final symlink |
| :--------------------------------- | :----------- | :----------------------- | :------------ |
| `O_RDONLY\|O_NOFOLLOW` (076)       | blocks       | `EACCES`                 | `ELOOP`       |
| `O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK` | ok           | `EACCES`                 | `ELOOP`       |
| `O_PATH\|O_NOFOLLOW` (this plan)   | ok, no block | ok                       | opens link    |

A Node process with a FIFO open blocked in the threadpool did not exit even after `process.exit(0)`, until it was killed. Node does not export `O_PATH` (`constants.O_PATH` is `undefined`).

The six tests in Task 1 were run in WSL:

- Main fails STAT-FD-001, 002, 005 and 006.
- Plan 076's `stat` fails 002, 003 (`still pending after 2000 ms`) and 004 (`EACCES`).
- This plan's code passes all six. On Windows, `npm run check:static` passes, and STAT-FD-006 passes while the other five skip.

## Global Constraints

- Work in `C:\filesystem-mcp` itself, and do not create a git worktree. Start with these commands, in this order:
  1. `git fetch origin`
  2. `git switch -c fix/stat-through-fd origin/main` (`origin/main` is `6c764af0`; its `src/` equals `381ca23e`)
  3. `npm ci`. `node_modules/` is not versioned, and another plan may have left a different SDK installed.
- Do not reuse, rebase or cherry-pick `advisor/076-bind-guarded-stat-to-fd`.
- Change only `stat`, `statDetailed`, the new `#statVerified` and `destExists`. Leave `lstat`, `#openVerified`, `#assertFdWithinRoots`, `READ_NOFOLLOW` and every caller as they are. The callers of `stat` are `fs.ts:591`, `fs.ts:813`, `search.ts:717`, `resources.ts:236`, `tools/batch.ts:75`, `tools/create.ts:333`, `tools/list.ts:143`, `tools/move.ts:487` and `:496`, `tools/read.ts:204` and `tools/replace-text.ts:581`. The `stat` tool calls `statDetailed` at `tools/stat.ts:111`.
- Signatures and return shapes do not change:
  - `stat(filePath, options?)` returns `Promise<{ stats: Stats; validPath: string }>`.
  - `statDetailed(filePath, options?)` returns `Promise<{ requestedPath: string; isSymlink: boolean; stats: Stats }>`.
  - `destExists(fs, path, label)` returns `Promise<boolean>`.
- Error copy, exactly:
  - ancestor escape: the existing `#assertFdWithinRoots` refusal, `ACCESS_DENIED` with `'Path changed under validation and now resolves outside the allowed roots (TOCTOU).'`
  - final-component link: `ErrorCode.SYMLINK_NOT_ALLOWED` with `'Path changed under validation and is now a symlink (TOCTOU).'`, path `requestedPath`
- Known limit, out of scope: on Linux, `#assertFdWithinRoots` refuses any real path that ends in `' (deleted)'` (`fs.ts:99`), because that is how procfs marks an unlinked file. Reads already refuse a file literally named `x (deleted)`, and after this plan `stat` refuses it too. Because `destExists` now fails closed, `create` and `move` ask before they overwrite such a file instead of overwriting it silently. A fix would check `nlink === 0`; record it as a follow-up and do not build it here.
- The Linux-only tests run in WSL, as described under "Running Linux tests". Windows runs them as skips.
- Match the comment density of the `countEntries` block at `src/core/fs.ts:709-716`. Write one-line whys, and no comment that restates the code.
- Run the shell commands in Git Bash. The `wsl` commands are the exception: run them from PowerShell.
- Run `npx prettier --write <changed files>` before any `npm run check`, because `check:static` runs `prettier --check .` before the tests. `plans/` and `docs/superpowers/plans/` are Prettier-checked too.
- Commit with a message file, never a bare `git commit`, because the harness sets `GIT_EDITOR=true`, which aborts it. Use the Write tool to write each message to `<scratchpad>/commit-msg.txt`, then run `git commit -F <scratchpad>/commit-msg.txt`. Every message ends with these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_015x93MERvWLDzoqaguLSmJj`
- Do not push or open a PR unless the user asks.

## Running Linux tests

In WSL, Node comes from nvm and is not on the login PATH. An inline `wsl -- bash -c '...'` breaks on the expanded Windows PATH. Instead, write this script to the session scratchpad as `wsl-test.sh`, with the Write tool, which writes LF line endings:

```bash
#!/usr/bin/env bash
# usage: wsl-test.sh <repo dir as /mnt/c/...> <name pattern or ""> [node flags and test files...]
source ~/.nvm/nvm.sh >/dev/null
cd "$1" || exit 1
node --test --test-timeout=60000 ${2:+--test-name-pattern="$2"} "${@:3}"
```

Run it from **PowerShell**, spelling the scratchpad path `C:\a\b` as `/mnt/c/a/b`:

```powershell
wsl -- bash /mnt/c/<scratchpad>/wsl-test.sh /mnt/c/filesystem-mcp "STAT-FD-" __tests__/core-fs.test.ts
```

Git Bash rewrites `/mnt/c/...` arguments to `C:/Program Files/Git/mnt/c/...`. If you must run this from Git Bash, prefix it with `MSYS_NO_PATHCONV=1`.

The Windows `node_modules` work in WSL as they are. `os.tmpdir()` there is `/tmp` (ext4, real mode bits), and the user is uid 1000, so `EACCES` reproduces.

## Review Focus

- **A FIFO in an allowed folder**, met by `move`, `edit`, `list --sizes`, the `stat` tool or a resource read: the call must return or refuse, never hang. Pinned by STAT-FD-003, which has a release valve so that a regression fails instead of wedging the test process.
- **A mode-000 file or a search-only (0311) directory**, for example the source of a `move`: it must still stat, as on main. Pinned by STAT-FD-004.
- **A final component swapped for a symlink to an outside file**, through `stat` or the `stat` tool's `statDetailed`: the result must be a refusal, never the outside file's size or mtime. Pinned by STAT-FD-002 and STAT-FD-005.
- **A destination whose stat is refused**, for example during a race or for a file named `x (deleted)`: `create` and `move` must ask before overwriting it, never treat it as absent. Pinned by STAT-FD-006.
- **Windows and macOS** must behave exactly as on main: the gate keeps the stat by path. The existing suite pins this on the `windows-latest` leg. No new test is needed, because the gate is a constant.

---

### Task 1: Linux stats go through a descriptor

**Files:**

- Modify: `src/core/fs.ts:57-62` (open-flag constants), `:198-205` (`stat`), `:668-676` (`statDetailed`) and `:803-820` (`destExists`)
- Modify: `__tests__/core-fs.test.ts:2-3` and `:22-24` (imports), `:1256-1263` (hoist a helper), and append a `describe` after line 1742
- Modify: `CHANGELOG.md` (`## [Unreleased]`)

**Interfaces:**

- Consumes:
  - existing private members of `GuardedFileSystem`: `#abandonOnAbort(pending, signal, release, label)` and `#assertFdWithinRoots(handle, requestedPath)`
  - `COUNT_THROUGH_FD`, defined in `fs.ts` at line 62
  - `O_NOFOLLOW`, already imported from `./read.ts` at `fs.ts:45`
- Produces:
  - the module constant `STAT_NOFOLLOW`
  - the private method `#statVerified(validPath: string, requestedPath: string, signal: AbortSignal | undefined): Promise<Stats>`
  - No exports change.

- [ ] **Step 0: Commit this plan on the branch**

```bash
git add docs/superpowers/plans/2026-10-24-stat-through-fd.md
```

Commit with the subject `docs(plan): add the O_PATH stat plan` and the two trailer lines, as the repo did in `d2da5c4e`.

- [ ] **Step 1: Hoist `failIfPendingAfter` and add the test imports**

1. Move the `failIfPendingAfter` arrow function, with its one-line comment, from inside `describe('GuardedFileSystem.countEntries', …)` (`__tests__/core-fs.test.ts:1256-1263`) to module scope, directly above that `describe`. Remove the two-space indent and change nothing else.
2. Add `import { constants } from 'node:fs';` on its own line above `import type { Dir, PathLike } from 'node:fs';` (line 2).
3. In the `../src/core/errors.ts` import (line 22), add `FsError`, which gives `import { ErrorCode, FsError, isFsError, isNodeError, Problem } from '../src/core/errors.ts';`.
4. Change the `../src/core/fs.ts` import (line 24) to `import { destExists, GuardedFileSystem } from '../src/core/fs.ts';`.

Run: `node --test --test-timeout=60000 __tests__/core-fs.test.ts`
Expected: `ℹ fail 0`. The move changes no behavior.

- [ ] **Step 2: Write the six failing tests**

Append this `describe` at the end of `__tests__/core-fs.test.ts`. It is exact code: it passed Prettier, ESLint and the type-check in the planning prototype.

```ts
describe('GuardedFileSystem.stat', () => {
  let root: string;
  let ctx: FilesystemServerContext;
  let fs: GuardedFileSystem;

  before(async () => {
    root = await createTestRoot();
    ctx = await createTestServer([root]);
    fs = new GuardedFileSystem(ctx.pathGuard);
  });

  after(async () => {
    if (ctx) {
      ctx.disposeRuntimeState();
      await ctx.mcp.close();
    }
    if (root) {
      await cleanupTestRoot(root);
    }
  });

  // Runs `swap` once, right after the guard validates `target`, as a racing process would.
  const swapAfterValidation = (
    method: 'validateExistingPath' | 'validateExistingPathDetailed',
    target: string,
    swap: () => Promise<void>,
  ): (() => void) => {
    const guard = ctx.pathGuard;
    const validate = guard[method].bind(guard) as (path: string) => Promise<unknown>;
    let swapped = false;
    Object.assign(guard, {
      [method]: async (requestedPath: string) => {
        const result = await validate(requestedPath);
        if (requestedPath === target && !swapped) {
          swapped = true;
          await swap();
        }
        return result;
      },
    });
    return () => Reflect.deleteProperty(guard, method);
  };

  it(
    'STAT-FD-001: refuses an ancestor swapped for a symlink out of the roots',
    { skip: process.platform !== 'linux' && 'descriptor re-check is Linux-only' },
    async () => {
      const dir = join(root, 'swap-ancestor');
      const file = await writeTestFile(dir, 'f.txt', 'inside');
      const outside = await mkdtemp(join(tmpdir(), 'fsmcp-outside-'));
      await writeTestFile(outside, 'f.txt', 'outside, longer');
      const restore = swapAfterValidation('validateExistingPath', file, async () => {
        await rename(dir, `${dir}.bak`);
        await symlink(outside, dir, 'dir');
      });
      try {
        await assert.rejects(fs.stat(file), fsErrorMatcher(ErrorCode.ACCESS_DENIED, 'TOCTOU'));
      } finally {
        restore();
        await cleanupTestRoot(outside);
      }
    },
  );

  it(
    'STAT-FD-002: refuses a final component swapped for a symlink',
    { skip: process.platform !== 'linux' && 'descriptor re-check is Linux-only' },
    async () => {
      const file = await writeTestFile(root, 'swap-final.txt', 'inside');
      const outside = await mkdtemp(join(tmpdir(), 'fsmcp-outside-'));
      const secret = await writeTestFile(outside, 'secret.txt', 'outside, longer');
      const restore = swapAfterValidation('validateExistingPath', file, async () => {
        await rename(file, `${file}.bak`);
        await symlink(secret, file);
      });
      try {
        await assert.rejects(
          fs.stat(file),
          fsErrorMatcher(ErrorCode.SYMLINK_NOT_ALLOWED, 'TOCTOU'),
        );
      } finally {
        restore();
        await cleanupTestRoot(outside);
      }
    },
  );

  it(
    'STAT-FD-003: a FIFO stats without blocking',
    { skip: process.platform === 'win32' && 'Windows has no FIFOs' },
    async (t) => {
      const { spawnSync } = await import('node:child_process');
      const fifo = join(root, 'stat.fifo');
      if (spawnSync('mkfifo', [fifo]).error !== undefined) return t.skip('mkfifo not available');
      try {
        const { stats } = await failIfPendingAfter(fs.stat(fifo), 2000);
        assert.ok(stats.isFIFO());
      } finally {
        // A read-only open of a FIFO blocks until a writer opens it; a read-write open
        // releases any open a regression left blocked, so the test process can exit.
        const release = await fsPromises.open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
        await release.close();
      }
    },
  );

  it('STAT-FD-004: an entry without read permission still stats', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX mode bits and a non-root user');
    }
    const file = await writeTestFile(root, 'locked.txt', 'x');
    const dir = join(root, 'locked-dir');
    await writeTestFile(dir, 'child.txt', 'y');
    await chmod(file, 0o000);
    await chmod(dir, 0o311);
    try {
      assert.strictEqual((await fs.stat(file)).stats.size, 1);
      assert.ok((await fs.stat(dir)).stats.isDirectory());
    } finally {
      await chmod(file, 0o644);
      await chmod(dir, 0o755);
    }
  });

  it(
    'STAT-FD-005: statDetailed refuses a final component swapped for a symlink',
    { skip: process.platform !== 'linux' && 'descriptor re-check is Linux-only' },
    async () => {
      const file = await writeTestFile(root, 'swap-detailed.txt', 'inside');
      const outside = await mkdtemp(join(tmpdir(), 'fsmcp-outside-'));
      const secret = await writeTestFile(outside, 'secret.txt', 'outside, longer');
      const restore = swapAfterValidation('validateExistingPathDetailed', file, async () => {
        await rename(file, `${file}.bak`);
        await symlink(secret, file);
      });
      try {
        await assert.rejects(
          fs.statDetailed(file),
          fsErrorMatcher(ErrorCode.SYMLINK_NOT_ALLOWED, 'TOCTOU'),
        );
      } finally {
        restore();
        await cleanupTestRoot(outside);
      }
    },
  );

  it('STAT-FD-006: destExists counts a refused stat as present', async () => {
    const refused = new FsError(ErrorCode.ACCESS_DENIED, 'refused', 'x');
    const refusingFs = { stat: () => Promise.reject(refused) };
    assert.strictEqual(await destExists(refusingFs, 'x', 'test'), true);
    assert.strictEqual(await destExists(fs, join(root, 'never-created.txt'), 'test'), false);
  });
});
```

- [ ] **Step 3: Run the tests to verify the red state**

1. In WSL, run with the pattern `"STAT-FD-"` on `__tests__/core-fs.test.ts`.
   Expected: `ℹ pass 2`, `ℹ fail 4`. STAT-FD-001, 002 and 005 fail with `Missing expected rejection.`, STAT-FD-006 fails on its first `strictEqual`, and STAT-FD-003 and 004 pass.
2. On Windows, run `node --test --test-timeout=60000 --test-name-pattern="STAT-FD-" __tests__/core-fs.test.ts`.
   Expected: `ℹ fail 1` (STAT-FD-006), with the other five skipped.

Any other result is a STOP: report the output.

- [ ] **Step 4: Add the flag constant**

In `src/core/fs.ts`, after `DIR_NOFOLLOW` (line 59), add:

```ts
// Descriptor open for stat. O_PATH opens no file content, so a FIFO cannot block it and a
// mode-000 entry still stats. Node does not export O_PATH; 0o10000000 is its value on every
// Linux architecture Node builds for. Used only under COUNT_THROUGH_FD.
const STAT_NOFOLLOW = 0o10000000 | O_NOFOLLOW;
```

Change the second line of the `COUNT_THROUGH_FD` comment (line 61) to these two lines:

```ts
// as the read path's re-check does; elsewhere the count reads the directory by path, and
// stat stats it by path.
```

Keep the constant's name: renaming it would touch 4 lines and buy nothing.

- [ ] **Step 5: Add `#statVerified` and route `stat` and `statDetailed` through it**

In `stat` (`fs.ts:202-204`), keep the `validateExistingPath` line and replace the two lines after it with:

```ts
return { stats: await this.#statVerified(validPath, filePath, options?.signal), validPath };
```

Directly after `stat`, add the private method. The order of the checks is the fix, so use this code:

```ts
  /**
   * Stats `validPath` through a descriptor under COUNT_THROUGH_FD, by path elsewhere: an
   * ancestor swapped for a symlink after validation fails the re-check, and a final
   * component swapped for one opens as the link itself.
   */
  async #statVerified(
    validPath: string,
    requestedPath: string,
    signal: AbortSignal | undefined,
  ): Promise<Stats> {
    if (!COUNT_THROUGH_FD) return await withAbort(fsStat(validPath), signal);
    const handle = await this.#abandonOnAbort(
      fsOpen(validPath, STAT_NOFOLLOW),
      signal,
      (late) => late.close(),
      `stat descriptor for ${validPath}`,
    );
    try {
      await this.#assertFdWithinRoots(handle, requestedPath);
      const stats = await withAbort(handle.stat(), signal);
      if (stats.isSymbolicLink()) {
        throw new FsError(
          ErrorCode.SYMLINK_NOT_ALLOWED,
          'Path changed under validation and is now a symlink (TOCTOU).',
          requestedPath,
        );
      }
      return stats;
    } finally {
      await handle.close();
    }
  }
```

In `statDetailed` (`fs.ts:674`), replace `const stats = await withAbort(fsStat(resolvedPath), options?.signal);` with:

```ts
const stats = await this.#statVerified(resolvedPath, filePath, options?.signal);
```

- [ ] **Step 6: Make `destExists` fail closed (`fs.ts:803-820`)**

Replace the doc comment (lines 803-806) with:

```ts
/**
 * Returns whether `path` exists, treating "not found" as absent. Any other stat
 * failure is logged and counts as present, so a destination whose stat is refused
 * is confirmed before it is overwritten, never written over as if absent. Used for
 * TOCTOU re-checks between plan and execute phases.
 */
```

Then replace the `catch` body (lines 816-819) with:

```ts
if (isMissing(err)) return false;
Logger.warn(`${label}: dest stat failed unexpectedly for "${path}": ${String(err)}`);
return true;
```

All four callers handle `true` already. At planning time, `create` asks for confirmation (`create.ts:155`) or refuses `appeared after overwrite confirmation was checked` (`create.ts:228`). `move` asks for confirmation (`move.ts:179`) or ends `CANCELLED` (`move.ts:228`).

- [ ] **Step 7: Run the tests to verify they pass**

1. In WSL, run with the pattern `"STAT-FD-"` on `__tests__/core-fs.test.ts`.
   Expected: `ℹ pass 6`, `ℹ fail 0`.
2. On Windows, run `node --test --test-timeout=60000 --test-name-pattern="STAT-FD-" __tests__/core-fs.test.ts`.
   Expected: `ℹ pass 1`, `ℹ fail 0`, and 5 skipped.

- [ ] **Step 8: Format, then run the full suites**

1. Format:

   ```bash
   npx prettier --write src/core/fs.ts __tests__/core-fs.test.ts
   ```

2. On Windows, run `npm run check`.
   Expected: exit 0 and `ℹ fail 0`.
3. On Linux, run the suite with the coverage floor that `package.json` `test:coverage` sets:

   ```powershell
   wsl -- bash /mnt/c/<scratchpad>/wsl-test.sh /mnt/c/filesystem-mcp "" --experimental-test-coverage "--test-coverage-include=src/**" --test-coverage-lines=92 --test-coverage-branches=85 --test-coverage-functions=91
   ```

   Expected: `ℹ fail 0`, and no `coverage threshold` failure line. On 2026-10-24 the prototype measured `all files | 96.11 | 91.50 | 94.77`, with 968 pass and 0 fail. On Windows it showed 948 pass and 0 fail.

`__tests__/outbound-regressions.test.ts:122` takes about 3 s alone, against a 5 s client timeout. Under full-suite load in WSL it timed out once on 2026-10-24, with and without this change. If it is the only failure, re-run that one file. If it passes alone, record that in the report and continue. Any other failure is a STOP.

- [ ] **Step 9: Add the CHANGELOG entry**

In `CHANGELOG.md`, insert a `### Security` section after the last bullet of the `## [Unreleased]` section (the Smithery bullet, which ends at line 15) and before `## [2.10.1]`. Keep a Changelog orders Security last. Use this text:

```markdown
### Security

- **A path swapped for a symlink while a tool checks it is refused on
  Linux.** `stat`, and every tool that checks a file's size or type before
  acting (`move`, `edit`, `read`, `list` with sizes, resource reads), now stat
  an open descriptor that is re-checked against the allowed folders. A parent
  directory swapped for a symlink out of the roots is refused with
  `ACCESS_DENIED`, and a file swapped for a symlink with
  `SYMLINK_NOT_ALLOWED`. Before, the stat could describe the outside file.
  FIFOs and files without read permission stat as before.
- **`create` and `move` ask before overwriting a destination they cannot
  stat.** A destination whose stat failed for any reason other than "not
  found" used to count as absent, so it could be overwritten without the
  usual confirmation.
```

- [ ] **Step 10: Commit**

```bash
npx prettier --write CHANGELOG.md
npx prettier --check .
git add src/core/fs.ts __tests__/core-fs.test.ts CHANGELOG.md
```

Commit message (contents of `commit-msg.txt`):

```text
fix(fs): stat an O_PATH descriptor on Linux

stat and statDetailed validated a path and then stat-ed it by path, so an
ancestor or the file itself swapped for a symlink in between described a
file outside the roots. On Linux both now open O_PATH|O_NOFOLLOW, re-check
the descriptor against the roots, and refuse one that is a symlink. O_PATH
opens no content: a FIFO cannot block and a mode-000 entry still stats,
which the O_RDONLY open of plan 076 broke.

destExists now counts any stat failure other than "not found" as present,
so a refused destination is confirmed before create or move overwrites it.

Supersedes plan 076.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x93MERvWLDzoqaguLSmJj
```

---

### Task 2: Retire plan 076

**Files:**

- Modify: `plans/076-bind-guarded-stat-to-fd.md` (the `## Status` list, line 10)
- Modify: `plans/README.md` (the row that starts with `| 076 |`)

**Interfaces:**

- Consumes: Task 1's commit hash, from `git rev-parse --short HEAD` after Task 1.
- Produces: nothing.

- [ ] **Step 1: Mark the plan superseded**

In `plans/076-bind-guarded-stat-to-fd.md`, insert this as the first bullet under `## Status`:

```markdown
- **Superseded** 2026-10-24 by `docs/superpowers/plans/2026-10-24-stat-through-fd.md`
  (commit `<task 1 hash>`). The branch's `O_RDONLY|O_NOFOLLOW` open blocks on a
  FIFO and fails `EACCES` on a mode-000 entry; do not merge it.
```

In `plans/README.md`, replace the last cell of the `| 076 |` row (the status cell) with: `SUPERSEDED by docs/superpowers/plans/2026-10-24-stat-through-fd.md (commit <task 1 hash>); branch advisor/076-bind-guarded-stat-to-fd must not merge`.

- [ ] **Step 2: Verify and commit**

```bash
npx prettier --write plans/076-bind-guarded-stat-to-fd.md plans/README.md
npx prettier --check .
git add plans/076-bind-guarded-stat-to-fd.md plans/README.md
```

Expected: Prettier exits 0.

Commit message (contents of `commit-msg.txt`):

```text
docs(plans): mark plan 076 superseded by the O_PATH stat fix

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x93MERvWLDzoqaguLSmJj
```

Deleting the `advisor/076-bind-guarded-stat-to-fd` branch is the user's call. Name it in the report, but do not delete it.
