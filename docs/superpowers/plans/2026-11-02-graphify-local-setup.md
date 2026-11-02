# Graphify Local Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up Graphify locally for this repo: a deep code graph that Claude Code queries through a skill and non-strict pre-grep hooks, with zero repo footprint and a local git hook keeping it fresh.

**Architecture:** Install the `graphifyy` CLI as an isolated uv tool. Bare `graphify install` registers the `/graphify` skill plus PreToolUse hooks in the user's Claude Code config (user-global, not project). One deep on-device index writes three artifacts under `graphify-out/`, which stay out of the repo via `.git/info/excludes`. A git hook in `.git/hooks/` runs the incremental `--update` pass on every commit.

**Tech Stack:** Python 3.14.5 (uv-managed fallback 3.12 if wheels missing), uv 0.12.5, `graphifyy` (PyPI, double y), tree-sitter parsing, Claude Code skill + hooks.

**Spec:** The settled grilling decisions from the 2026-11-02 session (no separate spec doc exists). Decision table:

| Decision | Choice |
| :-- | :-- |
| Wiring | Local bare `graphify install` (skill + pre-grep hooks) |
| First index | `graphify . --mode deep` |
| Model pass | Skipped; revisit after graph proves useful |
| Repo footprint | Zero — all ignores in `.git/info/excludes`, config user-global |
| Freshness | Local git hook in `.git/hooks`, incremental `--update` per commit |
| Strict | Non-strict; flip with `GRAPHIFY_HOOK_STRICT=1` later |

## Global Constraints

- Package name on PyPI is `graphifyy` (double y); the command is `graphify`. Never install a package named `graphify`.
- Local only: no API keys, no account, no code leaves the machine. The optional model pass is out of scope for this plan.
- Zero repo footprint: no tracked file may change. Success condition for the whole plan: `git status --porcelain` is empty at the end. Nothing is committed at any point.
- Non-strict: do not pass `--strict` to `graphify install`.
- Windows: run `graphify .` in PowerShell without the leading slash; `/graphify .` is the in-assistant spelling only.
- Rollback must be available at every point: `graphify uninstall --purge` plus the backups from Task 1.
- Python 3.10+ required; 3.14.5 present. uv 0.12.5 present.

## Review Focus

Failure modes this setup could hit, pinned by a task's verification:

1. Wrong package: PyPI `graphify` is not Graphify Labs. Pinned by Task 2 step 3 (`uv tool list` shows `graphifyy`; help text references the graph, not something else).
2. Footprint leak: `graphify-out/` or a CLAUDE.md section landing in the repo. Pinned by Task 3 step 4 and Task 6 step 3 (`git status --porcelain` empty; `git check-ignore` matches).
3. Stale graph: hook missing or broken, so pre-grep hooks inject outdated context. Pinned by Task 5 steps 3-4 (hook file exists in `.git/hooks/` and runs standalone, exit 0).
4. Hooks degrading normal Claude Code use: PreToolUse hook errors or blocks raw reads. Pinned by Task 7 step 2 (fresh session: grep works, graph context appears, nothing blocked).
5. Deep index hangs or 3.14 wheels missing on Windows. Pinned by Task 2 step 4 (3.12 fallback) and Task 4 step 1's timeout guard (abort at 15 min, fall back to default pass).

---

### Task 1: Snapshot and back up user-global config

**Files:**
- Create: `~/.claude/CLAUDE.md.backup-20261102`
- Create: `~/.claude/settings.json.backup-20261102`

**Interfaces:**
- Produces: byte-identical backups of both files, used by Task 3's diff verification and by rollback.

- [ ] **Step 1: Confirm repo starts clean**

```powershell
git status --porcelain
```
Expected: empty output. If not, stop — the plan assumes a clean tree.

- [ ] **Step 2: Back up both config files**

