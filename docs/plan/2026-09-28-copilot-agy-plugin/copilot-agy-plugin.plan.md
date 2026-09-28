# Plan: filesystem-mcp installs as a plugin in GitHub Copilot CLI and Antigravity CLI

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** `j0hanz/filesystem-mcp` at `1df96c3a` and
> `j0hanz/j0hanz-marketplace` at `ed530ca`, 2026-09-28. Tools on the authoring
> machine: GitHub Copilot CLI 1.0.88, Antigravity CLI (`agy`) 1.1.22, Node 24.
>
> **Drift check (run first)**, in each repo:
>
> - marketplace clone: `git diff --stat ed530ca..HEAD -- plugins/filesystem-mcp .claude-plugin/marketplace.json`
> - this repo: `git diff --stat 1df96c3a..HEAD -- README.md`
>
> Compare [Current state](#current-state) against the live files for every
> path either command lists. A mismatch is a [STOP](#stop) condition. One
> expected drift: the maintainer bumps the version in
> `plugins/filesystem-mcp/.claude-plugin/plugin.json` and the pin in `.mcp.json`
> by hand. A version-only change there is not a mismatch; use the current
> version wherever this plan writes `<ver>`.

## Goal

The Claude Code plugin in `j0hanz/j0hanz-marketplace` already installs in
Copilot CLI, which reads `.claude-plugin/` marketplaces. It installs **broken**
there, though. Copilot starts plugin MCP servers in the plugin's install
folder, not the project. The Claude config's `--allow-cwd --root-boundary .`
therefore makes that install folder the only root and the only grant
boundary, so a Copilot user can never reach their project. Antigravity CLI has
no install path at all yet.

This plan adds a Copilot manifest and an Antigravity manifest to the same
plugin folder. Each launches the server from the user's shell directory
(`${PWD}`) instead of the process working directory. The Claude files stay
untouched. No server code changes. Requirements covered: none, this is a
distribution change.

## Current state

### Marketplace plugin folder (`j0hanz/j0hanz-marketplace` at `ed530ca`)

Layout of [`plugins/filesystem-mcp/`](https://github.com/j0hanz/j0hanz-marketplace/tree/ed530ca/plugins/filesystem-mcp):

```text
plugins/filesystem-mcp/
├── .claude-plugin/
│   ├── icon.svg
│   └── plugin.json     name "filesystem-mcp", version "2.6.1"
├── .mcp.json           Claude Code server config
├── README.md
└── test/config.test.mjs
```

[`plugins/filesystem-mcp/.mcp.json`](https://github.com/j0hanz/j0hanz-marketplace/blob/ed530ca/plugins/filesystem-mcp/.mcp.json), in full:

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@2.6.1", "--allow-cwd", "--root-boundary", "."],
      "env": {
        "FS_PORT": "",
        "FS_ALLOWED_DIRS": "",
        "FS_ALLOW_CWD_WALK": "false",
        "FS_ALLOW_MISSING_ROOTS": "false",
        "FS_ALLOW_SENSITIVE": "false"
      }
    }
  }
}
```

[`test/config.test.mjs:7-38`](https://github.com/j0hanz/j0hanz-marketplace/blob/ed530ca/plugins/filesystem-mcp/test/config.test.mjs#L7-L38)
pins that file exactly. It reads the manifest with a `json()` helper at
[line 5](https://github.com/j0hanz/j0hanz-marketplace/blob/ed530ca/plugins/filesystem-mcp/test/config.test.mjs#L5)
and derives the pinned version from `manifest.version`:

```js
const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('filesystem plugin pins the server to the plugin version with project-scoped stdio defaults', () => {
  ...
  const manifest = json('../.claude-plugin/plugin.json');
  ...
      `@j0hanz/filesystem-mcp@${manifest.version}`,
```

New tests go in this same file and follow the same style.

Marketplace rules, from
[`AGENTS.md`](https://github.com/j0hanz/j0hanz-marketplace/blob/ed530ca/AGENTS.md):

- The gate is `npm run check`: lint, format:check, `validate`
  (`claude plugin validate --strict` per catalog plugin), typecheck, and test.
- There is no CI.
- `typecheck` rewrites README's generated regions, so never hand-edit
  `<!-- install:start -->` or `<!-- plugins:start -->`.
- Commit subjects are Conventional.

### Verified client behavior (probed on 2026-09-28, Windows 11)

Copilot CLI:

- Installing the unchanged plugin works:
  `copilot plugin marketplace add j0hanz/j0hanz-marketplace`, then
  `copilot plugin install filesystem-mcp@j0hanz-marketplace`, gives
  `filesystem-mcp@j0hanz-marketplace (v2.6.1)` and `filesystem (local)` in
  `copilot mcp list`.
- **Server working directory is the plugin install folder.** `list_roots`
  under Copilot returned
  `…\installed-plugins\j0hanz-marketplace\filesystem-mcp`.
- A folder holding both `.claude-plugin/plugin.json` + `.mcp.json` and a root
  Agent Plugins 1.0 `plugin.json` + `mcp.json` installs as one plugin. Copilot
  loads **only** the `mcp.json` server.
- Copilot expands `${VAR}` from the environment in `args` when it spawns the
  server. A probe server's `process.argv` showed `${PWD}` expanded to the
  project directory from Git Bash. From PowerShell, where `PWD` is not
  an environment variable, it stayed the literal `${PWD}`.
  `${workspaceFolder}` and `${cwd}` are never expanded.
- At `initialize`, Copilot declares `elicitation` (form, url) and **no**
  `roots`. It starts with `server/discover`, so the server runs the
  2026-07-28 era, where roots are never seeded.
- In non-interactive `copilot -p` runs, an out-of-root path returned
  `ACCESS_DENIED`. Whether the interactive CLI shows the grant prompt is
  **not verified**; Step 6 gates on it.
- `copilot plugin marketplace add <local path>` loads plugins live from that
  folder.
- `copilot mcp get filesystem` prints the configured `Command:` line
  **unexpanded**. From Git Bash it showed
  `--allow-missing-roots ${PWD}` literally; the `${PWD}` expansion above
  happens only when the server is started.
- `COPILOT_HOME=<dir>` isolates all config, so tests leave the real setup
  alone.

Antigravity CLI (`agy`):

- The manifest is `plugin.json`, where `name` must match `^[a-zA-Z0-9-_]+$`.
  MCP servers go in `mcp_config.json` under `mcpServers`, with `command` /
  `args` / `env` / `cwd` ([docs](https://antigravity.google/docs/plugins),
  [MCP docs](https://antigravity.google/docs/mcp)).
- `agy plugin validate <dir>` accepts an Agent Plugins 1.0 `plugin.json`
  (`$schema`, `version`, `license` present). Validation passes.
- `agy plugin install <dir>` copies the folder to
  `~/.gemini/config/plugins/<name>/` and **stages `mcp_config.json`**,
  ignoring `.mcp.json` and `mcp.json` when all three exist.
  `agy plugin uninstall <name>` removes it but leaves
  `~/.gemini/antigravity-cli/plugin_data/<name>/` behind.
- The server's working directory is the plugin folder.
- `${PLUGIN_ROOT}` expanded, which suggests agy uses environment expansion
  too. `${workspacePath}` and `${extensionPath}` stayed literal. **agy's
  `${PWD}` expansion was not probed.** Step 6 case 3 is where it gets
  proven.
- agy declares `roots` + `elicitation`, but also starts with
  `server/discover`, so roots are not seeded either.
- `agy plugin install` accepts a local directory or `plugin@marketplace`.
  Marketplaces are an internal registry, and there was no public way to
  register one.

Server (`@j0hanz/filesystem-mcp@2.6.2`):

- `--allow-missing-roots '${PWD}'` with an unexpanded `${PWD}` starts cleanly
  (exit 0). The allowed root becomes the nonexistent
  `<plugin dir>\${PWD}`. Without the flag the same argument fails with
  `Cannot access directory ${PWD}: ENOENT`.
- [`src/cli.ts:171-173`](../../../src/cli.ts#L171-L173): the flag wins over
  `FS_ALLOW_MISSING_ROOTS` because the two are OR-ed.

### This repo

[`README.md:157-170`](../../../README.md#L157-L170) is `### Install in Cursor`,
the last client section before `### Docker configuration` at
[line 172](../../../README.md#L172). The README never mentions plugins or
marketplaces.

## Commands

| Purpose | Command | Expected on success |
| :-- | :-- | :-- |
| Marketplace gate | `npm run check` (marketplace clone) | exit 0 |
| Plugin tests | `node --test plugins/filesystem-mcp/test/config.test.mjs` | all pass |
| Claude validation | `claude plugin validate --strict plugins/filesystem-mcp` | `✔ Validation passed` |
| agy validation | `agy plugin validate plugins/filesystem-mcp` | `[ok]` and `mcpServers  : 1 processed` |
| Install deps | `npm ci` (marketplace clone) | exit 0 |
| Copilot load | see Step 5 | `Command: npx -y @j0hanz/filesystem-mcp@<ver> --allow-missing-roots ${PWD}` (literal `${PWD}` in every shell) |
| This repo format | `npx prettier --check README.md` | clean |

## Scope

**In scope**, the only files to create or modify:

- `plugins/filesystem-mcp/plugin.json` (new, marketplace repo)
- `plugins/filesystem-mcp/mcp.json` (new, marketplace repo)
- `plugins/filesystem-mcp/mcp_config.json` (new, marketplace repo)
- `plugins/filesystem-mcp/test/config.test.mjs` (marketplace repo)
- `plugins/filesystem-mcp/README.md` (marketplace repo)
- [`README.md`](../../../README.md) (this repo, one new section)

**Out of scope**, leave these alone even though they look related:

- `plugins/filesystem-mcp/.mcp.json` and `.claude-plugin/*`: the Claude Code
  config is correct for Claude, which starts servers in the project folder,
  and it passed Anthropic directory review on 2026-09-27. Changing it
  triggers a re-scan.
- `.claude-plugin/marketplace.json`: Copilot already reads it. A per-plugin
  `version` is not needed, because Copilot shows the version from the
  manifest.
- README generated regions in the marketplace repo (`site:data` owns them).
- `src/**` in this repo: no server change. See [Notes](#notes) for the
  deferred cosmetic fix.
- `package.json`, `server.json`, `mcpb/manifest.json` versions and
  `.github/workflows/release.yml`: AGENTS.md forbids hand edits, and nothing
  here needs a release.

## Steps

### 1. Branch the marketplace repo

```bash
gh repo clone j0hanz/j0hanz-marketplace && cd j0hanz-marketplace && git switch -c feat/filesystem-mcp-copilot-agy
npm ci
```

`npm ci` is required: `eslint` and `prettier` are devDependencies, and
without them `npm run check` fails at its first script with
`'eslint' is not recognized`.

Run the drift check. Read the current version with:

```bash
node -p "require('./plugins/filesystem-mcp/.claude-plugin/plugin.json').version"
```

Use that value as `<ver>` from here on.

**Verify**: `npm run check` → exit 0 before any edit. This is the baseline;
if it fails, STOP.

### 2. Write the failing tests

Append three tests to
[`test/config.test.mjs`](https://github.com/j0hanz/j0hanz-marketplace/blob/ed530ca/plugins/filesystem-mcp/test/config.test.mjs),
reusing its `json()` helper and reading `<ver>` from
`../.claude-plugin/plugin.json` exactly like the existing test. Shared
expectation:

```js
const launchFromShellDir = (version) => ({
  command: 'npx',
  // ${PWD} is expanded by Copilot CLI and agy from the launching shell's
  // environment; both start the server in the plugin folder, so --allow-cwd
  // would expose the plugin, not the project. --allow-missing-roots keeps a
  // shell without PWD (PowerShell, cmd) from failing startup.
  args: ['-y', `@j0hanz/filesystem-mcp@${version}`, '--allow-missing-roots', '${PWD}'],
  env: {
    FS_PORT: '',
    FS_ALLOWED_DIRS: '',
    FS_ALLOW_CWD_WALK: 'false',
    FS_ALLOW_SENSITIVE: 'false',
  },
});
```

Write `'${PWD}'` in single quotes so it is a literal, not a template.

1. **`copilot manifest is Agent Plugins 1.0 with the catalog name and plugin version`**
   - `plugin.json` has `$schema` =
     `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`.
   - `name` = `filesystem-mcp`.
   - `version` = the Claude manifest's `version`.
   - Its keys are a subset of `$schema, name, version, description, author,
     homepage, repository, license, keywords`, the schema's allowed set minus
     `extensions`.
2. **`copilot mcp.json launches the server from the shell directory`**
   - `Object.keys(mcpServers)` deep-equals `['filesystem']`.
   - `mcpServers.filesystem` deep-equals
     `{ type: 'stdio', ...launchFromShellDir(<ver>) }`.
3. **`antigravity mcp_config.json launches the server from the shell directory`**
   - Same key check.
   - `mcpServers.filesystem` deep-equals `launchFromShellDir(<ver>)`, with no
     `type` key; agy's documented shape has none.

**Verify**: `node --test plugins/filesystem-mcp/test/config.test.mjs` → the 3
new tests fail with `ENOENT` for `plugin.json`, `mcp.json` and
`mcp_config.json`, and the 3 existing tests pass.

### 3. Add the three manifests

Create in `plugins/filesystem-mcp/`, replacing `<ver>`:

`plugin.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "filesystem-mcp",
  "version": "<ver>",
  "description": "Project-scoped filesystem MCP tools for batched reads, RE2 search, diffs, and edits. Requires Node.js 24+.",
  "author": { "name": "j0hanz", "email": "l.johansson93@outlook.com" },
  "homepage": "https://github.com/j0hanz/filesystem-mcp#readme",
  "repository": "https://github.com/j0hanz/filesystem-mcp",
  "license": "MIT",
  "keywords": ["mcp", "filesystem", "search", "diff", "edit"]
}
```

`mcp.json` (Copilot): `{ "mcpServers": { "filesystem": { "type": "stdio", …launchFromShellDir } } }`
written out as literal JSON.

`mcp_config.json` (agy): the same without `"type"`.

Copy the `description`, `author`, `homepage` and `repository` values from
`.claude-plugin/plugin.json` if they drifted from the values above.

**Verify**:

- `node --test plugins/filesystem-mcp/test/config.test.mjs` → all 6 pass.
- `claude plugin validate --strict plugins/filesystem-mcp` →
  `✔ Validation passed`.
- `agy plugin validate plugins/filesystem-mcp` → `[ok]` with
  `mcpServers  : 1 processed`.

### 4. Document the two new clients

In `plugins/filesystem-mcp/README.md`:

- Line 3: say the plugin works in Claude Code, GitHub Copilot CLI and
  Antigravity CLI.
- After the `## Install` block, add `### GitHub Copilot CLI`:

  ```text
  copilot plugin marketplace add j0hanz/j0hanz-marketplace
  copilot plugin install filesystem-mcp@j0hanz-marketplace
  ```

  Add that `copilot mcp list` shows `filesystem (local)`.
- Add `### Antigravity CLI`. agy has no public marketplace, so:

  ```text
  git clone https://github.com/j0hanz/j0hanz-marketplace
  agy plugin install ./j0hanz-marketplace/plugins/filesystem-mcp
  ```

  Re-run the install after `git pull` to update.
- In `## Defaults`, add one bullet. In Copilot CLI and Antigravity CLI the
  initial root is the shell directory the CLI was started from (`$PWD`).
  There is no grant boundary. In PowerShell or cmd, which do not export
  `PWD`, the server starts with no root, and each project path is approved
  through the client's access prompt on first use.

In this repo's [`README.md`](../../../README.md), after `### Install in Cursor`
([line 157](../../../README.md#L157)) and before `### Docker configuration`,
add `### Install as a plugin`. Give one line each for Claude Code
(`/plugin marketplace add j0hanz/j0hanz-marketplace`, then
`/plugin install filesystem-mcp@j0hanz-marketplace`), Copilot CLI (the two
commands above) and Antigravity CLI (the clone plus
`agy plugin install`). Link the marketplace plugin README for details.

**Verify**:

- Marketplace clone: `npx prettier --check plugins/filesystem-mcp` → clean.
- This repo: `npx prettier --check README.md` → clean.

### 5. Prove each client loads the new config

Run from the marketplace clone root. Use a throwaway Copilot home so the real
setup is untouched:

```bash
export COPILOT_HOME="$(mktemp -d)" COPILOT_AUTO_UPDATE=false
copilot plugin marketplace add "$PWD"
copilot plugin install filesystem-mcp@j0hanz-marketplace
copilot mcp get filesystem
```

**Verify**:

- The `Command:` line reads
  `npx -y @j0hanz/filesystem-mcp@<ver> --allow-missing-roots ${PWD}`, with
  the literal `${PWD}` in every shell. `mcp get` prints the configured args;
  Copilot expands `${PWD}` only when it starts the server, which Step 6
  checks. This line proves Copilot loaded `mcp.json`.
- It must not contain `--allow-cwd`. If it does, Copilot loaded `.mcp.json`
  instead of `mcp.json`: STOP.

Then agy:

```bash
agy plugin install ./plugins/filesystem-mcp
cat ~/.gemini/config/plugins/filesystem-mcp/mcp_config.json
agy plugin uninstall filesystem-mcp
rm -rf ~/.gemini/antigravity-cli/plugin_data/filesystem-mcp
```

**Verify**:

- The staged file contains `--allow-missing-roots` and `${PWD}`, and not
  `--allow-cwd`.
- `ls ~/.gemini/config/plugins` no longer lists `filesystem-mcp`.

### 6. Maintainer gate: interactive access in each client

This step needs a human at an interactive CLI. The executor asks the
maintainer to run it and report back, and **does not** mark it done itself.

In a real project folder, not under `AppData\Local\Temp`:

1. **Copilot CLI, POSIX shell (Git Bash, macOS or Linux).** Start `copilot`
   with the plugin installed as in Step 5. Ask it to call `list_roots`.
   Expected: the project folder.
2. **Copilot CLI, PowerShell.** Start `copilot` from PowerShell in the same
   project and ask it to list the project folder with the filesystem `list`
   tool. Expected: an access prompt for the folder; after approval, the
   listing.
3. **agy, POSIX shell.** Install as in Step 5 (skip the uninstall), start
   `agy` in the project, and ask for `list_roots`. Expected: the project
   folder.

**Verify**: the maintainer reports all three as expected. If case 2 shows no
access prompt and returns `ACCESS_DENIED`, STOP. PowerShell users would have
a plugin that cannot reach any file.

### 7. Land it

Marketplace repo:

```bash
npm run check
git add plugins/filesystem-mcp
git commit -m "feat(filesystem-mcp): add Copilot CLI and Antigravity CLI manifests"
git push -u origin feat/filesystem-mcp-copilot-agy
gh pr create --fill
```

This repo, on its own branch:

```bash
git switch -c docs/plugin-install
git add README.md
git commit -m "docs(readme): add plugin install for Claude Code, Copilot CLI and Antigravity CLI"
```

Ask the maintainer before pushing either branch.

**Verify**: `npm run check` (marketplace) → exit 0, and `git status` in both
repos shows only the in-scope files committed.

## Done

All must hold:

- [ ] Marketplace `npm run check` exits 0, including the 3 new tests.
- [ ] `claude plugin validate --strict plugins/filesystem-mcp` passes.
- [ ] `agy plugin validate plugins/filesystem-mcp` prints `[ok]`.
- [ ] `copilot mcp get filesystem` (throwaway `COPILOT_HOME`) shows
  `--allow-missing-roots` and no `--allow-cwd`.
- [ ] The maintainer confirmed the 3 interactive cases in Step 6.
- [ ] `git diff --stat ed530ca..HEAD` in the marketplace clone lists only the
  5 in-scope marketplace paths. `.mcp.json` and `.claude-plugin/` are
  unchanged.
- [ ] This repo's diff touches only `README.md`.

## STOP

Stop and report if:

- A [Current state](#current-state) excerpt does not match the live file,
  apart from the version-only drift allowed above.
- A Verify fails twice after one fix attempt.
- Copilot loads the `.mcp.json` server (`--allow-cwd` in `copilot mcp get`)
  when `plugin.json` + `mcp.json` exist. The whole design rests on Copilot
  preferring the Agent Plugins 1.0 files.
- `claude plugin validate --strict` rejects the extra root files. The
  Claude plugin must keep validating, because it is live in Anthropic's
  directory.
- Step 6 case 2 returns `ACCESS_DENIED` without an access prompt.
- The change seems to need a server code change or an edit to `.mcp.json`
  or `.claude-plugin/`.

## Notes

- **Review focus.** Check that `${PWD}` is the literal string in both new
  JSON files and in the tests. An editor or template literal that expands it
  at commit time would bake one machine's path into the plugin.
- **Security trade-off.** Unlike the Claude config, the new configs set no
  `--root-boundary`. A boundary of `${PWD}` would stay literal on
  PowerShell, point at a folder that doesn't exist, and so block every grant
  there. Grants still pass the server's unsafe-path guard (home, filesystem
  roots, system folders), and each one needs the user's approval in the
  client.
- **Deferred, cosmetic.** When `${PWD}` stays unexpanded, `list_roots`
  shows a nonexistent `<plugin dir>\${PWD}` root. A later server change
  could drop positional arguments that are still an unexpanded
  `${NAME}` placeholder. That needs a release, so it is left out here.
- **Not covered.** VS Code agent plugins were not probed. The plugin is not
  listed in `github/awesome-copilot` or `github/copilot-plugins` (the two
  default Copilot marketplaces), and agy has no public marketplace. Each is
  a follow-up.
- **Rollback.** Revert the marketplace PR. Users then fall back to the
  broken-for-Copilot `.mcp.json` behavior, which is the state today.
