# Stress-test critical and major fixes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 1 critical and 14 major defects that the 2026-10-29 stress test confirmed against HEAD `82da458`.

**Architecture:** The tasks are independent fixes, each owned by one module. One rule covers path security: containment checks fold ASCII case only. Tasks 11-15 all change `replace_text`'s `ReplacementMatcher`. They run in order and share one signature, defined in Task 12.

**Tech Stack:** TypeScript, Node 24 test runner, `@adguard/re2-wasm`, zod 4.

**Spec:** `tmp/stress/REPORT.md`. It lists every finding with repro, observed, expected and source line. Design briefs are in `tmp/stress/briefs.json` (keys match the task names below). Both files are git-ignored scratch, so read them before you delete `tmp/`.

## Global Constraints

- Branch: `fix/stress-test-findings` off `main`. One commit per task. Never hand-edit versions (CLAUDE.md, Releases).
- CHANGELOG: Task 1 creates `## [Unreleased]` above `## [2.12.1] - 2026-10-29`, with a `### Security` and a `### Fixed` heading. Every later task appends one bullet under the right heading.
- No tool description, schema or instructions text changes. The one exception is Task 7 (the `ignoreWhitespace` description). Run `node --test --test-update-snapshots __tests__/contract.test.ts` with no `FS_*` variables set in that task only.
- Windows-only tests gate on the platform the way the repo already does: `if (process.platform !== 'win32') { t.skip('...'); return; }`. Case-insensitive tests gate on `IS_CASE_INSENSITIVE_FS` from `src/core/path-utils.ts`.
- Tests go in the existing file named per task, inside the named `describe`. Use the existing helpers from `__tests__/helpers.ts`: `writeTestFile`, `firstTextBlock`, `failedSummary`, `withEnv`, `trySymlink`, `makeGuard`, `fsErrorMatcher`.
- Before each commit, run `npm run check:static` and the task's focused test. Before the final push, run `npm run check`. Per memory, run concurrency tests pinned to 2 CPUs in WSL.
- Tests are TypeScript. The test code below is the contract; copy its assertions exactly.

## Review Focus

1. **A non-ASCII case variant of an in-root path on Windows/macOS** (`É` vs `é`) is now refused as outside the roots, not resolved. The refusal must be `ACCESS_DENIED` and must never read the file. The test is in Task 1.
2. **`replace_text` with `maxMatches` in a dry run** must report and preview exactly what the live run then writes. The test is in Task 13.
3. **Undo after an in-place hardlink write** must restore the old bytes on both links. The test is in Task 8.
4. **A CRLF file edited with `ignoreWhitespace`** must keep `\r\n` on every re-indented line. The test is in Task 7.
5. **`search_text` with `context` around a 2 MB line** must clip the context lines too, not only the match line. The test is in Task 10.

## Pushback recorded

- **`read` of a 2 MB single line (`head: 1`) stays verbatim.** A full `read` of a 2 MB file also returns 2 MB by design, because the cap is `--max-file-size`. Clipping a slice would break the read-then-`edit` round trip. Only `search_text`, whose output is a summary, gets clipped (Task 10).
- **`ignoreWhitespace` swallowing blank lines inside the span** is documented, not fixed (Task 7). Those lines are part of the match.
- **`maxMatches`** uses sequential processing when an explicit cap is set, instead of the brief's cross-file ledger. That is less code, and the result is still deterministic.

---

### Task 1: Containment folds ASCII case only (critical)

**Files:**
- Modify: `src/core/path-utils.ts:172-174` (`normalizeCaseForComparison`) and `:187-189` (`unicodeMatchKey`)
- Test: `__tests__/path-helpers.test.ts` (describe `PathGuard containment helpers`), `__tests__/security.test.ts` (describe `PathGuard boundary enforcement`, after TC-SEC-014)
- Modify: `CHANGELOG.md:7`

**Interfaces:**
- Produces: `normalizeCaseForComparison(value: string): string`, which folds only `A-Z` on case-insensitive filesystems. It is used by `isSamePath` and `isPathInsideDirectory`. `unicodeMatchKey` keeps its full `toLowerCase()` fold through a new private `foldNameCase(value: string): string`. It only matches spellings within one directory and is not a containment check.

- [ ] **Step 1: Write the failing tests**

`__tests__/path-helpers.test.ts`:

```ts
  it('TC-PH-020: a Kelvin sign is not the letter k for containment', (t) => {
    if (!IS_CASE_INSENSITIVE_FS) { t.skip('case folding applies on a case-insensitive filesystem'); return; }
    const root = normalizePath('C:/x/kroot');
    assert.strictEqual(isPathInsideDirectory(root, normalizePath('C:/x/\u212Aroot/secret.txt')), false);
    assert.strictEqual(isSamePath('C:/x/\u212Aroot', 'C:/x/kroot'), false);
    assert.strictEqual(isPathInsideDirectory(root, normalizePath('C:/x/\u017Froot/s')), false); // long s
    assert.strictEqual(isPathInsideDirectory(root, normalizePath('C:/X/KROOT/a.txt')), true);   // ASCII still folds
  });
```

Add `IS_CASE_INSENSITIVE_FS` and `normalizePath` to the `../src/core/path-utils.ts` import if they are not already there.

`__tests__/security.test.ts` (TC-SEC-043, after TC-SEC-014):

