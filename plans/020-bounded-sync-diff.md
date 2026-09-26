# Plan 020: Every synchronous diff is time-bounded and computed only when its output can be used

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/diff.ts src/tools/diff.ts src/tools/replace-text.ts src/tools/edit.ts __tests__/tools.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (Plan 019 adds tests to
> `__tests__/tools.test.ts` without touching these functions; that is not
> drift.)

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW–MED (preview output can now be omitted; see Step 4)
- **Depends on**: plans/019 (its `$`-expansion test guards `replace-text.ts`)
- **Category**: security (availability) / perf
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

The `diff` package's line diff is a synchronous Myers algorithm whose cost is
quadratic in the number of differing lines. Measured on this machine with
diff 9.0.0: 1,000 changed lines 174 ms, 2,000 668 ms, 4,000 2.8 s, 8,000
11.1 s. A `replace_text` dry run on a 9.5 MB file with 106k matches ran for
more than two minutes before it was killed; the same call without `dryRun`
finished normally.

Synchronous work cannot be interrupted by the tool timeout or the abort
signal. On stdio the whole server freezes; on HTTP every client waits. Three
call sites pay this cost:

- `diff` tool: two files up to the 10 MiB limit each, diffed twice (patch, then
  a second `diffLines` pass for the stats).
- `replace_text`: with `dryRun` or `returnDiff`, a unified patch is computed
  for **every** changed file, and only afterwards is the 20 KB diff budget
  checked — so after the budget is full, every later file still pays for a
  diff that is thrown away.
- `edit`: `computeDiffStats` on every edited file, and a patch on dry run.

diff v9 supports a `timeout` option (milliseconds) on `diffLines`,
`structuredPatch` and `createTwoFilesPatch`; when the deadline passes the call
returns `undefined` instead of a result (`node_modules/diff/libesm/types.d.ts:28-41`).
This plan routes every call through `src/core/diff.ts` with that option, moves
`replace_text`'s budget check ahead of the computation, and derives the `diff`
tool's stats from the patch it already has.

## Current state

```ts
// src/core/diff.ts (whole file, 25 lines)
import { createTwoFilesPatch, diffLines } from 'diff';

export function computeDiffStats(
  original: string,
  modified: string,
): { linesAdded: number; linesRemoved: number } {
  // diffLines returns the change list synchronously on diff v9.
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const part of diffLines(original, modified)) {
    if (part.added) linesAdded += part.count;
    else if (part.removed) linesRemoved += part.count;
  }
  return { linesAdded, linesRemoved };
}

// createTwoFilesPatch returns the unified diff string synchronously on diff v9
// (the { callback } option fires via setTimeout and returns undefined).
export function unifiedPatch(label: string, original: string, modified: string): string {
  return createTwoFilesPatch(label, label, original, modified, 'Original', 'Modified');
}
```

```ts
// src/tools/diff.ts:48-67
const diffText = createTwoFilesPatch(
  basename(validA),
  basename(validB),
  contentA,
  contentB,
  'a',
  'b',
  { context: args.context },
);

const { linesAdded, linesRemoved } = computeDiffStats(contentA, contentB);

return {
  structured: { a: validA, b: validB, linesAdded, linesRemoved },
  text: diffText,
};
```

`src/tools/diff.ts` imports `createTwoFilesPatch` from `'diff'` directly
(line 4) and `computeDiffStats` from `'../core/diff.ts'` (line 6). Its output
schema (lines 18–24) has `linesAdded`/`linesRemoved` as required
non-negative integers. `defineTool` turns a thrown `FsError` into an
`isError` result carrying the message.

```ts
// src/tools/replace-text.ts:369-394
function maybeAppendPatchDiff(
  summary: ReplaceSummary,
  params: {
    filePath: string;
    originalContent: string;
    updatedContent: string;
    includeDiff: boolean;
  },
): void {
  if (!params.includeDiff) return;
  const header = toPosixRelative(summary.root, params.filePath);

  const patch = unifiedPatch(header, params.originalContent, params.updatedContent);

  if (summary.diff.length >= MAX_DIFF_SIZE) {
    summary.diffTruncated = true;
    return;
  }

  if (summary.diff.length + patch.length <= MAX_DIFF_SIZE + DIFF_APPEND_BUFFER) {
    summary.diff += patch;
    return;
  }

  summary.diffTruncated = true;
}
```

