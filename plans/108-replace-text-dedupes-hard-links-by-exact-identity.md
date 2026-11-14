# Plan 108: `replace_text` tells hard-linked files apart by exact file identity

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/tools/replace-text.ts src/core/fs.ts src/core/undo.ts __tests__/replace-text.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

When `replace_text` walks a folder it skips a file whose inode it already
handled, so two names for one hard-linked file are rewritten once. The key is
built from `stats.dev` and `stats.ino` as JavaScript numbers. On NTFS a file
ID is a 64-bit value that often exceeds 2^53; as a number it loses its low
bits, so two _different_ hard-linked files can produce the same key. The
second file is then skipped silently: no match, no skip count, no failure.
The caller is told the replacement landed everywhere when it did not.

The repo already knows this: `src/core/undo.ts:31-35` says "as a number an
NTFS file ID loses its low bits ... siblings a batch call made could read as
one file", and undo uses bigint identities for that reason. Trees where many
files are hard-linked are common (pnpm links `node_modules` from its store).

## Current state

`src/tools/replace-text.ts:212-219`, inside the `rewriteEntry` transform:

```ts
      async (bytes, stats, open) => {
        // Hard links share one inode, so a write through one name is seen by every
        // other name: a second name would transform the same bytes again.
        if (stats.nlink > 1) {
          const id = `${stats.dev}:${stats.ino}`;
          if (ctx.linked.has(id)) return undefined;
          ctx.linked.add(id);
        }
```

`ctx.linked` is declared at `:186-187`:

```ts
/** `dev:ino` of each multi-link file already claimed this run: a later name for it is skipped. */
linked: Set<string>;
```

`stats` is the number-typed `Stats` from `GuardedFileSystem.readText`
(`handle.stat()`), passed through `rewriteEntry` in `src/core/rewrite.ts:87`.

`GuardedFileSystem` already has a guarded bigint stat at
`src/core/fs.ts:639`: `return { stats: await fsLstat(validPath, { bigint: true }), validPath };`
Read the method that contains that line (about lines 625-640) to learn its
name, its parameter and what it validates.

`src/core/undo.ts:71-79`:

```ts
export const identityOf = (s: BigIntStats): FileIdentity => ({
  dev: s.dev,
  ino: s.ino,
  birthtimeNs: s.birthtimeNs,
});
// ...
const identityKey = (i: FileIdentity): string =>
  `${String(i.dev)}:${String(i.ino)}:${String(i.birthtimeNs)}`;
```

Project rule (CONTRIBUTING.md): tools read and write through the guarded
filesystem, never through `node:fs` directly.

Existing test: `__tests__/replace-text.test.ts:291`, "transforms a
hard-linked file once per run, dry run and live alike".

## Commands you will need

| Purpose       | Command                                                           | Expected on success |
| :------------ | :---------------------------------------------------------------- | :------------------ |
| One test file | `node --test --test-timeout=60000 __tests__/replace-text.test.ts` | all pass            |
| Full check    | `npm run check`                                                   | exit 0              |

## Scope

**In scope**:

- `src/tools/replace-text.ts` (the dedupe block and the `linked` comment)
- `src/core/fs.ts` only if the bigint stat method needs a one-line public
  wrapper (see Step 1)
- `__tests__/replace-text.test.ts`
- `CHANGELOG.md`, `plans/README.md`

**Out of scope**:

- `hardLinkKey` in `src/core/fs.ts:233`: it keys a lock, where a false
  collision only serializes two writes. Leave it.
- `identityOf`/`sameIdentity` in `src/core/fs.ts:2188-2213` (approval
  identity; its number form is a documented decision in the comment above it).
- `src/core/rewrite.ts`.

## Git workflow

- Branch: `fix/replace-text-exact-link-identity`
- One commit: `fix(replace_text): dedupe hard links by exact file identity`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Find the guarded bigint stat

Open `src/core/fs.ts` around line 625-640. Note the public method that
returns `{ stats: BigIntStats, validPath }`. If it is public and takes a
requested path, use it as is. If it is private (`#name`), add nothing new to
`fs.ts`; instead STOP and report the method's signature.

**Verify**: `grep -n "bigint: true" src/core/fs.ts` → line 639 is inside a
method whose name you have written down.

### Step 2: Key the dedupe on bigint dev and ino

Replace the block shown in "Current state" with (use the method name from
Step 1 in place of `EXACT_STAT`):

```ts
// Hard links share one inode, so a write through one name is seen by every
// other name: a second name would transform the same bytes again.
if (stats.nlink > 1) {
  // Exact (bigint): as a number an NTFS file id loses its low bits, and two files would read as one.
  const exact = (await ctx.fs.EXACT_STAT(entryPath)).stats;
  const id = `${String(exact.dev)}:${String(exact.ino)}`;
  if (ctx.linked.has(id)) return undefined;
  ctx.linked.add(id);
}
```

Only files with `nlink > 1` pay the extra stat. Do not include
`birthtimeNs` in the key: two names of one inode share it, so it adds nothing.

**Verify**: `npm run build` → exit 0.

### Step 3: Tests

1. `node --test --test-timeout=60000 __tests__/replace-text.test.ts` → the
   existing hard-link test still passes (true duplicates are still deduped).
2. Add a test after it: create two different files `a.txt` and `c.txt`, each
   containing `x\n`, hard-link each one to a second name (`b.txt`, `d.txt`;
   skip the test with `t.skip` when `link()` throws, as the existing test
   does). Run `replace` over the folder with `searchPattern: 'x'`,
   `replacement: 'xx'`. Assert `totalMatches === 2` and that all four names
   read `xx\n`. This pins "two inodes, two rewrites"; it cannot force a
   number collision, and that is accepted.

**Verify**: `node --test --test-timeout=60000 __tests__/replace-text.test.ts` → all pass.

### Step 4: Changelog and full check

Under `## [Unreleased]` → `### Fixed`:

```md
- **replace_text**: two different hard-linked files are no longer taken for one file on NTFS, where file ids exceed what a number holds; before, the second file could be skipped without being counted.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- Existing hard-link test (unchanged) plus the two-inode test from Step 3.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n '\${stats.dev}:\${stats.ino}' src/tools/replace-text.ts` returns nothing
- [ ] `git diff --stat` lists only in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

- The bigint stat method in `fs.ts` is private, or it validates for a
  different operation than reading an existing file (for example it is the
  delete-path guard).
- The extra stat throws for a file the Rewrite just read (it should not; if
  it does, report the error instead of catching it).

## Maintenance notes

- If `readText` later returns bigint stats, drop the extra stat and build the
  key from those.
- A dry run takes the same code path, so its counts match the live run.
