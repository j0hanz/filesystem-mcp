# gatekeeper Example Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `exampels/clients/gatekeeper/`, a REPL coding agent that drives
filesystem-mcp through `@modelcontextprotocol/client` and any
OpenAI-compatible LLM, with a y/N/why gate on every destructive tool call.

**Architecture:** One file, `agent.ts`, spawns the server over stdio, maps
`listTools()` onto OpenAI `tools`, and runs a chat loop over `fetch`. Tools
with `destructiveHint` pass a terminal approval gate, previewed with
`dryRun: true` when their schema offers it. A keyless `check.ts` drives the
real agent against a scripted stub LLM on `127.0.0.1`.

**Tech Stack:** Node 24 type stripping, `@modelcontextprotocol/client` 2.2.0,
`node:http`, `node:readline`, `node:util` `parseArgs`, `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-30-gatekeeper-client-design.md`

## Global Constraints

- Run with `node agent.ts`; no build, no `tsx`. Only erasable TypeScript: no
  `enum`, no parameter properties, `import type` for type-only imports.
- Exactly one runtime dependency: `@modelcontextprotocol/client` pinned to
  `2.2.0`. `agent.ts` at most ~250 lines.
- Server launch: `npx -y @j0hanz/filesystem-mcp <dir>` by default;
  `node $FS_MCP_BIN <dir>` when `FS_MCP_BIN` is set. Always pass
  `cwd: <absolute dir>` to the transport so relative tool paths resolve inside
  the root (the spec's startup step 2 omits this; it is a plan-level fix).
- Client options: `capabilities: { elicitation: { form: {} } }`,
  `versionNegotiation: { mode: 'auto' }`.
- Gated = `tool.annotations?.destructiveHint === true`. Previewable =
  `'dryRun' in (tool.inputSchema.properties ?? {})`. No hardcoded tool names.
- Exact strings: REPL prompt `> `; gate prompt `apply? [y/N/why] `; rejection
  results `rejected by user` and `rejected by user: <text>`; tool error prefix
  `ERROR: `.
- Default provider `ollama`; model always required (`--model` or
  `LLM_MODEL`); `LLM_BASE_URL` / `LLM_API_KEY` override presets.
- Max 25 tool rounds per turn.
- Check script is `check.ts`, never `*.test.ts` (root `node --test` would
  discover it).
- Root `npm run check` must stay green.

## Review Focus

- Piped stdin that arrives before a prompt is asked must not be dropped:
  `readline` emits lines with no pending `question()` into the void. Read all
  input through one shared async line iterator. Pinned by every `check.ts`
  scenario, which writes stdin up front.
- Stdin EOF at the gate prompt counts as `N`, the turn finishes, and the
  process exits 0 with the file untouched. Test in Task 3.
- Malformed `function.arguments` JSON from the model becomes an `ERROR: `
  tool result, not a crash. Test in Task 2.
- LLM endpoint unreachable: one stderr line, exit 1, no orphaned server
  process. Test in Task 2.
- The assistant message carrying `tool_calls` must be appended verbatim
  before its `role: 'tool'` replies, or real providers answer 400. Test in
  Task 2 asserts the order the stub receives.

---

### Task 1: Scaffold and root tooling

**Files:**

- Modify: `eslint.config.mjs:21` (global ignores)
- Create: `exampels/clients/gatekeeper/package.json`
- Create: `exampels/clients/gatekeeper/package-lock.json` (by `npm install`)

**Interfaces:**

- Produces: `npm start` = `node agent.ts`, `npm test` = `node check.ts` in
  the app folder.

- [ ] **Step 1: Add `'exampels/**'` to the `ignores` array at
      `eslint.config.mjs:21`.**

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "gatekeeper",
  "version": "1.0.0",
  "private": true,
  "description": "Terminal coding agent with an approval gate, built on filesystem-mcp",
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": { "start": "node agent.ts", "test": "node check.ts" },
  "dependencies": { "@modelcontextprotocol/client": "2.2.0" }
}
```

- [ ] **Step 3: Install**

Run: `npm install --prefix exampels/clients/gatekeeper`
Expected: `package-lock.json` created; `node_modules/` stays untracked
(`git status --short` does not list it).

- [ ] **Step 4: Verify the root check still passes**

Run: `npm run check`
Expected: exit 0. If `prettier --check` flags the new `package-lock.json`,
add `exampels/**/package-lock.json` to `.prettierignore` and re-run.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.mjs .prettierignore exampels/clients/gatekeeper/package.json exampels/clients/gatekeeper/package-lock.json
git commit -m "chore(exampels): scaffold gatekeeper client package"
```

