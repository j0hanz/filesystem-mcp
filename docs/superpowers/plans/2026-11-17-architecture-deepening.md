# Architecture deepening implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate same-Entry judgment, watcher lease ownership, and failure-resistant RuntimeState disposal in one ordered change.

**Architecture:** Tasks 1-4 implement ADR-021 and give four Batch tools one PathGuard same-Entry rule. Task 5 implements ADR-022 as one atomic registry and adapter migration. Tasks 6-7 implement ADR-023 on top of owned leases, with instance cleanup before shared-state disposal.

**Tech Stack:** TypeScript on Node, `node:test`, zod, MCP TypeScript SDK, Express, Node HTTP, `fs.watch`.

**Spec:**

- `docs/adr/021-same-entry-follows-the-guards-directory-rule.md`
- `docs/adr/022-watcher-registry-owns-lease-lifetimes.md`
- `docs/adr/023-runtime-state-owns-complete-disposal.md`
- **Entry**, **Respelling**, **Batch**, and **Watcher lease** in `GLOSSARY.md`

## Global Constraints

- Branch from `main`, deliver one PR, and execute Tasks 1-8 in order.
- Keep every task's commit green. Task 5 is the atomic watcher migration, so its registry and adapter changes share one test cycle and commit.
- Keep same-Entry error codes and messages unchanged. Out of scope are root and grant comparisons, Scan matching, containment checks, create's file-versus-directory conflict, and undo comparisons.
- The same-Entry judge never reads a directory outside the allowed roots. With no ancestor inside a root, it uses `IS_CASE_INSENSITIVE_FS`.
- Every successful watcher acquisition owns an independent lease. Resource subscribe idempotence remains per connection.
- Pending lease disposal resolves `{ ok: false, reason: 'cancelled' }` without waiting for path validation. Late validation must not attach a watcher.
- Preserve watcher aliases, the 50 ms debounce, `MAX_WATCHERS`, watcher-error recovery, root revocation, and ADR-003 legacy HTTP behavior.
- The internal watcher reason `stale` becomes `cancelled`; its message stays `subscription was cancelled during setup`.
- `RuntimeState.dispose(): void` and `FilesystemServerContext.disposeRuntimeState(): void` never throw. They log every failure through `Logger.error` with `formatUnknownErrorMessage`.
- RuntimeState retries only failed cleanups. Its first disposal stops resource-change notifications, even when failures remain.
- A server context disposes only self-created state. Injected state survives instance closure.
- Release instance subscriptions and stdio listen leases before registry destruction. Preserve HTTP handler closure, receive timeouts, and stdio stdin handling.
- Do not add a generic teardown engine, a shared stdio/HTTP request state machine, or test-only dependency-injection bags.
- No contract snapshot change is expected. After code changes, run `graphify update .`. Gate the final change with `npm run check`.

## Review Focus

1. An unreadable directory or a path outside every root must not throw or read outside the roots during same-Entry judgment. Task 1 adds both tests.
2. Two new files under a folder created by the same Batch must follow Unicode and directory-case rules. Task 3 adds the NFC/NFD test.
3. Pending watcher cancellation must settle before validation and prevent a late watcher. Task 5 adds direct registry and listen-preparation tests.
4. Two leases sharing one callback must not detach that callback until the final lease ends. Task 5 adds the shared-callback test and keeps HTTP fan-out coverage.
5. Cleanup failure must not skip later cleanup, repeat successful cleanup, escape instance closure, or destroy injected state. Tasks 6 and 7 add exact call-count, logging, retry, and ownership tests.

---

### Task 1: Add PathGuard same-Entry keys

**Files:**

- Modify: `src/core/path.ts`
- Test: create `__tests__/path-guard-entry-keys.test.ts`

**Interfaces:**

