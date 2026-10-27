# Scan owner implementation plan (PR 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Scan one owner, `src/core/scan.ts`, and move `find_files`,
`search_text`, `replace_text` and `list` onto it with one entry policy:
sensitive entries leave no trace; every other entry the scan cannot use,
including an unreadable directory, is counted in `skippedInaccessible`;
results come back in walk order; one stop rule.

**Architecture:** `PathGuard.entryVerdict` rules on a walked entry without
throwing. `globEntries` reports each directory it descends into, once,
through a new `onDirectory` hook, so `scan.ts` can probe it with `opendir`.
Node's `fs.glob` turns a failed readdir into an empty list, so a probe is the
only way to see an unreadable directory. `scan(scope, options, onEntry)` owns
the walk options, the verdicts, the probes, the concurrent dispatch, the walk
order, the stop rule and the counters. Tools supply only `onEntry`.
`scan.ts` has its own dispatch loop. `processEntriesConcurrently` and
`resolveStopReason` stay in `concurrency.ts` until Task 7 removes their last
caller, and Task 7 then deletes them.

**Tech Stack:** TypeScript (Node ESM, `.ts` imports), Node built-in test
runner, `node:fs/promises` `glob` and `opendir`.

**Spec:** `docs/adr/005-one-scan-rule-for-every-walking-tool.md` and the
**Scan** entry in `GLOSSARY.md`. Both come from the 2026-10-27 grilling of
candidate 1 of that day's architecture review.

## Design

These decisions are settled. Do not reopen them. PR 2 covers the content
verdict (`readText`: binary, undecodable, too large). PR 3 covers the input
alignment (`maxDepth` base, `maxMatches`, the 20000 cap and the tool
descriptions). Neither belongs in this PR.

