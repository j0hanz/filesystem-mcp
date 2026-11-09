# TDQS low-score description refinements implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the six lowest-scoring tool descriptions by documenting verified parameter interactions, partial failures, and exact result shapes without changing runtime behavior.

**Architecture:** Change only six `description` strings and their generated contract snapshot. Preserve the no-output-schema design, read-only isolation, tool names, and sibling routing. Existing tool tests verify the described behavior; surface tests guard the advertised MCP contract and payload budget.

**Tech Stack:** TypeScript on Node 24+ with native type stripping, Zod 4, Node's built-in test runner, MCP SDK `@modelcontextprotocol/server`.

**Spec:** `docs/superpowers/specs/2026-11-09-tdqs-low-score-descriptions-design.md` and `report.md` (TDQS report `leux2p2ef5`).

## Global Constraints

- Change no runtime logic, input schema, annotation, tool name, dependency, or release-managed version.
- Never add `outputSchema`; `TOOL-SURFACE-001` requires it to remain absent.
- Read-only descriptions must not name mutating tools; `TOOL-SURFACE-003` enforces this.
- Use the exact description copy below. Do not add generic prose or repeat defaults already carried by the schema.
- Regenerate snapshots with no `FS_*` variables set. Do not hand-edit the snapshot.
- Any budget raise gets a dated comment with measured full and read-only sizes.
- Do not run `npm run tdqs`: hosted scoring spends one daily call.
- After code changes, run `graphify update .`; a whole-file graph diff is expected.

## Review Focus

1. **False result-shape claims:** callers could parse nonexistent fields. Run the six affected tool test files in Task 1, Step 6.
2. **Read-only contamination:** `diff`, `find_files`, or `stat` naming a write tool breaks `--read-only` guidance. Run `TOOL-SURFACE-003` in Task 1, Step 6.
3. **Accidental output-schema publication:** this changes client result requirements. Run `TOOL-SURFACE-001` in Task 1, Step 6.
4. **Session-start payload growth:** expanded descriptions can exceed the wire budget. Calibrate `TOOL-SURFACE-002` in Task 1, Step 7.
5. **Full/read-only snapshot drift:** stale snapshots hide an unintended wire change. Regenerate and rerun both contract tests in Task 1, Steps 4–5.

---

### Task 1: Refine six low-scoring descriptions

**Files:**

- Modify: `src/tools/create.ts:132-136`
- Modify: `src/tools/diff.ts:29-33`
- Modify: `src/tools/move.ts:395-400`
- Modify: `src/tools/patch.ts:64-69`
- Modify: `src/tools/find-files.ts:94-99`
- Modify: `src/tools/stat.ts:170-175`
- Modify: `__tests__/contract.test.ts.snapshot` (generated only)
- Modify if measured over budget: `__tests__/tools.test.ts:1042-1088`
- Test: `__tests__/contract.test.ts`, `__tests__/tools.test.ts`, and the six affected tool test files

**Interfaces:**

- Consumes: existing `CREATE`, `DIFF`, `MOVE`, `PATCH`, `FIND_FILES`, and `STAT` definitions and their unchanged runtimes.
- Produces: unchanged tool names and schemas; only advertised description text changes.

- [ ] **Step 1: Establish the baseline**

Run:

```powershell
node --test --test-timeout=60000 __tests__/contract.test.ts
node --test --test-timeout=60000 --test-name-pattern="TOOL-SURFACE" __tests__/tools.test.ts
```

Expected: PASS. If either fails before edits, stop and diagnose the existing failure.

- [ ] **Step 2: Replace the six descriptions with the approved copy**

`src/tools/create.ts`:

```ts
  description:
    'Write whole text files (create, overwrite, or append) or make empty directories. ' +
    'Use when creating new files, replacing full contents, or creating folders. ' +
    'Missing parent directories are created automatically. Replacing an existing file requires overwrite: true or user confirmation. ' +
    'Each file and the whole batch share the FS_MAX_FILE_SIZE UTF-8 byte limit. ' +
    'Returns { files, directories?, failures?, skipped? } and an undo id for undo; one failed entry does not roll back the rest. ' +
    'Use edit or patch to modify parts of an existing file.',
```

`src/tools/diff.ts`:

```ts
  description:
    'Compare two text files and return a unified diff from a to b, like diff -u. ' +
    'Use when reviewing changes between two files. ' +
    'The diff has ---/+++ headers and @@ hunks; - lines are from a and + lines from b. context changes only the surrounding lines. ' +
    'Metadata includes resolved a and b paths, linesAdded, and linesRemoved; identical files return no hunks. ' +
    'Rejects binary and non-UTF-8 files; files too different give TOO_LARGE. Use read to inspect full files or slices first.',
```

`src/tools/move.ts`:

```ts
  description:
    'Move, rename, or copy files and directories, like mv or cp -r. ' +
    'Use when renaming paths, moving files between directories, or copying trees (copy: true). ' +
    'Each moves entry is { source, destination }; destination is the full target path, not a directory to move into. ' +
    'copy: true leaves sources in place. overwrite applies only to copies; moving onto an existing file requires confirmation. ' +
    'Returns { moves: [{ from, to }], failures?, skipped? } and an undo id for undo; one failed pair does not roll back completed transfers. ' +
    'Use delete to remove paths.',
```

`src/tools/patch.ts`:

```ts
  description:
    'Apply a single-file unified diff to an existing text file, like git apply. ' +
    'Use when applying diffs produced by diff tools or git. ' +
    'path selects the target; the ---/+++ names in diff are ignored. Empty or multi-file diffs fail with INVALID_INPUT. ' +
    'Writes nothing unless every hunk applies in order with exact context; mismatched hunks fail and leave the file untouched. ' +
    'Returns path, linesAdded, linesRemoved, and an undo id for undo. dryRun adds the preview diff and writes nothing. ' +
    'Use edit for unique snippet replacements, and replace_text for regex across files.',
```

`src/tools/find-files.ts`:

```ts
  description:
    'Find files by name or glob pattern, like find. ' +
    'Use when locating files by name or pattern anywhere in the workspace. ' +
    'A pattern without / matches names at any depth (*.ts); a pattern with / matches paths relative to path (src/**/*.ts). ' +
    'maxDepth is relative to path: 0 searches only that directory; omit it for unlimited depth. Hidden and ignored files are skipped by default. ' +
    'Returns { root, results: [{ path }], totalMatches, filesScanned, nextCursor?, stoppedReason? }. Result paths are relative to root when safe, absolute otherwise. stoppedReason reports maxResults or timeout truncation. ' +
    'Use list to browse directory trees, and search_text to search file contents.',
```

`src/tools/stat.ts`:

```ts
  description:
    'Get metadata without reading file contents, like ls -ld. ' +
    'Use when checking file existence, size, type, or timestamps. ' +
    'Both path and paths return { results, summary }, with value or error for each path. Missing paths get NOT_FOUND; one failure does not fail a batch, but an all-failed batch sets isError. ' +
    'Symlinks return their own metadata and symlinkTarget after path validation. ' +
    'Returns name, path, type, timestamps, and isHidden; files add size and tokenEstimate, directories entryCount. ' +
    'mimeType comes from the extension. Windows returns readOnly instead of POSIX permissions. Use read to view contents, and list to browse directories.',
```

- [ ] **Step 3: Confirm the contract test detects the edits**

Run:

```powershell
node --test --test-timeout=60000 __tests__/contract.test.ts
```

Expected: FAIL in `CONTRACT-001` and `CONTRACT-002` on changed descriptions. An unrelated failure means the edit touched more than the approved copy.

- [ ] **Step 4: Regenerate the contract snapshot**