- Consumes: `PathGuard.isDirectoryCaseSensitive`, `unicodeMatchKey`, `unicodeMatchKeyExactCase`, and `IS_CASE_INSENSITIVE_FS`.
- Produces:

  ```ts
  /** One key per path, in order; equal keys name one Entry. Paths are absolute. */
  entryKeys(paths: readonly string[], signal?: AbortSignal): Promise<string[]>;
  ```

  The key is `resolve(path)` folded with `unicodeMatchKey` when its rule directory is case-insensitive, or `unicodeMatchKeyExactCase` otherwise. The rule directory is the nearest existing ancestor of `dirname(path)` inside an allowed root. Read each rule directory once per call with a Map keyed by real path.

- [ ] **Step 1: Write the failing tests**

Cover Unicode form, spaces, per-directory case, missing parents, and distinct names:

```ts
const caseless = process.platform === 'win32' || process.platform === 'darwin';
const [a, b, c, d] = await guard.entryKeys([
  join(root, 'café.txt'),
  join(root, 'café.txt'),
  join(root, 'shot PM.png'),
  join(root, 'shot PM.png'),
]);
assert.strictEqual(a, b);
assert.strictEqual(c, d);

const [upper, lower] = await guard.entryKeys([
  join(root, 'k', 'Name.txt'),
  join(root, 'k', 'NAME.txt'),
]);
assert.strictEqual(upper === lower, caseless);

const [newUpper, newLower] = await guard.entryKeys([
  join(root, 'new', 'x.txt'),
  join(root, 'NEW', 'X.txt'),
]);
assert.strictEqual(newUpper === newLower, caseless);

const [first, second] = await guard.entryKeys([join(root, 'a.txt'), join(root, 'b.txt')]);
assert.notStrictEqual(first, second);
```

Add a POSIX-only mode-000 parent test that yields keys without throwing. Add `falls back to the platform rule outside the roots`, using two paths under `tmpdir()` and asserting no throw and `a === b === caseless` through separate comparisons.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="entryKeys|folds Unicode form|directory rule|nearest existing ancestor|different names apart|outside the roots"`

Expected: FAIL with `guard.entryKeys is not a function`.

- [ ] **Step 3: Implement `PathGuard.entryKeys`**

Implement the interface and caching rule above. Walk upward only inside an allowed root, stop at that root, and use the platform rule when no allowed ancestor exists. A directory read failure falls back to the next ancestor. Honor an aborted signal without reading further directories.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="entryKeys|folds Unicode form|directory rule|nearest existing ancestor|different names apart|outside the roots"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/path.ts __tests__/path-guard-entry-keys.test.ts
git commit -m "feat(path): judge same-Entry by the guard's directory rule"
```

### Task 2: Move edit duplicate checks into execution

**Files:**

- Modify: `src/tools/edit.ts:117-130`
- Test: `__tests__/edit.test.ts:169-187`

**Interfaces:**

- Consumes: Task 1's `ctx.fs.pathGuard.entryKeys(paths, signal)`.
- Produces: duplicate refusal before any edit Rewrite starts.

- [ ] **Step 1: Write the failing tests**

