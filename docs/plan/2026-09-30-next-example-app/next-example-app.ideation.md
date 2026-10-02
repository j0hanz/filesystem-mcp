# Next example app — ideation

Decision: which app goes in `exampels/clients/` after `gatekeeper`.

Constraints from `exampels/AGENTS.md`: one folder, `node <file>.ts` on Node 24,
≤250 lines, ≤2 runtime deps, keyless check script, useful on its own (not a
feature tour), model access via OpenAI-compatible `fetch`.

What `gatekeeper` already covers: stdio transport, `listTools` → OpenAI tools,
`destructiveHint` gate with `dryRun` preview, form elicitation
(`input_required` round trips), `internal://instructions`, `isError` recovery.

What the server offers that no example touches: resource subscriptions
(`filesystem-mcp://file/{+path}`; a **directory URI takes one recursive
`fs.watch`**, so subscribing the root sees new files —
`src/core/watcher-registry.ts:194`), `notifications/resources/updated`,
`resources/list_changed` for `filesystem-mcp://result/{id}`, pagination
cursors, `progressToken`, batch `paths[]`, `stat` token estimate, Streamable
HTTP + `--api-key`, `--read-only`, `get-help` prompt with completions. No
sampling: the server never asks the client for a model.

## Default (the bar, not entries)

- D1 — another coding agent with a different prompt (planner, refactorer).
  Twin of gatekeeper: same loop, new system prompt.
- D2 — a chat client that lists tools and lets you poke them. The feature
  tour the rules forbid.
- D3 — gatekeeper over Streamable HTTP with `--api-key`. A `--url` flag on
  gatekeeper, not an app.

## Field

| #   | Generator                  | Candidate                                                                                                                                                   | Killer                                                                                                                                       | Status                                                                 |
| :-- | :------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------- |
| 1   | drop "needs model"         | **watch** — keyless: subscribe to `<dir>`, print what changed (via `find_files` mtime + `read`)                                                             | Same killer as #4 (subscription semantics), cleared. Twin of #4 with the model removed.                                                      | killed as twin of #4 (keep the sharper)                                |
| 2   | drop "one server"          | **mirror** — two servers (local stdio + remote HTTP), compare trees                                                                                         | `rsync`/`diff -r` do it; no cross-server `diff` tool so the client reads every pair itself                                                   | killed (known true)                                                    |
| 3   | drop "terminal"            | tiny web UI over Node `http` + SSE                                                                                                                          | 250-line budget                                                                                                                              | killed (known true)                                                    |
| 4   | drop "prompt-driven"       | **hooks** — daemon: subscribe to the root dir; on change, run a standing task through the model ("keep README API section in sync"), gated like gatekeeper | (a) subscriptions per-file only → cleared: directory URIs get a recursive watch. (b) self-trigger loop: its own writes fire the watcher      | **live** — (b) is a cost: quiet window / ignore paths it just wrote    |
| 5   | move seam (client→middle)  | **policy proxy** — an MCP server that wraps filesystem-mcp, answers the server's confirmations by rule, logs every write with its diff                      | SDK v2 has no pass-through helper; re-exposing tools + resources + subscriptions + `input_required` by hand exceeds 250 lines               | **live, waits on a fact** (SDK v2 proxy effort; check at plan time)    |
| 6   | move seam (run→batch)      | **codemod runner** — no model, a JSON script of tool calls, exits non-zero on error                                                                         | a shell script does it better; MCP adds nothing                                                                                              | killed (known true)                                                    |
| 7   | invert (human calls tools) | **repl** — typed tool calls with schema tab-completion, cursor following                                                                                    | it is the feature tour; `@modelcontextprotocol/inspector` exists                                                                             | killed (known true)                                                    |
| 8   | invert (delete writes)     | **reviewer** — `--read-only` server, model answers questions about the tree                                                                                 | twin of gatekeeper minus the gate; teaches nothing new about the client API                                                                  | killed as twin                                                         |
| 9   | invert (unrepresentable)   | **patchsmith** — never writes; collects `dryRun` diffs into one unified patch on stdout                                                                     | second edit to the same file fails: no overlay, `oldText` no longer matches                                                                  | killed (known true)                                                    |
| 10  | invert (gate once)         | **staging** — model writes to a scratch root, one review + apply at the end                                                                                 | a git branch does exactly this for the target audience                                                                                       | killed (known true)                                                    |
| 11  | steal (repomix)            | **pack** — keyless context packer: `find_files` → `stat` token estimate → fit under `--budget` → batch `read` → markdown bundle                            | repomix / files-to-prompt exist and are better; value is only the MCP-native path                                                            | **live** — preference: does an MCP-native packer earn a table row?     |
| 12  | steal (http tests)         | **remote** — gatekeeper against a Docker-hosted server over HTTP + bearer                                                                                   | it is D3: a flag, not an app                                                                                                                 | killed (known true) — worth doing _inside_ gatekeeper                  |

Sampling-based candidates were not generated: the server never issues
`sampling/createMessage`, so a client declaring it would idle.

## Live set

**A. hooks** — event-driven agent.
`node hooks.ts <dir> "<standing task>" --model <id>`. Subscribes once to the
root directory resource, waits for `notifications/resources/updated`, locates
changed files (`find_files` filtered by mtime since last tick — the
notification names only the directory), runs one model turn with the standing
task, gates writes as gatekeeper does (or `--yes`).

- Killer left standing: none known; the self-trigger loop is a design cost.
- Cost: a daemon, not a one-shot; model spend per change event; must debounce
  bursts and suppress its own writes; changed-file discovery works around the
  directory-level notification.

**B. pack** — keyless context packer with a token budget.

- Killer left standing: preference — an MCP-native repomix has to be wanted.
- Cost: no model, so the LLM adapter path gets no second consumer; the app is
  "batch read + stat" and may read as a tour of two tools.

**C. policy proxy** — rule-answering, write-logging MCP middle server.

- Killer left standing: fact — SDK v2 pass-through effort under 250 lines.
- Cost: both deps spent on SDK packages; no model; the audience ("build your
  own client") gets a server example instead.

## Pick

**A. hooks.** It is the one thing neither gatekeeper nor any off-the-shelf tool
gives — `watchexec` has no model, gatekeeper has no events — and it is the only
survivor that exercises the server capability the examples table leaves dark
(subscriptions + notifications). It reuses gatekeeper's `fetch` adapter and
gate, so the line budget goes to what is new. B is a fine keyless second app
later; C is an honest bet only if the SDK makes forwarding cheap.

Three survivors → grilling puts A/B/C to the user as one round, then
write-specs for the winner.