```ts
    it('TC-SEC-043: a Unicode case-fold look-alike sibling of the root is outside it', async (t) => {
      if (!IS_CASE_INSENSITIVE_FS) { t.skip('case folding applies on a case-insensitive filesystem'); return; }
      const parent = await createTestRoot();
      try {
        const inside = join(parent, 'kroot');
        const lookalike = join(parent, '\u212Aroot');
        await mkdir(inside);
        await mkdir(lookalike);
        await writeFile(join(lookalike, 'secret.txt'), 'KELVIN-SECRET');
        const kGuard = await makeGuard([inside]);
        const denied = fsErrorMatcher(ErrorCode.ACCESS_DENIED, /Outside allowed directories/);
        await assert.rejects(kGuard.validateExistingPath(join(lookalike, 'secret.txt')), denied);
        await assert.rejects(kGuard.validatePathForWrite(join(lookalike, 'planted.txt')), denied);
        await assert.rejects(kGuard.validatePathForDelete(join(lookalike, 'secret.txt')), denied);
        // Review Focus 1: a root whose own name differs only in non-ASCII case is refused, never served.
        const cafe = join(parent, 'caf\u00e9');
        await mkdir(cafe);
        await writeFile(join(cafe, 'x.txt'), 'x');
        const cafeGuard = await makeGuard([cafe]);
        await assert.rejects(cafeGuard.validateExistingPath(join(parent, 'CAF\u00c9', 'x.txt')), denied);
        assert.ok((await cafeGuard.validateExistingPath(join(parent, 'CAF\u00e9', 'x.txt'))).endsWith('x.txt')); // ASCII case still folds
      } finally {
        await cleanupTestRoot(parent);
      }
    });
```

> NTFS keeps `kroot` and `\u212Aroot` as two folders (verified 2026-10-29 on Windows 11). On a filesystem that merges them, the second `mkdir` throws `EEXIST`. Then call `t.skip('filesystem folds U+212A')`.

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- --test-name-pattern="TC-PH-020|TC-SEC-043"`
Expected on Windows: FAIL. `isPathInsideDirectory` returns `true`, and `validateExistingPath` resolves the secret.

- [ ] **Step 3: Implement**

In `path-utils.ts`:
- Make `normalizeCaseForComparison` return `value.replace(/[A-Z]/gu, (c) => c.toLowerCase())` when `IS_CASE_INSENSITIVE_FS`.
- Add `foldNameCase(value)` with the old `toLowerCase()` body and use it in `unicodeMatchKey`.
- Comment the why in one line: `// ASCII only: JS folds U+212A/U+017F onto k/s, NTFS does not, so a full fold equates a sibling with the root.`

- [ ] **Step 4: Run the focused tests, then `npm test -- --test-name-pattern="unicode|respell|case"`**

Expected: PASS. The `unicode-paths.test.ts` case-only rename tests (TC-PH-009 and the "differently cased" link test) use ASCII names, so they must stay green. If one fails, stop and report. Do not widen the fold.

- [ ] **Step 5: CHANGELOG and commit**

Bullet under `### Security`: "**Path containment no longer folds non-ASCII case.** On Windows and macOS, a sibling folder whose name differs from a root only by a character JavaScript folds but NTFS does not (U+212A Kelvin sign, U+017F long s) passed the containment check, so every tool could read, write and delete outside the root. Containment now folds `A-Z` only."

```bash
git add src/core/path-utils.ts __tests__/path-helpers.test.ts __tests__/security.test.ts CHANGELOG.md
git commit -m "fix(path): fold only ASCII case in containment checks"
```

### Task 2: Refuse NTFS alternate data stream paths

**Files:**
- Modify: `src/core/path-utils.ts:139` (new export after `isWindowsDrivePath`), `src/core/path.ts:18-34` (import), `src/core/path.ts:581-582` (`validateAccess`, after the drive-relative throw)
- Test: `__tests__/security.test.ts` (TC-SEC-041, TC-SEC-042 after TC-SEC-043), `__tests__/tools.test.ts:882` (TC-FUNC-009s/009t after TC-FUNC-009d)

**Interfaces:**
- Produces: `export const hasAlternateDataStream = (requestedPath: string): boolean`, which is true when a `:` follows `win32.parse(requestedPath).root`.

- [ ] **Step 1: Write the failing tests**

TC-SEC-041 is Windows-gated. For each of `a.txt:hidden`, `a.txt::$DATA`, `new.txt:s` and `dir:x\\f.txt` under `root`, `validateExistingPath`, `validatePathForWrite` and `validatePathForDelete` all reject with `fsErrorMatcher(ErrorCode.INVALID_INPUT, /NTFS alternate data streams are not supported/)`. `` `\\\\?\\${join(root, 'b.txt:s')}` `` also rejects. `validateExistingPath(join(root, 'a.txt'))` still resolves.

TC-SEC-042 is POSIX-gated. `validatePathForWrite(join(root, 'a:b.txt'))` resolves to a path ending `a:b.txt`.

TC-FUNC-009s is Windows-gated. `create` of `join(tmpDir, 'ads-create.txt:hidden')` fails. `structuredContent.failures[0].error.code === 'INVALID_INPUT'`, and the text contains no `EINVAL` and no `.tmp`.

TC-FUNC-009t is Windows-gated. `move` with `copy: true` from an existing `ads-src.txt` to `ads-src.txt:hidden` sets `isError: true` and `_meta.failures[0].error.code === 'INVALID_INPUT'`. `readdir(tmpDir)` shows no new entry.

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- --test-name-pattern="TC-SEC-04[12]|TC-FUNC-009[st]"`
Expected: FAIL. The stream paths validate, `create` leaks `EINVAL`, and `copy` succeeds.

- [ ] **Step 3: Implement**

Add `hasAlternateDataStream` in `path-utils.ts`. In `validateAccess`, after the drive-relative block, add:
`if (IS_WINDOWS && hasAlternateDataStream(requestedPath)) throw new FsError(ErrorCode.INVALID_INPUT, "NTFS alternate data streams are not supported. Remove the ':stream' suffix from the path.", requestedPath);`

Keep `sensitive.ts` `stripAlternateDataStreams` as is.

- [ ] **Step 4: Run, expect PASS.** Then run `npm test -- --test-name-pattern="TC-SEC|sensitive"`. Expected: PASS.

- [ ] **Step 5: CHANGELOG `### Security` bullet** ("Paths naming an NTFS alternate data stream are refused on Windows…"). **Then commit** `fix(path): refuse NTFS alternate data stream paths`.

