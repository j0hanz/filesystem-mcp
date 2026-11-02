# Trust and reach implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the server's trust signals on listing sites, then earn more users and GitHub stars through wider listings and one launch aimed at people who care what an agent can touch.

**Architecture:** Four stages, in order, each gated on the last: trust signals (Tasks 1-3), proof assets (Task 4), listings (Task 5), launch and measurement (Task 6). Tasks 1-4 land as one pull request. Tasks 5-6 change nothing in the repository and publish under the maintainer's name.

**Tech Stack:** GitHub Actions, `hashgraph-online/ai-plugin-scanner-action`, `ossf/scorecard-action`, Markdown, `ffmpeg`, and the `agent-browser` skill for recording.

**Spec:** No separate spec. The strategy was agreed in conversation on 2026-11-02, and its decisions are under Global Constraints.

## Global Constraints

- **Pitch:** file access for AI with secrets hidden, risky changes confirmed, and undo. Aim at people who worry about what an agent can touch. Do not try to replace `@modelcontextprotocol/server-filesystem` (2,649,073 npm downloads a month, against 5,085 here).
- **Accurate claims only:** never say every change is confirmed. `SECURITY.md` says in-place edits with `edit`, `patch`, and `replace_text` do not ask. Name specific protections, and never use "secure" or "safe" as a blanket claim in new copy.
- **`ci.yml` stays secret-free and `contents: read`:** its first line requires this because it runs on agent PRs without approval. Anything needing `id-token: write` goes in its own workflow that never runs on `pull_request`.
- **Actions are pinned by commit SHA** with a version comment, as `ci.yml` does:
  - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
  - `hashgraph-online/ai-plugin-scanner-action@6d8ae026ae24ed2f2e9099c391cd9b62cd869d30 # v1.2.814`
  - `ossf/scorecard-action@fa7117db83c52d787ae5a89f350999701505d78e # v2.5.0`
- **Required check names do not change:** the `main: green CI required` ruleset and the release gate at `release.yml:70` depend on them.
- **Versions:** never hand-edit `package.json`, `server.json`, or plugin manifest versions.
- **Forbidden:** bought stars, star-for-star exchanges, listing bots, comments promoting this server on other projects' issues, and undisclosed self-promotion.
- **Outward actions need the maintainer's approval each time:** pushing, opening PRs, dismissing alerts, submitting listings, and posting.

## Review Focus

1. **A fork or agent PR must never get an OIDC token.** `plugin-report.yml` must have no `pull_request` trigger. Task 1 checks this.
2. **The rescan may not clear HOL's penalty.** Whether `report_to_hol` removes the "Caution" result or the 10% reduction is unverified. Task 1 records the before and after, and asks HOL if nothing changes.
3. **A scanner bump may lower the score below `min_score: 80`.** That would turn `Plugin security` red on every PR. Task 1 checks the PR's run before merge.
4. **A low Scorecard result advertised in the README hurts trust.** Task 2 adds the badge only at 6.0 or above.
5. **Listing copy can drift from behavior.** Task 5 checks the copy against `SECURITY.md` and the README comparison table before the first submission.

---

### Task 1: Report CI scans to HOL

> **Blocked, 2026-11-02:** action v1.2.814 accepts `report_to_hol`, but the newest `plugin-scanner` wheel (3.58.0) has no report code, so the job would pass and send nothing. Only the `ci.yml` pin bump ships now. Add `plugin-report.yml` once an action release bundles a wheel containing `send_ci_report`, and confirm the `HOL CI report:` line in the first run's log, because a green job proves nothing. Add `persist-credentials: false` to its checkout and `if: github.ref == 'refs/heads/main'` to its job. Until then, ask HOL to rescan.

**Files:**

- Create: `.github/workflows/plugin-report.yml`
- Modify: `.github/workflows/ci.yml:99` (scanner pin only)

**Interfaces:**

- Produces: workflow `Plugin report`, triggered by `push` to `main` and `workflow_dispatch`.

- [ ] **Step 1: Record the baseline**

Read `https://hol.org/registry/plugins/j0hanz%2Ffilesystem-mcp#trust`. Expected: Trust Score 68, Plugin Security 64, source commit `9eca93e`. Save any changed values in the PR description.

- [ ] **Step 2: Create `.github/workflows/plugin-report.yml`**

