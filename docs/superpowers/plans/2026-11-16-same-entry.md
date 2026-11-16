# Same-Entry Judge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `create`, `edit`, `delete` and `move` decide "two items name one Entry" through one `PathGuard` method that follows the guard's per-directory case rule.

**Architecture:** `PathGuard.entryKeys` returns one key per path; equal keys are one Entry. Unicode form and spaces always fold; case folds only when the holding directory (or nearest existing ancestor inside a root) is case-insensitive, via the existing `isDirectoryCaseSensitive` in `path.ts`. `edit` and `create` move their duplicate checks from zod `superRefine` into `run`.

**Tech Stack:** TypeScript on Node, `node:test`, zod.

**Spec:** `docs/adr/021-same-entry-follows-the-guards-directory-rule.md` (plus Respelling in `GLOSSARY.md`)

## Global Constraints

- Start after the text-body PR merges; branch from `main`; one PR.
- Error code and messages unchanged: `duplicate of files[N].path; put every edit for one file in a single entry` (edit), `duplicate of files[N].path; one entry per file` and `duplicate of directories[N]; one entry per directory` (create), `another entry in this batch already targets "…"` (move).
- Out of scope: `path.ts` root/grant comparisons, Scan name matching, `isPathInsideDirectory`, `nestedIndexes`, `create.ts:110` file-versus-directory conflict, `undo.ts` `journalRecords`.
- The judge never reads a directory outside the allowed roots; with no ancestor inside a root it uses `IS_CASE_INSENSITIVE_FS`.
- No contract snapshot change expected. After code changes run `graphify update .`. Gate: `npm run check`.

## Review Focus

1. Two relative spellings (`a.txt`, `<root>/A.TXT`) in one `edit` call on a case-insensitive FS: still refused before any write. (Task 2 test.)
2. A directory listing that cannot be read (permission denied): the judge falls back up the ancestors, never throws. (Task 1 test, POSIX only.)
3. A path outside every root (grant pending): the judge reads no directory outside the roots and falls back to `IS_CASE_INSENSITIVE_FS`, never throws. (Task 1 test.)
4. `create` with two new files under a folder the same call creates: NFC/NFD twins are one item. (Task 3 test.)
5. `delete` naming one link twice in different case: still collapses only when both saw one identity. (Task 4: existing test stays green.)

---

### Task 1: `PathGuard.entryKeys`

**Files:**
- Modify: `src/core/path.ts` (new public method on `PathGuard`; reuses `isDirectoryCaseSensitive` L191-212, `unicodeMatchKey`, `unicodeMatchKeyExactCase`)
- Test: create `__tests__/path-guard-entry-keys.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** One key per path, in order; equal keys name one Entry (a Respelling). Paths are absolute. */
  entryKeys(paths: readonly string[], signal?: AbortSignal): Promise<string[]>;
  ```
  Key: `resolve(path)` folded with `unicodeMatchKey` when its rule directory is case-insensitive, else `unicodeMatchKeyExactCase`. Rule directory: the nearest existing ancestor of `dirname(path)` inside an allowed root (walk up, stop at the root). Read each rule directory once per call (Map by real path).

- [ ] **Step 1: Write the failing tests**

```ts
const caseless = process.platform === 'win32' || process.platform === 'darwin';
it('folds Unicode form and spaces', async () => {
  const [a, b, c, d] = await guard.entryKeys([join(root, 'café.txt'), join(root, 'café.txt'), join(root, 'shot PM.png'), join(root, 'shot PM.png')]);
  assert.strictEqual(a, b);
  assert.strictEqual(c, d);
});
it('folds case by the directory rule', async () => {
  await writeTestFile(root, 'k/Name.txt', 'x');
  const [a, b] = await guard.entryKeys([join(root, 'k', 'Name.txt'), join(root, 'k', 'NAME.txt')]);
  assert.strictEqual(a === b, caseless);
});
it('uses the nearest existing ancestor for a missing parent', async () => {
  const [a, b] = await guard.entryKeys([join(root, 'new', 'x.txt'), join(root, 'NEW', 'X.txt')]);
  assert.strictEqual(a === b, caseless);
});
it('keeps different names apart', async () => {
  const [a, b] = await guard.entryKeys([join(root, 'a.txt'), join(root, 'b.txt')]);
  assert.notStrictEqual(a, b);
});
```
Plus a POSIX-only (`skip: process.platform === 'win32'`) test: a mode-000 folder as parent still yields keys, no throw. Plus `it('falls back to the platform rule outside the roots', …)`: two paths in `tmpdir()` (outside `root`) differing in case resolve without throwing, and `a === b` equals `caseless`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="entryKeys|folds Unicode form|directory rule|nearest existing ancestor|different names apart"`
Expected: FAIL with "guard.entryKeys is not a function".

- [ ] **Step 3: Implement `entryKeys` on `PathGuard`**

- [ ] **Step 4: Run tests to verify they pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/path.ts __tests__/path-guard-entry-keys.test.ts
git commit -m "feat(path): judge same-Entry by the guard's directory rule"
```

### Task 2: `edit` checks duplicates in `run`

