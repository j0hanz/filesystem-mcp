# Plan 010: Directory walks stop compiling globs per entry and stop descending past `maxDepth`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7ee3d49f..HEAD -- src/core/glob.ts __tests__/glob.test.ts docs/adr/001-one-skipignored-flag-owns-both-exclusion-rules.md`
> This plan runs **after plans 008 and 009**. Expected changes since the
> planned-at commit: plan 008 changed two lines of `src/core/glob.ts` to
> `resolve(cwd, match.parentPath, match.name)` and created
> `__tests__/glob.test.ts`; plan 009 added 12 tests to that file. Confirm both
> are `DONE` in `plans/README.md`, and that `node --test __tests__/glob.test.ts`
> reports 14 passing tests **before you change anything**. Any other change to
> `src/core/glob.ts` is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/008-glob-exclude-relative-dirent.md, plans/009-glob-characterization-tests.md
- **Category**: perf
- **Planned at**: commit `7ee3d49f`, 2026-09-25

## Why this matters

Every walking tool (`list`, `find_files`, `search_text`, `replace_text`) runs
under a 5-second deadline (`DEFAULT_SEARCH_TIMEOUT_MS`, `src/core/util.ts:78`),
and `skipIgnored` is on by default. Two costs make large trees time out:

1. **Per-entry glob compilation.** When the root has a `.gitignore` (nearly
   every git repo), the exclude predicate loops over all 41
   `DEFAULT_EXCLUDE_PATTERNS` and calls `posix.matchesGlob` on each. Node
   builds a new matcher on every call, and the predicate runs **twice** per
   entry (once inside `fs.glob`, once on yielded entries). Measured on the
   maintainer's machine: about 260 µs per predicate call, so about 0.5 ms per
   entry, which uses up the whole deadline in about 10k entries.
2. **`maxDepth` does not limit the walk.** It only filters what is yielded.
   `list` with its default depth of 1 still walks the entire tree, and the
   `.gitignore` discovery pass walks the entire tree again.

Measured on a 10,000-file tree with a `.gitignore` (40 × 10 directories × 25
files) with this plan's code applied to a scratch copy of the repo:

| walk                                          | before  | after  |
| --------------------------------------------- | ------- | ------ |
| full walk, `skipIgnored`                      | 3654 ms | 389 ms |
| `list` default (`maxDepth: 0`, dirs included) | 3766 ms | 22 ms  |
| `maxDepth: 1`, dirs included                  | 3724 ms | 379 ms |

