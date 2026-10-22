# Undo review fixes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two restore defects the 2026-10-22 undo review reproduced, and make the four small cuts it found.

**Architecture:** Five tasks, one commit each, on one branch. Task 1 serializes undo calls on their journal, so a second undo of the same id sees what the first one left. Task 2 lets a write record count as restored when its path already holds the saved bytes. Tasks 3 to 5 are refactors with no behaviour change. No MCP contract change.

**Tech Stack:** TypeScript on Node 24 (type stripping), `node:test`, `@modelcontextprotocol/server` 2.3.1.

**Spec:** the ponytail review of the `undo` tool at 785f6050, given in the 2026-10-22 session. Each task restates its finding. Two sonnet verifiers reproduced findings 1 and 2. The fixes for findings 2 and 3 were run in scratch worktrees: `__tests__/undo.test.ts` gave 70 pass, 0 fail, 5 skipped, and `check:static` exited 0. Out of scope: the review's open question (shrinking `dryRun` to a plain history list), which waits for the user.

## Global Constraints

- Line numbers are at commit 785f6050 (`main`). Earlier tasks shift later line numbers in the same file. Find code by the quoted text or symbol name.
- Node `>=24` (`package.json` engines).
- `src/core` must never import from `src/tools`.
- No MCP contract change: `node --test __tests__/contract.test.ts` passes with no snapshot update.
- Never hand-edit the version in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json` or `.cursor-plugin/plugin.json`.
- Commit messages are Conventional Commits with scope `undo`, like the existing `fix(undo): ...` history. End each one with these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01M6xe5b1AigkUbAhjikwu6h`
- Match the surrounding comment density. Mark a deliberate corner with a `ponytail:` comment that names its ceiling and upgrade path.
- Before each commit, format the changed files: `npx prettier --write <files>`.
- Run one test file with `node --test --test-timeout=60000 __tests__/undo.test.ts`. Filter with `--test-name-pattern="<name>"`.
- `npm run check` passes at the end of Task 5.

## Review Focus

1. Two concurrent undos of an id whose records all restore. The first restores everything. The second must fail cleanly with `Unknown or expired undo id`, and the files stay restored. Test in Task 1.
2. A write record whose path is now a symlink to a file holding the saved bytes. It must still be SKIPPED, because undo never writes through a link. Test in Task 2.
3. A dry run of a write whose path already holds the saved bytes must preview as restored, the same as the real run. Test in Task 2.
4. A dry run across a case-only folder rename followed by a move of that folder (win32 and darwin only). Every step must preview as restored once the case-folded branch of `disk()` is gone. Test in Task 3.

---

### Task 1: Serialize undo calls on their journal

Spec, finding 1 (Major). `src/tools/undo.ts:61-99` reads the entry, restores it, and then overwrites its records with `replaceRecords(id, remaining)`. When two undos of one id run at once, the path locks queue the second behind the first. The second then skips the records the first restored, and writes them back into the journal. A record brought back this way is restored again later. A brought-back `rename` moved a file again after the user had put it back.

**Files:**

- Modify: `src/tools/undo.ts:1-9` (imports), `:60-119` (from `let entries` to the final `return`)
- Test: `__tests__/undo.test.ts`, in `describe('undo tool')` (starts at `:1239`)

**Interfaces:**

- Consumes: `runExclusive<T>(key: unknown, fn: () => Promise<T>): Promise<T>` from `src/core/concurrency.ts:14`.
- Produces: no new names. `UNDO.run` holds a lock keyed on the `UndoJournal` instance from the entry lookup through the return.

- [ ] **Step 1: Branch and commit the plan**

```bash
git fetch origin
git switch -c fix/undo-review origin/main
git add docs/superpowers/plans/2026-10-22-undo-review-fixes.md
git commit -m "docs(plan): add undo review fixes plan"
```

- [ ] **Step 2: Write the failing tests**

Add both tests to `describe('undo tool')`. They use the helpers `call` and `firstTextBlock` from that block. Each test reads the id from `structuredContent`, because `create` leaves its JSON text without the suffix.

