# Plan 017: Close two SDK error/URL gaps — subscribe errors carry data, the resource id drops its fragment

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 1eb94134..HEAD -- src/resources.ts src/transport/http-policy.ts __tests__/resources.test.ts __tests__/http-policy.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (Plans 013 and 016 also edit
> `src/transport/http-policy.ts`, on other lines — comments and message
> strings. If they landed first, only re-check the lines this plan quotes.)

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `1eb94134`, 2026-09-26

## Why this matters

Two small places where the installed MCP SDK
(`@modelcontextprotocol/server@2.1.0`) already offers the right behavior and
this server does not use it:

1. **`resources/subscribe` reports client mistakes as server faults.** When a
   subscribe names a malformed file path (for example the drive-relative
   `C:relative`, refused on every platform), the watcher's path validation
   throws an `FsError` that the subscribe handler rethrows raw. The SDK turns
   any error without an integer `code` into `-32603 Internal error` with no
   `data`, and the server also logs a spurious "Unexpected error" warning. The
   same URI sent to `resources/read` correctly answers `-32602 Invalid params`
   with `data: { code: 'INVALID_INPUT', path: 'C:relative' }` through the
   SDK's `ProtocolError` data channel. The advisor reproduced both answers at
   `1eb94134`. The subscribe verb is legacy-only (2025-era), but it stays live
   until at least 2027-07-28 per ADR-002. (Plan 012 left this handler out of
   scope, on the assumption that its remaining errors were server-side. The
   reproduction shows they are not.)
2. **The published OAuth resource identifier can carry a `#fragment`.**
   `FS_PUBLIC_URL` is parsed and returned unchanged as the RFC 9728 `resource`
   value (and fed into the `WWW-Authenticate` `resource_metadata` URL).
   RFC 8707 §2 forbids a fragment in a resource indicator. The SDK exports
   `resourceUrlFromServerUrl`, which returns a copy with the fragment
   stripped.

Both fixes are a few lines and reuse SDK / in-file code rather than adding
new logic.

## Current state

### Part A — `src/resources.ts`

`wrapRead` (lines 390-424) already maps a non-not-found `FsError` to
`ProtocolError(InvalidParams, message, { code, path?, suggestion? })`:

```ts
// src/resources.ts:405-422
// A remaining FsError (NOT_FILE, TOO_LARGE, ...) traces to the
// caller-supplied URI; anything else is a server-side failure and must
// not be blamed on the request. The Problem's identity fields ride the
// SDK's error.data channel: `message` stays the wire message, and
// code/path/suggestion give clients a machine-readable view. Keyed by
// `code`, so it cannot collide with the ResourceNotFoundError
// convention (data: { uri } and nothing else).
if (isFsError(error)) {
  const { code, path, suggestion } = error.problem;
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message, {
    code,
    ...(path !== undefined ? { path } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
  });
}
throw new ProtocolError(ProtocolErrorCode.InternalError, formatUnknownErrorMessage(error));
```

The subscribe path, inside `createFilesystemResource` → `subscribe(uri, notify)`
→ `acquire()`, rethrows the raw error:

```ts
// src/resources.ts:268-280
if (result.reason === 'bad-uri') {
  throw new ResourceNotFoundError(uri, `Cannot subscribe: not a filesystem URI`);
}
if (result.reason === 'invalid-path') {
  const err = result.error;
  if (isNotFoundish(err)) {
    throw new ResourceNotFoundError(uri, `Cannot subscribe to ${uri}: ${err.message}`);
  }
  Logger.warn(
    `Unexpected error validating path for watcher ${uri}: ${formatUnknownErrorMessage(err)}`,
  );
  throw err;
}
```

`isNotFoundish` (lines 88-93) covers `NOT_FOUND` and `ACCESS_DENIED` only.
`isFsError`, `FsError` (type) and `ProtocolError` / `ProtocolErrorCode` are
already imported in this file (lines 14-23). `FsError.problem` is
`{ code, message, path?, suggestion? }` (`src/core/errors.ts:238-250`).

