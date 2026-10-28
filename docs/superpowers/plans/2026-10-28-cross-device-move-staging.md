# Cross-device move staging implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cross-device move gives the same result as a same-device rename. It never merges into an existing directory, and it never leaves a half-copied tree at the destination.

**Architecture:** On `EXDEV`, `performRenameWithFallback` copies the source to a temp sibling of the destination (`<validDest>.<12 hex>.tmp`), on the destination's device. It then renames that temp entry onto the destination, which is a same-device rename, so the OS gives its own refusals (`ENOTEMPTY`/`EPERM`/`EISDIR`/`ENOTDIR`). Only after that does it remove the source. Any failure before the final rename removes the temp copy and leaves the source untouched. Task 2 is separate housekeeping: it deletes the finished plan files in `plans/`.

**Tech Stack:** TypeScript, Node >= 24, `node:test`, `node:crypto` `randomUUID`.

**Spec:** Audit findings 1 and 2 from the 2026-10-28 ponytail audit (this conversation). Finding 1: on `EXDEV`, `fs.cp` merges into an existing destination directory and leaves partial trees on failure (`src/tools/move.ts:555-600`). Finding 2: 74 finished plan files remain in `plans/`.

## Global Constraints

- Temp name format matches `GuardedFileSystem.writeFile`: `` `${validDest}.${randomUUID().replace(/-/g, '').slice(0, 12)}.tmp` ``.
- Every fs call goes through `fsOps` (`GuardedFileSystem`), never raw `node:fs`, so path validation and undo capture still apply.
- Keep the existing error text `copy succeeded but source removal failed (destination holds a copy)` unchanged.
- `npm run check` must pass. Never hand-edit versions in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json` or `.cursor-plugin/plugin.json`.
- Do not change the contract snapshot. This change is internal; `__tests__/contract.test.ts` must stay green without `--test-update-snapshots`.

## Review Focus

- A directory moved onto an existing non-empty directory across devices must fail and leave both trees as they were. This is pinned by the Task 1 real-fs test `refuses to merge into an existing directory`.
- A copy that fails halfway (`ENOSPC`) must leave no `*.tmp` entry next to the destination. This is pinned by the Task 1 test `a failed copy removes the temp copy and keeps the source`.
- A confirmed file-over-file overwrite across devices must still replace the file, because a rename of a file over a file replaces it on every OS. This is pinned by the Task 1 real-fs test `replaces an existing file`.
- If removing the temp copy itself fails, the original error must still be the one thrown, and the cleanup failure is only logged. This is pinned by the Task 1 test `a failed temp cleanup keeps the original error`.
- An abort during the copy must still rethrow as an abort (`rethrowIfAborted`) after cleanup. The existing behaviour is kept; no new test, since the cleanup path is shared with the `ENOSPC` test.

---

### Task 1: Stage cross-device moves through a temp sibling

**Files:**

- Modify: `src/tools/move.ts:555-600` (`performRenameWithFallback`), plus imports
- Test: `__tests__/move-exdev.test.ts`

**Interfaces:**

- Consumes: `GuardedFileSystem.rename(old, new)`, `.cp(src, dst, opts)`, `.rm(path, opts)`. All already exist in `src/core/fs.ts`.
- Produces: unchanged signature `performRenameWithFallback(validSource: string, validDest: string, fsOps: Pick<GuardedFileSystem, 'rename' | 'cp' | 'rm'>, originalSource: string): Promise<void>`.

- [ ] **Step 1: Make `fakeOps` record arguments**

In `__tests__/move-exdev.test.ts`, push `` `${name} ${args.join(' ')}` `` for each call instead of the bare name. Each behavior callback receives the call's args, so `rename` can reject only for the first `('/src', '/dst')` call. Update the 5 existing `calls` assertions to the new form; for example, the plain-rename case becomes `['rename /src /dst']`.

- [ ] **Step 2: Write the failing fake-ops tests**

```ts
const TMP = /^\/dst\.[0-9a-f]{12}\.tmp$/;

it('EXDEV copies to a temp sibling, renames it into place, then removes the source', async () => {
  const { ops, calls } = fakeOps({
    rename: (from) => (from === '/src' ? Promise.reject(errno('EXDEV')) : Promise.resolve()),
  });
  await performRenameWithFallback('/src', '/dst', ops, 'src');
  const tmp = calls[1]?.split(' ')[2] ?? '';
  assert.match(tmp, TMP);
  assert.deepStrictEqual(calls, [
    'rename /src /dst',
    `cp /src ${tmp}`,
    `rename ${tmp} /dst`,
    'rm /src',
  ]);
});

it('a refused final rename removes the temp copy and keeps the source', async () => {
  // rename rejects EXDEV for /src, ENOTEMPTY for the temp entry
  // expect: rejects with code 'ENOTEMPTY'; last call is `rm ${tmp}`; no 'rm /src'
});

