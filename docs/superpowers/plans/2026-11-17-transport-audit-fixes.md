# Transport Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five findings of the 2026-11-17 MCP transport audit: HTTP-only flags silently ignored on stdio, invalid IPv6 URLs in output, HTTP teardown order, stdio listen-ID collision, and the borrowed request-receive timeout.

**Architecture:** Each fix is local to one transport file or the CLI. No new modules. One helper (`formatHttpHost`) joins the pure policy functions in `src/transport/http-policy.ts` because two call sites need it.

**Tech Stack:** TypeScript on Node (type-stripping, `node --test`), `@modelcontextprotocol/server` 2.4.0, Express.

**Spec:** The audit findings, restated in "Findings" below (no separate spec file).

## Findings

1. **Major.** `--api-key` / `--http-host` without `--port` start stdio and drop both flags with no warning (`src/index.ts:109`).
2. **Minor.** IPv6 binds print `http://::1:3000`, which is not a URL (`src/transport/http.ts:406`, `src/cli.ts:325`).
3. **Minor.** HTTP teardown calls `state.dispose()` before `modernHandler.close()`, so in-flight tool calls briefly run against disposed stores (`src/transport/http.ts:383-384`).
4. **Minor.** On stdio, any outgoing response whose ID matches an open `subscriptions/listen` releases that listen's watcher leases; the stream stays open but goes silent (`src/transport/stdio.ts:262-267`).
5. **Minor.** `httpServer.requestTimeout` reuses the MCP `DEFAULT_REQUEST_TIMEOUT_MSEC` (60 s) as the body-upload limit, so a near-limit write on a slow link gets 408 (`src/transport/http.ts:369`).

Out of scope (audit recommended against): sessionful legacy HTTP via `isLegacyRequest`; a shared `ServerEventBus` for multi-node.

## Global Constraints

- No new dependencies.
- Never hand-edit versions in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`.
- No change to the advertised MCP surface: `__tests__/contract.test.ts` must pass without a snapshot update.
- `FS_API_KEY` set in the environment without `--port` must keep starting stdio (people export it globally). Only the flags are refused.
- After code changes run `graphify update .`.
- Final gate: `npm run check` passes.

## Review Focus

1. `--print-config --api-key <key>` with no `--port` must still print config (the existing masking test at `__tests__/cli.test.ts:65` relies on it). Task 1 skips the guard under `--print-config`.
2. A host already in brackets (`[::1]`) must not become `[[::1]]`. Task 2 unit test.
3. The collision error in Task 4 must not itself release the lease: it has to go out through the unwrapped `send`, not `wire.send`. Task 4 test proves the lease survives.
4. A client response to a server-originated request (`roots/list` answer: has `id`, no `method`) must not be refused by Task 4's collision check. Task 4 checks `method` first; covered by existing legacy roots tests.
5. A duplicate `subscriptions/listen` ID used to fall through to the SDK, whose error reply released the first listen. Task 4 refuses it too; test included.

---

### Task 1: Refuse HTTP-only flags without `--port`

**Files:**

- Modify: `src/cli.ts:246-247` (after `printConfig` and `port` are computed)
- Test: `__tests__/cli.test.ts` (inside `describe('CLI (real subprocess)')`)

**Interfaces:**

- Consumes: `CliExitError` (existing, `src/cli.ts:37`), `runCli(args, env)` test helper (existing).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

```ts
it('CLI-HTTP-001: --api-key without --port exits 1 naming --port', async () => {
  const { code, stderr } = await runCli(['--api-key', 'k'.repeat(16), root]);
  assert.strictEqual(code, 1);
  assert.match(stderr, /--port/);
});

it('CLI-HTTP-002: --http-host without --port exits 1 naming --port', async () => {
  const { code, stderr } = await runCli(['--http-host', '127.0.0.1', root]);
  assert.strictEqual(code, 1);
  assert.match(stderr, /--port/);
});