```ts
it('a second concurrent undo of one id does not bring restored records back', async () => {
  const tmp = await createTestRoot();
  const pair = await createTestClientPair([tmp]);
  try {
    const x = join(tmp, 'tx.txt');
    const y = join(tmp, 'ty.txt');
    await writeFile(x, 'X0');
    await writeFile(y, 'Y0');
    const made = await call(pair.client, 'create', {
      files: [
        { path: x, content: 'X1', overwrite: true },
        { path: y, content: 'Y1', overwrite: true },
      ],
    });
    const id = (made.structuredContent as { undo?: string }).undo ?? '';
    await writeFile(y, 'Y-external');
    await Promise.all([call(pair.client, 'undo', { id }), call(pair.client, 'undo', { id })]);
    const third = firstTextBlock(await call(pair.client, 'undo', { id })) ?? '';
    assert.match(third, /ty\.txt SKIPPED/u);
    assert.ok(!third.includes('tx.txt'), `tx.txt was restored once: ${third}`);
  } finally {
    await pair.close();
    await cleanupTestRoot(tmp);
  }
});

it('a second concurrent undo of a fully restored id reports it gone', async () => {
  const tmp = await createTestRoot();
  const pair = await createTestClientPair([tmp]);
  try {
    const x = join(tmp, 'full.txt');
    await writeFile(x, 'X0');
    const made = await call(pair.client, 'create', {
      files: [{ path: x, content: 'X1', overwrite: true }],
    });
    const id = (made.structuredContent as { undo?: string }).undo ?? '';
    const results = await Promise.all([
      call(pair.client, 'undo', { id }),
      call(pair.client, 'undo', { id }),
    ]);
    assert.strictEqual(results.filter((r) => r.isError !== true).length, 1);
    const failed = results.find((r) => r.isError === true);
    assert.match(firstTextBlock(failed) ?? '', /Unknown or expired undo id/u);
    assert.strictEqual(await import('node:fs/promises').then((m) => m.readFile(x, 'utf8')), 'X0');
  } finally {
    await pair.close();
    await cleanupTestRoot(tmp);
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test --test-timeout=60000 --test-name-pattern="second concurrent undo" __tests__/undo.test.ts`
Expected: both FAIL. The first fails on the `tx.txt was restored once` assertion. The second fails on the `Unknown or expired undo id` match, because today the second call reports `full.txt SKIPPED`.

- [ ] **Step 4: Wrap the lookup and restore loop in `runExclusive(journal, ...)` in `src/tools/undo.ts`**

The input checks above `let entries` stay outside the lock. The lookup moves inside the lock, so a queued call reads the entry its predecessor left behind. Put this comment above the call:

```ts
// ponytail: one lock per journal, so undos run one at a time; per-entry
// locks if undo throughput ever matters.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-timeout=60000 __tests__/undo.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/tools/undo.ts __tests__/undo.test.ts
git add src/tools/undo.ts __tests__/undo.test.ts
git commit -m "fix(undo): run undo calls on one journal one at a time"
```

### Task 2: A write record already in its saved state counts as restored

Spec, finding 2. In `restoreEntry`'s `write` case (`src/core/undo.ts:608-626`), a path that already holds `record.bytes` is reported SKIPPED, `Not restored: modified since this undo step was recorded`, and stays in `remaining`. `remove` treats an absent path as done, and `mkdir` treats an existing directory as done. When every row of an undo is like this, the tool returns `isError: true`.

**Files:**

- Modify: `src/core/undo.ts:610-624` (the `write` case inside `lockForWrite`)
- Test: `__tests__/undo.test.ts`, in `describe('restoreEntry')` (starts at `:393`)

**Interfaces:**

- Consumes: `matchesHash(path, expect)` and `done(path)`, both closures inside `restoreEntry`, and `sha256Hex` from `src/core/util.ts`.
- Produces: no new names.

- [ ] **Step 1: Write the failing tests**

Add these to `describe('restoreEntry')`. They use its `captureOne`, `newFs` and `dryRunAll`.

```ts
it('a write whose path already holds the saved bytes counts as restored', async () => {
  const file = join(tmpDir, 'already-restored.txt');
  await writeFile(file, 'A');
  const entry = await captureOne((fs) => fs.writeFile(file, 'B'));
  await writeFile(file, 'A');
  const dry = await dryRunAll([entry]);
  assert.deepStrictEqual(
    dry.filter((r) => 'error' in r),
    [],
  );
  const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
  assert.deepStrictEqual(
    outcome.results.filter((r) => 'error' in r),
    [],
  );
  assert.deepStrictEqual(outcome.remaining, []);
});

it('a symlink to the saved bytes is still skipped', async (t) => {
  const file = join(tmpDir, 'link-restored.txt');
  const target = join(tmpDir, 'link-restored-target.txt');
  await writeFile(file, 'A');
  await writeFile(target, 'A');
  const entry = await captureOne((fs) => fs.writeFile(file, 'B'));
  await rm(file);
  if (!(await trySymlink(target, file, () => t.skip('symlinks unavailable'), 'file'))) return;
  const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
  assert.strictEqual(outcome.results.filter((r) => 'error' in r).length, 1);
  assert.strictEqual(outcome.remaining.length, 1);
});
```

