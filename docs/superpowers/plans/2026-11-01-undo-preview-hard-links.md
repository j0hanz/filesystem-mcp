# Undo Preview Hard-Link Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `undo` with `dryRun: true` report exactly what live undo performs when files have hard-linked names (issue #156).

**Architecture:** `UndoPreview` gains inode-keyed state — a modeled link count and an in-place content overlay — so a previewed write through one name of a multiply-linked inode is visible through every name and keeps the inode's identity, mirroring `GuardedFileSystem.writeFile`'s in-place branch. The read-only hard-link refusal is reused from `fs.ts` so the dry run predicts the same `ACCESS_DENIED`.

**Tech Stack:** Node 24, TypeScript (native type stripping), `node:test`, zod. No new dependencies.

**Spec:** https://github.com/j0hanz/filesystem-mcp/issues/156 — requirements restated in Design Decisions below (verified by reproduction, adversarial review, a 6-class divergence sweep, and a 900-trial differential fuzz on a scratch patch; all evidence in the issue #156 analysis session).

## Design Decisions (the spec)

Live truth to mirror (`src/core/fs.ts`):

- `writeFile` on an existing regular file with `nlink > 1` (`fs.ts:443`) writes **in place**: the inode is kept, every hard-linked name sees the new bytes, and `record.was == world.identity(path)` after the restore, so `journal.reidentify(I, I)` is a functional no-op (`undo.ts:191-208`).
- `nlink == 1` or absent target → temp+rename swaps in a **fresh inode** (`fs.ts:496-509`).
- A multiply-linked file is refused while read-only directories are configured (`fs.ts:132-140`, triggered by any configured read-only dir, checked at `fs.ts:468`).

Bug: `UndoPreview.world().writeFile` (`undo.ts:651-658`) always mints a fresh per-path identity and stores the hash only in that name's node. Two names of one inode are two preview paths, so a previewed write through one name is invisible at the other, and identity tracking re-keys (`undo.ts:733`) where live keeps the inode. Six confirmed divergence classes:

| #   | Shape                                                    | Dry says               | Live does            |
| --- | -------------------------------------------------------- | ---------------------- | -------------------- |
| 1   | Issue repro: write via alias, older write via other name | SKIP                   | restore              |
| 2   | External write between captures (rev-write)              | restore (false)        | SKIP                 |
| 3   | Append record via alias name                             | SKIP                   | restore              |
| 4   | Remove record on a linked name                           | wrong, both directions | opposite             |
| 5   | Rename tracking the inode (`undo.ts:1096-1127`)          | "unrestorable"         | restore              |
| 6   | Link into a read-only root                               | restore                | FAIL `ACCESS_DENIED` |

Fix (all in `UndoPreview`, `src/core/undo.ts` unless noted):

- `#links: Map<string, bigint>` keyed by `identityKey(FileIdentity)` — the inode's link count as the preview's own unlinks leave it. Seeded once from `stats.nlink` in `#fromDisk` (first sight wins, both stat branches there use bigint lstat). Never re-seed — a dry run never unlinks for real, so a later lstat would resurrect counts the preview already spent. Never delete entries.
- `#inPlace: Map<string, string>` keyed by `identityKey` — the sha256 an in-place preview write left on that inode; consulted by `world().hash` between `node.hash` and the disk read.
- `world().writeFile`: file target with `#linkCount > 1n` → keep the node's identity, set `#inPlace`, put a node with no `hash` (bytes live in `#inPlace`). Otherwise mint exactly as today.
- `world().rm`: resolve the node, decrement `#links` for a file, put `ABSENT`. Becomes `async` — signature-compatible (`RestoreWorld.rm` declares `Promise<void>`).
- Read-only refusal (task 2): the in-place branch calls the real check from `fs.ts` — `#assertNoReadOnlyHardLink` becomes public `assertNoReadOnlyHardLink(path: string, stats: { nlink: number })` (call sites `fs.ts:468` and `fs.ts:556` unchanged; `Stats` satisfies the structural type).

