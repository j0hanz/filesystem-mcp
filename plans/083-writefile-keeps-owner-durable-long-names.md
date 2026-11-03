# Plan 083: Make atomic writes keep the owner, reach the disk, and handle long names

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5ebbd489..HEAD -- src/core/fs.ts __tests__/core-fs.test.ts CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `5ebbd489`, 2026-11-03

## Why this matters

Every whole-file write (`create`, `edit`, `patch`, `replace_text`, and `undo`
restores) goes through one function: write a temp file, then rename it over the
target. That function has three separate gaps:

1. **The owner changes.** The new inode belongs to the server's user. A server
   running as root, for example in a container, turns a file owned by someone
   else into a root-owned file. With mode 0600, the original owner is locked out.
2. **A crash can lose the file.** The temp file is never flushed before the
   rename, so on some filesystems a power loss can leave the name pointing at
   missing data. The in-place branch of the same function already syncs.
3. **Long names cannot be written.** The temp name adds 17 characters to the
   file's own name. A file whose name is 239 or more characters exists on disk
   but cannot be edited. Reproduced on Windows on `5ebbd489`: names of 238
   characters work and 239 fail, with `NOT_FOUND`, a message naming a `.tmp` file
   the caller never asked about, and the advice to run `list`. Linux has the same
   limit in bytes (255); that was not run, and its error code will differ.

## Current state

- `src/core/fs.ts` — `GuardedFileSystem.writeFile` at lines 681-793 is the one
  temp-and-rename write.
- `__tests__/core-fs.test.ts` — its tests. Uses `t.mock.method(fsPromises, ...)`
  with `syncBuiltinESMExports()`, as at lines 79-93.

`src/core/fs.ts:689-690`, the temp name:

```ts
const tempSuffix = randomUUID().replace(/-/g, '').slice(0, 12);
const tempPath = `${validPath}.${tempSuffix}.tmp`;
```

`src/core/fs.ts:751-771`, the rename branch:

```ts
    } else {
      try {
        signal?.throwIfAborted();
        // Create the temp file already narrowed to the target's mode: a 0600
        // file's new bytes must never sit at 0644 while the write is in flight.
        // `wx` fails on a name collision instead of overwriting; the chmod below
        // still restores bits the umask masked off at creation.
        await fsWriteFile(tempPath, content, {
          signal,
          flag: 'wx',
          ...(mode !== undefined ? { mode } : {}),
        });
        if (mode !== undefined) {
          await fsChmod(tempPath, mode);
        }
        // Last cancellation point. The rename IS the commit: once it starts the
        // target may already be replaced, so it is never raced against the
        // signal — a withAbort race would report a finished write as failed, and
        // a client retry would apply it twice (same reasoning as appendFile).
        signal?.throwIfAborted();
        await fsRename(tempPath, validPath);
```

`existingStats` (`Stats | undefined`) is set earlier in the same function at
line 703, from `fsStat(validPath)`.

Facts to rely on:

- `fs.promises.writeFile` accepts `flush: true` in every Node version this
  project supports (`engines.node` is `>=24`).
- `process.getuid` and `process.getgid` are `undefined` on Windows, and Windows
  file stats report `uid` and `gid` as 0.
- Only root can give a file to another user. A non-root process gets `EPERM`.
  It may still set a group it belongs to.
- Windows allows 255 UTF-16 units per name component; Linux and macOS allow 255
  bytes. A UTF-8 byte count is never below the UTF-16 unit count, so it is the
  safe measure on all three.

Conventions:

- A known limit gets a comment in this form: `// shortcut: <the limit>, <when to upgrade>`.
  See `src/core/fs.ts:564` and `:734`.
- Comments state the why. Keep every existing comment you do not need to change.
- `src/core/fs.ts:1291` `crossDeviceStagingPath` is the precedent for an exported
  helper that exists for one internal use and its tests. Knip's entries include
  the test files, so test-only use counts as use.
- `Logger.debug` is available from `./observability.ts`, already imported in
  `fs.ts`; check its signature at `src/core/observability.ts:98`.

## Commands you will need

