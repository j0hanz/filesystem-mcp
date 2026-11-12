# Undo Journal Owns the Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the undo restore protocol (lock, selection, shared dry-run preview, re-keying moved entries, pruning) out of `src/tools/undo.ts` into one `UndoJournal.restore` method, with no behaviour change on the wire.

**Architecture:** `UndoJournal` already owns `reidentify` and `replaceRecords`; it gains `restore(selection, fs, opts)`, which runs today's loop from `src/tools/undo.ts:142-194` internally. `restoreEntry` and `restoreOrder` stop being exported; tests reach restore only through `journal.add` + `journal.restore`. `UndoPreview` stays exported, marked `@internal`, for one emulator test.

**Tech Stack:** TypeScript (Node, ESM `.ts` imports), Node built-in test runner, `zod/v4`.

**Spec:** decisions from the 2026-11-12 architecture review grilling (candidate "Let the undo journal own the restore"), plus `GLOSSARY.md` term **Undo journal**. Report: `C:\Users\PC\AppData\Local\Temp\architecture-review-20261112-182707.html`.

## Global Constraints

- No change to the advertised MCP surface: `__tests__/contract.test.ts` snapshot must not change.
- No change to undo tool output text, structured shape, error codes or messages.
- NOT_FOUND message stays exactly `Unknown or expired undo id "${id}".` with hint `Run undo with dryRun: true and no id to list the ids.`
- Transport policy (HTTP refusals, `Pass id or steps, not both.`, `Undo is disabled (FS_MAX_UNDO_BYTES=0).`) stays in `src/tools/undo.ts`.
- Never hand-edit versions in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`.
- Gate: `npm run check` green at the end of every task.
- After code changes run `graphify update .`.

## Review Focus

1. **Abort mid-run:** records finished before an abort leave the journal; unfinished ones stay under their id; the call rejects with the abort. Test in Task 1 (`abort keeps what finished`).
2. **Dry run leaves the journal untouched:** no `replaceRecords`, no `reidentify`; a real undo after a dry run restores everything. Test in Task 1 (`dry run changes nothing in the journal`).
3. **Two concurrent restores serialize:** the lock moves from the tool into the journal; two `restore` calls on one journal must not interleave. Test in Task 1 (`concurrent restores run one at a time`).
4. **Re-key without caller wiring:** an edit after a move, undone newest-first in one call or in two separate calls, still moves the file back. Test in Task 1 (`re-keys moves across calls`).
5. **Entry added during a restore:** a `journal.add` from a concurrent mutating call (`src/tools/define.ts:359` runs outside the lock) is not picked by a restore already running, because selection snapshots at start. Covered by implementation (select before first await); no timing test.

---

## File Structure

- `src/core/undo.ts` — gains `UndoSelection`, `RestoreStep`, `UndoJournal.restore`; `restoreEntry` and `restoreOrder` lose `export`; `UndoPreview` gets an `@internal` JSDoc tag.
- `src/tools/undo.ts` — `run` keeps validation and reporting; body of `runExclusive` replaced by one `journal.restore` call.
- `__tests__/undo.test.ts` — new `describe('UndoJournal.restore')`; the `describe('restoreEntry')` block migrates to the journal interface.
- `docs/adr/014-undo-journal-owns-the-restore.md` — new ADR.
- `GLOSSARY.md` — the **Undo journal** term (already written in the working tree).

---

### Task 1: `UndoJournal.restore`

**Files:**

- Modify: `src/core/undo.ts:115-243` (class `UndoJournal`), add types near `RestoreOutcome` (`:697`)
- Test: `__tests__/undo.test.ts` (new `describe('UndoJournal.restore')`, placed after `describe('restoreEntry')`, reusing its `newFs`/`captureOne` setup pattern)

**Interfaces:**

- Consumes: `restoreEntry(entry, fs, { dryRun, preview, signal, onRewrite, onRecord })`, `restoreOrder(records)`, `UndoPreview`, `runExclusive(key, fn)` from `./concurrency.ts`, `FsError`, `ErrorCode`.
- Produces:

```ts
export type UndoSelection = { id: string } | { steps: number } | Record<string, never>;
export interface RestoreStep { id: string; tool: string; results: UndoFileResult[] }
// on UndoJournal:
restore(
  selection: UndoSelection,
  fs: GuardedFileSystem,
  opts: {
    dryRun: boolean;
    signal?: AbortSignal | undefined;
    onProgress?: ((p: { current: number; total: number }) => void) | undefined;
  },
): Promise<RestoreStep[]>;
```

Selection rule (moved verbatim from `src/tools/undo.ts:143-162`): `{id}` → that entry or throw `FsError(ErrorCode.NOT_FOUND, …)` with the exact message and hint from Global Constraints; `{steps}` → `newest(steps)`; `{}` with `dryRun` → `newest(Infinity)`; `{}` otherwise → `newest(1)`. Empty selection returns `[]`.

- [ ] **Step 1: Write the failing tests**

Each test journals captured calls with `journal.add(tool, records)` and restores through `journal.restore` only. Names and assertions:

```ts
describe('UndoJournal.restore', () => {
  it('restores by id and drops the entry', async () => {
    // overwrite 'before' -> 'after', add, restore({ id }, fs, { dryRun: false })
    assert.strictEqual(await readFile(file, 'utf8'), 'before');
    assert.strictEqual(journal.get(id), undefined);
    assert.deepStrictEqual(
      steps.map((s) => s.id),
      [id],
    );
  });
  it('an unknown id fails NOT_FOUND with the listing hint', async () => {
    await assert.rejects(
      journal.restore({ id: 'zzzz' }, newFs(), { dryRun: false }),
      (e: FsError) =>
        e.code === ErrorCode.NOT_FOUND && e.message === 'Unknown or expired undo id "zzzz".',
    );
  });
  it('selects newest 1 by default, newest N with steps, all on a bare dry run', async () => {
    // three entries a,b,c added in order
    assert.deepStrictEqual(
      (await journal.restore({}, fs, { dryRun: true })).map((s) => s.id),
      [c, b, a],
    );
    assert.deepStrictEqual(
      (await journal.restore({ steps: 2 }, fs, { dryRun: true })).map((s) => s.id),
      [c, b],
    );
    assert.deepStrictEqual(
      (await journal.restore({}, fs, { dryRun: false })).map((s) => s.id),
      [c],
    );
  });
  it('an empty journal restores nothing', async () => {
    assert.deepStrictEqual(await new UndoJournal().restore({}, newFs(), { dryRun: false }), []);
  });
  it('re-keys moves across calls', async () => {
    // move a->b, then write b; add both; restore({}) twice (newest 1 each time)
    assert.strictEqual(await readFile(a, 'utf8'), 'v1');
    assert.deepStrictEqual(journal.newest(Infinity), []);
  });
  it('dry run changes nothing in the journal', async () => {
    // move then edit; restore({}, fs, { dryRun: true }); then restore({ steps: 2 }, fs, { dryRun: false })
    assert.strictEqual(await readFile(a, 'utf8'), 'v1');
    assert.deepStrictEqual(
      dry.flatMap((s) => s.results).map((r) => 'error' in r),
      [false, false],
    );
  });
  it('a skipped record stays under its id for a retry', async () => {
    // write, then modify the file outside; restore({ id }) -> one CANCELLED result
    assert.strictEqual(journal.get(id)?.records.length, 1);
  });
  it('abort keeps what finished', async () => {
    // two entries; onProgress aborts the controller on the first record
    await assert.rejects(journal.restore({ steps: 2 }, fs, { dryRun: false, signal, onProgress }), {
      name: 'AbortError',
    });
    assert.strictEqual(journal.newest(Infinity).length, 1); // the newer one left the journal
  });
  it('reports progress over every record of every selected entry', async () => {
    assert.deepStrictEqual(seen.at(-1), { current: 3, total: 3 });
  });
  it('concurrent restores run one at a time', async () => {
    // entries b then c; start restore({}, fs, { dryRun: false }) twice without awaiting, then Promise.all
    // selection runs inside the lock, so the second call sees c already pruned
    assert.deepStrictEqual([first[0]?.id, second[0]?.id], [c, b]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern="UndoJournal.restore"`
Expected: FAIL, `journal.restore is not a function`.

- [ ] **Step 3: Implement `UndoJournal.restore` in `src/core/undo.ts`**

Wrap the body in `runExclusive(this, …)`. Select entries synchronously before the first `await` (Review Focus 5). Compute `total` with `restoreOrder`. Build one `UndoPreview(fs, signal)` only when `dryRun`. Per entry: `signal?.throwIfAborted()`; call `restoreEntry` with `onRewrite: (was, id) => this.reidentify(was, id)` and `onRecord` driving `onProgress`; when not `dryRun`, `this.replaceRecords(entry.id, outcome.remaining)`; `signal?.throwIfAborted()` again; push `{ id, tool, results }`. Keep the two comments from `src/tools/undo.ts:167-172` and `:191` with the code they describe.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- --test-name-pattern="UndoJournal.restore"`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/undo.ts __tests__/undo.test.ts
git commit -m "feat(undo): let the journal run a restore"
```

### Task 2: The undo tool calls `journal.restore`

**Files:**

- Modify: `src/tools/undo.ts:3,7-8,39-47,140-194`

**Interfaces:**

- Consumes: `UndoJournal.restore`, `RestoreStep`, `UndoSelection` from Task 1.
- Produces: nothing new; `UndoOutput['steps']` becomes `(RestoreStep & { truncated?: true; totalResults?: number })[]`.

- [ ] **Step 1: Replace the `runExclusive` block**

`run` keeps the `enabled`, id-and-steps and HTTP checks unchanged, then:

```ts
const selection: UndoSelection = id !== undefined ? { id } : steps !== undefined ? { steps } : {};
const stepResults = await journal.restore(selection, ctx.fs, {
  dryRun,
  signal: ctx.signal,
  onProgress: ctx.onProgress,
});
if (stepResults.length === 0) return { structured: { steps: [] }, text: 'undo: nothing to undo' };
```

The reporting from `:196-218` stays as is. Drop the imports of `runExclusive`, `restoreEntry`, `restoreOrder`, `UndoPreview`, `UndoEntry`. Move the `ponytail:` lock comment (`:140-141`) to the `runExclusive` call in `UndoJournal.restore`.

- [ ] **Step 2: Run the undo wire tests**

Run: `npm test -- --test-name-pattern="undo"`
Expected: PASS, same count as on `main` (record it before Step 1 with the same command).

- [ ] **Step 3: Run the full check**

Run: `npm run check`
Expected: exit 0; `__tests__/contract.test.ts` passes with no snapshot diff.

- [ ] **Step 4: Commit**

```bash
git add src/tools/undo.ts src/core/undo.ts
git commit -m "refactor(undo): drive the undo tool through the journal's restore"
```

### Task 3: One interface — make `restoreEntry` private, migrate tests, record the decision

**Files:**

- Modify: `src/core/undo.ts:722` (`restoreOrder`), `:858` (`UndoPreview` JSDoc), `:1235` (`restoreEntry`)
- Modify: `__tests__/undo.test.ts:25-31` (imports), `:1438-2942` (`describe('restoreEntry')` and the nested `a dry run lists what the real undo then does`)
- Create: `docs/adr/014-undo-journal-owns-the-restore.md`
- Modify: `GLOSSARY.md` (commit only the **Undo journal** hunk)

**Interfaces:**

- Consumes: `UndoJournal.restore` from Task 1.
- Produces: `src/core/undo.ts` no longer exports `restoreEntry` or `restoreOrder`. `UndoPreview` stays exported with `/** @internal Emulator for restore's dry run; only tests construct it. */`.

- [ ] **Step 1: Migrate the tests**

In `describe('restoreEntry')` (rename it `describe('restore')`), replace every `restoreEntry(entry, fs, opts)` with the journal interface. Mapping:

| Old                                                                                                                  | New                                                                                                 |
| :------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| `captureOne(run)` returns an `UndoEntry`                                                                             | returns its id: `journal.add('test', cap.records)` on a per-test `journal`                          |
| `restoreEntry(entry, newFs(), { dryRun })`                                                                           | `journal.restore({ id }, newFs(), { dryRun })`                                                      |
| `outcome.results`                                                                                                    | `steps[0]?.results ?? []`                                                                           |
| `outcome.remaining` deep-equals `[]`                                                                                 | `journal.get(id)` is `undefined`                                                                    |
| `outcome.remaining.length === n`                                                                                     | `journal.get(id)?.records.length === n`                                                             |
| retry with `{ ...entry, records: first.remaining }`                                                                  | a second `journal.restore({ id }, …)`                                                               |
| hand-wired `onRewrite` → `journal.reidentify` (`:1940-1945`, `:1965-1970`, `:1993-1996`, `:2023-2026`, `:2060-2063`) | deleted; restore each entry by id in the same newest-first order                                    |
| `dryRunAll(entries)` with a shared `UndoPreview`                                                                     | `journal.restore({ steps: entries.length }, newFs(), { dryRun: true })` over a journal holding them |
| `previewThenUndo` loop with `replaceRecords` (`:2420-2431`)                                                          | `journal.restore({ id }, newFs(), { dryRun: false })` per id                                        |

Tests that pass a custom `fs` or `signal` (`:2333`, `:2423`, `:2896-2907`) keep it as `restore`'s second argument and `opts.signal`. The emulator test at `:2933` keeps `new UndoPreview(newFs()).world()` unchanged. Assertions keep their values.

- [ ] **Step 2: Drop the exports**

Remove `export` from `restoreEntry` and `restoreOrder`; add the `@internal` JSDoc to `UndoPreview`.

- [ ] **Step 3: Run the undo suite**

Run: `npm test -- --test-name-pattern="restore|undo"`
Expected: PASS; test count equal to Step 2 of Task 2 plus Task 1's 10.

- [ ] **Step 4: Write `docs/adr/014-undo-journal-owns-the-restore.md`**

Follow the shape of `docs/adr/011-guarded-filesystem-owns-deletion.md`: Status accepted 2026-11-12; Context (protocol in `src/tools/undo.ts:142-194`, five steps, two of which break later undos if skipped; six tests re-wired `onRewrite` by hand); Decision (`UndoJournal.restore` owns lock, selection, shared preview, re-key, prune; tool keeps transport policy and reporting; `restoreEntry`/`restoreOrder` private; `UndoPreview` exported `@internal` for the one emulator test that no record sequence reaches); Considered options (free function taking the journal; tool keeps selection; keep `restoreEntry` exported without `onRewrite`); Consequences (do not add a second restore path beside the journal; extend `restore`).

- [ ] **Step 5: Full check and graph**

Run: `npm run check`
Expected: exit 0, no contract snapshot diff.
Run: `graphify update .`

- [ ] **Step 6: Commit**

Stage only the **Undo journal** hunk of `GLOSSARY.md`; the **Mark** hunk and the Text view edit belong to PR 2. Without interactive staging: `git diff GLOSSARY.md > C:/tmp/glossary.patch`, delete the Mark and Text view hunks from the patch file, then `git apply --cached C:/tmp/glossary.patch`.

```bash
git add src/core/undo.ts __tests__/undo.test.ts docs/adr/014-undo-journal-owns-the-restore.md graphify-out
git commit -m "refactor(undo): test restore only through the journal"
```
