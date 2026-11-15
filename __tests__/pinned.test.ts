import assert from 'node:assert/strict';
import { lstat, mkdir, rename, rmdir, symlink, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { isSameDirectory, lstatPinned } from '../src/core/pinned.ts';
import { cleanupTestRoot, createTestRoot } from './helpers.ts';

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