Move the existing same-file-twice test off `schemaIssues`. Assert an `INVALID_INPUT` call result matching `duplicate of files\[0\]\.path; put every edit for one file in a single entry`, with the file unchanged. Add `refuses NFC and NFD spellings of one file in one batch` with entries for `café.txt` and `café.txt` and the same assertions.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="same file twice|NFC and NFD spellings of one file"`

Expected: FAIL because the NFD spelling passes the current ASCII-only check and the old error uses the schema path.

- [ ] **Step 3: Implement the execution-time check**

Remove only the duplicate check from the zod refinement. Before any Rewrite, call `entryKeys(files.map((file) => file.path), ctx.signal)`. On the first repeated key, throw `FsError(ErrorCode.INVALID_INPUT, ...)` with `files.<i>.path: duplicate of files[<first>].path; put every edit for one file in a single entry`. Remove `isSamePath` only if unused.

- [ ] **Step 4: Run edit tests**

Run: `npm test -- --test-name-pattern="edit"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/edit.ts __tests__/edit.test.ts
git commit -m "fix(edit): refuse respellings of one file in a batch"
```

### Task 3: Use same-Entry keys in create

**Files:**

- Modify: `src/tools/create.ts:89-140,343-366`
- Test: `__tests__/create.test.ts:123-195`

**Interfaces:**

- Consumes: Task 1's `entryKeys`.
- Produces: one duplicate rule for directories, files, and planned Landing paths.

- [ ] **Step 1: Write the failing tests**

Move the duplicate-files test off `schemaIssues` and assert `INVALID_INPUT` with `duplicate of files\[0\]\.path; one entry per file`. Add `treats NFC and NFD new files under a new folder as one entry`, using `nf/café.txt` and `nf/café.txt` where `nf` does not exist, and assert nothing is written. Add a non-Linux test where `dirs: ['d1', 'D1']` produces `duplicate of directories\[0\]; one entry per directory`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="one entry per file|NFC and NFD new files|one entry per directory"`

Expected: FAIL because duplicate errors still use `schemaIssues` or miss Unicode respellings.

- [ ] **Step 3: Implement create key checks**

Move duplicate checks out of the zod refinement while retaining file-versus-directory conflicts. Before planning, call `entryKeys` once over `[...directories, ...files.map((file) => file.path)]`. Refuse repeated keys within each input class with the existing messages and `directories.N:` or `files.N.path:` prefixes.

After planning, call `entryKeys` once over every plan's `validPath` and use those keys for the Landing map. Preserve overlap and Confirmation behavior.

- [ ] **Step 4: Run create tests**

Run: `npm test -- --test-name-pattern="create"`

Expected: PASS, including `another entry in this batch` cases.

- [ ] **Step 5: Commit**

```bash
git add src/tools/create.ts __tests__/create.test.ts
git commit -m "refactor(create): judge duplicate entries through the path guard"
```

### Task 4: Use same-Entry keys in move and delete

**Files:**

- Modify: `src/tools/move.ts:160-201`
- Modify: `src/tools/delete.ts:146-160`
- Test: `__tests__/move.test.ts`
- Test: `__tests__/delete.test.ts:726-779`

**Interfaces:**

- Consumes: Task 1's `entryKeys`.
- Produces: destination deduplication for move and key-plus-identity deduplication for delete.

- [ ] **Step 1: Write the failing delete test**

