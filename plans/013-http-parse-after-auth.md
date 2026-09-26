# Plan 013: HTTP parses a request body only after rate limiting and auth have admitted it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 1eb94134..HEAD -- src/transport/http.ts src/transport/http-policy.ts __tests__/http-server.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `1eb94134`, 2026-09-26

## Why this matters

The HTTP leg builds its express app with the SDK's `createMcpExpressApp`,
which mounts `express.json()` for the **whole app** at construction time. Every
middleware this server adds afterwards — CORS, the rate limiter, bearer auth —
therefore runs only after the request body has been fully read and
`JSON.parse`d (up to 4 MiB, synchronously, on the event loop). On a public
bind (where an API key is mandatory), an unauthenticated client can make the
server buffer and parse 4 MiB per request, and requests that end in 401 or 429
still pay the full parse, so the rate limiter does not bound that cost.

After this plan the app is assembled from the SDK's own building blocks
(`hostHeaderValidation`, `originValidation`, `localhostOriginValidation` from
`@modelcontextprotocol/express`) plus a JSON parser mounted **on the
`POST /mcp` route only, after auth**. Host and Origin validation keep running
first and app-wide, exactly as today. The only intended behavior changes:

- An unauthenticated or rate-limited request is refused (401 / 429) without
  its body being read.
- An unauthenticated request with malformed JSON gets 401 instead of 400.
- A 413 / 400 parser refusal now carries the CORS header (`corsMiddleware`
  runs before the parser instead of after it).

## Current state

Files:

- `src/transport/http.ts` — assembles the express app (`setupExpressApp`,
  lines 75-253) and starts the HTTP server.
- `src/transport/http-policy.ts` — pure policy helpers and middlewares
  (`corsMiddleware`, `createRateLimiter`, `bearerAuthMiddleware`,
  `isLoopbackHttpHost`). Two doc comments name `createMcpExpressApp`
  (lines 75 and 328).
- `__tests__/http-server.test.ts` — real-HTTP integration tests, including
  the `postWithoutEndingUpload` helper (lines 23-48) that sends headers plus a
  partial body and asserts a response arrives before the upload finishes.

`src/transport/http.ts:3` and `:17` (imports today):

```ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';
...
import type { Express, NextFunction, Request, Response } from 'express';
```

`src/transport/http.ts:84-116` (app construction and the middleware chain):

```ts
const allowedOriginHostnames = computeAllowedOriginHostnames(process.env['FS_ALLOWED_ORIGINS']);
// Read once here and passed down, like every other env-derived policy input:
// http-policy holds no state and reads no env of its own.
const publicUrl = process.env['FS_PUBLIC_URL'];

const app = createMcpExpressApp({
  host: httpHost,
  // The express parser limit derives from the SDK's own request-body
  // bound, so it and the adapter/handler-core defaults
  // (`DEFAULT_MAX_REQUEST_BODY_SIZE`, 4 MiB in 2.1.0) cannot drift apart.
  jsonLimit: `${DEFAULT_MAX_REQUEST_BODY_SIZE}b`,
  ...(allowedHosts.length > 0 ? { allowedHosts: [...allowedHosts] } : {}),
  ...(allowedOriginHostnames.length > 0 ? { allowedOrigins: [...allowedOriginHostnames] } : {}),
});

const trustProxy = resolveTrustProxySetting(process.env['FS_TRUST_PROXY']);
if (trustProxy !== undefined) {
  app.set('trust proxy', trustProxy);
}

if (allowedHosts.length === 0) {
  Logger.warn(
    '[HTTP] FS_ALLOW_UNRESTRICTED_HOSTS is set: binding globally without Host validation.',
  );
}

app.use('/mcp', corsMiddleware(allowedOriginHostnames));

// Unconditional: the spec's rate-limit MUST is not scoped to authenticated
// binds. A keyless bind is loopback-only, so the cap is looser, not absent.
const rpm = parseEnvInt('FS_RATE_LIMIT_RPM', apiKey ? 120 : 6_000, 1, 100_000);
app.use('/mcp', createRateLimiter(rpm));
```

`src/transport/http.ts:147-169` (auth, then the POST route that reads the
already-parsed body):

