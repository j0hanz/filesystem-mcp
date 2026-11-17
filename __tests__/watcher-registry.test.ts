import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { buildFileResourceUri } from '../src/core/file-uri.ts';
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
      ),
      { ok: true },
    );
    assert.deepEqual(
      await registry.acquire(
        fakeGuard(() => true),
        uri,
        (u) => seen.push(u),
      ),
      { ok: true },
    );
    watchers[0]?.emit('error', new Error('EPERM'));
    assert.deepEqual(seen, [uri]); // synchronous, not debounced
    assert.equal(registry.size(), 0);
    assert.equal(registry.hasWatcher(uri), false);
  });

  it('a change under a revoked root notifies nobody and frees the watcher', async () => {
    const uri = buildFileResourceUri(filePath);
    let allowed = true;
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const seen: string[] = [];
    await registry.acquire(
      fakeGuard(() => allowed),
      uri,
      (u) => seen.push(u),
    );
    allowed = false;
    watchers[0]?.fire(basename(filePath));
    await setTimeout(100);
    assert.deepEqual(seen, []);
    assert.equal(registry.size(), 0);
  });

  it('re-subscribing after the root is re-granted attaches a new watcher', async () => {
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
    );
    allowed = false;
    watchers[0]?.fire(basename(filePath));
    await setTimeout(100);
    allowed = true;
    registry.release(uri);
    assert.deepEqual(
      await registry.acquire(
        fakeGuard(() => allowed),
        uri,
        notify,
      ),
      { ok: true },
    );
    assert.equal(registry.size(), 1);
    watchers[1]?.fire(basename(filePath));
    await setTimeout(100);
    assert.deepEqual(seen, [uri]);
  });

  it('two URIs for one file share a watcher and each hears its own URI', async () => {
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const plain = buildFileResourceUri(filePath);
    const aliased = plain.replace(/a\.txt$/, '%61.txt'); // test file named a.txt
    const seen: string[] = [];
    await registry.acquire(
      fakeGuard(() => true),
      plain,
      (u) => seen.push(u),
    );
    await registry.acquire(
      fakeGuard(() => true),
      aliased,
      (u) => seen.push(u),
    );
    assert.equal(watchers.length, 1);
    assert.equal(registry.size(), 1);
    watchers[0]?.fire('a.txt');
    await setTimeout(100);
    assert.deepEqual(seen.sort(), [aliased, plain].sort());
    registry.release(plain);
    assert.equal(registry.size(), 1);
    seen.length = 0;
    watchers[0]?.fire('a.txt');
    await setTimeout(100);
    assert.deepEqual(seen, [aliased]);
    registry.release(aliased);
    assert.equal(registry.size(), 0);
  });

  it('at cap an alias still joins its watcher, and an error reaches every alias', async () => {
    const { watch, watchers } = fakeWatch();
    const registry = createWatcherRegistry({ watch });
    const guard = fakeGuard(() => true);
    const plain = buildFileResourceUri(filePath);
    const aliased = plain.replace(/a\.txt$/, '%61.txt');
    const seen: string[] = [];
    await registry.acquire(guard, plain, (u) => seen.push(u));
    for (let i = 1; i < MAX_WATCHERS; i++) {
      const sub = join(dir, `cap-${i}`);
      await mkdir(sub);
      assert.equal((await registry.acquire(guard, buildFileResourceUri(sub), () => {})).ok, true);
    }
    const extra = join(dir, 'cap-extra');
    await mkdir(extra);
    assert.deepEqual(await registry.acquire(guard, buildFileResourceUri(extra), () => {}), {
      ok: false,
      reason: 'capped',
    });
    assert.deepEqual(await registry.acquire(guard, aliased, (u) => seen.push(u)), { ok: true });
    assert.equal(registry.size(), MAX_WATCHERS);
    watchers[0]?.emit('error', new Error('EPERM'));
    assert.deepEqual(seen.sort(), [aliased, plain].sort());
    assert.equal(watchers[0]?.closed, true);
    assert.equal(registry.size(), MAX_WATCHERS - 1);
    registry.destroy();
  });
});
