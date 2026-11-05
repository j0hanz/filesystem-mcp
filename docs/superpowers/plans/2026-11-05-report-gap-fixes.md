# Report Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 7 gaps from the 2026-11-05 client-session audit: schema wording that mispredicts refusals, missing result-text facts, the unnamed stale patch hunk, undo preview wording, and the Windows `created` surprise.

**Architecture:** All seven are surface fixes: tool schema descriptions, one result-text line each in `search_text` and `replace_text`, a per-hunk diagnosis loop on patch failure, one word in `undo`'s reason lines, and one sentence in `stat`'s description. No behavior changes to guards, undo capture, or the scan engine.

**Tech Stack:** TypeScript (Node, ESM), zod v4 schemas, Node built-in test runner, jsdiff (`parsePatch`/`applyPatch`).

**Spec:** This plan's **Findings** section below. The audit lives in conversation, so it is embedded here and the plan argues from it.

## Findings (spec)

Verified against source on 2026-11-05. Items the audit cleared as intended are NOT in scope.

1. **Schemas promise prompts a client may not show.** `create.overwrite` says "prompts for confirmation"; `delete.recursive` says "required for non-empty directories". A client without the elicitation form capability gets `INVALID_INPUT` + a workaround instead (`src/core/input-required.ts:301-311`). Both "fail" rows in the report came from this.
2. **`search_text` text omits the match count.** `pageTrailer` totals only when paging or truncation (`src/core/fmt.ts:183`), so a single page holding all matches carries no count. `replace_text` prints one.
3. **`replace_text` hides changed file names.** On a live run without `returnDiff` and without an early stop, the text carries totals only; per-file results sit under `_meta`, which clients do not show (`src/tools/replace-text.ts:519-555`).
4. **Stale patch error names no hunk.** jsdiff returns only `false` (`src/tools/patch.ts:186-192`); the error cannot say which hunk or line.
5. **`undo` dry run and skip wording.** A bare dry run previews each step as if every newer call were reverted first (`src/tools/undo.ts:148-150`); that is correct, but the schema says only "Preview which calls would restore". Also, the roster prints `SKIPPED` while the reason line prints `CANCELLED` for the same skip (`src/tools/undo.ts:179`, `:76-85`).
6. **Windows creation-time reset undocumented.** Writes are atomic temp+rename (`src/core/fs.ts:761-786`); on Windows that mints a new inode, so `stat.created` becomes the write time after any edit. Nothing model-facing says so.
7. **Case defaults diverge without cross-warning.** `search_text` defaults case-insensitive, `replace_text` case-sensitive; deliberate (`CHANGELOG.md:124`), but each field description leaves the other tool's default unstated.

## Global Constraints

