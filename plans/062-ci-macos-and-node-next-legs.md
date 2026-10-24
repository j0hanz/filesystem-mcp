# Plan 062: CI also runs on macOS and on the next Node major

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 3da494ae..HEAD -- .github/workflows/ci.yml package.json`
> Plans 055 and 058 are expected to have changed `ci.yml` and `package.json`
> (055: `test` → `node --test --test-timeout=60000`; 058: a new
> `test:coverage` script). Compare `ci.yml` with the "Current state" below,
> which describes the state **after 055 and 058**, and confirm
> `grep -c '"test:coverage"' package.json` → `1`. Any other difference is a
> STOP condition.

## Status

- **Superseded** 2026-10-24 by `docs/superpowers/plans/2026-10-24-ci-macos-node26-legs.md`; do not execute this plan.
- **Priority**: P2
- **Effort**: S for the change itself. The first macOS run may surface
  failures that need triage, and this plan bounds that triage.
- **Risk**: MED. New legs may go red on day one. Both start
  non-blocking (`continue-on-error`).
- **Depends on**: plans 055 and 058 (step layout and coverage-step conditions)
- **Category**: tests
- **Planned at**: commit `3da494ae`, 2026-10-12

## Why this matters

**macOS.** `mcpb/manifest.json:56` declares `darwin`, and the MCPB bundle
targets Claude Desktop, which many users run on macOS. macOS is also the one
platform that combines POSIX separators with a **case-insensitive**
filesystem. The path guard branches on exactly that
(`src/core/path-utils.ts:158`):

```ts
IS_CASE_INSENSITIVE_FS = IS_WINDOWS || platform() === 'darwin';
```

A comment at `src/core/path.ts:620-624` records an earlier darwin-only
containment bug ("the previous IS_WINDOWS-only fold left darwin doing
exact-case compares"). macOS `tmpdir()` (`/var/folders/...`) resolves to
`/private/var/...`, which makes every test root an alias. The first Windows
CI run exposed the same class of problem with 8.3 short paths (run
36232184074, 7 failures, plan 011). `fs.watch` uses FSEvents on macOS, not
inotify, so subscriptions behave differently there. No CI runner covers any
of this, and macOS runners are free on public repositories.

**Next Node major.** `package.json` `engines.node` is `">=24"` with no upper
bound, and `mcpb/manifest.json:57` says `>=24.0.0`, but CI only runs `.nvmrc`
(`24`). The suite relies on runtime features that move between majors:
native TypeScript type stripping, `fs.glob` (`src/core/glob.ts:1`, with a
dirent workaround at `:413-416`), the test runner's coverage and snapshot
APIs, and RE2-wasm. A runtime-version gap has crashed users before
(`fb85f001`, `RegExp.escape` missing on Node 22). Node 26 is the Current
line and enters LTS in late October 2026.

## Current state (after plans 055 and 058)

`.github/workflows/ci.yml`, job `check`:

```yaml
check:
  name: Check (${{ matrix.os }})
  runs-on: ${{ matrix.os }}
  timeout-minutes: 15
  strategy:
    # One OS failing must not cancel the other: the point is to see both.
    fail-fast: false
    matrix:
      os: [ubuntu-latest, windows-latest]
  # Mirrors `npm run check` ... Keep the two in sync.
  steps:
    - uses: actions/checkout@v6
    - uses: actions/setup-node@v6
      with:
        node-version-file: .nvmrc
        cache: npm
    - name: Install
      id: install
      run: npm ci
    - name: Build
      id: build
      run: npm run build
    ... (Type-check tests, Lint, Format, Knip, each
         `if: ${{ !cancelled() && steps.install.outcome == 'success' }}`)
    - name: Test
      if: ${{ !cancelled() && steps.build.outcome == 'success' && matrix.os != 'ubuntu-latest' }}
      run: npm test
    - name: Test with coverage floor
      if: ${{ !cancelled() && steps.build.outcome == 'success' && matrix.os == 'ubuntu-latest' }}
      run: npm run test:coverage