### Task 3: `move` of a missing source reports NOT_FOUND

**Files:**
- Modify: `src/tools/move.ts:10` (import `unlessMissing`), `src/tools/move.ts:482-483`
- Test: `__tests__/tools.test.ts:1752` (after TC-FUNC-054; add `lstat` and `readlink` to the `node:fs/promises` import)

**Interfaces:**
- Consumes: `unlessMissing<T>(promise: Promise<T>): Promise<T | undefined>` (`src/core/errors.ts:208`).

- [ ] **Step 1: Write the failing tests**

- `'move with a nonexistent source fails NOT_FOUND naming the source'`: `isError === true`, `_meta.failures.length === 1`, `failures[0].error.code === 'NOT_FOUND'`, `failures[0].error.path === src`, and the suggestion does not match `/list_roots/`.
- `'copy with a nonexistent source fails NOT_FOUND naming the source'`: the same call with `copy: true`. It already passes and serves as a regression pin.
- `'move of a dangling symlink still moves the link itself'`: use `trySymlink(target, link, () => t.skip(...), 'file')`, then `(await lstat(dst)).isSymbolicLink() === true` and `await readlink(dst) === target`.

- [ ] **Step 2: Run, expect FAIL on test 1** (`ACCESS_DENIED`). Run: `npm test -- --test-name-pattern="nonexistent source|dangling symlink"`

- [ ] **Step 3: Implement.** Replace lines 482-483 with `const link = await unlessMissing(fs.lstat(source, { signal })); if (!link?.stats.isSymbolicLink()) throw err;`. Add the comment `// No entry at all is the stat's NOT_FOUND, not the outer catch's ACCESS_DENIED.`

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: CHANGELOG `### Fixed` bullet. Commit** `fix(move): report NOT_FOUND for a missing source`.

### Task 4: `create` caps size in UTF-8 bytes

**Files:**
- Modify: `src/tools/create.ts:39` (per-file refine), `:107-111` (batch sum and comment), `:117` (message says "bytes"), and the `src/core/util.ts:143-158` doc comment only
- Test: `__tests__/tools.test.ts:1401` (after `'create refuses a batch whose combined content exceeds the file limit'`)

- [ ] **Step 1: Write the failing tests** (both inside `withEnv({ FS_MAX_FILE_SIZE: String(1024 * 1024) }, …)`)

- `'create counts the per-file size cap in UTF-8 bytes, not UTF-16 units'`: `'€'.repeat(349526)` (1048578 bytes) is refused with `/Content exceeds maximum allowed text file size/`, and `stat` of the path rejects `ENOENT`. `'€'.repeat(349525) + 'x'` (exactly 1048576 bytes) is accepted, and its `stat().size === 1048576`.
- `'create counts the combined batch cap in UTF-8 bytes'`: two entries of `'€'.repeat(174764)` are refused. The text matches `/combined content is 1048584 bytes; one create call carries at most 1048576 \(FS_MAX_FILE_SIZE\)\. Split the batch\./u`.

- [ ] **Step 2: Run, expect FAIL.** Run: `npm test -- --test-name-pattern="create counts the|create refuses a batch whose combined"`

- [ ] **Step 3: Implement.** Replace `val.length` with `Buffer.byteLength(val, 'utf8')`, and sum `Buffer.byteLength(file.content, 'utf8')`. In the message, change "characters" to "bytes". Leave `getMaxInboundMessageBytes()` as is.

- [ ] **Step 4: Run, expect PASS.** The existing ASCII batch test stays green.

- [ ] **Step 5: CHANGELOG. Commit** `fix(create): measure the size cap in UTF-8 bytes`.

### Task 5: Batch `read` slices are charged their returned bytes

**Files:**
- Modify: `src/tools/read.ts:177-191` (drop `fullRead` from `BudgetMode`, delete line 187), `:222-231` (use `budgetSkip`), `:428-447` (`run`)
- Test: `__tests__/tools.test.ts:313` (after `'batch slice of an svg is charged its raw size, not base64'`)

**Interfaces:**
- Produces, both in `read.ts`: `function budgetSkip(path: string, maxTotalSize: number, suggestion?: string): FsError`. Its message is the existing line-228 text, unchanged. Also `const SLICE_SKIP_SUGGESTION = 'Read it on its own with path, or ask for fewer lines.'`.

- [ ] **Step 1: Write the failing tests**

- `'batch head slice of a file larger than maxTotalSize is charged its returned bytes'`: `small.txt` holds `'small\n'` and `big.txt` holds `'x\n'.repeat(300 * 1024)`. With `paths: [small, big], head: 1`, `summary.failed === 0`, and the text matches `/\/\/ .*big\.txt\nx/`.
- `'batch slices over budget skip one slice without head/tail advice'`: `a` and `b` each start with a 300 KiB line, and `c` is `'tiny\nrest\n'`. With `head: 1`, exactly one of `a` and `b` is skipped, and `c` never is. The skip has `code === 'TOO_LARGE'`, its message matches `/maxTotalSize \(524288 bytes\)/`, `suggestion === 'Read it on its own with path, or ask for fewer lines.'`, and `summary.failed === 1`.

