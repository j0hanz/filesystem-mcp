# Plan 008: Directory walks survive a relative dirent from `fs.glob` (fixes `list` failing and `find_files`/`search_text` silently missing files)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7ee3d49f..HEAD -- src/core/glob.ts __tests__/glob.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (plans 009 and 010 build on this one)
- **Category**: bug
- **Planned at**: commit `7ee3d49f`, 2026-09-25

## Why this matters

All four walking tools (`list`, `find_files`, `search_text`, `replace_text`)
go through `globEntries` in `src/core/glob.ts`. When the walked root contains
a `.gitignore`, the walk uses a predicate `exclude` function. Node's
`fs.glob` (observed on v24.15.0) sometimes calls that predicate a **second
time** for a first-level directory, with a dirent whose `parentPath` is the
relative string `"."` instead of an absolute path. It does this when the
**server process's current directory** also has an entry of the same name
(for example `src`, `docs`, `test`). The predicate joins `"."` with the name
and computes the path relative to the walk root. Because `"."` resolves
against the process cwd, the result is a `../../…` path, and the `ignore`
library throws `RangeError: path should be a path.relative()d string, but
got "../"`.

Reproduced through the real tools on a root containing `.gitignore`,
`a.txt` and `src/b.ts`, with the process cwd being a directory that also has
a `src`:

- `list` → `isError`, text `NOT_DIRECTORY: path should be a path.relative()d string…`
- `find_files` → returns only `a.txt`; `src/b.ts` silently missing
- `search_text` → finds the match in `a.txt` only; `src/b.ts` silently not searched

The last two tools run the walk with `suppressErrors: true`, so the throw
ends the walk early with just a log warning. Any client whose server cwd is a
project directory, while the user works in a different root with common
directory names, hits this. The existing tests miss it by luck: their fixture
directories (`a`, `nested`, `skipme`) do not exist in the repo root that
`npm test` runs from. The fix is to resolve the dirent against the walk's
`cwd`, which is what `"."` means there.

## Current state

- `src/core/glob.ts` — `createExcludeFilter` (lines 318-349) builds the
  predicate; `processDirentMatch` (lines 297-316) converts yielded dirents to
  absolute paths. `globEntries` (line 387) is the exported entry point.
- No test file imports `src/core/glob.ts` directly today. Create
  `__tests__/glob.test.ts` (plan 009 will add more tests to it).

`src/core/glob.ts:327-335`:

```ts
  return (match: GlobDirentLike) => {
    const relPath = match.parentPath
      ? relative(cwd, join(match.parentPath, match.name))
      : match.name;

    const posixRel = toPosixPath(relPath);

    // Gitignore check
    const isDir = match.isDirectory();
```

`src/core/glob.ts:297-304`:

```ts
function* processDirentMatch(
  match: GlobDirentLike,
  cwd: string,
  maxDepth: number | undefined,
  seen: Set<string>,
  onlyFiles: boolean,
): Generator<GlobEntry> {
  const absolutePath = resolve(match.parentPath, match.name);
```

What `fs.glob` passes to the predicate, traced on Windows with
`process.cwd() === 'C:\\filesystem-mcp'` (which has a `src` directory) and a
walk root `…\\Temp\\gp6-x` containing `src/b.ts` and `top.txt`:

```text
exclude calls [
  'C:\Users\PC\AppData\Local\Temp\gp6-x|src',
  '.|src',                                     <- parentPath "." (relative)
  'C:\Users\PC\AppData\Local\Temp\gp6-x|top.txt',
  'C:\Users\PC\AppData\Local\Temp\gp6-x\src|b.ts',
  'C:\Users\PC\AppData\Local\Temp\gp6-x\src|inner'
]
```

The same walk run with a process cwd that has no `src` makes no `"."` call.
The yielded entries all had absolute `parentPath`s; only the predicate saw the
relative one.