Add `collapses NFC and NFD names of one entry`, skipped on Linux. Create `café.txt`, call delete with both spellings, and assert one result has `deleted: true`, the other is `omitted`, and the file is gone. Keep the identity requirement.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="collapses NFC and NFD"`

Expected: FAIL because the second spelling currently plans again.

- [ ] **Step 3: Implement move and delete key comparisons**

Compute keys once per call before either tool's loops. In move, replace `destKey` with `entryKeys` over ready destinations and leave `touches` unchanged. In delete, compare `entryKeys` over validated paths and retain `sameIdentity`.

- [ ] **Step 4: Run move and delete tests**

Run: `npm test -- --test-name-pattern="move|delete"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/move.ts src/tools/delete.ts __tests__/move.test.ts __tests__/delete.test.ts
git commit -m "refactor(move,delete): judge same-Entry through the path guard"
```

### Task 5: Own watcher leases across all adapters

**Files:**

- Modify: `src/core/watcher-registry.ts:25-412`
- Modify: `src/resources.ts:253-418`
- Modify: `src/transport/shared.ts:74-129`
- Modify: `src/transport/stdio.ts:29-39,225-234,299-421`
- Modify: `src/transport/http.ts:214-258`
- Test: `__tests__/watcher-registry.test.ts`
- Test: `__tests__/resources-subscribe.test.ts:36-201`
- Test: `__tests__/subscriptions-listen.test.ts`
- Test: `__tests__/stdio.test.ts:462-851`

**Interfaces:**

- Produces:

  ```ts
  export type WatcherAttachResult =
    | { ok: true }
    | { ok: false; reason: 'cancelled' | 'capped' | 'bad-uri' | 'attach-failed' }
    | { ok: false; reason: 'invalid-path'; error: unknown };

  export interface WatcherLease {
    readonly ready: Promise<WatcherAttachResult>;
    dispose(): void;
  }

  acquire(
    pathGuard: PathGuard,
    uri: string,
    notify: (uri: string) => void,
  ): WatcherLease;
  ```

- Produces for listen adapters:

  ```ts
  export type ListenPreparation =
    { readonly ok: true } | { readonly ok: false; readonly message: string };

  export async function prepareListenWatchers(
    uris: readonly string[],
    pathGuard: PathGuard,
    registry: WatcherRegistry,
    notify: (uri: string) => void,
    leases: WatcherLease[],
  ): Promise<ListenPreparation>;
  ```

- [ ] **Step 1: Write failing registry lease tests**

Add `cancelling a pending lease resolves ready before validation settles`:

```ts
const validation = Promise.withResolvers<string>();
const guard = {
  validateExistingPath: () => validation.promise,
  isInsideAllowed: () => true,
} as unknown as PathGuard;
const lease = registry.acquire(guard, uri, () => {});
lease.dispose();
assert.deepEqual(await lease.ready, { ok: false, reason: 'cancelled' });
validation.resolve(filePath);
await setTimeout(0);
assert.equal(watchers.length, 0);
assert.equal(registry.size(), 0);
lease.dispose();
```

Add `owns independent same-URI leases and detaches callbacks per lease`. Acquire two leases with callbacks that push `'first'` and `'second'`. Dispose the first twice, fire, and assert only the second callback runs and size remains 1. Dispose the second, fire again, and assert silence and size 0.

Add `a shared callback survives until its final lease ends`. Two leases use one callback. After one disposal, one event produces one callback. After the final disposal, another event produces none.

Add `destroying the registry cancels pending acquisition`. Start with deferred validation, destroy the registry, assert the exact cancelled result, resolve validation late, and assert no watcher appears.

- [ ] **Step 2: Write failing adapter tests**

Add `disposing a pending listen preparation cancels acquisition` to `__tests__/subscriptions-listen.test.ts`. Use a real registry, deferred guard, one URI, and a `WatcherLease[]` fifth argument. Assert the array gains one lease synchronously. Dispose it, resolve the path, and assert a non-OK result containing `subscription was cancelled during setup` and size 0.

Add `a fresh subscribe after pending unsubscribe stays active` to `__tests__/resources-subscribe.test.ts`. Use a dedicated RuntimeState, server, and in-memory client. Mock `state.pathGuard.validateExistingPath` with a separate deferred promise per acquisition. Start subscribe, unsubscribe, then a fresh subscribe while the first validation is pending. Resolve the first and assert cancellation without attachment. Resolve the second, write the file, and assert the fresh subscription receives an update. Clean up with unsubscribe, state disposal, and root cleanup.

Keep existing repeated-subscribe, unrelated-unsubscribe, mixed-listen rollback, stdio pending-cancellation, HTTP fan-out, and remaining-subscriber behavior.

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `npm test -- --test-name-pattern="pending lease|independent same-URI|shared callback|cancels pending acquisition|pending listen preparation|fresh subscribe after pending"`

Expected: FAIL because `acquire` has no synchronous lease handle and listen preparation has no lease array.

- [ ] **Step 4: Implement registry-owned leases**

Implement the interfaces above. Remove `markSubscribe` and public `release(uri)`.

Use one internal record per lease with `pending`, `settled`, or `disposed` state, its URI, callback, and `ready` resolver. Replace `subscriberCounts`, `activeCallbacks`, and `pendingSubscribes` with per-URI lease sets. Pending disposal resolves `ready` immediately. Acquisition checks the record after every await so late validation cannot attach. Settled disposal removes the record and drops the watcher only after the final URI lease ends.

Build notification rounds from callbacks belonging to live leases, deduplicated by function identity. Keep `hasWatcher`, `size`, and `destroy`; `destroy` disposes every lease before closing watchers. Migrate existing registry tests to `handle.ready` and `handle.dispose()`, and update comments that describe caller-managed URI ref-counts.

- [ ] **Step 5: Migrate the resource subscription adapter**

Replace `leasedUris`, `cancelled`, and `activeCallbacks` with `leases: Map<string, WatcherLease>`. Retain `inflight: Map<string, Promise<boolean | undefined>>` for concurrent duplicate subscribes.

Store each lease immediately. Unsubscribe deletes the current maps' entries and disposes that lease, whether pending or settled. A fresh subscribe after pending unsubscribe gets a new lease. Guard `finally` cleanup by promise or lease identity so an old acquisition cannot delete a fresh subscription. Preserve error translation and map `cancelled` to the current successful no-subscription result.

When a settled subscription's watcher has errored, dispose its old lease before reacquiring. `destroy` disposes every lease, clears both maps, and destroys the registry only when `ownsRegistry` is true.

- [ ] **Step 6: Migrate listen preparation, stdio, and HTTP**

Push each lease into the caller's array before awaiting it. On failure, dispose every lease in the array, clear it, and return the existing message. Keep the over-cap precheck and all-or-nothing behavior.

In stdio, replace `StdioListenState.acquiredUris` with `leases`. `releaseListen` disposes each handle. Pending cancellation disposes existing handles immediately but keeps request state until serialized preparation exits. If cancellation causes preparation to fail, suppress the error response because the cancelled request was never delivered. Preserve request-ID reuse, delivery, and completion rules.

In HTTP, create the lease array and its idempotent dispose closure before awaiting preparation. Attach response-close handling before the await so early closure disposes pending handles. After success, the response owns those handles. Preserve handler-error release and JSON-RPC responses.

- [ ] **Step 7: Run watcher and adapter tests**

Run: `npm test -- --test-name-pattern="pending lease|independent same-URI|shared callback|cancels pending acquisition|pending listen preparation|fresh subscribe after pending"`

Expected: PASS.

Run: `npm test -- --test-name-pattern="watcher registry|Resource subscriptions|subscription|listen"`

Expected: PASS, including cap, alias, rollback, cancellation, fan-out, and root-revocation cases.

- [ ] **Step 8: Commit the atomic watcher migration**

```bash
git add src/core/watcher-registry.ts src/resources.ts src/transport/shared.ts src/transport/stdio.ts src/transport/http.ts __tests__/watcher-registry.test.ts __tests__/resources-subscribe.test.ts __tests__/subscriptions-listen.test.ts __tests__/stdio.test.ts
git commit -m "refactor(watchers): own subscription lease lifetimes"
```

### Task 6: Make RuntimeState cleanup complete and retryable

**Files:**

- Modify: `src/server.ts:9-17,53-96`
- Test: `__tests__/resources-subscribe.test.ts:203-249`

**Interfaces:**

- Consumes: `WatcherRegistry.destroy`, `PageSnapshotStore.clear`, `UndoJournal.clear`, `ResourceStore.clear`, `Logger.error`, and `formatUnknownErrorMessage`.
- Produces: no-throw `RuntimeState.dispose(): void` with per-operation retry.

- [ ] **Step 1: Write failing owned-state cleanup tests**

Add `logs every cleanup failure and retries only failed cleanup`. Import `Logger`. Mock the returned state's methods so only `undoJournal.clear` throws `Error('clear failed')` on its first call:

```ts
const state = createRuntimeState({ cliAllowedDirs: [tmpdir()] });
let failUndo = true;
const undo = t.mock.method(state.undoJournal, 'clear', () => {
  if (failUndo) throw new Error('clear failed');
});
const pages = t.mock.method(state.pageStore, 'clear', () => {});
const resources = t.mock.method(state.resourceStore, 'clear', () => {});
const watchers = t.mock.method(state.watcherRegistry, 'destroy', () => {});
const logged = t.mock.method(Logger, 'error', () => {});