`MAX_DIFF_SIZE = 20 * 1024` (line 139). The output schema already has
`diffTruncated?: boolean` ("True when the diff was cut due to the size
limit", line 127–130).

```ts
// src/tools/edit.ts:412-414
const { linesAdded, linesRemoved } =
  appliedEdits > 0 ? computeDiffStats(content, newContent) : { linesAdded: 0, linesRemoved: 0 };
return { content: newContent, appliedEdits, unmatchedEdits, linesAdded, linesRemoved };

// src/tools/edit.ts:433-436
if (options.dryRun) {
  if (editResult.appliedEdits > 0) {
    editResult.diff = unifiedPatch(basename(validPath), content, editResult.content);
  }
```

`EditResult` (lines 177–184) declares `linesAdded: number; linesRemoved: number; diff?: string`.
The per-file output schema (lines 148–150) has `linesAdded`, `linesRemoved`
and `diff` all **optional**; line 343 already emits the two counters
conditionally; line 466 logs `+${editResult.linesAdded}/-${editResult.linesRemoved}`.

Existing tests: `TC-FUNC-060` (`__tests__/tools.test.ts:1162`) for the diff
tool; `'edit and replace_text put the preview diff and stop reason in the text'`
(line 1864) for previews.

## Commands you will need

| Purpose        | Command                                                                                                          | Expected on success |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------- |
| Static check   | `npm run check:static`                                                                                           | exit 0              |
| All tests      | `npm test`                                                                                                       | all pass            |
| Diff unit      | `node --test __tests__/diff.test.ts`                                                                             | all pass            |
| Filter by name | `npm test -- --test-name-pattern="diff too large"`                                                               | passes              |
| Format         | `npx prettier --write src/core/diff.ts src/tools/diff.ts src/tools/replace-text.ts src/tools/edit.ts __tests__/` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/diff.ts` — timeout constant, `undefined` returns, patch-stats helper
- `src/tools/diff.ts` — call through core, handle `undefined`
- `src/tools/replace-text.ts` — `maybeAppendPatchDiff` only
- `src/tools/edit.ts` — `applyEdits` return (lines 412–414), `EditResult`
  type, the log line at 466, the dry-run patch at 435
- `__tests__/diff.test.ts` — new file
- `__tests__/tools.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/tools/patch.ts` — `applyPatch` is linear; not affected.
- The 20 KB `MAX_DIFF_SIZE` and its buffer — the budget value is not the bug.
- `edit`'s output schema — the fields are already optional; do not add a
  `diffTruncated` field there (wire change; see maintenance notes).

## Git workflow

- Branch: `advisor/020-bounded-sync-diff` from `main` (after plan 019 lands,
  or from its branch).
- Commits, conventional style, e.g.
  `fix(diff): bound every synchronous diff with a 1 s timeout`,
  `perf(replace_text): check the diff budget before computing a patch`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Core helpers with a deadline

Replace the body of `src/core/diff.ts` with:

```ts
import { createTwoFilesPatch, diffLines } from 'diff';

// Unified-diff computation over two text buffers. Kept out of `fmt.ts`, which
// formats terminal output and has no business pulling in the `diff` package.

/**
 * Wall-clock bound for one Myers diff. The algorithm is synchronous and
 * quadratic in differing lines (8k changed lines ≈ 11 s), and neither the tool
 * timeout nor the abort signal can interrupt it. Past the deadline the `diff`
 * package returns `undefined`; callers degrade (no preview / no counts) instead
 * of freezing the process.
 */
export const DIFF_TIMEOUT_MS = 1000;

export function computeDiffStats(
  original: string,
  modified: string,
  timeoutMs = DIFF_TIMEOUT_MS,
): { linesAdded: number; linesRemoved: number } | undefined {
  const parts = diffLines(original, modified, { timeout: timeoutMs });
  if (parts === undefined) return undefined;
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const part of parts) {
    if (part.added) linesAdded += part.count;
    else if (part.removed) linesRemoved += part.count;
  }
  return { linesAdded, linesRemoved };
}

export function unifiedPatch(
  label: string,
  original: string,
  modified: string,
  timeoutMs = DIFF_TIMEOUT_MS,
): string | undefined {
  return createTwoFilesPatch(label, label, original, modified, 'Original', 'Modified', {
    timeout: timeoutMs,
  });
}