it('a failed copy removes the temp copy and keeps the source', async () => {
  // cp rejects ENOSPC → rejects with code 'ENOSPC'; calls end with `rm ${tmp}`; no 'rm /src'
});

it('a failed temp cleanup keeps the original error', async () => {
  // cp rejects ENOSPC, rm rejects EPERM → rejects with code 'ENOSPC'
});
```

Fill in the three commented bodies the same way as the first test. Replace the old test `a failed copy rethrows the copy error and never removes the source` with the `ENOSPC` test above. Keep `copy ok but remove failed says the destination holds a copy`, which now fails at `rm /src` after the final rename.

- [ ] **Step 3: Write the failing real-fs tests**

In the same file, add a `describe('performRenameWithFallback on disk', ...)`. Build it with `createTestRoot`/`cleanupTestRoot` and `makeGuard([root])` from `__tests__/helpers.ts`, plus `new GuardedFileSystem(guard)`. The ops wrap the real fs; only `rename` throws `errno('EXDEV')` on its first call:

```ts
const exdevOnce = (fs: GuardedFileSystem): FsOps => {
  let first = true;
  return {
    rename: (a: string, b: string) => {
      if (first) {
        first = false;
        return Promise.reject(errno('EXDEV'));
      }
      return fs.rename(a, b);
    },
    cp: fs.cp.bind(fs),
    rm: fs.rm.bind(fs),
  } as FsOps;
};
```

Tests:

- `refuses to merge into an existing directory`: `src/x.txt='x'` and `dst/y.txt='y'`. The call rejects. Then `readdir(dst)` deep-equals `['y.txt']`, `readdir(src)` deep-equals `['x.txt']`, and `readdir(root)` has no entry matching `/\.tmp$/`.
- `replaces an existing file`: `a.txt='new'` and `b.txt='old'`. The call resolves. Then `b.txt` reads `'new'`, `a.txt` is gone, and there is no `.tmp` entry in `root`.
- `moves a directory to a missing destination`: `src/x.txt` moved to `dst`. Then `dst/x.txt` exists and `src` is gone.

- [ ] **Step 4: Run the tests and see them fail**

Run: `npm test -- __tests__/move-exdev.test.ts`
Expected: the new tests FAIL. Before the fix, `cp` targets `/dst` directly and the merge test finds `x.txt` inside `dst`.

- [ ] **Step 5: Implement the staging in `performRenameWithFallback`**

Order inside the `EXDEV` branch:

1. Build `tmp` (Global Constraints format) with `randomUUID` from `node:crypto`.
2. `cp(validSource, tmp, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })`.
3. `rename(tmp, validDest)`.
4. Set `copied = true`.
5. `rm(validSource, { recursive: true, force: true })`.

If step 2 or 3 throws, run `rm(tmp, { recursive: true, force: true })` before rethrowing. If that cleanup throws, `Logger.warn` it and rethrow the original error. Keep `rethrowIfAborted` and the existing "destination holds a copy" path for a failure in step 5. Update the function's comment so it says why the copy is staged: the final same-device rename gives the OS's own refusals, and a partial copy never reaches the destination.

- [ ] **Step 6: Run the tests and see them pass**

Run: `npm test -- __tests__/move-exdev.test.ts`
Expected: all PASS.

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/tools/move.ts __tests__/move-exdev.test.ts
git commit -m "fix(move): stage cross-device moves through a temp sibling"
```

Use a commit body that names both failures fixed (merge into an existing directory, partial tree left on failure), plus the attribution lines.

### Task 2: Delete finished plans

**Files:**

- Delete: every `plans/NNN-*.md` except 061, 062, 069, 077, 078, 079, 080
- Modify: `plans/README.md`
- Modify: any doc that links a deleted plan (found in Step 1)

**Interfaces:** none.

- [ ] **Step 1: Find links to plans**

Run: `git grep -nE "plans/[0-9]{3}" -- . ":!plans/"`
Expected: a list of links to fix, or no output. A link to a deleted plan in `CHANGELOG.md` stays as is, because it is history. Any other link gets replaced with the plan's title in plain text.

- [ ] **Step 2: Delete the finished plans**

Run: `git ls-files "plans/[0-9]*.md" | grep -vE "plans/0(61|62|69|77|78|79|80)-" | xargs git rm -q`
Then run: `git ls-files plans | wc -l`
Expected: `8` (7 open plans + README).

- [ ] **Step 3: Trim `plans/README.md`**

Keep the header paragraph and the status table rows for 061, 062, 069 and 077–080. Delete every other row, and every section that only describes deleted plans. Then run `npx prettier --write plans/`.

- [ ] **Step 4: Verify**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A plans docs README.md
git commit -m "docs(plans): delete finished plans"
```
