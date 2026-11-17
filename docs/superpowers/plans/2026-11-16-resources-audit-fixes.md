# Resources Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the eight findings of the 2026-11-16 MCP resources audit: silent watcher death, root-revoke leaks on the modern listen path, directory/alias/error-code/completion/notification gaps.

**Architecture:** Most fixes land in the shared `WatcherRegistry` (`src/core/watcher-registry.ts`), which both subscription paths (2025 `resources/subscribe` and 2026 `subscriptions/listen`) already go through, so one change covers both eras. The rest are small edits in `src/resources.ts` and `src/server.ts`.

**Tech Stack:** TypeScript on Node (type-stripping, `node --test`), `@modelcontextprotocol/server` v2.

**Spec:** The audit findings, restated in "Findings" below (no separate spec file).

## Findings

1. Watcher `'error'` drops the watcher and its callbacks without notifying; subscriber never learns (`watcher-registry.ts:193-196`).
2. Root-revoke filter (`isInsideAllowed`) exists only in the legacy subscribe callback (`resources.ts:331-333`); `subscriptions/listen` sinks (`stdio.ts:213`, `http.ts:174`) still notify after revoke.
3. A watcher under a revoked root keeps its slot against `FS_MAX_WATCHERS` until unsubscribe.
4. Directory URIs are subscribable and completable but `resources/read` refuses them with `NOT_FILE`; Linux directory watches are non-recursive. Undocumented.
5. URIs naming the same file differently (`%61.txt` vs `a.txt`, drive-letter case) take separate watchers.
6. Not-found on legacy-era connections uses `-32602`; the 2025 spec code is `-32002`.
7. `file://{+path}` alias template has no completer.
8. `ResourceStore` fires `list_changed` on every put/prune; the modern HTTP leg has no coalescing.

## Global Constraints

- No new dependencies.
- Never hand-edit versions in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`.
- Contract change (Task 3) needs `node --test --test-update-snapshots __tests__/contract.test.ts` run with no `FS_*` env vars, and the `.snapshot` diff committed.
- Registry change notification debounce stays 50 ms.
- After code changes run `graphify update .`.
- Final gate: `npm run check` passes.

## Review Focus

1. Watcher error with a subscriber whose callback throws: the other callbacks must still run (Task 1, covered by try/catch test).
2. Root re-granted after revoke: a fresh subscribe for the same URI must attach a new watcher and notify again (Task 2 test).
3. Alias URIs, one released: the remaining alias keeps notifying with its own URI string (Task 6 test).
4. Legacy-era read of an expired `filesystem-mcp://result/…` URI must also return `-32002`, not only file URIs (Task 4 test).
5. `list_changed` debounce must still fire after the last of a burst, not only the first (Task 5 test asserts count is exactly 1 after the burst settles).

---

### Task 1: Notify subscribers when a watcher dies

**Files:**

- Modify: `src/core/watcher-registry.ts:44` (factory signature), `:165-213` (`attach`)
- Test: `__tests__/watcher-registry.test.ts` (new)

**Interfaces:**

- Produces: `createWatcherRegistry(deps?: { watch?: WatchFn }): WatcherRegistry`, where
  `export type WatchFn = (path: string, options: { recursive?: boolean }, listener: (event: string, filename: string | null) => void) => FSWatcher;`
  Default is `node:fs` `watch`. Every existing caller passes nothing.
- Produces (test helpers inside the test file, reused by Tasks 2 and 6): `fakeWatch()` returning `{ watch: WatchFn, watchers: FakeWatcher[] }`, where `type FakeWatcher = EventEmitter & { close(): void; fire(filename: string | null): void }`; `fire` calls the `listener` the registry passed to `watch` with `('change', filename)`. Each `watch` call pushes one `FakeWatcher`; `fakeGuard(allowed: () => boolean)` returning `{ validateExistingPath: async (p: string) => p, isInsideAllowed: () => allowed() } as unknown as PathGuard`.

- [ ] **Step 1: Write the failing test** in `__tests__/watcher-registry.test.ts`

```ts
it('a watcher error notifies each subscriber once, then frees the slot', async () => {
  const { watch, watchers } = fakeWatch();
  const registry = createWatcherRegistry({ watch });
  const uri = buildFileResourceUri(filePath); // real tmp file
  const seen: string[] = [];
  const throwing = () => {
    throw new Error('boom');
  };
  assert.deepEqual(
    await registry.acquire(
      fakeGuard(() => true),
      uri,
      throwing,
    ),
    { ok: true },
  );
  assert.deepEqual(
    await registry.acquire(
      fakeGuard(() => true),
      uri,
      (u) => seen.push(u),
    ),
    { ok: true },
  );
  watchers[0].emit('error', new Error('EPERM'));
  assert.deepEqual(seen, [uri]); // synchronous, not debounced
  assert.equal(registry.size(), 0);
  assert.equal(registry.hasWatcher(uri), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test __tests__/watcher-registry.test.ts`
