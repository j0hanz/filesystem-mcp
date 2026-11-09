# Guarded Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen guarded deletion into `GuardedFileSystem` via `planDelete` and `executeDelete`, making `GuardedFileSystem` the sole owner of deletion planning, sensitive-file and workspace root policy checks, undo capture, and write-time identity verification.

**Architecture:** Mirror the two-phase Transfer lifecycle established in ADR-008 Amendment (`planTransfer` / `executeTransfer`). `GuardedFileSystem` owns `planDelete`, `executeDelete`, and a one-shot `delete` method; `PathGuard` enforces workspace root deletion protection; `src/tools/delete.ts` shrinks down to batch deduplication, Confirmation elicitation, and result reporting.

**Tech Stack:** TypeScript (Node 22+ built-in test runner `node:test`, `node:assert/strict`), MCP SDK (`@modelcontextprotocol/server`).

**Spec:** [`docs/adr/011-guarded-filesystem-owns-deletion.md`](../../adr/011-guarded-filesystem-owns-deletion.md) and [`GLOSSARY.md`](../../../GLOSSARY.md#writes).

## Global Constraints

- **No external shell or unauthorized tools**: Every file read, write, edit, and check must use `filesystem-mcp` tools when operating within this session constraint.
- **Contract snapshots**: Never break the MCP tool contract published in `__tests__/contract.test.ts.snapshot` (schema names, tool descriptions, and error codes must remain exact).
- **Confirmation boundary (ADR-007)**: Do not place write-time checks behind `confirmation.ts`; `executeDelete` owns write-time verification in `GuardedFileSystem`.
- **Transfer parity (ADR-008 Amendment)**: `DeletePlan` and `executeDelete` follow the naming, lifecycle, and error conventions established for `TransferPlan` and `executeTransfer`.

## Review Focus

1. **Missing path with `ignoreIfNotExists`**: A missing path with `ignoreIfNotExists=false` must fail at plan time with `NOT_FOUND`, while `ignoreIfNotExists=true` returns `noop: true` and succeeds in `executeDelete` without touching disk.
2. **Workspace root deletion refusal**: An attempt to delete an allowed workspace root directly or via symlink/junction must be refused with `Problem.accessDenied('Deleting a workspace root directory is not allowed')` at the guard/plan seam before any Confirmation.
3. **Write-time identity swap**: An entry replaced during the Confirmation gap (different `dev`/`ino` or `birthtimeMs`) must be refused in `executeDelete` with `FsError(ErrorCode.CANCELLED, ...)` rather than executing removal against the swapped entry.
4. **Sensitive-entry protection in non-empty trees**: A recursive directory holding sensitive files must set `holdsProtected: true` in `DeletePlan`, causing the tool to mark undo as abandoned with reason `contains files protected by the sensitive-file policy`.
5. **Directory vs file removal syscall dispatch**: A non-recursive empty directory deletion must dispatch `rmdir` (with `mkdir` undo recording); recursive directories, files, and symlinks must dispatch `rm` (with tree snapshotting).

---

### Task 1: Enforce Workspace Root Refusal in `PathGuard.validatePathForDelete`

**Files:**

- Modify: `src/core/path.ts:890-930`
- Test: `__tests__/write-path-root-guards.test.ts`

**Interfaces:**

- Consumes: `PathGuard.isAllowedRoot(validPath: string): boolean`
- Produces: `PathGuard.validatePathForDelete(requestedPath: string, options?: { allowReadOnly?: boolean }): Promise<string>` throws or rejects with `Problem.accessDenied('Deleting a workspace root directory is not allowed', { path: validPath })` when `validPath` is an allowed root.

- [ ] **Step 1: Write the failing test**

In `__tests__/write-path-root-guards.test.ts`, add a test asserting that `pathGuard.validatePathForDelete(root)` rejects with an access denied error naming workspace root:

```ts
it('validatePathForDelete rejects an allowed root directory', async () => {
  const root = await createTestRoot();
  const guard = await makeGuard([root]);
  await assert.rejects(
    () => guard.validatePathForDelete(root),
    (err: unknown) => {
      assert.ok(isFsError(err) || isProblem(err));
      assert.match(String(err), /Deleting a workspace root directory is not allowed/i);
      return true;
    },
  );
  await cleanupTestRoot(root);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="validatePathForDelete rejects an allowed root" __tests__/write-path-root-guards.test.ts`
Expected: FAIL (currently `validatePathForDelete` allows root if not read-only; the check only lived in `delete.ts`).

- [ ] **Step 3: Implement root guard in `validatePathForDelete`**

In `src/core/path.ts`, inside `validatePathForDelete`, after resolving `targetPath`:
Check `if (this.isAllowedRoot(targetPath))` and throw `new FsError(ErrorCode.ACCESS_DENIED, 'Deleting a workspace root directory is not allowed', requestedPath)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="validatePathForDelete rejects an allowed root" __tests__/write-path-root-guards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/path.ts __tests__/write-path-root-guards.test.ts
git commit -m "feat(path): refuse workspace root deletion in validatePathForDelete"
```

---

### Task 2: Implement Two-Phase Deletion in `GuardedFileSystem` (`planDelete`, `executeDelete`, `delete`)

**Files:**

- Modify: `src/core/fs.ts`
- Test: `__tests__/core-fs.test.ts`

**Interfaces:**

- Consumes: `this.pathGuard.validatePathForDelete`, `this.lstat`, `identityOf`, `sameIdentity`, `snapshotTree`, `fsRm`, `fsRmdir`
- Produces:
  ```ts
  export interface DeletePlan {
    readonly inputPath: string;
    readonly validPath: string;
    readonly itemType: FileType;
    readonly firstStats?: LstatResult | undefined;
    readonly pending: boolean;
    readonly holdsProtected: boolean;
    readonly noop: boolean;
  }

  planDelete(
    path: string,
    options?: { recursive?: boolean; ignoreIfNotExists?: boolean; signal?: AbortSignal },
  ): Promise<DeletePlan>;

  executeDelete(
    plan: DeletePlan,
    options?: { signal?: AbortSignal },
  ): Promise<{ deleted: string }>;

  delete(
    path: string,
    options?: { recursive?: boolean; ignoreIfNotExists?: boolean; signal?: AbortSignal },
  ): Promise<{ deleted: string }>;
  ```
- Privatizes: `hasChildrenUnchecked` and `holdsProtectedEntry` become private `#hasChildrenUnchecked` and `#holdsProtectedEntry` on `GuardedFileSystem`.

- [ ] **Step 1: Write the failing tests in `__tests__/core-fs.test.ts`**

Add test cases covering:

1. `planDelete` on missing file with `ignoreIfNotExists: true` returns `{ noop: true }`.
2. `planDelete` on non-empty directory with `recursive: true` returns `{ pending: true, holdsProtected: boolean }`.
3. `executeDelete` on a planned file removes the file.
4. `executeDelete` throws `ErrorCode.CANCELLED` if entry is swapped before execution.
5. One-shot `fs.delete` successfully plans and removes an entry.

```ts
it('planDelete and executeDelete remove a file and detect write-time identity swap', async () => {
  const filePath = await writeTestFile(root, 'del-test.txt', 'hello');
  const plan = await fs.planDelete(filePath);
  assert.strictEqual(plan.noop, false);
  assert.strictEqual(plan.pending, false);

  // Simulate swap before execution
  await rm(plan.validPath);
  await writeTestFile(root, 'del-test.txt', 'different');
  await assert.rejects(
    () => fs.executeDelete(plan),
    (err: unknown) => {
      assert.ok(isFsError(err));
      assert.strictEqual(err.code, ErrorCode.CANCELLED);
      assert.match(err.message, /replaced after the delete was approved/i);
      return true;
    },
  );
});

it('executeDelete removes a verified entry and handles noop cleanly', async () => {
  const filePath = await writeTestFile(root, 'del-real.txt', 'content');
  const plan = await fs.planDelete(filePath);
  const res = await fs.executeDelete(plan);
  assert.strictEqual(res.deleted, plan.validPath);
  await assert.rejects(() => lstat(plan.validPath));

  const missingPlan = await fs.planDelete(join(root, 'missing.txt'), { ignoreIfNotExists: true });
  assert.strictEqual(missingPlan.noop, true);
  const noopRes = await fs.executeDelete(missingPlan);
  assert.strictEqual(noopRes.deleted, missingPlan.validPath);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="planDelete and executeDelete" __tests__/core-fs.test.ts`
Expected: FAIL (`planDelete` is not a function).

- [ ] **Step 3: Implement `planDelete`, `executeDelete`, and `delete` in `src/core/fs.ts`**

In `src/core/fs.ts`:

1. Move `hasChildrenUnchecked` and `holdsProtectedEntry` logic to `#hasChildrenUnchecked` and `#holdsProtectedEntry`.
2. Implement `planDelete`:
   - Validates path via `this.pathGuard.validatePathForDelete(path)`. Catches `isNotFoundErrno` when `options?.ignoreIfNotExists` is true, returning `{ inputPath: path, validPath: path, itemType: 'file', pending: false, holdsProtected: false, noop: true }`.
   - Re-stats with `this.lstat(validPath)`.
   - If `options?.recursive && itemType === 'directory'`: checks `#hasChildrenUnchecked(validPath)` and `#holdsProtectedEntry(validPath, path, signal)`.
   - Returns `DeletePlan`.
3. Implement `executeDelete`:
   - If `plan.noop`, returns `{ deleted: plan.validPath }`.
   - Re-stats `validPath` with `this.lstat`. If not found and `options?.ignoreIfNotExists`, returns `{ deleted: plan.validPath }`.
   - Verifies `sameIdentity(identityOf(plan.firstStats.stats), identityOf(currentStats.stats))`. If changed, throws `new FsError(ErrorCode.CANCELLED, ...)`.
   - Dispatches `this.rmdir(validPath)` if `currentStats.stats.isDirectory() && !plan.recursive`, else `this.rm(validPath, { recursive: plan.recursive, force: plan.ignoreIfNotExists }, signal)`.
4. Implement `delete`: runs `planDelete` then `executeDelete`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern="planDelete and executeDelete" __tests__/core-fs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/fs.ts __tests__/core-fs.test.ts
git commit -m "feat(core/fs): implement planDelete, executeDelete, and delete lifecycle"
```

---

### Task 3: Refactor `src/tools/delete.ts` to Consume `GuardedFileSystem` Deletion Lifecycle

**Files:**

- Modify: `src/tools/delete.ts`
- Test: `__tests__/delete.test.ts`

**Interfaces:**

- Consumes: `fs.planDelete`, `fs.executeDelete`, `DeletePlan`
- Produces: `DELETE` tool definition with batch handling, user Confirmation elicitation, and response assembly.

- [ ] **Step 1: Write/verify test coverage in `__tests__/delete.test.ts`**

Ensure existing tests in `__tests__/delete.test.ts` cover:

- Refusing root directory.
- Sibling failure reporting in partial batches.
- Recursive delete of non-empty directory eliciting Confirmation.
- Declining confirmation cancelling the path.
- Sensitive-file hold in non-empty directory causing undo abandonment.

- [ ] **Step 2: Update `src/tools/delete.ts` to use `fs.planDelete` and `fs.executeDelete`**

1. Replace tool-level `planPath` with calls to `ctx.fs.planDelete(inputPath, { recursive: args.recursive, ignoreIfNotExists: args.ignoreIfNotExists, signal: ctx.signal })`.
2. Map `DeletePlan` results:
   - If error thrown: catches and converts via `Problem.fromUnknown(error, ErrorCode.UNKNOWN, inputPath, DELETE_ERRNOS)`.
   - If `plan.holdsProtected`: set undo capture unavailable reason `contains files protected by the sensitive-file policy`.
   - If `plan.pending`: collect for `confirm(...)`.
3. In execution:
   - Non-pending or confirmed plans call `await ctx.fs.executeDelete(plan, { signal: ctx.signal })`.
   - Catch cancellation or filesystem errors and format as per-path result rows.
4. Remove obsolete helpers: `finalizeDeletion`, `planPath`.

- [ ] **Step 3: Run delete tool tests**

Run: `node --test __tests__/delete.test.ts`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/delete.ts
git commit -m "refactor(tools/delete): delegate deletion lifecycle to GuardedFileSystem"
```

---

### Task 4: Full Repository Verification and Type Checking

**Files:**

- Repository-wide check

- [ ] **Step 1: Run static checks**

Run: `npm run check:static`
Expected: PASS with 0 lint, format, or TypeScript type errors.

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: PASS with all tests passing across all suites.

- [ ] **Step 3: Commit**

```bash
git commit --allow-empty -m "chore: verify full check passes after guarded deletion deepening"
```
