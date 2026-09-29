# Plan 043: File names with glob metacharacters work in `search_text` and `find_files`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 4d751c94..HEAD -- src/core/glob.ts src/core/search.ts src/tools/search-text.ts __tests__/glob.test.ts __tests__/tools.test.ts CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW — only the explicit-file branch of `search_text` and the
  glob-syntax refinement change; directory searches are untouched.
- **Depends on**: none (run before 045, which edits `src/core/search.ts` too)
- **Category**: bug
- **Planned at**: commit `4d751c94`, 2026-09-28

## Why this matters

Framework file names contain glob metacharacters: Next.js `[slug].tsx`,
`[...slug]/page.tsx`, `(group)/layout.tsx`, SvelteKit `[id]/+page.svelte`.
Two paths mishandle them:

1. `search_text { path: "pages/[slug].tsx", searchPattern: "x" }` names a
   _file_. `resolveSearchScope` rewrites that into a glob `./[slug].tsx` and
   hands it to the walk, where `[slug]` is a character class — the search
   scans `s.tsx`, `l.tsx`, … in the same directory and never the file the
   caller named. The code's own comment admits it ("Escape it here if that
   ever bites"). It bites.
2. `find_files { pattern: "app/**/[...slug]/page.tsx" }` is refused with
   `Invalid glob or unsafe path (absolute/.. forbidden)` because
   `isSafeGlobSyntax` rejects `..` **anywhere** in the pattern. Plan 018 fixed
   the same over-rejection for _paths_ (only a whole `..` segment is
   traversal) but left globs behind.

After this plan, naming a file searches exactly that file, and a glob is
refused only when `..` is a whole segment or a whole brace alternative — the
two forms that can traverse.

## Current state

- `src/core/glob.ts:14-31` — `isSafeGlobSyntax(pattern)`:

```ts
export function isSafeGlobSyntax(pattern: string): boolean {
  if (!pattern || pattern.trim().length === 0) {
    return false;
  }
  if (isAbsolute(pattern)) {
    return false;
  }
  if (isWindowsDriveRelativePath(pattern)) {
    return false;
  }
  // Covers every engine-specific traversal form too — `{a,..}` and `[..]` both
  // contain '..', so they are rejected here. Keep this check whole-string: the
  // per-form guards that used to follow it were unreachable because of it.
  if (pattern.includes('..')) {
    return false;
  }
  return true;
}
```

- `src/core/schema.ts:85-96` — `SafeGlobPattern` calls it and emits the
  message `Invalid glob or unsafe path (absolute/.. forbidden)`. The path
  precedent from plan 018 sits a few lines above (`schema.ts:64-67`):

```ts
// Only a whole `..` segment is traversal. `..` inside a segment
// (`[...slug]`, `v1..2.md`) is a plain file name; PathGuard re-checks
// containment on the resolved path regardless.
const hasTraversalSegment = (val: string): boolean => val.split(/[\\/]/u).includes('..');
```

- `src/tools/search-text.ts:237-266` — `resolveSearchScope`:

```ts
async function resolveSearchScope(
  args: SearchInput,
  ctx: ToolCtx,
): Promise<{ basePath: string; args: SearchInput }> {
  const requested = ctx.fs.pathGuard.resolvePathOrRoot(args.path);
  // One resolution, one stat: validateExistingDirectory would redo both.
  const resolved = await ctx.fs.pathGuard.validateExistingPath(requested);
  const stats = await stat(resolved);
  if (!stats.isFile()) {
    if (!stats.isDirectory()) {
      throw new FsError(ErrorCode.NOT_DIRECTORY, 'Not a directory', requested);
    }
    return { basePath: resolved, args };
  }
  return {
    basePath: dirname(resolved),
    // The `./` anchors the name to the parent: a bare name is a basename glob
    // that would also match every namesake anywhere below it.
    // ponytail: the name goes through as a glob, so a file whose name contains
    // glob metacharacters (`[id].ts`) matches as a pattern rather than
    // literally. Escape it here if that ever bites.
    args: {
      ...args,
      pattern: `./${basename(resolved)}`,
      includeHidden: true,
      includeIgnored: true,
    },
  };
}
```

- `src/tools/search-text.ts:297-316` — the single caller, inside
  `paginate(...).produce`:

```ts
const { basePath, args: scoped } = await resolveSearchScope(args, ctx);

const result = await searchContent(
  basePath,
  scoped.searchPattern,
  {
    includeHidden: scoped.includeHidden,
    filePattern: scoped.pattern ?? '**/*',
    caseSensitive: scoped.caseSensitive,
    isRegex: scoped.isRegex,
    maxResults: MAX_SEARCH_RESULTS,
    skipIgnored: !scoped.includeIgnored,
    context: scoped.context,
    ...(scoped.maxDepth !== undefined ? { maxDepth: scoped.maxDepth } : {}),
    signal: ctx.signal,
  },
  ctx.fs.pathGuard,
);
```

- `src/core/search.ts:175-186` — `SearchContentOptions` (fields:
  `caseSensitive`, `isRegex`, `maxResults`, `filePattern`, `skipIgnored`,
  `includeHidden`, `maxDepth`, `context`, `signal`).
- `src/core/search.ts:216-227` — `searchContent` builds `entries` with
  `globEntries({ cwd: directory, pattern: options.filePattern ?? '**/*', … })`
  and then iterates `guardedEntries(entries, pathGuard, …)`, which uses only
  `entry.path` (and re-validates it with `pathGuard.validateExistingPath`).
- `GlobEntry` (`src/core/glob.ts:181-184`) is `{ path: string; dirent: DirentLike }`;
  `DirentLike` (`src/core/path-utils.ts:11-15`) is
  `{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }`.

