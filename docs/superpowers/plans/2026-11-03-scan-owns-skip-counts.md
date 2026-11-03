# Scan skip counts implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Scan counts every content skip and refuses a skipped named file, so `search_text` and `replace_text` report the same ruling the same way.

**Architecture:** A Scan callback returns a `ScanSkip` value beside its normal result. The Scan counts it, drops it from `results`, and reports `skippedBinary` and `skippedTooLarge` on `ScanOutcome`. The first PR moves the counters with no client-visible change; the second makes the agreed visible changes.

**Tech Stack:** TypeScript on Node 24, Node's built-in test runner, `__tests__/tool-harness.ts`.

**Spec:** the decisions below, settled in the 2026-11-03 grilling of the "Give the Scan all its counters" candidate. ADR-005 (`docs/adr/005-one-scan-rule-for-every-walking-tool.md`) is the governing decision.

## Decisions

| Decision         | Choice                                                    |
| :--------------- | :-------------------------------------------------------- |
| Skip signal      | Callback returns a skip value; Scan counts and drops it   |
| `filesScanned`   | Every file ruled on: the Scan's `scanned`, in all 3 tools |
| Binary in search | Reported in text; counts as incomplete for the hint       |
| Stop overlays    | Stay in the tools; the Scan gets no stop hook             |
| Named-file skip  | Fails the call from inside the Scan                       |
| Undecodable      | Stays in `skippedBinary`; no new wire field               |
| Skip text        | One `// skipped ...` line, `replace_text` included        |
| Named refusals   | `readNamedText`'s, for `search_text` and `replace_text`   |
| Delivery         | 2 PRs; ADR-005 addendum and CHANGELOG in the second       |

## Global Constraints

- PR 1 changes nothing a client can see: no `.snapshot` diff, no CHANGELOG entry, and only the `rewrite.test.ts` expectations in Task 2 change among existing tests.
- `replace_text` keeps reading inside its callback, under the write lock (ADR-005).
- A sensitive entry is never counted (ADR-005).
- Never hand-edit a version in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json` or `.cursor-plugin/plugin.json`.
- Run `npm run check` before each PR. `scan.ts` admission is concurrency-sensitive, so also run, from PowerShell: `wsl bash -lc "source ~/.nvm/nvm.sh && cd /mnt/c/filesystem-mcp && taskset -c 0,1 node --test __tests__/scan.test.ts __tests__/replace-text.test.ts __tests__/search.test.ts"`.
- Do not change `ScanOutcome.scanned`'s meaning: entries whose `onEntry` resolved, a skip included.

## Review Focus

1. A batch where every file is skipped: `search_text` must not guess about the pattern. Task 4 pins it.
2. Page two of a paged search: the skip line must still appear, because it reads the stored metadata. Task 4 pins it.
3. A named binary under `replace_text` with `dryRun: true`: it is refused, and the matcher is still disposed by the existing `finally`. Task 5 pins the refusal.
4. A sensitive file that would also be binary: no count, because admission drops it before the callback. Task 1 pins it.
5. A skip at the match cap or `maxFiles`: a skip weighs nothing against `cap` but still spends a `maxFiles` slot, as it does today. Task 1 pins both.

---

# PR 1: `refactor/scan-owns-skip-counts`

### Task 1: `ScanSkip` and the Scan's counters

**Files:**

- Modify: `src/core/scan.ts`
- Test: `__tests__/scan.test.ts`

**Interfaces:**

- Produces, from `src/core/scan.ts`:
  ```ts
  export type SkipVerdict =
    | { readonly kind: 'binary'; readonly utf16: boolean }
    | { readonly kind: 'undecodable' }
    | { readonly kind: 'tooLarge'; readonly size: number };
  export class ScanSkip {
    constructor(readonly verdict: SkipVerdict) {}
  }
  /** A non-text content verdict as a skip; drops an undecodable file's bytes. */
  export function skipOf(verdict: Exclude<TextVerdict, { kind: 'text' }>): ScanSkip;
  ```
- `scan<R>`'s `onEntry` becomes `(entry: ScanEntry) => Promise<R | ScanSkip | undefined>`.
- `ScanOutcome<R>` gains `readonly skippedBinary: number` and `readonly skippedTooLarge: number`. `tooLarge` counts as too large; `binary` and `undecodable` count as binary.

- [ ] **Step 1: Write the failing tests** in `describe('scan')`, using the file's `base()` and `writeTestFile`:

  ```ts
  it('counts a returned skip and drops it from results', async () => {
    for (const name of ['a.bin', 'b.txt', 'c.big', 'd.txt']) await writeTestFile(root, name, 'x');
    const verdicts: Record<string, ScanSkip | undefined> = {
      'a.bin': new ScanSkip({ kind: 'binary', utf16: false }),
      'b.txt': new ScanSkip({ kind: 'undecodable' }),
      'c.big': new ScanSkip({ kind: 'tooLarge', size: 9 }),
    };
    const outcome = await scan({ root }, base({ concurrency: 1 }), (e) =>
      Promise.resolve(verdicts[basename(e.path)] ?? e.path),
    );
    assert.deepEqual(outcome.results, [join(root, 'd.txt')]);
    assert.strictEqual(outcome.scanned, 4);
    assert.strictEqual(outcome.skippedBinary, 2);
    assert.strictEqual(outcome.skippedTooLarge, 1);
  });
  ```

  Add these beside it:
  - `'a skip weighs nothing against the cap'`: 3 files, `cap: 1`, the first two skipped, the third a result; assert 1 result and no `stoppedReason`.
  - `'a skip spends a maxFiles slot'`: 3 files, `maxEntries: 2`, `concurrency: 1`, all skipped; assert `scanned === 2`, `skippedBinary === 2`, `stoppedReason === 'maxFiles'`.
  - `'a sensitive file is never counted as a skip'`: `.env` plus `a.txt`, a callback that skips every entry; assert `skippedBinary === 1`.
  - `'counts a skip on a named file'`: `scan({ root, explicitFile }, base(), () => Promise.resolve(new ScanSkip({ kind: 'binary', utf16: false })))`; assert `results` empty, `scanned === 1`, `skippedBinary === 1`. Task 5 replaces this test.

- [ ] **Step 2: Run them to confirm they fail**

  Run: `node --test --test-name-pattern="skip" __tests__/scan.test.ts`
  Expected: FAIL, `ScanSkip` is not exported.

- [ ] **Step 3: Implement in `src/core/scan.ts`**

  In `visitAdmitted`, after `onScanned?.(scanned)`: if `result instanceof ScanSkip`, count it and return before the `results.set` and `weigh` lines. Make `scanNamedFile` count the same way, and add zeros to its `timedOut` object. Use one local helper for the kind-to-counter rule.

- [ ] **Step 4: Run the Scan tests**

  Run: `node --test __tests__/scan.test.ts`
  Expected: PASS. Existing callbacks return no skips, so their counts are 0.

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/scan.ts __tests__/scan.test.ts
  git commit -m "refactor(scan): count a skip a callback returns"
  ```

