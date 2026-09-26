# Plan 009: Pin what a directory walk returns with characterization tests for `globEntries`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7ee3d49f..HEAD -- src/core/glob.ts __tests__/glob.test.ts`
> This plan runs **after plan 008**, which changed two lines of
> `src/core/glob.ts` and created `__tests__/glob.test.ts`. Confirm plan 008 is
> `DONE` in `plans/README.md` and that `grep -n "resolve(cwd, match.parentPath, match.name)" src/core/glob.ts`
> returns 2 lines. Any other change to `src/core/glob.ts` is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (tests only)
- **Depends on**: plans/008-glob-exclude-relative-dirent.md
- **Category**: tests
- **Planned at**: commit `7ee3d49f`, 2026-09-25

## Why this matters

`globEntries` (`src/core/glob.ts`) decides which files `list`, `find_files`,
`search_text` and `replace_text` see — and for `replace_text`, which files
get **rewritten**. Before plan 008 no test called it directly; it was covered
only through a handful of tool calls. Several of its behaviors had no test at
all: nested `.gitignore` files, `!negation`, `includeHidden` expansion, the
0-based `maxDepth`, and the fact that default excludes (`node_modules`,
`dist`…) take two different code paths depending on whether a `.gitignore`
exists. Plan 010 rewrites the exclude predicate and adds depth pruning for
performance; without these tests that rewrite could silently change which
files a `replace_text` touches. This plan adds tests only — every one must
pass against the current code on the first run.

## Current state

- `src/core/glob.ts` — `globEntries(options: GlobEntriesOptions)` (line 387),
  an async generator of `{ path, dirent }`. Options (lines 171-183):

```ts
export interface GlobEntriesOptions {
  cwd: string;
  pattern: string;
  includeHidden?: boolean;
  baseNameMatch?: boolean;
  maxDepth?: number;
  onlyFiles?: boolean;
  suppressErrors?: boolean;
  /** Skip what a walk should not surface: DEFAULT_EXCLUDE_PATTERNS and .gitignore. */
  skipIgnored?: boolean;
  /** Bounds the `.gitignore` discovery `skipIgnored` runs before the walk. */
  signal?: AbortSignal;
}
```

- `maxDepth` is **0-based**: `0` = entries directly in `cwd`. (`list`'s public
  `maxDepth` is 1-based and subtracts one before calling — see
  `src/tools/list.ts:92-95`.) `onlyFiles` defaults to `true`.
- `skipIgnored: true` applies `DEFAULT_EXCLUDE_PATTERNS` (a list at the end of
  `glob.ts`: `node_modules`, `dist`, `build`, `.git`, …) **and** every
  `.gitignore` under `cwd`. Without any `.gitignore` the defaults are passed
  to `fs.glob` as an array; with one, a predicate function is used
  (`createExcludeFilter`, line ~318). ADR-001 (`docs/adr/001-one-skipignored-flag-owns-both-exclusion-rules.md`)
  records that both branches must mean the same thing.
- `__tests__/glob.test.ts` — created by plan 008. It already has an async
  `walk(options)` helper that returns sorted root-relative POSIX paths, with
  a trailing `/` on directories. **Reuse it.**

