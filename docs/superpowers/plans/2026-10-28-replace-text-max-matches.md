# replace_text maxMatches implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `replace_text`'s total match cap is called `maxMatches`.
`maxResults` stays as a deprecated alias for one release, and a stop at the
cap reports `stoppedReason: 'maxMatches'`.

**Architecture:** This is a schema-level rename in `src/tools/replace-text.ts`.
The schema rejects calls that pass both fields, copying the `path`/`paths`
rule in `src/core/schema.ts:173-199`. `scan()` keeps emitting `'maxResults'`
for its weighted cap, and `replace_text` translates that value to
`'maxMatches'` in its own result, so `scan.ts` doesn't change.

**Tech Stack:** TypeScript, zod 4 (`.meta({ deprecated: true })`), Node test runner.

**Spec:** `docs/adr/005-one-scan-rule-for-every-walking-tool.md:61-71`,
plus decisions from the 2026-10-28 grilling: rename only; the alias lives
for one release; `stoppedReason` gets a new `'maxMatches'` value; a call
that passes both fields is rejected.

## Global Constraints

- `maxMatches`: `z.uint32().min(1).max(MAX_SEARCH_RESULTS)`, optional, with no zod `.default`; the code supplies `DEFAULT_SEARCH_RESULTS`. Description: `Maximum total match count across all files before stopping (default: ${DEFAULT_SEARCH_RESULTS})`.
- `maxResults`: the same bounds, `.meta({ deprecated: true })`, description `Deprecated alias of maxMatches; removed in the next release`.
- A call that passes both fields fails with the issue message `Cannot use both 'maxMatches' and 'maxResults'`.
- The list `maxDepth` base and the 20000 cap stay out of scope (Scan plan, PR 3). So does `maxFiles`.
- Regenerate the contract snapshot with no `FS_*` variables set: `node --test --test-update-snapshots __tests__/contract.test.ts`.

## Review Focus

1. **A client sending only `maxResults`:** the cap works exactly as before. Task 1 tests this.
2. **A named single file:** it ignores the cap with either name (`__tests__/tools.test.ts:3730-3740`). Task 1 switches that test to `maxMatches`, and adds an alias case.
3. **The published schema keeps `deprecated: true`:** check the snapshot diff in Task 1. If the SDK's JSON Schema conversion drops the key, stop and report.
4. **`maxFiles` stops:** they still report `stoppedReason: 'maxFiles'`. Task 2 tests this.
5. **The stop text:** it tells the client to raise `maxMatches`, not `maxResults`. Task 2 tests this.

---

### Task 1: `maxMatches`, with `maxResults` as a deprecated alias

**Files:**

- Modify: `src/tools/replace-text.ts:82-96` (schema) and `:570` (`cap`)
- Modify: `__tests__/contract.test.ts.snapshot` (regenerated)
- Modify: `docs/client-guide.md:422`, `CHANGELOG.md` (`[Unreleased]`)
- Test: `__tests__/tools.test.ts` (the replace_text describe block)

**Interfaces:**

- Produces: `args.maxMatches?: number` and `args.maxResults?: number`. Task 2 reads neither.

- [ ] **Step 1: Write the failing tests**
  - Change `tools.test.ts:3730-3740` and `:3810-3829` to pass `maxMatches`.
  - Add `replace_text maxResults still caps as a deprecated alias`: with `maxResults: 1` over two matching files, `totalMatches === 1`.
  - Add `replace_text rejects maxMatches with maxResults`: `isError === true`, and the text matches `/Cannot use both 'maxMatches' and 'maxResults'/`.
  - Add `replace_text publishes maxResults as deprecated`: from `client.listTools()`, `inputSchema.properties.maxResults.deprecated === true`, and `properties.maxMatches` is defined.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `npm test -- --test-name-pattern="replace_text"`
  Expected: FAIL. `maxMatches` is an unrecognised key in a strict object.

