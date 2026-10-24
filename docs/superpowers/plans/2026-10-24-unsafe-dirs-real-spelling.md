# Unsafe system dirs by real spelling implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A grant or `--allow-cwd` can never admit a system directory by its real path. On macOS, that means `/private/etc` is refused just as `/etc` is.

**Architecture:** `UNSAFE_SYSTEM_DIRS` in `src/core/path-discovery.ts` gains the realpath of each entry wherever it differs from the entry. The real paths are resolved once, when the module loads. `isUnsafeCwdPath` and its callers do not change.

**Tech Stack:** TypeScript on Node 24, `node:fs` `realpathSync.native`, `node:test`.

**Spec:** the macOS leg of CI on PR #129. Runs `40092640073` and `40092965649` both fail `TC-PG-012: an unsafe path aliased behind a symlink is refused by both grant gates` (`__tests__/path-guard-grant.test.ts:206`), with this output:

```text
AssertionError [ERR_ASSERTION]: must never offer a link resolving to an unsafe path
+ [ '/private/var/folders/…/fsmcp-test-2GRm1W/innocuous' ]
- []
```

**Cause:** on macOS, `/etc` is a symlink to `/private/etc`. `isUnsafeGrantTarget` (`src/core/path.ts:336-345`) checks the realpath of the target. It compares `/private/etc` against the literal `/etc` in `UNSAFE_SYSTEM_DIRS` (`src/core/path-discovery.ts:59-61`), which never matches, so the grant gate offers a link that resolves into `/etc`. The test's intent (its comment, lines 207-211): a link that only resolves to an unsafe dir must be refused by both grant gates.

## Global Constraints

- Base:
  - If PR #129 is merged (check with `gh pr view 129 --json state --jq .state`), branch from `origin/main`.
  - Otherwise branch from `origin/ci/macos-node26-legs`, and open the PR against that branch. The macOS CI leg is the only place the red test runs.
  - Then run `npm ci`.
- Work in `C:\filesystem-mcp` itself, and do not create a git worktree. Branch name: `fix/unsafe-dirs-real-spelling`.
- Change only `src/core/path-discovery.ts`, `__tests__/path-guard-grant.test.ts` and `CHANGELOG.md`. Do not touch `isUnsafeGrantTarget`, `UNSAFE_HOME_SUBDIRS` or the sensitive-file denylist.
- Keep each literal entry in the list. The real spelling is added beside it, not instead of it, because a lexical path can still name `/etc`.
- A directory that does not exist on a platform (for example `/System` on Linux) keeps only its literal entry. Resolving it must not throw.
- Run the shell commands in Git Bash. Run `npx prettier --write <files>` before `npm run check`.
- Commit with a message file, never a bare `git commit`, because the harness sets `GIT_EDITOR=true`, which aborts it. Use the Write tool to write each message to `<scratchpad>/commit-msg.txt`, then run `git commit -F <scratchpad>/commit-msg.txt`. Every message ends with these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_015x93MERvWLDzoqaguLSmJj`
- Pushing is outward-facing. STOP and ask the user before you push.

## Review Focus

- **`--allow-cwd` from a temp folder on macOS.** `tmpdir()` is under `/private/var/folders`. It must stay grantable, so it must neither contain nor sit inside a real spelling. Pinned by the existing suite on the macOS leg, whose test roots all live there.
- **`--allow-cwd` from `/private` itself on macOS.** It contains `/private/etc`, so it is now refused, as `/` already is. That is intended: no test pins it, but the behavior follows from the same rule.
- **Linux `/bin` and `/sbin`, which on many distros are symlinks to `/usr/bin` and `/usr/sbin`.** Their real spellings sit inside `/usr`, which is already in the list, so adding them changes no outcome.
- **Windows.** `C:\Windows` and the other entries resolve to themselves, so the list does not grow there.

---

### Task 1: Add the real spelling of each unsafe system dir

**Files:**

- Modify: `src/core/path-discovery.ts:1` (import) and `:52-61` (the list)
- Modify: `__tests__/path-guard-grant.test.ts` (imports, and a new test after TC-PG-012, line 236)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)

**Interfaces:**

- Consumes: `normalizePath`, `IS_WINDOWS` (already imported in `path-discovery.ts`).
- Produces: no new exports. `isUnsafeCwdPath(normalizedCwd: string): boolean` keeps its signature.

- [ ] **Step 0: Commit this plan on the branch**

Run `git add docs/superpowers/plans/2026-10-24-unsafe-dirs-real-spelling.md`. Commit it with the subject `docs(plan): add the unsafe dirs real-spelling plan` and the two trailer lines.

- [ ] **Step 1: Write the failing test**

In `__tests__/path-guard-grant.test.ts`:

- add `import { realpathSync } from 'node:fs';`
- add `import { isUnsafeCwdPath } from '../src/core/path-discovery.ts';`, in import order
- after TC-PG-012, add:

```ts
it(
  'TC-PG-013: the real spelling of a system dir is unsafe',
  { skip: process.platform === 'win32' && 'Windows system dirs have no alias spelling' },
  () => {
    for (const dir of ['/etc', '/usr', '/bin', '/sbin']) {
      let real: string;
      try {
        real = realpathSync.native(dir);
      } catch {
        continue;
      }
      assert.ok(isUnsafeCwdPath(real), `${real} (real spelling of ${dir}) must be unsafe`);
    }
  },
);
```

This test and TC-PG-012 fail only on macOS. On Linux and Windows they pass before and after the fix, because every real spelling there is already covered.

- [ ] **Step 2: Confirm the red state**

Locally, run `node --test --test-timeout=60000 --test-name-pattern="TC-PG-01[23]" __tests__/path-guard-grant.test.ts`.
Expected on Windows: `ℹ fail 0`, with TC-PG-013 skipped.

The red state on macOS is already on record: CI run `40092965649` fails TC-PG-012 with the message under Spec. TC-PG-013 fails there for the same cause, which the macOS leg of this branch's first CI run confirms (Step 6).

- [ ] **Step 3: Implement the real spellings**

In `src/core/path-discovery.ts`:

- import `realpathSync` from `node:fs`
- replace the `UNSAFE_SYSTEM_DIRS` definition (lines 59-61) with the version below
- keep the comment above it, and add one line to it: `// Each entry also counts by its real spelling: on macOS /etc is /private/etc.`

