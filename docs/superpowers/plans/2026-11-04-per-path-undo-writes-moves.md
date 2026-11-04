# Per-Path Undo for Writes, Creates and Moves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One file, entry or move that can't be saved for undo costs only its own undo; the rest of the call stays restorable and the result names what was lost.

**Architecture:** `delete` already gives each path its own capture (`UndoCapture.forPath` / `commit` / `release`, `src/core/fs.ts:979`). This plan applies that pattern at the operation level in `GuardedFileSystem`: `writeFile`, `appendFile`, `mkdir` and `#move`. `create.ts`, `move.ts`, `edit.ts`, `replace-text.ts` and `rewrite.ts` need no change because they all reach those four methods. A new `UndoCapture.journalRecords()` drops `rmdir` records for folders a refused path still uses.

**Tech Stack:** TypeScript, Node's built-in test runner, `__tests__/tool-harness.ts`, in-memory client pairs.

**Spec:** GitHub issues [#227](https://github.com/j0hanz/filesystem-mcp/issues/227) (parent), [#228](https://github.com/j0hanz/filesystem-mcp/issues/228), [#229](https://github.com/j0hanz/filesystem-mcp/issues/229), [#230](https://github.com/j0hanz/filesystem-mcp/issues/230). The `delete` fix (#231, `fbda2624`) that blocked them is merged.

## Global Constraints

- Report format: `· undo <id> · not undoable: <path>: <reason>`; `undoUnavailable` is `<path>: <reason>`, joined by `; `, capped by `joinRoster` at 20.
- `<path>` is `pathLabel(validPath)`. For a move it is the destination. For a refused parent-folder chain it is the folder, and the entry's file keeps its own undo.
- Tests compare captured and restored paths through `pathLabel`: on Windows `validPath` has a lowercase drive letter, so `join(tmpDir, ...)` does not match it.
- `copy: true` keeps the call-wide `not undoable: copies are not undoable yet`, with no path and no undo id.
- A call with no restorable record has no undo id and still reports each refusal.
- An operation that throws before changing anything reports no refusal. Its failure is already in the result. One that throws after changing something, and can't be undone, reports it.
- Undo's identity and hash checks are unchanged.
- `create.ts`, `move.ts` and the contract snapshot do not change. If the snapshot test fails, stop and report it.
- Never hand-edit versions in `package.json` or the plugin manifests.
- After code changes, run `graphify update .`.

## Review Focus

1. The refused entry commits before, or after, the sibling that made the shared folder: `journalRecords()` drops the folder's `rmdir` in both orders. (Task 2)
2. A `directories` entry makes `new/`, and a file refused under it stays: undo keeps `new/`. (Task 2)
3. `undo` with `dryRun` on a partial entry lists the same paths as the real undo, and neither mentions the kept folder. (Task 2)
4. An over-budget write that then fails or aborts: no refusal, target unchanged. (Task 1)
5. A refused over-budget file returns its charge, so a later small file in the same call still fits. (Task 1)

---

## File Structure

| File                       | Change                                                         |
| :------------------------- | :------------------------------------------------------------- |
| `src/core/undo.ts`         | `#refused` becomes a `Map`; add `journalRecords()`             |
| `src/core/fs.ts`           | Per-operation captures; cross-device reason moves to `#move`   |
| `src/tools/define.ts`      | `#undoSuffix` journals `journalRecords()`                      |
| `__tests__/undo.test.ts`   | fs-level and wire tests                                        |
| `__tests__/move-exdev.test.ts` | Cross-device move costs only its own undo                  |
| `CHANGELOG.md`, `GLOSSARY.md`, `docs/client-guide.md`, `docs/adr/008-rename-owns-the-cross-device-fallback.md` | Describe the wider behaviour |

The shared shape for every operation below:

```ts
const capture = this.#capture?.forPath(validPath);
try {
  // ...the operation, recording through `capture`...
  capture?.commit();
} finally {
  capture?.release(); // no-op after commit; otherwise returns the charge and reports nothing
}
```

---

### Task 1: One file that can't be saved costs only its own undo (#228)

**Files:**
- Modify: `src/core/fs.ts:708-824` (`writeFile`)
- Test: `__tests__/undo.test.ts`

**Interfaces:**
- Consumes: `UndoCapture.forPath(path)`, `commit()`, `release()`, `abandon(reason)`.
- Produces: `GuardedFileSystem.writeFile` keeps its signature. Refusal text is now `<basename>: <reason>`, also for a one-file call.

`edit` is multi-file and reaches `writeFile` through `rewriteFile`, so it is covered by this task. `patch` takes one file by schema (`src/tools/patch.ts`), so it has no sibling to lose; state that on #228 when closing it.

- [ ] **Step 1: Write the failing fs-level tests**

In `describe('UndoCapture via GuardedFileSystem')` (`makeFs` and `capture` are the local helpers; add imports for `link` and `readFile` if missing):

```ts
it('a file over the budget costs only its own undo and returns its charge', async () => {
  const big = join(tmpDir, 'over-budget.txt');
  const small = join(tmpDir, 'after-big.txt');
  await writeFile(big, 'x'.repeat(4000));
  await writeFile(small, 'old');
  const cap = new UndoJournal(2000).beginCapture();
  const fs = makeFs(cap);
  await fs.writeFile(big, 'new');
  await fs.writeFile(small, 'new');
  assert.strictEqual(cap.unavailableReason(), 'over-budget.txt: too large to keep for undo');
  assert.deepStrictEqual(cap.records.map((r) => r.op === 'write' && pathLabel(r.path)), ['after-big.txt']);
  cap.release();
});

it('a refused write that never ran reports nothing', async () => {
  const big = join(tmpDir, 'never-written.txt');
  await writeFile(big, 'x'.repeat(4000));
  const cap = new UndoJournal(2000).beginCapture();
  const aborted = AbortSignal.abort();
  await assert.rejects(makeFs(cap).writeFile(big, 'new', { signal: aborted }));
  assert.strictEqual(cap.unavailableReason(), undefined);
  assert.deepStrictEqual(cap.records, []);
  assert.strictEqual(await readFile(big, 'utf8'), 'x'.repeat(4000));
  cap.release();
});

it('a write that fails part-way reports only that file', async () => {
  const kept = join(tmpDir, 'partway-kept.txt');
  const linked = join(tmpDir, 'partway-linked.txt');
  await writeFile(kept, 'old');
  await writeFile(linked, 'old');
  await link(linked, join(tmpDir, 'partway-other-name.txt')); // nlink > 1 writes in place
  const cap = capture();
  const fs = makeFs(cap);
  await fs.writeFile(kept, 'new');
  // Not a string or Buffer: handle.writeFile throws after the truncate.
  await assert.rejects(fs.writeFile(linked, 42 as unknown as string));
  assert.strictEqual(cap.unavailableReason(), 'partway-linked.txt: the write failed part-way');
  assert.deepStrictEqual(cap.records.map((r) => r.op === 'write' && pathLabel(r.path)), ['partway-kept.txt']);
  cap.release();
});
```

Two POSIX-only tests in the same file also change. They skip on Windows, so confirm them on WSL or CI:

- Line 369: `'write-only.txt: could not read the old content'`
- Line 388: `'pipe.fifo: cannot capture a write over a non-regular file'`

- [ ] **Step 2: Write the failing wire tests**

In `describe('undo tool over the wire')`, next to the `delete` test at line 2324:

```ts
for (const [tool, args] of [
  ['replace_text', (root: string) => ({ path: root, searchPattern: 'old', replacement: 'new' })],
  ['edit', (_root: string, small: string, big: string) => ({
    files: [small, big].map((path) => ({ path, edits: [{ oldText: 'old', newText: 'new' }] })),
  })],
  ['create', (_root: string, small: string, big: string) => ({
    files: [small, big].map((path) => ({ path, content: 'new', overwrite: true })),
  })],
] as const) {
  it(`${tool}: one file over the budget stays as written, the other is restored`, async () => {
    // small.txt holds 'old'; big.txt holds 'old' + 4000 'x'; FS_MAX_UNDO_BYTES is 2000.
    // Assert, reading `result.structuredContent ?? result._meta`:
    //   meta.undoUnavailable === 'big.txt: too large to keep for undo'
    //   meta.undo is the id; for replace_text and edit, the first text line ends
    //   / · undo [a-z0-9]{4} · not undoable: big\.txt: too large to keep for undo$/u
    // Then undo by meta.undo: isError is not true, small.txt is 'old',
    // big.txt is still what the tool wrote.
  });
}

it('a replace_text in which no file could be saved has no undo id and reports each file', async () => {
  // Both files over FS_MAX_UNDO_BYTES 2000; both are changed.
  // meta.undo === undefined; meta.undoUnavailable includes 'a.txt: too large to keep for undo'
  // and 'b.txt: too large to keep for undo', joined by '; ' in either order.
});
```

The table's `args` type is illustrative: give each entry the same `(root, small, big)` signature.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="over the budget|never ran|part-way|no file could be saved"`
Expected: FAIL. The reason has no path, and the undo id is missing.

- [ ] **Step 4: Move the body of `writeFile` into `#writeValid` and scope its capture**

```ts
async writeFile(filePath, content, options = {}): Promise<{ validPath: string }> {
  const validPath = await this.#guard('write', filePath);
  const capture = this.#capture?.forPath(validPath);
  try {
    await this.#writeValid(validPath, filePath, content, options, capture);
    capture?.commit();
    return { validPath };
  } finally {
    capture?.release();
  }
}
```

`#writeValid(validPath: string, filePath: string, content: string | Buffer, options: {...}, capture: UndoCapture | undefined): Promise<void>` is the current body from line 716, with `this.#capture` replaced by `capture`. At the part-way catch: `capture?.abandon('the write failed part-way'); capture?.commit();` then rethrow. The bytes already changed, so this exit must report.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="over the budget|never ran|part-way|no file could be saved"`
Expected: PASS.

Run: `npm test -- __tests__/undo.test.ts __tests__/create.test.ts __tests__/edit.test.ts __tests__/replace-text.test.ts __tests__/rewrite.test.ts`
Expected: PASS. Any other failure on an exact reason string gets the `<basename>: ` prefix only.

- [ ] **Step 6: Commit**

```bash
git add src/core/fs.ts __tests__/undo.test.ts
git commit -m "fix(write): keep undo for files a sibling can't save"
```

Body: `Closes #228`, `Refs #227`.

---

### Task 2: One create entry that can't be undone costs only its own undo (#229)

**Files:**
- Modify: `src/core/undo.ts:231-258` (`#refused`, `unavailableReason`, `commit`), plus new `journalRecords`
- Modify: `src/core/fs.ts:485-498` (`mkdir`), `src/core/fs.ts:832-928` (`appendFile`)
- Modify: `src/tools/define.ts:342-352` (`#undoSuffix`)
- Test: `__tests__/undo.test.ts`

**Interfaces:**
- Consumes: Task 1's capture shape.
- Produces: `UndoCapture.journalRecords(): UndoRecord[]`, the records an undo id restores. It drops each `rmdir` whose folder holds a refused path or is one. It reads final state, so commit order does not matter.

- [ ] **Step 1: Write the failing fs-level tests**

In `describe('UndoCapture via GuardedFileSystem')`:

```ts
it('undo keeps a folder a refused entry still uses, and removes what survivors made', async () => {
  const folder = join(tmpDir, 'shared-new', 'sub');
  const a = join(folder, 'a.txt');
  const b = join(folder, 'b.txt');
  // 2 rmdir + remove a = 1536 bytes; remove b goes to 2048.
  const cap = new UndoJournal(1600).beginCapture();
  const fs = makeFs(cap);
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(a, 'a');
  await fs.writeFile(b, 'b');
  assert.strictEqual(cap.unavailableReason(), 'b.txt: too many changes to keep for undo');
  const records = cap.journalRecords();
  assert.deepStrictEqual(records.map((r) => r.op), ['remove']);

  const entry = { id: 'x', tool: 'create', createdAt: 0, records };
  const plain = new GuardedFileSystem(ctx.pathGuard);
  const preview = await restoreEntry(entry, plain, { dryRun: true });
  const real = await restoreEntry(entry, plain, { dryRun: false });
  assert.deepStrictEqual(preview.results.map((r) => pathLabel(r.path)), ['a.txt']);
  assert.deepStrictEqual(real.results.map((r) => pathLabel(r.path)), ['a.txt']);
  assert.deepStrictEqual(real.remaining, []);
  await assert.rejects(readFile(a, 'utf8'));
  assert.strictEqual(await readFile(b, 'utf8'), 'b');
  cap.release();
});

it('journalRecords does not depend on which path committed first', () => {
  const dir = join(tmpDir, 'order');
  const file = join(dir, 'refused.txt');
  for (const refusedFirst of [true, false]) {
    const cap = new UndoJournal(1024 * 1024).beginCapture();
    const survivor = cap.forPath(dir);
    survivor.push({ op: 'rmdir', path: dir });
    const refused = cap.forPath(file);
    refused.abandon('no');
    for (const own of refusedFirst ? [refused, survivor] : [survivor, refused]) own.commit();
    assert.deepStrictEqual(cap.journalRecords(), []);
    cap.release();
  }
});

it('a directories entry keeps its folder when a file under it is refused', async () => {
  // Over the wire, or through runToolBodyResult(CREATE, ..., { fs: makeFs(cap) }):
  // directories: [new/], files: [new/a.txt, new/b.txt], budget 1100.
  // One entry is refused, the parallel order decides which.
  // cap.journalRecords() has no rmdir; assert the refused name appears in the reason.
});

it('an append that fails part-way reports only that entry', async () => {
  const kept = join(tmpDir, 'append-kept.txt');
  const log = join(tmpDir, 'append-partway.txt');
  await writeFile(log, 'old');
  const cap = capture();
  const fs = makeFs(cap);
  await fs.writeFile(kept, 'k');
  // Not a string: handle.writeFile throws, inside the write.
  await assert.rejects(fs.appendFile(log, 42 as unknown as string));
  assert.strictEqual(cap.unavailableReason(), 'append-partway.txt: the append failed part-way');
  assert.strictEqual(cap.records.length, 1);
  cap.release();
});

it('an append that made a file and removed it again costs nothing', async () => {
  const fresh = join(tmpDir, 'append-new-partway.txt');
  const cap = capture();
  await assert.rejects(makeFs(cap).appendFile(fresh, 42 as unknown as string));
  assert.strictEqual(cap.unavailableReason(), undefined);
  await assert.rejects(readFile(fresh, 'utf8'));
  cap.release();
});

it('an append cancelled before its write reports nothing', async () => {
  const log = join(tmpDir, 'append-cancelled.txt');
  await writeFile(log, 'old');
  const cap = capture();
  await assert.rejects(makeFs(cap).appendFile(log, 'x', { signal: failOnSecondCheck() }));
  assert.strictEqual(cap.unavailableReason(), undefined);
  assert.strictEqual(await readFile(log, 'utf8'), 'old');
  cap.release();
});

it('a folder chain that cannot be inspected costs only that folder, and names it', async () => {
  const cap = capture();
  const refused = cap.forPath(join(tmpDir, 'sub'));
  // A NUL makes lstat reject on every platform.
  assert.deepStrictEqual(await plannedMkdirChain(refused, join(tmpDir, 'bad\0name')), []);
  refused.commit();
  const kept = cap.forPath(join(tmpDir, 'other'));
  kept.push({ op: 'rmdir', path: join(tmpDir, 'other') });
  kept.commit();
  assert.strictEqual(cap.unavailableReason(), 'sub: could not inspect the parent folders');
  assert.strictEqual(cap.records.length, 1);
  cap.release();
});
```

`failOnSecondCheck(): AbortSignal` is a local helper in the same describe, on the pattern at `__tests__/core-fs.test.ts:512`: an object cast to `AbortSignal` whose `throwIfAborted()` passes on its first call and throws on later ones. `appendFile` calls it before the open and again before the write. Import `plannedMkdirChain` from `../src/core/undo.ts`.

- [ ] **Step 2: Write the failing wire test**

```ts
it('a create with one oversized append restores the other entries and their folders', async () => {
  // FS_MAX_UNDO_BYTES 4096. big.log holds 8000 'x'.
  // files: [{ path: big.log, content: 'more', append: true }, { path: new/sub/a.txt, content: 'a' }]
  // structuredContent.undoUnavailable === 'big.log: too large to keep for undo',
  // and the JSON text block includes that string.
  // Undo by structuredContent.undo: isError not true, a.txt and new/ are gone,
  // big.log still ends 'more'.
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="refused entry|committed first|directories entry|part-way|removed it again|cancelled before|chain that cannot|oversized append"`
Expected: FAIL. `journalRecords` is not a function.

- [ ] **Step 4: Add `journalRecords` in `src/core/undo.ts`**

`#refused` becomes `Map<string, string>` (path to reason), so two entries refused on one folder report once. `commit` calls `parent.#refused.set(path, String(this.#unavailable))`. `unavailableReason` renders `joinRoster([...map].map(([path, reason]) => `${pathLabel(path)}: ${reason}`), '; ')`.

```ts
/** What an undo id restores: the folder of a refused path stays, since that path still sits in it. */
journalRecords(): UndoRecord[] {
  if (this.#refused.size === 0) return this.records;
  const kept = [...this.#refused.keys()];
  return this.records.filter(
    (record) =>
      record.op !== 'rmdir' || !kept.some((path) => isPathInsideDirectory(record.path, path)),
  );
}
```

- [ ] **Step 5: Journal `journalRecords()` in `#undoSuffix`**

In `src/tools/define.ts`: `const records = capture.journalRecords();`, then test `records.length > 0` and pass `records` to `undoJournal.add`.

- [ ] **Step 6: Scope `mkdir` and `appendFile`**

`mkdir`: `forPath(validPath)`, chain planned on it, then the shared `try`/`commit`/`finally` around `fsMkdir` and the `push`.

`appendFile`: `forPath(validPath)` after the guard, with the same shape around everything below it. Add `let writing = false`, set to `true` on the line before `handle.writeFile`, so the checks above it in the `try` stay no-change exits. The existing created-file cleanup runs on every failure, as it does now, and its `Logger.warn` stays. Report only when `writing` is true and the file remains (`!created`, or the unlink failed): `capture?.abandon('the append failed part-way'); capture?.commit();` then rethrow.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="refused entry|committed first|directories entry|part-way|removed it again|cancelled before|chain that cannot|oversized append"`
Expected: PASS.

Run: `npm test -- __tests__/undo.test.ts __tests__/create.test.ts __tests__/core-fs.test.ts __tests__/delete.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/undo.ts src/core/fs.ts src/tools/define.ts __tests__/undo.test.ts
git commit -m "fix(create): keep undo for entries a sibling can't save"
```

Body: `Closes #229`, `Refs #227`.

---

### Task 3: One move that can't be saved costs only its own undo (#230)

**Files:**
- Modify: `src/core/fs.ts:657-706` (`#move`), `src/core/fs.ts:1093` (remove the abandon in `#copyIntoPlace`)
- Test: `__tests__/undo.test.ts`, `__tests__/move-exdev.test.ts`
- Docs: `CHANGELOG.md`, `GLOSSARY.md`, `docs/client-guide.md`, `docs/adr/008-rename-owns-the-cross-device-fallback.md`

**Interfaces:**
- Consumes: Task 1's capture shape; Task 2's `journalRecords()`.
- Produces: the new reason `a move across devices is not undoable yet`.

`#copy` (line 1022) still abandons the call's capture, and all copy paths pass through it, so the abandon in `#copyIntoPlace` serves only the cross-device move. That line reaches the call's capture and would still cost every sibling.

- [ ] **Step 1: Write the failing tests**

In `describe('UndoCapture via GuardedFileSystem')`. Each builds `new GuardedFileSystem(await makeGuard([tmpDir]), cap, raw)`:

```ts
it('a move that replaced a directory costs only its own undo', async () => {
  // src-dir/ and an empty dest-dir/; keep.txt.
  // raw.rename removes an empty directory destination first, so this runs on Windows too.
  // fs.rename(src-dir, dest-dir), then fs.rename(keep.txt, kept.txt).
  // Reason: 'dest-dir: move replaced a directory'.
  // cap.journalRecords() is one rename for keep.txt.
  // restoreEntry moves keep.txt back; dest-dir stays as moved.
});

it('a destination that cannot be read costs only that move its undo', async () => {
  // Subclass GuardedFileSystem: readSaved rejects with an EIO-shaped Error.
  // fs.rename(a.txt, existing.txt), then fs.rename(c.txt, d.txt).
  // Reason: 'existing.txt: could not read the old content'.
  // Records: one rename, for c.txt.
});

it('a moved entry that cannot be inspected costs only that move its undo', async () => {
  // raw.rename renames, then removes the destination, on the first call only.
  // Reason: '<dest>: could not inspect the moved entry'; a second move is kept.
});

it('a move that fails after a refusal reports nothing', async () => {
  // Budget 2000; destination holds 4000 bytes; raw.rename rejects EACCES.
  // assert.rejects; cap.unavailableReason() === undefined; cap.records is [].
});

it('undo still refuses a moved entry that changed, in a partial move', async () => {
  // journal = new UndoJournal(2000); cap = journal.beginCapture();
  // moves: a.txt -> b.txt, plus c.txt -> d.txt where d.txt holds 4000 bytes.
  // runToolBodyResult(MOVE, args, { fs: new GuardedFileSystem(guard, cap),
  //   confirm: choose('overwrite'), undoJournal: journal }).
  // id = journal.add('move', cap.journalRecords()); cap.release().
  // Replace b.txt with a new file (unlink, then write).
  // runToolBodyResult(UNDO, { id }, { fs: new GuardedFileSystem(guard), undoJournal: journal }):
  // structured.steps[0].results has one result, label 'a.txt', error.message matching
  // /Not restored/; b.txt keeps the new bytes. Import MOVE and choose.
});

it('a partial move names the refused destination and undoes the other', async () => {
  // In describe('undo tool over the wire'). The overwrite needs a prompt, so:
  // withEnv({ FS_MAX_UNDO_BYTES: '2000' }, () => createElicitationClientPair([tmp],
  //   async () => ({ action: 'accept', content: { choice: 'overwrite' } }))).
  // moves: a.txt -> b.txt, plus c.txt -> d.txt where d.txt holds 4000 bytes.
  // First text line ends / · undo [a-z0-9]{4} · not undoable: d\.txt: too large to keep for undo$/u.
  // _meta.undoUnavailable === 'd.txt: too large to keep for undo'; _meta.undo is the id.
  // Undo by that id: isError not true, a.txt is back, b.txt absent, d.txt holds c's bytes.
});

it('a copy with new parents keeps the call-wide reason and no undo id', async () => {
  // Over the wire: moves [a -> new/a, b -> new/b], copy: true.
  // First line ends / · not undoable: copies are not undoable yet$/u.
  // _meta.undo === undefined; _meta.undoUnavailable has no 'a:' or 'b:' prefix.
});
```

In `__tests__/move-exdev.test.ts`:

```ts
it('a cross-device move costs only its own undo', async () => {
  // exdevOnce() raw, capture attached. fs.rename(x, x-dest), then fs.rename(y, y-dest).
  // Reason: 'x-dest: a move across devices is not undoable yet'.
  // Records: one rename, for y.
});

it('a cross-device move whose source removal fails still reports the lost undo', async () => {
  // exdevOnce({ rm: () => Promise.reject(errno('EPERM')) }), capture attached.
  // assert.rejects on fs.rename(x, x-dest): the destination already holds the copy.
  // Reason: 'x-dest: a move across devices is not undoable yet'.
});

it('a cross-device move whose copy fails reports nothing', async () => {
  // A source that fsCp cannot copy, as the test at line 113 of this file sets up.
  // assert.rejects; cap.unavailableReason() === undefined.
});
```

Record checks in this task compare `pathLabel`, per Global Constraints.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="replaced a directory|cannot be read|cannot be inspected|after a refusal|partial move|new parents|cross-device move"`
Expected: FAIL, except `new parents`, which pins behaviour that must survive.

- [ ] **Step 3: Scope `#move` and move the cross-device abandon**

`const capture = this.#capture?.forPath(validNew);`, then the shared shape around the snapshot, rename, recording and commit. In the EXDEV branch: `capture?.abandon('a move across devices is not undoable yet');`, then `await this.#moveAcrossDevices(validOld, validNew, plan.request.source, capture); return;`. `#moveAcrossDevices` gains the parameter `capture: UndoCapture | undefined` and calls `capture?.commit()` right after `copied = true`: the destination has changed by then, so a failed source removal still reports, and a failed copy does not. Delete `this.#capture?.abandon('copies are not undoable yet')` and its comment from `#copyIntoPlace`.

A spelling-only rename still skips the snapshot (`!plan.respelling`) and records through `capture`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="replaced a directory|cannot be read|cannot be inspected|after a refusal|partial move|new parents|cross-device move"`
Expected: PASS.

- [ ] **Step 5: Update the docs**

- `CHANGELOG.md`: widen the existing `delete` bullet under `[Unreleased] > Fixed`, keeping its report format. Name `delete`, `replace_text`, `edit`, `create` and `move`, and state that an undo id may restore only some of a call's paths. Note the new cross-device reason.
- `GLOSSARY.md` (Capture): replace the last sentence with `Each path a call changes has its own capture, so abandoning one costs only that path's undo; a copy abandons the whole call.`
- `docs/client-guide.md:309`: `A `delete` can carry both` becomes `A call can carry both`; add that a copy reports one reason with no path.
- `docs/adr/008-rename-owns-the-cross-device-fallback.md:32`: `A move completed by a copy abandons its own capture: a cross-device move is not undoable yet.`

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: exit 0. The contract snapshot is unchanged.

Run: `graphify update .`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/core/fs.ts __tests__/undo.test.ts __tests__/move-exdev.test.ts CHANGELOG.md GLOSSARY.md docs/client-guide.md docs/adr/008-rename-owns-the-cross-device-fallback.md
git commit -m "fix(move): keep undo for moves a sibling can't save"
```

Body: `Closes #230`, `Closes #227`.
