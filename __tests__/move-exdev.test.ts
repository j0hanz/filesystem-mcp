import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { crossDeviceStagingPath, GuardedFileSystem, type RawOps } from '../src/core/fs.ts';
import type { PathGuard } from '../src/core/path.ts';
import { cleanupTestRoot, createTestRoot, makeGuard, trySymlink, withEnv } from './helpers.ts';

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: fake`), { code });

/** The raw ops, except that the first rename fails as a cross-device one. */
function exdevOnce(extra: Pick<RawOps, 'rm'> = {}): RawOps {
  let first = true;
  return {
    rename: (a, b) => {
      if (first) {
        first = false;
        return Promise.reject(errno('EXDEV'));
      }
      return rename(a, b);
    },
    ...extra,
  };
}

describe('rename across devices (EXDEV)', () => {
  let root: string;
  let guard: PathGuard;
  let fs: GuardedFileSystem;

  beforeEach(async () => {
    root = await createTestRoot();
    guard = await makeGuard([root]);
    fs = new GuardedFileSystem(guard, undefined, exdevOnce());
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  /** Staging directories left behind: hidden `.tmp` entries anywhere under root. */
  const leftovers = async (): Promise<string[]> =>
    (await readdir(root, { recursive: true })).filter((name) => name.endsWith('.tmp'));

  it('a plain rename never copies', async () => {
    const calls: string[] = [];
    const plain = new GuardedFileSystem(guard, undefined, {
      rename: (a, b) => {
        calls.push('rename');
        return rename(a, b);
      },
      rm: () => {
        calls.push('rm');
        return Promise.reject(errno('EPERM'));
      },
    });
    const a = join(root, 'a.txt');
    await writeFile(a, 'x');
    await plain.rename(a, join(root, 'b.txt'));
    assert.deepStrictEqual(calls, ['rename']);
    assert.deepStrictEqual(await readdir(root), ['b.txt']);
  });

  it('a non-EXDEV rename error is rethrown untouched', async () => {
    const eacces = new GuardedFileSystem(guard, undefined, {
      rename: () => Promise.reject(errno('EACCES')),
    });
    const a = join(root, 'a.txt');
    await writeFile(a, 'x');
    await assert.rejects(
      eacces.rename(a, join(root, 'b.txt')),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'EACCES',
    );
    assert.deepStrictEqual(await readdir(root), ['a.txt']);
  });

  it('refuses to merge into an existing directory', async () => {
    const src = join(root, 'src');
    const dst = join(root, 'dst');
    await mkdir(src);
    await mkdir(dst);
    await writeFile(join(src, 'x.txt'), 'x');
    await writeFile(join(dst, 'y.txt'), 'y');
    await assert.rejects(fs.rename(src, dst));
    assert.deepStrictEqual(await readdir(dst), ['y.txt']);
    assert.deepStrictEqual(await readdir(src), ['x.txt']);
    assert.deepStrictEqual(await leftovers(), []);
  });

  it('replaces an existing file', async () => {
    const a = join(root, 'a.txt');
    const b = join(root, 'b.txt');
    await writeFile(a, 'new');
    await writeFile(b, 'old');
    await fs.rename(a, b);
    assert.strictEqual(await readFile(b, 'utf8'), 'new');
    assert.deepStrictEqual(await readdir(root), ['b.txt']);
  });

  it('moves a directory to a missing destination', async () => {
    const src = join(root, 'src');
    const dst = join(root, 'dst');
    await mkdir(src);
    await writeFile(join(src, 'x.txt'), 'x');
    await fs.rename(src, dst);
    assert.deepStrictEqual(await readdir(dst), ['x.txt']);
    assert.deepStrictEqual(await readdir(root), ['dst']);
  });

  it('a failed copy leaves no staging directory and keeps the source', async () => {
    const src = join(root, 'src');
    await mkdir(src);
    await writeFile(join(src, 'x.txt'), 'x');
    // The source vanishes between validation and the copy, so the copy fails.
    const vanishing = new GuardedFileSystem(guard, undefined, {
      rename: async () => {
        await rm(src, { recursive: true });
        throw errno('EXDEV');
      },
    });
    await assert.rejects(vanishing.rename(src, join(root, 'dst')));
    assert.deepStrictEqual(await readdir(root), []);
  });

  it('copy ok but remove failed says the destination holds a copy', async () => {
    const stuck = new GuardedFileSystem(
      guard,
      undefined,
      exdevOnce({ rm: () => Promise.reject(errno('EPERM')) }),
    );
    const a = join(root, 'a.txt');
    const b = join(root, 'b.txt');
    await writeFile(a, 'new');
    await assert.rejects(stuck.rename(a, b), (err: unknown) => {
      assert.ok(isFsError(err));
      assert.notStrictEqual(err.code, ErrorCode.CANCELLED);
      assert.match(
        err.message,
        /copy succeeded but source removal failed \(destination holds a copy\)/,
      );
      return true;
    });
    assert.strictEqual(await readFile(b, 'utf8'), 'new');
    assert.strictEqual(await readFile(a, 'utf8'), 'new');
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
    await fs.rename(link, dest);
    assert.ok((await lstat(dest)).isSymbolicLink());
    assert.deepStrictEqual(await readdir(join(root, 'a')), []);
    assert.deepStrictEqual(await readdir(join(root, 'b')), ['x']);
  });

  it('an operator deny on *.tmp does not block the move', async () => {
    await withEnv({ FS_DENYLIST: '*.tmp' }, async () => {
      const guarded = new GuardedFileSystem(await makeGuard([root]), undefined, exdevOnce());
      const a = join(root, 'a.txt');
      const b = join(root, 'b.txt');
      await writeFile(a, 'new');
      await guarded.rename(a, b);
      assert.strictEqual(await readFile(b, 'utf8'), 'new');
    });
  });

  it('a rooted allow entry for the destination lets the move through', async () => {
    const dest = join(root, '.env');
    // Rooted: it relieves this one path, not `<anything>/.env`.
    await withEnv({ FS_ALLOWLIST: dest }, async () => {
      const guarded = new GuardedFileSystem(await makeGuard([root]), undefined, exdevOnce());
      const a = join(root, 'a.txt');
      await writeFile(a, 'new');
      await guarded.rename(a, dest);
      assert.strictEqual(await readFile(dest, 'utf8'), 'new');
    });
  });

  it('a staged entry keeps the protection it has at the destination', async () => {
    const dest = join(root, 'dst', '.aws');
    const staged = crossDeviceStagingPath(dest);
    assert.strictEqual(basename(staged), '.aws');
    assert.strictEqual(dirname(dirname(staged)), dirname(dest));
    assert.ok(guard.isSensitive(join(dest, 'credentials')));
    assert.ok(guard.isSensitive(join(staged, 'credentials')));
  });
});
