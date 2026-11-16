# Elicitation Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four findings of the 2026-11-16 elicitation audit: a declined confirmation must not surface as `isError: true`; sealed `requestState` rounds must bind to the authenticated user, not just the OAuth client; a dismissed prompt must say the person may be asked again; and the round-trip TTL must cover reading a large form.

**Architecture:** One new predicate (`isRefusal`) in `src/core/errors.ts` classifies `CANCELLED` problems as the user's answer (decline, dismissal, or a post-approval race guard — nothing happened, nothing broke), and every site that sets `isError` from batch results or the executor's catch consults it. The `requestState` codec's `bind` gains a user-subject component read from `authInfo.extra.sub`, falling back to `authInfo.clientId`. Both changes are behavior-only; no wire shape, tool description, or contract snapshot changes.

**Tech Stack:** TypeScript, `@modelcontextprotocol/server` v2 (`createRequestStateCodec` supports `ttlSeconds`, default 600; `AuthInfo` has `extra?: Record<string, unknown>`), zod v4, Node's built-in test runner.

**Spec:** The audit report was chat output, so it is embedded here verbatim. All four findings against the mcp-elicitation skill:

| Sev   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                         | Location                                                                                                                  |
| :---- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| Major | Decline surfaces as `isError: true`: `delete.ts` sets it from `isTotalFailure`, so a single declined path reads "FAILED" and `isError: true`; the model cannot tell "user said no" from "something broke" and retries or reports a breakage that did not happen. Same shape in `create` (`isTotalFailure`) and `move` (a refused pair throws whole-call `FsError CANCELLED`, which the executor's `failProgress` always marks `isError: true`). | `src/tools/delete.ts:264`, `src/tools/create.ts:237`, `src/tools/move.ts:433`, `src/tools/define.ts:327` (`failProgress`) |
| Major | `requestState` bound to `clientId`, not user: the codec's `bind` is `${method}\0${authInfo.clientId}`. `clientId` identifies the OAuth client, not the subject, so two users behind one client share the bind and user B's retry of the same op + paths verifies against a state minted for user A. Fix: read the user's subject from `authInfo.extra.sub` (the skill's convention), fall back to `clientId`.                                   | `src/core/input-required.ts:138-140`                                                                                      |
| Minor | Decline and cancel conflated: both become per-path `CANCELLED` with terminal wording. Per the skill, cancel means "not answered, may ask again" — the refusal wording should say so.                                                                                                                                                                                                                                                            | `src/core/input-required.ts:425-437` (`describeRefusal`)                                                                  |
| Minor | 600 s TTL (SDK default) on forms that can ask one question per path in a 1000-path delete. Expiry surfaces as raw `-32602` from the seam, which the model gets as an unreadable protocol error with no next step.                                                                                                                                                                                                                               | `src/core/input-required.ts:176-180`                                                                                      |

Out of scope (audit verdict "keep unless users complain"): the whole-batch `INVALID_INPUT` when a client cannot elicit (R14 atomicity is deliberate). Also out of scope: a declined access grant surfacing as `ACCESS_DENIED` rather than `CANCELLED` — plumbing that would change grant semantics the audit did not flag.

## Global Constraints

- Test runner: `npm test -- --test-name-pattern="<pattern>"`; full gate is `npm run check`.
- `__tests__/contract.test.ts` snapshots the tool surface — this plan changes no tool description, so the snapshot must NOT change. If `npm run check` shows a contract snapshot diff, a task drifted; revert the description text.
- After modifying code, run `graphify update .` (CLAUDE.local.md rule; AST-only, no API cost).
- Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Comments the plan quotes are existing payload — never delete or shorten one you were not asked to change.

## Review Focus

Input classes no task's tests exercise directly, most likely first; each line names its owning task.

