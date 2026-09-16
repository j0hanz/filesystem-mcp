# Design: issued-token auth on the SDK resource-server helpers

> Spike for plan 006. Baseline commit `e1489b1a`. No production code changed —
> the prototype described here was written and tested as uncommitted edits in
> a worktree, measured, then discarded (`git checkout -- src __tests__`). The
> `--stat` and behavior captured below are the record of that run.

## Inventory

Single-credential assumptions found by the plan's greps, each with what
breaks once the HTTP endpoint has more than one principal.

| File:line | What it assumes | What breaks with N principals |
| --- | --- | --- |
| `src/transport/http.ts:290` (`const sharedPathGuard = new PathGuard(options)`) and the comment at `http.ts:282-289` | One `PathGuard` for the whole endpoint; grants accepted via `applyGrant` extend `grantedDirectories` for every caller for the guard's lifetime, because a per-request guard would discard every accepted grant the instant the modern per-request `McpServer` closes. | A grant principal A accepts (e.g. widening into `/home/alice/private`) becomes readable by principal B on the very next call — the comment's own words: "Split into per-auth-context guards if this ever serves more than one credential." |
| `src/transport/http.ts:278-281` (`const sharedStore = new ResourceStore(...)`) | One `ResourceStore` for the whole endpoint, same one-credential argument as the guard. | `store.ts:87` `getEntry(uri)` and `:146` `keys()` have no notion of caller — any bearer that knows (or lists) a `putText`-issued UUID URI can read another principal's externalized tool output. |
| `src/transport/http.ts:281` (`const sharedPageStore = new PageSnapshotStore()`) | One `PageSnapshotStore` for the whole endpoint. | `page-store.ts:67` `create(...)` returns a snapshot UUID; `:86` `read<T,M>(snapshotId, queryKey)` accepts any snapshot ID from any caller — same exposure as the resource store, cursor-shaped instead of URI-shaped. |
| `src/transport/http.ts:270` (`const sharedRegistry = createWatcherRegistry()`) | One watcher registry for the whole endpoint. | Nothing breaks: delivery is per SSE stream (see "Watcher registry" below), so this one is safe as-is. |
| `src/transport/http-policy.ts:274-310` (`bearerAuthMiddleware`) | Exactly one valid credential (`apiKey`); every successful auth sets `req.auth = { token, clientId: 'api-key', scopes: [] }` — a fixed, non-distinguishing `clientId`. | Nothing today reads `clientId` to separate callers, so this is the reason the stores above collapse to "one caller" rather than "N callers with one fixed label" — there is no per-principal key to shard on yet. |
| `src/server.ts:86` (`const cacheScope: 'private' | 'public' = extraDeps?.apiKey ? 'private' : 'public'`) | `'private'` already means "scoped to whichever single credential this bind trusts," not "scoped to this specific principal." | Not wrong with issued tokens (see "Cache hints" below), but its meaning quietly narrows from "the one caller" to "any of N callers" unless the transport also separates HTTP caches per principal — no code here does that today. |

## Prototype findings

