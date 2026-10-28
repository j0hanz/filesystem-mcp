# Implementation Plans

Open plans from the improve-skill audits (2026-09-25 to 2026-10-16). Finished,
superseded and reverted plans were deleted on 2026-10-28; `git log -- plans/`
holds them. Each executor: read the plan fully before starting, honor its STOP
conditions, and update your row when done.

These files are Prettier-checked by `npm run check` (`plans/` is not in
`.prettierignore`), so run `npx prettier --write plans/` after editing one.

## Execution order & status

| Plan | Title                                                   | Priority | Effort | Depends on | Status                                                                                                       |
| ---- | ------------------------------------------------------- | -------- | ------ | ---------- | ------------------------------------------------------------------------------------------------------------ |
| 061  | Suite green as root; stdio lease tests run concurrently | P3       | S      | 056        | PARTIAL (step 1 only; blocked on 056; branch `advisor/061-suite-root-safe-and-faster-stdio`, tip `6c0ebe6c`) |
| 077  | Inline single-use hop helpers                           | P2       | S      | —          | TODO — commit dda3542b                                                                                       |
| 078  | Dedupe PathGuard test recompute pairs                   | P2       | S      | —          | TODO — commit dda3542b                                                                                       |
| 079  | Single unicode fold primitive for search                | P3       | S      | —          | TODO — commit dda3542b                                                                                       |
| 080  | Enforce coverage floor on all runners                   | P3       | S      | —          | TODO — commit dda3542b                                                                                       |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) |
REJECTED (with one-line rationale — finding fixed independently or approach
abandoned)

## Dependency notes

- **056 before 061.** 061 runs stdio lease tests concurrently, which adds
  load. 056 has to find out first whether load is what drops notifications.

## Findings considered and rejected

From the 2026-10-13 standard audit at `8deb0d50`:

- TypeScript 7: `typescript-eslint` 8.71.x (latest and canary) still
  declares `typescript <6.1.0`. Re-check on its next minor.
- Routine in-range bumps (express 5.3.0, zod 4.6.7, prettier 3.9.10,
  typescript-eslint 8.71.2): `npm update`-grade, not plans. `@types/node`
  stays on `^24` to match `engines`.
- `exampels/` at the repo root: untracked local leftover holding only
  `node_modules/`. Delete it locally; no repo change.
- Cursor plugin (`mcp.json`) starting with no roots on a 2026-07-28
  connection: LOW confidence, needs a live Cursor session to confirm.
- In-flight `search_text` overshoot (each in-flight file may collect up to
  10k results before the shared cap is checked, `search.ts:332,405`): not
  measured; the snapshot-store memory is already a `ponytail:` ceiling.
- Tests for writes through a dangling in-root symlink (`fs.ts:62-66`) and
  for the schema refinements that reject conflicting arguments
  (`schema.ts:93-188`, `edit.ts:76-99`): both fail closed; low value.
- `CONTRIBUTING.md` tree omissions (`scripts/check-release-paths.sh`,
  `.cursor-plugin/`, `mcp.json`): trivial; fold into any docs edit.

From the 2026-10-12 testing & merge-gate audit at `3da494ae`:

- StrykerJS mutation testing in CI: with `node:test` it runs only through
  `@stryker-mutator/tap-runner`, which treats a whole file as one test and
  runs each file as its own process. With 36 files and many subprocess
  tests, a run would take hours. A one-off manual run on
  `src/core/path-utils.ts` is the most it is worth.
- Merge queue: not available on user-owned repositories.
- Test sharding / `--test-shard`: the suite takes about 20 s.
- `paths-ignore` / changed-files gating for docs-only PRs: skipped workflows
  leave required checks pending forever once 064 lands, and a run takes
  about 2 min.
- MCP Inspector `--cli` in CI: `__tests__/dist-smoke.test.ts` already boots
  the built bin through the real SDK client (the Inspector harness was
  dropped in `3df177b3` for the same reason).
- LLM-based MCP evals as a gate: non-deterministic and paid. No comparable
  repo gates on them.
- `@reporters/github` annotations: it adds a dependency, and 055's split
  steps already show which check failed. Revisit if test-failure triage in
  CI logs stays slow.