### Task 2: Connect, chat loop, ungated tools

**Files:**

- Create: `exampels/clients/gatekeeper/check.ts`
- Create: `exampels/clients/gatekeeper/agent.ts`

**Interfaces:**

- Consumes: Task 1 package.
- Produces, in `agent.ts` (module-private; later tasks extend them):
  - `ask(prompt: string): Promise<string | null>`: writes `prompt` to stdout
    and returns the next line from one shared
    `readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]()`,
    or `null` on EOF.
  - `chat(messages: Msg[], tools: OpenAITool[], signal: AbortSignal): Promise<Msg>`
    POSTs `{ model, messages, tools }` to `${baseUrl}/chat/completions`, sends
    `Authorization: Bearer <key>` only when a key is set, throws
    `Error('LLM <status>: <first 200 chars of body>')` on non-2xx, returns
    `choices[0].message`.
  - `runTool(call: ToolCall, signal: AbortSignal): Promise<string>`: parses
    `call.function.arguments`, calls `client.callTool`, returns joined text
    blocks (`ERROR: ` prefix when `isError`); any throw, including JSON parse
    errors and unknown tools, returns `ERROR: <message>`.
  - `Msg` and `ToolCall` are local `type` aliases for the OpenAI chat shapes.
- Produces, in `check.ts`:
  - `runAgent(opts: { script: StubReply[]; stdin: string; dir: string; env?: Record<string, string> }): Promise<{ code: number | null; stderr: string; requests: any[] }>`
    starts the stub, spawns `process.execPath agent.ts <dir> "go"` with
    `LLM_BASE_URL=http://127.0.0.1:<port>/v1`, `LLM_MODEL=stub`,
    `FS_MCP_BIN` defaulting to `../../../dist/index.js` resolved from
    `import.meta.dirname`, writes `stdin`, ends it, and awaits exit.
  - `StubReply` = `{ tool: string; args: string } | { text: string }`. The
    stub serves `script[n]` for the n-th request, then `{ text: 'done' }`.
    `args` is the raw arguments string so malformed JSON can be sent.

- [ ] **Step 1: Write `check.ts` with these scenarios** (each in its own
      `mkdtemp` dir holding `a.txt` = `hello\n`, assert with `node:assert/strict`)

```ts
// read round trip: tool result reaches the model, in the right order
let r = await runAgent({
  dir,
  stdin: '',
  script: [{ tool: 'read', args: JSON.stringify({ path: 'a.txt' }) }],
});
assert.equal(r.code, 0);
const msgs = r.requests[1].messages;
const i = msgs.findIndex((m) => m.role === 'tool');
assert.ok(msgs[i - 1].tool_calls?.length, 'assistant tool_calls precede tool reply');
assert.match(msgs[i].content, /hello/);

// malformed arguments and unknown tool become ERROR results
r = await runAgent({ dir, stdin: '', script: [{ tool: 'read', args: '{bad' }] });
assert.match(r.requests[1].messages.at(-1).content, /^ERROR: /);
r = await runAgent({ dir, stdin: '', script: [{ tool: 'nope', args: '{}' }] });
assert.match(r.requests[1].messages.at(-1).content, /^ERROR: /);

// missing model and unreachable LLM exit 1 with one line
r = await runAgent({ dir, stdin: '', script: [], env: { LLM_MODEL: '' } });
assert.equal(r.code, 1);
assert.match(r.stderr, /--model/);
r = await runAgent({ dir, stdin: '', script: [], env: { LLM_BASE_URL: 'http://127.0.0.1:9/v1' } });
assert.equal(r.code, 1);
console.log('check: ok');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npm test --prefix exampels/clients/gatekeeper`
Expected: FAIL, `Cannot find module …agent.ts`.

- [ ] **Step 3: Implement `agent.ts` startup and loop**

- CLI: `parseArgs` with `allowPositionals`, options `provider` (default
  `ollama`) and `model`. Positionals `[dir, task?]`. Missing `dir` or model:
  print usage plus one `--model` example per provider to stderr, exit 1.
- Presets map exactly as the spec's provider table. The key comes from the
  preset's env var, overridden by `LLM_API_KEY`.
