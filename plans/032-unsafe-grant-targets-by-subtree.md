# Plan 032: A grant is never offered for an ancestor of home or a system directory, nor for a secret subtree of home

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/path-discovery.ts src/core/path.ts __tests__/path-guard-grant.test.ts`
> If `path-discovery.ts:46-79` or `path.ts:276-303` changed, compare against
> the excerpts before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

When a tool names a path outside every allowed root, the server may offer the
user a grant for the path's **nearest existing ancestor directory**
(`PathGuard.resolveGrantTargetDir`). Before offering, it refuses "unsafe"
targets — but `isUnsafeCwdPath` matches only **exact** paths: the filesystem
root, the home directory, and eight fixed system directories.

Consequences, all probed during the audit on Windows:

- A request for a made-up path under `C:\Users\nobody\x` offers a grant for
  `C:\Users` — the directory that _contains_ home. `/home` on Linux and
  `/Users` on macOS behave the same. Granting it admits every user's files.
- `~\.ssh`, `~\AppData`, `~\.aws`, `~\.gnupg` are grantable: they are not the
  home directory itself.
- `C:\Windows\System32`, `C:\ProgramData`, `/etc/ssh` are grantable: they are
  inside a system directory, not equal to one.

Without `FS_ROOT_BOUNDARY` this check is the only thing between a
prompt-injected model and a user who clicks "approve" on `C:\Users`. The same
predicate gates `--allow-cwd` (`path.ts:800`).

## Current state

```ts
// src/core/path-discovery.ts:46-79
export function isUnsafeCwdPath(normalizedCwd: string): boolean {
  const norm = normalizedCwd.toLowerCase();

  // 1. Filesystem root check
  const root = parse(normalizedCwd).root;
  if (isSamePath(normalizedCwd, root)) {
    return true;
  }

  // 2. Home directory check
  if (isSamePath(normalizedCwd, homedir())) {
    return true;
  }

  // 3. Hard-coded unsafe paths check
  const unsafePaths = new Set(
    [
      '/usr',
      '/etc',
      '/bin',
      '/sbin',
      '/System',
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
    ].map((p) => normalizePath(p).toLowerCase()),
  );

  if (unsafePaths.has(norm)) {
    return true;
  }

  return false;
}
```

`path-discovery.ts` imports `homedir` from `node:os`, `parse` from
`node:path`, and `isSamePath`, `normalizePath` from `./path-utils.ts` (check
the import block; add `isPathInsideDirectory` and `join` as needed).

```ts
// src/core/path-utils.ts:205-217
export function isPathInsideDirectory(
  normalizedDirectory: string,
  normalizedCandidate: string,
): boolean {
  // true when candidate === directory or candidate is below it; case-folded
  // on Windows/macOS; separator-aware (no prefix collision)
```

```ts
// src/core/path.ts:276-303
  private async isUnsafeGrantTarget(targetDir: string): Promise<boolean> {
    const normalized = normalizePath(targetDir);
    if (isUnsafeCwdPath(normalized)) return true;
    let resolved: string;
    try {
      resolved = normalizePath(await realpath(normalized));
    } catch {
      return false;
    }
    return !isSamePath(resolved, normalized) && isUnsafeCwdPath(resolved);
  }

  /** Walk up from a blocked path to the closest existing ancestor directory. */
  private async resolveGrantTargetDir(blockedPath: string): Promise<string> {
    let targetDir = blockedPath;
    for (;;) {
      const parent = dirname(targetDir);
      try {
        return (await stat(targetDir)).isDirectory() ? targetDir : parent;
      } catch {
        // Missing — keep walking up.
      }
      if (parent === targetDir) return targetDir;
      targetDir = parent;
    }
  }
```

`precheckAccess` (lines 316–346) calls `resolveGrantTargetDir` then
`isUnsafeGrantTarget`, and skips unsafe targets; `applyGrant` re-checks.

Existing tests: `__tests__/path-guard-grant.test.ts` — `TC-PG-011` (line 186)
proves `/etc` / `C:\Windows` are never offered nor accepted, using
`new PathGuard({ cliAllowedDirs: [root] })`, `guard.recomputeAllowedDirectories()`,
`guard.precheckAccess([...])` and `guard.applyGrant(...)`.

## Commands you will need

| Purpose      | Command                                                                              | Expected on success |
| ------------ | ------------------------------------------------------------------------------------ | ------------------- |
| Static check | `npm run check:static`                                                               | exit 0              |
| All tests    | `npm test`                                                                           | all pass            |
| Grant tests  | `node --test __tests__/path-guard-grant.test.ts`                                     | all pass            |
| Format       | `npx prettier --write src/core/path-discovery.ts __tests__/path-guard-grant.test.ts` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/path-discovery.ts` — `isUnsafeCwdPath` (and imports)
- `__tests__/path-guard-grant.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope**: `PathGuard.isUnsafeGrantTarget` / `resolveGrantTargetDir`
(they already call the predicate on both the lexical and the resolved path);
`FS_ROOT_BOUNDARY` handling; the confirmation UI text.

## Git workflow

- Branch: `advisor/032-unsafe-grant-targets-by-subtree`.
- One commit: `fix(path): refuse grants for ancestors of home/system dirs and for secret subtrees`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Regression test (it must fail now)

In `__tests__/path-guard-grant.test.ts`, directly after `TC-PG-012`, add:

```ts
it('TC-PG-013: precheckAccess never offers an ancestor of home, a subtree of a system dir, or a secret subtree of home', async () => {
  delete process.env['FS_ROOT_BOUNDARY'];
  const guard = new PathGuard({ cliAllowedDirs: [root] });
  await guard.recomputeAllowedDirectories();

  const home = homedir();
  // The nearest existing ancestor of a made-up sibling of home is home's
  // parent (C:\Users, /home, /Users) — the directory that contains home.
  const homeParentProbe = join(dirname(home), 'no-such-user-9f3c', 'project', 'file.txt');
  const systemChild =
    process.platform === 'win32'
      ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      : '/etc/ssh/ssh_config';
  const secret = join(home, '.ssh', 'id_ed25519');

  for (const probe of [homeParentProbe, systemChild, secret]) {
    const grants = await guard.precheckAccess([probe]);
    assert.deepStrictEqual(grants, [], `must not offer a grant for ${probe}`);
  }
  assert.strictEqual(await guard.applyGrant(dirname(home)), false);
  assert.strictEqual(await guard.applyGrant(join(home, '.ssh')), false);
});
```

Add `import { homedir } from 'node:os';` and `dirname` to the `node:path`
import (`join, parse` are already imported; make it `dirname, join, parse`).

**Verify**: `node --test __tests__/path-guard-grant.test.ts` → the new test
**fails** on `homeParentProbe` (a grant for home's parent is offered). If it
passes, STOP — then check whether `dirname(homedir())` is itself a filesystem
root on this machine (for example a container where home is `/root`); report.

### Step 2: Reason about subtrees, not exact paths

Replace `isUnsafeCwdPath` in `src/core/path-discovery.ts` (lines 46–79) with:

```ts
// Directories a grant (or --allow-cwd) must never admit, as subtrees: a target
// inside one of these is unsafe, and so is a target that *contains* one — the
// nearest existing ancestor of a made-up path under C:\Users is C:\Users.
//
// Per platform on purpose: on POSIX `normalizePath('C:\\Windows')` resolves
// against the cwd, so a cross-platform list would make the cwd itself
// "contain a system dir" and refuse --allow-cwd.
const UNSAFE_SYSTEM_DIRS = IS_WINDOWS
  ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
  : ['/usr', '/etc', '/bin', '/sbin', '/System'];

// Subtrees of home that hold credentials. Home itself and its other
// subdirectories stay grantable: projects live there.
const UNSAFE_HOME_SUBDIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gcloud'];

export function isUnsafeCwdPath(normalizedCwd: string): boolean {
  const candidate = normalizePath(normalizedCwd);

  // 1. A filesystem root, or anything that contains home or a system dir.
  const home = normalizePath(homedir());
  if (isSamePath(candidate, parse(candidate).root)) return true;
  if (isPathInsideDirectory(candidate, home)) return true;
  for (const dir of UNSAFE_SYSTEM_DIRS) {
    const system = normalizePath(dir);
    if (isPathInsideDirectory(candidate, system)) return true;
    if (isPathInsideDirectory(system, candidate)) return true;
  }

  // 2. Credential subtrees of home.
  for (const sub of UNSAFE_HOME_SUBDIRS) {
    if (isPathInsideDirectory(normalizePath(join(home, sub)), candidate)) return true;
  }
  return false;
}
```

`isPathInsideDirectory(directory, candidate)` is true when `candidate` equals
`directory` or lies below it — so `isPathInsideDirectory(candidate, home)`
reads "home is inside candidate" (candidate is home or an ancestor of it), and
`isPathInsideDirectory(system, candidate)` reads "candidate is inside system".

Update the imports: `import { homedir } from 'node:os';` and
`import { join, parse } from 'node:path';` (keep whatever else is imported),
and add `IS_WINDOWS` and `isPathInsideDirectory` to the `./path-utils.ts`
import.

Run `npx prettier --write src/core/path-discovery.ts __tests__/path-guard-grant.test.ts`.

**Verify**: `node --test __tests__/path-guard-grant.test.ts` → all pass,
including `TC-PG-011`, `TC-PG-012` and the new `TC-PG-013`;
`node --test __tests__/roots-seeding.test.ts __tests__/security.test.ts __tests__/tools.test.ts`
→ all pass (the `--allow-cwd` and grant round-trip tests must still offer
ordinary temp directories).

### Step 3: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- New `TC-PG-013`: home's parent, a child of a system directory, and
  `~/.ssh` are never offered and never accepted.
- Existing: `TC-PG-001…012` (ordinary temp-dir grants still work — the OS
  temp directory is neither an ancestor of home nor inside a system dir on
  Windows, Linux or macOS), `TC-FUNC-070/071` (multi-select grants).

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "UNSAFE_HOME_SUBDIRS\|UNSAFE_SYSTEM_DIRS" src/core/path-discovery.ts` prints the two definitions and their uses
- [ ] The new test exists and passes
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 032 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The regression test passes before Step 2.
- After Step 2 any existing grant test fails because the machine's temp
  directory is inside home's parent chain in a way the rule now refuses (for
  example `TMPDIR=/home`): report the temp path; do not special-case it.
- `isPathInsideDirectory` is not exported from `path-utils.ts` at HEAD.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Adding a directory to either list is the whole change for a new "never
  grant" rule. Keep home's own subdirectories grantable except the listed
  credential stores; refusing `~/projects` would break the main use case.
- The system-dir list is per platform (see the code comment). Never merge
  the two lists back into one: on POSIX a Windows path resolves under the
  cwd and the containment check would refuse `--allow-cwd`.
- Reviewer focus: both directions of containment are checked for system
  dirs; only the "candidate contains it" direction for home (so `~/projects`
  stays grantable); only the "candidate is inside it" direction for the
  credential subtrees.
- Plan 031 (denylist) protects the files inside `~/.ssh` when a root already
  covers them; this plan keeps the directory from becoming a root at all.
