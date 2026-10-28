# Confirmation swap after approval implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `create`, `move` and `copy` refuse to overwrite an entry that was
replaced after the client approved overwriting it.

**Architecture:** Each tool already plans the identity of every destination
it would destroy and passes it to `confirm()`. On the approved round, nothing
re-checks that identity before the write. Both tools keep the planned
identity, re-stat the destination just before the write, and throw
`CANCELLED` when the identity changed. `confirm()` can't ask again at that
point: a new prompt is only possible before anything is written (R14), and
other entries may already be written.

**Tech Stack:** TypeScript (Node ESM), Node built-in test runner.

**Spec:** the **Confirmation** entry in `GLOSSARY.md`, plus decisions from
the 2026-10-28 grilling: cover `create`, `move` and `copy`; refuse with
`CANCELLED`; add one GLOSSARY sentence.

## Global Constraints

- Reuse `destIdentity`, `sameIdentity` and `EntryIdentity` from `src/core/fs.ts:841-911`. Add no new identity helper.
- A destination that vanished after approval needs no approval: it proceeds (GLOSSARY).
- A destination whose identity is `UNKNOWN_IDENTITY` in both the plan and the re-check proceeds, matching the `unknown-identity` case in `__tests__/confirmation.test.ts`.
- Entries with `overwrite: true` or `append: true` are never re-checked: the client gave its word up front.
- The refusal code is `CANCELLED`. The message is `<verb> cancelled: "<path>" was replaced after the overwrite was approved.`. For `move`/`copy`, the text inside the quotes is `destination "<destination>"`.
- No contract snapshot change.
- Out of scope: `delete`'s message wording and its `itemType 'other'` bypass (`src/tools/delete.ts:176-190`), and the precision loss of number-typed identities (`fs.ts` `identityOf` versus `undo.ts` bigint).

## Review Focus

1. **A batch with one swapped entry:** the swapped entry fails with `CANCELLED`, and the other entries are still written. Task 1 tests this.
2. **A swap after approval:** one round, no re-prompt: the swapped entry is refused, not asked about again. Tasks 1 and 2 assert the prompt count of that single round (`create` shows one prompt per pending file).
3. **A destination that vanished after approval:** the write proceeds. Tasks 1 and 2 test this.
4. **`move` takes no lock:** the re-check narrows the swap window to the gap between the check and the rename, but does not close it. Task 2 marks this with a `shortcut:` comment.
5. **A symlinked destination under `COUNT_THROUGH_FD`:** both stats return `UNKNOWN_IDENTITY`, so the write proceeds. This is unchanged behaviour, with no new test.

---

### Task 1: `create` re-checks the approved file inside its write lock

**Files:**

- Modify: `src/tools/create.ts:166-178` (`pendingByPath`) and `:203-236` (the per-file write)
- Test: `__tests__/confirmation-gaps.test.ts`

**Interfaces:**

- Consumes: `destIdentity(fs, path, tool): Promise<EntryIdentity | undefined>`, `sameIdentity(a, b): boolean` and `type EntryIdentity` from `src/core/fs.ts`.
- Produces: nothing new for Task 2.

- [ ] **Step 1: Write the failing tests** in the `Confirmation gaps` describe block.

  Use the existing `withPrompts('overwrite', …)` and `swap` helpers. Hook `GuardedFileSystem.prototype.lockForWrite`: it is first called on the approved round, after that round's plan stat (round 1 returns at `create.ts:181`). Follow the mock pattern at `__tests__/tools.test.ts:567-593`, including its `eslint-disable` for `unbound-method`. Inside the hook, run `swap` once, then call the real method.

  ```ts
  it('create refuses a file replaced after its overwrite was approved', …
    // files: [{ path: dst.txt, content: 'NEW' }, { path: other.txt, content: 'NEW' }]
    // dst.txt and other.txt both exist; the hook swaps only dst.txt ('SWAPPED')
    assert.strictEqual(prompts(), 2); // one round, one prompt per pending file: no re-prompt
    assert.match(firstTextBlock(result).text ?? '', /replaced after the overwrite was approved/);
    assert.strictEqual(await readFile(dst, 'utf8'), 'SWAPPED');
    assert.strictEqual(await readFile(other, 'utf8'), 'NEW');

  it('create writes a file that vanished after its overwrite was approved', …
    // the hook removes dst.txt (rm only)
    assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
    assert.strictEqual(prompts(), 1);
    assert.strictEqual(await readFile(dst, 'utf8'), 'NEW');
  ```

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `npm test -- --test-name-pattern="after its overwrite was approved"`
  Expected: the first test FAILS, because `dst.txt` reads `NEW`. The second PASSES; it guards the vanish rule.

