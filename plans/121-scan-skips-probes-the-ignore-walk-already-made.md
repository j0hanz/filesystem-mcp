# Plan 121: A scan does not open a directory again just to prove it is readable

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/core/glob.ts src/core/scan.ts __tests__/scan.test.ts __tests__/glob.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (the count of inaccessible directories must not change)
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

`list`, `find_files`, `search_text` and `replace_text` all walk a folder
through one function, `scan`. For each directory the walk does three
separate opens:

1. Before the walk, the `.gitignore` loader reads every non-ignored
   directory to find `.gitignore` files.
2. The walk itself (`fs.glob`) reads every directory again.
3. For every directory, `scan` opens and closes it once more
   (`probeDirectory`), only to learn whether it is readable, so that an
   unreadable directory is counted in `skippedInaccessible` instead of
   vanishing.

The third open is redundant for any directory the first pass already read
successfully. On a tree with tens of thousands of directories that is tens
of thousands of wasted `opendir`/`close` pairs inside the tool's 5-second
default deadline. This plan removes the redundant probe and nothing else. It
starts with a measurement; if the measured saving is small, the plan ends
there.

## Current state

`src/core/glob.ts`, `GitignoreManager.load` (lines 113-170), the pre-walk:

```ts
  static async load(
    root: string,
    includeHidden: boolean,
    signal?: AbortSignal,
    maxDepth?: number,
    ignoreCeiling?: string,
    pathGuard?: Pick<PathGuard, 'isSensitive'>,
  ): Promise<GitignoreManager | null> {
    const resolvedRoot = resolve(root);
    const manager = new GitignoreManager();
    // ...
      let frontier: string[] = [''];
      for (let depth = 0; frontier.length > 0; depth++) {
        // ...
            const absDir = dir === '' ? resolvedRoot : join(resolvedRoot, dir);
            if (!canDescend) {
              const matcher = await readGitignoreMatcher(join(absDir, '.gitignore'), signal);
              if (matcher) manager.addMatcher(dir, matcher);
              return;
            }
            const entries = await fsReaddir(absDir, { withFileTypes: true }).catch(() => undefined);
            if (!entries) return;
```

The doc comment says load returns `null` "when no `.gitignore` was found, so
callers skip the filter entirely". It is called at `src/core/glob.ts:660`
only when ignore rules apply.

The walk reports each directory to the scan (`src/core/glob.ts:639-643`):

```ts
      if (isDir && onDirectory && (maxDepth === undefined || depth < maxDepth)) {
        // ...
          onDirectory(absolute);
```

`src/core/scan.ts:194-202` and `:360-361`:

```ts
  const probes: string[] = [scope.root];
  const probe = async (dir: string): Promise<void> => {
    try {
      if (await probeDirectory(dir, pathGuard, signal)) countInaccessible(dir);
    } catch (error) {
      if (!signal?.aborted) throw error;
      cut = true;
    }
  };
  // ...
    // Runs inside fs.glob's exclude callback, so it only queues.
    onDirectory: (dir) => probes.push(dir),
```

`probeDirectory` (`src/core/scan.ts:427-455`) does `opendir(dir)` then
`handle.close()` and returns `true` when the directory is inaccessible.

GLOSSARY, "Scan": "every other entry it cannot use, including a directory it
could not read, is counted, so a scan with holes never reads as complete."
This must stay true.

Tests: `__tests__/scan.test.ts` already injects directory failures (for
example line 560-575, an `EBUSY` from `opendir`) and asserts
`skippedInaccessible`. `__tests__/glob.test.ts` covers the ignore rules.

## Commands you will need

| Purpose    | Command                                                                                                              | Expected on success |
| :--------- | :------------------------------------------------------------------------------------------------------------------- | :------------------ |
| Build      | `npm run build`                                                                                                      | exit 0              |
| Scan tests | `node --test --test-timeout=60000 __tests__/scan.test.ts __tests__/glob.test.ts`                                     | all pass            |
| Walkers    | `node --test --test-timeout=60000 __tests__/list.test.ts __tests__/find-files.test.ts __tests__/search-text.test.ts` | all pass            |
| Full check | `npm run check`                                                                                                      | exit 0              |

## Scope

**In scope**:

- `src/core/glob.ts` (record which directories the pre-walk read; pass that
  to the walk's `onDirectory` decision)
- `src/core/scan.ts` (only if the skip decision has to live there)
- `__tests__/scan.test.ts` (new tests)
- `plans/README.md`

**Out of scope**:

- Path validation per entry (`pathGuard.entryVerdict`, `reachesRemoteLink`,
  repeated `realpath`). It costs more than the probes, but it is the sandbox
  check; changing it needs a security design, not this plan.
- Replacing `fs.glob` with a custom walker.
- The `.gitignore` pre-walk itself.

## Git workflow

- Branch: `perf/scan-skip-redundant-probes`
- Commits: `test(scan): count directory opens per walk`, then
  `perf(scan): skip the probe for a directory the ignore walk already read`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Measure

Add a test to `__tests__/scan.test.ts` that builds a tree of 30 directories
(3 levels, a few files each, one `.gitignore` at the root), wraps
`fsPromises.opendir` and `fsPromises.readdir` with counting functions (same
`mock.method` + `syncBuiltinESMExports()` pattern the file already uses for
`opendir` failures), runs one `scan` with ignore rules on, and logs the two
counts with `t.diagnostic(...)`.

**Verify**: run it and note the numbers. Expected at the planned commit:
about 31 `opendir` calls from probes (root plus 30) on top of the walk's own
reads. If `opendir` is called fewer than 15 times, the premise is wrong: STOP.

Also time a real walk for the report: create a tree of about 5,000
directories in a temp folder and time `find_files` with pattern `**/*.none`
three times through the tool harness (`__tests__/tool-harness.ts`). Record
the median. Do not commit this timing code.

### Step 2: Write the failing behavior tests

1. **Fewer opens**: with the 30-directory tree, assert the probe `opendir`
   count is at most 1 after the change (write the assertion now; it fails).
2. **Holes still counted**: make one directory fail in the pre-walk's
   `readdir` AND in `opendir` (inject `EACCES` for that path in both mocks).
   Assert `skippedInaccessible === 1`. This passes before and must pass
   after.
3. **A directory that turns unreadable only for the walk**: inject a failure
   for `opendir` only (pre-walk `readdir` succeeds). Record today's result in
   the assertion. After the change this directory is no longer probed; see
   STOP conditions for what to do if today's result is `1`.
4. **No ignore rules** (`includeIgnored: true`): the pre-walk does not run;
   assert probe count is unchanged from Step 1's shape (every directory
   probed).

**Verify**: test 1 FAILS; tests 2 and 4 pass.

### Step 3: Skip the redundant probes

In `GitignoreManager`, add a private `readDirs = new Set<string>()` holding
the absolute path of each directory whose `fsReaddir` succeeded in `load`
(add `manager.readDirs.add(absDir)` right after the `if (!entries) return;`
line), and a method `wasRead(absDir: string): boolean`.

`load` returns `null` when no `.gitignore` exists anywhere, which would lose
the set. Check the end of `load` (below line 166). If it returns `null` in
that case, the skip only applies when a manager is returned; do not change
`load`'s return contract.

At the `onDirectory(absolute)` call site (`src/core/glob.ts:639-643`), skip
the call when the gitignore manager in scope reports `wasRead(absolute)`.
Trace how the manager reaches that function (it is the `gitignoreMatcher`
parameter at line 541) and use it there.

The root: `scan.ts` seeds `probes` with `scope.root` itself. Leave that one
probe in place (hence "at most 1" in test 1).

**Verify**: `node --test --test-timeout=60000 __tests__/scan.test.ts __tests__/glob.test.ts` → all pass, including test 1.

### Step 4: All walkers and full check

**Verify**: the "Walkers" command → all pass.
**Verify**: `npm run check` → exit 0.

Repeat the 5,000-directory timing from Step 1 and put both medians in your
report and in the commit message body.

## Test plan

Four tests in `__tests__/scan.test.ts` (Step 2), modeled on the existing
`opendir`-failure tests in that file.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] Probe `opendir` count on the 30-directory tree is at most 1 with ignore rules on
- [ ] `skippedInaccessible` assertions unchanged for an unreadable directory
- [ ] Before/after timing recorded in the report
- [ ] `plans/README.md` status row updated

## STOP conditions

- Step 1 shows the walk is not dominated by anything this plan touches (the
  5,000-directory timing improves by less than 10% in a quick prototype of
  Step 3). Mark the plan `REJECTED: measured saving below 10%` with the
  numbers.
- Test 3 shows that today a directory readable in the pre-walk but failing
  in `opendir` is counted as inaccessible, and after the change it is not.
  That is a behavior change in the "holes are counted" rule. Stop and report
  both results; the reviewer decides whether the narrower window is
  acceptable.
- `load` returns `null` in the common case (no `.gitignore` in the tree), so
  the skip would rarely apply. Report how often the manager is non-null in
  the repo's own tests.

## Maintenance notes

- The larger win is one walker that reads each directory once and loads
  `.gitignore` as it enters it. `fs.glob`'s `exclude` callback is
  synchronous, which is why the rules are loaded up front today. That
  rewrite is deliberately not planned here.
- Per-entry validation cost on Windows is acknowledged in a `shortcut:`
  comment at `src/core/path.ts:485`.
