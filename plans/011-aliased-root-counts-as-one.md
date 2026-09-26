# Plan 011: A root configured through an alias counts as one root (fixes the red Windows CI job)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 16698cbe..HEAD -- src/core/path.ts src/tools/list-roots.ts src/cli.ts __tests__/helpers.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (plan 007 added the Windows CI job that exposed this)
- **Category**: bug / tests
- **Planned at**: commit `16698cbe`, 2026-09-26

## Why this matters

A root can be configured through an **alias**: a symlink or junction, a
Windows 8.3 short name (`C:\Users\RUNNER~1\…`), or the macOS
`/tmp` → `/private/tmp` link. The guard deliberately allows both spellings
for containment. `resolveAllowedDirectoriesState` puts each root and its
`realpath` into the allowed set, so a single aliased root becomes **two**
entries in `getAllowedDirectories()`.

Two callers use that list to mean "the roots the user configured":

- `resolvePathOrRoot` picks the default root when a tool gets no `path`.
- `list_roots` (and `--print-config`) shows the roots.

So with one aliased root, every tool call without a `path` (`list`,
`find_files`, `search_text`, `replace_text`) fails with
`INVALID_INPUT: Multiple roots configured. Provide an explicit path.`, and
`list_roots` shows the same root twice. This was reproduced through the real
tools with a root given as an 8.3 short path.

The new Windows CI job (plan 007) made this visible. On GitHub's Windows
runner, `os.tmpdir()` returns the 8.3 short path `C:\Users\RUNNER~1\…`, while
`realpath` returns `C:\Users\runneradmin\…`, so every test root is an alias.
That produces 7 failures on `main`:

- 1 (`TC-FUNC-014`, `find_files` without `path`) is this product bug.
- 5 are tests comparing the server's resolved path with the unresolved
  `tmpdir()` spelling:
  - `readEditableText returns validated path…`
  - `TC-FUNC-031` and `TC-FUNC-032` (`statDetailed.isSymlink`, which is
    documented as true whenever any part of the path is aliased; the `stat`
    tool itself corrects this with `lstat`)
  - `TC-ROOTS-002` (counts the allowed set)
  - `TC-FUNC-069` (compares result paths)
- 1 (`TC-FUNC-068`) is also a result-path comparison.

This plan fixes the product bug and makes test roots canonical. The Windows
job should then go green.

## Current state

- `src/core/path.ts` — `PathGuard`.
  - The allowed set is `allowedDirectoriesState` (line 154).
  - `initialize` (lines 184-186) sets it.
  - `getAllowedDirectories` (lines 206-211) returns it.
  - `resolvePathOrRoot` (lines 567-588) reads it to choose the default root.
  - `recomputeAllowedDirectories` (lines 763-814) builds `combined` (the
    configured plus granted roots) and expands it with
    `resolveAllowedDirectoriesState`.
- `resolveAllowedDirectoriesState` (`src/core/path.ts:122-136`) adds each
  root's realpath next to it. **Keep this** — containment needs both
  spellings:

```ts
export async function resolveAllowedDirectoriesState(
  dirs: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const primary = normalizeAllowedDirectories(dirs);
  const reals = await Promise.all(primary.map((dir) => resolveRealPath(dir, signal)));
  return [
    ...new Set(
      primary.flatMap((dir, i) => {
        const real = reals[i];
        return real && !isSamePath(real, dir) ? [dir, real] : [dir];
      }),
    ),
  ];
}
```

`src/core/path.ts:154`, `:184-186`, `:206-211`:

```ts
  private allowedDirectoriesState: string[] | undefined;
```

```ts
  initialize(expanded: readonly string[]): void {
    this.allowedDirectoriesState = normalizeAllowedDirectories(expanded);
  }
```

```ts
  getAllowedDirectories(): string[] {
    if (!this.allowedDirectoriesState) {
      return [];
    }
    return [...this.allowedDirectoriesState];
  }
```

`src/core/path.ts:567-571` (in `resolvePathOrRoot`):