Expected: FAIL (`createWatcherRegistry` ignores `watch`; real watcher never errors / `seen` is `[]`).

- [ ] **Step 3: Implement**

Add `deps.watch` (default `fs.watch`); call it with three arguments in both branches (`{}` options for the file branch). In the `'error'` handler: copy `activeCallbacks.get(uri)` to an array, call `dropWatcher(uri, watcher)`, then call each callback with `uri` inside the same try/catch + `Logger.warn` that `notifyAll` uses. Rationale comment: the client re-reads and learns the file is gone or changed; `resources/subscribe` already re-acquires when `hasWatcher` is false.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test __tests__/watcher-registry.test.ts __tests__/resources-subscribe.test.ts __tests__/subscriptions-listen.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/watcher-registry.ts __tests__/watcher-registry.test.ts
git commit -m "fix(watchers): notify subscribers when a watcher errors"
```

### Task 2: Root-revoke filter in the registry (both eras) and slot release

**Files:**

- Modify: `src/core/watcher-registry.ts` (`attach`, `notifyAll` timer body, `dropWatcher`)
- Modify: `src/resources.ts:329-335` (remove the `isInsideAllowed` line from `guardedNotify`; keep the `active` check)
- Test: `__tests__/watcher-registry.test.ts`

**Interfaces:**

- Consumes: `fakeWatch`, `fakeGuard` from Task 1.
- Produces: no new exports. Internal `guards: Map<string, PathGuard>` set in `attach` from `acquire`'s `pathGuard`, deleted in `dropWatcher`/`drop`.

- [ ] **Step 1: Write the failing tests**

```ts
it('a change under a revoked root notifies nobody and frees the watcher', async () => {
  let allowed = true;
  const { watch, watchers } = fakeWatch();
  const registry = createWatcherRegistry({ watch });
  const seen: string[] = [];
  await registry.acquire(
    fakeGuard(() => allowed),
    uri,
    (u) => seen.push(u),
  );
  allowed = false;
  watchers[0].fire(basename(filePath)); // invokes the stored listener
  await setTimeout(100);
  assert.deepEqual(seen, []);
  assert.equal(registry.size(), 0);
});