- Transport as in Global Constraints with `stderr: 'pipe'`; keep the last 2 KB
  of `transport.stderr` output and print it if `connect` throws.
- System prompt: text of `readResource({ uri: 'internal://instructions' })`
  plus `Workspace root: <absolute dir>`.
- Turn loop per spec: the task argument is the first turn; then
  `while ((line = await ask('> ')) !== null)`. Append the assistant message
  verbatim, then one `{ role: 'tool', tool_call_id, content }` per call.
  Stop the turn after 25 rounds with a printed notice.
- Whole body in `try { … } catch (e) { console.error(String(e.message)); process.exitCode = 1 } finally { await client?.close() }`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test --prefix exampels/clients/gatekeeper`
Expected: `check: ok`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add exampels/clients/gatekeeper/agent.ts exampels/clients/gatekeeper/check.ts
git commit -m "feat(exampels): gatekeeper connect and chat loop"
```

### Task 3: Approval gate and Ctrl+C

**Files:**

- Modify: `exampels/clients/gatekeeper/agent.ts`
- Modify: `exampels/clients/gatekeeper/check.ts`

**Interfaces:**

- Consumes: `ask`, `runTool`, `runAgent` from Task 2.
- Produces: `gate(call: ToolCall, tool: Tool, signal: AbortSignal): Promise<string | null>`:
  returns `null` when approved, else the tool result string to send
  (`rejected by user`, `rejected by user: <text>`, or the dry-run `ERROR: `
  text). `runTool` calls it first for gated tools.

- [ ] **Step 1: Add scenarios to `check.ts`** (`edit` args:
      `{ path: 'a.txt', edits: [{ oldText: 'hello', newText: 'bye' }] }`)

```ts
// N: file untouched, model told why
r = await runAgent({ dir, stdin: 'why: keep it\n', script: [editCall] });
assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'hello\n');
assert.equal(r.requests[1].messages.at(-1).content, 'rejected by user: keep it');
// EOF at the gate prompt = N, clean exit
r = await runAgent({ dir, stdin: '', script: [editCall] });
assert.equal(r.code, 0);
assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'hello\n');
// y: applied
r = await runAgent({ dir, stdin: 'y\n', script: [editCall] });
assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'bye\n');
// broken dry run never prompts: the 'y' stays unread, file untouched
r = await runAgent({
  dir,
  stdin: 'y\n',
  script: [
    {
      tool: 'edit',
      args: JSON.stringify({ path: 'a.txt', edits: [{ oldText: 'zzz', newText: 'q' }] }),
    },
  ],
});
assert.match(r.requests[1].messages.at(-1).content, /^ERROR: /);
```

Note: the last scenario depends on the server marking a no-match dry run as
`isError`. If it does not, run it once, record the real result text, and
assert the file is unchanged instead.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix exampels/clients/gatekeeper`
Expected: FAIL at the first new assertion (the edit is applied ungated).

- [ ] **Step 3: Implement `gate`**

Previewable: `callTool` with `{ ...args, dryRun: true }`; on `isError` return
`ERROR: <text>`; else print the text. Otherwise print
`<name> <one-line summary>`: `create` → each `path (N lines)`; else
`JSON.stringify(args)` cut to 120 chars. Then `ask('apply? [y/N/why] ')`:
`y` → `null`; `why: <t>` → `rejected by user: <t>`; anything else or `null` →
`rejected by user`. Add `// ponytail: no stale-preview check between dry run and apply; exact-match edit fails instead of corrupting.`

- [ ] **Step 4: Wire Ctrl+C**

One `AbortController` per turn, passed to `chat` and `callTool`. On the
readline interface's `'SIGINT'` event: abort the controller when a turn is in
flight, else close the interface (the loop then sees EOF and exits). No check
scenario; verify by hand in Task 5.

- [ ] **Step 5: Run to verify it passes**

Run: `npm test --prefix exampels/clients/gatekeeper`
Expected: `check: ok`.

- [ ] **Step 6: Commit**

```bash
git add exampels/clients/gatekeeper/agent.ts exampels/clients/gatekeeper/check.ts
git commit -m "feat(exampels): gatekeeper approval gate"
```

### Task 4: Server confirmations (elicitation)

**Files:**

- Modify: `exampels/clients/gatekeeper/agent.ts`
- Modify: `exampels/clients/gatekeeper/check.ts`