| Purpose       | Command                                           | Expected on success |
| ------------- | ------------------------------------------------- | ------------------- |
| One test file | `node --test __tests__/core-fs.test.ts`           | all pass            |
| Full check    | `npm run check`                                   | exit 0              |
| Graph update  | `graphify update .` (project rule after any edit) | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/fs.ts`
- `__tests__/core-fs.test.ts`
- `CHANGELOG.md` (the `[Unreleased]` section)
- `graphify-out/` (only what `graphify update .` rewrites)

**Out of scope** (do NOT touch, even though they look related):

- The in-place branch at `src/core/fs.ts:733-750` — it keeps the inode, so it
  keeps the owner, and it already syncs.
- `appendFile` — it keeps the inode.
- `crossDeviceStagingPath` — it creates a directory beside the target and keeps
  the name as is, so it has no suffix problem.
- A directory fsync after the rename. Losing the rename leaves the old content,
  not lost data. See Maintenance notes.
- Copying POSIX ACLs, extended attributes or Windows ACLs. See Maintenance notes.
- A setting to turn the flush off.

## Git workflow

- Branch: `advisor/083-writefile-keeps-owner-durable-long-names`
- Commit per step, Conventional Commits, as in `git log`:
  `fix(search): keep the pattern hint beside a binary skip`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix long names

In `src/core/fs.ts`, add these near the other module constants (after
`LINE_COUNT_CHUNK_BYTES`):

```ts
/** A name component's limit: bytes on Linux and macOS, UTF-16 units on Windows, and bytes are never fewer. */
const MAX_NAME_BYTES = 255;
/** `.` + 12 hex + `.tmp`, the part a temp file adds to the name it sits beside. */
const TEMP_SUFFIX_BYTES = 17;
```

Add this exported function directly above `crossDeviceStagingPath`:

```ts
/**
 * Where `writeFile` stages new bytes: beside the target, in the same directory,
 * so the rename stays on one device. The target's own name is kept when it fits,
 * since it says what the file is if a crash leaves it behind. A name too long to
 * take the suffix gets a short one, or a file that exists could not be rewritten.
 */
export function atomicTempPath(validPath: string, suffix: string): string {
  const name = basename(validPath);
  return Buffer.byteLength(name, 'utf8') + TEMP_SUFFIX_BYTES <= MAX_NAME_BYTES
    ? `${validPath}.${suffix}.tmp`
    : join(dirname(validPath), `.${suffix}.tmp`);
}
```

In `writeFile`, change the `tempPath` line to:

```ts
const tempPath = atomicTempPath(validPath, tempSuffix);
```

Add these tests in `__tests__/core-fs.test.ts`, in the same describe block as
`TC-FUNC-049`, using that block's `tmpDir` and `fs`. Add `atomicTempPath` to the
existing import from `../src/core/fs.ts`.

```ts
it('atomicTempPath keeps the name while it fits, and shortens it when not', () => {
  const dir = join(tmpDir, 'd');
  assert.strictEqual(atomicTempPath(join(dir, 'a.txt'), 'abc'), join(dir, 'a.txt.abc.tmp'));
  const fits = `${'n'.repeat(234)}.txt`; // 238 bytes + 17 = 255
  assert.strictEqual(atomicTempPath(join(dir, fits), 'abc'), `${join(dir, fits)}.abc.tmp`);
  const over = `${'n'.repeat(235)}.txt`; // 239 bytes + 17 = 256
  assert.strictEqual(atomicTempPath(join(dir, over), 'abc'), join(dir, '.abc.tmp'));
  const wide = `${'é'.repeat(120)}.txt`; // 124 units, 244 bytes
  assert.strictEqual(atomicTempPath(join(dir, wide), 'abc'), join(dir, '.abc.tmp'));
});