**Files:**
- Modify: `src/tools/edit.ts` (remove L117-131 from `superRefine`; check in `run` before any Rewrite)
- Test: `__tests__/edit.test.ts` (L169-188 and a new NFC/NFD test)

**Interfaces:**
- Consumes: `ctx.fs.pathGuard.entryKeys` (Task 1).

- [ ] **Step 1: Write the failing test and adjust the old one**

The old test at L169 stops using `schemaIssues`; it asserts the call result is an error with code `INVALID_INPUT` and a message matching `/duplicate of files\[0\]\.path; put every edit for one file in a single entry/`, file unchanged. New `it('refuses NFC and NFD spellings of one file in one batch', …)`: file `café.txt`, entries for `café.txt` and `café.txt`, same assertions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="same file twice|NFC and NFD spellings of one file"`
Expected: FAIL — NFD twin passes today (`isSamePath` does no Unicode fold).

- [ ] **Step 3: Implement** — in `run`, `await ctx.fs.pathGuard.entryKeys(files.map((f) => f.path), ctx.signal)`; the first repeated key throws `FsError` with `ErrorCode.INVALID_INPUT` and message `files.<i>.path: duplicate of files[<first>].path; put every edit for one file in a single entry`, before any Rewrite starts. Drop the `isSamePath` import if unused.

- [ ] **Step 4: Run tests to verify they pass** (same command, then `npm test -- --test-name-pattern="edit"`). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/edit.ts __tests__/edit.test.ts
git commit -m "fix(edit): refuse respellings of one file in a batch"
```

### Task 3: `create` uses the judge

**Files:**
- Modify: `src/tools/create.ts` (remove the duplicate checks L94-105 and L121-135 from `superRefine`, keep L106-120; replace `unicodeMatchKey(plan.validPath)` at L341)
- Test: `__tests__/create.test.ts` (L136 test moves off `schemaIssues`; new tests)

**Interfaces:**
- Consumes: `entryKeys` (Task 1).

- [ ] **Step 1: Write the failing tests**

- Old duplicate-files test (near L136): asserts `INVALID_INPUT` and `/duplicate of files\[0\]\.path; one entry per file/` from the call result.
- New `it('treats NFC and NFD new files under a new folder as one entry', …)`: `files: [{ path: 'nf/café.txt', content: 'a' }, { path: 'nf/café.txt', content: 'b' }]` where `nf` does not exist; assert `INVALID_INPUT` duplicate message and nothing written.
- New, `skip: process.platform === 'linux'`: `dirs: ['d1', 'D1']` gives `/duplicate of directories\[0\]; one entry per directory/`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="one entry per file|NFC and NFD new files|one entry per directory"`
Expected: FAIL — errors still come from the schema path (`schemaIssues` shape), not the call result.

- [ ] **Step 3: Implement** — in `run`, one `entryKeys` call over `[...directories, ...files.map((f) => f.path)]` before planning; repeated keys within `directories` or within `files` throw `INVALID_INPUT` with the existing messages, prefixed `directories.N:` / `files.N.path:`. At L341 key the Landing map with `entryKeys` over the plans' `validPath`s (one call for all plans).

- [ ] **Step 4: Run tests to verify they pass** (same command, then `npm test -- --test-name-pattern="create"`). Expected: PASS, including every `another entry in this batch` test.

- [ ] **Step 5: Commit**

```bash
git add src/tools/create.ts __tests__/create.test.ts
git commit -m "refactor(create): judge duplicate entries through the path guard"
```

### Task 4: `move` and `delete` use the judge

**Files:**
- Modify: `src/tools/move.ts:165-188` (`destKey` from `entryKeys` over `ready` destinations; `touches` at L199-202 unchanged)
- Modify: `src/tools/delete.ts:145-155` (`sawSameEntry` compares `entryKeys` of `validPath`s, keeps `sameIdentity`)
- Test: `__tests__/move.test.ts`, `__tests__/delete.test.ts`

**Interfaces:**
- Consumes: `entryKeys` (Task 1).

- [ ] **Step 1: Write the failing test**

`__tests__/delete.test.ts`, `it('collapses NFC and NFD names of one entry', …)`, skip on Linux (both spellings can be distinct files there): create `café.txt`; `delete({ paths: [nfc, nfd] })`; assert one result `deleted: true`, the other `omitted`, file gone.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="collapses NFC and NFD"`
Expected: FAIL — the second item plans again (ASCII-only fold).

- [ ] **Step 3: Implement** — compute keys once per call before the loops (`await` before the `for`), then compare keys where the folds were.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="move|delete"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/move.ts src/tools/delete.ts __tests__/delete.test.ts
git commit -m "refactor(move,delete): judge same-Entry through the path guard"
```

### Task 5: Docs and graph

- [ ] **Step 1:** CHANGELOG Unreleased: `edit` and `delete` treat Unicode respellings of one file as one item; Batch tools follow per-directory case sensitivity.
- [ ] **Step 2:** `graphify update .`, then `npm run check`. Expected: PASS, contract snapshot unchanged.
- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md docs/adr/021-same-entry-follows-the-guards-directory-rule.md GLOSSARY.md graphify-out
git commit -m "docs: ADR-021 same-Entry follows the guard"
```