Untouched: `probe`/`identity`/`rename`/`rmdir`/`mkdir`/`mkdirp`/`symlink`/`treeNames`/`tracked`/`rewrite`/`#alias`/`#mint`, `diskWorld`, `restoreEntry`, `UndoJournal`, `src/tools/undo.ts`.

Out of scope (pre-existing, flag as candidate follow-up issue, do not model): Win32 rename onto another name of the same inode can eat the destination name live; POSIX keeps both; the preview models neither. External disk changes during a long dry run stale all preview reads; live undo is equally racy.

## Global Constraints

- Node >= 24, ESM, `.ts` import extensions; run TS directly with `node`.
- No new dependencies; no new files except tests inside `__tests__/undo.test.ts`.
- Every new hard-link test wraps `link()` in try/catch and returns `t.skip('hard links not supported here')` before any capture whose records the assertions need (suite convention, `undo.test.ts:481-485`). Two tests must capture before the link can exist (the remove-record test and the read-only test create the file they link); their skips still leave cleanup to the describe's `after()`.
- Assert content, `nlink`, and presence only — never mode bits.
- Advertised MCP surface unchanged: do not touch the undo tool schema; do NOT run `--test-update-snapshots`; `__tests__/contract.test.ts` must pass unmodified.
- Keep `#mint` untouched (dev `-1n` identities stay disjoint from disk identities).
- `#links` invariants: seed only in `#fromDisk` when the key is absent; only `world().rm` decrements; never delete, never re-seed.
- Targeted test run: `npm test -- __tests__/undo.test.ts`. Full gate: `npm run check`.
- Commit style: conventional (`fix(undo):`, `test(undo):`); end every commit message with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

Input classes and failure modes the mechanism must survive, each pinned by the test named:

1. Preview **promises a restore live skips** (rev-write, class 2) → task 1, oracle test "a dry run does not promise a restore the real undo skips".
2. Preview **promises a destructive remove live refuses** (remove-C2, class 4) → task 1, oracle test "a dry run does not promise removing a file the real undo refuses to remove".
3. Rename identity checked through a **hard-linked alias** (class 5, both `toHere` and `fromFree` faces) → task 1, oracle tests "an edit through the moved name after a move of its hard-linked twin" and "a move of one name, then an edit through its twin".
4. **Read-only linked file** must fail identically in dry and live (class 6) → task 2.
5. **Single-linked files must keep minting** — the in-place branch must not over-apply to `nlink == 1` targets (would regress the fresh-inode path) → task 3, parity pin "a write after one link was removed previews the fresh-inode restore".

---

### Task 1: inode-aware preview state and parity tests

**Files:**

- Modify: `src/core/undo.ts` — `UndoPreview` fields (after `#alias`, `:626`), helpers (after `#mint`, `:741`), `world().hash` (`:646-650`), `world().writeFile` (`:651-658`), `world().rm` (`:659-662`), `#fromDisk` (after `const kind = kindOf(stats)`, `:887`)
- Test: `__tests__/undo.test.ts` — `describe('restoreEntry')` (starts `:423`) and its nested oracle describe (starts `:1243`); tool-level test in the `undo` tool describe (after `:1847`)

**Interfaces:**

- Consumes: `FileIdentity`, `identityKey` (`undo.ts:30-34`, `:73-74`), `sha256Hex`, `hashFile`, `ABSENT`, `previewKey`, `#node`, `#put`, `#mint`; test helpers `captureOne` (`:443-451`), `dryRunAll` (`:452-459`), `previewThenUndo` (`:1246-1268`).
- Produces (private, no public signature changes): `#links: Map<string, bigint>`, `#inPlace: Map<string, string>`, `#linkCount(identity: FileIdentity): bigint`, `#unlink(identity: FileIdentity): void`. `world().rm` becomes `async` — task 2 adds one call inside task 1's in-place branch.

- [ ] **Step 1: Write the seven failing tests**

