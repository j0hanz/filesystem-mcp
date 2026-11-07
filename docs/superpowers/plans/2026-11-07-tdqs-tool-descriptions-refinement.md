# TDQS tool descriptions refinement implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine all 14 tool descriptions in filesystem-mcp to raise TDQS scores from 4.4 to 4.8+ with direct, front-loaded explanations ("Use when..."), concise parameters, clear return shapes, and complete cross-tool disambiguation, without verbosity or robotic over-compression.

**Architecture:** Only tool `description` strings in `src/tools/*.ts` and tests/snapshots change. All changes preserve closed-world annotations, zero-outputSchema design (TOOL-SURFACE-001), and read-only isolation (TOOL-SURFACE-003: no read-only tool may name any write tool). The character budget in `__tests__/tools.test.ts` (TOOL-SURFACE-002) is updated with a dated comment and measured sizes once all descriptions are in place.

**Tech Stack:** TypeScript on Node 26 (type stripping), Node built-in test runner (`node:test`, `node:assert/strict`), MCP SDK `@modelcontextprotocol/server`.

**Spec:** `report.md` (TDQS evaluation report), `docs/superpowers/plans/2026-10-23-tdqs-tier2-descriptions.md` and `docs/superpowers/plans/2026-11-05-report-gap-fixes.md` (architectural precedents).

## Global constraints

- Never hand-edit versions in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, or `.cursor-plugin/plugin.json`.
- TOOL-SURFACE-001: No tool publishes an `outputSchema`. Tools that return text place metadata under `_meta`; data tools return `structuredContent`.
- TOOL-SURFACE-003: No read-only tool (`diff`, `find_files`, `list`, `list_roots`, `read`, `search_text`, `stat`) may name any mutating tool (`create`, `delete`, `edit`, `move`, `patch`, `replace_text`, `undo`) in its description.
- TOOL-SURFACE-002: Any budget adjustment in `__tests__/tools.test.ts` gets a dated comment with measured `full` and `read-only` sizes.
- Contract snapshots: Whenever tool descriptions change, update snapshots with `node --test --test-update-snapshots __tests__/contract.test.ts` with no `FS_*` variables set, and commit `.snapshot` diffs.
- Windows host: Use PowerShell. When running Node/npm commands that access `C:\Program Files\nodejs\node.exe`, execute outside the sandbox or using standard paths.
- Commits use Conventional Commits with scope `tools` (`docs(tools): ...` or `refactor(tools): ...`).
- After code modifications are complete, run `graphify update .` to keep knowledge graph up to date.

## Review focus

1. **Read-only description contamination (TOOL-SURFACE-003):** An edit to a read-only tool (`diff`, `find_files`, `list`, `list_roots`, `read`, `search_text`, `stat`) that mentions a write tool (`create`, `delete`, `edit`, `move`, `patch`, `replace_text`, `undo`) must fail `TOOL-SURFACE-003` in `__tests__/tools.test.ts`. Pinned by tests in Tasks 1 and 2.
2. **Session-start payload budget calibration (TOOL-SURFACE-002):** Expanding descriptions to natural human prose must be accounted for by updating `BUDGET_CHARS` (full) and `BUDGET_CHARS_READ_ONLY` (read-only) in `__tests__/tools.test.ts`. Pinned by calibration in Task 5.
3. **Contract snapshot drift:** Description edits without updating `contract.test.ts.snapshot` must fail `contract.test.ts`. Pinned by snapshot regeneration steps in Tasks 1, 2, 3, 4, 5.
4. **Accuracy of return format claims:** Descriptions must accurately reflect actual runtime return format (e.g., `diff` unified diff string + metadata, `list` tree format + pagination, `patch` hunk result, `create` created/skipped paths, `move` moved paths + undo id, `stat` metadata fields).
5. **Accuracy of error code references:** Error codes named in descriptions (`NOT_FOUND`, `INVALID_INPUT`, `TOO_LARGE`, `NOT_DIRECTORY`, `NOT_FILE`, `ACCESS_DENIED`) must accurately match what `FsError` throws in `src/core/errors.ts` and tool implementations.

---

### Task 1: Refine read-only query and discovery tool descriptions (`diff`, `find_files`, `list`, `list_roots`)

**Files:**

- Modify: `src/tools/diff.ts:29-31`
- Modify: `src/tools/find-files.ts:94-97`
- Modify: `src/tools/list.ts:343-347`
- Modify: `src/tools/list-roots.ts:18-22`
- Modify: `__tests__/contract.test.ts.snapshot` (via snapshot update)
- Test: `__tests__/contract.test.ts`, `__tests__/tools.test.ts`

**Interfaces:**

- Consumes: `DIFF`, `FIND_FILES`, `LIST`, `LIST_ROOTS` tool definitions in `src/tools/`.
- Produces: Updated description strings for 4 read-only tools adhering strictly to TOOL-SURFACE-003.