- [ ] **Step 2: Run, expect FAIL.** Run: `npm test -- --test-name-pattern="batch head slice|batch slices over budget|batch read with binary|batch slice of an svg"`

- [ ] **Step 3: Implement.** In `run`, `const slice = args.paths !== undefined && hasLineRange(args)`. A slice batch skips `collectFileBudget`. In the `runOverPaths` callback, after `readOnePath`, charge `Buffer.byteLength(value.content ?? '', 'utf8')` against `READ_MANY_MAX_TOTAL_BYTES` in completion order. Throw `budgetSkip(path, READ_MANY_MAX_TOTAL_BYTES, SLICE_SKIP_SUGGESTION)` when the slice is over budget. Full reads keep the stat pre-pass.

- [ ] **Step 4: Run, expect PASS** (all four named tests).

- [ ] **Step 5: CHANGELOG. Commit** `fix(read): charge batch slices the bytes they return`.

### Task 6: `edit` stops reporting "(no change)" for a change too large to diff

**Files:**
- Modify: `src/tools/edit.ts:422-423` (`formatEditSummary`)
- Test: `__tests__/tools.test.ts:1107` (after TC-FUNC-013)

- [ ] **Step 1: Write the failing test** `'edit reports a change it could not diff instead of "(no change)"'`

Rewrite 20000 lines `a<i>` to `b<i>`. The test triggers the real 1000 ms `DIFF_TIMEOUT_MS`.
- The dry-run text equals `'edit: edit-diff-timeout.txt changed (too many lines to diff) [dry run]'`, and the file is unchanged.
- The real run's text matches `/^edit: edit-diff-timeout\.txt changed \(too many lines to diff\) · undo \S+$/u`, and the file equals the rewritten content.
- An identical `b0\n`→`b0\n` edit still matches `/^edit: edit-diff-timeout\.txt \(no change\)/u`.

- [ ] **Step 2: Run, expect FAIL.** Run: `node --test --test-name-pattern="could not diff" __tests__/tools.test.ts`

- [ ] **Step 3: Implement.** Before `const added = v.linesAdded ?? 0;`, add `if (v.appliedEdits > 0 && v.linesAdded === undefined) return \`${basename(v.path)} changed (too many lines to diff)\`;`. Use the comment `// Counts are absent only when the Myers diff hit DIFF_TIMEOUT_MS; the edit still applied.`

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: CHANGELOG. Commit** `fix(edit): say a large edit changed the file instead of "(no change)"`.

### Task 7: `edit` with `ignoreWhitespace` re-indents newText

**Files:**
- Modify: `src/tools/edit.ts:70-72` (description: newText is re-indented to the matched lines, and blank lines inside the matched span are replaced), `:263-266` (new helpers after `afterCodePoint`), `:327-331` (splice)
- Modify: `__tests__/tools.test.ts:1192-1204`. The existing test pins the bug. Its expected value becomes `'f() {\n    go();\n}\n'`.
- Test: `__tests__/tools.test.ts:~1236` (after `'keeps the blank lines before a leading newline'`)
- Modify: `__tests__/contract.test.ts.snapshot` (regenerated)

**Interfaces:**
- Produces, both module-private: `const indentOf = (line: string): string => /^\s*/u.exec(line)?.[0] ?? ''` and `function reindentNewText(newText: string, oldText: string, matched: string, atLineStart: boolean): string`.

- [ ] **Step 1: Write the failing tests**

- `'edit with ignoreWhitespace re-indents newText to the matched lines'`:
  - In `'function f() {\n    if (x) {\n        y();\n    }\n}\n'`, oldText `'if (x) {\n  y();\n}'` and newText `'if (x) {\n  z();\n}'` give `'function f() {\n    if (x) {\n        z();\n    }\n}\n'`.
  - In the tab file `'\tif (x) {\n\t\ty();\n\t}\n'`, newText `'if (x) {\n  z();\n  w();\n}'` gives `'\tif (x) {\n\t\tz();\n\t\tw();\n\t}\n'`.
- `'edit with ignoreWhitespace keeps the file indentation of a flattened oldText in a CRLF file'` (Review Focus 4): in `'function f() {\r\n    if (x) {\r\n        y();\r\n    }\r\n}\r\n'`, oldText `'y();\n}'` and newText `'w();\n}'` give `'function f() {\r\n    if (x) {\r\n        w();\r\n    }\r\n}\r\n'`.

- [ ] **Step 2: Run, expect FAIL.** Run: `npm test -- --test-name-pattern="ignoreWhitespace"`

- [ ] **Step 3: Implement `reindentNewText`.** This algorithm is not determined by the tests, so follow it exactly:
  - A line *counts* when it holds non-whitespace and (`index > 0 || atLineStart`). `atLineStart` means the match starts at offset 0 or right after `\n`.
  - `from[]` is `indentOf` of each counted oldText line. `to[]` is `indentOf` of each counted line of the matched span.
  - For each counted newText line:
    - When the counted newText count equals `from.length`, pair by position.
    - Otherwise use the index of the longest `from[k]` that the line's own indent starts with (the first one wins a tie).
    - If there is no pair, or the indent doesn't start with `from[j]`, keep the line as written.
    - Else output `to[j] + line.slice(from[j].length)`.
  - Uncounted lines stay as written. Join with `\n`. The CRLF conversion has already run, so the `\r` stays.
  - Call `reindentNewText` in the splice only when `ignoreWhitespace` is set.

- [ ] **Step 4: Run, expect PASS.** Then run `node --test --test-update-snapshots __tests__/contract.test.ts` (no `FS_*` set) and `npm test -- --test-name-pattern="contract"`.

- [ ] **Step 5: CHANGELOG. Commit** `fix(edit): re-indent newText under ignoreWhitespace` (include the snapshot).