it('writeFile replaces a file whose name leaves no room for the temp suffix', async () => {
  for (const name of [`${'n'.repeat(247)}.txt`, `${'é'.repeat(120)}.txt`]) {
    const filePath = await writeTestFile(tmpDir, name, 'old\n');
    await fs.writeFile(filePath, 'new\n');
    assert.strictEqual(await readFile(filePath, 'utf8'), 'new\n');
  }
  assert.deepStrictEqual(
    (await readdir(tmpDir)).filter((entry) => entry.endsWith('.tmp')),
    [],
  );
});
```

If the second test's `.tmp` check fails because an earlier test in the block
left a file in `tmpDir`, use a fresh subdirectory for this test.

**Verify**: `node --test --test-name-pattern="temp suffix|atomicTempPath" __tests__/core-fs.test.ts` → 2 pass.

### Step 2: Flush before the rename

Add `flush: true` to the `fsWriteFile` options in the rename branch, with a
comment:

```ts
await fsWriteFile(tempPath, content, {
  signal,
  flag: 'wx',
  // The rename publishes these bytes, so they must reach the disk first: a
  // crash in between could otherwise leave the name on an empty file.
  flush: true,
  ...(mode !== undefined ? { mode } : {}),
});
```

Add this test. `fsPromises`, `syncBuiltinESMExports` and `writeTestFile` are
already imported in that file.

```ts
it('writeFile flushes the temp file before renaming it', async (t) => {
  const filePath = await writeTestFile(tmpDir, 'flushed.txt', 'old\n');
  const writes = t.mock.method(fsPromises, 'writeFile');
  syncBuiltinESMExports();
  try {
    await fs.writeFile(filePath, 'new\n');
  } finally {
    writes.mock.restore();
    syncBuiltinESMExports();
  }
  const options = writes.mock.calls.at(-1)?.arguments[2] as { flush?: boolean } | undefined;
  assert.strictEqual(options?.flush, true);
});
```

**Verify**: `node --test --test-name-pattern="flushes" __tests__/core-fs.test.ts` → 1 passes.

Then compare suite time with the earlier baseline of about 30 s:

**Verify**: `npm test` → all pass, with the reported `duration_ms` below 60000.

### Step 3: Keep the owner

Add `chown as fsChown` to the `node:fs/promises` import at the top of
`src/core/fs.ts`, in alphabetical position.

Add this exported function directly above `atomicTempPath`:

```ts
/**
 * Give a temp file the owner of the file it will replace: the rename swaps in a
 * new inode, which otherwise belongs to whoever runs the server. Best effort,
 * because only root can give a file away, and a refused write would be worse
 * than a changed owner. POSIX only: Windows has no `process.getuid`.
 * shortcut: POSIX ACLs, extended attributes and Windows ACLs are still lost; copy them if a client reports it.
 */
export async function keepOwner(
  tempPath: string,
  existing: Pick<Stats, 'uid' | 'gid'> | undefined,
  chown: typeof fsChown = fsChown,
): Promise<void> {
  if (existing === undefined || process.getuid === undefined) return;
  if (existing.uid === process.getuid() && existing.gid === process.getgid?.()) return;
  try {
    await chown(tempPath, existing.uid, existing.gid);
  } catch (error) {
    Logger.debug(`Could not keep the owner of ${tempPath}: ${formatUnknownErrorMessage(error)}`);
  }
}
```

In `writeFile`, call it after the write and before the chmod, because a `chown`
can clear mode bits and the chmod restores them:

```ts
await keepOwner(tempPath, existingStats);
if (mode !== undefined) {
  await fsChmod(tempPath, mode);
}
```

Add these tests. Add `keepOwner` to the existing import from `../src/core/fs.ts`,
and add `chown` to the existing `node:fs/promises` import in that test file.

```ts
it('keepOwner calls chown only when the owner differs, and tolerates a refusal', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows has no process.getuid');
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const calls: [number, number][] = [];
  const record = ((_path: unknown, u: number, g: number) => {
    calls.push([u, g]);
    return Promise.resolve();
  }) as never;

  await keepOwner('t', { uid, gid }, record);
  assert.deepStrictEqual(calls, []);
  await keepOwner('t', undefined, record);
  assert.deepStrictEqual(calls, []);

  await keepOwner('t', { uid: uid + 1, gid }, record);
  assert.deepStrictEqual(calls, [[uid + 1, gid]]);

  const refuse = (() =>
    Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' }))) as never;
  await keepOwner('t', { uid: uid + 1, gid }, refuse);
});

