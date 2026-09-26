import type { McpSubscription } from '@modelcontextprotocol/client';
import { ProtocolErrorCode, STDIO_DEFAULT_MAX_BUFFER_SIZE } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { isNodeError } from '../src/core/errors.ts';
import { buildFileResourceUri } from '../src/core/file-uri.ts';
import { MUTATING_TOOL_NAMES } from '../src/tools/index.ts';
import {
  ALL_REGISTERED_TOOL_NAMES,
  cleanupTestRoot,
  createRawStdioServer,
  createStdioClient,
  createTestRoot,
  firstTextBlock,
  waitFor,
  waitForResourceUpdate,
  writeTestFile,
} from './helpers.ts';

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new Error(`operation did not settle within ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('Stdio Transport (real subprocess)', () => {
  let tmpDir: string;
  let harness: Awaited<ReturnType<typeof createStdioClient>>;
  const subscriptions: McpSubscription[] = [];

  before(async () => {
    tmpDir = await createTestRoot();
    harness = await createStdioClient(tmpDir);
  });

  after(async () => {
    for (const s of subscriptions) await s.close().catch(() => {});
    if (harness) await harness.close();
    if (tmpDir) await cleanupTestRoot(tmpDir);
  });

  it('STDIO-001: lists all tools over a real stdio subprocess', async () => {
    const tools = await harness.client.listTools();
    assert.strictEqual(tools.tools.length, ALL_REGISTERED_TOOL_NAMES.length);
  });

  it('STDIO-002: reads a file over a real stdio subprocess', async () => {
    const filePath = await writeTestFile(tmpDir, 'stdio.txt', 'stdio content');
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: filePath },
    });
    assert.notStrictEqual(result.isError, true);
    assert.ok(firstTextBlock(result).text?.includes('stdio content'));
  });

  it('STDIO-003: subscriptions/listen delivers resource updates over stdio', async () => {
    // The SDK acknowledges the listen and routes outbound change notifications,
    // but attaches no watcher — the entry taps the wire for the inbound filter
    // so one gets attached. Without that tap this never fires.
    const filePath = await writeTestFile(tmpDir, 'listen.txt', 'initial');
    const uri = buildFileResourceUri(filePath);

    subscriptions.push(await harness.client.listen({ resourceSubscriptions: [uri] }));
    await writeFile(filePath, 'changed');

    await waitForResourceUpdate(harness.client, uri);
  });

  it('STDIO-004: re-listening on one URI registers one watcher callback, not one per listen', async () => {
    // Two open listen streams both match this URI, so the SDK router delivers
    // two notifications per change — that fan-out is expected. What must NOT
    // scale is the registry side: the notify sink is one closure per
    // connection, so the second listen re-registers the same callback and the
    // registry de-duplicates it by identity. A sink built per listen would
    // stack a second callback, each sending its own update through the same
    // two streams — 4 notifications, and an activeCallbacks set that grows
    // with every re-listen (MAX_WATCHERS caps watchers, not callbacks).
    const filePath = await writeTestFile(tmpDir, 'relisten.txt', 'initial');
    const uri = buildFileResourceUri(filePath);
    const streams = 2;
    let count = 0;

    harness.client.setNotificationHandler('notifications/resources/updated', (n) => {
      if ((n.params as { uri: string }).uri === uri) count += 1;
    });

    for (let i = 0; i < streams; i += 1) {
      subscriptions.push(await harness.client.listen({ resourceSubscriptions: [uri] }));
    }

    await writeFile(filePath, 'changed');
    await waitFor(() => count >= streams, 5000);
    // Settle past the registry's 50ms debounce so a stacked second callback
    // would have landed by now.
    await waitFor(() => count > streams, 500);

    assert.strictEqual(
      count,
      streams,
      'one change must yield one update per listen stream; more means a stacked notify callback',
    );
  });

  it('STDIO-005: rejects a missing filesystem resource before acknowledging the listen', async () => {
    const uri = buildFileResourceUri(join(tmpDir, 'missing-listen.txt'));

    await assert.rejects(
      harness.client.listen({ resourceSubscriptions: [uri] }),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, ProtocolErrorCode.InvalidParams);
        return true;
      },
    );
  });

  it('STDIO-012: pagination snapshots survive separate stdio requests', async () => {
    const pageDir = join(tmpDir, 'stdio-pages');
    await writeTestFile(pageDir, 'alpha.txt', 'alpha');
    await writeTestFile(pageDir, 'bravo.txt', 'bravo');

    const first = await harness.client.callTool({
      name: 'list',
      arguments: { path: pageDir, maxEntries: 1 },
    });
    const cursor = (first._meta as { nextCursor?: string }).nextCursor;
    assert.ok(cursor);

    const second = await harness.client.callTool({
      name: 'list',
      arguments: { path: pageDir, maxEntries: 10, cursor },
    });
    assert.notStrictEqual(second.isError, true);
    assert.deepStrictEqual(
      (second._meta as { entries?: { name: string }[] }).entries?.map((entry) => entry.name),
      ['bravo.txt'],
    );
  });
});

// argv-only behaviour: these flags are read by parseArgs before any server
// exists, so the only honest coverage spawns a real process with them set.
describe('Stdio CLI flags (real subprocess)', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await createTestRoot();
  });

  after(async () => {
    if (tmpDir) await cleanupTestRoot(tmpDir);
  });

  it('STDIO-CLI-001: --read-only unregisters every mutating tool', async () => {
    const harness = await createStdioClient(tmpDir, {}, ['--read-only']);
    try {
      const names = (await harness.client.listTools()).tools.map((t) => t.name);
      for (const mutating of MUTATING_TOOL_NAMES) {
        assert.ok(
          !names.includes(mutating),
          `${mutating} must not be registered under --read-only`,
        );
      }
      assert.ok(names.includes('read'));
      assert.ok(names.includes('list_roots'));
    } finally {
      await harness.close();
    }
  });

  it('STDIO-CLI-002: --root-boundary denies a path that escapes the boundary', async () => {
    const harness = await createStdioClient(tmpDir, {}, ['--root-boundary', tmpDir]);
    try {
      const result = await harness.client.callTool({
        name: 'read',
        arguments: { path: join(tmpDir, '../../../../etc/shadow') },
      });
      assert.strictEqual(result.isError, true);
      const [first] = (result._meta as { results?: { error?: { code?: string } }[] }).results ?? [];
      assert.strictEqual(first?.error?.code, 'ACCESS_DENIED');
    } finally {
      await harness.close();
    }
  });
});

describe('Stdio subscription lease lifecycle', () => {
  it('STDIO-014: buffer overflow releases watchers and exits with stdin still open', async () => {
    const root = await createTestRoot();
    const harness = await createRawStdioServer(root);
    const pipeErrors: Error[] = [];
    let stderr = '';
    harness.child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    harness.child.stdin.on('error', (error: Error) => pipeErrors.push(error));
    try {
      const file = await writeTestFile(root, 'overflow.txt', 'watched');
      await harness.send({
        jsonrpc: '2.0',
        id: 'overflow-listen',
        method: 'subscriptions/listen',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'raw-stdio-test', version: '1.0.0' },
          },
          notifications: { resourceSubscriptions: [buildFileResourceUri(file)] },
        },
      });
      const acknowledged = await within(harness.nextMessage(), 5000);
      assert.ok('method' in acknowledged, JSON.stringify(acknowledged));
      assert.equal(acknowledged.method, 'notifications/subscriptions/acknowledged');
      assert.equal(
        acknowledged.params?._meta?.['io.modelcontextprotocol/subscriptionId'],
        'overflow-listen',
      );

      const exited = once(harness.child, 'exit');
      // No newline, stdin end, or drain wait: overflow itself must close the connection.
      harness.child.stdin.write(Buffer.alloc(STDIO_DEFAULT_MAX_BUFFER_SIZE + 1, 'x'));
      await waitFor(() => stderr.includes('ReadBuffer exceeded maximum size'), 3000);
      assert.match(stderr, /ReadBuffer exceeded maximum size/);
      assert.deepEqual(
        await within(exited, 5000),
        [0, null],
        'the subscribed child must exit naturally after overflow',
      );
      assert.equal(harness.child.stdin.writableEnded, false);
      await within(harness.close(), 1000);
      await within(harness.close(), 1000);
      for (const error of pipeErrors) {
        assert.ok(isNodeError(error));
        assert.ok(error.code !== undefined);
        assert.ok(
          ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(error.code),
          error.message,
        );
      }
    } finally {
      if (harness.child.exitCode === null && harness.child.signalCode === null) {
        harness.child.kill();
      }
      await within(harness.close(), 3000);
      await cleanupTestRoot(root);
    }
  });

  it('STDIO-006: closing a listen frees a one-slot watcher budget', async () => {
    const tmpDir = await createTestRoot();
    const harness = await createStdioClient(tmpDir, {
      FS_MAX_WATCHERS: '1',
    });
    try {
      const fileA = await writeTestFile(tmpDir, 'lease-a.txt', 'A');
      const fileB = await writeTestFile(tmpDir, 'lease-b.txt', 'B');
      const first = await harness.client.listen({
        resourceSubscriptions: [buildFileResourceUri(fileA)],
      });

      await first.close();

      const second = await harness.client.listen({
        resourceSubscriptions: [buildFileResourceUri(fileB)],
      });
      await second.close();
    } finally {
      await harness.close();
      await cleanupTestRoot(tmpDir);
    }
  });

  it('STDIO-007: an SDK-rejected listen does not consume watcher capacity', async () => {
    const tmpDir = await createTestRoot();
    const harness = await createRawStdioServer(tmpDir, {
      FS_MAX_WATCHERS: '1',
    });
    try {
      const invalidFile = await writeTestFile(tmpDir, 'invalid-listen.txt', 'invalid');
      const validFile = await writeTestFile(tmpDir, 'valid-listen.txt', 'valid');

      const meta = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'raw-stdio-test', version: '1.0.0' },
      };
      await harness.send({
        jsonrpc: '2.0',
        id: 'discover',
        method: 'server/discover',
        params: { _meta: meta },
      });
      const discover = await harness.nextMessage();
      assert.ok('result' in discover, JSON.stringify(discover));

      await harness.send({
        jsonrpc: '2.0',
        id: 'invalid',
        method: 'subscriptions/listen',
        params: {
          _meta: meta,
          notifications: {
            resourceSubscriptions: [buildFileResourceUri(invalidFile), 42 as never],
          },
        },
      });
      const rejected = await harness.nextMessage();
      assert.ok('error' in rejected);

      await harness.send({
        jsonrpc: '2.0',
        id: 'valid',
        method: 'subscriptions/listen',
        params: {
          _meta: meta,
          notifications: {
            resourceSubscriptions: [buildFileResourceUri(validFile)],
          },
        },
      });
      const acknowledged = await harness.nextMessage();
      assert.ok('method' in acknowledged, JSON.stringify(acknowledged));
      assert.strictEqual(acknowledged.method, 'notifications/subscriptions/acknowledged');
    } finally {
      await harness.close();
      await cleanupTestRoot(tmpDir);
    }
  });

  it('STDIO-008: cancelling an accepted listen frees its watcher lease', async () => {
    const tmpDir = await createTestRoot();
    const harness = await createRawStdioServer(tmpDir, {
      FS_MAX_WATCHERS: '1',
    });
    try {
      const fileA = await writeTestFile(tmpDir, 'cancel-a.txt', 'A');
      const fileB = await writeTestFile(tmpDir, 'cancel-b.txt', 'B');
      const meta = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'raw-stdio-test', version: '1.0.0' },
      };

      await harness.send({
        jsonrpc: '2.0',
        id: 'discover',
        method: 'server/discover',
        params: { _meta: meta },
      });
      assert.ok('result' in (await harness.nextMessage()));

      await harness.send({
        jsonrpc: '2.0',
        id: 'first',
        method: 'subscriptions/listen',
        params: {
          _meta: meta,
          notifications: {
            resourceSubscriptions: [buildFileResourceUri(fileA)],
          },
        },
      });
      const firstAck = await harness.nextMessage();
      assert.ok('method' in firstAck);

      await harness.send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'first' },
      });

      await harness.send({
        jsonrpc: '2.0',
        id: 'second',
        method: 'subscriptions/listen',
        params: {
          _meta: meta,
          notifications: {
            resourceSubscriptions: [buildFileResourceUri(fileB)],
          },
        },
      });
      const secondAck = await harness.nextMessage();
      assert.ok('method' in secondAck, JSON.stringify(secondAck));
      assert.strictEqual(secondAck.method, 'notifications/subscriptions/acknowledged');
    } finally {
      await harness.close();
      await cleanupTestRoot(tmpDir);
    }
  });

  it('STDIO-009: cancellation queued with a pending listen suppresses admission', async () => {
    const tmpDir = await createTestRoot();
    const harness = await createRawStdioServer(tmpDir, {
      FS_MAX_WATCHERS: '1',
    });
    try {
      const fileA = await writeTestFile(tmpDir, 'pending-a.txt', 'A');
      const fileB = await writeTestFile(tmpDir, 'pending-b.txt', 'B');
      const meta = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'raw-stdio-test', version: '1.0.0' },
      };

      await harness.send({
        jsonrpc: '2.0',
        id: 'discover',
        method: 'server/discover',
        params: { _meta: meta },
      });
      assert.ok('result' in (await harness.nextMessage()));

      await harness.sendMany([
        {
          jsonrpc: '2.0',
          id: 'pending',
          method: 'subscriptions/listen',
          params: {
            _meta: meta,
            notifications: {
              resourceSubscriptions: [buildFileResourceUri(fileA)],
            },
          },
        },
        {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 'pending' },
        },
      ]);

      await harness.send({
        jsonrpc: '2.0',
        id: 'after-pending-cancel',
        method: 'subscriptions/listen',
        params: {
          _meta: meta,
          notifications: {
            resourceSubscriptions: [buildFileResourceUri(fileB)],
          },
        },
      });
      const acknowledged = await harness.nextMessage();
      assert.ok('method' in acknowledged, JSON.stringify(acknowledged));
      assert.strictEqual(acknowledged.method, 'notifications/subscriptions/acknowledged');
      assert.equal(
        acknowledged.params?._meta?.['io.modelcontextprotocol/subscriptionId'],
        'after-pending-cancel',
      );
    } finally {
      await harness.close();
      await cleanupTestRoot(tmpDir);
    }
  });

  it('STDIO-010: shared URI listens release one lease per cancellation', async () => {
    const tmpDir = await createTestRoot();
    const harness = await createRawStdioServer(tmpDir, {
      FS_MAX_WATCHERS: '1',
    });
    try {
      const sharedFile = await writeTestFile(tmpDir, 'shared.txt', 'shared');
      const otherFile = await writeTestFile(tmpDir, 'other.txt', 'other');
      const sharedUri = buildFileResourceUri(sharedFile);
      const otherUri = buildFileResourceUri(otherFile);
      const meta = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'raw-stdio-test', version: '1.0.0' },
      };

      await harness.send({
        jsonrpc: '2.0',
        id: 'discover',
        method: 'server/discover',
        params: { _meta: meta },
      });
      assert.ok('result' in (await harness.nextMessage()));

      for (const id of ['shared-1', 'shared-2']) {
        await harness.send({
          jsonrpc: '2.0',
          id,
          method: 'subscriptions/listen',
          params: {
            _meta: meta,
            notifications: { resourceSubscriptions: [sharedUri] },
          },
        });
        assert.ok('method' in (await harness.nextMessage()));
      }

      await harness.send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'shared-1' },
      });
      await harness.send({
        jsonrpc: '2.0',
        id: 'blocked',
        method: 'subscriptions/listen',
        params: {
          _meta: meta,
          notifications: { resourceSubscriptions: [otherUri] },
        },
      });
      const blocked = await harness.nextMessage();
      assert.ok('error' in blocked, JSON.stringify(blocked));
      assert.strictEqual(blocked.error.code, ProtocolErrorCode.InvalidParams);

      await harness.send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'shared-2' },
      });
      await harness.send({
        jsonrpc: '2.0',
        id: 'released',
        method: 'subscriptions/listen',
        params: {
          _meta: meta,
          notifications: { resourceSubscriptions: [otherUri] },
        },
      });
      const released = await harness.nextMessage();
      assert.ok('method' in released, JSON.stringify(released));
      assert.strictEqual(released.method, 'notifications/subscriptions/acknowledged');
    } finally {
      await harness.close();
      await cleanupTestRoot(tmpDir);
    }
  });

  it('STDIO-011: an SDK version rejection releases an acquired watcher lease', async () => {
    const tmpDir = await createTestRoot();
    const harness = await createRawStdioServer(tmpDir, {
      FS_MAX_WATCHERS: '1',
    });
    try {
      const rejectedFile = await writeTestFile(tmpDir, 'version-rejected.txt', 'rejected');
      const validFile = await writeTestFile(tmpDir, 'version-valid.txt', 'valid');
      const clientInfo = { name: 'raw-stdio-test', version: '1.0.0' };
      const validMeta = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': clientInfo,
      };

      await harness.send({
        jsonrpc: '2.0',
        id: 'discover',
        method: 'server/discover',
        params: { _meta: validMeta },
      });
      assert.ok('result' in (await harness.nextMessage()));

      await harness.send({
        jsonrpc: '2.0',
        id: 'unsupported-version',
        method: 'subscriptions/listen',
        params: {
          _meta: {
            ...validMeta,
            'io.modelcontextprotocol/protocolVersion': '1900-01-01',
          },
          notifications: {
            resourceSubscriptions: [buildFileResourceUri(rejectedFile)],
          },
        },
      });
      const rejected = await harness.nextMessage();
      assert.ok('error' in rejected, JSON.stringify(rejected));
      assert.strictEqual(rejected.error.code, -32022);

      await harness.send({
        jsonrpc: '2.0',
        id: 'after-version-rejection',
        method: 'subscriptions/listen',
        params: {
          _meta: validMeta,
          notifications: {
            resourceSubscriptions: [buildFileResourceUri(validFile)],
          },
        },
      });
      const acknowledged = await harness.nextMessage();
      assert.ok('method' in acknowledged, JSON.stringify(acknowledged));
      assert.strictEqual(acknowledged.method, 'notifications/subscriptions/acknowledged');
    } finally {
      await harness.close();
      await cleanupTestRoot(tmpDir);
    }
  });

  it('STDIO-013: a listen sent as the first modern request attaches its watcher', async () => {
    const tmpDir = await createTestRoot();
    const harness = await createRawStdioServer(tmpDir);
    try {
      const file = await writeTestFile(tmpDir, 'first-request-listen.txt', 'before');
      const uri = buildFileResourceUri(file);
      const meta = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'raw-stdio-test', version: '1.0.0' },
      };

      await harness.send({
        jsonrpc: '2.0',
        id: 'first-request-listen',
        method: 'subscriptions/listen',
        params: {
          _meta: meta,
          notifications: { resourceSubscriptions: [uri] },
        },
      });
      const acknowledged = await harness.nextMessage();
      assert.ok('method' in acknowledged, JSON.stringify(acknowledged));
      assert.strictEqual(acknowledged.method, 'notifications/subscriptions/acknowledged');

      await writeFile(file, 'after');
      const updated = await Promise.race([
        harness.nextMessage(),
        setTimeout(750).then(() => {
          throw new Error('timed out waiting for the first-request watcher');
        }),
      ]);
      assert.ok('method' in updated, JSON.stringify(updated));
      assert.strictEqual(updated.method, 'notifications/resources/updated');
      assert.strictEqual(updated.params?.['uri'], uri);
    } finally {
      await harness.close();
      await cleanupTestRoot(tmpDir);
    }
  });
});
