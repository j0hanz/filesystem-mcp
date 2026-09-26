# Plan 014: A cancelled or timed-out write never reports failure after its rename has committed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 1eb94134..HEAD -- src/core/fs.ts __tests__/core-fs.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1eb94134`, 2026-09-26

## Why this matters

Every overwrite (`create` with overwrite, `edit`, `patch`, `replace_text`)
goes through `atomicWriteFile` in `src/core/fs.ts`: write a temp file, then
`rename` it over the target. The rename is wrapped in `withAbort`, which races
it against the request's abort signal. If the signal fires while the rename
is in flight — a client cancel, or a tool timeout such as `replace_text`'s
5-second budget — `withAbort` rejects immediately even though the rename then
completes. The tool reports CANCELLED or TIMEOUT for a file that **was**
replaced, and a client that retries applies the change twice (for
`replace_text`, a second round of replacements on already-replaced text).

This contradicts a rule the codebase already states and follows elsewhere:
`src/core/concurrency.ts:59-62` ("once an item has run, its result is real
work that a write caller may have committed to disk … a client retry would
append twice"), and the `appendFile` path in the same file avoids `withAbort`
for exactly this reason (`src/core/fs.ts:239-243`). The fix is to check the
signal one last time **before** the rename and then let the rename run to
completion unraced.

The advisor reproduced the bug deterministically against commit `1eb94134`:
with the rename patched to abort the signal right after the real rename
finishes, `GuardedFileSystem.writeFile` rejected with the abort reason while
the file on disk already held the new content.

## Current state

- `src/core/fs.ts` — guarded filesystem primitives. `atomicWriteFile`
  (lines 62-109) is the only caller of `fsRename` inside a write.
  `withAbort` is imported from `./concurrency.ts` (line 22) and is still used
  by several read paths in this file (lines 166, 175, 334, 366, 374, 398), so
  **the import stays**.
- `src/core/concurrency.ts:176-195` — `withAbort(promise, signal)`:
  `Promise.race` of the promise against a rejection on `abort`. It cannot
  cancel the underlying operation; it only stops waiting for it.
- `__tests__/core-fs.test.ts` — unit tests for `GuardedFileSystem`; the
  abort tests `TC-FUNC-047b` / `TC-FUNC-047c` (lines 337-360) are the
  structural pattern.

`src/core/fs.ts:91-108` today:

```ts
try {
  signal?.throwIfAborted();
  await fsWriteFile(tempPath, content, { encoding, signal });
  if (existingMode !== undefined) {
    await fsChmod(tempPath, existingMode);
  }
  await withAbort(fsRename(tempPath, validPath), signal);
} catch (error) {
  try {
    await fsUnlink(tempPath);
  } catch (cleanupError) {
    Logger.warn(
      `Failed to clean up temp file ${tempPath} after write error (${formatUnknownErrorMessage(error)}): ${formatUnknownErrorMessage(cleanupError)}`,
    );
  }
  throw error;
}
return { validPath };
```

Note a second defect of the same line: `fsRename(...)` is evaluated **before**
`withAbort` runs its own `signal.throwIfAborted()`. So a signal that aborted
during `fsChmod` starts the rename, then throws, and the `catch` unlinks the
temp file while that rename is still in flight. The fix below removes this
too, because the abort check moves in front of the rename call.

The precedent comment to match, `src/core/fs.ts:239-243` (in `appendFile`):

```ts
// fs.promises.appendFile takes no signal, so a withAbort race would
// report failure while the append still lands — a client retry then
// appends twice. ...
```

How the test intercepts the rename: `fs.ts` imports `rename as fsRename`
from `node:fs/promises` as an ESM live binding. Node's
`syncBuiltinESMExports()` (from `node:module`) copies the CommonJS export
object's current properties onto the builtin ESM bindings. Patching
`fsPromises.rename` with `mock.method` from `node:test` and then calling
`syncBuiltinESMExports()` therefore redirects `fs.ts`'s `fsRename`.
`mock.restoreAll()` plus a second `syncBuiltinESMExports()` restores it. The
advisor verified this technique on Node 24.15, and verified that both
`import fsPromises from 'node:fs/promises'` and the `mock.method` call
type-check under this repo's `NodeNext` + `verbatimModuleSyntax` settings.

## Commands you will need

| Purpose      | Command                                         | Expected on success |
| ------------ | ----------------------------------------------- | ------------------- |
| Static check | `npm run check:static`                          | exit 0              |
| All tests    | `npm test`                                      | all pass            |
| One suite    | `npm test -- --test-name-pattern="TC-FUNC-047"` | suite passes        |

`npm run check:static` = build + `tsc -p tsconfig.test.json` + eslint
(`--max-warnings=0`) + `prettier --check .` + knip.

## Scope

**In scope** (the only files you should modify):

- `src/core/fs.ts` — the rename line in `atomicWriteFile` and its comment
- `__tests__/core-fs.test.ts` — two new tests
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `withAbort` in `src/core/concurrency.ts` — it is correct for reads; the bug
  is using it on a commit step.
- The other `withAbort` call sites in `src/core/fs.ts` (stat / lstat /
  readFile) — reads are safe to abandon.
- `GuardedFileSystem.rename` (`fs.ts:196-202`) and `src/tools/move.ts` — they
  take no signal today.
- `appendFile` — already correct.
- Tool-level timeout values (`timeoutMs` in tool definitions).

## Git workflow

- Branch: `advisor/014-atomic-write-commit` from `main`.
- Commit per step, conventional-commit style matching the log, for example
  `test(fs): pin atomic write outcome when abort lands mid-rename` and
  `fix(fs): never race the atomic write's commit rename against abort`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the regression test (it must fail now)

In `__tests__/core-fs.test.ts`:

1. Adjust the imports at the top of the file. The repo's ESLint
   `no-duplicate-imports` rule forbids two value imports from one module, so
   the default import joins the existing named-import line:

   - Replace
     `import { chmod, readFile, stat, writeFile } from 'node:fs/promises';`
     with
     `import fsPromises, { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises';`
   - Replace `import { after, before, describe, it } from 'node:test';` with
     `import { after, before, describe, it, mock } from 'node:test';`
   - Add `import type { PathLike } from 'node:fs';` and
     `import { syncBuiltinESMExports } from 'node:module';`

   Run `npx prettier --write __tests__/core-fs.test.ts` afterwards; its
   sort-imports plugin places the new lines. Do not hand-sort.

2. Inside the top-level `describe('Core Filesystem (GuardedFileSystem + core search) Tests', …)`
   block, next to `TC-FUNC-047b` / `TC-FUNC-047c`, add:

   ```ts
   it('TC-FUNC-047d: an abort landing mid-rename still reports the committed write', async () => {
     const filePath = await writeTestFile(tmpDir, 'commit_race.txt', 'old\n');
     const controller = new AbortController();
     const originalRename = fsPromises.rename;
     // The real rename completes, THEN the signal fires — before the rename's
     // promise settles to its caller. Racing that promise against the signal
     // would reject even though the file was already replaced.
     mock.method(fsPromises, 'rename', async (from: PathLike, to: PathLike): Promise<void> => {
       await originalRename(from, to);
       controller.abort(new Error('late abort'));
     });
     syncBuiltinESMExports();
     try {
       await fs.writeFile(filePath, 'new\n', { signal: controller.signal });
     } finally {
       mock.restoreAll();
       syncBuiltinESMExports();
     }
     assert.strictEqual(await readFile(filePath, 'utf-8'), 'new\n');
     const leftovers = (await readdir(dirname(filePath))).filter((name) =>
       name.startsWith('commit_race.txt.'),
     );
     assert.deepStrictEqual(leftovers, [], 'no temp file may be left behind');
   });
   ```

   `writeTestFile`, `fs`, `tmpDir`, `readFile`, `dirname` and `assert` are
   already in scope in this file.

**Verify**: `npm test -- --test-name-pattern="TC-FUNC-047d"` → the test
**fails**, rejecting with `late abort` (today's `withAbort` race). If it
passes on the unmodified source, STOP.

### Step 2: Check the signal before the rename, then commit unraced

In `src/core/fs.ts`, replace the single line

```ts
await withAbort(fsRename(tempPath, validPath), signal);
```

with:

```ts
// Last cancellation point. The rename IS the commit: once it starts the
// target may already be replaced, so it is never raced against the
// signal — a withAbort race would report a finished write as failed, and
// a client retry would apply it twice (same reasoning as appendFile).
signal?.throwIfAborted();
await fsRename(tempPath, validPath);
```

Do not remove the `withAbort` import; other functions in the file use it.

**Verify**:

- `npm test -- --test-name-pattern="TC-FUNC-047"` → `TC-FUNC-047b`, `047c`
  and `047d` all pass.
- `grep -n "withAbort(fsRename" src/core/fs.ts` → no matches.

### Step 3: Pin the last cancellation point

Add a second test next to `TC-FUNC-047d`. It proves an abort that lands
after the temp write but before the rename still cancels cleanly — target
untouched, temp file removed:

```ts
it('TC-FUNC-047e: an abort before the rename leaves the target untouched', async () => {
  const filePath = await writeTestFile(tmpDir, 'commit_precheck.txt', 'old\n');
  const controller = new AbortController();
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
    await assert.rejects(
      fs.writeFile(filePath, 'new\n', { signal: controller.signal }),
      /abort before commit/,
    );
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.strictEqual(await readFile(filePath, 'utf-8'), 'old\n');
  const leftovers = (await readdir(dirname(filePath))).filter((name) =>
    name.startsWith('commit_precheck.txt.'),
  );
  assert.deepStrictEqual(leftovers, [], 'the temp file must be cleaned up');
});
```

The mock is installed **after** `writeTestFile` has created the fixture,
because `writeTestFile` itself writes through `node:fs/promises`.

**Verify**: `npm test -- --test-name-pattern="TC-FUNC-047e"` → passes.

### Step 4: Full gate

Run `npx prettier --write __tests__/core-fs.test.ts src/core/fs.ts` first.

**Verify**: `npm run check` → exit 0, all tests pass including `TC-FUNC-047d`
and `TC-FUNC-047e`.

## Test plan

- `TC-FUNC-047d` (regression): the abort fires after the real rename but
  before its promise settles → `writeFile` resolves, the target holds the
  new content, and no `*.tmp` sibling remains. Fails before Step 2.
- `TC-FUNC-047e` (guard): the abort fires after the temp write → `writeFile`
  rejects with the abort reason, the target keeps the old content, and the
  temp file is removed.
- Pattern: `TC-FUNC-047b` / `TC-FUNC-047c` in the same file.
- Every mock is restored in a `finally` (plus `syncBuiltinESMExports()`) so a
  failure cannot leak a patched `rename` / `writeFile` into later tests.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `TC-FUNC-047d` and `TC-FUNC-047e` exist and pass
- [ ] `grep -n "withAbort(fsRename" src/core/fs.ts` returns no matches
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 014 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows an in-scope file changed and the excerpts no longer
  match.
- `TC-FUNC-047d` passes on the unmodified source — the race did not
  reproduce; report instead of shipping an untested change.
- The `mock.method` + `syncBuiltinESMExports()` interception does not reach
  `fs.ts`'s `fsRename` (for example the mocked function is never called).
  Report the Node version (`node --version`); do not replace the technique
  with a module-mocking flag.
- Any existing test in `__tests__/core-fs.test.ts` or `__tests__/tools.test.ts`
  starts failing or becomes flaky after Step 2.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Rule for reviewers**: a filesystem call that _commits_ a change (rename,
  append, unlink, rm) must never be wrapped in `withAbort`. Check the signal
  before the commit, not during it. `withAbort` is only for operations whose
  result can be safely abandoned (stat, reads).
- The tool layer still honors cancellation up to the rename: a cancel during
  the temp write aborts `fsWriteFile` (it receives the signal), and a cancel
  after it is caught by the new pre-rename check.
- If `GuardedFileSystem.rename` or `move` ever gains a `signal` parameter,
  apply the same pattern there.
- Batch tools (`replace_text` across files) can still stop between files on
  abort — that is intended; each committed file reports as done.
