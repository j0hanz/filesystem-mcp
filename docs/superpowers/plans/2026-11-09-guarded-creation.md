# Guarded Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `GuardedFileSystem` the whole Creation lifecycle (`planCreate`/`executeCreate` + one-shot `create`), and reduce `src/tools/create.ts` to batch policy, the Confirmation round, and result metadata.

**Architecture:** Same two-phase shape ADR-011 gave Deletion: plan classifies every file write and seals the Landing identity of a pending overwrite; execute takes the write lock, re-checks identity, and dispatches. Every file write crosses the seam — append and `overwrite: true` take pre-settled plans, not a side path. Directories keep one-shot `mkdir`. The tool keeps schema batch policy, the Confirmation and its verdict mapping, and transport-aware metadata assembly.

**Tech Stack:** TypeScript 7 native build (ADR-009 alias), `node:test`, zod. Node >= 24.

**Spec:** `docs/adr/012-guarded-filesystem-owns-creation.md` (the decision; read before starting). `GLOSSARY.md` defines **Creation**.

## Global Constraints

- Node >= 24 (`package.json` engines). No new dependencies; no `tsconfig` edits.
- Gate is `npm run check` (static + tests). Quick loop: `npm run check:static`; single test: `npm test -- --test-name-pattern="<pattern>"`.
- **Contract snapshot must stay byte-identical** (`__tests__/contract.test.ts.snapshot`): no advertised surface changes in this plan. A snapshot diff is a STOP condition.
- Error texts below are pinned verbatim — they are contract-visible. Changing one is a STOP condition.
- `docs/adr/012` and `GLOSSARY.md` are already recorded; do not re-decide or re-edit them.
- After code changes: run `graphify update .` (commit only if `git status` shows a tracked diff).
- Conventional Commits; end every commit message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- House test rules (`CLAUDE.md`): drive a tool body through `runToolBodyResult` in its own test file; keep the wire for what the executor adds. New `GuardedFileSystem` invariants go in `__tests__/core-fs.test.ts` beside the Deletion ones.

## Review Focus

1. **Pending overwrite swapped while the prompt was open** → `CANCELLED`, `create cancelled: "<input>" was replaced after the overwrite was approved.` — Task 2 test.
2. **File appears at a clear path while the prompt was open** → `CANCELLED`, `create refused: "<input>" appeared after overwrite confirmation was checked` — Task 2 test; the end-to-end alias case is already pinned by `__tests__/create.test.ts` "never overwrites, through an alias, a file that appeared after planning" — Task 3 keeps it green.
3. **Directory named as a file** → `NOT_FILE` `Not a regular file` at plan, before the Confirmation round; sibling entries still prompt and write — Task 1 test; Task 3 keeps `create.test.ts`'s directory-in-batch test green.
4. **Append is pre-settled**: never prompts, creates a missing file, and an append the write guard refuses now fails at plan with the guard's own error — Task 1 (classification) and Task 2 (dispatch) tests.
5. **Undo survives the move**: the Capture is taken inside `writeFile`/`appendFile`, so a created file still gets an undo id and restores — Task 3 runs the undo round-trip test.

---

### Task 1: `planCreate` classifies every write

**Files:**

- Modify: `src/core/fs.ts` (insert after the one-shot `delete` method, ~line 798)
- Test: `__tests__/core-fs.test.ts` (add a `Creation` block after the one-shot delete test, ~line 1206)

**Interfaces:**

- Consumes: `this.pathGuard.validatePathForWrite(path)`, `destIdentity(fs, path, label)` (`fs.ts:1810`), `EntryIdentity`.
- Produces (Task 2 and Task 3 consume exactly these):

```ts
export interface CreatePlan {
  inputPath: string;
  validPath: string;
  kind: 'append' | 'overwrite' | 'clear' | 'pending';
  identity?: EntryIdentity; // present iff kind === 'pending'
}

// on GuardedFileSystem
planCreate(
  path: string,
  options?: { append?: boolean | undefined; overwrite?: boolean | undefined; signal?: AbortSignal | undefined },
): Promise<CreatePlan>
```

- [ ] **Step 1: Write the failing tests** (house style of the `planDelete` tests at `core-fs.test.ts:1167`)

