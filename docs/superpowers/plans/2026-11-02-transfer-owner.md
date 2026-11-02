# Transfer owner implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the **Transfer** (move or copy of one source to one destination) one deep home in `GuardedFileSystem` (`src/core/fs.ts`). Today a move resolves both ends twice: once in `src/tools/move.ts` `planTransfer`, then again in `fs.rename`. It also walks the source tree twice: `assertTreeHasNoProtectedEntries`, then `#validateMappedDescendants`. After this change the move tool keeps only batch policy, the Confirmation, and its report.

**Architecture:** Three steps on one branch (`worktree-transfer-owner`):

1. One private Relocation walk in `fs.ts` replaces `#validateMappedDescendants` and checks both rules.
2. `planTransfer` / `executeTransfer` land in `GuardedFileSystem`, and `rename` / `cp` become one-shots over them.
3. `move.ts` consumes them and drops its planning helpers.

**Tech Stack:** TypeScript 7 native compile (ADR-009), Node test runner, real temp directories (no fakes; ADR-008's `RawOps` stays the one seam for forcing `EXDEV`).

**Spec:** The decisions grilled on 2026-11-02 are listed under Global Constraints below. ADR-008's 2026-11-02 amendment records the decision. `GLOSSARY.md` defines **Transfer**.

## Global Constraints

- **Interface** (the common-caller design chosen in the grilling):

  ```ts
  export type TransferOp = 'move' | 'copy';

  export interface TransferPlan {
    readonly op: TransferOp;
    readonly request: { readonly source: string; readonly destination: string }; // as the caller spelled them
    readonly noop: boolean;         // Self-move, or a copy onto its own Respelling
    readonly entry: string;         // move: the Entry renamed (a link stays a link); copy: the Landing
    readonly landing: string;       // the source resolved through links; every comparison uses it
    readonly destination: string;   // validated destination
    readonly existing: EntryIdentity | undefined; // what sat at the destination when planned; undefined = absent or Respelling
  }

  planTransfer(op: TransferOp, pair: { source: string; destination: string },
               o?: { signal?: AbortSignal }): Promise<TransferPlan>;
  executeTransfer(plan: TransferPlan,
                  o?: { createParents?: boolean; crossDevice?: boolean;
                        copy?: Parameters<typeof fsCp>[2]; signal?: AbortSignal }
  ): Promise<{ from: string; to: string }>;
  ```

- **Plan makes no changes.** It runs in every round, because a Confirmation ends the call (ADR-007).
- **Execute order:**
  1. Return at once for a `noop` plan.
  2. Re-run the Relocation walk.
  3. Check the destination: absent at plan but present now → `CANCELLED` "created during confirmation". `existing` set but the identity differs now → `CANCELLED` "replaced after the overwrite was approved".
  4. `mkdir` the parents when `createParents` is set.
  5. Rename (with the ADR-008 `EXDEV` fallback unless `crossDevice: false`) or copy.
  6. Capture, exactly as `rename` / `cp` do today.
- **No approval flag.** The identity check always runs. For a copy with `overwrite: true` the gap between plan and execute is a few milliseconds; that is accepted.
- **One Relocation walk** runs at plan and again at execute. It checks every entry with `relocationKeepsProtection` and every mapped destination with `validateTransferPathForWrite`. It is skipped for a non-directory and for a moved link.
- **Copy defaults are fixed inside the Transfer:** `recursive`, `verbatimSymlinks`, `preserveTimestamps`, `force`. The tool passes no copy options; `cp(src, dst, options)` still passes its options through.
- **Wording that must stay the same, because tests pin it:**
  - `own subdirectory` (`tools.test.ts:2234`)
  - `protected entries` (`unicode-paths.test.ts:660`)
  - `replaced after the overwrite was approved` (`confirmation-gaps.test.ts`)
  - `could not be fully inspected`
  - The `${VERB} refused:` / `${VERB} cancelled:` prefixes. They move into `fs.ts` keyed by `op`.
- **Behaviour changes accepted:** one-shot `cp` now:
  - refuses a copy into its own subdirectory (`INVALID_INPUT`);
  - treats a self-copy as a no-op;
  - runs the protection walk;
  - copies through a final link (the Landing), as the tool already did.

  The wire behaviour of the `move` tool is unchanged, so `__tests__/contract.test.ts` must not change.

- **Out of scope:**
  - Undo's `assertTreeKeepsPolicy` and `UndoPreview`. Undo's `diskWorld.rename(…, { crossDevice: false })` keeps its signature.
  - A write lock for transfers (the `shortcut:` in `executeTransfer` moves with the code, unchanged).
  - Batch duplicate and overlap policy, which stays in `move.ts`.
- `destIdentity` / `destExists` stay exported because `create.ts` uses them.
- No version bumps; the Release workflow owns them.
- `npm run check` must be green at the end of every task.

## Review Focus

1. **Source views:** a moved link renames the link, while every comparison uses the Landing. A link source whose target is gone or fails validation stands for itself (the tool used to refuse one pointing outside the roots; undo needs it). Copy reads out of a read-only dir (`allowReadOnly`); a real move out of one stays refused, both directly and on the cross-device path.
2. **Respelling asymmetry:** a move onto its own Respelling is real work, with no destination checks; a copy onto it is a `noop`.
3. **The walk at execute:** an entry added under the source while the Confirmation was open, if it is protected or lands in a read-only dir, is refused before any change.
4. **Capture parity:** `rename` still records `write` + `rename`, and still abandons for a replaced directory. Copies and cross-device moves still abandon.
5. **Undo on disk:** `restoreEntry` → `diskWorld.rename` now also runs the fs-level protection walk after undo's own walk. It must never refuse a restore that undo's check allowed. Pin this with an existing directory-move undo test.

---

### Task 1: one Relocation walk inside GuardedFileSystem

**Files:**

- Modify: `src/core/fs.ts`: replace `#validateMappedDescendants` (~L142) with `#relocationWalk(op, entry, requestedSource, destination)`; call it from `rename` (~L373) and `#moveAcrossDevices` (~L754).
- Test: `__tests__/transfer.test.ts` (new).

- [ ] **Step 1: Failing test.** Through `new GuardedFileSystem(guard).rename(dir, dest)` on real temp dirs, use a directory whose child would change sensitive-file status at the destination (borrow the fixture from `unicode-paths.test.ts:642`). Assert `ACCESS_DENIED` matching `/protected entries/`. Today the one-shot `rename` lets it through, because only the tool walked for protection.
- [ ] **Step 2:** Run `npm test -- __tests__/relocation.test.ts` and confirm it fails.
- [ ] **Step 3: Implement the walk.** Use one recursive `readdir` under the Entry. It yields relative names to `pathGuard.relocationKeepsProtection(names, { from, requestedFrom }, destination)`, and calls `validateTransferPathForWrite(join(destination, rel))` for each name before yielding it. A listing failure maps to `ACCESS_DENIED` "…could not be fully inspected for protected entries"; an abort rethrows.
- [ ] **Step 4:** `npm test -- __tests__/relocation.test.ts __tests__/move-exdev.test.ts __tests__/read-only-roots.test.ts __tests__/undo.test.ts`, then `npm run check`.

### Task 2: planTransfer and executeTransfer, with rename and cp as one-shots

**Files:**

- Modify: `src/core/fs.ts`: add `TransferOp`, `TransferPlan`, `planTransfer`, `executeTransfer`. Move in the logic from `move.ts` `validateTransferSource` (~L475), the body of `planTransfer` (~L100), and the destination checks of `executeTransfer` (~L188). `rename` and `cp` become `executeTransfer(await this.planTransfer(…), …)`.
- Test: `__tests__/transfer.test.ts`; `unicode-paths.test.ts` now expects `NOT_FOUND` for a self-rename of a missing path.

- [ ] **Step 1: Failing tests at the seam**, all on real temp dirs:
  - a Self-move plan is `noop`, and a missing source still fails;
  - a copy onto its own Respelling is `noop`, while a move onto it is a plan with `existing === undefined`;
  - a directory into its own subtree → `INVALID_INPUT` `/own subdirectory/`;
  - a destination created between plan and execute → `CANCELLED` `/created during confirmation/`;
  - a destination replaced between plan and execute → `CANCELLED` `/replaced after the overwrite was approved/`;
  - a protected entry added under the source between plan and execute → `ACCESS_DENIED`;
  - one-shot `cp` into its own subdirectory → `INVALID_INPUT`.
- [ ] **Step 2:** Run `npm test -- __tests__/transfer.test.ts` and confirm the new cases fail.
- [ ] **Step 3: Implement.** Keep `rename`'s Capture block and `EXDEV` branch as they are, inside the move branch of `executeTransfer`. Keep `cp`'s `allowReadOnly` source, `filter` recheck and Capture abandon inside the copy branch.
- [ ] **Step 4:** `npm test -- __tests__/transfer.test.ts __tests__/move-exdev.test.ts __tests__/unicode-paths.test.ts __tests__/undo.test.ts __tests__/read-only-roots.test.ts`, then `npm run check`.

### Task 3: the move tool consumes the Transfer

**Files:**

- Modify: `src/tools/move.ts`.
  - Delete `TransferPlan`, `TransferSource`, `TransferPlanResult`, `planTransfer`, `executeTransfer`, `validateTransferSource`, `assertTreeHasNoProtectedEntries`, and the `globEntries`, `TransferKind` and `destIdentity`/`destExists` imports.
  - `runTransfers` calls `ctx.fs.planTransfer`, catching each pair's error into `pairFailure`, and drops `noop` plans.
  - Duplicate and overlap checks read `entry` / `landing` / `destination`.
  - The Confirmation items come from `existing` (`required: !overwrite`).
  - A small `cancelled(op, pair, verdict)` maps the verdict to `CANCELLED`, using today's wording.
  - Execute calls `ctx.fs.executeTransfer(plan, { createParents: true, signal })`.
- Test: no new tests. `tools.test.ts`, `confirmation-gaps.test.ts`, `unicode-paths.test.ts` and `contract.test.ts` must pass unchanged.

- [ ] **Step 1:** Make the edit.
- [ ] **Step 2:** `npm test -- __tests__/tools.test.ts __tests__/confirmation-gaps.test.ts __tests__/unicode-paths.test.ts __tests__/contract.test.ts`.
- [ ] **Step 3:** `npm run build && npm run check`; this runs the dist smoke test too.
