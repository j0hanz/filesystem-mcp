# CI macOS and Node 26 legs implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two CI legs that report results but do not block: `Check (macos-latest)` on the pinned Node, and `Check (ubuntu-latest, node 26)`. The two existing legs keep their exact names and behavior.

**Architecture:** One job changes: `check` in `.github/workflows/ci.yml`.

- A `node` matrix key, default `''`, lets an `include` entry add a Node 26 leg without changing the default Ubuntu leg.
- A job-level `continue-on-error` keeps the new legs out of the workflow result.
- Coverage stays on the pinned Ubuntu leg only.

Task 2 triages the first CI run.

**Tech Stack:** GitHub Actions (`actions/setup-node` v7.1.0, pinned by SHA), Node 24 (`.nvmrc`), Node 26.

**Spec:** `plans/062-ci-macos-and-node-next-legs.md`, which holds the design and the macOS rationale. This plan replaces it, because its `uses:` lines and its line context are stale. These facts were checked on 2026-10-24:

- **Node schedule.** Node 26 becomes Active LTS on 2026-10-28. Node 24 entered maintenance on 2026-10-20 (`nodejs/Release` `schedule.json`). The latest 26 release is `v26.12.1`.
- **Untested range.** `package.json` `engines.node` is `">=24"` and `mcpb/manifest.json:79` is `>=24.0.0`, but CI runs only `.nvmrc` (`24`).
- **Windows on 26.** On Node 26.12.1, a copy of `381ca23e` passed `npm run check`: 947 tests, `fail 0`.
- **Linux on 26.** In WSL, the full suite with the coverage floor showed `fail 1`. The failing test was `__tests__/outbound-regressions.test.ts:122`, which hit a 5 s client timeout under load. That test passed 3 of 3 times alone on both Node 24.21.0 and 26.12.1, taking about 3.0 s each time. Coverage was 96.14 lines, 91.49 branches and 94.85 functions, all above the floor of 92 / 85 / 91.
- **Required names.** The main ruleset requires `Check (ubuntu-latest)`, `Check (windows-latest)` and `Release build paths`. The release gate in `.github/workflows/release.yml:70` reads the same three names, so their spelling must not change.
- **macOS is untested.** Plan 062's "Why this matters" names its risks:
  - case-insensitive APFS (`IS_CASE_INSENSITIVE_FS`, `src/core/path-utils.ts:180`)
  - `tmpdir()` under `/var` resolves to `/private/var`, so every test root is an alias
  - `fs.watch` runs on FSEvents

## Global Constraints

- Work in `C:\filesystem-mcp` itself, and do not create a git worktree. Start with these commands, in this order:
  1. `git fetch origin`
  2. `git switch -c ci/macos-node26-legs origin/main` (`origin/main` is `6c764af0`)
  3. `npm ci`. `node_modules/` is not versioned, and another plan may have left a different SDK installed.
- Keep every `uses:` line exactly as it is, including the SHA pin and the `# vX` comment.
- Do not change `.nvmrc`, `package.json` `engines`, `release.yml`, `Dockerfile`, `mcpb/manifest.json`, the ruleset or repository settings. Making a leg required is the user's decision, after it has been green for a while.
- Coverage (`npm run test:coverage`) runs on exactly one leg: `ubuntu-latest` with the pinned Node.
- A fix allowed in Task 2 is a test assumption only, at most 5 changed lines per test, such as a `realpath` of a temp root. A product bug that a leg reveals is reported, not fixed.
- Pushing is outward-facing, so do not push or open a PR. Where a step needs a CI run, STOP and ask the user to push the branch.
- Run the shell commands in Git Bash.
- Run `npx prettier --write <changed files>` before each commit.
- Commit with a message file, never a bare `git commit`, because the harness sets `GIT_EDITOR=true`, which aborts it. Use the Write tool to write each message to `<scratchpad>/commit-msg.txt`, then run `git commit -F <scratchpad>/commit-msg.txt`. Every message ends with these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_015x93MERvWLDzoqaguLSmJj`

## Review Focus

- **The two required legs keep their exact names.** A typo in the `name:` expression would silently drop a required check, and the release gate would then refuse every tag. Task 1 Step 3 pins this with the run's job list.
- **The default Ubuntu leg stays on Node 24 and keeps coverage.** If `node: ['']` were dropped, the Node 26 `include` would merge into the default leg and quietly move it to 26. Task 1 Step 2 checks the parsed matrix, and Step 3 checks each leg's `node:` line and its test step.
- **A red experimental leg leaves the workflow green.** Task 2 Step 1 reads the run conclusion.
- **`release-paths` keeps `node-version-file: .nvmrc`.** Its `setup-node` block has the same text as the `check` job's block. Task 1 Step 2's `grep -c` checks this.
- **The subscription and outbound tests on a slow runner.** `outbound-regressions.test.ts:122` and the resources-subscribe test have each timed out once under load before. Task 2 classifies a failure that passes on re-run as a flake, not a product bug.

---

### Task 1: Add two legs to the CI matrix

**Files:**

- Modify: `.github/workflows/ci.yml:20-64` (the `check` job only)
- Modify: `CONTRIBUTING.md:78`
- Modify: `plans/062-ci-macos-and-node-next-legs.md` (`## Status`, line 19)
- Modify: `plans/README.md` (the row that starts with `| 062 `)