- [ ] **Step 1: Run baseline contract and surface tests**

Run: `node --test __tests__/contract.test.ts`
Expected: PASS

Run: `node --test __tests__/tools.test.ts --test-name-pattern="TOOL-SURFACE"`
Expected: PASS

- [ ] **Step 2: Update descriptions in `diff.ts`, `find-files.ts`, `list.ts`, `list-roots.ts`**

In `src/tools/diff.ts` (lines 29-31), replace description with:

```ts
  description:
    'Compare two text files and return a unified diff from a to b, like diff -u. ' +
    'Use when reviewing changes between two files. ' +
    'Returns the unified diff with linesAdded and linesRemoved in metadata; identical files return no hunks. ' +
    'Rejects binary files and paths outside allowed roots. Use read to inspect full files or slices first.',
```

In `src/tools/find-files.ts` (lines 94-97), replace description with:

```ts
  description:
    'Find files by name or glob pattern, like find. ' +
    'Use when locating files by name or pattern anywhere in the workspace. ' +
    'A pattern without / matches names at any depth (*.ts); a pattern with / matches relative paths (src/**/*.ts). ' +
    'Skips hidden and ignored files by default. Returns matching paths and a nextCursor for paging. ' +
    'Use list to browse directory trees, and search_text to search file contents.',
```

In `src/tools/list.ts` (lines 343-347), replace description with:

```ts
  description:
    'List directory contents as a tree of names, like ls or tree. ' +
    'Use when exploring directory structure or checking folder contents. ' +
    'Traversal is one level deep unless maxDepth is raised. Skips hidden and ignored files (.git, node_modules) by default. ' +
    'sortBy: size orders largest first. Returns formatted tree text with nextCursor when paged. ' +
    'Use find_files to find files by name, stat for metadata, and read for contents.',
```

In `src/tools/list-roots.ts` (lines 18-22), replace description with:

```ts
  description:
    'List the workspace directory roots this server can access, including session-granted roots. ' +
    'Use when starting a session or checking accessible directory boundaries. ' +
    'Returns { roots, readOnlyDirs } as absolute paths. Mutating operations under readOnlyDirs are refused with ACCESS_DENIED. ' +
    'Other tools prompt for approval when accessing paths outside these roots.',
```

- [ ] **Step 3: Update contract snapshots and verify tests**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`
Expected: Snapshot updated.

Run: `node --test __tests__/contract.test.ts`
Expected: PASS

Run: `node --test __tests__/tools.test.ts --test-name-pattern="TOOL-SURFACE-003"`
Expected: PASS (verifies no write tools named in read-only tools).

- [ ] **Step 4: Commit Task 1 changes**

```bash
git add src/tools/diff.ts src/tools/find-files.ts src/tools/list.ts src/tools/list-roots.ts __tests__/contract.test.ts.snapshot
git commit -m "docs(tools): refine diff, find-files, list, and list-roots descriptions for TDQS

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Refine read-only inspection and content tool descriptions (`read`, `search_text`, `stat`)

**Files:**

- Modify: `src/tools/read.ts:514-519`
- Modify: `src/tools/search-text.ts:196-200`
- Modify: `src/tools/stat.ts:170-174`
- Modify: `__tests__/contract.test.ts.snapshot` (via snapshot update)
- Test: `__tests__/contract.test.ts`, `__tests__/tools.test.ts`

**Interfaces:**

- Consumes: `READ`, `SEARCH_TEXT`, `STAT` tool definitions in `src/tools/`.
- Produces: Refined description strings for remaining 3 read-only tools adhering strictly to TOOL-SURFACE-003.

- [ ] **Step 1: Update descriptions in `read.ts`, `search-text.ts`, `stat.ts`**

In `src/tools/read.ts` (lines 514-519), replace description with:

```ts
  description:
    'Read text files, like cat: whole file or a slice via head, tail, or 1-based startLine/endLine. ' +
    'Use when inspecting file contents. Pass binary: true to read binary files as base64 resources (slicing disabled). ' +
    'Images and audio return as media. Returns file text or slice, or per-path results for batches. ' +
    'Use stat for size and token estimates before reading, search_text to find text, and list to browse folders.',
```

In `src/tools/search-text.ts` (lines 196-200), replace description with:

```ts
  description:
    'Search file contents for text or an RE2 regex, like grep. ' +
    'Use when searching for keywords or patterns across files. ' +
    'searchPattern matches line by line (case-insensitive by default); pattern filters files by glob (e.g. **/*.ts). ' +
    'Returns matching lines with line numbers grouped by file, plus a nextCursor for paging. ' +
    'Use read to view full context, and find_files to find by name.',
```

