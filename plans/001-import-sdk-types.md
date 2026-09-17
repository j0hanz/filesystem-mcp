# Plan 001: Import SDK types instead of redeclaring them

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 2d3b112f..HEAD -- src/core/observability.ts src/transport/http-policy.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `2d3b112f`, 2026-09-17

## Why this matters

Two SDK types are restated by hand. `src/core/observability.ts` spells out
the eight RFC 5424 log levels as its own `LoggingLevel` union; the SDK exports
the same union (`LoggingLevel` from `@modelcontextprotocol/server`, derived
from its `LoggingLevelSchema`), and the two can only drift apart.
`src/transport/http-policy.ts` casts `req` to add an `auth` property that
`@modelcontextprotocol/express` already declares on Express's `Request`
through module augmentation. Both are small, both are the kind of duplicate
that later turns into a silent mismatch. Deleting them costs nothing at
runtime and removes one import.

## Current state

- `src/core/observability.ts` — stderr logger; owns the level ordering and
  the `--log-level` / `FS_LOG_LEVEL` gate. Lines 1-6 today:

```ts
import { cli } from './config.js';
import { warnInvalidSetting } from './primitives.js';

export type LoggingLevel =
  'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';
```

`LoggingLevel` is used inside the file (`LEVEL_ORDER`, `isLoggingLevel`,
`parseLogLevel`, `Logger.emit`) and imported once elsewhere:
`src/tools/define.ts:39` (`import type { LoggingLevel } from
  '../core/observability.js';`). No test imports it.

- `src/transport/http-policy.ts` — HTTP auth, CORS and rate-limit policy.
  Lines 1-3 today:

```ts
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import { localhostAllowedHostnames } from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
```

Lines 292-297 today (inside `bearerAuthMiddleware`):

```ts
const presented = authHeader.slice('Bearer '.length).trim();
(req as Request & { auth?: AuthInfo }).auth = {
  token: presented,
  clientId: 'api-key',
  scopes: [],
};
```

`AuthInfo` is used nowhere else in the file.

- The SDK side, from the installed packages:
  - `node_modules/@modelcontextprotocol/server/dist/index.d.mts` exports
    `LoggingLevel` (a string-literal union of the RFC 5424 levels).
  - `node_modules/@modelcontextprotocol/express/dist/index.d.mts` ends with:

```ts
declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthInfo;
  }
}
```

    That augmentation is in effect for any module in the program that imports
    from `@modelcontextprotocol/express` — `http-policy.ts` already does (line
    1), so `req.auth` type-checks without a cast.

Conventions: type-only imports use `import type` (eslint
`consistent-type-imports`); re-exports of types use `export type { ... }`
(eslint `consistent-type-exports`); import order is fixed by `npm run fix`.
`knip` (part of `npm run check:static`) fails on an unused import or export.

## Commands you will need

| Purpose       | Command                                                                              | Expected on success |
| ------------- | ------------------------------------------------------------------------------------ | ------------------- |
| Static checks | `npm run check:static`                                                               | exit 0              |
| Tests         | `npm test -- --test-name-pattern="observability\|HTTP Policy\|bearerAuthMiddleware"` | all pass            |
| Full check    | `npm run check`                                                                      | exit 0              |
| Format        | `npm run fix`                                                                        | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/observability.ts`
- `src/transport/http-policy.ts`

**Out of scope** (do NOT touch, even though they look related):

- `src/tools/define.ts` — keeps importing `LoggingLevel` from
  `../core/observability.js`; the re-export below preserves that path.
- `src/cli-help.ts` / `README.md` — the level list in help text is prose,
  not a type.
- Any behaviour of `bearerAuthMiddleware` — only the cast goes.

## Git workflow

- Branch: `refactor/import-sdk-types` from `main`.
- One commit. Subject style from `git log`: `refactor: import SDK types
instead of redeclaring them` (conventional prefix, lower case, no trailing
  period).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Re-export the SDK `LoggingLevel`

In `src/core/observability.ts`, replace lines 4-5:

```ts
export type LoggingLevel =
  'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';
```

with:

```ts
import type { LoggingLevel } from '@modelcontextprotocol/server';

// The SDK's RFC 5424 level union, re-exported so the rest of the server keeps
// one import path for it.
export type { LoggingLevel };
```

(Put the `import type` line with the other imports at the top of the file;
`npm run fix` sorts it into the `@modelcontextprotocol/*` group.)

**Verify**: `npx tsc -p tsconfig.json --noEmit` → exit 0. If it reports that
a member of `LEVEL_ORDER` is not assignable to `LoggingLevel`, the SDK union
differs from the local one — STOP.

### Step 2: Drop the `req.auth` cast

In `src/transport/http-policy.ts`:

1. Delete line 3 (`import type { AuthInfo } from '@modelcontextprotocol/server';`).
2. Replace the assignment at line 293:

```ts
      (req as Request & { auth?: AuthInfo }).auth = {
```

with:

```ts
      req.auth = {
```

**Verify**: `npm run check:static` → exit 0 (`tsc`, eslint and `knip` all
clean; a `knip` complaint about `AuthInfo` means step 2.1 was skipped).

### Step 3: Tests and format

**Verify**:
`npm test -- --test-name-pattern="observability|HTTP Policy|bearerAuthMiddleware"`
→ all pass; `npm run fix` → exit 0; `git status --short` → only the two
in-scope files.

## Test plan

- No new tests: no behaviour changes. The existing
  `__tests__/observability.test.ts` (level gating) and
  `__tests__/http-policy.test.ts` (`bearerAuthMiddleware (TC-SEC-038 - TC-SEC-040)`)
  cover both edited functions.
- Verification: `npm test` → all pass, same count as before.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "export type LoggingLevel =" src/core/observability.ts` → no output
- [ ] `grep -n "export type { LoggingLevel }" src/core/observability.ts` → one match
- [ ] `grep -n "AuthInfo" src/transport/http-policy.ts` → no output
- [ ] `grep -n "req.auth = {" src/transport/http-policy.ts` → one match
- [ ] `git status --short` lists only the two in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the live code.
- Step 1's type-check fails because the SDK `LoggingLevel` union is not the
  same eight members (`debug`, `info`, `notice`, `warning`, `error`,
  `critical`, `alert`, `emergency`).
- Step 2's type-check reports `Property 'auth' does not exist on type
'Request'` — the express augmentation is not in effect; do not re-add the
  cast, report it.

## Maintenance notes

- If `@modelcontextprotocol/express` is ever dropped from
  `http-policy.ts` imports, the `req.auth` augmentation goes with it and the
  assignment stops type-checking — that is the intended signal, not something
  to paper over with a cast.
- Reviewer: the diff should be two files, net negative lines, no logic change.
