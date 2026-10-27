import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { buildFileResourceUri } from '../src/core/file-uri.ts';
import { createRuntimeState, createServer } from '../src/server.ts';
import {
  assertOneNotificationPerRound,
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  waitFor,
  waitForResourceUpdate,
  writeTestFile,
} from './helpers.ts';

describe('assertOneNotificationPerRound', () => {
  it('accepts one notification, and two rounds a debounce apart', () => {
    assertOneNotificationPerRound([10], 'one');
    assertOneNotificationPerRound([10, 70], 'macOS split round');
    assertOneNotificationPerRound([10, 30], 'two rounds pulled together by a client stall');
  });

  it('rejects two notifications in one round, and none at all', () => {
    assert.throws(() => assertOneNotificationPerRound([10, 11], 'dup'), /one debounce round/);
    assert.throws(() => assertOneNotificationPerRound([], 'silent'), /no notification/);
  });
});

describe('Resource subscriptions round-trip', () => {
  let tmpDir: string;
  let pair: Awaited<ReturnType<typeof createTestClientPair>>;

  before(async () => {
    tmpDir = await createTestRoot();
    pair = await createTestClientPair([tmpDir]);
    await writeTestFile(tmpDir, 'watch.txt', 'initial');
  });

  after(async () => {
    await pair.close();
    await cleanupTestRoot(tmpDir);
  });

  it('subscribe -> file modification -> notification -> unsubscribe', async () => {
    const filePath = join(tmpDir, 'watch.txt');
    const uri = buildFileResourceUri(filePath);

    await pair.client.subscribeResource({ uri });

    // Trigger file modification
    await waitForResourceUpdate(pair.client, uri, () => writeFile(filePath, 'changed'));

    // Unsubscribe, then prove the silence with a fresh local handler (the
    // helper call above replaced any handler registered for the method).
    let received: string | undefined;
    pair.client.setNotificationHandler('notifications/resources/updated', (n) => {
      received = (n.params as { uri: string }).uri;
    });
    await pair.client.unsubscribeResource({ uri });

    // Trigger second modification
    await writeFile(filePath, 'changed-again');

    // Short poll to confirm no notification arrives after unsubscribe
    await waitFor(() => received !== undefined, 300);

    assert.strictEqual(received, undefined, 'Should not receive notification after unsubscribe');
  });

  it('waitForResourceUpdate counts an update that lands before its trigger settles', async () => {
    const filePath = await writeTestFile(tmpDir, 'early.txt', 'initial');
    const uri = buildFileResourceUri(filePath);
    await pair.client.subscribeResource({ uri });
    try {
      // The update is sent 50 ms after the write; this trigger settles at 150 ms.
      await waitForResourceUpdate(pair.client, uri, async () => {
        await writeFile(filePath, 'changed');
        await setTimeout(150);
      });
    } finally {
      await pair.client.unsubscribeResource({ uri });
    }
  });

  it('waitForResourceUpdate rejects with the trigger error at once', async () => {
    const started = performance.now();
    await assert.rejects(
      waitForResourceUpdate(pair.client, 'file:///never', () => Promise.reject(new Error('boom'))),
      { message: 'boom' },
    );
    assert.ok(performance.now() - started < 1000, 'must not wait out the timeout');
  });

  it('a repeated subscribe is one subscription: one notification, released by one unsubscribe', async () => {
    const filePath = await writeTestFile(tmpDir, 'dup.txt', 'initial');
    const uri = buildFileResourceUri(filePath);
    const arrivals: number[] = [];

    pair.client.setNotificationHandler('notifications/resources/updated', () => {
      arrivals.push(performance.now());
    });

    // Subscribing twice for one URI is the same subscription on the wire. A
    // per-request notify sink made this fan out twice per change and left a
    // lease one unsubscribe could not release.
    await pair.client.subscribeResource({ uri });
    await pair.client.subscribeResource({ uri });

    await writeFile(filePath, 'changed');
    await waitFor(() => arrivals.length > 0, 2000);
    // Count rounds, not raw notifications: one write may legitimately span two.
    await setTimeout(200);
    assertOneNotificationPerRound(arrivals, 'a doubled subscribe');

    const seen = arrivals.length;
    await pair.client.unsubscribeResource({ uri });
    await writeFile(filePath, 'changed-again');
    await setTimeout(300);
    assert.strictEqual(arrivals.length, seen, 'one unsubscribe must end a doubled subscription');
  });

  it('unsubscribing a URI never subscribed does not drop another holder watcher', async () => {
    const held = await writeTestFile(tmpDir, 'held.txt', 'initial');
    const uri = buildFileResourceUri(held);
    let count = 0;

    pair.client.setNotificationHandler('notifications/resources/updated', () => {
      count += 1;
    });

    await pair.client.subscribeResource({ uri });
    // Over-release: the registry ref-counts by URI, so an unsubscribe for a
    // lease this connection never took used to decrement someone else's.
    await pair.client.unsubscribeResource({
      uri: buildFileResourceUri(join(tmpDir, 'never-subscribed.txt')),
    });

    await writeFile(held, 'changed');
    await waitFor(() => count > 0, 2000);
    assert.strictEqual(count, 1, 'the live subscription must survive an unrelated unsubscribe');

    await pair.client.unsubscribeResource({ uri });
  });

  it("a subscription survives the server's own atomic replace and keeps notifying", async () => {
    const filePath = await writeTestFile(tmpDir, 'replaced.txt', 'one\n');
    const uri = buildFileResourceUri(filePath);
    let count = 0;
    pair.client.setNotificationHandler('notifications/resources/updated', (n) => {
      if ((n.params as { uri: string }).uri === uri) count += 1;
    });
    await pair.client.subscribeResource({ uri });

    // Each edit commits by renaming a temp file over the path: a new inode.
    const edit = (oldText: string, newText: string) =>
      pair.client.callTool({
        name: 'edit',
        arguments: { path: filePath, edits: [{ oldText, newText }] },
      });

    const first = await edit('one', 'two');
    assert.notStrictEqual(first.isError, true);
    await waitFor(() => count >= 1, 3000);
    assert.ok(count >= 1, 'the first replace must notify');

    const seen = count;
    const second = await edit('two', 'three');
    assert.notStrictEqual(second.isError, true);
    await waitFor(() => count > seen, 3000);
    assert.ok(count > seen, 'the second replace must notify too (inode-bound watch went silent)');

    await pair.client.unsubscribeResource({ uri });
  });
});

