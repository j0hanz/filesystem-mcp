# Test-report fixes (F1-F8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the eight findings an external agent reported after building an app through filesystem-mcp, each pinned by a test.

**Architecture:** Two behavior bugs (F1 edit re-indent, F2 regex error code), two text-output gaps (F7 list paging, F8 lone-failure code), and four description fixes (F3-F6). Every fix lands at its single owning site; descriptions that reach `tools/list` or the instructions need a contract snapshot update in the same task.

**Tech Stack:** TypeScript on Node >=24 (`engines`), type stripping, `node:test`, zod v4, re2-wasm.

**Spec:** The findings below, from `C:\test-app\fsmcp-testbed\FSMCP_TEST_REPORT.md` (outside the repo), each reproduced on `main` at `d50fd1e2`:

| ID  | Finding                                                                                                                          | Owning site                                        |
| :-- | :------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------- |
| F1  | `edit` whitespace-flexible match doubles indentation when newText already carries the file's indentation (8 spaces instead of 4) | `src/tools/edit.ts:483` `reindentNewText`          |
| F2  | Invalid RE2 regex surfaces as `UNKNOWN`, not `INVALID_INPUT` (search_text, replace_text)                                         | `src/core/matcher.ts:171` `compileRegex`           |
| F3  | Path params reject any `..` segment, undocumented                                                                                | `src/core/schema.ts:275` `RequiredPath`            |
| F4  | Instructions say cursors expire on a ~60s clock; code and tool schemas say 5 min                                                 | `src/instructions.ts:69`, `src/core/store.ts:314`  |
| F5  | `created` resets on every whole-file write (atomic rename), undocumented                                                         | `src/tools/stat.ts:220`                            |
| F6  | `find_files sortBy: "name"` is locale, case-insensitive order, undocumented                                                      | `src/tools/find-files.ts:46`                       |
| F7  | `list` later pages redraw ancestor folders as if complete; nothing says a folder continues                                       | `src/tools/list.ts:188` `renderMarkdown`           |
| F8  | Single-path failure text drops the error code (`FAILED: Path not found`) in delete and edit                                      | `src/tools/delete.ts:225`, `src/tools/edit.ts:726` |

## Global Constraints

- Never hand-edit versions in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`.
- Contract snapshot update: `node --test --test-update-snapshots __tests__/contract.test.ts` with no `FS_*` variables set; commit the `.snapshot` diff with the change that caused it.
- Test payload assembly through `__tests__/tool-harness.ts` (`runToolBodyResult`) in the tool's own test file.
- Failure text format matches `failureLines` in `src/tools/batch.ts:444`: `<CODE> <message>`, code first, one space.
- After code changes run `graphify update .`.
- Final gate: `npm run check` passes.

## Review Focus

1. Re-indent with tabs in the file and spaces in newText (F1): the absolute-indent check must compare literal strings, so a tab-indented file never treats a space-indented newText as already aligned. Test in Task 3.
2. Re-indent where newText has a different line count than oldText (F1): the non-positional branch must stay unchanged. Covered by the existing `tabs.js` case in `edit.test.ts:416`; Task 3 must keep it green.
3. A regex the engine aborts on (wasm abort) must still map through `re2AbortError`, not the new `INVALID_INPUT` (F2). Task 1 changes only the `SyntaxError` branch.
4. The cancel/decline path in delete keeps `isError` false while its text gains `CANCELLED` (F8). Test in Task 2.
5. The externalized full tree (`resourceUri`) must not gain `(continued)` markers, since it holds every entry (F7). Test in Task 4.

---

### Task 1: Invalid regex is INVALID_INPUT (F2)

**Files:**

- Modify: `src/core/matcher.ts:167-175`
- Test: `__tests__/match-engine.test.ts:282-293`, `__tests__/replace-text.test.ts:522-535`, `__tests__/search-text.test.ts`

**Interfaces:**

- Produces: `compileRegex` throws `FsError` with `code === ErrorCode.INVALID_INPUT`, message unchanged (`<engine message>. Lookahead, lookbehind, and backreferences are not supported.`), original `SyntaxError` as `cause`.

- [ ] **Step 1: Update the two existing tests to expect the new error**

`match-engine.test.ts:288`: replace `SyntaxError` with `fsErrorMatcher(ErrorCode.INVALID_INPUT)`.
`replace-text.test.ts:530-534`: replace the predicate with
`fsErrorMatcher(ErrorCode.INVALID_INPUT, /\. Lookahead, lookbehind, and backreferences are not supported\.$/)`.

- [ ] **Step 2: Add `search_text refuses a lookahead regex with INVALID_INPUT`** to `search-text.test.ts`

Run `SEARCH_TEXT` via `runToolBodyResult` with `{ path: root, searchPattern: 'foo(?=\\d)', isRegex: true }`; `assert.rejects(..., fsErrorMatcher(ErrorCode.INVALID_INPUT, /invalid perl operator/))`.

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- --test-name-pattern="invalid regex|lookahead regex"`
Expected: 3 FAIL (got SyntaxError).

