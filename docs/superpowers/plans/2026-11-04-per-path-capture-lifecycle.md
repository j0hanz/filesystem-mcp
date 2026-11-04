# Per-path Capture Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the per-path Capture lifecycle out of every `GuardedFileSystem` mutation and into one scope on `UndoCapture`, with no change in behaviour.

**Architecture:** `UndoCapture.forMutation(path, run)` opens a path's capture, hands `run` a small `PathCapture`, and settles on every exit. A mutation calls `own.changed()` at its point of no return; any earlier exit returns the charge and reports nothing. A `GuardedFileSystem` with no Capture runs the same code against `NOT_RECORDING`.

**Tech Stack:** TypeScript on Node's built-in test runner.

**Spec:** No separate document. Candidate 1 of the 2026-11-04 architecture review, as settled in its grilling; the decisions are the Global Constraints below. The word **Capture** is defined in `GLOSSARY.md`.

## Global Constraints

- Refactor only: `undoUnavailable` text, undo ids and the MCP contract do not change. `__tests__/contract.test.ts.snapshot` has no diff.
- The verb is `changed()`, never `landed()`: `GLOSSARY.md` gives **Landing** another meaning.
- `abandon(reason)` means no undo; `changed()` reports. A path that changed without undo calls both. No third verb.
- `own.recording` is the only guard for undo-only work. It is `true` for a real capture even after `abandon`, matching today's `if (capture)`.
- `saveOld`, `snapshotTree` and `plannedMkdirChain` stay exported functions.
- `#copy` still abandons the whole call through `this.#capture?.abandon`.
- `release()` stays public on `UndoCapture`: `src/tools/define.ts:529` and call-level tests use it. `PathCapture` does not expose it.
- Known oddity, kept on purpose: `rm` reports before its raw delete, so a path whose snapshot was abandoned is named in `undoUnavailable` even if the delete then fails outright. It gets a separate fix.
- Work on branch `refactor/per-path-capture-lifecycle`, not `main`.
- End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A mutation that throws after `changed()`, as a half-finished recursive `rm`: its records stay, so undo still restores what went. (Task 1, Task 2)
- A call with no Capture (journal off, `noUndo`): every mutation still works, and nothing saves old bytes. (Task 2)
- A read reserved, then a throw: the reservation returns to the shared pool, or later calls in the server lose undo. (Task 1)
- `changed()` reached twice on one path: records are handed over once, so a restore doesn't run them twice. (Task 1)
- The call abandoned while a path is mid-mutation, as a `copy` in the same call: that path's `changed()` keeps no records and adds no second reason. (Task 1)

---

### Task 1: `forMutation` scope on `UndoCapture`

**Files:**

- Modify: `src/core/undo.ts:233-378`
- Test: `__tests__/undo.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces, exported from `src/core/undo.ts`:

```ts
export interface PathCapture {
  /** False only for NOT_RECORDING; stays true after abandon. */
  readonly recording: boolean;
  reserve(n: number): boolean;
  abandon(reason: string): void;
  push(...records: UndoRecord[]): void;
  unavailableReason(): string | undefined;
  /** This path has, or may have, changed: hand records and charge to the call, or report why it has none. */
  changed(): void;
}

export const NOT_RECORDING: PathCapture;