```ts
it('planCreate classifies each write and refuses a directory', async () => {
  const fresh = await fs.planCreate(join(tmpDir, 'create-new.txt'), {});
  assert.strictEqual(fresh.kind, 'clear');

  const existing = await writeTestFile(tmpDir, 'create-existing.txt', 'old');
  const pending = await fs.planCreate(existing, {});
  assert.strictEqual(pending.kind, 'pending');
  assert.strictEqual(pending.identity?.itemType, 'file');

  assert.strictEqual((await fs.planCreate(existing, { overwrite: true })).kind, 'overwrite');
  assert.strictEqual((await fs.planCreate(existing, { append: true })).kind, 'append');

  await assert.rejects(
    () => fs.planCreate(tmpDir, {}),
    (err: unknown) => {
      assert.ok(isFsError(err));
      assert.strictEqual(err.code, ErrorCode.NOT_FILE);
      assert.strictEqual(err.message, 'Not a regular file');
      return true;
    },
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="planCreate"`
Expected: FAIL — `planCreate is not a function`.

- [ ] **Step 3: Implement `CreatePlan` + `planCreate` in `src/core/fs.ts`**

JSDoc it like `planDelete` (`fs.ts:647`), referencing "Creation (see GLOSSARY.md)". Order is load-bearing (a directory throws even under `overwrite: true`):

```ts
async planCreate(path, options = {}) {
  options.signal?.throwIfAborted();
  const validPath = await this.pathGuard.validatePathForWrite(path);
  const identity = await destIdentity(this, validPath, 'create');
  if (identity?.itemType === 'directory')
    throw new FsError(ErrorCode.NOT_FILE, 'Not a regular file', path);
  const kind = options.append ? 'append' : options.overwrite ? 'overwrite'
    : identity !== undefined ? 'pending' : 'clear';
  return { inputPath: path, validPath, kind, ...(kind === 'pending' ? { identity } : {}) };
}
```

`destIdentity` returns `UNKNOWN_IDENTITY` for a refused stat, not `undefined`, so a destination that cannot be named is classified `pending` — confirmed, never written over as absent. Do not change that.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --test-name-pattern="planCreate"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/fs.ts __tests__/core-fs.test.ts
git commit -m "feat(core/fs): plan the Creation lifecycle with planCreate" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: `executeCreate` and the one-shot `create`

**Files:**

- Modify: `src/core/fs.ts` (after `planCreate`)
- Test: `__tests__/core-fs.test.ts` (same `Creation` block)

**Interfaces:**

- Consumes: `CreatePlan`/`planCreate` (Task 1); existing `lockForWrite` (`fs.ts:401`, guards and passes the resolved key; `writeFile`/`appendFile` do not take the lock), `writeFile(filePath, content, { signal, mode? })` (`fs.ts:919`), `appendFile(filePath, content, { signal })` (`fs.ts:1066`), `mkdir(dir, { recursive: true })`, `destIdentity`, `sameIdentity`.
- Produces (Task 3 consumes exactly these):

```ts
// on GuardedFileSystem
executeCreate(
  plan: CreatePlan,
  content: string,
  options?: { signal?: AbortSignal | undefined },
): Promise<{ validPath: string; writtenAt: Date }>

create( // one-shot, no Confirmation; mirrors delete()
  path: string,
  content: string,
  options?: { append?: boolean | undefined; overwrite?: boolean | undefined; signal?: AbortSignal | undefined },
): Promise<{ validPath: string; writtenAt: Date }>
```

- [ ] **Step 1: Write the failing tests**

