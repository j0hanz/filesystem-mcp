# Plan 092: Watcher leases stay balanced when an unsubscribe races a subscribe or an attach fails

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- src/resources.ts src/core/watcher-registry.ts __tests__/resources.test.ts __tests__/resources-subscribe.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

A client subscribes to a file URI and the server holds one filesystem watcher
per URI, shared by every subscriber through a lease count. Two paths leave
that count wrong:

1. An `unsubscribe` that arrives while the `subscribe` for the same URI is
   still validating its path is ignored. The subscribe then completes, so the
   client keeps receiving `notifications/resources/updated` after it
   unsubscribed, and one of the 256 watcher slots stays held until the
   connection closes.
2. When creating the OS watcher fails, the rollback calls `release(uri)`. If
   other subscribers still hold leases on that URI (their watcher died
   earlier with an `'error'` event), the rollback takes one of _their_ counts.
   A later subscriber's live watcher is then torn down early and it silently
   stops getting notifications.

Neither the watcher `'error'` path nor the attach-failure rollback has a test.

## Current state

Files:

- `src/core/watcher-registry.ts`: `createWatcherRegistry()`: the
  uri → `FSWatcher` map, callbacks, lease counts, and `acquire`.
- `src/resources.ts`: the per-connection `subscribe` / `unsubscribe` pair
  that takes and releases leases.
- `__tests__/resources.test.ts`: unit tests on the registry (search for
  `TC-FUNC-063`).
- `__tests__/resources-subscribe.test.ts`: round-trip tests through a client.

`src/resources.ts:268-322` (abridged to the lines that matter):

```ts
    subscribe(uri, notify) {
      if (leasedUris.has(uri)) {
        if (registry.hasWatcher(uri)) return undefined;
        leasedUris.delete(uri);
        registry.release(uri);
      }
      // A subscribe for this URI is mid-acquire: share its outcome instead of
      // taking a second lease the lease set cannot represent.
      const pending = inflight.get(uri);
      if (pending) return pending;

      const acquire = async (): Promise<boolean | undefined> => {
        const result = await registry.acquire(options.pathGuard, uri, notify, {
          markSubscribe: true,
        });
        if (result.ok) {
          leasedUris.add(uri);
          return undefined;
        }
        // ... failure branches ...
      };

      const promise = acquire().finally(() => inflight.delete(uri));
      inflight.set(uri, promise);
      return promise;
    },

    unsubscribe(uri) {
      // Only release a lease this connection actually took.
      if (!leasedUris.delete(uri)) return;
      registry.release(uri);
    },
```

`leasedUris` (a `Set<string>`) and `inflight` (a
`Map<string, Promise<boolean | undefined>>`) are declared near
`src/resources.ts:182-188`. While a subscribe is in flight the URI is in
`inflight` but not yet in `leasedUris`, so `unsubscribe` returns at once.

`src/core/watcher-registry.ts:74-78` (why counts outlive a dead watcher):

```ts
// Tears down the watcher itself, NOT the ref-count. The 'error' event calls
// this with leases still outstanding: clearing the count there would let the
// next release from one of those leases decrement from zero and drop a
// watcher a later subscriber re-established for the same URI. `drop` below is
// the only path that ends leases, and it is the only one that clears them.
```

`src/core/watcher-registry.ts:184-191`:

```ts
const release = (uri: string): void => {
  const remaining = (subscriberCounts.get(uri) ?? 0) - 1;
  if (remaining > 0) {
    subscriberCounts.set(uri, remaining);
    return;
  }
  drop(uri);
};
```

`src/core/watcher-registry.ts:323-332` (the faulty rollback, inside `acquire`):

```ts
addCallback(uri, notify);
if (!attach(uri, resolved)) {
  // fs.watch threw (inotify exhaustion, or a race deleted the path): roll
  // back so no dangling callback is left believing a watcher exists. No
  // lease was taken yet, so `release` drops the entry outright.
  release(uri);
  return fail({ ok: false, reason: 'attach-failed' });
}
retain(uri);
return { ok: true };
```

The comment's claim "No lease was taken yet" is true for _this_ call but not
for other holders whose counts survived a watcher error.

`addCallback` (`:161-173`) adds `notify` to `activeCallbacks.get(uri)` (a
`Set`), creating the set when absent.

Test conventions: Node's built-in runner (`node:test`), `assert` from
`node:assert/strict`. To fake a Node builtin, tests use
`t.mock.method(...)` followed by `syncBuiltinESMExports()` from `node:module`,
and restore both in `finally`. Exemplar, `__tests__/scan.test.ts:549-561`:

```ts
t.mock.method(fsPromises, 'opendir', () => new Promise<Dir>(() => {}));
syncBuiltinESMExports();
try {
  // ...
} finally {
  t.mock.restoreAll();
  syncBuiltinESMExports();
}
```

Registry test exemplar, `__tests__/resources.test.ts` `TC-FUNC-063`:

```ts
const registry = createWatcherRegistry();
const testFile = await writeTestFile(tmpDir, 'watch_test.txt', 'initial');
const testUri = buildFileResourceUri(testFile);
const result = await registry.acquire(pathGuard, testUri, (uri) => {
  notifications.push(uri);
});
assert.strictEqual(result.ok, true);
assert.strictEqual(registry.hasWatcher(testUri), true);
// ...
registry.destroy();
```

## Commands you will need

| Purpose          | Command                                                                  | Expected on success |
| ---------------- | ------------------------------------------------------------------------ | ------------------- |
| Install          | `npm ci`                                                                 | exit 0              |
| Type-check tests | `npm run type-check:test`                                                | exit 0              |
| Lint             | `npm run lint`                                                           | exit 0, no warnings |
| Registry tests   | `node --test --test-timeout=60000 __tests__/resources.test.ts`           | `# fail 0`          |
| Round-trip tests | `node --test --test-timeout=60000 __tests__/resources-subscribe.test.ts` | `# fail 0`          |
| Full check       | `npm run check`                                                          | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/watcher-registry.ts`
- `src/resources.ts`
- `__tests__/resources.test.ts`
- `__tests__/resources-subscribe.test.ts`
- `CHANGELOG.md`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `src/transport/stdio.ts`, `src/transport/http.ts`, `src/transport/shared.ts`
  (the listen paths). They call `registry.acquire` / `registry.release`
  directly and are not part of this fix.
- The `attach` function and the `{ recursive: true }` option in
  `watcher-registry.ts`. Plan 100 changes that; keep the diffs apart.
- The `desiredState` / `isStale` machinery. Leave it as is.

## Git workflow

- Branch: `advisor/092-watcher-leases-stay-balanced`
- Two commits, one per fix. Message style from `git log`:
  `fix(confirmation): ask again when two items saw different entries at one path`.
  Use `fix(resources): honor an unsubscribe that lands during its subscribe`
  and `fix(watcher): keep other leases when attaching a watcher fails`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Failing test for the attach-failure rollback

In `__tests__/resources.test.ts`, next to `TC-FUNC-063`, add a test named
`'WatcherRegistry - a failed attach leaves other leases alone'`. Add imports
as needed: `import fs from 'node:fs';` and
`import { syncBuiltinESMExports } from 'node:module';`.

Sequence (all on one URI of a real temp file, one `createWatcherRegistry()`):

1. Mock `fs.watch` so it calls the real `fs.watch` and pushes the returned
   watcher into a local array `made`. Call `syncBuiltinESMExports()`.
2. `acquire` twice (leases A and B). Assert both `ok`.
3. `made[0].emit('error', new Error('boom'))`. Assert
   `registry.hasWatcher(uri) === false`.
4. Re-mock `fs.watch` to throw `new Error('ENOSPC')`; sync. `acquire` once
   more (C). Assert `{ ok: false, reason: 'attach-failed' }`.
5. Restore the real `fs.watch` (`t.mock.restoreAll()`; sync).
6. `registry.release(uri)` (lease A ends).
7. `acquire` (D). Assert `ok` and `hasWatcher(uri) === true`.
8. `registry.release(uri)` (lease B ends).
9. Assert `registry.hasWatcher(uri) === true`: D still holds a lease.
10. `registry.destroy()` in `finally`, with `t.mock.restoreAll()` and
    `syncBuiltinESMExports()`.

**Verify**: `node --test --test-timeout=60000 __tests__/resources.test.ts` →
the new test FAILS at step 9. All other tests pass.

### Step 2: Roll back only what the failed attach added

In `src/core/watcher-registry.ts`, replace the rollback block shown in
"Current state" with:

```ts
addCallback(uri, notify);
if (!attach(uri, resolved)) {
  // fs.watch threw (inotify exhaustion, or a race deleted the path): take
  // back the callback this call added. Not `release`: leases whose
  // watcher errored still hold their counts (see `dropWatcher`), and a
  // release here would end one of theirs.
  const callbacks = activeCallbacks.get(uri);
  callbacks?.delete(notify);
  if (callbacks?.size === 0) activeCallbacks.delete(uri);
  return fail({ ok: false, reason: 'attach-failed' });
}
```

**Verify**: `node --test --test-timeout=60000 __tests__/resources.test.ts` →
`# fail 0`.

