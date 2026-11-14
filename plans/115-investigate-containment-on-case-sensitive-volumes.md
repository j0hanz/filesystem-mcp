# Plan 115: Find out whether a case-sensitive volume lets a sibling folder pass as the root

> **Executor instructions**: This is an INVESTIGATION plan. Its product is a
> test that records what happens and a written finding, not a fix. Follow it
> step by step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/core/path-utils.ts src/core/path.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (adds one test; no source change)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

The path guard decides "is this path inside an allowed root?" by string
comparison. On Windows and macOS it lower-cases ASCII letters first, because
those filesystems normally ignore case. The decision is made per platform,
not per volume. But case-sensitive volumes exist on both: macOS APFS can be
formatted case-sensitive, and Windows directories can be switched to
case-sensitive (WSL does this for folders it creates).

On such a volume, `Proj` and `proj` are two different folders. If `Proj` is
an allowed root, the folded comparison says `proj/secret.txt` is inside it.
If that is reachable end to end, a client can read, write and delete in a
folder the operator never allowed. A code reading says it is reachable; it
has not been reproduced. This plan reproduces it or rules it out.

## Current state

`src/core/path-utils.ts:187-192`:

```ts
export const IS_CASE_INSENSITIVE_FS = IS_WINDOWS || platform() === 'darwin';

// ASCII only: JS folds U+212A/U+017F onto k/s, NTFS does not, so a full fold equates a sibling with the root.
export function normalizeCaseForComparison(value: string): string {
  return IS_CASE_INSENSITIVE_FS ? value.replace(/[A-Z]/gu, (c) => c.toLowerCase()) : value;
}
```

`src/core/path-utils.ts:268-280`:

```ts
export function isPathInsideDirectory(
  normalizedDirectory: string,
  normalizedCandidate: string,
): boolean {
  const root = normalizeCaseForComparison(normalizedDirectory);
  const candidate = normalizeCaseForComparison(normalizedCandidate);

  if (root === candidate) return true;
  if (!candidate.startsWith(root)) return false;

  if (isPathSeparator(root.charCodeAt(root.length - 1))) return true;
  return isPathSeparator(candidate.charCodeAt(root.length));
}
```

The guard uses this for the requested path and again for the path
`realpath` returns (`src/core/path.ts`, `validateAccess` and
`validateExistingPathDetailed`, around lines 748 and 874). `realpath`
returns the on-disk spelling, so on a case-sensitive volume it returns
`.../proj/secret.txt`, which still passes the folded check.

Test helpers (`__tests__/helpers.ts`): `createTestRoot()`,
`cleanupTestRoot(dir)`, `makeGuard(...)`, `writeTestFile(root, rel, text)`,
`fsErrorMatcher(code)`. `__tests__/security.test.ts` is the home of guard
escape tests; read its first 110 lines for the structure
(`describe`/`before`/`after`, how a `GuardedFileSystem` is built from a
guard).

Node's test runner supports `it('name', { todo: 'reason' }, fn)`: a failing
`todo` test is reported but does not fail the run.

## Commands you will need

| Purpose    | Command                                                                    | Expected on success |
| :--------- | :------------------------------------------------------------------------- | :------------------ |
| One file   | `node --test --test-timeout=60000 __tests__/case-sensitive-volume.test.ts` | exit 0              |
| Full check | `npm run check`                                                            | exit 0              |

## Scope

**In scope**:

- `__tests__/case-sensitive-volume.test.ts` (create)
- `plans/115-investigate-containment-on-case-sensitive-volumes.md` (append a
  "Findings" section at the end)
- `plans/README.md`

**Out of scope**:

- Everything under `src/`. Even if the escape reproduces, do not fix it
  here: the fix touches the security core and needs its own plan.

## Git workflow

- Branch: `test/case-sensitive-volume-probe`
- One commit: `test(security): probe root containment on a case-sensitive volume`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: A helper that makes a case-sensitive directory, or reports it cannot

In the new test file, write `makeCaseSensitiveDir(): Promise<string | undefined>`:

- Create a directory with `createTestRoot()`.
- **Windows**: run `fsutil.exe file setCaseSensitiveInfo <dir> enable` with
  `execFile` from `node:child_process` (promisified). On any error, return
  `undefined`.
- **macOS**: return `undefined` unless the probe below passes on the temp
  directory as is (creating a case-sensitive disk image is out of scope).
- **Linux**: the platform flag is false there and the comparison is exact;
  return `undefined`.
- Probe on every platform: create `Probe` and `probe` as two sub-directories
  and check `readdir` lists both. If it lists one, clean up and return
  `undefined`.

**Verify**: `npm run type-check:test` → exit 0.

### Step 2: The test