```yaml
# Sends the scan summary to HOL so listings show the latest CI result. Holds
# id-token: write, so it must never run on pull_request; ci.yml stays read-only.
name: Plugin report

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  report:
    name: Report plugin scan
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: hashgraph-online/ai-plugin-scanner-action@6d8ae026ae24ed2f2e9099c391cd9b62cd869d30 # v1.2.814
        with:
          plugin_dir: .
          report_to_hol: true
```

- [ ] **Step 3: Bump the scanner pin at `ci.yml:99`**

Use the same SHA and comment as Step 2. Change nothing else in `ci.yml`.

- [ ] **Step 4: Check the trigger and formatting**

Run: `npx prettier --check .github/workflows/plugin-report.yml .github/workflows/ci.yml`
Expected: all files pass.

Run: `git grep -n "pull_request" -- .github/workflows/plugin-report.yml`
Expected: only the comment line matches.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/plugin-report.yml .github/workflows/ci.yml
git commit -m "ci: report plugin scans to HOL from main"
```

- [ ] **Step 6: Verify after merge**

Check the PR first: `Plugin security` must pass on the bumped scanner.

Run: `gh run list --workflow plugin-report.yml --limit 1`
Expected: `success`. A failed report only logs and never fails the job, so also read the log for the report line.

Reread the HOL page. Expected: the source commit is newer than `9eca93e`, and the 3 missing-URL findings and the CI reduction are gone.

If the page has not changed after 48 hours, ask HOL through its listed support route. Do not change the repository to chase the score.

### Task 2: Publish the Scorecard result

**Files:**

- Create: `.github/workflows/scorecard.yml`
- Modify: `README.md:10` (badge, conditional, after merge)

**Interfaces:**

- Produces: a public score at `https://api.securityscorecards.dev/projects/github.com/j0hanz/filesystem-mcp`.

- [ ] **Step 1: Create `.github/workflows/scorecard.yml`**

Scorecard rejects top-level write permissions and extra steps, so this file stays minimal. SARIF upload is left out because publishing the result is the only goal.

```yaml
name: Scorecard

on:
  push:
    branches: [main]
  schedule:
    - cron: '17 4 * * 1'
  workflow_dispatch:

permissions: read-all

jobs:
  analysis:
    name: Scorecard analysis
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: ossf/scorecard-action@fa7117db83c52d787ae5a89f350999701505d78e # v2.5.0
        with:
          results_file: results.json
          results_format: json
          publish_results: true
```

- [ ] **Step 2: Check formatting**

Run: `npx prettier --check .github/workflows/scorecard.yml`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/scorecard.yml
git commit -m "ci: publish an OpenSSF Scorecard"
```

- [ ] **Step 4: Verify after merge**

Run: `curl -s https://api.securityscorecards.dev/projects/github.com/j0hanz/filesystem-mcp`
Expected: JSON with a numeric `score`.

- [ ] **Step 5: Add the badge only if `score` is 6.0 or above**

Add this after the CI badge on `README.md:10`, in a follow-up PR. Below 6.0, list the failing checks for the maintainer and leave the README alone.

```markdown
[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/j0hanz/filesystem-mcp?style=flat-square&label=OpenSSF%20Scorecard)](https://scorecard.dev/viewer/?uri=github.com/j0hanz/filesystem-mcp)
```

### Task 3: Close the open trust gaps

**Files:**

- Create: `CODE_OF_CONDUCT.md`
- Modify: `SECURITY.md` (new section before the closing "See the Security section" paragraph)
- Modify: `README.md:58-60` (comparison date, and rows if they changed)

**Interfaces:**

- Produces: the `What this does not protect against` section, which Task 5's copy must not contradict.

- [ ] **Step 1: Create `CODE_OF_CONDUCT.md`**

```markdown
# Code of conduct

This project follows the
[Contributor Covenant, version 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

To report a problem privately, use
[GitHub's report form](https://github.com/contact/report-abuse). The maintainer
can remove comments, issues, and contributors that break the code.
```

- [ ] **Step 2: Add this section to `SECURITY.md`**

