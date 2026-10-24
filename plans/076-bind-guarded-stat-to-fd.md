# Plan 076: Bind GuardedFileSystem.stat to open fd

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat dda3542b..HEAD -- src/core/fs.ts src/tools/list.ts __tests__/core-fs.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Superseded** 2026-10-24 by `docs/superpowers/plans/2026-10-24-stat-through-fd.md`
  (commit `ce61be43`). The branch's `O_RDONLY|O_NOFOLLOW` open blocks on a
  FIFO and fails `EACCES` on a mode-000 entry; do not merge it.
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `dda3542b`, 2026-10-16
- **Issue**: —

## Why this matters

`GuardedFileSystem.stat` validates a path then stats it by path. A swapped ancestor symlink between those two calls escapes the sandbox (TOCTOU). Batch A (PR #106) tightened `list --sizes` by routing it through `ctx.fs.stat` but left the same gap. `src/core/fs.ts:79-100` already binds reads/writes to an open fd via `#assertFdWithinRoots` + `/proc/self/fd` re-check; `stat` must follow. Fix closes the last unbound syscall in the guarded surface and satisfies PR #106 Codex P1.

## Current state

- Relevant files:
  - `src/core/fs.ts` — guarded filesystem; owns `GuardedFileSystem` + `#assertFdWithinRoots` (lines 79-100). `stat` currently does `this.pathGuard.validateExistingPath` then `fsStat(path)` without fd, unlike `readFileWithStats` which opens `O_NOFOLLOW` and re-checks fd.
  - `src/tools/list.ts` — list tool `collect` stats entry paths for `includeSizes`; now calls `ctx.fs.stat` but still hits the unbound `stat` implementation.
  - `src/core/path.ts:308-320` — `isEntryAccessible` and `validateExistingPathDetailed` already realpath every ancestor (symlink-aware).

Excerpts (approximate line numbers from `dda3542b`):

```ts
// src/core/fs.ts:65-78 — guarded class header
export class GuardedFileSystem {
  readonly pathGuard: PathGuard;
  constructor(pathGuard: PathGuard) { this.pathGuard = pathGuard; }

// src/core/fs.ts:79-100 — fd re-check (already exists)
  async #assertFdWithinRoots(handle: FileHandle, requestedPath: string): Promise<string|undefined> {
    let fdPath: string;
    try { fdPath = await fsReadlink(`/proc/self/fd/${String(handle.fd)}`); } catch { return undefined; }
    const inRoots = isAbsolute(fdPath) && !fdPath.endsWith(' (deleted)') &&
      this.pathGuard.allowedRootContaining(normalizePath(fdPath)) !== undefined &&
      !this.pathGuard.isSensitive(normalizePath(fdPath));
    if (!inRoots) throw new FsError(ErrorCode.ACCESS_DENIED, 'Path changed under validation and now resolves outside the allowed roots (TOCTOU).', requestedPath);
  }

// src/core/fs.ts:173-180 — current stat (unbound) — REFRESHED 2026-10-16 against live code
  async stat(
    filePath: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<{ stats: Stats; validPath: string }> {
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    const stats = await withAbort(fsStat(validPath), options?.signal);
    return { stats, validPath };
  }
```

- Conventions: error handling via `FsError`/`ErrorCode.ACCESS_DENIED`; every guarded method wraps I/O in `withAbort(signal)` for cancellation; fd pattern uses `fsOpen(p, O_NOFOLLOW)` then `handle.stat()` + `#assertFdWithinRoots`, finally `handle.close()`. Exemplar: `src/core/fs.ts:readFileWithStats` and `src/core/read.ts:O_NOFOLLOW` flow. Prettier + eslint strict.

## Commands you will need

| Purpose         | Command                                          | Expected on success |
| --------------- | ------------------------------------------------ | ------------------- |
| Build           | `npm run build`                                  | exit 0              |
| Typecheck tests | `npm run type-check:test`                        | exit 0              |
| Lint            | `npm run lint`                                   | exit 0              |
| Tests           | `npm test -- --test-name-pattern="guards\|list"` | all pass            |
| Full check      | `npm run check`                                  | exit 0              |

## Scope

**In scope**:

- `src/core/fs.ts`
- `__tests__/core-fs.test.ts` (add pin)
- `__tests__/helpers.ts` if helper needed for temp symlink setup

**Out of scope**:

- `src/core/path.ts` — do not change ancestor-resolution logic here
- `docs/plan/2026-10-16-arch-audit-findings-3/` — separate workbench
- Contract snapshot `__tests__/contract.test.ts.snapshot` — no MCP surface change

## Git workflow

- Branch: `advisor/076-bind-guarded-stat-to-fd`
- Commit style: `fix(fs): bind GuardedFileSystem.stat to open fd` (see `git log --oneline -10`)
- Do NOT push or open PR unless operator instructs.

## Steps

### Step 1: Add failing pin for the stat fd re-check

REFRESHED 2026-10-16: the original design (stat, then swap ancestor for a symlink) is vacuous, as both calls re-validate by path. The repo already has a deterministic pattern: mock `fsPromises.readlink` so `/proc/self/fd/N` reads back out-of-root, then call the guarded method once. See `__tests__/core-fs.test.ts:145-174` ("every read path re-checks the opened descriptor against the roots"), which must keep passing untouched.

In `__tests__/core-fs.test.ts`, add `it('stat re-checks the opened descriptor against the roots')` modeled line-for-line on that exemplar: create `tmpDir/stat-fd-recheck.txt`, mock `fsPromises.readlink` so any `/proc/self/fd/` path resolves to `'/outside-roots/secret.txt'` (all other paths delegate to the original), call `fs.stat(filePath)` once, `assert.rejects(read(), fsErrorMatcher(ErrorCode.ACCESS_DENIED, 'TOCTOU'), 'stat')`. The mock pattern is `t.mock.method(fsPromises, 'readlink', handler)` wrapped in `syncBuiltinESMExports()` with `t.mock.restoreAll()` in `finally`. Confirm the failing case FIRST: before the Step 3 edit, it must fail because `stat` never throws, not because the mock is broken.

**Verify**: `npm test -- --test-name-pattern="re-checks the opened descriptor"` → new stat entry fails pre-step-3; existing read entries still pass.

### Step 2: Inventory callers of GuardedFileSystem.stat

REFRESHED 2026-10-16: the original expectation (≤3 call sites, list-only) was wrong. `Grep` `\.stat\(` under `src/` and confirm the consumer set matches: `GuardedFileSystem.stat` has ~11 internal callers (fs.ts:444 readEditableText, read.ts:232, resources.ts:236, search.ts:719, list.ts:147, move.ts:487/496, edit.ts:387, patch.ts:146, create.ts:344/390, replace-text.ts:581) plus tests. All want one semantics: guarded stat, abort-aware, return `{ stats, validPath }`. No caller needs different error semantics, so the fd-binding change is uniform. Record in report: two accepted behavior changes on procfs platforms: (a) stat on a write-only file (e.g. mode 0o200) now fails EACCES instead of succeeding, matching the read path's existing behavior; (b) one extra open syscall per stat. Without procfs, the fd open still happens but the re-check degrades to the existing best-effort (no throw).

**Verify**: grep count matches the inventory above within ±1 (allow drift); record result in report.

### Step 3: Bind stat to fd (REFRESHED 2026-10-16)

Replace the `stat` body in `src/core/fs.ts:173-180`, keeping the live return shape `{ stats, validPath }`:

```ts
  async stat(
    filePath: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<{ stats: Stats; validPath: string }> {
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    const handle = await this.#openVerified(validPath, filePath, options?.signal);
    try {
      // O_NOFOLLOW guards the final component; #openVerified's fd re-check closes
      // the swapped-ancestor TOCTOU window that plain fsStat(validPath) leaves open.
      return { stats: await withAbort(handle.stat(), options?.signal), validPath };
    } finally {
      await handle.close();
    }
  }
```

No new imports: `READ_NOFOLLOW`/`O_NOFOLLOW`/`withAbort`/`Stats` are already imported, and `#openVerified` (`fs.ts:106-136`) already does open + `#assertFdWithinRoots` + close-on-ACCESS_DENIED + abort-abandoned-open cleanup. Do not re-inline open/close/assert; reuse the existing primitive.

**Verify**: `npm run build && npm run type-check:test` → exit 0

### Step 4: Green the pin and full suite

**Verify**: `npm test -- --test-name-pattern="re-checks the opened descriptor"` → all entries pass incl. new stat pin; `npm run check` → exit 0

## Test plan

- New pin: mocked out-of-root `/proc/self/fd` readlink → `ACCESS_DENIED` (Step 1 refresh)
- Existing: `npm test` full suite must stay green; especially `core-fs`, `guards`, `path-guard-grant`, `list`, `move` suites.

## Done criteria

- [ ] `npm run type-check:test` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm test` exits 0; new stat fd-recheck pin passes
- [ ] `grep -n "fsStat(" src/core/fs.ts` shows no `fsStat` line inside the `stat` method (fd path used)
- [ ] `git status`/`git diff --stat` only touches in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

- If `src/core/fs.ts` `#assertFdWithinRoots` or `stat` excerpt mismatches live code (drift) — refreshed 2026-10-16 against live code, verified matching
- If a caller inventory mismatch surfaces a consumer needing different error semantics
- If Windows CI requires different syscall (do not add win32 fallback here — report)
- Verification fails twice after fix attempt

## Maintenance notes

- Future `GuardedFileSystem` methods must use fd-binding pattern; raw `fs*` by path is banned except via `PathGuard` + fd re-check.
- Reviewer: check `finally` closes handle on both success and `ACCESS_DENIED`; check `withAbort` on both open and stat.
- Deferred: non-Linux non-procfs fallback is existing best-effort; separate plan if needed.
