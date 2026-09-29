# Plan 042: Directory `move`/`copy` refuses a tree that contains protected entries

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 4d751c94..HEAD -- src/tools/move.ts __tests__/tools.test.ts src/instructions.ts CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED — every directory move/copy now pays a pre-walk of the source
  tree; a tree containing a protected entry that used to move now fails
  closed with `ACCESS_DENIED`.
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `4d751c94`, 2026-09-28

## Why this matters

The sensitive-file policy (built-in denylist plus operator `--deny` /
`FS_DENYLIST` patterns) is evaluated per path. Name-based patterns (`.env`,
`*.pem`, `*id_rsa*`) follow a file wherever it goes, but **path-based**
patterns (`secrets/**`, `config/prod/*.json`, the built-in `.aws/credentials`
under a renamed parent) do not. Today `move` validates only the source
directory's own path (`validateTransferSource`) and then `rename`s or `cp`s the
entire tree. `move { source: "secrets", destination: "public" }` therefore
relocates every file under `secrets/` to `public/`, where the same server will
happily `read` them. A `copy` does the same while leaving the originals. After
this plan, a directory transfer whose tree contains any entry the policy
denies is refused as a per-pair `ACCESS_DENIED` failure before anything moves,
and a test pins it with an operator `secrets/**` rule.

## Current state

- `src/tools/move.ts` — the `move` tool (move + copy). Two phases per pair:
  `planTransfer` (no mutation) → `executeTransfer` (rename/cp).
- `src/core/path.ts:229-231` — `PathGuard.isSensitive(filePath)` is the
  lexical policy check (requested path, no realpath).
- `src/core/glob.ts:408-426` — `globEntries(options)` is the shared walk; it
  yields `{ path, dirent }` and takes `onlyFiles`, `includeHidden`,
  `skipIgnored`, `signal`, `suppressErrors`.
- `__tests__/tools.test.ts` — tool-level tests via `createTestClientPair`.

Live code at `src/tools/move.ts:409-425`:

```ts
async function validateTransferSource(
  op: PairOp,
  source: string,
  fs: ToolCtx['fs'],
): Promise<TransferSource> {
  try {
    const realSource = await fs.pathGuard.validateExistingPath(source);
    const opSource = op === 'move' ? await fs.pathGuard.validatePathForDelete(source) : realSource;
    return { realSource, opSource };
  } catch (error) {
    if (isFsError(error)) throw error;
    throw new FsError(ErrorCode.ACCESS_DENIED, `${VERB[op]} failed for ${source}`, source);
  }
}
```

`planTransfer` (`move.ts:114-172`) calls it first:

```ts
try {
  ({ realSource, opSource } = await validateTransferSource(op, pair.source, fs));
  validDest = await fs.pathGuard.validatePathForWrite(pair.destination);
} catch (error) {
  return { status: 'fail', failure: pairFailure(pair, error) };
}
```

and `executeTransfer` (`move.ts:181-233`) performs the mutation:

```ts
  if (op === 'move') {
    await performRenameWithFallback(plan.opSource, plan.validDest, ctx.fs, plan.pair.source);
    ...
  } else {
    await ctx.fs.cp(plan.opSource, plan.validDest, {
      recursive: true, verbatimSymlinks: true, preserveTimestamps: true, force: true,
    });
  }
```

`planTransfer`'s signature is `(op, pair, fs, overwrite)`; it does not receive
`ctx.signal`. `runTransfers` (`move.ts:259-…`) calls it and has `ctx`. The
existing import block of `move.ts` (lines 1-35) does **not** import
`globEntries`; add `import { globEntries } from '../core/glob.ts';` in the
`../core/` group (imports are sorted by the Prettier plugin — run
`npx prettier --write src/tools/move.ts` after editing).

How `isSensitive` sees paths: `SensitiveMatcher` (`src/core/sensitive.ts:350+`)
matches an absolute path against path-globs (relative patterns match any
suffix of the path) and name-globs. With `FS_DENYLIST=secrets/**`,
`isSensitive('/root/secrets/x.txt')` is `true` and
`isSensitive('/root/public/x.txt')` is `false` — which is the whole bug.

Precedent for how the walk is used with the guard: `src/core/search.ts:216-227`
(`globEntries({ cwd, pattern: '**/*', includeHidden, skipIgnored, signal, maxDepth, suppressErrors: true })`).

## Commands you will need

| Purpose           | Command                                                          | Expected on success |
| ----------------- | ---------------------------------------------------------------- | ------------------- |
| Build + typecheck | `npm run build && npm run type-check:test`                       | exit 0              |
| Targeted tests    | `npm test -- --test-name-pattern="move\|copy\|TC-FUNC-06"`       | all pass            |
| Full check        | `npm run check`                                                  | exit 0; 0 fail      |
| Format            | `npx prettier --write src/tools/move.ts __tests__/tools.test.ts` | exit 0              |

Baseline at planning time: `npm test` → 450 tests, 447 pass, 3 skips, 0 fail.

## Scope

**In scope**:

- `src/tools/move.ts` — one new helper, called from `planTransfer`
- `__tests__/tools.test.ts` — two new tests
- `src/instructions.ts` — one clause (step 4) if the constraints section
  mentions move/copy; otherwise skip
- `CHANGELOG.md` — one `### Fixed` bullet under `## [Unreleased]`
- `plans/README.md` — status row

**Out of scope**:

- `src/tools/delete.ts` — recursive delete of a tree containing protected
  entries is destructive but discloses nothing; deferred (see Maintenance).
- `src/core/fs.ts` `cp`/`rename` — the guard belongs in the tool's plan phase,
  where per-pair failures are already collected; do not add filtering to `cp`.
- `src/core/sensitive.ts`, `src/core/path.ts` — the policy itself is correct.
- `MoveOutputSchema` and the `{ moves, failures, skipped }` wire shape.

## Git workflow

- Branch: `advisor/042-move-tree-honors-deny-rules`
- Commit per step, e.g. `fix(move): refuse a directory transfer whose tree contains protected entries`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing tests

In `__tests__/tools.test.ts`, inside the top-level
`describe('P0 Functional Tests - Tools (MCP Client)', …)`, directly after the
test `'move and copy both refuse a destination inside the source directory'`
(line ~1196), add a test that builds its **own** harness under an operator
deny rule (the shared `harness` was created without one; `FS_DENYLIST` is read
when the server is constructed):

```ts
it('move and copy refuse a directory whose tree contains a path-denied file', async () => {
  // `secrets/**` is path-based: it denies secrets/x.txt but not public/x.txt,
  // so moving the directory used to carry the file out of the rule.
  await withEnv({ FS_DENYLIST: 'secrets/**' }, async () => {
    const root = await createTestRoot();
    const own = await createTestClientPair([root]);
    try {
      const secret = await writeTestFile(root, 'secrets/inner/x.txt', 'top secret\n');
      const plainDir = join(root, 'plain');
      await writeTestFile(root, 'plain/ok.txt', 'ok\n');

      for (const copy of [false, true]) {
        const label = `copy=${String(copy)}`;
        const result = await own.client.callTool({
          name: 'move',
          arguments: {
            moves: [{ source: join(root, 'secrets'), destination: join(root, 'public') }],
            copy,
          },
        });
        assert.strictEqual(result.isError, true, `${label} must be refused`);
        const { failures = [] } = result._meta as {
          failures?: { error: { code: string; message: string } }[];
        };
        assert.strictEqual(failures[0]?.error.code, 'ACCESS_DENIED', label);
        assert.match(failures[0]?.error.message ?? '', /protected/i, label);
        await assert.rejects(access(join(root, 'public')), `${label} created nothing`);
        assert.strictEqual(
          await readFile(secret, 'utf-8'),
          'top secret\n',
          `${label} left the source`,
        );
      }

      // A clean tree still moves: the pre-walk must not refuse everything.
      const moved = await own.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: plainDir, destination: join(root, 'moved') }] },
      });
      assert.notStrictEqual(moved.isError, true);
      assert.strictEqual(await readFile(join(root, 'moved', 'ok.txt'), 'utf-8'), 'ok\n');
    } finally {
      await own.close();
      await cleanupTestRoot(root);
    }
  });
});
```

`withEnv`, `createTestRoot`, `createTestClientPair`, `cleanupTestRoot`,
`writeTestFile` are already imported at the top of the file; `access`,
`readFile`, `join` too.

**Verify**: `npm test -- --test-name-pattern="path-denied file"` → **fails**
(`isError` is not `true`: the move succeeds today).

### Step 2: Walk the source tree in the plan phase

In `src/tools/move.ts`, add a helper after `validateTransferSource`:

```ts
/**
 * Path-based deny rules (`secrets/**`, `.aws/credentials`) follow the path,
 * not the file: moving or copying their parent directory would relocate the
 * protected entries to paths the rules no longer match. Walk the tree once
 * before any mutation and fail the pair closed if anything in it is denied.
 * Name-based rules need no help — they match after the move too.
 */
