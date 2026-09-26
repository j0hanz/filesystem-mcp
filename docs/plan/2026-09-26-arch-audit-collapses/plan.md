# Arch-audit collapses: errno ownership, test helpers, stop-reason precedence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the three surviving architecture-audit findings: errno classification into `errors.ts`, the three locally-grown test rules into `helpers.ts`, and the search stop-reason precedence into one owner.

**Architecture:** Pure refactor inside `src/core` + `__tests__`; no protocol, schema, or user-facing text changes beyond the two deltas the findings doc blesses. Each finding is a reuse move — the owning module already exists, only exports and call sites change.

**Tech Stack:** TypeScript (Node 24, ESM, `.ts` import extensions), node:test, zod v4.

**Spec:** `docs/plan/2026-09-26-arch-audit-collapses/audit-findings.md` — read it first; every task argues from it.

## Global Constraints

- Gate: `npm run check` exits 0 (build, `type-check:test`, lint, prettier, knip, all tests).
- Relative imports end in `.ts`; `node:` protocol for builtins; `no-console` in `src` (use `Logger`).
- `exactOptionalPropertyTypes` + strict TS: never assign `undefined` to an optional property.
- knip: every `src` export must be reachable from `__tests__/**/*.test.ts`; drop or un-export anything orphaned in the same change.
- Conventional Commits, each ending with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Branch `refactor/arch-audit-collapses`; do not push or open a PR.
- Never hand-edit versions in `package.json`, `server.json`, `mcpb/manifest.json`.
- Behavior-preserving except the two deltas named in the findings doc (ELOOP log-only; `path.ts` unmapped-errno → `IO_ERROR`).

## Review Focus

1. Env restore must distinguish unset (restore by delete) from empty string (restore as set) — pinned by Task 5 Step 1's new test.
2. Restore ordering across sibling describe blocks (node:test runs after hooks FIFO; a `t.after` restore re-applies a later block's pins) — pinned by `security.test.ts`'s whole two-block suite staying green in Task 5.
3. `fs.ts:265`'s `EEXIST` race probe must remain hand-written — pinned by the append/create race tests in `core-fs.test.ts` staying green and untouched in Task 2.
4. `path.ts:516` mapping deltas: unmapped errno → `IO_ERROR`, message stays `'Cannot access path'` — pinned by Task 1's `IO_ERROR` case and Task 3's path suites.
5. Stop-reason precedence: the result cap wins over an abort on the same iteration — pinned by Task 4's new test (previously unpinned).

---

### Task 1: Export the errno classification API

**Files:**
- Modify: `src/core/errors.ts:151` (add `export`), after `:110` (new predicate)
- Test: `__tests__/errors.test.ts` (new file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `classifyCauseChain(error: unknown): Problem` (now exported); `isSkippableErrno(error: unknown): error is NodeJS.ErrnoException`.

- [ ] **Step 1: Write the failing test — `__tests__/errors.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyCauseChain, ErrorCode, isSkippableErrno } from '../src/core/errors.ts';

const errnoError = (code: string, path?: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: boom`), path === undefined ? { code } : { code, path });

describe('classifyCauseChain', () => {
  it('an abort wins, then a timeout, then the errno', async () => {
    assert.strictEqual(classifyCauseChain(Object.assign(new Error('stop'), { name: 'AbortError' })).code, ErrorCode.CANCELLED);
    assert.strictEqual(classifyCauseChain(Object.assign(new Error('late'), { name: 'TimeoutError' })).code, ErrorCode.TIMEOUT);
    assert.strictEqual(classifyCauseChain(errnoError('ENOENT', '/x')).code, ErrorCode.NOT_FOUND);
    assert.strictEqual(classifyCauseChain(errnoError('ENOENT', '/x')).path, '/x');
  });
  it('an unmapped errno falls back to IO_ERROR; a non-Error is UNKNOWN', async () => {
    assert.strictEqual(classifyCauseChain(errnoError('ENODEV')).code, ErrorCode.IO_ERROR);
    assert.strictEqual(classifyCauseChain('nope').code, ErrorCode.UNKNOWN);
  });
  it('walks the cause chain', async () => {
    const wrapped = new Error('outer', { cause: Object.assign(new Error('stop'), { name: 'AbortError' }) });
    assert.strictEqual(classifyCauseChain(wrapped).code, ErrorCode.CANCELLED);
  });
});

