import assert from 'node:assert/strict';
import type { Dir } from 'node:fs';
import fsPromises, { chmod, mkdir, realpath } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { toPosixPath } from '../src/core/path-utils.ts';
import type { PathGuard } from '../src/core/path.ts';
import type { ScanEntry, ScanOptions, ScanScope } from '../src/core/scan.ts';
import { probeDirectory, resolveScanScope, scan } from '../src/core/scan.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  makeGuard,
  trySymlink,
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