async function assertTreeHasNoProtectedEntries(
  op: PairOp,
  realSource: string,
  requestedSource: string,
  fs: ToolCtx['fs'],
  signal: AbortSignal | undefined,
): Promise<void> {
  let protectedCount = 0;
  const entries = globEntries({
    cwd: realSource,
    pattern: '**/*',
    includeHidden: true,
    skipIgnored: false,
    onlyFiles: false,
    suppressErrors: true,
    ...(signal ? { signal } : {}),
  });
  for await (const entry of entries) {
    signal?.throwIfAborted();
    if (fs.pathGuard.isSensitive(entry.path)) {
      protectedCount++;
      break; // one is enough to refuse; do not enumerate the rest
    }
  }
  if (protectedCount > 0) {
    throw new FsError(
      ErrorCode.ACCESS_DENIED,
      `${VERB[op]} refused: the directory contains protected entries matching the sensitive-file policy; move or copy individual files instead`,
      requestedSource,
    );
  }
}
```

Do **not** include the matching file names in the message: the policy hides
them from `list`/`find_files`, and the error must not become a side channel.

Then in `planTransfer`, after `validateTransferSource` succeeds and before
`validatePathForWrite`, stat the source and run the walk only for
directories. `planTransfer` needs the signal — extend its signature with a
fifth parameter `signal: AbortSignal | undefined` and pass `ctx.signal` from
its single call site in `runTransfers` (search for `planTransfer(` — there is
one call). The new lines inside the existing `try`:

```ts
({ realSource, opSource } = await validateTransferSource(op, pair.source, fs));
if ((await stat(realSource)).isDirectory()) {
  await assertTreeHasNoProtectedEntries(op, realSource, pair.source, fs, signal);
}
validDest = await fs.pathGuard.validatePathForWrite(pair.destination);
```

`stat` comes from `node:fs/promises` (add it to the imports; `move.ts` does not
import it today). The thrown `FsError` is caught by the existing `catch` and
becomes the pair's `failure` through `pairFailure`, so the wire shape is
unchanged.

Run `npx prettier --write src/tools/move.ts` to sort the new imports.

**Verify**: `npm run build && npm run type-check:test` → exit 0;
`npm test -- --test-name-pattern="path-denied file"` → passes;
`npm test -- --test-name-pattern="move\|copy\|TC-FUNC-06"` → all pass
(existing single-file and directory moves are unaffected: a file source skips
the walk, a clean directory passes it).

### Step 3: Symlink source stays correct

`validateTransferSource` resolves symlinks (`realSource`) — the walk runs on
the resolved directory, which is what `cp` copies. A **move** of a symlink
renames the link itself (`opSource`), so its tree does not relocate; walking
it is harmless but wasted. Add one guard: skip the walk when
`op === 'move' && opSource !== realSource` (the source is a symlink being
renamed). Keep the walk for copies of a symlinked directory.

**Verify**: `npm test -- --test-name-pattern="move\|copy\|symlink"` → all pass
(there are existing symlink move tests; `trySymlink` in helpers skips on
platforms without symlink rights).

### Step 4: Documentation

- `CHANGELOG.md`: under `## [Unreleased]` → `### Fixed` (create the heading
  if absent, above `## [2.6.3]`): `**Directory move/copy honors path-based deny rules.** A directory whose tree contains an entry the sensitive-file policy denies (an operator `secrets/**`, the built-in `.aws/credentials`, …) is no longer relocated past the rule; the pair fails with `ACCESS_DENIED` and nothing moves.`
- `src/instructions.ts`: only if its constraints text lists what `move`
  refuses (grep for `move` in that file); if so add "or a directory containing
  protected files". Otherwise leave it.

**Verify**: `npx prettier --check CHANGELOG.md src/instructions.ts` → exit 0.

### Step 5: Full check

**Verify**: `npm run check` → exit 0, `fail 0`.

## Test plan

- New: the test in step 1 (move and copy refused; source intact; nothing
  created; a clean tree still moves under the same rule).
- Pattern: `'move and copy both refuse a destination inside the source directory'`
  (`tools.test.ts:1196`) for the `for (const copy of [false, true])` shape and
  the `_meta.failures` assertions; the `withEnv` usage in
  `security.test.ts:263-300` for pinning `FS_DENYLIST`.
- Existing tests that must stay green: TC-FUNC-009d, TC-FUNC-064..067 (choice
  round-trips), `move-exdev.test.ts`, the case-only rename test, and the
  boundary-walk test at `tools.test.ts:199`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] The new test exists and passes; reverting `src/tools/move.ts` alone makes it fail
- [ ] `grep -c "assertTreeHasNoProtectedEntries" src/tools/move.ts` → 2 (definition + call)
- [ ] `grep -n "globEntries" src/tools/move.ts` → import + one use
- [ ] The refusal message contains no file names from the walked tree (read the string)
- [ ] CHANGELOG updated; `npx prettier --check .` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `planTransfer` has more than one call site, or `runTransfers` has no `ctx.signal` in scope.
- `globEntries` rejects `onlyFiles: false` together with `pattern: '**/*'` (check `GlobEntriesOptions` at `glob.ts:186-198`; both are declared today).
- An existing directory-move test starts timing out: the pre-walk is too slow for that fixture — report the test name and the fixture size rather than adding a cap.
- `PathGuard.isSensitive` is not public or does not accept an absolute path.

## Maintenance notes

- The walk is a pre-check, so a file created inside the tree between the walk
  and the rename is not seen. This is the same accepted TOCTOU window the
  class docstring on `PathGuard` records for every validation.
- Cost: one full walk of the source tree per directory pair. If large trees
  become a complaint, the right cap is on entries walked (refuse when exceeded)
  — never a silent "checked the first N".
- Deferred: `delete` of a directory containing protected entries (destructive,
  non-disclosing) — separate decision; and filtering on **copy** (copy the
  clean subset) — rejected here for consistency with move, revisit only with a
  concrete ask.