The SDK behavior this relies on: the request dispatcher uses
`Number.isSafeInteger(error.code) ? error.code : -32603`
(`node_modules/@modelcontextprotocol/server/dist/src-D-y6h4N7.mjs:6541`).
`FsError.code` is a string such as `'INVALID_INPUT'`, so a raw `FsError`
always becomes `-32603`.

Safety constraint (from the SDK d.mts, carried over from plan 012): the SDK's
`ResourceNotFoundError` convention is "`error.data` is exactly
`{ uri: string }`". This plan's payload keys (`code`, `path`, `suggestion`)
cannot collide with it.

### Part B — `src/transport/http-policy.ts`

```ts
// src/transport/http-policy.ts:1-6 (imports)
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import {
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  validateOriginHeader,
} from '@modelcontextprotocol/server';
```

```ts
// src/transport/http-policy.ts:213-224
export function protectedResourceUrl(
  req: Request,
  hostValidated: boolean,
  configured: string | undefined,
): URL | null {
  if (configured) {
    const parsed = URL.parse(configured);
    if (parsed) return parsed;
    Logger.warn(
      `[HTTP] Ignoring unparseable FS_PUBLIC_URL: ${configured}. Deriving the resource identifier from the Host header instead.`,
    );
  }
```

`protectedResourceUrl` feeds both the metadata document
(`src/transport/http.ts:119-132`, `resource: resource.href`) and the 401
challenge (`buildAuthChallenge`, `http-policy.ts:238-254`), so one change
fixes both.

The SDK helper (exported from `@modelcontextprotocol/server`;
declaration `createMcpHandler-Bt6U_Fqb.d.mts:305`, implementation
`src-D-y6h4N7.mjs:436-440`):

```ts
declare function resourceUrlFromServerUrl(url: URL | string): URL;
// implementation: new URL(url.href) with `hash = ""`
```

### Tests

- `__tests__/resources.test.ts` — `describe('MCP Client Resource Operations', …)`
  (starts line 499; `harness` is a `createTestClientPair([clientTmpDir])`).
  Pattern to copy: `'client.readResource() on a not-file URI rejects with structured error.data'`
  (around line 599) and the three `resources/subscribe …` tests after it
  (around lines 613-651). `ProtocolError`, `ProtocolErrorCode` and `ErrorCode`
  are already imported.
- `__tests__/http-policy.test.ts` — `createMockRequest()` (line 70) builds a
  fake express `Request`. The `Utility functions (...)` describe (line 687) is
  where small pure-function tests live. `protectedResourceUrl` is **not**
  imported there yet (import list at lines 9-21).

## Commands you will need

| Purpose      | Command                                                                | Expected on success |
| ------------ | ---------------------------------------------------------------------- | ------------------- |
| Static check | `npm run check:static`                                                 | exit 0              |
| All tests    | `npm test`                                                             | all pass            |
| Part A test  | `npm test -- --test-name-pattern="subscribe answers a malformed path"` | passes              |
| Part B test  | `npm test -- --test-name-pattern="drops a fragment"`                   | passes              |

`npm run check:static` = build + `tsc -p tsconfig.test.json` + eslint
(`--max-warnings=0`) + `prettier --check .` + knip.

## Scope

**In scope** (the only files you should modify):

- `src/resources.ts` — a new module-private helper, `wrapRead`'s FsError
  branch, and the subscribe `invalid-path` branch
- `src/transport/http-policy.ts` — the import list and `protectedResourceUrl`
  line 220
- `__tests__/resources.test.ts` — one new test
- `__tests__/http-policy.test.ts` — one new test and one import
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- The `bad-uri`, `capped`, `attach-failed` and `stale` subscribe branches —
  their answers are deliberate (see the comments at `resources.ts:268-289`
  and `:529-535`).
- The HTTP / stdio `subscriptions/listen` refusals in
  `src/transport/shared.ts` — a different wire path with its own messages.
