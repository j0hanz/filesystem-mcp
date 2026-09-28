# Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken and stale directory listings for
`@j0hanz/filesystem-mcp`, and list it on the live directories that still
accept submissions.

**Architecture:** One task changes code, in `j0hanz/j0hanz-marketplace`: it
pins the plugin's npx launcher so that Anthropic's plugin directory accepts
it. Every other task is an outward-facing submission:

- one CLI call against the official MCP Registry,
- one PR to an external awesome-list,
- web forms that need the maintainer's own login.

**Nothing in this repository changes except the run log.**

**Deferred by the spec, so this plan leaves them out:**

- ToolHive, Docker, and the GitHub/VS Code registry (gap rows 9–11): low
  throughput or no way to submit.
- Glama's stale description and LobeHub's unclaimed entries: the spec
  found no verified way to fix them.

**Tech Stack:**

- `mcp-publisher` v1.8.1
- `gh` CLI
- Node 24 (`node --test`) in the marketplace repo
- `claude plugin validate`
- Web forms: claude.ai developer portal, cursor.directory, mcp.so, Cline
  issue form, mcpservers.org, MCP Market

**Spec:**
[`publishers.md`](publishers.md). Read its "Top 5 next actions", gap rows
1–8, and "Retired or closed".

**Written against:**

- this repo at `45c5bab7` (v2.6.1);
- `j0hanz/j0hanz-marketplace` at `cc9ef7b`.

Both dated 2026-09-27.

## Global Constraints

- Never hand-edit `version` in `package.json`, `server.json`, or
  `mcpb/manifest.json` in this repo (AGENTS.md).
- Every outward-facing action needs the maintainer's go-ahead before it
  runs, each time. Approval for one does not carry to the next. This covers
  a registry status change, a PR to someone else's repo, and a form
  submission.
- Use the pinned `mcp-publisher` only: `MCP_PUBLISHER_VERSION=v1.8.1`,
  `MCP_PUBLISHER_SHA256=a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc`
  for the `linux_amd64` asset (`.github/workflows/release.yml`). On Windows,
  take `mcp-publisher_windows_amd64.tar.gz` from the same release and check
  its hash against `registry_1.8.1_checksums.txt`.
- Canonical one-line description, verbatim:
  `Secure filesystem MCP server for reading, writing, searching, diffing, and patching files.`
- Canonical repo URL: `https://github.com/j0hanz/filesystem-mcp`.
- Canonical npx config: `npx -y @j0hanz/filesystem-mcp@latest <dir>`. The
  exception is the Claude plugin, which is pinned by Task 1.
- Logo: `assets/logo.png`, 400×400 PNG.
- Privacy policy URL:
  `https://github.com/j0hanz/filesystem-mcp#privacy-policy`.
- Do not use any paid tier ($39 "skip review" on mcp.so and mcpservers.org)
  unless the maintainer says so.

## Review Focus

1. **Pin drift after the next release.** The maintainer bumps
   `plugin.json` `version` by hand and forgets the `.mcp.json` pin. The
   plugin then ships an old server. Task 1's test fails when the two
   differ.
2. **Wrong registry name.** Deprecating `io.github.j0hanz/filesystem-mcp`
   instead of `io.github.j0hanz/filesystem-context` would hide the live
   server. Task 2's verify step checks both entries.
3. **Awesome-list edit touches more than one line.** A reformat or
   re-sort in punkpeye's 2,000-line README buries the change and gets the
   PR rejected. Task 3 checks that the diff is exactly `1 1` in
   `--numstat`.
4. **Name collision with the reference server.** cursor.directory's slug
   `filesystem-mcp` belongs to `@modelcontextprotocol/server-filesystem`,
   so a submission under that name merges or confuses the two. Task 5
   submits as `j0hanz-filesystem-mcp` and checks the resulting page's
   install args.
5. **The broken mcp.so entry survives.** A new entry next to the old one
   still leaves a copy-paste install that returns 404 on npm. Task 6 files
   the removal ticket and records its URL.

---

### Task 1: Pin the plugin's npx launcher to the plugin version (marketplace repo)

The Claude plugin directory blocks `@latest` as "Unpinned npx launcher"
([pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist)).
Pinning also means plugin users get a new server only when the plugin
version bumps. That is the directory's intent.

**Files** (all in `j0hanz/j0hanz-marketplace`):

- Modify: `plugins/filesystem-mcp/.mcp.json:6`
- Modify: `plugins/filesystem-mcp/test/config.test.mjs:17-21`
- Modify: `plugins/filesystem-mcp/README.md:7` (the "`latest` dist-tag"
  sentence)

**Interfaces:**

- Produces: `.mcp.json` `args[1]` equals
  `` `@j0hanz/filesystem-mcp@${plugin.json version}` ``. Task 4 submits
  this folder.

- [ ] **Step 1: Branch**

  ```bash
  gh repo clone j0hanz/j0hanz-marketplace && cd j0hanz-marketplace && git switch -c fix/pin-filesystem-mcp
  ```