**Interfaces:**

- Consumes: `ask` from Task 2.
- Produces: the `client.setRequestHandler('elicitation/create', …)` handler.
  The server sends `requestedSchema.properties` of either
  `confirm: { type: 'boolean' }` (access grants, recursive delete) or
  `choice: { type: 'string', enum: [...] }` (overwrite: `['overwrite', 'skip']`)
  or `choice: { type: 'array', … }` (multi-dir grant).

- [ ] **Step 1: Add scenarios to `check.ts`** (`outside` = a second
      `mkdtemp` dir containing `b.txt`; `stat` is not gated)

```ts
const statOutside = { tool: 'stat', args: JSON.stringify({ path: join(outside, 'b.txt') }) };
r = await runAgent({ dir, stdin: 'y\n', script: [statOutside] });
assert.doesNotMatch(r.requests[1].messages.at(-1).content, /^ERROR: /);
r = await runAgent({ dir, stdin: 'n\n', script: [statOutside] });
assert.match(r.requests[1].messages.at(-1).content, /^ERROR: /);
// overwrite choice: gate y, then pick option 1 ('overwrite')
const overwrite = {
  tool: 'create',
  args: JSON.stringify({ files: [{ path: 'a.txt', content: 'new\n' }] }),
};
r = await runAgent({ dir, stdin: 'y\n1\n', script: [overwrite] });
assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'new\n');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --prefix exampels/clients/gatekeeper`
Expected: FAIL on the first new assertion (without a handler the grant comes
back as an error).

- [ ] **Step 3: Implement the handler**

`params.mode === 'url'` → `{ action: 'decline' }`. Print `params.message`.
Single property `confirm` of type boolean → `ask('y/N ')`, accept with
`{ confirm: true }` on `y`, else `{ action: 'decline' }`. Single property with
`enum` → print `1) … n)` and `ask('choice: ')`; a valid number → accept with
`{ [key]: enum[n - 1] }`, else decline. Any other schema → decline.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test --prefix exampels/clients/gatekeeper`
Expected: `check: ok`.

- [ ] **Step 5: Commit**

```bash
git add exampels/clients/gatekeeper/agent.ts exampels/clients/gatekeeper/check.ts
git commit -m "feat(exampels): gatekeeper renders server confirmations"
```

### Task 5: Live provider verification and docs

**Files:**

- Create: `exampels/clients/gatekeeper/README.md`
- Modify: `exampels/README.md`
- Modify: `exampels/AGENTS.md`

**Interfaces:**

- Consumes: the finished `agent.ts` CLI.

- [ ] **Step 1: Verify tool calling per provider**

For each provider with credentials on this machine, run one live session in a
temp copy of a small folder: ask it to rename a word in a file, answer `why:`
once and `y` once, and check the file changed. Known available now: `ollama`
(pull a tool-capable model, e.g. `ollama pull qwen3`) and `gemini`
(`GEMINI_API_KEY` is set). `openai` and `anthropic` have no key here: ask the
user to run them, or list them as unverified. Also press Ctrl+C mid-turn once
and confirm the prompt returns. Record the results in the step's commit
message.

- [ ] **Step 2: Write `gatekeeper/README.md`**

Sections: what it is (one paragraph); run (`npm install`, then
`node agent.ts <dir> --model <m>` per provider); env vars (`LLM_BASE_URL`,
`LLM_API_KEY`, `LLM_MODEL`, `FS_MCP_BIN`); a gate transcript captured from
Step 1; "How it works" mapping each part to the client API it teaches
(`StdioClientTransport`, `listTools` annotations, `callTool` with `dryRun`,
`elicitation/create` handler, `readResource`); `npm test` for the check. Only
verified providers are listed as working.

- [ ] **Step 3: Fill `exampels/README.md` and `exampels/AGENTS.md`**

Content exactly as the spec's "exampels/README.md content" and
"exampels/AGENTS.md rules" sections.

- [ ] **Step 4: Verify**

Run: `npm run check` then `npm test --prefix exampels/clients/gatekeeper`
Expected: both exit 0; `wc -l exampels/clients/gatekeeper/agent.ts` ≤ 250.

- [ ] **Step 5: Commit**

```bash
git add exampels/README.md exampels/AGENTS.md exampels/clients/gatekeeper/README.md
git commit -m "docs(exampels): document gatekeeper and example rules"
```