### Task 2: Callers return skips

**Files:**

- Modify: `src/core/rewrite.ts`, `src/core/search.ts`, `src/tools/replace-text.ts`
- Test: `__tests__/rewrite.test.ts:215-218`

**Interfaces:**

- Consumes: `ScanSkip`, `skipOf`, `ScanOutcome.skippedBinary`, `ScanOutcome.skippedTooLarge` from Task 1.
- Produces: `rewriteEntry<T>` returns `Promise<Rewritten<T> | ScanSkip | undefined>`. The `Skipped` type is deleted.

- [ ] **Step 1: Update the expectations in `rewrite.test.ts:215-218`**

  ```ts
  'a.png': new ScanSkip({ kind: 'binary', utf16: false }),
  'bom.txt': new ScanSkip({ kind: 'binary', utf16: true }),
  'late.txt': new ScanSkip({ kind: 'undecodable' }),
  'big.txt': new ScanSkip({ kind: 'tooLarge', size: MIB + 1 }),
  ```

- [ ] **Step 2: Run it to confirm it fails**

  Run: `node --test __tests__/rewrite.test.ts`
  Expected: FAIL on `rewriteEntry returns the verdict without transforming`.

- [ ] **Step 3: Change the callers**

  - `rewrite.ts`: `rewriteEntry` returns `skipOf(verdict)` for any non-text verdict. Delete `Skipped`.
  - `search.ts`: `FileScan` becomes `{ matches: SearchResult[]; cut?: boolean }`. `scanFile` returns `Promise<FileScan | ScanSkip>`: `skipOf(verdict)` for too large or binary, `new ScanSkip({ kind: 'binary', utf16: false })` for undecodable bytes holding a NUL, and `new ScanSkip({ kind: 'tooLarge', size: buffer.length })` for an overlong line. In `searchContent`, `weigh` becomes `(s) => s.matches.length`. Delete `skippedTooLarge`/`skippedBinary` locals and read them from `outcome`. To keep PR 1 invisible, set `filesScanned: outcome.scanned - outcome.skippedTooLarge`.
  - `replace-text.ts`: `processEntry` returns `done` when `done instanceof ScanSkip`, after its existing `singleFile` throw reads `done.verdict`. Delete `{ kind: 'binary' }` and `{ kind: 'tooLarge' }` from `EntryOutcome`, the two `switch` cases, and `skippedBinary`/`skippedTooLarge` from `ReplaceSummary`. `buildSearchAndReplaceStructuredResult` reads both from `outcome`.

