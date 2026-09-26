# Plan 007: CI runs the full check on Windows as well as Linux

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7ee3d49f..HEAD -- .github/workflows/ci.yml .gitattributes .gitignore Dockerfile`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: dx / tests
- **Planned at**: commit `7ee3d49f`, 2026-09-25

## Why this matters

This is a filesystem sandbox with Windows-only security logic: NTFS
alternate-data-stream stripping and trailing-dot/space trimming in the
sensitive-file matcher (`src/core/sensitive.ts:346`), drive-letter folding
(`src/core/path-utils.ts:164`), and case-insensitive containment
(`path-utils.ts:171`). The tests that pin that logic skip themselves off
Windows (`__tests__/security.test.ts:128-134`, `:199-205`, `:287-293`), and CI
runs only on `ubuntu-latest`. So a regression in, for example, the `.env:stream`
bypass guard ships through a green CI; it is caught only if someone happens
to run the suite on Windows before a release, and the release job also runs
on Linux. The MCPB bundle declares `win32` as a supported platform. Adding a
Windows leg closes that gap. One prerequisite: a Windows runner checks files
out with CRLF (`core.autocrlf=true` by default), and Prettier's default
`endOfLine: "lf"` would then fail `prettier --check` in `npm run check`. A
`.gitattributes` forcing LF fixes that for every Windows clone, not just CI.

## Current state

- `.github/workflows/ci.yml` — the only CI workflow. Full content:

```yaml
name: CI