- [ ] **Step 4: In `compileRegex`, throw `new FsError(ErrorCode.INVALID_INPUT, <same message>, undefined, error)`** in place of `new SyntaxError(...)`. Leave the `isRe2Abort` and non-`SyntaxError` branches as they are.

- [ ] **Step 5: Run to verify pass**

Run: `npm test -- --test-name-pattern="invalid regex|lookahead regex|regex"`
Expected: PASS, no other regex test regresses.

- [ ] **Step 6: Commit**

```bash
git add src/core/matcher.ts __tests__/match-engine.test.ts __tests__/replace-text.test.ts __tests__/search-text.test.ts
git commit -m "fix(matcher): report an invalid regex as INVALID_INPUT"
```

### Task 2: Lone-failure text names the error code (F8)

**Files:**

- Modify: `src/tools/delete.ts:225`, `src/tools/edit.ts:726`
- Test: `__tests__/delete.test.ts`, `__tests__/edit.test.ts`

**Interfaces:**

- Produces: single-path failure text `delete: <path> FAILED: <CODE> <message>` and `edit: <path> FAILED: <CODE> <message>[ [dry run]]`.

- [ ] **Step 1: Write the failing tests**

`delete.test.ts`: `it('names the error code when the only path is missing')`: delete `{ paths: [join(root, 'ghost.txt')] }`; `assert.match(result.text, /FAILED: NOT_FOUND /)`.
`edit.test.ts`: `it('names the error code when the only file fails')`: edit a missing path; `assert.match(result.text, /FAILED: NOT_FOUND /)`.
Update `delete.test.ts:709` to `/FAILED: CANCELLED Delete cancelled/` and keep its `isError` assertion.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --test-name-pattern="names the error code|declin"`
Expected: 3 FAIL.

- [ ] **Step 3: Insert `${error.code} ` before the message at both sites.** In delete keep the `'unknown error'` fallback for a result with no `error`.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- __tests__/delete.test.ts __tests__/edit.test.ts`
Expected: PASS. Grep `__tests__` for other `FAILED: ` text assertions and update any that broke.

- [ ] **Step 5: Commit**

```bash
git add src/tools/delete.ts src/tools/edit.ts __tests__/delete.test.ts __tests__/edit.test.ts
git commit -m "fix(delete,edit): name the error code in a single-path failure"
```

### Task 3: Re-indent keeps newText already at the file's indentation (F1)

**Files:**

- Modify: `src/tools/edit.ts:483-516` (`reindentNewText`), `src/tools/edit.ts:92` (description)
- Test: `__tests__/edit.test.ts` (next to `:397`), `__tests__/contract.test.ts.snapshot`

**Interfaces:**

