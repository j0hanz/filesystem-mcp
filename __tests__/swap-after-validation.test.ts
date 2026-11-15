import assert from 'node:assert/strict';
import fsPromises, { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { isSamePath } from '../src/core/path-utils.ts';
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
});
