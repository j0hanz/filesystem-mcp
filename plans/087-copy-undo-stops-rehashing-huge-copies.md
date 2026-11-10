# Plan 087: Undo capture for a copy gives up before re-reading a huge copy

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat d799cc5e..HEAD -- src/core/undo.ts __tests__/undo.test.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (very large copies lose their undo id; writes and deletes already behave this way)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `d799cc5e`, 2026-11-10

## Why this matters

After a copy, the undo capture opens every copied file again and hashes it
with sha256, so a later undo can tell whether the copy was edited since. A new
file is charged only a flat 512 bytes against the undo budget, so the budget
never limits how many bytes get hashed. A copy of a 4 GiB file therefore reads
4 GiB twice (once to copy, once to hash), and the hash cannot be cancelled:
the copy path takes no abort signal. The call does not return until the hash
is done.

After this plan, a copy whose files total more than eight times the undo
budget (256 MiB at the default 32 MiB budget) is marked "too large to keep for
undo" while planning, before the copy, and nothing is hashed. The copy itself
still runs.

## Current state

Files:

- `src/core/undo.ts`: the undo journal and capture. `planCopyUndo` (line 566)
  walks the source before the copy; `recordCopyUndo` (line 629) hashes after.
- `__tests__/undo.test.ts`: copy-undo tests at lines 406-660.

`src/core/undo.ts:245-256`:

```ts
/** What a mutation holds for its path while `UndoCapture.forMutation` runs it. */
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
```

`NOT_RECORDING` (line 258) is an object literal of that interface.
`UndoCapture implements PathCapture` (line 268) already has
`readonly maxBytes: number` (line 278), set from `UndoJournal`'s constructor
argument (`new UndoJournal(1600)` gives a 1600-byte budget).

`src/core/undo.ts:387-398`, the budget check and its abandon reason:

```ts
  reserve(n: number): boolean {
    if (this.#unavailable !== undefined) return false;
    const cost = n + RECORD_OVERHEAD_BYTES;
    // The budget is shared: every live capture's charge counts.
    if (this.#pool.bytes + cost > this.maxBytes) {
      this.abandon('too large to keep for undo');
      return false;
    }
```

`src/core/undo.ts:566-597`, the file branch of the planning walk:

```ts
export async function planCopyUndo(
  capture: PathCapture,
  fs: GuardedFileSystem,
  validSource: string,
  validDest: string,
): Promise<CopyTarget[]> {
  const targets: CopyTarget[] = [];
  const walk = async (source: string, dest: string, destAbsent: boolean): Promise<void> => {
    if (fs.pathGuard.isSensitive(dest)) {
      capture.abandon('contains protected files');
      return;
    }
    const src = await fsLstat(source, { bigint: true });
    const existing = destAbsent ? undefined : await unlessMissing(fsLstat(dest, { bigint: true }));
    if (src.isSymbolicLink()) {
      // shortcut: no record removes a link a call created; add one if clients copy trees with links
      capture.abandon('copied links are not undoable');
    } else if (src.isFile()) {
      if (existing === undefined) {
        // Charged now, so a huge new tree stops here instead of after the copy.
        if (!capture.reserve(0)) return;
        targets.push({ kind: 'new-file', path: dest });
      } else if (existing.isFile() && existing.nlink > 1n) {
```

`src/core/undo.ts:635-647`, the hash after the copy:

```ts
    for (const target of targets) {
      // Once undo gave up, hashing the rest would only re-read files for nothing.
      if (capture.unavailableReason() !== undefined) return;
      if (target.kind === 'new-dir') {
        capture.push({ op: 'rmdir', path: target.path });
      } else {
        const expect = await hashFile(fs, target.path);
```

`__tests__/undo.test.ts:478-497`, the test to model the new one on. It counts
hashes by wrapping `fs.open`:

```ts
it('a copy past the record budget gives up while planning, before any hash', async () => {
  const src = join(tmpDir, 'cph-src');
  const dest = join(tmpDir, 'cph-dest');
  await mkdir(src, { recursive: true });
  for (let i = 0; i < 6; i++) await writeFile(join(src, `f${i}.txt`), String(i));
  // rmdir + 2 removes = 1536 bytes; a third remove would make 2048.
  const cap = new UndoJournal(1600).beginCapture();
  const fs = makeFs(cap);
  let hashed = 0;
  const open = fs.open.bind(fs);
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    if (args[0].includes('cph-dest')) hashed++;
    return open(...args);
  };
  await copyVia(fs, src, dest);
  assert.match(cap.unavailableReason() ?? '', /: too large to keep for undo$/u);
  assert.strictEqual(hashed, 0, `hashed ${String(hashed)} files after undo gave up`);
  assert.strictEqual(await readFile(join(dest, 'f5.txt'), 'utf8'), '5');
  cap.release();
});
```

`makeFs`, `copyVia` and `capture` are already defined or imported in that
`describe('UndoCapture via GuardedFileSystem', …)` block (lines 237-238, and
`copyVia` in the import list at line 42).

Conventions: comments say why, in one or two lines. A known limit is written
as `// shortcut: <the limit>, <when to upgrade>`. Commit messages are
Conventional Commits, for example
`perf(core): chunk case-insensitive literal pre-filtering to prevent memory spikes`.

## Commands you will need

| Purpose    | Command                                                   | Expected on success |
| :--------- | :-------------------------------------------------------- | :------------------ |
| Install    | `npm ci`                                                  | exit 0              |
| Undo tests | `node --test --test-timeout=60000 __tests__/undo.test.ts` | all pass            |
| Full check | `npm run check`                                           | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/undo.ts`: the `PathCapture` interface, `NOT_RECORDING`, a new
  constant, and `planCopyUndo`.
- `__tests__/undo.test.ts`
- `CHANGELOG.md` (one bullet under `## [Unreleased]` then `### Changed`; create
  the `### Changed` heading under `[Unreleased]` if it is missing)
