# SDK Built-ins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace four pieces of hand-rolled code with MCP TypeScript SDK 2.0.0 built-ins, fixing a `resources/subscribe` misroute and a CORS/Origin-gate disagreement along the way.

**Architecture:** Each task swaps one custom mechanism for the SDK primitive that already does the job — `UriTemplate#match` for subscribe routing, `validateOriginHeader` for CORS reflection, `McpServer`'s own capability inference, and the typed result of `specTypeSchemas.SubscriptionsListenRequest` for listen parsing. No new files, no new dependencies; every task is a net deletion.

**Tech Stack:** TypeScript 6, Node >= 24 (runs `.ts` directly), `@modelcontextprotocol/server` 2.0.0, Express 5, Zod 4, Node's built-in test runner.

**Spec:** [`sdk-builtins.hunt.md`](sdk-builtins.hunt.md) (same directory) — findings F1-F4 and what was deliberately left out.

## Global Constraints

- SDK stays pinned at exactly `2.0.0` (`package.json` dependencies). Do not upgrade it.
- Never hand-edit `version` in `package.json` or `server.json`; the Release workflow owns both.
- Formatting: Prettier with `singleQuote`, `printWidth: 100`, `trailingComma: all`, and the sort-imports plugin. Run `npx prettier --write <files>` on every file you touch before committing.
- Lint is `eslint . --max-warnings=0`; `knip` fails on unused exports, so delete an export and its test imports in the same commit.
- Regexes in tests carry the `u` flag (`/.../u`), matching the existing suite.
- Tests run on Node's test runner. One file: `node --test __tests__/<file>.test.ts`. Filtered: `node --test --test-name-pattern="<regex>" __tests__/<file>.test.ts`.
- Full gate: `npm run check` (build, test type-check, lint, prettier check, knip, all tests).
- Commit messages are Conventional Commits and end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `CHANGELOG.md` is written when a release is stamped, not in these commits.
- Work on branch `fix/sdk-builtins`, never on `main`.

---

### Task 0: Branch

**Files:** none

- [ ] **Step 1: Create the branch from an up-to-date `main`**

```bash
git switch main
git pull --ff-only
git switch -c fix/sdk-builtins
```

- [ ] **Step 2: Confirm the baseline is green**

Run: `npm run check`
Expected: exit 0. If it fails on `main`, stop and report — do not start Task 1 on a red baseline.

- [ ] **Step 3: Commit the spec and this plan**

`docs/plan/` is Prettier-ignored, so no formatting step is needed.

```bash
git add docs/plan/2026-09-23-sdk-builtins
git commit -m "docs(plan): SDK built-ins audit and plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Route `resources/subscribe` by URI template (fixes F1)

Today `checkResourceAllowed` (an OAuth audience check) decides which resource owns a subscribe URI. It compares `URL.origin`, which is `"null"` for every custom scheme, so `filesystem-mcp://result/abc` is routed to the file template and answered "not a filesystem URI" instead of "does not support subscriptions", and an unparseable URI throws `-32603 Invalid URL`. Replace it with `UriTemplate#match`, the matcher the SDK itself uses to dispatch `resources/read`.

**Files:**
- Modify: `src/resources.ts:14-21` (imports), `:414-415` (new helper above `registerResources`), `:485-536` (subscribe/unsubscribe handlers)
- Test: `__tests__/resources.test.ts:1` (import), insert after `:593`

**Interfaces:**
- Consumes: `ResourceContract` (module-private type in `src/resources.ts`, fields `uri?: string`, `uriTemplate?: string`); `UriTemplate` from `@modelcontextprotocol/server` (`new UriTemplate(template: string)`, `.match(uri: string): Variables | null`).
- Produces: module-private `function owns(contract: ResourceContract, uri: string): boolean`. Nothing outside `src/resources.ts` changes.

- [ ] **Step 1: Write the failing tests**

In `__tests__/resources.test.ts`, change line 1 to import `ProtocolError`:

```ts
import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
} from '@modelcontextprotocol/server';
```

Then insert these three tests inside `describe('MCP Client Resource Operations', ...)`, directly after the test that ends at line 593 (`'client.readResource() on a missing workspace file rejects as resource-not-found'`):