Why not escape the name for the glob instead: Node's `fs.glob` on Windows
treats `\` as a path separator, so `\[` escaping is not portable. Bypassing
the walk for a single named file is the robust fix — and it is exactly what
`replace_text` already does (`src/tools/replace-text.ts:434-455`,
`resolveSearchRoot` returns `{ root, singleFile }` with the comment "A single
explicit file target bypasses the glob machinery entirely"). Match that.

Tests: `__tests__/glob.test.ts` (unit, imports from `../src/core/glob.ts`),
`__tests__/tools.test.ts` (tool-level; `search_text` tests near line 2407,
`find_files` tests near line 2254; the shared `harness` and `tmpDir` are
created in `before`). `search_text`'s text argument is `searchPattern`; its
glob argument is `pattern`.

## Commands you will need

| Purpose           | Command                                                                       | Expected on success |
| ----------------- | ----------------------------------------------------------------------------- | ------------------- |
| Build + typecheck | `npm run build && npm run type-check:test`                                    | exit 0              |
| Targeted tests    | `npm test -- --test-name-pattern="search_text\|find_files\|isSafeGlobSyntax"` | all pass            |
| Full check        | `npm run check`                                                               | exit 0; 0 fail      |

Baseline at planning time: 450 tests, 447 pass, 3 skips, 0 fail.

## Scope

**In scope**:

- `src/core/glob.ts` — `isSafeGlobSyntax` body and its comment
- `src/core/search.ts` — one optional field on `SearchContentOptions`, one
  branch where `entries` is built
- `src/tools/search-text.ts` — `resolveSearchScope` and its caller
- `__tests__/glob.test.ts`, `__tests__/tools.test.ts` — new tests
- `CHANGELOG.md` — `### Fixed` bullets under `## [Unreleased]`
- `plans/README.md` — status row

**Out of scope**:

- `src/core/schema.ts` — `SafeGlobPattern`'s message text stays; `RequiredPath` is already correct.
- `src/tools/replace-text.ts`, `src/tools/find-files.ts` — they consume `SafeGlobPattern`; no change needed.
- The per-line match loop in `search.ts` (plan 045 owns it).

## Git workflow

- Branch: `advisor/043-glob-metachar-names`
- Commits e.g. `fix(glob): refuse only a whole .. segment or brace alternative`,
  `fix(search_text): search a named file directly instead of as a glob`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Failing unit tests for `isSafeGlobSyntax`

In `__tests__/glob.test.ts`, add `isSafeGlobSyntax` to the existing import
from `../src/core/glob.ts` and append a new top-level `describe`:

```ts
describe('isSafeGlobSyntax', () => {
  it('accepts .. inside a segment or a character class', () => {
    for (const ok of [
      'app/**/[...slug]/page.tsx',
      'docs/v1..2.md',
      '**/[..]x',
      'a/..b/c',
      '**/*.ts',
    ]) {
      assert.strictEqual(isSafeGlobSyntax(ok), true, ok);
    }
  });
  it('refuses a whole .. segment or brace alternative', () => {
    for (const bad of ['..', '../x', 'a/../b', 'a/..', '{a,..}/x', 'x/{..,b}', '..\\x']) {
      assert.strictEqual(isSafeGlobSyntax(bad), false, bad);
    }
  });
  it('still refuses absolute and drive-relative patterns', () => {
    assert.strictEqual(isSafeGlobSyntax('/etc/*'), false);
    assert.strictEqual(isSafeGlobSyntax('C:foo/*'), false);
    assert.strictEqual(isSafeGlobSyntax('   '), false);
  });
});
```

**Verify**: `npm test -- --test-name-pattern="isSafeGlobSyntax"` → the first
test **fails** (`[...slug]`, `v1..2`, `[..]`, `..b` are refused today); the
other two pass.

### Step 2: Bound the `..` check

In `src/core/glob.ts`, replace the `pattern.includes('..')` check and its
comment with:

```ts
// Only a whole `..` — a path segment, or one alternative of a `{a,..}`
// brace set — can traverse. `..` inside a segment (`[...slug]`, `v1..2.md`,
// `[..]`) is a literal name or a character class, and PathGuard re-checks
// containment on every resolved entry regardless.
if (TRAVERSAL_DOTDOT_RE.test(pattern)) {
  return false;
}
```

with, above the function:

```ts
/** `..` bounded on both sides by a separator, a brace delimiter, or the pattern edge. */
const TRAVERSAL_DOTDOT_RE = /(?:^|[/\\{,])\.\.(?=[/\\},]|$)/u;
```

**Verify**: `npm test -- --test-name-pattern="isSafeGlobSyntax"` → all three
pass. `npm test -- --test-name-pattern="find_files\|replace_text\|search_text"`
→ all pass (no existing test relies on the broad rejection).

### Step 3: Failing tool test for the named-file search

In `__tests__/tools.test.ts`, directly after `TC-FUNC-072` (`search_text finds a literal match via callTool`, line ~2407), add:

```ts
it('search_text on a file whose name has glob metacharacters searches that file', async () => {
  const target = await writeTestFile(tmpDir, 'globby/[slug].tsx', 'export const NEEDLE_A = 1;\n');
  // A same-directory decoy that the character class `[slug]` would match.
  await writeTestFile(tmpDir, 'globby/s.tsx', 'export const NEEDLE_A = 2;\n');

  const result = await harness.client.callTool({
    name: 'search_text',
    arguments: { path: target, searchPattern: 'NEEDLE_A' },
  });
  assert.notStrictEqual(result.isError, true);
  const matches = (result._meta as { matches?: { file: string; line: number }[] }).matches ?? [];
  assert.deepStrictEqual(
    matches.map((m) => m.file),
    ['[slug].tsx'],
    'exactly the named file, not the decoy',
  );
});

it('find_files accepts a literal file name containing .. inside a segment', async () => {
  // `[...slug]` stays a character class (as in any glob), so the accepted
  // pattern that is also *useful* is a literal name with `..` inside it.
  await writeTestFile(tmpDir, 'globby/docs/v1..2.md', 'x\n');
  const result = await harness.client.callTool({
    name: 'find_files',
    arguments: { path: join(tmpDir, 'globby'), pattern: 'docs/v1..2.md' },
  });
  assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
  const paths =
    (result._meta as { results?: { path: string }[] }).results?.map((r) => r.path) ?? [];
  assert.deepStrictEqual(paths, ['docs/v1..2.md']);
});
```

Note (learned on first execution): `app/**/[...slug]/page.tsx` is now
_accepted_ but matches nothing against a directory literally named
`[...slug]` — brackets are a character class in every glob engine, and
Node's `fs.glob` has no portable escape on Windows. `**/page.tsx` finds that
file. Do not assert a bracket pattern matches a bracket-named directory.

Windows note: `fs.glob` on Windows is case-insensitive; the decoy `s.tsx` is
what the class `[slug]` matches on both platforms.

**Verify**: `npm test -- --test-name-pattern="glob metacharacters searches that file"`
→ **fails** today (matches are `['s.tsx']` or empty).
`npm test -- --test-name-pattern="literal file name containing"` → passes after
step 2 (this test guards step 2 end to end).

### Step 4: Search a named file directly

`src/core/search.ts`: add to `SearchContentOptions`:

```ts
  /**
   * Search exactly this file (absolute, already guard-validated) instead of
   * walking `directory` with `filePattern`. Set when the caller named a file:
   * its name must not be interpreted as a glob.
   */
  explicitFile?: string;
```

and change the `entries` construction in `searchContent` to:

```ts
    const entries = options.explicitFile
      ? singleEntry(options.explicitFile)
      : globEntries({
          cwd: directory,
          pattern: options.filePattern ?? '**/*',
          // (existing options unchanged)
          ...
        });
```

with a module-private generator near `guardedEntries`:

```ts
/** One named file as a walk result; `guardedEntries` re-validates it like any other. */
async function* singleEntry(path: string): AsyncGenerator<GlobEntry> {
  yield {
    path,
    dirent: { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
  };
}
```

`src/tools/search-text.ts`: change `resolveSearchScope`'s return type to
`{ basePath: string; args: SearchInput; explicitFile?: string }`. The
directory branch is unchanged. The file branch becomes:

```ts
return {
  basePath: dirname(resolved),
  // The name is NOT turned into a glob: `[slug].tsx` would read as a
  // character class. searchContent scans exactly this file instead, and
  // hidden/ignored filtering is moot for a file the caller named.
  explicitFile: resolved,
  args: { ...args, includeHidden: true, includeIgnored: true },
};
```

(Remove the `pattern: \`./${basename(resolved)}\``line and the "ponytail"
comment; if`basename`is now unused, drop it from the`node:path`import.)
In the caller, destructure`explicitFile` and pass it through:

```ts
      const { basePath, args: scoped, explicitFile } = await resolveSearchScope(args, ctx);
      const result = await searchContent(basePath, scoped.searchPattern, {
          ...(existing fields)
          ...(explicitFile !== undefined ? { explicitFile } : {}),
        }, ctx.fs.pathGuard);
```

The match's `file` field is built by `buildSortedPayloads` relative to
`result.basePath` (`dirname(resolved)`), so it stays `[slug].tsx` as the test
expects.

**Verify**: `npm run build && npm run type-check:test` → exit 0;
`npm test -- --test-name-pattern="search_text"` → all pass including the new
one; `npm run lint` → exit 0 (unused import would fail here).

### Step 5: Documentation and full check

`CHANGELOG.md`, `## [Unreleased]` → `### Fixed` (create if absent):

- `**\`search_text\` on a file whose name contains glob characters.** Naming \`pages/[slug].tsx\` searched other same-directory files (the name was read as a glob); it now searches exactly that file.`
- `**Globs may contain \`..\` inside a segment.** \`docs/v1..2.md\` and \`**/[..]x\` are accepted by \`find_files\`, \`search_text\` and \`replace_text\`; only a whole \`..\` segment or brace alternative is refused. (Brackets remain a character class, as in any glob.)`

**Verify**: `npm run check` → exit 0, `fail 0`.

## Test plan

- New: 3 unit tests (`isSafeGlobSyntax`), 2 tool tests (named-file search
  hits only the named file; `find_files` accepts `[...slug]`).
- Pattern: `glob.test.ts` `describe('globEntries')` for the unit style;
  `TC-FUNC-072` and the boundary-walk test at `tools.test.ts:199` for the
  `_meta.matches` / `_meta.results` assertions.
- Existing coverage that must stay green: `'read accepts legal file names containing .. ; and backtick'`
  (`tools.test.ts:63`), every `find_files` and `replace_text` test, and
  `'find_files and search_text match a slash-free glob at any depth'`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "includes('..')" src/core/glob.ts` → no match
- [ ] `grep -n "ponytail" src/tools/search-text.ts` → no match
- [ ] `grep -c "explicitFile" src/core/search.ts` ≥ 3 and `src/tools/search-text.ts` ≥ 2
- [ ] The five new tests pass; reverting `src/core/glob.ts` alone fails the first unit test and the `find_files` test; reverting `src/core/search.ts` + `src/tools/search-text.ts` alone fails the named-file test
- [ ] CHANGELOG updated; `npx prettier --check .` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Node's `fs.glob` accepts a pattern the unit test accepts but a **literal**
  file name test (`docs/v1..2.md`) returns nothing — report; do not fall back
  to escaping.
- `guardedEntries` or the match loop reads `entry.dirent` anywhere (it does
  not at `4d751c94`; if it does now, the stub dirent may be wrong).
- Any `replace_text` test changes outcome after step 2 — a pattern it relied
  on being refused is now accepted; report which.

## Maintenance notes

- `TRAVERSAL_DOTDOT_RE` and `schema.ts`'s `hasTraversalSegment` express the
  same rule for globs and paths respectively; if one changes, change both.
- `explicitFile` is the only place `searchContent` skips the walk. Plan 045
  (search perf) restructures the per-file scan; it must keep the
  `singleEntry` branch feeding the same loop.
- Deferred: none. `replace_text` already does the right thing
  (`resolveSearchRoot` in `src/tools/replace-text.ts:434-455` returns
  `singleFile` and bypasses the glob) — this plan brings `search_text` to
  parity with it.