```markdown
## What this does not protect against

- **Secrets under ordinary names.** The secret-file list matches paths and
  names, not contents. An API key in `notes.txt` is readable if its folder is
  allowed.
- **Anything the AI can read leaving your machine.** The server makes no network
  calls, but your AI client may send what it reads to its model provider.
- **Instructions hidden in files.** File contents reach the AI unfiltered, so
  allow only folders whose contents you trust the AI to read.
- **In-place edits.** `edit`, `patch`, and `replace_text` apply without asking.
  `dryRun` previews them, and `undo` reverts them only while the server runs.
- **Other software on your machine.** This is a check inside the server, not an
  operating system sandbox. Other tools and processes keep their own access.
```

- [ ] **Step 3: Refresh the comparison at `README.md:58-60`**

Read the current README at `https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem`. Update any row that changed and set the date to the day you checked. If nothing changed, change only the date.

- [ ] **Step 4: Dismiss CodeQL alert 1 (maintainer approval required)**

`examples/clients/browser/server.ts:103` sends `error.message` to a page on `127.0.0.1` only. The page shows that message, and `check.ts:116` asserts it, so removing it would break the example. Do not change the code.

```bash
gh api -X PATCH repos/j0hanz/filesystem-mcp/code-scanning/alerts/1 -f state=dismissed -f dismissed_reason="won't fix" -f dismissed_comment="Local example: the message reaches only the user's own page on 127.0.0.1, which shows it by design."
```

Expected: JSON with `"state": "dismissed"`.

- [ ] **Step 5: Run the checks**

Run: `npm run check:static`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add CODE_OF_CONDUCT.md SECURITY.md README.md
git commit -m "docs: state security limits and add a code of conduct"
```

### Task 4: Proof assets

**Files:**

- Create: `assets/demo.gif`
- Create: `assets/social-preview.png`
- Modify: `README.md` (between the badge block ending at line 14 and `## What is this?`)

**Interfaces:**

- Consumes: `examples/clients/browser`, which already shows the server's confirmation dialog.
- Produces: `assets/demo.gif` for the README and launch posts, and `assets/social-preview.png` for the repository settings.

- [ ] **Step 1: Build a demo folder outside the repository**

Use a new temporary folder holding `README.md`, `app.ts`, and a `.env` containing the fake value `API_KEY=example`.

- [ ] **Step 2: Run the example against the local build**

Run from `examples/clients/browser`, with `FS_MCP_BIN` set to the absolute path of `dist/index.js`: `npm install`, then `node server.ts <demo folder> --port 8787`.
Expected: prints `browser: http://127.0.0.1:8787/`.

- [ ] **Step 3: Capture the two scenes**

Use the `agent-browser` skill to take frames. Scene 1: the file list, with `.env` absent. Scene 2: creating `README.md` over the existing file, with the overwrite dialog open, then choosing `skip`. Undo is left out because the page has no undo control.

- [ ] **Step 4: Encode `assets/demo.gif`**

Use `ffmpeg` at 900 px wide. Expected: under 5 MB, readable, and showing only the demo folder's fake data.

- [ ] **Step 5: Add the GIF to the README**

```markdown
![The AI lists a folder with .env hidden, then the server asks before overwriting a file](assets/demo.gif)
```

- [ ] **Step 6: Create `assets/social-preview.png`**

Size 1280x640: `assets/logo.png`, the name "Filesystem MCP", and the README tagline "Let your AI assistant work with your files, safely." Verify the size with `ffprobe`.

- [ ] **Step 7: Run the checks**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add assets/demo.gif assets/social-preview.png README.md
git commit -m "docs: show the safety checks in a README demo"
```

- [ ] **Step 9: Maintainer uploads the preview**

Upload `assets/social-preview.png` under GitHub Settings, General, Social preview. GitHub offers no API for this.

Verify: `gh repo view j0hanz/filesystem-mcp --json usesCustomOpenGraphImage`
Expected: `true`.

### Task 5: Listings

**Gate:** Tasks 1-4 merged. Each submission needs the maintainer's approval. Nothing is committed.

**Interfaces:**

- Consumes: the `SECURITY.md` section from Task 3.

- [ ] **Step 1: Check the copy against the docs**

Compare both blocks below with `SECURITY.md` and the README comparison table. Fix the copy if any claim is out of date.

Short:

```text
File tools for AI assistants, limited to the folders you choose. Secret files stay hidden, and overwrites and non-empty folder deletes wait for your OK.
```

Long:

```text
Filesystem MCP gives your AI client tools to read, search, edit, and patch files in folders you allow. .env files, private keys, and cloud credentials are blocked by default. The server asks before overwriting a file with create or move, deleting a non-empty folder, or opening a new folder. In-place edits can be previewed with dryRun and reverted with undo for 30 minutes while the server runs. --read-only removes every tool that writes. It runs locally with no telemetry. Install: npx -y @j0hanz/filesystem-mcp@latest
```

- [ ] **Step 2: Bump the two stalled PRs, once each**

Add one polite comment to `docker/mcp-registry#5247` and `punkpeye/awesome-mcp-servers#15135`, asking what is needed to merge. Read each PR's checks first and fix anything failing. Do not comment again.