```powershell
Copy-Item "$HOME/.claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md.backup-20261102"
Copy-Item "$HOME/.claude/settings.json" "$HOME/.claude/settings.json.backup-20261102"
```

- [ ] **Step 3: Verify backups**

```powershell
(Get-Item "$HOME/.claude/CLAUDE.md.backup-20261102").Length
(Get-Item "$HOME/.claude/settings.json.backup-20261102").Length
```
Expected: first is 450; second is non-zero and equals the live file's size.

### Task 2: Install the Graphify CLI

**Files:**
- Create: uv tool environment for `graphifyy` (under `%LOCALAPPDATA%` uv tools dir; nothing in the repo)

**Interfaces:**
- Produces: `graphify` command on PATH (uv tool shim).
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Install via uv**

```powershell
uv tool install graphifyy
```
Expected: success, ending with "graphify" executable installed.

- [ ] **Step 2: If step 1 fails on Python 3.14 (missing wheels), retry on a managed 3.12**

```powershell
uv tool install --python 3.12 graphifyy
```
Expected: success. If this also fails, stop and report the exact error; do not fall back to `pip install graphify`.

- [ ] **Step 3: Verify the right package and its command**

```powershell
uv tool list
graphify --help
```
Expected: `uv tool list` shows `graphifyy`; `graphify --help` exits 0 and lists graph/index commands (`--update`, `--mode`, `install`, query subcommands). Help referencing anything unrelated to code graphs means the wrong package — uninstall with `uv tool uninstall graphifyy` and stop.

### Task 3: Bare install (skill + hooks), non-strict

**Files:**
- Modify: `~/.claude/CLAUDE.md` (Graphify section appended by the installer)
- Modify: `~/.claude/settings.json` or a sibling (PreToolUse hook registration; exact location discovered here)

**Interfaces:**
- Produces: `/graphify` skill available in Claude Code sessions; pre-grep hooks registered; no `--strict`.
- Consumes: `graphify` command from Task 2.

- [ ] **Step 1: Run bare install**

```powershell
graphify install
```
Expected: success; output mentions Claude Code, the skill, and hooks. Do not pass `--strict`.

- [ ] **Step 2: Verify global CLAUDE.md got an append, not a rewrite**

```powershell
Compare-Object (Get-Content "$HOME/.claude/CLAUDE.md.backup-20261102") (Get-Content "$HOME/.claude/CLAUDE.md") | Where-Object SideIndicator -eq '<='
```
Expected: no output (nothing from the original 450 bytes was removed). New lines at the end (`=>`) are the Graphify section.

- [ ] **Step 3: Find where hooks landed**

```powershell
Compare-Object (Get-Content "$HOME/.claude/settings.json.backup-20261102") (Get-Content "$HOME/.claude/settings.json")
```
Expected: a PreToolUse hook entry for graphify in the diff. If hooks landed in a project file instead (`.claude/settings.json` or `CLAUDE.md` inside the repo), that violates the footprint constraint: revert that file from git and rerun the install with the user-global variant per `graphify install --help`.

- [ ] **Step 4: Footprint check**

```powershell
git status --porcelain
```
Expected: empty.

### Task 4: First deep index

**Files:**
- Create: `graphify-out/graph.json`
- Create: `graphify-out/GRAPH_REPORT.md`
- Create: `graphify-out/graph.html`

**Interfaces:**
- Produces: the graph for repo HEAD, deep mode; consumed by Tasks 5-7.
- Consumes: `graphify` CLI and installed skill.

- [ ] **Step 1: Index the repo**

Run in `C:\filesystem-mcp` in PowerShell:

```powershell
graphify . --mode deep
```
Expected: progress output; 5-15 minutes for 244 files. If it exceeds 15 minutes, Ctrl+C and rerun without `--mode deep` (default pass), noting deep mode as a later retry.

- [ ] **Step 2: Verify all three artifacts exist and are non-empty**

