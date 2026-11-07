# Diff worker implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close GHSA-9p5w-jvxw-wrcg: a diff must not block the event loop, so other clients keep being served while one runs.

**Architecture:** `twoFilesPatch` and `unifiedPatch` in `src/core/diff.ts` become async. Small inputs keep the current inline Myers pass. Inputs over a line threshold run `structuredPatch` in a `worker_threads` worker, one worker at a time through the existing `runExclusive`. The worker is terminated at a hard deadline. Header formatting stays on the main thread, so both paths produce the same text. All four callers await the result.

**Tech Stack:** TypeScript, Node >= 24 `node:worker_threads`, the `diff` package, Node built-in test runner.

**Spec:** GHSA-9p5w-jvxw-wrcg (private advisory) and the confirmation below.

## Confirmed behaviour on v2.19.0 (`fc8856dc`)

Two 10k-line files, 8k lines differ, keyed HTTP bind, a `tools/list` ping every 20 ms:

| Load            | Wall    | Worst ping |
| :-------------- | :------ | :--------- |
| no diff         | 0 ms    | 8 ms       |
| 1 diff          | 1015 ms | 1003 ms    |
| 8 diffs at once | 8045 ms | 5991 ms    |

All 9 diffs returned `TOO_LARGE`. Inline worst case (every line differs): 250+250 lines 12 ms, 500+500 lines 33 ms, 1000+1000 lines 128 ms, 4000+4000 lines 1001 ms. Worker spawn plus one round trip: 10 ms.

## Global Constraints

- Standard library only: no new dependency.
- `DIFF_TIMEOUT_MS` stays `1000`; it bounds the worker's Myers pass, not the main thread.
- Inline threshold: `INLINE_DIFF_MAX_LINES = 1000`, counted as lines in `before` plus lines in `after`. Measured worst case at that size: 33 ms.
- One diff worker at a time: `runExclusive(DIFF_WORKER_KEY, ...)` from `src/core/concurrency.ts`. Waiting in that queue does not count toward the deadline.
- Hard kill: `worker.terminate()` at `DIFF_TIMEOUT_MS + 500` ms, resolving `undefined`.
- A worker `error`, an `exit` before a message, or the hard kill all resolve `undefined`. Callers already degrade on `undefined`. Never reject, never leave a worker running.
- The worker file must load from `src/` (tests run `.ts`) and from `dist/` (npm and mcpb ship `dist/`, `mcpb/manifest.json` runs `dist/index.js`).
- Do not hand-edit versions in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`.
- Work in the private fork `j0hanz/filesystem-mcp-ghsa-9p5w-jvxw-wrcg`, branch `advisory-fix-1`.

## Review Focus

1. The worker URL resolves under `dist/` as `.js`, not only under `src/` as `.ts`. A miss there ships a `diff` that always returns `TOO_LARGE` and only `dist-smoke` would notice.
2. Inline and worker paths give byte-identical text for the same input, including quoted header names.
3. A worker that crashes or exits early resolves `undefined` with no unhandled rejection and no live worker left behind.
4. A burst of worker diffs runs one at a time and the main loop stays free throughout.
5. `replace_text`: a patch that arrives after other files folded still respects the 20 KB `MAX_DIFF_SIZE` cap.

---

### Task 1: Move big diffs off the event loop

**Files:**

- Create: `src/core/diff-worker.ts` (worker entry)
- Modify: `src/core/diff.ts` (async `twoFilesPatch`/`unifiedPatch`, threshold, worker runner, doc comment on `DIFF_TIMEOUT_MS`)
- Modify: `src/tools/diff.ts:47`, `src/tools/edit.ts:621`, `src/tools/patch.ts:97` (await)
- Modify: `src/core/diff-budget.ts:54-70` (`patchWithinBudget` async), `src/tools/replace-text.ts:210,470` (`onChanged` returns `Promise<Patch>`)
- Modify: `CHANGELOG.md` (add `## [Unreleased]` / `### Security` above `## [2.19.0]`)
- Test: `__tests__/diff.test.ts`, `__tests__/diff-budget.test.ts`

**Interfaces:**

- Produces:
  - `twoFilesPatch(oldName, newName, before, after, oldHeader, newHeader, options: { context?: number; timeout: number }): Promise<string | undefined>`
  - `unifiedPatch(label, original, modified, timeoutMs = DIFF_TIMEOUT_MS): Promise<string | undefined>`
  - `export const INLINE_DIFF_MAX_LINES = 1000`
  - `patchWithinBudget(budget, index, header, done): Promise<Patch>`
  - Worker message in: `{ before, after, oldName, newName, oldHeader, newHeader, options }`. Message out: the `structuredPatch` result, or `null` past the deadline.

- [ ] **Step 1: Write the failing tests in `__tests__/diff.test.ts`**

Add `await` to every existing `unifiedPatch`/`twoFilesPatch` call. Add:

```ts
const lines = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n') + '\n';

it('a diff over the inline threshold returns the full patch', async () => {
  // 600 + 600 lines is over INLINE_DIFF_MAX_LINES, so it runs in the worker.
  const big = await unifiedPatch('f', lines('a', 600), lines('b', 600));
  assert.ok(big?.startsWith('Index: f\n'));
  assert.strictEqual(diffStatsFromPatch(big).linesAdded, 600);
  assert.strictEqual(diffStatsFromPatch(big).linesRemoved, 600);
});

it('a big diff leaves the event loop free', async () => {
  let maxGap = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  await unifiedPatch('f', lines('a', 4000), lines('b', 4000));
  clearInterval(tick);
  assert.ok(maxGap < 200, `event loop blocked ${maxGap.toFixed(0)} ms`);
});

it('a worker diff past its deadline resolves undefined', async () => {
  const t = performance.now();
  assert.strictEqual(await unifiedPatch('f', lines('a', 8000), lines('b', 8000), 50), undefined);
  assert.ok(performance.now() - t < 1500);
});

it('concurrent worker diffs all complete', async () => {
  const out = await Promise.all(
    [0, 1, 2].map((i) => unifiedPatch('f', lines(`a${i}`, 600), lines(`b${i}`, 600))),
  );
  assert.ok(out.every((p) => p !== undefined));
});
```

Add a test that the quoted-name case at `__tests__/diff.test.ts:64` gives the same header when the body is over the threshold.

- [ ] **Step 2: Run it and check it fails**

Run: `npm test -- __tests__/diff.test.ts`
Expected: `a big diff leaves the event loop free` fails with `event loop blocked ~1000 ms`. The others pass, since awaiting a string works.

- [ ] **Step 3: Write `src/core/diff-worker.ts`**

On `parentPort` message: call `structuredPatch` with the message fields and post the result, posting `null` when it returns `undefined`. Nothing else.

- [ ] **Step 4: Make `twoFilesPatch` async in `src/core/diff.ts`**

- Count lines in `before` plus `after`, stopping early once past `INLINE_DIFF_MAX_LINES`. At or under: today's inline call.
- Over: `runExclusive(DIFF_WORKER_KEY, () => patchInWorker(...))`. `DIFF_WORKER_KEY` is a module-private `Symbol`.
- `patchInWorker` resolves once on the first of: a `message`, an `error`, an `exit`, or the hard-kill timer. It clears the timer and calls `terminate()` in every case.
- Worker URL: `new URL(import.meta.url.endsWith('.ts') ? './diff-worker.ts' : './diff-worker.js', import.meta.url)`. `tsc` with `rewriteRelativeImportExtensions` does not rewrite this string.
- Header formatting stays after the patch comes back, shared by both paths.
- `unifiedPatch` returns `twoFilesPatch(...)`.
- Rewrite the `DIFF_TIMEOUT_MS` comment: big diffs run in a worker killed at the deadline; the tool timeout and abort signal still do not stop it. Cite GHSA-9p5w-jvxw-wrcg.

- [ ] **Step 5: Run `__tests__/diff.test.ts` and check it passes**

Run: `npm test -- __tests__/diff.test.ts`
Expected: PASS.

- [ ] **Step 6: Await at every caller**

- `src/tools/diff.ts:47`, `src/tools/edit.ts:621`, `src/tools/patch.ts:97`: add `await`. Each is already inside an async function.
- `src/core/diff-budget.ts`: `patchWithinBudget` becomes `async`. Keep the `remaining === 0` early return before the diff. After the await, check `patch.length > MAX_DIFF_SIZE - budget.folded.length` against the current fold, not the value read before the await.
- `src/tools/replace-text.ts:210`: `onChanged: (done: Rewritten<number>) => Promise<Patch>`; await it where `processEntry` calls it.
- `__tests__/diff-budget.test.ts`: await each `patchWithinBudget`.

- [ ] **Step 7: Add the changelog entry**

`## [Unreleased]` / `### Security`: **Big diffs no longer stall the server** ([GHSA-9p5w-jvxw-wrcg](https://github.com/j0hanz/filesystem-mcp/security/advisories/GHSA-9p5w-jvxw-wrcg)). A diff of two large, mostly different files held the event loop for up to 1 s, and a stream of them kept every other client waiting. Diffs over 1000 lines now run in a worker thread, one at a time, and other requests are served meanwhile. Results are unchanged.

- [ ] **Step 8: Full check**

Run: `npm run check`
Expected: PASS, including `__tests__/dist-smoke.test.ts` against the fresh `dist/`.

- [ ] **Step 9: Re-run the PoC against `dist/`**

Run: `npm run build`, then `node <scratchpad>/repro-diff.mjs C:/filesystem-mcp-ghsa-9p5w-jvxw-wrcg/dist/index.js 8`
Expected: worst ping under 100 ms for both the single diff and the burst of 8. Each diff still returns `TOO_LARGE`, because the files exceed the 1 s budget.

- [ ] **Step 10: Commit and push**

```bash
git add src/core/diff-worker.ts src/core/diff.ts src/core/diff-budget.ts src/tools/diff.ts src/tools/edit.ts src/tools/patch.ts src/tools/replace-text.ts CHANGELOG.md __tests__/diff.test.ts __tests__/diff-budget.test.ts docs/superpowers/plans/2026-11-07-diff-worker.md
git commit -m "fix(diff): run big diffs in a worker thread (GHSA-9p5w-jvxw-wrcg)"
git push -u origin advisory-fix-1
```