On that scratch copy the full test suite passed (365 pass, 0 fail, 2 skipped,
including plan 009's 12 characterization tests). An old-versus-new comparison
over 256 option combinations (`includeHidden` × `maxDepth` × `onlyFiles` ×
`skipIgnored` × 4 patterns, with and without `.gitignore`) found exactly one
behavior difference, which is intended: a default-excluded name **below a
dot-directory** (for example `.hidden/node_modules/q.js`) is now excluded.
Before, the glob `**/node_modules` could not match through a dot segment.

## Current state

`src/core/glob.ts` (after plan 008). The regions this plan changes:

`src/core/glob.ts:2` — imports:

```ts
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
```

`GitignoreManager.load` (lines ~66-79):

```ts
  static async load(root: string, signal?: AbortSignal): Promise<GitignoreManager | null> {
    const manager = new GitignoreManager();
    try {
      const gitignorePaths: string[] = [];
      const gitignoreEntries = fsGlob('**/.gitignore', {
        cwd: root,
        exclude: (entry: string) => {
          const name = basename(entry);
          if (name === 'node_modules' || name === '.git' || name === '.hg' || name === '.svn') {
            return true;
          }
          return false;
        },
      });
```

`NormalizedGlob` and `normalizeGlobOptions` (lines ~185-295) carry an
`exclude: readonly string[]` field set to
`options.skipIgnored ? DEFAULT_EXCLUDE_PATTERNS.map(toPosixPath) : []`.

`createExcludeFilter` (lines ~318-347, after plan 008):

```ts
function createExcludeFilter(
  cwd: string,
  excludePatterns: readonly string[],
  gitignoreMatcher?: GitignoreManager | null,
): ((match: GlobDirentLike) => boolean) | readonly string[] {
  if (!gitignoreMatcher) {
    return excludePatterns;
  }

  return (match: GlobDirentLike) => {
    const relPath = relative(cwd, resolve(cwd, match.parentPath, match.name));

    const posixRel = toPosixPath(relPath);

    // Gitignore check
    const isDir = match.isDirectory();
    if (gitignoreMatcher.isIgnored(posixRel, isDir)) {
      return true;
    }

    // Also check explicit exclude patterns
    if (excludePatterns.length > 0) {
      for (const ex of excludePatterns) {
        if (posix.matchesGlob(posixRel, ex)) return true;
      }
    }

    return false;
  };
}
```

`processGlobPattern` takes `excludeFunc` and passes it as `exclude:` to
`fsGlob`, then re-applies it:

```ts
// A function `exclude` only prunes descent in fs.glob — it still yields
// the rejected dirent itself, and any rejected entry below the top level.
// An array `exclude` drops both. Re-apply the predicate so the two agree.
if (typeof excludeFunc === 'function' && excludeFunc(match)) continue;
```

`globEntries` builds `excludeFunc = createExcludeFilter(plan.cwd, plan.exclude, gitignoreMatcher)`,
and the file ends with `const DEFAULT_EXCLUDE_PATTERNS = [ ... ]`: 41 strings,
each `'**/<name>'` or `'**/<name>/**'`, covering 23 distinct names.

Two `fs.glob` facts this design depends on (both confirmed while planning):

- A predicate `exclude` that returns `true` for a directory stops descent into
  it. A rejected **top-level** entry is not yielded; a rejected entry **below
  the top level** is still yielded (hence the re-check). "Top level" here is
  relative to where the pattern starts matching: for `src/**`, `src/deep` is
  top-level.
- So pruning a directory _at_ the depth bound would sometimes drop the
  directory itself. This plan prunes **one level past** the bound instead:
  directories at `depth > maxDepth`. `processDirentMatch` already drops any
  entry deeper than `maxDepth`, so the extra level never reaches the caller.

ADR-001 (`docs/adr/001-one-skipignored-flag-owns-both-exclusion-rules.md`)
says `glob.ts` is the sole owner of what `skipIgnored` means, and that the
array and predicate forms of the filter must mean the same thing. This plan
removes the array form. Both rules (default names and `.gitignore`) now go
through one predicate, which is the strongest form of that guarantee. The ADR
gets a short amendment (Step 5).

## Commands you will need

| Purpose      | Command                               | Expected on success |
| ------------ | ------------------------------------- | ------------------- |
| Install      | `npm ci`                              | exit 0              |
| Typecheck    | `npm run type-check:test`             | exit 0              |
| Glob tests   | `node --test __tests__/glob.test.ts`  | all pass            |
| Tool tests   | `node --test __tests__/tools.test.ts` | all pass            |
| Lint         | `npm run lint`                        | exit 0              |
| Format files | `npx prettier --write <files>`        | exit 0              |
| Full gate    | `npm run check`                       | exit 0              |

## Scope

**In scope**:

- `src/core/glob.ts`
- `__tests__/glob.test.ts` (add 1 test)
- `docs/adr/001-one-skipignored-flag-owns-both-exclusion-rules.md` (append an
  amendment bullet only)

**Out of scope**:

- `src/tools/*.ts`. Every caller keeps calling `globEntries` with the same
  options.
- `buildHiddenPatterns`: `includeHidden` still runs up to 3 walks, one per
  pattern variant. Merging them into one `fs.glob` call is a possible
  follow-up, but it was not measured.
- `src/core/search.ts`: `search_text`'s serial per-file I/O is a separate
  cost.
- Plan 009's expected arrays. If one of them fails, STOP.

## Git workflow

- Branch: `advisor/010-glob-walk-perf` from `main` (after 008 and 009).
- One commit, e.g. `perf(glob): match default excludes by name and prune past maxDepth`.
  Put the benchmark table from Step 6 in the body. If you are an AI agent, end
  with a `Co-Authored-By:` trailer naming your model, as recent commits do.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 0: Record a baseline benchmark

Save this script **outside the repo**, for example as `$TMPDIR/glob-bench.mts`.
Run it from the repo root with `node <path>/glob-bench.mts`, and keep the
output.

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { globEntries } = await import(pathToFileURL(join(process.cwd(), 'src/core/glob.ts')).href);
const root = await mkdtemp(join(tmpdir(), 'glob-bench-'));
try {
  for (let d = 0; d < 40; d++)
    for (let s = 0; s < 10; s++) {
      const dir = join(root, `pkg${d}`, `mod${s}`);
      await mkdir(dir, { recursive: true });
      for (let f = 0; f < 25; f++) await writeFile(join(dir, `f${f}.ts`), 'x');
    }
  await writeFile(join(root, '.gitignore'), '*.log\n');
  const cases = [
    ['full walk', {}],
    ['list default (maxDepth 0, dirs)', { maxDepth: 0, onlyFiles: false }],
  ] as const;
  for (const [label, opts] of cases) {
    const t = performance.now();
    let n = 0;
    for await (const _ of globEntries({ cwd: root, pattern: '**/*', skipIgnored: true, ...opts }))
      n++;
    console.log(`${label}: ${(performance.now() - t).toFixed(0)} ms, ${n} entries`);
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
```

**Verify**: it prints two lines with entry counts `10000` and `40`. Timings
depend on the machine. On the planning machine both were about 3.7 s.

### Step 1: Replace the pattern list with a name set

At the end of `src/core/glob.ts`, replace the whole
`const DEFAULT_EXCLUDE_PATTERNS = [ ... ];` with:

```ts
/** Names a `skipIgnored` walk never enters or yields, at any depth. */
const DEFAULT_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.vscode',
  '.idea',
  '.DS_Store',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.cache',
  '.yarn',
  'jspm_packages',
  'bower_components',
  'out',
  'tmp',
  '.temp',
  'npm-debug.log',
  'yarn-debug.log',
  'yarn-error.log',
  'Thumbs.db',
]);
```

These are the 23 names from the old list, the same ones and no others. Check
this before deleting the old array: every old entry, with its `**/` prefix and
`/**` suffix stripped, appears in the new set exactly once.

In the `GlobEntriesOptions.skipIgnored` doc comment, change
`DEFAULT_EXCLUDE_PATTERNS` to `DEFAULT_EXCLUDED_NAMES`.

**Verify**: no verify yet, because the file does not compile until Step 2.

### Step 2: One predicate filter with depth pruning

1. Delete the `exclude: readonly string[];` field from `NormalizedGlob`, and
   delete the `exclude: …` line from `normalizeGlobOptions`.
2. Replace `createExcludeFilter` entirely with:

```ts
interface WalkFilter {
  /** Given to fs.glob: true stops descent into a directory. */
  prune: (match: GlobDirentLike) => boolean;
  /** Re-applied to yielded entries: the ignore rules only, never the depth bound. */
  isExcluded: (match: GlobDirentLike) => boolean;
}

