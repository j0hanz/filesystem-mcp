# Plan 044: Walks honor ancestor `.gitignore` files up to the containing allowed root

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 4d751c94..HEAD -- src/core/glob.ts src/core/path.ts src/core/search.ts src/tools/list.ts src/tools/replace-text.ts __tests__/glob.test.ts __tests__/tools.test.ts docs/adr/001-one-skipignored-flag-owns-both-exclusion-rules.md CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — a walk scoped to a subdirectory now hides files the
  repository root ignores (the intended, git-matching behavior); a
  `.gitignore` above the walk root is read for the first time.
- **Depends on**: 043 (both edit `src/core/glob.ts`; 043 first, it is smaller)
- **Category**: bug
- **Planned at**: commit `4d751c94`, 2026-09-28

## Why this matters

`skipIgnored` promises "what git would ignore". The `.gitignore` loader only
discovers files **under the walk root** (`fsGlob('**/.gitignore', { cwd: root })`).
When an agent scopes `find_files`, `search_text`, `replace_text` or `list` to
`packages/api/`, the repository-root `.gitignore` (`*.log`, `dist/`,
`.env.local`) is never consulted, so build output and logs ignored at the
root come back as results — and `replace_text` will edit them. A monorepo
user sees different results for the same files depending on where they point
the tool. After this plan, every `.gitignore` from the walk root up to (and
including) the allowed root that contains it is applied, with the nearest
file winning exactly as in git, and nothing above an allowed root is ever
read.

## Current state

- `src/core/glob.ts:81-104` — `GitignoreManager.load(root, signal, maxDepth)`
  enumerates only below `root`:

```ts
  static async load(
    root: string,
    signal?: AbortSignal,
    maxDepth?: number,
  ): Promise<GitignoreManager | null> {
    const manager = new GitignoreManager();
    try {
      const gitignorePaths: string[] = [];
      const gitignoreEntries = fsGlob('**/.gitignore', {
        cwd: root,
        exclude: (entry: string) => { ... },
      });
      for await (const match of gitignoreEntries) {
        if (signal?.aborted) break;
        gitignorePaths.push(match);
      }
      await loadGitignoreFiles(root, gitignorePaths, manager, signal);
    } catch (error) { ... }
    return manager.matchers.size === 0 ? null : manager;
  }
```

- `src/core/glob.ts:36-66` — `loadGitignoreFiles(root, relPaths, manager, signal)`
  reads each file with an `lstat` gate (regular file, ≤ `MAX_GITIGNORE_BYTES`)
  and calls `manager.addMatcher(dirRelativeToRoot, ignore().add(contents))`,
  where the key is `''` for the root's own `.gitignore`.
- `src/core/glob.ts:106-165` — `isIgnored(relativePath, isDirectory)` checks
  each parent then the entry via `checkPath`, which consults
  `this.matchers.get('')` (root) first and then each deeper directory's
  matcher with the path re-based to that directory; a later `ignored` /
  `unignored` verdict overrides an earlier one (nearest wins):

```ts
  private checkPath(posixPath: string, isDirectory: boolean): boolean {
    const parts = posixPath.split('/');
    const pathToCheck = isDirectory ? (posixPath.endsWith('/') ? posixPath : `${posixPath}/`) : posixPath;
    let ignored = false;
    // Check root level
    const rootMatcher = this.matchers.get('');
    if (rootMatcher) {
      const res = rootMatcher.test(pathToCheck);
      if (res.ignored) ignored = true;
      if (res.unignored) ignored = false;
    }
    // Check subdirectories
    ...
    return ignored;
  }
```

- `src/core/glob.ts:186-198` — `GlobEntriesOptions` (`cwd`, `pattern`,
  `includeHidden`, `baseNameMatch`, `maxDepth`, `onlyFiles`,
  `suppressErrors`, `skipIgnored`, `signal`).
- `src/core/glob.ts:408-411` — `globEntries` calls
  `GitignoreManager.load(options.cwd, options.signal, options.maxDepth)` when
  `skipIgnored`.
- `glob.ts` imports nothing from `path.ts` (layering: `core/glob.ts` is below
  the guard). It does import `toPosixPath`, `isWindowsDriveRelativePath` from
  `./path-utils.ts`, and `basename, dirname, isAbsolute, join, relative, resolve`
  from `node:path`.