- Consumes: nothing new.
- Produces: `reindentNewText(newText, oldText, matched, atLineStart): string`, same signature.

Rule: in the **positional** branch only, when at least one counted pair has `from[j] !== to[j]`, and every such pair's newText line already starts with `to[j]`, return `newText` unchanged. newText is then already written in the file's indentation. Otherwise keep today's relative mapping. The non-positional branch is unchanged.

- [ ] **Step 1: Write the failing tests**

`it('with ignoreWhitespace keeps newText already at the file indentation')`: file `'function search(term) {\n    const t = 1;\n    return t;\n}\n'`; oldText `'function search(term) {\nconst t = 1;'`; newText `'function search(term) {\n    const t = 2;'`. Run once with `ignoreWhitespace: true` and once without (fallback). Both expect file `'function search(term) {\n    const t = 2;\n    return t;\n}\n'`.

`it('with ignoreWhitespace keeps relative newText relative')`: same file, newText `'function search(term) {\n  const t = 2;'`. Expect `'      const t = 2;'` (6 spaces) on line 2. This pins the documented relative rule.

`it('with ignoreWhitespace compares tab and space indentation literally')`: file `'\tif (x) {\n\t\ty();\n\t}\n'`, oldText `'if (x) {\ny();\n}'` (match starts mid-line, so line 0 is not counted; `to` is `['\t\t', '\t']`).

- Tabs, absolute: newText `'if (x) {\n\t\tz();\n\t}'` expects file `'\tif (x) {\n\t\tz();\n\t}\n'`.
- Spaces, relative: newText `'if (x) {\n        z();\n    }'` expects file `'\tif (x) {\n\t\t        z();\n\t    }\n'`. Spaces never start with `\t`, so the mapping stays relative.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --test-name-pattern="ignoreWhitespace"`
Expected: the absolute-indent cases FAIL (8 spaces / 4 tabs written); relative cases PASS.

- [ ] **Step 3: Implement the rule in `reindentNewText`.** Compute the check before the `.map`, using the same `counted` filter and positional pairing.

- [ ] **Step 4: Update the `ignoreWhitespace` description** (`edit.ts:92`) to:
      `'Match oldText ignoring indentation and spacing, never across line breaks. newText indentation is read relative to oldText and moved onto the match, unless newText already carries the file\'s indentation. Tried automatically when the exact text has no match'`

- [ ] **Step 5: Run to verify pass, then refresh the snapshot**

Run: `npm test -- __tests__/edit.test.ts`
Expected: PASS, including `edit.test.ts:397` and the property tests at `:982`.
Run: `node --test --test-update-snapshots __tests__/contract.test.ts`, then `git diff __tests__/contract.test.ts.snapshot`. Expected: only the `ignoreWhitespace` description changes.

- [ ] **Step 6: Commit**

```bash
git add src/tools/edit.ts __tests__/edit.test.ts __tests__/contract.test.ts.snapshot
git commit -m "fix(edit): keep newText that already has the file's indentation"
```

### Task 4: List pages mark folders that continue elsewhere (F7)

**Files:**

- Modify: `src/tools/list.ts:188-235` (`renderMarkdown`), `src/tools/list.ts:430-446` (`render`)
- Test: `__tests__/list.test.ts`

**Interfaces:**

- Produces: tree text where a folder redrawn only as an ancestor reads `data/ (continued)`. A page with a `nextCursor` adds the note line `// a folder shown without its contents may continue on the next page` to the trailer notes. `structuredContent.entries` is unchanged.

- [ ] **Step 1: Write the failing tests**

`it('marks a folder redrawn on a later page as continued')`: root with `data/{a,b,c,d}.md` and `src/`, `list({ path: root, maxDepth: 2, maxEntries: 2 })`, follow `structured.nextCursor` until a page holds `data/` files without `data` itself; `assert.match(page.text, /data\/ \(continued\)/)`.
`it('notes that a paged folder may continue')`: first page `assert.match(text, /may continue on the next page/)`; last page `assert.doesNotMatch(...)`.
`it('keeps the full tree resource free of continued markers')`: read the first page's `resourceUri` markdown; `assert.doesNotMatch(markdown, /\(continued\)/)`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --test-name-pattern="continued|may continue"`
Expected: 2 FAIL, 1 PASS (the resource test).

