# Delete execution error flow implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Throw Delete's mapped `Problem` through the existing Batch execution seam without changing tool results.

**Architecture:** `executePlan` keeps Delete-specific error mapping and returns only successful or skipped outcomes. Its failures throw `Problem`, which `executeBatchSlots` already preserves, so the slot no longer reconstructs `FsError`.

**Tech Stack:** TypeScript, Node.js built-in test runner, npm.

**Spec:** `docs/superpowers/specs/2026-11-11-delete-problem-errors-design.md`

## Global Constraints

- Change Delete execution only. Do not change `planPath`, `PlanResult`, or `planIntoSlots`.
- Keep `DELETE_ERRNOS`, `DELETE_ERRNOS_NO_CONFIRM`, `cancelMessage`, and Confirmation behavior unchanged.
- Keep `Problem.code`, `Problem.message`, `Problem.path`, and `Problem.suggestion` intact.
- Do not change advertised MCP results or add dependencies.

## Review Focus

- An execution error with custom recovery guidance must keep it, pinned by `preserves custom suggestion when execution delete fails`.
- A thrown plain `Problem` must reach the Batch result unchanged, pinned by `preserves a thrown Problem verbatim`.
- A skipped directory must not call the filesystem mutation, pinned by `leaves the directory in place when the user picks Skip`.
- A declined Confirmation must report `CANCELLED`, pinned by `reports a declined delete as CANCELLED and keeps the directory`.
- An abort during the protected-file walk must not become `UNKNOWN`, pinned by `reports an abort during the protected-file walk as cancelled, not unknown`.

---

### Task 1: execution failures

**Files:**

- Modify: `src/tools/delete.ts:96-125`
- Modify: `src/tools/delete.ts:209-227`
- Test: `__tests__/batch.test.ts:17-99`
- Test: `__tests__/delete.test.ts:283-306`
- Test: `__tests__/delete.test.ts:698-711`
- Test: `__tests__/delete.test.ts:752-781`

**Interfaces:**

- Consumes: `Problem.fromUnknown(error, ErrorCode.UNKNOWN, path, rows)` and `Problem.cancelled(message, { path })` from `src/core/errors.ts`.
- Consumes: `executeBatchSlots` in `src/tools/batch.ts`, whose pending slot catches thrown values and preserves a non-`Error` `Problem` verbatim.
- Produces: `executePlan(plan, ctx, confirmed): Promise<{ deleted: string } | { skipped: true; path: string }>`, throwing `Problem` for every failure.

- [ ] **Step 1: Add the Batch characterization test**

Add this test inside `describe('executeBatchSlots')` in `__tests__/batch.test.ts`:

```ts
it('preserves a thrown Problem verbatim', async () => {
  const problem = Problem.accessDenied('Access denied', {
    path: 'a.txt',
    suggestion: 'Ask for access',
  });
  const slots: BatchSlot<string>[] = [
    {
      status: 'pending',
      path: 'a.txt',
      run: async () => {
        throw problem;
      },
    },
  ];
  const ctx = { onProgress: () => undefined } as unknown as ToolCtx;
  const result = await executeBatchSlots(slots, ctx);
  const entry = result.results[0];
  assert.ok(entry && 'error' in entry);
  assert.strictEqual(entry.error, problem);
});
```

This refactor preserves behavior, so the characterization test passes before and after the Delete edit.

- [ ] **Step 2: Run the Batch test and Delete regressions before editing**

Run:

```bash
npm test -- --test-name-pattern="preserves a thrown Problem verbatim|preserves custom suggestion when execution delete fails|leaves the directory in place when the user picks Skip|reports a declined delete as CANCELLED|reports an abort during the protected-file walk as cancelled" __tests__/batch.test.ts __tests__/delete.test.ts
```

Expected: PASS. Record this as the behavior baseline.

- [ ] **Step 3: Simplify Delete execution**

In `src/tools/delete.ts`, change `executePlan` to the signature in Interfaces. Return the existing skipped and successful outcomes. Replace both failure-return branches with these mappings:

```ts
throw Problem.cancelled(cancelMessage('delete', plan.validPath, verdict), {
  path: plan.validPath,
});
```

```ts
throw Problem.fromUnknown(error, ErrorCode.UNKNOWN, plan.validPath, rows);
```

Keep the existing `rows` selection. In the pending slot, call `executePlan`, return `{ deleted: false }` for a skipped outcome, and return `{ deleted: true }` for success. Delete the failure-union check and `new FsError(...)` reconstruction. Keep `FsError` imported because planning still uses it.

- [ ] **Step 4: Run the focused regression set**

Run the command from Step 2.

Expected: PASS, including object identity in the new Batch test and the custom suggestion through DELETE.

- [ ] **Step 5: Run the full repository check**

Run:

```bash
npm run check
```

Expected: build, test type-check, lint, formatting, knip, and all tests pass. The build enables `dist-smoke.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/tools/delete.ts __tests__/batch.test.ts docs/superpowers/specs/2026-11-11-delete-problem-errors-design.md docs/superpowers/plans/2026-11-11-delete-problem-errors.md
git commit -m "refactor(delete): throw mapped problems through batch" -m "Execution failures kept switching between result objects and exceptions. Each conversion copied fields and could lose recovery guidance." -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