assert.doesNotThrow(() => state.dispose());
assert.equal(undo.mock.callCount(), 1);
assert.equal(pages.mock.callCount(), 1);
assert.equal(resources.mock.callCount(), 1);
assert.equal(watchers.mock.callCount(), 1);
assert.ok(logged.mock.calls.some((call) => String(call.arguments[1]).includes('clear failed')));

failUndo = false;
state.dispose();
assert.equal(undo.mock.callCount(), 2);
assert.equal(pages.mock.callCount(), 1);
assert.equal(resources.mock.callCount(), 1);
assert.equal(watchers.mock.callCount(), 1);
```

Add `stops change notifications while failed cleanup awaits retry`. Create RuntimeState with an `onResourcesChanged` spy and make one cleanup fail. Call `state.resourceStore.putText({ name: 'x.txt', text: 'x' })` to arm the 100 ms timer. Dispose, wait 150 ms, and assert no notification. Make the failed cleanup succeed, dispose again, and assert completion without a delayed notification.

Keep `createRuntimeState dispose clears the page store` as the normal idempotence check.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="retries only failed cleanup|failed cleanup awaits retry"`

Expected: FAIL because the first cleanup throw escapes and skips later operations.

- [ ] **Step 3: Implement per-operation cleanup tracking**

Import `formatUnknownErrorMessage` in `src/server.ts`. Replace the short-circuiting sequence with a private list:

```ts
interface OwnedCleanup {
  readonly label: string;
  readonly run: () => void;
  done: boolean;
}
```

Include the changed timer, watcher registry, page store, undo journal, and resource store in that order. Each `run` closure reads the live method at call time so test mocks need no production injection seam.

Set `disposed = true` on the first call so notifications stay suppressed. For each incomplete cleanup, run it inside `try`, set `done = true` only after success, and log failures as:

```ts
Logger.error(`[Runtime] ${cleanup.label} cleanup failed:`, formatUnknownErrorMessage(error));
```

After successful timer cleanup, set `changedTimer = undefined`. Later calls skip successful entries and retry failed entries. Return normally after every attempt.

- [ ] **Step 4: Run owned-state tests**

Run: `npm test -- --test-name-pattern="retries only failed cleanup|failed cleanup awaits retry|dispose clears the page store"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts __tests__/resources-subscribe.test.ts
git commit -m "fix(server): finish cleanup after owned-state failures"
```

### Task 7: Separate instance cleanup and order transport teardown

**Files:**

- Modify: `src/server.ts:244-259`
- Modify: `src/transport/stdio.ts:225-263`
- Modify: `src/transport/http.ts:383-407`
- Test: `__tests__/resources-subscribe.test.ts:203-249`
- Test existing behavior: `__tests__/http-server.test.ts:81-125`
- Test existing behavior: `__tests__/stdio.test.ts:462-851`

**Interfaces:**

- Consumes: Task 5's `WatcherLease.dispose` and Task 6's no-throw RuntimeState disposal.
- Produces: no-throw `FilesystemServerContext.disposeRuntimeState(): void` with creator-only shared-state ownership.

- [ ] **Step 1: Write failing instance-ownership tests**

Add `instance cleanup logs lease failures and preserves injected state`. Create a root and injected RuntimeState, then add a page-store entry. Mock `state.watcherRegistry.acquire` to return:

```ts
{
  ready: Promise.resolve({ ok: true } as const),
  dispose(): void {
    throw new Error('lease failed');
  },
}
```

