# Plan 034: The atomic-write temp file is created with the target's mode from the start

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/fs.ts __tests__/core-fs.test.ts`
> If `fs.ts:99-110` changed, compare against the excerpt before proceeding;
> on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security (hardening)
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

Every server-side write (`create`, `edit`, `patch`, `replace_text`) goes
through `atomicWriteFile`: write a temp file next to the target, `chmod` it
to the target's existing mode, `rename` it over the target. The temp file is
created by `writeFile` with the default `0o666 & ~umask` — typically `0644` —
and only **afterwards** narrowed to, say, `0600`. On a multi-user POSIX host
the new contents of a private file are group/world readable for the duration
of the write, and a temp file left behind by a crash keeps the wide mode.

`fs.promises.writeFile` accepts `mode` and `flag`; passing the target's mode
(and `wx`, so an unexpected existing temp name is an error rather than an
overwrite) closes the window. The `chmod` stays: `mode` on create is masked
by the umask, and the explicit `chmod` is what restores bits the umask
removed.

## Current state

```ts
// src/core/fs.ts:78-110 (atomicWriteFile, middle)
  const tempSuffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tempPath = `${validPath}.${tempSuffix}.tmp`;

  // The rename below swaps in the temp file's inode, so the target would
  // inherit fsWriteFile's default 0o666 & ~umask — silently widening a 0600
  // file to 0644 on every write. Carry the existing mode across instead.
  let existingMode: number | undefined;
  try {
    existingMode = (await fsStat(validPath)).mode & 0o777;
  } catch (error) {
    // ENOENT is the normal new-file case: the default mode is correct there.
    …
  }

  try {
    signal?.throwIfAborted();
    await fsWriteFile(tempPath, content, { encoding, signal });
    if (existingMode !== undefined) {
      await fsChmod(tempPath, existingMode);
    }
    // Last cancellation point. The rename IS the commit: …
    signal?.throwIfAborted();
    await fsRename(tempPath, validPath);
```

Existing POSIX-only mode test to mirror: `TC-FUNC-049`
(`__tests__/core-fs.test.ts:224-244`) — skips on win32 with
`t.skip('POSIX-only inode/mode assertions')`, `chmod(filePath, 0o600)`, then
asserts `after.mode & 0o777 === 0o600`. A sibling test for `writeFile`
keeping the mode across the rename exists in the same block (`TC-FUNC-047`
or `048`; find it with `grep -n "0o600" __tests__/core-fs.test.ts`).

## Commands you will need

| Purpose      | Command                                 | Expected on success |
| ------------ | --------------------------------------- | ------------------- |
| Static check | `npm run check:static`                  | exit 0              |
| All tests    | `npm test`                              | all pass            |
| Core fs      | `node --test __tests__/core-fs.test.ts` | all pass            |
| Format       | `npx prettier --write src/core/fs.ts`   | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/fs.ts` — the one `fsWriteFile` call in `atomicWriteFile`
- `plans/README.md` (status row)

**Out of scope**: `appendFile` (no temp file); the `chmod` (must stay); the
temp-file naming; Windows behavior (`mode` is ignored there beyond the
read-only bit).

## Git workflow

- Branch: `advisor/034-atomic-write-temp-mode`.
- One commit: `fix(fs): create the atomic-write temp file with the target's mode`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pass the mode at creation

In `src/core/fs.ts`, change

```ts
await fsWriteFile(tempPath, content, { encoding, signal });
```

to

```ts
// Create the temp file already narrowed to the target's mode: a 0600
// file's new bytes must never sit at 0644 while the write is in flight.
// `wx` fails on a name collision instead of overwriting; the chmod below
// still restores bits the umask masked off at creation.
await fsWriteFile(tempPath, content, {
  encoding,
  signal,
  flag: 'wx',
  ...(existingMode !== undefined ? { mode: existingMode } : {}),
});
```

Run `npx prettier --write src/core/fs.ts`.

**Verify**: `node --test __tests__/core-fs.test.ts` → all pass (the
mode-preservation and abort-mid-write tests, `TC-FUNC-047…054`).

### Step 2: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- No new test: the widened-mode window is not observable after the call
  returns, and the final mode is already pinned by the existing POSIX test
  (`grep -n "0o600" __tests__/core-fs.test.ts`).
- Existing: the whole `core-fs.test.ts` write block, plus every `create` /
  `edit` / `replace_text` test in `tools.test.ts`.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "flag: 'wx'" src/core/fs.ts` prints one line inside `atomicWriteFile`
- [ ] `git status` shows changes only in `src/core/fs.ts` and `plans/README.md`
- [ ] `plans/README.md` status row for 034 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any `core-fs.test.ts` test fails after Step 1 — in particular the
  abort-mid-write test (`TC-FUNC-05x`), which must still see the temp file
  unlinked on cancellation.
- The project's `exactOptionalPropertyTypes` rejects the spread form — use
  two separate `fsWriteFile` calls under an `if` rather than `mode: undefined`.

## Maintenance notes

- Reviewer focus: the `chmod` after the write is unchanged. Removing it would
  reintroduce the umask problem the original comment describes.
- If a `--umask`-style option is ever added, this is the one call site that
  needs it.
