import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { buildFileResourceUri } from '../src/core/file-uri.ts';
import { Logger } from '../src/core/observability.ts';
import type { PathGuard } from '../src/core/path.ts';
import { createWatcherRegistry, MAX_WATCHERS, type WatchFn } from '../src/core/watcher-registry.ts';

type FakeWatcher = EventEmitter & {
  closed: boolean;
  close(): void;
  fire(filename: string | null): void;
};

/** A `watch` stand-in: each call yields one FakeWatcher whose `fire` runs the registry's listener. */
export function fakeWatch(): { watch: WatchFn; watchers: FakeWatcher[] } {
  const watchers: FakeWatcher[] = [];
  const watch: WatchFn = (_path, _options, listener) => {
    const w = new EventEmitter() as FakeWatcher;
    w.closed = false;
    w.close = () => {
      w.closed = true;
    };
    w.fire = (filename) => listener('change', filename);
    watchers.push(w);
    return w as unknown as ReturnType<WatchFn>;
  };
  return { watch, watchers };
}

export function fakeGuard(allowed: () => boolean): PathGuard {
  return {
    validateExistingPath: async (p: string) => p,
    isInsideAllowed: () => allowed(),
  } as unknown as PathGuard;
}

describe('watcher registry', () => {
  let dir: string;
  let filePath: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'watcher-registry-'));
    filePath = join(dir, 'a.txt');
    await writeFile(filePath, 'x');
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a watcher error notifies each subscriber once, then frees the slot', async () => {
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const uri = buildFileResourceUri(filePath); // real tmp file
    const seen: string[] = [];
    const throwing = () => {
      throw new Error('boom');
    };
    assert.deepEqual(
      await registry.acquire(
        fakeGuard(() => true),
        uri,
        throwing,
      ).ready,
      { ok: true },
    );
    assert.deepEqual(
      await registry.acquire(
        fakeGuard(() => true),
        uri,
        (u) => seen.push(u),
      ).ready,
      { ok: true },
    );
    watchers[0]?.emit('error', new Error('EPERM'));
    assert.deepEqual(seen, [uri]); // synchronous, not debounced
    assert.equal(registry.size(), 0);
    assert.equal(registry.hasWatcher(uri), false);
  });

  it('a watcher whose close throws is still dropped, and the throw is logged', async (t) => {
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const uri = buildFileResourceUri(filePath);
    const lease = registry.acquire(
      fakeGuard(() => true),
      uri,
      () => {},
    );
    assert.deepEqual(await lease.ready, { ok: true });
    const w = watchers[0];
    assert.ok(w);
    w.close = () => {
      throw new Error('close boom');
    };
    const errors = t.mock.method(Logger, 'error', () => {});
    assert.doesNotThrow(() => {
      lease.dispose();
    });
    assert.equal(errors.mock.callCount(), 1);
    assert.match(String(errors.mock.calls[0]?.arguments[0]), /close boom/u);
    assert.equal(registry.size(), 0);
    assert.equal(registry.hasWatcher(uri), false);
  });

  it('a change under a revoked root notifies nobody and keeps the watcher', async () => {
    const uri = buildFileResourceUri(filePath);
    let allowed = true;
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const seen: string[] = [];
    await registry.acquire(
      fakeGuard(() => allowed),
      uri,
      (u) => seen.push(u),
    ).ready;
    allowed = false;
    watchers[0]?.fire(basename(filePath));
    await setTimeout(100);
    assert.deepEqual(seen, []);
    assert.equal(registry.size(), 1);
  });

  it('a change whose resolved path left the allowed roots notifies nobody', async () => {
    const uri = buildFileResourceUri(filePath);
    const target = join(dir, 'target.txt');
    await writeFile(target, 'x');
    const guard = {
      validateExistingPath: async () => target, // symlink-style: URI path resolves elsewhere
      isInsideAllowed: (p: string) => p !== target,
    } as unknown as PathGuard;
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const seen: string[] = [];
    await registry.acquire(guard, uri, (u) => seen.push(u)).ready;
    watchers[0]?.fire(basename(target));
    await setTimeout(100);
    assert.deepEqual(seen, []);
  });

  it('notices resume on the same watcher once the root is granted again', async () => {
    const uri = buildFileResourceUri(filePath);
    let allowed = true;
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const seen: string[] = [];
    const notify = (u: string) => seen.push(u);
    await registry.acquire(
      fakeGuard(() => allowed),
      uri,
      notify,
    ).ready;
    allowed = false;
    watchers[0]?.fire(basename(filePath));
    await setTimeout(100);
    assert.deepEqual(seen, []);
    allowed = true;
    watchers[0]?.fire(basename(filePath));
    await setTimeout(100);
    assert.deepEqual(seen, [uri]);
    assert.equal(watchers.length, 1);
  });

  it('two URIs for one file share a watcher and each hears its own URI', async () => {
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const plain = buildFileResourceUri(filePath);
    const aliased = plain.replace(/a\.txt$/, '%61.txt'); // test file named a.txt
    const seen: string[] = [];
    const plainLease = registry.acquire(
      fakeGuard(() => true),
      plain,
      (u) => seen.push(u),
    );
    await plainLease.ready;
    const aliasedLease = registry.acquire(
      fakeGuard(() => true),
      aliased,
      (u) => seen.push(u),
    );
    await aliasedLease.ready;
    assert.equal(watchers.length, 1);
    assert.equal(registry.size(), 1);
    watchers[0]?.fire('a.txt');
    await setTimeout(100);
    assert.deepEqual(seen.sort(), [aliased, plain].sort());
    plainLease.dispose();
    assert.equal(registry.size(), 1);
    seen.length = 0;
    watchers[0]?.fire('a.txt');
    await setTimeout(100);
    assert.deepEqual(seen, [aliased]);
    aliasedLease.dispose();
    assert.equal(registry.size(), 0);
  });

  it('at cap an alias still joins its watcher, and an error reaches every alias', async () => {
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const guard = fakeGuard(() => true);
    const plain = buildFileResourceUri(filePath);
    const aliased = plain.replace(/a\.txt$/, '%61.txt');
    const seen: string[] = [];
    await registry.acquire(guard, plain, (u) => seen.push(u)).ready;
    for (let i = 1; i < MAX_WATCHERS; i++) {
      const sub = join(dir, `cap-${i}`);
      await mkdir(sub);
      assert.equal(
        (await registry.acquire(guard, buildFileResourceUri(sub), () => {}).ready).ok,
        true,
      );
    }
    const extra = join(dir, 'cap-extra');
    await mkdir(extra);
    assert.deepEqual(await registry.acquire(guard, buildFileResourceUri(extra), () => {}).ready, {
      ok: false,
      reason: 'capped',
    });
    assert.deepEqual(await registry.acquire(guard, aliased, (u) => seen.push(u)).ready, {
      ok: true,
    });
    assert.equal(registry.size(), MAX_WATCHERS);
    watchers[0]?.emit('error', new Error('EPERM'));
    assert.deepEqual(seen.sort(), [aliased, plain].sort());
    assert.equal(watchers[0]?.closed, true);
    assert.equal(registry.size(), MAX_WATCHERS - 1);
    registry.destroy();
  });

  it('cancelling a pending lease resolves ready before validation settles', async () => {
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const uri = buildFileResourceUri(filePath);
    const validation = Promise.withResolvers<string>();
    const guard = {
      validateExistingPath: () => validation.promise,
      isInsideAllowed: () => true,
    } as unknown as PathGuard;
    const lease = registry.acquire(guard, uri, () => {});
    lease.dispose();
    assert.deepEqual(await lease.ready, { ok: false, reason: 'cancelled' });
    validation.resolve(filePath);
    await setTimeout(0);
    assert.equal(watchers.length, 0);
    assert.equal(registry.size(), 0);
    lease.dispose();
  });

  it('owns independent same-URI leases and detaches callbacks per lease', async () => {
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const uri = buildFileResourceUri(filePath);
    const seen: string[] = [];
    const guard = fakeGuard(() => true);
    const first = registry.acquire(guard, uri, () => seen.push('first'));
    const second = registry.acquire(guard, uri, () => seen.push('second'));
    assert.deepEqual(await first.ready, { ok: true });
    assert.deepEqual(await second.ready, { ok: true });
    first.dispose();
    first.dispose();
    assert.equal(registry.size(), 1);
    watchers[0]?.fire(basename(filePath));
    await setTimeout(100);
    assert.deepEqual(seen, ['second']);
    second.dispose();
    assert.equal(registry.size(), 0);
    watchers[0]?.fire(basename(filePath));
    await setTimeout(100);
    assert.deepEqual(seen, ['second']);
  });

  it('a shared callback survives until its final lease ends', async () => {
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const uri = buildFileResourceUri(filePath);
    let calls = 0;
    const shared = (): void => {
      calls += 1;
    };
    const guard = fakeGuard(() => true);
    const one = registry.acquire(guard, uri, shared);
    const two = registry.acquire(guard, uri, shared);
    assert.deepEqual(await one.ready, { ok: true });
    assert.deepEqual(await two.ready, { ok: true });
    one.dispose();
    watchers[0]?.fire(basename(filePath));
    await setTimeout(100);
    assert.equal(calls, 1);
    two.dispose();
    watchers[0]?.fire(basename(filePath));
    await setTimeout(100);
    assert.equal(calls, 1);
  });

  it('destroying the registry cancels pending acquisition', async () => {
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const uri = buildFileResourceUri(filePath);
    const validation = Promise.withResolvers<string>();
    const guard = {
      validateExistingPath: () => validation.promise,
      isInsideAllowed: () => true,
    } as unknown as PathGuard;
    const lease = registry.acquire(guard, uri, () => {});
    registry.destroy();
    assert.deepEqual(await lease.ready, { ok: false, reason: 'cancelled' });
    validation.resolve(filePath);
    await setTimeout(0);
    assert.equal(watchers.length, 0);
    assert.equal(registry.size(), 0);
  });
});