```ts
it('executeCreate refuses a pending overwrite replaced since the plan', async () => {
  const p = join(tmpDir, 'create-swap.txt');
  await writeTestFile(tmpDir, 'create-swap.txt', 'old');
  const plan = await fs.planCreate(p, {});
  await rm(p);
  await writeTestFile(tmpDir, 'create-swap.txt', 'other');
  await assert.rejects(
    () => fs.executeCreate(plan, 'new'),
    (err: unknown) =>
      isFsError(err) && err.code === ErrorCode.CANCELLED &&
      /replaced after the overwrite was approved/u.test(err.message),
  );
  assert.strictEqual(await readFile(p, 'utf-8'), 'other');
});

it('executeCreate refuses a file that appeared at a clear path since the plan', async () => {
  const p = join(tmpDir, 'create-appeared.txt');
  const plan = await fs.planCreate(p, {});
  await writeTestFile(tmpDir, 'create-appeared.txt', 'raced');
  await assert.rejects(
    () => fs.executeCreate(plan, 'new'),
    (err: unknown) =>
      isFsError(err) && err.code === ErrorCode.CANCELLED &&
      /appeared after overwrite confirmation was checked/u.test(err.message),
  );
  assert.strictEqual(await readFile(p, 'utf-8'), 'raced');
});

it('executeCreate writes a clear path, appends a missing file, and clobbers under overwrite', async () => {
  const clearPlan = await fs.planCreate(join(tmpDir, 'create-write.txt'), {});
  const wrote = await fs.executeCreate(clearPlan, 'hello');
  assert.strictEqual(wrote.validPath, clearPlan.validPath);
  assert.ok(wrote.writtenAt instanceof Date);

  const appendPlan = await fs.planCreate(join(tmpDir, 'create-append.txt'), { append: true });
  await fs.executeCreate(appendPlan, 'line');
  assert.strictEqual(await readFile(appendPlan.validPath, 'utf-8'), 'line');

  const clobber = join(tmpDir, 'create-clobber.txt');
  await writeTestFile(tmpDir, 'create-clobber.txt', 'old');
  await fs.executeCreate(await fs.planCreate(clobber, { overwrite: true }), 'new');
  assert.strictEqual(await readFile(clobber, 'utf-8'), 'new');
});

it('one-shot create plans then executes', async () => {
  const res = await fs.create(join(tmpDir, 'create-oneshot.txt'), 'content');
  assert.ok(isSamePath(res.validPath, join(tmpDir, 'create-oneshot.txt')));
  assert.strictEqual(await readFile(res.validPath, 'utf-8'), 'content');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern="executeCreate"`
Expected: FAIL — `executeCreate is not a function`.

- [ ] **Step 3: Implement `executeCreate` + `create` in `src/core/fs.ts`**

