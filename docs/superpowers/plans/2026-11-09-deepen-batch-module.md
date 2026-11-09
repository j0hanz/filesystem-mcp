# Deepen batch module implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the `batch` module into a full batch lifecycle executor (`executeBatchSlots`) that preserves caller input order, absorbs pre-settled outcomes (noops, duplicates, plan refusals), standardizes cancellation preservation, and unifies parallel execution across `delete`, `move`, `create`, and `edit`.

**Architecture:** Extend `src/tools/batch.ts` with `executeBatchSlots` accepting an indexed array of `BatchSlot<T>` descriptors (pre-settled values, pre-settled failures, omitted slots, or pending async execution callbacks). `executeBatchSlots` manages parallel concurrency, multi-stage progress offsets, input-order slot filling, and abort signal preservation. `delete.ts`, `move.ts`, and `create.ts` delegate their post-confirmation execution phase to `executeBatchSlots`, eliminating ~180 lines of hand-rolled progress counters, manual slot indexing, and conflicting cancellation behaviors.

**Tech Stack:** TypeScript (Node 22+ built-in test runner `node:test`, `node:assert/strict`), MCP SDK (`@modelcontextprotocol/server`).

**Spec:** Grilling alignment (2026-11-09) following ADR-007, ADR-008 Amendment, ADR-011, and [`GLOSSARY.md`](../../../GLOSSARY.md).

## Global Constraints

- **Contract snapshots**: Never alter the MCP surface snapshot in `__tests__/contract.test.ts.snapshot` without explicit design mandate.
- **Confirmation boundary (ADR-007)**: Do not move Confirmation prompt elicitation into the batch engine; each tool retains its own Confirmation round, calling `executeBatchSlots` only for the post-confirmation mutation execution.
- **Cancellation invariance**: When `ctx.signal` fires, items that already landed on disk must be preserved in `results`; unstarted items must receive the abort `Problem` so callers can safely retry.
- **Caller input ordering**: Non-omitted results must always align 1:1 with the caller's input array in exact original order.
- **No unapproved dependencies**: Use existing primitives in `src/core/concurrency.ts` (`processInParallel`) and `src/core/errors.ts` (`Problem`, `ErrorCode`, `PerPathResult`).

## Review Focus

1. **Cancellation preservation during partial completion**: When `ctx.signal` fires midway through a batch of 5 items where 2 finished, the resulting `results` array must have 2 succeeded items and 3 items with `CANCELLED` errors, in exact input order.
2. **Omitted slot deduplication**: In `delete`, when duplicate input paths occur (e.g. `['a', 'b', 'a']`), slot 2 is marked `omitted` and omitted from the returned `results` array, yielding 2 results (`a` and `b`), without throwing out-of-bounds or array hole errors.
3. **Pre-settled failure preservation**: A path that fails pre-validation (e.g. nested delete collision or merge refusal) in slot 0 followed by valid pending items in slots 1 and 2 must preserve the pre-settled failure in `results[0]` alongside the executed results in `results[1]` and `results[2]`.
4. **Multi-stage progress monotonicity**: In a multi-stage operation (like `create`), progress notifications must monotonically increase from `1` to `dirs + files`, with the second stage beginning at `dirs.length + 1` rather than resetting to `1`.
5. **Zero-item batch**: An empty array of slots (`[]`) passed to `executeBatchSlots` must return `{ results: [], summary: { total: 0, succeeded: 0, failed: 0 } }` without triggering progress ticks or errors.

---

### Task 1: Record batch concept in GLOSSARY.md

**Files:**

- Modify: `GLOSSARY.md`

**Interfaces:**

- Produces: New `## Batches` section with `**Batch**` definition in domain vocabulary.

- [ ] **Step 1: Check existing `GLOSSARY.md` structure**

Verify current sections (`Path views`, `Scans`, `Matching`, `Writes`, `Undo`, `Approval`, `Transport`).

- [ ] **Step 2: Add `## Batches` section to `GLOSSARY.md`**

In `GLOSSARY.md`, after `## Writes` (or after `## Approval`), add:

```markdown
## Batches

**Batch**:
A multi-item execution on a client's behalf that preserves the client's input
order across all settled items. Pre-settled items (noops, duplicates, plan-time
refusals) take their slots without mutation; pending items run concurrently under
the call's concurrency and cancellation rules. On abort or deadline, finished
items are preserved and unstarted items report the abort, so a retried call knows
what already landed.
_Avoid_: parallel loop, bulk run, multi-op
```