```ts
  resolvePathOrRoot(pathValue: string | undefined): string {
    if (pathValue && pathValue.trim().length > 0) {
      return pathValue;
    }
    const roots = this.getAllowedDirectories();
```

`src/core/path.ts:807-814` (end of `recomputeAllowedDirectories`):

```ts
    const combined = [...baseline, ...grantsToInclude];
    const nextState = await resolveAllowedDirectoriesState(combined, signal);
    // Commit boundaries and the allowed set together, after every await has
    // resolved, so a rejecting recompute leaves the guard's previous,
    // consistent view intact.
    this.rootBoundaries = boundaries;
    this.initialize(nextState);
  }
```

`src/tools/list-roots.ts:30`:

```ts
const dirs = ctx.fs.pathGuard.getAllowedDirectories();
```

`src/cli.ts:214` (`--print-config`):

```ts
const allowedRoots = pathGuard.getAllowedDirectories();
```

`__tests__/helpers.ts:11` and `:33-35`:

```ts
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
```

```ts
export async function createTestRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fsmcp-test-'));
}
```

`makeGuard` in `__tests__/helpers.ts:86-90` calls
`guard.initialize(await resolveAllowedDirectoriesState(dirs))` with one
argument. It must keep working unchanged.

**Callers that must keep using `getAllowedDirectories()`** because they do
containment and need both spellings:

- `precheckAccess`
- `applyGrant`'s verification
- `isAllowedRoot`, so deleting a root is refused under either spelling
- the symlink ancestor walk
- `src/core/path-completer.ts`

Do not change any of them.

**What was verified while planning** (on a scratch copy with this plan's
changes, Windows, Node 24.15.0):

| run                                         | before            | after  |
| ------------------------------------------- | ----------------- | ------ |
| full suite, normal `TEMP`                   | 0 fail            | 0 fail |
| full suite, `TEMP` set to an 8.3 short path | **7 fail** (= CI) | 0 fail |
| new `aliased-root.test.ts` (junction alias) | 2 fail            | 2 pass |

## Commands you will need

| Purpose      | Command                                      | Expected on success |
| ------------ | -------------------------------------------- | ------------------- |
| Install      | `npm ci`                                     | exit 0              |
| Typecheck    | `npm run type-check:test`                    | exit 0              |
| New test     | `node --test __tests__/aliased-root.test.ts` | 2 pass              |
| All tests    | `npm test`                                   | 0 fail              |
| Format files | `npx prettier --write <files>`               | exit 0              |
| Full gate    | `npm run check`                              | exit 0              |

**Reproducing CI's 8.3 temp path locally (Windows only).** This works only
where 8.3 names are enabled. Check with `fsutil 8dot3name query C:`; it says
"8dot3 name creation is ENABLED" by default. In PowerShell:

```powershell
$d = Join-Path $env:TEMP 'longnamedirectory83'
New-Item -ItemType Directory -Force $d | Out-Null
$short = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($d).ShortPath
$short   # must contain a '~', e.g. C:\Users\you\AppData\Local\Temp\LONGNA~1
$env:TEMP = $short; $env:TMP = $short; npm test; Remove-Item Env:TEMP, Env:TMP
```

If `$short` has no `~`, 8.3 names are disabled on that volume. Skip the 8.3
runs and say so in the report. The junction-based test covers the same code
path on every OS.

## Scope

**In scope**:

- `src/core/path.ts`: add a `rootsState` field and `getRoots()`, add a second
  parameter to `initialize`, make one change in `resolvePathOrRoot`, and make
  one change in `recomputeAllowedDirectories`.
- `src/tools/list-roots.ts`: one line.
- `src/cli.ts`: one line.
- `__tests__/helpers.ts`: `createTestRoot` returns a realpath.
- `__tests__/aliased-root.test.ts` (create).

**Out of scope**:

- `resolveAllowedDirectoriesState`, and every containment caller listed above.
- `validateExistingPathDetailed`'s `isSymlink` semantics. They are documented
  ("true whenever ANY ancestor is a symlink"), and `src/tools/stat.ts`
  corrects them with `lstat`.