- Callers that set `skipIgnored` (all five):
  `src/core/search.ts:231-240` (`searchContent`) and `:396-403` (`searchFiles`)
  — both receive `pathGuard` as a parameter; `src/tools/list.ts:85-96`
  (`collect`, has `options.pathGuard`); `src/tools/replace-text.ts:519-529`
  (has `ctx.fs.pathGuard`); `src/tools/find-files.ts:133` goes through
  `searchFiles`.
- `src/core/path.ts:213-218` — `PathGuard.getAllowedDirectories()` returns
  the allowed set (configured roots plus their realpath aliases).
- `src/core/path-utils.ts:208-227` — `isPathInsideDirectory(normalizedDirectory, normalizedCandidate)`
  and `isPathWithinDirectories(normalizedPath, allowedDirs)`.
- ADR-001 (`docs/adr/001-…md`) makes `glob.ts` "the sole owner of what
  `skipIgnored` means" and forbids callers from post-filtering. This plan
  keeps that: the ceiling is an _input_ to the walk, the rules stay in
  `glob.ts`.

## Commands you will need

| Purpose           | Command                                                                         | Expected on success |
| ----------------- | ------------------------------------------------------------------------------- | ------------------- |
| Build + typecheck | `npm run build && npm run type-check:test`                                      | exit 0              |
| Unit tests        | `npm test -- --test-name-pattern="globEntries\|gitignore"`                      | all pass            |
| Tool tests        | `npm test -- --test-name-pattern="find_files\|list\|search_text\|replace_text"` | all pass            |
| Full check        | `npm run check`                                                                 | exit 0; 0 fail      |

Baseline at planning time: 450 tests, 447 pass, 3 skips, 0 fail.

## Scope

**In scope**:

- `src/core/glob.ts` — `GlobEntriesOptions.ignoreCeiling`, `GitignoreManager` ancestor matchers
- `src/core/path.ts` — one new public method `allowedRootContaining`
- `src/core/search.ts`, `src/tools/list.ts`, `src/tools/replace-text.ts` — pass the ceiling
- `__tests__/glob.test.ts`, `__tests__/tools.test.ts` — new tests
- `docs/adr/001-one-skipignored-flag-owns-both-exclusion-rules.md` — one "Amended" bullet
- `CHANGELOG.md` — `### Fixed` bullet under `## [Unreleased]`
- `plans/README.md` — status row

**Out of scope**:

- `DEFAULT_EXCLUDED_NAMES` and `createWalkFilter` — unchanged.
- Caching `.gitignore` results across walks (separate finding #9; not here).
- Reading any `.gitignore` above an allowed root, or `.git/info/exclude`,
  or the global `core.excludesFile` — git semantics beyond the allowed root
  are deliberately not reproduced.
- `src/tools/find-files.ts` — it reaches the walk through `searchFiles`.

## Git workflow

- Branch: `advisor/044-ancestor-gitignore`
- Commits e.g. `fix(glob): apply ancestor .gitignore files up to the allowed root`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Failing unit tests

In `__tests__/glob.test.ts`, append a `describe('ancestor .gitignore', …)`
using the file's existing `walk(options)` helper (returns sorted root-relative
POSIX paths, directories with a trailing `/`):

