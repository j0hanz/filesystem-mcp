import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildFileResourceUri } from '../src/core/file-uri.ts';
import { sanitizeLogField } from '../src/core/observability.ts';
import { createWatcherRegistry, MAX_WATCHERS } from '../src/core/watcher-registry.ts';
import { cleanupTestRoot, createTestRoot, makeGuard } from './helpers.ts';

describe('sanitizeLogField', () => {
  it('flattens control characters so a client value cannot forge a log line', () => {
    assert.strictEqual(sanitizeLogField('7\n[error] forged\r\n'), '7 [error] forged ');
  });

  it('flattens the Unicode line and paragraph separators too', () => {
    assert.strictEqual(sanitizeLogField('a\u2028b\u2029c'), 'a b c');
  });

  it('caps the value length, or leaves it uncapped on request', () => {
    assert.strictEqual(sanitizeLogField('x'.repeat(500)).length, 128);
    assert.strictEqual(sanitizeLogField('x'.repeat(500), Infinity).length, 500);
  });

  it('sanitizes client-supplied URI when warning at the watcher cap', async (t) => {
    const dir = await createTestRoot();
    const guard = await makeGuard([dir]);
    const registry = createWatcherRegistry();
    const logged: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
      logged.push(args);
    });
    const acquiredUris: string[] = [];

    try {
      for (let i = 0; i < MAX_WATCHERS; i++) {
        const sub = join(dir, `sub-${i}`);
        await mkdir(sub);
        const uri = buildFileResourceUri(sub);
        const res = await registry.acquire(guard, uri, () => {});
        assert.strictEqual(res.ok, true);
        acquiredUris.push(uri);
      }

      const forgedUri = `${buildFileResourceUri(dir)}/x\n[error] forged line`;
      const capped = await registry.acquire(guard, forgedUri, () => {});
      assert.deepStrictEqual(capped, { ok: false, reason: 'capped' });

      const capLogs = logged.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('Cannot subscribe to'),
      );
      assert.strictEqual(capLogs.length, 1);
      const firstArg = capLogs[0]?.[0];
      assert(typeof firstArg === 'string');
      assert.strictEqual(firstArg.includes('\n'), false);
    } finally {
      for (const uri of acquiredUris) {
        registry.release(uri);
      }
      await cleanupTestRoot(dir);
    }
  });
});
