# Spec: hooks — an event-driven example client

A terminal daemon in `exampels/clients/hooks/` that watches a workspace through
filesystem-mcp's resource subscriptions and, on every change, runs one standing
task through an OpenAI-compatible model with the same approval gate gatekeeper
uses.

Chosen in [`ideation`](next-example-app.ideation.md) (survivor A).

## Why

The examples table has one row, and it is prompt-driven: the human types, the
model acts. Nothing shows the server capability that sets filesystem-mcp apart
from the reference server — push notifications on file change
([README](../../../README.md#compared-with-the-reference-server)). A developer
who wants to build "when X changes, have the model do Y" has no starting
point, and the subscription API (`subscriptions/listen` on the 2026-07-28
era) is the least obvious part of the client SDK to get right. Once this
exists, that developer copies one folder, and the examples table demonstrates
both halves of the server: request/response tools and server-initiated events.

## Users and stories

- **P1** — As a developer, I want a daemon that reacts to file changes in my
  workspace by running a standing instruction through a model, so that
  derived artifacts (docs, indexes, generated tables) stay in sync without me
  prompting. (R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R21, R22)
- **P2** — As the person whose files these are, I want every write the daemon
  makes to stop at the same y/N/why gate gatekeeper has, unless I opted out,
  so that an unattended model cannot corrupt my tree. (R11, R12, R13)
- **P3** — As a developer copying this as a starting point, I want it to
  survive a flaky model endpoint and exit cleanly on Ctrl+C or server death,
  so that the skeleton is one I can run for hours. (R14, R15, R16, R17)
- **P4** — As a maintainer, I want a keyless check and a README row, so that
  the app is verifiable and discoverable like gatekeeper. (R18, R19, R20)

## Requirements

Terms: a `turn` is one model conversation from the standing task to a final
assistant message with no tool calls (or the round cap). The `baseline` is the
set of workspace files and their modification times the app last recorded.
`external change` is a change to a workspace file that the app's own tool
calls did not make. `quiet period` is the wait after the last change
notification before a turn starts.

### Startup and arguments

- **R1** The `hooks` app shall accept `node hooks.ts <dir> <task> [--provider <name>] [--model <id>] [--yes]`, where `<dir>` is the workspace root and `<task>` the standing instruction, and shall read `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY` and `FS_MCP_BIN` exactly as gatekeeper does ([`agent.ts:19-49`](../../../exampels/clients/gatekeeper/agent.ts#L19-L49)).
  - Falsified by: a gatekeeper-valid provider/model/env combination that gatekeeper accepts and hooks rejects, or vice versa.
  - Given `LLM_BASE_URL` and `LLM_MODEL` set, When run with `<dir> <task>` only, Then the app starts watching.
  - Given `--provider gemini` and no `GEMINI_API_KEY`, When run, Then the request to the model carries no authorization header (same as gatekeeper).
- **R2** If `<dir>` or `<task>` is missing, `<task>` is blank, `--provider` is unknown, or no model is given, then the app shall print a usage message to stderr and exit with code 1 before starting the server.
  - Falsified by: any of those inputs producing exit code 0, or a spawned server process.
  - Given no `--model` and no `LLM_MODEL`, When run, Then stderr contains `--model` and the exit code is 1.
  - Given `<task>` is `"   "`, When run, Then the exit code is 1.
- **R3** When started, the app shall launch filesystem-mcp on `<dir>` (via `npx -y @j0hanz/filesystem-mcp <dir>`, or `node $FS_MCP_BIN <dir>` when set), record the baseline through the server's tools only, subscribe to changes under `<dir>`, and print one line naming the watched directory to stdout.
  - Falsified by: the app calling Node `fs` on the workspace directly; or no line naming `<dir>` on stdout before the first change.
  - Given a workspace with two files, When the app starts, Then stdout has a line containing the resolved `<dir>` and no turn has run.
  - Given an empty workspace, When the app starts, Then it watches with an empty baseline and a later created file is reported as created (R7).
- **R4** If the server fails to start or the subscription is refused, then the app shall print the server's error (with the server's captured stderr) and exit with code 1.
  - Falsified by: a server that exits at startup leaving the app running, or exiting 1 with no message.
  - Given `FS_MCP_BIN` pointing at a script that exits immediately, When the app starts, Then the exit code is 1 and stderr names the failure.

### Reacting to changes

- **R5** When an external change occurs under `<dir>` and the quiet period then elapses with no further notification, the app shall start exactly one turn.
  - Falsified by: one external write producing zero or two model conversations.
  - Given the app is watching, When one file is written once, Then exactly one turn runs.
- **R6** While the quiet period is open, when another change notification arrives, the app shall restart the quiet period instead of starting a second turn.
  - Falsified by: two writes 100 ms apart producing two turns.
  - Given the app is watching, When three files are written within 200 ms, Then exactly one turn runs and it names all three.
- **R7** The first model message of a turn shall contain the standing task and the workspace-relative paths of every file created, modified or deleted since the baseline, each labeled as one of those three, discovered through the server's tools only.
  - Falsified by: a turn after a create + a modify + a delete whose first user message omits any of the three paths or mislabels one; or a direct Node `fs` read of the workspace in the app.
  - Given files `a.txt` and `b.txt` in the baseline, When `a.txt` is rewritten, `b.txt` deleted and `c.txt` created, Then the first user message names `a.txt` as modified, `b.txt` as deleted and `c.txt` as created.
- **R8** If a change notification arrives but no file differs from the baseline under the app's discovery rules (for example only ignored paths such as `.git/` or `node_modules/` changed), then the app shall start no turn.
  - Falsified by: a write into `<dir>/.git/` starting a turn.
  - Given a workspace with a `.git/` directory, When a file inside `.git/` is written, Then no model request is made within two quiet periods.
- **R9** The app shall not start a turn for changes made by its own tool calls.
  - Falsified by: a turn in which the model edits a file (approved) being followed by a second turn with no external change.
  - Given `--yes`, When the model's only tool call is an `edit` and the turn ends, Then no further model request is made within two quiet periods.
- **R10** While a turn is running, when an external change occurs, the app shall run one further turn after the current one ends, naming that change; changes during a turn never start a concurrent turn.
  - Falsified by: two model conversations interleaving, or an external write during a turn producing no later turn.
  - Given a turn in progress, When an external file is written, Then after the current turn's final message one more turn starts and names that file.
- **R21** Each turn shall start from the system prompt (the server's `internal://instructions` plus the workspace root) and the message from R7; messages from earlier turns shall not be sent.
  - Falsified by: a model request whose messages include a `tool` role message from a previous turn.
  - Given turn 1 made two tool calls, When turn 2 starts, Then its first request has exactly one system and one user message.
- **R22** A turn shall stop after 25 tool rounds and print that it did, matching gatekeeper's `MAX_ROUNDS`.
  - Falsified by: a model that always returns tool calls driving a 26th request within one turn.
  - Given a model that always calls `read`, When a turn runs, Then 25 model requests are made and stdout notes the cap.

### Gate and confirmations

- **R11** When the model calls a tool whose `annotations.destructiveHint` is set and `--yes` is absent, the app shall show the tool's `dryRun` preview when its schema has one and stop at an `apply? [y/N/why]` prompt on stdin, with gatekeeper's semantics: `y` applies; anything else (including EOF) refuses and returns `rejected by user[: <why>]` to the model.
  - Falsified by: a destructive call applied without a `y`, or a refusal message that differs from gatekeeper's.
  - Given stdin `why: keep it\n`, When the model calls `edit`, Then the file is unchanged and the tool message is `rejected by user: keep it`.
  - Given stdin at EOF, When the model calls `edit`, Then the file is unchanged and the tool message is `rejected by user`.
- **R12** Where `--yes` is given, the app shall apply destructive tool calls without prompting.
  - Falsified by: an `apply?` prompt appearing on stdout with `--yes`.
  - Given `--yes` and stdin at EOF, When the model calls `edit`, Then the file changes.
- **R13** When the server asks a question (`elicitation/create`, one boolean or one enum field), the app shall answer it from stdin exactly as gatekeeper does, and shall decline when stdin is at EOF, regardless of `--yes`.
  - Falsified by: `--yes` auto-accepting a server confirmation, or a `url`-mode or multi-field elicitation being accepted.
  - Given `--yes` and stdin at EOF, When the model stats a path outside `<dir>`, Then the tool result is an `ERROR:` and no access is granted.

### Resilience and exit

- **R14** If a model request fails (unreachable host, non-2xx status) during a turn, then the app shall print the error to stderr, end that turn, and keep watching; the next external change shall start a turn.
  - Falsified by: the process exiting, or the next change producing no model request.
  - Given the model endpoint returns 500 once, When a file is written, Then stderr names the failure; When another file is written after the endpoint recovers, Then a turn runs.
- **R15** If a tool call fails or its arguments are malformed, then the app shall send the model `ERROR: <message>` as the tool result, as gatekeeper does.
  - Falsified by: a malformed-arguments call ending the turn or the process.
  - Given the model calls `read` with `{bad`, When the turn runs, Then the next tool message starts with `ERROR: `.
- **R16** When SIGINT arrives (Ctrl+C, in a terminal or piped), the app shall abort any running turn, close the server, and exit with code 0 — it does not wait for the turn to finish.
  - Falsified by: SIGINT during a gate prompt leaving the process alive after 5 s, or an exit code other than 0.
  - Given a turn waiting at `apply?`, When SIGINT arrives, Then the process exits 0 within 5 s and the file is unchanged.
- **R17** If the server process exits while the app is watching, then the app shall print `filesystem-mcp exited` to stderr and exit with code 1.
  - Falsified by: a dead server leaving the app waiting for notifications that cannot come.
  - Given a server that exits mid-session, When it exits, Then the app exits 1 with that message.

### Packaging

- **R18** The app shall live in `exampels/clients/hooks/` with `hooks.ts`, `check.ts`, `README.md`, `package.json` (and lockfile), run as `node hooks.ts` on Node 24 with no build step, have `@modelcontextprotocol/client@2.2.0` as its only runtime dependency, and be at most 350 lines in `hooks.ts` as formatted by the repository's Prettier config, keeping `exampels/AGENTS.md`'s 250 as the target. (Amended 2026-09-30 by [`next-example-app.spec-delta.md`](next-example-app.spec-delta.md); folded 2026-10-02.)
  - Falsified by: `hooks.ts` over 350 lines, a second runtime dependency, a `tsx`/build step, or an `enum`.
- **R19** `npm test` in the app folder shall run `check.ts`: the real app and server against a scripted stub model on `127.0.0.1`, needing no key or network, and shall exercise at least R5, R6, R7, R8, R9, R11, R12, R14 and R16.
  - Falsified by: the check needing a network or API key, or any listed requirement lacking an assertion.
- **R20** `exampels/README.md` shall gain a table row for hooks in the same columns as gatekeeper, and the app's `README.md` shall show an abridged session, a run section, the provider/env tables, a "how it works" section mapping each part to the client API used (notably `client.listen({ resourceSubscriptions })` and `notifications/resources/updated`), and a check section.
  - Falsified by: the table missing hooks, or the README not naming the subscription API.

## Constraints

- Rules for apps — [`exampels/AGENTS.md`](../../../exampels/AGENTS.md): ≤250 lines, ≤2 runtime deps, erasable TypeScript, keyless check not named `*.test.ts`, model access via `fetch`, add to the table.
- The 2026-07-28 era has no `resources/subscribe`; the client subscribes with `subscriptions/listen` carrying `resourceSubscriptions` ([`resources.ts:484-497`](../../../src/resources.ts#L484-L497), [`stdio.test.ts:100-111`](../../../__tests__/stdio.test.ts#L100-L111)). gatekeeper already negotiates that era.
- A directory URI takes one recursive watch, so the root URI covers new files; the notification names the directory, not the file ([`watcher-registry.ts:192-216`](../../../src/core/watcher-registry.ts#L192-L216)). Change discovery is the client's job (R7).
- The server debounces 50 ms per URI ([`watcher-registry.ts:106-130`](../../../src/core/watcher-registry.ts#L106-L130)); the app's quiet period sits on top.
- `find_files` returns paths only; `stat` returns `modified` and accepts `paths[]` up to 1000 ([`schema.ts:129-150`](../../../src/core/schema.ts#L129-L150)); `find_files` pages at 100 by default, 10 000 max ([`util.ts:150-151`](../../../src/core/util.ts#L150-L151)).
- Baseline refresh after a change shall complete within 2 s at p95 for a 1 000-file workspace, measured from notification to the first model request, on the check machine.

## Out of scope

- A model-free mode that only prints changes — that is candidate #1, killed as a twin.
- Running the standing task once at startup — the app reacts; a first run is `node ../gatekeeper/agent.ts`.
- Streamable HTTP / remote servers — a flag for gatekeeper, not this app.
- Cross-turn memory — each turn is stateless (R21); the workspace is the memory.
- Multiple standing tasks or per-glob tasks — one task per process; run two processes.
- Watching several roots — one `<dir>`.

## Success criteria

1. From a cold clone with `dist/` built, `npm install && npm test` in `exampels/clients/hooks/` passes with no network or API key.
2. Against a real tool-capable model, saving a file in `<dir>` produces one turn within quiet period + 2 s that names that file, and the model's approved edit does not trigger a second turn.
3. `wc -l hooks.ts` ≤ 350 and `package.json` lists one runtime dependency.
4. A developer can find hooks in `exampels/README.md` and the subscription call in its README without reading `hooks.ts`.

## Assumptions and open questions

Defaults chosen where the input was silent:

- Name is `hooks`, as in the ideation page; folder `exampels/clients/hooks/`, entry `hooks.ts`.
- Quiet period is 1 000 ms; overridable by `HOOKS_QUIET_MS` for the check script only (not documented as a user flag).
- Discovery uses `find_files` with `includeHidden: true` and ignored paths excluded, so `.github/` changes count and `.git/`, `node_modules/` do not (R8).
- Workspaces over one `find_files` page: the app follows `nextCursor` up to the server maximum (10 000 files); larger trees are out of scope and the README says so.
- `--yes` covers only the app's gate; server confirmations still read stdin and decline at EOF (R13). An unattended `--yes` run therefore never grants out-of-root access or overwrites without a human.
- Turn messages are stateless (R21) to bound memory in a long-running process.
- Startup does not run the task (see Out of scope).
- SIGINT exits rather than returning to a prompt: there is no prompt in a daemon.

No `[NEEDS CLARIFICATION]` markers remain.
