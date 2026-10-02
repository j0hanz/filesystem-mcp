import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Notification } from '@modelcontextprotocol/server';
import { isSpecType, type ProgressNotificationParams } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { ProgressSession } from '../src/tools/progress.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  createTestServer,
  type ElicitHandler,
  withBoundary,
  writeTestFile,
} from './helpers.ts';

interface Frame {
  progress: number;
  total?: number;
  message?: string;
}

/**
 * Mirrors how ToolExecutor builds its session (src/tools/define.ts). With a
 * test context, `Date.now` advances one rate-limit window (50ms) per call, so
 * every tick clears the limiter; tests that drive the clock themselves pass
 * nothing. A session that knows no total reports the cursor on its terminal
 * frame, which is the value the last tick already used — the case the
 * monotonic wire guard has to handle without swallowing the outcome.
 */
function session(t?: TestContext): {
  sent: Frame[];
  progress: ProgressSession;
} {
  if (t) {
    let now = 0;
    t.mock.method(Date, 'now', () => (now += 50));
  }
  const sent: Frame[] = [];
  const notify = (n: Notification): Promise<void> => {
    sent.push(n.params as unknown as Frame);
    return Promise.resolve();
  };
  const progress = new ProgressSession({
    label: 'label',
    sink: { toolName: 't', token: 'tok', notify },
  });
  return { sent, progress };
}