1. Mixed batch — one declined row plus one genuinely failed row must keep `isError: true` (Task 1, `delete` mixed test).
2. All four destructive ops on the wire — a decline must come back without `isError` on `create`, `move`, `copy`, and `delete` (Task 1, mutation-regressions refuse branch).
3. A `CANCELLED` escaping the tool body as a thrown `FsError` (move's refused pair, and the fs.ts race guards) must lose `isError` in the executor too, not only in batch summaries (Task 1, mutation-regressions refuse branch covers move; the fs.ts guards are unreachable without racing, accepted as reviewed-not-tested).
4. Two users behind one OAuth client, same paths — user B must not verify a round sealed for user A; and deployments with no `extra.sub` (today's static API key) must keep working unchanged (Task 2, both new tests).
5. A decline still reads `CANCELLED` in `structuredContent`/`failures` — only the `isError` flag changes; existing CANCELLED-code assertions must keep passing (Task 1, existing `delete.test.ts` and `create.test.ts` code assertions are the regression net).

---

### Task 1: A refused confirmation is an answer, not `isError`

**Files:**

- Modify: `src/core/errors.ts` (add `isRefusal` near `Problem` helpers, ~line 47)
- Modify: `src/tools/delete.ts:263-264`
- Modify: `src/tools/create.ts:237`
- Modify: `src/tools/move.ts:433`
- Modify: `src/tools/define.ts:327-340` (`failProgress`)
- Test: `__tests__/delete.test.ts:698-711` (flip) and a new mixed-batch test after it
- Test: `__tests__/create.test.ts:712-725` (flip one assertion)
- Test: `__tests__/mutation-regressions.test.ts:494-496` (refuse branch gains an `isError` assertion)

**Interfaces:**

- Produces: `export function isRefusal(problem: Problem): boolean` in `src/core/errors.ts` — true exactly when `problem.code === ErrorCode.CANCELLED`. Task-internal; nothing later depends on it.

- [ ] **Step 1: Write the failing tests**

`__tests__/delete.test.ts` — in `'reports a declined delete as CANCELLED and keeps the directory'` (line 705), change:

```ts
assert.strictEqual(result.isError, true);
```

to

```ts
assert.notStrictEqual(result.isError, true, 'a decline is an answer, not a failure');
```

Keep the CANCELLED-code, message, and `FAILED: Delete cancelled` text assertions unchanged (Review Focus 5).

Add directly after that test:

```ts
it('keeps isError true when a decline rides with a real failure', async () => {
  const dir = await nonEmptyDir('del_mixed_dir');
  const missing = join(root, 'del_mixed_missing.txt');
  const result = await del(
    { paths: [dir, missing], recursive: true },
    { confirm: () => ({ action: 'decline' }) },
  );

  assert.strictEqual(result.isError, true, 'one real failure still fails the call');
  const codes = result.structured.results.map((r) => r.error?.code ?? r.value?.deleted);
  assert.deepStrictEqual(codes, ['CANCELLED', 'NOT_FOUND']);
});
```

`__tests__/create.test.ts` — in `'reports a declined overwrite as declined by the user'` (line 718), change `assert.strictEqual(result.isError, true, 'one file, one refusal: a total failure');` to `assert.notStrictEqual(result.isError, true, 'a decline is an answer, not a failure');`.

`__tests__/mutation-regressions.test.ts` — in the refuse branch (the final `else` around line 494), after the existing `assert.match(text, tool.refused);` add:

```ts
assert.notStrictEqual(result.isError, true, text);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="declin|keeps isError|maps to its outcome"`
Expected: FAIL — the three flipped/new assertions see `isError: true` today.

- [ ] **Step 3: Implement `isRefusal` and apply it at the four `isError` sites**

`src/core/errors.ts`, after `cancelled` factory (~line 47):

```ts
/** A CANCELLED problem is the user's refusal — or a race guard after an approval — so nothing happened and nothing broke; it is an answer, not a failure. */
export function isRefusal(problem: Problem): boolean {
  return problem.code === ErrorCode.CANCELLED;
}
```

`src/tools/delete.ts:264` — replace `const isError = isTotalFailure(structured.summary);` with:

```ts
// A refusal is an answer the model can report; only a real failure is an error.
const isError =
  isTotalFailure(structured.summary) &&
  structured.results.some((r) => 'error' in r && !isRefusal(r.error));
```

`src/tools/create.ts:237` — replace `return { structured, resources: links, isError: isTotalFailure(summary) };` with the same pattern over `batch.results` only (directories never confirm, so no CANCELLED row can appear in `dirBatch.results` — say so in a one-line comment):

```ts
const isError =
  isTotalFailure(summary) &&
  // Directories never take a confirmation, so only file rows can be refusals.
  batch.results.some((r) => 'error' in r && !isRefusal(r.error));
return { structured, resources: links, isError };
```

`src/tools/move.ts:433` — replace the `isError` value with:

```ts
isError: failures.some((f) => !isRefusal(f.error)) && results.length + skipped.length === 0,
```

`src/tools/define.ts` `failProgress` (~line 327) — the returned problem is a refusal when it is CANCELLED (move's whole-call refused pair, the fs.ts post-approval guards). Widen the declared return type to `{ isError?: true; content: ContentBlock[]; _meta: { error: Problem } }`, then:

```ts
const problem = Problem.fromUnknown(error, this.def.defaultErrorCode ?? ErrorCode.UNKNOWN);
const refusal = isRefusal(problem);
```

and make the returned object spread `...(refusal ? {} : { isError: true })`. Keep `#progressSession.fail` and the `_meta: { error: problem }` line unchanged — the failure detail still ships for clients that want it.

Import `isRefusal` in each of the four files (delete.ts, create.ts, move.ts, define.ts already import from `../core/errors.ts` / `./errors.ts` — extend those import lists).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="declin|keeps isError|maps to its outcome|CANCELLED"`
Expected: PASS, including the existing CANCELLED-code assertions (Review Focus 5).

- [ ] **Step 5: Full gate, graph, commit**

Run: `npm run check` — expected: PASS with no contract snapshot diff.
Run: `graphify update .`

```bash
git add src/core/errors.ts src/tools/delete.ts src/tools/create.ts src/tools/move.ts src/tools/define.ts __tests__/delete.test.ts __tests__/create.test.ts __tests__/mutation-regressions.test.ts graphify-out/
git commit -m "fix(tools): a refused confirmation is an answer, not isError

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: Bind sealed rounds to the authenticated user

**Files:**

- Modify: `src/core/input-required.ts:111-168` (key/bind helpers and `RoundBind` docs)
- Modify: `src/transport/http-policy.ts:289-301` (comment only)
- Test: `__tests__/input-required.test.ts` (new tests inside the existing codec `describe`)

**Interfaces:**

- Produces: `export function roundCallerOf(authInfo: AuthInfo | undefined): string | undefined` in `src/core/input-required.ts`. Reads `authInfo.extra['sub']` when a non-empty string, else `authInfo.clientId`. Used only by `requestStateBinding` and `roundBindOf`; no other task depends on it.

- [ ] **Step 1: Write the failing tests**

`__tests__/input-required.test.ts` — inside the existing `describe('requestState codec', ...)` (the one holding lines 147-187), add:

```ts
it('binds to the user subject when the verifier provides one', async () => {
  const httpBind = (sub: string | undefined, clientId: string): ServerContext =>
    ({
      mcpReq: { method: 'tools/call' },
      http: { authInfo: { clientId, ...(sub === undefined ? {} : { extra: { sub } }) } },
    }) as unknown as ServerContext;

  const wire = await requestStateCodec.mint(
    { op: 'delete', paths: ['/a'] },
    httpBind('user-a', 'client-1'),
  );
  // The subject, not the OAuth client, is who the round belongs to.
  await requestStateCodec.verify(wire, httpBind('user-a', 'client-2'));
  assert.rejects(() => requestStateCodec.verify(wire, httpBind('user-b', 'client-1')));
});

it('falls back to clientId when no subject was stamped', async () => {
  assert.strictEqual(roundCallerOf({ clientId: 'c', scopes: [], token: 't' } as never), 'c');
  assert.strictEqual(
    roundCallerOf({ clientId: 'c', scopes: [], token: 't', extra: { sub: '' } } as never),
    'c',
  );
  assert.strictEqual(
    roundCallerOf({ clientId: 'c', scopes: [], token: 't', extra: { sub: 'u' } } as never),
    'u',
  );
  assert.strictEqual(roundCallerOf(undefined), undefined);
});
```

Import `roundCallerOf` in the import block at the top of the file. Do not touch the existing bind tests at lines 182-187 — they pin the clientId fallback (Review Focus 4) and must keep passing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="input_required"`
Expected: FAIL — `roundCallerOf` is not exported; the first new test fails to compile/run.

- [ ] **Step 3: Implement `roundCallerOf` and thread it through the bind**

`src/core/input-required.ts`:

1. Add `AuthInfo` to the type import from `'@modelcontextprotocol/server'` (after `ServerContext`).
2. Add `roundCallerOf` above `requestStateBinding`:

```ts
/**
 * The authenticated principal a sealed round binds to: the token's user subject
 * when the verifier stamps it into `authInfo.extra.sub` (a static API key has
 * none), else the OAuth client id. `clientId` alone identifies the client, not
 * the person: two users behind one client must not share confirmations.
 */
export function roundCallerOf(authInfo: AuthInfo | undefined): string | undefined {
  const sub = authInfo?.extra?.['sub'];
  if (typeof sub === 'string' && sub !== '') return sub;
  return authInfo?.clientId;
}
```

3. `requestStateBinding` (line 139): replace `ctx.http?.authInfo?.clientId ?? ''` with `roundCallerOf(ctx.http?.authInfo) ?? ''`, and extend the function's doc comment: the caller part is the user subject when provided, else the client id.
4. `roundBindOf` (line 154): replace `const caller = ctx.http?.authInfo?.clientId;` with `const caller = roundCallerOf(ctx.http?.authInfo);`.
5. Extend the `RoundBind` interface comment (line 144-146): `` `caller` is the authenticated user's subject when the verifier stamps `authInfo.extra.sub`, else the OAuth client id; absent on stdio ``.

`src/transport/http-policy.ts` — inside the comment block at lines 289-301 (the `req.auth =` assignment), append one line after the `expiresAt` note:

```text
// A future issued-token verifier MUST stamp the authenticated user's subject
// into `authInfo.extra.sub`: confirmation rounds seal to that subject
// (roundCallerOf in core/input-required.ts), so two users of one client
// cannot share an approval.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="input_required|requestState"`
Expected: PASS — both new tests and the untouched bind tests at lines 182-187.

- [ ] **Step 5: Full gate, graph, commit**

Run: `npm run check` — expected: PASS, no snapshot diff.
Run: `graphify update .`

```bash
git add src/core/input-required.ts src/transport/http-policy.ts __tests__/input-required.test.ts graphify-out/
git commit -m "fix(core): bind sealed confirmation rounds to the user subject

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: A dismissed prompt says the person may be asked again

**Files:**

- Modify: `src/core/input-required.ts:425-437` (`describeRefusal`)
- Test: `__tests__/input-required.test.ts:528-529` (expected-string update)

**Interfaces:**

- Consumes: `describeRefusal(ctx, key)` (existing signature, unchanged).
- Produces: no new surface — one wording change.

- [ ] **Step 1: Write the failing test**

`__tests__/input-required.test.ts` — in the `describeRefusal` case array (line 529), change:

```ts
[{ confirm_0: { action: 'cancel' } }, 'dismissed by the user'],
```

to

```ts
[{ confirm_0: { action: 'cancel' } }, 'dismissed by the user; ask again if they still want it'],
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="describeRefusal"`
Expected: FAIL — current wording is `'dismissed by the user'`.

- [ ] **Step 3: Implement the wording change**

`src/core/input-required.ts` line 435, in `describeRefusal`:

```ts
if (view.action === 'cancel') return 'dismissed by the user; ask again if they still want it';
```

Leave the `decline` line untouched — a decline is a final no. The string flows into `cancelMessage` (`src/tools/batch.ts:174-182`), producing e.g. `Delete cancelled: approval for "x" was dismissed by the user; ask again if they still want it`. No edit needed there. `__tests__/mutation-regressions.test.ts` matches `(declined|dismissed) by the user` — still matches.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="describeRefusal|maps to its outcome|refus"`
Expected: PASS, including the mutation-regressions refuse regexes.

- [ ] **Step 5: Full gate, graph, commit**

Run: `npm run check` — expected: PASS.
Run: `graphify update .`

```bash
git add src/core/input-required.ts __tests__/input-required.test.ts graphify-out/
git commit -m "fix(core): a dismissed prompt says the person may be asked again

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 4: Seal rounds for an hour, not the SDK's ten minutes

**Files:**

- Modify: `src/core/input-required.ts:176-180` (`requestStateCodec`)
- Test: `__tests__/input-required.test.ts` (new test in the codec describe)

**Interfaces:**

- Produces: no new surface — one option value.

- [ ] **Step 1: Write the failing test**

`__tests__/input-required.test.ts` — inside the codec describe, add:

```ts
it('seals a round for an hour of think time', async () => {
  const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/a'] }, bindContext());
  // Token layout: "v1." + base64url(JSON {p, exp, b}) + "." + base64url(mac).
  const body = JSON.parse(
    Buffer.from(wire.slice(3, wire.lastIndexOf('.')), 'base64url').toString('utf8'),
  ) as { exp: number };
  const seconds = body.exp - Math.floor(Date.now() / 1000);
  assert.ok(seconds > 3590 && seconds <= 3600, `exp was ${String(seconds)}s away, expected ~3600`);
  await requestStateCodec.verify(wire, bindContext());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="seals a round"`
Expected: FAIL — `seconds` is ~600.

- [ ] **Step 3: Implement the TTL**

`src/core/input-required.ts` — in the `createRequestStateCodec` call (lines 176-180), add after `key`:

```ts
// An hour, not the SDK's ten minutes: a 1000-path delete mints one form per
// path, and an expired seal answers with a raw -32602 the model cannot read.
// Re-mints on reprompt/reissue restart the clock.
ttlSeconds: 3600,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="input_required"`
Expected: PASS — the codec tests (mint/verify round-trips) are immediate and unaffected; only the new TTL assertion changes.

- [ ] **Step 5: Full gate, graph, commit**

Run: `npm run check` — expected: PASS, no snapshot diff.
Run: `graphify update .`

```bash
git add src/core/input-required.ts __tests__/input-required.test.ts graphify-out/
git commit -m "fix(core): seal confirmation rounds for an hour of think time

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