it('re-subscribing after the root is re-granted attaches a new watcher', async () => {
  let allowed = true;
  const { watch, watchers } = fakeWatch();
  const registry = createWatcherRegistry({ watch });
  const seen: string[] = [];
  const notify = (u: string) => seen.push(u);
  await registry.acquire(
    fakeGuard(() => allowed),
    uri,
    notify,
  );
  allowed = false;
  watchers[0].fire(basename(filePath));
  await setTimeout(100);
  allowed = true;
  registry.release(uri);
  assert.deepEqual(
    await registry.acquire(
      fakeGuard(() => allowed),
      uri,
      notify,
    ),
    { ok: true },
  );
  assert.equal(registry.size(), 1);
  watchers[1].fire(basename(filePath));
  await setTimeout(100);
  assert.deepEqual(seen, [uri]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test __tests__/watcher-registry.test.ts`
Expected: FAIL (`seen` is `[uri]`, `size()` is 1).

- [ ] **Step 3: Implement**

In the debounce timer body of `notifyAll`, before fan-out: `const path = extractPath(uri); const guard = guards.get(uri);` if both exist and `!guard.isInsideAllowed(path)`, call `dropWatcher(uri, watchers.get(uri))` and return. Lease counts stay (callers own them), same as the error path. Add `// shortcut: the slot frees on the first change after a revoke, not at the revoke; hook PathGuard root changes if idle revoked watchers ever hit the cap.` Then remove the now-duplicate check in `resources.ts`.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test __tests__/watcher-registry.test.ts __tests__/resources-subscribe.test.ts __tests__/subscriptions-listen.test.ts __tests__/stdio.test.ts`
Expected: PASS (existing "a revoked declared root sends no more change notices" still passes).

- [ ] **Step 5: Commit**

```bash
git add src/core/watcher-registry.ts src/resources.ts __tests__/watcher-registry.test.ts
git commit -m "fix(watchers): apply root revocation on every subscription path"
```

### Task 3: Document directory URIs on the file template

**Files:**

- Modify: `src/resources.ts:265` (`description` of `filesystem-mcp-file`)
- Modify: `__tests__/contract.test.ts.snapshot` (regenerated)

- [ ] **Step 1: Change the description** to exactly:

`'Read a file from the workspace. Subscribe to get updates when it changes. A directory URI can be subscribed (direct children only on Linux) but not read: use the list tool for its entries.'`

- [ ] **Step 2: Regenerate the snapshot**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts` (no `FS_*` env vars set)
Expected: PASS; `git diff __tests__/contract.test.ts.snapshot` shows only the description line.

- [ ] **Step 3: Commit**

```bash
git add src/resources.ts __tests__/contract.test.ts.snapshot
git commit -m "docs(resources): state directory subscribe/read semantics"
```

### Task 4: `-32002` not-found on legacy-era connections

**Files:**

- Modify: `src/resources.ts` (`wrapRead` signature, `registerResources` subscribe handler)
- Modify: `__tests__/helpers.ts:197-230` (`createTestServer`/`createTestClientPair` options gain `era?: 'legacy' | 'modern'`, forwarded as `createServer`'s second argument `{ era }`)
- Test: `__tests__/resources.test.ts`

**Interfaces:**

- Produces: `function forEra(error: unknown, era: ResourceRegistrationOptions['era']): unknown` in `src/resources.ts` — returns `new ProtocolError(ProtocolErrorCode.ResourceNotFound, error.message, { uri: error.uri })` when `era === 'legacy'` and `error instanceof ResourceNotFoundError`; otherwise returns `error` unchanged.
- `wrapRead(contract, transport, era)`.

Only explicit `'legacy'` converts; `undefined` era (in-memory test pairs) keeps today's `-32602`, so existing tests do not change.

- [ ] **Step 1: Write the failing tests**

```ts
it('legacy era reports a missing file and an expired result as -32002', async () => {
  const pair = await createTestClientPair([root], { era: 'legacy' });
  try {
    for (const uri of [
      buildFileResourceUri(join(root, 'nope.txt')),
      'filesystem-mcp://result/00000000-0000-0000-0000-000000000000',
    ]) {
      await assert.rejects(
        pair.client.readResource({ uri }),
        (err: { code?: number; data?: { uri?: string } }) => {
          assert.equal(err.code, -32002);
          assert.equal(err.data?.uri, uri);
          return true;
        },
      );
    }
    await assert.rejects(
      pair.client.subscribeResource({ uri: buildFileResourceUri(join(root, 'nope.txt')) }),
      (err: { code?: number }) => err.code === -32002,
    );
  } finally {
    await pair.close();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-name-pattern="legacy era reports" __tests__/resources.test.ts`
Expected: FAIL (`-32602 !== -32002`).

- [ ] **Step 3: Implement** — in `wrapRead`'s catch, route every throw through `forEra(..., era)`; wrap the subscribe handler body in `try { ... } catch (e) { throw forEra(e, deps.era); }`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test __tests__/resources.test.ts __tests__/resources-subscribe.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/resources.ts __tests__/helpers.ts __tests__/resources.test.ts
git commit -m "fix(resources): use -32002 for not-found on 2025-era connections"
```

### Task 5: Coalesce `list_changed` from the result store

**Files:**

- Modify: `src/server.ts:50-62` (`createRuntimeState` wraps `hooks.onResourcesChanged`)
- Modify: `src/server.ts:163-173` (drop the `ponytail:` cross-tick note; keep `debouncedNotificationMethods`)
- Test: `__tests__/resources.test.ts`

**Interfaces:**

- Produces: `RESOURCES_CHANGED_DEBOUNCE_MS = 100` (exported from `src/server.ts`). The wrapped callback arms one `setTimeout(..., 100).unref()` if none is pending and calls the hook when it fires. `dispose()` clears the pending timer.

- [ ] **Step 1: Write the failing test**

```ts
it('a burst of result-store changes across ticks sends one list_changed', async () => {
  let count = 0;
  const state = createRuntimeState(
    {},
    {
      onResourcesChanged: () => {
        count++;
      },
    },
  );
  for (let i = 0; i < 3; i++) {
    state.resourceStore.putText({ name: `r${i}`, text: 'x' });
    await setImmediate();
  }
  await setTimeout(RESOURCES_CHANGED_DEBOUNCE_MS + 50);
  assert.equal(count, 1);
  state.dispose();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-name-pattern="burst of result-store" __tests__/resources.test.ts`
Expected: FAIL (`3 !== 1`).

- [ ] **Step 3: Implement** the wrapper in `createRuntimeState` (trailing-edge timer, no new util file).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test __tests__/resources.test.ts __tests__/subscriptions-listen.test.ts __tests__/http-transport.test.ts`
Expected: PASS (HTTP test "an externalized result invalidates resources/list" still sees its notification).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts __tests__/resources.test.ts
git commit -m "fix(resources): coalesce result-store list_changed bursts"
```

### Task 6: One watcher per real file across URI aliases

**Files:**

- Modify: `src/core/watcher-registry.ts` (`watchers`, `attach`, `dropWatcher`, `isAtCap`, `size`, error handler)
- Test: `__tests__/watcher-registry.test.ts`

**Interfaces:**

- Consumes: Task 1 `WatchFn`/`fakeWatch`/`fakeGuard`; Task 2 `guards` map.
- Produces: unchanged public API. Internal: `byPath: Map<string, { watcher: FSWatcher; uris: Set<string> }>` keyed by the `resolved` path from `validateExistingPath`; `watchers: Map<string, FSWatcher>` stays keyed by URI and points at the shared watcher. `isAtCap()` and `size()` use `byPath.size`. A watcher event fans out `notifyAll(u)` for each `u` in its entry's `uris`. `dropWatcher(uri)` removes `uri` from the entry and closes the watcher only when `uris` is empty. The error handler (Task 1) notifies then drops every URI in the entry.

- [ ] **Step 1: Write the failing test**

```ts
it('two URIs for one file share a watcher and each hears its own URI', async () => {
  const { watch, watchers } = fakeWatch();
  const registry = createWatcherRegistry({ watch });
  const plain = buildFileResourceUri(filePath);
  const aliased = plain.replace(/a\.txt$/, '%61.txt'); // test file named a.txt
  const seen: string[] = [];
  await registry.acquire(
    fakeGuard(() => true),
    plain,
    (u) => seen.push(u),
  );
  await registry.acquire(
    fakeGuard(() => true),
    aliased,
    (u) => seen.push(u),
  );
  assert.equal(watchers.length, 1);
  assert.equal(registry.size(), 1);
  watchers[0].fire('a.txt');
  await setTimeout(100);
  assert.deepEqual(seen.sort(), [aliased, plain].sort());
  registry.release(plain);
  assert.equal(registry.size(), 1);
  seen.length = 0;
  watchers[0].fire('a.txt');
  await setTimeout(100);
  assert.deepEqual(seen, [aliased]);
  registry.release(aliased);
  assert.equal(registry.size(), 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test __tests__/watcher-registry.test.ts`
Expected: FAIL (`watchers.length` is 2).

- [ ] **Step 3: Implement** the `byPath` keying described in Interfaces. Keep the existing "two concurrent attaches for one URI" guard (`watchers.has(uri)` after validation).

- [ ] **Step 4: Run to verify it passes**

Run: `node --test __tests__/watcher-registry.test.ts __tests__/resources-subscribe.test.ts __tests__/subscriptions-listen.test.ts __tests__/stdio.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/watcher-registry.ts __tests__/watcher-registry.test.ts
git commit -m "perf(watchers): share one watcher across URI aliases of a file"
```

### Task 7: Completer for the `file://` alias template

**Files:**

- Modify: `src/resources.ts:215-229` (`createFileUrlResource` gains `complete`)
- Modify: `__tests__/contract.test.ts.snapshot` if the completion capability listing changes (regenerate as in Task 3)
- Test: `__tests__/resources.test.ts` (next to the existing `ref/resource` completion tests, ~line 1255)

**Interfaces:**

- Produces: `complete.path(value)` = `suggestPaths(pathGuard, extractFileUrlPath('file://' + value) ?? value)` mapped through `(p) => pathToFileURL(p).href.slice('file://'.length)`. Values start with `/` (`/C:/…` on Windows), so `file://` + value is a valid `file:///` URL.

- [ ] **Step 1: Write the failing test**

```ts
it('completes file:// alias paths as URL paths that read back', async () => {
  const harness = await createTestClientPair([root]);
  try {
    const result = await harness.client.complete({
      ref: { type: 'ref/resource', uri: FILE_URL_TEMPLATE },
      argument: {
        name: 'path',
        value: pathToFileURL(`${root}${sep}`).href.slice('file://'.length),
      },
    });
    assert.ok(result.completion.values.length > 0);
    const file = result.completion.values.find((v) => !v.endsWith('/'));
    assert.ok(file?.startsWith('/'));
    await harness.client.readResource({ uri: `file://${file}` }); // resolves, no throw
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --test-name-pattern="file:// alias paths" __tests__/resources.test.ts`
Expected: FAIL (`values.length` is 0).

- [ ] **Step 3: Implement** the `complete` entry from Interfaces. Import `pathToFileURL` from `node:url`.

- [ ] **Step 4: Run to verify it passes, then full gate**

Run: `node --test __tests__/resources.test.ts __tests__/contract.test.ts`
Then: `npm run check` and `graphify update .`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/resources.ts __tests__/resources.test.ts __tests__/contract.test.ts.snapshot
git commit -m "feat(resources): complete paths for the file:// alias template"
```