- `isNotFoundish` — keep `ACCESS_DENIED` as not-found (security: it does not
  reveal whether an out-of-root path exists).
- The Host-derived branch of `protectedResourceUrl` (lines 225-230) — the
  Host header is validated before it gets there and cannot carry a fragment.
- `src/core/errors.ts` — no changes to `FsError` / `Problem`.

## Git workflow

- Branch: `advisor/017-sdk-error-url-gaps` from `main`.
- One commit per part, conventional-commit style matching the log, for
  example `fix(resources): answer malformed subscribe paths as InvalidParams with error.data`
  and `fix(http): strip the fragment from FS_PUBLIC_URL via resourceUrlFromServerUrl`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Part A regression test (it must fail now)

In `__tests__/resources.test.ts`, inside `describe('MCP Client Resource Operations', …)`,
directly after the test `'resources/subscribe answers a foreign scheme as not found'`,
add:

```ts
it('resources/subscribe answers a malformed path as InvalidParams with structured error.data', async () => {
  // `C:relative` is refused on every platform (isWindowsDriveRelativePath
  // checks regardless of OS), so this reaches the watcher's path
  // validation everywhere and is the caller's mistake, not a server fault.
  const uri = 'filesystem-mcp://file/C:relative';
  await assert.rejects(harness.client.subscribeResource({ uri }), (err: unknown) => {
    assert.ok(ProtocolError.isInstance(err), 'expected ProtocolError');
    assert.strictEqual(err.code, ProtocolErrorCode.InvalidParams);
    const data = (err as { data?: unknown }).data as Record<string, unknown>;
    assert.strictEqual(data['code'], ErrorCode.INVALID_INPUT);
    assert.strictEqual(data['path'], 'C:relative');
    return true;
  });
});
```

**Verify**: `npm test -- --test-name-pattern="subscribe answers a malformed path"`
→ **fails**: `err.code` is `-32603`, expected `-32602`. If it passes, STOP.

### Step 2: Part A fix — one helper, two call sites

In `src/resources.ts`:

1. Add a module-private helper directly above `function wrapRead(` (around
   line 390), moving the explanatory comment from `wrapRead` onto it:

   ```ts
   /**
    * A caller-traceable FsError as the SDK's InvalidParams error. The Problem's
    * identity fields ride the SDK's error.data channel: `message` stays the
    * wire message, and code/path/suggestion give clients a machine-readable
    * view. Keyed by `code`, so it cannot collide with the
    * ResourceNotFoundError convention (data: { uri } and nothing else).
    */
   function fsErrorToProtocolError(error: FsError): ProtocolError {
     const { code, path, suggestion } = error.problem;
     return new ProtocolError(ProtocolErrorCode.InvalidParams, error.message, {
       code,
       ...(path !== undefined ? { path } : {}),
       ...(suggestion !== undefined ? { suggestion } : {}),
     });
   }
   ```

2. In `wrapRead`, replace the FsError block (the `if (isFsError(error)) { … }`
   at lines 412-419) and its comment (lines 405-411) with:

   ```ts
   // A remaining FsError (NOT_FILE, TOO_LARGE, ...) traces to the
   // caller-supplied URI; anything else is a server-side failure and must
   // not be blamed on the request.
   if (isFsError(error)) throw fsErrorToProtocolError(error);
   ```

   The final `throw new ProtocolError(ProtocolErrorCode.InternalError, …)`
   line stays.

3. In the subscribe `invalid-path` branch (lines 271-280), insert one line
   between the `isNotFoundish` block and the `Logger.warn`:

   ```ts
   if (isFsError(err)) throw fsErrorToProtocolError(err);
   ```

   The `Logger.warn` + `throw err` that follow now run only for a
   non-`FsError` (a genuine server-side failure), which is what the
   "Unexpected error" wording already claims.

4. Run `npx prettier --write src/resources.ts`.

**Verify**:

- `npm test -- --test-name-pattern="subscribe answers a malformed path"` →
  passes.
