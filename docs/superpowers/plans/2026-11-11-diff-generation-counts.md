# Diff generation counts implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return patch text and hunk-derived line counts from both Diff generation functions.

**Architecture:** `twoFilesPatch` already receives `StructuredPatch` from inline and worker execution. It will count hunk lines before formatting and return one `GeneratedPatch`, while all callers consume that result instead of parsing patch text.

**Tech Stack:** TypeScript, Node.js built-in test runner, `diff` 9, worker threads, npm.

**Spec:** `docs/superpowers/specs/2026-11-11-diff-generation-counts-design.md`

## Global Constraints

- Count from `StructuredPatch.hunks`; never parse formatted file headers.
- Preserve `undefined` for deadline, worker failure, and queue saturation.
- Preserve patch text, header quoting, timeout behavior, and advertised MCP results.
- Do not change `diff-worker.ts` or add dependencies.
- Remove `diffStatsFromPatch` and its direct tests.

## Review Focus

- Ordinary changes need exact counts, pinned by `counts added and removed lines from generated hunks`.
- Content beginning with `--` or `++` must not be confused with headers, pinned by `counts content lines that start with -- or ++`.
- Hostile names must stay escaped without changing counts, pinned by `keeps ... escaped so it cannot forge a header line`.
- Identical files need zero counts, pinned by `returns zero counts for identical files`.
- Worker generation must use the same counting rule, pinned by `a diff over the inline threshold returns the full patch` with 600 additions and 600 removals.

---

### Task 1: generation counts

**Files:**

- Modify: `src/core/diff.ts:143-192`
- Modify: `src/tools/diff.ts:42-77`
- Modify: `src/tools/edit.ts:630-637`
- Modify: `src/tools/patch.ts:100-137`
- Modify: `src/core/diff-budget.ts:54-72`
- Test: `__tests__/diff.test.ts:28-195`
- Test: `__tests__/diff-budget.test.ts`
- Test: `__tests__/edit.test.ts`
- Test: `__tests__/patch.test.ts`

**Interfaces:**

- Consumes: `StructuredPatch` from `diff`, already returned by inline and worker execution.
- Produces:

```ts
export interface GeneratedPatch {
  readonly text: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

export async function twoFilesPatch(
  oldName: string,
  newName: string,
  before: string,
  after: string,
  oldHeader: string,
  newHeader: string,
  options: { context?: number; timeout: number },
): Promise<GeneratedPatch | undefined>;

export function unifiedPatch(
  label: string,
  original: string,
  modified: string,
  timeoutMs = DIFF_TIMEOUT_MS,
): Promise<GeneratedPatch | undefined>;
```

- [ ] **Step 1: Write failing generation tests**

In `__tests__/diff.test.ts`, replace the first parser test with:

```ts
it('counts added and removed lines from generated hunks', async () => {
  const patch = await unifiedPatch('f', 'one\ntwo\nthree\n', 'one\n2\nthree\nfour\n');
  assert.ok(patch);
  assert.strictEqual(patch.linesAdded, 2);
  assert.strictEqual(patch.linesRemoved, 1);
});
```

Change the `--` and `++` content test to assert the same properties with 1 addition and 2 removals. Add:

```ts
it('returns zero counts for identical files', async () => {
  const patch = await unifiedPatch('f', 'one\n', 'one\n');
  assert.ok(patch);
  assert.strictEqual(patch.linesAdded, 0);
  assert.strictEqual(patch.linesRemoved, 0);
  assert.ok(!patch.text.includes('\n@@'));
});
```

- [ ] **Step 2: Run the new ordinary-count test to verify it fails**

Run:

```bash
npm test -- --test-name-pattern="counts added and removed lines from generated hunks" __tests__/diff.test.ts
```

Expected: FAIL because `unifiedPatch` currently returns a string, so both count properties are `undefined`.

- [ ] **Step 3: Implement the generation result**

In `src/core/diff.ts`, add `GeneratedPatch` exactly as defined in Interfaces. After inline or worker execution returns `patch`, iterate over `patch.hunks` and their `lines`. Count a leading `+` as an addition and a leading `-` as a removal. Return the existing header plus formatted hunks as `text`, together with both counts. Keep the existing early `undefined` return and header formatting. Delete `diffStatsFromPatch`.

- [ ] **Step 4: Migrate every production caller**

Make these exact adaptations:

- `src/tools/diff.ts`: use `generated.text` for the text block and `generated.linesAdded` plus `generated.linesRemoved` for structured output.
- `src/tools/edit.ts`: copy only the two count properties into `editResult`; assign `patch.text` to `editResult.diff` for a dry run.
- `src/tools/patch.ts`: read counts from `computed ?? done.result`; use `computed?.text ?? args.diff` for `preview` so string operations keep working.
- `src/core/diff-budget.ts`: check `patch.text.length` and store `patch.text`; keep the existing `undefined` branch.

Do not change `diff-worker.ts`.

- [ ] **Step 5: Migrate the remaining Diff tests**

In `__tests__/diff.test.ts`, remove the `diffStatsFromPatch` import and import `type GeneratedPatch` from `../src/core/diff.ts`. Compare text expectations with `patch.text`, call string methods on `patch.text`, pass `patch.text` to `parsePatch`, and read counts directly from `patch`. Change the worker-header helper parameter to `GeneratedPatch | undefined` and compare `patch?.text`. Keep the existing expected values, including 600 additions and 600 removals for the 600-line worker case and `undefined` for deadline and queue-saturation cases.

- [ ] **Step 6: Run the focused Diff and caller tests**

Run:

```bash
npm test -- __tests__/diff.test.ts __tests__/diff-budget.test.ts __tests__/edit.test.ts __tests__/patch.test.ts
```

Expected: PASS. The generation tests cover all five Review Focus cases, and the tool suites prove their wiring still returns the same text and counts.

- [ ] **Step 7: Run the full repository check**

Run:

```bash
npm run check
```

Expected: build, test type-check, lint, formatting, knip, and all tests pass. No contract snapshot change is expected.

- [ ] **Step 8: Commit**

```bash
git add src/core/diff.ts src/core/diff-budget.ts src/tools/diff.ts src/tools/edit.ts src/tools/patch.ts __tests__/diff.test.ts docs/superpowers/specs/2026-11-11-diff-generation-counts-design.md docs/superpowers/plans/2026-11-11-diff-generation-counts.md
git commit -m "refactor(diff): return counts from generation" -m "Callers parsed formatted patches to recover counts already present in structured hunks. Returning both removes that duplicate work and its header rules." -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
