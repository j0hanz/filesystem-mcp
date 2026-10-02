# Plan: add `hooks`, an event-driven example client under `exampels/clients/`

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `965de66b`, 2026-09-30.
> **Drift check (run first)**: `git diff --stat 965de66b..HEAD -- exampels src/core/watcher-registry.ts src/core/file-uri.ts src/tools/find-files.ts src/tools/stat.ts src/core/fmt.ts`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

The examples table has one prompt-driven app. Nothing shows the server's
push side — resource subscriptions — which is the capability that sets
filesystem-mcp apart from the reference server and the least obvious part of
the client SDK. `hooks` watches a workspace through one `subscriptions/listen`
on the root directory and, on each burst of external changes, runs a standing
instruction through an OpenAI-compatible model behind gatekeeper's approval
gate. When this lands, `exampels/README.md` has two rows and a developer can
copy one folder to build "when X changes, have the model do Y".

Requirements covered: [`R1`–`R22`](next-example-app.spec.md#requirements) of
[`next-example-app.spec.md`](next-example-app.spec.md). Spec-hunt found zero
gaps ([`next-example-app.spec-hunt.md`](next-example-app.spec-hunt.md)).

## Current state

### The app to imitate

- [`exampels/clients/gatekeeper/agent.ts`](../../../exampels/clients/gatekeeper/agent.ts) — 264 lines. Reuse verbatim (copy, do not import — each app is self-contained): `PROVIDERS`/`parseArgs` block (lines 19–49), `rl`/`ask()` (53–73), transport + `Client` construction (75–92), `client.onclose` (94–102), the `elicitation/create` handler (106–127), `toText` (129–134), `gate()` (139–160), `runTool()` (162–176), `chat()` (178–197), and the OpenAI tool mapping + `internal://instructions` read (200–214). Drop the `> ` REPL loop (232–250) and the `task` positional's optional-ness.
- [`exampels/clients/gatekeeper/check.ts`](../../../exampels/clients/gatekeeper/check.ts) — the harness to imitate: `runAgent()` spins a stub Chat Completions server on `127.0.0.1`, spawns the app with `LLM_BASE_URL`/`LLM_MODEL=stub`/`FS_MCP_BIN`, records every request body. The SIGINT scenario (lines 190–214) uses a `--import` preload that calls `process.emit('SIGINT')` — the only portable way to deliver SIGINT to a child on Windows.
- [`exampels/clients/gatekeeper/package.json`](../../../exampels/clients/gatekeeper/package.json):
  ```json
  { "name": "gatekeeper", "version": "1.0.0", "private": true, "type": "module",
    "engines": { "node": ">=24" },
    "scripts": { "start": "node agent.ts", "test": "node check.ts" },
    "dependencies": { "@modelcontextprotocol/client": "2.2.0" } }
  ```
- [`exampels/README.md:16-18`](../../../exampels/README.md#L16-L18) — the table, one row:
  ```markdown
  | App                               | What it does                                          | Run                                |
  | [gatekeeper](clients/gatekeeper/) | Coding agent with a y/N/why gate on every file change | `node agent.ts <dir> --model <id>` |
  ```
- [`exampels/AGENTS.md`](../../../exampels/AGENTS.md) — rules: one folder per app, `node <file>.ts` on Node 24, erasable TS only (`import type`, no `enum`), pin client to `2.2.0`, `npx -y @j0hanz/filesystem-mcp <dir>` or `node $FS_MCP_BIN <dir>`, ≤250 lines / ≤2 runtime deps, one keyless check script never named `*.test.ts`, model via `fetch`, add to the table.

### Server facts the app relies on (verified by a probe against `dist/` on 2026-09-30)

- Subscribing on the 2026-07-28 era: `const sub = await client.listen({ resourceSubscriptions: [uri] })` — `Client.listen` in [`@modelcontextprotocol/client` `index.d.mts:2608`](../../../node_modules/@modelcontextprotocol/client/dist/index.d.mts#L2608); resolves when the server acknowledges; `sub.close()` tears down. Notifications land on `client.setNotificationHandler('notifications/resources/updated', (n) => n.params.uri)`. Same `Client` options gatekeeper uses (`versionNegotiation: { mode: 'auto' }`) — [`__tests__/helpers.ts:446-449`](../../../__tests__/helpers.ts#L446-L449), [`__tests__/stdio.test.ts:100-111`](../../../__tests__/stdio.test.ts#L100-L111).
- Root URI: `filesystem-mcp://file/` + the resolved dir with `\`→`/`, `encodeURIComponent`, then `%2F`→`/` — [`src/core/file-uri.ts:23-26,37-39`](../../../src/core/file-uri.ts#L23-L39). Probe: `C:\Users\PC\AppData\Local\Temp\probe-X` → `filesystem-mcp://file/C%3A/Users/PC/AppData/Local/Temp/probe-X`.
- A directory URI gets one recursive `fs.watch`; the notification names the **directory**, never the file — [`src/core/watcher-registry.ts:192-216`](../../../src/core/watcher-registry.ts#L192-L216). The server debounces 50 ms per URI ([`watcher-registry.ts:106-130`](../../../src/core/watcher-registry.ts#L106-L130)). The app's own writes through the server fire it too (probe: an `edit` produced a second `updated`).
- `find_files` returns **text only** (no `structuredContent`), one root-relative path per line; when zero match, the single line `No files matching '<pattern>'`; trailer lines are prefixed `//` — [`src/tools/find-files.ts:159-176`](../../../src/tools/find-files.ts#L159-L176), [`src/core/fmt.ts:106-139`](../../../src/core/fmt.ts#L106-L139). `maxResults` max 10 000 ([`util.ts:150`](../../../src/core/util.ts#L150)); `includeHidden: true` includes `.github/`, and `.git/`, `node_modules/`, `dist/` stay excluded by the fixed ignore list applied via `skipIgnored: !includeIgnored` ([`src/core/glob.ts:501-506`](../../../src/core/glob.ts#L501-L506)). Probe output for `{pattern:'**/*', includeHidden:true}`: `.github/ci.yml\na.txt`.
- `stat` with `paths: [...]` (≤1000, [`schema.ts:129-150`](../../../src/core/schema.ts#L129-L150)) returns `structuredContent.results[]`, each `{ path, value: { modified: ISO, ... } }` or `{ path, error: { code: 'NOT_FOUND', ... } }`; `isError` is unset even when some paths fail. Probe excerpt:
  ```json
  {"results":[{"path":"a.txt","value":{"modified":"2026-09-30T09:44:46.220Z", ...}},
              {"path":"missing.txt","error":{"code":"NOT_FOUND", ...}}],
   "summary":{"total":2,"succeeded":1,"failed":1}}
  ```
- Write tools (`edit`, `create`, `move`, `delete`, `patch`, `replace_text`) carry `annotations.destructiveHint: true` and a `dryRun` input ([`src/tools/define.ts:399-401`](../../../src/tools/define.ts#L399-L401)); gatekeeper's `gate()` keys on exactly that.

### Decisions fixed by the spec (do not re-decide)

- Quiet period 1 000 ms, overridable by env `HOOKS_QUIET_MS` (test-only knob, not in the README env table).
- Discovery = `find_files {pattern:'**/*', includeHidden:true, maxResults:10000}` then `stat {paths}`; ignored dirs excluded by server default.
- Baseline advances at turn start (before the first model request).
- `--yes` skips the app's gate only; server elicitations still read stdin and decline at EOF (R13).
- Turns are stateless: each starts `[system, user]` (R21). Round cap 25 (R22).
- SIGINT → abort turn, close, exit 0 (R16). Server death → `filesystem-mcp exited`, exit 1 (R17). Model failure → stderr, keep watching (R14).

## Commands

Run from the repository root unless a `cd` is shown.

| Purpose                     | Command                                                                                        | Expected on success                                   |
| :-------------------------- | :--------------------------------------------------------------------------------------------- | :---------------------------------------------------- |
| Build the server for checks | `npm run build`                                                                                | exit 0, `dist/index.js` present                       |
| App check                   | `cd exampels/clients/hooks && npm test`                                                        | last line `check: ok`, exit 0                         |
| Baseline (unchanged) check  | `cd exampels/clients/gatekeeper && npm test`                                                   | last line `check: ok`                                 |
| Format                      | `npx prettier --write exampels docs/plan/2026-09-30-next-example-app`                          | exit 0                                                |
| Format gate                 | `npx prettier --check exampels`                                                                | `All matched files use Prettier code style!`, exit 0 |
| Line budget                 | `node -e "console.log(require('fs').readFileSync('exampels/clients/hooks/hooks.ts','utf8').trimEnd().split('\n').length)"` | a number ≤ 250                        |
| Usage path                  | `node exampels/clients/hooks/hooks.ts`                                                         | usage on stderr, exit 1                               |

## Scope

**In scope** — the only files to create or modify:

- `exampels/clients/hooks/package.json` (new) and `package-lock.json` (generated by `npm install`)
- `exampels/clients/hooks/hooks.ts` (new)
- `exampels/clients/hooks/check.ts` (new)
- `exampels/clients/hooks/README.md` (new)
- [`exampels/README.md`](../../../exampels/README.md) — one table row
- `docs/plan/2026-09-30-next-example-app/next-example-app.run.md` (run log, written by run-plan)

**Files out of scope** — leave alone even though they look related:

- [`exampels/clients/gatekeeper/**`](../../../exampels/clients/gatekeeper/) — each app is self-contained; sharing code would couple the two starting points.
- [`exampels/AGENTS.md`](../../../exampels/AGENTS.md) — rules, not an app.
- Anything under [`src/`](../../../src/) or [`__tests__/`](../../../__tests__/) — the server is the fixed dependency here; a server change to make the client easier is a different effort.
- [`package.json`](../../../package.json), [`server.json`](../../../server.json), [`mcpb/manifest.json`](../../../mcpb/manifest.json) — versions are bumped by the Release workflow only.
- [`README.md`](../../../README.md) (root) — it does not list example apps.

## Steps

### 1. Scaffold the package

Create `exampels/clients/hooks/package.json`, copying gatekeeper's shape with `name: "hooks"`, `description: "Event-driven agent: runs a standing task through a model whenever the workspace changes, built on filesystem-mcp"`, scripts `start: node hooks.ts`, `test: node check.ts`, and the single dependency `"@modelcontextprotocol/client": "2.2.0"`. Then `cd exampels/clients/hooks && npm install` to produce `package-lock.json` and `node_modules/` (already git-ignored by the root `.gitignore:5` `node_modules/` rule — after the install, `git check-ignore -v exampels/clients/hooks/node_modules` prints that rule and exits 0).

**Verify**: `cd exampels/clients/hooks && node -e "import('@modelcontextprotocol/client').then(m => console.log(typeof m.Client))"` → `function`

### 2. Write the check first (`check.ts`)

Create `exampels/clients/hooks/check.ts`, starting from gatekeeper's [`check.ts`](../../../exampels/clients/gatekeeper/check.ts) and changing the harness:

- `runHooks(opts)` spawns `node [--import <preload>] hooks.ts <dir> "keep it tidy" [--yes]` with env `LLM_BASE_URL`, `LLM_MODEL=stub`, `FS_MCP_BIN`, `HOOKS_QUIET_MS=200`, stdio `['pipe','pipe','pipe']`. It resolves a handle `{ child, requests, stdout(), stderr(), ready: Promise<void>, done: Promise<number|null> }` where `ready` resolves when stdout contains `watching ` (the R3 line) and `done` on `close`. A 60 s kill timer guards every run.
- The stub model: like gatekeeper's, but a script entry may also be `{ status: 500 }` to answer one request with HTTP 500 and body `boom` (R14).
- `waitFor(pred, ms)` polls every 25 ms.
- Ending a run: the app is a daemon, so every scenario ends it with SIGINT through **one** preload file written once into the temp dir, `stop.mjs`, loaded with `--import`. It emits `process.emit('SIGINT')` (a) after `Number(process.env.STOP_AFTER_MS)` ms when that env is set, and (b) when a chunk written to `process.stdout` contains `process.env.STOP_ON_STDOUT` when that is set (gatekeeper's `sigintAtGate` pattern, lines 190–201). Scenarios pick whichever fits; `child.kill()` is never used (see STOP).

Scenarios, each with its assertion and the requirement it exercises (name them in comments):

1. **R2** usage: no args → exit 1, stderr matches `/usage/`; `<task>` `"   "` → exit 1; `LLM_MODEL=''` → exit 1 and stderr matches `/--model/`. No stub request arrives.
2. **R3/R5/R7** one save: workspace `{a.txt, b.txt}`; after `ready`, rewrite `a.txt`, delete `b.txt`, create `c.txt` within 50 ms; wait for 1 request; the request's `messages` are exactly `[system, user]`; the user content contains `keep it tidy`, and lines matching `/modified: a\.txt/`, `/deleted: b\.txt/`, `/created: c\.txt/`. Stop with `STOP_AFTER_MS` after the request; exit 0 (R16).
3. **R6** burst: write three files 60 ms apart → wait 3 quiet periods → exactly 1 request, naming all three as created.
4. **R8** ignored churn: `mkdir .git`, after `ready` write `.git/index` → wait 3 quiet periods → 0 requests. Also write `.github/ci.yml` → 1 request naming `.github/ci.yml` (hidden but not ignored).
5. **R9/R12** own write: `--yes`; external write of `a.txt`; script `[edit a.txt hello→bye, {text:'done'}]`; after the second request wait 3 quiet periods → still exactly 2 requests; `a.txt` reads `bye\n`; no `apply?` in stdout.
6. **R10** change mid-turn: script `[read a.txt, {text:'done'}, {text:'done'}]` with `beforeReply(2)` = write `d.txt` externally, then wait 400 ms (two quiet periods) before answering → turn 1 is requests 1–2, turn 2 is request 3. Assert exactly 3 requests after 3 more quiet periods, and that request 3's `messages[1].content` matches `/created: d\.txt/` and `messages.length === 2` (R21).
7. **R11** gate: stdin `why: keep it\n`, script `[edit a.txt]` → `a.txt` unchanged, tool message `rejected by user: keep it`; stdin EOF → `rejected by user`. `apply?` appears in stdout.
8. **R13** server question under `--yes`: stdin closed (EOF), script `[stat <outside>/x.txt]` → tool message starts `ERROR: `.
9. **R14** model failure: script `[{status:500}]`, one write → stderr matches `/LLM 500/`; second write → a further request arrives (total 2).
10. **R15** malformed args: script `[{tool:'read', args:'{bad'}]` → next tool message starts `ERROR: `.
11. **R16** SIGINT at gate: preload with `STOP_ON_STDOUT=apply?`; script `[edit a.txt]` → exit code 0 within 5 s, `a.txt` unchanged.
12. **R17** server death: gatekeeper's `dying-server.mjs` trick (lines 168–188) → exit 1, stderr matches `/filesystem-mcp exited/`.
13. **R21** statelessness: covered by scenario 6 — request 3 (turn 2 start) has exactly 2 messages.
14. **R22** cap: script of 30 × `read a.txt` → exactly 25 requests in the turn and stdout matches `/stopped after 25/`.
15. **R4** bad server: `FS_MCP_BIN` = a script that `process.exit(1)` → exit 1, stderr matches `/filesystem-mcp (failed to start|exited)/` — `client.onclose` is registered before `connect()`, so either message may land first (plan-hunt C2).

End with `console.log('check: ok')`.

**Verify**: `cd exampels/clients/hooks && npm test` → fails with an error mentioning `hooks.ts` (the app does not exist yet); exit ≠ 0.

### 3. Write the app (`hooks.ts`)

Create `exampels/clients/hooks/hooks.ts`. Target shape — the parts copied from gatekeeper are named, the new parts are spelled out:

```ts
// hooks: an event-driven agent. filesystem-mcp watches the workspace and
// supplies the tools; any OpenAI-compatible chat endpoint runs the standing
// task each time something outside this process changes a file.
import { Client } from '@modelcontextprotocol/client';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

// (types ToolCall/Msg, MAX_ROUNDS, PROVIDERS — from gatekeeper)
const QUIET_MS = Number(process.env.HOOKS_QUIET_MS) || 1000;
const USAGE = `usage: node hooks.ts <dir> <task> [--provider ...] --model <id> [--yes]
  ...same provider lines as gatekeeper...
  --yes applies the model's file changes without asking.`;

const { values, positionals } = parseArgs({ allowPositionals: true,
  options: { provider: {type:'string', default:'ollama'}, model: {type:'string'}, yes: {type:'boolean', default:false} } });
const [dirArg, task] = positionals;
// R2: task must be present and non-blank
if (!dirArg || !task?.trim() || !preset || !model) { console.error(USAGE); process.exit(1); }

// (rl / ask() — from gatekeeper)
// (transport, serverLog, client — from gatekeeper; client name 'hooks')
// (client.onclose → 'filesystem-mcp exited', exit 1, abort current — from gatekeeper)   R17
// (elicitation/create handler — from gatekeeper, unchanged; --yes does not touch it)    R13
// (toText, toolsByName, gate() — from gatekeeper)

// Own writes: each applied destructive call records a [start, end] window; a
// changed file whose mtime falls in one is ours, not an external change.       R9
const ownWindows: [number, number][] = [];
let ownDeletes = 0; // delete/move applied this turn → deletions are ours

async function runTool(call, signal) {
  // as gatekeeper, plus: when tool.annotations.destructiveHint and (values.yes || gate approved):
  //   const t0 = Date.now(); const result = await client.callTool(...); ownWindows.push([t0 - 100, Date.now() + 100]);
  //   if (tool.name === 'delete' || tool.name === 'move') ownDeletes++;
}
// (chat() — from gatekeeper)

// ── change discovery through the server ────────────────────────────────    R7
type Snapshot = Map<string, string>; // relative path → modified ISO
async function snapshot(): Promise<Snapshot> {
  const found = toText(await client.callTool({ name: 'find_files',
    arguments: { pattern: '**/*', includeHidden: true, maxResults: 10000 } }) as CallToolResult);
  const paths = found.split('\n').filter((l) => l && !l.startsWith('//') && !l.startsWith('No files matching'));
  const snap: Snapshot = new Map();
  for (let i = 0; i < paths.length; i += 1000) {              // stat batches of ≤1000
    const res = await client.callTool({ name: 'stat', arguments: { paths: paths.slice(i, i + 1000) } }) as CallToolResult;
    const { results } = res.structuredContent as { results: { path: string; value?: { modified: string } }[] };
    for (const r of results) if (r.value) snap.set(r.path, r.value.modified);
  }
  return snap;
}
type Change = { kind: 'created' | 'modified' | 'deleted'; path: string; modified?: string };
function diff(before: Snapshot, after: Snapshot): Change[] {
  const out: Change[] = [];
  for (const [path, modified] of after) {
    const prev = before.get(path);
    if (prev === undefined) out.push({ kind: 'created', path, modified });
    else if (prev !== modified) out.push({ kind: 'modified', path, modified });
  }
  for (const path of before.keys()) if (!after.has(path)) out.push({ kind: 'deleted', path });
  return out;
}
const isOwn = (c: Change): boolean =>
  c.kind === 'deleted' ? ownDeletes > 0
  : ownWindows.some(([a, b]) => { const t = Date.parse(c.modified!); return t >= a && t <= b; });

// ── the loop ────────────────────────────────────────────────────────────
// connect (R4 error path as gatekeeper), listTools → openaiTools, instructions → system prompt
let baseline = await snapshot();                                                 // R3
const rootUri = 'filesystem-mcp://file/' + encodeURIComponent(dir.replace(/\\/g, '/')).replace(/%2F/gi, '/');
client.setNotificationHandler('notifications/resources/updated', () => schedule());   // R5/R6
const sub = await client.listen({ resourceSubscriptions: [rootUri] });
console.log(`watching ${dir}`);

let timer: NodeJS.Timeout | null = null;
let running = false;
function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(onQuiet, QUIET_MS); }   // R6
async function onQuiet() {
  timer = null;
  if (running) return;                        // R10: the running turn re-checks when it ends
  const now = await snapshot();
  const changes = diff(baseline, now);
  baseline = now;                             // advance at turn start
  if (changes.length === 0) return;           // R8
  await runTurn(changes);
}
async function runTurn(changes: Change[]) {
  running = true; ownWindows.length = 0; ownDeletes = 0;
  current = new AbortController();
  const user = `${task}\n\nChanged since the last turn (paths relative to ${dir}):\n` +
    changes.map((c) => `- ${c.kind}: ${c.path}`).join('\n');
  const messages: Msg[] = [{ role: 'system', content: system }, { role: 'user', content: user }];   // R21
  try {
    // gatekeeper's round loop (R22 message: `(stopped after ${MAX_ROUNDS} tool rounds)`)
  } catch (error) {
    if (current.signal.aborted) return;       // R16: exiting
    console.error(error instanceof Error ? error.message : String(error));       // R14
  } finally {
    current = null; running = false;
  }
  // R9/R10: what moved during the turn, minus our own writes
  const after = await snapshot();
  const external = diff(baseline, after).filter((c) => !isOwn(c));
  baseline = after;
  if (external.length > 0) await runTurn(external);
}

// R16
const interrupt = () => { closing = true; current?.abort(); if (timer) clearTimeout(timer);
  void sub.close().catch(() => {}).then(() => client.close()).then(() => { rl.close(); process.exit(0); }); };
rl.on('SIGINT', interrupt); process.on('SIGINT', interrupt);
```

Rules while writing: erasable TypeScript only (`import type`, no `enum`, no parameter properties); every stdout line the check greps for is fixed here — `watching <dir>`, `apply? [y/N/why] `, `(stopped after 25 tool rounds)`, `rejected by user`, `filesystem-mcp exited`, `filesystem-mcp failed to start`. `--yes` is consulted only in `runTool` before `gate()`; the elicitation handler is untouched.

Iterate until the check is green. If the file lands over 250 lines, trim comments and blank lines first, then collapse the provider table's formatting; do not remove behavior.

**Verify**: `cd exampels/clients/hooks && npm test` → last line `check: ok`, exit 0.
**Verify**: line-budget command from [Commands](#commands) → ≤ 250.

### 4. Document

Create `exampels/clients/hooks/README.md` with the same sections as gatekeeper's [`README.md`](../../../exampels/clients/gatekeeper/README.md): title + one-paragraph pitch, an abridged session (a save → `watching`, the change list, a tool call, a dry-run diff, `apply? [y/N/why]`), **Run** (`npm install`, `node hooks.ts <dir> "<task>" --provider <name> --model <id> [--yes]`, what `--yes` does and does not cover), the provider table and the env table copied from gatekeeper (no `HOOKS_QUIET_MS` row), **How it works** mapping to the client API — `StdioClientTransport`, `listTools`, `client.listen({ resourceSubscriptions: [rootUri] })`, `notifications/resources/updated` naming only the directory, `find_files` + `stat paths[]` as the diff, the gate on `destructiveHint`/`dryRun`, `elicitation/create`, `internal://instructions`, stateless turns — plus a **Limits** paragraph (one root, ≤10 000 files, changes inside ignored dirs are invisible, a file the model and you both change in the same turn is attributed to the model), and **Check** (`npm test`, build the server first).

Add the row to [`exampels/README.md`](../../../exampels/README.md) after gatekeeper's:

```markdown
| [hooks](clients/hooks/) | Runs a standing task through the model whenever the workspace changes | `node hooks.ts <dir> "<task>" --model <id>` |
```

Then `npx prettier --write exampels` (it realigns the table).

**Verify**: `npx prettier --check exampels` → `All matched files use Prettier code style!`
**Verify**: `grep -n "clients/hooks/" exampels/README.md` → exactly one line. (`git diff --stat -- exampels/README.md` will show several insertions and deletions: Prettier re-pads the header, separator and gatekeeper row to the wider new row. That is expected.)

### 5. Final gates

Run every command in [Commands](#commands). Run gatekeeper's check too — it shares nothing, but proves `dist/` is still the build both checks use.

**Verify**: `cd exampels/clients/gatekeeper && npm test` → `check: ok`; `git status --short` lists only in-scope paths.

## Done

- [ ] `cd exampels/clients/hooks && npm test` exits 0 with `check: ok`, and `check.ts` names R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R17, R21, R22 in comments beside their assertions.
- [ ] `hooks.ts` ≤ 250 lines; `package.json` has exactly one entry under `dependencies`.
- [ ] `npx prettier --check exampels` exits 0.
- [ ] `exampels/README.md` has a `clients/hooks/` row.
- [ ] `cd exampels/clients/gatekeeper && npm test` still prints `check: ok`.
- [ ] `git status --short` shows only files in the in-scope list.

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its excerpt — in particular if `find_files` starts returning `structuredContent`, if `stat` batch results change shape, or if `client.listen` rejects `{ resourceSubscriptions }`.
- A step's verification fails twice after one fix attempt.
- `hooks.ts` cannot be brought to ≤ 250 lines without removing a spec'd behavior — report the count; the fix is a spec delta on `R18` (gatekeeper itself is 264), not a silent overrun.
- A directory listen does not fire for a file created in a **subdirectory** on the executor's OS (recursive `fs.watch` on Linux needs Node ≥ 20.13; `engines` says ≥ 24, so this should not happen — if it does, report `node --version`).
- The `--import` preload cannot deliver SIGINT to the child (R16 scenario hangs past 5 s) — do not switch to `child.kill()`, which on Windows terminates without running handlers and would make the exit-code assertion meaningless.
- The fix appears to require a file in [Files out of scope](#scope).

## Notes

- **Amended 2026-09-30 after plan-hunt** ([`next-example-app.plan-hunt.md`](next-example-app.plan-hunt.md)): scenario 6 request count corrected to 3 (C3); scenario 15 accepts either startup-failure message (C2, suspected — settle on first run); step 4's diff-stat Verify replaced by the grep (C4).
- Reviewer focus: the own-write attribution (`ownWindows`/`ownDeletes`) is the one heuristic in the app. Its failure mode is documented in the README's Limits; the check pins the two behaviors the spec fixes (R9: no echo turn; R10: an external mid-turn write gets its turn).
- `HOOKS_QUIET_MS` exists so the check runs in seconds; it is deliberately undocumented for users.
- Deferred: `--url` for Streamable HTTP belongs to gatekeeper (ideation #12/D3), not here.
- No rollback needed: additive files plus one README row.