```ts
  app.use('/mcp', bearerAuthMiddleware(apiKey, allowedHosts.length > 0, publicUrl));

  const resourceUpdateSink = (uri: string): void => {
    notifier.resourceUpdated(uri);
  };

  app.post('/mcp', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      if (!isJsonContentType(req.headers['content-type'])) {
        sendJsonRpcError(
          res,
          415,
          JSONRPC_SERVER_ERROR,
          'Unsupported Media Type: Content-Type must be application/json',
        );
        return;
      }
      const parsedBody = req.body as unknown;
      if (parsedBody === undefined) {
        // Undefined tells the Node adapter to read the raw stream without our parser's limit.
        sendJsonRpcError(res, 400, ProtocolErrorCode.ParseError, 'Invalid JSON in request body');
        return;
      }
```

`src/transport/http.ts:250` — `app.use(errorHandlerMiddleware);` is mounted
app-wide at the end; it maps body-parser `err.status === 413` / `400` to
JSON-RPC envelopes (lines 53-73). It keeps working unchanged when the parser
moves to route level, because a route-level middleware error still reaches
app-level error handlers.

What `createMcpExpressApp` does today — the installed implementation,
`node_modules/@modelcontextprotocol/express/dist/index.mjs:134-151`:

```js
function createMcpExpressApp(options = {}) {
  const { host = '127.0.0.1', allowedHosts, allowedOrigins, jsonLimit } = options;
  const app = express();
  if (allowedHosts) app.use(hostHeaderValidation(allowedHosts));
  else if (['127.0.0.1', 'localhost', '::1'].includes(host)) app.use(localhostHostValidation());
  else if (host === '0.0.0.0' || host === '::')
    console.warn(`Warning: Server is binding to ${host} without DNS rebinding protection. ...`);
  if (allowedOrigins) app.use(originValidation(allowedOrigins));
  else if (['127.0.0.1', 'localhost', '::1'].includes(host)) app.use(localhostOriginValidation());
  app.use(express.json(jsonLimit ? { limit: jsonLimit } : void 0));
  return app;
}
```

The three middlewares are public exports of the installed package
(`node_modules/@modelcontextprotocol/express/dist/index.d.mts:91,123,133`):

```ts
declare function hostHeaderValidation(allowedHostnames: string[]): RequestHandler;
declare function originValidation(allowedOriginHostnames: string[]): RequestHandler;
declare function localhostOriginValidation(): RequestHandler;
```

Each answers a refusal with HTTP 403 and
`{ jsonrpc: '2.0', error: { code: -32000, message }, id: null }`.

How this server's inputs map onto that logic (so the replacement is exact):

- `allowedHosts` comes from `resolveAllowedHosts` (`http-policy.ts:147-156`).
  It is non-empty for every loopback and concrete bind, and empty only for a
  wildcard bind under `FS_ALLOW_UNRESTRICTED_HOSTS` — the case where the SDK
  merely `console.warn`s and this server already logs its own warning
  (`http.ts:104-108`). So the Host rule reduces to: **mount
  `hostHeaderValidation(allowedHosts)` when the list is non-empty, nothing
  otherwise.**
- `allowedOriginHostnames` comes from `computeAllowedOriginHostnames`
  (`http-policy.ts:316-322`): the loopback default when `FS_ALLOWED_ORIGINS`
  is unset, the parsed list when set, and `[]` only for an all-blank value such
  as `" , "`. The documented behavior for that `[]` case
  (`http-policy.ts:79-83`) is "a loopback bind keeps the SDK's localhost
  default … a concrete or wildcard bind then mounts no Origin gate". So the
  Origin rule is: **non-empty list → `originValidation(list)`; empty list on a
  loopback bind → `localhostOriginValidation()`; otherwise nothing.** Use this
  repo's `isLoopbackHttpHost` (exported from `http-policy.ts:56`) as the
  loopback test. It also accepts `[::1]` and upper-case spellings, so it
  mounts the localhost gate in two edge spellings the SDK's literal list
  misses. That is a deliberate fail-safe tightening.

Conventions to match:

- Separate value and type imports from the same module are the house style
  (ESLint `no-duplicate-imports` with `allowSeparateTypeImports`, and
  `consistent-type-imports` with `separate-type-imports`). Precedent in this
  very file, `http.ts:14-15`:

  ```ts
  import type { Server } from 'node:http';
  import { createServer as createHttpServer } from 'node:http';
  ```

- Import order is enforced by Prettier's sort-imports plugin
  (`@modelcontextprotocol/*` first, then node builtins, then third-party, then
  relative; specifiers sorted case-insensitively). `npx prettier --write` on
  the file fixes ordering; do not hand-tune it.