- Test runner: Node built-in. One file: `npm test -- __tests__/<file>.test.ts`; pattern: `npm test -- --test-name-pattern="<pattern>"`.
- Contract snapshots: any schema-description edit changes `__tests__/contract.test.ts.snapshot`. After the edit, with **no `FS_*` environment variables set**, run `node --test --test-update-snapshots __tests__/contract.test.ts`, then `npm test -- __tests__/contract.test.ts`, and commit the `.snapshot` diff with the change.
- Never edit `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`: the Release workflow owns versions. Do not edit `CHANGELOG.md`; it is stamped at release.
- No new dependencies. `diff` (jsdiff) and `zod/v4` are already imported where needed.
- Every commit message ends with: `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Branch off `main` first (worktree per superpowers:using-git-worktrees at execution time); commit after each task.
- `npm run check` must pass at the end; `npm run fix` first if it does not.
- After the last code change: `graphify update .`. A large whole-graph diff is expected; do not trim it.
- Windows host: PowerShell; pass `C:/...` paths to node.

## Review Focus

Input classes no task's happy path covers, each pinned by the named test:

1. **Contract snapshot drift:** any description edit without the snapshot update fails `contract.test.ts`. Pinned by the snapshot steps in Tasks 1, 2, 3, 7.
2. **Paged `search_text` duplication:** when the pager already totals, the new count line must not appear too. Pinned by Task 4's paged test.
3. **Zero-match `search_text`:** no count line beside "No matches". Pinned by Task 4's zero test.
4. **`replace_text` early-stop warning:** the existing "were already rewritten" line must survive verbatim. Pinned by keeping `replace-text.test.ts:1292` green in Task 5.
5. **Patch diagnosis cost:** a diff whose line-product times hunk count exceeds the guard keeps the generic refusal. Pinned by Task 6's over-budget test.

---

### Task 1: No-prompt fallback wording in `create` and `delete`

**Files:**

- Modify: `src/tools/create.ts:43-48`
- Modify: `src/tools/delete.ts:35-37`
- Modify: `__tests__/contract.test.ts.snapshot` (via update command)

**Interfaces:**

- Consumes: none.
- Produces: none.

- [ ] **Step 1: Run the contract test to see the current pin**

Run: `npm test -- __tests__/contract.test.ts`
Expected: PASS (baseline).

- [ ] **Step 2: Edit the two descriptions**

`src/tools/create.ts`, the `overwrite` field's `.describe(...)` becomes exactly:

```
Replace an existing file without asking the user; without it an existing file prompts for confirmation. A client that cannot show a prompt fails with INVALID_INPUT and a workaround instead.
```

`src/tools/delete.ts`, the `recursive` `defaultFalseBoolean(...)` string becomes exactly:

```
Delete directory contents recursively (required for non-empty directories). Deleting a non-empty directory asks the user to confirm; a client that cannot show a prompt fails with INVALID_INPUT and nothing in the call is deleted.
```

- [ ] **Step 3: Run the contract test to verify it fails on the snapshot**

Run: `npm test -- __tests__/contract.test.ts`
Expected: FAIL: snapshot mismatch naming the two descriptions.

- [ ] **Step 4: Update the snapshot and verify**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts` (no `FS_*` variables set), then `npm test -- __tests__/contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/create.ts src/tools/delete.ts __tests__/contract.test.ts.snapshot
git commit -m "docs(tools): state the no-prompt fallback for create and delete

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: Cross-warn the case defaults

**Files:**

- Modify: `src/tools/search-text.ts:49`
- Modify: `src/tools/replace-text.ts:79-82`
- Modify: `__tests__/contract.test.ts.snapshot` (via update command)

**Interfaces:**

- Consumes: none.
- Produces: none.

- [ ] **Step 1: Edit the two descriptions**

`src/tools/search-text.ts`, `caseSensitive` string becomes exactly:

```
Enable case-sensitive matching (default: case-insensitive). replace_text matches case by default, so matches found here can go unreplaced there.
```

`src/tools/replace-text.ts`, `caseSensitive` `.describe(...)` becomes exactly:

```
Match case exactly (default: true). Pass false to ignore case. search_text ignores case by default, so matches it reports can include case variants this call does not replace.
```

- [ ] **Step 2: Update the snapshot and verify**

Run: `npm test -- __tests__/contract.test.ts` (expected: FAIL on snapshot). Then `node --test --test-update-snapshots __tests__/contract.test.ts` and `npm test -- __tests__/contract.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tools/search-text.ts src/tools/replace-text.ts __tests__/contract.test.ts.snapshot
git commit -m "docs(tools): cross-reference search_text and replace_text case defaults

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: `undo` preview wording and one skip word

**Files:**

- Modify: `src/tools/undo.ts:25` (schema)
- Modify: `src/tools/undo.ts:76-85` (`reasonLines`)
- Test: `__tests__/undo.test.ts`
- Modify: `__tests__/contract.test.ts.snapshot` (via update command)

**Interfaces:**

- Consumes: `ErrorCode` (already imported in `src/tools/undo.ts`).
- Produces: none.

- [ ] **Step 1: Write the failing tests in `__tests__/undo.test.ts`**

Two tests, following the file's existing fixtures (a write recorded, then the file modified before the undo, produces a `CANCELLED` skip; a failing op produces a `FAILED` row):

- `reason line prints SKIPPED for a cancelled restore`: after a skipped restore, `assert.match(undone.text ?? '', /: SKIPPED Not restored/u)`.
- `reason line keeps the code for a failed restore`: after a `FAILED` row, `assert.match(undone.text ?? '', /: UNKNOWN /u)`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- __tests__/undo.test.ts`
Expected: FAIL: first test finds `CANCELLED` where `SKIPPED` is asserted.

- [ ] **Step 3: Implement**

In `reasonLines` (`src/tools/undo.ts:76-85`), render a `CANCELLED` code as `SKIPPED`, every other code verbatim:

```ts
const lines = results.flatMap((r) =>
  'error' in r
    ? [
        `// ${r.path}: ${r.error.code === ErrorCode.CANCELLED ? 'SKIPPED' : r.error.code} ${r.error.message}`,
      ]
    : [],
);
```

In the schema (`src/tools/undo.ts:25`), the `dryRun` description becomes exactly:

```
Preview which calls would restore, changing nothing. The preview assumes every newer call is reverted first, so a file changed since can still show as restored.
```

- [ ] **Step 4: Run the undo tests to verify they pass**

Run: `npm test -- __tests__/undo.test.ts`
Expected: PASS (including the pre-existing `ty.txt SKIPPED` and `would revert ... [dry run]` assertions).

- [ ] **Step 5: Update the snapshot and verify**

Run: `npm test -- __tests__/contract.test.ts` (expected: FAIL on snapshot). Then `node --test --test-update-snapshots __tests__/contract.test.ts` and `npm test -- __tests__/contract.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/undo.ts __tests__/undo.test.ts __tests__/contract.test.ts.snapshot
git commit -m "fix(undo): say the preview assumes newer reverts and align skip wording

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 4: `search_text` prints the match count