With no `FS_*` environment variables set, run:

```powershell
node --test --test-update-snapshots __tests__/contract.test.ts
```

Expected: PASS and an updated `__tests__/contract.test.ts.snapshot`. Review the snapshot diff: six full-surface descriptions and the three read-only descriptions (`diff`, `find_files`, `stat`) change; schemas and annotations do not.

- [ ] **Step 5: Format and verify the contract**

Run:

```powershell
npx prettier --write src/tools/create.ts src/tools/diff.ts src/tools/move.ts src/tools/patch.ts src/tools/find-files.ts src/tools/stat.ts docs/superpowers/specs/2026-11-09-tdqs-low-score-descriptions-design.md docs/superpowers/plans/2026-11-09-tdqs-low-score-descriptions.md
node --test --test-timeout=60000 __tests__/contract.test.ts
```

Expected: formatting stable; both contract tests PASS.

- [ ] **Step 6: Verify described behavior and surface guards**

Run:

```powershell
node --test --test-timeout=60000 __tests__/create.test.ts __tests__/diff.test.ts __tests__/move.test.ts __tests__/patch.test.ts __tests__/find-files.test.ts __tests__/stat.test.ts
node --test --test-timeout=60000 --test-name-pattern="TOOL-SURFACE-001|TOOL-SURFACE-003" __tests__/tools.test.ts
```

Expected: PASS. Symlink tests may skip when Windows lacks permission; all other tests must pass.

- [ ] **Step 7: Measure and, only if needed, adjust the payload budget**

Run:

```powershell
node --test --test-timeout=60000 --test-name-pattern="TOOL-SURFACE-002" __tests__/tools.test.ts
```

Expected: PASS, or FAIL with the measured size. If over budget, raise only the exceeded constant to the next 50-character boundary. Add a dated comment explaining this TDQS pass and recording measured full/read-only sizes; rerun until both measurements pass. Do not lower an existing budget in this task.

- [ ] **Step 8: Commit the description change**

```powershell
git add src/tools/create.ts src/tools/diff.ts src/tools/move.ts src/tools/patch.ts src/tools/find-files.ts src/tools/stat.ts __tests__/contract.test.ts.snapshot __tests__/tools.test.ts docs/superpowers/specs/2026-11-09-tdqs-low-score-descriptions-design.md docs/superpowers/plans/2026-11-09-tdqs-low-score-descriptions.md
git commit -m "docs(tools): close remaining TDQS description gaps" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

Expected: one commit containing only the six descriptions, generated snapshots, any measured budget change, and these planning documents.

### Task 2: Run repository verification and refresh the graph

**Files:**

- Modify: `graphify-out/graph.json` and other generated graph outputs, only through `graphify update .`
- Test: full repository check

**Interfaces:**

- Consumes: Task 1's committed description and snapshot changes.
- Produces: verified working tree and current knowledge graph; no new tool behavior.

- [ ] **Step 1: Run the full repository check**

Run:

```powershell
npm run check
```

Expected: PASS, including static checks, tests, and the dist smoke test after the check's build. Do not claim completion from the targeted tests alone.

- [ ] **Step 2: Refresh the knowledge graph**

Run:

```powershell
graphify update .
```

Expected: PASS with the six changed TypeScript files re-extracted. A large whole-file `graphify-out/graph.json` diff is expected and must not be flagged as churn.

- [ ] **Step 3: Inspect and commit generated graph changes**

Run:

```powershell
git status --short
git diff --stat
```

Expected: only intended generated graph outputs remain outside Task 1's commit; the user's pre-existing untracked `report.md` remains untouched and uncommitted. If graph outputs changed, commit them separately:

```powershell
git add graphify-out
git commit -m "chore: refresh knowledge graph" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

Expected: no source or snapshot changes in this commit. Do not run hosted TDQS; report that a new score remains unmeasured until the owner runs `npm run tdqs`.
