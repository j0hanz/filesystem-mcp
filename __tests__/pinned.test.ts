import assert from 'node:assert/strict';
import { linkSync } from 'node:fs';
import {
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
import { join, parse } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import {
  inPinnedDirectory,
  isMkdirStep,
  isSameDirectory,
  isSecondLink,
  lstatPinned,
  mkdirPinned,
  renamePinned,
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

  it('isSameDirectory is exact off macOS and folds the Data volume on it', () => {
    assert.equal(isSameDirectory('/a/b', '/a/b', 'linux'), true);
    assert.equal(isSameDirectory('/a/B', '/a/b', 'linux'), false);
    assert.equal(isSameDirectory('/System/Volumes/Data/Users/x', '/Users/x', 'darwin'), true);
    assert.equal(isSameDirectory('/System/Volumes/Data/Users/x', '/Users/x', 'linux'), false);
  });

  it('lstatPinned returns the entry of the validated directory', posixOnly, async () => {
    const file = join(realRoot, 'dir', 'a.txt');
    assert.equal(lstatPinned(file).ino, (await lstat(file, { bigint: true })).ino);
  });

  it('survives a deleted working directory and falls back to the root', posixOnly, async () => {
    const original = process.cwd();
    const gone = join(base, 'gone');
    await mkdir(gone);
    try {
      process.chdir(gone);
      await rmdir(gone);
      const file = join(realRoot, 'dir', 'a.txt');
      assert.equal(lstatPinned(file).ino, (await lstat(file, { bigint: true })).ino);
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

    it('lstatPinned refuses a directory that is now a symlink elsewhere', () => {
      assert.throws(
        () => lstatPinned(join(realRoot, 'dir', 'a.txt')),
        (err) => isFsError(err) && err.code === ErrorCode.ACCESS_DENIED,
      );
    });

    it('restores the working directory after a refusal', () => {
      const before = process.cwd();
      assert.throws(() => lstatPinned(join(realRoot, 'dir', 'a.txt')));
      assert.equal(process.cwd(), before);
    });
  });
});

describe('inPinnedDirectory', posixOnly, () => {
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

  it('inPinnedDirectory returns the action result and restores the working directory', () => {
    const before = process.cwd();
    assert.equal(
      inPinnedDirectory(root, () => process.cwd()),
      root,
    );
    assert.equal(process.cwd(), before);
  });

  it('inPinnedDirectory restores the working directory after a throw', () => {
    const before = process.cwd();
    assert.throws(
      () =>
        inPinnedDirectory(root, () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(process.cwd(), before);
  });

  it('inPinnedDirectory refuses a directory that is a link elsewhere', async (t) => {
    const link = join(root, 'link');
    if (!(await trySymlink(outside, link, () => t.skip('symlinks unavailable')))) return;
    assert.throws(
      () => inPinnedDirectory(link, () => 'ran'),
      (e) => isFsError(e) && e.code === ErrorCode.ACCESS_DENIED,
    );
  });

  it('inPinnedDirectory works when the server working directory was deleted', async () => {
    const before = process.cwd();
    const doomed = join(root, 'doomed');
    await mkdir(doomed);
    process.chdir(doomed);
    await rm(doomed, { recursive: true });
    try {
      assert.equal(
        inPinnedDirectory(root, () => 'ran'),
        'ran',
      );
    } finally {
      process.chdir(before);
    }
  });
  it('mkdirPinned creates the missing chain and accepts an existing directory', async () => {
    mkdirPinned(join(root, 'a', 'b', 'c'));
    mkdirPinned(join(root, 'a', 'b', 'c'));
    assert.ok((await stat(join(root, 'a', 'b', 'c'))).isDirectory());
  });

  it('mkdirPinned fails EEXIST on a file in the way', async () => {
    await writeFile(join(root, 'file'), '');
    assert.throws(() => mkdirPinned(join(root, 'file', 'x')), { code: 'EEXIST' });
  });

  it('renamePinned moves an entry between directories and leaves no staging name', async () => {
    await mkdir(join(root, 'from'));
    await mkdir(join(root, 'to'));
    await writeFile(join(root, 'from', 'a.txt'), 'data');
    renamePinned(join(root, 'from', 'a.txt'), join(root, 'to', 'b.txt'));
    assert.equal(await readFile(join(root, 'to', 'b.txt'), 'utf8'), 'data');
    assert.deepEqual(await readdir(join(root, 'from')), []);
    assert.deepEqual(await readdir(join(root, 'to')), ['b.txt']);
  });

  it('renamePinned puts the source back when the destination directory is missing', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.txt'), 'data');
    assert.throws(() => renamePinned(join(root, 'src', 'a.txt'), join(root, 'nope', 'a.txt')));
    assert.deepEqual(await readdir(join(root, 'src')), ['a.txt']);
  });

  it('renamePinned onto a hard link of the same inode does nothing, as rename does', async () => {
    await mkdir(join(root, 'hl'));
    await writeFile(join(root, 'hl', 'a.txt'), 'data');
    linkSync(join(root, 'hl', 'a.txt'), join(root, 'hl', 'b.txt'));
    renamePinned(join(root, 'hl', 'a.txt'), join(root, 'hl', 'b.txt'));
    assert.deepEqual((await readdir(join(root, 'hl'))).sort(), ['a.txt', 'b.txt']);
  });
});

describe('isSecondLink', () => {
  const entry = { dev: 1n, ino: 7n };
  it('a second hard link of the same inode is a no-op rename', () => {
    assert.equal(isSecondLink(entry, { dev: 1n, ino: 7n }, false), true);
  });
  it('a respelling of the same entry is not a no-op, even on one inode', () => {
    assert.equal(isSecondLink(entry, { dev: 1n, ino: 7n }, true), false);
  });
  it('a different inode or a missing destination is not a no-op', () => {
    assert.equal(isSecondLink(entry, { dev: 1n, ino: 8n }, false), false);
    assert.equal(isSecondLink(entry, undefined, false), false);
  });
});

describe('isMkdirStep', () => {
  it('accepts a Data-prefixed cwd on darwin only', () => {
    const cwd = '/System/Volumes/Data/Users/a/new';
    assert.equal(isMkdirStep(cwd, '/Users/a', 'new', 'darwin'), true);
    assert.equal(isMkdirStep(cwd, '/Users/a', 'new', 'linux'), false);
  });
  it('folds the base name and refuses another one', () => {
    assert.equal(isMkdirStep('/r/é', '/r', 'é', 'linux'), true);
    assert.equal(isMkdirStep('/r/other', '/r', 'new', 'linux'), false);
  });
});
