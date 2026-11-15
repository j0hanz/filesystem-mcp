import assert from 'node:assert/strict';
import { renameSync, symlinkSync } from 'node:fs';
import fsPromises, {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { isSamePath } from '../src/core/path-utils.ts';
import { renamePinned } from '../src/core/pinned.ts';
import type { FilesystemServerContext } from '../src/server.ts';
import { cleanupTestRoot, createTestRoot, createTestServer, trySymlink } from './helpers.ts';

/** Runs `swap` once, immediately before the first open of `path`, then opens for real. */
function swapBeforeOpen(targetPath: string, swap: () => Promise<void>): void {
  let swapped = false;
  const originalOpen = fsPromises.open.bind(fsPromises);
  mock.method(fsPromises, 'open', (async (
    path: Parameters<typeof fsPromises.open>[0],
    flags?: Parameters<typeof fsPromises.open>[1],
    mode?: Parameters<typeof fsPromises.open>[2],
  ) => {
    if (!swapped && isSamePath(String(path), targetPath)) {
      swapped = true;
      await swap();
    }
    return await originalOpen(path, flags, mode);
  }) as typeof fsPromises.open);
  syncBuiltinESMExports();
}

/** Runs `swap` once, immediately before the first `process.chdir` into `directory`; restore with `mock.restoreAll()`. */
function swapBeforeChdir(directory: string, swap: () => void): void {
  let swapped = false;
  const originalChdir = process.chdir.bind(process);
  mock.method(process, 'chdir', (target: string) => {
    if (!swapped && isSamePath(target, directory)) {
      swapped = true;
      swap();
    }
    originalChdir(target);
  });
}

describe('swap after validation', () => {
  let base: string;
  let root: string;
  let outside: string;
  let ctx: FilesystemServerContext;
  let fs: GuardedFileSystem;

  before(async () => {
    base = await createTestRoot();
    root = join(base, 'root');
    outside = join(base, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'victim.txt'), 'TOP_SECRET');
    ctx = await createTestServer([root]);
    fs = new GuardedFileSystem(ctx.pathGuard);
  });

  after(async () => {
    if (ctx) {
      ctx.disposeRuntimeState();
      await ctx.mcp.close();
    }
    if (base) {
      await cleanupTestRoot(base);
    }
  });

  it('A: final component swapped for a file link', async (t) => {
    const target = join(root, 'a.txt');
    const victim = join(outside, 'victim.txt');
    await writeFile(target, 'in-root');

    let linkCreated = false;
    let skipped = false;

    swapBeforeOpen(target, async () => {
      await unlink(target);
      const created = await trySymlink(
        victim,
        target,
        () => {
          skipped = true;
          t.skip('file symlinks refused on this platform');
        },
        'file',
      );
      if (created) linkCreated = true;
    });

    try {
      try {
        const result = await fs.read(target);
        if (skipped) return;
        assert.doesNotMatch(
          result.content,
          /TOP_SECRET/,
          'returned content must not contain TOP_SECRET',
        );
        assert.fail('expected read to be refused, but it succeeded');
      } catch (error) {
        if (skipped) return;
        if (error instanceof assert.AssertionError) {
          throw error;
        }
      }
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      if (linkCreated) {
        await unlink(target).catch(() => {});
      }
    }
  });

  // The final component stays a regular file, so only the parent re-check
  // (/proc fd on Linux, realpath after open elsewhere) can catch this swap.
  it('B: parent directory swapped for a link to outside the roots', async (t) => {
    const dir = join(root, 'swapdir');
    const parked = join(root, 'swapdir.real');
    await mkdir(dir, { recursive: true });
    const target = join(dir, 'victim.txt');
    await writeFile(target, 'in-root');

    let linkCreated = false;
    let skipped = false;
    swapBeforeOpen(target, async () => {
      await rename(dir, parked);
      linkCreated = await trySymlink(outside, dir, () => {
        skipped = true;
        t.skip('directory links refused on this platform');
      });
    });

    try {
      await assert.rejects(fs.read(target), (error: unknown) => {
        if (skipped) return true;
        assert.ok(isFsError(error), `expected FsError, got ${String(error)}`);
        assert.strictEqual(error.code, ErrorCode.ACCESS_DENIED);
        assert.doesNotMatch(error.message, /TOP_SECRET/);
        return true;
      });
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      if (linkCreated) await rm(dir, { recursive: false, force: true }).catch(() => {});
      await rename(parked, dir).catch(() => {});
    }
  });

  // Without /proc, an ancestor swapped for the open and lstat, then back before realpath,
  // must still be caught: only the chdir/getcwd pin sees the directory actually entered.
  it(
    'refuses a double swap when /proc is unreadable',
    { skip: process.platform === 'win32' },
    async () => {
      await mkdir(join(root, 'dir'), { recursive: true });
      await writeFile(join(root, 'dir', 'note.txt'), 'inside');
      await writeFile(join(outside, 'note.txt'), 'TOP_SECRET');
      try {
        mock.method(fsPromises, 'readlink', async () => {
          throw new Error('no procfs');
        });
        let armed = false;
        swapBeforeOpen(join(root, 'dir', 'note.txt'), async () => {
          await rename(join(root, 'dir'), join(base, 'dir.real'));
          await trySymlink(outside, join(root, 'dir'), () => {});
          armed = true;
        });
        const realRealpath = fsPromises.realpath.bind(fsPromises);
        mock.method(fsPromises, 'realpath', (async (p: string) => {
          if (armed) {
            armed = false;
            await unlink(join(root, 'dir'));
            await rename(join(base, 'dir.real'), join(root, 'dir'));
          }
          return realRealpath(p);
        }) as typeof fsPromises.realpath);
        syncBuiltinESMExports();
        await assert.rejects(
          fs.read(join(root, 'dir', 'note.txt')),
          (err) => isFsError(err) && err.code === ErrorCode.ACCESS_DENIED,
        );
      } finally {
        mock.restoreAll();
        syncBuiltinESMExports();
      }
    },
  );

  it(
    'a parent swapped before the write commit is refused and nothing lands outside',
    { skip: process.platform === 'win32' },
    async () => {
      const dir = join(root, 'commitdir');
      await mkdir(dir);
      const outsideBefore = await readdir(outside);
      swapBeforeChdir(dir, () => {
        renameSync(dir, join(root, 'commitdir-real'));
        symlinkSync(outside, dir);
      });
      try {
        await assert.rejects(
          fs.writeFile(join(dir, 'new.txt'), 'payload'),
          (e) => isFsError(e) && e.code === ErrorCode.ACCESS_DENIED,
        );
      } finally {
        mock.restoreAll();
      }
      // Earlier tests leave their own files there; this write must add nothing.
      assert.deepEqual(await readdir(outside), outsideBefore);
    },
  );
  for (const [name, setup, act] of [
    [
      'mkdir -p into a directory swapped before the anchor enters it',
      async (_dir: string) => {},
      (dir: string) => fs.mkdir(join(dir, 'made'), { recursive: true }),
    ],
    [
      'rm of a file whose directory is swapped before the anchor enters it',
      async (dir: string) => writeFile(join(dir, 'victim.txt'), 'in-root'),
      (dir: string) => fs.rm(join(dir, 'victim.txt')),
    ],
    [
      'rmdir in a directory swapped before the anchor enters it',
      async (dir: string) => {
        await mkdir(join(dir, 'empty'));
        await mkdir(join(outside, 'empty'), { recursive: true });
      },
      (dir: string) => fs.rmdir(join(dir, 'empty')),
    ],
  ] as const) {
    it(name, { skip: process.platform === 'win32' }, async () => {
      const dir = join(root, `swap-${name.split(' ')[0]}`);
      await mkdir(dir);
      await setup(dir);
      const outsideBefore = await readdir(outside);
      swapBeforeChdir(dir, () => {
        renameSync(dir, `${dir}-real`);
        symlinkSync(outside, dir);
      });
      try {
        await assert.rejects(act(dir), (e) => isFsError(e) && e.code === ErrorCode.ACCESS_DENIED);
      } finally {
        mock.restoreAll();
      }
      assert.deepEqual(await readdir(outside), outsideBefore);
      assert.equal(await readFile(join(outside, 'victim.txt'), 'utf8'), 'TOP_SECRET');
      if (outsideBefore.includes('empty'))
        assert.ok((await stat(join(outside, 'empty'))).isDirectory());
    });
  }

  for (const [name, swapSide, file] of [
    ['a destination parent swapped before a move is refused and the source stays', 'to', 'a.txt'],
    [
      'a source parent swapped before a move is refused and outside is untouched',
      'from',
      'victim.txt',
    ],
  ] as const) {
    it(name, { skip: process.platform === 'win32' }, async () => {
      const dirs = { from: join(root, `mv-${swapSide}-from`), to: join(root, `mv-${swapSide}-to`) };
      await mkdir(dirs.from);
      await mkdir(dirs.to);
      await writeFile(join(dirs.from, file), 'data');
      const outsideBefore = await readdir(outside);
      const swapped = dirs[swapSide];
      swapBeforeChdir(swapped, () => {
        renameSync(swapped, `${swapped}-real`);
        symlinkSync(outside, swapped);
      });
      try {
        await assert.rejects(
          fs.rename(join(dirs.from, file), join(dirs.to, file)),
          (e) => isFsError(e) && e.code === ErrorCode.ACCESS_DENIED,
        );
      } finally {
        mock.restoreAll();
      }
      const sourceDir = swapSide === 'from' ? `${dirs.from}-real` : dirs.from;
      assert.equal(await readFile(join(sourceDir, file), 'utf8'), 'data');
      assert.deepEqual(await readdir(outside), outsideBefore);
      assert.equal(await readFile(join(outside, 'victim.txt'), 'utf8'), 'TOP_SECRET');
    });
  }

  it(
    'a source parent swapped before a failed move is sent back keeps the entry out of outside',
    { skip: process.platform === 'win32' },
    async () => {
      const from = join(root, 'sb-from');
      const to = join(root, 'sb-to');
      await mkdir(from);
      await mkdir(join(to, 'a.txt'), { recursive: true });
      await writeFile(join(to, 'a.txt', 'keep'), '');
      await writeFile(join(from, 'a.txt'), 'data');
      const outsideBefore = await readdir(outside);
      // Swap before the third chdir into either directory: the send-back after step 3 fails.
      let entries = 0;
      const originalChdir = process.chdir.bind(process);
      mock.method(process, 'chdir', (target: string) => {
        if (isSamePath(target, from) || isSamePath(target, to)) {
          entries += 1;
          if (entries === 3) {
            renameSync(from, `${from}-real`);
            symlinkSync(outside, from);
          }
        }
        originalChdir(target);
      });
      try {
        assert.throws(() => renamePinned(join(from, 'a.txt'), join(to, 'a.txt')));
      } finally {
        mock.restoreAll();
      }
      assert.deepEqual(await readdir(outside), outsideBefore);
      assert.equal(await readFile(join(outside, 'victim.txt'), 'utf8'), 'TOP_SECRET');
    },
  );
});