- `docs/client-guide.md`: only if it lists the `undoUnavailable` reasons one
  by one; see step 4.
- `plans/README.md` (your status row)

**Out of scope** (do NOT touch):

- `src/core/fs.ts` `#copy` and `#copyValid`: threading an abort signal through
  the copy is a separate change.
- `recordCopyUndo` and `hashFile`: with the cap in planning, they never see an
  over-cap copy.
- `reserve`: do not charge copied bytes to the shared budget. The budget
  counts bytes held in memory, and a `remove` record holds none.
- `saveOld` and the handling of replaced files' old bytes.

## Git workflow

- Branch: `advisor/087-copy-undo-hash-cap` from `main`.
- One commit, for example
  `perf(core): give up copy undo before re-hashing a huge copy`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing test

In `__tests__/undo.test.ts`, right after the test
`'a copy past the record budget gives up while planning, before any hash'`,
add:

`it('a copy with more bytes than undo will re-read gives up while planning, before any hash', …)`

- `src = join(tmpDir, 'cpx-src.txt')`, `dest = join(tmpDir, 'cpx-dest.txt')`.
- Write 40,000 bytes to `src`: `await writeFile(src, 'x'.repeat(40_000))`.
- `const cap = new UndoJournal(4096).beginCapture();` (8 × 4096 = 32,768, so
  40,000 bytes is over the cap, while the flat 512-byte record charge fits the
  4096 budget).
- Wrap `fs.open` exactly as the model test does, counting opens whose path
  includes `'cpx-dest'`.
- `await copyVia(fs, src, dest);`
- Assert `cap.unavailableReason()` matches `/: too large to keep for undo$/u`,
  `hashed === 0`, and `(await readFile(dest, 'utf8')).length === 40_000`.
- `cap.release();`

**Verify**: `node --test --test-timeout=60000 __tests__/undo.test.ts` → the new
test FAILS (`unavailableReason()` is `undefined`); all others pass.

### Step 2: Cap the bytes a copy's undo will re-read

In `src/core/undo.ts`:

1. Add to the `PathCapture` interface:

   ```ts
   /** The undo byte budget this capture charges against. */
   readonly maxBytes: number;
   ```

   and add `maxBytes: 0,` to the `NOT_RECORDING` object literal.

2. Near `RECORD_OVERHEAD_BYTES` (line 102), add:

   ```ts
   // Copied files are hashed after the copy, a second full read. Past this many
   // budgets' worth, undo is not worth that read: 256 MiB at the default 32 MiB.
   const COPY_HASH_BUDGETS = 8;
   ```

3. In `planCopyUndo`, declare `let hashBytes = 0;` next to `const targets`.
   In the `src.isFile()` branch, before the `if (existing === undefined)`
   line, add:

   ```ts
   // Every copied file is re-read to hash it; stop before the copy, not after.
   hashBytes += Number(src.size);
   if (hashBytes > capture.maxBytes * COPY_HASH_BUDGETS) {
     capture.abandon('too large to keep for undo');
     return;
   }
   ```

   Indent it to match the surrounding block. Change nothing else in the walk.

**Verify**: `node --test --test-timeout=60000 __tests__/undo.test.ts` → all
pass, including the new test and the two existing budget tests
(`'a copy past the record budget gives up while planning, before any hash'`
and `'copy over a file past the budget still copies'`).

### Step 3: Type check

**Verify**: `npm run check:static` → exit 0. If the type checker reports an
object that implements `PathCapture` without `maxBytes` (a test double, for
example), add `maxBytes` to that object with the value its journal uses, or
`0` for a non-recording double. If more than three such sites exist, STOP.

### Step 4: Docs and changelog

Run `grep -n "too large to keep" README.md docs/*.md`. If a doc lists the
reasons undo can be unavailable, add nothing new (the reason text is
unchanged). If a doc states that copies of any size are undoable, STOP and
report the line.

In `CHANGELOG.md`, under `## [Unreleased]` then `### Changed`, add:

```md
- **Undo**: a copy whose files total more than eight times the undo budget (256 MiB by default) no longer gets an undo id; before, every copied byte was read a second time to hash it. The copy itself is unaffected.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- One new test in `__tests__/undo.test.ts`, described in step 1: the copy
  lands, undo reports "too large to keep for undo", and no copied file is
  opened for hashing.
- Pattern: `__tests__/undo.test.ts:478-497`.
- Verification: `npm run check` → exit 0.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "COPY_HASH_BUDGETS" src/core/undo.ts` shows the constant and one use
- [ ] The new test exists and passes
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- Any existing copy-undo test (`__tests__/undo.test.ts:406-660`, `:3016`,
  `:3801`) fails after step 2. They copy a few bytes each and must stay under
  the cap.
- `capture.maxBytes` is `0` for a recording capture in any test. That would
  make every copy over-cap.
- More than three objects need `maxBytes` added in step 3.

## Maintenance notes

- The factor 8 is a judgment: sha256 over 256 MiB costs well under a second of
  CPU plus one sequential read. If users ask for undo on larger copies, raise
  the factor; if they report slow copies under the cap, thread the call's
  abort signal through `#copy` into `hashFile` (it already accepts one).
- The cap follows `--max-undo-bytes` style configuration through
  `capture.maxBytes`: a server with undo disabled never reaches this code,
  because `own.recording` is false.
- The serial `lstat` walk in `planCopyUndo` is untouched; it costs two
  syscalls per entry and was not measured as a problem.