### Task 8: Write hardlinked files in place

**Files:**
- Modify: `src/core/read.ts:24-27` (new `WRITE_NOFOLLOW`), `src/core/fs.ts:43-52` (import), `src/core/fs.ts:385-469` (`GuardedFileSystem.writeFile`)
- Test: `__tests__/core-fs.test.ts:422` (TC-FUNC-011b; add `link` to the import), `__tests__/undo.test.ts:475` (in `restoreEntry`; add `link` and `readFile` to the import)

**Interfaces:**
- Produces: `export const WRITE_NOFOLLOW = constants.O_RDWR | O_NOFOLLOW | O_NONBLOCK`. The `writeFile` signature does not change.

- [ ] **Step 1: Write the failing tests** (each skips when `link()` throws)

- TC-FUNC-011b `'writeFile over a hardlinked file updates every link in place'`: write `'new\n'` over a longer original. Both names read `'new\n'`, `nlink === 2`, and no `hardlink_a.txt.*` temp files are left behind.
- `'restore over a hardlinked file puts the old bytes back on every link'` (Review Focus 3): `captureOne((fs) => fs.writeFile(file, 'after'))`, then `restoreEntry(entry, newFs(), { dryRun: false })`. Expect `remaining` to deep-equal `[]`, the twin to read `'before'` and `nlink === 2`.

- [ ] **Step 2: Run, expect FAIL** (the twin keeps its old bytes, `nlink` is 1). Run: `npm test -- --test-name-pattern="hardlink"`

- [ ] **Step 3: Implement.** After `const existing = await fsStat(validPath)`, set `inPlace = existing.isFile() && existing.nlink > 1`. When `inPlace` is true:
  1. `signal?.throwIfAborted()`.
  2. `await using handle = await fsOpen(validPath, WRITE_NOFOLLOW)`.
  3. `await this.#assertFdWithinRoots(handle, filePath)`.
  4. `truncate(0)`, then `handle.writeFile(content)` with no signal, then `sync()`.
  5. On error, call `this.#capture?.abandon('the write failed part-way')` and rethrow.

  Otherwise the existing temp+rename path runs unchanged. Comment the in-place branch: `// shortcut: in-place write is not crash-atomic; a rename would give this path a new inode and strand the other links on the old bytes.`

- [ ] **Step 4: Run, expect PASS.** Then run `npm test -- --test-name-pattern="core-fs|undo|rewrite"`.

- [ ] **Step 5: CHANGELOG. Commit** `fix(fs): write hardlinked files in place`.

### Task 9: `find_files` matches case-insensitively on Windows and macOS, with on-disk names

**Files:**
- Modify: `src/core/glob.ts` (new `foldPatternCase` near `normalizePattern:465`; apply it to `patterns` in `globEntries` before `fsGlob` at about `:709`; `DEFAULT_EXCLUDED_NAMES.has(...)` lookups at `:337` and `:613` use the lowercased name when `IS_CASE_INSENSITIVE_FS`)
- Test: `__tests__/glob.test.ts` (describe `globEntries`; import `IS_CASE_INSENSITIVE_FS`)

**Interfaces:**
- Produces: `function foldPatternCase(pattern: string): string`. It turns each ASCII letter outside a `[...]` class into `[xX]`, which forces fs.glob to match by wildcard and yield on-disk names.

- [ ] **Step 1: Write the failing test** `'globEntries matches literal and wildcard segments case-insensitively on a case-insensitive filesystem'` (gated on `IS_CASE_INSENSITIVE_FS`)

The root holds `Upper.TXT`, `d/f01.txt` and `Node_Modules/x.txt`. Using the `walk` helper:
- `{ pattern: 'Upper.txt', baseNameMatch: true }` gives `['Upper.TXT']`.
- `{ pattern: '**/F01.TXT' }` gives `['d/f01.txt']`.
- `{ pattern: 'D/f01.txt' }` gives `['d/f01.txt']` (the on-disk spelling).
- `{ pattern: '**/*.txt', skipIgnored: true }` does not contain `'Node_Modules/x.txt'`.
- On a case-sensitive filesystem, `{ pattern: 'Upper.txt', baseNameMatch: true }` still gives `[]`. Assert this in an `else` branch.

- [ ] **Step 2: Run, expect FAIL.** Run: `npm test -- --test-name-pattern="case-insensitively"`

- [ ] **Step 3: Implement `foldPatternCase`.** Walk the chars and track bracket depth. Only `A-Za-z` outside brackets become classes, and non-ASCII stays as is (same rule as Task 1). Apply it only when `IS_CASE_INSENSITIVE_FS`.

- [ ] **Step 4: Run, expect PASS.** Then run `npm test -- --test-name-pattern="glob|find_files|scan"`.

- [ ] **Step 5: CHANGELOG. Commit** `fix(glob): match case-insensitively and report on-disk names on Windows and macOS`.

### Task 10: `search_text` clips long match and context lines

**Files:**
- Modify: `src/core/search.ts` (new constant and helper near `own` at `:16`; apply at `:386` (`content`) and `:389-390` (`before`/`after`))
- Test: `__tests__/tools.test.ts:4523` (after `'search_text context: a match beats context on a shared line…'`)

**Interfaces:**
- Produces: `export const MAX_MATCH_LINE_CHARS = 1000` and `function clipLine(line: string, column: number): string`. The helper returns a window of `MAX_MATCH_LINE_CHARS` UTF-16 units that starts at `max(0, column - 200)`. It never splits a surrogate pair. It prefixes `…[N chars] ` when it cut the start and suffixes ` […N chars]` when it cut the end, where N is the number of chars cut. Context lines use `column = 0`.