it('CLI-HTTP-003: FS_API_KEY without --port still starts stdio', async () => {
  // stdin is 'ignore' in runCli, so stdio sees EOF and shuts down cleanly.
  const { code } = await runCli([root], { FS_API_KEY: 'k'.repeat(16) });
  assert.strictEqual(code, 0);
});
```

- [ ] **Step 2: Run to verify 001 and 002 fail, 003 passes**

Run: `npm test -- --test-name-pattern="CLI-HTTP"`
Expected: CLI-HTTP-001 and -002 FAIL (code 0, stdio started); CLI-HTTP-003 PASS.

- [ ] **Step 3: Implement the guard in `parseArgs`**

Condition: `!printConfig && port === undefined && (v['api-key'] !== undefined || v['http-host'] !== undefined)`. Read `v[...]` (flags), not the merged `apiKey` / `httpHost` (which include env). Throw:

```ts
throw new CliExitError(
  'Error: --api-key and --http-host apply only to the HTTP transport. Add --port, or drop them for stdio.',
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="CLI-HTTP|print-config"`
Expected: PASS, including the existing `--print-config masks the API key` test.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts __tests__/cli.test.ts
git commit -m "fix(cli): refuse --api-key/--http-host without --port"
```

---

### Task 2: Bracket IPv6 hosts in printed URLs

**Files:**

- Modify: `src/transport/http-policy.ts` (add helper next to `isLoopbackHttpHost`, ~line 474)
- Modify: `src/transport/http.ts:406` (listen log)
- Modify: `src/cli.ts:325` (`--print-config` transport field)
- Test: `__tests__/http-policy.test.ts`, `__tests__/cli.test.ts`

**Interfaces:**

- Produces: `export function formatHttpHost(host: string): string` in `src/transport/http-policy.ts`. Returns `[host]` when `host` contains `:` and does not start with `[`; otherwise `host` unchanged.

- [ ] **Step 1: Write the failing tests**

`__tests__/http-policy.test.ts`:

```ts
it('formatHttpHost brackets bare IPv6 and leaves the rest alone', () => {
  assert.strictEqual(formatHttpHost('::1'), '[::1]');
  assert.strictEqual(formatHttpHost('::'), '[::]');
  assert.strictEqual(formatHttpHost('[::1]'), '[::1]');
  assert.strictEqual(formatHttpHost('127.0.0.1'), '127.0.0.1');
  assert.strictEqual(formatHttpHost('localhost'), 'localhost');
});
```

`__tests__/cli.test.ts`:

```ts
it('CLI-HTTP-004: --print-config brackets an IPv6 --http-host', async () => {
  const { code, stdout } = await runCli([
    '--print-config',
    '--port',
    '3000',
    '--http-host',
    '::1',
    root,
  ]);
  assert.strictEqual(code, 0);
  assert.strictEqual(JSON.parse(stdout).transport, 'http://[::1]:3000');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern="formatHttpHost|CLI-HTTP-004"`
Expected: FAIL (`formatHttpHost` not exported; transport is `http://::1:3000`).

- [ ] **Step 3: Implement `formatHttpHost` and use it at both call sites**

`src/cli.ts` imports it from `./transport/http-policy.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="formatHttpHost|CLI-HTTP"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transport/http-policy.ts src/transport/http.ts src/cli.ts __tests__/http-policy.test.ts __tests__/cli.test.ts
git commit -m "fix(http): bracket IPv6 hosts in printed URLs"
```

---

### Task 3: HTTP teardown order and receive timeout

**Files:**

- Modify: `src/transport/http.ts:52-55` (constants), `:369` (`requestTimeout`), `:380-387` (`teardown`)
- Test: `__tests__/http-server.test.ts`

**Interfaces:**

- Produces: `const REQUEST_RECEIVE_TIMEOUT_MS = 300_000` (module-private, `src/transport/http.ts`). One-line why: covers a max-size body (`3 × FS_MAX_FILE_SIZE + 1 MiB`) on a slow link; `headersTimeout` (10 s) still guards slowloris.

- [ ] **Step 1: Write the failing test**

Follow the `startHttpServer(0, { cliAllowedDirs: [tmpDir] }, { apiKey: TEST_API_KEY })` pattern at `__tests__/http-server.test.ts:80`.

```ts
it('HTTP-LIFE-001: request receive timeout is 300 s, not the MCP request timeout', async () => {
  const srv = await startHttpServer(0, { cliAllowedDirs: [tmpDir] }, { apiKey: TEST_API_KEY });
  try {
    assert.strictEqual(srv.requestTimeout, 300_000);
    assert.strictEqual(srv.headersTimeout, 10_000);
  } finally {
    await srv[Symbol.asyncDispose]();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="HTTP-LIFE"`
Expected: FAIL (`60000 !== 300000`).

- [ ] **Step 3: Implement both changes**

1. Add `REQUEST_RECEIVE_TIMEOUT_MS`, assign it to `httpServer.requestTimeout`, drop the now-unused `DEFAULT_REQUEST_TIMEOUT_MSEC` import.
2. Reorder `teardown`: close the limiter, then `await modernHandler.close()` (keep its `.catch` logging), then `state.dispose()`. Keep it returning `Promise<void>`.

The teardown reorder has no dedicated test: `state` has no seam to observe ordering. The existing shutdown tests (`http-server.test.ts:79-123`, `:569`, `:595`) are its regression guard.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="HTTP-LIFE|close"` then `npm test -- __tests__/http-server.test.ts __tests__/http-transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transport/http.ts __tests__/http-server.test.ts
git commit -m "fix(http): close handler before disposing state; own receive timeout"
```

---

### Task 4: Refuse stdio requests that reuse an open listen's ID

**Files:**

- Modify: `src/transport/stdio.ts` `wire.onmessage` wrapper (~lines 318-395)
- Test: `__tests__/stdio.test.ts` (next to STDIO-010, ~line 776)

**Interfaces:**

- Consumes: `send` (the unwrapped `wire.send.bind(wire)`, `stdio.ts:262`), `listens` map, `jsonRpcError`, `ProtocolErrorCode.InvalidRequest`.
- Test harness (existing): `createRawStdioServer(tmpDir, env)`, `discoverModern(harness)`, `harness.send`, `harness.nextMessage`, `MODERN_META`.

- [ ] **Step 1: Write the failing tests**

Model on STDIO-010: `FS_MAX_WATCHERS: '1'`, so a second listen on another URI is refused while the first lease is held.

```ts
it('STDIO-015: a request reusing an open listen ID is refused and keeps the lease', async () => {
  // open listen id 'dup' on sharedUri; assert ack ('method' in message)
  // send { jsonrpc: '2.0', id: 'dup', method: 'tools/list', params: { _meta: MODERN_META } }
  const collision = await harness.nextMessage();
  assert.ok('error' in collision, JSON.stringify(collision));
  assert.strictEqual(collision.id, 'dup');
  assert.strictEqual(collision.error.code, ProtocolErrorCode.InvalidRequest);
  // send listen id 'other' on otherUri
  const blocked = await harness.nextMessage();
  assert.ok('error' in blocked, JSON.stringify(blocked));
  assert.strictEqual(blocked.error.code, ProtocolErrorCode.InvalidParams); // lease still held
});

it('STDIO-016: a duplicate listen ID is refused and keeps the first lease', async () => {
  // same as STDIO-015, but the colliding request is a second subscriptions/listen
  // with id 'dup' naming sharedUri; same three assertions.
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern="STDIO-01[56]"`
Expected: FAIL. The `blocked` listen is acknowledged, because the reply to the colliding request released the lease.

- [ ] **Step 3: Implement the collision check**

In `wire.onmessage`, after the `cancelId` branch and before `listenSubscriptionUris`: if the message has both `method` and `id`, and `listens.has(id)`, reply through `send` (not `wire.send`) with `jsonRpcError(ProtocolErrorCode.InvalidRequest, 'Request ID <JSON id> is in use by an open subscriptions/listen. Use a fresh ID.', id)`, route a send failure to `wire.onerror`, and return without delivering. Then simplify the later `if (id === null || listens.has(id))` to `if (id === null)`; the collision check already covers it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- __tests__/stdio.test.ts`
Expected: PASS, all STDIO cases.

- [ ] **Step 5: Commit**

```bash
git add src/transport/stdio.ts __tests__/stdio.test.ts
git commit -m "fix(stdio): refuse requests reusing an open listen ID"
```

---

### Task 5: Final gate

- [ ] **Step 1: Refresh the graph**

Run: `graphify update .`
Expected: exits 0.

- [ ] **Step 2: Full check**

Run: `npm run check`
Expected: PASS, with no `contract.test.ts` snapshot diff.

- [ ] **Step 3: Commit the graph if it changed**

```bash
git add graphify-out
git commit -m "chore(graph): update after transport audit fixes"
```
