import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { performRenameWithFallback } from '../src/tools/move.ts';
import { cleanupTestRoot, createTestRoot, makeGuard } from './helpers.ts';

type FsOps = Pick<GuardedFileSystem, 'rename' | 'cp' | 'rm'>;
type Behavior = (...args: string[]) => Promise<void>;

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: fake`), { code });

const TMP = /^\/dst\.[0-9a-f]{12}\.tmp$/;

function fakeOps(behavior: { rename?: Behavior; cp?: Behavior; rm?: Behavior }): {
  ops: FsOps;
  calls: string[];
} {
  const calls: string[] = [];
  const op =
    (name: 'rename' | 'cp' | 'rm') =>
    async (...args: unknown[]): Promise<void> => {
      // Paths only: the options object of cp/rm is not part of the record.
      const paths = args.filter((a): a is string => typeof a === 'string');
      calls.push(`${name} ${paths.join(' ')}`);
      await (behavior[name] ?? (() => Promise.resolve()))(...paths);
    };
  const ops = { rename: op('rename'), cp: op('cp'), rm: op('rm') } as unknown as FsOps;
  return { ops, calls };
}

/** The temp path the copy went to: cp's second argument. */
const tmpOf = (calls: readonly string[]): string =>
  calls.find((c) => c.startsWith('cp '))?.split(' ')[2] ?? '';

const exdevForSource: Behavior = (from) =>
  from === '/src' ? Promise.reject(errno('EXDEV')) : Promise.resolve();

describe('performRenameWithFallback (EXDEV)', () => {
  it('a plain rename never copies', async () => {
    const { ops, calls } = fakeOps({});
    await performRenameWithFallback('/src', '/dst', ops, 'src');
    assert.deepStrictEqual(calls, ['rename /src /dst']);
  });

  it('EXDEV copies to a temp sibling, renames it into place, then removes the source', async () => {
    const { ops, calls } = fakeOps({ rename: exdevForSource });
    await performRenameWithFallback('/src', '/dst', ops, 'src');
    const tmp = tmpOf(calls);
    assert.match(tmp, TMP);
    assert.deepStrictEqual(calls, [
      'rename /src /dst',
      `cp /src ${tmp}`,
      `rename ${tmp} /dst`,
      'rm /src',
    ]);
  });

  it('a non-EXDEV rename error is rethrown untouched', async () => {
    const { ops, calls } = fakeOps({ rename: () => Promise.reject(errno('EACCES')) });
    await assert.rejects(
      performRenameWithFallback('/src', '/dst', ops, 'src'),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'EACCES',
    );
    assert.deepStrictEqual(calls, ['rename /src /dst']);
  });

  it('a refused final rename removes the temp copy and keeps the source', async () => {
    const { ops, calls } = fakeOps({
      rename: (from) => Promise.reject(errno(from === '/src' ? 'EXDEV' : 'ENOTEMPTY')),
    });
    await assert.rejects(
      performRenameWithFallback('/src', '/dst', ops, 'src'),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOTEMPTY',
    );
    const tmp = tmpOf(calls);
    assert.deepStrictEqual(calls, [
      'rename /src /dst',
      `cp /src ${tmp}`,
      `rename ${tmp} /dst`,
      `rm ${tmp}`,
    ]);
  });

  it('a failed copy removes the temp copy and keeps the source', async () => {
    const { ops, calls } = fakeOps({
      rename: exdevForSource,
      cp: () => Promise.reject(errno('ENOSPC')),
    });
    await assert.rejects(
      performRenameWithFallback('/src', '/dst', ops, 'src'),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOSPC',
    );
    const tmp = tmpOf(calls);
    assert.deepStrictEqual(calls, ['rename /src /dst', `cp /src ${tmp}`, `rm ${tmp}`]);
  });

  it('a failed temp cleanup keeps the original error', async () => {
    const { ops } = fakeOps({
      rename: exdevForSource,
      cp: () => Promise.reject(errno('ENOSPC')),
      rm: () => Promise.reject(errno('EPERM')),
    });
    await assert.rejects(
      performRenameWithFallback('/src', '/dst', ops, 'src'),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOSPC',
    );
  });

  it('copy ok but remove failed says the destination holds a copy', async () => {
    const { ops } = fakeOps({
      rename: exdevForSource,
      rm: (path) => (path === '/src' ? Promise.reject(errno('EPERM')) : Promise.resolve()),
    });
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
  const exdevOnce = (): FsOps => {
    let first = true;
    return {
      rename: (a: string, b: string) => {
        if (first) {
          first = false;
          return Promise.reject(errno('EXDEV'));
        }
        return fs.rename(a, b);
      },
      cp: fs.cp.bind(fs),
      rm: fs.rm.bind(fs),
    };
  };

  const tmpEntries = async (): Promise<string[]> =>
    (await readdir(root)).filter((name) => name.endsWith('.tmp'));

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
    assert.deepStrictEqual(await tmpEntries(), []);
  });

  it('replaces an existing file', async () => {
    const a = join(root, 'a.txt');
    const b = join(root, 'b.txt');
    await writeFile(a, 'new');
    await writeFile(b, 'old');
    await performRenameWithFallback(a, b, exdevOnce(), 'a.txt');
    assert.strictEqual(await readFile(b, 'utf8'), 'new');
    assert.deepStrictEqual((await readdir(root)).sort(), ['b.txt']);
  });

  it('moves a directory to a missing destination', async () => {
    const src = join(root, 'src');
    const dst = join(root, 'dst');
    await mkdir(src);
    await writeFile(join(src, 'x.txt'), 'x');
    await performRenameWithFallback(src, dst, exdevOnce(), 'src');
    assert.deepStrictEqual(await readdir(dst), ['x.txt']);
    assert.deepStrictEqual((await readdir(root)).sort(), ['dst']);
  });
});