on:
  push:
    branches: [main, dev]
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    name: Check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run check
```

- There is no `.gitattributes`. `.prettierrc` sets no `endOfLine`, so
  Prettier requires LF.
- `git ls-files --eol` at the planned-at commit: 106 text files are LF in the
  index; **two are CRLF in the index**: `.gitignore` and `Dockerfile`.
  `LICENSE` is LF in the index (CRLF only in one local working tree).
  `assets/logo.png` is detected as binary.
- `main` has no branch protection and no rulesets (checked with
  `gh api repos/j0hanz/filesystem-mcp/branches/main/protection` → 404), so
  renaming the job's display name does not break a required status check.
- The suite passes on Windows today (353 pass, 2 skipped, on the maintainer's
  Windows 11 machine at the planned-at commit), so the new leg is expected to
  pass. Symlink tests skip themselves when symlinks are not permitted
  (`trySymlink` in `__tests__/helpers.ts:43`).

## Commands you will need

| Purpose               | Command                               | Expected on success      |
| --------------------- | ------------------------------------- | ------------------------ |
| Install               | `npm ci`                              | exit 0                   |
| Line endings in index | `git ls-files --eol \| grep "i/crlf"` | no output (after Step 2) |
| Full gate             | `npm run check`                       | exit 0                   |

Run shell steps in Git Bash (or any POSIX shell); the commands use `mktemp`.

## Scope

**In scope**:

- `.gitattributes` (create)
- `.github/workflows/ci.yml`
- `.gitignore` and `Dockerfile` — **line endings only**, via `git add --renormalize`;
  no content edits.

**Out of scope**:

- `.github/workflows/release.yml` — releases stay on Linux.
- Any test file. If the Windows leg fails, report; do not fix tests here.
- `.prettierrc` — do not set `endOfLine: "auto"`; LF everywhere is the point.

## Git workflow

- Branch: `advisor/007-windows-ci` from `main`.
- Two commits:
  1. `chore: force LF line endings with .gitattributes` (the attributes file
     plus the renormalized `.gitignore` and `Dockerfile`).
  2. `ci: run the check on windows-latest too`.
     If you are an AI agent, end each message with a `Co-Authored-By:` trailer
     naming your model, as recent commits do.
- Do NOT push or open a PR unless the operator instructed it. The Windows leg
  can only be observed on GitHub, so Step 5 is for the operator (or for you,
  if the operator told you to push).

## Steps

### Step 1: Add `.gitattributes`

Create `.gitattributes` at the repo root with exactly:

```text
# LF everywhere, including Windows checkouts: Prettier's check requires it.
* text=auto eol=lf
```

**Verify**: `cat .gitattributes` shows the two lines.

### Step 2: Renormalize the index

Run `git add --renormalize .` then `git status --short`.

**Verify**: the status lists exactly `A  .gitattributes`, `M  .gitignore`,
`M  Dockerfile` (staged). If any other file appears, STOP.
Then `git ls-files --eol | grep "i/crlf"` → no output.

Commit (commit 1 above).

### Step 3: Prove a Windows-style checkout is now LF

Simulate the runner's `core.autocrlf=true` checkout from your branch:

```bash
tmp="$(mktemp -d)"
git clone --quiet --branch "$(git branch --show-current)" -c core.autocrlf=true . "$tmp/eol-check"
git -C "$tmp/eol-check" ls-files --eol | grep -c "w/crlf"
rm -rf "$tmp"
```

**Verify**: the `grep -c` prints `0`. (For contrast, the same clone of the
planned-at commit prints `109`.)

### Step 4: Add the OS matrix to CI

Edit `.github/workflows/ci.yml` so the `check` job reads:

```yaml
jobs:
  check:
    name: Check (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      # One OS failing must not cancel the other: the point is to see both.
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run check
```

Keep everything above `jobs:` unchanged.

**Verify**:

- `npx prettier --check .github/workflows/ci.yml .gitattributes` → exit 0
  (Prettier formats YAML; it may report `.gitattributes` as having no parser —
  that is fine, only a formatting _failure_ on `ci.yml` matters).
- `npm run check` → exit 0 locally.

Commit (commit 2 above).

### Step 5 (operator, after push): Confirm both legs

Push the branch and open the PR (only if instructed). On the PR's Checks tab:

**Verify**: `Check (ubuntu-latest)` and `Check (windows-latest)` both pass, and
the Windows log for `npm run check` shows `TC-SEC-011` and `TC-SENS-005` as
passing, not skipped (search the log for `TC-SEC-011`).

## Test plan

No new tests. The change makes existing Windows-only tests
(`TC-SEC-011`, `TC-SENS-005`, `TC-ALLOW-004` in `__tests__/security.test.ts`)
run in CI, and makes POSIX-only ones (`core-fs.test.ts:206`,
`tools.test.ts:403`) keep running on the Linux leg.

## Done criteria

- [ ] `.gitattributes` exists with `* text=auto eol=lf`
- [ ] `git ls-files --eol | grep "i/crlf"` → no output
- [ ] Step 3's simulated `core.autocrlf=true` clone reports `0` CRLF files
- [ ] `.github/workflows/ci.yml` has `matrix.os: [ubuntu-latest, windows-latest]` and `fail-fast: false`
- [ ] `npm run check` exits 0 locally
- [ ] `git diff main --stat` lists only `.gitattributes`, `.gitignore`, `Dockerfile`, `.github/workflows/ci.yml`, and `git diff main -w --ignore-cr-at-eol -- .gitignore Dockerfile` is empty (line endings only)
- [ ] (operator) both CI legs green on the PR
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `git add --renormalize .` stages anything other than `.gitattributes`,
  `.gitignore` and `Dockerfile`.
- Step 3 prints a non-zero count.
- The Windows CI leg fails. Report the failing test names and the first
  error line of each. Likely suspects are timing-based watcher tests
  (`__tests__/resources-subscribe.test.ts`, `__tests__/subscriptions-listen.test.ts`
  use fixed sleeps) and `__tests__/input-required.test.ts` (a real 2.1 s wait).
  Do not add retries or skips in this plan.

## Maintenance notes

- Adding a new OS (macOS) later is one matrix entry; macOS is the other
  case-insensitive filesystem `path-utils.ts:171` special-cases.
- CI time roughly doubles in runner-minutes (legs run in parallel, so
  wall-clock is about the slower leg). If that matters, a later change can
  run only `npm test` on Windows and keep static checks on Linux.
- The release workflow still runs `npm run check` on Linux only before
  publishing; the Windows signal comes from CI on the PR/merge.
