# Plan: derive the HTTP request-body limit from `DEFAULT_MAX_REQUEST_BODY_SIZE`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. There is no plans index to update; your reviewer
> maintains the record.
>
> **Drift check (run first)**:
> `git diff --stat 2fba1ed0..HEAD -- src/transport/http.ts __tests__/http-server.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `2fba1ed0`, 2026-09-26

## Why this matters

Three layers bound the HTTP request body: the express JSON parser limit
(hand-set as `4 * MIB`), the node adapter `toNodeHandler` (SDK default), and
the `createMcpHandler` core (SDK default). The last two both read
`DEFAULT_MAX_REQUEST_BODY_SIZE` (4 MiB in the installed
`@modelcontextprotocol/server@2.1.0`), so the hand-set express constant is a
fourth copy of the same number that can silently drift from the other
layers. Deriving the express limit from the exported SDK constant makes the
agreement structural: if the SDK default ever changes, the express layer
follows it instead of diverging.

Behavior is byte-identical today: `4 * MIB` and `DEFAULT_MAX_REQUEST_BODY_SIZE`
are both `4194304`, so `jsonLimit` produces the same string `"4194304b"`.

## Current state

- `src/transport/http.ts` — HTTP transport: express app assembly and the
  modern per-request handler. The pieces this plan touches:

Lines 6-11 (the value import from the server package — note the
sort-imports plugin keeps named imports alphabetical, case-insensitive):

```ts
import {
  createMcpHandler,
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  isJsonContentType,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
```

Line 24 (the util import — `parseEnvInt` is still used at line 111 for
`FS_RATE_LIMIT_RPM`; `MIB` is used only by the constant being deleted):

```ts
import { MIB, parseEnvInt } from '../core/util.ts';
```

Lines 47-50:

```ts
const MAX_REQUEST_BODY_BYTES = 4 * MIB;
// Must exceed the idle timeout of any proxy in front of this server, or the
// proxy reuses connections the server already closed (intermittent 502s).
const KEEPALIVE_TIMEOUT_MS = 5_000;
```

Lines 89-94 (inside `setupExpressApp`):

```ts
  const app = createMcpExpressApp({
    host: httpHost,
    jsonLimit: `${MAX_REQUEST_BODY_BYTES}b`,
    ...(allowedHosts.length > 0 ? { allowedHosts: [...allowedHosts] } : {}),
    ...(allowedOriginHostnames.length > 0 ? { allowedOrigins: [...allowedOriginHostnames] } : {}),
  });
```

`MAX_REQUEST_BODY_BYTES` has exactly one other reference in the file (the
`jsonLimit` line above) and is not exported. `MIB` has no other use in
`http.ts`.

- `__tests__/http-server.test.ts` — HTTP transport integration tests. Test 5
  (lines 258-271) pins the 413 behavior this plan must preserve:

```ts
  it('5. POST /mcp with an oversized body -> 413', async () => {
    const tooBig = 'x'.repeat(5 * 1024 * 1024); // > default 4 MiB FS_MAX_REQUEST_BYTES
```

The comment names `FS_MAX_REQUEST_BYTES` — no such constant or env var exists
(any more); the limit is the SDK constant now. Fix the comment while here.

- Installed SDK fact (verified against
  `node_modules/@modelcontextprotocol/server/dist/index.d.mts:755-756`):
  `DEFAULT_MAX_REQUEST_BODY_SIZE` is exported from
  `@modelcontextprotocol/server` and is 4 MiB (4194304). The node adapter
  (`@modelcontextprotocol/node/dist/index.d.mts:241-245`) and
  `CreateMcpHandlerOptions` both default to it.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused test | `node --test __tests__/http-server.test.ts` | all pass, incl. test 5 (413) |
| Full gate | `npm run check` | exit 0 (build, test type-check, lint, prettier check, knip, all tests) |
| Format | `npx prettier --write src/transport/http.ts __tests__/http-server.test.ts` | files formatted |

## Scope

**In scope** (the only files you should modify):
- `src/transport/http.ts`
- `__tests__/http-server.test.ts`

**Out of scope** (do NOT touch):
- `src/core/util.ts` (`MIB` stays — other modules use it).
- `src/transport/http-policy.ts` and the 413 mapping in
  `errorHandlerMiddleware` — unchanged; express still emits the 413 body.
- Passing `maxRequestBodySize` to `toNodeHandler` or `createMcpHandler` —
  their SDK defaults already equal the constant; pinning them would restate
  the default.

## Git workflow

- Branch: `fix/request-body-limit` (repo uses `fix/...`, see
  `fix/sdk-builtins` in `git log`).
- Conventional Commits, ending with the trailer
  `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Do NOT push or open a PR.

## Steps

### Step 1: Swap the constant for the SDK export in `src/transport/http.ts`

1. In the `@modelcontextprotocol/server` value import (lines 6-11), add
   `DEFAULT_MAX_REQUEST_BODY_SIZE` keeping alphabetical order (it sorts
   before `DEFAULT_REQUEST_TIMEOUT_MSEC`):

```ts
import {
  createMcpHandler,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  isJsonContentType,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
```

2. Trim the util import (line 24) to `import { parseEnvInt } from '../core/util.ts';`

3. Delete line 47 (`const MAX_REQUEST_BODY_BYTES = 4 * MIB;`), leaving the
   `KEEPALIVE_TIMEOUT_MS` block untouched.

4. Replace the `jsonLimit` property in the `createMcpExpressApp` call with:

```ts
    // The express parser limit derives from the SDK's own request-body
    // bound, so it and the adapter/handler-core defaults
    // (`DEFAULT_MAX_REQUEST_BODY_SIZE`, 4 MiB in 2.1.0) cannot drift apart.
    jsonLimit: `${DEFAULT_MAX_REQUEST_BODY_SIZE}b`,
```

**Verify**: `npm run build` → exit 0.
If it errors on the missing export, the installed SDK is not 2.1.0 — STOP.

### Step 2: Fix the stale test comment in `__tests__/http-server.test.ts`

Line 259:

```ts
    const tooBig = 'x'.repeat(5 * 1024 * 1024); // > default 4 MiB FS_MAX_REQUEST_BYTES
```

becomes:

```ts
    const tooBig = 'x'.repeat(5 * 1024 * 1024); // > DEFAULT_MAX_REQUEST_BODY_SIZE (4 MiB)
```

No assertion changes.

**Verify**: `node --test __tests__/http-server.test.ts` → all pass,
including `5. POST /mcp with an oversized body -> 413`.

### Step 3: Format, then run the full gate

```bash
npx prettier --write src/transport/http.ts __tests__/http-server.test.ts
npm run check
```

**Verify**: exit 0. `knip` passing also confirms no dangling `MIB` import.

### Step 4: Commit

```bash
git add src/transport/http.ts __tests__/http-server.test.ts
git commit -m "refactor(http): derive jsonLimit from DEFAULT_MAX_REQUEST_BODY_SIZE" -m "The express parser limit was a hand-set 4 * MIB while the node adapter and createMcpHandler core both default to the SDK's DEFAULT_MAX_REQUEST_BODY_SIZE (4 MiB) — the same number maintained in four places, able to drift. Derive the express limit from the exported constant so every layer shares one number by construction; behavior is unchanged." -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

**Verify**: `git show --stat HEAD` → exactly the two in-scope files.

## Test plan

- No new tests: the existing 413 characterization test
  (`__tests__/http-server.test.ts:258-271`, a 5 MiB POST must 413 with a
  JSON-RPC error body) already pins the behavior this refactor must
  preserve, and the change is a constant swap.
- Verification: `node --test __tests__/http-server.test.ts` → all pass.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `node --test __tests__/http-server.test.ts` exits 0, test 5 (413) passes
- [ ] `grep -n "MAX_REQUEST_BODY_BYTES\|MIB" src/transport/http.ts` returns
      no matches
- [ ] `git status` shows no files outside
      `src/transport/http.ts` and `__tests__/http-server.test.ts`

## STOP conditions

- The "Current state" excerpts do not match the live code (drift since
  `2fba1ed0`).
- `DEFAULT_MAX_REQUEST_BODY_SIZE` is missing from the installed
  `@modelcontextprotocol/server` d.mts, or a quick
  `node -e "console.log(require('@modelcontextprotocol/server').DEFAULT_MAX_REQUEST_BODY_SIZE)"`
  does not print `4194304` — the plan assumes the 2.1.0 value; a different
  value changes `jsonLimit` and is a behavior change, not a refactor.
- Test 5 (413) fails after the swap.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

- If the express limit ever needs to differ from the SDK bound (e.g. an
  operator knob), reintroduce a local constant then — and pass
  `maxRequestBodySize` to `toNodeHandler` in the same change so the adapter
  layer matches the new intent.
- A reviewer should confirm the diff contains no behavior change: same
  import set otherwise, same `jsonLimit` string (`"4194304b"`), same tests.