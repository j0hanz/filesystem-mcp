# Plan 122: An edit does not read the file a second time to save it for undo

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/core/rewrite.ts src/core/fs.ts src/core/undo.ts __tests__/rewrite.test.ts __tests__/undo.test.ts`
> Plan 104 changes one catch block in `src/core/fs.ts` (`#writeValid`); that
> is expected. For any other change, compare the "Current state" excerpts
> against the live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (the saved bytes are what `undo` restores; they must be the file's exact bytes)
- **Depends on**: plans/104-write-refuses-after-detected-path-swap.md (same block of `fs.ts`), plans/113-tests-for-lock-rate-limit-order-and-failed-rename.md (safety net)
- **Category**: perf
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

`edit`, `patch` and `replace_text` are "Rewrites": under the file's write
lock they read the whole file, transform it, and write it back. To make the
change undoable, the write then saves the old bytes, by reading the whole
file again. Every undoable edit therefore reads its target twice: a 10 MiB
file costs 20 MiB of reads plus a second open and validation. The first read
happened under the same lock, so its bytes are exactly what the second read
returns unless something outside the server changed the file in between.

This plan hands the bytes already read to the undo capture when a stat
proves the file has not changed. It starts with a measurement; if the saving
is small, the plan ends there.

## Current state

`src/core/rewrite.ts:57-64` (named file: `edit`, `patch`):

```ts
return locked(request, async () => {
  const { validPath, content, stats } = await request.fs.readNamedText(request.path, {
    signal: request.signal,
    tool: request.tool,
  });
  const view = viewText(content);
  return apply(request, validPath, view, stats, await transform(view.text, view));
});
```

`src/core/rewrite.ts:82-90` (walked file: `replace_text`):

```ts
return locked(request, async () => {
  const verdict = await request.fs.readText(request.path, { signal: request.signal });
  if (verdict.kind !== 'text') return skipOf(verdict);
  // ...
  const change = await transform(verdict.bytes, verdict.stats, open);
  if (change === undefined) return undefined;
  return apply(request, request.path, open(), verdict.stats, change);
});
```

`apply` writes at `src/core/rewrite.ts:152-153`:

```ts
  if (written) {
    await fs.writeFile(request.path, after, { signal });
```

`src/core/fs.ts:1907-1914`, `readNamedText` has the exact bytes but returns
only the decoded string:

```ts
const verdict = await this.readText(validPath, { signal, requestedPath: filePath });
if (verdict.kind !== 'text') throw refusalOf(verdict, filePath, options?.tool);
return { validPath, content: verdict.bytes.toString('utf8'), stats: verdict.stats };
```

`src/core/fs.ts:1159-1170`, `writeFile`:

```ts
  async writeFile(
    filePath: string,
    content: string | Buffer,
    options: { signal?: AbortSignal | undefined; mode?: number | undefined } = {},
  ): Promise<{ validPath: string }> {
    const validPath = await this.#guard('write', filePath);
    await this.#forMutation(validPath, (own) =>
      this.#writeValid(validPath, filePath, content, options, own),
    );
```

Inside `#writeValid` (`src/core/fs.ts:1195-1213`):

```ts
const existing = await fsStat(validPath);
// ...
if (own.recording && !relock) {
  if (!existing.isFile()) {
    own.abandon('cannot capture a write over a non-regular file');
  } else {
    saved = await saveOld(own, this, validPath, existing);
  }
}
```

`src/core/undo.ts:547-561`, `saveOld`:

```ts
export async function saveOld(
  capture: PathCapture,
  fs: GuardedFileSystem,
  path: string,
  stats: Stats | BigIntStats,
): Promise<SavedFile | undefined> {
  if (!capture.reserve(Number(stats.size))) return undefined;
  const exact =
    typeof stats.ino === 'bigint' ? (stats as BigIntStats) : await fsLstat(path, { bigint: true });
  return {
    bytes: await fs.readSaved(path),
    mode: Number(stats.mode) & 0o777,
    was: identityOf(exact),
  };
}
```

`fs.readSaved` (`src/core/fs.ts:567-570`) is the second whole-file read.

Vocabulary (GLOSSARY): **Rewrite**, **Capture** ("The record of a tool
call's filesystem changes ..."). Use these words in comments.

## Design (fixed by this plan)

1. `writeFile`'s options gain an optional field:

```ts
    /** The file's bytes and stat as the caller read them under this path's write lock; undo saves these instead of reading again. */
    previous?: { readonly bytes: Buffer; readonly stats: Stats } | undefined;
```

2. `#writeValid` passes `options.previous?.bytes` to `saveOld` only when the
   fresh `existing` stat matches `previous.stats` on all of: `dev`, `ino`,
   `size`, `mtimeMs`. Otherwise it passes nothing and `saveOld` reads as
   today.
3. `saveOld` takes a fifth optional parameter `known?: Buffer` and uses it in
   place of `await fs.readSaved(path)` when given. The `capture.reserve` call
   and the bigint `lstat` for `was` stay.
4. `readNamedText` also returns `bytes: verdict.bytes`.
5. `apply` in `rewrite.ts` receives the bytes (a new parameter) and passes
   `{ previous: { bytes, stats } }` to `fs.writeFile`. `rewriteFile` passes
   the bytes from `readNamedText`; `rewriteEntry` passes `verdict.bytes`.

Only Rewrites use `previous`. `create` and undo's own restores do not.

## Commands you will need

| Purpose    | Command                                                                                                          | Expected on success |
| :--------- | :--------------------------------------------------------------------------------------------------------------- | :------------------ |
| Build      | `npm run build`                                                                                                  | exit 0              |
| Rewrite    | `node --test --test-timeout=60000 __tests__/rewrite.test.ts`                                                     | all pass            |
| Undo       | `node --test --test-timeout=60000 __tests__/undo.test.ts`                                                        | all pass            |
| Tools      | `node --test --test-timeout=60000 __tests__/edit.test.ts __tests__/patch.test.ts __tests__/replace-text.test.ts` | all pass            |
| Full check | `npm run check`                                                                                                  | exit 0              |

## Scope

**In scope**:

- `src/core/rewrite.ts`, `src/core/fs.ts` (`writeFile`, `#writeValid`,
  `readNamedText` and its result type), `src/core/undo.ts` (`saveOld`)
- `__tests__/rewrite.test.ts` (new tests)
- `plans/README.md`

**Out of scope**:

- `appendFile`, `create`, transfers, deletion.
- Removing the repeated path validations (a security-design question).
- The in-place hard-link branch's relock logic: with `relock` true the first
  pass saves nothing and the recursive call must receive the same `options`
  (it already passes `options` through; confirm, do not restructure).

## Git workflow

- Branch: `perf/rewrite-reuse-read-for-undo`
- Commits: `test(rewrite): count reads per undoable edit`, then
  `perf(rewrite): save the bytes already read for undo`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Measure

In `__tests__/rewrite.test.ts`, add a test that performs one undoable
rewrite of a 4 MiB text file (build the `GuardedFileSystem` with a capture:
`new GuardedFileSystem(ctx.pathGuard, new UndoJournal(64 * MIB).beginCapture())`,
see `__tests__/core-fs.test.ts:612-618`) and counts calls to `readSaved` with
`t.mock.method(fs, 'readSaved')` (the mock wraps and calls through).

**Verify**: the count is 1 at the planned commit. If it is 0, the premise is
wrong: STOP.

Time ten such rewrites with and without a capture and record both medians.
If the capture adds less than 10% to the wall time, mark the plan
`REJECTED: measured saving below 10%` with the numbers and stop.

### Step 2: Failing tests

1. **No second read**: after the rewrite, `readSaved` was called 0 times,
   and the capture's records contain one `write` record whose `bytes` equal
   the file's original bytes exactly (compare Buffers, include a file with a
   BOM and CRLF endings so the exact-bytes requirement is exercised).
2. **Undo still restores**: add the capture to a journal, run the journal's
   restore the way an existing undo test does (find one with
   `grep -n "journal.add(" __tests__/core-fs.test.ts __tests__/undo.test.ts | head`),
   and assert the file is byte-identical to the original.
3. **Changed file falls back**: call `fs.writeFile(path, 'new', { previous: { bytes: Buffer.from('stale'), stats: <stats of a different file> } })`
   directly. Assert `readSaved` was called once and the saved bytes are the
   file's real bytes, not `stale`.

**Verify**: test 1 FAILS; tests 2 and 3 fail to compile until Step 3 (that is
expected; make them compile-ready by landing the type change first if you
prefer).

### Step 3: Implement the design

Apply the five design points in this order: `saveOld` parameter →
`writeFile` option and the stat comparison in `#writeValid` → `readNamedText`
result → `apply` and its two callers. Keep the existing comment style: one
line, saying why.

The comparison helper belongs next to `hardLinkKey` in `fs.ts`:

```ts
/** True when `now` is still the file `then` described: same inode, size and write time. */
const unchangedSince = (then: Stats, now: Stats): boolean =>
  then.dev === now.dev &&
  then.ino === now.ino &&
  then.size === now.size &&
  then.mtimeMs === now.mtimeMs;
```

**Verify**: `npm run build` → exit 0; the "Rewrite", "Undo" and "Tools"
commands → all pass.

### Step 4: Full check

**Verify**: `npm run check` → exit 0. Repeat Step 1's timing and report both
medians.

## Test plan

Three tests in `__tests__/rewrite.test.ts` (Step 2), plus the unchanged undo
and tool suites as regression cover.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `readSaved` is called 0 times for an undoable rewrite of an unchanged file, 1 time when `previous` does not match
- [ ] Undo of a rewrite restores byte-identical content (BOM and CRLF case included)
- [ ] Before/after timing recorded in the report
- [ ] `plans/README.md` status row updated

## STOP conditions

- `readText` does not return the file's exact on-disk bytes in
  `verdict.bytes` (for example it strips a BOM before returning). Check
  `src/core/fs.ts:1807-1870` first.
- The contract snapshot or any tool's structured output changes.
- An undo test fails after Step 3 and the cause is not obvious within two
  attempts.
- A Rewrite path writes a file different from the one it read (the read's
  `validPath` differs from the path `writeFile` resolves). Report it; that
  is a known, separate concern (the Rewrite ignores the target
  `lockForWrite` resolved).

## Maintenance notes

- `mtimeMs` equality is the weakest of the four checks: a same-size rewrite
  by an outside process within the timestamp resolution passes. The window
  is the time between the Rewrite's read and its write, under the server's
  own lock; undo would then restore the Rewrite's view of the old bytes,
  which is also what the user saw in the diff. Reviewer: confirm that
  trade-off is acceptable.
- On Linux the skipped `readSaved` was also a second descriptor re-check
  (see plan 104). The first read performed the same check, so no detection
  is lost for the bytes; the write itself has no re-check either way.
