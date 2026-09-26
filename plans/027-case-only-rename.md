# Plan 027: A case-only rename renames the file instead of reporting "nothing"

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/tools/move.ts __tests__/tools.test.ts`
> Plan 019 adds one `export` keyword to `move.ts:416`; that is not drift. The
> `planTransfer` excerpt below must still match.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

On a case-insensitive filesystem (Windows, macOS), `move foo.txt → Foo.txt`
answers `move: nothing` and leaves the file named `foo.txt`. The model
believes the rename happened. Reproduced on Windows through the tool.

Cause: the destination is validated with `validatePathForWrite`, which
`realpath`s an existing destination (`src/core/path.ts:640`) and so returns
the **on-disk** spelling `foo.txt`. Source and destination then resolve to the
identical string, `isSelf` is true, and the planner returns `noop`. The
`isCaseOnlyRename` branch that was written for exactly this case can never be
reached when the destination exists — which for a case-only rename is always.

## Current state

```ts
// src/tools/move.ts:113-142 (planTransfer, first half)
async function planTransfer(
  op: PairOp,
  pair: { source: string; destination: string },
  fs: ToolCtx['fs'],
  overwrite: boolean,
): Promise<TransferPlanResult> {
  let realSource: string;
  let opSource: string;
  let validDest: string;
  try {
    ({ realSource, opSource } = await validateTransferSource(op, pair.source, fs));
    validDest = await fs.pathGuard.validatePathForWrite(pair.destination);
  } catch (error) {
    return { status: 'fail', failure: pairFailure(pair, error) };
  }

  // Comparisons run on the resolved source; only the fs call in phase 2 uses
  // opSource. validatePathForWrite resolves the destination through a symlink
  // too, so both sides of every check must be resolved to match.
  const resolvedSource = resolve(realSource);
  const resolvedDest = resolve(validDest);

  const isSelf = resolvedSource === resolvedDest;
  const isCaseOnlyRename = !isSelf && isSamePath(resolvedSource, resolvedDest);

  // A copy onto a case-only variant of its own source is the same file, so it
  // is a no-op; the same rename is real work for move and proceeds.
  if (isSelf || (isCaseOnlyRename && op === 'copy')) {
    return { status: 'noop' };
  }
```

Lines 158–164 then compute
`destExistedOriginally = !isCaseOnlyRename && (await destExists(...))` and
return `{ status: 'plan', plan: { pair, opSource, validDest, isCaseOnlyRename, destExistedOriginally, pending } }`.
`executeTransfer` (lines 174–223) skips the TOCTOU check when
`plan.isCaseOnlyRename` and then calls
`performRenameWithFallback(plan.opSource, plan.validDest, ctx.fs, plan.pair.source)`
— so the rename target is whatever `validDest` says.

`isSamePath` (`src/core/path-utils.ts:177-184`) case-folds on Windows and
macOS only; on Linux two spellings are two files and this plan changes
nothing there. `basename`, `dirname`, `join` — `move.ts:4` imports
`basename, dirname, resolve` from `node:path`; add `join`.

Output shape: `result._meta` is `{ moves: { from, to }[], failures?, skipped? }`
(`move.ts:41-44`, `61-71`). Existing test pattern: `TC-FUNC-021`
(`__tests__/tools.test.ts:831`).

## Commands you will need

| Purpose        | Command                                                          | Expected on success |
| -------------- | ---------------------------------------------------------------- | ------------------- |
| Static check   | `npm run check:static`                                           | exit 0              |
| All tests      | `npm test`                                                       | all pass            |
| Filter by name | `npm test -- --test-name-pattern="case-only rename"`             | passes              |
| Format         | `npx prettier --write src/tools/move.ts __tests__/tools.test.ts` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/tools/move.ts` — `planTransfer` only (and the `node:path` import)
- `__tests__/tools.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope**: `validatePathForWrite` (its realpath is correct for every
other caller); the `copy` no-op rule; `executeTransfer`.

## Git workflow

- Branch: `advisor/027-case-only-rename`.
- One commit: `fix(move): perform a case-only rename instead of reporting nothing`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Regression test (it must fail now on Windows/macOS)

In `__tests__/tools.test.ts`, directly after `TC-FUNC-021` (ends line 856),
add:

```ts
it('move performs a case-only rename on a case-insensitive filesystem', async (t) => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    t.skip('case-only rename is only special on a case-insensitive filesystem');
    return;
  }
  const dir = join(tmpDir, 'case_rename');
  const lower = await writeTestFile(tmpDir, 'case_rename/foo.txt', 'same bytes\n');
  const upper = join(dir, 'Foo.txt');

  const result = await harness.client.callTool({
    name: 'move',
    arguments: { moves: [{ source: lower, destination: upper }] },
  });
  assert.notStrictEqual(result.isError, true);
  const moves = (result._meta as { moves?: { to: string }[] }).moves ?? [];
  assert.strictEqual(moves.length, 1, 'a case-only rename is real work, not a no-op');
  assert.deepStrictEqual(await readdir(dir), ['Foo.txt']);
  assert.strictEqual(await readFile(upper, 'utf-8'), 'same bytes\n');
});
```

Add `readdir` to the `node:fs/promises` import at the top of the file.

**Verify**: on Windows or macOS,
`npm test -- --test-name-pattern="case-only rename"` → **fails** at
`moves.length` (0, the call was a no-op). On Linux it is skipped; in that
case verify the failure on the Windows CI job instead, or note that you could
not observe the pre-fix failure.

### Step 2: Recognize the rename from the requested spelling

In `src/tools/move.ts`:

1. Change the `node:path` import to `import { basename, dirname, join, resolve } from 'node:path';`.
2. Replace lines 132–136 with:

   ```ts
   const resolvedSource = resolve(realSource);
   let resolvedDest = resolve(validDest);

   // On a case-insensitive filesystem validatePathForWrite realpaths an
   // existing destination to its on-disk spelling, so `foo.txt -> Foo.txt`
   // resolves to the source itself. The requested basename is what the
   // caller wants on disk: rename to it, do not treat the pair as self.
   const requestedName = basename(pair.destination);
   if (
     resolvedSource === resolvedDest &&
     requestedName !== basename(resolvedDest) &&
     isSamePath(join(dirname(resolvedDest), requestedName), resolvedDest)
   ) {
     validDest = join(dirname(validDest), requestedName);
     resolvedDest = resolve(validDest);
   }

   const isSelf = resolvedSource === resolvedDest;
   const isCaseOnlyRename = !isSelf && isSamePath(resolvedSource, resolvedDest);
   ```

   (`validDest` is already declared with `let` at line 121.)

Run `npx prettier --write src/tools/move.ts __tests__/tools.test.ts`.

**Verify**: `npm test -- --test-name-pattern="case-only rename"` → passes on
Windows/macOS; `npm test -- --test-name-pattern="TC-FUNC-021|move"` → all pass.

### Step 3: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- New test (win32/darwin only): `foo.txt → Foo.txt` reports one move and the
  directory lists `Foo.txt`.
- Existing: every `move`/`copy` test, especially the dest-inside-source and
  overwrite-confirmation ones — the new branch only fires when both resolved
  paths are identical strings and the requested basename differs.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "requestedName" src/tools/move.ts` prints at least 3 lines
- [ ] The new test exists and passes (or is skipped on Linux)
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 027 updated

## STOP conditions

Stop and report back (do not improvise) if:

- On Windows/macOS the regression test passes before Step 2.
- After Step 2 the rename syscall itself fails with `EEXIST` or similar on
  the platform you are on — report the error; some filesystems need a
  two-step rename via a temporary name, which is out of this plan's scope.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Only the **basename** is re-spelled. A request that also changes the case
  of a parent directory segment (`dir/foo.txt → Dir/foo.txt`) still resolves
  to the on-disk parent; renaming directories by case is a separate feature.
- Reviewer focus: the guard `isSamePath(join(dirname(resolvedDest), requestedName), resolvedDest)`
  keeps this branch a no-op on Linux, where `isSamePath` is exact.
