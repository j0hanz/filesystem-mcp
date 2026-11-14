# Plan 116: The HTTP server bounds how many request bytes it parses at once

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/transport/http.ts src/transport/http-policy.ts src/core/util.ts __tests__/http-server.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (normal clients send one large request at a time)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

One HTTP request body may be as large as three times the file-size limit
plus 1 MiB: about 31 MiB by default, about 301 MiB when `FS_MAX_FILE_SIZE`
is raised to its 100 MiB maximum. Each body is buffered whole and then
parsed, and the parsed object costs several times the raw size. The only
throttle is requests per minute (120 with a key, 6,000 without). Nothing
limits how many bodies are in memory at the same moment, so a handful of
parallel near-limit POSTs, from a key holder or from any local process on a
keyless server, can exhaust the heap and crash the process. `SECURITY.md`
promises "no input can crash or hang the server".

## Current state

`src/transport/http.ts:174-185`:

```ts
  // One bound for both transports, derived from the write tools' own limit
  // (getMaxInboundMessageBytes): a create the schema accepts must not be
  // refused here. Mounted after CORS, the rate limiter and auth, so a refused
  // request is answered without its body being read. ...
  const parseJson = express.json({ limit: `${String(getMaxInboundMessageBytes())}b` });

  app.post('/mcp', parseJson, (req: Request, res: Response, next: NextFunction) => {
```

`src/core/util.ts:97-99`:

```ts
export function getMaxInboundMessageBytes(): number {
  return 3 * getMaxTextFileSize() + MIB;
}
```

Middleware order on `/mcp` today: CORS → rate limiter → bearer auth →
`parseJson` → handler. `sendJsonRpcError(res, status, code, message, id?, headers?)`
is the helper for refusals; see its use at `src/transport/http.ts:255-259`:

```ts
sendJsonRpcError(res, 405, JSONRPC_SERVER_ERROR, 'Method not allowed.', null, {
  Allow: 'POST, OPTIONS',
});
```

The rate limiter in `src/transport/http-policy.ts` (`createRateLimiter`,
around line 390) is the exemplar for a small stateful middleware exported
from that file and unit-tested in `__tests__/http-policy.test.ts`.

HTTP test helper: `bootHttpTest([dir], env)` in `__tests__/http-server.test.ts`
returns `{ base, close }`; the `rate limiting` describe (line 601) shows its
use, and `postWithoutEndingUpload(base, headers, write)` shows how to hold a
request open without finishing its body.

## Design (fixed by this plan)

A middleware `createBodyBudget(budgetBytes)` in `src/transport/http-policy.ts`:

- Per request, the cost is the `Content-Length` header as an integer. A
  missing or invalid header costs `getMaxInboundMessageBytes()` (the most the
  parser would accept).
- Requests costing less than 1 MiB pass without accounting. Ordinary tool
  calls are small, and this keeps them out of the path entirely.
- If `inFlight + cost > budgetBytes`, answer `503` with a `Retry-After: 1`
  header and a JSON-RPC error body, without reading the body.
- Otherwise add `cost` to `inFlight`, and subtract it exactly once when the
  response emits `close`.
- Budget: `Math.max(getMaxInboundMessageBytes(), 128 * MIB)`. One maximum
  body always fits; at the default limit about four fit.

No new setting. A fixed budget is enough until someone needs to tune it.

## Commands you will need

| Purpose    | Command                                                          | Expected on success |
| :--------- | :--------------------------------------------------------------- | :------------------ |
| Build      | `npm run build`                                                  | exit 0              |
| Policy     | `node --test --test-timeout=60000 __tests__/http-policy.test.ts` | all pass            |
| Server     | `node --test --test-timeout=60000 __tests__/http-server.test.ts` | all pass            |
| Full check | `npm run check`                                                  | exit 0              |

## Scope

**In scope**:

- `src/transport/http-policy.ts` (new exported `createBodyBudget`)
- `src/transport/http.ts` (mount it before `parseJson` on `POST /mcp`)
- `__tests__/http-policy.test.ts` (unit tests)
- `__tests__/http-server.test.ts` (one wire test)
- `docs/configuration.md` (one sentence in the HTTP section)
- `CHANGELOG.md`, `plans/README.md`

**Out of scope**:

- The stdio transport.
- The rate limiter, the body size limit itself, `getMaxInboundMessageBytes`.
- A new `FS_*` variable or CLI flag.

## Git workflow

