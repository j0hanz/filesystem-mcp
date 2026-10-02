import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { buildFileResourceUri } from '../src/core/file-uri.ts';
import { createWatcherRegistry } from '../src/core/watcher-registry.ts';
import { createServer } from '../src/server.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  waitFor,
  waitForResourceUpdate,
  writeTestFile,
} from './helpers.ts';

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
    await writeFile(filePath, 'changed');
    await waitForResourceUpdate(pair.client, uri);

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

  it('a repeated subscribe is one subscription: one notification, released by one unsubscribe', async () => {
    const filePath = await writeTestFile(tmpDir, 'dup.txt', 'initial');
    const uri = buildFileResourceUri(filePath);
    let count = 0;

    pair.client.setNotificationHandler('notifications/resources/updated', () => {
      count += 1;
    });

    // Subscribing twice for one URI is the same subscription on the wire. A
    // per-request notify sink made this fan out twice per change and left a
    // lease one unsubscribe could not release.
    await pair.client.subscribeResource({ uri });
    await pair.client.subscribeResource({ uri });

    await writeFile(filePath, 'changed');
    await waitFor(() => count > 0, 2000);
    // Settle past the 50ms debounce so a second sink would have fired by now.
    await setTimeout(200);
    assert.strictEqual(count, 1, 'a doubled subscribe must not double the notifications');

    count = 0;
    await pair.client.unsubscribeResource({ uri });
    await writeFile(filePath, 'changed-again');
    await setTimeout(300);
    assert.strictEqual(count, 0, 'one unsubscribe must end a doubled subscription');
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
    const registry = createWatcherRegistry();
    try {
      const ctx = await createServer({ cliAllowedDirs: [root] }, { watcherRegistry: registry });
      const client = new Client({ name: 'dispose-test', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([ctx.mcp.connect(serverTransport), client.connect(clientTransport)]);

      const uri = buildFileResourceUri(await writeTestFile(root, 'held.txt', 'x'));
      await client.subscribeResource({ uri });
      assert.strictEqual(registry.hasWatcher(uri), true);

      await client.close();
      assert.strictEqual(registry.hasWatcher(uri), false);
    } finally {
      registry.destroy();
      await cleanupTestRoot(root);
    }
  });
});
