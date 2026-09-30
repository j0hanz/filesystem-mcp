# gatekeeper: example CLI coding agent client — design

Date: 2026-09-30
Status: approved in brainstorming, awaiting spec review

## Goal

Ship the first example client under `exampels/clients/`: **gatekeeper**, a
terminal coding agent whose workspace tools come from filesystem-mcp. It is for
developers who build their own MCP clients with `@modelcontextprotocol/client`
v2. It must be small, runnable in one command, and useful on its own, not a
feature tour.

The other five candidate apps (margin, ctxpack, reclaim, waitfor, codeguessr)
are out of scope and get their own design cycles later.

## Success criteria

- `node agent.ts <dir>` opens a REPL that plans and edits code in `<dir>` with
  any OpenAI-compatible LLM, including a local Ollama model with no API key.
- No file changes on disk without an explicit `y` from the user.
- `agent.ts` is at most ~250 lines; the app has exactly one runtime dependency.
- `npm test` inside the app folder passes with no API key and no network.
- Root `npm run check` stays green and does not pick up example files.

## Decisions

| Topic            | Decision                                                      |
| :--------------- | :------------------------------------------------------------ |
| Audience         | Developers building their own MCP client                      |
| Scope            | gatekeeper only; `exampels/README.md` and `AGENTS.md` too     |
| Interaction      | REPL session; optional first task as a CLI argument           |
| LLM layer        | OpenAI-compatible Chat Completions over `fetch`, no LLM SDK   |
| Default provider | `ollama`                                                      |
| Gate             | Every tool with `destructiveHint`; dry-run preview if offered |
| Server launch    | `npx -y @j0hanz/filesystem-mcp`; `FS_MCP_BIN` overrides       |
| Runtime          | Node 24 type stripping (`node agent.ts`), no build, no `tsx`  |
| Folder name      | `exampels/` keeps its current spelling                        |

## Layout

```text
exampels/
├── README.md        index: app table, prerequisites, provider presets
├── AGENTS.md        rules for adding apps
└── clients/
    └── gatekeeper/
        ├── package.json   type=module, dep @modelcontextprotocol/client 2.2.0
        ├── agent.ts       the app
        ├── check.ts       keyless end-to-end self-check
        └── README.md      usage, providers, gate transcript
```

## Architecture

### Startup

1. Parse `node agent.ts <dir> [task] [--provider <p>] [--model <m>]`. `<dir>`
   is required and becomes the server's root.
2. Spawn the server with `StdioClientTransport` from
   `@modelcontextprotocol/client/stdio`:
   - default: `command: 'npx'`, `args: ['-y', '@j0hanz/filesystem-mcp', dir]`
     (the transport spawns through `cross-spawn`, so `npx.cmd` resolves on
     Windows; verified on this machine);
   - when `FS_MCP_BIN` is set: `command: process.execPath`,
     `args: [FS_MCP_BIN, dir]`;
   - `stderr: 'pipe'` so server logs stay out of the REPL.
3. Create the client:
   `new Client({ name: 'gatekeeper', version }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' } })`.
   The modern (2026-07-28) era is what carries the server's `input_required`
   confirmations. The SDK warns against `'auto'` for spawn-per-invocation
   CLIs because of the extra probe process; a REPL session connects once, so
   the cost is paid once.
4. `listTools()` and derive, with no hardcoded tool names:
   - **gated**: `tool.annotations?.destructiveHint === true`;
   - **previewable**: `'dryRun' in tool.inputSchema.properties`.
5. System prompt: `readResource({ uri: 'internal://instructions' })` text plus
   one line naming the root directory.

### LLM layer

- One function `chat(messages, tools, signal)` that POSTs to
  `${baseUrl}/chat/completions` with `{ model, messages, tools }` and returns
  the first choice's message.
- Tools map one-to-one:
  `{ type: 'function', function: { name, description, parameters: inputSchema } }`.
- Provider presets set the base URL and the env var the key comes from:

  | `--provider` | Base URL                                                  | Key env             |
  | :----------- | :-------------------------------------------------------- | :------------------ |
  | `ollama`     | `http://localhost:11434/v1`                               | none                |
  | `openai`     | `https://api.openai.com/v1`                               | `OPENAI_API_KEY`    |
  | `anthropic`  | `https://api.anthropic.com/v1`                            | `ANTHROPIC_API_KEY` |
  | `gemini`     | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY`    |

- `LLM_BASE_URL` / `LLM_API_KEY` override any preset, covering OpenRouter,
  Groq, LM Studio, vLLM and similar hosts.
- The model is always required (`--model` or `LLM_MODEL`); no model IDs are
  hardcoded because they go stale. The missing-model error prints one example
  per provider.
- The key is sent as `Authorization: Bearer <key>` when present.

### Turn loop

```text
 > task
    │
    ▼
 ┌──────────────┐  no tool_calls  ┌─────────────┐
 │  chat()      │ ──────────────► │ print reply │──► > (next turn)
 └──────────────┘                 └─────────────┘
    │ tool_calls
    ▼
 ┌──────────────┐   no     ┌──────────┐
 │  gated?      │ ───────► │ callTool │──┐
 └──────────────┘          └──────────┘  │
    │ yes                                │
    ▼                                    │
 ┌──────────────┐  y  ┌──────────────┐   │
 │ preview+ask  │ ──► │ callTool real│───┤
 └──────────────┘     └──────────────┘   │
    │ N / why: text                      │
    └─► "rejected by user…" ─────────────┤
                                         ▼
                        role:'tool' message back to chat()