- `npm test -- --test-name-pattern="structured error.data"` → the existing
  `readResource` not-file test still passes (proves `wrapRead` is unchanged
  in behavior).

### Step 3: Part B regression test (it must fail now)

In `__tests__/http-policy.test.ts`:

1. Add `protectedResourceUrl` to the import list from
   `'../src/transport/http-policy.ts'` (lines 9-21, keep alphabetical order).
2. In the `describe('Utility functions (isLoopbackHttpHost, splitCsvList, resolveTrustProxySetting)', …)`
   block, add:

   ```ts
   it('protectedResourceUrl drops a fragment from FS_PUBLIC_URL (RFC 8707 §2)', () => {
     const url = protectedResourceUrl(
       createMockRequest(),
       true,
       'https://mcp.example.com/mcp#section',
     );
     assert.strictEqual(url?.href, 'https://mcp.example.com/mcp');
   });
   ```

**Verify**: `npm test -- --test-name-pattern="drops a fragment"` → **fails**
(actual href ends in `#section`). If it passes, STOP.

### Step 4: Part B fix

In `src/transport/http-policy.ts`:

1. Add `resourceUrlFromServerUrl` to the value import from
   `'@modelcontextprotocol/server'` (lines 2-6; keep specifiers alphabetical,
   or let `npx prettier --write` sort them).
2. Change line 220 from `if (parsed) return parsed;` to:

   ```ts
   // RFC 8707 §2: a resource indicator must not carry a fragment.
   if (parsed) return resourceUrlFromServerUrl(parsed);
   ```

3. Run `npx prettier --write src/transport/http-policy.ts __tests__/http-policy.test.ts`.

**Verify**: `npm test -- --test-name-pattern="drops a fragment"` → passes.

### Step 5: Full gate

**Verify**: `npm run check` → exit 0; all tests pass, including the two new
ones.

## Test plan

- Part A: `resources/subscribe` on `filesystem-mcp://file/C:relative` →
  `ProtocolError` with `code === -32602`,
  `data.code === 'INVALID_INPUT'`, `data.path === 'C:relative'`
  (in `__tests__/resources.test.ts`, pattern: the `readResource` not-file
  test above it).
- Part B: `protectedResourceUrl(req, true, 'https://mcp.example.com/mcp#section')`
  → href `https://mcp.example.com/mcp` (in `__tests__/http-policy.test.ts`,
  pattern: the pure-function tests in the `Utility functions` block).
- Existing tests that must keep passing unchanged: every
  `resources/subscribe …` test in `resources.test.ts`,
  `__tests__/resources-subscribe.test.ts`, and the `readResource`
  structured-data test.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] Both new tests exist and pass
- [ ] `grep -c "fsErrorToProtocolError" src/resources.ts` prints `3`
      (definition + two call sites)
- [ ] `grep -n "resourceUrlFromServerUrl" src/transport/http-policy.ts`
      shows the import and the call
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 017 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows a quoted line changed and no longer matches.
- Either regression test passes before its fix step.
- After Step 2, the new subscribe test sees `data` without `code` (the
  client-side error reconstruction may drop `data` on this path). Report the
  observed error object; do not weaken the assertion.
- Any existing `resources/subscribe` test changes outcome — the helper must
  only affect the `invalid-path` + non-not-found `FsError` case.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- `fsErrorToProtocolError` is now the one place that decides how an `FsError`
  looks on the resources wire. A future resources verb (or the modern listen
  path, if it ever surfaces per-URI errors) should reuse it rather than
  hand-building `ProtocolError` data.
- **Reviewer focus**: the payload keys must never become `{ uri }` — that
  shape is the SDK's `ResourceNotFoundError` convention.
- ADR-002 schedules the legacy subscribe handler for removal. When it goes,
  Part A's subscribe call site goes with it; the helper stays for `wrapRead`.
- If `FS_PUBLIC_URL` validation ever grows (for example rejecting non-https
  on public binds), do it next to the `resourceUrlFromServerUrl` call so one
  function owns the resource identifier's shape.