describe('ProgressSession wire monotonicity', () => {
  it('SDK-AUDIT-PROGRESS-005: startup does not consume the first work tick budget', async (t) => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const { sent, progress } = session();
    now = 100;

    progress.set({ current: 1, total: 2 });
    await progress.flush();

    assert.deepStrictEqual(
      sent.map((frame) => frame.progress),
      [0, 1],
    );
    assert.strictEqual(sent.at(-1)?.total, 2);
  });

  it('SDK-AUDIT-PROGRESS-006: subsequent work ticks retain the rate limit', async (t) => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const { sent, progress } = session();
    now = 100;
    progress.set({ current: 1 });
    now = 120;
    progress.set({ current: 2 });
    now = 150;

    progress.set({ current: 3 });
    await progress.flush();

    assert.deepStrictEqual(
      sent.map((frame) => frame.progress),
      [0, 1, 3],
    );
  });

  it('SDK-AUDIT-PROGRESS-001: idle and ignored updates emit no startup frame', async (t) => {
    const { sent, progress } = session(t);
    progress.set({ current: 0 });
    progress.set({ current: -1 });

    await progress.flush();

    assert.deepStrictEqual(sent, []);
  });

  for (const terminal of ['complete', 'fail'] as const) {
    it(`SDK-AUDIT-PROGRESS-001: terminal-only ${terminal} sends initial and final frames`, async (t) => {
      const { sent, progress } = session(t);

      progress[terminal]('terminal outcome');
      await progress.flush();

      assert.deepStrictEqual(
        sent.map((frame) => frame.progress),
        [0, 1],
      );
      assert.strictEqual(sent.at(-1)?.message, 'terminal outcome');
    });
  }

  it('delivers every frame of a totalless session, strictly increasing', async (t) => {
    const { sent, progress } = session(t);

    progress.set({ current: 1 });
    progress.set({ current: 2 });
    progress.complete('done');
    await progress.flush();

    // 0 is the session's synthetic start tick; 3 is the completion advanced past
    // the cursor it would otherwise have repeated.
    assert.deepStrictEqual(
      sent.map((f) => f.progress),
      [0, 1, 2, 3],
    );
    assert.strictEqual(sent.at(-1)?.message, 'done');
  });

  async function progressClient(roots: string[], onElicit?: ElicitHandler) {
    const context = await createTestServer(roots);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const frames: ProgressNotificationParams[] = [];
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = async (message, options) => {
      if (isSpecType.ProgressNotification(message)) frames.push(message.params);
      await send(message, options);
    };
    const client = new Client(
      { name: 'progress-test', version: '1.0.0' },
      { capabilities: onElicit ? { elicitation: { form: {} } } : {} },
    );
    if (onElicit) client.setRequestHandler('elicitation/create', onElicit);
    await context.mcp.connect(serverTransport);
    await client.connect(clientTransport);
    assert.strictEqual(client.getProtocolEra(), 'legacy');
    return {
      client,
      frames,
      async close() {
        await client.close();
        context.disposeRuntimeState();
        await context.mcp.close();
      },
    };
  }

  describe('Legacy confirmation progress', () => {
    it('SDK-AUDIT-PROGRESS-004: a call without a progress token sends no progress', async () => {
      const root = await createTestRoot();
      try {
        const pair = await progressClient([root]);
        try {
          const result = await pair.client.callTool({ name: 'list_roots', arguments: {} });

          assert.notStrictEqual(result.isError, true);
          assert.deepStrictEqual(pair.frames, []);
        } finally {
          await pair.close();
        }
      } finally {
        await cleanupTestRoot(root);
      }
    });

    for (const { id, grant } of [
      { id: '002', grant: false },
      { id: '003', grant: true },
    ]) {
      it(`SDK-AUDIT-PROGRESS-${id}: ${grant ? 'grant and overwrite' : 'overwrite'} rounds keep one increasing stream`, async () => {
        const parent = await createTestRoot();
        try {
          await withBoundary(parent, async () => {
            const root = join(parent, 'root');
            await mkdir(root);
            const target = await writeTestFile(
              parent,
              join(grant ? 'outside' : 'root', 'existing.txt'),
              'unchanged body',
            );
            const forms: string[] = [];
            const framesDuringForms: number[] = [];
            const pair = await progressClient([root], (request) => {
              framesDuringForms.push(pair.frames.length);
              if (request.params.mode === 'url') throw new Error('Expected a form');
              if (Object.hasOwn(request.params.requestedSchema.properties, 'confirm')) {
                forms.push('grant');
                return { action: 'accept', content: { confirm: true } };
              }
              forms.push('skip-overwrite');
              return { action: 'accept', content: { choice: 'skip' } };
            });
            try {
              const result = await pair.client.callTool(
                {
                  name: 'create',
                  arguments: { files: [{ path: target, content: 'replacement' }] },
                },
                { onprogress: () => {} },
              );

              assert.notStrictEqual(result.isError, true);
              assert.deepStrictEqual(
                forms,
                grant ? ['grant', 'skip-overwrite'] : ['skip-overwrite'],
              );
              assert.deepStrictEqual(framesDuringForms, grant ? [0, 0] : [0]);
              assert.strictEqual(await readFile(target, 'utf8'), 'unchanged body');
              assert.ok(pair.frames.length >= 2, 'initial and terminal frames are required');
              const first = pair.frames[0];
              const last = pair.frames.at(-1);
              assert.ok(first && last);
              assert.strictEqual(first.progress, 0);
              assert.strictEqual(last.total, last.progress);
              let previous = -1;
              for (const frame of pair.frames) {
                assert.strictEqual(frame.progressToken, first.progressToken);
                assert.ok(frame.progress > previous, 'same-token progress must strictly increase');
                previous = frame.progress;
              }
            } finally {
              await pair.close();
            }
          });
        } finally {
          await cleanupTestRoot(parent);
        }
      });
    }
  });

  it('delivers the fail frame and its message', async (t) => {
    const { sent, progress } = session(t);

    progress.set({ current: 1 });
    progress.fail('failed');
    await progress.flush();

    assert.deepStrictEqual(
      sent.map((f) => f.progress),
      [0, 1, 2],
    );
    assert.strictEqual(sent.at(-1)?.message, 'failed');
  });

  it('keeps a known total ahead of the advanced completion', async (t) => {
    const { sent, progress } = session(t);

    progress.set({ current: 1, total: 2 });
    progress.set({ current: 2, total: 2 });
    progress.complete('done');
    await progress.flush();

    assert.deepStrictEqual(
      sent.map((f) => f.progress),
      [0, 1, 2, 3],
    );
    assert.strictEqual(sent.at(-1)?.total, 3);
  });

  it('drops a tick that repeats the last value on the wire', async (t) => {
    const { sent, progress } = session(t);

    progress.set({ current: 1, total: 3 });
    progress.set({ current: 1, total: 3 });
    await progress.flush();

    assert.deepStrictEqual(
      sent.map((f) => f.progress),
      [0, 1],
    );
  });

  it('read budget: progress total counts every requested path', async () => {
    const root = await createTestRoot();
    try {
      const big = await writeTestFile(root, 'big.txt', 'x'.repeat(600 * 1024) + '\nlast\n');
      const small = await writeTestFile(root, 'small.txt', 'tiny\n');
      const pair = await progressClient([root]);
      try {
        await pair.client.callTool(
          { name: 'read', arguments: { paths: [big, small] } },
          { onprogress: () => {} },
        );
        assert.ok(
          pair.frames.some((f) => f.progress === 1 && f.total === 2),
          `expected a 1/2 work frame, got ${JSON.stringify(pair.frames)}`,
        );
      } finally {
        await pair.close();
      }
    } finally {
      await cleanupTestRoot(root);
    }
  });
});