- [ ] **Step 3: Implement the schema, the refinement and the cap**
  - Apply the field definitions from Global Constraints.
  - Close the strict object with `.superRefine`, which adds a `custom` issue at `path: ['maxResults']` when both fields are set.
  - Set `cap: args.maxMatches ?? args.maxResults ?? DEFAULT_SEARCH_RESULTS`.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `npm test -- --test-name-pattern="replace_text"`
  Expected: PASS.

- [ ] **Step 5: Regenerate the contract snapshot and read its diff**

  Run: `node --test --test-update-snapshots __tests__/contract.test.ts`, then `git diff __tests__/contract.test.ts.snapshot`.
  Expected: only `CONTRACT-001`'s replace_text properties change. `maxMatches` is added, and `maxResults` gains `"deprecated": true`.

- [ ] **Step 6: Update the docs**
  - `client-guide.md:422`: `` `maxMatches` stops a run once that many matches are replaced; it does not shorten the scan itself… ``. Keep the sentence's existing point about a narrower path, pattern or maxDepth.
  - `CHANGELOG.md`: under `### Changed`, add `**`replace_text`'s match cap is `maxMatches`.** Before, it was `maxResults`, which is a page size in every other tool.`
  - `CHANGELOG.md`: add a new `### Deprecated` section, in the `FS_MAX_INLINE_MATCHES` voice (`CHANGELOG.md:1645-1649`): `**`replace_text`'s `maxResults`** is read as `maxMatches`. Use `maxMatches`; `maxResults` is removed in the next release.`

- [ ] **Step 7: Commit**

  ```bash
  git add src/tools/replace-text.ts __tests__/tools.test.ts __tests__/contract.test.ts.snapshot docs/client-guide.md CHANGELOG.md
  git commit -m "feat(replace_text): name the match cap maxMatches; keep maxResults as an alias"
  ```

### Task 2: A stop at the cap reports `maxMatches`

**Files:**

- Modify: `src/core/concurrency.ts:4` (`StoppedReason`)
- Modify: `src/tools/replace-text.ts:510` (structured value) and `:704-709` (stop text)
- Modify: `docs/client-guide.md:398`, `CHANGELOG.md`
- Test: `__tests__/tools.test.ts`

**Interfaces:**

- Produces: `type StoppedReason = 'maxResults' | 'maxMatches' | 'maxFiles' | 'timeout'`. `scan()` never emits `'maxMatches'`.

- [ ] **Step 1: Write the failing tests**
  - In the dry-run preview test at `:3810-3829`, expect `_meta.stoppedReason === 'maxMatches'`, and the text `// scan stopped early: hit the maxMatches limit;`.
  - Add `replace_text maxFiles stop keeps its reason`: with `maxFiles: 1` over two matching files, `stoppedReason === 'maxFiles'`.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `npm test -- --test-name-pattern="replace_text"`
  Expected: FAIL, with the reason reading `'maxResults'`.

- [ ] **Step 3: Implement the translation**
  - Widen `StoppedReason`.
  - At `:510`, map the scan's `'maxResults'` to `'maxMatches'`. Pass `'maxFiles'` and `'timeout'` through unchanged.
  - The text at `:704-709` already interpolates the structured value. Update its comment to name `maxMatches`/`maxFiles`.

- [ ] **Step 4: Update the docs**
  - `client-guide.md:398`: add `maxMatches` to the listed `stoppedReason` values, noting it is replace_text's cap.
  - `CHANGELOG.md` `### Changed`: `**`replace_text`reports`stoppedReason: 'maxMatches'`when it hits its match cap.** Before, it reported`'maxResults'`.`

- [ ] **Step 5: Run the full check**

  Run: `npm run check`
  Expected: PASS. `TOOL-SURFACE-001` (`tools.test.ts:4862`) still passes, and the snapshot matches Task 1's.

- [ ] **Step 6: Commit**

  ```bash
  git add src/core/concurrency.ts src/tools/replace-text.ts __tests__/tools.test.ts docs/client-guide.md CHANGELOG.md
  git commit -m "feat(replace_text): report a match-cap stop as maxMatches"
  ```
