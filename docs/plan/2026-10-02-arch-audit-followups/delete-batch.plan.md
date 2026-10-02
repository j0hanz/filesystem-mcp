# Plan: Land the delete.ts batch — `PendingCtx` for confirmations and read budget skips as batch items

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `fada7b47` (main), 2026-10-02.
> **Drift check (run first)**:
> `git diff --stat fada7b47..HEAD -- src/core/input-required.ts src/tools/define.ts src/tools/create.ts src/tools/delete.ts src/tools/move.ts src/tools/read.ts src/tools/batch.ts __tests__/input-required.test.ts __tests__/tools.test.ts __tests__/progress.test.ts __tests__/helpers.ts README.md`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

Two audit findings that share [`delete.ts`](../../../src/tools/delete.ts) land as
ONE PR on branch `refactor/delete-batch-pendingctx-read-budget`.

**Finding 2**: the four confirmation fields (`requestState`,
`droppedInputResponseKeys`, `clientCapabilities`, `serverCtx`) are hand-copied at
four `pendingRoundTrip` call sites, and `describeRefusal` takes three loose
arguments at three more. Three past commits each had to spread one new field to
every site. A structural `PendingCtx` makes the next field a one-place change.

**Finding 3**: [`read.ts`](../../../src/tools/read.ts) splits budget-skipped paths
from survivors, special-cases an empty survivor list, re-orders results and
recounts the summary, duplicating what
[`batch.ts`](../../../src/tools/batch.ts) owns. [`delete.ts`](../../../src/tools/delete.ts)
recounts the summary too. After this lands, every requested path is a batch item,
and one `summarize()` owns the counts.

Requirements covered: none (refactor). Decisions, settled — do not reopen:
[T-13](tickets/T-13-should-confirmation-context-be-pendingctx-alone-or-include-r.md)
(`PendingCtx` alone, NO `readPendingChoice` helper) and
[T-04](tickets/T-04-are-the-two-visible-read-budget-changes-acceptable.md)
(accept both visible read changes). Source of the findings:
[`audit-findings.md` §2–§3](assets/audit-findings.md) (its line numbers are stale; this plan's are
current at `fada7b47`). Delivery tickets:
[T-07](tickets/T-07-deliver-pendingctx-for-the-confirmation-hand-off.md),
[T-08](tickets/T-08-deliver-read-budget-skips-through-runoverpaths.md),
batch ticket [T-18](tickets/T-18-merge-the-delete-ts-batch-findings-2-and-3.md).

## Current state

### Finding 2 — confirmation context