**Files:**

- Modify: `src/tools/search-text.ts:270-309`
- Test: `__tests__/search-text.test.ts`

**Interfaces:**

- Consumes: `buildSearchMatchDetail` (`src/tools/search-text.ts:136`), `paged.offset`, `paged.metadata.matchingLines`, `paged.metadata.filesMatched`.
- Produces: none.

- [ ] **Step 1: Write the failing tests in `__tests__/search-text.test.ts`**

Using the file's existing `runSearch` helper (root with 2 files, 3 matching lines total):

- `prints the match count when one page holds every match`: default `maxResults`; `assert.match(text, /\/\/ 3 matches · 2 files/u)`.
- `leaves the count to the pager when matches span pages`: `maxResults` below the total; `assert.doesNotMatch(text, /\/\/ \d+ matches/u)` and `assert.match(text, /showing 1-/u)`.
- `no count line on zero matches`: `assert.match(text, /No matches/u)` and `assert.doesNotMatch(text, /matches ·/u)`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- __tests__/search-text.test.ts`
Expected: FAIL: first test, no count line in text.

- [ ] **Step 3: Implement in `run`'s text assembly (`src/tools/search-text.ts:294-309`)**

One count line, only when this page holds every match (the pager's trailer totals every other case), reusing `buildSearchMatchDetail`:

```ts
const countLine =
  paged.metadata.matchingLines > 0 && paged.offset === 0 && structured.matches.length === paged.metadata.matchingLines
    ? `\n\n// ${buildSearchMatchDetail(paged.metadata.matchingLines, paged.metadata.filesMatched ?? 0)}`
    : '';
const text = body + countLine + pageTrailer({ ... });
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- __tests__/search-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/search-text.ts __tests__/search-text.test.ts
git commit -m "fix(search): print the match count in search_text text

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 5: `replace_text` names the changed files

**Files:**

- Modify: `src/tools/replace-text.ts:538-555`
- Test: `__tests__/replace-text.test.ts`

**Interfaces:**

- Consumes: `structured.results` (root-relative paths), `structured.summary.succeeded`.
- Produces: none.

- [ ] **Step 1: Write the failing test in `__tests__/replace-text.test.ts`**

`names the changed files on a live run without returnDiff`: two files changed, no `dryRun`, no `returnDiff`, no cap; `assert.match(text, /\/\/ changed: a\.txt, b\.txt/u)`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- __tests__/replace-text.test.ts`
Expected: FAIL: no changed-file line in text.

- [ ] **Step 3: Implement in `run`'s line assembly**

Add, right after the existing early-stop block (`src/tools/replace-text.ts:538-552`), a line for exactly the gap case: a live run where nothing else names the files (the stop warning names them; `dryRun` and `returnDiff` ship the diff):

```ts
if (stop === undefined && !args.dryRun && !args.returnDiff && structured.summary.succeeded > 0) {
  const total = structured.summary.succeeded;
  const shown = structured.results
    .filter((x) => !('error' in x))
    .slice(0, 5)
    .map((x) => x.path)
    .join(', ');
  const more = total > 5 ? `, and ${String(total - 5)} more` : '';
  lines.push(`// changed: ${shown}${more}`);
}
```

- [ ] **Step 4: Run the file's tests to verify they pass**

Run: `npm test -- __tests__/replace-text.test.ts`
Expected: PASS, including the early-stop test at `:1292` (`file(s) were already rewritten and stay changed`), which must stay green untouched.

- [ ] **Step 5: Commit**

```bash
git add src/tools/replace-text.ts __tests__/replace-text.test.ts
git commit -m "fix(replace): name the changed files in replace_text text

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 6: `patch` names the failing hunk

**Files:**

- Modify: `src/tools/patch.ts:184-193`
- Test: `__tests__/patch.test.ts`

**Interfaces:**

- Consumes: `applyPatch`, `parsedPatch`, the clamped `hunks`, `fileLines`, `diffLines` (all in `patchContent`), `MAX_PATCH_LINE_PRODUCT`.
- Produces: none.

- [ ] **Step 1: Write the failing tests in `__tests__/patch.test.ts`**

