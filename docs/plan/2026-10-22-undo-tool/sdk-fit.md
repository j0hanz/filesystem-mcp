# SDK fit 2026-10-22: the `undo` tool against the MCP TypeScript SDK, Node stdlib and repo helpers

Reviewed at `origin/main` 730e0038 (merge of PR #112). Installed SDK:
`@modelcontextprotocol/server` 2.3.1, `core` 2.3.1, `node` 2.1.1, `express`
2.0.2. Runtime checks ran on Node 24.15.0, win32.

**Verdict: trim.** The SDK makes no undo code unnecessary. Every SDK feature
that fits undo is already in use. Eight repo or stdlib cuts remove about 50
of the 1,229 source lines PR #112 added. A redesign around SDK features
has nothing to build on: the installed SDK ships no journal, snapshot,
restore or preview code, the 2026-07-28 revision has no sessions, and v2
removed the task store.

## Contents

- [Answers to the three questions](#answers-to-the-three-questions)
- [Findings, ranked by lines removable](#findings-ranked-by-lines-removable)
- [Side findings](#side-findings)
- [Refuted candidates](#refuted-candidates)
- [Resources](#resources)
- [Verdict](#verdict)
- [Method](#method)

## Answers to the three questions

**1. Resources.** Tool-only is correct. Undo history is live state that the
model acts on, and the SDK docs make resources application-controlled
read-only data. See [Resources](#resources).

**2. SDK counterparts per mechanism.** None of them replaces undo code.
"Already used" means undo depends on that SDK feature today.

| Mechanism | Undo code | Closest SDK feature (dist file:line) | Replaces undo code? |
| :-- | :-- | :-- | :-- |
| Journal: bounded history, TTL, ids | `src/core/undo.ts:80-240` | None. `TaskStore`, `InMemoryTaskStore` and `registerToolTask` are docs-only (the migration guide lists them as removed). Task wire types have "no SDK runtime" (`createMcpHandler-D4NN8WsG.d.mts:722-726`). `EventStore` (`index.d.mts:468`) replays SSE messages | No |
| Per-session scoping | `src/server.ts:182,212-230`, `src/transport/http.ts:284,363`, `src/tools/undo.ts:53-60` | `BaseContext.sessionId` (`createMcpHandler-D4NN8WsG.d.mts:2115`) is undefined on both transports used here. `onsessionclosed` (`index.d.mts:520`) exists only on the sessionful 2025-era transport. `serveStdio` (`stdio.d.mts:61`) and `Protocol.onclose` (`createMcpHandler-D4NN8WsG.d.mts:2304`) are already used | No, already uses what fits |
| Capture before write | `src/core/fs.ts:241-251,271-324,341-417,447-528,576-616`, `src/tools/define.ts:557-572` | None. A grep for undo, rollback, revert, journal, snapshot, transaction and checkpoint across the four dist trees finds nothing | No |
| Restore | `src/core/undo.ts:485-770` | None | No |
| Preview (`dryRun`) | `simulated` and `relocations` in `src/core/undo.ts:507-570`, `src/tools/undo.ts:85-88` | `inputRequired` (`createMcpHandler-D4NN8WsG.d.mts:1486`) asks for a confirmation and computes no preview. `outputSchema` (`:3376`) is forbidden here by `src/tools/define.ts:543-548` | No |
| Cancellation | `src/core/undo.ts:479,585-590`, `src/tools/undo.ts:90,102` | `ctx.mcpReq.signal` (`createMcpHandler-D4NN8WsG.d.mts:2183`) is already the source (`src/tools/define.ts:188`). The SDK drops an aborted response but does not stop the handler, so undo's own checks stay | No, already used |
| Size limits | `src/core/undo.ts:80-98,246-323`, `src/core/util.ts:126-129` | `maxRequestBodySize` (`:3994`), `maxToolInputElements` (`:3230`) and `STDIO_DEFAULT_MAX_BUFFER_SIZE` (`:2701`) cap wire input, not memory held for undo | No |
| Concurrency: live cap, byte pool, locks | `src/core/undo.ts:83-84,133-161,242-323`, `src/core/fs.ts:178-196` | None. The SDK has no semaphore or lock | No |
| Move tracking by file identity | `src/core/undo.ts:21-68,103-104,200-229` | None | No |
| Undo id on results, result shape | `src/tools/define.ts:327-347`, `src/tools/undo.ts:25-29,108-123` | `CallToolResult.isError` (`:509`) and `_meta` are already used | No, already used |
| Annotations | `src/tools/define.ts:525-529` | `ToolAnnotations` (`:503`, schema at `core/dist/auth-Anm-lwWi.d.mts:2322`) already publishes `destructiveHint: true` for undo | No, already used |
| Progress | `src/tools/undo.ts:40-43` | `ctx.mcpReq.notify` (`:2204`) is already used through `ProgressSession` (`src/tools/define.ts:250-256`) | No, already used |

All dist paths are under `node_modules/@modelcontextprotocol/server/dist/`
unless another package is named.

**3. Stdlib and repo duplicates.** Eight, listed under
[Findings](#findings-ranked-by-lines-removable). Two more candidates looked
like duplicates and failed verification; they are under
[Refuted candidates](#refuted-candidates).

## Findings, ranked by lines removable

Line counts are net source lines. Verdicts come from an adversarial pass
(see [Method](#method)). CONFIRMED means a skeptic tried to refute the
finding and failed, and the change ran clean in a scratch copy or a one-line
probe. PLAUSIBLE means the mechanism holds but part of the change was not run.

| # | Finding | Replaced by | Net lines | Verdict |
| :-- | :-- | :-- | :-- | :-- |
| 1 | Live-capture slot cap | Shared byte pool already in `undo.ts` | about -21 | PLAUSIBLE |
| 2 | Three copies of the file-identity helpers | `identityOf`, `sameIdentity` | about -11 | CONFIRMED |
| 3 | Hand-counted `isError` in the tool | `summarize`, `isTotalFailure` | about -5 | CONFIRMED |
| 4 | `UndoJournal.list()` | `newest(Infinity)` | about -5 | CONFIRMED |
| 5 | Junction target resolve in `symlink` | Node `fs.promises.symlink` | about -5 | CONFIRMED |
| 6 | `steps` schema | `PositiveInt` | about -3 | PLAUSIBLE |
| 7 | Id alphabet loop | `randomInt(...).toString(36)` | about -2 | CONFIRMED |
| 8 | Raw path-prefix checks | `isPathInsideDirectory`, `IS_WINDOWS` | +1 | CONFIRMED |

### 1. The live-capture slot cap is redundant once `abandon` keeps its charge

- **Cut.** [`src/core/undo.ts:83-84`](../../../src/core/undo.ts#L83-L84)
  (`MAX_LIVE_CAPTURES`), `:133` (`#live`), the branch in `:137-151`, the slot
  release in `:157-160`, `holdsSlot` at `:249-250`, and the comment at
  [`src/tools/define.ts:559-561`](../../../src/tools/define.ts#L559-L561).
  In `abandon()` at
  [`src/core/undo.ts:306`](../../../src/core/undo.ts#L306), release only the
  bytes of the records it drops, and keep reservations charged until
  `endCapture()`. (As shipped. The first version kept the whole charge; the
  final branch review found that this starved concurrent calls.)
- **Replaced by.** The shared `LivePool` that commit 3b5d5a0c added
  (`undo.ts:134-135,242-244,262-270`). `reserve()` (`:289-299`) and `push()`
  (`:309-322`) already charge every capture against one budget, and
  `endCapture()` (`:153-156`) releases the charge in `execute()`'s `finally`
  (`define.ts:514`).
- **Why both cuts go together.** Commit ef3c87e2 added the cap as the memory
  bound ("Capture memory is now bounded: live-capture cap plus per-record
  overhead"). The pool came later and bounds what is charged. But `abandon()`
  returns the whole charge (`undo.ts:302-307` calls `release()` at
  `:278-282`) while a parallel batch item may still be inside `readSaved()`
  (`src/core/fs.ts:354-355`). The verifier reproduced 8 live captures with
  30 MiB reads pending each, 240 MiB against a 32 MiB budget. Today the cap is
  what limits that to 8 times the budget. If `abandon()` keeps the charge
  until `endCapture()`, in-flight bytes stay under the budget and the cap
  bounds nothing.
- **Kept.** Captured bytes stay under `maxBytes` in flight plus `maxBytes` in
  the journal. This is stricter than today.
- **Lost.** The ninth concurrent mutating call is no longer refused with
  `not undoable: too many concurrent calls to keep for undo`. An abandoned
  call holds the bytes of reads still in flight until it finishes, so a
  concurrent call can hit `too large to keep for undo` while those reads
  run. This also removes
  a latent slot leak if anything throws between `beginCapture()` and
  `execute()` (`define.ts:562-572`).
- **Tests.** Delete `__tests__/undo.test.ts:111-124`. The verifier removed the
  cap in a scratch copy and ran the full suite: 929 tests, 902 pass, 0 fail,
  27 skipped. The `abandon()` change was not run.

### 2. File-identity helpers exist three times

- **Cut.** The `same` closure at
  [`src/core/undo.ts:692-695`](../../../src/core/undo.ts#L692-L695) repeats
  `sameIdentity` from `:67-68`, which the same function already calls at
  `:747`. [`src/core/fs.ts:315-318`](../../../src/core/fs.ts#L315-L318)
  repeats `identityOf`, which `fs.ts` imports at `:48` and already uses at
  `:588`. [`src/tools/delete.ts:163-167`](../../../src/tools/delete.ts#L163-L167)
  declares the same `Identity` type and `sameIdentity`.
- **Replaced by.** `identityOf` and `sameIdentity` in `src/core/undo.ts:56-68`.
  Export `sameIdentity` and import it in `delete.ts`. A tools-to-core import
  is the allowed direction.
- **Kept.** All behaviour. Every site compares `dev`, `ino` and `birthtimeMs`
  with `===`.
- **Lost.** Nothing.
- **Tests.** No test pins these spellings. In a scratch copy: `tsc` clean,
  897 pass, 0 fail. Two manifest suites failed only because the copy lacked
  `mcpb/`.
- **Optional.** `delete.ts:368-369` can spread `identityOf(stats)`.
  `src/core/input-required.ts:40-46` could extend `FileIdentity`, but that
  ties the signed confirmation state to the undo module for 2 lines; skip it.

### 3. The undo tool counts its own total failure

- **Cut.** [`src/tools/undo.ts:29`](../../../src/tools/undo.ts#L29),
  `:83-84`, `:104-105`, and the expression at `:121`.
- **Replaced by.** `isError: isTotalFailure(summarize(stepResults.flatMap((s) => s.results)))`,
  from [`src/tools/batch.ts:60-78`](../../../src/tools/batch.ts#L60-L78).
  `define.ts:108-113` documents that batch tools set `isError` this way, and
  `undo-tool.plan.md:83-85` intended the tool to use `summarize`.
- **Kept.** The predicate is identical: at least one result, and every
  result has an `error`.
- **Lost.** Nothing.
- **Tests.** `__tests__/undo.test.ts` ran 59 pass, 0 fail in a scratch copy.
  The `isError` assertions at `:1091,1145,1162,1175,1229,1245` pass unchanged.

### 4. `UndoJournal.list()` is `newest()` without the slice

- **Cut.** [`src/core/undo.ts:231-234`](../../../src/core/undo.ts#L231-L234).
- **Replaced by.** `newest(Infinity)` (`:185-188`). Both prune first and
  return newest first.
- **Kept.** All behaviour.
- **Lost.** The name `list()`. `MAX_ENTRIES` is not exported, so callers pass
  `Infinity`.
- **Tests.** Rewrite one source call site (`src/tools/undo.ts:71`) and six
  test call sites (`__tests__/undo.test.ts:55,65,66,87,99,659`).

### 5. `GuardedFileSystem.symlink` resolves junction targets that Node already resolves

- **Cut.** `type === 'junction' ? resolve(dirname(validPath), target) : target`
  at [`src/core/fs.ts:597`](../../../src/core/fs.ts#L597), plus `dirname` and
  `resolve` from the import at `fs.ts:22` (`:597` is their only use). PR #112
  added this method.
- **Replaced by.** `fsSymlink(target, validPath, type)`. On Windows Node
  resolves a junction target against the link's parent itself:
  `internal/fs/utils` lines 364-368 (`// A relative target is relative to the
  link's parent directory.` `path = pathModule.resolve(linkPath, '..', path);`),
  called from `internal/fs/promises` line 1004. A probe that created a
  junction to `../sub/tgt` with the working directory elsewhere read back the
  absolute target under the link's parent.
- **Kept.** All behaviour. `'junction'` is only recorded on win32
  (`undo.ts:397-402`), and junction targets read back absolute anyway.
- **Lost.** Nothing.
- **Tests.** `__tests__/undo.test.ts:199-227`, `:330-345` and `:435-467` cover
  the symlink paths.

### 6. The `steps` schema re-spells `PositiveInt`

- **Cut.** The `z.number().int().min(1)` chain at
  [`src/tools/undo.ts:15-21`](../../../src/tools/undo.ts#L15-L21).
- **Replaced by.** `PositiveInt.max(20).optional().describe(...)` from
  `src/core/schema.ts:11-13`, as `diff.ts:14` does.
- **Kept.** Accepted values.
- **Lost.** The advertised schema changes from `"minimum": 1` to an exclusive
  minimum of 0, and the error text becomes `Must be > 0`. The contract
  snapshot (`__tests__/contract.test.ts.snapshot:846`) must be regenerated as
  `AGENTS.md` describes. Take this one only alongside another contract change.

### 7. The id generator loops over an alphabet

- **Cut.** `ID_ALPHABET` at
  [`src/core/undo.ts:82`](../../../src/core/undo.ts#L82) and the
  `Array.from(...).join('')` body at `:126-127`.
- **Replaced by.** `randomInt(36 ** 4).toString(36).padStart(4, '0')`. Same
  36 symbols, uniform.
- **Kept.** The 4-character format and the collision loop.
- **Lost.** Nothing.
- **Tests.** 20,000 draws matched `/^[a-z0-9]{4}$/`, the pattern
  `__tests__/undo.test.ts:43-49` pins.

### 8. Two raw path-prefix checks break the repo's containment rule

- **Change.** `out === from || out.startsWith(from + sep)` at
  [`src/core/undo.ts:517`](../../../src/core/undo.ts#L517) and the same test
  at `:527`. Also `process.platform === 'win32'` at `:398`.
- **Replaced by.** `isPathInsideDirectory` (`src/core/path-utils.ts:274-286`)
  and `IS_WINDOWS` (`path-utils.ts:64`). `path-utils.ts:170-172` says callers
  "must use isSamePath / isPathInsideDirectory for all equality and
  containment checks", because those helpers fold case. These are the only
  two raw `+ sep` containment checks in `src`.
- **Kept.** Behaviour on Linux. Real restores, because `relocations` is only
  filled during a dry run (`undo.ts:751`).
- **Changed.** On win32 and darwin the checks fold case. The verification
  pass reproduced a preview error after a case-only folder rename (write a
  file in `d`, rename `d` to `D`, rename `D` to `X`, dry-run all three), and
  this change made that case pass. Planning later traced the error to side
  finding 3, which breaks the same sequence with no case change at all. Once
  side finding 3 is fixed the sequence passes without case folding, so this
  change is convention only.
- **Not fixed.** `simulated` is still keyed by raw strings, so other dry-run
  previews after a case-only rename can still differ from the real run.
- **Tests.** No new test. The existing dry-run tests must stay green.

## Side findings

The verification pass found these defects. They are outside the question
asked, so this report does not rank them.

| # | Severity | Where | Defect | Status |
| :-- | :-- | :-- | :-- | :-- |
| 1 | Minor | `src/core/undo.ts:302-307` | `abandon()` releases reservations for reads still in flight, so the pool bounds charged bytes, not held bytes. Finding 1 fixes it | Reproduced |
| 2 | Minor | `src/core/undo.ts:739` | A dry run walks `record.to`, not `disk(record.to)` as the probe at `:706` does. After a parent folder moved, the preview reports `Undo refused` (ACCESS_DENIED) for a nested folder move that the real undo restores | Reproduced: move `p/q` to `p/r`, move `p` to `s`, dry-run both |
| 3 | Minor | `src/core/undo.ts:696-751` | A dry run records a relocation only when it reads the `to` folder from disk (`toIsRealDir`), not when the simulation already put a folder there (`toKnown === 'dir'`). A folder moved twice (`a` to `b`, then `b` to `c`) previews an edit inside `a` as SKIPPED while the real undo restores it | Reproduced, with and without a case change |
| 4 | Minor | `src/tools/move.ts:521-551` | `globEntries` cannot report an unreadable subtree. Node's `fs.glob` maps every `readdir` error to an empty listing (`internal/fs/glob` line 148, `PromisePrototypeThen(readdir(...), null, () => [])`), so "could not be fully inspected" never fires for one. A missing `cwd` yields 0 entries | Missing `cwd` reproduced; EACCES not reproduced |

## Refuted candidates

Checked and rejected, so nobody proposes them again.

### SDK

| Candidate | Where | Why it does not fit |
| :-- | :-- | :-- |
| Tasks as the journal or for long restores | `createMcpHandler-D4NN8WsG.d.mts:722-726`; codec note `:1173` | Wire types only, with "no SDK runtime". The 2026 codec deletes `capabilities.tasks`. `TaskStore`, `InMemoryTaskStore` and `registerToolTask` are docs-only; the v2 migration guide lists them as removed |
| `ctx.sessionId` for per-session journals | `createMcpHandler-D4NN8WsG.d.mts:2115`; `Transport.sessionId` `:1977` | A runtime probe read it as undefined on `serveStdio`, on modern HTTP and on legacy stateless HTTP, even when the client sent `mcp-session-id`. The docs say the 2026-07-28 revision "is per-request and has no `Mcp-Session-Id`" (`serving/sessions-state-scaling.md` line 7) |
| `onsessionclosed`, `sessionIdGenerator`, sessionful `NodeStreamableHTTPServerTransport` | `index.d.mts:501,509,520`; `node/dist/index.d.mts:118` | Serves only 2025-era clients, and `docs/adr/003-http-serves-2025-era-clients-statelessly.md:65-72` rejects sessionful HTTP |
| `ctx.http.authInfo` to scope per client | `createMcpHandler-D4NN8WsG.d.mts:2213`; `requireBearerAuth` `express/dist/index.d.mts:161` | The repo's bearer check sets `clientId: 'api-key'` for every caller (`src/transport/http-policy.ts:283-296`), and stdio has no `authInfo`. It cannot tell callers apart |
| `EventStore` | `index.d.mts:468` | Replays dropped SSE messages. Holds no file state |
| `ServerEventBus`, `ServerNotifier` | `createMcpHandler-D4NN8WsG.d.mts:3814,3850` | Carries list-changed and resource-updated events only |
| `requestState`, `createRequestStateCodec` | `createMcpHandler-D4NN8WsG.d.mts:2179`; `index.d.mts:460` | Lives for one `input_required` exchange, travels through the client, and is "signed, not encrypted". It cannot carry up to 1 GiB of saved bytes between calls |
| `inputRequired`, `elicitInput` to replace `dryRun` | `createMcpHandler-D4NN8WsG.d.mts:1486,2238` | Asks the user to confirm and computes nothing, so the simulation stays. `elicitInput` throws on 2026-era requests. Undo already refuses to overwrite changed files by hash |
| `outputSchema`, `structuredContent` | `createMcpHandler-D4NN8WsG.d.mts:3376` | The repo forbids `outputSchema` (`src/tools/define.ts:543-548`, TOOL-SURFACE-001). Adding it adds lines |
| `ToolAnnotations` | `createMcpHandler-D4NN8WsG.d.mts:503` | Already published. The docs say annotations "never change how the SDK runs the tool" (`servers/tools.md` line 209) |
| `ctx.mcpReq.signal` to replace undo's abort checks | `createMcpHandler-D4NN8WsG.d.mts:2183` | Already the source. The SDK only suppresses the aborted response, so `restoreEntry` still has to stop between records and return the rest (pinned by `__tests__/undo.test.ts:777-789`) |
| Size options | `createMcpHandler-D4NN8WsG.d.mts:2701,3230,3994`; `index.d.mts:568` | Cap wire input. Undo's budget caps memory |
| Resources for history | `createMcpHandler-D4NN8WsG.d.mts:3334,3495,3215` | See [Resources](#resources) |
| `listRoots`, `Root` to confine restores | `createMcpHandler-D4NN8WsG.d.mts:3202` | Deprecated under SEP-2577. `PathGuard` already confines every restore path |
| A vendor `undo/*` method via `setRequestHandler` | `createMcpHandler-D4NN8WsG.d.mts:2541` | Models call tools, not custom methods |
| `loadSkills`, Hono and Fastify adapters, `SSEServerTransport` | docs only | Not installed, and unrelated to undo |

### Stdlib and repo

| Candidate | Where | Why it does not fit |
| :-- | :-- | :-- |
| Reuse `assertTreeHasNoProtectedEntries` for `assertTreeKeepsPolicy` | `src/tools/move.ts:504-559` vs `src/core/undo.ts:434-463` | The rule is the same, but the move helper walks with `globEntries`, which cannot see an unreadable subtree (see [Side findings](#side-findings)). Undo's `readdir({recursive: true})` fails closed as `undo.ts:438` promises. The swap would save about 26 lines and make the check fail open |
| Derive the `mkdir -p` chain from `fs.mkdir`'s return value | `src/core/undo.ts:325-353`, `src/core/fs.ts:241-251` | Works and saves about 18 lines in a scratch copy. On win32 Node returns `\\?\C:\...` or `\\?\UNC\...` (measured), so the chain then depends on stripping that prefix. If the strings ever diverge, undo removes a folder the call did not create, silently. It narrows the probe-then-create race (a shared parent was still over-claimed in 198 of 400 concurrent trials). `undo-tool.plan.md:528-531` already rejected it |
| `TtlLru` for the journal | `src/core/store.ts:15-86` | Not exported. `get()` moves an entry to newest (`:46-47`), and weight is fixed at `set()` while `replaceRecords` shrinks entries. The journal is a stack. `undo-tool.plan.md:51-57` decided this |
| `throwIfNoEntry: false` for the repeated "lstat or undefined" pattern | `src/core/undo.ts:340,369,548,558,706,731`; `src/core/fs.ts:279` | `fs.promises.lstat` ignores the option and throws ENOENT (run). A new local helper would save about 15 lines; no existing helper does the job |
| `randomUUID` ids | `src/core/store.ts:182` | The 4-character id is part of the result text, and `__tests__/undo.test.ts:43-49` pins it |
| `withAbort` | `src/core/concurrency.ts:207` | Throws on abort. Undo must return the records it did not process |
| `stream/promises.pipeline` for `hashFile` | `src/core/undo.ts:470-483` | Saves about 2 lines, and abort then surfaces as `AbortError` with a cause instead of the reason |
| `crypto.hash` for `sha256Hex` | `src/core/util.ts:75-76` | Saves one line, and is not undo code |
| A `/$/m` regex for `#insertSuffix` | `src/tools/define.ts:343-347` | Saves 4 lines with a regex trick and moves the suffix on CRLF text. The 3-line method is clearer |
| `Map.groupBy` for the rename index | `src/core/undo.ts:206-213` | Saves about 2 lines. `#track` is still needed for re-keying |
| `fs.cp` to a staging directory instead of in-memory snapshots | `src/core/undo.ts:362-432` | A redesign that moves the budget to disk. The sensitive-path gate, the non-regular refusal and junction typing still need the walk |
| `readdir({recursive: true})` for `snapshotTree` | `src/core/undo.ts:362-432` | Loses post-order pushes and the per-entry charge that stops an oversized tree early |
| `destExists` for `absent()` | `src/core/fs.ts:850` | Uses `stat` and returns false on other errors, which fails open |

## Resources

**Tool-only is the right design.** The undo files register no resource, and
they should not.

1. **The model is the consumer.** The SDK docs say resources are read-only
   data that "the client decides what to read: resources are
   application-controlled, where tools are model-controlled"
   (`https://ts.sdk.modelcontextprotocol.io/v2/servers/resources.md`, line 3).
   The model chooses which call to revert. It already gets the id on every
   mutating result (`src/tools/define.ts:327-341`), and `undo {dryRun: true}`
   lists the history with per-path outcomes (`src/tools/undo.ts:70-71,87-95`).
2. **The history is live state, not a document.** Entries expire after 30
   minutes (`src/core/undo.ts:81`). A partial restore rewrites them in place
   (`replaceRecords` at `:190-198`, `reidentify` at `:205-222`). A preview is
   computed against current disk. `ResourceStore` (`src/core/store.ts:122-221`)
   holds 60-second immutable text snapshots, so it cannot hold this.
3. **A resource costs code and gains nothing.** It needs list and read
   callbacks over `UndoJournal`, a change hook the journal does not have,
   `resources/list_changed` on every mutating call, a `--read-only` gate, an
   `FS_MAX_UNDO_BYTES=0` gate and a contract snapshot change. The verifier
   estimated 35 to 50 lines for no new capability.
4. **There is no pending state.** An undo finishes in one call. No
   `input_required` round and no in-flight transaction exist to observe.

Privacy does not decide either way. Over HTTP the journal is shared by the
whole endpoint (`src/transport/http.ts:284`). `resources/list` would show
every caller's history, but `undo {dryRun: true}` with no id already does
(`src/tools/undo.ts:55-60` allows it).

The strongest argument for a resource: `dryRun` lives on a tool annotated
`readOnlyHint: false` (`src/tools/undo.ts:37`), so a host that auto-approves
read-only tools cannot auto-approve a preview. Revisit if a host asks for an
undo-history panel. Then add one fixed-URI resource that lists ids, tools and
paths, never saved bytes.

## Verdict

**Trim.** Make these cuts in this order, about 50 lines in total:

1. Remove the live-capture cap, and let `abandon()` keep its charge until
   `endCapture()` (finding 1).
2. Collapse the identity helpers into `identityOf` and `sameIdentity`
   (finding 2).
3. Use `summarize` and `isTotalFailure` in the undo tool (finding 3).
4. Drop `UndoJournal.list()` (finding 4).
5. Drop the manual junction resolve in `GuardedFileSystem.symlink`
   (finding 5).
6. Generate ids with `toString(36)` (finding 7).
7. Switch the two prefix checks to `isPathInsideDirectory` (finding 8).
8. Fix side findings 2 and 3, the two dry-run relocation defects in
   `restoreEntry`'s rename branch. They are bugs, not trims, but they sit
   in the code the trims touch.
9. Defer the `PositiveInt` swap until the next contract change (finding 6).

Do not redesign. The SDK features undo can use, it already uses: one
`serveStdio` instance per connection with `Protocol.onclose` cleanup,
`ctx.mcpReq.signal`, progress through `ctx.mcpReq.notify`,
`ToolAnnotations`, and `isError` with `_meta`. The rest of undo (journal,
capture, restore, preview, budget, move tracking) has no SDK counterpart.

These tests must stay green through the trims. They cover the behaviour
named in the task:

| Behaviour | Tests in `__tests__/undo.test.ts` |
| :-- | :-- |
| Capture safety and size limits | `:149-369`, `:724-732`, `:805-819` |
| Moved files and folders | `:347-369`, `:521-555`, `:607-723`, `:734-776`, `:820-835` |
| Recreated directories and links | `:199-227`, `:330-345`, `:435-467`, `:734-756`, `:791-803` |
| Cancellation | `:777-789` |
| Tool contract and transports | `:838-945`, `:946-1299`, plus `__tests__/contract.test.ts` |

## Method

1. **Inventories.** Four haiku agents listed every export of `server`
   (470 rows), `core` (218), `node` (28) and `express` (14) from the dist
   `.d.mts` files. A sonnet agent read `llms.txt` and the 49 pages it links,
   and marked each stateful-tool feature installed or docs-only. A sonnet
   agent split undo into mechanisms with line ranges and mapped the tests.
2. **Comparison.** I opened every `.d.mts` line cited above and pulled the
   docs quotes from the raw `.md` pages.
3. **Adversarial pass.** One sonnet skeptic per candidate tried to refute it;
   several applied the change in a scratch copy and ran the suite. A
   completeness critic searched for missed duplicates and found findings 5,
   6 and 7. The skeptics refuted the `move.ts` reuse and downgraded the
   `mkdir` return-value idea.
4. **Probes.** `fs.promises.mkdir` return values, `throwIfNoEntry` on
   promise `lstat`, junction target resolution, `globEntries` on a missing
   directory, the id pattern, and `ctx.sessionId` on all three serving paths.

No source file was changed. Scratch copies made during verification were
deleted.
