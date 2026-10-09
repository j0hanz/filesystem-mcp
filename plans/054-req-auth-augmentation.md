# Plan 054: `bearerAuthMiddleware` sets `req.auth` through the SDK's Express type augmentation, not a cast

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8941498f..HEAD -- src/transport/http-policy.ts`
> If the file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW. Type-level only; the emitted JavaScript is unchanged.
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `8941498f`, 2026-10-09

## Why this matters

`@modelcontextprotocol/express` declares `auth?: AuthInfo` on Express's
`Request` (a `declare module 'express-serve-static-core'` augmentation) so
that `requireBearerAuth` and `toNodeHandler` agree on where the verified
caller lives. This server's own `bearerAuthMiddleware` writes the same field
but reaches it through a local intersection cast, which hides the contract:
a reader cannot tell that the shape is the SDK's, and a future SDK rename of
the field would compile here and silently stop reaching `toNodeHandler`.
Using the augmentation makes that break a compile error and removes a cast
and an import.

## Current state

- `src/transport/http-policy.ts:1-8`, imports:

```ts
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import {
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  resourceUrlFromServerUrl,
  validateOriginHeader,
} from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
```

Because line 1 imports a value from `@modelcontextprotocol/express`, that
package's declaration file is already part of this module's type program,
and so is its augmentation.

- `src/transport/http-policy.ts:283-295`, inside `bearerAuthMiddleware`:

```ts
// Forward the validated caller to the SDK pipeline: toNodeHandler reads
// req.auth and passes it as the handler's pass-through authInfo, which the
// per-request factory receives on ctx.http.
// `expiresAt` is deliberately omitted: a static API key has no expiry and
// there is no `exp` claim or introspection response to read one from.
// Populate it from the token if this ever moves to issued tokens.
const presented = authHeader.slice('Bearer '.length).trim();
(req as Request & { auth?: AuthInfo }).auth = {
  token: presented,
  clientId: 'api-key',
  scopes: [],
};
```

`AuthInfo` is used nowhere else in the file (`Select-String -Path src\transport\http-policy.ts -Pattern AuthInfo`
→ only lines 8 and 290).

- The augmentation (installed `@modelcontextprotocol/express` 2.0.2,
  `node_modules/@modelcontextprotocol/express/dist/index.d.mts:186-194`):

```ts
declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Information about the validated access token, populated by
     * `requireBearerAuth`.
     */
    auth?: AuthInfo;
  }
}
```

- `__tests__/http-policy.test.ts:181-246` (`bearerAuthMiddleware (TC-SEC-038 - TC-SEC-040)`)
  already asserts the field is set: `:209-210` reads
  `(okReq as unknown as { auth?: … }).auth` from a hand-built request stub and
  asserts it is present. That stub is a plain object, not an Express
  `Request`, so its cast is unrelated to this plan and stays.

Conventions: `src/transport/http-policy.ts` is the stateless HTTP policy
module; ESLint runs with `@typescript-eslint` strict rules, so an unused
type import fails `npm run lint`.

## Commands you will need

| Purpose      | Command                                     | Expected on success |
| ------------ | ------------------------------------------- | ------------------- |
| Build        | `npm run build`                             | exit 0              |
| Static check | `npm run check:static`                      | exit 0              |
| Policy tests | `npm test -- __tests__/http-policy.test.ts` | all pass            |
| Full check   | `npm run check`                             | exit 0; `fail 0`    |

Baseline at planning time: `npm test` → 567 tests, 564 pass, 3 skipped, 0 fail.

## Scope

**In scope** (the only files you should modify):

- `src/transport/http-policy.ts`
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `__tests__/http-policy.test.ts`: its `:209` cast is on a stub object, not
  an Express request. Leave it.
- The `auth` object's contents (`token`, `clientId: 'api-key'`, `scopes: []`,
  no `expiresAt`): the comment above it records why; this plan changes only
  how the field is typed.
- Any move to `requireBearerAuth` / `verifyBearerToken`: rejected in
  `plans/README.md` ("Findings considered and rejected") for the static-key
  case.

## Git workflow

- Branch: `advisor/054-req-auth-augmentation`
- One commit, e.g. `refactor(http): set req.auth via the SDK's Express augmentation`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace the cast

In `src/transport/http-policy.ts`:

1. Change line 290 from
   `(req as Request & { auth?: AuthInfo }).auth = {`
   to
   `req.auth = {`
2. Delete line 8, `import type { AuthInfo } from '@modelcontextprotocol/server';`
   (now unused).
3. Append one sentence to the comment block above the assignment, after
   "…receives on ctx.http.":
   `// \`req.auth\` is typed by @modelcontextprotocol/express's Request augmentation.`(as a plain`//` comment line, matching the lines around it).

**Verify**: `npm run build && npm run lint` → exit 0. If `npm run build`
reports `Property 'auth' does not exist on type 'Request…'`, see STOP
conditions.

### Step 2: Confirm behaviour is unchanged

**Verify**: `npm test -- __tests__/http-policy.test.ts` → all pass
(`TC-SEC-038`–`TC-SEC-040` still see `req.auth` set); `npm run check` →
exit 0, `fail 0`, 564 pass.

## Test plan

- No new tests: the field's presence and contents are already pinned by
  `TC-SEC-038`–`TC-SEC-040` in `__tests__/http-policy.test.ts:181-246`, and
  `__tests__/http-server.test.ts` exercises the authenticated HTTP path end
  to end. The change is type-level; the compiler is the test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run check` exits 0; 564 pass, 0 fail
- [ ] `Select-String -Path src\transport\http-policy.ts -Pattern "auth\?: AuthInfo"` → no hits (POSIX: `grep -n 'auth?: AuthInfo' src/transport/http-policy.ts` → nothing)
- [ ] `Select-String -Path src\transport\http-policy.ts -Pattern "import type \{ AuthInfo \}"` → no hits
- [ ] `Select-String -Path src\transport\http-policy.ts -Pattern "^\s*req\.auth = \{"` → exactly one hit
- [ ] `git diff --stat` lists only `src/transport/http-policy.ts` and `plans/README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `npm run build` fails with `Property 'auth' does not exist` after step 1.
  The augmentation is not reaching this file (check that
  `node_modules/@modelcontextprotocol/express/dist/index.d.mts` still
  contains `declare module 'express-serve-static-core'` and that line 1 of
  `http-policy.ts` still imports from `@modelcontextprotocol/express`). Do
  not fix it by adding a `/// <reference>` or re-adding the cast.
- `npm run lint` reports anything other than the removed `AuthInfo` import
  (for example a type-import-ordering rule on the remaining imports that it
  did not report before); report the rule name.
- `knip` (part of `npm run check:static`) flags `@modelcontextprotocol/server`
  as unused in this file's import graph; that would mean the value imports on
  lines 2-7 changed, which is drift.

## Maintenance notes

- If the SDK ever renames or retypes `Request.auth`, this file now fails to
  compile instead of silently setting a field `toNodeHandler` no longer
  reads. That is the point; fix it by following the SDK, not by restoring a
  cast.
- Reviewers: the diff should be three lines in one file (one assignment, one
  deleted import, one comment line). Anything more is out of scope.
- Related, deferred, and already listed under "Found but not planned" in
  `plans/README.md` (cosmetic SDK type reuse): `ProtocolEra` / `CacheScope`
  for the hand-written unions in `src/server.ts` and `src/resources.ts`,
  `NodeMcpRequestHandler` for the handler parameter in `src/transport/http.ts`,
  and `satisfies OAuthProtectedResourceMetadata` on the metadata body there.
  Same spirit as this plan; separate change if wanted.