- `knip --production` as a dev-only-import guard: at `3da494ae` it reports 6
  of 8 runtime dependencies as unused (the entries are tests only), so it is
  noise. 059 boots the production trees instead.
- An `npm pack` → install-from-tarball smoke test: still deferred (plan
  046's note). 059's Docker and MCPB boots cover the prod-deps question.
- Dependabot: still rejected (exact SDK pins). The weekly SDK canary (below)
  is the pin-respecting alternative.
- Lint ban on static `it.skip` / `describe.skip`: there are none today, and
  `.only` cannot leak under `node --test` without `--test-only`. Low value.

- Per-request `createServer` on the HTTP leg: measured 1.9 ms warm per
  request; tool shapes and stores are already shared. Not worth it.
- Splitting `src/core/path.ts` (815 lines): one cohesive `PathGuard` class on
  a security boundary; a split buys nothing verifiable.
- Dependabot: would fight the deliberate exact pins on `@modelcontextprotocol/*`.
- `.mcpregistry_*` token files in the repo root: gitignored and untracked;
  local-only, not a finding.
- `search_text` collecting up to 10,000 results regardless of page size:
  deliberate, keeps paginated totals stable.
- `destExists` failing open on non-ENOENT errors: no realistic trigger found.
- Previously settled (do not re-propose): `exactOptionalPropertyTypes`
  spreads, the `resources.ts` contract layer, the local `LoggingLevel` union,
  `destructiveHint` annotations, the watcher registry's URI-only keying.

From the 2026-09-26 SDK audit (against installed server 2.1.0 / node 2.1.0 /
express 2.0.1; every claim verified against `dist/*.d.mts`, not the docs
site — the docs run ahead):

- Tasks API cluster (`Task`, `ToolExecution`, `tasks/*` wire methods,
  `RELATED_TASK_META_KEY`): every export is `@deprecated 2025-11-25 wire
vocabulary with no SDK runtime; kept importable for interoperability
only`. Dead end — skip permanently unless the SDK revives it.
- `requireBearerAuth` / `verifyBearerToken` / `bearerAuthChallengeResponse` /
  `buildOAuthProtectedResourceMetadata` / `mcpAuthMetadataRouter`:
  mechanically unfit for the static-operator-key model (verifier and
  `oauthMetadata` are required inputs; the 401 body is OAuth JSON, not a
  JSON-RPC envelope). The hand-rolled middleware is documented at
  `src/transport/http-policy.ts:258-264` and stays.
- `isJSONRPCResultResponse` / `isJSONRPCErrorResponse` in the stdio
  send-wrap (`src/transport/stdio.ts:223`): SDK covers it, but the guards
  deep-parse every outbound message; the O(1) `'id' in message` check is
  deliberately kept.
- `specTypeSchemas.CancelledNotification` for the cancelled-request parse
  (`src/transport/stdio.ts:42`): hand-parse is the cheap path on the
  every-message hot line; migrating buys strict-shape validation only.
- `maxSubscriptions` tuning (both legs): default 1024 already active; the
  binding constraint is `MAX_WATCHERS` (256).
- `scopeChallenge` / `requireScopes`, `icons` (implementation/tool/prompt),
  `responseMode`, `bus` injection, `EventStore` + sessionful transports
  (ADR-003), `inputRequired.{maxRounds,roundTimeoutMs,legacyShim}` tuning
  (defaults are load-bearing), `preloadSchemas` / `fromJsonSchema` /
  `SdkError` / sampling: no story for this server.
- `debouncedNotificationMethods` for `resources/updated` (as opposed to
  `list_changed`, which plan 012 adopts): the watcher registry already
  debounces per-URI across ticks.
- Doc-only symbols (docs site ahead of 2.1.0 — re-check on the next SDK
  bump): `parseListenFilter` / `createListenRouter` (listenRouter module,
  would replace `listenSubscriptionUris` in `src/transport/shared.ts:58-66`)
  and `createServerNotifier` (implemented in `dist/mcp-*.mjs`, exported from
  no installed d.mts).

From the SDK re-audit at `1eb94134` (2026-09-26; four agents, every cited
line re-read by the advisor; the docs site's package-level export list
matched the installed `server/dist/index.d.mts:773` exactly, 412 names):

- The doc-only set is unchanged: `parseListenFilter` / `createListenRouter`
  and `createServerNotifier`. Every other doc-only name on the per-module
  doc pages is an internal helper that no package entry re-exports.
- Duplicate unrestricted-host warning (`src/transport/http.ts:104-108` plus
  the SDK's `console.warn`): moot once 013 lands, since 013 drops
  `createMcpExpressApp`.
- `isLoopbackHttpHost` → SDK `localhostAllowedHostnames()`: the Host-header
  form is not the bind-address form (no bare `::1`). Not equivalent.
- `RegisteredTool.disable()` for the `--read-only` gate
  (`src/tools/index.ts:36-43`): the config is static, and filtering at
  registration is simpler.
- SDK private `createToolError` for handler throws
  (`src/tools/define.ts:289-298`): it returns the bare message only and would
  drop the error code, the suggestion and the progress fail frame.
- `MissingRequiredClientCapabilityError` for the elicitation pre-check
  (`src/core/input-required.ts:196-230`): a protocol error the model never
  sees; the custom `isError` result is actionable.
- `UriTemplate.expand` for file-URI encoding (`src/core/file-uri.ts:24-40`):
  the SDK's `{+path}` expansion leaves `#` and `?` raw, which truncates the
  path.
- `inputRequired.listRoots()` for modern-era roots: the client `roots`
  capability is deprecated (SEP-2577).

From the 2026-09-26 full audit at `8c2a82cd` (four agents: security,
correctness, tests+perf, debt/deps/DX/docs/direction; every cited line
re-read by the advisor):

- HTTP clients answering their own out-of-root grant elicitation: MCP
  elicitation trusts the client on both transports; `FS_ROOT_BOUNDARY` is
  the documented limiter. A startup warning when HTTP runs without a
  boundary would be the only addition; not planned.
- Kelvin-sign / Unicode case-fold mismatch in containment
  (`path-utils.ts:171-175`): exploiting it needs write access beside the
  root already. Not worth a plan.
- The one-off bare `test failed` in `tools.test.ts` ("HTTP pagination
  survives the per-request server factory"): evidence (orphaned temp dirs,
  no `after` hook ran) points to the test process dying, not an assertion;
  0/140 reproductions. Investigate only when it recurs.
- Elicitation answer readers accepting values never offered
  (`input-required.ts:116-118`): every caller re-checks against what it
  offered. Hardening only; skipped again.
- Four dead-code sites (a never-firing 5 s timeout in `list.ts`, a duplicate
  `validateExistingPath` in `resources.ts`, two unreachable notifier
  branches): harmless; skipped.
- Timing-based "exactly one notification" assertions in the subscription
  tests: MED confidence flake risk, no observed failure. Skipped.
- `create`/`move` moving onto the shared `{ results, summary }` envelope:
  a wire-shape change; the release type is the operator's call. Presented,
  not planned.
- SHA-pinning GitHub Actions: without an automated bumper (Dependabot was
  rejected) SHA pins rot; tag pins stay. Noted in plan 036.
- `define.ts` churn (69 commits): a hub file touched by every cross-cutting
  sweep, not a missing seam. Layering is clean (`core/` imports nothing
  from `tools/`/`transport/`).
- Duplicate type-check in `check:static` (~3.5 s), pre-commit hooks,
  `.vscode/tasks.json`: not worth it.
- Dependencies: `@modelcontextprotocol/*` 2.1.0 / express 2.0.1 are latest;
  `typescript@7` is out but `typescript-eslint@8.70` requires `<6.1`; the
  doc-only SDK symbols (`parseListenFilter`, `createListenRouter`,
  `createServerNotifier`) are still unexported. Nothing to do.
  (Superseded 2026-09-28: `server@2.2.0` / `client@2.2.0` are out — plan 047.)
- SDK 2.2.0 re-check (2026-09-28, plan 047): `parseListenFilter` /
  `createListenRouter` / `createServerNotifier` are still unexported.

From the 2026-09-28 deep audit at `4d751c94` (seven agents; every cited
line re-read by the advisor):

- **Malformed `WWW-Authenticate` challenge** (`http-policy.ts:255`):
  **false positive.** The source is `` `Bearer ${params.join(', ')}` ``;
  the auditor's tool output (and the advisor's file viewer) masked the
  `Bearer ${…}` template as `******`. Verified by dumping the line's char
  codes. Not a finding — and a reminder to verify any "secret-looking"
  string with a raw read before reporting it.
- Paged-response adapter "duplication" across `find-files.ts`,
  `search-text.ts`, `list.ts`: the shared `paginate` engine already owns the
  logic; each tool adds two `...(x ? {x} : {})` spreads for `resourceUri`
  and `nextCursor`. Below the net-deletion bar.
- Splitting the long handlers (`replace-text.ts` `handleSearchAndReplace`,
  `read.ts` `run`, `move.ts` `runTransfers`, `delete.ts` `handleDelete`)
  into phase functions: no verifiable gain, real abort/ordering risk. Not
  planned.
- Moving architectural prose out of `path.ts` / `search.ts` / `http.ts`
  comments into ADRs: the repository's comment style is deliberate and was
  re-anchored by plan 039. Not planned.
- `writeFile` continuing with the default mode when the existing mode
  cannot be read (`fs.ts:174-184`): deliberate warn-and-continue with no
  realistic trigger (a `stat` that fails with EACCES implies the rename
  would too). Not planned.
- `GitignoreManager.isIgnored` O(D²) prefix loops: D is path depth (< 10 in
  practice); map lookups, not syscalls. Not measurable.
- Routine dev-dep bumps (`@types/node`, `typescript-eslint` minors), an
  `.editorconfig`, knip covering `scripts/*.mjs`: `npm update`-grade
  housekeeping, not plans.
- Windows-specific PathGuard tests: the CI matrix runs the whole suite on
  Windows and the platform-conditional tests (027, 030, aliased-root) exist.
- HTTP 413/415 "untested": both are pinned in `http-server.test.ts:97,275`.
  Only `FS_TRUST_PROXY` lacks an end-to-end test (backlog below).
- Structural/AST search tool (direction): ungrounded — no issue, doc or
  TODO asks for it.

From the 2026-09-29 SDK v2 gap analysis at `fb51aee1` (installed 2.2.0 /
2.1.0 / 2.0.1 typings and runtime as ground truth; every candidate re-read
in `dist/*.d.mts` before rejection):

- `outputSchema` — pinned off by TOOL-SURFACE-001 (`define.ts:398-403`);
  text-authoring tools ship metadata in `_meta`, and a published schema
  would oblige `structuredContent` on every result.
- `createListenRouter` / `parseListenFilter` / `createServerNotifier` —
  present in the SDK source on `main`, still unexported in 2.2.0 (0 hits in
  `dist/*.d.mts`); the hand-rolled listen gates in `stdio.ts` / `http.ts`
  stay. Re-check on the next SDK bump.
- `requireBearerAuth` / `mcpAuthMetadataRouter` / `requireScopes` /
  `AuthInfo` pass-through into `ctx.http.authInfo` — OAuth-shaped; a single
  static operator key has nothing to key on (previously rejected, unchanged).
- `@modelcontextprotocol/fastify` / `hono` — only Host/Origin arming and (hono)
  a body parser; no auth helper; the Express wiring already uses the same
  SDK gates. Nothing to gain from a framework swap.
- `createMcpExpressApp` — mounts `express.json()` (Express's 100 kb default)
  app-wide before auth; the hand-assembled app (plan 013) is deliberately
  stricter and now (048) sizes its own limit.
- `responseMode`, `bus`, `EventStore`, sessionful legacy HTTP — ADR-003
  chose stateless per-request serving; single process.
- `maxSubscriptions`, `keepAliveMs`, `inputRequired.{maxRounds,roundTimeoutMs,legacyShim}`
  — defaults are load-bearing; `MAX_WATCHERS` (256) binds first.
- `sendLoggingMessage` / `ctx.mcpReq.log`, sampling, `ToolExecution` /
  Tasks, `elicitUrl`, `ctx.mcpReq.send` — deprecated (SEP-2577) or no
  server→client channel on 2026-07-28; stderr logging is already the
  migration target the SDK names.
- `icons`, `RegisteredTool.update()` / `disable()` — cosmetic or static
  config (previously rejected, unchanged).
- `fromJsonSchema` / `validators/ajv` — Zod schemas already; nothing to
  convert.
- SEP-2243 `Mcp-Param-*` pre-dispatch validation — the SDK performs it from
  the registered `inputSchema`; nothing for the server to add.
- Test harness patterns (`handler.fetch` as the client transport's `fetch`,
  `versionNegotiation: 'auto'`, `StdioClientTransport`) — already the
  SDK-documented approach (`__tests__/helpers.ts:234-240,315-320,439-447`).
- ADR-002 sunset trigger — not met: `Server.listRoots()` and
  `getClientCapabilities()` are still present in 2.2.0.

From the 2026-10-09 SDK 2.3.1 / adapter review at `8941498f`:

- **Adapter swap to `@modelcontextprotocol/hono` 2.0.2 or `/fastify` 2.0.1:
  stay on express.** Re-evaluated at the new versions. Hono's one feature
  express lacks, `maxRequestBodySize` (413 before parse, 4 MiB default), is
  already achieved by `express.json({ limit })` at `src/transport/http.ts:171`
  plus `toNodeHandler({ maxRequestBodySize })` at `:322`; its Workers / Deno
  / Bun reach is moot for a `node:fs` / `fs.watch` server. Fastify has no
  body option and no auth helper. Neither ships an auth hook, so the bearer,
  CORS-reflection, rate-limiter, 405 and error middleware
  (`http-policy.ts:271,342,378`; `http.ts:246,252`) would be rewritten for
  zero behaviour change. The only concrete hono gain is dependency pruning
  (`express`, `cors`, `@modelcontextprotocol/express` and `/node` out; `hono`
  and `@hono/node-server` are already in the tree via
  `@modelcontextprotocol/node` 2.1.1); revisit only if express maintenance
  becomes a cost.
- `VerifyBearerTokenOptions.expectedResource` (server 2.3.0, passed through
  by express 2.0.2): only relevant on the SDK `requireBearerAuth` /
  `verifyBearerToken` path, which stays rejected for the static-key case
  (missing-header → `invalid_token`, required `expiresAt`, OAuth JSON 401
  body). 2.3.x changed none of those blockers.
- `isLegacyRequest` / `legacyStatelessFallback` / `classifyInboundRequest` /
  `ToWebRequestOptions.signal`: user-land routing primitives for servers that
  do not use `createMcpHandler`'s built-in `legacy: 'stateless'`. This one
  does (`http.ts:316`); they would add code, not remove it.
- `McpRequestContext.authInfo` / `requestInfo` in the per-request factory:
  single static credential (`clientId: 'api-key'`), nothing to key on;
  previously rejected, unchanged.
- Not yet published (in the hosted docs, absent from every installed
  `.d.mts`): `honoredSubset`, `createServerNotifier`, `armSseKeepAlive`,
  `DEFAULT_SSE_KEEP_ALIVE_MS`, `resolveMaxRequestBodySize`, `MAX_BATCH_SIZE`,
  `requestBodyTooLargeMessage`, `createScopeChallengeResponse`,
  `findScopeChallenge`, `StdioListenRouter`, `parseListenFilter`,
  `createListenRouter`, `buildWwwAuthenticateHeader`. Re-check on the next
  SDK bump.
- Index correction: the "`droppedInputResponseKeys` re-ask rejected" note in
  the older `docs/plan/2026-09-23-sdk-builtins` hunt is superseded; plan 049
  implemented it (`src/core/input-required.ts:287-297`, `CHANGELOG.md`).

## Found but not planned (available for a later run)

From the 2026-10-13 standard audit at `8deb0d50` (not selected):

- **A confirmed recursive delete fails the whole batch when the confirmed
  directory vanished during the prompt.** `delete { paths: ['d','f.txt'],
recursive: true, ignoreIfNotExists: true }`: if `d` is removed while the
  human confirms, the retry's pending set is empty, the round still runs
  (`delete.ts:320`), and `pendingRoundTrip` throws "confirmation does not
  match the requested paths" (`input-required.ts:297-302`); `f.txt` is not
  deleted. Fail-closed; the comment at `delete.ts:317-319` suggests the
  empty-set check is deliberate. Effort S, confidence MED.
- **The externalized result JSON is built before the size check that
  refuses it.** 10k matches with `context: 10` stringify to about 20 MiB
  (36 ms, synchronous) in `store.ts:243-247`, then `MAX_ENTRY_BYTES` refuses
  it and `cursor.ts:124-130` drops the error. Pre-check with
  `jsonBytesOver`. Effort S, low leverage.
- **Registry Docker entry mounts `:ro` without `--read-only`**
  (`server.json` OCI package, `-v {host_dir}:/workspace:ro`). The write
  tools are advertised and every call fails with EROFS; the docs pair `:ro`
  with `--read-only` (`docs/configuration.md:115-116`). Add the flag, or
  drop `:ro`. Effort S; changes what registry Docker users get.
- **Agent docs do not name the plan directories.** `AGENTS.md` /
  `CONTRIBUTING.md` never mention `plans/README.md` (index, rejected and
  backlog lists) or `docs/plan/<date>-<topic>/` (run maps, audit findings
  and their refuted lists). Three or four lines in `AGENTS.md`. Effort S.
- **Direction: HTTP entry in `server.json`.** Both registry packages declare
  only `stdio`; README sells Streamable HTTP. An OCI entry with `--port`,
  `FS_API_KEY` (`isSecret`) and `FS_ALLOWED_HOSTS`. Registry validation
  rules unchecked. S–M.
- **Direction: MCPB `--deny` / `--allow`.** The documented fix for
  "Sensitive file blocked" is `--allow '.env.example'`
  (`docs/configuration.md:329-332`); `mcpb/manifest.json` offers only
  `allowed_directories`. Bundle with the logged MCPB `--read-only` item. S.
- **Direction: all-or-nothing `replace_text`.** Scan and plan within the
  deadline, then write without one, so a timeout never leaves a partial
  refactor. Supersedes plan 066's text line. M; spike first.

From the 2026-10-12 testing & merge-gate audit at `3da494ae` (not selected):

- **[FIXED in `92bdb2a7`, 2.8.0: delete confirmations are bound to sealed
  `dev`/`ino`/`birthtimeMs` identities.]** **Product: a confirmed `delete` also removes a different object swapped
  in during confirmation.** It was reproduced with a scratch test against
  `3da494ae` on Windows. A recursive delete of `d/` is confirmed; while the
  human confirms, `d/` is replaced by a file, or by a different non-empty
  directory. The retry deletes the replacement and reports
  `deleted: true`. The `requestState` seals only the pending **path set**
  (`delete.ts:294-317`, `input-required.ts` `PendingState`), and the retry
  re-plans from scratch. The identity check in `delete.ts:199-219` (and
  `move.ts:210-222`) therefore never compares against what was shown. Its
  comment ("a swap during the confirmation gap … fails closed") is
  inaccurate for the current flow. One option: seal `dev`/`ino`/`birthtimeMs`
  per pending path into the HMAC state and refuse a mismatch on retry.
  Whether a confirmation binds to an object or to a path is the maintainer's
  call. Effort M, risk MED.
- **Cross-transport parity tests.** Most tool tests run on the in-memory
  pair, which serializes nothing and sets no `ctx.transport`. `7abdfe99`
  (the stdio-only read cap regressing HTTP) was caught by review, not by a
  test. A table of about 10 calls run over in-memory, stdio and HTTP,
  legacy and modern, then compared. Effort M.
- **Example clients' checks in CI.** `examples/clients/*/check.ts` run
  nowhere (`examples/AGENTS.md:39-41`). A local run at `3da494ae` on Windows
  reported 3 of 5 failing: `fsq` and `tail` with a libuv assertion
  (`0xC0000409`), and `browser` with `c:\` vs `C:\` in roots. Planning saw
  the same lower-case drive letter in `delete` results for deleted paths but
  not for failures. Triage before wiring anything into CI. Effort M.
- **MCP conformance suite (direction, spike).**
  `@modelcontextprotocol/conformance` (0.1.16; 0.2.0-alpha supports
  `--requirements 2026-07-28`) is a spec-authored oracle with a per-check
  expected-failures baseline. Run it once locally against
  `node dist/index.js --port …` before deciding on a CI job.
- **Weekly SDK canary (direction).** A scheduled job that runs
  `npm i --no-save @modelcontextprotocol/*@latest && npm run check` warns
  before a bump PR without touching the pins
  (`modelcontextprotocol/servers` `sdk-watch.yml` is the model). Effort S.
- **Commit the stress/fuzz harness (direction).** PR #62 / `8855acaf`
  found six high-severity bugs with a sweep that was never committed. Either
  commit it as a `scripts/` tool, or add `fast-check` properties for the two
  classes of user-reported bug: replace_text on astral-plane text (#24) and
  the binary probe at split offsets (#11). One verifier judged path-
  containment properties speculative. Effort M.

From the 2026-09-28 deep audit at `4d751c94` (not selected):

- **Cache `.gitignore` rule sets across walks.** `GitignoreManager.load`
  re-enumerates `**/.gitignore` and re-reads every file on every
  `globEntries` call with `skipIgnored` (`glob.ts:83-104`, `:408-411`); a
  `find_files` + `search_text` + `replace_text` + `list` sequence scans the
  ignore tree four times. Key a short-TTL cache on `(cwd, ignoreCeiling)`
  with per-file `mtime`/`size` validation. Plan 044 makes a load slightly
  dearer, which is the argument for this. Effort M, risk MED (stale rules
  change what a walk exposes).
- **`FS_TRUST_PROXY` rate-limit keying and `index.ts` shutdown sequencing
  have no end-to-end tests** (grep: zero hits for `FS_TRUST_PROXY`,
  `SIGTERM`, `shutdown` in `__tests__/`). A trust-proxy test needs a real
  request with `X-Forwarded-For` through `bootHttpTest`; a shutdown test
  needs a child process (Windows has no signals — use stdin EOF). Effort M.
- **`ResourceStore` byte-budget/TTL eviction has no direct test**
  (`store.ts:94-110`; `TC-FUNC-058..060A` cover put/get only) and the class
  takes no `now` injection unlike `PageSnapshotStore`. Effort S.
- **Public `./transport` export is undocumented** (`package.json`
  `exports`, `src/transport.ts`: `startServer`, `startHttpServer`). One
  README "Programmatic API" section. Effort S.
- **Path completion lists in-root symlink names the guard would refuse on
  read** (`path-completer.ts:133-137` filters entries by `isSensitive` on
  the requested path only). Name-only leak; `resources/read` still
  refuses. Effort S, low value.
- **`CONTRIBUTING.md` lacks single-test filtering and Windows notes**
  (`CONTRIBUTING.md:26-31`; the filter syntax lives only in `AGENTS.md`).
  Effort S.

Deferred while executing 018–040 (2026-09-26):

- **Ranged batch `read` still budgeted by file size** (the half of plan 022
  that was reverted). `read { paths: [big.log], head: 3 }` skips a file over
  512 KiB, while the single-path call works. A correct fix accounts for
  returned bytes while streaming. Skipping the pre-estimate is unsafe:
  ranged reads are capped only per file (10 MiB).
- **Grant refusal hard-codes `C:` for Windows system dirs** (plan 032). A
  Windows install on another drive is not covered; derive the list from
  `%SystemRoot%` / `%ProgramFiles%` / `%ProgramData%`.
- **No direct test pins `atomicWriteFile` keeping a 0600 mode** (plan 034
  assumed one existed; the only 0600 test covers `appendFile`). One
  POSIX-only test in `core-fs.test.ts` would close it.

From the 2026-09-26 full audit at `8c2a82cd` (not selected; effort M).
**Four of the five became plans on 2026-09-28** — directory move/copy
(042), ancestor `.gitignore` (044), `search_text` at 4.8 s (045),
`isSafeGlobSyntax` and `..` (043). Still open:

- **Linux recursive directory watch walks and inotify-watches every file**
  (Node's JS recursive watcher; `watcher-registry.ts:200`). Subscribing to a
  root directory in Docker can exhaust `max_user_watches`. Fix: non-recursive
  directory watches on Linux, or an `ignore` built from
  `DEFAULT_EXCLUDED_NAMES`.

Direction (options for the maintainer, evidence in the audit):

- **Persistent grants** (2026-09-28). Grants and the `requestState` HMAC key
  die with the process (`input-required.ts:63-89`; `instructions.ts:53-66`
  calls accepted roots session-additive). Repeat use on one project
  re-prompts every restart; remote hosts cannot preserve trusted-workspace
  policy. A `--grants-file` keyed by canonical root, opt-in, 0600, with
  expiry/revocation, separate for stdio vs authenticated HTTP. Widens
  authorization lifetime — threat model before code. L; spike first.
- **Directory-level subscriptions / a listing resource** (2026-09-28). The
  watcher registry and `list` exist but a client cannot watch a tree without
  first knowing file names (`resources.ts:83-132`, `:250-295` are per-URI).
  Event bursts, rename identity and the Linux inotify cost (above) are the
  open questions. L; spike first.
- **Copilot CLI / Antigravity CLI plugin distribution** is in flight, not a
  plan here: `docs/plan/2026-09-28-copilot-agy-plugin/*.run.md` stopped at
  step 6a; 2.6.3 shipped the `${NAME}` placeholder it needed; the remaining
  steps live in the marketplace repository and need the maintainer
  interactively.
- MCPB bundle cannot enable `--read-only` (no env mirror, `cli.ts:96`;
  `mcpb/manifest.json` offers only `allowed_directories`). S–M.
- Overwrite confirmations show no diffstat (`create.ts:150-153`). S–M.
- Multi-file `patch` is marked deferred in code (`patch.ts:82-84`) while
  `replace_text` dry runs emit exactly that format. L; spike first.

Earlier leads that this batch absorbed: subscriptions after atomic replace
(035), batch `read` budget (022), path schema (018), release-only paths
(037), `$`-expansion and EXDEV tests (019), diff before budget (020), ADR
anchors (039).

From the SDK re-audit at `1eb94134`:

- Dead code, three spots:
  - A second, never-firing 5 s timeout at `src/tools/list.ts:283` (the tool's
    `timeoutMs` already bounds `ctx.signal`).
  - A duplicate `validateExistingPath` at `src/resources.ts:220` (`readRaw`
    validates again at `src/core/fs.ts:365`).
  - Notifier branches that cannot run in production at
    `src/server.ts:151-154` and `src/resources.ts:497-500`.
- Stale docs:
  - ADR-002 anchors (`resources.ts:452-559` is now 475-547; `define.ts:159-162`
    is now 166-177; `README.md:294` is now 312-314).
  - ADR-003 anchors (`http.ts:312` is now 316) and its "per session/IP"
    limiter wording (per-IP only).
  - Wrong comments at `src/tools/list.ts:340-343`, `src/transport/http.ts:240-243`,
    `src/server.ts:78-81`, `src/core/schema.ts:10-12`,
    `src/core/errors.ts:173-178` and `src/transport/stdio.ts:103`.
  - `README.md:291,302` still refer to `src/transport.ts` as the transport
    module.
- Elicitation answer readers accept values that were never offered
  (`src/core/input-required.ts:116-118`). Validating with the SDK's
  `acceptedContent(schema)` against the offered `z.enum` would put the check
  in one place instead of four call sites. Every current caller is correct;
  this is hardening.
- Cosmetic reuse of SDK types:
  - `ProtocolEra` / `CacheScope` for the hand-written unions at
    `src/server.ts:64,91` and `src/resources.ts:66,72`.
  - `NodeMcpRequestHandler` for `src/transport/http.ts:79`.
  - `satisfies OAuthProtectedResourceMetadata` on the metadata body at
    `src/transport/http.ts:128-132`.
