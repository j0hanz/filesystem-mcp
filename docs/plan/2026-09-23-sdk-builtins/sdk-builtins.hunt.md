# SDK built-ins audit (2026-09-23)

Audit of filesystem-mcp against the MCP TypeScript SDK v2 docs
(https://ts.sdk.modelcontextprotocol.io/v2/llms-full.txt, read in full for every
server-side page) and the installed packages. Written against commit
`b4c97e21` (v2.4.1).

Installed: `@modelcontextprotocol/server`, `node`, `express`, `client` — all
`2.0.0`. Every documented server API exists in 2.0.0 except `scopeChallenge`
and `requireScopes` (documented at
https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.md#enforce-per-operation-scopes,
zero hits in the installed `.d.mts`; the migration page names no shipping
version).

## Findings in scope

### F1. `resources/subscribe` routes URIs with an OAuth audience check (bug)

`src/resources.ts:487-495` decides which resource contract owns a subscribe or
unsubscribe URI with `checkResourceAllowed` + `resourceUrlFromServerUrl`.
`checkResourceAllowed` is an RFC 8707 resource-indicator check that compares
`URL.origin`. For every non-special URL scheme the origin is the opaque string
`"null"`, so the origin comparison always passes and only a path-prefix test
remains. Probed against the installed SDK:

| URI                              | owns file? | owns result? | owns instructions? |
| -------------------------------- | ---------- | ------------ | ------------------ |
| `filesystem-mcp://result/abc`    | true       | true         | true               |
| `internal://instructions`        | false      | false        | true               |
| `other://file/x`                 | true       | true         | true               |
| `filesystem-mcp://evil/x`        | true       | true         | true               |

Observed over a real client (`createTestClientPair`):

| subscribe URI                 | today                                                          | intended                                          |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| `filesystem-mcp://result/abc` | `ResourceNotFoundError -32602 "Cannot subscribe: not a filesystem URI"` | `ProtocolError -32602 "... does not support subscriptions ..."` (`resources.ts:505-509`) |
| `other://file/x`              | `ResourceNotFoundError "Cannot subscribe: not a filesystem URI"` | `ResourceNotFoundError "Resource not found: other://file/x"` |
| `not a uri`                   | `ProtocolError -32603 "Invalid URL"` (thrown by `new URL`)      | `ResourceNotFoundError -32602`                    |

No test covers the "does not support subscriptions" message.

Built-in: `UriTemplate#match` (exported from `@modelcontextprotocol/server`,
`createMcpHandler-CLhGwQTn.d.mts:2680`) — the matcher `ResourceTemplate` wraps
and the SDK dispatches `resources/read` with. Doc:
https://ts.sdk.modelcontextprotocol.io/v2/servers/resources.md#add-a-resource-template

### F2. CORS reflection disagrees with the SDK Origin gate

`src/transport/http-policy.ts:48,64-95` reflects `Access-Control-Allow-Origin`
for any localhost origin unconditionally (`LOCALHOST_ORIGIN_RE`,
`isAllowedLocalhostOrigin`), plus the `FS_ALLOWED_ORIGINS` list. But
`createMcpExpressApp` validates `Origin` first, with `validateOriginHeader`
over the same list passed as `allowedOrigins`, and a configured list
*replaces* the localhost default. Probed with
`createMcpExpressApp({ host: '127.0.0.1', allowedOrigins: ['app.example.com'] })`:

| method  | Origin                    | status |
| ------- | ------------------------- | ------ |
| OPTIONS | `http://localhost:5173`   | 403    |
| POST    | `http://localhost:5173`   | 403    |
| POST    | `https://app.example.com` | 204    |

So the "localhost always accepted" branch is unreachable whenever
`FS_ALLOWED_ORIGINS` is set, and when it is unset the list already is
`localhostAllowedHostnames()`. The doc comment at `http-policy.ts:82-90`
claims otherwise.

Built-in: `validateOriginHeader` + `localhostAllowedHostnames`
(`@modelcontextprotocol/server`, runtime at `index.mjs:1680`). Doc:
https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard.md#protect-against-dns-rebinding
and the "Server (deprecated accessors and app-factory Origin validation)"
section of https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.md

### F3. Capability flags McpServer already advertises

`src/server.ts:85-87` declares `tools: {}`, `prompts: {}`, `completions: {}`.
`McpServer` advertises all three from registration (`tools`/`prompts` with
`listChanged: true`; `completions` from the first `completable` or template
`complete`). Probed: `getCapabilities()` is identical with and without the
three keys. `resources` must stay declared — `subscribe` is never inferred, and
the legacy-HTTP instance deliberately sets `listChanged: false`.

Docs: https://ts.sdk.modelcontextprotocol.io/v2/servers/notifications.md#advertise-the-listchanged-capability,
https://ts.sdk.modelcontextprotocol.io/v2/servers/completion.md#wrap-an-argument-with-completable

### F4. The listen body is parsed twice

`src/transport/shared.ts:36-39` validates a `subscriptions/listen` body with
`specTypeSchemas.SubscriptionsListenRequest`, discards the parsed value, and
`:61-73` re-walks the raw body with casts to read `resourceSubscriptions`.
The validator is synchronous and returns the typed value
(`result.value.params.notifications.resourceSubscriptions: string[] | undefined`,
type-checked against 2.0.0). One function can return the URIs of a valid
listen and `undefined` for anything else.

Doc: https://ts.sdk.modelcontextprotocol.io/v2/advanced/wire-schemas.md

## Considered and left out of the plan

- **stdio `Transport` decorator** (replace the post-`serveStdio` patches at
  `stdio.ts:222-263` with a class passed as `serveStdio({ transport })`,
  https://ts.sdk.modelcontextprotocol.io/v2/advanced/custom-transports.md).
  Net line count is about even, and the only gain is independence from
  `serveStdio`'s install order — which `stdio.ts:257` already asserts, so an
  SDK change fails loudly at startup. Revisit if that assertion ever fires.
- **`droppedInputResponseKeys`** (`createMcpHandler-CLhGwQTn.d.mts:2124`).
  The audit first proposed re-asking a confirmation whose answer the SDK
  dropped as a wrapped `{method, result}` shape. That loops: a peer that wraps
  once wraps every round, so the user is prompted until the round cap
  (8 shim / 10 client) fails the call — worse than today's one-round
  `CANCELLED: not answered`. A diagnostic-only variant has no reported case
  behind it.
- **`icons` on `Implementation`** — needs an icon asset nobody has asked for.
- **`scopeChallenge` / `requireScopes`** — needs an SDK upgrade and a move from
  one static `API_KEY` to scoped, verifier-issued tokens.
- **No SDK equivalent (keep):** listen-filter watcher attach, `ProgressSession`,
  `TtlLru` stores, tool-result cursors, rate limiter, CORS header reflection
  itself, the 405 with `Allow`, `assertCanElicit`.
- **Justified hand-rolls:** `bearerAuthMiddleware` (the SDK's `verifyBearerToken`
  answers a missing header `invalid_token` and requires `expiresAt`,
  `index.mjs:1401,1408`); the protected-resource metadata route
  (`oauthMetadataResponse` / `mcpAuthMetadataRouter` need authorization-server
  metadata this server does not have); sessionful legacy HTTP (rejected in
  `docs/adr/003-http-serves-2025-era-clients-statelessly.md`).