// on class UndoCapture implements PathCapture
forMutation<T>(path: string, run: (own: PathCapture) => Promise<T>): Promise<T>;
get recording(): boolean; // always true
changed(): void; // no-op at call level
```

`forPath` and `commit` keep working until Task 3.

- [ ] **Step 1: Create the branch**

Run: `git switch -c refactor/per-path-capture-lifecycle`
Expected: on the new branch.

- [ ] **Step 2: Write the failing table test**

Add a new top-level `describe` to `__tests__/undo.test.ts`, and import `NOT_RECORDING` and `type PathCapture`:

```ts
describe('forMutation settles every exit', () => {
  const path = join('/root', 'a');
  const record: UndoRecord = { op: 'rmdir', path: join(path, 'x') };
  const body =
    (fn: (own: PathCapture) => void) =>
    (own: PathCapture): Promise<void> => {
      fn(own);
      return Promise.resolve();
    };
  const boom = new Error('boom');

  it('returns what run returns', async () => {
    const cap = new UndoJournal(1024 * 1024).beginCapture();
    assert.strictEqual(await cap.forMutation(path, () => Promise.resolve(7)), 7);
    cap.release();
  });

  const exits: {
    name: string;
    run: (own: PathCapture) => void;
    rejects: boolean;
    records: number;
    reason: string | undefined;
  }[] = [
    {
      name: 'no change',
      run: (o) => o.push(record),
      rejects: false,
      records: 0,
      reason: undefined,
    },
    {
      name: 'throw before change',
      run: (o) => {
        o.push(record);
        throw boom;
      },
      rejects: true,
      records: 0,
      reason: undefined,
    },
    {
      name: 'abandon, then throw before change',
      run: (o) => {
        o.abandon('no');
        throw boom;
      },
      rejects: true,
      records: 0,
      reason: undefined,
    },
    {
      name: 'change',
      run: (o) => {
        o.push(record);
        o.changed();
      },
      rejects: false,
      records: 1,
      reason: undefined,
    },
    {
      name: 'throw after change keeps records',
      run: (o) => {
        o.push(record);
        o.changed();
        throw boom;
      },
      rejects: true,
      records: 1,
      reason: undefined,
    },
    {
      name: 'abandon and change report the path',
      run: (o) => {
        o.abandon('no');
        o.changed();
        throw boom;
      },
      rejects: true,
      records: 0,
      reason: 'a: no',
    },
    {
      name: 'a second change hands over once',
      run: (o) => {
        o.push(record);
        o.changed();
        o.changed();
      },
      rejects: false,
      records: 1,
      reason: undefined,
    },
  ];

  for (const { name, run, rejects, records, reason } of exits) {
    it(name, async () => {
      const cap = new UndoJournal(1024 * 1024).beginCapture();
      const settled = cap.forMutation(path, body(run));
      if (rejects) await assert.rejects(settled, boom);
      else await settled;
      assert.strictEqual(cap.records.length, records);
      assert.strictEqual(cap.unavailableReason(), reason);
      cap.release();
    });
  }

  it('returns a reservation to the pool when run throws', async () => {
    // reserve adds a record's overhead, so the budget leaves room for one such charge, not two.
    const journal = new UndoJournal(4000);
    const cap = journal.beginCapture();
    await assert.rejects(
      cap.forMutation(
        path,
        body((own) => {
          assert.ok(own.reserve(3000));
          throw boom;
        }),
      ),
      boom,
    );
    const probe = journal.beginCapture();
    assert.ok(probe.reserve(3000), 'the reservation came back');
    probe.release();
    cap.release();
  });

  it('keeps no records and no second reason when the call was abandoned mid-mutation', async () => {
    const cap = new UndoJournal(1024 * 1024).beginCapture();
    await cap.forMutation(
      path,
      body((own) => {
        own.push(record);
        cap.abandon('copies are not undoable yet');
        own.changed();
      }),
    );
    assert.strictEqual(cap.records.length, 0);
    assert.strictEqual(cap.unavailableReason(), 'copies are not undoable yet');
    cap.release();
  });

  it('NOT_RECORDING records nothing and never throws', () => {
    assert.strictEqual(NOT_RECORDING.recording, false);
    assert.strictEqual(NOT_RECORDING.reserve(1), false);
    NOT_RECORDING.abandon('no');
    NOT_RECORDING.push(record);
    NOT_RECORDING.changed();
    assert.strictEqual(NOT_RECORDING.unavailableReason(), undefined);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="forMutation settles"`
Expected: FAIL, `NOT_RECORDING` and `forMutation` do not exist.

- [ ] **Step 4: Implement in `src/core/undo.ts`**

Add `PathCapture` and `NOT_RECORDING` above `UndoCapture`, and declare `implements PathCapture`.

`changed()` takes today's `commit()` body and clears `#owner` on both of its exits, so a second call hits the existing `#owner === undefined` return. Keep `commit()` as a one-line call to `changed()` until Task 3.

```ts
async forMutation<T>(path: string, run: (own: PathCapture) => Promise<T>): Promise<T> {
  const own = this.forPath(path);
  try {
    return await run(own);
  } finally {
    // After changed() this does nothing. Any other exit changed nothing, so nothing is reported.
    own.release();
  }
}
```

Change the `capture` parameter of `saveOld`, `snapshotTree` and `plannedMkdirChain` to `PathCapture`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="forMutation settles"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/undo.ts __tests__/undo.test.ts
git commit -m "refactor(undo): add forMutation scope for a path's capture"
```

### Task 2: Run every mutation through the scope

**Files:**

- Modify: `src/core/fs.ts:485-503` (`mkdir`), `:662-719` (`#move`), `:721-866` (`writeFile`, `#writeValid`), `:869-990` (`appendFile`, `#appendValid`), `:1030-1067` (`rm`, `rmdir`), `:1107-1147` (`#moveAcrossDevices`)
- Test: `__tests__/undo.test.ts`

**Interfaces:**

- Consumes: `PathCapture`, `NOT_RECORDING`, `UndoCapture.forMutation` from Task 1.
- Produces: private `#forMutation<T>(path: string, run: (own: PathCapture) => Promise<T>): Promise<T>` on `GuardedFileSystem`. It calls `this.#capture.forMutation` when there is a Capture, else `run(NOT_RECORDING)`.

- [ ] **Step 1: Write the test for a call with no Capture**

Add inside `describe('UndoCapture via GuardedFileSystem')`, which has `tmpDir` and `ctx`:

```ts
it('every mutation works with no capture', async () => {
  const fs = new GuardedFileSystem(ctx.pathGuard);
  const dir = join(tmpDir, 'plain', 'deep');
  const file = join(dir, 'f.txt');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, 'one');
  await fs.writeFile(file, 'two');
  await fs.appendFile(file, '!');
  assert.strictEqual(await readFile(file, 'utf8'), 'two!');
  await fs.rm(file);
  await fs.rmdir(dir);
  await assert.rejects(lstat(dir));
});
```

- [ ] **Step 2: Run it to record the baseline**

Run: `npm test -- --test-name-pattern="every mutation works with no capture"`
Expected: PASS. It passes today and must still pass after the move, because this task is a refactor.

- [ ] **Step 3: Move each mutation into `#forMutation`**

Replace `capture` with `own: PathCapture`, and `capture?.x` or `if (capture)` as this table says. Keep existing comments except the repeated `After a commit this does nothing`, which now lives in `forMutation`.

| Mutation             | Undo-only work guarded by `own.recording` | `own.changed()` goes                      |
| :------------------- | :---------------------------------------- | :---------------------------------------- |
| `mkdir`              | `plannedMkdirChain`                       | after `fsMkdir`, after the `rmdir` pushes |
| `#move`              | destination save, moved entry's `fsLstat` | after the rename records                  |
| `#moveAcrossDevices` | none                                      | where `capture?.commit()` is now          |
| `#writeValid`        | `saveOld`, `sha256Hex` in `recordWrite`   | where `commit` is now, both exits         |
| `#appendValid`       | `saveOld`, `sha256Hex`                    | where `commit` is now, both exits         |
| `rm`                 | `snapshotTree`                            | before `fsRm`, as today                   |
| `rmdir`              | the `before` lstat                        | after `fsRmdir` and its push              |

`rm` drops its hand-written `capture?.release()`: the abort check becomes `signal?.throwIfAborted()` and the scope releases. `rmdir` now opens the scope before its raw call, which holds no charge.

`#writeValid` guards non-regular targets with `if (own.recording)` exactly where `if (capture)` is now, so `abandon` messages stay.

- [ ] **Step 4: Run the full check**

Run: `npm run check`
Expected: PASS, including `__tests__/undo.test.ts`, `delete.test.ts`, `move-exdev.test.ts` and the failed-close test from `deca93bb`.

- [ ] **Step 5: Confirm the contract did not move**

Run: `git diff --stat -- __tests__/contract.test.ts.snapshot`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/core/fs.ts __tests__/undo.test.ts
git commit -m "refactor(fs): run mutations through the capture scope"
```

### Task 3: Remove the old protocol

**Files:**

- Modify: `src/core/undo.ts`
- Test: `__tests__/delete.test.ts:466-498`, `__tests__/undo.test.ts:518-524`, `:620-624`, `:846-852`

**Interfaces:**

- Consumes: `forMutation`, `PathCapture` from Task 1.
- Produces: `forPath` becomes private `#forPath`; `commit` is deleted. `release` stays public.

- [ ] **Step 1: Make `forPath` private and delete `commit`**

`forMutation` is the only caller of `#forPath`.

- [ ] **Step 2: Verify the old tests now fail to compile**

Run: `npm run check:static`
Expected: FAIL, naming only the test lines listed under **Files**. Any `src/` line means Task 2 missed a site: fix that first.

- [ ] **Step 3: Migrate those tests to `forMutation`**

Each test keeps its name and its assertions. Each `forPath` + `push` + `commit` becomes one `forMutation` call, awaited in the same order, and the test becomes `async`.

- `delete.test.ts` budget test: `fill('released')` exits without `changed()`; `refused` calls `abandon` then `changed()`; `kept` calls `changed()`. Drop the `ReturnType<typeof capture.forPath>` annotation.
- `undo.test.ts:620` order test: run the two scopes in `refusedFirst` order; each pushes or abandons, then calls `changed()`.
- `undo.test.ts:846`: pass `own` to `plannedMkdirChain` inside the scope.

- [ ] **Step 4: Run the full check**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Confirm the old protocol is gone**

Run: `git grep -nE "\.forPath\(|\.commit\(\)" -- src __tests__`
Expected: no output.

- [ ] **Step 6: Update the graph and commit**

Run `graphify update .`, then:

```bash
git add src/core/undo.ts __tests__/delete.test.ts __tests__/undo.test.ts
git commit -m "refactor(undo): remove the per-path commit protocol"
```