**What changed.** In `src/transport/http.ts` line 147, `bearerAuthMiddleware`
was replaced with a new `spikeRequireBearerAuthMiddleware` (added to
`src/transport/http-policy.ts`) that wraps `requireBearerAuth` from
`@modelcontextprotocol/express` with a hand-written `OAuthTokenVerifier`
(`spikeStaticKeyVerifier`) that still checks the static `API_KEY` via the
existing `validateBearerAuthorization`/`timingSafeEqual` path, but returns an
`AuthInfo` with a synthetic `expiresAt: Number.MAX_SAFE_INTEGER / 1000` —
required because `verifyBearerToken` (which `requireBearerAuth` calls
internally) rejects any `AuthInfo` with no `expiresAt` ("Token has no
expiration time"), exactly as the plan's SDK facts said. No introspection
verifier was prototyped: the static-key path alone was enough to see the
behavior change the plan asked about, and adding a second verifier would not
have changed what broke.

Diff size (`src` + `__tests__` only; the design doc's own directory is
excluded since it did not exist yet when the diff was taken):

```
src/transport/http-policy.ts | 46 +++++++++++++++++++++++++++++++++++++++++---
src/transport/http.ts        |  5 +++--
2 files changed, 46 insertions(+), 5 deletions(-)
```

`npx tsc --noEmit` passed with no errors — the swap type-checks cleanly
against the installed SDK with no new dependency.

**Test run** (`npm test -- --test-name-pattern="http-policy|HTTP"`, 78 tests,
77 pass / 1 fail):

- `__tests__/http-server.test.ts` — **`authenticates an unsupported upload
  before rejecting its content type`** FAILED. Expected the JSON-RPC envelope
  `{ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } }`;
  got the SDK's OAuth error body `{ error: 'invalid_token', error_description:
  'Missing Authorization header' }`. This is the 401-body-shape break the plan
  predicted: `requireBearerAuth` always answers through
  `bearerAuthChallengeResponse`, which is OAuth-JSON, not this server's
  JSON-RPC convention.
- All 22 `__tests__/http-policy.test.ts` unit tests still PASSED, including
  the bare-vs-`invalid_token` challenge tests (TC-SEC-038–040). This is not
  evidence the split survived — it is a coverage gap: those tests call
  `bearerAuthMiddleware` directly as a unit, and that function was left in
  place (still exported, just no longer mounted at `http.ts:147`) so the
  spike wouldn't have to touch the test file to compile. The only test that
  exercises the *mounted* route through a real socket
  (`http-server.test.ts`) is the one that failed.
- `the apiKey option demands a bearer with API_KEY absent from the
  environment` (`http-server.test.ts`) still PASSED — it only asserts
  `/^Bearer /` on the challenge, which both the old and new middleware
  satisfy, so it did not catch the body-shape or challenge-content changes.
- Rate-limit ordering was unaffected: the rate limiter is mounted before the
  auth middleware at both `http.ts:115` (untouched) and in the spike, so nothing
  about that ordering changed and no test regressed on it.

**Confirmed by direct probe, not by a passing/failing test** (ad hoc script
run against the spike-patched server, output captured, then the script
deleted before discarding the spike):

```
NO AUTH  status=401 www-authenticate=Bearer error="invalid_token", error_description="Missing Authorization header"
BAD AUTH status=401 www-authenticate=Bearer error="invalid_token", error_description="Invalid or expired bearer token"
```

Both cases carry `error="invalid_token"`. The current hand-rolled
`buildAuthChallenge` (`http-policy.ts:243-259`) emits a bare `Bearer`
challenge (no `error=` param) for the no-credentials case and reserves
`error="invalid_token"` for a credential that was present but wrong — per RFC
6750 §3.1. `requireBearerAuth`/`bearerAuthChallengeResponse` does not make
that distinction (confirmed in the installed `@modelcontextprotocol/server`
type doc comments and now empirically): adopting it as-is silently drops a
behavior the plan and the codebase call out on purpose, and no existing test
would have caught it — the one test that checks the challenge shape only
checks the `Bearer ` prefix.

**Discarded**: all `src`/`__tests__` edits were reverted with
`git checkout -- src __tests__` before this document's commit; the working
tree was confirmed to match `e1489b1a` (`git diff --stat e1489b1a..HEAD --
src __tests__` empty) beforehand. There is no `spike/oauth-resource-server`
branch — the environment this spike ran in is a single worktree without the
two-branch setup the plan describes, so the prototype lived only as
uncommitted edits, per the executor's operating instructions. Nothing to
delete.

## PathGuard

**Chosen**: keep one baseline `PathGuard` built from `ServerOptions` (the
CLI-configured roots every principal starts with), and key *grants* by
principal — a lazily-built `Map<string, PathGuard>` (or equivalently, a
`Map<string, string[]>` of `grantedDirectories` consulted alongside the
shared baseline) where the key is `authInfo.clientId` from
`McpRequestContext.authInfo`, populated by the per-request factory
(`createMcpHandler(async ({ era }) => ...)` in `http.ts:293`, which already
has access to the request's `authInfo` per the SDK facts). A grant `A`
accepts via `applyGrant` writes only into `A`'s map entry; `B`'s guard
instance (or `B`'s slice of the merged allowed-directory computation) never
sees it. Idle principals are evicted the same way the existing `ResourceStore`
already ages out entries — a bounded map with a TTL/LRU sweep, not an
unbounded one, since a hostile client could otherwise mint clientIds to grow
the map forever.

**Rejected**: one `PathGuard` instance fully re-created per principal
(instead of "baseline + per-principal grant overlay"). Rejected because
`recomputeAllowedDirectories()` re-derives the CLI-configured baseline roots
from disk on construction (symlink resolution, existence checks — see
`path.ts` around `applyGrant`/`precheckAccess`), and doing that once per
distinct principal rather than once per process wastes the exact work the
current single shared instance was built to avoid; the baseline roots are
identical for every principal under one server process, only the grant
overlay differs.

## ResourceStore / PageSnapshotStore

**Chosen**: tag each entry with the owning principal at write time
(`putText`/`create` take or infer `clientId` and store it alongside the
existing `ResourceEntry`/`StoredPageSnapshot` fields) and make the read path
(`getEntry`/`read`) refuse a URI or snapshot ID that exists but belongs to a
different principal with **the same `FsError` the missing-key case already
returns** — not a distinct "forbidden" error. This is the one
security-relevant call in this document: returning a different error for
"exists but not yours" vs. "does not exist" would let a caller enumerate
another principal's live resource IDs by timing/error-shape, even though the
IDs themselves are unguessable UUIDs. Fail closed, uniformly.

**Rejected**: per-principal store instances (one `ResourceStore` and one
`PageSnapshotStore` per `clientId`, mirroring the `PathGuard` map). Rejected
because the memory bound (`MAX_ENTRIES = 64`, `MAX_TOTAL_BYTES = 25 * MIB` in
`store.ts`; `DEFAULT_MAX_SNAPSHOTS = 32` in `page-store.ts`) is sized for one
endpoint today; multiplying it by however many principals are concurrently
connected turns a fixed, reviewed cap into an unbounded one unless a second
layer of per-principal accounting is added anyway — at which point tagging
entries in one shared store is the same accounting with a smaller diff and a
single set of eviction/LRU code paths to reason about.

## Watcher registry

**Chosen**: unchanged, stays one shared `WatcherRegistry` for the endpoint.
**Justification**: delivery is already per SSE stream — `hasWatcher`/`size`/
`release` in `watcher-registry.ts` govern *how many* filesystem watches
exist, not *who* gets notified; the fan-out to a specific connection's
stream happens through the per-request `notifier`/subscription wiring
exercised by `__tests__/http-server.test.ts`'s "HTTP per-connection
subscription gating (cross-talk)" test, which already proves one subscriber
does not see another's notifications. The scarce resource here (`MAX_WATCHERS`)
is legitimately endpoint-wide, like an OS file-descriptor budget, not a
per-principal one — nothing about issued tokens changes that.

**Rejected**: per-principal watcher registries. Rejected because it would
either multiply `MAX_WATCHERS` per principal (reopening the same "unbounded
resource, unbounded principals" problem as the two stores above) or require
splitting one fixed budget across N principals up front, which is a real
design question but an orthogonal one — not required to close the
confidentiality gap the other two shared objects have, since watcher
delivery was never shared in the first place.

## Cache hints

**Chosen**: `cacheScope` stays `'private'` in both the current static-key
mode and a future issued-token mode — no change needed. `server.ts:86` sets
`cacheScope = extraDeps?.apiKey ? 'private' : 'public'`; issued-token mode
always has `apiKey`-equivalent credentials configured (the endpoint is never
keyless once an authorization server exists), so `cacheScope` is `'private'`
unconditionally in that mode. **Confirmed**, not just asserted: `'private'`
in the SDK's cache-hint vocabulary means "do not share this cached response
across different callers," which is exactly the property multi-principal
HTTP needs — it was already correct for the one-credential case (don't leak
a cached `tools/list` shaped by one operator's key to a different-key caller
on a shared proxy) and remains correct when "different callers" means
"different principals" instead of "possibly different keys presenting as the
same principal." No code change is implied by adopting issued tokens here.

## Legacy static key

**Chosen**: one middleware, two verifiers — adopt `requireBearerAuth` +
`OAuthTokenVerifier` for both the static-key and introspection cases, and
accept the OAuth-JSON 401 body as the new convention going forward. The
JSON-RPC 401 envelope (`sendJsonRpcError` used inside `bearerAuthMiddleware`
today) was this codebase's own convention, not a spec requirement — nothing
in RFC 6750 or the MCP spec requires a 401 auth failure to look like a
JSON-RPC error response, and every other 401-producing path in this server is
pre-JSON-RPC-parsing HTTP policy anyway (rate limiting, body-size, content
type). Keeping one hand-rolled middleware alive solely to preserve that
envelope shape, alongside a second SDK-based middleware for introspection,
means two auth code paths to maintain and test for the rest of this server's
life, for a body-shape difference no client is known to depend on.

**Rejected**: keep `bearerAuthMiddleware` hand-rolled for the static-key mode
and use `requireBearerAuth` only for introspection. Rejected primarily
because it is the higher-maintenance option (two auth pipelines, two sets of
tests, two `WWW-Authenticate` construction paths) for a benefit — preserving
today's exact 401 JSON shape and the bare-vs-`invalid_token` split — that is
a local convention rather than a contract this server has published to
anyone. If the maintainer answers "the bare-challenge split matters and must
survive," this recommendation flips: see Open questions.

## Recommendation

**Go/no-go: no-go now, go when an IdP exists.** There is no authorization
server in this deployment today, and `AuthMetadataOptions.oauthMetadata` (RFC
8414) is a hard SDK requirement for `mcpAuthMetadataRouter` — there is
nothing to point it at yet (see `http-policy.ts:203-212`, unchanged and still
accurate). Swapping the middleware now, with no verifier to plug in besides
the static key, buys nothing but the OAuth-JSON body-shape regression
measured above and a synthetic-expiry code smell, for zero new capability.
Adopt these SDK helpers as part of the same change that introduces a real
introspection or JWT verifier — not before.

**Effort estimate for the full change**, once an IdP is in scope:

- Middleware swap (`requireBearerAuth` + verifier(s), drop
  `bearerAuthMiddleware`, update `WWW-Authenticate`/401 tests): **S**
- Per-principal scoping (`PathGuard` grant map, tagged `ResourceStore`/
  `PageSnapshotStore` entries + refusal semantics, eviction policy for idle
  principals): **M**
- Docs and tests (`README.md` env var table, `src/cli-help.ts` `ENV_HELP`,
  `CHANGELOG.md`, new/updated `__tests__/http-policy.test.ts` and
  `__tests__/http-server.test.ts` cases for cross-principal isolation): **M**

## Open questions

1. Is multi-principal HTTP (more than one distinct bearer credential
   presenting to the same running server) an actual target deployment, or is
   "one operator key per process, restart to rotate" the permanent model?
   This decides whether the PathGuard/ResourceStore/PageSnapshotStore work in
   "Per-principal scoping" above is ever built.
2. Is adding `jose` (or an equivalent) acceptable if JWT verification is
   preferred over RFC 7662 introspection? The SDK ships neither; `fetch`-based
   introspection needs no new dependency, a local JWT verifier does.
   `package.json` currently carries none of `jose`/`jsonwebtoken`/similar.
3. Should the static-key mode keep the RFC 6750 bare-vs-`invalid_token`
   challenge split once `requireBearerAuth` is adopted, given the SDK
   collapses it to `invalid_token` unconditionally (measured above)? This is
   the one concrete behavior regression a middleware swap introduces today;
   an explicit answer here decides whether "Legacy static key" above (one
   middleware, accept the SDK's shape) is correct, or whether the
   hand-rolled challenge construction in `buildAuthChallenge` needs to be
   preserved and layered on top of `requireBearerAuth`'s output instead.

## Files a follow-up implementation plan would touch

- `src/transport/http-policy.ts` — replace `bearerAuthMiddleware` with a
  `requireBearerAuth`-based middleware and one or two `OAuthTokenVerifier`
  implementations (static-key, introspection); resolve Open question 3
  before touching `buildAuthChallenge`.
- `src/transport/http.ts` — mount point at line 147; thread `authInfo` from
  the per-request factory (`createMcpHandler` callback, `http.ts:293-317`)
  into per-principal `PathGuard`/`ResourceStore`/`PageSnapshotStore` lookups;
  add the `mcpAuthMetadataRouter` mount for introspection mode only.
- `src/core/path.ts` — `PathGuard` gains a per-principal grant overlay (or a
  sibling map type keyed by `clientId`) alongside `applyGrant`/
  `precheckAccess`; out of scope for this spike per the plan, in scope for
  the implementation.
- `src/core/store.ts` — `ResourceEntry` gains an owning-principal field;
  `getEntry`/`putText`/`keys()` become principal-aware with fail-closed
  refusal for a foreign principal.
- `src/core/page-store.ts` — same shape of change as `store.ts`, for
  `StoredPageSnapshot`/`create`/`read`.
- `src/cli.ts` / wherever env is read once (per `AGENTS.md`'s config
  convention) — new env vars `FS_OAUTH_ISSUER`, `FS_OAUTH_INTROSPECTION_URL`,
  `FS_OAUTH_CLIENT_ID`, `FS_OAUTH_CLIENT_SECRET`.
- `README.md` (Environment variables table), `src/cli-help.ts` (`ENV_HELP`),
  `CHANGELOG.md` — document the new env vars, per `AGENTS.md`.
- `__tests__/http-policy.test.ts`, `__tests__/http-server.test.ts` — new
  cases for both verifiers, the OAuth-JSON 401 body, and (the one this spike
  could not exercise without going out of scope) cross-principal isolation
  for the two stores and the guard.