- [ ] **Step 1: Write the failing test** `'search_text clips a multi-megabyte match line and its context lines'`

The file holds `'ctx' + 'c'.repeat(2_000_000) + '\n' + 'x'.repeat(1_000_000) + 'NEEDLE' + 'x'.repeat(1_000_000) + '\n'`. Call with `context: 1`.
- The text length is under 5000.
- `structuredContent.matches[0].content` contains `'NEEDLE'`, starts with `'…['`, ends with `' chars]'` and has length < 1100.
- `column === 1_000_000`.
- `before[0].length < 1100` (Review Focus 5).

- [ ] **Step 2: Run, expect FAIL** (the 2 MB line is returned). Run: `npm test -- --test-name-pattern="clips a multi-megabyte"`

- [ ] **Step 3: Implement `clipLine`** and wrap the three `own(...)` call sites. Lines at or under the limit come back unchanged.

- [ ] **Step 4: Run, expect PASS.** Then run `npm test -- --test-name-pattern="search_text"`.

- [ ] **Step 5: CHANGELOG. Commit** `fix(search_text): clip match and context lines to 1000 chars`.

### Task 11: `replace_text` case-insensitive literals match natively (timeout)

**Files:**
- Modify: `src/core/search.ts:73-84,100,118-134`. Export `LiteralMatcher` and `createLiteralMatcher`. `needsRe2` takes `Buffer | string`. The Kelvin and long-s constants become strings. Add `export function foldAsciiCase(text: string): string`.
- Modify: `src/tools/replace-text.ts:35-42` (imports), after `:301` (new matcher), `:486-493` (`createReplacementMatcher` routing)
- Test: `__tests__/tools.test.ts:~3249` (after `'replace_text expands $ tokens exactly like String.prototype.replace'`)

**Interfaces:**
- Consumes: `createLiteralMatcher(needle: string, caseSensitive: boolean): LiteralMatcher | undefined`. It returns `undefined` for needles it cannot fold exactly like RE2.
- Produces: `function createCaseInsensitiveLiteralMatcher(searchPattern: string, literal: LiteralMatcher, fallback: ReplacementMatcher): ReplacementMatcher`.
  - Its `testBuffer` checks `needsRe2(buffer)`. If true it calls `fallback.testBuffer`, else `literal.mayMatch`.
  - Its `replace` checks `needsRe2(content)`. If true it delegates to `fallback`. Otherwise it runs one pass of `indexOf` over `foldAsciiCase(content)` and splices the original `content` at the same offsets.
  - Routing: when `!isRegex && !caseSensitive && !wholeWord` and `createLiteralMatcher` returns a matcher, use it with the RE2 matcher as `fallback`.

- [ ] **Step 1: Write the failing tests**

- `'replace_text case-insensitive literal replaces 300 matches in a 3 MB file well inside the deadline'`: the file is `` `${'x'.repeat(9990)} Needle\n`.repeat(300) `` and the needle is `'NEEDLE'`. Expect `stoppedReason === undefined`, `totalMatches === 300`, elapsed < 2000 ms, and the file equals `` `${'x'.repeat(9990)} pin\n`.repeat(300) ``.
- `'replace_text case-insensitive literal rewrites exactly what the escaped RE2 regex rewrites'`: copy the brief's 9-case table (Kelvin `key`→3, long-s `state`→3, dotted I `id`→2, emoji `needle`→2, `aa`→4, CRLF `line`→2, `Straße`→2, `e`→2, `a.b*c`→2). For each case, the literal run and the `isRegex: true` + `escapeRegExp` run give the same file bytes and the same `totalMatches`. Add `escapeRegExp` to the `../src/core/util.ts` import.

- [ ] **Step 2: Run, expect FAIL on test 1** (`stoppedReason: 'timeout'`). Run: `npm test -- --test-name-pattern="case-insensitive literal"`

- [ ] **Step 3: Implement** per the Interfaces block. Also update the stale comment at `replace-text.ts:255-257` and the one at `tools.test.ts:3238`.

- [ ] **Step 4: Run, expect PASS.** Then run `npm test -- --test-name-pattern="literal search matches what RE2|replace_text"`.

- [ ] **Step 5: CHANGELOG. Commit** `fix(replace_text): match case-insensitive literals natively`.

### Task 12: `replace_text` refuses output past the text size limit

**Files:**
- Modify: `src/tools/replace-text.ts:174-184` (`ReplacementMatcher.replace` signature), regex matcher `:244-274`, literal matcher `:289-296`, the Task 11 matcher, `ReplaceContext:305-313`, `processEntry:335-353`, context literal `:577-585`
- Test: `__tests__/tools.test.ts:3307` (after `'replace_text counts walked files over the text size limit in skippedTooLarge'`)

**Interfaces:**
- Produces the shared signature that Tasks 13-15 use:
  - `interface ReplaceLimits { maxMatches: number; maxBytes: number; path: string }`.
  - `ReplacementMatcher.replace(content: string, replacement: string, signal: AbortSignal | undefined, limits: ReplaceLimits): Promise<{ content: string; matchCount: number; more: boolean }>`.
  - In this task, `maxMatches` is always `Infinity` and `more` is always `false`.
- Produces `function outputTooLarge(limits: ReplaceLimits, cause?: unknown): FsError`. It builds `new FsError(ErrorCode.TOO_LARGE, \`Replacement result exceeds the size limit (more than ${maxBytes} bytes)\`, path, cause, OUTPUT_TOO_LARGE_SUGGESTION)`, with `OUTPUT_TOO_LARGE_SUGGESTION = "Narrow searchPattern or shorten the replacement; $\` and $' insert the whole text before/after each match."`.

