# Plan hunt: copilot-agy-plugin

Hunted [`copilot-agy-plugin.plan.md`](copilot-agy-plugin.plan.md) on 2026-09-28
against `j0hanz/j0hanz-marketplace` at `ed530ca` (fresh clone) and this repo at
`1df96c3a`. Every step was checked against the dead-step tells. The runtime
claims were settled by running the plan's own commands in a scratch clone
with a throwaway `COPILOT_HOME`.

## Confirmed

### 1. Step 1 baseline cannot pass on a fresh clone (dependency assumed present)

Step 1 clones the marketplace and immediately gates on `npm run check`. It
never installs dependencies, so the executor hits the STOP before any edit.
The plan never runs `npm ci` or `npm install` and never mentions
`node_modules`. The marketplace `check` script starts with `npm run lint`
(`"eslint ."`), and `eslint` and `prettier` exist only under
`devDependencies`. Step 4's `npx prettier --check` has the same gap.

- **Observed:** `npm run lint` on the fresh clone printed
  `'eslint' is not recognized as an internal or external command`.
- **Refuter:** confirmed, independently: "the baseline check fails and Step 1
  hits its STOP before any edit".
- **Fix:** add `npm ci` to Step 1, after the clone and before the baseline
  Verify.

## Contested: refuter killed it, a direct run says otherwise

### 2. Step 5's expected `Command:` line is wrong in a POSIX shell (step with a gate that cannot pass)

Step 5 and the Commands table expect `copilot mcp get filesystem`, run from
Git Bash, macOS or Linux, to print
`--allow-missing-roots <absolute path of the shell's directory>`.

- **Observed:** from Git Bash, in the scratch clone with the plan's
  `mcp.json` in place, `copilot mcp get filesystem` printed
  `Command: npx -y @j0hanz/filesystem-mcp@2.6.1 --allow-missing-roots ${PWD}`,
  with the literal placeholder. `mcp get` shows the configured args, and
  Copilot expands `${PWD}` only when it starts the server. That spawn-time
  expansion is the one the earlier env probe saw.
- **Refuter:** killed. Its evidence quoted the plan's own Current state line,
  "`copilot mcp get filesystem` prints the resolved `Command:` line". That
  line is the plan's unverified assertion and exactly the claim under test.
  The refuter had no way to run Copilot, and it noted that "macOS and Linux
  were not probed".
- **Why it stays:** a kill that rests on the plan's own claim does not meet
  the evidence bar, and the direct run contradicts it. Kept here instead of
  dropped, so the author can decide.
- **Fix:**
  1. Change Step 5's expected output to the literal
     `--allow-missing-roots ${PWD}` for every shell. The check then proves the
     APv1 `mcp.json` loaded, not `.mcp.json`.
  2. Correct the Current state line to say `mcp get` shows the unexpanded
     args.
  3. Leave the expansion check to Step 6, where the server actually starts.

## Dismissed

- **`'${PWD}'` in test source tripping ESLint's `no-template-curly-in-string`.**
  The marketplace `eslint.config.js` ignores `'plugins/**'`, so the plugin
  tests are never linted.
- **agy rejecting Agent Plugins 1.0 fields** (`author`, `homepage`,
  `repository`, `keywords`) despite its documented
  `additionalProperties: false`. `agy plugin validate` on the Step 3
  `plugin.json` returned `[ok]` with `mcpServers  : 1 processed`.
- **The extra root files breaking Claude's strict validation.**
  `claude plugin validate --strict` on the plugin folder with all three new
  files returned `✔ Validation passed`.
- **Step 2's predicted red.** Reading a missing `../plugin.json` with
  `readFileSync` throws `ENOENT`, as stated. The existing 3 tests stay green.

## Hand-off

Two items need the author: one confirmed, one contested. Route both back to
write-plan before run-plan.

## Re-hunt, 2026-09-28 (after fixes)

Re-checked the whole plan after the author's edits.

- **Finding 1 fixed.** Step 1 now runs `npm ci` before the baseline gate, and
  the Commands table lists it. On the same fresh clone, `npm ci` exited 0.
- **Finding 2 fixed.** Step 5 and the Commands table now expect the literal
  `--allow-missing-roots ${PWD}` in every shell, which matches the direct Git
  Bash run. Current state now says `mcp get` prints the configured args
  unexpanded. Copilot's spawn-time expansion is attributed to the probe
  server's `process.argv`.
- **New claim marked unverified.** Current state now says agy's `${PWD}`
  expansion was not probed and that Step 6 case 3 proves it. A failure there
  fails Step 6's Verify, and the plan's general rule turns that into a STOP.

No new candidates. Every step still has a stated gate, and every cited path
and command was either run during this hunt or is marked unverified with the
step that settles it.

**Result: zero findings.** Forward to run-plan.