### Step 3: Failing test for unsubscribe during subscribe

In `__tests__/resources-subscribe.test.ts`, in the
`'Resource subscriptions round-trip'` describe block, add a test named
`'an unsubscribe sent before its subscribe settles leaves no subscription'`.
Read the existing first test in that block
(`'subscribe -> file modification -> notification -> unsubscribe'`) and reuse
its way of proving silence with a local notification handler.

Sequence:

1. Create a new file `race.txt` in `tmpDir`; build its URI with
   `buildFileResourceUri`.
2. Start both requests without awaiting the first:
   `const sub = pair.client.subscribeResource({ uri });`
   `const unsub = pair.client.unsubscribeResource({ uri });`
   `await Promise.all([sub, unsub]);`
3. Register a handler that records `notifications/resources/updated` for this
   URI, write new content to the file, wait 300 ms.
4. Assert that zero notifications for this URI arrived.

**Verify**: `node --test --test-timeout=60000 __tests__/resources-subscribe.test.ts`
→ the new test FAILS (one notification arrives). If it PASSES, see STOP
conditions.

### Step 4: Honor the unsubscribe once the subscribe settles

In `src/resources.ts`:

1. Next to the `inflight` declaration add:

```ts
// URIs whose in-flight subscribe was unsubscribed before it settled: the
// lease it is about to take is given back instead of kept.
const cancelled = new Set<string>();
```

2. In `subscribe`, change the pending branch to:

```ts
const pending = inflight.get(uri);
if (pending) {
  // A fresh subscribe outranks an unsubscribe that came before it.
  cancelled.delete(uri);
  return pending;
}
```

3. In the `acquire` closure, change the success branch to:

```ts
if (result.ok) {
  if (cancelled.delete(uri)) {
    registry.release(uri);
    return undefined;
  }
  leasedUris.add(uri);
  return undefined;
}
```

4. Change the `.finally` to also clear the marker:

```ts
const promise = acquire().finally(() => {
  inflight.delete(uri);
  cancelled.delete(uri);
});
```

5. Change `unsubscribe` to:

```ts
    unsubscribe(uri) {
      // Mid-subscribe: no lease exists yet, so mark it for release on arrival.
      if (inflight.has(uri) && !leasedUris.has(uri)) {
        cancelled.add(uri);
        return;
      }
      // Only release a lease this connection actually took.
      if (!leasedUris.delete(uri)) return;
      registry.release(uri);
    },
```

**Verify**: `node --test --test-timeout=60000 __tests__/resources-subscribe.test.ts`
→ `# fail 0`.

### Step 5: Changelog and full check

In `CHANGELOG.md`, under `## [Unreleased]` → `### Fixed`, append:

```markdown
- **Resource subscriptions**: an unsubscribe that arrives while its subscribe is still validating the path now takes effect; before, the subscription stayed live. A watcher that fails to start no longer ends another subscriber's lease.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- `__tests__/resources.test.ts`: one new registry test (Step 1). It also
  covers the watcher `'error'` path, which had no test.
- `__tests__/resources-subscribe.test.ts`: one new round-trip test (Step 3).
- Verification: both files report `# fail 0`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "release(uri);" src/core/watcher-registry.ts` shows no match inside `acquire` (the only `release` left is the `const release` definition and the returned property)
- [ ] `grep -c "cancelled" src/resources.ts` returns at least 5
- [ ] Both new tests exist and pass
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- In Step 1, emitting `'error'` on the captured watcher does not make
  `hasWatcher` false, or mocking `fs.watch` does not reach the registry (the
  registry imports `watch` by name from `node:fs`; `syncBuiltinESMExports()`
  is what makes the mock visible).
- The Step 3 test PASSES before Step 4. The race is then not reproducible
  through the in-memory client. Do Steps 1-2 only, report, and leave Steps
  3-4 undone.
- The Step 3 test is flaky across 5 consecutive runs after Step 4.

## Maintenance notes

- Plan 100 edits `attach` in the same file. Land this plan first.
- A related LOW-confidence lead was not planned: the `stale` return in
  `acquire` never clears an `'unsubscribed'` marker set by another holder's
  release. Revisit if a listen attach is ever seen failing as `stale`.
- Reviewer: check that `cancelled` cannot leak (it is cleared in `.finally`).