- [ ] **Step 2: Change the test so it demands the pin.** In
      `config.test.mjs`, replace the literal `args` array inside the
      `deepEqual` with the pinned value from the manifest:

  ```js
  args: ['-y', `@j0hanz/filesystem-mcp@${manifest.version}`, '${CLAUDE_PROJECT_DIR}'],
  ```

  Rename the test to
  `'filesystem plugin pins the server to the plugin version with project-scoped stdio defaults'`.

- [ ] **Step 3: Run the test and confirm it fails**

  Run: `node --test plugins/filesystem-mcp/test/config.test.mjs`

  Expected: FAIL. The diff shows `'@j0hanz/filesystem-mcp@latest'` against
  `'@j0hanz/filesystem-mcp@2.6.1'`.

- [ ] **Step 4: Pin `.mcp.json`.** Set `args[1]` to
      `"@j0hanz/filesystem-mcp@2.6.1"`.

- [ ] **Step 5: Fix the README copy.** Line 7 should say that the first
      launch downloads the `@j0hanz/filesystem-mcp` version pinned in
      `.mcp.json`, matching the plugin version. The word `latest` must not
      remain on that line.

- [ ] **Step 6: Run the full marketplace check**

  Run: `npm run check`

  Expected: exit 0. This covers lint, format, `claude plugin validate
  --strict` for every catalog entry, typecheck, and tests.

- [ ] **Step 7: Commit, push, open PR** (own repo; still confirm with the
      maintainer before pushing)

  ```bash
  git add plugins/filesystem-mcp
  git commit -m "fix(filesystem-mcp): pin npx launcher to the plugin version"
  git push -u origin fix/pin-filesystem-mcp
  gh pr create --fill
  ```

  Expected: PR open, CI green.

  **STOP** if a maintainer-side rule rejects pinning. Report it, and do not
  run Task 4.

### Task 2: Deprecate the legacy registry entry

The spec is gap row 1. This task needs a GitHub device-flow login, so the
maintainer runs it. Use `! <command>` in Claude Code.

**Files:** none.

**Interfaces:** Consumes nothing. Produces: `io.github.j0hanz/filesystem-context`
has status `deprecated`, and PulseMCP picks that up when its ingestion
resumes.

- [ ] **Step 1: Record the before state**

  ```bash
  curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.j0hanz/filesystem-context&version=latest" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s).servers[0];console.log(x.server.name,x.server.version,x._meta['io.modelcontextprotocol.registry/official'].status)})"
  ```

  Expected: `io.github.j0hanz/filesystem-context 1.0.9 active`

- [ ] **Step 2: Log in**

  Run `mcp-publisher login github` and complete the device flow as
  `j0hanz`.

- [ ] **Step 3: Deprecate every version**

  ```bash
  mcp-publisher status --status deprecated --all-versions --message "Renamed: use io.github.j0hanz/filesystem-mcp" io.github.j0hanz/filesystem-context
  ```

  Expected: exit 0, and a confirmation that lists the updated versions.

- [ ] **Step 4: Verify both entries**

  Re-run Step 1. Expected: `… deprecated`. Then run the same command with
  `io.github.j0hanz/filesystem-mcp`. Expected:
  `io.github.j0hanz/filesystem-mcp 2.6.1 active`.

  **STOP** if the second entry is anything but `active`. Revert with
  `mcp-publisher status --status active --all-versions io.github.j0hanz/filesystem-mcp`.

### Task 3: Fix the punkpeye awesome-list entry

The spec is gap row 2. The PR goes to an external repo, so confirm with
the maintainer before Step 5.

**Files** (in the fork of `punkpeye/awesome-mcp-servers`): Modify
`README.md`, the one line that contains
`j0hanz/filesystem-context-mcp-server`.

**Interfaces:** Consumes the Glama badge URL
`https://glama.ai/mcp/servers/j0hanz/filesystem-mcp/badges/score.svg`,
which returns HTTP 200.

- [ ] **Step 1: Fork and branch**

  ```bash
  gh repo fork punkpeye/awesome-mcp-servers --clone && cd awesome-mcp-servers && git switch -c update-j0hanz-filesystem-mcp
  ```

- [ ] **Step 2: Replace the line.** Find the one line matching
      `j0hanz/filesystem-context-mcp-server` and replace it with exactly
      this:

  ```markdown
  - [j0hanz/filesystem-mcp](https://github.com/j0hanz/filesystem-mcp) [![j0hanz/filesystem-mcp MCP server](https://glama.ai/mcp/servers/j0hanz/filesystem-mcp/badges/score.svg)](https://glama.ai/mcp/servers/j0hanz/filesystem-mcp) 📇 🏠 🍎 🪟 🐧 - Read, write, search (RE2), diff, and patch files inside allowed roots; stdio or Streamable HTTP.
  ```

- [ ] **Step 3: Check the diff size**

  Run: `git diff --numstat`

  Expected: `1	1	README.md`

- [ ] **Step 4: Check alphabetical position**

  Run: `grep -n -A1 -B1 "j0hanz/filesystem-mcp" README.md`

  Expected: the line before starts `- [isaacphi/`, the line after starts
  `- [jeannier/`.