```ts
describe('ancestor .gitignore', () => {
  let root: string;
  before(async () => {
    root = await createTestRoot();
    await writeFile(join(root, '.gitignore'), '*.log\noutdir/\n');
    await mkdir(join(root, 'pkg', 'outdir'), { recursive: true });
    await writeFile(join(root, 'pkg', '.gitignore'), '!keep.log\n');
    await writeFile(join(root, 'pkg', 'a.txt'), 'a');
    await writeFile(join(root, 'pkg', 'a.log'), 'a');
    await writeFile(join(root, 'pkg', 'keep.log'), 'k');
    await writeFile(join(root, 'pkg', 'outdir', 'out.js'), 'o');
  });
  after(async () => cleanupTestRoot(root));

  it("applies the allowed root's rules to a walk scoped below it, nearest file winning", async () => {
    const seen = await walk({
      cwd: join(root, 'pkg'),
      pattern: '**/*',
      skipIgnored: true,
      ignoreCeiling: root,
    });
    assert.deepStrictEqual(seen, ['a.txt', 'keep.log']);
  });

  it('without a ceiling only the walk root and below are consulted (previous behavior)', async () => {
    const seen = await walk({ cwd: join(root, 'pkg'), pattern: '**/*', skipIgnored: true });
    assert.deepStrictEqual(seen, ['a.log', 'a.txt', 'keep.log', 'outdir/out.js']);
  });

  it('a ceiling file that ignores the walk root itself is skipped whole, so the walk is not emptied', async () => {
    await writeFile(join(root, '.gitignore'), '*.log\noutdir/\npkg/\n');
    try {
      const seen = await walk({
        cwd: join(root, 'pkg'),
        pattern: '**/*',
        skipIgnored: true,
        ignoreCeiling: root,
      });
      // The whole root file is skipped (its `pkg/` rule would hide everything the
      // caller asked for), so its `*.log` and `outdir/` rules do not apply either.
      assert.deepStrictEqual(seen, ['a.log', 'a.txt', 'keep.log', 'outdir/out.js']);
    } finally {
      await writeFile(join(root, '.gitignore'), '*.log\noutdir/\n');
    }
  });

  it('never reads above the ceiling', async () => {
    // A .gitignore at the ceiling's parent must not apply: give the parent a
    // rule that would hide a.txt and confirm a.txt survives.
    const outer = await createTestRoot();
    try {
      const inner = join(outer, 'repo');
      await mkdir(join(inner, 'pkg'), { recursive: true });
      await writeFile(join(outer, '.gitignore'), 'a.txt\n');
      await writeFile(join(inner, 'pkg', 'a.txt'), 'a');
      const seen = await walk({
        cwd: join(inner, 'pkg'),
        pattern: '**/*',
        skipIgnored: true,
        ignoreCeiling: inner,
      });
      assert.deepStrictEqual(seen, ['a.txt']);
    } finally {
      await cleanupTestRoot(outer);
    }
  });
});
```

(`before`/`after`/`writeFile`/`mkdir`/`join` are already imported in that
file. `globEntries` defaults to `onlyFiles: true`, so `walk()` yields files
only — directories never appear in these expectations. Do not name the
fixture directory `build`, `dist`, `out` or anything else in
`DEFAULT_EXCLUDED_NAMES` (`glob.ts:428-452`): those are hidden regardless of
`.gitignore`.)

**Verify**: `npm run type-check:test` → **fails** (`ignoreCeiling` is not a
known option). That is the red state for this step.

### Step 2: Add `ignoreCeiling` and ancestor matchers in `glob.ts`

1. `GlobEntriesOptions`: add

```ts
  /**
   * Topmost directory whose `.gitignore` may apply to this walk — the allowed
   * root containing `cwd`. Ancestors of `cwd` up to and including it are
   * consulted; nothing above it is ever read. Ignored without `skipIgnored`.
   */
  ignoreCeiling?: string;
```

2. `GitignoreManager`: add a second store and a loader.

```ts
  /** Rules from directories above the walk root, farthest first; `prefix` re-bases a walk-relative path to that directory. */
  private ancestors: { prefix: string; matcher: Ignore }[] = [];

  addAncestorMatcher(prefix: string, matcher: Ignore): void {
    this.ancestors.push({ prefix, matcher });
  }
```

In `checkPath`, **before** the "Check root level" block, evaluate the
ancestors in order (farthest first, so nearer verdicts override):

```ts
for (const { prefix, matcher } of this.ancestors) {
  const res = matcher.test(`${prefix}/${pathToCheck}`);
  if (res.ignored) ignored = true;
  if (res.unignored) ignored = false;
}
```

Change the "no rules" test at the end of `load` to
`manager.matchers.size === 0 && manager.ancestors.length === 0 ? null : manager`.

3. `load(root, signal, maxDepth, ceiling?)`: after `loadGitignoreFiles(...)`,
   when `ceiling` is given and `root` is strictly inside it, walk up:

```ts
if (ceiling !== undefined) {
  await loadAncestorGitignores(root, ceiling, manager, signal);
}
```

with a new module-private function next to `loadGitignoreFiles`:

```ts
/**
 * Load `.gitignore` from each ancestor of `root` up to and including `ceiling`,
 * farthest first. A rule set that ignores `root` itself is skipped: the caller
 * named that directory on purpose, and applying the rule would empty the walk.
 */
async function loadAncestorGitignores(
  root: string,
  ceiling: string,
  manager: GitignoreManager,
  signal?: AbortSignal,
): Promise<void> {
  const normalizedCeiling = resolve(ceiling);
  const chain: string[] = [];
  for (let dir = dirname(resolve(root)); ; dir = dirname(dir)) {
    if (!isPathInsideDirectory(normalizedCeiling, dir)) break; // climbed past the ceiling
    chain.push(dir);
    if (dir === normalizedCeiling || dirname(dir) === dir) break;
  }
  for (const dir of chain.reverse()) {
    signal?.throwIfAborted();
    const file = join(dir, '.gitignore');
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > MAX_GITIGNORE_BYTES) continue;
      const matcher = ignore().add(await fsReadFile(file, { encoding: 'utf-8', signal }));
      const prefix = toPosixPath(relative(dir, root));
      if (matcher.test(`${prefix}/`).ignored) continue; // rule ignores the walk root itself
      manager.addAncestorMatcher(prefix, matcher);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // ENOENT is the normal case (no .gitignore at this level); anything else is not worth a warning per walk
    }
  }
}
```