- [ ] **Step 2: Run the tests to verify the first fails**

Run: `node --test --test-timeout=60000 --test-name-pattern="saved bytes" __tests__/undo.test.ts`
Expected: `a write whose path already holds the saved bytes counts as restored` FAILS on the dry-run assertion, with one `Not restored: modified since` row. The symlink test PASSES; it guards the fix.

- [ ] **Step 3: Add the already-restored branch in `src/core/undo.ts`**

Between `if (ok) {...}` and `else { skip(...) }`, add one `else if`. It calls `matchesHash(record.path, sha256Hex(record.bytes))` and, when that is true, calls `done(record.path)` with no write and no `simulate`. `matchesHash` already checks `isFile()` on the `lstat` result, so a symlink still falls through to `skip`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-timeout=60000 __tests__/undo.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/core/undo.ts __tests__/undo.test.ts
git add src/core/undo.ts __tests__/undo.test.ts
git commit -m "fix(undo): count a write already back in its saved state as restored"
```

### Task 3: Cut `disk()` to an exact-prefix relocation

Spec, finding 3. `hasPathBoundary` plus the two-branch `disk()` (`src/core/undo.ts:502-524`) are 22 lines that map a dry-run path through relocations. The second branch matches case-folded prefixes, and lowercase-length checks guard it against the U+0130 slice. A verifier traced the record paths: they carry on-disk casing from `realpath`, so the only path that reached that branch was a hand-built entry. `simulated` is keyed by raw strings anyway. Net -14 lines.

**Files:**

- Modify: `src/core/undo.ts:502-524` (`hasPathBoundary`, `disk`)
- Test: `__tests__/undo.test.ts`, in `describe('restoreEntry')`

**Interfaces:**

- Consumes: `isPathInsideDirectory(normalizedDirectory: string, normalizedCandidate: string): boolean` from `src/core/path-utils.ts` (already imported).
- Produces: `disk(path: string): string`, the same closure with a smaller body. `hasPathBoundary` is removed.

- [ ] **Step 1: Write the guard test**

```ts
it('dry run across a case-only folder rename and a move previews as restored', async (t) => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    t.skip('case-insensitive filesystem required');
    return;
  }
  const lower = join(tmpDir, 'case-cd');
  const upper = join(tmpDir, 'CASE-CD');
  const away = join(tmpDir, 'case-away');
  await mkdir(lower, { recursive: true });
  await writeFile(join(lower, 'f.txt'), 'v1');
  const edited = await captureOne((fs) => fs.writeFile(join(lower, 'f.txt'), 'v2'));
  const recased = await captureOne((fs) => fs.rename(lower, upper));
  const moved = await captureOne((fs) => fs.rename(upper, away));
  const results = await dryRunAll([moved, recased, edited]);
  assert.deepStrictEqual(
    results.filter((r) => 'error' in r),
    [],
  );
});
```

- [ ] **Step 2: Run the guard test on the current code**

Run: `node --test --test-timeout=60000 --test-name-pattern="case-only folder rename" __tests__/undo.test.ts`
Expected: PASS on win32 (the verifier ran this scenario against both versions of `disk()`), SKIP on Linux.

- [ ] **Step 3: Replace `hasPathBoundary` and `disk` in `src/core/undo.ts`**

Delete `hasPathBoundary`. `disk` keeps its loop over `relocations.toReversed()`. Inside the loop, rewrite `out` only when `out.startsWith(from) && isPathInsideDirectory(from, out)`. Add the comment `// startsWith keeps the slice exact; the helper adds the segment boundary.` `IS_WINDOWS` is still used at `:377`, so its import stays.

- [ ] **Step 4: Run the undo tests and static checks**

Run: `node --test --test-timeout=60000 __tests__/undo.test.ts`
Expected: PASS, 0 fail. `dry run does not remap a length-changing lowercase alias` still passes.