| Case                                            | Walked entry                         | Named file (`explicitFile`)           |
| :---------------------------------------------- | :----------------------------------- | :------------------------------------ |
| Sensitive (lexical or by realpath)              | dropped, never counted               | call fails (guard's error)            |
| Out of root, missing, denied, PERMISSION_DENIED | `skippedInaccessible++`              | call fails                            |
| Directory the walk descends into but can't read | `skippedInaccessible++`, once        | n/a                                   |
| Scope root that can't be read                   | `skippedInaccessible++`              | n/a                                   |
| `onEntry` throws (not an abort)                 | `skippedInaccessible++`              | call fails (rethrown)                 |
| `onEntry` rejects while the signal is aborted   | not counted; the stop is `'timeout'` | resolves `{ results: [], 'timeout' }` |
| Symlinked file with `onlyFiles: true`           | not yielded (unchanged; now stated)  | followed (unchanged)                  |

**Stop rule:**

- The signal is checked first. Once it has aborted, the stop is
  `'timeout'`, even if the cap was also reached. This reverses
  `resolveStopReason`.
- `'maxResults'` applies only when one of these is true:
  - the walk yields another entry after the weighted total reached `cap`;
  - the weighted total went past `cap`.
- `'maxFiles'` applies only when a usable entry was refused because
  `maxEntries` usable entries had already started.
- Skipped entries count toward neither `cap` nor `maxEntries`.
- A pre-aborted signal resolves with `'timeout'`. It never rejects.

**Order:** `results` come back sorted by walk index, whatever order the
`onEntry` calls finish in.

**Scope signal:** `resolveScanScope` takes an optional signal. Only
`search_text` passes one, as it does today. `find_files`, `replace_text` and
`list` resolve their scope without the deadline, so a call whose deadline has
already passed reaches `scan` and gets a partial `'timeout'` result rather
than a `TIMEOUT` error from `fs.stat`.

## Global Constraints

- `npm run check` passes after every task's commit.
- `__tests__/contract.test.ts.snapshot` stays unchanged. Never run
  `--test-update-snapshots` for this work. No tool description or input
  schema changes.
- `skipIgnored` stays the one exclusion flag (ADR-001). `scan` derives it as
  `!includeIgnored`.
- The move-protection walk (`src/tools/move.ts:505`) and undo's walks are
  not Scans. Leave them untouched. `onDirectory` stays optional, and they do
  not pass it.
- Output field names stay as they are: `skippedInaccessible`,
  `filesScanned`, `stoppedReason`, `truncated`. `replace_text` and `list`
  gain an optional `skippedInaccessible`, omitted when it is 0.
- Tools that return text (`find_files`, `search_text`, `replace_text`,
  `list`) put their structured result under `result._meta`. Tests read
  `_meta`, never `structuredContent`.
- Do not touch the versions in `package.json`, `server.json`,
  `mcpb/manifest.json`, `.codex-plugin/plugin.json` or
  `.cursor-plugin/plugin.json`.
- Tests that need an unreadable path skip with
  `if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('needs POSIX directory permissions as non-root');`.
  Restore the mode in `finally`. Verify them once in WSL with fixtures in
  `/tmp`. Node there comes from nvm: run a script file that starts with
  `source ~/.nvm/nvm.sh`, through `wsl -- bash /mnt/c/<path>/script.sh`.
- Work on branch `refactor/scan-owner`.

## Review Focus

1. **Sensitive misread as inaccessible.** A symlink inside the root whose
   target is `.env` must return `'sensitive'`. If it returned
   `'inaccessible'`, the count would reveal the file. Covered by Task 1 row
   `link-to-env`, the only row that reaches the realpath branch.
2. **Abort while `onEntry` runs.** A rejection that arrives while the signal
   is aborted must not be counted or turned into a failure row. The call
   must still return a partial result with `'timeout'`. Covered by Task 3
   `abort mid-entry` and `named file abort resolves as timeout`, and by
   Task 6's required runs of the replace timeout tests.
3. **A directory pruned for being sensitive or ignored is never probed**,
   and **no directory is probed twice** when `includeHidden` adds pattern
   variants. Covered by Task 2's two tests.
4. **A replace write that fails after it started** stays a failure row and
   is never counted as inaccessible. Covered by the existing GUARD-009 at
   `guards.test.ts:285`; Task 6 keeps it green.
5. **The literal prefix of a pattern.** For a pattern like
   `locked/**/*.ts`, `fs.glob` never hands `locked` to `exclude`, so the
   scan cannot see that it is unreadable. This is a known limit. Mark it in
   `scan.ts` with
   `// shortcut: a pattern's literal prefix dir is not probed; probe it if clients scope by prefix`.
   Task 3 `unreadable root counted` pins the probe of the scope root.

---

### Task 1: `PathGuard.entryVerdict`

**Files:**

- Modify: `src/core/path.ts:351-363`. Add `entryVerdict` and make
  `isEntryAccessible` a one-line wrapper.
- Test: `__tests__/entry-verdict.test.ts` (new)
- Commit too: `GLOSSARY.md` and
  `docs/adr/005-one-scan-rule-for-every-walking-tool.md`. Both are already
  written.

**Interfaces:**

- Produces:
  - `export type EntryVerdict = 'ok' | 'sensitive' | 'inaccessible';` in
    `src/core/path.ts`
  - `PathGuard.entryVerdict(entryPath: string): Promise<EntryVerdict>`
  - `isEntryAccessible(p)` stays as `(await this.entryVerdict(p)) === 'ok'`

- [ ] **Step 1: Write the failing table test.** Use `makeGuard([root])`
      from `__tests__/helpers.ts`. Run one `it` per row. Skip a symlink row when
      the symlink cannot be created, as `trySymlink` does in `tools.test.ts`.

| Row                | Fixture                                  | Expected         |
| :----------------- | :--------------------------------------- | :--------------- |
| `plain`            | `root/a.txt`                             | `'ok'`           |
| `env`              | `root/.env`                              | `'sensitive'`    |
| `uppercase-env`    | `root/.ENV` (lexical case fold)          | `'sensitive'`    |
| `link-to-env`      | `root/link` → `root/.env`                | `'sensitive'`    |
| `outside`          | `root/out` → a file in a second temp dir | `'inaccessible'` |
| `missing`          | `root/gone.txt` (never created)          | `'inaccessible'` |
| `dangling`         | `root/d` → `root/nowhere`                | `'inaccessible'` |
| `dangling-outside` | `root/x` → `<second temp dir>/missing`   | `'inaccessible'` |

Add one more test: `isEntryAccessible` returns `true` only for `plain`.

- [ ] **Step 2: Run.** `npm test -- --test-name-pattern="entryVerdict"`.
      Expected: FAIL, `entryVerdict is not a function`.
- [ ] **Step 3: Implement `entryVerdict`** next to `isEntryAccessible`.
  1. Return `'sensitive'` when `isSensitive` holds for the path as given or
     for its `normalizePath` form.
  2. Otherwise run `validateExistingPathDetailed`. A run that succeeds is
     `'ok'`.
  3. On `ACCESS_DENIED`, `realpath` the entry inside its own `try`. Return
     `'sensitive'` when the real path is sensitive. Return `'inaccessible'`
     when it is not, or when the `realpath` itself throws. Both the denylist
     and the out-of-root check throw `ACCESS_DENIED`, so the code alone
     cannot tell them apart.
  4. Any other code in `SKIPPABLE_FS_CODES`, or `isSkippableErrno`, gives
     `'inaccessible'`.
  5. Rethrow everything else, as `isEntryAccessible` does today.
- [ ] **Step 4: Run.** The same command passes, and so does
      `npm test -- --test-name-pattern="sensitive"`.
- [ ] **Step 5: Commit.**
      `feat(path): rule on a walked entry without throwing`. Include
      `GLOSSARY.md` and the ADR.

### Task 2: `globEntries` reports the directories it descends into

**Files:**

- Modify: `src/core/glob.ts:428-450`. Add the option.
- Modify: `src/core/glob.ts:583-658` (`createWalkFilter`). Call the hook from
  `prune`, deduplicated.
- Modify: `src/core/glob.ts:688-698`. Delete the dead `try/catch` around
  `fsGlob(...)`. It can only throw on argument validation, and the arguments
  are fixed.
- Test: `__tests__/glob.test.ts`

**Interfaces:**

- Produces: `GlobEntriesOptions.onDirectory?: (absolutePath: string) => void`.
  - It is called once per directory that `prune` lets the walk descend into,
    including a directory at the `maxDepth` bound. That directory is still
    read; only its children are pruned.
  - It is not called for directories pruned as excluded, sensitive or past
    the bound. It does not receive `cwd` itself.
  - `fs.glob` calls `exclude` once per pattern variant, and `includeHidden`
    adds variants. `createWalkFilter` therefore keeps a `Set<string>` of the
    paths it has reported and reports each one only once.

- [ ] **Step 1: Write failing tests** in `glob.test.ts`.
  - `onDirectory reports each descended dir once, whatever the pattern`:
    - Fixture: `a/b/f.ts` and `c/h.txt`.
    - Call it twice, both with pattern `'*.ts'` and `baseNameMatch: true`:
      once with `includeHidden: false` and once with `includeHidden: true`.
    - For each call, assert that the raw call list has no duplicates, that
      its sorted contents equal `[a, a/b, c]` as absolute paths, and that
      only `f.ts` is yielded.
  - `onDirectory skips pruned dirs`:
    - Fixture: `node_modules/x/y.ts`, `vault.key/k.txt` (the default
      denylist matches `*.key`) and `deep/1/2/z.ts`.
    - Call with pattern `'**/*'`, `skipIgnored: true`, `pathGuard` and
      `maxDepth: 1`.
    - Assert that `deep` and `deep/1` are reported, and that
      `node_modules`, `node_modules/x`, `vault.key` and `deep/1/2` are
      never reported.
- [ ] **Step 2: Run.** `npm test -- --test-name-pattern="onDirectory"`.
      Expected: FAIL.
- [ ] **Step 3: Implement.** In `prune`, after every exclusion check has
      passed for a directory match, call `onDirectory?.(absoluteOf(match))`
      before returning `false`. Skip the call if the path is already in the
      filter's reported set.
- [ ] **Step 4: Run.** The filtered run passes, and so does
      `npm test -- --test-name-pattern="glob"`.
- [ ] **Step 5: Commit.**
      `feat(glob): report each directory a walk descends into`

### Task 3: `scan.ts`

**Files:**

- Create: `src/core/scan.ts`. It has its own dispatch loop, adapted from
  `processEntriesConcurrently` (`concurrency.ts:117-194`) to follow the stop
  rule in § Design. Leave `concurrency.ts` as it is; Task 7 trims it.
- Test: `__tests__/scan.test.ts` (new)

**Interfaces:**

- Consumes: `PathGuard.entryVerdict` (Task 1) and
  `GlobEntriesOptions.onDirectory` (Task 2).
- Produces:

```ts
export interface ScanScope {
  readonly root: string;
  /** A file the client named: no walk, and any error on it fails the call. */
  readonly explicitFile?: string;
}
export function resolveScanScope(
  path: string | undefined,
  fs: GuardedFileSystem,
  options: { readonly signal?: AbortSignal; readonly allowFile: boolean },
): Promise<ScanScope>;

export interface ScanEntry {
  readonly path: string;
  readonly type: EntryType; // from path-utils resolveEntryType
  readonly index: number; // walk order
}
export interface ScanOptions<R> {
  readonly pathGuard: PathGuard;
  readonly pattern: string;
  readonly baseNameMatch: boolean;
  readonly includeHidden: boolean;
  readonly includeIgnored: boolean;
  readonly onlyFiles: boolean;
  readonly maxDepth?: number; // 0-based, as globEntries takes it
  readonly concurrency: number;
  readonly cap?: number;
  readonly weigh?: (result: R) => number; // default 1 per defined result
  readonly maxEntries?: number;
  readonly signal?: AbortSignal;
  readonly onScanned?: (scanned: number) => void; // after each onEntry resolves
}
export interface ScanOutcome<R> {
  readonly results: readonly R[]; // walk order; undefined returns dropped
  readonly scanned: number; // entries whose onEntry resolved
  readonly skippedInaccessible: number;
  readonly stoppedReason?: StoppedReason; // from concurrency.ts
}
export function scan<R>(
  scope: ScanScope,
  options: ScanOptions<R>,
  onEntry: (entry: ScanEntry) => Promise<R | undefined>,
): Promise<ScanOutcome<R>>;
```

- [ ] **Step 1: Write failing tests** in `scan.test.ts`. Use
      `createTestRoot` and `makeGuard`. Every test starts from these options,
      and states only what it overrides: `pattern: '**/*'`,
      `baseNameMatch: false`, `includeHidden: true`, `includeIgnored: false`,
      `onlyFiles: true`, `concurrency: 4`. `onEntry` returns `entry.path`
      unless a test says otherwise. Assert on paths relative to the root.
  - `sensitive leaf is never counted`: given `a.txt` and `.env`, assert
    `results` is `[a.txt]` and `skippedInaccessible` is `0`.
  - `unreadable directory is counted once` (POSIX skip):
    - Fixture: `ok/a.txt` and `locked/b.txt`, then `chmod(locked, 0o000)`.
    - Assert that `results` is `[ok/a.txt]`, that
      `skippedInaccessible === 1`, and that `stoppedReason` is `undefined`.
  - `unreadable root counted` (POSIX skip): `chmod(root/sub, 0o300)`, then
    scan `{ root: sub }`. Assert `skippedInaccessible === 1` and that
    `results` is empty.
  - `out-of-root link is counted, not followed`:
    - Override `onlyFiles: false`.
    - The fixture is `root/out`, a symlink to a file in another temp dir.
    - Assert `skippedInaccessible === 1` and that `out` is not in
      `results`.
  - `symlinked file is not yielded with onlyFiles`: a link `root/l` to
    `root/a.txt` gives `results` of `[a.txt]` and
    `skippedInaccessible === 0`.
  - `onEntry error counts the entry`: have `onEntry` throw
    `new Error('boom')` for `b.txt`. Assert that `results` lacks `b.txt` and
    `skippedInaccessible === 1`.
  - `results come back in walk order`:
    - Fixture: 8 files.
    - `onEntry` sleeps `(8 - index) * 5` ms.
    - Assert that `results` matches the order of a second run whose
      `onEntry` does not sleep.
  - `onScanned counts each resolved entry`: over 3 files, the calls are
    `[1, 2, 3]` and `scanned === 3`.
  - `exact cap is not truncation`: 3 files with `cap: 3` give 3 results and
    no `stoppedReason`. 4 files with `cap: 3` give `stoppedReason`
    `'maxResults'`.
  - `weight past the cap is truncation`: 1 file with `cap: 2` and
    `weigh: () => 3` gives `stoppedReason` `'maxResults'`.
  - `skipped entries spend neither cap nor maxEntries`:
    - Fixture: `.env`, `.npmrc`, `a.txt`, `b.txt`.
    - With `maxEntries: 2`, assert 2 results and no `stoppedReason`.
    - Add `c.txt` and run again: `stoppedReason` is `'maxFiles'`.
  - `abort beats cap`: `cap: 1` over 3 files, with an `onEntry` that aborts
    the controller after the first result. Assert
    `stoppedReason === 'timeout'`.
  - `abort mid-entry`:
    - `onEntry` awaits a promise that rejects with the signal's reason once
      the controller aborts.
    - Assert that the call resolves, not rejects, with
      `stoppedReason === 'timeout'` and `skippedInaccessible === 0`.
  - `pre-aborted signal resolves as timeout`: assert `results` is empty and
    `stoppedReason` is `'timeout'`.
  - `named file errors fail the call`:
    - `{ root, explicitFile: root/.env }` rejects with `FsError`
      `ACCESS_DENIED`.
    - `{ root, explicitFile: root/a.txt }` with an `onEntry` that throws
      rejects with that same error.
  - `named file abort resolves as timeout`: `{ root, explicitFile: root/a.txt }`
    with an `onEntry` that aborts the controller and then throws the
    signal's reason. Assert that the call resolves with empty `results` and
    `stoppedReason === 'timeout'`.
  - `resolveScanScope`: a file with `allowFile: false` rejects with
    `NOT_DIRECTORY`. With `allowFile: true` it returns
    `{ root: dirname, explicitFile }`. A directory returns `{ root }`.
- [ ] **Step 2: Run.** `npm test -- --test-name-pattern="scan"`. Expected:
      FAIL, module not found.
- [ ] **Step 3: Implement `scan.ts`.**
  - **Scope.** `resolveScanScope` is `resolveSearchScope`
    (`search.ts:709-731`), with these changes:
    - `basePath` is renamed `root`;
    - `signal` is optional and forwarded to `fs.stat` only when given;
    - with `allowFile: false`, a file throws `NOT_DIRECTORY`.
  - **Walk.** `scan` builds the `globEntries` options in one place:
    - `skipIgnored: !includeIgnored`;
    - `ignoreCeiling: pathGuard.allowedRootContaining(root)` when it is
      defined;
    - `pathGuard`;
    - `suppressErrors: true`;
    - `signal` only when it is defined;
    - `onDirectory`, which queues a probe.
  - **Probes.** Probe the root and each reported directory with
    `opendir(dir)` followed by `close()`. Run the probes on the same
    concurrency pool. A failure that `isSkippableErrno` matches counts
    `skippedInaccessible`.
  - **Entries.** Each walked entry gets `entryVerdict`:
    - `'sensitive'` is dropped;
    - `'inaccessible'` is counted;
    - `'ok'` is dispatched to `onEntry`.
  - **Errors from `onEntry`.** When `onEntry` rejects:
    - if the signal has aborted, nothing is counted and the stop becomes
      `'timeout'`;
    - otherwise the entry is counted in `skippedInaccessible`.
  - **Progress.** After each `onEntry` resolves, increment `scanned` and
    call `onScanned(scanned)`.
  - **Storage.** Keep results in a `Map<index, R>` and return them sorted.
  - **Named file.** With `explicitFile`:
    1. Call `validateExistingPath`. Its errors fail the call.
    2. Call `onEntry` once with
       `{ path: explicitFile, type: 'file', index: 0 }`.
       `resolveScanScope` already proved that it is a file.
    3. If `onEntry` rejects while the signal is aborted, resolve with
       `{ results: [], scanned: 0, skippedInaccessible: 0, stoppedReason: 'timeout' }`.
       Rethrow any other error.
  - **Stop rule.** Follow § Design.
  - Add the literal-prefix `shortcut:` comment from Review Focus item 5.
- [ ] **Step 4: Run.** The filtered run passes. Then run the POSIX tests in
      WSL with fixtures in `/tmp` and confirm that they ran and were not
      skipped.
- [ ] **Step 5: Commit.** `feat(core): give the Scan one owner`

### Task 4: `find_files` on `scan`

**Files:**

- Modify: `src/tools/find-files.ts:43-60` and `:79-147`.
  - Replace the derived `SearchFilesPageMetadata` type (`:57-60`) with an
    explicit one:
    `interface SearchFilesPageMetadata { readonly root: string; matched: number; filesScanned: number; truncated: boolean; skippedInaccessible: number; stoppedReason?: StoppedReason }`.
  - Widen `SearchFilesOutput.stoppedReason` (`:52`) to `StoppedReason`.
- Modify: `src/core/search.ts:600-707`. Delete `searchFiles`. Once `scan`
  exists it would be only a `scan` call plus a sort, a pass-through. Leave
  its imports that `searchContent` still uses.
- Modify: `__tests__/core-fs.test.ts:836-856`. Move these sort-by-name and
  sort-by-path cases into `__tests__/tools.test.ts` as `find_files` calls
  through `harness.client.callTool`, with the same assertions.
- Modify: `__tests__/core-fs.test.ts:912-925`. Delete only the
  `searchFiles` half. The Task 3 test `pre-aborted signal resolves as
timeout` covers it. The `searchContent` half stays for Task 5.

**Interfaces:**

- Consumes: `resolveScanScope(requestedBasePath, ctx.fs, { allowFile: false })`
  with no signal, and `scan` with:
  - `pattern: args.pattern`
  - `onlyFiles: true`
  - `baseNameMatch: true`
  - `cap: MAX_SEARCH_RESULTS`
  - `concurrency: PARALLEL_CONCURRENCY`
  - `signal: ctx.signal`
- Produces the same output fields:
  - `filesScanned` and `matched` are `results.length`.
  - `truncated` is `stoppedReason !== undefined`.
  - Sorting by name or by path happens after `scan`, on the kept results.

- [ ] **Step 1: Write a failing wiring test** in `tools.test.ts`:
      `find_files counts an unreadable directory` (POSIX skip). Fixture
      `locked/x.ts` with `locked` at `0o000`, plus `a.ts`. Assert that
      `_meta.skippedInaccessible === 1`, that the text matches
      `/1 inaccessible file/`, and that the results are `[a.ts]`.
- [ ] **Step 2: Run** it. Expected: FAIL, with `skippedInaccessible`
      undefined.
- [ ] **Step 3: Implement** the move described above.
- [ ] **Step 4: Run.** `npm test -- --test-name-pattern="find_files"` and
      `npm test -- --test-name-pattern="sensitive files never surface"` both
      pass, and so does `npm run check:static`.
- [ ] **Step 5: Commit.** `refactor(find_files): scan through the Scan owner`

### Task 5: `search_text` on `scan`

**Files:**

- Modify: `src/core/search.ts:333-393`.
  - `FileScan` loses `'sensitive'`.
  - `scanFile`'s catch loses the `startsWith('Sensitive file')` sniff and
    rethrows, so `scan` counts the entry.
  - Its per-file match loop collects up to `maxResults + 1` matches
    (`if (matches.length > scanCtx.maxResults) break;`). A file with more
    matches than the cap then weighs past it and reports `'maxResults'`.
  - The content verdicts at `:361-426` stay as they are, since PR 2 covers
    them.
- Modify: `src/core/search.ts:305-331` and `:454-588`.
  - Widen `SearchContentOutcome.summary.stoppedReason` (`:329`) to
    `StoppedReason`.
  - `searchContent` takes a `ScanScope` in place of `directory` plus
    `explicitFile`.
  - Its loop becomes
    `scan(scope, { …, cap: maxResults, weigh: (s) => s.kind === 'scanned' ? s.matches.length : 0 }, (e) => scanFile(e.path, scanCtx))`.
  - Its tally (`:537-564`) reads `outcome.results` and takes
    `skippedInaccessible` from the outcome.
  - Its stop resolution (`:566-569`) becomes `outcome.stoppedReason`.
  - Trim the matches to `maxResults`, as it does today.
- Modify: `src/tools/search-text.ts:75` and `:206-212`.
  - Widen `stoppedReason` to `StoppedReason`.
  - Use
    `resolveScanScope(args.path, ctx.fs, { signal: ctx.signal, allowFile: true })`.
  - Leave `resolveSearchScope` in `search.ts`; `replace_text` uses it until
    Task 6.
- Modify every `searchContent(` call in `__tests__/core-fs.test.ts`,
  `__tests__/search-literal.test.ts` and `__tests__/tools.test.ts`. Find them
  with `grep -n "searchContent(" __tests__`.
  - A call that passes `explicitFile` moves it into the scope:
    `searchContent({ root, explicitFile: file }, pattern, { …rest }, guard)`.
  - Every other call passes `{ root: dir }`.

**Interfaces:**

- Consumes: `scan` and `resolveScanScope` (Task 3).
- Produces:
  `searchContent(scope: ScanScope, pattern: string, options: Omit<SearchContentOptions, 'explicitFile'>, pathGuard: PathGuard): Promise<SearchContentOutcome>`.

- [ ] **Step 1: Write failing tests.**
  - `search_text counts an unreadable directory` (POSIX skip): the Task 4
    fixture, with `searchPattern` matching `a.ts`. Assert
    `_meta.skippedInaccessible === 1`.
  - `search_text on a named unreadable file fails the call` (POSIX skip):
    `path: 'b.txt'` with `b.txt` at `0o000` gives `isError === true`. Today
    `fs.stat` succeeds, `open` fails, and the result comes back empty with
    `skippedInaccessible: 1`.
- [ ] **Step 2: Run** both. Expected: FAIL.
- [ ] **Step 3: Implement** the changes listed above.
- [ ] **Step 4: Run.** `npm test -- --test-name-pattern="search"` passes.
      These existing tests must stay green:
  - the cap test at `tools.test.ts:3830`;
  - the per-file cap test at `:3849`;
  - the engine-cut test at `:3988`;
  - `search-literal.test.ts:120`.
- [ ] **Step 5: Commit.** `refactor(search_text): scan through the Scan owner`

### Task 6: `replace_text` on `scan`

**Files:**

- Modify: `src/tools/replace-text.ts:34` and `:496`. Use
  `resolveScanScope(args.path, ctx.fs, { allowFile: true })` with no signal.
  Then delete `resolveSearchScope` (`search.ts:709-731`).
- Modify: `src/tools/replace-text.ts:91-101`. Add
  `skippedInaccessible?: number` to `SearchAndReplaceOutput`.
- Modify: `src/tools/replace-text.ts:267-275`. `ReplaceContext` drops
  `summary`.
- Modify: `src/tools/replace-text.ts:342-373`. `readReplacementPlan` returns
  `ReplacementPlan | 'binary' | undefined`, and line `:362` becomes
  `return 'binary'`.
- Modify: `src/tools/replace-text.ts:285-340`. `processEntry` returns
  `Promise<EntryOutcome | undefined>`.
- Modify: `src/tools/replace-text.ts:115-134`, `:460-463` and `:495-565`.
  - Build the summary from `outcome.results` in walk order.
  - The walk setup and the dispatch loop become one `scan` call.
  - Delete the timeout fallback at `:557-563`.
- Modify: the summary text. When `skippedInaccessible` is set, add
  `` ` · ${n} inaccessible skipped` ``, and count it toward `incomplete`.

**Interfaces:**

- Consumes: `scan` and `resolveScanScope` (Task 3), with:
  - `cap: args.maxResults`
  - `weigh: (o) => o.kind === 'changed' ? o.matches : 0`
  - `maxEntries: args.maxFiles`
  - `concurrency: REPLACE_CONCURRENCY`
  - `signal: ctx.signal`
  - `onScanned: (n) => ctx.onProgress({ current: n })`, plus a final
    `ctx.onProgress({ current: outcome.scanned })`
- Produces, internal to `replace-text.ts`:

```ts
type EntryOutcome =
  | { kind: 'changed'; path: string; matches: number; diff?: { original: string; updated: string } }
  | { kind: 'binary' }
  | { kind: 'failed'; path: string; error: unknown };
```

- [ ] **Step 1: Write failing tests.** Read results from `result._meta`.
  - `replace_text counts an unreadable directory` (POSIX skip): the Task 4
    fixture with `dryRun: true`. Assert that
    `_meta.skippedInaccessible === 1`, that the summary has no failure,
    and that the text names `1 inaccessible skipped` without printing
    `no files were searched`.
  - `replace_text counts an EACCES file instead of failing it` (POSIX
    skip): `b.txt` at `0o000` next to a matching `a.txt`. Assert
    `_meta.skippedInaccessible === 1` and `summary.failed === 0`. Today it
    is skipped silently.
  - `replace_text results and diff follow walk order`:
    - Fixture: 12 matching files named `a00.txt` through `a11.txt`, with
      `dryRun: true`.
    - Use `t.mock.method` on `GuardedFileSystem.prototype.open` so that
      opening `a00.txt` waits until every other file has been opened. Today
      that makes `a00.txt` finish last.
    - Assert that the first result path and the first `+++` header in
      `diff` both name `a00.txt`.
  - `replace_text maxFiles ignores skipped entries`:
    - Fixture: `.env`, `a.txt` and `b.txt` all contain the needle.
    - Call with `includeHidden: true` and `maxFiles: 2`.
    - Assert 2 changed files and no `stoppedReason`. Today `.env` spends a
      slot, so the run stops with `'maxFiles'`.
  - `replace_text marks a diff cut by its budget`: `MAX_DIFF_SIZE` is a
    20 KiB constant. Use `a.txt` and `b.txt`, each holding 300 lines that
    contain the needle, so that each patch is over 12 KiB and both together
    exceed 20 KiB. Run with `dryRun: true` and assert `diffTruncated: true`
    and that the kept diff names `a.txt`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`onEntry`.** For live runs, run `processEntry` inside `lockForWrite`,
    as today. Classify an error in this order:
    1. If the signal has aborted, rethrow it, so `scan` stops with
       `'timeout'` and counts nothing.
    2. If the write has not started and the error is a skippable errno or
       carries a code in `SKIPPABLE_FS_CODES`, rethrow it, so `scan` counts
       it.
    3. Any other error, including any error after `write.started`, becomes
       `{ kind: 'failed' }`.
  - **Primary.** Keep the full rewritten content out of `EntryOutcome`. Keep
    the primary in the `onEntry` closure: the lowest-`index` changed file,
    with its path and content.
  - **Diff.** `diff` is set only when `dryRun || returnDiff`. The summary
    pass calls the existing `maybeAppendPatchDiff` for each `'changed'`
    outcome in walk order. That keeps the budget check before
    `unifiedPatch` and the timeout-to-`diffTruncated` handling.
  - **Summary.** Keep only the first `MAX_FAILURES` failures in walk order.
    Count `skippedBinary` from the `'binary'` outcomes.
  - **`filesScanned`.** Set it to `outcome.scanned`.
- [ ] **Step 4: Run.** These must pass:
  - `npm test -- --test-name-pattern="replace_text"`
  - `npm test -- --test-name-pattern="GUARD-009"`
  - the timeout tests at `tools.test.ts:4542-4619`, H1 and both
    `rt-timeout` cases. Each must show `summary.failed === 0` and no
    `isError` on a timeout.
- [ ] **Step 5: Commit.** `refactor(replace_text): scan through the Scan owner`

### Task 7: `list` on `scan`, the leftover loop, then the docs

**Files:**

- Modify: `src/tools/list.ts:84-185`. `collect` calls `scan` with:
  - `onlyFiles: false`, `baseNameMatch: false` and pattern `'**/*'`;
  - `maxDepth: options.maxDepth - 1` (PR 3 removes the shift);
  - `signal: options.signal`;
  - `onScanned: (n) => options.onProgress({ current: n })`.

  `onEntry` keeps the size stat, the totals and the top-K buffer in the
  closure, and returns `undefined`, so `scan` stores nothing. Delete the
  `isEntryAccessible` call, `fatalError` and the `throwIfAborted` at `:175`.
  `collect` returns `skippedInaccessible` and `stoppedReason` alongside the
  totals.

- Modify: `src/tools/list.ts:285-400`.
  - `ListPageMetadata` gains `skippedInaccessible?: number` and
    `stoppedReason?: 'timeout'`.
  - The `paginate` `produce` call uses
    `resolveScanScope(resolvedPath, ctx.fs, { allowFile: false })` with no
    signal, and sets
    `truncated: result.totalEntries > result.entries.length || result.stoppedReason !== undefined`.
  - The externalized full tree carries `stoppedReason` and
    `skippedInaccessible`, and sets `truncated: true` under the same
    condition.
  - The trailer passes both fields. A timeout returns the partial page.
  - The existing `MAX_LIST_ENTRIES` `stoppedReason: 'maxResults'` stays;
    PR 3 changes it. A `'timeout'` takes its place when both apply.
- Modify: `src/core/concurrency.ts`. Delete `processEntriesConcurrently`
  (`:117-194`) and `resolveStopReason` (`:28-34`); `list.ts` was their last
  caller. Keep `StoppedReason`, `withAbort`, `runExclusive` and
  `processInParallel`.
- Modify: `__tests__/concurrency.test.ts:4,6-13`. Delete
  `describe('resolveStopReason')` (`:6-13`) and drop `resolveStopReason`
  from the import at `:4`.
- Modify: `__tests__/tools.test.ts:2610` (TC-FUNC-063a). After the abort,
  assert:
  - `isError` is not `true`;
  - `(result._meta as { stoppedReason?: string }).stoppedReason === 'timeout'`;
  - the text matches `/scan stopped early: hit the time limit/`.

  Delete the stale `structuredContent === undefined` assertion. This test
  depends on the scope being resolved without the signal.

- Modify: `docs/client-guide.md:397-400` and `:412-417`.
  - Add `list` to the paragraph on scans that hit a limit.
  - Move `list` out of the `TIMEOUT`-error sentence and into the
    partial-result sentence.
  - Add one sentence: a scan does not follow a symlinked file, and
    `skippedInaccessible` counts entries and directories it could not read.
- Modify: `CHANGELOG.md` `## [Unreleased]`. Add a `### Changed` heading
  before `### Fixed`, in Keep a Changelog order. Follow the repo format: a
  bold claim, then "Before, …".
  - Under `### Changed`: **`list` returns what it found when it times
    out.** Before, it failed with `TIMEOUT`.
  - Under `### Fixed`: **`find_files`, `search_text`, `replace_text` and
    `list` count the entries and directories they could not read in
    `skippedInaccessible`.** Before, an unreadable folder looked empty, and
    `replace_text` and `list` skipped such entries without a word.
  - Under `### Fixed`: **`replace_text` returns its files and diff in walk
    order.** Before, they came back in a different order from one run to the
    next.
  - Under `### Fixed`: **`search_text` on a file you name but cannot read
    fails with the reason.** Before, it returned an empty result.
- Test: `__tests__/tools.test.ts`

**Interfaces:**

- Consumes: `scan` and `resolveScanScope` (Task 3).

- [ ] **Step 1: Write the failing tests.** Read results from `result._meta`.
  - `list counts an unreadable directory` (POSIX skip):
    - Use `maxDepth: 3` and the Task 4 fixture.
    - Assert that `_meta.skippedInaccessible === 1`, that `locked` itself
      is still listed, and that the text matches `/1 inaccessible file/`.
  - `a timed-out list externalizes a partial tree`:
    - Mock `AbortSignal.timeout` as TC-FUNC-063a does.
    - List a directory with more entries than `maxEntries`.
    - Assert that `_meta.resourceUri` is set and that the resource it names
      carries `stoppedReason: 'timeout'`. If the pre-aborted walk collects
      no entries, abort after a set number of `onProgress` ticks instead.
  - Edit TC-FUNC-063a as listed above.
- [ ] **Step 2: Run.** `npm test -- --test-name-pattern="list"`. Expected:
      FAIL on all three tests.
- [ ] **Step 3: Implement** the changes listed above, then write the docs and
      CHANGELOG entries.
- [ ] **Step 4: Run.** `npm run check` passes. Then run
      `git diff --stat main -- __tests__/contract.test.ts.snapshot`; it must
      print nothing.
- [ ] **Step 5: Commit.**
      `refactor(list): scan through the Scan owner; return partial on timeout`
