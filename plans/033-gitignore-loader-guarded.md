# Plan 033: The `.gitignore` loader reads only regular files under a size cap

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/glob.ts __tests__/glob.test.ts`
> If `glob.ts:36-56` changed, compare against the excerpt before proceeding;
> on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security (hardening)
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

`list`, `find_files`, `search_text` and `replace_text` honor `.gitignore` by
default. The loader globs `**/.gitignore` under the walk root and reads each
hit with a raw `readFile` — no guard, no regular-file check, no size cap, and
up to 64 reads in flight. It follows symlinks. A `.gitignore` that is a
symlink to a device, a FIFO, or a multi-gigabyte file (possible in any
untrusted checkout on POSIX) is read whole into memory, or blocks a libuv
worker thread. The contents are only used as ignore rules and never returned,
so this is a robustness hole, not a data leak.

The fix is one `lstat` per hit: skip anything that is not a regular file and
anything over 1 MiB (a real `.gitignore` is a few KB).

## Current state

```ts
// src/core/glob.ts:1-2 (imports)
import { glob as fsGlob, readFile as fsReadFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
```

```ts
// src/core/glob.ts:36-56 (loadGitignoreFiles body)
await processInParallel(
  gitignorePaths,
  async (relPath) => {
    const absPath = join(root, relPath);
    try {
      const contents = await fsReadFile(absPath, { encoding: 'utf-8', signal });
      const matcher = ignore();
      matcher.add(contents);
      const dir = toPosixPath(dirname(relPath));
      manager.addMatcher(dir === '.' ? '' : dir, matcher);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      Logger.warn(`Failed to read .gitignore at ${absPath}: ${formatUnknownErrorMessage(error)}`);
    }
  },
  GLOB_BATCH_CONCURRENCY,
  signal,
);
```

`src/core/util.ts:7` exports `MIB`. Test conventions:
`__tests__/glob.test.ts` has a `walk(options)` helper that runs `globEntries`
and returns sorted root-relative POSIX paths; `createTestRoot`,
`cleanupTestRoot`, `trySymlink` come from `./helpers.ts` (`trySymlink(target, link, skip, type)`
returns `false` and calls `skip` when Windows forbids symlinks).

## Commands you will need

| Purpose      | Command                                                        | Expected on success |
| ------------ | -------------------------------------------------------------- | ------------------- |
| Static check | `npm run check:static`                                         | exit 0              |
| All tests    | `npm test`                                                     | all pass            |
| Glob tests   | `node --test __tests__/glob.test.ts`                           | all pass            |
| Format       | `npx prettier --write src/core/glob.ts __tests__/glob.test.ts` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/glob.ts` — `loadGitignoreFiles` and one import
- `__tests__/glob.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope**: ADR-001's single-flag rule (unchanged); which
`.gitignore` files are discovered (plan not selected: ancestor `.gitignore`
files); routing these reads through `PathGuard` (they never leave the root
except via a symlink, which `lstat` now excludes).

## Git workflow

- Branch: `advisor/033-gitignore-loader-guarded`.
- One commit: `fix(glob): read only regular .gitignore files under 1 MiB`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Regression test (it must fail now)

In `__tests__/glob.test.ts`, inside `describe('globEntries', …)`, add:

```ts
it('ignores a .gitignore that is a symlink or oversized', async (t) => {
  const root = await createTestRoot();
  const outside = await createTestRoot();
  try {
    await mkdir(join(root, 'linked'));
    await writeFile(join(root, 'linked', 'keep.txt'), 'x');
    await writeFile(join(outside, 'rules'), '*.txt\n');
    const linked = await trySymlink(
      join(outside, 'rules'),
      join(root, 'linked', '.gitignore'),
      () => t.diagnostic('symlink not permitted; symlink case skipped'),
      'file',
    );

    await mkdir(join(root, 'huge'));
    await writeFile(join(root, 'huge', 'keep.txt'), 'x');
    // 1 MiB of comment, then a rule: the rule must never take effect.
    await writeFile(join(root, 'huge', '.gitignore'), `${'#'.repeat(1024 * 1024)}\n*.txt\n`);

    const seen = await walk({ cwd: root, pattern: '**/*', skipIgnored: true, onlyFiles: true });
    assert.ok(seen.includes('huge/keep.txt'), 'an oversized .gitignore must be skipped');
    if (linked) {
      assert.ok(seen.includes('linked/keep.txt'), 'a symlinked .gitignore must be skipped');
    }
  } finally {
    await cleanupTestRoot(root);
    await cleanupTestRoot(outside);
  }
});
```

Add `trySymlink` to the `./helpers.ts` import in that file (`mkdir`,
`writeFile`, `join` are already imported; check `GlobEntriesOptions` for the
exact option names used by `walk` — `cwd`, `pattern`, `skipIgnored`,
`onlyFiles` are the ones the existing tests pass).

**Verify**: `node --test __tests__/glob.test.ts` → the new test **fails** on
`huge/keep.txt` (the oversized file's rule is applied). If it passes, STOP.

### Step 2: One `lstat` before each read

In `src/core/glob.ts`:

1. Change the first import to
   `import { glob as fsGlob, lstat, readFile as fsReadFile } from 'node:fs/promises';`
   and add `MIB` to the import from `'./util.ts'` (create that import if the
   file has none: `import { MIB } from './util.ts';`).
2. Add near the other module constants:

   ```ts
   /** A .gitignore past this size is not a .gitignore; skip it rather than read it. */
   const MAX_GITIGNORE_BYTES = MIB;
   ```

3. In `loadGitignoreFiles`, replace
   `const contents = await fsReadFile(absPath, { encoding: 'utf-8', signal });`
   with:

   ```ts
   // lstat, not stat: a symlinked .gitignore may point at a device, a
   // FIFO or a huge file outside the root. Only a plain, small file is a
   // rule set worth reading.
   const info = await lstat(absPath);
   if (!info.isFile() || info.size > MAX_GITIGNORE_BYTES) return;
   const contents = await fsReadFile(absPath, { encoding: 'utf-8', signal });
   ```

Run `npx prettier --write src/core/glob.ts __tests__/glob.test.ts`.

**Verify**: `node --test __tests__/glob.test.ts` → all pass.

### Step 3: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- New test: an oversized `.gitignore` is ignored; a symlinked one is ignored
  where symlinks can be created (skipped with a diagnostic otherwise).
- Existing: every `skipIgnored` walk test in `glob.test.ts` and the
  `find_files`/`search_text` gitignore tests in `tools.test.ts`.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "MAX_GITIGNORE_BYTES" src/core/glob.ts` prints the definition and one use
- [ ] `grep -n "lstat" src/core/glob.ts` prints the import and one call
- [ ] The new test exists and passes
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 033 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The regression test passes before Step 2.
- `glob.ts` already imports from `./util.ts` under a different binding style
  that prettier's import sorter rejects — report rather than reorder by hand.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If ancestor `.gitignore` loading is ever added (audit finding "ancestor
  `.gitignore` ignored in subdir walks"), route those reads through the same
  `lstat` gate.
- A skipped `.gitignore` is silent by design: a warn line per untrusted
  checkout would be noise; the walk just behaves as if the file were absent.
