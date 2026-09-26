import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { buildFileResourceUri } from '../src/core/file-uri.ts';
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
});