describe('createServer disposal on connection close', () => {
  it('closing a connected client releases the leases it held', async () => {
    const root = await createTestRoot();
    const state = createRuntimeState({ cliAllowedDirs: [root] });
    try {
      const ctx = await createServer({ cliAllowedDirs: [root] }, { state });
      const client = new Client({ name: 'dispose-test', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([ctx.mcp.connect(serverTransport), client.connect(clientTransport)]);

      const uri = buildFileResourceUri(await writeTestFile(root, 'held.txt', 'x'));
      await client.subscribeResource({ uri });
      assert.strictEqual(state.watcherRegistry.hasWatcher(uri), true);

      await client.close();
      assert.strictEqual(state.watcherRegistry.hasWatcher(uri), false);
    } finally {
      state.dispose();
      await cleanupTestRoot(root);
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
      await cleanupTestRoot(root);
    }
  });

  it('createRuntimeState dispose clears the page store', () => {
    const state = createRuntimeState({ cliAllowedDirs: [tmpdir()] });
    const pageId = state.pageStore.create({ queryKey: 'q', items: [1] });
    state.dispose();
    state.dispose(); // idempotent
    assert.throws(() => state.pageStore.read(pageId, 'q'));
  });
});

describe('Resource subscription guards', () => {
  let top: string;
  let root: string;
  let pair: Awaited<ReturnType<typeof createTestClientPair>>;

  before(async () => {
    top = await createTestRoot();
    root = join(top, 'root');
    await mkdir(root);
    await writeFile(join(top, 'outside.txt'), 'x');
    await writeFile(join(root, '.env'), 'x');
    pair = await createTestClientPair([root]);
  });

  after(async () => {
    await pair.close();
    await cleanupTestRoot(top);
  });

  it('subscribe refuses a file outside the root and a sensitive file', async () => {
    const paths = [join(top, 'outside.txt'), join(root, '.env')];
    for (const p of paths) {
      await assert.rejects(
        pair.client.subscribeResource({ uri: buildFileResourceUri(p) }),
        (err: unknown) => {
          assert.equal((err as { code?: unknown }).code, ProtocolErrorCode.InvalidParams);
          return true;
        },
      );
    }

    let received: string | undefined;
    pair.client.setNotificationHandler('notifications/resources/updated', (n) => {
      received = (n.params as { uri: string }).uri;
    });
    for (const p of paths) await writeFile(p, 'changed');
    await waitFor(() => received !== undefined, 300);
    assert.strictEqual(received, undefined, 'no watcher may be attached to a refused file');
  });
});