- [ ] **Step 3: Verify formatting**

Run: `git diff GLOSSARY.md`
Ensure formatting and terminology match project conventions.

- [ ] **Step 4: Commit**

```bash
git add GLOSSARY.md
git commit -m "docs(glossary): add domain definition for Batch"
```

---

### Task 2: Implement executeBatchSlots in src/tools/batch.ts

**Files:**

- Modify: `src/tools/batch.ts`
- Test: `__tests__/batch.test.ts`

**Interfaces:**

- Consumes:
  - `processInParallel` from `../core/concurrency.ts`
  - `Problem`, `ErrorCode`, `PerPathResult` from `../core/errors.ts`
  - `PARALLEL_CONCURRENCY` from `../core/util.ts`
  - `ToolCtx` from `./define.ts`
- Produces:

  ```ts
  export type BatchSlot<T> =
    | { readonly status: 'settled'; readonly path: string; readonly value: T }
    | { readonly status: 'failure'; readonly path: string; readonly error: Problem }
    | { readonly status: 'omitted' }
    | {
        readonly status: 'pending';
        readonly path: string;
        readonly run: (ctx: ToolCtx) => Promise<T>;
      };

  export interface BatchExecutionOptions {
    readonly defaultErrorCode?: ErrorCode;
    readonly progressOffset?: number;
    readonly progressTotal?: number;
  }

  export async function executeBatchSlots<T>(
    slots: readonly BatchSlot<T>[],
    ctx: ToolCtx,
    options?: BatchExecutionOptions,
  ): Promise<BatchResult<T>>;
  ```

- [ ] **Step 1: Write failing tests in `__tests__/batch.test.ts`**

Add tests exercising:

1. Mixed pre-settled and pending slots in exact input order.
2. Omitted slots properly excluded from `results`.
3. Cancellation preserving finished items and marking unstarted pending slots with the abort error.
4. Multi-stage progress tracking using `progressOffset` and `progressTotal`.

```ts
it('executeBatchSlots preserves input order across settled, failure, omitted, and pending slots', async () => {
  const slots: BatchSlot<{ val: number }>[] = [
    { status: 'settled', path: 'a.txt', value: { val: 1 } },
    { status: 'omitted' },
    { status: 'failure', path: 'c.txt', error: Problem.notFound('c.txt') },
    { status: 'pending', path: 'd.txt', run: async () => ({ val: 4 }) },
  ];
  const ctx = createMockToolCtx();
  const res = await executeBatchSlots(slots, ctx);
  assert.equal(res.results.length, 3);
  assert.equal(res.results[0]?.path, 'a.txt');
  assert.equal(res.results[1]?.path, 'c.txt');
  assert.equal(res.results[2]?.path, 'd.txt');
  assert.equal(res.summary.total, 3);
  assert.equal(res.summary.succeeded, 2);
  assert.equal(res.summary.failed, 1);
});

it('executeBatchSlots preserves completed items when aborted and marks unstarted items', async () => {
  const ac = new AbortController();
  const slots: BatchSlot<{ val: number }>[] = [
    {
      status: 'pending',
      path: 'first.txt',
      run: async () => {
        ac.abort(new Error('timed out'));
        return { val: 1 };
      },
    },
    {
      status: 'pending',
      path: 'second.txt',
      run: async () => {
        return { val: 2 };
      },
    },
  ];
  const ctx = createMockToolCtx({ signal: ac.signal });
  const res = await executeBatchSlots(slots, ctx);
  assert.equal(res.results.length, 2);
  assert.ok('value' in (res.results[0] ?? {}));
  assert.ok('error' in (res.results[1] ?? {}));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test __tests__/batch.test.ts`
Expected: FAIL (`executeBatchSlots is not defined`).

- [ ] **Step 3: Implement `executeBatchSlots` and rewrite `runOverPaths`**

In `src/tools/batch.ts`:

1. Define `BatchSlot<T>` and `BatchExecutionOptions`.
2. Implement `executeBatchSlots`:
   - Initialize `results = new Array<PerPathResult<T> | undefined>(slots.length)`.
   - Pre-populate settled and failure slots in `results`; leave omitted slots as `undefined`.
   - Identify pending slots: `pending = slots.map((slot, index) => ({ slot, index })).filter(({ slot }) => slot.status === 'pending')`.
   - Calculate `progressTotal = options?.progressTotal ?? pending.length`.
   - Set `completed = options?.progressOffset ?? 0`.
   - Execute pending slots with `processInParallel`. In `tick()`, increment `completed` and notify `ctx.onProgress({ current: completed, total: progressTotal })`.
   - On success, assign `results[index] = { path: slot.path, value }`.
   - On item error, assign `results[index] = { path: slot.path, error: Problem.fromUnknown(error, defaultErrorCode, slot.path) }`.
   - Catch top-level abort/error: for any slot where `slot.status === 'pending'` and `results[index] === undefined`, populate `results[index] = { path: slot.path, error: Problem.fromUnknown(error, defaultErrorCode, slot.path) }`.
   - Return `{ results: results.filter((r): r is PerPathResult<T> => r !== undefined), summary: summarize(...) }`.
3. Simplify `runOverPaths` to map `items` into `BatchSlot<TPerPath>[]` and delegate directly to `executeBatchSlots`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test __tests__/batch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/batch.ts __tests__/batch.test.ts
git commit -m "feat(batch): introduce executeBatchSlots with slot preservation and abort handling"
```

---

### Task 3: Delegate deletion batch execution to executeBatchSlots

**Files:**

- Modify: `src/tools/delete.ts`
- Test: `__tests__/delete.test.ts`

**Interfaces:**

- Consumes:
  - `executeBatchSlots`, `BatchSlot` from `./batch.ts`
  - `executePlan` from `src/tools/delete.ts`
- Produces: `handleDelete` returns `DeleteOutput` using `executeBatchSlots` without manual `out` slot mapping or `Unknown delete failure` fallback.

- [ ] **Step 1: Inspect existing deletion tests**

Run: `node --test __tests__/delete.test.ts`
Confirm all existing tests pass before touching code.

- [ ] **Step 2: Add a test for delete duplicate omission and abort preservation**

In `__tests__/delete.test.ts`:
Verify that passing duplicate paths returns deduplicated results in order, and that an aborted batch preserves finished deletions.

- [ ] **Step 3: Refactor `handleDelete` in `src/tools/delete.ts`**

In `src/tools/delete.ts`:

1. Build `BatchSlot<{ deleted: boolean }>[]` from `paths`:
   - Duplicate paths -> `{ status: 'omitted' }`
   - Planned failures (`r.status === 'fail'`) -> `{ status: 'failure', path: r.failure.path, error: r.failure.error }`
   - Nested collisions -> `{ status: 'failure', path: plan.validPath, error: Problem.invalidInput(...) }`
   - No-op (`r.status === 'noop'`) -> `{ status: 'settled', path: r.deleted, value: { deleted: true } }`
   - Confirmed executable plan -> `{ status: 'pending', path: plan.validPath, run: async (ctx) => { const r = await executePlan(plan, ctx, confirmed); if ('skipped' in r) return { deleted: false }; if ('failure' in r) throw r.failure.error; return { deleted: true }; } }`
2. Replace `processInParallel(plans, ...)` and the manual `out` array loop with:
   ```ts
   const structured = await executeBatchSlots(slots, ctx, {
     defaultErrorCode: ErrorCode.UNKNOWN,
   });
   return structured;
   ```
3. Remove unused local helpers (`seenTargets`, `duplicates`, `executed`, manual slot remapping).

- [x] **Step 4: Run tests to verify all delete tests pass**

Run: `node --test __tests__/delete.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/tools/delete.ts __tests__/delete.test.ts
git commit -m "refactor(tools/delete): delegate batch execution to executeBatchSlots"
```

---

### Task 4: Delegate move batch execution to executeBatchSlots

**Files:**

- Modify: `src/tools/move.ts`
- Test: `__tests__/move.test.ts`

**Interfaces:**

- Consumes:
  - `executeBatchSlots`, `BatchSlot` from `./batch.ts`
  - `ctx.fs.executeTransfer`
- Produces: `move.ts` execution loop delegates to `executeBatchSlots`, eliminating hand-rolled `tick()` and retaining finished moves on abort.

- [x] **Step 1: Inspect existing move tests**

Run: `node --test __tests__/move.test.ts`
Confirm all existing move tests pass.

- [x] **Step 2: Write test for move cancellation preserving completed transfers**

In `__tests__/move.test.ts`:
Add a test ensuring that an aborted multi-pair move preserves pairs that completed before the abort signal was received.

- [x] **Step 3: Refactor execution in `src/tools/move.ts`**

In `src/tools/move.ts`:

1. Build `BatchSlot<TransferResultItem>[]` from `args.pairs`:
   - Duplicate pairs (from `duplicateSources`, `duplicateDests`) -> `{ status: 'failure', path: pair.source, error: Problem.invalidInput(...) }`
   - Merge check failures -> `{ status: 'failure', path: plan.request.source, error }`
   - Confirmation skipped -> `{ status: 'settled', path: plan.request.destination, value: { skipped: plan.request.destination } }`
   - Confirmed executable transfers -> `{ status: 'pending', path: plan.request.destination, run: async (ctx) => { ... return { value: moved }; } }`
2. Replace lines 247-285 (custom `tick()`, `processInParallel(safe, ...)`, `rethrowIfAborted(error)`) with `executeBatchSlots(slots, ctx, { defaultErrorCode: ErrorCode.UNKNOWN })`.
3. Clean up manual progress tracking and failure concatenation.

- [x] **Step 4: Run tests to verify all move tests pass**

Run: `node --test __tests__/move.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/tools/move.ts __tests__/move.test.ts
git commit -m "refactor(tools/move): delegate batch execution to executeBatchSlots"
```

---

### Task 5: Support multi-stage progress in create with executeBatchSlots

**Files:**

- Modify: `src/tools/create.ts`
- Test: `__tests__/create.test.ts`

**Interfaces:**

- Consumes:
  - `executeBatchSlots`, `BatchSlot` from `./batch.ts`
- Produces: `create.ts` runs directory and file creation stages through `executeBatchSlots` using `progressOffset` and `progressTotal`.

- [x] **Step 1: Inspect existing create tests**

Run: `node --test __tests__/create.test.ts`
Confirm all create tests pass.

- [x] **Step 2: Refactor directory and file execution in `src/tools/create.ts`**

In `src/tools/create.ts`:

1. Calculate `totalProgress = dirs.length + files.length`.
2. Run directory creation stage:
   ```ts
   const dirSlots: BatchSlot<string>[] = dirs.map((dir) => ({
     status: 'pending',
     path: dir,
     run: async () => {
       await ctx.fs.mkdir(dir, { recursive: true });
       return dir;
     },
   }));
   const dirBatch = await executeBatchSlots(dirSlots, ctx, {
     progressOffset: 0,
     progressTotal,
     defaultErrorCode: ErrorCode.UNKNOWN,
   });
   ```
3. Run file creation stage:
   ```ts
   const fileSlots: BatchSlot<CreateFileEntryResult>[] = files.map((file) => ({
     status: 'pending',
     path: file.path,
     run: async (c) => createOneFile(file, c),
   }));
   const fileBatch = await executeBatchSlots(fileSlots, ctx, {
     progressOffset: dirs.length,
     progressTotal,
     defaultErrorCode: ErrorCode.UNKNOWN,
   });
   ```
4. Remove custom `progressFrom` wrapper closures.

- [x] **Step 3: Run tests to verify all create tests pass**

Run: `node --test __tests__/create.test.ts`
Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add src/tools/create.ts __tests__/create.test.ts
git commit -m "refactor(tools/create): use executeBatchSlots with multi-stage progress"
```

---

### Task 6: Static checks, contract verification, and suite validation

**Files:**

- Test: `__tests__/contract.test.ts`, all test suites

**Interfaces:**

- Consumes: All modules
- Produces: Clean static checks, unmodified contract snapshot, 100% passing test suite.

- [x] **Step 1: Run static checks (types, lint, knip)**

Run: `npm run check:static`
Expected: Code 0 (no TypeScript errors, no ESLint errors, no Knip unused exports).

- [x] **Step 2: Run contract snapshot check**

Run: `node --test __tests__/contract.test.ts`
Expected: PASS (contract surface unchanged).

- [x] **Step 3: Run full test suite**

Run: `npm test`
Expected: PASS across all test files.

- [x] **Step 4: Commit if any formatting or adjustments made**

```bash
git add -u
git commit -m "chore(batch): satisfy check and contract verification"
```