- [`input-required.ts:186-205`](../../../src/core/input-required.ts#L186-L205) —
  `PendingRoundTripOpts` holds `op`, `pending`, `buildInputs` AND the four ctx
  fields:

  ```ts
  interface PendingRoundTripOpts {
    readonly op: PendingOp;
    readonly pending: readonly string[];
    readonly requestState: (() => PendingState | undefined) | undefined;
    readonly clientCapabilities?: ClientCapabilities | undefined;
    readonly droppedInputResponseKeys?: readonly string[] | undefined;
    readonly buildInputs: (pending: readonly string[]) => readonly PendingInput[];
    readonly serverCtx: ServerContext;
  }
  ```

- [`input-required.ts:250`](../../../src/core/input-required.ts#L250)
  `pendingRoundTrip(opts)` reads `opts.requestState?.()`, `opts.clientCapabilities`,
  `opts.droppedInputResponseKeys`, `opts.serverCtx`.
- [`input-required.ts:363`](../../../src/core/input-required.ts#L363)
  `describeRefusal(responses, key, droppedKeys?)`. Its five returned strings are
  the pinned refusal text (`'answered in a shape this server cannot read (a wrapped result instead of the bare elicitation result), twice'`, `'not answered'`, `'declined by the user'`, `'dismissed by the user'`, `'answered without a valid choice'`). **Do not touch the strings.**
- [`ToolCtx`](../../../src/tools/define.ts#L41) already has `inputResponses?`,
  `droppedInputResponseKeys?`, `requestState?: RequestStateAccessor`,
  `clientCapabilities?`, `serverCtx` with exactly the types `PendingCtx` needs, so
  it satisfies `PendingCtx` structurally with no change to it.
- Callers that must switch (grep of `pendingRoundTrip|describeRefusal` over `src/` and
  `__tests__/` at `fada7b47` — re-run it in step 2 and expect nothing else):

  | File | Call |
  | :-- | :-- |
  | [`create.ts:152`](../../../src/tools/create.ts#L152) | `pendingRoundTrip({ op: 'create', … requestState: ctx.requestState, … })` |
  | [`create.ts:181`](../../../src/tools/create.ts#L181) | `describeRefusal(ctx.inputResponses, key, ctx.droppedInputResponseKeys)` inside `new FsError(CANCELLED, …)` |
  | [`delete.ts:307`](../../../src/tools/delete.ts#L307) | `pendingRoundTrip({ op: 'delete', … })` |
  | [`delete.ts:254`](../../../src/tools/delete.ts#L254) | `describeRefusal(...)` inside `Problem.cancelled(…)` in `executePlan` |
  | [`move.ts:317`](../../../src/tools/move.ts#L317) | `pendingRoundTrip({ op, … })` |
  | [`move.ts:194`](../../../src/tools/move.ts#L194) | `describeRefusal(...)` inside `new FsError(CANCELLED, …)` in `executeTransfer` |
  | [`define.ts:316`](../../../src/tools/define.ts#L316) | `pendingRoundTrip({ op: 'grant', requestState: this.toolCtx.requestState, … })` in `precheckGrant` — becomes `pendingRoundTrip(this.toolCtx, { op: 'grant', … })` |
  | [`input-required.test.ts`](../../../__tests__/input-required.test.ts) | **10** direct `pendingRoundTrip` calls (lines 75, 189, 204, 219, 236, 250, 268, 283, 297, 312) and **3** `describeRefusal` calls (lines 520, 525, 526) = the audit's "13" |

  `describeRefusal` and `pendingRoundTrip` are used nowhere else (the
  `// … pendingRoundTrip` mentions in comments at
  [`define.ts:65`](../../../src/tools/define.ts#L65),
  [`define.ts:89`](../../../src/tools/define.ts#L89) and
  [`move.ts:250`](../../../src/tools/move.ts#L250) need no change).
- [`executePlan`](../../../src/tools/delete.ts#L237) and
  [`executeTransfer`](../../../src/tools/move.ts#L179) type `ctx` as
  `Pick<ToolCtx, 'fs' | … | 'inputResponses' | 'droppedInputResponseKeys' | 'log'>`
  (no `serverCtx`). So `describeRefusal` must take only
  `Pick<PendingCtx, 'inputResponses' | 'droppedInputResponseKeys'>`, otherwise
  those signatures would have to widen.
- Test harness: `bindContext()` at
  [`input-required.test.ts:34`](../../../__tests__/input-required.test.ts#L34)
  builds the `serverCtx` the direct calls pass today.
- Refusal text is pinned end to end by
  [`tools.test.ts:434`](../../../__tests__/tools.test.ts#L434) (`/declined by the user/`),
  [`input-required.test.ts:510-527`](../../../__tests__/input-required.test.ts#L510-L527)
  and `:629` (`/wrapped result/`).

### Finding 3 — read budget and batch summary

- [`batch.ts:13-65`](../../../src/tools/batch.ts#L13-L65) `runOverPaths(items, ctx,
  defaultErrorCode, perPath)`: throws `FsError(INVALID_INPUT)` on an empty list,
  ticks `ctx.onProgress({ current, total: items.length })` per item, wraps a
  throw as `{ path, error: Problem.fromUnknown(error, defaultErrorCode, path) }`,
  and counts `succeeded`/`failed` inline (lines 55-62). [`isTotalFailure`](../../../src/tools/batch.ts#L72)
  takes `{ total, failed }`.
- [`read.ts:168-243`](../../../src/tools/read.ts#L168-L243) `collectFileBudget` returns
  `{ skippedResults: Map<number, PerPathResult>, survivors: string[], known: Map<path, {validPath, stats}> }`.
  The skip is a hand-built object (no `suggestion`):
  `{ path, error: { code: TOO_LARGE, message: 'Skipped: this file alone would push the batch past maxTotalSize (<n> bytes). Read it on its own with path instead of paths.', path } }`.
  A failed `stat` leaves the path in `survivors` so its read reports the real error.
- [`read.ts:372-427`](../../../src/tools/read.ts#L372-L427) `run`: builds
  `pathList`/`survivors`/`known`, special-cases `survivors.length === 0`
  (`runOverPaths` rejects empty), then `resultMap` keyed by path + `ordered`
  re-mapping + recount (`failed`, `summary`).
- [`delete.ts:364-368`](../../../src/tools/delete.ts#L364-L368):

  ```ts
  const failed = results.filter((r) => 'error' in r).length;
  return {
    results,
    summary: { total: results.length, succeeded: results.length - failed, failed },
  };
  ```

  `delete` de-duplicates `args.paths` up front ([`delete.ts:268-271`](../../../src/tools/delete.ts#L268-L271)), keeps
  `processInParallel`, and finishes its R14 confirmation round before deleting; that stays.
- [`README.md:324`](../../../README.md#L324): ``| `src/tools/batch.ts`  | Batch helpers (runOverPaths, isTotalFailure)                                    |``
- Callers of every function whose signature changes (grep at `fada7b47`; re-run in steps 4–6):

  | Symbol | Callers |
  | :-- | :-- |
  | `collectFileBudget` | only [`read.ts:380`](../../../src/tools/read.ts#L380) (module-private, not exported). No test references it. |
  | `runOverPaths` | signature does NOT change, return shape does not change. Callers, all unaffected: [`create.ts:169`](../../../src/tools/create.ts#L169), [`edit.ts:503`](../../../src/tools/edit.ts#L503), [`stat.ts:165`](../../../src/tools/stat.ts#L165), [`read.ts:400`](../../../src/tools/read.ts#L400). No test imports it. |
  | `summarize` (new) | `runOverPaths` itself and `delete.ts` `handleDelete`. Nothing else recomputes a summary: `grep -n "succeeded" src` shows only `batch.ts`, `read.ts`, `delete.ts`. |

- **Verified baseline behaviors that the refactor must preserve or change as stated**
  (measured on `fada7b47` with a scratch read of `[big, small, small, big]`, where `big` is
  600 KiB > the 512 KiB `READ_MANY_MAX_TOTAL_BYTES`, then removed):
  - **Duplicate paths**: `results` has **one row per requested index** (4 rows, summary
    `total: 4`), and each duplicate is read separately; `resultMap` keying by path only
    makes equal-path rows share one outcome, which is always the same outcome anyway.
    Per-index items reproduce this exactly. No behavior change expected — pin it with a test.
  - **Progress**: with `[big, small]` the wire frames are `[0,undefined] [1,1] [2,2]`
    (`progress,total`); the work tick reports `total` = survivors only (1), not 2.
    With `[big, small, small, big]` it is `[1,2]`, not `[1,4]`.
  - **Skip result has no `suggestion`** today. After the change it goes through
    `Problem.fromUnknown`, and [`FsError`'s constructor](../../../src/core/errors.ts#L247)
    already attaches `DEFAULT_SUGGESTIONS[code]`, which for `TOO_LARGE` is exactly
    `'Use head/tail or line ranges to read partially.'` ([`errors.ts:73`](../../../src/core/errors.ts#L73)).
  - A throw of a plain `Problem` object would NOT work: `classify` turns a non-`Error`
    into `UNKNOWN` / `'[non-Error thrown]'` ([`errors.ts:184-186`](../../../src/core/errors.ts#L184-L186)).
    So `skip` is an `FsError`, whose `.problem` is the TOO_LARGE Problem.
- Existing coverage that must stay green:
  [`tools.test.ts:1094`](../../../__tests__/tools.test.ts#L1094) "batch read budget: one oversized
  file skips only itself…" (ranged, full, lone-oversized `isError`, single-path escape hatch).
- Conventions: tests use the shared harness in [`helpers.ts`](../../../__tests__/helpers.ts)
  (`failedSummary` at [`helpers.ts:547`](../../../__tests__/helpers.ts#L547), `writeTestFile`,
  `createTestRoot`); wire-progress tests follow
  [`progress.test.ts`](../../../__tests__/progress.test.ts) (`progressClient`, defined inside the top
  `describe` at about line 130, returns `{ client, frames, close }`; a call counts as
  progress-enabled only when `callTool(..., { onprogress: () => {} })` is passed — exemplar at
  [`progress.test.ts:206-212`](../../../__tests__/progress.test.ts#L206-L212)).

## Commands

All verified to run on `fada7b47`; baseline `npm run check` = 552 tests, 549 pass, 3 skipped.

| Purpose | Command | Expected on success |
| :-- | :-- | :-- |
| Test type-check | `npm run type-check:test` | exit 0 |
| Static checks (build, type-check, eslint, prettier, knip) | `npm run check:static` | exit 0 |
| One file | `node --test __tests__/<file>.test.ts` | `ℹ fail 0` |
| By name | `node --test --test-name-pattern="<pattern>" __tests__/<file>.test.ts` | `ℹ fail 0` |
| Format | `npx prettier --write <files>` | files listed |
| Full | `npm run check` | exit 0 (counts per step below) |

## Scope

**In scope** — the only files to modify or create:

- [`src/core/input-required.ts`](../../../src/core/input-required.ts)
- [`src/tools/define.ts`](../../../src/tools/define.ts) (one call site only)
- [`src/tools/create.ts`](../../../src/tools/create.ts)
- [`src/tools/delete.ts`](../../../src/tools/delete.ts)
- [`src/tools/move.ts`](../../../src/tools/move.ts)
- [`src/tools/read.ts`](../../../src/tools/read.ts)
- [`src/tools/batch.ts`](../../../src/tools/batch.ts)
- [`__tests__/input-required.test.ts`](../../../__tests__/input-required.test.ts)
- [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts) (new read tests next to line 1094)
- [`__tests__/progress.test.ts`](../../../__tests__/progress.test.ts) (one new read-progress test)
- [`__tests__/helpers.ts`](../../../__tests__/helpers.ts) (widen `failedSummary`'s `error` type by `suggestion?: string`)
- `__tests__/batch.test.ts` (new: `summarize` unit tests)
- [`README.md`](../../../README.md) (line 324 only)

**Files out of scope** — leave alone even though they look related:

- `package.json`, `server.json`, `mcpb/manifest.json` — versions are bumped only by the Release workflow; never hand-edit.
- [`src/core/errors.ts`](../../../src/core/errors.ts) — the suggestion text comes from existing `DEFAULT_SUGGESTIONS`; no change needed.
- [`src/tools/edit.ts`](../../../src/tools/edit.ts), [`src/tools/stat.ts`](../../../src/tools/stat.ts) — `runOverPaths` callers; its signature and return shape do not change.
- [`src/transport/http.ts`](../../../src/transport/http.ts) and the other `__tests__/input-required.test.ts` hunks (dispose hook) — finding 4, a separate batch that merges in the order [T-15](tickets/T-15-in-what-order-do-the-batch-prs-merge.md) sets; edit only the 13 call sites here.
- `executePlan` / `executeTransfer` ctx `Pick` types and the `'Unknown delete failure'` fallback in `delete.ts` — unrelated to this change.
- Any `readPendingChoice` helper — rejected by T-13; each site keeps its own choice read and failure shape (`FsError` in create/move, `Problem.cancelled` in delete).

## Steps

### 1. Create the branch and confirm the baseline

Start from `main`: `git switch main`, then `git switch -c refactor/delete-batch-pendingctx-read-budget`.
Run the drift check from the header (if `main` moved past `fada7b47`, apply it before continuing).

**Verify**: `git branch --show-current` → `refactor/delete-batch-pendingctx-read-budget`; `npm run type-check:test` → exit 0.

### 2. Introduce `PendingCtx` and switch every caller and test (one step: the signature change breaks them all)

In [`input-required.ts`](../../../src/core/input-required.ts):

- Add and export next to `PendingState`:

  ```ts
  /** The per-round confirmation context; `ToolCtx` satisfies it structurally. */
  export interface PendingCtx {
    readonly requestState?: (() => PendingState | undefined) | undefined;
    readonly clientCapabilities?: ClientCapabilities | undefined;
    readonly droppedInputResponseKeys?: readonly string[] | undefined;
    readonly inputResponses?: Record<string, unknown> | undefined;
    readonly serverCtx: ServerContext;
  }
  ```

  Move the existing field doc comments (the `clientCapabilities` "only positively-absent form support
  short-circuits" note and the `serverCtx` "codec binds minted state" note) onto these fields.
- `PendingRoundTripOpts` keeps only `op`, `pending`, `buildInputs`.
- `pendingRoundTrip(ctx: PendingCtx, opts: PendingRoundTripOpts)`; inside, read
  `ctx.requestState?.()`, `ctx.clientCapabilities`, `ctx.droppedInputResponseKeys`, `ctx.serverCtx`.
  Update the doc comment above it ("The caller supplies `buildInputs`…").
- `describeRefusal(ctx: Pick<PendingCtx, 'inputResponses' | 'droppedInputResponseKeys'>, key: string)`;
  body uses `ctx.droppedInputResponseKeys?.includes(key)` and `inputResponse(ctx.inputResponses, key)`.
  Return strings byte-identical. Update its comment ("Pass the round's ctx…").
- Do not import anything from `../tools/`.

Switch the callers (list in [Current state](#finding-2--confirmation-context)):

- [`create.ts:152`](../../../src/tools/create.ts#L152), [`delete.ts:307`](../../../src/tools/delete.ts#L307), [`move.ts:317`](../../../src/tools/move.ts#L317):
  `pendingRoundTrip(ctx, { op, pending, buildInputs })` — delete the four hand-threaded fields.
- [`define.ts:316`](../../../src/tools/define.ts#L316): `pendingRoundTrip(this.toolCtx, { op: 'grant', pending: grantDirs, buildInputs })`.
- [`create.ts:181`](../../../src/tools/create.ts#L181), [`delete.ts:254`](../../../src/tools/delete.ts#L254), [`move.ts:194`](../../../src/tools/move.ts#L194):
  `describeRefusal(ctx, key)`. Leave the surrounding `readAcceptedChoice` and the
  `FsError`/`Problem.cancelled` construction untouched.

Update [`input-required.test.ts`](../../../__tests__/input-required.test.ts) in the same step: each of
the 10 `pendingRoundTrip({ op, pending, requestState, …, serverCtx: bindContext() })` calls becomes
`pendingRoundTrip({ requestState, [clientCapabilities], [droppedInputResponseKeys], serverCtx: bindContext() }, { op, pending, buildInputs })`;
the 3 `describeRefusal` calls become `describeRefusal({ inputResponses: responses }, 'confirm_0')`,
`describeRefusal({ droppedInputResponseKeys: ['confirm_0'] }, 'confirm_0')` and
`describeRefusal({ droppedInputResponseKeys: ['other'] }, 'confirm_0')`.

Run `npx prettier --write` on the touched files.

**Verify**: `npm run check:static` → exit 0 (this proves `ToolCtx` satisfies `PendingCtx`: all four callers type-check passing `ctx` / `this.toolCtx`);
`node --test __tests__/input-required.test.ts` → `ℹ fail 0`;
`node --test --test-name-pattern="declined|overwrite|confirm|grant" __tests__/tools.test.ts` → `ℹ fail 0`;
`Select-String -Path src\*\*.ts -Pattern "droppedInputResponseKeys: ctx\.droppedInput"` → no match (no hand-threaded field left).

### 3. Finding 3, test first: pin the two accepted changes and the unchanged behavior

Add the tests below. They go against current code, so two must FAIL now.

- [`helpers.ts:547`](../../../__tests__/helpers.ts#L547): add `suggestion?: string` to the `error` type in both
  places inside `failedSummary`'s return type (type-only change).
- In [`tools.test.ts`](../../../__tests__/tools.test.ts), after the test at line 1094, use the same
  `big`/`small` fixtures (600 KiB file, small file) via `writeTestFile(tmpDir, …)`:
  Name both tests starting with `read budget:` so the step's name filter finds them.
  1. **Suggestion (fails now)**: `read` `{ paths: [big, small] }`; assert
     `failedSummary(r)?.results?.[0]?.error?.suggestion === 'Use head/tail or line ranges to read partially.'`
     and its `code === 'TOO_LARGE'`. Today `suggestion` is `undefined`.
  2. **Duplicates and order (passes now and after)**: `read` `{ paths: [big, small, small, big] }`;
     assert 4 rows, rows `[0]`/`[3]` are `TOO_LARGE`, rows `[1]`/`[2]` have no error,
     row `path`s equal the request order, and `summary` is `{ total: 4, failed: 2 }` (assert `failed === 2`; and `results.length === 4`).
  3. **Every path skipped (passes now and after)**: already covered by "a lone oversized file is
     still refused" at `:1126`; add nothing.
- In [`progress.test.ts`](../../../__tests__/progress.test.ts), inside the outer `describe`, next to the
  `'delivers the fail frame and its message'` test at [`:244`](../../../__tests__/progress.test.ts#L244) (so `progressClient` is in scope):
  **Progress total counts every requested path (fails now)**: create `root`, `big` (600 KiB) and `small`
  with `writeTestFile`, `progressClient([root])`, `pair.client.callTool({ name: 'read', arguments: { paths: [big, small] } }, { onprogress: () => {} })`;
  assert `pair.frames.some((f) => f.progress === 1 && f.total === 2)`. Today the work tick is
  `{ progress: 1, total: 1 }`. Close in `finally` like the neighbouring tests (`pair.close()`, `cleanupTestRoot(root)`).

Run `npx prettier --write` on the three test files.

**Verify**: `npm run type-check:test` → exit 0;
`node --test --test-name-pattern="batch read budget|read budget" __tests__/tools.test.ts` → exactly the new suggestion test fails (`ℹ fail 1`), the duplicates test and the old budget test pass;
`node --test --test-name-pattern="read budget" __tests__/progress.test.ts` (start the progress test's name with `read budget:` too) → `ℹ fail 1`.
If the duplicates test fails here, **STOP**: the baseline duplicate behavior differs from this plan.

### 4. Add `summarize()` to `batch.ts` and use it in `runOverPaths`

In [`batch.ts`](../../../src/tools/batch.ts) add and export:

```ts
export function summarize(results: readonly PerPathResult<unknown>[]): BatchResult<unknown>['summary'] {
  const failed = results.filter((r) => 'error' in r).length;
  return { total: results.length, succeeded: results.length - failed, failed };
}
```

Replace the inline `succeeded` loop at [`batch.ts:55-62`](../../../src/tools/batch.ts#L55-L62) with
`return { results, summary: summarize(results) };`. Keep `isTotalFailure` as is.

Create `__tests__/batch.test.ts` (`node:test` + `node:assert/strict`, import from `../src/tools/batch.ts`,
no harness needed): `summarize([])` → `{0,0,0}`; one value + one error →
`{ total: 2, succeeded: 1, failed: 1 }`; all errors → `failed === total`.

**Verify**: `node --test __tests__/batch.test.ts` → `ℹ pass 3`, `ℹ fail 0`; `npm run type-check:test` → exit 0; `node --test __tests__/tools.test.ts` → only the step-3 suggestion test fails.

### 5. Make every requested read path a batch item

In [`read.ts`](../../../src/tools/read.ts):

- Replace `collectFileBudget`'s return with one item per requested path, in request order:

  ```ts
  interface BudgetItem {
    path: string;
    known?: { validPath: string; stats: Stats };
    skip?: FsError;
  }
  ```

  `skip` is `new FsError(ErrorCode.TOO_LARGE, <same message as today>, path)` (keep the message text
  byte-identical; the `suggestion` arrives via `FsError`). A path whose `stat` failed returns `{ path }`
  with no `known` and no `skip` (the read surfaces the real error, as today). A surviving path returns
  `{ path, known: { validPath, stats } }`. Build it with `filePaths.map(...)` over the existing
  `byIndex` sizes and accumulate `total` as today ("skip this file only; a later, smaller file that
  still fits is read"). Drop the `known` Map keyed by path and the `skippedResults` / `survivors` fields.
- In `run`:

  ```ts
  const items: BudgetItem[] =
    args.paths !== undefined
      ? await collectFileBudget(args.paths, READ_MANY_MAX_TOTAL_BYTES, getMaxTextFileSize(), ctx)
      : [{ path: args.path ?? '' }];
  const { results: ordered, summary } = await runOverPaths(
    items,
    ctx,
    ErrorCode.NOT_FILE,
    ({ path, known, skip }) => {
      if (skip) throw skip;
      return readOnePath(path, args, ctx, known);
    },
  );
  ```

  Delete `pathList`, `skippedResults`, `survivors`, the `survivors.length === 0` branch, the `resultMap`/`ordered`
  re-mapping and the `failed`/`summary` recount (the old `'Unknown read failure'` fallback goes with it: with
  one result per index it was unreachable). The rest of `run` (resources, text, `structuredResults`, `isError: isTotalFailure(summary)`) is unchanged.
- Fix imports (`FsError` from `../core/errors.ts`; drop `PerPathResult` if unused). Run `npx prettier --write src/tools/read.ts`.

**Verify**: `npm run check:static` → exit 0 (eslint and knip catch leftover imports);
`node --test __tests__/tools.test.ts` → `ℹ fail 0` (the suggestion test passes, the duplicates and old budget tests still pass);
`node --test __tests__/progress.test.ts` → `ℹ fail 0` (the new progress test passes). If the progress test is flaky because the work tick is
rate-limited off the wire, **STOP** and report the frames (do not weaken it silently).

### 6. Use `summarize()` in `delete.ts`; update the README

- [`delete.ts:364-368`](../../../src/tools/delete.ts#L364-L368): replace the `failed` count and hand-built `summary` with
  `return { results, summary: summarize(results) };` and import `summarize` from `./batch.ts` (line 28). The fallback row for a missing entry stays.
- [`README.md:324`](../../../README.md#L324): `Batch helpers (runOverPaths, summarize, isTotalFailure)`, keeping the table's column alignment (run `npx prettier --write README.md`).

**Verify**: `npm run check:static` → exit 0; `node --test --test-name-pattern="delete" __tests__/tools.test.ts` → `ℹ fail 0`;
`Select-String -Path src\tools\*.ts -Pattern "filter\(\(r\) => 'error' in r\)"` → no match.

### 7. Full check; stop uncommitted

Run `npm run check`. Do NOT commit or push: commits need the user's go-ahead (the PR is then opened per
[T-18](tickets/T-18-merge-the-delete-ts-batch-findings-2-and-3.md)).

**Verify**: `npm run check` → exit 0, `ℹ tests 558` (552 + 6 new: suggestion, duplicates, read progress, 3 `summarize`), `ℹ fail 0`, `ℹ skipped 3`.

## Done

- [ ] `npm run check` exits 0 with fail 0, skipped 3, and a test total of 552 plus the tests added
- [ ] the new suggestion test and read-progress test failed in step 3 and pass now
- [ ] `git grep -n "droppedInputResponseKeys: ctx\.dropped\|requestState: ctx\.requestState" -- src` prints nothing
- [ ] `git grep -n "survivors\|skippedResults\|Unknown read failure" -- src/tools/read.ts` prints nothing
- [ ] `git grep -n "from '../tools" -- src/core/input-required.ts` prints nothing (core imports nothing from tools)
- [ ] `git status --short` lists only the in-scope files above (plus this plan directory) and nothing is committed

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its excerpt.
- A step's verification fails twice after one fix attempt.
- The fix appears to require an out-of-scope file (notably `errors.ts`, `edit.ts`, `stat.ts`, `http.ts`).
- The step-3 duplicates test fails on the unchanged code: this plan's duplicate-path premise is false.
- A refusal string changes, or `tools.test.ts` / `input-required.test.ts` refusal assertions fail after step 2: refusal text must stay byte-identical.
- `ToolCtx` does not satisfy `PendingCtx` without editing `ToolCtx` (for example `requestState`'s accessor type is not assignable): that means the structural premise of T-13 is false.
- `__tests__/input-required.test.ts` has drifted by another batch (finding 4 edits the dispose-hook blocks near lines 98 and 577): rebase onto `main` and re-grep the call sites before continuing, rather than resolving conflicts blindly.

## Notes

- **Audit premises corrected**: (1) the audit's "13 calls" is 10 `pendingRoundTrip` + 3 `describeRefusal` in `input-required.test.ts`; (2) audit line numbers are stale (all re-grepped here); (3) "no test pins either visible change" is true, hence the tests in step 3; (4) the audit's `skip` as a "Problem" cannot be thrown as a plain object, so the item carries an `FsError` (see Current state).
- Reviewer focus: the `Pick<PendingCtx, …>` parameter of `describeRefusal` (keeps `executePlan`/`executeTransfer` ctx types narrow); that no path in `read` loses its original-string `path` on the error row (`runOverPaths` fills it from the item); `delete` still does phase 1 plan → confirmation → phase 2 with `processInParallel` (R14).
- Visible changes, deliberate (T-04): a budget-skipped `TOO_LARGE` row gains `suggestion: 'Use head/tail or line ranges to read partially.'`; the read progress total is the requested path count, so a batch with a skipped file reports `n/n` instead of `(n-skipped)/(n-skipped)`.
- Rollback: `git switch main && git branch -D refactor/delete-batch-pendingctx-read-budget` (nothing is committed or pushed by this plan).
