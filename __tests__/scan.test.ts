import assert from 'node:assert/strict';
import type { Dir } from 'node:fs';
import fsPromises, { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { normalizePath, toPosixPath } from '../src/core/path-utils.ts';
import type { PathGuard } from '../src/core/path.ts';
import type { ScanEntry, ScanOptions, ScanScope } from '../src/core/scan.ts';
import {
  probeDirectory,
  readNamedText,
  readText,
  resolveScanScope,
  scan,
} from '../src/core/scan.ts';
import { MIB } from '../src/core/util.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  fsErrorMatcher,
  makeGuard,
  trySymlink,
  withEnv,
  writeTestFile,
} from './helpers.ts';

const skipUnlessPosix = (t: TestContext): boolean => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('needs POSIX directory permissions as non-root');
    return true;
  }
  return false;
};

describe('scan', () => {
  let root: string;
  let guard: PathGuard;

  beforeEach(async () => {
    root = await createTestRoot();
    guard = await makeGuard([root]);
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  const base = (overrides: Partial<ScanOptions<string>> = {}): ScanOptions<string> => ({
    pathGuard: guard,
    pattern: '**/*',
    baseNameMatch: false,
    includeHidden: true,
    includeIgnored: false,
    onlyFiles: true,
    concurrency: 4,
    ...overrides,
  });
  const byPath = async (entry: ScanEntry): Promise<string> => entry.path;
  const rel = (results: readonly string[]): string[] =>
    results.map((p) => toPosixPath(relative(root, p)));
  const files = async (...names: string[]): Promise<void> => {
    for (const name of names) await writeTestFile(root, name, 'x');
  };

  it('sensitive leaf is never counted', async () => {
    await files('a.txt', '.env');
    const out = await scan({ root }, base(), byPath);
    assert.deepEqual(rel(out.results), ['a.txt']);
    assert.equal(out.skippedInaccessible, 0);
  });

  it('unreadable directory is counted once', async (t) => {
    if (skipUnlessPosix(t)) return;
    await files('ok/a.txt', 'locked/b.txt');
    const locked = join(root, 'locked');
    await chmod(locked, 0o000);
    try {
      const out = await scan({ root }, base(), byPath);
      assert.deepEqual(rel(out.results), ['ok/a.txt']);
      assert.equal(out.skippedInaccessible, 1);
      assert.equal(out.stoppedReason, undefined);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('unreadable directory under a non-recursive pattern', async (t) => {
    if (skipUnlessPosix(t)) return;
    await files('a.txt', 'locked/b.txt');
    const locked = join(root, 'locked');
    await chmod(locked, 0o000);
    try {
      const out = await scan({ root }, base({ pattern: '*.txt' }), byPath);
      assert.deepEqual(rel(out.results), ['a.txt']);
      // Pinned as observed: fs.glob never hands `locked` to exclude for a
      // pattern that cannot descend, so it is not probed or counted.
      assert.equal(out.skippedInaccessible, 0);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('unreadable root counted', async (t) => {
    if (skipUnlessPosix(t)) return;
    await files('sub/a.txt');
    const sub = join(root, 'sub');
    await chmod(sub, 0o300);
    try {
      const out = await scan({ root: sub }, base(), byPath);
      assert.equal(out.skippedInaccessible, 1);
      assert.deepEqual(out.results, []);
    } finally {
      await chmod(sub, 0o755);
    }
  });

  it('out-of-root link is counted, not followed', async (t) => {
    const other = await createTestRoot();
    try {
      const target = await writeTestFile(other, 'secret.txt', 'x');
      const linked = await trySymlink(
        target,
        // Not `out`: that name is in the walk's default-ignored set.
        join(root, 'escape'),
        () => t.skip('symlink creation not permitted'),
        'file',
      );
      if (!linked) return;
      const out = await scan({ root }, base({ onlyFiles: false }), byPath);
      assert.equal(out.skippedInaccessible, 1);
      assert.ok(!rel(out.results).includes('escape'));
    } finally {
      await cleanupTestRoot(other);
    }
  });

  it('symlinked file is not yielded with onlyFiles', async (t) => {
    const target = await writeTestFile(root, 'a.txt', 'x');
    const linked = await trySymlink(
      target,
      join(root, 'l'),
      () => t.skip('symlink creation not permitted'),
      'file',
    );
    if (!linked) return;
    const out = await scan({ root }, base(), byPath);
    assert.deepEqual(rel(out.results), ['a.txt']);
    assert.equal(out.skippedInaccessible, 0);
  });

  it('onEntry error counts the entry', async () => {
    await files('a.txt', 'b.txt');
    const out = await scan({ root }, base(), async (entry) => {
      if (entry.path.endsWith('b.txt')) throw new Error('boom');
      return entry.path;
    });
    assert.deepEqual(rel(out.results), ['a.txt']);
    assert.equal(out.skippedInaccessible, 1);
  });

  it('an entry swapped for a sensitive link before onEntry fails is not counted', async (t) => {
    await files('a', '.env', 'b.txt');
    const a = join(root, 'a');
    let linked = true;
    const out = await scan({ root }, base(), async (entry) => {
      if (entry.path.endsWith(`${sep}a`)) {
        await fsPromises.rm(a);
        linked = await trySymlink(
          join(root, '.env'),
          a,
          () => t.skip('symlink creation not permitted'),
          'file',
        );
        throw new Error('refused');
      }
      return entry.path;
    });
    if (!linked) return;
    assert.deepEqual(rel(out.results), ['b.txt']);
    assert.equal(out.skippedInaccessible, 0);
  });

  it('odd verdict error counts the entry', async (t) => {
    await files('a.txt', 'b.txt', 'c.txt');
    const detailed = guard.validateExistingPathDetailed.bind(guard);
    t.mock.method(guard, 'validateExistingPathDetailed', async (path: string) => {
      if (path.endsWith('b.txt'))
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      return detailed(path);
    });
    const out = await scan({ root }, base(), byPath);
    assert.deepEqual(rel(out.results), ['a.txt', 'c.txt']);
    assert.equal(out.skippedInaccessible, 1);
  });

  it('no entry starts after a fatal error', async (t) => {
    await files('a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt');
    const verdict = guard.entryVerdict.bind(guard);
    let first = true;
    // Every entry but the first is admitted after the first one's onScanned threw.
    t.mock.method(guard, 'entryVerdict', async (path: string) => {
      if (first) first = false;
      else await sleep(30);
      return verdict(path);
    });
    const ran: string[] = [];
    const boom = new Error('boom');
    await assert.rejects(
      scan(
        { root },
        base({
          onScanned: () => {
            throw boom;
          },
        }),
        async (entry) => {
          ran.push(entry.path);
          return entry.path;
        },
      ),
      (error: unknown) => error === boom,
    );
    assert.equal(ran.length, 1);
  });

  it('results come back in walk order', async () => {
    await files(...Array.from({ length: 8 }, (_, i) => `f${i}.txt`));
    const slow = await scan({ root }, base(), async (entry) => {
      await sleep((8 - entry.index) * 5);
      return entry.path;
    });
    const fast = await scan({ root }, base(), byPath);
    assert.equal(fast.results.length, 8);
    assert.deepEqual(slow.results, fast.results);
  });

  it('onScanned counts each resolved entry', async () => {
    await files('a.txt', 'b.txt', 'c.txt');
    const calls: number[] = [];
    const out = await scan({ root }, base({ onScanned: (n) => calls.push(n) }), byPath);
    assert.deepEqual(calls, [1, 2, 3]);
    assert.equal(out.scanned, 3);
  });

  it('exact cap is not truncation', async () => {
    await files('a.txt', 'b.txt', 'c.txt');
    const exact = await scan({ root }, base({ cap: 3 }), byPath);
    assert.equal(exact.results.length, 3);
    assert.equal(exact.stoppedReason, undefined);
    await files('d.txt');
    const over = await scan({ root }, base({ cap: 3 }), byPath);
    assert.equal(over.stoppedReason, 'maxResults');
  });

  it('weight past the cap alone is not truncation', async () => {
    await files('a.txt');
    const out = await scan({ root }, base({ cap: 2, weigh: () => 3 }), byPath);
    assert.equal(out.stoppedReason, undefined);
  });

  it('skipped entries spend neither cap nor maxEntries', async () => {
    await files('.env', '.npmrc', 'a.txt', 'b.txt');
    const fits = await scan({ root }, base({ maxEntries: 2 }), byPath);
    assert.equal(fits.results.length, 2);
    assert.equal(fits.stoppedReason, undefined);
    await files('c.txt');
    const over = await scan({ root }, base({ maxEntries: 2 }), byPath);
    assert.equal(over.stoppedReason, 'maxFiles');
  });

  it('maxEntries admits the first entries in walk order', async (t) => {
    await files('a.txt', 'b.txt', 'c.txt', 'd.txt');
    const all = await scan({ root }, base(), byPath);
    const verdict = guard.entryVerdict.bind(guard);
    // The first entry's verdict finishes last, so admission cannot follow verdict order.
    t.mock.method(guard, 'entryVerdict', async (path: string) => {
      if (path === all.results[0]) await sleep(30);
      return verdict(path);
    });
    const out = await scan({ root }, base({ maxEntries: 2 }), byPath);
    assert.deepEqual(out.results, all.results.slice(0, 2));
    assert.equal(out.stoppedReason, 'maxFiles');
  });

  it('an entry that fails into inaccessible frees its maxEntries slot', async () => {
    await files('a.txt', 'b.txt');
    const all = await scan({ root }, base(), byPath);
    const [first, second] = all.results;
    const out = await scan({ root }, base({ maxEntries: 1 }), async (entry) => {
      if (entry.path === first) {
        await sleep(30);
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return entry.path;
    });
    assert.deepEqual(out.results, [second]);
    assert.equal(out.skippedInaccessible, 1);
    assert.equal(out.stoppedReason, undefined);
  });

  it('an early failure frees its slot for an entry refused before it ran', async (t) => {
    await files('a.txt', 'b.txt');
    const all = await scan({ root }, base(), byPath);
    const [first, second] = all.results;
    const verdict = guard.entryVerdict.bind(guard);
    // `b`'s verdict is done when `a` is admitted, so `b` asks for a slot before `a` runs.
    t.mock.method(guard, 'entryVerdict', async (path: string) => {
      if (path === first) await sleep(30);
      return verdict(path);
    });
    const out = await scan({ root }, base({ maxEntries: 1 }), async (entry) => {
      if (entry.path === first) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return entry.path;
    });
    assert.deepEqual(out.results, [second]);
    assert.equal(out.skippedInaccessible, 1);
    assert.equal(out.stoppedReason, undefined);
  });

  it('window holds admission until the prefix settles', async () => {
    await files(...Array.from({ length: 6 }, (_, i) => `f${i}.txt`));
    const gate = Promise.withResolvers<undefined>();
    const started: number[] = [];
    const running = scan({ root }, base({ window: 2 }), async (entry) => {
      started.push(entry.index);
      if (entry.index === 0) await gate.promise;
      return entry.path;
    });
    await sleep(30);
    assert.deepEqual(
      started.filter((i) => i >= 3),
      [],
    );
    gate.resolve(undefined);
    const out = await running;
    const all = await scan({ root }, base(), byPath);
    assert.equal(out.results.length, 6);
    assert.deepEqual(out.results, all.results);
  });

  it('window wait ends on abort', async () => {
    await files(...Array.from({ length: 6 }, (_, i) => `f${i}.txt`));
    const controller = new AbortController();
    const { signal } = controller;
    const started: number[] = [];
    const settled: number[] = [];
    const running = scan(
      { root },
      base({ window: 2, signal, onSettled: (i) => settled.push(i) }),
      async (entry) => {
        started.push(entry.index);
        if (entry.index !== 0) return entry.path;
        // Index 0 outlives the abort, so only the abort can wake the waiters.
        return new Promise<never>((_, reject) => {
          const fail = (): void => reject(signal.reason as Error);
          signal.addEventListener('abort', () => setTimeout(fail, 50), { once: true });
        });
      },
    );
    await sleep(30);
    controller.abort();
    const out = await running;
    assert.equal(out.stoppedReason, 'timeout');
    assert.deepEqual(
      started.filter((i) => i >= 3),
      [],
    );
    assert.ok(settled.indexOf(3) < settled.indexOf(0), `settle order ${settled.join(',')}`);
  });

  it('abort beats cap', async () => {
    await files('a.txt', 'b.txt', 'c.txt');
    const controller = new AbortController();
    const out = await scan(
      { root },
      base({ cap: 1, concurrency: 1, signal: controller.signal }),
      async (entry) => {
        controller.abort();
        return entry.path;
      },
    );
    assert.equal(out.stoppedReason, 'timeout');
  });

  it('abort mid-entry', async () => {
    await files('a.txt', 'b.txt');
    const controller = new AbortController();
    const { signal } = controller;
    const out = await scan({ root }, base({ signal }), async () => {
      const aborted = new Promise<never>((_, reject) => {
        const fail = (): void => reject(signal.reason as Error);
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
      controller.abort();
      return aborted;
    });
    assert.equal(out.stoppedReason, 'timeout');
    assert.equal(out.skippedInaccessible, 0);
  });

  it('abort after the last entry finished is not a timeout', async () => {
    await files('a.txt', 'b.txt', 'c.txt');
    const controller = new AbortController();
    const signal = controller.signal;
    const out = await scan({ root }, base({ signal }), async (entry) => {
      if (entry.index === 2) {
        // Long enough for the walk to finish first.
        await sleep(30);
        controller.abort();
      }
      return entry.path;
    });
    assert.equal(out.results.length, 3);
    assert.equal(out.stoppedReason, undefined);
    const late = new AbortController();
    const named = await scan(
      { root, explicitFile: join(root, 'a.txt') },
      base({ signal: late.signal }),
      async (entry) => {
        late.abort();
        return entry.path;
      },
    );
    assert.equal(named.stoppedReason, undefined);
  });

  it('pre-aborted signal resolves as timeout', async () => {
    await files('a.txt');
    const out = await scan({ root }, base({ signal: AbortSignal.abort() }), byPath);
    assert.deepEqual(out.results, []);
    assert.equal(out.stoppedReason, 'timeout');
  });

  it('pre-aborted scan probes nothing', async () => {
    const out = await scan(
      { root: join(root, 'gone') },
      base({ signal: AbortSignal.abort() }),
      byPath,
    );
    assert.equal(out.stoppedReason, 'timeout');
    assert.equal(out.skippedInaccessible, 0);
  });

  it('a stalled probe ends at the deadline', { timeout: 5000 }, async (t) => {
    await files('a.txt', 'sub/b.txt');
    // A hung mount: the directory open never settles, so only the signal can end the probe.
    t.mock.method(fsPromises, 'opendir', () => new Promise<Dir>(() => {}));
    syncBuiltinESMExports();
    try {
      const out = await scan({ root }, base({ signal: AbortSignal.timeout(200) }), byPath);
      assert.equal(out.stoppedReason, 'timeout');
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it('a probe that fails with any other error is counted', async (t) => {
    await files('a.txt', 'busy/b.txt');
    const realOpendir = fsPromises.opendir;
    t.mock.method(fsPromises, 'opendir', (path: string) =>
      path.endsWith('busy')
        ? Promise.reject(Object.assign(new Error('resource busy'), { code: 'EBUSY' }))
        : realOpendir(path),
    );
    syncBuiltinESMExports();
    try {
      const out = await scan({ root }, base(), byPath);
      assert.equal(out.skippedInaccessible, 1);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it('a directory that fails its probe and its verdict is counted once', async (t) => {
    await files('a.txt', 'd/b.txt');
    const busy = (): Error => Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    const isD = (path: string): boolean => path.endsWith(`${sep}d`);
    const realOpendir = fsPromises.opendir;
    t.mock.method(fsPromises, 'opendir', (path: string) =>
      isD(path) ? Promise.reject(busy()) : realOpendir(path),
    );
    syncBuiltinESMExports();
    const detailed = guard.validateExistingPathDetailed.bind(guard);
    t.mock.method(guard, 'validateExistingPathDetailed', async (path: string) => {
      if (isD(path)) throw busy();
      return detailed(path);
    });
    try {
      const out = await scan({ root }, base({ onlyFiles: false }), byPath);
      assert.ok(!rel(out.results).includes('d'));
      assert.equal(out.skippedInaccessible, 1);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it('named file errors fail the call', async () => {
    await files('a.txt', '.env');
    await assert.rejects(
      scan({ root, explicitFile: join(root, '.env') }, base(), byPath),
      (error: unknown) => isFsError(error) && error.code === ErrorCode.ACCESS_DENIED,
    );
    const boom = new Error('boom');
    await assert.rejects(
      scan({ root, explicitFile: join(root, 'a.txt') }, base(), () => Promise.reject(boom)),
      (error: unknown) => error === boom,
    );
  });

  it('named file abort resolves as timeout', async () => {
    await files('a.txt');
    const controller = new AbortController();
    const scope: ScanScope = { root, explicitFile: join(root, 'a.txt') };
    const out = await scan(scope, base({ signal: controller.signal }), () => {
      controller.abort();
      return Promise.reject(controller.signal.reason as Error);
    });
    assert.deepEqual(out.results, []);
    assert.equal(out.stoppedReason, 'timeout');
  });

  it('a failed probe of a sensitive directory is not counted', async (t) => {
    const missing = join(root, 'gone');
    assert.equal(await probeDirectory(missing, guard), true);
    t.mock.method(guard, 'isSensitive', (path: string) => path === missing);
    assert.equal(await probeDirectory(missing, guard), false);
  });

  it('a failed probe through a link to a sensitive directory is not counted', async (t) => {
    if (skipUnlessPosix(t)) return;
    await files('locked/b.txt');
    const locked = join(root, 'locked');
    const link = join(root, 'link');
    if (!(await trySymlink(locked, link, () => t.skip('symlink creation not permitted')))) {
      return;
    }
    const real = await realpath(locked);
    await chmod(locked, 0o000);
    try {
      assert.equal(await probeDirectory(link, guard), true);
      t.mock.method(guard, 'isSensitive', (path: string) => path === real);
      assert.equal(await probeDirectory(link, guard), false);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('resolveScanScope', async () => {
    await writeTestFile(root, 'dir/a.txt', 'x');
    await mkdir(join(root, 'empty'));
    const fs = new GuardedFileSystem(guard);
    // The guard's spelling of each path (Windows lowercases the drive letter).
    const file = await guard.validateExistingPath(join(root, 'dir/a.txt'));
    const empty = await guard.validateExistingPath(join(root, 'empty'));
    await assert.rejects(
      resolveScanScope(file, fs, { allowFile: false }),
      (error: unknown) => isFsError(error) && error.code === ErrorCode.NOT_DIRECTORY,
    );
    assert.deepEqual(await resolveScanScope(file, fs, { allowFile: true }), {
      root: dirname(file),
      explicitFile: file,
    });
    assert.deepEqual(await resolveScanScope(empty, fs, { allowFile: false }), { root: empty });
  });
});

describe('readText', () => {
  let root: string;
  let fs: GuardedFileSystem;

  beforeEach(async () => {
    root = await createTestRoot();
    fs = new GuardedFileSystem(await makeGuard([root]));
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  const put = async (name: string, bytes: Buffer | string): Promise<string> => {
    const path = join(root, name);
    await writeFile(path, bytes);
    return path;
  };
  const pastProbe = (tail: number[]): Buffer =>
    Buffer.concat([Buffer.alloc(600, 'a'), Buffer.from(tail)]);

  it('readText text verdict carries bytes and stats', async () => {
    const path = await put('a.txt', 'héllo\n');
    const verdict = await readText(fs, path);
    assert.equal(verdict.kind, 'text');
    if (verdict.kind !== 'text') return;
    assert.deepEqual(verdict.bytes, Buffer.from('héllo\n'));
    assert.equal(verdict.stats.size, 7);
  });

  it('readText binary by extension', async () => {
    assert.deepEqual(await readText(fs, await put('a.png', 'plain text')), {
      kind: 'binary',
      utf16: false,
    });
  });

  it('readText binary by sample', async () => {
    const path = await put('b.txt', Buffer.from([0x61, 0x62, 0x63, 0, 0x64]));
    assert.deepEqual(await readText(fs, path), { kind: 'binary', utf16: false });
  });

  it('readText UTF-16 BOM', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]);
    assert.deepEqual(await readText(fs, await put('c.txt', bytes)), {
      kind: 'binary',
      utf16: true,
    });
  });

  it('readText undecodable past the probe', async () => {
    const latin1 = await readText(fs, await put('d.txt', pastProbe([0xe9])));
    assert.equal(latin1.kind, 'undecodable');
    const nul = await readText(fs, await put('e.txt', pastProbe([0])));
    assert.equal(nul.kind, 'undecodable');
  });

  it('readText too large', async () => {
    const path = await put('big.txt', Buffer.alloc(MIB + 1, 'a'));
    await withEnv({ FS_MAX_FILE_SIZE: String(MIB) }, async () => {
      assert.deepEqual(await readText(fs, path), { kind: 'tooLarge', size: MIB + 1 });
    });
  });

  it('readText bounds the read of a file that reports size 0', async (t) => {
    // procfs and some FUSE files report size 0 and stream on.
    const open = fs.open.bind(fs);
    t.mock.method(fs, 'open', async (...args: Parameters<GuardedFileSystem['open']>) => {
      const handle = await open(...args);
      const real = await handle.stat();
      t.mock.method(handle, 'stat', () => Promise.resolve(Object.assign(real, { size: 0 })));
      return handle;
    });
    const small = await readText(fs, await put('virtual.txt', 'text\n'));
    assert.equal(small.kind, 'text');
    const path = await put('stream.txt', Buffer.alloc(4 * MIB, 'a'));
    await withEnv({ FS_MAX_FILE_SIZE: String(MIB) }, async () => {
      const verdict = await readText(fs, path);
      assert.equal(verdict.kind, 'tooLarge');
      if (verdict.kind !== 'tooLarge') return;
      assert.ok(verdict.size > MIB && verdict.size < 2 * MIB, String(verdict.size));
    });
  });

  for (const [stalls, reportedSize] of [
    ['stat', undefined],
    ['read', undefined],
    ['read', 0],
  ] as const) {
    it(
      `readText abandons a stalled ${stalls}${reportedSize === 0 ? ' of a size-0 file' : ''}`,
      {
        timeout: 2000,
      },
      async (t) => {
        // A hung mount or FIFO: the call never returns until the test settles it.
        let settle!: () => void;
        const stalled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        let closed = false;
        const open = fs.open.bind(fs);
        t.mock.method(fs, 'open', async (...args: Parameters<GuardedFileSystem['open']>) => {
          const handle = await open(...args);
          const real = await handle.stat();
          t.mock.method(handle, 'stat', () =>
            stalls === 'stat'
              ? stalled.then(() => real)
              : Promise.resolve(Object.assign(real, { size: reportedSize ?? real.size })),
          );
          if (stalls === 'read') {
            t.mock.method(handle, 'read', () =>
              stalled.then(() => ({ bytesRead: 0, buffer: Buffer.alloc(0) })),
            );
          }
          const close = handle.close.bind(handle);
          t.mock.method(handle, 'close', async () => {
            closed = true;
            await close();
          });
          return handle;
        });
        const controller = new AbortController();
        const pending = readText(fs, await put('stall.txt', 'text'), controller.signal);
        setTimeout(() => controller.abort(), 10);
        await assert.rejects(pending, { name: 'AbortError' });
        // close() would queue behind the call in flight, so it waits for that call to settle.
        assert.equal(closed, false);
        settle();
        await sleep(10);
        assert.equal(closed, true);
      },
    );
  }

  it('readText reads a file that grew after the fstat to EOF', async (t) => {
    // Another process appends between fstat and read; a Rewrite must not drop the tail.
    const open = fs.open.bind(fs);
    t.mock.method(fs, 'open', async (...args: Parameters<GuardedFileSystem['open']>) => {
      const handle = await open(...args);
      const real = await handle.stat();
      t.mock.method(handle, 'stat', () => Promise.resolve(Object.assign(real, { size: 5 })));
      return handle;
    });
    const verdict = await readText(fs, await put('grows.txt', 'head\ntail\n'));
    assert.equal(verdict.kind, 'text');
    if (verdict.kind !== 'text') return;
    assert.equal(verdict.bytes.toString('utf8'), 'head\ntail\n');
    const path = await put('grows-big.txt', Buffer.alloc(2 * MIB, 'a'));
    await withEnv({ FS_MAX_FILE_SIZE: String(MIB) }, async () => {
      assert.equal((await readText(fs, path)).kind, 'tooLarge');
    });
  });

  it('readText pre-aborted signal rejects', async () => {
    const path = await put('f.txt', 'text');
    await assert.rejects(readText(fs, path, AbortSignal.abort()));
  });
});

describe('readNamedText', () => {
  let tmpDir: string;
  let fs: GuardedFileSystem;

  beforeEach(async () => {
    tmpDir = await createTestRoot();
    fs = new GuardedFileSystem(await makeGuard([tmpDir]));
  });

  afterEach(async () => {
    await cleanupTestRoot(tmpDir);
  });

  it('readNamedText returns validated path, content, and stats', async () => {
    const filePath = await writeTestFile(tmpDir, 'editable.txt', 'editable content');

    const result = await readNamedText(fs, filePath);

    assert.strictEqual(result.validPath, normalizePath(filePath));
    assert.strictEqual(result.content, 'editable content');
    assert.strictEqual(result.stats.size, Buffer.byteLength('editable content'));
  });

  it('readNamedText rejects files above the configured text limit', async () => {
    const limit = 1024 * 1024;
    await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
      const filePath = join(tmpDir, 'too-large.txt');
      await writeFile(filePath, Buffer.alloc(limit + 1, 0x61));

      await assert.rejects(
        readNamedText(fs, filePath),
        fsErrorMatcher(ErrorCode.TOO_LARGE, 'File too large for edit'),
      );
    });
  });

  it('readNamedText rejects binary files', async () => {
    const filePath = join(tmpDir, 'editable.png');
    await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    await assert.rejects(
      readNamedText(fs, filePath),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /^Binary file detected\.$/),
    );
  });

  // Issue #11: the 512-byte binary probe must not reject a multi-byte
  // character cut by the sample boundary.
  it('readNamedText accepts UTF-8 split at the sample boundary', async () => {
    for (const [name, text] of [
      ['split-cjk.md', '我'.repeat(171)],
      ['split-emoji.txt', `${'a'.repeat(510)}${'😀'.repeat(4)}`],
      ['split-latin.txt', `${'a'.repeat(511)}${'é'.repeat(4)}`],
    ] as const) {
      const filePath = join(tmpDir, name);
      await writeFile(filePath, text);
      assert.strictEqual((await readNamedText(fs, filePath)).content, text, name);
    }
  });

  it('readNamedText rejects non-UTF-8 bytes past the binary probe', async () => {
    const filePath = join(tmpDir, 'latin1-late.txt');
    await writeFile(
      filePath,
      Buffer.concat([
        Buffer.alloc(600, 0x61),
        Buffer.from('\ncaf'),
        Buffer.from([0xe9]),
        Buffer.from('\n'),
      ]),
    );
    await assert.rejects(
      readNamedText(fs, filePath),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /^Binary or non-UTF-8 file detected\.$/),
    );

    const utf16 = join(tmpDir, 'utf16le.txt');
    await writeFile(
      utf16,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello\n', 'utf16le')]),
    );
    // UTF-16 is named at the shared probe, for edit as for read.
    await assert.rejects(
      readNamedText(fs, utf16),
      fsErrorMatcher(
        ErrorCode.INVALID_INPUT,
        /^UTF-16 text file detected; convert it to UTF-8 first\.$/,
      ),
    );
  });
});