- [ ] **Step 4: Run the full check**

  Run: `npm run check`
  Expected: PASS, no `.snapshot` diff, and no other test edited.

- [ ] **Step 5: Run the 2-CPU pass from Global Constraints**

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/core/rewrite.ts src/core/search.ts src/tools/replace-text.ts __tests__/rewrite.test.ts
  git commit -m "refactor(scan): search and replace hand their skips to the Scan"
  ```

---

# PR 2: `feat/scan-skip-reporting`, on top of PR 1

### Task 3: `filesScanned` means every file ruled on

**Files:**

- Modify: `src/core/search.ts`, `src/tools/find-files.ts:142`
- Test: `__tests__/search-text.test.ts`, `__tests__/find-files.test.ts`

**Interfaces:**

- Consumes: `ScanOutcome.scanned`.

- [ ] **Step 1: Write the failing tests**

  In `search-text.test.ts`, add `'counts a file over the size limit in filesScanned'`: under `withEnv({ FS_MAX_FILE_SIZE: '1048576' })`, one over-limit file and one small file; assert `structured.filesScanned === 2` and `structured.skippedTooLarge === 1`.

  In `find-files.test.ts`, add `'reports filesScanned from the Scan'`: 3 files; assert `filesScanned === 3`. It pins the source; the number does not move here.

- [ ] **Step 2: Run them to confirm the search test fails**

  Run: `node --test --test-name-pattern="filesScanned" __tests__/search-text.test.ts __tests__/find-files.test.ts`
  Expected: `search-text` FAIL with 1 !== 2; `find-files` PASS.

- [ ] **Step 3: Implement**

  `search.ts`: `filesScanned: outcome.scanned`. `find-files.ts`: `filesScanned: scanned.scanned`.

- [ ] **Step 4: Run the tests**

  Run: `node --test __tests__/search-text.test.ts __tests__/find-files.test.ts __tests__/search.test.ts __tests__/search-literal.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/search.ts src/tools/find-files.ts __tests__/search-text.test.ts __tests__/find-files.test.ts
  git commit -m "fix(scan): filesScanned counts every file the scan ruled on"
  ```

### Task 4: One skip line and one incomplete rule

**Files:**

- Modify: `src/core/fmt.ts`, `src/tools/search-text.ts`, `src/tools/replace-text.ts`
- Test: `__tests__/search-text.test.ts`, `__tests__/replace-text.test.ts:293,458,500,1124`

**Interfaces:**

- Produces, from `src/core/fmt.ts`:
  ```ts
  interface SkipCounts {
    skippedTooLarge?: number | undefined;
    skippedBinary?: number | undefined;
    skippedInaccessible?: number | undefined;
  }
  /** `// skipped ...; results may be incomplete.`, or '' with nothing skipped. */
  export function skippedLine(counts: SkipCounts): string;
  ```
- `pageTrailer`'s parameter gains `skippedBinary`, and it calls `skippedLine`.
- Line order: too large, binary, inaccessible. Binary wording: `formatCount(n, 'binary file')`.

- [ ] **Step 1: Write and update the tests**

  `search-text.test.ts`:

  ```ts
  it('reports a binary skip and gives no pattern hint when every file was skipped', async () => {
    const dir = join(root, 'only_binary');
    await writeFile(join(dir, 'b.bin'), Buffer.from([0, 0x61, 0x7c, 0x62, 0]));
    const { text } = await search({ path: dir, searchPattern: 'a|b' });
    assert.strictEqual(
      text,
      "No matches for 'a|b'\n\n// skipped 1 binary file; results may be incomplete.",
    );
  });
  ```

  Create `dir` with `mkdir` first. Also add `'keeps the skip line on a later page'`: enough matches to page with `maxResults: 1` plus one binary file; request the second page by `cursor`; assert the skip line is in its text.

  Update the expectation at line 526:

  ```ts
  'search_bin/text.txt:1: BINNEEDLE\n\n// skipped 1 binary file; results may be incomplete.';
  ```

  `replace-text.test.ts`:
  - 293: `/\/\/ skipped 2 files over the text size limit/`
  - 458: `/\/\/ skipped 2 binary files/`
  - 500: `/1 inaccessible entry/u`
  - 1124: `"replace_text: 'a|b' [dry run] · 0 match(es) in 0 file(s)\n// skipped 1 binary file; results may be incomplete."`

- [ ] **Step 2: Run them to confirm they fail**

  Run: `node --test __tests__/search-text.test.ts __tests__/replace-text.test.ts`
  Expected: FAIL on exactly the tests above.

- [ ] **Step 3: Implement**

  - `fmt.ts`: add `skippedLine`, and use it in `pageTrailer`.
  - `search-text.ts`: pass `skippedBinary` to `pageTrailer`, and add `structured.skippedBinary` to the `incomplete` expression.
  - `replace-text.ts`: delete the three `· N ... skipped` segments from `summaryText`; push `skippedLine(structured)` right after the stop line when non-empty. The `incomplete` expression is unchanged.

- [ ] **Step 4: Run the full test suite**

  Run: `npm test`
  Expected: PASS. If another test had a binary file beside its matches, update only its expected text to include the skip line.

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/fmt.ts src/tools/search-text.ts src/tools/replace-text.ts __tests__/search-text.test.ts __tests__/replace-text.test.ts
  git commit -m "fix(search): name binary skips in one line shared with replace_text"
  ```