- The tests that failed on CI (`core-fs.test.ts`, `tools.test.ts`,
  `roots-seeding.test.ts`). They go green through the `createTestRoot` fix,
  and their assertions stay as they are.
- `src/core/path-completer.ts`. Duplicate completions for an aliased root are
  harmless.

## Git workflow

- Branch: `advisor/011-aliased-root-counts-as-one` from `main`.
- Make two commits, each ending with a `Co-Authored-By:` trailer naming your
  model:
  1. `fix(path): count a root reached through an alias once`, containing the
     `src/` changes and `__tests__/aliased-root.test.ts`.
  2. `test: resolve test roots to their real path`, containing
     `__tests__/helpers.ts`.
- Do NOT push unless the operator says so.

## Steps

### Step 1: Write the failing regression test

Create `__tests__/aliased-root.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  type TestClientContext,
  trySymlink,
} from './helpers.ts';

// A root configured through an alias (a symlink or junction, a Windows 8.3
// short name, macOS /tmp -> /private/tmp) is ONE root. The guard also allows
// its realpath for containment, but a caller choosing "the root" must see one.
describe('a root configured through an alias', () => {
  let base: string;
  let alias: string;
  let harness: TestClientContext | undefined;

  before(async () => {
    base = await createTestRoot();
    const real = join(base, 'real-root');
    await mkdir(real);
    await writeFile(join(real, 'alias-probe.txt'), 'ALIASNEEDLE');
    alias = join(base, 'alias-root');
    if (!(await trySymlink(real, alias, () => undefined))) return;
    harness = await createTestClientPair([alias]);
  });

  after(async () => {
    await harness?.close();
    await cleanupTestRoot(base);
  });

  it('lists as one root', async (t) => {
    if (!harness) return t.skip('symlink not permitted');
    const result = await harness.client.callTool({ name: 'list_roots' });
    const roots = (result.structuredContent as { roots: string[] }).roots;
    assert.strictEqual(roots.length, 1, JSON.stringify(roots));
  });

  it('is the default path for tools called without one', async (t) => {
    if (!harness) return t.skip('symlink not permitted');
    for (const [name, args] of [
      ['find_files', { pattern: '**/*.txt' }],
      ['list', {}],
      ['search_text', { searchPattern: 'ALIASNEEDLE' }],
    ] as const) {
      const result = await harness.client.callTool({ name, arguments: args });
      assert.notStrictEqual(result.isError, true, `${name}: ${firstTextBlock(result).text ?? ''}`);
      assert.match(firstTextBlock(result).text ?? '', /alias-probe\.txt/u, name);
    }
  });
});
```

`trySymlink` creates a junction on Windows, which needs no admin rights, and
a directory symlink elsewhere.

**Verify**: `node --test __tests__/aliased-root.test.ts` → **2 fail**. The
first shows `roots.length` 2. The second shows
`Multiple roots configured. Provide an explicit path.` If both pass or both
skip, STOP.

### Step 2: Keep the configured roots next to the expanded allowed set

In `src/core/path.ts`:

1. Below `private allowedDirectoriesState: string[] | undefined;`, add:

   ```ts
     /** One entry per configured or granted root, without the realpath aliases. */
     private rootsState: string[] | undefined;
   ```

2. Replace `initialize` with:

   ```ts
     /**
      * `expanded` is the containment set (each root plus its realpath alias);
      * `roots` is what a caller choosing "the root" sees, one entry per root.
      */
     initialize(expanded: readonly string[], roots: readonly string[] = expanded): void {
       this.allowedDirectoriesState = normalizeAllowedDirectories(expanded);
       this.rootsState = normalizeAllowedDirectories(roots);
     }
   ```

3. Directly below `getAllowedDirectories()`, add:

   ```ts
     /**
      * The roots as configured or granted, one per root. getAllowedDirectories()
      * also holds each root's realpath alias for containment, so an aliased root
      * (symlink, junction, 8.3 short name) appears there twice.
      */
     getRoots(): string[] {
       return this.rootsState ? [...this.rootsState] : [];
     }
   ```