- `names the failing hunk`: a two-hunk diff against a file where hunk 1 applies and hunk 2's context is stale; `fsErrorMatcher(ErrorCode.INVALID_INPUT, /did not apply cleanly: hunk 2 \(starting at line /)`.
- `keeps the generic refusal when the diagnosis is over budget`: a 10,000-line file, two hunks of about 500 diff lines each (line product times hunk count over `MAX_PATCH_LINE_PRODUCT`), second stale; message matches `/did not apply cleanly: hunk context/` and `assert.doesNotMatch(message, /hunk 2/)`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- __tests__/patch.test.ts`
Expected: FAIL: first test, message has no hunk number.

- [ ] **Step 3: Implement in `patchContent` (`src/tools/patch.ts:186-192`)**

On `patched === false`, diagnose only within one apply's budget (each prefix re-runs jsdiff's matcher, so cost scales with hunk count times the guarded line product):

```ts
if (patched === false) {
  const first =
    hunks.length > 0 && fileLines * diffLines * hunks.length <= MAX_PATCH_LINE_PRODUCT
      ? hunks.findIndex(
          (_, i) => applyPatch(content, { ...parsedPatch, hunks: hunks.slice(0, i + 1) }) === false,
        )
      : -1;
  const where =
    first >= 0
      ? `hunk ${String(first + 1)} (starting at line ${String(hunks[first]?.oldStart)}) does not match file content`
      : 'hunk context does not match file content';
  throw new FsError(
    ErrorCode.INVALID_INPUT,
    `patch did not apply cleanly: ${where} (hunks must be in file order)`,
    args.path,
  );
}
```

`findIndex` cannot miss: the full clamped set is the last prefix and already returned `false`. `oldStart` is the clamped start.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- __tests__/patch.test.ts` and `npm test -- __tests__/tools.test.ts`
Expected: PASS. The existing `/did not apply cleanly/` assertions (`patch.test.ts:59`, `tools.test.ts:534`) keep matching the shared prefix.

- [ ] **Step 5: Commit**

```bash
git add src/tools/patch.ts __tests__/patch.test.ts
git commit -m "fix(patch): name the stale hunk when a patch does not apply

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 7: `stat` notes the Windows creation-time reset

**Files:**

- Modify: `src/tools/stat.ts:172-175`
- Modify: `__tests__/contract.test.ts.snapshot` (via update command)

**Interfaces:**

- Consumes: none.
- Produces: none.

- [ ] **Step 1: Extend the `STAT` description**

Append one sentence to the description (`src/tools/stat.ts:172-175`), keeping the existing text; the full description ends with exactly:

```
... each missing path gets its own NOT_FOUND entry. created is the filesystem creation time; on Windows an edit, patch or replace writes a new file atomically, so created becomes that write's time, while modified keeps tracking edits.
```

- [ ] **Step 2: Update the snapshot and verify**

Run: `npm test -- __tests__/contract.test.ts` (expected: FAIL on snapshot). Then `node --test --test-update-snapshots __tests__/contract.test.ts` and `npm test -- __tests__/contract.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tools/stat.ts __tests__/contract.test.ts.snapshot
git commit -m "docs(stat): note the Windows creation-time reset on writes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 8: Full check and graph refresh

**Files:**

- Modify: `graphify-out/` (via `graphify update .`)

**Interfaces:**

- Consumes: all prior tasks.
- Produces: a green full check.

- [ ] **Step 1: Run the full check**

Run: `npm run check`
Expected: PASS (static + all tests, including contract). If format or lint fails: `npm run fix`, then `npm run check` again.

- [ ] **Step 2: Refresh the knowledge graph**

Run: `graphify update .`
Expected: completes; a large whole-file diff to `graphify-out/graph.json` is expected.

- [ ] **Step 3: Commit**

```bash
git add graphify-out
git commit -m "chore: refresh graphify graph after report gap fixes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review

1. **Spec coverage:** Findings 1→Task 1, 7→Task 2, 5→Task 3, 2→Task 4, 3→Task 5, 4→Task 6, 6→Task 7. All seven covered; no extra scope.
2. **Step scan:** Each code step pins the exact string, signature, or condition; bodies appear only where the tests do not determine them (`reasonLines` one-liner, count line, names line, patch diagnosis loop). Copy tasks have no body to write.
3. **Type consistency:** `buildSearchMatchDetail(total: number, filesMatched: number): string`; `paged.offset: number`, `paged.metadata.matchingLines: number`, `paged.metadata.filesMatched: number | undefined`; `hunks[first]?.oldStart: number`; `fsErrorMatcher` used as in `patch.test.ts:59`. Checked.
4. **Review Focus:** all five lines have owning-task tests (1→Tasks 1, 2, 3, 7 snapshot steps; 2 and 3→Task 4; 4→Task 5 Step 4; 5→Task 6 over-budget test).
5. **Proportion:** 8 tasks, each one commit; the plan is shorter than the code it describes would be if transcribed.
