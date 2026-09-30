# gatekeeper

A terminal coding agent that cannot touch your files without asking.
filesystem-mcp supplies the workspace tools (list, search, read, edit, patch,
...); any OpenAI-compatible model plans the work. Every destructive tool call
stops at an approval gate that shows the server's own dry-run diff first.
An abridged session:

```text
> In greet.js change the returned word hello to hi
· read {"path":"greet.js"}
· edit {"path":"greet.js","edits":[{"oldText":"return \"hello\";","newText":"return \"hi\";"}]}
edit: greet.js +1 -1 [dry run]

--- greet.js	Original
+++ greet.js	Modified
@@ -1,3 +1,3 @@
 function greet() {
-  return "hello";
+  return "hi";
 }

apply? [y/N/why] why: use "hey" instead
· edit {"path":"greet.js","edits":[{"oldText":"return \"hello\";","newText":"return \"hey\";"}]}
...
apply? [y/N/why] y
Done — greet.js now returns "hey".
```

## Run

Requires Node 24+.

```sh
npm install
node agent.ts <dir> [task] --provider <name> --model <id>
```

`<dir>` is the workspace the server may touch. Without a `task` argument the
agent starts at the `> ` prompt. Conversation history lasts for the session.
Ctrl+C interrupts the running turn; Ctrl+C at the prompt (or end of input)
exits.

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
| `LLM_API_KEY`  | Bearer key, overrides the provider's key variable          |
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
- **The gate.** A tool is gated when its `annotations.destructiveHint` is set,
  and previewed when its `inputSchema` has a `dryRun` property. No tool names
  are hardcoded. The preview is the same `callTool` with `dryRun: true`.
- **Server confirmations.** The client declares `elicitation: { form: {} }`
  and handles `elicitation/create`, so the server can ask about access outside
  the root, overwrites and recursive deletes. This needs the 2026-07-28
  protocol, selected with `versionNegotiation: { mode: 'auto' }`.
- **System prompt.** `client.readResource({ uri: 'internal://instructions' })`
  is the server's own usage guide.
- **Errors.** A tool failure comes back as `isError` and is sent to the model
  as `ERROR: ...` so it can recover.

## Check

`npm test` runs `check.ts`: the real agent and server against a scripted stub
LLM on `127.0.0.1`. No key or network needed. Build the server first with
`npm run build` at the repository root.
