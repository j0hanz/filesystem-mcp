import type { Notification } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProgressSession } from '../src/tools/progress.ts';

interface Frame {
  progress: number;
  total?: number;
  message?: string;
}

/**
 * Mirrors how ToolExecutor builds its session (src/tools/define.ts): rate
 * limiting off. A session that knows no total reports the cursor on its
 * terminal frame, which is the value the last tick already used — the case the
 * monotonic wire guard has to handle without swallowing the outcome.
 */
function session(): { sent: Frame[]; progress: ProgressSession } {
  const sent: Frame[] = [];
  const notify = (n: Notification): Promise<void> => {
    sent.push(n.params as unknown as Frame);
    return Promise.resolve();
  };
  const progress = new ProgressSession({
    label: 'label',
    sink: { toolName: 't', token: 'tok', notify },
    rateLimitMs: 0,
  });
  return { sent, progress };
}

describe('ProgressSession wire monotonicity', () => {
  it('delivers every frame of a totalless session, strictly increasing', async () => {
    const { sent, progress } = session();

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

  it('delivers the fail frame and its message', async () => {
    const { sent, progress } = session();

    progress.set({ current: 1 });
    progress.fail('failed');
    await progress.flush();

    assert.deepStrictEqual(
      sent.map((f) => f.progress),
      [0, 1, 2],
    );
    assert.strictEqual(sent.at(-1)?.message, 'failed');
  });

  it('keeps a known total ahead of the advanced completion', async () => {
    const { sent, progress } = session();

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

  it('drops a tick that repeats the last value on the wire', async () => {
    const { sent, progress } = session();

    progress.set({ current: 1, total: 3 });
    progress.set({ current: 1, total: 3 });
    await progress.flush();

    assert.deepStrictEqual(
      sent.map((f) => f.progress),
      [0, 1],
    );
  });
});
