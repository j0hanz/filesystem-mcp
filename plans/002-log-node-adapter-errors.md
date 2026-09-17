# Plan 002: Log Node-adapter failures on the HTTP leg

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2d3b112f..HEAD -- src/transport/http.ts`
> If the file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `2d3b112f`, 2026-09-17

## Why this matters

`toNodeHandler` from `@modelcontextprotocol/node` adapts the SDK's
web-standard MCP handler to Express. When the adapter itself fails — the Node
request cannot be converted to a `Request`, or `handler.fetch` throws (for
example because the handler was already closed during shutdown) — the
adapter answers `500` and, unless given an `onerror` callback, says nothing.
Today `src/transport/http.ts` passes no callback, so an operator sees a bare
500 in the client and nothing on stderr. The SDK's own handler-level errors
are already logged through `createMcpHandler`'s `onerror`; this plan gives the
adapter layer the same logger, so every 500 the HTTP leg produces has a
stderr line naming its cause.

## Current state

- `src/transport/http.ts` — HTTP hosting: Express app assembly, the
  per-request server factory, and the `/mcp` route. The handler is built at
  lines 293-321 and wrapped for Express at line 322.

`src/transport/http.ts:311-322` today:

```ts
    {
      // The SDK's default: a 2025-era request is answered by a fresh instance
      // from the same factory, no session. What that leg cannot do — answer an
      // input_required confirmation, deliver a subscription — is refused with a
      // named workaround (define.ts, resources.ts). See docs/adr/003.
      legacy: 'stateless',
      onerror: (error: Error) => {
        Logger.error('[HTTP] modern leg error:', formatUnknownErrorMessage(error));
      },
    },
  );
  const modernNodeHandler = toNodeHandler(modernHandler);
```

`Logger` and `formatUnknownErrorMessage` are already imported in this file
(`src/transport/http.ts:18-19`). The log-line convention is a bracketed leg
tag followed by a short noun phrase, as in the `onerror` above and in
`Logger.error('[HTTP] runtime server error', …)` at `src/transport/http.ts:342`.
Match it.

The SDK option, from
`node_modules/@modelcontextprotocol/node/dist/index.d.mts`:

```ts
interface ToNodeHandlerOptions {
  /**
   * Called when the adapter answers `500` because request conversion or
   * `handler.fetch` itself threw (e.g. a closed handler). ...
   */
  onerror?: (error: Error) => void;
}
declare function toNodeHandler(
  handler: FetchLikeMcpHandler,
  opts?: ToNodeHandlerOptions,
): NodeMcpRequestHandler;
```

## Commands you will need

| Purpose       | Command                                  | Expected on success |
| ------------- | ---------------------------------------- | ------------------- |
| Static checks | `npm run check:static`                   | exit 0              |
| HTTP tests    | `npm test -- --test-name-pattern="HTTP"` | all pass            |
| Full check    | `npm run check`                          | exit 0              |
| Format        | `npm run fix`                            | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/transport/http.ts`

**Out of scope** (do NOT touch, even though they look related):

- `src/transport/http-policy.ts` — auth, CORS and rate-limit policy; unrelated.
- `src/transport/stdio.ts` — stdio has no Node adapter.
- `CHANGELOG.md` — this changes stderr output only, not wire behaviour; no
  entry.

## Git workflow

- Branch: `fix/http-node-adapter-onerror` from `main`.
- One commit. Subject style from `git log`: `fix(http): log node adapter
failures` (conventional prefix, lower case, no trailing period).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pass an `onerror` logger to `toNodeHandler`

In `src/transport/http.ts`, replace line 322:

```ts
const modernNodeHandler = toNodeHandler(modernHandler);
```

with:

```ts
// Adapter-level failures (request conversion, a fetch on a closed handler)
// answer 500 on their own; without this they would do so silently. The
// handler's own errors already go through createMcpHandler's `onerror`.
const modernNodeHandler = toNodeHandler(modernHandler, {
  onerror: (error: Error) => {
    Logger.error('[HTTP] node adapter error:', formatUnknownErrorMessage(error));
  },
});
```

**Verify**: `npm run check:static` → exit 0.

### Step 2: Run the HTTP test suites

**Verify**: `npm test -- --test-name-pattern="HTTP"` → all pass, 0 failed.

### Step 3: Full check and format

**Verify**: `npm run fix` → exit 0; `git status --short` → only
`src/transport/http.ts` modified.

## Test plan

- No new test. The adapter's error path only fires when the SDK's own
  `handler.fetch` throws or request conversion fails, neither of which the
  server can provoke through its public surface without stubbing SDK
  internals. The gate is `npm run check:static` (type-checks the options
  object against the installed SDK) plus the existing HTTP suites, which prove
  the wrapped handler still serves every request shape.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "toNodeHandler(modernHandler, {" src/transport/http.ts` returns one match
- [ ] `grep -n "node adapter error" src/transport/http.ts` returns one match
- [ ] `git status --short` lists only `src/transport/http.ts`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/transport/http.ts:322` is not `const modernNodeHandler = toNodeHandler(modernHandler);`.
- `npm run check:static` reports that `toNodeHandler` accepts no second
  argument — the installed `@modelcontextprotocol/node` is not 2.0.0.
- Any HTTP test fails after the change.

## Maintenance notes

- If the HTTP leg ever moves off Express onto a bare `node:http` mount, the
  same `onerror` belongs on whatever wraps `handler.fetch` there.
- Reviewer: confirm the log tag matches the file's other `[HTTP]` lines and
  that no request data is logged (the error message only).