```

- The job names `Check (ubuntu-latest)` and `Check (windows-latest)` are, or
  will be, **required status checks** (plan 064). Their spelling must not
  change.
- `.nvmrc` is `24`. `release.yml` uses Node 24 and stays on it. Releases
  build on the pinned major.

## Commands you will need

| Purpose         | Command                                                                                   | Expected on success       |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| Format the YAML | `npx prettier --check .github/workflows/ci.yml`                                           | exit 0                    |
| Lint workflow   | `actionlint .github/workflows/ci.yml` (only if installed)                                 | no output                 |
| Node 26 exists  | `gh api repos/nodejs/node/releases --jq '[.[].tag_name \| select(startswith("v26"))][0]'` | prints a v26 tag          |
| CI result       | `gh run list --workflow CI --branch <branch> --limit 1`                                   | after the operator pushes |

## Scope

**In scope**:

- `.github/workflows/ci.yml`: the `check` job's `name`, `strategy.matrix`,
  `setup-node` inputs, `continue-on-error`, and the two Test steps' `if:`
- `__tests__/*.test.ts`: one- or two-line test-assumption fixes from step 5
  only. Each is verified by the next CI push, since it cannot be reproduced on
  Windows. `npm test` must stay `fail 0` locally.
- `plans/README.md`: status row, plus the first-run triage notes

**Out of scope**:

- `.nvmrc`, `package.json` `engines`, `release.yml`, `Dockerfile` (they stay on 24).
- Fixing product bugs the macOS leg reveals. Report each one as a candidate
  plan (step 5).
- Making the new legs required checks. Plan 064 adds them after they are
  green. This plan does not touch repository settings.
- A Node 22 leg. `engines` is `>=24`.

## Git workflow

- Branch: `advisor/062-ci-macos-and-node-next-legs`
- One commit, e.g. `ci: add a macOS leg and a Node 26 ubuntu leg (non-blocking)`
- Do NOT push or open a PR unless the operator instructed it. The new legs
  can only be verified by a CI run, so ask the operator to push the branch at
  step 4.

## Steps

### Step 1: Confirm the Node major to add

Run `gh api repos/nodejs/node/releases --jq '[.[].tag_name | select(startswith("v26"))][0]'`
(works in PowerShell and Git Bash). At planning it printed `v26.11.1`.

**Verify**: it prints a `v26.x.y` tag. If there is none, STOP: the Node
release line assumed here does not exist.

### Step 2: Matrix and job name

Replace the `check` job's `name:` and `strategy:` with:

```yaml
check:
  # Existing legs keep their names exactly (required status checks depend on
  # them); only the extra Node leg gets a suffix.
  name: Check (${{ matrix.os }}${{ matrix.node && format(', node {0}', matrix.node) || '' }})
  runs-on: ${{ matrix.os }}
  timeout-minutes: 15
  # New legs report but do not fail the workflow until they have been green
  # for a while; then delete their `experimental: true` lines (plan 062
  # maintenance notes).
  continue-on-error: ${{ matrix.experimental == true }}
  strategy:
    # One leg failing must not cancel the others: the point is to see all.
    fail-fast: false
    matrix:
      os: [ubuntu-latest, windows-latest, macos-latest]
      node: ['']
      include:
        - os: macos-latest
          experimental: true
        - os: ubuntu-latest
          node: '26'
          experimental: true
```

How `include` resolves here (GitHub's rule: an include entry is merged into
every existing combination it does not contradict on an _original_ matrix
key; if it would overwrite an original key's value, it becomes a new
combination):

- `experimental` is **not** an original matrix key, so the first entry is
  merged into the existing macOS combination. macOS stays one leg.
- `node` **is** an original key (`['']`), and `'26'` overwrites `''`, so the
  second entry creates a **fourth** leg and leaves the default Ubuntu leg
  alone. Do not drop `node: ['']`. Without it, `node: '26'` would merge into
  the default Ubuntu leg and silently move it to Node 26.

Expected leg names: `Check (ubuntu-latest)`, `Check (windows-latest)`,
`Check (macos-latest)`, `Check (ubuntu-latest, node 26)`.

### Step 3: Node version input and coverage on exactly one leg

`setup-node` step:

```yaml
- uses: actions/setup-node@v6
  with:
    # The pinned major from .nvmrc, unless the leg names another one.
    node-version: ${{ matrix.node }}
    node-version-file: ${{ !matrix.node && '.nvmrc' || '' }}
    cache: npm
```

In the two Test steps, change **only the `if:` lines** (keep the comments
plan 058 added), so coverage runs only on the pinned Ubuntu leg:

```yaml
# in "Test":
if: ${{ !cancelled() && steps.build.outcome == 'success' && (matrix.os != 'ubuntu-latest' || matrix.node != '') }}
# in "Test with coverage floor":
if: ${{ !cancelled() && steps.build.outcome == 'success' && matrix.os == 'ubuntu-latest' && matrix.node == '' }}
```

**Verify**: `npx prettier --check .github/workflows/ci.yml` → exit 0 (use
`--write` and re-check if needed). If `actionlint` is installed, it reports
nothing. Read the file once more and confirm the `release-paths` job is
unchanged.

### Step 4: First CI run (operator pushes the branch)

Ask the operator to push the branch and open a draft PR. Then:

```bash
gh run list --workflow CI --branch advisor/062-ci-macos-and-node-next-legs --limit 1
gh run view <id> --json jobs --jq '.jobs[] | {name, conclusion}'
```

**Verify**: exactly four `Check (…)` jobs plus `Release build paths`, named
as in step 2. `Check (ubuntu-latest)` and `Check (windows-latest)` must be
`success`. Then:

```bash
gh run view <id> --json conclusion --jq .conclusion
gh run view <id> --json jobs --jq '.jobs[] | {name, ran: [.steps[] | select(.conclusion != "skipped") | .name]}'
```

- The run conclusion is `success` even if a new leg's job shows `failure`.
  That is expected with job-level `continue-on-error`.
- `Test with coverage floor` appears only under `Check (ubuntu-latest)`.
  `Check (ubuntu-latest, node 26)` lists `Test`.

### Step 5: Triage the new legs (bounded)

For each failing test on the new legs, record a `- 062 first-run triage:`
bullet list at the end of the `### Batch 055–064` section of
`plans/README.md`, and set the 062 status row to
`DONE (n new-leg failures recorded)`. Each entry gives the test name, the leg, the first assertion line, and one
classification:

- **test-assumption**: the test compares an unresolved `tmpdir()` spelling,
  assumes case-sensitivity, or assumes inotify timing. If the fix is
  test-only and one or two lines (for example using `realpath` the way
  `createTestRoot` does), fix it in this plan.
- **product**: the server behaves wrongly on that platform or runtime.
  Do **not** fix it here. Record it as a candidate plan.

Spend at most two fix-and-push cycles on test-assumption fixes. Whatever
remains stays red but non-blocking (`continue-on-error`), and is recorded.

**Verify**: every failure on the new legs is recorded with a classification.
`Check (ubuntu-latest)` and `Check (windows-latest)` stay green.

## Test plan

- The new CI legs are the test. Step 5's record is the output.
- `__tests__/resources-subscribe.test.ts` and `__tests__/stdio.test.ts`
  `STDIO-003` (plan 056's subscription tests) and `__tests__/guards.test.ts`
  (plan 060) are the most likely to behave differently on macOS (FSEvents,
  APFS). Note them specifically in step 5.

## Done criteria

- [ ] The CI run shows four `Check (…)` jobs with the names from step 2
- [ ] `Check (ubuntu-latest)` and `Check (windows-latest)` are green, and their names are unchanged
- [ ] Coverage runs only on `Check (ubuntu-latest)` (from the step logs)
- [ ] Every new-leg failure is recorded in `plans/README.md` with a classification
- [ ] Git Bash: `grep -c 'macos-latest' .github/workflows/ci.yml` → `2`
- [ ] `grep -c 'continue-on-error: \${{ matrix.experimental == true }}' .github/workflows/ci.yml` → `1`
- [ ] `grep -c "node-version-file: \${{ !matrix.node && '.nvmrc' || '' }}" .github/workflows/ci.yml` → `1` (`release-paths` keeps its plain `node-version-file: .nvmrc`)
- [ ] `grep -c "matrix.node == ''" .github/workflows/ci.yml` → `1`, and `grep -c "matrix.node != ''" .github/workflows/ci.yml` → `1`
- [ ] `npx prettier --check .github/workflows/ci.yml` → exit 0
- [ ] `git diff --name-only main...HEAD` → only `.github/workflows/ci.yml`, `plans/README.md`, plus any step-5 test files listed in the README

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 finds no Node 26 release.
- The existing legs' names change (a required-check break).
- A **product** failure appears on macOS in the path guard (`security.test.ts`,
  `path-*.test.ts`, `aliased-root.test.ts`). Report it before continuing,
  because it may be a sandbox issue on a shipped platform.
- `continue-on-error` at job level does not keep the workflow green when a new
  leg fails. Report what the run shows.

## Maintenance notes

- Once `Check (macos-latest)` and `Check (ubuntu-latest, node 26)` have been
  green for about two weeks of pushes, delete their `experimental: true`
  lines from `include` (and the then-empty `- os: macos-latest` entry), and
  add both names to the required checks (plan
  064's ruleset) and to `REQUIRED` in `release.yml` (plan 063).
- When Node 26 becomes the pinned major (`.nvmrc`), change the extra leg to
  the next Current line (27).
- macOS runners queue longer than Linux ones. If PR feedback gets slow,
  macOS can run on `push` to `main` only. That is a trade-off for the
  maintainer.