```

- One `messages[]` array holds the whole REPL session.
- A turn stops after 25 tool rounds and returns to the prompt.
- Ctrl+C during a turn aborts it through an `AbortController` passed to both
  `fetch` and `callTool`; Ctrl+C at an empty prompt exits.
- Stdin EOF exits cleanly (this is what `check.ts` relies on).

### Approval gate

- **Previewable** gated tool: call once with `{ ...args, dryRun: true }` and
  print the result text (the server's diff or dry-run summary).
- **Other** gated tool (`create`, `move`, `delete`): print the tool name and a
  one-line summary of its arguments, e.g. `create src/retry.ts (24 lines)`.
- Prompt `apply? [y/N/why]` through `node:readline/promises`:
  - `y` runs the real call with the model's original arguments;
  - `N` or empty input returns `rejected by user` as the tool result (fail
    closed);
  - `why: <text>` returns `rejected by user: <text>` so the model revises.
- If the dry-run call returns `isError`, its text goes straight to the model
  and the user is not prompted.
- `// ponytail:` note in code: no stale-preview check between dry run and
  apply; `edit` exact matching makes a stale apply fail rather than corrupt,
  and the model sees that error.

### Server confirmations (elicitation)

- `client.setRequestHandler('elicitation/create', …)` renders the server's
  own questions (access outside the root, overwrite on `create`/`move`,
  recursive `delete`) through the same readline prompt.
- Branch on `params.mode === 'url'` (decline) and treat everything else as a
  form, per the SDK guidance.
- Form fields: boolean asks `y/N`; an enum shows numbered choices; any other
  schema is declined.
- Gate and elicitation can both fire for one call (approve `create`, then the
  server asks about overwriting). That is intended: it shows both layers.

### Tool results and errors

- Text from `result.content` text blocks is joined and sent as the tool
  message. `isError` results are sent too, prefixed `ERROR:`, so the model can
  recover.
- `structuredContent` and `_meta` are not forwarded; the text already carries
  the payload.
- Connect failure or a non-2xx LLM response: print one line with the cause,
  exit 1. `client.close()` runs in `finally` so no server process is orphaned.
- A tool name the model invents throws from `callTool`; catch it and return
  `ERROR: <message>` as the tool result.

## Testing: `check.ts`

Run with `npm test` (`node check.ts`) inside `exampels/clients/gatekeeper/`.
Keyless, offline, assert-based; no test framework.

1. Start a stub LLM with `node:http` on `127.0.0.1:0`. It replies to the first
   request with one `edit` tool call on a temp file, and to the next with a
   plain text reply. It records every request body.
2. Spawn `node agent.ts <tmpdir> "rename"` with `LLM_BASE_URL` pointing at the
   stub, `LLM_MODEL=stub`, and `FS_MCP_BIN` defaulting to
   `../../../dist/index.js`.
3. Write `n\n` to stdin, then end it. Assert the file is unchanged and the
   second stub request carries a `rejected by user` tool message.
4. Repeat with `y\n`. Assert the file content changed.

`agent.ts` has no test hooks; the stub is just another `LLM_BASE_URL`.
Requires `npm run build` at the repo root first.

## Root repo changes

- `eslint.config.mjs`: add `'exampels/**'` to the global ignores. Example files
  sit outside every tsconfig, so `projectService` would fail on them.
- Prettier keeps formatting `exampels/` (no `.prettierignore` change).
- knip and tsc need nothing: their globs cover only `src/` and `__tests__/`.
- The check script is named `check.ts`, not `*.test.ts`, because the root
  `node --test` auto-discovers `**/*.test.ts` and would pull it in.

## exampels/AGENTS.md rules

- One folder per app under `clients/`, with its own `package.json`, runnable
  with `node <file>.ts` on Node 24; no build step, no `tsx`.
- Pin `@modelcontextprotocol/client` to the repo's devDependency version
  (currently `2.2.0`).
- Launch the server with `npx -y @j0hanz/filesystem-mcp`; honor
  `FS_MCP_BIN` for local builds.
- Target at most 250 lines and 2 runtime dependencies per app.
- Each app has a `README.md` and one keyless check script that is not named
  `*.test.ts`.
- LLM access goes through the OpenAI-compatible `fetch` layer, not vendor
  SDKs.

## exampels/README.md content

- One-paragraph intro: what the folder is and who it is for.
- Prerequisites: Node 24+, and either Ollama with a tool-capable model or an
  API key for one provider.
- App table (one row today: gatekeeper) with pitch and run command.
- Provider preset table (same as above).

## Verification during implementation

- Tool calling through each preset (`ollama`, `openai`, `anthropic`,
  `gemini`) is verified against the live endpoint before the README claims
  it. A preset that fails is dropped from the table, not papered over.
- `edit` with `dryRun: true` is confirmed to return a readable diff in its text
  content; if it does not, the preview prints the dry-run text as-is and the
  spec is amended.

## Out of scope

- The other five apps (margin, ctxpack, reclaim, waitfor, codeguessr).
- A CI step that runs `check.ts`. Add it when a server change breaks
  gatekeeper unnoticed.
- `--yes` auto-approve, streaming output, token accounting, session save.
- Client-side roots (deprecated by SEP-2577; the CLI `<dir>` covers it).
