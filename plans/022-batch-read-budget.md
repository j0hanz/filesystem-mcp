# Plan 022: A batched `read` budgets only what it will actually read, and one oversized file never blanks the rest

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/tools/read.ts __tests__/tools.test.ts`
> If `src/tools/read.ts` changed, compare the "Current state" excerpts against
> the live code before proceeding; on a mismatch, treat it as a STOP condition.
> (Other plans add tests to `tools.test.ts`; that is not drift.)

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

A batched `read` (`paths: [...]`) pre-estimates the bytes it will return and
refuses files that would push the total past 512 KiB. Two things are wrong
with that estimate:

1. It uses the whole file size even when `head`, `tail` or `startLine`/`endLine`
   is set and only a few lines will be returned. `read {paths:[big.log],
head: 3}` fails while `read {path: big.log, head: 3}` succeeds.
2. Once one file overflows, an `overflowed` flag marks **every later file** as
   `TOO_LARGE`, however small. `read {paths:[big.log (600 KB), a.txt, b.txt]}`
   fails all three, and because every entry failed the whole call is
   `isError`.

Reproduced during the audit through the in-memory client: the summary was
`{"total":3,"succeeded":0,"failed":3}`, every entry "Skipped: combined
estimated read would exceed maxTotalSize".

After this plan: ranged reads skip the byte budget (each line is already
capped by the per-line size limit in `src/core/read.ts`), and a full-read batch
skips only the files that do not fit, reading everything else.

## Current state

```ts
// src/tools/read.ts:193-222 (collectFileBudget, first half)
async function collectFileBudget(
  filePaths: string[],
  maxTotalSize: number,
  maxSize: number,
  ctx: Pick<ToolCtx, 'fs' | 'signal' | 'log'>,
): Promise<{
  skippedResults: Map<number, PerPathResult<PerPathReadValue>>;
  survivors: string[];
  known: Map<string, { validPath: string; stats: Stats }>;
}> {
  const indexed = filePaths.map((path, index) => ({ path, index }));
  const { results } = await processInParallel(
    indexed,
    async ({ path, index }): Promise<BatchFileInfo | undefined> => {
      try {
        const out = await ctx.fs.stat(path);
        return {
          index,
          size: Math.min(out.stats.size, maxSize),
          validPath: out.validPath,
          stats: out.stats,
        };
      } catch (err: unknown) {
        ctx.log?.('debug', `collectFileBudget: stat failed for "${path}": ${String(err)}`, 'read');
        return undefined;
      }
    },
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );
```

```ts
// src/tools/read.ts:238-284 (collectFileBudget, second half)
  let total = 0;
  const skippedResults = new Map<number, PerPathResult<PerPathReadValue>>();
  const survivors: string[] = [];
  let overflowed = false;
  for (let i = 0; i < filePaths.length; i += 1) {
    const path = filePaths[i];
    if (path === undefined) continue;
    const size = byIndex.get(i);
    if (overflowed) {
      // Only files that were actually stat'd get the TOO_LARGE result; a failed
      // stat falls through to survivors so its read surfaces the real error —
      // not a misleading TOO_LARGE.
      if (size !== undefined) {
        skippedResults.set(i, {
          path,
          error: {
            code: ErrorCode.TOO_LARGE,
            message: `Skipped: combined estimated read would exceed maxTotalSize (${String(maxTotalSize)} bytes)`,
            path,
          },
        });
      } else {
        survivors.push(path);
      }
      continue;
    }
    if (size === undefined) {
      survivors.push(path);
      continue;
    }
    if (total + size > maxTotalSize) {
      overflowed = true;
      skippedResults.set(i, {
        path,
        error: {
          code: ErrorCode.TOO_LARGE,
          message: `Skipped: combined estimated read would exceed maxTotalSize (${String(maxTotalSize)} bytes)`,
          path,
        },
      });
      continue;
    }
    total += size;
    survivors.push(path);
  }

  return { skippedResults, survivors, known };
}
```

```ts
// src/tools/read.ts:419-439 (run, batch branch)
if (args.paths !== undefined) {
  pathList = args.paths;
  const budget = await collectFileBudget(
    pathList,
    READ_MANY_MAX_TOTAL_BYTES,
    getMaxTextFileSize(),
    ctx,
  );
  known = budget.known;
  skippedResults = budget.skippedResults;
  survivors = budget.survivors;
} else {
  pathList = [args.path ?? ''];
  survivors = [...pathList];
}
```

`buildReadSpec` (lines 133–148) already knows the mode: `head`, `tail`,
`startLine`/`endLine` → a ranged read; otherwise `full`.
`READ_MANY_MAX_TOTAL_BYTES = 512 * KIB` (`src/core/util.ts:73`). `known` is a
stat cache; `readOnePath(path, args, ctx, known.get(path))` accepts
`undefined` (the single-path branch passes none).

Existing batch tests: `'a call where every path failed is reported as isError'`
and `'a partly-failed batch is not isError'` (`__tests__/tools.test.ts:882-903`).
`failedSummary(result)` returns `_meta` as `{ results, summary }`.

## Commands you will need

| Purpose        | Command                                                          | Expected on success |
| -------------- | ---------------------------------------------------------------- | ------------------- |
| Static check   | `npm run check:static`                                           | exit 0              |
| All tests      | `npm test`                                                       | all pass            |
| Filter by name | `npm test -- --test-name-pattern="batch read budget"`            | passes              |
| Format         | `npx prettier --write src/tools/read.ts __tests__/tools.test.ts` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/tools/read.ts` — `collectFileBudget` loop and the `run` batch branch
- `__tests__/tools.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `READ_MANY_MAX_TOTAL_BYTES` value.
- `src/core/read.ts` — the per-line cap and streaming readers are correct.
- The single-path branch.

## Git workflow

- Branch: `advisor/022-batch-read-budget`.
- One commit: `fix(read): budget a batch by what it returns; skip only the file that does not fit`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Regression test (it must fail now)

In `__tests__/tools.test.ts`, directly after `'a partly-failed batch is not isError'`
(ends at line 903), add:

```ts
it('batch read budget: ranged reads are not pre-estimated, and one oversized file skips only itself', async () => {
  const big = await writeTestFile(tmpDir, 'budget/big.txt', 'x'.repeat(600 * 1024) + '\nlast\n');
  const small = await writeTestFile(tmpDir, 'budget/small.txt', 'tiny\n');

  const ranged = await harness.client.callTool({
    name: 'read',
    arguments: { paths: [big, small], head: 1 },
  });
  assert.notStrictEqual(ranged.isError, true, 'head reads must not be budgeted by file size');
  assert.strictEqual(failedSummary(ranged)?.summary?.failed, 0);

  const full = await harness.client.callTool({ name: 'read', arguments: { paths: [big, small] } });
  assert.notStrictEqual(full.isError, true, 'the small file must still be read');
  const results = failedSummary(full)?.results ?? [];
  assert.strictEqual(results[0]?.error?.code, 'TOO_LARGE');
  assert.strictEqual(results[1]?.error, undefined, 'the file after the oversized one must succeed');
  assert.ok(firstTextBlock(full).text?.includes('tiny'));

  const alone = await harness.client.callTool({ name: 'read', arguments: { paths: [big] } });
  assert.strictEqual(alone.isError, true, 'a lone oversized file is still refused');
});
```

**Verify**: `npm test -- --test-name-pattern="batch read budget"` → **fails**
on the first `assert.notStrictEqual(ranged.isError, true)`. If it passes, STOP.

### Step 2: Skip the budget for ranged reads

In `src/tools/read.ts`, `run` (line 419–432), replace the batch branch with:

```ts
    if (args.paths !== undefined) {
      pathList = args.paths;
      // A ranged read returns a few lines whatever the file size, and each line
      // is already bounded by the per-line cap in core/read.ts. Only a full read
      // is budgeted by size.
      if (buildReadSpec(args).kind === 'full') {
        const budget = await collectFileBudget(
          pathList,
          READ_MANY_MAX_TOTAL_BYTES,
          getMaxTextFileSize(),
          ctx,
        );
        known = budget.known;
        skippedResults = budget.skippedResults;
        survivors = budget.survivors;
      } else {
        survivors = [...pathList];
      }
    } else {
```

### Step 3: Skip only the file that does not fit

In `collectFileBudget`, replace lines 238–282 (from `let total = 0;` through
the end of the `for` loop) with:

```ts
let total = 0;
const skippedResults = new Map<number, PerPathResult<PerPathReadValue>>();
const survivors: string[] = [];
for (let i = 0; i < filePaths.length; i += 1) {
  const path = filePaths[i];
  if (path === undefined) continue;
  const size = byIndex.get(i);
  // A failed stat falls through to survivors so its read surfaces the real
  // error, not a misleading TOO_LARGE.
  if (size === undefined) {
    survivors.push(path);
    continue;
  }
  // Skip this file only; a later, smaller file that still fits is read.
  if (total + size > maxTotalSize) {
    skippedResults.set(i, {
      path,
      error: {
        code: ErrorCode.TOO_LARGE,
        message: `Skipped: this file alone would push the batch past maxTotalSize (${String(maxTotalSize)} bytes). Read it separately, or with head/tail/startLine.`,
        path,
      },
    });
    continue;
  }
  total += size;
  survivors.push(path);
}
```

Run `npx prettier --write src/tools/read.ts __tests__/tools.test.ts`.

**Verify**: `npm test -- --test-name-pattern="batch read budget"` → passes.

### Step 4: Full gate

**Verify**: `npm run check` → exit 0 (`grep -n "overflowed" src/tools/read.ts`
prints nothing).

## Test plan

- New test: `head: 1` batch with a 600 KB file succeeds; full batch reads the
  small file and marks only the big one `TOO_LARGE`; a lone oversized file is
  still `isError`.
- Existing: the two batch tests at lines 882–903; every single-path `read`
  test.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "overflowed" src/tools/read.ts` prints nothing
- [ ] `grep -n "buildReadSpec(args).kind === 'full'" src/tools/read.ts` prints one line
- [ ] The new test exists and passes
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 022 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The regression test passes before Step 2.
- After Step 3, the `'a partly-failed batch is not isError'` test changes
  outcome.
- `buildReadSpec` is not reachable from `run` (declared after use is fine in
  TS; if it has moved or been renamed, report).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The budget now protects only full reads. If a future `read` mode returns
  large fractions of a file (for example byte ranges), add it to the `'full'`
  branch or give it its own estimate.
- Reviewer focus: the `known` stat cache is only populated for full-read
  batches; `readOnePath` must keep tolerating a missing entry.