describe('isSkippableErrno', () => {
  it('accepts exactly SKIPPABLE_ERRNOS members that are Node errors', async () => {
    assert.ok(isSkippableErrno(errnoError('ENOENT')));
    assert.ok(isSkippableErrno(errnoError('EACCES')));
    assert.ok(isSkippableErrno(errnoError('ELOOP')));
    assert.ok(!isSkippableErrno(errnoError('EPERM')));
    assert.ok(!isSkippableErrno(new Error('no code')));
    assert.ok(!isSkippableErrno('ENOENT'));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test __tests__/errors.test.ts`
Expected: FAIL — `classifyCauseChain` / `isSkippableErrno` not exported (not a function).

- [ ] **Step 3: Implement in `src/core/errors.ts`**

Add `export` to `classifyCauseChain` (`:151`). Add beside `isNotFoundErrno` (`:193`):

```ts
/** True when `error` is a Node errno error whose code is in `SKIPPABLE_ERRNOS`. */
export function isSkippableErrno(error: unknown): error is NodeJS.ErrnoException {
  return isNodeError(error) && SKIPPABLE_ERRNOS.has(error.code);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test __tests__/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add __tests__/errors.test.ts src/core/errors.ts` → `refactor(errors): export classifyCauseChain and add isSkippableErrno` + trailer.

### Task 2: Convert the fs/path-completer tolerance probes

**Files:**
- Modify: `src/core/fs.ts:54`, `:241`, `:436`; `src/core/path-completer.ts:73`, `:155`
- No new tests (behavior-preserving; `ELOOP` log delta is doc'd).

**Interfaces:**
- Consumes: `isNotFoundErrno`, `isSkippableErrno` from Task 1.
- Produces: nothing.

- [ ] **Step 1: Convert the five probes**

`fs.ts:54` and `fs.ts:241`: `if (!isNodeError(error) || error.code !== 'ENOENT') { throw error; }` → `if (!isNotFoundErrno(error)) { throw error; }` (drop now-unused `isNodeError` import only if nothing else in the file uses it).
`fs.ts:436`: `(isNodeError(err) && err.code === 'ENOENT')` → `isNotFoundErrno(err)` (keep the `isFsError` half).
`path-completer.ts:73`: `if (!isNotFoundErrno(err) && (!isNodeError(err) || err.code !== 'EACCES'))` → `if (!isSkippableErrno(err))`.
`path-completer.ts:155`: `if (!isNodeError(err) || (err.code !== 'ENOENT' && err.code !== 'EACCES'))` → `if (!isSkippableErrno(err))`.
Do NOT touch `fs.ts:265` (`EEXIST` race probe).
Accepted delta: `ELOOP` now also tolerated at both path-completer sites — a debug line and a warn line disappear.

- [ ] **Step 2: Verify**

Run: `node --test __tests__/core-fs.test.ts __tests__/path-helpers.test.ts __tests__/resources.test.ts __tests__/errors.test.ts`
Expected: all PASS.

- [ ] **Step 3: Commit**

`git add src/core/fs.ts src/core/path-completer.ts` → `refactor(core): route errno tolerance probes through errors.ts predicates` + trailer.

### Task 3: Classify in path.ts, retire the ERRNO_MAP export

**Files:**
- Modify: `src/core/path.ts:516-523`, `:667`, `:9` (import list)
- No new tests (delta pinned by Task 1's `IO_ERROR` case).

**Interfaces:**
- Consumes: `classifyCauseChain`, `isNotFoundErrno` from Task 1.
- Produces: `ERRNO_MAP` un-exported.

- [ ] **Step 1: Replace the raw mapping at `path.ts:516-523`**

```ts
    const mapped = classifyCauseChain(error);
    throw new FsError(
      mapped.code,
      'Cannot access path',
      requestedPath,
      error instanceof Error ? error : undefined,
    );
```

The message and `cause` stay identical; only the code source changes (unmapped errno now `IO_ERROR`, abort/timeout now `CANCELLED`/`TIMEOUT` — both doc'd deltas).

- [ ] **Step 2: Convert `path.ts:667`**

`if (!isNodeError(lstatErr) || lstatErr.code !== 'ENOENT')` → `if (!isNotFoundErrno(lstatErr))`. The surrounding comment stays accurate.

- [ ] **Step 3: Drop `ERRNO_MAP` from `path.ts` imports (`:9`) and un-export it in `errors.ts`**

Change `export const ERRNO_MAP` → `const ERRNO_MAP` in `src/core/errors.ts:79`. Verify sole-consumer claim first: `grep -rn "ERRNO_MAP" src __tests__` → only `errors.ts` (internal use at `:157`). If any other hit appears, leave it exported and note it.

- [ ] **Step 4: Verify**

Run: `npm run build && node --test __tests__/path-guard-grant.test.ts __tests__/security.test.ts __tests__/path-helpers.test.ts __tests__/errors.test.ts`
Expected: build exit 0, all PASS.

- [ ] **Step 5: Commit**

`git add src/core/path.ts src/core/errors.ts` → `refactor(core): classify path probes through errors.ts; un-export ERRNO_MAP` + trailer.

### Task 4: Own the stop-reason precedence in concurrency.ts

**Files:**
- Modify: `src/core/concurrency.ts` (new function beside `SearchStoppedReasonSchema:16`; docstring `:10-15`), `src/core/search.ts:317-318`, `:417-418`, imports, comments `:199-204`, `:314-316`, `:383`
- Test: `__tests__/concurrency.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveStopReason(hitCap: boolean, aborted: boolean): 'maxResults' | 'timeout' | undefined`.

- [ ] **Step 1: Write the failing test in `__tests__/concurrency.test.ts`**

```ts
describe('resolveStopReason', () => {
  it('the result cap wins over an abort on the same iteration', async () => {
    assert.strictEqual(resolveStopReason(true, true), 'maxResults');
    assert.strictEqual(resolveStopReason(true, false), 'maxResults');
    assert.strictEqual(resolveStopReason(false, true), 'timeout');
    assert.strictEqual(resolveStopReason(false, false), undefined);
  });
});
```

Add `resolveStopReason` to the file's import from `../src/core/concurrency.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test __tests__/concurrency.test.ts`
Expected: FAIL — `resolveStopReason` is not exported.

- [ ] **Step 3: Implement and convert**

In `concurrency.ts`, beside `SearchStoppedReasonSchema`, lean — a verbose JSDoc flips this to net addition:

```ts
/** The one precedence both scans share: the result cap wins over an abort that fired the same iteration. */
export function resolveStopReason(
  hitCap: boolean,
  aborted: boolean,
): 'maxResults' | 'timeout' | undefined {
  return hitCap ? 'maxResults' : aborted ? 'timeout' : undefined;
}
```

In `search.ts`, import it and replace both ternaries:

```ts
const stoppedReason = resolveStopReason(matches.length >= maxResults, counters.stoppedByAbort);
```

(same at the `searchFiles` site with `results.length`). Fix the dead-class citations: `concurrency.ts:12` docstring and `search.ts:201-202` say `hitMaxResults`/`hitAbort` — rewrite to name `resolveStopReason`; drop "matching StopReasonTracker's precedence" from `search.ts:315`; `search.ts:383`'s "never hit `hitMaxFiles`" → "never `maxFiles`".

- [ ] **Step 4: Verify**

Run: `node --test __tests__/concurrency.test.ts __tests__/tools.test.ts __tests__/glob.test.ts`
Expected: all PASS (tools covers `search_text`/`find_files` stoppedReason wiring).

- [ ] **Step 5: Commit**

`git add src/core/concurrency.ts src/core/search.ts __tests__/concurrency.test.ts` → `refactor(core): one owner for the search stop-reason precedence` + trailer.

### Task 5: Promote withEnv into helpers.ts

**Files:**
- Modify: `__tests__/helpers.ts` (new `withEnv` beside `withBoundary:74-83`; `withBoundary` rewritten on it), `__tests__/security.test.ts:275-291` (delete local, import, ~20 call sites), `__tests__/core-fs.test.ts:~105-122`, `:652-655`, `__tests__/tools.test.ts:~2403`, `__tests__/http-policy.test.ts:~762`, `:799`
- Test: the new test in Step 1.

**Interfaces:**
- Consumes: nothing.
- Produces: `withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T>` in `helpers.ts`.

- [ ] **Step 1: Write the failing restore-semantics test in `__tests__/security.test.ts`**

```ts
it('withEnv restores unset by deleting and empty string as set', async () => {
  Reflect.deleteProperty(process.env, 'FS_PIN_TEST');
  await withEnv({ FS_PIN_TEST: 'x' }, () => {
    assert.strictEqual(process.env['FS_PIN_TEST'], 'x');
  });
  assert.ok(!('FS_PIN_TEST' in process.env));
  process.env['FS_PIN_TEST'] = '';
  await withEnv({ FS_PIN_TEST: 'x' }, () => {
    assert.strictEqual(process.env['FS_PIN_TEST'], 'x');
  });
  assert.strictEqual(process.env['FS_PIN_TEST'], '');
  Reflect.deleteProperty(process.env, 'FS_PIN_TEST');
});
```

Import `withEnv` from `./helpers.ts` (this import fails red).

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test __tests__/security.test.ts`
Expected: FAIL — no `withEnv` export in helpers.

- [ ] **Step 3: Implement in `helpers.ts`**

```ts
/**
 * Run `fn` with the named env vars pinned, restoring every prior value after.
 * `undefined` in `vars` unsets the var; a prior value that was unset restores
 * by deleting, an empty-string prior restores as set. Restores in a finally
 * when the awaited call returns, never via t.after: node:test runs after hooks
 * FIFO, so hook-based restore re-applies a later block's pins over an earlier
 * block's restore (the two-block suite in security.test.ts pins this).
 */
export async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(vars)) {
    saved[name] = process.env[name];
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}
```

Rewrite `withBoundary` as `return withEnv({ FS_ROOT_BOUNDARY: boundary }, fn);` keeping its own one-line doc.

- [ ] **Step 4: Convert call sites**

Delete `security.test.ts:275-291` (the local `withEnv`); keep the FIFO rationale by pointing the `:267-274` comment at the helper's doc. Its ~20 sites become `await withEnv(vars, () => { … })` with the enclosing `it` callback made `async` where it is not. Convert the inline try/finally pin-restore sites in `core-fs.test.ts` (~`:105-122`, `:652-655`), `tools.test.ts` (~`:2403`), `http-policy.test.ts` (~`:762`, `:799`) the same way. Do NOT touch: `path-guard-grant.test.ts:125/155/189/211` and `http-server.test.ts:414-431` (hook-paired saves), `core-fs.test.ts:357`.

- [ ] **Step 5: Verify**

Run: `node --test __tests__/security.test.ts __tests__/core-fs.test.ts __tests__/tools.test.ts __tests__/http-policy.test.ts __tests__/http-server.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

`git add __tests__/helpers.ts __tests__/security.test.ts __tests__/core-fs.test.ts __tests__/tools.test.ts __tests__/http-policy.test.ts` → `refactor(tests): promote env pin-and-restore into helpers.withEnv` + trailer.

### Task 6: Promote the FsError rejection matcher

**Files:**
- Modify: `__tests__/helpers.ts` (new matcher), `__tests__/input-required.test.ts:123`, `:143`, `__tests__/core-fs.test.ts:114-117`, `:131-134`, `:174-177`, `:190-193`, `__tests__/path-guard-grant.test.ts:237-248`, `__tests__/page-store.test.ts:8-13` (+ its 5 use sites), `__tests__/http-policy.test.ts:273`, `:315`, `:562`, `:573`, `__tests__/security.test.ts:91`

**Interfaces:**
- Consumes: `waitFor`-style helper conventions; `ErrorCode`, `isFsError`, `formatUnknownErrorMessage` from `../src/core/errors.ts`.
- Produces: `fsErrorMatcher(code: ErrorCode, message?: string | RegExp): (error: unknown) => boolean`.

- [ ] **Step 1: Implement in `helpers.ts`** (test-infra helper; pinned by the suites it converts)

Ensure `helpers.ts` imports `assert` from `node:assert/strict` and `{ ErrorCode, formatUnknownErrorMessage, isFsError }` from `../src/core/errors.ts`.

```ts
/** An assert.rejects matcher: FsError with `code`; `message` is included (string) or matched (RegExp). */
export function fsErrorMatcher(
  code: ErrorCode,
  message?: string | RegExp,
): (error: unknown) => boolean {
  return (error: unknown) => {
    assert(isFsError(error), `expected FsError, got ${formatUnknownErrorMessage(error)}`);
    assert.strictEqual(error.code, code);
    if (typeof message === 'string') {
      assert.ok(error.message.includes(message), `expected message to include: ${message}`);
    } else if (message instanceof RegExp) {
      assert.match(error.message, message);
    }
    return true;
  };
}
```

- [ ] **Step 2: Convert the matcher sites**

`(e) => isFsError(e) && e.code === ErrorCode.X` → `fsErrorMatcher(ErrorCode.X)`; message-matching sites pass the message: `includes` strings stay strings, exact-equality strings become anchored Regexps (e.g. `/^Binary file detected\.$/`), `assert.match` regexes pass as-is. Delete `assertAccessDenied` (`path-guard-grant.test.ts:237-248`; its call sites become `await assert.rejects(p, fsErrorMatcher(ErrorCode.ACCESS_DENIED), msg)`) and `assertInvalidCursor` (`page-store.test.ts:8-13`; sites use `fsErrorMatcher(ErrorCode.INVALID_INPUT, /Request the first page without a cursor/)`). Do NOT touch `core-fs.test.ts:157` (message-only) or `:357` (OR with raw errno).

- [ ] **Step 3: Verify**

Run: `node --test __tests__/input-required.test.ts __tests__/core-fs.test.ts __tests__/path-guard-grant.test.ts __tests__/page-store.test.ts __tests__/http-policy.test.ts __tests__/security.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

`git add __tests__/helpers.ts __tests__/input-required.test.ts __tests__/core-fs.test.ts __tests__/path-guard-grant.test.ts __tests__/page-store.test.ts __tests__/http-policy.test.ts __tests__/security.test.ts` → `refactor(tests): one FsError rejection matcher in helpers` + trailer.

### Task 7: Promote the resource-update wait fixture

**Files:**
- Modify: `__tests__/helpers.ts` (new helper), `__tests__/subscriptions-listen.test.ts`, `__tests__/resources-subscribe.test.ts`, `__tests__/http-shared-guard.test.ts`, `__tests__/stdio.test.ts` (fitting sites only)
- No new test file (pinned by the suites it converts).

**Interfaces:**
- Consumes: `waitFor` (`helpers.ts:66`), `Client` (already imported by helpers).
- Produces: `waitForResourceUpdate(client: Client, uri: string, timeoutMs?: number): Promise<void>`.

- [ ] **Step 1: Implement in `helpers.ts`**

```ts
/** Resolve when `client` receives notifications/resources/updated for `uri`. Replaces any handler registered for the method. */
export async function waitForResourceUpdate(
  client: Client,
  uri: string,
  timeoutMs = 5000,
): Promise<void> {
  let arrived = false;
  client.setNotificationHandler('notifications/resources/updated', (n) => {
    if ((n.params as { uri: string }).uri === uri) arrived = true;
  });
  await waitFor(() => arrived, timeoutMs);
  assert.ok(arrived, `no notifications/resources/updated for ${uri} within ${timeoutMs}ms`);
}
```

- [ ] **Step 2: Convert the fitting sites**

Grep `setNotificationHandler('notifications/resources/updated'` (15 sites). Convert only sites whose handler's whole job is detecting one uri and whose assertion is arrival, not count: the site's handler+flag+`waitFor` block becomes one `await waitForResourceUpdate(client, uri)`. Known non-fitting (keep local): count assertions (`resources-subscribe.test.ts:68`, `:96`; `stdio.test.ts:106`; `subscriptions-listen.test.ts:247-250` two-client fanout), cross-talk with negative assertion (`subscriptions-listen.test.ts:180-183`), drain-and-reregister (`subscriptions-listen.test.ts:283`).

- [ ] **Step 3: Verify**

Run: `node --test __tests__/subscriptions-listen.test.ts __tests__/resources-subscribe.test.ts __tests__/stdio.test.ts __tests__/http-shared-guard.test.ts`
Expected: all PASS.

- [ ] **Step 4: Commit**

`git add __tests__/helpers.ts __tests__/subscriptions-listen.test.ts __tests__/resources-subscribe.test.ts __tests__/stdio.test.ts __tests__/http-shared-guard.test.ts` → `refactor(tests): one resource-update wait fixture in helpers` + trailer.

### Task 8: Full gate

- [ ] **Step 1: Create the branch if not yet on it, then run the gate**

Run: `npm run check`
Expected: exit 0 — including knip (proves `withEnv`/`fsErrorMatcher`/`waitForResourceUpdate` all have consumers and `ERRNO_MAP` no longer needs export).

- [ ] **Step 2: STOP conditions**

Any gate failure names its file — fix in place, re-run. If a fix must leave the findings doc's blessed deltas (e.g. a test asserting `UNKNOWN` for an unmapped errno at `path.ts:516`), that test pins the old shape: update it to the doc'd `IO_ERROR` and note it in the commit body.