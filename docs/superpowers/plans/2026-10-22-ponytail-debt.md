# Ponytail debt paydown implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pay the one ledger entry that is a live defect (undo restores a deleted
directory wider than it was), give the two trigger-less markers a revisit
trigger, and bring the ledger back in line with the code.

**Architecture:** The `mkdir` undo record gains the deleted directory's
permission bits; restore passes them to `mkdir`, where the umask can only
narrow them, so a `0700` folder no longer comes back `0755`. No `chmod` is
added to `GuardedFileSystem`: a raw path `chmod` after `mkdir` would follow a
swapped-in link, and narrowing-only already closes the widening.

**Tech Stack:** TypeScript on Node, `node:test`, `node:fs/promises`.

**Spec:** `PONYTAIL-DEBT.md` (harvested 2026-10-22).

## Global Constraints

- Branch off `origin/main` (PR #113 is merged): `fix/undo-dir-mode`.
- `npm run check` passes before each commit (`npm run fix` formats first).
- No MCP surface change: `__tests__/contract.test.ts` snapshot stays untouched.
- Never hand-edit versions in `package.json`, `server.json`, `mcpb/manifest.json`,
  `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`.
- Marker convention: `ponytail: <ceiling>, <upgrade path>`.

## Out of Scope

Six ledger entries stay as they are. Each one's trigger has not fired, or the
upgrade is blocked upstream:

| Entry                       | Why it stays                                   |
| :-------------------------- | :--------------------------------------------- |
| `watcher-registry.ts:44`    | MCP `resources/unsubscribe` carries only `uri` |
| `store.ts:297`              | trigger is memory pressure; none seen          |
| `fs.ts:301` rename identity | no data loss; contents move with the dir       |
| `fs.ts:446` append capture  | refuses honestly; no client asked              |
| `fs.ts:607` forced `cp`     | refuses honestly; no client asked              |
| `server.ts:143` debounce    | trigger is a client report; none filed         |

## Review Focus

1. **Windows host:** mode bits mean nothing on win32 directories; a restore
   that now passes `mode` to `mkdir` must still recreate the tree. Pinned by
   the existing test `a deleted tree comes back with bytes, mode, symlink and
subdirectory` (`__tests__/undo.test.ts:475`), which runs on win32 and
   restores `sub` through the changed `mkdir` call.
2. **Restrictive umask (`077`):** a restored `0750` folder comes back `0700`,
   narrower, never wider. This is the documented ceiling; no test, because the
   test process cannot change the CI umask safely.
3. **Directory with no owner write bit that had children (`0555`):** only root
   can delete such a tree, and root ignores mode bits, so restoring the parent
   `0555` before its children still works. No test: needs root.
4. **setgid / sticky bits (`02775`, `01777`):** dropped by `& 0o777`, the same
   as file records do. No test: consistent with the file path.
5. **`rmdir` whose pre-delete `lstat` fails:** `mode` is `undefined`, `mkdir`
   uses its default, as today. Pinned by type only (`mode` optional).

---

### Task 1: Restore a deleted directory's mode on undo

**Files:**

- Modify: `src/core/undo.ts:43-44` (record type), `:401` (`snapshotTree`),
  `:654-658` (restore `mkdir` case)
- Modify: `src/core/fs.ts:582-589` (`GuardedFileSystem.rmdir`)
- Modify: `PONYTAIL-DEBT.md` (the `src/core/undo.ts` entry)
- Test: `__tests__/undo.test.ts` (new test after line 507)

**Interfaces:**

- Produces: `UndoRecord` variant
  `{ op: 'mkdir'; path: string; mode?: number | undefined; was?: FileIdentity | undefined }`,
  where `mode` is `stats.mode & 0o777` of the deleted directory.
- Producers: `snapshotTree` (`undo.ts:401`) and `GuardedFileSystem.rmdir`
  (`fs.ts:588`). No other code builds `mkdir` records.
- Consumer: `restoreEntry`'s `mkdir` case calls
  `fs.mkdir(record.path, { mode: record.mode })`.

- [ ] **Step 1: Write the failing test**

Add inside the same `describe` as the test at `__tests__/undo.test.ts:475`,
which owns `captureOne`, `newFs` and `tmpDir`:

```ts
it('a deleted directory comes back with its mode, never wider', async (t) => {
  if (process.platform === 'win32') {
    t.skip('directory mode bits are POSIX-only');
    return;
  }
  const fsPromises = await import('node:fs/promises');
  const tree = join(tmpDir, 'private-tree');
  const empty = join(tmpDir, 'private-empty');
  await mkdir(join(tree, 'inner'), { recursive: true });
  await mkdir(empty);
  await fsPromises.chmod(tree, 0o700);
  await fsPromises.chmod(join(tree, 'inner'), 0o700);
  await fsPromises.chmod(empty, 0o700);
  const entry = await captureOne(async (fs) => {
    await fs.rm(tree, { recursive: true, force: true }); // snapshotTree path
    await fs.rmdir(empty); // GuardedFileSystem.rmdir path
  });
  await restoreEntry(entry, newFs(), { dryRun: false });
  assert.strictEqual((await fsPromises.stat(tree)).mode & 0o777, 0o700);
  assert.strictEqual((await fsPromises.stat(join(tree, 'inner'))).mode & 0o777, 0o700);
  assert.strictEqual((await fsPromises.stat(empty)).mode & 0o777, 0o700);
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- --test-name-pattern="comes back with its mode"`
Expected on win32: 1 skipped. Expected on POSIX with umask `022`: FAIL,
`493 !== 448` (restored `0755`, wanted `0700`).

> This machine has no Node in WSL. The POSIX red proof is the ubuntu CI job;
> do not push a red commit only to see it. The assertion is red by
> construction: `mkdir` with no mode gives `0777 & ~022`.

- [ ] **Step 3: Carry the mode through capture and restore**

1. `undo.ts:44`: add `mode?: number | undefined` to the `mkdir` variant; update
   the doc comment on line 43 to say the mode is reapplied, narrowed by the
   umask.
2. `undo.ts:401`: push `mode: stats.mode & 0o777`.
3. `fs.ts:584-588`: take one `fsLstat` before `fsRmdir` (only when
   `this.#capture` is set, as now); derive both `was` and
   `mode: stats.mode & 0o777` from it; a failed `lstat` leaves both `undefined`.
4. `undo.ts:658`: `await fs.mkdir(record.path, { mode: record.mode });`
5. Replace the comment at `undo.ts:654-656` with:

```ts
// ponytail: mkdir's mode is masked by the umask, so a restored directory can
// come back narrower than it was (0775 as 0755), never wider. Upgrade: a
// guarded chmod on GuardedFileSystem for exact bits.
```

6. `PONYTAIL-DEBT.md`: rewrite the `src/core/undo.ts` entry body to match:
   simplified = mode reapplied through `mkdir`, umask may narrow it;
   ceiling = umask-cleared bits (group/other write) are not restored;
   upgrade = a guarded `chmod` on `GuardedFileSystem`.

- [ ] **Step 4: Run the full check**

Run: `npm run fix`
Expected: exits 0; the new test reports skipped on win32, all others pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/undo.ts src/core/fs.ts __tests__/undo.test.ts PONYTAIL-DEBT.md
git commit -m "fix(undo): bring a deleted directory back with its mode"
```

Body: one line on the widening (`0700` came back `0755`) and one on the ceiling.

### Task 2: Revisit triggers for the two trigger-less markers; refresh the ledger

**Files:**

- Modify: `src/core/schema.ts:232-234`
- Modify: `examples/clients/gatekeeper/agent.ts:161-162`
- Modify: `PONYTAIL-DEBT.md` (all headings, both no-trigger entries, footer)

**Interfaces:** none; comments and the ledger only.

- [ ] **Step 1: Replace the `schema.ts` comment (lines 232-234) with:**

```ts
// ponytail: charset regex, not z.base64url() — the SDK's AJV warns on the
// unknown `base64url` format; the server's own decode (cursor.ts) is the real
// validation, so loosening the client-facing schema to the alphabet is safe.
// Revisit if the SDK's AJV registers `base64url`: z.base64url() then fits.
```

- [ ] **Step 2: Replace the gatekeeper comment (lines 161-162) with:**

```ts
// ponytail: no stale-preview check between dry run and apply; exact-match
// edit fails instead of corrupting, and the model sees that error. Add a
// content-hash check if a user reports an apply that differs from its preview.
```

- [ ] **Step 3: Refresh `PONYTAIL-DEBT.md`**

1. Run: `git grep -n "ponytail:" -- src examples`
   Expected: 9 lines.
2. Set each entry heading's `file:line` to the grep result. The ledger
   headings are stale today (`undo.ts:383` is now `:654`, `fs.ts:269` is `:301`).
3. Drop `(no-trigger)` from the `schema.ts` and `gatekeeper` headings; set each
   `upgrade:` line to the trigger added in Steps 1-2.
4. Footer: `9 markers, 0 with no trigger.` (the old count of 10 was a miscount).

- [ ] **Step 4: Run the full check**

Run: `npm run fix`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/schema.ts examples/clients/gatekeeper/agent.ts PONYTAIL-DEBT.md
git commit -m "docs: give the trigger-less ponytail markers a revisit trigger"
```