**Interfaces:**

- Consumes: nothing.
- Produces: 6 jobs per run:
  - `Check (ubuntu-latest)`
  - `Check (windows-latest)`
  - `Check (macos-latest)`
  - `Check (ubuntu-latest, node 26)`
  - `Release build paths`
  - `Plugin security`

  Task 2 reads the new legs' results by these names.

- [ ] **Step 0: Commit this plan on the branch**

```bash
git add docs/superpowers/plans/2026-10-24-ci-macos-node26-legs.md
```

Commit with the subject `docs(plan): add the CI macOS and Node 26 legs plan` and the two trailer lines, as the repo did in `d2da5c4e`.

- [ ] **Step 1: Edit the `check` job header**

Replace the job's `name:` and `strategy:` keys with the block below, and add `continue-on-error`. Keep `runs-on` and `timeout-minutes` as they are. The block is shown at its real indent: `check:` sits at 2 spaces under `jobs:`, as on line 20.

```yaml
check:
  # The first two legs keep their names exactly: the main ruleset and the
  # release gate require `Check (ubuntu-latest)` and `Check (windows-latest)`.
  name: Check (${{ matrix.os }}${{ matrix.node && format(', node {0}', matrix.node) || '' }})
  runs-on: ${{ matrix.os }}
  timeout-minutes: 15
  # New legs report but do not fail the workflow until they have been green
  # for a while; then delete their `experimental: true` lines.
  continue-on-error: ${{ matrix.experimental == true }}
  strategy:
    # One leg failing must not cancel the others: the point is to see all.
    fail-fast: false
    matrix:
      os: [ubuntu-latest, windows-latest, macos-latest]
      # '' means the .nvmrc pin. Keep this key: without it the node 26
      # include below merges into the default Ubuntu leg instead of adding one.
      node: ['']
      include:
        - os: macos-latest
          experimental: true
        - os: ubuntu-latest
          node: '26'
          experimental: true
```

GitHub's `include` rule decides how these resolve. An entry merges into each existing combination where it overwrites no _original_ matrix value. If it can merge into none, it becomes a new combination.

- The macOS entry merges into the macOS combination, so macOS stays one leg.
- The Node 26 entry would overwrite the original `node: ''` on the Ubuntu combination. It therefore becomes a new, fourth `Check` leg.

- [ ] **Step 2: Edit the Node input, the two Test steps and the docs**

`ci.yml` has two `setup-node` steps whose `with:` blocks are identical: one in `check` (lines 33-36) and one in `release-paths` (lines 74-77). Change **only the one in `check`**. `release-paths` keeps `node-version-file: .nvmrc`. The new block, at its real 8-space indent:

```yaml
with:
  # The pinned major from .nvmrc, unless the leg names another one.
  node-version: ${{ matrix.node }}
  node-version-file: ${{ !matrix.node && '.nvmrc' || '' }}
  cache: npm
```

In the `check` job, change only the `if:` lines of the two Test steps, and keep their comments:

- `Test`: `if: ${{ !cancelled() && steps.build.outcome == 'success' && (matrix.os != 'ubuntu-latest' || matrix.node != '') }}`
- `Test with coverage floor`: `if: ${{ !cancelled() && steps.build.outcome == 'success' && matrix.os == 'ubuntu-latest' && matrix.node == '' }}`

Replace `CONTRIBUTING.md` line 78 with this whole line:

```markdown
CI runs the same checks as separate steps on Ubuntu and Windows, plus two legs that report but do not block: macOS, and Ubuntu on Node 26. The Ubuntu leg on the pinned Node runs `npm run test:coverage` instead of `npm test`. Please run `npm run check` before you open a pull request.
```

In `plans/062-ci-macos-and-node-next-legs.md`, insert this as the first bullet under `## Status` (line 19):

```markdown
- **Superseded** 2026-10-24 by `docs/superpowers/plans/2026-10-24-ci-macos-node26-legs.md`; do not execute this plan.
```

In `plans/README.md`, replace the last cell of the `| 062 ` row (the status cell) with `SUPERSEDED by docs/superpowers/plans/2026-10-24-ci-macos-node26-legs.md`.

Verify:

```bash
npx prettier --write .github/workflows/ci.yml CONTRIBUTING.md plans/062-ci-macos-and-node-next-legs.md plans/README.md
npx prettier --check .
node -e "const j=require('yaml').parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8')).jobs;console.log(Object.keys(j).join(),j.check['continue-on-error'],JSON.stringify(j.check.strategy.matrix.node),j.check.steps[1].with['node-version'],j['release-paths'].steps[1].with['node-version-file'])"
grep -c 'node-version-file: .nvmrc$' .github/workflows/ci.yml
grep -cF "matrix.node == '' }}" .github/workflows/ci.yml
```

Expected:

- Prettier exits 0.
- The `node -e` line prints exactly: `check,release-paths,plugin-security ${{ matrix.experimental == true }} [""] ${{ matrix.node }} .nvmrc`
- Each `grep -c` prints `1`.

