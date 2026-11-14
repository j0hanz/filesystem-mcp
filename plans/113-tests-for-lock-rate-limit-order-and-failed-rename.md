# Plan 113: Tests pin the write lock, the rate limit before auth, and cleanup after a failed rename

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/core/concurrency.ts src/core/fs.ts src/transport/http.ts __tests__/concurrency.test.ts __tests__/http-server.test.ts __tests__/core-fs.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

Three behaviors that protect data or credentials have no test, so a
regression in any of them passes CI:

1. `runExclusive` is the one lock behind per-file writes, hard-link writes,
   access grants, undo and the diff worker. Its only tests check how many
   arguments the callback receives. Nothing checks that two holders of one
   key never overlap.
2. The HTTP rate limiter is mounted before authentication so that wrong
   tokens are throttled. Every 429 test sends a valid token; moving the
   limiter after auth would give unlimited guesses and still pass.
3. A write is a temp file plus a rename. No test makes the rename fail (a
   common event on Windows when antivirus holds the target), so nothing
   checks that the temp file is removed and the original error is reported.

This plan adds tests only. If a new test fails against current code, that is
a finding: STOP and report it; do not fix source.

## Current state

### 1. `src/core/concurrency.ts:4-27`

```ts
const exclusiveChains = new Map<unknown, Promise<unknown>>();

export async function runExclusive<T>(key: unknown, fn: () => Promise<T>): Promise<T> {
  const run = (exclusiveChains.get(key) ?? Promise.resolve()).then(
    () => fn(),
    () => fn(),
  );
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  exclusiveChains.set(key, tail);
  try {
    return await run;
  } finally {
    if (exclusiveChains.get(key) === tail) exclusiveChains.delete(key);
  }
}
```

`__tests__/concurrency.test.ts:61-88` has a `describe('runExclusive argument isolation', ...)`
with two tests. The file imports
`{ processInParallel, runExclusive, withAbort }` from `../src/core/concurrency.ts`.

### 2. `src/transport/http.ts:134-138` and `:171`

```ts
const rpm = parseEnvInt('FS_RATE_LIMIT_RPM', apiKey ? 120 : 6_000, 1, 100_000);
const rateLimiter = createRateLimiter(rpm);
app.use('/mcp', rateLimiter);
// ... later ...
app.use('/mcp', bearerAuthMiddleware(apiKey, allowedHosts.length > 0, publicUrl));
```

`__tests__/http-server.test.ts`, `describe('rate limiting', ...)` (line 601):

```ts
  beforeEach(async () => {
    tmpDir = await createTestRoot();
    http = await bootHttpTest([tmpDir], { FS_RATE_LIMIT_RPM: '2' });
    ({ base } = http);
  });
  // ...
  it('third authenticated POST within the window is rejected with 429', async () => {
    const headers = {
      'content-type': 'application/json',
      Authorization: `Bearer ${TEST_API_KEY}`,
    };
    // ...
    const r1 = await fetch(base, { method: 'POST', headers, body });
```

### 3. `src/core/fs.ts:1292-1303` (inside `#writeValid`)

```ts
        signal?.throwIfAborted();
        await fsRename(tempPath, validPath);
      } catch (error) {
        try {
          await fsUnlink(tempPath);
        } catch (cleanupError) {
          Logger.warn(
            `Failed to clean up temp file ${tempPath} after write error (${formatUnknownErrorMessage(error)}): ${formatUnknownErrorMessage(cleanupError)}`,
          );
        }
        throw error;
      }
```

`fsRename` is `rename` imported from `node:fs/promises`. The existing test
`TC-FUNC-047e` (`__tests__/core-fs.test.ts:1012-1039`) shows how to replace a
built-in for one test:

```ts
const originalWriteFile = fsPromises.writeFile;
mock.method(
  fsPromises,
  'writeFile',
  async (...args: Parameters<typeof fsPromises.writeFile>): Promise<void> => {
    await originalWriteFile(...args);
    controller.abort(new Error('abort before commit'));
  },
);
syncBuiltinESMExports();
try {
  // ... act and assert ...
} finally {
  mock.restoreAll();
  syncBuiltinESMExports();
}
```

## Commands you will need

| Purpose    | Command                                                     | Expected on success |
| :--------- | :---------------------------------------------------------- | :------------------ |
| Build      | `npm run build`                                             | exit 0              |
| One file   | `node --test --test-timeout=60000 __tests__/<name>.test.ts` | all pass            |
| Full check | `npm run check`                                             | exit 0              |

## Scope

**In scope** (tests only):

- `__tests__/concurrency.test.ts`
- `__tests__/http-server.test.ts`
- `__tests__/core-fs.test.ts`
- `plans/README.md`