In `src/tools/stat.ts` (lines 170-174), replace description with:

```ts
  description:
    'Get metadata without reading file contents, like ls -ld. ' +
    'Use when checking file existence, size, type, or timestamps. ' +
    'Missing paths get their own NOT_FOUND entry, so batches succeed even if some paths are missing. ' +
    'Symlinks return link targets without following. Returns type, size/entryCount, tokenEstimate, timestamps, permissions, and mimeType. ' +
    'Use read to view contents, and list to browse directories.',
```

- [ ] **Step 2: Update contract snapshots and verify tests**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`
Expected: Snapshot updated.

Run: `node --test __tests__/contract.test.ts`
Expected: PASS

Run: `node --test __tests__/tools.test.ts --test-name-pattern="TOOL-SURFACE-003"`
Expected: PASS (strict verification that `read`, `search_text`, and `stat` do not name any write tools).

- [ ] **Step 3: Commit Task 2 changes**

```bash
git add src/tools/read.ts src/tools/search-text.ts src/tools/stat.ts __tests__/contract.test.ts.snapshot
git commit -m "docs(tools): refine read, search-text, and stat descriptions for TDQS

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Refine mutating text tool descriptions (`create`, `edit`, `patch`, `replace_text`)

**Files:**

- Modify: `src/tools/create.ts:132-135`
- Modify: `src/tools/edit.ts:699-703`
- Modify: `src/tools/patch.ts:64-68`
- Modify: `src/tools/replace-text.ts:524-529`
- Modify: `__tests__/contract.test.ts.snapshot` (via snapshot update)
- Test: `__tests__/contract.test.ts`, `__tests__/tools.test.ts`

**Interfaces:**

- Consumes: Mutating text tool definitions in `src/tools/`.
- Produces: Coherent, disambiguated descriptions for `create`, `edit`, `patch`, and `replace_text`.

- [ ] **Step 1: Update descriptions in `create.ts`, `edit.ts`, `patch.ts`, `replace-text.ts`**

In `src/tools/create.ts` (lines 132-135), replace description with:

```ts
  description:
    'Write whole text files (create, overwrite, or append) or make empty directories. ' +
    'Use when creating new files, replacing full contents, or creating folders. ' +
    'Missing parent directories are created automatically. Replacing an existing file requires overwrite: true. ' +
    'Returns created paths and an undo id. Use edit or patch to modify parts of an existing file.',
```

In `src/tools/edit.ts` (lines 699-703), replace description with:

```ts
  description:
    'Edit text files in place by replacing exact oldText with newText. ' +
    'Use when changing specific unique snippets in one or more files. ' +
    'Each oldText must match exactly once; unmatched or ambiguous text fails and leaves the file untouched. ' +
    'Returns the diff and line counts per file, plus an undo id. Use dryRun to preview. ' +
    'Use replace_text for multiple occurrences or regex, patch to apply unified diffs, and create for new files.',
```

In `src/tools/patch.ts` (lines 64-68), replace description with:

```ts
  description:
    'Apply a single-file unified diff to an existing text file, like git apply. ' +
    'Use when applying diffs produced by diff tools or git. ' +
    'Writes nothing unless every hunk applies in order with exact context; mismatched hunks fail and leave the file untouched. ' +
    'Returns applied hunk counts, lines changed, and an undo id. Use dryRun to test applicability cleanly. ' +
    'Use edit for unique snippet replacements, and replace_text for regex across files.',
```

In `src/tools/replace-text.ts` (lines 524-529), replace description with:

```ts
  description:
    'Find and replace text or an RE2 regex across one file or all files under a directory, like sed -i. ' +
    'Use when replacing every match across a file or project. ' +
    'Patterns match across the whole file and can span lines (^ and $ anchor to file start and end). ' +
    'Directory runs stop near 100 matches unless maxMatches is raised. ' +
    'Returns match counts, modified files, and an undo id. Use dryRun to preview wide scopes. ' +
    'Use edit for a single unique snippet, and patch to apply unified diffs.',
```

- [ ] **Step 2: Update contract snapshots and verify tests**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`
Expected: Snapshot updated.

Run: `node --test __tests__/contract.test.ts`
Expected: PASS

- [ ] **Step 3: Commit Task 3 changes**

```bash
git add src/tools/create.ts src/tools/edit.ts src/tools/patch.ts src/tools/replace-text.ts __tests__/contract.test.ts.snapshot
git commit -m "docs(tools): refine create, edit, patch, and replace-text descriptions for TDQS

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Refine mutating lifecycle tool descriptions (`delete`, `move`, `undo`)

**Files:**

- Modify: `src/tools/delete.ts:363-366`
- Modify: `src/tools/move.ts:332-336`
- Modify: `src/tools/undo.ts:100-102`
- Modify: `__tests__/contract.test.ts.snapshot` (via snapshot update)
- Test: `__tests__/contract.test.ts`, `__tests__/tools.test.ts`