- Comments in this file explain _why_ in full sentences; keep that style and
  keep the existing `jsonLimit` rationale comment (move it with the parser).

## Commands you will need

| Purpose       | Command                                                | Expected on success |
| ------------- | ------------------------------------------------------ | ------------------- |
| Static check  | `npm run check:static`                                 | exit 0              |
| All tests     | `npm test`                                             | all pass            |
| One test      | `npm test -- --test-name-pattern="<part of its name>"` | that test passes    |
| Format a file | `npx prettier --write <file>`                          | exit 0              |

`npm run check:static` = build + `tsc -p tsconfig.test.json` + eslint
(`--max-warnings=0`) + `prettier --check .` + knip. `npm test` is
`node --test`; native flags go after `--`.

## Scope

**In scope** (the only files you should modify):

- `src/transport/http.ts`
- `src/transport/http-policy.ts` — the two doc comments at lines 75 and 328
  only
- `__tests__/http-server.test.ts`
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `corsMiddleware`, `createRateLimiter`, `bearerAuthMiddleware`,
  `resolveAllowedHosts`, `computeAllowedOriginHostnames` logic — their
  behavior must stay byte-identical; only their mount order relative to the
  parser changes.
- The `errorHandlerMiddleware` mapping (413 → `-32600`, 400 → `-32700`) —
  existing tests pin it.
- The route order inside `/mcp` other than inserting the parser into
  `app.post('/mcp', …)`.
- The SDK `maxRequestBodySize` option on `toNodeHandler` / `createMcpHandler`
  — `parsedBody` is always supplied, so those bounds are never reached;
  a previous plan decided to leave them at their defaults.
- Any `@modelcontextprotocol/*` or `express` version.

## Git workflow

- Branch: `advisor/013-http-parse-after-auth` from `main`.
- Commit per step, conventional-commit style matching the log, for example
  `test(http): pin Host/Origin gates before app assembly change` and
  `fix(http): parse JSON bodies after rate limiting and auth`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pin the Host and Origin gates with characterization tests

`__tests__/http-server.test.ts` has no live-server test for the Host header
gate, and none for the default (no `FS_ALLOWED_ORIGINS`) Origin gate. Add them
**before** changing the app assembly so Step 3 cannot silently drop a gate.

Inside the existing `describe('Real HTTP Server integration', …)` block (it
boots a loopback server with the API key via `bootHttpTest`; `port` and `base`
are set in its `beforeEach`), add:

```ts
async function requestWithHost(
  path: string,
  method: 'GET' | 'POST',
  host: string,
): Promise<{ status: number | undefined; body: unknown }> {
  const response = Promise.withResolvers<{ status: number | undefined; body: unknown }>();
  const req = request(
    {
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        host,
        authorization: ['Bearer', TEST_API_KEY].join(' '),
        'content-type': 'application/json',
      },
    },
    (res) => {
      void json(res).then(
        (body: unknown) => response.resolve({ status: res.statusCode, body }),
        response.reject,
      );
    },
  );
  req.on('error', response.reject);
  req.end(method === 'POST' ? '{}' : undefined);
  return response.promise;
}

for (const [method, path] of [
  ['POST', '/mcp'],
  ['GET', '/healthz'],
] as const) {
  it(`refuses a foreign Host header on ${method} ${path} with 403`, async () => {
    const result = await requestWithHost(path, method, 'evil.example');
    assert.strictEqual(result.status, 403);
    assert.strictEqual((result.body as { error?: { code?: number } }).error?.code, -32000);
  });
}

it('refuses a foreign Origin on POST /mcp with 403 under the loopback default', async () => {
  const r = await fetch(base, {
    method: 'POST',
    headers: {
      origin: 'http://evil.example',
      'content-type': 'application/json',
      authorization: ['Bearer', TEST_API_KEY].join(' '),
    },
    body: '{}',
  });
  assert.strictEqual(r.status, 403);
  const body = (await r.json()) as { error?: { code?: number } };
  assert.strictEqual(body.error?.code, -32000);
});
```

`request` and `json` are already imported at the top of the file
(`node:http`, `node:stream/consumers`).

**Verify**: `npm test -- --test-name-pattern="foreign"` → 3 tests pass
(these pin **current** behavior; they must pass before any source change).

### Step 2: Add the regression tests (they must fail now)

Still in `__tests__/http-server.test.ts`:

1. In the `describe('Real HTTP Server integration', …)` block, next to the
   existing `'authenticates an unsupported upload before rejecting its content type'`
   test (around line 178), add:

   ```ts
   it('authenticates an unfinished JSON upload before reading its body', async () => {
     const result = await postWithoutEndingUpload(
       base,
       { 'content-type': 'application/json', 'content-length': 1024 * 1024 },
       (req) => {
         req.flushHeaders();
         req.write('{');
       },
     );
     assert.strictEqual(result.status, 401);
     assert.deepStrictEqual(result.body, {
       jsonrpc: '2.0',
       id: null,
       error: { code: -32000, message: 'Unauthorized' },
     });
   });
   ```

   The declared length (1 MiB) is deliberately **below** the 4 MiB parser
   limit: a length above it would be refused with 413 up front and prove
   nothing.

2. In the `describe('rate limiting', …)` block (it boots with
   `FS_RATE_LIMIT_RPM: '2'`), add:

   ```ts
   it('rate-limits an unfinished JSON upload before reading its body', async () => {
     const headers = {
       'content-type': 'application/json',
       Authorization: `Bearer ${TEST_API_KEY}`,
     };
     // Spend the two-request budget on quick, complete requests.
     await (await fetch(base, { method: 'POST', headers, body: '{}' })).text();
     await (await fetch(base, { method: 'POST', headers, body: '{}' })).text();
     const result = await postWithoutEndingUpload(
       base,
       { ...headers, 'content-length': 1024 * 1024 },
       (req) => {
         req.flushHeaders();
         req.write('{');
       },
     );
     assert.strictEqual(result.status, 429);
   });
   ```

**Verify**: `npm test -- --test-name-pattern="unfinished JSON upload"` →
both new tests **fail** with
`No response before the unfinished upload deadline` (today the app-wide
parser waits for the whole body before auth or the limiter can answer).
If either passes on the unmodified source, STOP (see STOP conditions).

### Step 3: Assemble the app from the SDK middlewares and mount the parser on POST /mcp

In `src/transport/http.ts`:

1. Replace the import at line 3 with the three middlewares, and add a value
   import of express next to the existing type import:

   ```ts
   import {
     hostHeaderValidation,
     localhostOriginValidation,
     originValidation,
   } from '@modelcontextprotocol/express';
   ...
   import express from 'express';
   import type { Express, NextFunction, Request, Response } from 'express';
   ```

   Add `isLoopbackHttpHost` to the existing `./http-policy.ts` import list.

2. Replace the `createMcpExpressApp({...})` call (lines 89-97) with:

   ```ts
   // Assembled from the SDK's own gates rather than `createMcpExpressApp`,
   // which mounts `express.json()` for the whole app: that would parse every
   // body before the rate limiter and bearer auth below can refuse it. Host
   // and Origin validation still run first and app-wide, mounted by the same
   // rules `createMcpExpressApp` applies to these inputs; the parser moves
   // onto the POST /mcp route, after auth.
   const app = express();
   if (allowedHosts.length > 0) app.use(hostHeaderValidation([...allowedHosts]));
   if (allowedOriginHostnames.length > 0) {
     app.use(originValidation([...allowedOriginHostnames]));
   } else if (isLoopbackHttpHost(httpHost)) {
     // An all-blank FS_ALLOWED_ORIGINS on a loopback bind keeps the localhost
     // default (see isOriginAllowed in http-policy.ts).
     app.use(localhostOriginValidation());
   }
   ```

3. Mount the parser on the POST route only, keeping the existing `jsonLimit`
   rationale comment with it. Change the route opening at line 153 from
   `app.post('/mcp', (req: Request, res: Response, next: NextFunction) => {`
   to:

   ```ts
   // The express parser limit derives from the SDK's own request-body
   // bound, so it and the adapter/handler-core defaults
   // (`DEFAULT_MAX_REQUEST_BODY_SIZE`, 4 MiB in 2.1.0) cannot drift apart.
   // Mounted here, after CORS, the rate limiter and auth, so a refused
   // request is answered without its body being read.
   const parseJson = express.json({ limit: `${DEFAULT_MAX_REQUEST_BODY_SIZE}b` });

   app.post('/mcp', parseJson, (req: Request, res: Response, next: NextFunction) => {
   ```

   Nothing else in the route body changes. `express.json`'s defaults
   otherwise match what `createMcpExpressApp` mounted (it passed only
   `limit`).