**Out of scope**:

- Everything under `src/`. Do not export `exclusiveChains` or add a test
  hook; the drain of the map is not asserted by this plan.

## Git workflow

- Branch: `test/lock-ratelimit-rename`
- One commit per test file, style `test: <what is covered>`, for example
  `test: cover reverse duplicate-landing orders and isolated listen after stale subscribe`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: `runExclusive` exclusion and independence

Add `describe('runExclusive serialization', ...)` to
`__tests__/concurrency.test.ts` with three tests. Use explicit gates, never
sleeps:

```ts
const gate = (): { promise: Promise<void>; open: () => void } => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};
```

- **Same key never overlaps, in call order.** Start three
  `runExclusive(key, ...)` calls on one fresh key (use a `Symbol()`), each
  pushing `start-N` to an array, awaiting its own gate, then pushing `end-N`.
  Open the gates in reverse order (3, 2, 1). Await all three. Assert the
  array is exactly `start-1, end-1, start-2, end-2, start-3, end-3`.
- **Different keys run together.** Start one call on key A that awaits a
  gate, and one on key B that resolves at once. Assert B's promise resolves
  while A is still pending (await B, then check a flag A sets only after its
  gate), then open A's gate and await it.
- **A rejected holder does not block the next.** First call rejects; second
  call on the same key resolves with a value. Assert both outcomes.

**Verify**: `node --test --test-timeout=60000 __tests__/concurrency.test.ts` → all pass.

### Step 2: Wrong tokens are rate limited

In `describe('rate limiting', ...)` of `__tests__/http-server.test.ts`, add:

```ts
it('counts requests with a wrong token toward the limit', async () => {
  const headers = {
    'content-type': 'application/json',
    Authorization: 'Bearer wrong-token-0123456789',
  };
  const post = () => fetch(base, { method: 'POST', headers, body: '{}' });
  const r1 = await post();
  const r2 = await post();
  const r3 = await post();
  await Promise.all([r1.text(), r2.text(), r3.text()]);
  assert.strictEqual(r1.status, 401);
  assert.strictEqual(r2.status, 401);
  assert.strictEqual(r3.status, 429);
});
```

**Verify**: `node --test --test-timeout=60000 __tests__/http-server.test.ts` → all pass.

### Step 3: A failed rename leaves no temp file and reports the rename error

Next to `TC-FUNC-047e` in `__tests__/core-fs.test.ts`, add two tests modeled
on it:

- **Rename fails.** Write `rename_fail.txt` with `old\n`. Replace
  `fsPromises.rename` with a function that rejects with
  `Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })`.
  `await assert.rejects(fs.writeFile(filePath, 'new\n'), /EPERM/)`. After
  restoring mocks: the file reads `old\n`; no directory entry starts with
  `rename_fail.txt.`.
- **Rename fails and cleanup fails.** Same, and also replace
  `fsPromises.unlink` with a function that rejects with an `EBUSY` error.
  Spy `console.error` with `t.mock.method(console, 'error', ...)` collecting
  calls. Assert the rejection still matches `/EPERM/` (the rename error, not
  the cleanup error) and that one logged line contains
  `Failed to clean up temp file`. Then, after restoring mocks, delete the
  leftover temp file yourself so the shared test directory stays clean.

Keep the `try { ... } finally { mock.restoreAll(); syncBuiltinESMExports(); }`
shape exactly.

**Verify**: `node --test --test-timeout=60000 __tests__/core-fs.test.ts` → all pass.

### Step 4: Full check

**Verify**: `npm run check` → exit 0.

## Test plan

Six new tests: three in `concurrency.test.ts`, one in `http-server.test.ts`,
two in `core-fs.test.ts`. Each is described above.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `git diff --stat` lists only the three test files and `plans/README.md`
- [ ] No `setTimeout`/`sleep` call was added (`git diff | grep -n "sleep\|setTimeout"` prints nothing)
- [ ] `plans/README.md` status row updated

## STOP conditions

- A new test fails against unmodified source after you have checked the test
  itself twice. Report the test and its output: it is a real defect.
- The wrong-token request returns something other than 401 before the limit
  (for example 400 from body parsing). Then the middleware order is not what
  the excerpt shows.
- Mocking `fsPromises.rename` does not affect `fs.writeFile` (the write
  succeeds). Then `fs.ts` reaches rename another way; report it.

## Maintenance notes

- Plans 104, 121 and 122 change code near these tests; these tests are the
  safety net for them.
- If `runExclusive` gains a test hook later, add the "map entry is dropped
  after the chain drains" assertion.