- [ ] **Step 3: Submit, checking for an existing listing first**

Open each site in a browser, because some blocked automated checks. Update an existing entry instead of adding a duplicate. Work in this order, and record each URL for Task 6.

| Order | Where            | Route                                                                                  |
| :---- | :--------------- | :------------------------------------------------------------------------------------- |
| 1     | Claude plugins   | https://clau.de/plugin-directory-submission                                            |
| 2     | Cline            | https://github.com/cline/mcp-marketplace/issues/new?template=mcp-server-submission.yml |
| 3     | PulseMCP         | https://www.pulsemcp.com/submit                                                        |
| 4     | mcp.so           | https://mcp.so/submit                                                                  |
| 5     | mcpservers.org   | https://mcpservers.org/submit                                                          |
| 6     | MCP Market       | https://mcpmarket.com/submit                                                           |
| 7     | Cursor directory | https://cursor.directory/mcp                                                           |
| 8     | Smithery         | Current route from smithery.ai; the old docs URL returned 404                          |

- [ ] **Step 4: Finish the community signals**

Maintainer completes the self-certification at `https://www.bestpractices.dev/en`.

Run: `gh repo edit j0hanz/filesystem-mcp --enable-discussions`
Then open one Discussion: "What should a filesystem server refuse to do?"

Verify: `gh api repos/j0hanz/filesystem-mcp/community/profile --jq .health_percentage`
Expected: above the current 85.

### Task 6: Launch and measure

**Gate:** Task 5 Step 3 finished, and the HOL page no longer shows "Caution". If HOL has not updated within 2 weeks of asking, the maintainer decides whether to launch anyway.

**Interfaces:**

- Consumes: `assets/demo.gif` and the Task 5 copy.

- [ ] **Step 1: Draft the post outside the repository**

Title: "What a filesystem MCP server should refuse." Cover symlink escapes, secret files, overwrites, and the limits from `SECURITY.md`. Link to real test cases. Run it through the `writeup:unslop` skill. The maintainer reviews every claim.

- [ ] **Step 2: Maintainer publishes on a weekday, spaced 2-3 days apart**

Agents do not post. Disclose authorship everywhere, and read each community's self-promotion rules first.

1. The technical post, on dev.to or a personal blog.
2. Show HN: "Show HN: Filesystem MCP – AI file access with secrets hidden and overwrites confirmed". This is usually a one-time chance.
3. r/mcp, then r/ClaudeAI.
4. A short pitch to MCP newsletters, starting with PulseMCP's weekly.

- [ ] **Step 3: Answer comments the same day**

File real bugs as issues. Correct any wrong claim in the post openly.

- [ ] **Step 4: Measure monthly**

GitHub traffic data lasts only 14 days, so record it each time.

```bash
gh repo view j0hanz/filesystem-mcp --json stargazerCount
gh api repos/j0hanz/filesystem-mcp/traffic/views --jq '{count,uniques}'
gh api repos/j0hanz/filesystem-mcp/traffic/popular/referrers
curl -s https://api.npmjs.org/downloads/point/last-month/@j0hanz/filesystem-mcp
```

The targets below are estimates, not commitments. Use them to compare channels. Bots may inflate npm downloads.

| Metric               | 2026-11-02 | 90-day target |
| :------------------- | :--------- | :------------ |
| GitHub stars         | 26         | 150+          |
| npm downloads/month  | 5,085      | 15,000        |
| HOL trust score      | 68         | 85+           |
| HOL directory lists  | 0 of 5     | 3+            |
| Unique views/14 days | 137        | 500           |