The expected values below were captured by running `globEntries` (with plan
008's fix) on exactly the fixture this plan builds, on Windows, Node 24.15.0.
Paths are sorted with JavaScript's default `sort()`.

Fixture files (all with content `x`):

```text
a.txt
keep.log
x.log
.dotfile
.hidden/h.txt
dist/o.js
node_modules/m.js
src/b.ts
src/deep/c.ts
src/deep/deeper/d.ts
src/node_modules/n.js
sub/y.log
sub/z.txt
```

The "ignored" fixture is the same tree plus `.gitignore` = `*.log\n!keep.log\n`
and `sub/.gitignore` = `z.txt\n`.

## Commands you will need

| Purpose      | Command                                       | Expected on success |
| ------------ | --------------------------------------------- | ------------------- |
| Install      | `npm ci`                                      | exit 0              |
| Typecheck    | `npm run type-check:test`                     | exit 0              |
| Glob tests   | `node --test __tests__/glob.test.ts`          | all pass            |
| Lint         | `npm run lint`                                | exit 0              |
| Format files | `npx prettier --write __tests__/glob.test.ts` | exit 0              |
| Full gate    | `npm run check`                               | exit 0              |

## Scope

**In scope**:

- `__tests__/glob.test.ts` only.

**Out of scope**:

- `src/core/glob.ts` and every other source file. This plan must not change
  behavior. If a test below fails, that is a STOP, not a fix.
- The plan-008 tests already in the file — leave them as they are.

## Git workflow

- Branch: `advisor/009-glob-characterization-tests` from `main` (after plan 008).
- One commit, e.g. `test(glob): pin walk results for excludes, gitignore, hidden and depth`.
  If you are an AI agent, end with a `Co-Authored-By:` trailer naming your
  model, as recent commits do.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Build the two fixtures once

In `__tests__/glob.test.ts`, add `before`/`after` to the `node:test` import
and a new `describe('globEntries characterization', …)` block after the
existing `describe`. Inside it:

```ts
const FILES = [
  'a.txt',
  'keep.log',
  'x.log',
  '.dotfile',
  '.hidden/h.txt',
  'dist/o.js',
  'node_modules/m.js',
  'src/b.ts',
  'src/deep/c.ts',
  'src/deep/deeper/d.ts',
  'src/node_modules/n.js',
  'sub/y.log',
  'sub/z.txt',
];
let plain: string;
let ignored: string;

before(async () => {
  plain = await createTestRoot();
  ignored = await createTestRoot();
  for (const root of [plain, ignored]) {
    for (const file of FILES) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), 'x');
    }
  }
  await writeFile(join(ignored, '.gitignore'), '*.log\n!keep.log\n');
  await writeFile(join(ignored, 'sub', '.gitignore'), 'z.txt\n');
});

after(async () => {
  await cleanupTestRoot(plain);
  await cleanupTestRoot(ignored);
});
```

Add `dirname` to the `node:path` import.

**Verify**: `node --test __tests__/glob.test.ts` → the two plan-008 tests
still pass (no new `it` yet).

### Step 2: Add the tests, one `it` per row

Add these `it` blocks inside the new `describe`. Each is
`assert.deepStrictEqual(await walk({ cwd: <root>, pattern: '**/*', ...opts }), <expected>)`.

| #   | test name                                                            | root      | options (besides `cwd`, `pattern: '**/*'`)                             | expected                                                                                                                                                                   |
| --- | -------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `skipIgnored drops default-excluded dirs at any depth`               | `plain`   | `skipIgnored: true`                                                    | `['a.txt', 'keep.log', 'src/b.ts', 'src/deep/c.ts', 'src/deep/deeper/d.ts', 'sub/y.log', 'sub/z.txt', 'x.log']`                                                            |
| 2   | `without skipIgnored every non-hidden file is walked`                | `plain`   | `skipIgnored: false`                                                   | `['a.txt', 'dist/o.js', 'keep.log', 'node_modules/m.js', 'src/b.ts', 'src/deep/c.ts', 'src/deep/deeper/d.ts', 'src/node_modules/n.js', 'sub/y.log', 'sub/z.txt', 'x.log']` |
| 3   | `includeHidden adds dotfiles and dot-directory contents`             | `plain`   | `skipIgnored: true, includeHidden: true`                               | `['.dotfile', '.hidden/h.txt', 'a.txt', 'keep.log', 'src/b.ts', 'src/deep/c.ts', 'src/deep/deeper/d.ts', 'sub/y.log', 'sub/z.txt', 'x.log']`                               |
| 4   | `maxDepth 0 yields only top-level entries`                           | `plain`   | `skipIgnored: true, maxDepth: 0, onlyFiles: false`                     | `['a.txt', 'keep.log', 'src/', 'sub/', 'x.log']`                                                                                                                           |
| 5   | `maxDepth 1 yields one level down, directories at the edge included` | `plain`   | `skipIgnored: true, maxDepth: 1, onlyFiles: false`                     | `['a.txt', 'keep.log', 'src/', 'src/b.ts', 'src/deep/', 'sub/', 'sub/y.log', 'sub/z.txt', 'x.log']`                                                                        |
| 6   | `root and nested .gitignore both apply, negation re-includes`        | `ignored` | `skipIgnored: true`                                                    | `['a.txt', 'keep.log', 'src/b.ts', 'src/deep/c.ts', 'src/deep/deeper/d.ts']`                                                                                               |
| 7   | `gitignore and maxDepth combine`                                     | `ignored` | `skipIgnored: true, maxDepth: 1, onlyFiles: false`                     | `['a.txt', 'keep.log', 'src/', 'src/b.ts', 'src/deep/', 'sub/']`                                                                                                           |
| 8   | `gitignore with includeHidden lists the .gitignore files`            | `ignored` | `skipIgnored: true, includeHidden: true`                               | `['.dotfile', '.gitignore', '.hidden/h.txt', 'a.txt', 'keep.log', 'src/b.ts', 'src/deep/c.ts', 'src/deep/deeper/d.ts', 'sub/.gitignore']`                                  |
| 9   | `without skipIgnored a .gitignore is not applied`                    | `ignored` | `skipIgnored: false`                                                   | same array as row 2                                                                                                                                                        |
| 10  | `baseNameMatch matches a slash-free glob at any depth`               | `plain`   | `skipIgnored: true, pattern: '*.ts', baseNameMatch: true`              | `['src/b.ts', 'src/deep/c.ts', 'src/deep/deeper/d.ts']`                                                                                                                    |
| 11  | `baseNameMatch respects maxDepth`                                    | `plain`   | `skipIgnored: true, pattern: '*.ts', baseNameMatch: true, maxDepth: 1` | `['src/b.ts']`                                                                                                                                                             |
| 12  | `a prefixed globstar with includeHidden stays inside the prefix`     | `plain`   | `skipIgnored: true, pattern: 'src/**', includeHidden: true`            | `['src/b.ts', 'src/deep/c.ts', 'src/deep/deeper/d.ts']`                                                                                                                    |

For rows 10–12 the `pattern` in the options replaces `'**/*'`: write the
call as `walk({ cwd, pattern: '*.ts', … })`.

Row 1 vs row 6 is the pair that exercises both exclude branches (array vs
predicate): `node_modules/`, `src/node_modules/` and `dist/` must be absent
in both.

**Verify**: `node --test __tests__/glob.test.ts` → 14 tests, all pass (12 new
plus 2 from plan 008), on the **first** run, with no source change.

### Step 3: Format and full gate

`npx prettier --write __tests__/glob.test.ts`

**Verify**: `npm run check` → exit 0.

## Test plan

This plan _is_ the test plan: 12 characterization tests over two fixtures,
covering default excludes (both branches), no-exclude mode, hidden
expansion, 0-based depth with directories at the edge, nested and negated
`.gitignore`, `baseNameMatch`, and a prefixed globstar.

## Done criteria

- [ ] `node --test __tests__/glob.test.ts` → 14 pass, 0 fail
- [ ] `npm run check` exits 0
- [ ] `git diff --stat main` shows only `__tests__/glob.test.ts`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 008 is not `DONE`.
- Any new test fails on the first run. Report the test name and the actual
  array. Do **not** edit the expected value to match: the discrepancy is
  either a platform difference (report the OS) or a behavior change since
  planning, and plan 010's safety depends on knowing which.
- A test passes on one OS and fails on another in CI (for example
  `node_modules` casing on Windows) — report both outputs.

## Maintenance notes

- These tests pin _current_ behavior, including two quirks worth knowing:
  `includeHidden` lists `.gitignore` files themselves (row 8), and hidden
  expansion is done by extra patterns, not a `dot` option.
- One behavior deliberately left unpinned: a default-excluded name _below a
  dot-directory_ (e.g. `.hidden/node_modules/x.js`). Today `**/node_modules`
  does not match through a dot segment, so it is walked; plan 010 may change
  that, and it is not worth pinning.
- When an expected array here has to change, the commit changing it should
  say which user-visible walk result changed and why.