All in `__tests__/undo.test.ts`. Tests 1 in `describe('restoreEntry')`, placed right after "restore over a hardlinked file puts the old bytes back on every link" (ends `:494`). Tests 2-6 appended inside the oracle describe (`:1243`, closes `:1509`), shaped exactly like the existing oracle cases: `previewThenUndo([oldestCall, ..., newestCall])`, assert `real.every((r) => r.endsWith(' ok'))` (except where noted), `assert.deepStrictEqual(dry, real)`. Test 7 in the undo tool describe, right after "dryRun of two steps previews what the real undo restores" (ends `:1847`).

Test 1 — `a dry run across two hard-linked names previews both steps and writes nothing`:

```ts
it('a dry run across two hard-linked names previews both steps and writes nothing', async (t) => {
  const file = join(tmpDir, 'dry-hardlink.txt');
  const twin = join(tmpDir, 'dry-hardlink-twin.txt');
  await writeFile(file, 'A');
  try {
    await link(file, twin);
  } catch {
    return t.skip('hard links not supported here');
  }
  const aEntry = await captureOne((fs) => fs.writeFile(file, 'B'));
  const bEntry = await captureOne((fs) => fs.writeFile(twin, 'C'));
  assert.strictEqual(await readFile(twin, 'utf8'), 'C');

  const dry = await dryRunAll([bEntry, aEntry]); // newest first, as undo steps: 2

  assert.deepStrictEqual(
    dry.filter((r) => 'error' in r),
    [],
    dry.map((r) => ('error' in r ? r.error.message : 'ok')).join('\n'),
  );
  assert.strictEqual(await readFile(file, 'utf8'), 'C');
  assert.strictEqual(await readFile(twin, 'utf8'), 'C');
  assert.strictEqual((await lstat(file)).nlink, 2);
});
```