function createWalkFilter(
  cwd: string,
  skipIgnored: boolean,
  gitignoreMatcher: GitignoreManager | null,
  maxDepth: number | undefined,
): WalkFilter | undefined {
  if (!skipIgnored && maxDepth === undefined) return undefined;

  const relativeOf = (match: GlobDirentLike): string =>
    toPosixPath(relative(cwd, resolve(cwd, match.parentPath, match.name)));
  // Every default exclude is a bare name that applies at any depth, so a Set
  // lookup per segment replaces compiling dozens of globs per entry.
  const excluded = (posixRel: string, isDir: boolean): boolean =>
    skipIgnored &&
    (posixRel.split('/').some((segment) => DEFAULT_EXCLUDED_NAMES.has(segment)) ||
      (gitignoreMatcher?.isIgnored(posixRel, isDir) ?? false));

  return {
    prune: (match) => {
      const posixRel = relativeOf(match);
      const isDir = match.isDirectory();
      if (excluded(posixRel, isDir)) return true;
      // Stop descent one level past the depth bound. Pruning a directory *at*
      // the bound would drop it where fs.glob treats it as top-level, so prune
      // its children instead; processDirentMatch drops that extra level.
      if (maxDepth === undefined || !isDir) return false;
      return posixRel.split('/').length - 1 > maxDepth;
    },
    isExcluded: (match) => excluded(relativeOf(match), match.isDirectory()),
  };
}
```

3. In `processGlobPattern`, rename the last parameter to
   `filter: WalkFilter | undefined`. Change the `fsGlob` options to
   `...(filter ? { exclude: filter.prune } : {}),` in place of
   `exclude: excludeFunc,`. Replace the re-check and its comment with:

```ts
// A function `exclude` only prunes descent in fs.glob — it still yields
// the rejected dirent itself, and any rejected entry below the top level.
// Re-apply the ignore rules (not the depth bound) to drop those.
if (filter?.isExcluded(match)) continue;
```

4. In `globEntries`, replace the `excludeFunc` line with:

```ts
const filter = createWalkFilter(
  plan.cwd,
  options.skipIgnored ?? false,
  gitignoreMatcher,
  plan.maxDepth,
);
```

Then pass `filter` to `processGlobPattern` in place of `excludeFunc`.

5. Remove `posix` from the `node:path` import. Keep `join`, because
   `loadGitignoreFiles` uses it.

**Verify**: `npm run type-check:test` → exit 0.

### Step 3: Bound the `.gitignore` discovery walk

Change `GitignoreManager.load` to take `maxDepth?: number` as a third
parameter, and replace its `exclude` with:

```ts
        // Skip what the walk itself skips, and stop one level past its depth
        // bound: a .gitignore at depth d only affects entries at depth >= d.
        exclude: (entry: string) => {
          const name = basename(entry);
          if (name === '.hg' || name === '.svn' || DEFAULT_EXCLUDED_NAMES.has(name)) return true;
          return maxDepth !== undefined && toPosixPath(entry).split('/').length - 1 > maxDepth;
        },