**Interfaces:**

- Consumes: Mutating lifecycle tool definitions in `src/tools/`.
- Produces: Refined description strings for `delete`, `move`, and `undo`.

- [ ] **Step 1: Update descriptions in `delete.ts`, `move.ts`, `undo.ts`**

In `src/tools/delete.ts` (lines 363-366), replace description with:

```ts
  description:
    'Delete files, directories, or symlinks, like rm or rm -r. ' +
    'Use when permanently removing paths. Paths are exact (globs are not expanded). ' +
    'Non-empty directories require recursive: true and confirmation. ' +
    'Set ignoreIfNotExists: true to succeed cleanly if a path is already absent. ' +
    'Returns { path, deleted } per path and an undo id. Use move to relocate a path instead.',
```

In `src/tools/move.ts` (lines 332-336), replace description with:

```ts
  description:
    'Move, rename, or copy files and directories, like mv or cp -r. ' +
    'Use when renaming paths, moving files between directories, or copying trees (copy: true). ' +
    'Each destination must be the full target path, not an existing directory to move into. ' +
    'Overwrite applies only to copies; moving onto an existing file requires confirmation. ' +
    'Returns moved paths and an undo id. Use delete to remove paths.',
```

In `src/tools/undo.ts` (lines 100-102), replace description with:

```ts
  description:
    'Revert earlier mutating tool calls by undo id or steps (last N calls), not both. ' +
    'Use when rolling back recent file changes. ' +
    'Restores a file only if unchanged since the target call; modified files are skipped with explanation. ' +
    'Over HTTP, an undo id is required. Returns lists of restored and skipped paths. Use dryRun to inspect history without reverting.',
```

- [ ] **Step 2: Update contract snapshots and verify tests**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`
Expected: Snapshot updated.

Run: `node --test __tests__/contract.test.ts`
Expected: PASS

- [ ] **Step 3: Commit Task 4 changes**

```bash
git add src/tools/delete.ts src/tools/move.ts src/tools/undo.ts __tests__/contract.test.ts.snapshot
git commit -m "docs(tools): refine delete, move, and undo descriptions for TDQS

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Calibrate `tools/list` session-start budget and full verification

**Files:**

- Modify: `__tests__/tools.test.ts:1051-1056`
- Modify: `__tests__/contract.test.ts.snapshot` (final verification)
- Test: Full repository test suite (`npm run check`)

**Interfaces:**

- Consumes: All updated tool definitions from Tasks 1-4.
- Produces: Calibrated `BUDGET_CHARS` and `BUDGET_CHARS_READ_ONLY` in `TOOL-SURFACE-002` matching measured sizes with dated comment.

- [ ] **Step 1: Measure new full and read-only `tools/list` character sizes**

Run:

```bash
node -e "import('./__tests__/helpers.ts').then(async h => { const p = await h.createTestClientPair([process.cwd()]); const { tools } = await p.client.listTools(); console.log('full:', JSON.stringify(tools).length); await p.close(); const ro = await h.createTestClientPair([process.cwd()], { readOnly: true }); const { tools: rtools } = await ro.client.listTools(); console.log('ro:', JSON.stringify(rtools).length); await ro.close(); })"
```

Record the exact measured `full` and `ro` lengths.

- [ ] **Step 2: Update `TOOL-SURFACE-002` budget and comment in `__tests__/tools.test.ts`**

Update `__tests__/tools.test.ts` near line 1051 with a dated comment and headroom (+50 chars buffer over measured):

```ts
    // Raised 2026-11-07 to <NEW_FULL> full and <NEW_RO> read-only: TDQS score
    // refinement adds direct "use when" routing, parameter semantics, return format descriptions,
    // and cross-tool disambiguation; measured <MEASURED_FULL> / <MEASURED_RO>.
    const BUDGET_CHARS = <NEW_FULL>;
    const BUDGET_CHARS_READ_ONLY = <NEW_RO>;
```

- [ ] **Step 3: Regenerate and verify contract snapshot**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts` (with no `FS_*` variables set)
Run: `node --test __tests__/contract.test.ts`
Expected: PASS

- [ ] **Step 4: Run full repository test and verification suite**

Run: `npm run check` (runs lint, static checks, build, contract test, dist-smoke test, and all unit tests)
Expected: ALL PASS with exit code 0.

- [ ] **Step 5: Update knowledge graph**

Run: `graphify update .`
Expected: Knowledge graph updated with AST changes.

- [ ] **Step 6: Commit Task 5 changes**

```bash
git add __tests__/tools.test.ts __tests__/contract.test.ts.snapshot graphify-out/
git commit -m "test(tools): calibrate tools/list session budget after TDQS description refinements

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
