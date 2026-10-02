# hooks

An agent that runs while you work. filesystem-mcp watches the workspace and
supplies the tools (list, search, read, edit, patch, ...); every time a file
changes outside this process, any OpenAI-compatible model runs one standing
task against what changed. Writes stop at the same y/N/why gate
[gatekeeper](../gatekeeper/) has, unless you pass `--yes`. An abridged session:

```text
$ node hooks.ts . "keep the README's API section in sync with src/" --model qwen3
watching C:\work\demo

changed:
- modified: src/greet.js
· read {"path":"src/greet.js"}
· read {"path":"README.md"}
· edit {"path":"README.md","edits":[{"oldText":"greet() -> \"hello\"","newText":"greet() -> \"hi\""}]}
edit: README.md +1 -1 [dry run]

--- README.md	Original
+++ README.md	Modified
@@ -12,3 +12,3 @@
 ## API
-greet() -> "hello"
+greet() -> "hi"

apply? [y/N/why] y
README updated to match greet().
```

Saving `src/greet.js` produced that turn. The model's own edit to `README.md`
did not produce another one.

## Run

Requires Node 24+.

```sh
npm install
node hooks.ts <dir> "<task>" --provider <name> --model <id> [--yes]
```

`<dir>` is the workspace the server may touch and the directory being
watched. `<task>` is the standing instruction; it is sent, together with the
list of created, modified and deleted files, on every turn. Ctrl+C exits.

`--yes` applies the model's file changes without the `apply?` prompt. It does
not answer the server's own questions (access outside `<dir>`, overwrites,
recursive deletes): those still read stdin and are declined when stdin is
closed, so an unattended `--yes` run cannot be talked out of the workspace.

| `--provider`       | Key env var         | Tested                       |
| :----------------- | :------------------ | :--------------------------- |
| `ollama` (default) | none                | yes (`kimi-k2.7-code:cloud`) |
| `gemini`           | `GEMINI_API_KEY`    | yes (`gemini-flash-latest`)  |
| `openai`           | `OPENAI_API_KEY`    | not yet                      |
| `anthropic`        | `ANTHROPIC_API_KEY` | not yet                      |

Any other OpenAI-compatible host (OpenRouter, Groq, LM Studio, vLLM) works
through environment variables:

| Variable       | Meaning                                                    |
| :------------- | :--------------------------------------------------------- |
| `LLM_BASE_URL` | Chat Completions base URL, overrides the provider          |
| `LLM_API_KEY`  | Bearer token, overrides the provider's key variable        |
| `LLM_MODEL`    | Model id when `--model` is not given                       |
| `FS_MCP_BIN`   | Path to a local `dist/index.js` instead of the npm package |

Small local models call tools poorly; pick one your provider marks as
tool-capable.

## How it works

Each part maps to one piece of the MCP client API:

- **Spawning the server.** `StdioClientTransport` runs
  `npx -y @j0hanz/filesystem-mcp <dir>` with `cwd: <dir>`, so relative paths
  resolve inside the workspace.
- **Tool discovery.** `client.listTools()` is passed to the model unchanged:
  `name`, `description` and `inputSchema` become an OpenAI `function` tool.
- **Watching.** One
  `client.listen({ resourceSubscriptions: ['filesystem-mcp://file/<dir>'] })`
  on the root directory. The server puts a recursive watch on it, so new
  files and subdirectories are covered. Each change arrives as
  `notifications/resources/updated` — naming only the directory, never the
  file — and restarts a one-second quiet period; a burst of saves is one turn.
- **What changed.** When the quiet period ends, the app takes a snapshot with
  the server's own tools — `find_files` for the paths, `stat` with `paths[]`
  for their `modified` times — and diffs it against the previous one. The
  model's first message is the task plus that list. Nothing in this process
  reads the workspace with Node `fs`. A listing the server could not complete
  (a `// showing … Next page` or `// scan stopped early` trailer) is refused:
  the app logs `scan incomplete` and runs no turn rather than guessing.
- **Not reacting to itself.** A destructive tool call the model made records
  two things: every path named in its arguments (a directory covers what is
  under it), and a time window from 2 s before the call to just after it. A
  changed file matching either is the model's own write — renames included —
  and starts no turn. A file someone else changed while the turn ran gets its
  own turn right after.
- **The gate.** A tool is gated when its `annotations.destructiveHint` is set,
  and previewed when its `inputSchema` has a `dryRun` property. No tool names
  are hardcoded. `--yes` skips only this gate.
- **Server confirmations.** The client declares `elicitation: { form: {} }`
  and handles `elicitation/create` on stdin. This and `listen()` need the
  2026-07-28 protocol, selected with `versionNegotiation: { mode: 'auto' }`.
- **System prompt.** `client.readResource({ uri: 'internal://instructions' })`
  is the server's own usage guide. Every turn starts fresh from it; the
  workspace is the memory.
- **Errors.** A tool failure comes back as `isError` and is sent to the model
  as `ERROR: ...`. A failing model endpoint ends the turn and the app keeps
  watching; the server exiting ends the app with exit code 1.

## Limits

One root per process. A workspace the server cannot list in one complete scan
(over 10 000 files, or slower than its 5 s scan timeout) is refused: the app
logs `scan incomplete` and runs no turn; at startup it exits 1. Changes inside
directories the server ignores (`.git/`, `node_modules/`, `dist/`, ...) are
invisible. An external change to a path the model also wrote in the same
turn, or within 2 s of one of its writes, is attributed to the model. The
own-write window compares file timestamps with this machine's clock, so a
network-mounted workspace with clock skew may trigger extra turns.

## Check

`npm test` runs `check.ts`: the real app and server against a scripted stub
LLM on `127.0.0.1`, with the quiet period shortened to 200 ms. No key or
network needed. Build the server first with `npm run build` at the repository
root.