- [ ] **Step 1: Write the failing tests** (under `withEnv({ FS_MAX_FILE_SIZE: String(1024 * 1024) })`)

- `'replace_text refuses a $\` expansion that grows a file past the text size limit, dry run included'`: 44 KiB of `a`, `replacement: '$\`'`, `isRegex: true`. For `dryRun` true and false, expect `isError`, `error.code === 'TOO_LARGE'`, `error.message === 'Replacement result exceeds the size limit (more than 1048576 bytes)'`, and the file unchanged.
- `'replace_text fails only the walked file whose literal replacement outgrows the limit'`: `blow.txt` holds `'x'.repeat(1000)` and `ok.txt` holds `'x\n'`. With replacement `'y'.repeat(2000)` and `caseSensitive: true`, expect `summary` to deep-equal `{ total: 2, succeeded: 1, failed: 1 }`, `blow.txt` unchanged, and `ok.txt` equal to `'y'.repeat(2000) + '\n'`.
- `'replace_text caps the result in UTF-8 bytes, not UTF-16 units, and allows exactly the limit'`: replace `'a'`→`'€'` with `caseSensitive: true`. On `'a'.repeat(349526)` the result is 349526 units but 1048578 bytes, so it is refused and the file is unchanged. On `'a'.repeat(349525) + 'b'` the result is exactly 1048576 bytes, so it is written, and `stat().size === 1048576`.

- [ ] **Step 2: Run, expect FAIL.** Run: `npm test -- --test-name-pattern="outgrows|size limit, dry run|caps the result in UTF-8"`

- [ ] **Step 3: Implement.**
  - In the regex loop, after each `updated +=`, throw `outputTooLarge` when `updated.length > maxBytes` (UTF-16 length is a lower bound on bytes). Map a `RangeError` from the loop to `outputTooLarge`.
  - The literal matchers keep a running size and check it the same way.
  - In `processEntry`, before `write.started = true`, throw when `Buffer.byteLength(content, 'utf8') > maxBytes`.
  - Set `maxBytes: getMaxTextFileSize()` once per call.

- [ ] **Step 4: Run, expect PASS.** Then run `npm test -- --test-name-pattern="replace_text"`.

- [ ] **Step 5: CHANGELOG. Commit** `fix(replace_text): refuse results past the text size limit`.

### Task 13: `replace_text` `maxMatches` is a strict bound

**Files:**
- Modify: `src/tools/replace-text.ts`:
  - the matchers stop at `limits.maxMatches` and set `more`;
  - `ReplaceContext` gains `remaining: number`;
  - in `processEntry`, `maxMatches` is `ctx.remaining`, which is decremented by `matchCount`; `more` sets `ctx.cut`;
  - scan `concurrency: explicitCap ? 1 : REPLACE_CONCURRENCY` (`:599`);
  - the stop text at `:734-740` says `later matches were not replaced`;
  - `stoppedReason: 'maxMatches'` when `ctx.cut`.
- Modify: `docs/client-guide.md:424-429`. The cap is strict, and a named file honors an explicit cap.
- Modify: `__tests__/tools.test.ts:3757-3767` (rewrite the named-file test), `:3769-3788` (tighten the alias test to an exact count)
- Test: `__tests__/tools.test.ts` (after `:3788`)

**Interfaces:**
- Consumes: `ReplaceLimits` and `more` from Task 12.
- `explicitCap = args.maxMatches ?? args.maxResults`. Without one, a named file runs with `maxMatches: Infinity` (`sed -i`), and a walk keeps today's `DEFAULT_SEARCH_RESULTS` cap at file granularity.

- [ ] **Step 1: Write the failing tests**

- `'replace_text on a named file stops at an explicit maxMatches mid-file'`: on `'x x x x\n'` with `maxMatches: 2`, expect `totalMatches === 2`, `stoppedReason === 'maxMatches'`, the file equal to `'y y x x\n'`, and the text matching `/hit the maxMatches limit; later matches were not replaced/u`. With `caseSensitive: true` and `maxMatches: 3`, expect `'y y y x\n'`.
- `'replace_text on a named file with no maxMatches replaces past the default cap'`: `'x '.repeat(150)` in a dry run gives `totalMatches === 150` and no `stoppedReason`.
- `'replace_text maxMatches is a strict bound across files'`: 10 files of `'x\n'` with `maxMatches: 3` give `totalMatches === 3` and `summary.succeeded === 3`. Exactly 3 files read `'y\n'`. Don't assert which 3: readdir order is not sorted on Linux.
- `'replace_text maxMatches dry run previews exactly what the live run writes'` (Review Focus 2): on `'x x x x\n'` with `maxMatches: 2`, the dry-run diff contains `+y y x x`. The live run then writes `'y y x x\n'`, and both runs report `totalMatches === 2`.

- [ ] **Step 2: Run, expect FAIL.** Run: `npm test -- --test-name-pattern="maxMatches|replace_text maxResults"`

- [ ] **Step 3: Implement** per the Files list. The regex matcher breaks at the top of the loop when `matchCount === limits.maxMatches`. The literal matchers use a `replaceAll` callback that returns the match itself once the limit is reached.

- [ ] **Step 4: Run, expect PASS.** Then run the whole `replace_text` group.

- [ ] **Step 5: CHANGELOG (note the behavior change for named files). Commit** `fix(replace_text): enforce maxMatches strictly`.

### Task 14: `replace_text` literal text follows a CRLF file's line endings

