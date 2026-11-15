import assert from 'node:assert/strict';
import { linkSync } from 'node:fs';
import fsPromises, {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, parse } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import {
  lstatPinned,
  mkdirPinned,
  renamePinned,
  rmdirPinned,
  rmPinned,
  writeStagedPinned,
} from '../src/core/pinned.ts';
import { cleanupTestRoot, createTestRoot, trySymlink } from './helpers.ts';

const posixOnly = { skip: process.platform === 'win32' };

describe('pinned identity check', () => {
  let base: string;
  let realRoot: string;

  before(async () => {
    base = await createTestRoot();
    realRoot = join(base, 'real');
    await mkdir(join(realRoot, 'dir'), { recursive: true });
    await writeFile(join(realRoot, 'dir', 'a.txt'), 'inside');
    await mkdir(join(base, 'outside'));
    await writeFile(join(base, 'outside', 'a.txt'), 'outside');
  });

  after(async () => {
    if (base) await cleanupTestRoot(base);
  });

  it('lstatPinned returns the entry of the validated directory', async () => {
    const file = join(realRoot, 'dir', 'a.txt');
    assert.equal((await lstatPinned(file)).ino, (await lstat(file, { bigint: true })).ino);
  });

  it('survives a deleted working directory and falls back to the root', posixOnly, async () => {
    const original = process.cwd();
    const gone = join(base, 'gone');
    await mkdir(gone);
    try {
      process.chdir(gone);
      await rmdir(gone);
      const file = join(realRoot, 'dir', 'a.txt');
      assert.equal((await lstatPinned(file)).ino, (await lstat(file, { bigint: true })).ino);
      assert.equal(process.cwd(), parse(file).root);
    } finally {
      process.chdir(original);
    }
  });

  describe('after the directory is swapped for a symlink', posixOnly, () => {
    before(async () => {
      await rename(join(realRoot, 'dir'), join(base, 'dir.real'));
      await symlink(join(base, 'outside'), join(realRoot, 'dir'));
    });

    it('lstatPinned refuses a directory that is now a symlink elsewhere', async () => {
      await assert.rejects(
        () => lstatPinned(join(realRoot, 'dir', 'a.txt')),
        (err) => isFsError(err) && err.code === ErrorCode.ACCESS_DENIED,
      );
    });

    it('restores the working directory after a refusal', async () => {
      const beforeCwd = process.cwd();
      await assert.rejects(() => lstatPinned(join(realRoot, 'dir', 'a.txt')));
      assert.equal(process.cwd(), beforeCwd);
    });
  });
});