```ts
    it('resources/subscribe refuses a result URI as unsubscribable, not as missing', async () => {
      // `filesystem-mcp://result/{id}` is listed and readable, so a subscribe
      // must say it has no watcher, not that the resource does not exist.
      const uri = 'filesystem-mcp://result/abc';
      await assert.rejects(harness.client.subscribeResource({ uri }), (err: unknown) => {
        assert.ok(ProtocolError.isInstance(err), 'expected ProtocolError');
        assert.strictEqual(ResourceNotFoundError.isInstance(err), false, 'must not read as missing');
        assert.strictEqual(err.code, ProtocolErrorCode.InvalidParams);
        assert.match(err.message, /does not support subscriptions/u);
        return true;
      });
    });

    it('resources/subscribe answers an unparseable URI as not found, not an internal error', async () => {
      await assert.rejects(
        harness.client.subscribeResource({ uri: 'not a uri' }),
        (err: unknown) => {
          assert.ok(ResourceNotFoundError.isInstance(err), 'expected ResourceNotFoundError');
          assert.strictEqual(err.code, ProtocolErrorCode.InvalidParams);
          return true;
        },
      );
    });

    it('resources/subscribe answers a foreign scheme as not found', async () => {
      await assert.rejects(
        harness.client.subscribeResource({ uri: 'other://file/x' }),
        (err: unknown) => {
          assert.ok(ResourceNotFoundError.isInstance(err), 'expected ResourceNotFoundError');
          assert.match(err.message, /^Resource not found: other:\/\/file\/x$/u);
          return true;
        },
      );
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern="resources/subscribe" __tests__/resources.test.ts`
Expected: 3 failing tests —
1. the result-URI test fails at `must not read as missing` (today it is a `ResourceNotFoundError`);
2. the unparseable-URI test fails at `expected ResourceNotFoundError` (today it is `-32603 Invalid URL`);
3. the foreign-scheme test fails the `assert.match` (today the message is `Cannot subscribe: not a filesystem URI`).

- [ ] **Step 3: Swap the imports**

In `src/resources.ts`, replace lines 14-21:

```ts
import {
  checkResourceAllowed,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/server';
```

with:

```ts
import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  UriTemplate,
} from '@modelcontextprotocol/server';
```

- [ ] **Step 4: Add the `owns` helper**

In `src/resources.ts`, insert directly above `export function registerResources(` (currently line 416):

```ts
/**
 * Whether `contract` answers for `uri`, decided by the template matcher the SDK
 * dispatches `resources/read` with, so `resources/subscribe` and
 * `resources/read` agree on which resource owns a URI. Not
 * `checkResourceAllowed`: that is an RFC 8707 audience check comparing
 * `URL.origin`, which is the opaque `"null"` for every custom scheme, so it
 * matched `filesystem-mcp://result/…` — and any other scheme — to the file
 * template.
 */
function owns(contract: ResourceContract, uri: string): boolean {
  if (contract.uri !== undefined) return uri === contract.uri;
  return (
    contract.uriTemplate !== undefined && new UriTemplate(contract.uriTemplate).match(uri) !== null
  );
}
```

- [ ] **Step 5: Route subscribe and unsubscribe through `owns`**

In `src/resources.ts`, replace the block from the comment `// The URI prefix a contract answers for:` through the end of the `resources/unsubscribe` handler (currently lines 485-536):

```ts
    // The URI prefix a contract answers for: a fixed URI, or a template up to
    // its first variable.
    const prefixOf = (contract: ResourceContract): string | undefined =>
      contract.uri ?? contract.uriTemplate?.split('{')[0];
    const matches = (contract: ResourceContract, requested: URL): boolean => {
      const configured = prefixOf(contract);
      return (
        configured !== undefined &&
        checkResourceAllowed({ requestedResource: requested, configuredResource: configured })
      );
    };

    server.server.setRequestHandler(
      'resources/subscribe',
      async (req: { params: SubscribeRequestParams }) => {
        const requested = resourceUrlFromServerUrl(req.params.uri);
        if (!matches(file, requested)) {
          // A resource that exists but has no watcher (the instructions text,
          // a cached result) is NOT a not-found: reporting it as one told
          // clients a URI they can list and read does not exist.
          if (resourceContracts.some((contract) => matches(contract, requested))) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              `Resource ${requested.toString()} does not support subscriptions; only ${FILESYSTEM_FILE_URI_TEMPLATE} does. Read it again for the current contents.`,
            );
          }
          throw new ResourceNotFoundError(
            requested.toString(),
            `Resource not found: ${requested.toString()}`,
          );
        }
        if ((await file.subscribe(requested.toString(), notifyUpdated)) === false) {
          // InternalError for want of anything better: ProtocolErrorCode has
          // no resource-limit member, and the message already names the
          // actionable cause.
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            `Subscription rejected: no watcher attached (watcher limit ${MAX_WATCHERS} reached, or fs.watch failed to start).`,
          );
        }
        return {};
      },
    );

    server.server.setRequestHandler(
      'resources/unsubscribe',
      (req: { params: UnsubscribeRequestParams }) => {
        const requested = resourceUrlFromServerUrl(req.params.uri);
        if (matches(file, requested)) file.unsubscribe(requested.toString());
        return {};
      },
    );
```

with:

```ts
    server.server.setRequestHandler(
      'resources/subscribe',
      async (req: { params: SubscribeRequestParams }) => {
        const { uri } = req.params;
        if (!owns(file, uri)) {
          // A resource that exists but has no watcher (the instructions text,
          // a cached result) is NOT a not-found: reporting it as one told
          // clients a URI they can list and read does not exist.
          if (resourceContracts.some((contract) => owns(contract, uri))) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              `Resource ${uri} does not support subscriptions; only ${FILESYSTEM_FILE_URI_TEMPLATE} does. Read it again for the current contents.`,
            );
          }
          throw new ResourceNotFoundError(uri, `Resource not found: ${uri}`);
        }
        if ((await file.subscribe(uri, notifyUpdated)) === false) {
          // InternalError for want of anything better: ProtocolErrorCode has
          // no resource-limit member, and the message already names the
          // actionable cause.
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            `Subscription rejected: no watcher attached (watcher limit ${MAX_WATCHERS} reached, or fs.watch failed to start).`,
          );
        }
        return {};
      },
    );

    server.server.setRequestHandler(
      'resources/unsubscribe',
      (req: { params: UnsubscribeRequestParams }) => {
        if (owns(file, req.params.uri)) file.unsubscribe(req.params.uri);
        return {};
      },
    );
```

Note: the watcher lease is now keyed by the URI exactly as the client sent it, not by `new URL(uri).toString()`. That is the same key the `subscriptions/listen` path already uses, so a legacy subscribe and a modern listen on one URI still share one watcher. For URIs built by `buildFileResourceUri` the two strings are identical.

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `node --test --test-name-pattern="resources/subscribe" __tests__/resources.test.ts`
Expected: 3 passing, 0 failing.

- [ ] **Step 7: Run the subscription suites for regressions**

Run: `node --test __tests__/resources.test.ts __tests__/resources-subscribe.test.ts __tests__/stdio.test.ts`
Expected: all pass. `resources-subscribe.test.ts` checks that the notification URI equals the subscribed URI and that one unsubscribe ends a doubled subscribe.

- [ ] **Step 8: Format, type-check, lint**

```bash
npx prettier --write src/resources.ts __tests__/resources.test.ts
npm run type-check && npm run type-check:test && npx eslint src/resources.ts __tests__/resources.test.ts --max-warnings=0
```

Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/resources.ts __tests__/resources.test.ts
git commit -m "fix(resources): route resources/subscribe by URI template" -m "checkResourceAllowed compares URL.origin, which is the opaque \"null\" for every custom scheme, so a filesystem-mcp://result/ URI was routed to the file template and refused as missing instead of unsubscribable, and an unparseable URI threw -32603. UriTemplate#match is the matcher the SDK dispatches resources/read with." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Reflect CORS origins with the SDK's Origin validator (fixes F2)

`createMcpExpressApp` validates `Origin` with `validateOriginHeader` over the list passed as `allowedOrigins`, before any route runs, and a configured list replaces the localhost default. `corsMiddleware` instead reflects any localhost origin unconditionally. That branch never runs when `FS_ALLOWED_ORIGINS` is set (the SDK has already answered 403), and the comment claiming otherwise is wrong. Use the same validator over the same list so reflection matches admission.

**Files:**
- Modify: `src/transport/http-policy.ts:1-3` (imports), `:48` (delete), `:64-95` (replace), `:328-330` (comment)
- Modify: `README.md:408` (one table row)
- Test: `__tests__/http-policy.test.ts:9-22` (imports), `:345-392` (TC-SEC-028, TC-SEC-030), `:394-483` (TC-SEC-031), append a describe at end of file

**Interfaces:**
- Consumes: `validateOriginHeader(originHeader: string | null | undefined, allowedOriginHostnames: string[]): { ok: boolean; ... }` and `localhostAllowedHostnames(): string[]` from `@modelcontextprotocol/server`.
- Produces: `isOriginAllowed(origin: string, allowedHostnames: readonly string[]): boolean` (same signature, stricter semantics). `isAllowedLocalhostOrigin` is deleted — nothing in `src/` besides `isOriginAllowed` calls it.

- [ ] **Step 1: Rewrite the unit tests to the new contract**

In `__tests__/http-policy.test.ts`, delete `isAllowedLocalhostOrigin,` from the import list (line 16).

Replace the whole `TC-SEC-028` test (lines 345-359) with:

```ts
    it('TC-SEC-028: isOriginAllowed on the loopback default accepts localhost origins and rejects spoofed ones', () => {
      assert.strictEqual(isOriginAllowed('http://localhost', []), true);
      assert.strictEqual(isOriginAllowed('http://localhost:3000', []), true);
      assert.strictEqual(isOriginAllowed('https://127.0.0.1:8080', []), true);
      assert.strictEqual(isOriginAllowed('http://[::1]:5173', []), true);
      assert.strictEqual(isOriginAllowed('https://localhost', []), true);

      assert.strictEqual(isOriginAllowed('http://localhost.attacker.com', []), false);
      assert.strictEqual(isOriginAllowed('http://127.0.0.1.attacker.com', []), false);
      assert.strictEqual(isOriginAllowed('http://evil.com', []), false);
      assert.strictEqual(isOriginAllowed('http://evil.com/localhost', []), false);
      assert.strictEqual(isOriginAllowed('file:///etc/passwd', []), false);
      assert.strictEqual(isOriginAllowed('null', []), false);
      assert.strictEqual(isOriginAllowed('', []), false);
    });
```

Replace the whole `TC-SEC-030` test (lines 378-392) with:

```ts
    it('TC-SEC-030: isOriginAllowed accepts exactly the configured list, localhost only by default', () => {
      assert.strictEqual(isOriginAllowed('https://app.example.com', ['app.example.com']), true);
      assert.strictEqual(
        isOriginAllowed('https://app.example.com:8443', ['app.example.com']),
        true,
      );
      // A configured list replaces the loopback default, exactly as the SDK
      // Origin gate treats `allowedOrigins` — it 403s these before CORS runs.
      assert.strictEqual(isOriginAllowed('http://127.0.0.1:8080', ['app.example.com']), false);
      assert.strictEqual(isOriginAllowed('http://localhost:5173', ['app.example.com']), false);
      assert.strictEqual(
        isOriginAllowed('http://localhost:5173', ['localhost', 'app.example.com']),
        true,
      );

      assert.strictEqual(isOriginAllowed('https://attacker.com', ['app.example.com']), false);
      assert.strictEqual(isOriginAllowed('https://attacker.com', []), false);
      assert.strictEqual(isOriginAllowed('not-a-valid-url', ['app.example.com']), false);
    });
```

In `TC-SEC-031`, change the handler on line 395 from:

```ts
      const handler = corsMiddleware(['app.example.com']);
```

to:

```ts
      const handler = corsMiddleware(['localhost', 'app.example.com']);
```

and insert this case just before the test's closing `});` (after case 5, currently line 482):

```ts

      // 6. A configured list without localhost reflects no localhost origin,
      // matching the SDK Origin gate, which already 403s it on a live server.
      const strict = corsMiddleware(['app.example.com']);
      const reqStrict = createMockRequest({
        method: 'OPTIONS',
        path: '/',
        headers: { origin: 'http://localhost:3000' },
      });
      const resStrict = createMockResponse();
      strict(reqStrict, resStrict, () => {});
      assert.strictEqual(resStrict.headers['access-control-allow-origin'], undefined);
```

- [ ] **Step 2: Add the integration test that pins gate/reflection agreement**

Append to the end of `__tests__/http-policy.test.ts`:

```ts

describe('CORS reflection agrees with the SDK Origin gate', () => {
  it('TC-SEC-031b: with FS_ALLOWED_ORIGINS set, localhost is refused and the listed origin reflected', async () => {
    const saved = process.env['FS_ALLOWED_ORIGINS'];
    process.env['FS_ALLOWED_ORIGINS'] = 'app.example.com';
    const dir = await createTestRoot();
    const httpServer = await startHttpServer(0, { cliAllowedDirs: [dir] }, {});
    const port = (httpServer.address() as AddressInfo).port;
    const preflight = async (origin: string): Promise<{ status: number; allow: string | null }> => {
      const res = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
        method: 'OPTIONS',
        headers: { origin },
      });
      await res.text();
      return { status: res.status, allow: res.headers.get('access-control-allow-origin') };
    };
    try {
      const local = await preflight('http://localhost:5173');
      assert.strictEqual(local.status, 403, 'the SDK gate refuses an unlisted localhost origin');
      assert.strictEqual(local.allow, null);

      const listed = await preflight('https://app.example.com');
      assert.strictEqual(listed.status, 204);
      assert.strictEqual(listed.allow, 'https://app.example.com');
    } finally {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await cleanupTestRoot(dir);
      if (saved === undefined) Reflect.deleteProperty(process.env, 'FS_ALLOWED_ORIGINS');
      else process.env['FS_ALLOWED_ORIGINS'] = saved;
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify the right ones fail**

Run: `node --test --test-name-pattern="TC-SEC-0(28|30|31)" __tests__/http-policy.test.ts`
Expected:
- `TC-SEC-028` PASSES — with an empty list the old regex gives the same answers; it is rewritten only because `isAllowedLocalhostOrigin` is going away;
- `TC-SEC-030` FAILS at `isOriginAllowed('http://127.0.0.1:8080', ['app.example.com'])` (today `true`);
- `TC-SEC-031` FAILS at case 6 (today localhost is reflected);
- `TC-SEC-031b` PASSES (it pins the SDK gate that already exists, which is the point).

- [ ] **Step 4: Replace the origin helpers**

In `src/transport/http-policy.ts`, change line 2:

```ts
import { localhostAllowedHostnames } from '@modelcontextprotocol/server';
```

to:

```ts
import { localhostAllowedHostnames, validateOriginHeader } from '@modelcontextprotocol/server';
```

Delete line 48:

```ts
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u;
```

Delete lines 64-66:

```ts
export function isAllowedLocalhostOrigin(origin: string): boolean {
  return LOCALHOST_ORIGIN_RE.test(origin);
}
```

Replace lines 74-95 (the `originHostname` function and the `isOriginAllowed` doc comment and body):

```ts
function originHostname(origin: string): string | undefined {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

/**
 * True if `origin` (a raw `Origin` request header) is allowed given the
 * env-derived `allowedHostnames` set (hostname-form, no scheme/port). Localhost
 * origins are always accepted via {@link isAllowedLocalhostOrigin}; a remote
 * origin is accepted iff its parsed hostname is in the set. Both the SDK app's
 * `allowedOrigins` and this OPTIONS-handler check consume hostname-form, so a
 * remote origin allowed via `FS_ALLOWED_ORIGINS` is reflected
 * end-to-end in `Access-Control-Allow-Origin`.
 */
export function isOriginAllowed(origin: string, allowedHostnames: readonly string[]): boolean {
  if (isAllowedLocalhostOrigin(origin)) return true;
  const host = originHostname(origin);
  return host !== undefined && allowedHostnames.includes(host);
}
```

with:

```ts
/**
 * True if `origin` (a raw `Origin` request header) may have
 * `Access-Control-Allow-Origin` reflected. `allowedHostnames` is the same
 * hostname-form list `createMcpExpressApp` receives as `allowedOrigins`, and
 * the check is the SDK's own `validateOriginHeader`, so reflection matches
 * admission: the SDK gate runs first and answers 403 to any Origin outside
 * that list — localhost included once `FS_ALLOWED_ORIGINS` replaces the
 * loopback default. An empty list (an all-blank `FS_ALLOWED_ORIGINS`) mounts no
 * `allowedOrigins`, so a loopback bind keeps the SDK's localhost default; this
 * uses the same default. An empty header is never reflected — the SDK treats an
 * absent `Origin` as allowed, which is right for admission but not for echoing.
 */
export function isOriginAllowed(origin: string, allowedHostnames: readonly string[]): boolean {
  const allowed = allowedHostnames.length > 0 ? [...allowedHostnames] : localhostAllowedHostnames();
  return origin !== '' && validateOriginHeader(origin, allowed).ok;
}
```

In the `corsMiddleware` doc comment, replace these two lines (currently 329-330):

```ts
 * carries `Access-Control-Allow-Origin` for an allowed Origin (localhost, or in
 * the env-derived `FS_ALLOWED_ORIGINS` set — no wildcard fallback), and the
```

with:

```ts
 * carries `Access-Control-Allow-Origin` for an Origin {@link isOriginAllowed}
 * accepts (no wildcard fallback), and the
```

- [ ] **Step 5: Document the replace-the-default behavior**

In `README.md`, replace the `FS_ALLOWED_ORIGINS` row's description cell (line 408):

```text
Comma-separated origin hostnames for CORS.
```

with:

```text
Comma-separated origin hostnames allowed to call `/mcp` from a browser. Replaces the localhost default, so include `localhost` if local browser clients still need access.
```

(Only the description text changes; Prettier realigns the table in Step 7.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test __tests__/http-policy.test.ts`
Expected: all pass, including `TC-SEC-028`, `TC-SEC-030`, `TC-SEC-031`, `TC-SEC-031b`.

- [ ] **Step 7: Format, type-check, lint, knip**

```bash
npx prettier --write src/transport/http-policy.ts __tests__/http-policy.test.ts README.md
npm run type-check && npm run type-check:test && npx eslint src/transport/http-policy.ts __tests__/http-policy.test.ts --max-warnings=0 && npx knip
```

Expected: exit 0. `knip` passing confirms nothing still imports `isAllowedLocalhostOrigin`.

- [ ] **Step 8: Commit**

```bash
git add src/transport/http-policy.ts __tests__/http-policy.test.ts README.md
git commit -m "fix(http): reflect CORS origins with the SDK's origin validator" -m "createMcpExpressApp already 403s any Origin outside allowedOrigins, and a configured FS_ALLOWED_ORIGINS replaces the localhost default, so the unconditional localhost branch in corsMiddleware never ran when the variable was set. isOriginAllowed now runs validateOriginHeader over the same list, so reflection matches admission." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Let `McpServer` advertise tools, prompts and completions (F3)

`McpServer` advertises `tools` and `prompts` (each with `listChanged: true`) and `completions` from the registrations `createServer` makes. Declaring them by hand restates what the SDK infers. `resources` stays declared: `subscribe` is never inferred, and the legacy-HTTP instance deliberately advertises `listChanged: false`.

**Files:**
- Modify: `src/server.ts:74-88`
- Test: `__tests__/capabilities.test.ts` (add one test)

**Interfaces:**
- Consumes: nothing new.
- Produces: no API change; the advertised capability object must stay byte-identical.

- [ ] **Step 1: Pin the exact advertised capabilities (characterization test)**

In `__tests__/capabilities.test.ts`, add after `CAP-002`, inside the `describe`:

```ts

  it('CAP-003: the advertised capability set is exactly what the registrations imply', () => {
    assert.deepStrictEqual(harness.client.getServerCapabilities(), {
      resources: { subscribe: true, listChanged: true },
      tools: { listChanged: true },
      prompts: { listChanged: true },
      completions: {},
    });
  });
```

- [ ] **Step 2: Run it against the current code**

Run: `node --test __tests__/capabilities.test.ts`
Expected: PASS. This test documents today's output so Step 3 can prove it is unchanged. If it fails, stop: the advertised set differs from what the spec measured, so report the actual object instead of editing the expectation to match.

- [ ] **Step 3: Drop the inferred flags**

In `src/server.ts`, replace lines 74-88:

```ts
  // `resources.subscribe` stays advertised on both eras: the verb itself is
  // 2025-only, but with enforceStrictCapabilities the SDK also gates outbound
  // `notifications/resources/updated` — which the modern `subscriptions/listen`
  // stream delivers — on this same capability bit. The one exception is a
  // legacy instance on the HTTP leg (era 'legacy' with a notifier): it serves
  // one request, registers no subscribe handler (resources.ts, same
  // predicate) and sends no notification of any kind — there is no stream to
  // send it on — so neither `subscribe` nor `listChanged` is advertised.
  const legacyHttp = extraDeps?.era === 'legacy' && extraDeps.notifier !== undefined;
  const capabilities = {
    resources: { subscribe: !legacyHttp, listChanged: !legacyHttp },
    tools: {},
    prompts: {},
    completions: {},
  } satisfies ServerCapabilities;
```

with:

```ts
  // Only `resources` is declared: `McpServer` advertises `tools` and `prompts`
  // (with `listChanged: true`) and `completions` from the registrations below,
  // but never infers `subscribe`.
  //
  // `resources.subscribe` stays advertised on both eras: the verb itself is
  // 2025-only, but with enforceStrictCapabilities the SDK also gates outbound
  // `notifications/resources/updated` — which the modern `subscriptions/listen`
  // stream delivers — on this same capability bit. The one exception is a
  // legacy instance on the HTTP leg (era 'legacy' with a notifier): it serves
  // one request, registers no subscribe handler (resources.ts, same
  // predicate) and sends no notification of any kind — there is no stream to
  // send it on — so neither `subscribe` nor `listChanged` is advertised.
  const legacyHttp = extraDeps?.era === 'legacy' && extraDeps.notifier !== undefined;
  const capabilities = {
    resources: { subscribe: !legacyHttp, listChanged: !legacyHttp },
  } satisfies ServerCapabilities;
```

- [ ] **Step 4: Verify the advertised set is unchanged**

Run: `node --test __tests__/capabilities.test.ts __tests__/resources.test.ts __tests__/http-server.test.ts`
Expected: all pass — `CAP-001`, the new `CAP-003`, the `resources.subscribe`/`listChanged` capability test in `resources.test.ts`, and the HTTP legs.

- [ ] **Step 5: Format, type-check, lint**

```bash
npx prettier --write src/server.ts __tests__/capabilities.test.ts
npm run type-check && npm run type-check:test && npx eslint src/server.ts __tests__/capabilities.test.ts --max-warnings=0
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts __tests__/capabilities.test.ts
git commit -m "refactor(server): let McpServer advertise tools, prompts and completions" -m "McpServer infers all three from the registrations createServer makes; the advertised capability object is unchanged, now pinned by CAP-003." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Parse `subscriptions/listen` once with the SDK schema (F4)

`isStructurallyValidListen` validates a listen body and throws the parsed value away; `listenSubscriptionUris` then re-walks the raw body with casts. Merge them into one function that returns the de-duplicated URIs of a valid listen, `[]` when a valid listen names none, and `undefined` for everything else. `prepareListenWatchers` takes those URIs instead of re-reading the body.

**Files:**
- Modify: `src/transport/shared.ts:28-39` (delete `isStructurallyValidListen`), `:60-73` (rewrite `listenSubscriptionUris`), `:97-117` (`prepareListenWatchers` signature)
- Modify: `src/transport/http.ts:45-50` (imports), `:172-206` (listen route)
- Modify: `src/transport/stdio.ts:22-28` (imports), `:279-307` (gate)
- Test: `__tests__/subscriptions-listen.test.ts:25-33` (unit tests), `:87-93` and `:109` (stale comments)

**Interfaces:**
- Consumes: `specTypeSchemas.SubscriptionsListenRequest['~standard'].validate(value: unknown)` from `@modelcontextprotocol/server` — synchronous for this schema; on success `result.value.params.notifications.resourceSubscriptions` is `string[] | undefined` (type-checked against 2.0.0).
- Produces:
  - `listenSubscriptionUris(message: unknown): string[] | undefined`
  - `prepareListenWatchers(uris: readonly string[], pathGuard: PathGuard, registry: WatcherRegistry, notify: (uri: string) => void): Promise<ListenPreparation>`
  - `isStructurallyValidListen` is deleted.

- [ ] **Step 1: Write the failing unit tests**

In `__tests__/subscriptions-listen.test.ts`, replace the `describe('listenSubscriptionUris', ...)` block (lines 25-33) with:

```ts
describe('listenSubscriptionUris', () => {
  it('de-duplicates repeated URIs so attach and release stay balanced', () => {
    const body = {
      method: 'subscriptions/listen',
      params: { notifications: { resourceSubscriptions: ['a://1', 'a://2', 'a://1'] } },
    };
    assert.deepStrictEqual(listenSubscriptionUris(body), ['a://1', 'a://2']);
  });

  it('returns undefined for a listen the schema rejects, so nothing is attached for it', () => {
    const body = {
      method: 'subscriptions/listen',
      params: { notifications: { resourceSubscriptions: [42, 'a://1'] } },
    };
    assert.strictEqual(listenSubscriptionUris(body), undefined);
  });

  it('returns undefined for anything that is not a listen', () => {
    assert.strictEqual(listenSubscriptionUris({ method: 'tools/list' }), undefined);
    assert.strictEqual(listenSubscriptionUris(null), undefined);
    assert.strictEqual(listenSubscriptionUris('subscriptions/listen'), undefined);
  });

  it('returns [] for a valid listen that names no resources', () => {
    const body = {
      method: 'subscriptions/listen',
      params: { notifications: { toolsListChanged: true } },
    };
    assert.deepStrictEqual(listenSubscriptionUris(body), []);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern="listenSubscriptionUris" __tests__/subscriptions-listen.test.ts`
Expected: 2 failing —
- `returns undefined for a listen the schema rejects` gets `['a://1']` (today the raw walk keeps the string entry);
- `returns undefined for anything that is not a listen` gets `[]`.

The other two pass.

- [ ] **Step 3: Rewrite the helpers in `shared.ts`**

In `src/transport/shared.ts`, delete lines 28-39 (the `isStructurallyValidListen` doc comment and function):

```ts
/**
 * True when `message` really is a `subscriptions/listen` request, not merely a
 * body carrying that method string. Both legs gate watcher attachment on this:
 * a malformed listen cannot succeed downstream, so creating and tearing down
 * `fs.watch` handles for it is pure waste — and on HTTP the teardown depended on
 * the response-close listener firing. Non-listen bodies fail it too, which is
 * the same answer `listenSubscriptionUris` gives them.
 */
export function isStructurallyValidListen(message: unknown): boolean {
  const result = specTypeSchemas.SubscriptionsListenRequest['~standard'].validate(message);
  return !('issues' in result);
}
```

Replace the `listenSubscriptionUris` function (lines 60-73):

```ts
/** The `resourceSubscriptions` URIs of a `subscriptions/listen` body, de-duplicated. */
export function listenSubscriptionUris(parsedBody: unknown): string[] {
  if (typeof parsedBody !== 'object' || parsedBody === null) return [];
  const body = parsedBody as {
    method?: unknown;
    params?: { notifications?: { resourceSubscriptions?: unknown } };
  };
  if (body.method !== 'subscriptions/listen') return [];
  const uris = body.params?.notifications?.resourceSubscriptions;
  if (!Array.isArray(uris)) return [];
  // De-duplicate: one attach must yield one ref-count, or the release below
  // decrements further than it incremented and tears down a live watcher.
  return [...new Set(uris.filter((uri): uri is string => typeof uri === 'string'))];
}
```

with:

```ts
/**
 * The de-duplicated `resourceSubscriptions` URIs of a structurally valid
 * `subscriptions/listen` request — `[]` when it names none — or `undefined` for
 * anything else, including a listen the schema rejects. Both legs gate watcher
 * attachment on this: a malformed listen cannot succeed downstream, so creating
 * and tearing down `fs.watch` handles for it is pure waste — and on HTTP the
 * teardown depended on the response-close listener firing.
 *
 * The method check runs first because every inbound stdio message passes
 * through here; only a listen pays for the schema parse.
 */
export function listenSubscriptionUris(message: unknown): string[] | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  if ((message as { method?: unknown }).method !== 'subscriptions/listen') return undefined;
  const result = specTypeSchemas.SubscriptionsListenRequest['~standard'].validate(message);
  if (result instanceof Promise || result.issues !== undefined) return undefined;
  // De-duplicate: one attach must yield one ref-count, or the release below
  // decrements further than it incremented and tears down a live watcher.
  return [...new Set(result.value.params.notifications.resourceSubscriptions ?? [])];
}
```

In `prepareListenWatchers`, replace the signature and first line of the body:

```ts
export async function prepareListenWatchers(
  parsedBody: unknown,
  pathGuard: PathGuard,
  registry: WatcherRegistry,
  notify: (uri: string) => void,
): Promise<ListenPreparation> {
  const uris = listenSubscriptionUris(parsedBody);
  const acquired: string[] = [];
```

with:

```ts
export async function prepareListenWatchers(
  uris: readonly string[],
  pathGuard: PathGuard,
  registry: WatcherRegistry,
  notify: (uri: string) => void,
): Promise<ListenPreparation> {
  const acquired: string[] = [];
```

- [ ] **Step 4: Update the HTTP route**

In `src/transport/http.ts`, change the `./shared.ts` import (lines 45-50):

```ts
import {
  isStructurallyValidListen,
  jsonRpcRequestId,
  listenSubscriptionUris,
  prepareListenWatchers,
} from './shared.ts';
```

to:

```ts
import { jsonRpcRequestId, listenSubscriptionUris, prepareListenWatchers } from './shared.ts';
```

Replace lines 172-185:

```ts
      // Only a structurally valid listen gets watchers, mirroring the stdio
      // gate. A malformed one cannot succeed downstream, so attaching handles
      // for it only gives the response-close release something to undo — and
      // everything that is not a listen takes no watchers either way.
      if (!isStructurallyValidListen(parsedBody)) {
        await modernNodeHandler(req, res, parsedBody);
        return;
      }

      // Reject an over-cap listen before the ack so the client does not believe
      // every requested URI is watched when the watcher budget is exhausted.
      // The per-URI `capped` failure below would also reject, but only after
      // creating and tearing down every watcher up to the cap.
      const requestedUris = listenSubscriptionUris(parsedBody);
```

with:

```ts
      // Only a structurally valid listen gets watchers, mirroring the stdio
      // gate. A malformed one cannot succeed downstream, so attaching handles
      // for it only gives the response-close release something to undo — and
      // everything that is not a listen takes no watchers either way.
      const requestedUris = listenSubscriptionUris(parsedBody);
      if (requestedUris === undefined) {
        await modernNodeHandler(req, res, parsedBody);
        return;
      }

      // Reject an over-cap listen before the ack so the client does not believe
      // every requested URI is watched when the watcher budget is exhausted.
      // The per-URI `capped` failure below would also reject, but only after
      // creating and tearing down every watcher up to the cap.
```

Then change the `prepareListenWatchers` call (currently lines 201-206):

```ts
      const prepared = await prepareListenWatchers(
        parsedBody,
        sharedPathGuard,
        sharedRegistry,
        resourceUpdateSink,
      );
```

to:

```ts
      const prepared = await prepareListenWatchers(
        requestedUris,
        sharedPathGuard,
        sharedRegistry,
        resourceUpdateSink,
      );
```

- [ ] **Step 5: Update the stdio gate**

In `src/transport/stdio.ts`, change the `./shared.ts` import (lines 22-28):

```ts
import {
  isStructurallyValidListen,
  jsonRpcError,
  jsonRpcRequestId,
  listenSubscriptionUris,
  prepareListenWatchers,
} from './shared.ts';
```

to:

```ts
import {
  jsonRpcError,
  jsonRpcRequestId,
  listenSubscriptionUris,
  prepareListenWatchers,
} from './shared.ts';
```

Replace lines 279-283:

```ts
    const subscriptionUris = listenSubscriptionUris(message);
    if (subscriptionUris.length === 0) {
      deliver(message);
      return;
    }
```

with:

```ts
    // A malformed listen, or one naming no resources, needs no watcher and
    // goes straight to the SDK, which answers it.
    const subscriptionUris = listenSubscriptionUris(message);
    if (subscriptionUris === undefined || subscriptionUris.length === 0) {
      deliver(message);
      return;
    }
```

Inside the `gated.then(async () => { ... })` callback, delete the now-redundant validity check (currently lines 297-301):

```ts
        if (!isStructurallyValidListen(message)) {
          listens.delete(id);
          deliver(message);
          return;
        }
```

and change the `prepareListenWatchers` call (currently line 307):

```ts
        const prepared = await prepareListenWatchers(message, pathGuard, registry, sink);
```

to:

```ts
        const prepared = await prepareListenWatchers(subscriptionUris, pathGuard, registry, sink);
```

Behavior note: a malformed listen used to enter the `listens` map and wait in the `gated` queue behind earlier listens before being delivered unchanged. It is now delivered at once. The SDK answers it with the same error either way; `STDIO-007` covers that path.

- [ ] **Step 6: Fix the two stale test comments**

In `__tests__/subscriptions-listen.test.ts`, replace the comment above `'does not attach watchers for a structurally invalid listen'` (currently lines 87-93):

```ts
  // The watcher gate runs off the raw body, ahead of the SDK.
  // `listenSubscriptionUris` filters `resourceSubscriptions` to its string
  // entries, so a mixed-type array still yields URIs to attach — for a request
  // the schema rejects outright. Without the gate those fs.watch handles get
  // created and then depend on the response-close release to come back. The
  // client cannot send this shape, so it goes over raw fetch; the assertion is
  // decisive because the ungated path answers with its own message.
```

with:

```ts
  // The watcher gate runs off the raw body, ahead of the SDK, and attaches only
  // for a listen the schema accepts. A mixed-type array fails the schema, so no
  // fs.watch handle is created for it — otherwise those handles would depend on
  // the response-close release to come back. The client cannot send this shape,
  // so it goes over raw fetch; the assertion is decisive because the gated path
  // answers with its own "Cannot subscribe to" message.
```

and change the inline comment (currently line 109):

```ts
        // 42 fails the schema; missingUri survives listenSubscriptionUris.
```

to:

```ts
        // 42 fails the schema, so listenSubscriptionUris yields nothing to attach.
```

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `node --test --test-name-pattern="listenSubscriptionUris" __tests__/subscriptions-listen.test.ts`
Expected: 4 passing, 0 failing.

- [ ] **Step 8: Run both transport legs for regressions**

Run: `node --test __tests__/subscriptions-listen.test.ts __tests__/stdio.test.ts __tests__/http-shared-guard.test.ts __tests__/http-transport.test.ts`
Expected: all pass. `STDIO-006` through `STDIO-013` cover the stdio lease lifecycle (cap, rejection, cancellation, shared URIs); `subscriptions-listen.test.ts` covers HTTP admission, the invalid-shape gate, and fan-out.

- [ ] **Step 9: Format, type-check, lint, knip**

```bash
npx prettier --write src/transport/shared.ts src/transport/http.ts src/transport/stdio.ts __tests__/subscriptions-listen.test.ts
npm run type-check && npm run type-check:test && npx eslint src/transport __tests__/subscriptions-listen.test.ts --max-warnings=0 && npx knip
```

Expected: exit 0. `knip` passing confirms nothing still imports `isStructurallyValidListen`.

- [ ] **Step 10: Commit**

```bash
git add src/transport/shared.ts src/transport/http.ts src/transport/stdio.ts __tests__/subscriptions-listen.test.ts
git commit -m "refactor(transport): parse subscriptions/listen once with the SDK schema" -m "isStructurallyValidListen validated the body and discarded the result, then listenSubscriptionUris re-walked it with casts. One function now returns the URIs of a valid listen, [] when it names none, and undefined otherwise; prepareListenWatchers takes the URIs." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Full gate

**Files:** none

- [ ] **Step 1: Run the full repository check**

Run: `npm run check`
Expected: exit 0 (build, test type-check, lint, `prettier --check .`, knip, full test suite).

- [ ] **Step 2: Confirm scope**

Run: `git diff --stat main...HEAD`
Expected: only these files changed — the two files in `docs/plan/2026-09-23-sdk-builtins/`, `src/resources.ts`, `src/transport/http-policy.ts`, `src/server.ts`, `src/transport/shared.ts`, `src/transport/http.ts`, `src/transport/stdio.ts`, `README.md`, and the four test files `__tests__/resources.test.ts`, `__tests__/http-policy.test.ts`, `__tests__/capabilities.test.ts`, `__tests__/subscriptions-listen.test.ts`. Anything else is out of scope; revert it.

Opening a PR, merging and releasing are left to the maintainer.
