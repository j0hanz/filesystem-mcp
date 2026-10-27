# Capture availability owner implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `UndoCapture` exclusively owns capture availability: `fs.ts` stops
re-checking `!capture.unavailable` at nine sites, the field leaves the public
interface, and one accessor reports the reason.

**Architecture:** The nine `capture && !capture.unavailable` guards in
`src/core/fs.ts` wrap only undo bookkeeping (the mutation always runs), and
`UndoCapture` already no-ops everywhere (`push`, `reserve`, `abandon`,
`snapshotTree`'s entry check), so deleting the guards makes that no-op the
single owner. The field goes `#private`, `isAbandoned()` goes `private` (two
internal callers), and one public `unavailableReason()` serves the reporting
site in `define.ts` (`#undoSuffix`). Observable behavior is byte-identical.
Terms: `GLOSSARY.md` (capture).

**Tech Stack:** TypeScript, Node built-in test runner.

**Spec:** The architecture-review candidate "UndoCapture owns its own
availability" (2026-10-27), settled in the grilling decisions recorded as this
plan's Global Constraints. The glossary's **Capture** entry (added 2026-10-27)
states the domain contract this implements: a capture that is unavailable
records nothing further, and the mutation still runs.

## Global Constraints

- Observable behavior byte-identical: the `undoUnavailable` structured key and
  the ` · not undoable: <reason>` suffix unchanged;
  `__tests__/contract.test.ts` snapshots untouched.
- In `fs.ts` the `capture &&` half of every guard survives (undo disabled,
  read-only calls, dry runs): mutations run unconditionally, only undo
  bookkeeping may no-op.
- First reason wins: `abandon()` on an already-unavailable capture is a no-op.
- Interface after the change: `#unavailable` field, `private isAbandoned()`,
  one public availability read `unavailableReason(): string | undefined`.
- Accepted cost (settled, do not "fix"): on an already-abandoned capture,
  `rename`'s identity `lstat`, `mkdir`'s parent-chain walk, and the
  `sha256Hex` at the `writeFile`/`appendFile` push sites still run and are
  discarded.

## Review Focus

Failure modes a user can hit; each is pinned to the task that owns it.

1. A tool that abandons mid-call (cp, a protected tree move) and then performs
   further guarded mutations: mutations run, nothing is recorded, the first
   reason survives. → Task 1's pin test.
2. A client reading the unavailable report: suffix text and `undoUnavailable`
   value byte-identical. → Task 2 Step 4 runs the pinning suites
   (`undo.test.ts` suffix tests, `tools.test.ts` undo annotations).
3. Undo disabled or a read-only/dry-run call: no capture at all, so the
   `capture &&` half must survive the deletion. → Task 2 Step 4 runs the
   disabled-undo and read-only suites.
4. A budget-exhausted capture: reason strings verbatim (`too large to keep
   for undo`, `too many changes to keep for undo`). → Task 1's sweep keeps the
   string-equality asserts; Task 2 Step 4 re-runs them.
5. A respelling-only rename (the destination IS the source): no destination
   snapshot even on a live capture. → Task 2 Step 4 runs
   `unicode-paths.test.ts` rename tests.

## Delivery

Branch `refactor/capture-availability-owner`, two commits: `docs(plan)` (Task
0, plan + glossary), then `refactor(core)` (Tasks 1–3, one commit at the end).

### Task 0: branch and plan commit

- [ ] Create branch `refactor/capture-availability-owner` from `main`.
- [ ] Commit the glossary entry and this plan:
      `docs(plan): add the capture availability owner plan and a glossary`.

### Task 1: `unavailableReason()` and the pin

**Files:**
- Modify: `src/core/undo.ts` (class `UndoCapture`, after `isAbandoned()` at
  :247)
- Test: `__tests__/undo.test.ts` (new test after the cp test at :304; 15
  assert sites swept)

**Interfaces:**
- Produces: `UndoCapture.unavailableReason(): string | undefined`, the
  abandon reason when the capture is unavailable, else `undefined`. Task 2 and
  the 15 test reads rely on this exact name and return type.

- [ ] **Step 1: Write the failing pin test**

In `__tests__/undo.test.ts`, directly after the `cp abandons with copies are
not undoable yet` test, add:

```ts
it('after an abandon, mutations run but record nothing, and the first reason wins', async () => {
  const src = join(tmpDir, 'pin-src.txt');
  const mid = join(tmpDir, 'pin-mid.txt');
  await writeFile(src, 'src');
  await writeFile(mid, 'mid');
  const cap = capture();
  const fs = makeFs(cap);
  await fs.cp(src, join(tmpDir, 'pin-dest.txt')); // abandons: copies are not undoable yet
  await fs.writeFile(mid, 'replaced'); // the mutation runs; nothing is recorded
  await fs.rename(mid, src); // overwrites src; nothing is recorded
  assert.strictEqual((await lstat(src)).size, 8); // the write and rename both ran
  await fs.rm(src); // snapshotTree skips; nothing is recorded
  assert.strictEqual(cap.unavailableReason(), 'copies are not undoable yet');
  assert.deepStrictEqual(cap.records, []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- __tests__/undo.test.ts --test-name-pattern="after an abandon"`
Expected: FAIL with `TypeError: cap.unavailableReason is not a function`.

- [ ] **Step 3: Implement the accessor**

In `src/core/undo.ts`, after `isAbandoned()` (:247-249), add:

```ts
/** The abandon reason once this capture is unavailable, else undefined; the undo suffix reports it. */
unavailableReason(): string | undefined {
  return this.unavailable;
}
```

- [ ] **Step 4: Run the pin test again**

Run: `npm test -- __tests__/undo.test.ts --test-name-pattern="after an abandon"`
Expected: PASS.

- [ ] **Step 5: Sweep the 15 test reads to the accessor**

In `__tests__/undo.test.ts`, replace every read of the raw field with the
call: `assert.strictEqual(cap.unavailable, X)` becomes
`assert.strictEqual(cap.unavailableReason(), X)`; the `=== undefined` and
`!== undefined` asserts swap the property for the call. Sites: lines 114
(`caps.every((c) => ...)`), 124, 177, 237, 257, 267, 279, 300, 311, 329, 348,
365, 433, 1066, 1169. No assertion value changes.

- [ ] **Step 6: Run the file**

Run: `npm test -- __tests__/undo.test.ts`
Expected: PASS, all tests.

### Task 2: fs.ts stops reading capture state; the field goes private

**Files:**
- Modify: `src/core/fs.ts:288, 292, 319, 339, 373, 424, 466, 524, 584`
- Modify: `src/core/undo.ts` (field `:229`, `isAbandoned` `:247`, `reserve`
  `:264`, `abandon` `:278-279`, `push` `:288`, `snapshotTree` `:365`)
- Modify: `src/tools/define.ts:329-331`

**Interfaces:**
- Consumes: `unavailableReason()` (Task 1).
- Produces: `#unavailable` field and `private isAbandoned()`; nothing
  outside `undo.ts` may read capture availability after this task.

- [ ] **Step 1: Delete the nine guard halves in `fs.ts`**

Each condition keeps its `capture &&` half and drops
`&& !capture.unavailable` (or `&& !this.#capture.unavailable`):

- `mkdir` :288 and :292: `if (capture)`
- `rename` :319: `if (capture && !spellingOnly)`; :339: `if (this.#capture)`
- `writeFile` :373 and :424: `if (this.#capture)`
- `appendFile` :466: `if (this.#capture && existing)`; :524:
  `if (this.#capture)`
- `rm` :584: `if (capture)`

The surrounding `Undo capture:` comments stay; no other line changes.

- [ ] **Step 2: Privatize in `undo.ts`**

- Field `:229`: `unavailable: string | undefined;` →
  `#unavailable: string | undefined;`
- `isAbandoned()` at :247 becomes `private`, body →
  `return this.#unavailable !== undefined;`
- `reserve()` :264, `abandon()` :278-279, `push()` :288:
  `this.unavailable` → `this.#unavailable`
- `unavailableReason()` body (Task 1) → `return this.#unavailable;`
- `snapshotTree` :365: `if (capture.unavailable !== undefined) return;` →
  `if (capture.isAbandoned()) return;`

- [ ] **Step 3: `define.ts` reads the accessor**

`#undoSuffix` :329-331 becomes:

```ts
const reason = capture.unavailableReason();
if (reason !== undefined) {
  if (structured !== undefined) structured['undoUnavailable'] = reason;
  return ` · not undoable: ${reason}`;
}
```

- [ ] **Step 4: Run the suites**

Run: `npm test -- __tests__/undo.test.ts __tests__/core-fs.test.ts`
Expected: PASS; these two suites green with the guards deleted is the
empirically verified bar (the review's verify pass ran exactly this deletion:
187 tests, 0 fail).

### Task 3: verify and commit

- [ ] **Step 1: Full gate**

Run: `npm run check`
Expected: static checks and the full suite PASS; no contract snapshot change.

- [ ] **Step 2: POSIX spot-check**

Run `__tests__/undo.test.ts` under WSL (script starting with
`source ~/.nvm/nvm.sh`, per the repo's WSL convention): the FIFO and 0o200
tests are POSIX-only paths through the deleted guards.
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/undo.ts src/core/fs.ts src/tools/define.ts __tests__/undo.test.ts
git commit -m "refactor(core): give capture availability one owner in UndoCapture"
```