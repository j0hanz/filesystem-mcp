# Plan: Rejected cancellation requests preserve stdio subscriptions

> **Executor rules:** work the steps in order. Step 1 deliberately ends RED;
> every other verification must pass. On a STOP condition, report the step,
> condition, and evidence. Do not implement any other SDK audit finding.
>
> **Written against** commit `105fb972`, 2026-09-29.
> **Status:** ready for implementation; not implemented.
> **Review:** [plan-hunt](stdio-cancellation-envelope.plan-hunt.md), zero findings.
> **Effort:** S. **Fix risk:** low.
> **Drift check:** `git diff --stat 105fb972..HEAD -- src\transport\stdio.ts __tests__\stdio.test.ts CHANGELOG.md`.
> Compare the [current-state excerpts](#current-state) against every changed
> file before executing. Also inspect `git status --short` for uncommitted
> changes; do not overwrite them.

## Goal

A JSON-RPC request whose method is `notifications/cancelled` must receive
the SDK's method-not-found error without cancelling another request's
subscription or releasing its filesystem watcher. This must hold whether
the targeted listen is already acknowledged or is queued for admission.
Genuine cancellation notifications must continue to release their leases.

Requirements covered: none, this is a fix. No separate spec or protocol
feature is being added.

## Current state

### The local parser mistakes a request for a notification

[`cancelledRequestId()` at stdio.ts:42-51](../../../src/transport/stdio.ts#L42-L51)
currently reads:

```ts
function cancelledRequestId(message: unknown): string | number | null {
  if (typeof message !== 'object' || message === null) return null;
  const notification = message as {
    method?: unknown;
    params?: { requestId?: unknown };
  };
  if (notification.method !== 'notifications/cancelled') return null;
  const requestId = notification.params?.requestId;
  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : null;
}
```

It does not distinguish a notification from a request carrying its own
`id`. Its result drives mutation in
[`wire.onmessage` at stdio.ts:263-277](../../../src/transport/stdio.ts#L263-L277):

```ts
const cancelId = cancelledRequestId(message);
if (cancelId !== null) {
  const state = listens.get(cancelId);
  if (!state) {
    deliver(message);
    return;
  }
  state.cancelled = true;
  if (state.delivered) {
    releaseListen(cancelId);
    deliver(message);
  }
  return;
}
```

For an active listen, a request-shaped cancellation releases its lease
before being delivered to the SDK, which rejects the request. For a queued
listen, the same input marks it cancelled and is swallowed; the queued
listen is then suppressed too.

### The installed SDK already has the correct envelope discriminator

The runtime dependency is
[`@modelcontextprotocol/server` 2.2.0](../../../package.json#L60-L63).
Its public
[`isJSONRPCNotification()` declaration](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CfX6zgs1.d.mts#L1694)
is:

```ts
declare const isJSONRPCNotification: (value: unknown) => value is JSONRPCNotification;
```

The SDK's own
[`serveStdio` cancellation branch](../../../node_modules/@modelcontextprotocol/server/dist/stdio.mjs#L378-L381)
requires that guard before cancelling a listen:

```ts
if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") {
  const cancelledId = message.params?.requestId;
  if (cancelledId !== void 0 && listenRouter.cancel(cancelledId)) return true;
}
```

The public
[`isSpecType` guard family](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CfX6zgs1.d.mts#L1830-L1856)
is not a substitute: its cancellation schema accepts the extra top-level
`id`. The following command was run successfully against the installed
package; it is also the executor's dependency-assumption gate:

```powershell
node --input-type=module -e "import assert from 'node:assert/strict'; import {isJSONRPCNotification,isSpecType} from '@modelcontextprotocol/server'; const notification={jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:0}}; const request={...notification,id:'bad-cancel'}; assert.equal(isJSONRPCNotification(notification),true); assert.equal(isJSONRPCNotification(request),false); assert.equal(isSpecType.CancelledNotification(request),true); console.log('guard contract confirmed')"
```

Expected: exit 0 and `guard contract confirmed`.

### Reproduction and the existing test conventions

Read-only subprocess probes on the baseline established:

- With a one-watcher budget, listen A is acknowledged. A request-shaped
  cancellation receives `-32601`, but a subsequent listen B unexpectedly
  succeeds: A's lease has already been released.
- When listen A, a request-shaped cancellation targeting A, and listen B
  are sent in one write, the first reply is B's acknowledgement. A's
  admission and the invalid request's error response have both been
  suppressed. This was reproduced with a string target ID and numeric `0`.

Use the existing
[`Stdio subscription lease lifecycle` suite](../../../__tests__/stdio.test.ts#L233),
not a mocked transport or a new exported test seam:

- [`STDIO-008`](../../../__tests__/stdio.test.ts#L365-L413) exercises a genuine
  notification cancelling an active listen.
- [`STDIO-009`](../../../__tests__/stdio.test.ts#L415-L466) uses one
  [`sendMany()`](../../../__tests__/helpers.ts#L491-L499) write for queued
  cancellation. Follow that scheduling pattern, without sleeps.
- [`STDIO-010`](../../../__tests__/stdio.test.ts#L468-L532) checks the
  one-watcher budget while leases are shared.
- [`MODERN_META`, `within()`, and `discoverModern()`](../../../__tests__/stdio.test.ts#L26-L50)
  already provide the envelope, bounded reads, and modern opening.
- [`createRawStdioServer()`](../../../__tests__/helpers.ts#L460-L520) provides
  unmodified JSON-RPC frames. Its
  [`nextMessage()`](../../../__tests__/helpers.ts#L501-L507) has no timeout:
  wrap every new read in the existing
  [`within()`](../../../__tests__/stdio.test.ts#L32-L39), using 5,000 ms.
- [`writeTestFile()`](../../../__tests__/helpers.ts#L523-L532) creates files
  inside the isolated test root. The existing
  [`writeFile` import](../../../__tests__/stdio.test.ts#L6) can then change A
  to prove that its resource-update notification still arrives.
- Match existing `assert.ok` union narrowing and `try`/`finally` cleanup:
  close the harness before removing its test root. Do not write repository
  fixtures or use broad process-killing commands.

### Preserve the existing architectural decisions

The [earlier parser decision](../../../plans/README.md#L330-L332) says:

> hand-parse is the cheap path on the every-message hot line; migrating buys
> strict-shape validation only.

This plan addresses a newly reproduced state-changing defect, not blanket
schema cleanup. Keep the cheap method check first, so unrelated messages
never invoke the SDK guard. Do not change the
[outbound reply discriminator](../../../src/transport/stdio.ts#L221-L228).

The [upstream lifecycle-hook record](../2026-09-15-sdk-listen-hook/issue-draft.md#L53-L72)
explains why the application still owns watcher leases and intercepts
stdio traffic. This fix does not replace that architecture, remove its
installation-order assertion, or wait for a future SDK hook.

## Commands

Run from the repository root in PowerShell. These existing commands were
exercised on the baseline: the stdio file passed 17 tests; type checking,
scoped lint, and scoped formatting all exited 0. New-test RED/GREEN outcomes
below are executor gates, not claims that those tests have already landed.

| Purpose | Command | Expected |
| --- | --- | --- |
| Drift | `git diff --stat 105fb972..HEAD -- src\transport\stdio.ts __tests__\stdio.test.ts CHANGELOG.md` | Review any listed file against its baseline before proceeding. |
| Stdio behavior | `npm test -- __tests__\stdio.test.ts` | Baseline: 17 pass; after step 2: 21 pass, zero failures, cancellations, or skips. |
| Source and test types | `npm run type-check:test` | Exit 0; its [configuration](../../../tsconfig.test.json#L2-L8) checks source and tests without emitting files. |
| Scoped lint | `npm exec --no -- eslint src\transport\stdio.ts __tests__\stdio.test.ts --max-warnings=0` | Exit 0, no warnings. |
| Scoped formatting | `npm exec --no -- prettier --check src\transport\stdio.ts __tests__\stdio.test.ts CHANGELOG.md` | Exit 0, all three files match repository formatting. |
| Worktree scope | `git status --short` | Only the three implementation files below, plus pre-existing planning artifacts or user changes; no unrelated executor edits. |

The command definitions and tool dependencies are in
[`package.json`](../../../package.json#L28-L80). Do not install or upgrade
anything for this fix.

## Scope

**In scope for implementation:**

- [`src/transport/stdio.ts`](../../../src/transport/stdio.ts): import and use
  the SDK's envelope guard inside the existing cancellation parser.
- [`__tests__/stdio.test.ts`](../../../__tests__/stdio.test.ts): four
  regression cases in the existing lifecycle suite.
- [`CHANGELOG.md`](../../../CHANGELOG.md#L8-L15): one Unreleased/Fixed entry
  describing the user-visible subscription fix.

**Out of scope, even though related:**

- [`src/transport/http.ts`](../../../src/transport/http.ts): HTTP cancels
  through response-stream closure, not this stdio parser.
- [`src/transport/shared.ts`](../../../src/transport/shared.ts):
  subscriptions/listen parsing already uses the SDK schema; it is not the
  defective cancellation discriminator.
- [`src/core/watcher-registry.ts`](../../../src/core/watcher-registry.ts):
  lease accounting is correct when supplied genuine cancellation events.
- [`__tests__/helpers.ts`](../../../__tests__/helpers.ts): existing raw
  harness operations suffice; keep scenario assertions local to the tests.
- [`package.json`](../../../package.json): the required guard already ships;
  no dependency, version, or script change is needed.
- [Prior SDK follow-up artifacts](../2026-09-29-sdk-audit-followups/sdk-audit-followups.plan.md):
  that applied effort is separate; do not reopen it or create a verify
  artifact for it as part of this fix.

## Steps

### 1. Add active and queued regression cases, and establish RED

In the [lifecycle suite](../../../__tests__/stdio.test.ts#L233), add:

- `STDIO-015: rejected cancellation request preserves an active listen`
- `STDIO-016: rejected cancellation request preserves a queued listen`

Parameterize each over a string listen ID and numeric `0`, including the ID
kind in each test's name. This adds exactly four test cases. Use a distinct,
fresh string ID for each invalid request and each capacity-probe listen;
none may equal the target listen ID. Duplicate outstanding request IDs are
not part of this fix.

Each case creates two test files A and B and a fresh
[`createRawStdioServer()`](../../../__tests__/helpers.ts#L460-L520) with
`FS_MAX_WATCHERS: '1'`, then calls the existing
[`discoverModern()`](../../../__tests__/stdio.test.ts#L40-L50).
The invalid message is a valid JSON-RPC **request**, not a notification:

```ts
{
  jsonrpc: '2.0',
  id: 'bad-cancel',
  method: 'notifications/cancelled',
  params: {
    _meta: MODERN_META,
    requestId: targetListenId,
  },
}
```

Here [`MODERN_META`](../../../__tests__/stdio.test.ts#L26-L30) must be
present even on the invalid request: after discovery the stdio entry may
still be in its probe phase. A claim-less message could select the legacy
path before the queued modern listen arrives, testing negotiation rather
than this defect.

**Active case:**

1. Send listen A and await its acknowledgement. Assert its subscription ID
   equals the original target ID, preserving its number/string type.
2. Send the invalid request. Require an error with its own request ID and
   [`ProtocolErrorCode.MethodNotFound`](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CfX6zgs1.d.mts#L1549-L1556).
3. Send a listen for B. Require an error with B's request ID and
   [`ProtocolErrorCode.InvalidParams`](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CfX6zgs1.d.mts#L1549-L1556),
   because A must still occupy the sole watcher slot.

**Queued case:**

1. Use one [`sendMany()`](../../../__tests__/helpers.ts#L491-L499) call for
   listen A, the invalid request, and the capacity-probe listen for B, in
   that order. Do not wait for A's acknowledgement before sending the other
   frames.
2. Read the three expected responses with bounded reads, accepting either
   order for independent replies: A's acknowledgement, the invalid
   request's method-not-found error, and B's capacity error.
3. Match frames by JSON-RPC `id` or the acknowledgement's
   `params._meta['io.modelcontextprotocol/subscriptionId']`, not by arrival
   position. Reject unexpected frames immediately. In particular, B
   receiving an acknowledgement must fail the test immediately; do not
   merely wait for two responses the buggy server swallowed.
4. Assert each expected response occurs exactly once. The baseline
   acknowledges B while suppressing A and the invalid request.

**Finish both cases with observable delivery and genuine cancellation:**

1. Change A's contents after its acknowledgement and the capacity/error
   assertions. Require `notifications/resources/updated`, the exact A URI,
   and A's original subscription ID. This proves updates still work, rather
   than checking watcher capacity alone.
2. Send a genuine notification with no top-level `id`, method
   `notifications/cancelled`, and `params.requestId` equal to A's ID.
3. Send a fresh listen for B and require its acknowledgement: a genuine
   cancellation must still release the watcher slot.
4. Always close the harness and clean up its isolated root in `finally`.

**Verify:** `npm test -- __tests__\stdio.test.ts` -> the new cases fail for
the described lease-release/admission defect; existing cases remain green.
`npm run type-check:test` -> exit 0. Do not weaken expectations to make RED
pass or mistake a type error for the required behavioral failure.

### 2. Guard the cancellation envelope, document the fix, and establish GREEN

Add [`isJSONRPCNotification`](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CfX6zgs1.d.mts#L1694)
to the existing runtime SDK import at
[`stdio.ts:5`](../../../src/transport/stdio.ts#L5). In
[`cancelledRequestId()`](../../../src/transport/stdio.ts#L42-L51), insert the
guard immediately after the existing method check:

```ts
if (notification.method !== 'notifications/cancelled') return null;
if (!isJSONRPCNotification(message)) return null;
const requestId = notification.params?.requestId;
return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : null;
```

Keep the object guard and lightweight view preceding this excerpt. Keeping
the existing typed `requestId` read avoids unrelated type casts or helper
changes. The return sentinel must remain `null`: numeric ID `0` is valid
and must not be handled with a truthiness check.

Leave [`wire.onmessage`](../../../src/transport/stdio.ts#L263-L290) and its
lease transitions unchanged. Returning `null` for a request-shaped
cancellation already sends that message through the ordinary delivery
path, allowing the SDK to return the error without touching A's state.
Do not add an application-generated error response, silently drop invalid
requests, guard every inbound message, or replace the parser with the
looser spec-type guard.

Add one bullet under
[`CHANGELOG.md` Unreleased/Fixed](../../../CHANGELOG.md#L8-L15), matching its
existing bold-summary style: rejected stdio cancellation requests no
longer cancel queued subscriptions or detach active file watchers.
Do not change any package version.

**Verify:**

```powershell
npm test -- __tests__\stdio.test.ts
npm run type-check:test
npm exec --no -- eslint src\transport\stdio.ts __tests__\stdio.test.ts --max-warnings=0
npm exec --no -- prettier --check src\transport\stdio.ts __tests__\stdio.test.ts CHANGELOG.md
git status --short
```

Expected: 21 stdio tests pass with zero failures, cancellations, or skips;
all static commands exit 0; no unrelated implementation files changed.
The existing genuine-cancellation, shared-lease, rejection, and shutdown
cases must remain green. Check each command's exit status before proceeding.

## Done

- [ ] Step 1 demonstrated the defect before the production change.
- [ ] Both new test IDs run for a string target ID and numeric `0`.
- [ ] Rejected requests preserve active delivery and queued admission.
- [ ] Their own request IDs receive method-not-found errors.
- [ ] A genuine notification still releases A's lease and admits B.
- [ ] All step 2 commands pass, with 21 passing stdio tests.
- [ ] The production change is limited to the import and cancellation guard.
- [ ] The only other implementation changes are the four tests and the
      Unreleased changelog bullet.

## STOP

Stop and report if:

- A current-state excerpt or dependency guard assertion no longer matches.
- The queued scenario requires changing the production scheduler or the raw
  harness; do not add artificial delays or expose a new production seam.
- Any new case passes on the unfixed baseline: the reproduction needs
  investigation before choosing a different fix.
- Fixing the case requires changing an out-of-scope file or handling reused
  outstanding request IDs.
- A verification fails twice after one correction attempt. The intentional
  behavioral RED in step 1 is exempt; type errors and unrelated failures
  are not.

## Notes

This plan deliberately leaves the already-recorded SDK typing, private
listen-hook, auth, version-negotiation, and sunset work alone. Review the
placement of the method-first guard and the response-correlation assertions
most closely: broad validation would reopen the rejected hot-path cleanup,
and assuming a reply order would make the queued regression flaky.

The planner has not changed production code, added these tests, or claimed
the defect is fixed. The [plan-hunt](stdio-cancellation-envelope.plan-hunt.md)
found no dead steps. The next stage is implementation through run-plan, not
another audit of the already-recorded SDK findings.