If `actionlint` is installed, `actionlint .github/workflows/ci.yml` prints nothing. It was not installed on the planning machine, so skip it if it is absent.

These edits were applied to a scratch copy on 2026-10-24 and produced exactly that output. Expanding the matrix by GitHub's `include` rule gives these 4 `Check` legs:

| Leg                              | Node     | Experimental | Test step                  |
| :------------------------------- | :------- | :----------- | :------------------------- |
| `Check (ubuntu-latest)`          | `.nvmrc` | no           | `Test with coverage floor` |
| `Check (windows-latest)`         | `.nvmrc` | no           | `Test`                     |
| `Check (macos-latest)`           | `.nvmrc` | yes          | `Test`                     |
| `Check (ubuntu-latest, node 26)` | `26`     | yes          | `Test`                     |

Commit:

```bash
git add .github/workflows/ci.yml CONTRIBUTING.md plans/062-ci-macos-and-node-next-legs.md plans/README.md
```

Commit message (contents of `commit-msg.txt`):

```text
ci: add a macOS leg and a Node 26 Ubuntu leg (non-blocking)

Node 26 is Active LTS from 2026-10-28 and engines is >=24, so users run it
untested; macOS is the one case-insensitive POSIX platform the path guard
branches on. Both legs use continue-on-error and new names, so the
required Check (ubuntu-latest) and Check (windows-latest) are unchanged.
Supersedes plan 062.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x93MERvWLDzoqaguLSmJj
```

- [ ] **Step 3: STOP for a CI run, then check the legs**

Ask the user to push `ci/macos-node26-legs` and open a draft PR. Once they confirm, get the run id and wait for the run to finish:

```bash
gh run list --workflow CI --branch ci/macos-node26-legs --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch <run-id>
```

`gh run view --log` refuses a run that is still in progress, so run the next two commands only after `gh run watch` reports the run completed:

```bash
gh run view <run-id> --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'
gh run view <run-id> --log | grep -E "node: v2[46]\.|Run npm (test|run test:coverage)$"
```

Expected:

- **Job list:** exactly 6 rows in any order: `Check (ubuntu-latest)`, `Check (windows-latest)`, `Check (macos-latest)`, `Check (ubuntu-latest, node 26)`, `Release build paths` and `Plugin security`.
- **Log lines:** each line starts with its job name. `Check (ubuntu-latest)` shows `node: v24.` and `Run npm run test:coverage`. `Check (ubuntu-latest, node 26)` shows `node: v26.` and `Run npm test`. The windows and macOS legs show `Run npm test`.

If a required name is missing or spelled differently, STOP and fix the `name:` expression before anything else.

---

### Task 2: Triage the first run

**Files:**

- Modify: `__tests__/*.test.ts`, only for test-assumption fixes, as Global Constraints allows
- Create: nothing

**Interfaces:**

- Consumes: Task 1's run id and its job names.
- Produces: a triage report to the user. Fixes land as commits on the same branch.

- [ ] **Step 1: Read the result**

Run: `gh run view <run-id> --json conclusion --jq .conclusion`
Expected: `success`, even when an experimental leg failed.

- If it is `failure` and only an experimental leg is red, STOP: `continue-on-error` did not apply.
- If a required leg (`Check (ubuntu-latest)`, `Check (windows-latest)` or `Release build paths`) is red, re-run it once. If it is still red, STOP and report it: this plan's change did not cause it.

- [ ] **Step 2: Classify each failing test on a new leg**

For each failure in `Check (macos-latest)` or `Check (ubuntu-latest, node 26)`, read the log with `gh run view <run-id> --log-failed`. Put each one in exactly one class:

| Class           | How to recognize it                       | Action                         |
| :-------------- | :---------------------------------------- | :----------------------------- |
| Flake           | passes when its job is re-run             | record the name, no change     |
| Test assumption | test hard-codes a fact of another OS/Node | fix, ≤5 lines, one commit each |
| Product bug     | server behaves wrong on that platform     | report as a candidate plan     |

A test assumption is a test that hard-codes a non-macOS path or case fact, or a Node-24-only runtime detail such as error text or timing.

To re-run one job, get its id with `gh run view <run-id> --json jobs --jq '.jobs[] | [.databaseId, .name, .conclusion] | @tsv'`, then run `gh run rerun --job <databaseId>`. Do not rely on `gh run rerun <run-id> --failed`: a run whose conclusion is `success` may refuse it.

A test-assumption commit uses the subject `test: <what the test assumed> on macOS` or `test: <what the test assumed> on Node 26`, plus the two trailer lines. After each fix, run `npm test` on Windows. Expected: `ℹ fail 0`. That run proves nothing about the leg itself, so after the last fix commit, STOP and ask the user to push again. Report each fix as unverified on its leg until that run passes.

- [ ] **Step 3: Report**

Report to the user:

- the run URL
- each new leg's conclusion
- the classified failures, with log excerpts

For each product bug, give its failing test name, the assertion message and the platform fact behind it. Do not change the `experimental` flags. Removing them is the user's call, after the legs have stayed green.
