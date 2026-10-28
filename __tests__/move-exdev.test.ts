import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { crossDeviceStagingPath, GuardedFileSystem } from '../src/core/fs.ts';
import { performRenameWithFallback } from '../src/tools/move.ts';
import { cleanupTestRoot, createTestRoot, makeGuard, trySymlink, withEnv } from './helpers.ts';

type FsOps = Pick<GuardedFileSystem, 'rename' | 'copyIntoPlace' | 'rm'>;
type Behavior = (...args: string[]) => Promise<void>;

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: fake`), { code });

function fakeOps(behavior: { rename?: Behavior; copyIntoPlace?: Behavior; rm?: Behavior }): {
  ops: FsOps;
  calls: string[];
} {
  const calls: string[] = [];
  const op =
    (name: 'rename' | 'copyIntoPlace' | 'rm') =>
    async (...args: unknown[]): Promise<void> => {
      // Paths only: the options object of rm is not part of the record.
      const paths = args.filter((a): a is string => typeof a === 'string');
      calls.push(`${name} ${paths.join(' ')}`);
      await (behavior[name] ?? (() => Promise.resolve()))(...paths);
    };
  const ops = {
    rename: op('rename'),
    copyIntoPlace: op('copyIntoPlace'),
    rm: op('rm'),
  } as unknown as FsOps;
  return { ops, calls };
}

const exdev: Behavior = () => Promise.reject(errno('EXDEV'));

describe('performRenameWithFallback (EXDEV)', () => {
  it('a plain rename never copies', async () => {
    const { ops, calls } = fakeOps({});
    await performRenameWithFallback('/src', '/dst', ops, 'src');
    assert.deepStrictEqual(calls, ['rename /src /dst']);
  });

  it('EXDEV copies into place, then removes the source', async () => {
    const { ops, calls } = fakeOps({ rename: exdev });
    await performRenameWithFallback('/src', '/dst', ops, 'src');
    assert.deepStrictEqual(calls, ['rename /src /dst', 'copyIntoPlace /src /dst', 'rm /src']);
  });

  it('a non-EXDEV rename error is rethrown untouched', async () => {
    const { ops, calls } = fakeOps({ rename: () => Promise.reject(errno('EACCES')) });
    await assert.rejects(
      performRenameWithFallback('/src', '/dst', ops, 'src'),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'EACCES',
    );
    assert.deepStrictEqual(calls, ['rename /src /dst']);
  });

  it('a failed copy rethrows its error and never removes the source', async () => {
    const { ops, calls } = fakeOps({
      rename: exdev,
      copyIntoPlace: () => Promise.reject(errno('ENOTEMPTY')),
    });
    await assert.rejects(
      performRenameWithFallback('/src', '/dst', ops, 'src'),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOTEMPTY',
    );
    assert.deepStrictEqual(calls, ['rename /src /dst', 'copyIntoPlace /src /dst']);
  });

  it('copy ok but remove failed says the destination holds a copy', async () => {
    const { ops } = fakeOps({ rename: exdev, rm: () => Promise.reject(errno('EPERM')) });
    await assert.rejects(performRenameWithFallback('/src', '/dst', ops, 'src'), (err: unknown) => {
      assert.ok(isFsError(err));
      assert.notStrictEqual(err.code, ErrorCode.CANCELLED);
      assert.match(
        err.message,
        /copy succeeded but source removal failed \(destination holds a copy\)/,
      );
      return true;
    });
  });
});

describe('performRenameWithFallback on disk', () => {
  let root: string;
  let fs: GuardedFileSystem;

  beforeEach(async () => {
    root = await createTestRoot();
    fs = new GuardedFileSystem(await makeGuard([root]));
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  /** The real filesystem, except that the first rename fails as a cross-device one. */
  const exdevOnce = (guarded: GuardedFileSystem = fs): FsOps => {
    let first = true;
    return {
      rename: (a: string, b: string) => {
        if (first) {
          first = false;
          return Promise.reject(errno('EXDEV'));
        }
        return guarded.rename(a, b);
      },
      copyIntoPlace: guarded.copyIntoPlace.bind(guarded),
      rm: guarded.rm.bind(guarded),
    };
  };

  /** Staging directories left behind: hidden `.tmp` entries anywhere under root. */
  const leftovers = async (): Promise<string[]> =>
    (await readdir(root, { recursive: true })).filter((name) => name.endsWith('.tmp'));

  it('refuses to merge into an existing directory', async () => {
    const src = join(root, 'src');
    const dst = join(root, 'dst');
    await mkdir(src);
    await mkdir(dst);
    await writeFile(join(src, 'x.txt'), 'x');
    await writeFile(join(dst, 'y.txt'), 'y');
    await assert.rejects(performRenameWithFallback(src, dst, exdevOnce(), 'src'));
    assert.deepStrictEqual(await readdir(dst), ['y.txt']);
    assert.deepStrictEqual(await readdir(src), ['x.txt']);
    assert.deepStrictEqual(await leftovers(), []);
  });

  it('replaces an existing file', async () => {
    const a = join(root, 'a.txt');
    const b = join(root, 'b.txt');
    await writeFile(a, 'new');
    await writeFile(b, 'old');
    await performRenameWithFallback(a, b, exdevOnce(), 'a.txt');
    assert.strictEqual(await readFile(b, 'utf8'), 'new');
    assert.deepStrictEqual(await readdir(root), ['b.txt']);
  });

  it('moves a directory to a missing destination', async () => {
    const src = join(root, 'src');
    const dst = join(root, 'dst');
    await mkdir(src);
    await writeFile(join(src, 'x.txt'), 'x');
    await performRenameWithFallback(src, dst, exdevOnce(), 'src');
    assert.deepStrictEqual(await readdir(dst), ['x.txt']);
    assert.deepStrictEqual(await readdir(root), ['dst']);
  });

  it('a failed copy leaves no staging directory', async () => {
    await assert.rejects(fs.copyIntoPlace(join(root, 'missing'), join(root, 'dst')));
    assert.deepStrictEqual(await readdir(root), []);
  });

  it('moves a relative link whose target names the destination', async (t) => {
    // a/link -> 'x' resolves to b/x once it sits in b/: the staging rename must
    // still replace b/x, not read as a move of b/x onto itself.
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    const dest = join(root, 'b', 'x');
    await writeFile(dest, 'old');
    const link = join(root, 'a', 'link');
    if (!(await trySymlink('x', link, () => t.skip('symlinks need privileges'), 'file'))) return;
    await performRenameWithFallback(link, dest, exdevOnce(), 'a/link');
    assert.ok((await lstat(dest)).isSymbolicLink());
    assert.deepStrictEqual(await readdir(join(root, 'a')), []);
    assert.deepStrictEqual(await readdir(join(root, 'b')), ['x']);
  });

  it('an operator deny on *.tmp does not block the move', async () => {
    await withEnv({ FS_DENYLIST: '*.tmp' }, async () => {
      const guarded = new GuardedFileSystem(await makeGuard([root]));
      const a = join(root, 'a.txt');
      const b = join(root, 'b.txt');
      await writeFile(a, 'new');
      await performRenameWithFallback(a, b, exdevOnce(guarded), 'a.txt');
      assert.strictEqual(await readFile(b, 'utf8'), 'new');
    });
  });

  it('a rooted allow entry for the destination lets the move through', async () => {
    const dest = join(root, '.env');
    // Rooted: it relieves this one path, not `<anything>/.env`.
    await withEnv({ FS_ALLOWLIST: dest }, async () => {
      const guarded = new GuardedFileSystem(await makeGuard([root]));
      const a = join(root, 'a.txt');
      await writeFile(a, 'new');
      await performRenameWithFallback(a, dest, exdevOnce(guarded), 'a.txt');
      assert.strictEqual(await readFile(dest, 'utf8'), 'new');
    });
  });

  it('a staged entry keeps the protection it has at the destination', async () => {
    const guard = await makeGuard([root]);
    const dest = join(root, 'dst', '.aws');
    const staged = crossDeviceStagingPath(dest);
    assert.strictEqual(basename(staged), '.aws');
    assert.strictEqual(dirname(dirname(staged)), dirname(dest));
    assert.ok(guard.isSensitive(join(dest, 'credentials')));
    assert.ok(guard.isSensitive(join(staged, 'credentials')));
  });
});