4. In `resolvePathOrRoot`, change `const roots = this.getAllowedDirectories();`
   to `const roots = this.getRoots();`.
5. At the end of `recomputeAllowedDirectories`, change
   `this.initialize(nextState);` to `this.initialize(nextState, combined);`.

**Verify**: `npm run type-check:test` → exit 0.

### Step 3: Show roots, not the containment set

- `src/tools/list-roots.ts`: change
  `const dirs = ctx.fs.pathGuard.getAllowedDirectories();` to
  `const dirs = ctx.fs.pathGuard.getRoots();`.
- `src/cli.ts`: change
  `const allowedRoots = pathGuard.getAllowedDirectories();` to
  `const allowedRoots = pathGuard.getRoots();`.

**Verify**: `node --test __tests__/aliased-root.test.ts` → 2 pass. Then
`npm test` → 0 fail.

Commit 1.

### Step 4: Make test roots canonical

In `__tests__/helpers.ts`, add `realpath` to the `node:fs/promises` import,
and change `createTestRoot` to:

```ts
/** Create an isolated temp directory for a test, as its real path (no 8.3 or symlink alias). */
export async function createTestRoot(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'fsmcp-test-')));
}
```

**Verify**:

- `npm test` → 0 fail.
- Windows with 8.3 names enabled: the short-`TEMP` run from "Commands you
  will need" → 0 fail. Without the fix it gives exactly 7 failures, the ones
  listed in "Why this matters".

Commit 2.

### Step 5: Format and full gate

`npx prettier --write src/core/path.ts src/tools/list-roots.ts src/cli.ts __tests__/helpers.ts __tests__/aliased-root.test.ts`

**Verify**: `npm run check` → exit 0.

## Test plan

- New `__tests__/aliased-root.test.ts`. With a junction or symlink alias as
  the only root:
  - `list_roots` returns 1 root.
  - `find_files`, `list` and `search_text` without `path` succeed and find
    the probe file.
- Existing tests: all of them. The 7 that failed on the Windows runner now
  pass because `createTestRoot` is canonical. `path-guard-grant.test.ts` and
  `roots-seeding.test.ts` cover grants and seeding through `recompute`.
- CI: both jobs green after push. That is the operator's step.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `node --test __tests__/aliased-root.test.ts` → 2 pass. It was 2 fail before Step 2.
- [ ] `grep -n "getRoots()" src/core/path.ts src/tools/list-roots.ts src/cli.ts` → the definition, plus the uses in `resolvePathOrRoot`, `list-roots.ts` and `cli.ts`
- [ ] `grep -n "getAllowedDirectories()" src/core/path.ts` still shows the containment callers (`applyGrant`, `isAllowedRoot`, the ancestor walk)
- [ ] 8.3 short-`TEMP` run → 0 fail, or it is reported as skipped because 8.3 names are disabled
- [ ] `git diff main --stat` lists only the five in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The Step 1 test does not fail on the unfixed code.
- Any existing test fails after Step 3. In particular, a test in
  `path-guard-grant.test.ts` or `roots-seeding.test.ts` asserting on
  `list_roots` output or the default path.
- A caller outside the three named here turns out to choose "the root" from
  `getAllowedDirectories()` (`grep -rn "getAllowedDirectories()" src`). Report
  it rather than switching it.
- The short-`TEMP` run still shows failures after Step 4. Report the test
  names.

## Maintenance notes

- Two lists, two purposes. `getAllowedDirectories()` is the **containment**
  set: roots plus realpath aliases. `getRoots()` is **what the user
  configured**. Any new code that picks, shows or counts roots uses
  `getRoots()`. Any code that checks whether a path is allowed uses
  `getAllowedDirectories()`.
- `initialize`'s second parameter defaults to the first. Test guards built
  with `makeGuard` have no aliases, so for them the two lists are identical.
- `statDetailed().isSymlink` still means "the path is aliased somewhere", not
  "this entry is a link". Renaming it (e.g. to `isAliased`) is a reasonable
  follow-up, but out of scope here.