```ts
it(
  'a sibling that differs from the root only in case is outside the root',
  { todo: 'plan 115: remove when the guard is per-volume' },
  async (t) => {
    const base = await makeCaseSensitiveDir();
    if (base === undefined) return t.skip('no case-sensitive directory available here');
    // base/Proj is the allowed root; base/proj is a different folder.
    // 1. mkdir both; write base/proj/secret.txt = 'OUTSIDE'.
    // 2. Build the guard and GuardedFileSystem with base/Proj as the only root
    //    (same construction as __tests__/security.test.ts).
    // 3. Assert each of these rejects with ACCESS_DENIED:
    //    fs.read(join(base, 'proj', 'secret.txt'))
    //    fs.writeFile(join(base, 'proj', 'new.txt'), 'x')
    // 4. Assert base/proj/new.txt does not exist afterwards.
  },
);
```

Fill in the body. Clean up `base` in a `finally`.

**Verify**: `node --test --test-timeout=60000 __tests__/case-sensitive-volume.test.ts`
→ exit 0 in every case. Read the output and note which of these happened:

- **skipped**: no case-sensitive directory could be made here.
- **todo, passing**: the guard refused; no escape.
- **todo, failing**: the escape reproduced.

### Step 3: Record the finding

Append to this plan file a section:

```md
## Findings (<date>, <platform and version>)

- Case-sensitive directory available: yes | no (why)
- Outcome: skipped | refused (no escape) | ESCAPE REPRODUCED
- For an escape: which calls succeeded, and the exact path strings the guard
  compared (add a temporary log, then remove it).
```

If the outcome is "refused", remove the `todo` option from the test so it
becomes a normal regression test.

If the outcome is "skipped" on your platform, say so plainly in the status
row (`BLOCKED: needs Windows with fsutil or a case-sensitive APFS volume`).

**Verify**: `npm run check` → exit 0.

## Test plan

The single probe test above. It is safe to commit in all three outcomes
because of `todo` and the skip.

## Done criteria

- [ ] `__tests__/case-sensitive-volume.test.ts` exists and `npm run check` exits 0
- [ ] This file has a "Findings" section with one of the three outcomes
- [ ] No file under `src/` is modified (`git status`)
- [ ] `plans/README.md` status row updated with the outcome in a few words

## STOP conditions

- `fsutil` asks for elevation or changes a directory outside the temp root.
- The escape reproduces through `read` (file content from outside the root
  is returned). Record it in Findings, mark the status row
  `DONE: ESCAPE REPRODUCED`, and tell the operator directly; the maintainer
  should treat it under `SECURITY.md` and not discuss details in a public
  issue.

## Maintenance notes

If the escape reproduces, the fix to plan next (not here): after `realpath`,
compare the resolved path against each root's own real path **without**
folding, since `realpath` returns the on-disk case on both platforms; keep
the folded comparison only for the pre-realpath lexical check. The risk is
that roots are stored as configured, not as real paths, in some code paths
(`recomputeAllowedDirectories` in `src/core/path.ts`), and that `isSamePath`
callers assume folding. That plan needs the mutation tests from plan 119 as
its safety net.

## Findings (2026-11-14, Windows 11 Home x64 10.0.26300)

- Case-sensitive directory available: yes (`fsutil.exe file setCaseSensitiveInfo <dir> enable` succeeded on NTFS temp directory without elevation)
- Outcome: ESCAPE REPRODUCED
- For an escape: which calls succeeded, and the exact path strings the guard compared:
  - Calls that succeeded:
    - `fs.read(join(base, 'proj', 'secret.txt'))` returned content `'OUTSIDE'` even though only `base/Proj` was an allowed root.
    - `fs.writeFile(join(base, 'proj', 'new.txt'), 'x')` succeeded in creating the file in the unallowed sibling directory `proj`.
  - Exact path strings compared:
    - Allowed root configured: `base\Proj` (normalized: `c:\Users\PC\AppData\Local\Temp\<temp-id>\Proj`)
    - Candidate path requested: `base\proj\secret.txt` (normalized: `C:/Users/PC/AppData/Local/Temp/<temp-id>/proj/secret.txt`)
    - Candidate path resolved (`realpath`): `c:\Users\PC\AppData\Local\Temp\<temp-id>\proj\secret.txt`
    - In `isPathInsideDirectory` (`src/core/path-utils.ts`), because `IS_CASE_INSENSITIVE_FS` is unconditionally true for Windows (`IS_WINDOWS || platform() === 'darwin'`), `normalizeCaseForComparison` folds ASCII characters to lowercase:
      - `root` normalized and folded: `c:\users\pc\appdata\local\temp\<temp-id>\proj`
      - `candidate` normalized and folded: `c:\users\pc\appdata\local\temp\<temp-id>\proj\secret.txt` (or with forward slashes)
      - The folded candidate starts with the folded root followed by a path separator, passing both the pre-realpath and post-realpath containment checks.
