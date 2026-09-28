# Run: filesystem-mcp installs as a plugin in GitHub Copilot CLI and Antigravity CLI

Executing [`copilot-agy-plugin.plan.md`](copilot-agy-plugin.plan.md), started
2026-09-28 at `d5af7667` (this repo) and `ed530ca` (marketplace).

- **0** 2026-09-28 — drift check empty in both repos. `<ver>` = `2.6.1`.
- **1** 2026-09-28 — done. Cloned the marketplace to the session scratchpad on
  branch `feat/filesystem-mcp-copilot-agy`. `npm ci` → exit 0. Baseline
  `npm run check` → exit 0 (196 tests pass).
- **2** 2026-09-28 — done. Red: the 3 new tests failed with `ENOENT` for
  `plugin.json`, `mcp.json` and `mcp_config.json`, and the 3 existing tests
  passed.
- **3** 2026-09-28 — done. `config.test.mjs` → pass 6, fail 0.
  `claude plugin validate --strict` → `✔ Validation passed`.
  `agy plugin validate` → `[ok]`, `mcpServers  : 1 processed`. Deviation:
  `keywords` mirrors `.claude-plugin/plugin.json` exactly (it includes
  `batch`) rather than the plan's 5-item list, which the plan's own
  "copy if drifted" rule allows.
- **4** 2026-09-28 — done. Plugin README (intro line, Copilot CLI and
  Antigravity CLI install sections, a `Defaults` bullet) and this repo's
  README (`### Install as a plugin` table) on branch `docs/plugin-install`.
  `prettier --check` is clean in both repos.
- **5** 2026-09-28 — done. Throwaway `COPILOT_HOME`: `copilot mcp get
  filesystem` → `Command: npx -y @j0hanz/filesystem-mcp@2.6.1
  --allow-missing-roots ${PWD}`, with no `--allow-cwd`. agy staged
  `mcp_config.json` with the same args. Uninstalled, and the leftover
  `plugin_data` folder removed.
- **6** 2026-09-28 — **STOP** (key assumption false for agy). Non-interactive
  pre-checks from Git Bash in `C:\filesystem-mcp`:
  - **Case 1 (Copilot):** `list_roots` → `{"roots":["c:\\filesystem-mcp"]}`.
    Passes.
  - **Case 3 (agy):** `list_roots` → `{"roots":[],"hint":"No positional
    directories specified…"}`. Fails.
  - An argv probe under agy with args
    `["--allow-missing-roots","${PWD}","x${PWD}x"]` received those strings
    **unexpanded**, while the child's environment had
    `PWD=C:/filesystem-mcp`. agy substitutes only its own variables (e.g.
    `${PLUGIN_ROOT}`), not arbitrary environment variables.
  - **Case 2 (Copilot, PowerShell access prompt):** not run; it needs the
    maintainer interactively.
  - Nothing committed. The marketplace branch and this repo's
    `docs/plugin-install` branch hold the uncommitted work.
- **6a** 2026-09-28 — STOP resolved by maintainer decision, option A: the
  server resolves a whole-argument `${NAME}` positional from its own
  environment and drops it when unset. This is a deviation from the plan's
  out-of-scope `src/**`, approved by the maintainer. Branch
  `feat/plugin-placeholder-roots` in this repo:
  - `src/cli.ts`: `expandEnvPlaceholder`, applied to positionals before
    validation.
  - `__tests__/cli.test.ts`: 2 new tests. Red: `Cannot access directory
    ${FS_TEST_PLACEHOLDER_ROOT}`. Green: pass 5, fail 0.
  - `README.md`: the `[dirs...]` row, plus the Step 4 plugin section.
  - `CHANGELOG.md`: an Unreleased `Added` entry.

  `npm run check` → exit 0 (437 tests: 434 pass, 3 skipped, 0 fail).
  End to end under agy with a temporary plugin running local
  `dist/index.js --allow-missing-roots ${PWD}`:
  - Git Bash: `{"roots":["c:\filesystem-mcp"]}`.
  - PowerShell without `PWD`: `{"roots":[]…}`, with no bogus root.

  The temporary plugin was uninstalled and cleaned up. Remaining: release
  (2.6.3 or the maintainer's choice), pin the marketplace plugin to it,
  re-run Steps 3–5, then Step 6 (maintainer interactive: Copilot PowerShell
  access prompt) and Step 7.
