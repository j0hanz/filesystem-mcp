import assert from 'node:assert/strict';
import fsPromises, { chmod, mkdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { PathGuard } from '../src/core/path.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  makeGuard,
  trySymlink,
  writeTestFile,
} from './helpers.ts';

const caseless = process.platform === 'win32' || process.platform === 'darwin';

describe('PathGuard.entryKeys', () => {
  let root: string;
  let guard: PathGuard;

  before(async () => {
    root = await createTestRoot();
    guard = await makeGuard([root]);
    await mkdir(join(root, 'k'));
  });
  after(async () => {
    await cleanupTestRoot(root);
  });

  it('folds Unicode form and space characters', async () => {
    const nfc = 'caf\u00e9.txt';
    const nfd = 'cafe\u0301.txt';
    const narrow = 'shot\u202fPM.png';
    const plain = 'shot PM.png';
    assert.notStrictEqual(nfc, nfd);
    assert.notStrictEqual(narrow, plain);
    const [a, b, c, d] = await guard.entryKeys([
      join(root, nfc),
      join(root, nfd),
      join(root, narrow),
      join(root, plain),
    ]);
    assert.strictEqual(a, b);
    assert.strictEqual(c, d);
  });

  it('keeps existing fold-alike entries apart and joins a respelling to its entry', async () => {
    const plain = 'a b.txt';
    const nbsp = 'a\u00a0b.txt';
    assert.notStrictEqual(plain, nbsp);
    await writeTestFile(root, `k/${plain}`, '1');
    await writeTestFile(root, `k/${nbsp}`, '2');
    const [a, b] = await guard.entryKeys([join(root, 'k', plain), join(root, 'k', nbsp)]);
    assert.notStrictEqual(a, b);

    const nfc = 'caf\u00e9.txt';
    const nfd = 'cafe\u0301.txt';
    assert.notStrictEqual(nfc, nfd);
    await writeTestFile(root, `k/${nfc}`, '3');
    const [existing, respelled] = await guard.entryKeys([
      join(root, 'k', nfc),
      join(root, 'k', nfd),
    ]);
    assert.strictEqual(existing, respelled);
  });

  it('follows the directory rule for letter case', async () => {
    const [upper, lower] = await guard.entryKeys([
      join(root, 'k', 'Name.txt'),
      join(root, 'k', 'NAME.txt'),
    ]);
    assert.strictEqual(upper === lower, caseless);
  });

  it('uses the nearest existing ancestor for missing parents', async () => {
    const [newUpper, newLower] = await guard.entryKeys([
      join(root, 'new', 'x.txt'),
      join(root, 'NEW', 'X.txt'),
    ]);
    assert.strictEqual(newUpper === newLower, caseless);
  });

  it('tells different names apart', async () => {
    const [first, second] = await guard.entryKeys([join(root, 'a.txt'), join(root, 'b.txt')]);
    assert.notStrictEqual(first, second);
  });

  it('yields keys for an unreadable parent', { skip: process.platform === 'win32' }, async () => {
    const locked = join(root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const [lockedKey, lockedOther] = await guard.entryKeys([
        join(locked, 'x.txt'),
        join(locked, 'X.txt'),
      ]);
      // Falls back to the root's rule; the root is case-sensitive only off win32/darwin.
      assert.strictEqual(lockedKey === lockedOther, caseless);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('falls back to the platform rule outside the roots', async () => {
    const [a, b] = await guard.entryKeys([
      join(tmpdir(), 'entry-keys-out', 'Y.txt'),
      join(tmpdir(), 'entry-keys-out', 'y.txt'),
    ]);
    assert.strictEqual(a === b, caseless);
  });

  it('never reads a directory a link leads out of the roots', async (t) => {
    const outside = await createTestRoot();
    try {
      // Outside holds two names that differ by case, so a read would show a case-sensitive dir.
      await writeTestFile(outside, 'a', '');
      await writeTestFile(outside, 'A', '');
      if (!(await trySymlink(outside, join(root, 'escape'), () => t.skip('no symlink right')))) {
        return;
      }
      const reads: string[] = [];
      const original = fsPromises.readdir;
      const spy = t.mock.method(fsPromises, 'readdir', (...args: Parameters<typeof original>) => {
        reads.push(String(args[0]));
        return Reflect.apply(original, fsPromises, args);
      });
      syncBuiltinESMExports();
      const [a, b] = await guard.entryKeys([join(root, 'escape', 'x'), join(root, 'escape', 'X')]);
      assert.strictEqual(a === b, caseless);
      assert.ok(!reads.some((dir) => dir.startsWith(outside)));
      assert.ok(spy.mock.callCount() > 0, 'the readdir spy saw the guard');
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await cleanupTestRoot(outside);
    }
  });

  it('honors an aborted signal', async () => {
    await assert.rejects(guard.entryKeys([join(root, 'k', 'a')], AbortSignal.abort()));
  });
});