```ts
const UNSAFE_SYSTEM_DIRS = withRealSpellings(
  IS_WINDOWS
    ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
    : ['/usr', '/etc', '/bin', '/sbin', '/System'],
);

function withRealSpellings(dirs: readonly string[]): string[] {
  const all = [...dirs];
  for (const dir of dirs) {
    try {
      const real = realpathSync.native(dir);
      if (!isSamePath(normalizePath(real), normalizePath(dir))) all.push(real);
    } catch {
      // A system dir missing on this platform has no other spelling.
    }
  }
  return all;
}
```

Use `function` hoisting as written, or define `withRealSpellings` above the constant; either matches the file.

- [ ] **Step 4: Run the tests**

Run `node --test --test-timeout=60000 __tests__/path-guard-grant.test.ts`.
Expected: `ℹ fail 0`.

Then run the Linux suite in WSL, using the `wsl-test.sh` recipe from `docs/superpowers/plans/2026-10-24-stat-through-fd.md` ("Running Linux tests"), with the pattern `"TC-PG-"` on `__tests__/path-guard-grant.test.ts`.
Expected: `ℹ fail 0`.

- [ ] **Step 5: Format, full check, CHANGELOG, commit**

Add this bullet under a `### Security` heading in `## [Unreleased]`. If the heading already exists, put the bullet last under it. Otherwise insert the heading after the section's last bullet and before the next `## [` line.

```markdown
- **A grant can no longer reach a system folder by its real path on
  macOS.** `/etc` there is a link to `/private/etc`, and the grant check
  compared the resolved path against `/etc` only, so a folder link that
  resolved into `/etc` was offered for access. Each system folder now also
  counts by its real path.
```

```bash
npx prettier --write src/core/path-discovery.ts __tests__/path-guard-grant.test.ts CHANGELOG.md
npm run check
git add src/core/path-discovery.ts __tests__/path-guard-grant.test.ts CHANGELOG.md
```

Expected: `npm run check` exits 0 with `ℹ fail 0`.

Commit message (contents of `commit-msg.txt`):

```text
fix(path): refuse system dirs by their real spelling

On macOS /etc is a link to /private/etc. The grant gate checks a target's
realpath against the unsafe list, which only named /etc, so a link that
resolved into /etc was offered for access (TC-PG-012, red on the macOS CI
leg). Each unsafe system dir now also counts by its realpath.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x93MERvWLDzoqaguLSmJj
```

- [ ] **Step 6: STOP for a CI run**

Ask the user to push `fix/unsafe-dirs-real-spelling` and open a PR against the base from Global Constraints. Once the run completes (`gh run watch <run-id>`), run:

```bash
gh run view <run-id> --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'
```

Expected: `Check (macos-latest)` concludes `success`, with TC-PG-012 and TC-PG-013 passing. Every other job also concludes `success`.

If macOS still fails TC-PG-012, STOP and report the assertion output. The cause is then not, or not only, the `/private/etc` spelling.