Subscribe to a filesystem URI, mock `Logger.error`, and close the client. Assert closure does not reject, a log argument contains `lease failed`, and `state.pageStore.read(pageId, 'q').items` remains `[1]`. Dispose injected state and clean up the root in `finally`.

Add `closing a self-owned instance disposes its RuntimeState`. Spy on `ResourceStore.prototype.clear` while retaining its implementation, create a server without `extraDeps.state`, connect an in-memory client, and close it. Assert the spy ran once for the self-created store.

- [ ] **Step 2: Run the instance tests**

Run: `npm test -- --test-name-pattern="instance cleanup logs lease failures|self-owned instance disposes"`

Expected: the lease-failure test FAILS because registration disposal throws. The self-owned state test passes as an ownership pin.

- [ ] **Step 3: Implement no-throw instance cleanup**

Keep `cleanedUp` as the per-instance guard. Call `resourceDisposable.dispose()` inside `try`. Log failure as:

```ts
Logger.error('[Server] Resource registration cleanup failed:', formatUnknownErrorMessage(error));
```

Then call `state.dispose()` only when `ownsState` is true. Injected state remains untouched. The existing `server.server.onclose` hook needs no catch around context disposal.

- [ ] **Step 4: Order stdio and HTTP teardown**

In stdio `cleanupConnection`, keep the `closed` guard. Call `releaseListen` for a snapshot of every listen ID, capture and clear `activeCtx`, call `ctx?.disposeRuntimeState()`, then call `runtime.dispose()`. Keep `process.stdin.unref()` in its own catch because file-backed stdin has no `unref`. Remove catches around RuntimeState and context disposal. Preserve outer close and `wire.onclose` ordering.

In HTTP `teardown`, keep rate-limiter closure and `modernHandler.close().catch(...).finally(...)`. Replace the `try/catch` around `state.dispose()` with one direct call inside `finally`. `HTTP-LIFE-002` must still close and log through RuntimeState.

- [ ] **Step 5: Run instance and transport lifecycle tests**

Run: `npm test -- --test-name-pattern="instance cleanup logs lease failures|self-owned instance disposes|injected state survives|closing a connected client"`

Expected: PASS.

Run: `npm test -- --test-name-pattern="HTTP-LIFE|Stdio subscription lease lifecycle"`

Expected: PASS, including close after throwing undo cleanup and natural stdio exit after overflow.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/transport/stdio.ts src/transport/http.ts __tests__/resources-subscribe.test.ts
git commit -m "fix(server): dispose instances before shared state"
```

### Task 8: Record and verify the consolidated change

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `graphify-out`
- Review: the three ADRs against the implementation. Stop and revise the design if behavior diverges rather than silently changing a decision.

**Interfaces:**

- Consumes: Tasks 1-7.
- Produces: no runtime interface.

- [ ] **Step 1: Add changelog entries**

Under Unreleased, cover these user-visible changes:

- `edit` and `delete` treat Unicode respellings of one file as one item, and Batch tools follow per-directory case sensitivity.
- Watcher subscriptions cancel pending acquisition and detach callbacks through independent leases.
- Shutdown attempts every owned cleanup, logs failures, retries failed cleanup, and releases subscriptions before shared-state disposal.

Do not claim a wire-schema change.

- [ ] **Step 2: Update the graph and run the full repository check**

Run: `graphify update .`

Run: `npm run check`

Expected: PASS. `__tests__/contract.test.ts.snapshot` remains unchanged.

- [ ] **Step 3: Commit documentation and the graph**

```bash
git add CHANGELOG.md GLOSSARY.md docs/adr/021-same-entry-follows-the-guards-directory-rule.md docs/adr/022-watcher-registry-owns-lease-lifetimes.md docs/adr/023-runtime-state-owns-complete-disposal.md docs/superpowers/plans/2026-11-17-architecture-deepening.md graphify-out
git commit -m "docs: record architecture deepening decisions"
```