```

(`node_modules` and `.git` are in `DEFAULT_EXCLUDED_NAMES`. `load` only runs
when `skipIgnored` is set, so a `.gitignore` inside an excluded directory
could never apply anyway.) In `globEntries`, pass `options.maxDepth` as the
third argument to `GitignoreManager.load`.

**Verify**:

- `npm run type-check:test` → exit 0.
- `node --test __tests__/glob.test.ts` → **14 pass, unchanged**. Plan 009's
  12 characterization tests are the safety net here. If any of them fails,
  STOP.

### Step 4: Pin the one intended behavior change

In `__tests__/glob.test.ts`, inside `describe('globEntries characterization', …)`,
add a test named
`a default-excluded name below a dot-directory is excluded too`. It builds its
own small root and cleans it up in `finally`:

- files: `.hidden/node_modules/q.js`, `.hidden/keep.txt`
- `walk({ cwd: root, pattern: '**/*', skipIgnored: true, includeHidden: true })`
  → `['.hidden/keep.txt']`

**Verify**: `node --test __tests__/glob.test.ts` → 15 pass.

### Step 5: Amend ADR-001

Append one bullet at the end of the **Consequences** list in
`docs/adr/001-one-skipignored-flag-owns-both-exclusion-rules.md`, dated with
today's date:

```markdown
- **Amended <YYYY-MM-DD>:** the array form is gone. `glob.ts` now applies both
  rules (default excluded names and `.gitignore`) through one predicate,
  `createWalkFilter`, which also prunes descent past `maxDepth`. The
  array-vs-predicate divergence described above can no longer occur. The
  defaults became a name set (`DEFAULT_EXCLUDED_NAMES`) matched per path
  segment, which also excludes such a name below a dot-directory.
```

Do not edit the rest of the ADR. Its drifted line links are a separate
docs clean-up.

**Verify**: `npx prettier --check docs/adr/001-one-skipignored-flag-owns-both-exclusion-rules.md` → exit 0.

### Step 6: Format, benchmark, full gate

1. `npx prettier --write src/core/glob.ts __tests__/glob.test.ts docs/adr/001-one-skipignored-flag-owns-both-exclusion-rules.md`
2. Re-run the Step 0 benchmark.

**Verify**:

- Benchmark: the entry counts are unchanged (`10000`, `40`). "full walk" is
  at most **one third** of its Step 0 time, and "list default" is at most
  **one tenth** of its Step 0 time.
- `node --test __tests__/tools.test.ts` → all pass.
- `npm run check` → exit 0.

## Test plan

- Safety net: plan 009's 12 characterization tests, unchanged, plus plan 008's
  2 tests.
- New: dot-directory-nested default exclude (the one intended change).
- Existing tool-level walk tests that must stay green:
  - `TC-FUNC-075b` (list prunes an ignored directory and everything under it)
  - `TC-FUNC-075c` (find_files drops a gitignored file below the top level)
  - `find_files and search_text match a slash-free glob at any depth`
  - all `list` depth tests in `__tests__/tools.test.ts`
- Performance: the Step 0/Step 6 benchmark. It is not committed, because
  timing tests are flaky in CI.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `node --test __tests__/glob.test.ts` → 15 pass
- [ ] `grep -n "matchesGlob\|DEFAULT_EXCLUDE_PATTERNS\|createExcludeFilter" src/core/glob.ts` → no matches
- [ ] `grep -n "DEFAULT_EXCLUDED_NAMES" src/core/glob.ts` → definition + uses in `createWalkFilter` and `GitignoreManager.load` + the doc comment
- [ ] Benchmark ratios from Step 6 met; the before/after numbers are in the commit body
- [ ] `git status` shows only the three in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 008 or 009 is not `DONE`, or `__tests__/glob.test.ts` does not have 14
  passing tests before you start.
- Any of plan 009's characterization tests fails after Step 2 or Step 3.
  Report the test name and the actual array. The comparison run during
  planning predicts none will.
- A directory at exactly `maxDepth` disappears from `list` output. That is the
  `fs.glob` top-level behavior this design works around. Report which pattern
  and depth.
- The benchmark entry counts change, or the speed-up ratios are not met.
- The change seems to need edits to any tool file.

## Maintenance notes

- `DEFAULT_EXCLUDED_NAMES` holds names, not globs. Adding a pattern that is not
  a bare name (for example `*.pyc`) needs a second mechanism, and that is what
  ADR-001 says to argue against first.
- Depth pruning reads one directory level past `maxDepth`. Plan for that when
  sizing very wide trees.
- `includeHidden` still costs up to 3 walks (`buildHiddenPatterns`). If
  profiling shows it matters, try passing all patterns to one `fsGlob` call,
  and benchmark it.
- Reviewer: check that `prune` and `isExcluded` share `excluded()`, and that
  the depth check is **not** in `isExcluded`. If it were, directories at the
  bound would vanish from `list`.