- [ ] **Step 3: In `renderMarkdown`, keep a `Set<string>` of the ancestor paths it pushes as context.** Append ` (continued)` after the `/` for those lines. In `render`, add the note line when `nextCursor !== undefined`. Use the existing notes mechanism if the trailer accepts it there; otherwise put it before the trailer.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- __tests__/list.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/list.ts __tests__/list.test.ts
git commit -m "fix(list): mark folders continued across pages"
```

### Task 5: Descriptions match behavior (F3, F4, F5, F6)

**Files:**

- Modify: `src/core/schema.ts:275`, `src/core/store.ts:314`, `src/instructions.ts:69`, `src/tools/stat.ts:220`, `src/tools/find-files.ts:46`
- Test: `__tests__/find-files.test.ts`, `__tests__/contract.test.ts.snapshot`

**Interfaces:**

- Produces: `export const SNAPSHOT_TTL_MS` from `src/core/store.ts`. The instructions build their cursor line from it so the text cannot drift again.

Exact new text:

- F3 `RequiredPath`: `'File or directory path inside a root, absolute or relative to it. No ".." segments.'`
- F4 pagination line: `` `pagination: nextCursor appears in the result text and in _meta. Its snapshot lasts about ${SNAPSHOT_TTL_MS / 60_000} min after its last page is read. Send the printed Next page call as-is (the original arguments plus cursor). If a cursor is rejected, start again without one. resourceUri appears on the first page only and expires after about 60 seconds.` ``
- F5 stat: after `timestamps` insert `(created resets when a tool rewrites the file, since writes replace it atomically)`
- F6 sortBy: `'name: by file name across folders, case-insensitive, ties by path. Sorts the first 10,000 kept matches before paging.'`

- [ ] **Step 1: Write the failing test** `find-files.test.ts`: `it('sortBy name orders case-insensitively')`: files `README.md`, `data/ideas.md`; `sortBy: 'name'`; expect `['data/ideas.md', 'README.md']`. This pins F6's documented order. It passes today, so it is a regression guard, not a red test.

- [ ] **Step 2: Apply the four text changes and the `SNAPSHOT_TTL_MS` export.**

- [ ] **Step 3: Run the suites and refresh the snapshot**

Run: `npm test -- __tests__/find-files.test.ts __tests__/stat.test.ts __tests__/contract.test.ts`
Expected: PASS.
Run: `node --test --test-update-snapshots __tests__/contract.test.ts`. Expected diff: only the four described strings change (the instructions text appears twice, full and read-only).
Grep `docs/` and `README.md` for `~60s clock` and fix any copy.

- [ ] **Step 4: Commit**

```bash
git add src/core/schema.ts src/core/store.ts src/instructions.ts src/tools/stat.ts src/tools/find-files.ts __tests__/find-files.test.ts __tests__/contract.test.ts.snapshot
git commit -m "docs(tools): describe .. paths, cursor TTL, created resets, name sort"
```

### Task 6: Final gate

- [ ] **Step 1:** Run `graphify update .`
- [ ] **Step 2:** Run `npm run check`. Expected: exit 0.
- [ ] **Step 3:** Rerun the repro script from the analysis, if available, and confirm F1, F2, F7 and F8 now show the fixed output. Expected: F1 writes 4 spaces in the fallback case, F2 reports `INVALID_INPUT`, F7 prints `(continued)` on page 2+, F8 prints `FAILED: NOT_FOUND`.
- [ ] **Step 4:** Commit any `graphify-out/` change: `git commit -am "chore: update graph"`.