### Task 5: A skip on a named file fails the call

**Files:**

- Modify: `src/core/scan.ts`, `src/core/search.ts`, `src/tools/replace-text.ts`
- Test: `__tests__/scan.test.ts`, `__tests__/search-text.test.ts`, `__tests__/replace-text.test.ts:274-282,434-441,463-471`

**Interfaces:**

- Consumes: `ScanSkip`, `SkipVerdict`.
- Produces: `ScanOptions<R>` gains `readonly tool?: string`, used only in the too-large wording. `searchContent` passes `'search_text'`; `replace_text` passes `'replace_text'`.
- Internal to `scan.ts`: `function refusalOf(verdict: SkipVerdict, filePath: string, tool: string | undefined): FsError`, moved out of `readNamedText`'s `switch`. `readNamedText` keeps calling it, so its wording does not change.

- [ ] **Step 1: Write and update the tests**

  `scan.test.ts`: replace `'counts a skip on a named file'` with:

  ```ts
  it('a skip on a named file fails the call', async () => {
    const file = await writeTestFile(root, 'a.txt', 'x');
    await assert.rejects(
      scan({ root, explicitFile: file }, base({ tool: 'search_text' }), () =>
        Promise.resolve(new ScanSkip({ kind: 'tooLarge', size: 9 })),
      ),
      fsErrorMatcher(ErrorCode.TOO_LARGE, /^File too large for search_text \(9 bytes/),
    );
  });
  ```

  `search-text.test.ts`, each with `assert.rejects` and `fsErrorMatcher`:
  - `'refuses a named binary file'`: `ErrorCode.BINARY_FILE`.
  - `'refuses a named UTF-16 file'`: a `\xFF\xFE` BOM; `ErrorCode.INVALID_INPUT`, `/UTF-16/`.
  - `'refuses a named file with an overlong regex line, and names the line'`: the `search.test.ts:51` body, `isRegex: true`; `ErrorCode.TOO_LARGE`, `/line/`.
  - `'still searches a named undecodable file lossily'`: the `late-latin1.txt` shape from `core-fs.test.ts:946`; assert 1 match.

  `replace-text.test.ts`: the refusal now leaves `run`, so these use `assert.rejects(runToolBodyResult(REPLACE_TEXT, args, { fs }), matcher)`:
  - 274: `fsErrorMatcher(ErrorCode.TOO_LARGE, /^File too large for replace_text/)`; the file stays untouched.
  - 434 and 463: `ErrorCode.BINARY_FILE`.
  - Add `'refuses a named binary file on a dry run'`: `dryRun: true`, `ErrorCode.BINARY_FILE`.
  - Add `'refuses a named late non-UTF-8 file'`: `ErrorCode.INVALID_INPUT`, `/non-UTF-8/`.

  Keep 373 and 390 as they are: a replacement that grows a file is still a failure row.