- [ ] **Step 5: Commit and open PR**

  ```bash
  git commit -am "Update j0hanz/filesystem-mcp (renamed from filesystem-context-mcp-server)"
  git push -u origin update-j0hanz-filesystem-mcp
  gh pr create --repo punkpeye/awesome-mcp-servers --title "Update j0hanz/filesystem-mcp (renamed repo)" --body "Repo was renamed from filesystem-context-mcp-server and is no longer read-only. Updates link, description, platforms, and adds the Glama score badge."
  ```

  Expected: PR open, and the `Check Glama Link` job passes.

### Task 4: Submit the plugin to Anthropic's Claude plugin directory

The spec is gap row 3. The maintainer does this in the browser. It
depends on Task 1 being merged.

**Files:** none.

**Interfaces:** Consumes the pinned `plugins/filesystem-mcp` folder on
`j0hanz-marketplace` `main`.

- [ ] **Step 1: Validate.** Open https://claude.ai/directory/manage and
      choose **Submit new** → **Plugin bundle**. Set:
  - Repository: `j0hanz/j0hanz-marketplace`
  - Plugin path: `plugins/filesystem-mcp`
  - Branch: empty (uses `main`)

  Select **Validate**.

  Expected: no **Blocking** findings. Holds for "Runs a pinned npx or uvx
  package" and possibly "Name may be confused with an existing listing"
  are expected.

- [ ] **Step 2: Answer the data-handling step.** Base each answer on the
      README privacy section:
  - The plugin reads local files the user allows.
  - It stores nothing outside the user's machine.
  - It sends data to no service; the MCP client's own provider policy
    applies.
  - It is not aimed at under-18s.

- [ ] **Step 3: Submit.** Keep **GitHub push webhook**. Select **Submit
      for review**, then **Set up push updates**.

  Expected: the portal shows the plugin under **Submissions**, with a
  status.

- [ ] **Step 4: Log it.** Record the submission status and date in the run
      log (Task 8).

### Task 5: Submit to cursor.directory

The spec is gap row 4. The maintainer does this in the browser, signed in
with GitHub.

**Files:** none.

- [ ] **Step 1: Submit.** At https://cursor.directory/plugins/new, set:
  - Name: `j0hanz-filesystem-mcp`
  - Display name: `Filesystem MCP (j0hanz)`
  - Description: the canonical one.
  - Repo: the canonical URL.
  - Config: the contents of `mcp.json` in this repo.

- [ ] **Step 2: Verify the page**

  Open the resulting plugin page. Expected: its config shows
  `@j0hanz/filesystem-mcp`, not `@modelcontextprotocol/server-filesystem`.

### Task 6: Replace the broken mcp.so entry

The spec is gap row 5. The maintainer does this in the browser.

**Files:** none.

- [ ] **Step 1: Submit the new entry.** At https://mcp.so/submit, set:
  - Type: Server
  - Repository: the canonical URL
  - Name: `Filesystem MCP`

  Use the free tier.

- [ ] **Step 2: Request removal of the old entry.** Open a support ticket
      from the submit page and ask them to remove or redirect
      `https://mcp.so/server/filesystem-context-mcp-server/j0hanz`. Give
      the reason: its install config runs `@j0hanz/filesystem-context-mcp`,
      which returns 404 on npm, and the repo was renamed. Record the ticket
      reference.

### Task 7: Batch submissions (low odds or unverified reach)

The spec is gap rows 6–8. The maintainer does these in the browser. The
Cline form needs a logo upload, which `gh` cannot attach.

**Files:** none. Optional: add `llms-install.md` to this repo only if the
Cline test in Step 1 fails.

- [ ] **Step 1: Cline.** In a Cline session, install the server using only
      `README.md`. If that works, open
      https://github.com/cline/mcp-marketplace/issues/new?template=mcp-server-submission.yml
      and fill in:
  - GitHub Repository URL: the canonical repo URL.
  - Logo Image: upload `assets/logo.png`.
  - Installation Testing: tick both boxes.
  - Additional Information: RE2 search that no pattern can hang, the
    default deny list for sensitive files, a `--read-only` mode, and
    stdio or Streamable HTTP.

- [ ] **Step 2: mcpservers.org.** At https://mcpservers.org/submit, set:
  - Category: File System
  - Short Description: the canonical one.
  - Official MCP Registry Name: `io.github.j0hanz/filesystem-mcp`

  Use the free tier.

- [ ] **Step 3: MCP Market.** Submit the canonical repo at
      https://mcpmarket.com/submit.

### Task 8: Run log

**Files:** Create `docs/plan/2026-09-24-distribution/distribution.run.md`
in this repo.

- [ ] **Step 1: Write the log.** Add one row per task: task number,
      date, outcome (`submitted` / `merged` / `pending review` /
      `skipped` / `failed`), and link (PR, ticket, or listing URL).
      Include any STOP condition you hit, with its evidence.

- [ ] **Step 2: Format and commit**

  ```bash
  npx prettier --write docs/plan/2026-09-24-distribution/
  git add docs/plan/2026-09-24-distribution/
  git commit -m "docs(plans): add distribution plan and run log"
  ```

  Expected: `npm run check:static` still passes.