```powershell
Get-ChildItem graphify-out
(Get-Item graphify-out/graph.json).Length
```
Expected: `graph.json`, `GRAPH_REPORT.md`, `graph.html` present; graph.json well above 0 bytes.

- [ ] **Step 3: Verify the report knows this repo**

```powershell
Select-String -Path graphify-out/GRAPH_REPORT.md -Pattern "PathGuard","ToolDef"
```
Expected: hits. `PathGuard` lives in `src/core/path.ts`; its absence means the index scanned the wrong directory.

- [ ] **Step 4: Spot-check a query with citations**

```powershell
graphify query PathGuard --graph graphify-out/graph.json
```
(If `graphify --help` shows a different query spelling, use that.) Expected: answer naming `src/core/path.ts` with line references.

### Task 5: Freshness via local git hook

**Files:**
- Create: a hook file under `.git/hooks/` (name discovered from `graphify --help`; never a tracked path)

**Interfaces:**
- Produces: incremental `--update` reindex on every commit, without touching tracked files.
- Consumes: graph from Task 4.

- [ ] **Step 1: Discover the hook command**

```powershell
graphify --help
```
Expected: a git-hook topic/command (llms-full.txt lists "git hooks" among help topics). Record the exact command.

- [ ] **Step 2: Install the hook**

```powershell
<the command from step 1>
```

- [ ] **Step 3: Verify placement**

```powershell
Get-ChildItem .git/hooks
```
Expected: the graphify hook file present in `.git/hooks/` (e.g. `post-commit` or a graphify-named file). `.git/` is never tracked, so this keeps zero footprint.

- [ ] **Step 4: Run the hook standalone**

```powershell
& .git/hooks/<hook-name>
```
Expected: exit 0, incremental update output. Do not create a throwaway commit on main to test; the next real commit exercises it.

- [ ] **Step 5: Footprint check**

```powershell
git status --porcelain
```
Expected: empty.

### Task 6: Excludes and final footprint guard

**Files:**
- Modify: `.git/info/excludes` (exists, currently empty; not a tracked file)

**Interfaces:**
- Produces: `graphify-out/` invisible to git, completing the zero-footprint guarantee.
- Consumes: Task 4's artifacts.

- [ ] **Step 1: Add the ignore rule**

```powershell
Add-Content .git/info/excludes "graphify-out/"
```

- [ ] **Step 2: Verify the rule matches**

```powershell
git check-ignore -v graphify-out/graph.json
```
Expected: output naming `.git/info/excludes` and the `graphify-out/` pattern.

- [ ] **Step 3: Final repo cleanliness**

```powershell
git status --porcelain
```
Expected: empty. This plus Task 3 step 4 and Task 5 step 5 close Review Focus item 2.

### Task 7: End-to-end smoke in a fresh session

**Files:** none (session-level verification)

**Interfaces:**
- Consumes: everything above.
- Produces: confirmation the hooks and skill work in real use.

- [ ] **Step 1: Start a fresh Claude Code session in `C:\filesystem-mcp`**

Ask it: "Where does PathGuard validate symlinks?"

- [ ] **Step 2: Verify hook behavior**

Expected: graph context appears alongside or before grep results; the assistant's raw reads are not blocked (non-strict); answer cites real files; no hook errors shown. This closes Review Focus item 4.

- [ ] **Step 3: Note the strict-mode switch for later**

Do not enable. Record in session notes: strict mode is `GRAPHIFY_HOOK_STRICT=1` once the graph has proven fresh and useful.

### Task 8: Rollback runbook (documentation only; nothing executes)

- [ ] **Step 1: Confirm the rollback recipe is complete and nothing runs**

Rollback, if ever wanted: `graphify uninstall --purge` (also deletes `graphify-out/`), restore both files from the `.backup-20261102` copies, delete the hook from `.git/hooks/`, remove the `graphify-out/` line from `.git/info/excludes`, `uv tool uninstall graphifyy`.