- [ ] **Step 2: Run them to confirm they fail**

  Run: `node --test __tests__/scan.test.ts __tests__/search-text.test.ts __tests__/replace-text.test.ts`
  Expected: FAIL on the tests above, except the lossy-search test, which passes.

- [ ] **Step 3: Implement**

  - `scan.ts`: extract `refusalOf`. `scanNamedFile` throws `refusalOf(result.verdict, explicitFile, options.tool)` when `result instanceof ScanSkip`.
  - `search.ts`: pass `tool: 'search_text'`. Add `named: boolean` to `ScanContext`, from `scope.explicitFile !== undefined`. For a named file with an overlong line, throw `new FsError(ErrorCode.TOO_LARGE, 'A line in this file is too long for a regex search; use a literal searchPattern.', entryPath)`, because `File too large` would be false.
  - `replace-text.ts`: pass `tool: 'replace_text'`, and delete the refusal branch in `processEntry` with its imports. Keep `singleFile`: the `catch` still uses it, so other failures on a named file stay rows.

- [ ] **Step 4: Run the full check and the 2-CPU pass**

  Run: `npm run check`, then the command in Global Constraints.
  Expected: PASS. No `.snapshot` diff: tool descriptions do not change.

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/scan.ts src/core/search.ts src/tools/replace-text.ts __tests__/scan.test.ts __tests__/search-text.test.ts __tests__/replace-text.test.ts
  git commit -m "fix(scan): a skip on a named file fails the call"
  ```

### Task 6: Record the decisions

**Files:**

- Modify: `docs/adr/005-one-scan-rule-for-every-walking-tool.md`, `CHANGELOG.md`, `docs/client-guide.md:405-406`

- [ ] **Step 1: Append to ADR-005**

  ```markdown
  ## Addendum, 2026-11-03: the Scan counts content skips

  A callback still does the guarded read, so `replace_text` keeps its write
  lock, and returns a skip value that the Scan counts. `filesScanned` is every
  file ruled on, in every tool. A skip on a named file fails the call with
  `readNamedText`'s refusal.

  Stop reasons the Scan cannot see stay in the tools: a file cut mid-read in
  `search_text`, and a cap reached inside a file in `replace_text`. They are one
  or two lines on facts only that tool has, and they differ on purpose. A stop
  hook on the Scan would be about as wide as the code it hides.
  ```

- [ ] **Step 2: Update `CHANGELOG.md` under `[Unreleased]`**

  In the existing `### Changed` entry, delete `and `replace_text`'s `Binary or non-UTF-8 file detected.``, leaving the UTF-16 clause. Add:

  ```markdown
  - **`filesScanned` means every file a scan ruled on.** `search_text` left out files over the size limit, and `find_files` repeated its match count; both now match `replace_text`.
  - **`search_text` names binary skips.** Its text gains `// skipped N binary files; results may be incomplete.`, and a search with binary skips no longer guesses at the pattern on zero matches.
  - **`replace_text` reports skips in the same line.** The `· N binary skipped`, `· N too large skipped` and `· N inaccessible skipped` segments become one `// skipped ...` line.
  - **A named file that cannot be scanned fails the call.** `search_text` on a named binary or too-large file answered `No matches`; it now refuses. `replace_text`'s refusal of a named file leaves `results` empty of it, answers with the tool error text, and uses the refusals `read` and `edit` give: `BINARY_FILE`, `File too large for replace_text`, the UTF-16 advice.
  ```

- [ ] **Step 3: Extend the sentence in `docs/client-guide.md:405-406`**

  Replace it with:

  ```markdown
  does not follow a symlinked file. `_meta.skippedInaccessible` counts the entries
  and directories it could not read, and `_meta.skippedBinary` and
  `_meta.skippedTooLarge` count the files it would not read as text. A file you
  name yourself is refused instead of skipped.
  ```

- [ ] **Step 4: Run the full check**

  Run: `npm run check`
  Expected: PASS, including the format and docs checks.

- [ ] **Step 5: Commit**

  ```bash
  git add docs/adr/005-one-scan-rule-for-every-walking-tool.md CHANGELOG.md docs/client-guide.md
  git commit -m "docs: record that the Scan counts its content skips"
  ```