describe('anchored mutations', () => {
  let root: string;
  let outside: string;

  before(async () => {
    // A realpath: macOS temp directories sit behind a link.
    root = await realpath(await createTestRoot());
    outside = await realpath(await createTestRoot());
  });

  after(async () => {
    if (root) await cleanupTestRoot(root);
    if (outside) await cleanupTestRoot(outside);
  });

  it('mkdirPinned creates the missing chain and accepts an existing directory', async () => {
    await mkdirPinned(join(root, 'a', 'b', 'c'), { recursive: true });
    await mkdirPinned(join(root, 'a', 'b', 'c'), { recursive: true });
    assert.ok((await stat(join(root, 'a', 'b', 'c'))).isDirectory());
  });

  it('mkdirPinned handles Unicode normalization across missing components', async (t) => {
    if (process.platform !== 'win32') {
      const realCwd = process.cwd.bind(process);
      t.mock.method(process, 'cwd', () => {
        const current = realCwd();
        return basename(current).normalize('NFC') === '\u00e9'
          ? join(dirname(current), 'e\u0301')
          : current;
      });
    }
    try {
      await mkdirPinned(join(root, 'uni', '\u00e9'), { recursive: true });
      assert.ok((await stat(join(root, 'uni', '\u00e9'))).isDirectory());
    } finally {
      t.mock.restoreAll();
    }
  });

  it('mkdirPinned fails on a file in the way', async () => {
    await writeFile(join(root, 'file'), '');
    await assert.rejects(() => mkdirPinned(join(root, 'file', 'x'), { recursive: true }), {
      code: process.platform === 'win32' ? 'ENOTDIR' : 'EEXIST',
    });
  });

  it('mkdirPinned refuses entering an existing symlink directory', posixOnly, async (t) => {
    const link = join(root, 'dir-link');
    if (!(await trySymlink(outside, link, () => t.skip('symlinks unavailable')))) return;
    await assert.rejects(
      () => mkdirPinned(join(link, 'child'), { recursive: true }),
      (e) => isFsError(e) && e.code === ErrorCode.ACCESS_DENIED,
    );
  });

  it('mkdirPinned works when the server working directory was deleted', posixOnly, async () => {
    const beforeCwd = process.cwd();
    const doomed = join(root, 'doomed');
    await mkdir(doomed);
    process.chdir(doomed);
    await rm(doomed, { recursive: true });
    try {
      await mkdirPinned(join(root, 'after-doomed', 'leaf'), { recursive: true });
      assert.ok((await stat(join(root, 'after-doomed', 'leaf'))).isDirectory());
    } finally {
      process.chdir(beforeCwd);
    }
  });

  it('renamePinned moves an entry between directories and leaves no staging name', async () => {
    await mkdir(join(root, 'from'));
    await mkdir(join(root, 'to'));
    await writeFile(join(root, 'from', 'a.txt'), 'data');
    await renamePinned(join(root, 'from', 'a.txt'), join(root, 'to', 'b.txt'));
    assert.equal(await readFile(join(root, 'to', 'b.txt'), 'utf8'), 'data');
    assert.deepEqual(await readdir(join(root, 'from')), []);
    assert.deepEqual(await readdir(join(root, 'to')), ['b.txt']);
  });

  it('renamePinned uses custom rawRename when supplied', async () => {
    const calls: [string, string][] = [];
    const customRename = async (oldPath: string, newPath: string): Promise<void> => {
      calls.push([oldPath, newPath]);
      await rename(oldPath, newPath);
    };
    await mkdir(join(root, 'raw-from'));
    await mkdir(join(root, 'raw-to'));
    const from = join(root, 'raw-from', 'a.txt');
    const to = join(root, 'raw-to', 'b.txt');
    await writeFile(from, 'raw');
    await renamePinned(from, to, { rawRename: customRename as typeof rename });
    assert.deepEqual(calls, [[from, to]]);
    assert.equal(await readFile(to, 'utf8'), 'raw');
  });

  it('renamePinned puts the source back when the destination directory is missing', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.txt'), 'data');
    await assert.rejects(() =>
      renamePinned(join(root, 'src', 'a.txt'), join(root, 'nope', 'a.txt')),
    );
    assert.deepEqual(await readdir(join(root, 'src')), ['a.txt']);
  });

  it(
    'renamePinned onto a hard link of the same inode is a no-op unless respelling is set',
    posixOnly,
    async (t) => {
      const hl = join(root, 'hl');
      await mkdir(hl);
      await writeFile(join(hl, 'a.txt'), 'data');
      linkSync(join(hl, 'a.txt'), join(hl, 'b.txt'));
      await renamePinned(join(hl, 'a.txt'), join(hl, 'b.txt'));
      assert.deepEqual((await readdir(hl)).sort(), ['a.txt', 'b.txt']);

      const chdirSpy = t.mock.method(process, 'chdir');
      try {
        await renamePinned(join(hl, 'a.txt'), join(hl, 'a.txt'), {
          respelling: true,
        });
        assert.equal(chdirSpy.mock.callCount(), 4);
      } finally {
        t.mock.restoreAll();
      }
      assert.deepEqual((await readdir(hl)).sort(), ['a.txt', 'b.txt']);
    },
  );

  it('rmPinned removes files, honors force, and falls back to recursive rm on directories', async () => {
    const file = join(root, 'rm-target.txt');
    await writeFile(file, 'bye');
    await rmPinned(file);
    await assert.rejects(() => stat(file), { code: 'ENOENT' });

    await rmPinned(join(root, 'missing-rm.txt'), { force: true });
    await assert.rejects(() => rmPinned(join(root, 'missing-rm.txt')), { code: 'ENOENT' });

    const dir = join(root, 'rm-tree');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', 'x.txt'), 'x');
    await rmPinned(dir, { recursive: true });
    await assert.rejects(() => stat(dir), { code: 'ENOENT' });
  });

  it('rmdirPinned removes an empty directory and refuses a non-empty one', async () => {
    const empty = join(root, 'empty-dir');
    await mkdir(empty);
    await rmdirPinned(empty);
    await assert.rejects(() => stat(empty), { code: 'ENOENT' });

    const nonEmpty = join(root, 'non-empty-dir');
    await mkdir(nonEmpty);
    await writeFile(join(nonEmpty, 'keep.txt'), 'k');
    await assert.rejects(() => rmdirPinned(nonEmpty));
  });

  it('writeStagedPinned commits atomically and cleans up temp files on abort or error', async (t) => {
    const target = join(root, 'staged.txt');
    const temp = join(root, 'staged.txt.111111111111.tmp');
    await writeFile(target, 'old');
    const existingStats = await stat(target);

    const outcome = await writeStagedPinned(target, temp, 'new-content', {
      existingStats,
      mode: 0o600,
    });
    assert.equal(outcome, 'renamed');
    assert.equal(await readFile(target, 'utf8'), 'new-content');
    await assert.rejects(() => stat(temp), { code: 'ENOENT' });

    const abortedTemp = join(root, 'staged.txt.222222222222.tmp');
    const chdirSpy = t.mock.method(process, 'chdir');
    const unlinkSpy = t.mock.method(fsPromises, 'unlink');
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () =>
          writeStagedPinned(target, abortedTemp, 'never', {
            signal: AbortSignal.abort(new Error('cancelled')),
          }),
        /cancelled/,
      );
      assert.equal(chdirSpy.mock.callCount(), 0);
      assert.equal(unlinkSpy.mock.callCount(), 0);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(await readFile(target, 'utf8'), 'new-content');
    await assert.rejects(() => stat(abortedTemp), { code: 'ENOENT' });

    const failTemp = join(root, 'staged.txt.333333333333.tmp');
    await assert.rejects(
      () =>
        writeStagedPinned(target, failTemp, 'never', {
          rawRename: (async () => {
            throw Object.assign(new Error('rename failed'), { code: 'EIO' });
          }) as unknown as typeof rename,
        }),
      /rename failed/,
    );
    assert.equal(await readFile(target, 'utf8'), 'new-content');
    await assert.rejects(() => stat(failTemp), { code: 'ENOENT' });
  });
});