Both messages are contract-visible — exact copy. The re-check reads `resolvedTarget` (the lock's resolved key), matching today's tool code:

```ts
async executeCreate(plan, content, options = {}) {
  options.signal?.throwIfAborted();
  return this.lockForWrite(plan.validPath, async (resolvedTarget) => {
    if (plan.kind === 'pending') {
      const now = await destIdentity(this, resolvedTarget, 'create');
      if (now !== undefined && !sameIdentity(now, plan.identity!))
        throw new FsError(
          ErrorCode.CANCELLED,
          `create cancelled: "${plan.inputPath}" was replaced after the overwrite was approved.`,
          plan.inputPath,
        );
    }
    if (plan.kind === 'clear' &&
        (await destIdentity(this, resolvedTarget, 'create')) !== undefined)
      throw new FsError(
        ErrorCode.CANCELLED,
        `create refused: "${plan.inputPath}" appeared after overwrite confirmation was checked`,
        plan.inputPath,
      );
    await this.mkdir(dirname(plan.validPath), { recursive: true });
    const written = plan.kind === 'append'
      ? await this.appendFile(plan.validPath, content, { signal: options.signal })
      : await this.writeFile(plan.validPath, content, { signal: options.signal });
    return { validPath: written.validPath, writtenAt: new Date() };
  });
}

async create(path, content, options = {}) {
  const plan = await this.planCreate(path, options);
  return this.executeCreate(plan, content, options);
}
```

Keep today's load-bearing comments when moving code: the in-process-only lock shortcut comment on the re-check window, and `writeFile`/`appendFile` owning the Capture. `dirname` is already imported in `fs.ts`; verify with `npm run check:static`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- --test-name-pattern="executeCreate"` then `npm test -- --test-name-pattern="create"` (create.test.ts must stay green — nothing consumed the seam yet).
Expected: PASS, both.

- [ ] **Step 5: Commit**

```bash
git add src/core/fs.ts __tests__/core-fs.test.ts
git commit -m "feat(core/fs): execute Creation with executeCreate and one-shot create" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: the create tool delegates

**Files:**

- Modify: `src/tools/create.ts` — planner block (~lines 184-222), file slot construction (~lines 225-295), `createOne` (~lines 357-460)
- Test: `__tests__/create.test.ts` (keep green; no new tests required — the alias, directory-in-batch and schema tests now exercise the seam end to end)

**Interfaces:**

- Consumes: `planCreate`/`executeCreate`/`CreatePlan` exactly as defined in Tasks 1-2; `BatchSlot` statuses `settled`/`failure`/`omitted`/`pending` (`src/tools/batch.ts:12`); `confirm(ctx, 'create', 'overwrite', items)`; `runToolBodyResult` (unchanged).
- Produces: nothing new — `CREATE`'s advertised schema, structured output, progress and text are unchanged.

- [ ] **Step 1: Reorganize `run` into `handleCreate` mirroring `delete.ts`**

Mirror `handleDelete` (`delete.ts:141-283`) piece for piece:

- `planFile(file, ctx)` mirrors `planPath`: `try { const plan = await ctx.fs.planCreate(file.path, { append: file.append, overwrite: file.overwrite, signal: ctx.signal }); return { status: 'plan', plan }; } catch` → failure result mapped the way `toDeleteFailure` maps, abort handling included. Plan still runs via `processInParallel`.
- Failed plans become `{ status: 'failure', path, error }` slots pre-settled before the Confirmation round; every other plan becomes a `pending` slot whose `run` does, in order:
  1. If `plan.kind === 'pending'`: `const verdict = confirmed.verdict(plan.validPath)`; `skipped` → return `{ skipped: plan.inputPath }`; any non-`proceed` verdict → throw `FsError(ErrorCode.CANCELLED, …)` with today's two texts, verbatim, labeled with `plan.inputPath`:
     - changed: `create cancelled: "<input>" was replaced again while the prompt was open.`
     - else: `create cancelled: overwrite of "<input>" was <verdict.refused>`
  2. `const { validPath, writtenAt } = await c.fs.executeCreate(plan, file.content, { signal: c.signal });`
  3. `return createOne(validPath, writtenAt, file.content, file.append, c);`
- Confirmation items come from `pending` plans: `{ path: plan.validPath, identity: plan.identity, required: true, message: \`"${plan.validPath}" already exists. Overwrite it?\` }` — message verbatim.
- Delete the `folders` set and its slot guard (`create.ts:226-228`): `planCreate` now refuses directories at plan. Delete the stale "left for runOverPaths to report" comment.
- The `dirBatch` (one-shot `mkdir` slots) and its position after the Confirmation are unchanged; dirs get no plan.
- Schema `superRefine`, `mapPaths`, `progress`/`progressDone`, summary and report assembly are unchanged.

- [ ] **Step 2: Slim `createOne` to metadata only**

New signature `createOne(validPath: string, writtenAt: Date, content: string, append: boolean | undefined, ctx: ToolCtx)`. Remove the `mkdir` and the write/append dispatch (now inside `executeCreate`); keep both metadata branches exactly as they are — the append branch's degraded-stat handling, MIME sniff and line-count cap, the write branch's `statAfterWrite` + `buildWrittenFileMeta`, `created`/`modified` derivation — now keyed on the `validPath` parameter instead of a write result. Keep their comments; they explain why metadata is best-effort.

- [ ] **Step 3: Fix imports**

`create.ts` drops `destIdentity`, `sameIdentity` and (if now unused) `EntryIdentity` from `'../core/fs.ts'`, adds `type CreatePlan`, and keeps `type Stats`. `validatePathForWrite` is no longer called from the tool. `npm run check:static` must be clean (lint catches stragglers like `dirname`).

- [ ] **Step 4: Verify the suite and the wire**

Run: `npm test -- --test-name-pattern="create"` then `npm test`
Expected: PASS — including "never overwrites, through an alias, a file that appeared after planning" (`create.test.ts:548`), the directory-in-batch test (`create.test.ts:~306`), `undo.test.ts`, `mutation-regressions.test.ts`, and the undo round-trip for a created file (Review Focus line 5).

- [ ] **Step 5: Commit**

```bash
git add src/tools/create.ts
git commit -m "refactor(tools/create): delegate the Creation lifecycle to GuardedFileSystem" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 4: gates

**Files:** no new code — verification and repo hygiene only.

**Interfaces:** none.

- [ ] **Step 1: Full gate**

Run: `npm run check`
Expected: green (static + tests). Fix anything it flags in the task that owns the code; a contract snapshot diff or a changed pinned message is a STOP condition, not a fix.

- [ ] **Step 2: Contract snapshot explicitly unchanged**

Run: `npm test -- --test-name-pattern="contract"`
Expected: PASS with no `.snapshot` diff in `git status`.

- [ ] **Step 3: Refresh the graph**

Run: `graphify update .`
Expected: succeeds; commit only if `git status` shows a tracked `graphify-out` diff:

```bash
git add graphify-out
git commit -m "chore: refresh graphify graph after Creation deepening" \
  -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
