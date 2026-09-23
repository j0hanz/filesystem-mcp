import { Client, type McpSubscription } from '@modelcontextprotocol/client';
import { LATEST_PROTOCOL_VERSION, ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { buildFileResourceUri } from '../src/core/file-uri.ts';
import { MAX_WATCHERS } from '../src/core/watcher-registry.ts';
import { listenSubscriptionUris } from '../src/transport/shared.ts';
import {
  bootHttpTest,
  cleanupTestRoot,
  createTestHttpHarness,
  createTestRoot,
  type HttpTestContext,
  TEST_API_KEY,
  waitFor,
  writeTestFile,
} from './helpers.ts';

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

describe('HTTP watcher fan-out and listen admission', () => {
  let tmpDir: string;
  let http: HttpTestContext;
  let client: Client;

  before(async () => {
    tmpDir = await createTestRoot();
    http = await bootHttpTest([tmpDir]);
    client = await http.makeClient('http-listen-admission');
  });

  after(async () => {
    await http.close();
    await cleanupTestRoot(tmpDir);
  });

  it('rejects a missing filesystem resource before acknowledging the listen', async () => {
    const uri = buildFileResourceUri(join(tmpDir, 'missing.txt'));

    await assert.rejects(client.listen({ resourceSubscriptions: [uri] }), (err: unknown) => {
      assert.equal((err as { code?: unknown }).code, ProtocolErrorCode.InvalidParams);
      return true;
    });
  });

  it('rejects a mixed valid/invalid batch and leaves the valid URI reusable', async () => {
    const filePath = await writeTestFile(tmpDir, 'valid-after-reject.txt', 'initial');
    const validUri = buildFileResourceUri(filePath);
    const missingUri = buildFileResourceUri(join(tmpDir, 'missing-in-batch.txt'));

    await assert.rejects(
      client.listen({ resourceSubscriptions: [validUri, missingUri] }),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, ProtocolErrorCode.InvalidParams);
        return true;
      },
    );

    let received: string | undefined;
    client.setNotificationHandler('notifications/resources/updated', (n) => {
      received = (n.params as { uri: string }).uri;
    });
    const subscription = await client.listen({ resourceSubscriptions: [validUri] });
    try {
      await writeFile(filePath, 'changed');
      await waitFor(() => received !== undefined);
      assert.strictEqual(received, validUri);
    } finally {
      await subscription.close();
    }
  });

  // The watcher gate runs off the raw body, ahead of the SDK, and attaches only
  // for a listen the schema accepts. A mixed-type array fails the schema, so no
  // fs.watch handle is created for it — otherwise those handles would depend on
  // the response-close release to come back. The client cannot send this shape,
  // so it goes over raw fetch. The assertion is decisive because attaching the
  // missing file would fail with "Cannot subscribe to"; its absence proves the
  // gate attached nothing.
  it('does not attach watchers for a structurally invalid listen', async () => {
    const missingUri = buildFileResourceUri(join(tmpDir, 'never-created.txt'));
    const response = await fetch(http.base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_API_KEY}`,
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        'mcp-method': 'subscriptions/listen',
        'mcp-name': 'listen-gate-test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscriptions/listen',
        // 42 fails the schema, so listenSubscriptionUris yields nothing to attach.
        params: { notifications: { resourceSubscriptions: [42, missingUri] } },
      }),
    });

    const body = await response.text();
    assert.doesNotMatch(body, /Cannot subscribe to/);
  });
});

// Per-connection subscription gating (verify-first). Two HTTP clients over one
// real HTTP server (one shared bus/registry): A opens a subscriptions/listen
// for a file URI, B does not. On mutation, A must receive
// notifications/resources/updated and B must NOT. If B receives, the shared bus
// cross-talks across connections (the audit's Should-Fix) and step 8 installs
// per-connection filtering. Uses the real Express server so prepareListenWatchers
// wires the file watcher (the handler.fetch harness bypasses it).

describe('HTTP per-connection subscription gating (cross-talk)', () => {
  let tmpDir: string;
  let http: HttpTestContext;
  let clientA: Client;
  let clientB: Client;
  let subscription: McpSubscription | undefined;

  before(async () => {
    tmpDir = await createTestRoot();
    await writeTestFile(tmpDir, 'watch.txt', 'initial');
    http = await bootHttpTest([tmpDir]);
    clientA = await http.makeClient('http-cross-talk');
    clientB = await http.makeClient('http-cross-talk');
  });

  after(async () => {
    try {
      await subscription?.close();
    } catch {
      /* subscription may already be torn down */
    }
    await http.close();
    await cleanupTestRoot(tmpDir);
  });

  it('subscriber receives the update; non-subscriber does not (no cross-talk)', async () => {
    const filePath = join(tmpDir, 'watch.txt');
    const uri = buildFileResourceUri(filePath);
    let receivedA: string | undefined;
    let receivedB: string | undefined;

    clientA.setNotificationHandler('notifications/resources/updated', (n) => {
      receivedA = (n.params as { uri: string }).uri;
    });
    clientB.setNotificationHandler('notifications/resources/updated', (n) => {
      receivedB = (n.params as { uri: string }).uri;
    });

    // Only A listens for the URI (2026-07-28 subscriptions/listen).
    subscription = await clientA.listen({ resourceSubscriptions: [uri] });

    await writeFile(filePath, 'changed');

    // Poll for the debounced notification on A (50ms debounce).
    await waitFor(() => receivedA !== undefined);
    assert.strictEqual(receivedA, uri, 'subscriber A must receive the update');

    // Give B a short window to prove it stays silent — it never subscribed.
    await waitFor(() => receivedB !== undefined, 400);
    assert.strictEqual(
      receivedB,
      undefined,
      'non-subscriber B must NOT receive the update (per-connection gating)',
    );
  });
});

// Fan-out (#13): two clients subscribe to the SAME file URI. Pre-fix, the
// registry's `addCallback` did `set(uri, notify)`, so the second subscriber
// overwrote the first's callback — only one client received the update. The
// Set-based registry must notify every subscriber.
describe('HTTP watcher fan-out (multi-subscriber)', () => {
  let tmpDir: string;
  let http: HttpTestContext;
  let clientA: Client;
  let clientB: Client;
  let subA: McpSubscription | undefined;
  let subB: McpSubscription | undefined;

  before(async () => {
    tmpDir = await createTestRoot();
    await writeTestFile(tmpDir, 'fanout.txt', 'initial');
    http = await bootHttpTest([tmpDir]);
    clientA = await http.makeClient('http-fanout');
    clientB = await http.makeClient('http-fanout');
  });

  after(async () => {
    try {
      await subA?.close();
    } catch {
      /* teardown */
    }
    try {
      await subB?.close();
    } catch {
      /* teardown */
    }
    await http.close();
    await cleanupTestRoot(tmpDir);
  });

  it('both subscribers receive the update for one file URI', async () => {
    const filePath = join(tmpDir, 'fanout.txt');
    const uri = buildFileResourceUri(filePath);
    let countA = 0;
    let countB = 0;

    clientA.setNotificationHandler('notifications/resources/updated', (n) => {
      if ((n.params as { uri: string }).uri === uri) countA += 1;
    });
    clientB.setNotificationHandler('notifications/resources/updated', (n) => {
      if ((n.params as { uri: string }).uri === uri) countB += 1;
    });

    subA = await clientA.listen({ resourceSubscriptions: [uri] });
    subB = await clientB.listen({ resourceSubscriptions: [uri] });

    await writeFile(filePath, 'changed');

    await waitFor(() => countA >= 1 && countB >= 1);
    await setTimeout(150);
    assert.strictEqual(countA, 1, 'subscriber A must receive exactly one update');
    assert.strictEqual(countB, 1, 'subscriber B must receive exactly one update');

    await subA.close();
    await subB.close();
    subA = undefined;
    subB = undefined;
  });

  it('remaining subscriber still receives updates after one unsubscribes', async () => {
    // Regression: `remove(uri)` used to tear down the shared watcher, so a
    // second subscriber silently stopped receiving updates when the first
    // unsubscribed. Ref-counting keeps the watcher live until the last leaves.
    const filePath = join(tmpDir, 'fanout.txt');
    const uri = buildFileResourceUri(filePath);
    let receivedB: string | undefined;

    subA = await clientA.listen({ resourceSubscriptions: [uri] });
    subB = await clientB.listen({ resourceSubscriptions: [uri] });

    // Drain any initial notifications by waiting briefly, then reset B's flag.
    await setTimeout(60);
    clientB.setNotificationHandler('notifications/resources/updated', (n) => {
      receivedB = (n.params as { uri: string }).uri;
    });

    await subA.close();
    subA = undefined;
    await writeFile(filePath, 'after-unsub');

    await waitFor(() => receivedB !== undefined);
    assert.strictEqual(
      receivedB,
      uri,
      'subscriber B must still receive updates after A unsubscribes',
    );
  });
});

// Recursive directory watch (#13): one client subscribes to a DIRECTORY URI.
// Pre-fix, `attach` called `watch(path, cb)` with no options, so child changes
// were not reported. With `{ recursive: true }` for directories, creating a
// child file must notify the subscriber. Note: this creates a DIRECT child,
// which a non-recursive directory watch also catches; nested-grandchild
// coverage depends on platform recursive support (macOS/Windows only — see the
// `attach` ponytail comment), so it is not asserted here to stay green on Linux.
describe('HTTP recursive directory watch', () => {
  let tmpDir: string;
  let http: HttpTestContext;
  let client: Client;
  let subscription: McpSubscription | undefined;

  before(async () => {
    tmpDir = await createTestRoot();
    http = await bootHttpTest([tmpDir]);
    client = await http.makeClient('http-recursive');
  });

  after(async () => {
    try {
      await subscription?.close();
    } catch {
      /* teardown */
    }
    await http.close();
    await cleanupTestRoot(tmpDir);
  });

  it('subscriber is notified when a child file is created under the directory', async () => {
    const dirUri = buildFileResourceUri(tmpDir);
    let received: string | undefined;

    client.setNotificationHandler('notifications/resources/updated', (n) => {
      received = (n.params as { uri: string }).uri;
    });

    subscription = await client.listen({ resourceSubscriptions: [dirUri] });

    const childPath = join(tmpDir, 'child.txt');
    await writeFile(childPath, 'new child');

    await waitFor(() => received !== undefined);
    assert.strictEqual(received, dirUri, 'directory subscriber must be notified of a child change');
  });
});

// resourcesListChanged listen filter: an accepted access grant calls
// notifier.resourcesChanged() -> bus.publish resources_list_changed, and the
// SDK listen router narrows that notification to subscriptions that opted into
// `resourcesListChanged`. Modeled on http-shared-guard: HTTP server,
// elicitation-capable client, FS_ROOT_BOUNDARY=tmpdir() so a grant sticks.
describe('HTTP resourcesListChanged listen filter', () => {
  let rootDir: string;
  let outDir: string;
  let outFile: string;
  let http: HttpTestContext;
  let client: Client;
  let sub: McpSubscription | undefined;

  before(async () => {
    rootDir = await createTestRoot();
    outDir = await mkdtemp(join(tmpdir(), 'fsmcp-listchanged-'));
    outFile = await writeTestFile(outDir, 'granted.txt', 'initial');

    http = await bootHttpTest([rootDir], { FS_ROOT_BOUNDARY: tmpdir() });
    client = await http.makeClient('http-list-changed', () => ({
      action: 'accept' as const,
      content: { confirm: true },
    }));
  });

  after(async () => {
    await sub?.close().catch(() => {});
    await http.close();
    await cleanupTestRoot(outDir);
    await cleanupTestRoot(rootDir);
  });

  it('a grant sends no notifications/resources/list_changed', async () => {
    let received = false;
    client.setNotificationHandler('notifications/resources/list_changed', () => {
      received = true;
    });
    sub = await client.listen({ resourcesListChanged: true });
    try {
      // Trigger a grant: read an out-of-root file; the elicitation handler
      // accepts and applyGrant widens the allowed roots. Nothing announces that,
      // because no resource list reads the roots — the instructions resource has
      // a fixed URI, the result template lists the ResourceStore, and the file
      // template lists nothing. The listener itself is known-good: the next test
      // proves it fires for a store insertion, which does change the list.
      const r = await client.callTool({ name: 'read', arguments: { path: outFile } });
      assert.notStrictEqual(r.isError, true, 'granted read must succeed');
      await setTimeout(150);
      assert.strictEqual(
        received,
        false,
        'a grant must not announce a resource list that cannot have changed',
      );
    } finally {
      await sub.close().catch(() => {});
      sub = undefined;
    }
  });

  it('an externalized result invalidates resources/list and appears after refresh', async () => {
    // Two entries and a one-entry page: an incomplete first page externalizes
    // the full list.
    await writeTestFile(rootDir, 'page-a.txt', 'body a\n');
    await writeTestFile(rootDir, 'page-b.txt', 'body b\n');
    const before = await client.listResources();
    let received = false;
    client.setNotificationHandler('notifications/resources/list_changed', () => {
      received = true;
    });
    sub = await client.listen({ resourcesListChanged: true });

    try {
      const result = (await client.callTool({
        name: 'list',
        arguments: { path: rootDir, maxEntries: 1 },
      })) as { _meta?: { resourceUri?: string } };
      const uri = result._meta?.resourceUri;
      assert.ok(uri, 'an incomplete list page must externalize a result resource');

      await waitFor(() => received);
      assert.strictEqual(received, true, 'result insertion must emit resources/list_changed');

      const after = await client.listResources();
      assert.strictEqual(
        before.resources.some((resource) => resource.uri === uri),
        false,
        'the result must not exist before the tool call',
      );
      assert.strictEqual(
        after.resources.some((resource) => resource.uri === uri),
        true,
        'the invalidated resource list must contain the result URI',
      );
    } finally {
      await sub.close().catch(() => {});
      sub = undefined;
    }
  });
});

// Capacity pre-check overcount (Plan 002): the pre-check used to count every
// requested URI as needing a new slot, including URIs already watched.
// MAX_WATCHERS is a module-level constant read at import time, so it cannot
// be clamped per-test via env var — instead this drives the real default cap
// to its boundary: one URI is already watched, then a single batch mixes
// that URI with just enough new (fake, unvalidatable) URIs to exactly fill
// the remaining slots. The old code counted the already-watched URI too and
// rejected the batch with 400; the fix excludes it and must accept.
describe('HTTP duplicate listen does not consume capacity', () => {
  let tmpDir: string;
  let http: HttpTestContext;
  let client: Client;
  let sub: McpSubscription | undefined;

  before(async () => {
    tmpDir = await createTestRoot();
    await writeTestFile(tmpDir, 'duplisten.txt', 'initial');
    http = await bootHttpTest([tmpDir]);
    client = await http.makeClient('http-dup-listen');
  });

  after(async () => {
    try {
      await sub?.close();
    } catch {
      /* teardown */
    }
    await http.close();
    await cleanupTestRoot(tmpDir);
  });

  it('a batch mixing an already-watched URI with capacity-filling new URIs is accepted', async () => {
    const filePath = join(tmpDir, 'duplisten.txt');
    const uri = buildFileResourceUri(filePath);
    let received: string | undefined;
    client.setNotificationHandler('notifications/resources/updated', (n) => {
      received = (n.params as { uri: string }).uri;
    });

    // Establish the watcher for `uri` first and prove it is live through a
    // delivered notification.
    sub = await client.listen({ resourceSubscriptions: [uri] });
    await writeFile(filePath, 'first-change');
    await waitFor(() => received !== undefined);
    assert.strictEqual(received, uri, 'the real watcher must be live before the batch check');

    // `uri` now occupies exactly one slot. Fill every remaining slot with real
    // files and include `uri` again in the same batch. The already-watched URI
    // must not be counted as a new watcher by the capacity pre-check.
    const capacityUris = await Promise.all(
      Array.from({ length: MAX_WATCHERS - 1 }, async (_, i) =>
        buildFileResourceUri(await writeTestFile(tmpDir, `capacity-${String(i)}.txt`, String(i))),
      ),
    );
    const sub2 = await client.listen({ resourceSubscriptions: [uri, ...capacityUris] });
    await sub2.close();
  });
});

// Regression: `remove(uri)`'s final-teardown branch used to permanently set
// desiredState to 'unsubscribed' on the watched URI. A later
// subscriptions/listen for the same URI never called startSubscribe (the
// modern attach path), so isStale(uri) stayed true forever and the watcher
// silently never attached again. The fix clears the entry on settled
// teardown instead of poisoning it.
describe('HTTP re-listen after full release', () => {
  let tmpDir: string;
  let http: HttpTestContext;
  let client: Client;
  let sub: McpSubscription | undefined;

  before(async () => {
    tmpDir = await createTestRoot();
    await writeTestFile(tmpDir, 'relisten.txt', 'initial');
    http = await bootHttpTest([tmpDir]);
    client = await http.makeClient('http-relisten');
  });

  after(async () => {
    try {
      await sub?.close();
    } catch {
      /* teardown */
    }
    await http.close();
    await cleanupTestRoot(tmpDir);
  });

  it('a URI whose last listener left can be listened to again', async () => {
    const filePath = join(tmpDir, 'relisten.txt');
    const uri = buildFileResourceUri(filePath);

    const first = await client.listen({ resourceSubscriptions: [uri] });
    await first.close();
    await setTimeout(100);

    let received: string | undefined;
    client.setNotificationHandler('notifications/resources/updated', (n) => {
      received = (n.params as { uri: string }).uri;
    });
    sub = await client.listen({ resourceSubscriptions: [uri] });
    await writeFile(filePath, 'changed-after-relisten');
    await waitFor(() => received !== undefined);
    assert.strictEqual(received, uri, 're-listen after release must receive updates');
  });
});

// Graceful close (2026-07-28): when the server closes a listen stream
// deliberately (entry close()/shutdown), it sends the empty
// `subscriptions/listen` JSON-RPC result before closing the stream, and the
// client's `McpSubscription.closed` resolves 'graceful'. A close without that
// result resolves 'remote' (unexpected disconnect) — so this pins the
// deliberate-shutdown path clients use to decide against re-listening.
describe('subscriptions/listen graceful close', () => {
  it("handler close() resolves the subscription's closed promise 'graceful'", async () => {
    const tmpDir = await createTestRoot();
    const harness = await createTestHttpHarness([tmpDir]);
    try {
      const sub = await harness.client.listen({ resourcesListChanged: true });
      await harness.handler.close();
      assert.strictEqual(await sub.closed, 'graceful');
    } finally {
      // handler.close() already ran; harness.close() re-runs it (idempotent)
      // and tears down the client.
      await harness.close();
      await cleanupTestRoot(tmpDir);
    }
  });
});