Run: `npm run check:static`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/core/undo.ts __tests__/undo.test.ts
git add src/core/undo.ts __tests__/undo.test.ts
git commit -m "refactor(undo): relocate dry-run paths by exact prefix only"
```

### Task 4: Drop `UndoJournal.endCapture`, fix the stacked doc comment

Spec, findings 4 and 6. `endCapture(capture)` (`src/core/undo.ts:141-145`) only calls `capture?.release()`. In `src/tools/define.ts:318-325` the `#undoSuffix` doc block sits above the `#undoId` field instead of above `#undoSuffix()`.

**Files:**

- Modify: `src/core/undo.ts:136` (comment), `:141-145` (method), `:283-284` (comment)
- Modify: `src/tools/define.ts:318-327` (doc order), `:514` (call)
- Test: `__tests__/undo.test.ts:115,118,127,128,131,143,144,818,819,1083,1084,1087`

**Interfaces:**

- Consumes: `UndoCapture.release(): void` (unchanged).
- Produces: `UndoJournal.endCapture` is removed. Callers use `capture?.release()`.

- [ ] **Step 1: Replace the call sites**

- `src/tools/define.ts:514`: `this.toolCtx.undoJournal.endCapture(this.capture);` becomes `this.capture?.release();`.
- In each test site, `journal.endCapture(x)` becomes `x.release()`.
- The test name at `:118` becomes `'an abandoned capture keeps its charge until release'`.
- In `src/core/undo.ts:136` and `:284`, the comments name `release()` instead of `endCapture`.

- [ ] **Step 2: Delete `endCapture` and reorder the doc**

Delete the `endCapture` method from `src/core/undo.ts`. In `src/tools/define.ts`, move the block that starts `The undo suffix for a captured call, minted once` down to sit directly above `#undoSuffix(structured?: ...)`. Leave the one-line `#undoId` doc above the field.

- [ ] **Step 3: Verify nothing still names it**

Run: `git grep -n endCapture -- src __tests__`
Expected: no output.

Run: `node --test --test-timeout=60000 __tests__/undo.test.ts` then `npm run check:static`
Expected: PASS, 0 fail; exit 0.

- [ ] **Step 4: Commit**

```bash
npx prettier --write src/core/undo.ts src/tools/define.ts __tests__/undo.test.ts
git add src/core/undo.ts src/tools/define.ts __tests__/undo.test.ts
git commit -m "refactor(undo): release captures directly, drop endCapture"
```

### Task 5: Make the capture's pool required

Spec, finding 5. `UndoCapture`'s optional `pool` (`src/core/undo.ts:232-247`, plus the guards at `:256` and `:285`) exists only for tests. Production always passes one through `beginCapture()`.

**Files:**

- Modify: `src/core/undo.ts:232-247`, `:256`, `:285`
- Test: `__tests__/undo.test.ts:13` (import), `:167`, `:264`, `:276`, `:416`, `:967`

**Interfaces:**

- Consumes: `UndoJournal.beginCapture(): UndoCapture` (unchanged).
- Produces: `new UndoCapture(maxBytes: number, pool: LivePool)`. `pool` is required, and `#pool: LivePool` is no longer `| undefined`. `#used()` returns `this.#pool.bytes`.

- [ ] **Step 1: Switch the test sites to `beginCapture()`**

Each `new UndoCapture(n)` becomes `new UndoJournal(n).beginCapture()`. The test at `:967` keeps its `32 * 1024 * 1024`. If `UndoCapture` then appears only in type positions, move it from the value import at `:13` to an `import type` line. The repo's eslint enforces consistent type imports.

- [ ] **Step 2: Run the tests on the old code**

Run: `node --test --test-timeout=60000 __tests__/undo.test.ts`
Expected: PASS, 0 fail. A fresh journal's pool equals the capture's own bytes, so budgets behave as before.

- [ ] **Step 3: Make `pool` required in `src/core/undo.ts`**

Remove the `?` from the constructor parameter and the `| undefined` from `#pool`. `#used()` becomes `this.#pool.bytes`. Drop the `if (this.#pool)` guards in `#charge`, `release` and `abandon`, and drop the `?.`. Update the `#used()` doc, which mentions the unpooled case.

- [ ] **Step 4: Run the full check**

Run: `npm run check`
Expected: exit 0, including `__tests__/contract.test.ts` with no snapshot change.

- [ ] **Step 5: Commit**

```bash
npx prettier --write src/core/undo.ts __tests__/undo.test.ts
git add src/core/undo.ts __tests__/undo.test.ts
git commit -m "refactor(undo): require the shared pool on every capture"
```