**Files:**
- Modify: `src/core/util.ts` (after `escapeRegExp:122`, move `usesCrlf`/`toCrlf` and their comment from `src/tools/edit.ts:290-301`), `src/tools/edit.ts:20` (import), `src/tools/replace-text.ts:43-49` (import), `ReplaceContext` (`crlf?: { matcher: ReplacementMatcher; replacement: string }`), `handleSearchAndReplace` (build it after `createReplacementMatcher`, dispose it in `finally`), `processEntry` (pick per file)
- Test: `__tests__/tools.test.ts` (after `'replace_text regex mode on a file past the RE2 input cap fails that file with TOO_LARGE'`)

**Interfaces:**
- Produces: `export function usesCrlf(content: string): boolean` and `export function toCrlf(text: string): string`, moved verbatim.
- Rule: when `!isRegex` and the file is all-CRLF, use `toCrlf(searchPattern)` and `toCrlf(replacement)`. Regex and mixed-ending files are taken as written.

- [ ] **Step 1: Write the failing test** `'replace_text converts LF literal text to CRLF in a CRLF file'`

- `'one\r\ntwo\r\nthree\r\n'`, `'one\ntwo'`→`'uno\ndos'` with `caseSensitive: true` gives `'uno\r\ndos\r\nthree\r\n'`.
- `'One\r\nTwo\r\n'`, `'one\ntwo'`→`'x\ny'` (default case) gives `'x\r\ny\r\n'`.
- `'a\r\nb\r\n'`, `'\nb'`→`'\nc'` gives `'a\r\nc\r\n'`.
- `'one\r\ntwo\r\n'`, `'two'`→`'two\nhalf'` gives `'one\r\ntwo\r\nhalf\r\n'`.
- The mixed file `'mixed\r\nlf\n'` stays unchanged.
- With `isRegex`, `'one\ntwo'` on a CRLF file stays unchanged.

- [ ] **Step 2: Run, expect FAIL.** Run: `npm test -- --test-name-pattern="replace_text converts LF"`

- [ ] **Step 3: Implement.** The CRLF matcher is built once per request through `createReplacementMatcher({ ...args, searchPattern: toCrlf(args.searchPattern) })`. It passes the same `ReplaceLimits` as Tasks 12-13.

- [ ] **Step 4: Run, expect PASS.** Then run `npm test -- --test-name-pattern="replace_text|ignoreWhitespace|edit"`.

- [ ] **Step 5: CHANGELOG. Commit** `fix(replace_text): convert LF literal text in CRLF files`.

### Task 15: `replace_text` `wholeWord` uses Unicode word boundaries

**Files:**
- Modify: `src/tools/replace-text.ts`: near `DOLLAR_TOKEN` (`WORD_CLASS`, `WORD_CHAR`, `isWordCharAt`), `buildSearchPattern:478-484`, `createRegexReplacementMatcher:227` (new `wholeWord` param), `createReplacementMatcher:490`
- Test: `__tests__/tools.test.ts:~3974` (after `'replace_text and edit splice correctly past astral characters'`)

**Interfaces:**
- Produces: `const WORD_CLASS = String.raw\`\p{L}\p{N}\p{M}_\``, `const WORD_CHAR = new RegExp(\`[${WORD_CLASS}]\`, 'uy')`, `function isWordCharAt(text: string, index: number): boolean` and `function createRegexReplacementMatcher(regex: Regex, expandReplacement: boolean, wholeWord: boolean): ReplacementMatcher`.
- Pattern: `` `(^|[^${WORD_CLASS}])(?:${needle})` ``. The lead boundary is consumed and captured. The trailing boundary is checked in JS at `match.end`, so adjacent words keep their shared separator. The splice offset becomes `match.start + lead.length`, and the caller's groups are `match.groups.slice(1)`.

- [ ] **Step 1: Write the failing tests**

- `'replace_text wholeWord treats non-ASCII letters and punctuation edges as word boundaries'` (the brief's 6 cases):
  - `café cafés xcafé` gives `X cafés xcafé` (1 match);
  - `über Über xüber über_` gives `X X xüber über_` (2 matches);
  - `-x a-x a -x` gives `Y a-x a Y` (2 matches);
  - `a a a` gives `b b b` (3 matches);
  - `x\u0301 x` gives `x\u0301 Y` (1 match);
  - `😀über über😀 ü` gives `😀X X😀 ü` (2 matches).
- `'replace_text wholeWord with isRegex keeps the caller capture groups numbered from 1'`: `(a)(b)`→`$2$1[$&]` on `'ab xab ab\n'` gives `'ba[ab] xab ba[ab]\n'`.

- [ ] **Step 2: Run, expect FAIL.** Run: `npm test -- --test-name-pattern="wholeWord"`

- [ ] **Step 3: Implement.** A match whose next char is a word char is skipped, and the loop keeps its `tick()`. Add `// shortcut: a rejected regex match does not retry a longer alternative ('foo|foobar' on 'foobar'); fix with a second exec from match.start if reported.`

- [ ] **Step 4: Run, expect PASS.** Then run the whole `replace_text` group.

- [ ] **Step 5: CHANGELOG. Commit** `fix(replace_text): use Unicode word boundaries for wholeWord`.

### Task 16: Final verification

- [ ] **Step 1:** `npm run check`. Expected: exit 0 and coverage above the floor.
- [ ] **Step 2:** `npm run build`, then rerun the stress repros through `tmp/stress/probe.mjs`. That means the Kelvin read, the 3 MB `NEEDLE` replace, `maxMatches: 2` and the `$\`` blow-up. Each must now give the fixed result.
- [ ] **Step 3:** Run the concurrency tests in WSL pinned to 2 CPUs (see the memory note `ci-low-cpu-concurrency`).
- [ ] **Step 4:** Open the PR with `writeup:pr`. List the two behavior changes: non-ASCII case variants are refused, and `maxMatches` is strict on named files.