- [ ] **Step 3: Keep the planned identity, and re-check it in the lock**
  - `pendingByPath` becomes `Map<string, { validPath: string; identity: EntryIdentity }>`. The verdict lookup uses `pending.validPath`.
  - Inside `ctx.fs.lockForWrite(path, async (resolvedTarget) => …)`, when the entry is pending, call `destIdentity(ctx.fs, resolvedTarget, 'create')`. If the result is not `undefined` and `!sameIdentity(now, pending.identity)`, throw `new FsError(ErrorCode.CANCELLED, \`create cancelled: "${path}" was replaced after the overwrite was approved.\`, path)`.
  - Keep the existing non-pending "appeared" check at `:222-234` unchanged.
  - Compare against this round's planned identity. It equals the sealed, approved identity whenever the verdict is `'proceed'` (`confirmation.ts:83-95`).

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `npm test -- --test-name-pattern="Confirmation gaps|create"`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/tools/create.ts __tests__/confirmation-gaps.test.ts
  git commit -m "fix(create): refuse a file replaced after its overwrite was approved"
  ```

### Task 2: `move` and `copy` re-check an approved destination before they write

**Files:**

- Modify: `src/tools/move.ts:189-221` (`executeTransfer`)
- Modify: `GLOSSARY.md` (Confirmation entry), `CHANGELOG.md` (`[Unreleased]` → `### Security`)
- Test: `__tests__/confirmation-gaps.test.ts`

**Interfaces:**

- Consumes: `TransferPlan.destIdentity` and `TransferPlan.pending`, which `move.ts:163-178` already sets. Also `destIdentity` and `sameIdentity` from Task 1's imports.

- [ ] **Step 1: Write the failing tests**, one each for `move` and `copy` (`copy: true`).

  `move` has no lock to hook. Instead, hook `GuardedFileSystem.prototype.stat`. When a call whose first argument ends with `dest.txt` resolves for the second time (the approved round's plan stat), run `swap` before returning. The third stat is the new re-check, and it sees the swapped file.

  ```ts
  it('move refuses a destination replaced after its overwrite was approved', …
    assert.strictEqual(prompts(), 2); // one round, one prompt per pending file: no re-prompt
    assert.match(firstTextBlock(result).text ?? '', /replaced after the overwrite was approved/);
    assert.strictEqual(await readFile(destination, 'utf8'), 'SWAPPED');
    await access(source); // move did not consume the source

  it('copy refuses a destination replaced after its overwrite was approved', …
    // same assertions, with arguments { copy: true, moves: [...] }

  it('move writes a destination that vanished after its overwrite was approved', …
    // the hook removes dest.txt
    assert.strictEqual(await readFile(destination, 'utf8'), 'SOURCE');
  ```

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `npm test -- --test-name-pattern="after its overwrite was approved"`
  Expected: the move and copy refusal tests FAIL, because the destination reads `SOURCE`.

- [ ] **Step 3: Re-check the destination in `executeTransfer`**
  - After the verdict block (`:195-205`) and before `mkdir` (`:221`), when `plan.pending && plan.destIdentity`, call `destIdentity(ctx.fs, plan.validDest, op)`.
  - If the result is not `undefined` and differs from `plan.destIdentity` (`sameIdentity`), throw `CANCELLED` with `${VERB[op]} cancelled: destination "${plan.pair.destination}" was replaced after the overwrite was approved.`.
  - Add `// shortcut: move/copy take no write lock, so a swap between this check and the rename still lands; lock the destination if that window matters`.

- [ ] **Step 4: Update the docs**
  - `GLOSSARY.md`, in the Confirmation entry after "asked about again, once.": add `An entry replaced after the approval, once writing has begun, is refused, not asked about again.`
  - `CHANGELOG.md` `### Security`: add a new bullet below the existing `move`/`copy`/`create` "ask again" bullet, in its voice:
    `**`create`, `move`and`copy` refuse an entry replaced after you approved overwriting it.** Before, a file swapped in between the approval and the write was overwritten instead of the one you were asked about.`

- [ ] **Step 5: Run the full check**

  Run: `npm run check`
  Expected: PASS, with `__tests__/contract.test.ts` unchanged.

- [ ] **Step 6: Commit**

  ```bash
  git add src/tools/move.ts __tests__/confirmation-gaps.test.ts GLOSSARY.md CHANGELOG.md
  git commit -m "fix(move): refuse a destination replaced after its overwrite was approved"
  ```