4. Leave the `if (allowedHosts.length === 0) Logger.warn(...)` block
   (lines 104-108) in place. It is now the only warning for that case; the
   SDK's duplicate `console.warn` goes away with `createMcpExpressApp`.

5. Run `npx prettier --write src/transport/http.ts`.

**Verify**:

- `npm run check:static` → exit 0 (tsc, eslint, prettier, knip all clean).
- `npm test -- --test-name-pattern="unfinished JSON upload"` → both Step 2
  tests now pass.
- `npm test -- --test-name-pattern="foreign"` → the 3 Step 1 tests still pass.

### Step 4: Update the two stale doc comments in http-policy.ts

`src/transport/http-policy.ts` names `createMcpExpressApp` in two comments
that describe behavior now provided by the individual middlewares:

- Line 75: "`allowedHostnames` is the same hostname-form list
  `createMcpExpressApp` receives as `allowedOrigins`" → change to "the same
  hostname-form list `originValidation` receives in `http.ts`".
- Line 328: "because `createMcpExpressApp`'s `allowedOrigins` only gates which
  Origins are accepted" → change to "because the SDK's `originValidation`
  gate only decides which Origins are accepted".

Do not change any code in this file.

**Verify**: `grep -rn "createMcpExpressApp" src/` → no matches.
`npx prettier --check src/transport/http-policy.ts` → exit 0.

### Step 5: Full gate

**Verify**: `npm run check` → exit 0; every test passes, including the 5 new
ones (3 from Step 1, 2 from Step 2).

## Test plan

- New tests (all in `__tests__/http-server.test.ts`):
  - Host gate: `POST /mcp` and `GET /healthz` with `Host: evil.example` → 403,
    `error.code === -32000` (characterization, passes before and after).
  - Origin gate under the loopback default: `Origin: http://evil.example` →
    403 (characterization).
  - Unauthenticated unfinished JSON upload (1 MiB declared, 1 byte sent) → 401
    before the upload ends (regression; fails before Step 3).
  - Rate-limited unfinished JSON upload → 429 before the upload ends
    (regression; fails before Step 3).
- Pattern to follow: the existing
  `'authenticates an unsupported upload before rejecting its content type'`
  test and the `postWithoutEndingUpload` helper in the same file.
- Existing tests that must keep passing unchanged and that pin the parser's
  behavior: `'5. POST /mcp with an oversized body -> 413'`,
  `'6. POST /mcp with malformed JSON -> 400 ParseError'`,
  `'rejects an unframed empty JSON request before raw conversion'`,
  `'preserves InvalidRequest for JSON with an explicit zero content length'`,
  the two `rejects an unfinished … upload before reading its body` 415 tests,
  and `TC-SEC-031b` in `__tests__/http-policy.test.ts`.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] The 5 new tests exist and pass
- [ ] `grep -rn "createMcpExpressApp" src/` returns no matches
- [ ] `grep -n "express.json" src/transport/http.ts` returns exactly one
      match, and it is not passed to `app.use(`
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 013 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows an in-scope file changed and the excerpts no longer
  match.
- Any Step 1 characterization test fails on the **unmodified** source — the
  gates do not behave as this plan describes, and replacing them would be
  guesswork.
- Either Step 2 regression test passes on the unmodified source — the
  premise (app-wide parse before auth) is false; report what you observed.
- `import express from 'express'` does not type-check under the repo's
  `NodeNext` + `verbatimModuleSyntax` settings. Report the tsc error; do not
  switch to `require` or `createRequire`.
- Any existing HTTP test changes status code or body after Step 3. The
  intended behavior changes are listed in "Why this matters"; anything else
  is a regression.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Reviewer focus**: the Host/Origin mounting rules in Step 3 must stay
  equivalent to `createMcpExpressApp`'s for this server's inputs (see
  "Current state"). The single intended divergence is using
  `isLoopbackHttpHost` for the empty-origin-list fallback.
- On the next `@modelcontextprotocol/express` bump, diff the new
  `createMcpExpressApp` source against Step 3's assembly. If the SDK adds a
  gate there (for example a new header check), this app must add it by hand
  — it no longer inherits changes to that factory.
- Any future route that needs a parsed JSON body must mount `parseJson`
  itself (or its own parser) after auth. Do not reintroduce an app-wide
  `app.use(express.json())`.
- Deferred: capping per-request parse cost for **authenticated** callers
  below 4 MiB. The operator key is trusted, and the limit derives from the
  SDK default on purpose.