- Branch: `fix/http-body-budget`
- Two commits: `feat(http): bound request bytes in flight`, then `test(http): cover the body budget`.
  Or one commit if you prefer; keep the conventional style.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Unit tests first

In `__tests__/http-policy.test.ts`, add `describe('body budget', ...)`. Drive
the middleware with minimal fakes: a `req` with `headers`, a `res` that is an
`EventEmitter` with `status()`, `set()`/`header()`, `json()`/`end()` spies
(look at how the rate limiter tests in the same file fake `req`/`res` and
copy that shape). Cases:

1. A 100-byte request calls `next()` and holds no budget.
2. Two requests of 80 MiB against a 128 MiB budget: the first calls `next()`,
   the second gets 503 with `Retry-After`.
3. After the first response emits `close`, a third 80 MiB request calls `next()`.
4. A request with no `Content-Length` is charged the fallback cost passed to
   the factory.
5. `close` emitted twice releases once (a later request is still bounded).

**Verify**: the tests fail to compile or fail (no `createBodyBudget` yet).

### Step 2: Implement `createBodyBudget`

In `src/transport/http-policy.ts`, export:

```ts
/**
 * Bounds the request bytes being buffered and parsed at once: each body is held
 * whole, so a few parallel near-limit uploads could otherwise exhaust the heap.
 */
export function createBodyBudget(budgetBytes: number, unknownCost: number): RequestHandler;
```

Follow the design section. Use the same `sendJsonRpcError` helper and error
code constant the rate limiter uses for its 429. Message:
`'Server busy: too many large requests in flight. Retry shortly.'`.

**Verify**: `node --test --test-timeout=60000 __tests__/http-policy.test.ts` → all pass.

### Step 3: Mount it

In `src/transport/http.ts`, create the middleware beside `parseJson` and put
it before `parseJson` in the `app.post('/mcp', ...)` argument list:

```ts
  const bodyBudget = createBodyBudget(
    Math.max(getMaxInboundMessageBytes(), 128 * MIB),
    getMaxInboundMessageBytes(),
  );

  app.post('/mcp', bodyBudget, parseJson, (req, res, next) => {
```

Import `MIB` from `../core/util.ts` (it is exported there; confirm with
`grep -n "export const MIB" src/core/util.ts`).

**Verify**: `npm run build` → exit 0.

### Step 4: Wire test

In `__tests__/http-server.test.ts`, add a test that boots the server with
`bootHttpTest([tmpDir], { FS_MAX_FILE_SIZE: <value giving a body limit near 80 MiB> })`.
Check how `FS_MAX_FILE_SIZE` is parsed (`src/core/config.ts`, around line 104) to choose a valid value. Open two uploads with `postWithoutEndingUpload`
declaring `content-length` of 70 MiB each and writing one byte; then send a
third the same way and assert its status is 503. End or destroy the held
requests in a `finally`.

**Verify**: `node --test --test-timeout=60000 __tests__/http-server.test.ts` → all pass.

### Step 5: Docs, changelog, full check

In `docs/configuration.md`, in the "The server enforces these safety rules"
list, add:

```md
- Large request bodies are bounded in total: when the bodies being received
  add up to more than 128 MiB (or one maximum-size body, if that is larger),
  further large requests get `503` with `Retry-After` until one finishes.
```

`CHANGELOG.md` → `## [Unreleased]` → `### Security`:

```md
- **HTTP**: the request bytes being received at once are bounded; further large requests get `503` until one finishes. Before, a few parallel maximum-size bodies could exhaust the server's memory.
```

**Verify**: `npm run check` → exit 0.

## Test plan

Five unit tests (Step 1) and one wire test (Step 4).

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "bodyBudget, parseJson" src/transport/http.ts` prints one line
- [ ] `git diff --stat` lists only in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

- The SDK handler reads the raw body itself for some requests (the comment
  at `src/transport/http.ts:174-181` says it does not when `parsedBody` is
  supplied; if you find a path where it does, report it).
- `res.once('close')` does not fire for a request refused by `parseJson`
  with 413 (then the budget would leak; test this case and report if so).
- The wire test needs more than 10 seconds or more than 200 MiB of memory.

## Maintenance notes

- The cost is the declared length, not the bytes received, so a client that
  declares a large body and sends slowly holds budget until the socket
  closes. The server's request timeout bounds that.
- If several large legitimate uploads in parallel become a real use, make
  the budget a Setting through `src/core/config.ts` (ADR-017).