it('writeFile keeps the owner of a file another user owns', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() !== 0) {
    return t.skip('needs root on POSIX to create a file another user owns');
  }
  const filePath = await writeTestFile(tmpDir, 'owned.txt', 'old\n');
  await chown(filePath, 1234, 1234);
  await fs.writeFile(filePath, 'new\n');
  const after = await stat(filePath);
  assert.strictEqual(after.uid, 1234);
  assert.strictEqual(after.gid, 1234);
});
```

**Verify**: `node --test --test-name-pattern="keepOwner|keeps the owner" __tests__/core-fs.test.ts` → pass on POSIX. On Windows both report as skipped. Without root, the second reports as skipped.

Note in your final report that the real-owner test does not run in CI, because
CI is not root. If you can run as root on Linux, run it there and report the result:

```bash
sudo node --test --test-name-pattern="keeps the owner" __tests__/core-fs.test.ts
```

### Step 4: Record the change

In `CHANGELOG.md` under `## [Unreleased]`, add a `### Fixed` heading if there is
none, placed after `### Changed`, with these bullets:

```markdown
- **Writes keep a file's owner where the server is allowed to.** A write replaces the file with a new one, which belonged to the server's user. A server running as root turned other users' files into root's, locking them out of a 0600 file. It now restores the owner and group when it can. POSIX ACLs, extended attributes and Windows ACLs are still not carried over.
- **Writes reach the disk before they replace a file.** New content is flushed before the rename, so a crash cannot leave the name on an empty file. Large `replace_text` runs may take a little longer.
- **Files with very long names can be rewritten.** A name of 239 or more characters left no room for the temporary name, so `edit`, `patch`, `replace_text` and an overwrite failed on a file that exists, with an error naming a file the caller never asked about.
```

**Verify**: `npx prettier --check CHANGELOG.md` → exit 0.

### Step 5: Full check

Run `npm run check`, then `graphify update .`.

**Verify**: `npm run check` → exit 0.

## Test plan

Tests in `__tests__/core-fs.test.ts`, all given above, modelled on `TC-FUNC-049`:

| Case                                        | Pins                        |
| :------------------------------------------ | :-------------------------- |
| `atomicTempPath` at 238 and 239 bytes, wide | The boundary, in bytes      |
| Rewrite of a 251-byte and a 244-byte name   | The reported failure        |
| `writeFile` passes `flush: true`            | Durability option stays set |
| `keepOwner` same, none, different, refused  | Best-effort logic           |
| Real owner kept, root only                  | The actual outcome          |

Existing tests that must keep passing unchanged: the 0600 mode tests and the
undo tests in `__tests__/undo.test.ts`, because undo restores through `writeFile`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `node --test __tests__/core-fs.test.ts` exits 0, including the new tests
- [ ] `npm test` reports `duration_ms` below 60000
- [ ] `grep -n "flush: true" src/core/fs.ts` shows the write in `writeFile`
- [ ] `grep -n "keepOwner(tempPath, existingStats)" src/core/fs.ts` shows one call before `fsChmod(tempPath, mode)`
- [ ] `git status` shows only in-scope files modified
- [ ] The final report says whether the root-only test ran
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- `npm test` takes more than twice as long after Step 2. Report the before and
  after numbers rather than removing the flush.
- A test depends on the temp name's format and fails after Step 1.
- `flush: true` fails on any of the three platforms in CI.
- The type checker rejects `flush` on `fsWriteFile`, which would mean
  `@types/node` differs from what this plan assumed.
- A sensitive-file test fails after Step 1. A short temp name must not change
  what the denylist decides about the target, since the target was validated.

## Maintenance notes

- **Directory sync is deliberately absent.** Without it, a crash can undo the
  rename and leave the old content, which is safe. Add it only if a client needs
  a write to be durable the moment it returns.
- **ACLs and extended attributes are a known limit**, marked with a `shortcut:`
  comment. That includes SELinux labels and Windows ACLs set on the file itself.
- **Hidden temp names.** A long-named file's temp file starts with a dot. If a
  crash leaves one behind, `list` hides it by default.
- **Performance.** The flush adds one fsync per file. A large `replace_text` run
  is the case to watch. Reviewers should weigh the Step 2 timing.
- **A reviewer should confirm** that `keepOwner` runs before `fsChmod`, since a
  `chown` can clear setuid and setgid bits that the chmod must restore.