Import `isPathInsideDirectory` from `./path-utils.ts` (already the source
of `toPosixPath`). The `lstat`/size gate mirrors `loadGitignoreFiles`
(plan 033's rule: only a small regular file is a rule set).

4. `globEntries`: pass the ceiling:
   `GitignoreManager.load(options.cwd, options.signal, options.maxDepth, options.ignoreCeiling)`.

**Verify**: `npm run build && npm run type-check:test` → exit 0;
`npm test -- --test-name-pattern="ancestor .gitignore\|globEntries"` → all
pass (the four new tests and every existing `globEntries` test).

### Step 3: Compute the ceiling in the guard and pass it from every caller

`src/core/path.ts`, next to `getAllowedDirectories()`:

```ts
  /**
   * The allowed directory that contains `resolvedPath` — the longest match,
   * so a nested root wins over its parent — or `undefined` when none does.
   * Walks use it as the `.gitignore` ceiling: rules above an allowed root are
   * never read.
   */
  allowedRootContaining(resolvedPath: string): string | undefined {
    const normalized = normalizePath(resolvedPath);
    let best: string | undefined;
    for (const dir of this.getAllowedDirectories()) {
      if (isPathInsideDirectory(dir, normalized) && (best === undefined || dir.length > best.length)) {
        best = dir;
      }
    }
    return best;
  }
```

(`isPathInsideDirectory` and `normalizePath` are already imported in
`path.ts`.) Then at each of the four `globEntries({ … skipIgnored … })` call
sites add one line — the `cwd` at each site is already a guard-validated
directory:

- `src/core/search.ts:231` (`searchContent`): `...(pathGuard.allowedRootContaining(directory) !== undefined ? { ignoreCeiling: pathGuard.allowedRootContaining(directory) } : {})` — or bind it to a `const ceiling` first to avoid the double call; match the file's existing `...(cond ? {…} : {})` spread style (required by `exactOptionalPropertyTypes`).
- `src/core/search.ts:396` (`searchFiles`): same, with `directory`.
- `src/tools/list.ts:85` (`collect`): same, with `rootPath` and `options.pathGuard`.
- `src/tools/replace-text.ts:519`: same, with `root` and `ctx.fs.pathGuard`.

**Verify**: `npm run build && npm run type-check:test && npm run lint` → exit 0.

### Step 4: Tool-level test

In `__tests__/tools.test.ts`, after `TC-FUNC-075c` (line ~1565), add:

```ts
it("find_files, search_text, list and replace_text honor the allowed root's .gitignore below it", async () => {
  // tmpDir is the allowed root; the walk is scoped to a subdirectory.
  await writeFile(join(tmpDir, '.gitignore'), 'scoped_ignored/*.log\n');
  const sub = join(tmpDir, 'scoped_ignored');
  await writeTestFile(tmpDir, 'scoped_ignored/keep.txt', 'NEEDLE_G\n');
  const dropped = await writeTestFile(tmpDir, 'scoped_ignored/drop.log', 'NEEDLE_G\n');

  const found = await harness.client.callTool({
    name: 'find_files',
    arguments: { path: sub, pattern: '**/*' },
  });
  const paths = (found._meta as { results?: { path: string }[] }).results?.map((r) => r.path) ?? [];
  assert.deepStrictEqual(paths, ['keep.txt']);

  const searched = await harness.client.callTool({
    name: 'search_text',
    arguments: { path: sub, searchPattern: 'NEEDLE_G' },
  });
  const files =
    (searched._meta as { matches?: { file: string }[] }).matches?.map((m) => m.file) ?? [];
  assert.deepStrictEqual(files, ['keep.txt']);

  const listed = await harness.client.callTool({ name: 'list', arguments: { path: sub } });
  const names =
    (listed._meta as { entries?: { name: string }[] }).entries?.map((e) => e.name) ?? [];
  assert.deepStrictEqual(names, ['keep.txt']);

  const replaced = await harness.client.callTool({
    name: 'replace_text',
    arguments: { path: sub, searchPattern: 'NEEDLE_G', replacement: 'X' },
  });
  assert.notStrictEqual(replaced.isError, true);
  assert.strictEqual(await readFile(dropped, 'utf-8'), 'NEEDLE_G\n', 'ignored file untouched');

  // includeIgnored lifts it, as before.
  const all = await harness.client.callTool({
    name: 'find_files',
    arguments: { path: sub, pattern: '**/*', includeIgnored: true },
  });
  const allPaths =
    (all._meta as { results?: { path: string }[] }).results?.map((r) => r.path) ?? [];
  assert.deepStrictEqual(allPaths.sort(), ['drop.log', 'keep.txt']);
});
```

The shared `tmpDir` gains a `.gitignore` for the rest of the file: its only
rule is scoped to `scoped_ignored/`, so no other test's fixture is affected.
If a later test in the file asserts `tmpDir` has no `.gitignore`, run this
test in its own root instead (`createTestRoot()` + `createTestClientPair`).

**Verify**: `npm test -- --test-name-pattern="honor the allowed root"` → passes;
`npm test -- --test-name-pattern="find_files\|list\|search_text\|replace_text"` → all pass.

### Step 5: Records

- `docs/adr/001-one-skipignored-flag-owns-both-exclusion-rules.md`, under
  "## Consequences", add a bullet: `**Amended 2026-09-28:** a walk scoped below an allowed root also applies the \`.gitignore\` files of its ancestors up to that root (\`GlobEntriesOptions.ignoreCeiling\`, computed by \`PathGuard.allowedRootContaining\`). The rules still live in \`glob.ts\`; callers pass the ceiling and decide nothing further.`
- `CHANGELOG.md`, `## [Unreleased]` → `### Fixed`: `**Subdirectory walks honor the repository's \`.gitignore\`.** \`find_files\`, \`search_text\`, \`replace_text\` and \`list\` scoped to a subdirectory now apply every \`.gitignore\` from that directory up to the allowed root that contains it, nearest file winning, as git does. Nothing above an allowed root is read.`

**Verify**: `npm run check` → exit 0, `fail 0`.

## Test plan

- New unit tests (4) in `glob.test.ts`: ceiling applied with nearest-wins
  negation; no ceiling = previous behavior; a rule ignoring the walk root
  itself is skipped; nothing above the ceiling is read.
- New tool test (1) covering all four tools plus `includeIgnored`.
- Pattern: `glob.test.ts` `walk()` helper and `describe('globEntries')`;
  `TC-FUNC-075c` for the tool shape.
- Existing tests that must stay green: every `globEntries` characterization
  test (plan 009), TC-FUNC-075c, the colliding-cwd tests, and the boundary
  walk at `tools.test.ts:199`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -c "ignoreCeiling" src/core/glob.ts` ≥ 3; `grep -l "ignoreCeiling" src/core/search.ts src/tools/list.ts src/tools/replace-text.ts` → all three
- [ ] `grep -n "allowedRootContaining" src/core/path.ts` → 1 definition
- [ ] The 5 new tests pass; reverting `src/core/glob.ts` alone fails the ceiling tests
- [ ] ADR-001 and CHANGELOG updated; `npx prettier --check .` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `ignore` package's `test()` throws on the prefixed path (it rejects
  paths starting with `./`, `../` or `/`; the prefix built from
  `relative(dir, root)` must never start that way — if it does, the chain
  walked past the ceiling).
- Any plan-009 characterization test in `glob.test.ts` changes outcome
  without a ceiling being passed — the no-ceiling path must be untouched.
- `getAllowedDirectories()` returns paths whose casing/aliasing makes
  `allowedRootContaining` miss on Windows CI (8.3 short names): report the
  two spellings rather than loosening the comparison.

## Maintenance notes

- Finding #9 (cache `.gitignore` sets across walks) would key its cache on
  `(cwd, ignoreCeiling)`; the ancestor chain makes a reload slightly more
  expensive, which is the argument for that follow-up.
- Reviewers should check that `checkPath` evaluates ancestors **before** the
  root matcher — precedence is "farther first, nearer overrides".
- If a future change lets a walk start outside every allowed root (it cannot
  today — `cwd` is guard-validated), `allowedRootContaining` returns
  `undefined` and the walk degrades to the previous behavior.