/** Added/removed line counts read off a unified patch — no second diff pass. */
export function diffStatsFromPatch(patch: string): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) linesAdded++;
    else if (line.startsWith('-')) linesRemoved++;
  }
  return { linesAdded, linesRemoved };
}
```

**Verify**: `npm run build` → fails to compile in `edit.ts` / `diff.ts` /
`replace-text.ts` (callers still expect non-undefined). That is expected; the
next steps fix them. If it compiles cleanly, STOP: the `timeout` option's
return type is not `| undefined` on the installed version — report the
`node_modules/diff/package.json` version.

### Step 2: `diff` tool

In `src/tools/diff.ts`:

1. Keep `import { createTwoFilesPatch } from 'diff';` (line 4) — the tool
   needs `context` and its own `a`/`b` headers, so it calls the package
   directly with the shared timeout. Change line 6 to
   `import { DIFF_TIMEOUT_MS, diffStatsFromPatch } from '../core/diff.ts';`
   and add `import { ErrorCode, FsError } from '../core/errors.ts';`.
2. Replace lines 48–67 with:

   ```ts
   // Synchronous Myers diff; `timeout` is the only thing that can stop it.
   const diffText = createTwoFilesPatch(
     basename(validA),
     basename(validB),
     contentA,
     contentB,
     'a',
     'b',
     { context: args.context, timeout: DIFF_TIMEOUT_MS },
   );
   if (diffText === undefined) {
     throw new FsError(
       ErrorCode.TOO_LARGE,
       `Diff not computed: the files differ in too many lines to diff within ${String(DIFF_TIMEOUT_MS)} ms. Compare smaller sections with read + startLine/endLine.`,
       args.a,
     );
   }

   const { linesAdded, linesRemoved } = diffStatsFromPatch(diffText);

   // The text block is the one copy of the diff; a model reads that, and a
   // structured duplicate or a store entry would only ship the same bytes again.
   return {
     structured: { a: validA, b: validB, linesAdded, linesRemoved },
     text: diffText,
   };
   ```

**Verify**: `npm test -- --test-name-pattern="TC-FUNC-060"` → passes
(`linesAdded`/`linesRemoved` unchanged for the existing fixture).

### Step 3: `replace_text` budget before work

In `src/tools/replace-text.ts`, replace lines 378–394 (the body of
`maybeAppendPatchDiff` after `if (!params.includeDiff) return;`) with:

```ts
// Budget first: a full budget must not pay for a diff it will discard, and a
// diff past its deadline counts as truncated output, not a failed file.
if (summary.diff.length >= MAX_DIFF_SIZE) {
  summary.diffTruncated = true;
  return;
}
const header = toPosixRelative(summary.root, params.filePath);
const patch = unifiedPatch(header, params.originalContent, params.updatedContent);
if (patch === undefined) {
  summary.diffTruncated = true;
  return;
}
if (summary.diff.length + patch.length <= MAX_DIFF_SIZE + DIFF_APPEND_BUFFER) {
  summary.diff += patch;
  return;
}
summary.diffTruncated = true;
```

**Verify**: `npm test -- --test-name-pattern="preview diff and stop reason"`
→ passes.

### Step 4: `edit` degrades without stats or preview

In `src/tools/edit.ts`:

1. `EditResult` (lines 177–184): change `linesAdded: number; linesRemoved: number;`
   to `linesAdded?: number; linesRemoved?: number;`.
2. Lines 412–414: replace with

   ```ts
   const stats =
     appliedEdits > 0 ? computeDiffStats(content, newContent) : { linesAdded: 0, linesRemoved: 0 };
   return { content: newContent, appliedEdits, unmatchedEdits, ...(stats ?? {}) };
   ```

3. Line 435: `unifiedPatch(...)` now returns `string | undefined`; assign it
   only when defined:

   ```ts
   const patch = unifiedPatch(basename(validPath), content, editResult.content);
   if (patch !== undefined) editResult.diff = patch;
   ```

4. Line 466 (the log line): use `String(editResult.linesAdded ?? 0)` and
   `String(editResult.linesRemoved ?? 0)` so the template compiles with the
   optional fields (the project's `restrict-template-expressions` rule allows
   numbers, not `number | undefined`).
5. Line 343 already reads
   `? { linesAdded: result.linesAdded, linesRemoved: result.linesRemoved }` under
   a condition — check that condition still type-checks; if it tests
   `appliedEdits > 0`, change it to
   `result.linesAdded !== undefined && result.linesRemoved !== undefined`.

Run `npx prettier --write src/core/diff.ts src/tools/diff.ts src/tools/replace-text.ts src/tools/edit.ts`.

**Verify**: `npm run check:static` → exit 0.

### Step 5: Tests

Create `__tests__/diff.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeDiffStats, diffStatsFromPatch, unifiedPatch } from '../src/core/diff.ts';

