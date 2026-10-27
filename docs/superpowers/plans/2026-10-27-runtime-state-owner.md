# Runtime state owner and workspace-grant sunset markers implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the endpoint runtime state one factory and one owner, and mark
the legacy-only `'workspace'` grant so the ADR-002 removal grep finds it.

**Architecture:** A `createRuntimeState()` factory in `src/server.ts` builds the
five shared objects (`PathGuard`, `ResourceStore`, `PageSnapshotStore`,
`UndoJournal`, `WatcherRegistry`) behind one `RuntimeState` value with a
`dispose()`. `createServer()` takes a single optional `state` dep; it owns and
disposes the state only when it built it. The HTTP leg, stdio leg and test
helpers call the factory instead of constructing the pieces by hand.

**Tech Stack:** TypeScript (Node, ESM `.ts` imports), `@modelcontextprotocol/server`,
Node built-in test runner.

**Spec:** GitHub issue #132
(<https://github.com/j0hanz/filesystem-mcp/issues/132>), findings 1 and 2 of
the 2026-10-23 architecture audit. Findings 3-9 are out of scope.

## Global Constraints

- `npm run check` passes.
- The contract snapshot (`__tests__/contract.test.ts.snapshot`) is unchanged;
  never run `--test-update-snapshots` for this work.
- `grep -rn "sunset(SEP-2577)" src` lists the new `src/core/path.ts` sites.
- No `?? new PathGuard|ResourceStore|PageSnapshotStore|UndoJournal` remains in
  `src/server.ts`.
- Finding 2 is comments and docs only: no behavior change in `src/core/path.ts`.
- Marker spelling, verbatim:
  `sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.`
- Do not touch the versions in `package.json`, `server.json`,
  `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`.

## Deviation from the issue text

> The issue calls the omitted-`state` case "the stdio case". It is not: stdio
> needs the guard before `createServer` runs (`ensurePathGuard`) and the
> registry outside the instance (`prepareListenWatchers`, `stdio.ts:361`).
> Stdio therefore builds its state per connection and disposes it in
> `cleanupConnection`. The owned case is `createTestServer` and any bare
> `createServer(options)` call.

## Review Focus

1. **Stdio `resources/list_changed` after the move**: the connection-level
   store must still notify the live instance, through `server.server` so the
   SDK's same-tick debounce still applies. Pinned by the existing stdio
   list-changed tests; Task 1 Step 5 runs them.
2. **Stdio oversize cap on result-store reads**: the stdio store must keep
   `MAX_OUTBOUND_RESULT_BYTES`; the HTTP store must not get it. Pinned by the
   existing stdio oversize tests; Task 1 Step 5 runs them.
3. **A per-request HTTP instance closing** must not clear the shared undo
   journal or page snapshots. Task 1 Step 1 `injected state survives …`.
4. **Owned state on a bare `createServer`** must still be cleared and its
   registry destroyed on close (no leaked `fs.watch` handles keeping the test
   process alive). Task 1 Step 1 `createRuntimeState dispose …` plus the
   existing `closing a connected client releases the leases it held`.
5. **Stdio factory racing connection close** (`if (closed)` branch) must not
   strand state. `cleanupConnection` disposes the connection state once; the
   instance never owns it. Covered by existing stdio close tests.

---

### Task 1: `createRuntimeState` factory and single `state` dep

**Files:**

- Modify: `src/server.ts:11-16` (imports), `:38-85` (`extraDeps`), `:168-191`
  (construction), `:193-205` (`deps`), `:211-224` (ownership/dispose)
- Modify: `src/transport/http.ts:270-304` (construction, factory), `:356-363`
  (shutdown)
- Modify: `src/transport/stdio.ts:146-163` (construction, factory), `:220-225`
  (`cleanupConnection`)
- Modify: `__tests__/helpers.ts:256-264` (`createTestElicitPair`), `:316-347`
  (`createTestHttpHarness`)
- Modify: `__tests__/resources-subscribe.test.ts:183-200`
- Test: `__tests__/resources-subscribe.test.ts` (describe
  `createServer disposal on connection close`)

**Interfaces:**

- Produces, exported from `src/server.ts`:

```ts
export interface RuntimeState {
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore;
  readonly pageStore: PageSnapshotStore;
  readonly undoJournal: UndoJournal;
  readonly watcherRegistry: WatcherRegistry;
  /** Destroys the registry and clears the three stores. Idempotent. */
  dispose(): void;
}

export function createRuntimeState(
  options?: ServerOptions,
  hooks?: {
    /** ResourceStore list-changed callback; read the live server lazily. */
    onResourcesChanged?: () => void;
    /** ResourceStore read cap; stdio passes MAX_OUTBOUND_RESULT_BYTES. */
    maxReadResultBytes?: number;
  },
): RuntimeState;
```

- `createServer(options, extraDeps)`: `extraDeps` loses `pathGuard`,
  `resourceStore`, `pageStore`, `undoJournal`, `watcherRegistry`; gains
  `state?: RuntimeState`. `notifier`, `era`, `transport`, `cacheScope` stay.
- `FilesystemServerContext` is unchanged.

- [ ] **Step 1: Write the failing tests**

Add to the `createServer disposal on connection close` describe in
`__tests__/resources-subscribe.test.ts`, and migrate the existing test there to
`state`:

```ts
it('closing a connected client releases the leases it held', async () => {
  const root = await createTestRoot();
  const state = createRuntimeState({ cliAllowedDirs: [root] });
  try {
    const ctx = await createServer({ cliAllowedDirs: [root] }, { state });
    // ...connect, subscribe, close exactly as today, asserting on
    // state.watcherRegistry.hasWatcher(uri) instead of registry.hasWatcher(uri)
  } finally {
    state.dispose();
  }
});

it('injected state survives the instance closing', async () => {
  const root = await createTestRoot();
  const state = createRuntimeState({ cliAllowedDirs: [root] });
  try {
    const pageId = state.pageStore.create({ queryKey: 'q', items: [1] });
    const ctx = await createServer({ cliAllowedDirs: [root] }, { state });
    await ctx.mcp.close();
    assert.deepStrictEqual(state.pageStore.read(pageId, 'q').items, [1]);
  } finally {
    state.dispose();
  }
});

it('createRuntimeState dispose clears the page store', () => {
  const state = createRuntimeState({ cliAllowedDirs: [tmpdir()] });
  const pageId = state.pageStore.create({ queryKey: 'q', items: [1] });
  state.dispose();
  state.dispose(); // idempotent
  assert.throws(() => state.pageStore.read(pageId, 'q'));
});
```

> Assumes `PageSnapshotStore.read` throws on a missing id and its snapshot
> exposes `items`; check `src/core/store.ts:294-340` and adjust the two
> assertions to the real shape, not the store.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="createServer disposal on connection close"`
Expected: FAIL: `createRuntimeState` is not exported from `src/server.ts`.

- [ ] **Step 3: Implement `createRuntimeState` and the `state` dep in `src/server.ts`**

- `createRuntimeState` constructs each object once:
  `new PathGuard(options)`, `new ResourceStore(hooks.onResourcesChanged, hooks.maxReadResultBytes)`,
  `new PageSnapshotStore()`, `new UndoJournal()`, `createWatcherRegistry()`.
  It does not recompute the guard; callers that need it ready await
  `state.pathGuard.recomputeAllowedDirectories()` themselves, and
  `createServer` keeps its `if (!pathGuard.isInitialized())` recompute.
- `dispose()` runs `watcherRegistry.destroy()`, then `pageStore.clear()`,
  `undoJournal.clear()`, `resourceStore.clear()`, in the order `http.ts:359-362`
  uses today, behind a once-guard.
- In `createServer`:
  `const ownsState = extraDeps?.state === undefined;`
  `const state = extraDeps?.state ?? createRuntimeState(options, { onResourcesChanged: () => voidSend(server.server.sendResourceListChanged(), 'resource list_changed'), maxReadResultBytes: extraDeps?.transport === 'stdio' ? MAX_OUTBOUND_RESULT_BYTES : undefined });`
  The `notifier` branch of today's fallback callback goes: every caller
  that passes a `notifier` now passes `state`.
- `deps` takes `pathGuard`, `pageStore`, `undoJournal`, `resourceStore` and
  `watcherRegistry` from `state` (always set, so the conditional spread for
  `watcherRegistry` goes). `src/resources.ts` keeps its own
  `?? createWatcherRegistry()` fallback: `__tests__/resources.test.ts` calls
  `registerResources` without a registry.
- `disposeRuntimeState()`: replace `ownsPages`/`ownsUndo` with
  `if (ownsState) state.dispose();`, keep `resourceDisposable.dispose()`.
- Move the five per-field doc comments into one comment on `state`: who shares
  it (HTTP endpoint, stdio connection), and that an omitted `state` is owned
  and disposed on close. Keep the R8 grant-survival reasoning from the old
  `pathGuard` comment.
- Drop imports that become unused.

- [ ] **Step 4: Migrate the callers**

- `src/transport/http.ts`: replace `sharedRegistry`, `sharedStore`,
  `sharedPageStore`, `sharedUndoJournal`, `sharedPathGuard` with
  `const state = createRuntimeState(options, { onResourcesChanged: () => { modernHandler.notify.resourcesChanged(); } });`
  then `await state.pathGuard.recomputeAllowedDirectories();`. Keep the
  existing comments on why the endpoint shares one guard and one store, moved
  above that line. Pass `{ state, notifier, era, transport, cacheScope }` to
  `createServer`; `:201-202`, `:220`, `:339-340` read `state.pathGuard` /
  `state.watcherRegistry`; the shutdown block `:359-362` becomes
  `state.dispose();`.
- `src/transport/stdio.ts`: replace `new PathGuard(options)` and
  `createWatcherRegistry()` with
  `const state = createRuntimeState(options, { onResourcesChanged: () => { voidSend(activeCtx?.mcp.server.sendResourceListChanged(), '[Stdio] resource list_changed'); }, maxReadResultBytes: MAX_OUTBOUND_RESULT_BYTES });`
  The callback reads `activeCtx` when it fires, like `sink` at `:197`, so it
  never pins a disposed instance. `ensurePathGuard`, `prepareListenWatchers`,
  `registry.release` and `seedRootsFromClient` read `state.pathGuard` /
  `state.watcherRegistry`. Pass `{ state, era, transport: 'stdio' }`. In
  `cleanupConnection` replace `registry.destroy()` with `state.dispose()`.
- `__tests__/helpers.ts` `createTestElicitPair`: one
  `createRuntimeState({ cliAllowedDirs: allowedDirs })`, await its guard
  recompute, pass `{ state }`, and `state.dispose()` in `close`. This now
  shares undo and page stores across requests, as `http.ts` does.
- `__tests__/helpers.ts` `createTestHttpHarness`: one `createRuntimeState`
  with `onResourcesChanged: () => { notifier.resourcesChanged(); }`; return
  `registry: state.watcherRegistry`; pass `{ state, notifier, era, transport: 'http' }`;
  dispose the state wherever `close` destroys the registry today. Keep the
  "one store for the whole harness" comment.

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: PASS, including `__tests__/contract.test.ts` with no snapshot diff
(`git status --short __tests__` shows no `.snapshot` change).

Run: `grep -nE "\?\? new (PathGuard|ResourceStore|PageSnapshotStore|UndoJournal)" src/server.ts`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/transport/http.ts src/transport/stdio.ts __tests__/helpers.ts __tests__/resources-subscribe.test.ts
git commit -m "refactor: give endpoint runtime state one owner"
```

---

### Task 2: Mark the legacy `'workspace'` grant for sunset

**Files:**

- Modify: `src/core/path.ts:205-212` (`accessGrants` doc), `:428-435`
  (`applyGrant` JSDoc), `:1223-1229` (`bases` filter)
- Modify: `docs/adr/002-legacy-protocol-paths-sunset.md` (Context, Consequences)

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: no code interface; three new grep hits.

- [ ] **Step 1: Add the three markers in `src/core/path.ts`**

- In the `accessGrants` JSDoc (`:206-211`) and the `applyGrant` JSDoc
  (`:428-434`), append the line
  ` * sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.`
  as `src/transport/stdio.ts:85` does.
- Above `// A configured root stays a base even when it was also granted.`
  (`:1223`) add
  `// sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.`

- [ ] **Step 2: Amend ADR-002**

- Context, after the `seedRootsFromClient` clause in the "three code paths"
  paragraph, add: "That seeding is also the only caller of
  `PathGuard.applyGrant(dir, 'workspace')` in
  [`src/core/path.ts`](../../src/core/path.ts); the `'workspace'` kind, the
  `accessGrants` list and the `bases` filter in `recomputeAllowedDirectories`
  exist only to tell a declared root from an approved grant."
- Consequences, append after the 2026-10-13 amendment:

```markdown
- **Amended 2026-10-27:** the marker grep returns three more sites, in
  `src/core/path.ts`. The `'workspace'` grant kind landed in b34b6310
  (2026-10-14), after the last amendment, without the marker. Its only caller
  is `seedRootsFromClient`. With workspace grants gone every grant is an
  access grant, so the removal also deletes the `kind` parameter of
  `applyGrant` and its branch, the `accessGrants` list, and the `bases`
  filter in `recomputeAllowedDirectories`: every base is then a configured
  root.
```

- [ ] **Step 3: Verify**

Run: `grep -rn "sunset(SEP-2577)" src`
Expected: the existing sites plus three lines in `src/core/path.ts`.

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/path.ts docs/adr/002-legacy-protocol-paths-sunset.md
git commit -m "docs: mark the legacy workspace grant for SEP-2577 sunset"
```