Test conventions: Node's built-in runner (`node:test`, `node:assert/strict`),
temp roots from `createTestRoot()`/`cleanupTestRoot()` in `__tests__/helpers.ts`,
regexes carry the `u` flag. Each test **file** runs in its own process under
`node --test` (process isolation is Node's default), so a `process.chdir`
inside a test file does not leak into other files, provided the test restores
it in `finally`.

## Commands you will need

| Purpose       | Command                               | Expected on success |
| ------------- | ------------------------------------- | ------------------- |
| Install       | `npm ci`                              | exit 0              |
| Typecheck     | `npm run type-check:test`             | exit 0              |
| New test file | `node --test __tests__/glob.test.ts`  | all pass            |
| Tool tests    | `node --test __tests__/tools.test.ts` | all pass            |
| Lint          | `npm run lint`                        | exit 0              |
| Format files  | `npx prettier --write <files>`        | exit 0              |
| Full gate     | `npm run check`                       | exit 0              |

## Scope

**In scope**:

- `src/core/glob.ts` — the `relPath` line in `createExcludeFilter` and the
  `absolutePath` line in `processDirentMatch`, plus a comment.
- `__tests__/glob.test.ts` (create)

**Out of scope**:

- `GitignoreManager` and the `ignore` library call — the input was wrong, not
  the matcher.
- `DEFAULT_EXCLUDE_PATTERNS` and the `matchesGlob` loop — plan 010 changes those.
- The `suppressErrors` behavior of `search_text`/`find_files` — separate
  question; do not change it here.
- Any tool file.

## Git workflow

- Branch: `advisor/008-glob-exclude-relative-dirent` from `main`.
- One commit, e.g. `fix(glob): resolve fs.glob dirents against the walk root`;
  body describes the process-cwd collision. If you are an AI agent, end with a
  `Co-Authored-By:` trailer naming your model, as recent commits do.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing tests

Create `__tests__/glob.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

import { globEntries, type GlobEntriesOptions } from '../src/core/glob.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
} from './helpers.ts';

/** Walk and return root-relative POSIX paths, sorted, directories with a trailing `/`. */
async function walk(options: GlobEntriesOptions): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of globEntries(options)) {
    const rel = relative(options.cwd, entry.path).replaceAll('\\', '/');
    out.push(entry.dirent.isDirectory() ? `${rel}/` : rel);
  }
  return out.sort();
}

/**
 * A root with a .gitignore and a subdirectory whose name also exists in the
 * process cwd: fs.glob re-visits that directory with a dirent relative to the
 * walk root ("."), which used to resolve against the process cwd instead.
 */
async function withCollidingCwd(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await createTestRoot();
  const elsewhere = await createTestRoot();
  const previousCwd = process.cwd();
  try {
    await mkdir(join(root, 'shared'));
    await writeFile(join(root, 'shared', 'inner.txt'), 'NEEDLE');
    await writeFile(join(root, 'top.txt'), 'NEEDLE');
    await writeFile(join(root, '.gitignore'), '*.log\n');
    await mkdir(join(elsewhere, 'shared'));
    process.chdir(elsewhere);
    await fn(root);
  } finally {
    process.chdir(previousCwd);
    await cleanupTestRoot(root);
    await cleanupTestRoot(elsewhere);
  }
}

describe('globEntries', () => {
  it('walks every subdirectory when the process cwd holds a same-named entry', async () => {
    await withCollidingCwd(async (root) => {
      assert.deepStrictEqual(await walk({ cwd: root, pattern: '**/*', skipIgnored: true }), [
        'shared/inner.txt',
        'top.txt',
      ]);
    });
  });

  it('list, find_files and search_text see the colliding subdirectory', async () => {
    await withCollidingCwd(async (root) => {
      const harness = await createTestClientPair([root]);
      try {
        const listed = await harness.client.callTool({
          name: 'list',
          arguments: { path: root, maxDepth: 2 },
        });
        assert.notStrictEqual(listed.isError, true, firstTextBlock(listed).text);
        assert.match(firstTextBlock(listed).text ?? '', /inner\.txt/u);

        const found = await harness.client.callTool({
          name: 'find_files',
          arguments: { path: root, pattern: '**/*' },
        });
        assert.match(firstTextBlock(found).text ?? '', /inner\.txt/u);

        const searched = await harness.client.callTool({
          name: 'search_text',
          arguments: { path: root, searchPattern: 'NEEDLE' },
        });
        assert.match(firstTextBlock(searched).text ?? '', /inner\.txt/u);
      } finally {
        await harness.close();
      }
    });
  });
});
```

**Verify**: `node --test __tests__/glob.test.ts` → both tests **fail** (the
first with `RangeError … got "../"`, the second on the `list` `isError`
assertion). If they pass, STOP: the Node version in use may not have the
quirk — report `node --version`.

### Step 2: Resolve dirents against the walk root

In `src/core/glob.ts` `createExcludeFilter`, replace the `relPath`
declaration with:

```ts
// fs.glob can hand the predicate a dirent whose parentPath is "." — the walk
// root, not the process cwd — when it re-visits a directory under `**` whose
// name also exists in the process cwd. Resolving against `cwd` names the
// entry the dirent describes; `join` would resolve it against the process.
const relPath = relative(cwd, resolve(cwd, match.parentPath, match.name));
```

In `processDirentMatch`, change the first line to:

```ts
const absolutePath = resolve(cwd, match.parentPath, match.name);
```

(`resolve` ignores `cwd` when `parentPath` is absolute, so every
already-working case is unchanged.) If `join` is now unused in `glob.ts`,
remove it from the `node:path` import; `loadGitignoreFiles` still uses it, so
it probably stays.

**Verify**: `node --test __tests__/glob.test.ts` → both pass.

### Step 3: Format and full gate

`npx prettier --write src/core/glob.ts __tests__/glob.test.ts`

**Verify**:

- `node --test __tests__/tools.test.ts` → all pass (especially
  `TC-FUNC-075b` and `TC-FUNC-075c`, the existing gitignore walk tests).
- `npm run check` → exit 0 (includes `knip`; the new file is an entry via
  `knip.json`'s `__tests__/**/*.test.ts`).

## Test plan

- New `__tests__/glob.test.ts`:
  - `globEntries` over a root with `.gitignore` + `shared/` while the process
    cwd also has `shared/` → both files returned, no throw.
  - `list`, `find_files`, `search_text` on the same root → all see
    `shared/inner.txt`, `list` is not an error.
- Existing, must stay green: `TC-FUNC-075b`, `TC-FUNC-075c` and every other
  walking test in `__tests__/tools.test.ts`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `node --test __tests__/glob.test.ts` → 2 pass
- [ ] `grep -n "resolve(cwd, match.parentPath, match.name)" src/core/glob.ts` → 2 matches
- [ ] `grep -n "join(match.parentPath" src/core/glob.ts` → no matches
- [ ] `git status` shows only `src/core/glob.ts` modified and `__tests__/glob.test.ts` added
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The new tests pass before Step 2 (report `node --version`; the quirk may be
  version-specific).
- After Step 2 the first test still fails — for example the colliding
  directory is now _excluded_ or listed twice. Report the actual array.
- `process.chdir` throws in the test runner (for example, if tests are being
  run with `--test-isolation=none`); report how the tests were invoked.
- Any existing walking test fails.

## Maintenance notes

- This is a Node `fs.glob` quirk. It was observed on v24.15.0 and not
  reported upstream at planning time; filing a Node issue with the trace
  above is worthwhile. The `resolve(cwd, …)` form is correct whether or not
  Node fixes it.
- `search_text` and `find_files` walk with `suppressErrors: true`, which is
  what turned this crash into silently missing files. A thrown error mid-walk
  is logged at `warn` only. Consider (separately) surfacing "walk ended early"
  in those tools' output the way a timeout is.
- Plan 009 adds characterization tests to `__tests__/glob.test.ts`; keep the
  `walk` helper there as the shared utility.
