# Agent guardrails implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove three sources of wasted agent turns that the retro of session `94ec6967` found: formatting by hand, `npm notice` noise, and knip configuration hints that look like failures.

**Architecture:** These are config changes only, with no `src/` change. A local Claude Code `PostToolUse` hook formats each file an agent writes. A repo `.npmrc` quiets npm. `knip.json` loses two redundant entries.

**Tech Stack:** Claude Code hooks, Node 22+ (`node:child_process`), Prettier 3, npm 11, knip 6.

**Spec:** The retro findings 1–3 in the session that wrote this plan. Each finding's evidence is restated at the top of its task.

## Global Constraints

- `.claude/` is gitignored (`.gitignore:53`). The hook and its settings stay local and are never committed.
- The hook always exits 0. It must never block or fail a tool call.
- Never hand-edit the versions in `package.json`, `server.json`, `mcpb/manifest.json`, or the plugin manifests.
- `npm run check` passes on the final branch.

## Review Focus

1. **A file with a syntax error:** Prettier exits 2 and the hook still exits 0, leaving the file untouched. The Task 1 self-check pins this.
2. **A path outside the repo** (scratchpad, `C:\tmp`): the hook skips it, so files in other projects are never reformatted. The Task 1 self-check pins this.
3. **A path in `.prettierignore`** (`.superpowers/…`): Prettier leaves it unchanged without an error. The Task 1 self-check pins this.
4. **Relative MCP paths** (`src/core/read.ts`): the hook resolves them against `CLAUDE_PROJECT_DIR`, not the hook's own working directory. The Task 1 self-check pins this.
5. **Built-in `Edit` after the hook reformats a file:** Claude Code sees the file changed on disk. The next `Edit` must still apply. Check this manually in Task 1 Step 5.

---

### Task 1: Format-on-edit hook

The evidence: the agent ran `npx prettier --write` by hand about 15 times, and `npm run check` still failed twice on unformatted agent-written Markdown. `.prettierignore` also lists `docs/plan/`, which does not exist.

**Files:**

- Create: `.claude/hooks/format-on-edit.mjs` (local, gitignored)
- Modify: `.claude/settings.json` (local, gitignored): add a `PostToolUse` block
- Modify: `.prettierignore:3`: delete `docs/plan/`
- Test: `.claude/hooks/format-on-edit.selfcheck.mjs` (local, gitignored)

**Interfaces:**

- Consumes: the hook JSON that Claude Code sends on stdin, `{ tool_name, tool_input }`. Paths live in these fields:
  - `Write`, `Edit`: `tool_input.file_path`
  - `mcp__plugin_filesystem-mcp_filesystem__edit`: `tool_input.path` or `tool_input.files[].path`
  - `mcp__plugin_filesystem-mcp_filesystem__create`: `tool_input.files[].path`
  - `mcp__plugin_filesystem-mcp_filesystem__patch`: `tool_input.path`
- Produces: `collectPaths(input: unknown, projectDir: string): string[]`, exported for the self-check. It returns absolute paths under `projectDir`, deduplicated.

- [ ] **Step 1: Write the self-check**

  `format-on-edit.selfcheck.mjs` uses `node:assert/strict`. It imports `collectPaths` and asserts the following, with `projectDir = 'C:/filesystem-mcp'`:

  - `{ tool_input: { file_path: 'C:/filesystem-mcp/a.md' } }` returns `['C:/filesystem-mcp/a.md']`, with separators normalized through `path.resolve`.
  - `{ tool_input: { path: 'src/x.ts' } }` returns `[resolve(projectDir, 'src/x.ts')]`.
  - `{ tool_input: { files: [{ path: 'a.ts' }, { path: 'a.ts' }, { path: 'b.ts' }] } }` returns two paths.
  - `{ tool_input: { file_path: 'C:/tmp/x.md' } }` returns `[]`.
  - `{ tool_input: { file_path: 'C:/filesystem-mcp-other/x.md' } }` returns `[]`. That is a sibling folder sharing the prefix.
  - `{}` and `null` return `[]`.

  End-to-end case: write `.superpowers/hook-check/bad.ts` with the contents `const = ;`. Pipe its event into the hook with `spawnSync(process.execPath, [hook], { input })` and assert `status === 0`. Do the same for `docs/hook-check.md` holding `#  Title` and assert the file becomes `# Title\n`. Delete both files in `finally`.