const lines = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`).join('\n') + '\n';

describe('core/diff', () => {
  it('counts added and removed lines from a patch and from diffLines alike', () => {
    const a = 'one\ntwo\nthree\n';
    const b = 'one\n2\nthree\nfour\n';
    const patch = unifiedPatch('f', a, b);
    assert.ok(patch);
    assert.deepStrictEqual(diffStatsFromPatch(patch), { linesAdded: 2, linesRemoved: 1 });
    assert.deepStrictEqual(computeDiffStats(a, b), { linesAdded: 2, linesRemoved: 1 });
  });

  it('gives up past the deadline instead of blocking', () => {
    const a = lines('a', 4000);
    const b = lines('b', 4000);
    assert.strictEqual(unifiedPatch('f', a, b, 1), undefined);
    assert.strictEqual(computeDiffStats(a, b, 1), undefined);
  });
});
```

In `__tests__/tools.test.ts`, directly after `TC-FUNC-060`, add (this test
runs about one second):

```ts
it('diff reports "too large" instead of freezing on files that share no lines', async () => {
  const many = (p: string): string =>
    Array.from({ length: 8000 }, (_, i) => `${p}${String(i)}`).join('\n') + '\n';
  const a = await writeTestFile(tmpDir, 'diff_huge/a.txt', many('a'));
  const b = await writeTestFile(tmpDir, 'diff_huge/b.txt', many('b'));
  const started = Date.now();
  const result = await harness.client.callTool({ name: 'diff', arguments: { a, b } });
  assert.strictEqual(result.isError, true);
  assert.match(firstTextBlock(result).text ?? '', /Diff not computed/);
  assert.ok(Date.now() - started < 5000, 'the call must return within the tool timeout');
});
```

Run `npx prettier --write __tests__/diff.test.ts __tests__/tools.test.ts`.

**Verify**: `node --test __tests__/diff.test.ts` → 2 pass;
`npm test -- --test-name-pattern="too large"` → passes.

### Step 6: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- `__tests__/diff.test.ts`: patch-derived stats equal `diffLines` stats on a
  small fixture; both helpers return `undefined` past a 1 ms deadline on two
  4,000-line files with no common lines.
- `tools.test.ts`: the `diff` tool answers `isError` with "Diff not computed"
  on two 8,000-line disjoint files within the tool timeout.
- Existing: `TC-FUNC-060`, the edit/replace preview test, every `edit` test
  that asserts `linesAdded`.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "timeout" src/core/diff.ts src/tools/diff.ts` shows the option
      passed at every `diffLines` / `createTwoFilesPatch` call (3 sites)
- [ ] `grep -n "computeDiffStats" src/tools/diff.ts` prints nothing
- [ ] In `src/tools/replace-text.ts`, the `MAX_DIFF_SIZE` check precedes the
      `unifiedPatch(` call inside `maybeAppendPatchDiff`
- [ ] New tests exist and pass
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 020 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1's build does **not** fail (the installed `diff` types do not model
  the `undefined` return).
- `TC-FUNC-060` reports different `linesAdded`/`linesRemoved` after Step 2 —
  `diffStatsFromPatch` and `diffLines` disagree; report both numbers.
- The Step 5 tool test takes longer than 5 s (the timeout is not honored by
  `createTwoFilesPatch` on this version).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- `DIFF_TIMEOUT_MS` is per call. `replace_text` can now call `unifiedPatch`
  at most a couple of times per request (the 20 KB budget fills after one or
  two files), so the worst case is a few seconds, not minutes.
- `edit` in dry-run mode silently omits `diff` when the deadline hits. If that
  proves confusing, add an optional `diffTruncated` to `PerFileResultSchema`
  — that is a wire-shape addition and the release type is the operator's call.
- Reviewer focus: no call into the `diff` package without `timeout`
  (`grep -rn "from 'diff'" src/` should list only `core/diff.ts` and
  `tools/diff.ts`).