Test 2 — `two edits through two hard-linked names preview what the real undo does` (oracle; the issue's exact repro):

```ts
it('two edits through two hard-linked names preview what the real undo does', async (t) => {
  const a = join(tmpDir, 'oracle-hl-a.txt');
  const b = join(tmpDir, 'oracle-hl-b.txt');
  await writeFile(a, 'A');
  try {
    await link(a, b);
  } catch {
    return t.skip('hard links not supported here');
  }
  const { dry, real } = await previewThenUndo([
    await captureOne((fs) => fs.writeFile(a, 'B')),
    await captureOne((fs) => fs.writeFile(b, 'C')),
  ]);
  assert.ok(
    real.every((r) => r.endsWith(' ok')),
    real.join('\n'),
  );
  assert.deepStrictEqual(dry, real);
  assert.strictEqual(await readFile(a, 'utf8'), 'A');
  assert.strictEqual(await readFile(b, 'utf8'), 'A');
  assert.strictEqual((await lstat(a)).nlink, 2);
});
```

Test 3 — `a dry run does not promise a restore the real undo skips` (rev-write; parity here means agreeing on the skip). The external write between the two captures goes through raw `node:fs/promises` `writeFile` (opens 'w', truncates in place):

```ts
it('a dry run does not promise a restore the real undo skips', async (t) => {
  const a = join(tmpDir, 'oracle-hl-rev-a.txt');
  const b = join(tmpDir, 'oracle-hl-rev-b.txt');
  await writeFile(a, 'A');
  try {
    await link(a, b);
  } catch {
    return t.skip('hard links not supported here');
  }
  const first = await captureOne((fs) => fs.writeFile(a, 'B'));
  await writeFile(b, 'C'); // external in-place write through the twin
  const second = await captureOne((fs) => fs.writeFile(b, 'B'));
  const { dry, real } = await previewThenUndo([first, second]);
  assert.ok(
    real.some((r) => r.endsWith(`${a} CANCELLED`)),
    real.join('\n'),
  );
  assert.deepStrictEqual(dry, real);
});
```

Both names end at 'C': the older step refused to restore over externally changed bytes, and the preview agrees.

Test 4 — `a dry run does not promise removing a file the real undo refuses to remove` (remove-C2). `a` does not exist yet, so its captured create leaves a remove record; the link and the external in-place write then make the twin's bytes diverge from what the remove record expects:

```ts
it('a dry run does not promise removing a file the real undo refuses to remove', async (t) => {
  const a = join(tmpDir, 'oracle-hl-rm-a.txt');
  const b = join(tmpDir, 'oracle-hl-rm-b.txt');
  const created = await captureOne((fs) => fs.writeFile(a, 'A')); // create: a remove record
  try {
    await link(a, b);
  } catch {
    return t.skip('hard links not supported here');
  }
  await writeFile(b, 'B'); // external in-place edit through the twin
  const edited = await captureOne((fs) => fs.writeFile(b, 'A'));
  const { dry, real } = await previewThenUndo([created, edited]);
  assert.ok(
    real.some((r) => r.endsWith(`${a} CANCELLED`)),
    real.join('\n'),
  );
  assert.deepStrictEqual(dry, real);
  assert.strictEqual(await readFile(a, 'utf8'), 'B'); // live refused the removal
});
```

Test 5 — `an edit through the moved name after a move of its hard-linked twin` (pins `toHere` via an alias and `fromFree` together):

```ts
it('an edit through the moved name after a move of its hard-linked twin', async (t) => {
  const a = join(tmpDir, 'oracle-hl-mv-a.txt');
  const b = join(tmpDir, 'oracle-hl-mv-b.txt');
  const c = join(tmpDir, 'oracle-hl-mv-c.txt');
  await writeFile(a, 'v1');
  try {
    await link(a, b);
  } catch {
    return t.skip('hard links not supported here');
  }
  const { dry, real } = await previewThenUndo([
    await captureOne((fs) => fs.writeFile(a, 'v2')),
    await captureOne((fs) => fs.rename(b, c)), // c is still the shared inode
    await captureOne((fs) => fs.writeFile(c, 'v3')),
  ]);
  assert.ok(
    real.every((r) => r.endsWith(' ok')),
    real.join('\n'),
  );
  assert.deepStrictEqual(dry, real);
  assert.strictEqual(await readFile(a, 'utf8'), 'v1');
  assert.strictEqual(await readFile(b, 'utf8'), 'v1');
  assert.strictEqual(
    await lstat(c).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.strictEqual((await lstat(a)).nlink, 2);
});
```

Test 6 — `a move of one name, then an edit through its twin` (identity retention alone; the minimal shape an alias-based fix fails):

```ts
it('a move of one name, then an edit through its twin', async (t) => {
  const a = join(tmpDir, 'oracle-hl-ia-a.txt');
  const b = join(tmpDir, 'oracle-hl-ia-b.txt');
  const c = join(tmpDir, 'oracle-hl-ia-c.txt');
  await writeFile(a, 'v1');
  try {
    await link(a, b);
  } catch {
    return t.skip('hard links not supported here');
  }
  const { dry, real } = await previewThenUndo([
    await captureOne((fs) => fs.rename(b, c)),
    await captureOne((fs) => fs.writeFile(a, 'v2')),
  ]);
  assert.ok(
    real.every((r) => r.endsWith(' ok')),
    real.join('\n'),
  );
  assert.deepStrictEqual(dry, real);
  assert.strictEqual(await readFile(a, 'utf8'), 'v1');
  assert.strictEqual(await readFile(b, 'utf8'), 'v1');
  assert.strictEqual(
    await lstat(c).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.strictEqual((await lstat(a)).nlink, 2);
});
```

Test 7 — `dryRun across two hard-linked names previews what the real undo restores` (tool level, mirrors the existing two-step test at `:1805-1847`):

```ts
it('dryRun across two hard-linked names previews what the real undo restores', async (t) => {
  const tmp = await createTestRoot();
  const pair = await createTestClientPair([tmp]);
  try {
    const a = join(tmp, 'linked-a.txt');
    const b = join(tmp, 'linked-b.txt');
    await writeFile(a, 'A');
    try {
      await link(a, b);
    } catch {
      return t.skip('hard links not supported here');
    }
    const first = await call(pair.client, 'edit', {
      path: a,
      edits: [{ oldText: 'A', newText: 'B' }],
    });
    assert.notStrictEqual(first.isError, true);
    const second = await call(pair.client, 'edit', {
      path: b,
      edits: [{ oldText: 'B', newText: 'C' }],
    });
    assert.notStrictEqual(second.isError, true);

    const dry = await call(pair.client, 'undo', { steps: 2, dryRun: true });
    assert.notStrictEqual(dry.isError, true);
    const dryText = firstTextBlock(dry) ?? '';
    assert.ok(!dryText.includes('SKIPPED') && !dryText.includes('FAILED'), dryText);
    assert.strictEqual(await readFile(a, 'utf8'), 'C');
    assert.strictEqual((await lstat(a)).nlink, 2);

    const undone = await call(pair.client, 'undo', { steps: 2 });
    assert.notStrictEqual(undone.isError, true);
    assert.strictEqual(await readFile(a, 'utf8'), 'A');
    assert.strictEqual(await readFile(b, 'utf8'), 'A');
  } finally {
    await pair.close();
    await cleanupTestRoot(tmp);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/undo.test.ts`
Expected: exactly the seven new tests FAIL — the preview reports `a.txt` "Not restored: modified since this undo step was recorded" (tests 1, 2, 7) or a `restored`/`ok` line that `deepStrictEqual` shows differing from `real` (tests 3-6); no previously-green test fails.

- [ ] **Step 3: Implement the inode-aware state in `src/core/undo.ts`**

Fields, after `#alias` (`undo.ts:626`):

```ts
/** An inode's link count as the preview's own unlinks leave it: seeded once
 * from disk, never re-seeded (a dry run never unlinks for real, so a later
 * lstat would undo counts the preview already spent). Never delete entries. */
readonly #links = new Map<string, bigint>();
/** sha256 an in-place preview write left on that inode: live writes through
 * one name of a multiply-linked file change what every name sees. */
readonly #inPlace = new Map<string, string>();
```

Helpers, after `#mint` (`undo.ts:741`):

```ts
/** A minted file is its inode's only name; every disk-resolved file is seeded. */
#linkCount(identity: FileIdentity): bigint {
  return this.#links.get(identityKey(identity)) ?? 1n;
}

/** A name left its inode: live unlink drops its link count. */
#unlink(identity: FileIdentity): void {
  this.#links.set(identityKey(identity), (this.#links.get(identityKey(identity)) ?? 1n) - 1n);
}
```

`world().hash` — one fallback between `node.hash` and the disk read:

```ts
return (
  node.hash ??
  this.#inPlace.get(identityKey(node.identity)) ??
  (await hashFile(this.#fs, node.disk ?? path, this.#signal))
);
```

`world().writeFile` — mirror live's in-place decision; the read-only refusal call is task 2, leave the branch without it for now:

```ts
writeFile: async (path, bytes) => {
  await this.#parentDir(path, 'open');
  const node = await this.#node(path);
  const hash = sha256Hex(bytes);
  if (node.kind === 'file' && this.#linkCount(node.identity) > 1n) {
    // Live writeFile keeps a multiply-linked inode in place, so every name
    // sees the new bytes and the identity survives to later records.
    this.#inPlace.set(identityKey(node.identity), hash);
    this.#put(previewKey(path), { kind: 'file', identity: node.identity });
    return;
  }
  this.#put(previewKey(path), { kind: 'file', identity: this.#mint(), hash });
},
```

`world().rm` — becomes async, decrements the count:

```ts
rm: async (path) => {
  const node = await this.#node(path);
  if (node.kind === 'file') this.#unlink(node.identity);
  this.#put(previewKey(path), ABSENT);
},
```

`#fromDisk` — seed after `const kind = kindOf(stats);` (`:887`); both stat branches there are bigint:

```ts
// First sight wins: the dry run's disk is frozen, so a later read of the
// same inode would re-report the pre-run count the preview already spent.
if (kind === 'file' && !this.#links.has(identityKey(identity))) {
  this.#links.set(identityKey(identity), stats.nlink);
}
```

Nothing else changes: no `hash` on the in-place node (bytes live in `#inPlace`), no `#unlink` in the mint branch (a minted inode has one name), `#mint` untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- __tests__/undo.test.ts`
Expected: all tests PASS (the seven new ones included), 5 pre-existing hard-link/symlink skips remain, no previously-green test flips.

- [ ] **Step 5: Commit**

```bash
git add src/core/undo.ts __tests__/undo.test.ts
git commit -m "fix(undo): preview hard-linked writes by shared inode

The dry-run preview modeled each path as its own file, so a previewed
write through one hard-linked name was invisible at the inode's other
names and minted an identity live undo keeps. Model the shared inode:
content overlay and link counts keyed by dev/ino, in-place writes keep
the identity, mirroring GuardedFileSystem.writeFile for nlink > 1.

Closes #156

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: read-only hard-link refusal parity

**Files:**

- Modify: `src/core/fs.ts:132` (one signature line), `src/core/fs.ts:468` and `:556` (drop `#` at the two call sites), `src/core/undo.ts` (one call in task 1's in-place branch)
- Test: `__tests__/undo.test.ts` — standalone `it` at the end of `describe('restoreEntry')`

**Interfaces:**

- Consumes: task 1's in-place branch and `#linkCount`.
- Produces: public `GuardedFileSystem.assertNoReadOnlyHardLink(path: string, stats: { nlink: number }): void` (was `#assertNoReadOnlyHardLink(path: string, stats: Stats)`; body unchanged). `Stats` satisfies `{ nlink: number }`, so both existing call sites compile untouched.

- [ ] **Step 1: Write the failing test**

In `describe('restoreEntry')`, a standalone test with its own read-only-configured server (setup modeled on `__tests__/read-only-roots.test.ts`):

```ts
it('a dry run refuses a write live undo must refuse on a read-only hard link', async (t) => {
  const rw = await createTestRoot();
  const ro = await createTestRoot();
  const server = await createTestServer([rw], { readOnlyDirs: [ro] });
  try {
    const file = join(rw, 'ro-linked.txt');
    const twin = join(ro, 'ro-linked-twin.txt');
    await writeFile(file, 'A');
    const cap = new UndoJournal(32 * 1024 * 1024).beginCapture();
    const guarded = new GuardedFileSystem(server.pathGuard, cap);
    await guarded.writeFile(file, 'B'); // captured while the file is still single-linked
    assert.strictEqual(cap.unavailableReason(), undefined);
    try {
      await link(file, twin);
    } catch {
      return t.skip('hard links not supported here');
    }
    const entry = { id: 't', tool: 'test', createdAt: Date.now(), records: cap.records };

    const preview = new UndoPreview(new GuardedFileSystem(server.pathGuard));
    const dry = await restoreEntry(entry, new GuardedFileSystem(server.pathGuard), {
      dryRun: true,
      preview,
    });
    assert.strictEqual(dry.results.filter((r) => !('error' in r)).length, 0);
    assert.ok(
      dry.results.some((r) => 'error' in r && r.error.code === ErrorCode.ACCESS_DENIED),
      JSON.stringify(dry.results.map((r) => ('error' in r ? r.error.code : 'ok'))),
    );
    assert.strictEqual(await readFile(file, 'utf8'), 'B'); // the dry run wrote nothing

    const live = await restoreEntry(entry, new GuardedFileSystem(server.pathGuard), {
      dryRun: false,
    });
    assert.ok(live.results.some((r) => 'error' in r && r.error.code === ErrorCode.ACCESS_DENIED));
    assert.strictEqual(await readFile(file, 'utf8'), 'B');
  } finally {
    server.disposeRuntimeState();
    await server.mcp.close();
    await cleanupTestRoot(rw);
    await cleanupTestRoot(ro);
  }
});
```

The capture happens before `link()`: the write is recorded while the file is single-linked (allowed), and only the external link afterwards makes it multiply-linked under a read-only configuration. Add `ErrorCode` to the `../src/core/errors.ts` import at the file top (`undo.test.ts:8`); the existing import there is type-only (`import type { Problem }`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- __tests__/undo.test.ts`
Expected: the new test FAILS — the dry run reports `restored: true` where the live run fails `ACCESS_DENIED`.

- [ ] **Step 3: Implement the refusal**

`src/core/fs.ts:132`:

```ts
assertNoReadOnlyHardLink(path: string, stats: { nlink: number }): void {
```

Drop the `#` at the call sites (`:468`, `:556`). Body unchanged.

`src/core/undo.ts`, first line inside task 1's in-place branch (before `#inPlace.set` — the throw must leave the preview unmutated):

```ts
this.#fs.assertNoReadOnlyHardLink(path, { nlink: Number(this.#linkCount(node.identity)) });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- __tests__/undo.test.ts`
Expected: PASS, no flips elsewhere.

- [ ] **Step 5: Commit**

```bash
git add src/core/fs.ts src/core/undo.ts __tests__/undo.test.ts
git commit -m "fix(undo): preview the read-only hard-link refusal

Reuse GuardedFileSystem.assertNoReadOnlyHardLink from the preview's
in-place branch so a dry run reports the same ACCESS_DENIED the live
undo hits for a multiply-linked file under read-only directories.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: parity pin, full gate, cleanup

**Files:**

- Test: `__tests__/undo.test.ts` — one oracle test appended to the oracle describe
- Delete: `repro-156.ts` (repo root, untracked; superseded by the unit tests)

**Interfaces:**

- Consumes: the landed fix. Produces: nothing.

- [ ] **Step 1: Add the green parity pin**

`a write after one link was removed previews the fresh-inode restore` — pins that the in-place branch does not over-apply to single-linked targets (Review Focus line 5). This shape is parity before and after the fix; it guards the fresh branch:

```ts
it('a write after one link was removed previews the fresh-inode restore', async (t) => {
  const a = join(tmpDir, 'oracle-hl-drop-a.txt');
  const b = join(tmpDir, 'oracle-hl-drop-b.txt');
  await writeFile(a, 'v1');
  try {
    await link(a, b);
  } catch {
    return t.skip('hard links not supported here');
  }
  const writeB = await captureOne((fs) => fs.writeFile(b, 'v2')); // in-place capture, both names 'v2'
  const removeA = await captureOne((fs) => fs.rm(a)); // snapshot bytes 'v2', undo recreates a
  const { dry, real } = await previewThenUndo([writeB, removeA]);
  assert.ok(
    real.every((r) => r.endsWith(' ok')),
    real.join('\n'),
  );
  assert.deepStrictEqual(dry, real);
  assert.strictEqual(await readFile(a, 'utf8'), 'v2'); // recreated by the newer step
  assert.strictEqual(await readFile(b, 'utf8'), 'v1'); // reverted, on a fresh inode
  assert.strictEqual((await lstat(a)).nlink, 1); // a is a fresh inode now
});
```

- [ ] **Step 2: Run it and the full gate**

Run: `npm test -- __tests__/undo.test.ts`
Expected: PASS, including this pin (if it fails, the fresh/in-place decision diverged — fix before proceeding).

Run: `npm run check`
Expected: full repository check green — static checks, the whole suite, `__tests__/contract.test.ts` unmodified (no snapshot diff; the advertised surface is unchanged).

- [ ] **Step 3: Delete the repro script**

```bash
rm repro-156.ts
```

Expected: `git status` clean (the file was untracked); the reproduction now lives as the task 1 tests.

- [ ] **Step 4: Commit**

```bash
git add __tests__/undo.test.ts
git commit -m "test(undo): pin rm-then-write parity across a hard link

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