- [ ] **Step 2: Run it and confirm it fails**

  Run: `node .claude/hooks/format-on-edit.selfcheck.mjs`
  Expected: `ERR_MODULE_NOT_FOUND` for `format-on-edit.mjs`.

- [ ] **Step 3: Write the hook in `.claude/hooks/format-on-edit.mjs`**

  - Export `collectPaths`. A path counts as inside the project when `path.relative(projectDir, p)` does not start with `..` and is not absolute.
  - Main runs only when the file is executed directly. Compare `import.meta.url` with `pathToFileURL(process.argv[1]).href`.
  - Main reads all of stdin and calls `JSON.parse`. A parse error leads to exit 0.
  - `projectDir` is `process.env.CLAUDE_PROJECT_DIR ?? process.cwd()`.
  - When paths exist, main runs `spawnSync(process.execPath, [join(projectDir, 'node_modules/prettier/bin/prettier.cjs'), '--write', '--ignore-unknown', '--log-level', 'silent', ...paths], { cwd: projectDir })`. It calls Prettier's bin directly, because `npx` needs `shell: true` on Windows.
  - Main always ends with `process.exit(0)`.

- [ ] **Step 4: Run the self-check and confirm it passes**

  Run: `node .claude/hooks/format-on-edit.selfcheck.mjs && echo ok`
  Expected: `ok`.

- [ ] **Step 5: Wire the hook and check it live**

  Add this block to `.claude/settings.json` under `hooks`, next to `PreToolUse`:

  ```json
  "PostToolUse": [
    {
      "matcher": "Write|Edit|mcp__plugin_filesystem-mcp_filesystem__(edit|create|patch)",
      "hooks": [
        {
          "type": "command",
          "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/format-on-edit.mjs\"",
          "timeout": 20
        }
      ]
    }
  ]
  ```

  `replace_text` stays out of the matcher. It can touch a whole folder.

  Live check, in a new session:
  1. Use `Write` to create `docs/hook-live.md` with the contents `#  Hi`.
  2. Read the file and expect `# Hi`.
  3. `Edit` the same file. The edit must apply.
  4. Delete the file.

- [ ] **Step 6: Drop the stale ignore line and commit**

  Delete `docs/plan/` from `.prettierignore`. Then run `npx prettier --check .` and expect `All matched files use Prettier code style!`.

  ```bash
  git add .prettierignore
  git commit -m "chore(prettier): drop ignore for nonexistent docs/plan"
  ```

### Task 2: Quiet npm notices

The evidence: `npm config get loglevel` returns `notice`. Every script prints `npm notice run …` lines. The agent filtered them with `grep -v notice` about 20 times, and one check result was nothing but a notice line.

**Files:**

- Create: `.npmrc`

**Interfaces:** none.

- [ ] **Step 1: Confirm the noise exists**

  Run: `npm run lint 2>&1 | grep -c "npm notice"`
  Expected: a count of 1 or more.

- [ ] **Step 2: Create `.npmrc` with one line, `loglevel=warn`**

- [ ] **Step 3: Confirm the noise is gone and failures still show**

  1. Run `npm run lint 2>&1 | grep -c "npm notice"` and expect `0`.
  2. Run `npm run nonexistent-script` and expect `npm error Missing script` to still print.

- [ ] **Step 4: Commit**

  ```bash
  git add .npmrc
  git commit -m "chore(npm): log at warn to drop notice lines from script output"
  ```

### Task 3: Remove redundant knip entries

The evidence: during a failing `check`, knip printed `Remove redundant pattern from knip.json → entry` for `src/index.ts!` and `src/transport.ts!`. The agent took these hints for the failure and stashed work to compare against `main`. `package.json` `main`/`bin` already declare both files as entries.

**Files:**

- Modify: `knip.json:4-5`

**Interfaces:** none.

- [ ] **Step 1: Confirm the hints exist**

  Run: `npx knip`
  Expected: `Configuration hints (2)`, exit 0.

- [ ] **Step 2: Delete the `"src/index.ts!"` and `"src/transport.ts!"` lines from `entry`**

- [ ] **Step 3: Confirm knip is clean in both modes**

  1. Run `npx knip` and expect no output, exit 0.
  2. Run `npx knip --production --include files,dependencies` and expect no output, exit 0.

  If the production run reports `src/transport.ts` as an unused file, restore that one line and record the reason in the commit body.

- [ ] **Step 4: Run the full check and commit**

  Run: `npm run check`
  Expected: exit 0 and `ℹ fail 0`.

  ```bash
  git add knip.json
  git commit -m "chore(knip): drop entries package.json already declares"
  ```
