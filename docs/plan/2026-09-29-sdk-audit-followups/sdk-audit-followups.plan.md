# Plan: Honor resource cancellation, elicitation modes, progress rounds, and browser recovery headers

> **Executor rules**: work the steps in order. Work each behavior change
> test-first: add the regression, observe its intended failure, then make the
> smallest production change. Run every Verify command and confirm its expected
> result before moving on. On any STOP condition, report the condition, step,
> and evidence. This document authorizes no dependency changes or commits.
>
> **Written against** commit `bfe5ac37`, 2026-09-29.
> **Drift check (run first)**:
> `git diff --stat bfe5ac37..HEAD -- src\resources.ts src\core\fs.ts src\core\input-required.ts src\tools\progress.ts src\transport\http-policy.ts __tests__\core-fs.test.ts __tests__\resources.test.ts __tests__\input-required.test.ts __tests__\progress.test.ts __tests__\http-policy.test.ts __tests__\http-server.test.ts CHANGELOG.md`
>
> Its file list narrows the excerpt match: compare [Current state](#current-state)
> against live code for every flagged file. Also record `git status --short` and
> inspect uncommitted changes in those files. An unexplained mismatch is a
> [STOP](#stop) condition; never revert another contributor's changes.

## Goal

Fix the four previously unrecorded SDK-integration findings from the 2026-09-29
audit: file-resource reads ignore cancellation, URL-only clients pass a
form-elicitation gate, legacy confirmation retries restart progress, and browser
clients cannot read recovery headers already present in HTTP responses.
These are independent fixes, not a new feature or another SDK migration.
Requirements covered: none, this is a fix; no separate spec exists.

**Scope assumption:** the unqualified write-plan request following the four-item
audit selects all four findings. Each of steps 1-4 is an independently shippable
vertical slice, ordered by the audit's value/effort ranking. Step 5 depends on all
four. Planning does not implement any of them.

## Current state

### Baseline and installed SDK

The [manifest](../../../package.json#L66-L85) pins server/client 2.2.0, Node adapter
2.1.0, and Express adapter 2.0.1. The server runs on Node >=24 with strict
TypeScript and Node's built-in test runner; [scripts](../../../package.json#L29-L39)
own the check commands below. Planning used Node 24.15.0.

The entire [SDK v2 reference](https://ts.sdk.modelcontextprotocol.io/v2/llms-full.txt)
was read before comparison. The relevant APIs are installed, not docs-only:

- The request's cancellation signal is declared in
  [the installed server declarations](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CfX6zgs1.d.mts#L2179-L2182).
- Form and URL capabilities are distinct in
  [the installed core declarations](../../../node_modules/@modelcontextprotocol/core/dist/auth-Anm-lwWi.d.mts#L573-L578).
- The server's legacy input-required shim and its defaults are declared in
  [the installed server declarations](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CfX6zgs1.d.mts#L2863-L2888).
- The challenge metadata URL is already supported by
  [the installed bearer-auth declarations](../../../node_modules/@modelcontextprotocol/server/dist/index.d.mts#L98-L112).

Content-hashed declaration filenames belong to this exact install. If one no
longer resolves, establish the installed equivalent and compare the contract;
do not upgrade packages to make the link resolve.

### 1. A file resource drops the request signal

[`resources.ts:205-222`](../../../src/resources.ts#L205-L222), inside
[`createFilesystemResource`](../../../src/resources.ts#L166), currently reads:

```ts
    async read(uri, _variables, _ctx: ServerContext) {
```

After decoding the URI and rejecting malformed percent-encoding, it executes:

```ts
      await options.pathGuard.validateExistingPath(rawPath);
      const fs = new GuardedFileSystem(options.pathGuard);
      const readResult = await fs.readRaw(rawPath);
```

[`GuardedFileSystem.readRaw`](../../../src/core/fs.ts#L365-L386) accepts a signal
but does not check it before path validation, and races an uncancellable native
read rather than supplying that read with the signal:

```ts
  async readRaw(
    filePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ content: Buffer; mimeType: string; isBinary: boolean }> {
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    const stats = await withAbort(fsStat(validPath), options?.signal);
```

```ts
    const content = await withAbort(fsReadFile(validPath), options?.signal);
```

The audit called the file-resource contract with an already-aborted signal and
received a complete text result. The SDK's
[cancellation guidance](https://ts.sdk.modelcontextprotocol.io/v2/servers/logging-progress-cancellation.md#pass-the-signal-to-your-own-io)
requires the handler to propagate cancellation into its own I/O.

The current resource-test
[`dummyContext`](../../../__tests__/resources.test.ts#L41) contains only:

```ts
const dummyContext = { sessionId: 'test-session' } as unknown as ServerContext;
```

That fixture must gain a live request signal when the handler begins reading
it; weakening the production contract to accommodate this fake is not a fix.

### 2. The form gate accepts URL-only clients

[`assertCanElicit`](../../../src/core/input-required.ts#L226-L230) currently reads:

```ts
function assertCanElicit(op: PendingOp, capabilities: ClientCapabilities | undefined): void {
  if (capabilities === undefined) return;
  if (capabilities.elicitation !== undefined) return;
  throw new FsError(ErrorCode.INVALID_INPUT, `${op}: ${NO_ELICITATION_HINT[op]}`);
}
```

Every [`buildInputRequired`](../../../src/core/input-required.ts#L143-L162) request
uses form elicitation. A modern client declaring only `{ elicitation: { url: {} } }`
passed this gate and its tool call rejected with protocol code `-32021`, while a
client declaring no elicitation received the intended actionable tool error.

SDK [elicitation modes](https://ts.sdk.modelcontextprotocol.io/v2/servers/elicitation.md#require-the-elicitation-capability)
are separate capabilities. Preserve the
[backward-compatible empty declaration](https://ts.sdk.modelcontextprotocol.io/v2/clients/server-requests.md#declare-what-your-client-can-do):
`elicitation: {}` means form support. Unknown overall capabilities remain
"cannot tell", not a positive refusal.

### 3. A constructor emits progress before a round knows whether it can run

[`ToolExecutor`](../../../src/tools/define.ts#L205-L250) constructs a new
[`ProgressSession`](../../../src/tools/progress.ts#L30-L49) on every handler entry:

```ts
    this.#startTime = Date.now();
    this.#lastSentMs = this.#startTime - this.#rateLimitMs;
    // Synthetic start tick: the wire sees 0 at session creation.
    this.#emit('tick', 0, undefined, this.#label);
```

[`execute`](../../../src/tools/define.ts#L353-L378) returns early for a grant or
tool-produced input-required round without completing progress. Nevertheless,
the constructor's zero has already gone out. The audit captured **0, 0, 1 with
one progress token** on an actual legacy SDK wire.

The SDK's
[legacy shim contract](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.md#legacy-shim-for-input_required)
says the originating token spans all rounds and must increase. The production
grant/overwrite confirmation paths do not emit work ticks before requesting
input: see the [grant precheck](../../../src/tools/define.ts#L297-L350),
[create planning phase](../../../src/tools/create.ts#L106-L155),
[move planning phase](../../../src/tools/move.ts#L259-L333), and
[delete planning phase](../../../src/tools/delete.ts#L263-L320).

The existing [progress unit tests](../../../__tests__/progress.test.ts#L20-L93)
pin ordinary streams to `[0, 1, 2, 3]`, terminal failure to `[0, 1, 2]`, and
duplicate suppression. Preserve those sequences by delaying, not removing, the
initial zero.

### 4. CORS admits the browser but hides its recovery headers

[`corsMiddleware`](../../../src/transport/http-policy.ts#L342-L361) currently sets:

```ts
    if (origin && isOriginAllowed(origin, allowedOriginHostnames)) {
      res.header('Access-Control-Allow-Origin', origin);
      // Key the response by Origin so a CDN/proxy caching one origin's response
      // cannot replay it for a different origin (cache-poison).
      res.header('Vary', 'Origin');
    }
```

It never sets `Access-Control-Expose-Headers`. The
[bearer gate](../../../src/transport/http-policy.ts#L270-L309) already sends
`WWW-Authenticate`, and the
[rate limiter](../../../src/transport/http-policy.ts#L376-L407) sends `Retry-After`.
Loopback HTTP observations confirmed allowed-origin 401 and 429 responses with
those headers but no exposure header.

The SDK's [authorization guidance](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.md#require-a-bearer-token)
uses the challenge for recovery. Neither header is
[CORS-safelisted](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Expose-Headers),
so scripts cannot read it without explicit exposure. Node's fetch can read it
regardless: a Node integration assertion proves the server's header contract,
not that a real browser was exercised.

### Conventions and settled boundaries

- Use `node:assert/strict`, `node:test`, and temporary roots with guaranteed
  cleanup. Reuse [`createTestRoot`](../../../__tests__/helpers.ts#L37-L40),
  [`makeGuard`](../../../__tests__/helpers.ts#L142-L147),
  [`createTestServer`](../../../__tests__/helpers.ts#L149-L155), and
  [`writeTestFile`](../../../__tests__/helpers.ts#L517-L530); do not modify them.
- Native filesystem interception follows
  [the existing mock/restore pattern](../../../__tests__/core-fs.test.ts#L347-L398):
  intercept the default filesystem-promises export, call `syncBuiltinESMExports`,
  and restore the mock and synchronize exports in `finally`. Do not run tests
  sharing these mocks concurrently.
- Resource behavior follows
  [text and binary contract tests](../../../__tests__/resources.test.ts#L287-L356);
  retain MIME types, bytes, size limits, and path refusals.
- Elicitation units follow
  [`pendingRoundTrip` tests](../../../__tests__/input-required.test.ts#L83-L158);
  modern integration follows
  [`createElicitationClientPair`](../../../__tests__/helpers.ts#L193-L261).
  A legacy pair cannot prove modern `-32021` handling.
- Legacy real-client wiring and scoped environment restoration follow
  [the existing grant test](../../../__tests__/tools.test.ts#L1366-L1425) and
  [`withEnv`](../../../__tests__/helpers.ts#L113-L135). Wire assertions use SDK
  type guards instead of new broad casts.
- HTTP assertions follow
  [the existing CORS mock test](../../../__tests__/http-policy.test.ts#L375-L425)
  and [`bootHttpTest`](../../../__tests__/helpers.ts#L348-L413).
  Reference the existing test credential constant by import; copy no secret
  values into this plan, logs, or new fixtures.
- [ADR-002](../../adr/002-legacy-protocol-paths-sunset.md#decision) says:
  "The three paths stay. They are removed together, in one change" at its dated
  trigger. This is a legacy correctness fix, not that removal.
- [ADR-003](../../adr/003-http-serves-2025-era-clients-statelessly.md#options)
  chooses "`legacy: 'stateless'`" and rejects sessionful legacy HTTP. Do not add
  sessions to test the shim; use a legacy in-memory connection instead.
- Preserve the deliberate
  [text/metadata result policy](../../../src/tools/define.ts#L184-L202) and
  [absence of output schemas](../../../src/tools/define.ts#L393-L405).

## Commands

Run at the repository root in PowerShell. Every command below was exercised
during planning against the baseline; post-fix gates additionally require the
new cases named in [Steps](#steps). Existing platform-specific skips are allowed;
the new cases must pass on Windows and must not be silently skipped.

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Source typecheck | `npm exec --no -- tsc --noEmit -p tsconfig.json` | Exit 0, no diagnostics |
| Test typecheck | `npm run type-check:test` | Exit 0, no diagnostics |
| Resource slice | `npm test -- __tests__\core-fs.test.ts __tests__\resources.test.ts` | Exit 0, zero failures; baseline 71 passed, 1 platform skip |
| Elicitation slice | `npm test -- __tests__\input-required.test.ts` | Exit 0, zero failures; baseline 27 passed |
| Progress slice | `npm test -- __tests__\progress.test.ts __tests__\tools.test.ts` | Exit 0, zero failures; baseline 121 passed, 1 platform skip |
| HTTP slice | `npm test -- __tests__\http-policy.test.ts __tests__\http-server.test.ts` | Exit 0, zero failures; baseline 50 passed |
| Repository gate | `npm run check` | Exit 0: build, test typecheck, lint, formatting, knip, tests |
| Patch whitespace | `git diff --check` | Exit 0, no output |
| Scope inventory | `git status --short` | No new implementation changes outside the allowlist below |

The repository gate builds ignored distribution output before smoke coverage.
Do not install dependencies unless a gate actually fails because one is missing.
Do not run the repository-wide auto-fixer to repair unrelated baseline issues.

## Scope

**In scope - the only implementation files to modify:**

- [`src\resources.ts`](../../../src/resources.ts): forward the resource request signal.
- [`src\core\fs.ts`](../../../src/core/fs.ts): native cancellation in raw reads only.
- [`__tests__\resources.test.ts`](../../../__tests__/resources.test.ts): signal-bearing context and resource regressions.
- [`__tests__\core-fs.test.ts`](../../../__tests__/core-fs.test.ts): raw-read cancellation and native signal interception.
- [`src\core\input-required.ts`](../../../src/core/input-required.ts): form-capability predicate and directly related comments.
- [`__tests__\input-required.test.ts`](../../../__tests__/input-required.test.ts): mode matrix and modern real-client regression.
- [`src\tools\progress.ts`](../../../src/tools/progress.ts): lazy initial notification only.
- [`__tests__\progress.test.ts`](../../../__tests__/progress.test.ts): idle sessions and real legacy round trips.
- [`src\transport\http-policy.ts`](../../../src/transport/http-policy.ts): expose the two recovery headers for allowed origins.
- [`__tests__\http-policy.test.ts`](../../../__tests__/http-policy.test.ts): allowed/disallowed/absent-Origin exposure assertions.
- [`__tests__\http-server.test.ts`](../../../__tests__/http-server.test.ts): real 401/429/normal-response headers.
- [`CHANGELOG.md`](../../../CHANGELOG.md#unreleased): record completed fixes under Unreleased only.

**Files out of scope - leave alone even though they look related:**

- [`src\tools\define.ts`](../../../src/tools/define.ts): keep executor lifetimes, token handling, error funnels, and output policy; lazy initialization belongs to the progress session.
- [`src\core\concurrency.ts`](../../../src/core/concurrency.ts): no global cancellation-helper rewrite; native raw-read cancellation is a local change.
- [`src\core\path.ts`](../../../src/core/path.ts): no grant-policy, containment, or symlink-race redesign.
- [`src\tools\create.ts`](../../../src/tools/create.ts), [`move.ts`](../../../src/tools/move.ts), [`delete.ts`](../../../src/tools/delete.ts), [`edit.ts`](../../../src/tools/edit.ts), and [`patch.ts`](../../../src/tools/patch.ts): preserve mutation/confirmation semantics, especially post-commit cancellation behavior.
- [`src\server.ts`](../../../src/server.ts), [`src\transport\http.ts`](../../../src/transport/http.ts), and [`stdio.ts`](../../../src/transport/stdio.ts): no transport/session rewiring or admission-order change.
- [`src\core\watcher-registry.ts`](../../../src/core/watcher-registry.ts): the SDK lifecycle-hook work is already a separate effort.
- [`__tests__\helpers.ts`](../../../__tests__/helpers.ts) and [`__tests__\tools.test.ts`](../../../__tests__/tools.test.ts): use as read-only exemplars and regression coverage; keep new specialized fixtures local to the in-scope test files.
- [`package.json`](../../../package.json): no SDK upgrade, package installation, version edit, or script addition.
- [ADR-002](../../adr/002-legacy-protocol-paths-sunset.md) and [ADR-003](../../adr/003-http-serves-2025-era-clients-statelessly.md): settled compatibility choices are not being reopened.

This plan and its review are pre-existing handoff artifacts for the executor,
not permission to rewrite earlier efforts. Preserve any unrelated baseline
worktree changes when applying the scope inventory.

## Steps

### 1. Carry resource cancellation through to the native read

Add these tests first in the
[resource tests](../../../__tests__/resources.test.ts#L287-L356) and
[core filesystem tests](../../../__tests__/core-fs.test.ts#L96-L184):

1. `SDK-AUDIT-CANCEL-001`: call the file contract with an already-aborted signal.
   It rejects with the supplied abort reason and performs no raw file read.
   Supply a real signal in the existing
   [`dummyContext`](../../../__tests__/resources.test.ts#L41); retain its existing
   localized test-double assertion, not a new optional production context.
2. `SDK-AUDIT-CANCEL-002`: an already-aborted raw read rejects before path
   validation/stat/read begins. Count the intercepted operations; a rejected
   promise alone does not establish that I/O never started.
3. `SDK-AUDIT-CANCEL-003`: intercept the native read for one fixture, capture
   its options, and establish that its signal is exactly the controller passed
   to the raw read. Abort at that native boundary and delegate to the real
   native read with the captured arguments; expect rejection, not a buffer.
   This distinguishes native propagation from a promise-race-only fix without
   slow files, FIFOs, sleeps, or platform-specific I/O.
4. `SDK-AUDIT-CANCEL-004`: capture options passed to
   [`GuardedFileSystem.readRaw`](../../../src/core/fs.ts#L365-L386) by the file
   contract; they must carry that request's exact signal. Return controlled
   text/binary data or delegate to the real read. Existing text/binary and
   over-limit tests remain unchanged.

Update the [file-resource callback](../../../src/resources.ts#L205-L235) to read
its context, reject a pre-aborted signal before path work, and pass the signal
into its raw read. In the
[raw-read implementation](../../../src/core/fs.ts#L365-L386), check the signal
before validation and before starting subsequent I/O after awaited validation.
Retain the guarded stat, file-kind check, and size cap.

Replace the uncancellable native read wrapped in a promise race with a native
`readFile` receiving `{ signal }`. Do not use an encoding option: the result
must remain a Buffer for MIME detection and binary resources. There is no claim
that JavaScript can interrupt an OS syscall already in progress; the guarantee
is pre-start refusal and cancellation of Node's buffered read.

**Verify**: `npm test -- __tests__\core-fs.test.ts __tests__\resources.test.ts`
-> exit 0, zero failures, including `SDK-AUDIT-CANCEL-001` through `004`.

**Verify**: `npm exec --no -- tsc --noEmit -p tsconfig.json`
-> exit 0; `npm run type-check:test` -> exit 0.

### 2. Refuse clients that cannot answer a form

In [the input-required tests](../../../__tests__/input-required.test.ts#L83-L158),
add `SDK-AUDIT-MODES-001`, a table exercising
[`pendingRoundTrip`](../../../src/core/input-required.ts#L233-L259) on an initial
round for every operation kind (delete, move, copy, create, grant):

| Declared capabilities | Expected gate behavior |
| --- | --- |
| `undefined` | Allow the existing unknown-capabilities path |
| `{}` | Throw `FsError` with `INVALID_INPUT` and that operation's hint |
| `{ elicitation: {} }` | Allow legacy implicit form support |
| `{ elicitation: { form: {} } }` | Allow |
| `{ elicitation: { form: {}, url: {} } }` | Allow |
| `{ elicitation: { url: {} } }` | Refuse with the same operation-specific tool-error precursor |

Add `SDK-AUDIT-MODES-002` in the same test file: a real SDK modern HTTP
client/handler pair, using
[the existing modern harness as an exemplar](../../../__tests__/helpers.ts#L193-L261)
but keeping the URL-only fixture local. Assert the negotiated era is modern.
Invoke the actual create tool against an existing temporary file, without
`overwrite` or `append`, with a different proposed body. The URL-only client
must receive `isError: true`, the existing `overwrite: true` recovery hint,
no elicitation invocation, no rejected `-32021`, and unchanged file bytes.
Close the client, handler, and factory-owned runtime contexts in `finally`.

Change only the predicate and its inaccurate comments in
[`assertCanElicit`](../../../src/core/input-required.ts#L213-L230):

```ts
  if (capabilities === undefined) return;
  const elicitation = capabilities.elicitation;
  if (
    elicitation !== undefined &&
    (elicitation.form !== undefined || elicitation.url === undefined)
  ) {
    return;
  }
```

Keep the existing throw and hints below it. This is a predicate over the SDK's
validated capability object; do not implement a second wire parser, import the
client package into production, or alter same-operation retry validation.

**Verify**: `npm test -- __tests__\input-required.test.ts`
-> exit 0, zero failures, including both new mode cases.

**Verify**: `npm exec --no -- tsc --noEmit -p tsconfig.json`
-> exit 0; `npm run type-check:test` -> exit 0.

### 3. Start progress only when a round reports work or terminates

In [the progress tests](../../../__tests__/progress.test.ts), add:

1. `SDK-AUDIT-PROGRESS-001`: constructing and flushing a session sends no
   frame. Repeated zero/backward updates before real progress also send none.
   First positive update or terminal outcome sends one initial zero; existing
   ordinary success/failure sequences and known-total guards still pass.
2. `SDK-AUDIT-PROGRESS-002`: a real legacy SDK pair runs the actual create
   tool against an existing in-root file. The form handler returns accepted
   `choice: 'skip'`. Assert exactly one confirmation, unchanged file bytes,
   no progress while the confirmation handler is running, and a nonempty,
   strictly increasing wire progress sequence on one token after completion.
3. `SDK-AUDIT-PROGRESS-003`: use sibling configured/outside directories under
   one temporary boundary, as in the
   [existing grant test](../../../__tests__/tools.test.ts#L1366-L1425).
   A create call on an existing outside file first receives accepted
   `confirm: true` for access, then accepted `choice: 'skip'` for overwrite.
   Assert exactly two forms in that order, no frames during either form,
   unchanged bytes, and one strictly increasing token-scoped final stream.
4. `SDK-AUDIT-PROGRESS-004`: an ordinary call without `onprogress` sends no
   progress notifications. Retain the existing terminal failure and duplicate
   tick tests; add a terminal-only completion/failure assertion if not covered.

For the integration cases, use the
[legacy real-client wiring](../../../__tests__/tools.test.ts#L1389-L1425), with
both linked transport halves from the same SDK package. Wrap the server
transport's `send` before connecting, capture only values narrowed by the
SDK's [`isSpecType.ProgressNotification`](../../../node_modules/@modelcontextprotocol/server/dist/index.d.mts#L773)
guard, and delegate every message and
its options unchanged. Pass `onprogress` to the originating tool call so it
receives a token. Assert at least an initial and a terminal frame; empty
sequences must not pass vacuous monotonicity checks.

Do not assert monotonicity across the modern client's aggregate `onprogress`
callback: it also emits local round-counter updates and uses fresh wire tokens
for retries. The reported defect is same-token legacy wire progress.

In [`ProgressSession`](../../../src/tools/progress.ts#L30-L70), remove only the
constructor's emission. Add a small private, idempotent lazy-start operation:
it emits the existing zero once, immediately before the first accepted positive
[`set`](../../../src/tools/progress.ts#L51-L57),
[`complete`](../../../src/tools/progress.ts#L59-L63), or
[`fail`](../../../src/tools/progress.ts#L65-L69). In the update method, retain the
done/backward/duplicate checks before attempting to start. In terminal methods,
retain their done guard.
Keep rate limiting, failure logging, terminal advancement, and flush semantics.

The deliberate timing change is that input-only rounds emit no progress.
An ordinary tool with no intermediate ticks sends its zero and terminal frame
at completion, not at construction. Do not retain counters in signed request
state, introduce global token maps, or change the executor to buffer events.

**Verify**: `npm test -- __tests__\progress.test.ts __tests__\tools.test.ts`
-> exit 0, zero failures, including all four new progress cases and the existing
ordinary sequences.

**Verify**: `npm exec --no -- tsc --noEmit -p tsconfig.json`
-> exit 0; `npm run type-check:test` -> exit 0.

### 4. Make existing HTTP recovery headers browser-readable

In [the CORS policy tests](../../../__tests__/http-policy.test.ts#L375-L425), add
`SDK-AUDIT-CORS-001`: allowed-origin POST and OPTIONS responses expose exactly
`WWW-Authenticate, Retry-After`; absent/disallowed origins do not gain an
exposure header. Existing Origin reflection, `Vary`, request-header allowlist,
and method behavior stay unchanged.

In [the real HTTP tests](../../../__tests__/http-server.test.ts), add
`SDK-AUDIT-CORS-002` through `004` for an allowed origin:

- A POST without credentials returns 401 and exposes its existing challenge.
- A server booted with a one-request budget returns 401 for the first
  unauthenticated POST, then 429 for the second; the latter exposes a positive
  integer `Retry-After`.
- A normal authenticated MCP response exposes the same names. A disallowed
  Origin still gets 403 without reflected origin or newly exposed headers.

Reuse [`bootHttpTest`](../../../__tests__/helpers.ts#L357-L413), pin
`FS_ALLOWED_ORIGINS` to `localhost` in the relevant fixture, and pass the rate
limit through its environment override. The one-request-budget fixture must
not call the client's connection helper first: its discovery request would
spend that budget. Consume fetch response bodies and close the fixture in
`finally`. Keep any locally nested fixture's environment restoration inside
its lifetime, rather than closing it after a different fixture restored env.

Add this line inside the existing allowed-origin branch of
[`corsMiddleware`](../../../src/transport/http-policy.ts#L342-L351):

```ts
      res.header('Access-Control-Expose-Headers', 'WWW-Authenticate, Retry-After');
```

Do not replace the request-header allowlist with it, expose all headers via
`*`, enable credentialed cookies, move middleware, or replace static-key auth
with OAuth verifier middleware.

**Verify**: `npm test -- __tests__\http-policy.test.ts __tests__\http-server.test.ts`
-> exit 0, zero failures, including `SDK-AUDIT-CORS-001` through `004`.

**Verify**: `npm exec --no -- tsc --noEmit -p tsconfig.json`
-> exit 0; `npm run type-check:test` -> exit 0.

### 5. Record the fixes and run the repository gate

After steps 1-4 are green, add four short user-facing entries under
[`CHANGELOG.md` Unreleased / Fixed](../../../CHANGELOG.md#unreleased).
Name resource-read cancellation, URL-only-client recovery, legacy confirmation
progress, and browser recovery-header visibility. State neither that legacy
HTTP supports confirmation nor that all filesystem syscalls are cancellable.
Do not mark these fixes released or edit any version.

Run the repository gate. If formatting fails on your changes, format only
those changed files with the existing formatter, not the entire repository.
Repeat the gate and retain evidence of the successful run.

**Verify**: `npm run check` -> exit 0, all static checks and tests pass.

**Verify**: `git diff --check` -> exit 0, no output.

**Verify**: `git status --short` -> no new implementation files outside
[Scope](#scope), after accounting for the recorded baseline and handoff artifacts.

## Done

All must hold:

- [ ] `npm exec --no -- tsc --noEmit -p tsconfig.json` exits 0.
- [ ] `npm run type-check:test` exits 0.
- [ ] `npm test -- __tests__\core-fs.test.ts __tests__\resources.test.ts` exits 0,
  including `SDK-AUDIT-CANCEL-001` through `004`.
- [ ] `npm test -- __tests__\input-required.test.ts` exits 0, including
  `SDK-AUDIT-MODES-001` and `002`.
- [ ] `npm test -- __tests__\progress.test.ts __tests__\tools.test.ts` exits 0,
  including `SDK-AUDIT-PROGRESS-001` through `004`; the legacy cases contain
  frames and compare values on the same token.
- [ ] `npm test -- __tests__\http-policy.test.ts __tests__\http-server.test.ts`
  exits 0, including `SDK-AUDIT-CORS-001` through `004`.
- [ ] `npm run check` exits 0 with no new skipped regressions.
- [ ] `git diff --check` exits 0.
- [ ] `git status --short` shows no new implementation changes outside the
  scope allowlist relative to the recorded starting worktree.
- [ ] [Unreleased](../../../CHANGELOG.md#unreleased) describes completed fixes
  without claiming a release or new legacy HTTP capabilities.

## STOP

Stop and report if:

- Live code at a [Current state](#current-state) location no longer matches its
  excerpt, beyond explained line movement.
- A verification gate fails twice after one fix attempt. Distinguish an
  intentional test-first red result from a failed post-fix gate.
- The fix appears to require an out-of-scope production file, dependency
  change, new public option, or SDK upgrade.
- Native filesystem interception cannot prove signal identity without
  weakening types or racing real disk latency; do not replace it with sleeps.
- The installed SDK no longer treats an empty elicitation declaration as form
  support, or a URL-only modern test silently negotiates legacy.
- Any production confirmation path emits positive work progress before
  returning input-required. Lazy startup alone would then not establish the
  same-token guarantee; report the handler and event sequence.
- The progress regression uses different tokens, contains no frames, bypasses
  the SDK shim, or cannot prove the expected one/two confirmation rounds.
- CORS admission policy, authentication bodies, or unauthenticated binding
  policy must change to expose the two existing headers.
- A baseline check fails in unrelated code. Record it; do not fix unrelated
  work or claim the final gate passed.

## Notes

- Review cancellation in the read-only path separately from mutation commit
  points. Post-write cancellation/stat redesign is explicitly deferred.
- Form refusal is a recoverable tool error, not authorization and not a way
  to trust client-supplied confirmation responses without signed state.
- Startup progress is delayed, not globally suppressed; ensure terminal
  notifications and no-token behavior remain covered.
- The browser-header change is the concrete server-side CORS contract. No
  browser automation framework or dependency is warranted for these tests.
- Rollback commands are not applicable: these are local code fixes, not data
  migrations, deletions, or production-state operations.
- **Handoff:** this five-step plan went through
  [plan-hunt](sdk-audit-followups.plan-hunt.md), rather than directly to
  `run-plan`, because it crosses request contexts, native I/O, protocol eras,
  and HTTP policy. The citation correction and final disposition are recorded
  there. Implementation has not started; no run or verify-specs artifact is
  produced by writing the plan.
