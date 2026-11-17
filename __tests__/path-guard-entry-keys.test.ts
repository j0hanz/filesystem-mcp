import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsPromises, { chmod, mkdir, readdir, rmdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';

import type { PathGuard } from '../src/core/path.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  makeGuard,
  trySymlink,
  writeTestFile,
} from './helpers.ts';

const caseless = process.platform === 'win32' || process.platform === 'darwin';

/** Makes `dir` (new, empty) case-sensitive; false when the host cannot. Windows only. */
async function makeCaseSensitive(dir: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  await mkdir(dir, { recursive: true });
  try {
    await promisify(execFile)('fsutil.exe', ['file', 'setCaseSensitiveInfo', dir, 'enable']);
    await mkdir(join(dir, 'Probe'));
    await mkdir(join(dir, 'probe'));
    const entries = await readdir(dir);
    await rmdir(join(dir, 'Probe'));
    await rmdir(join(dir, 'probe'));
    return entries.includes('Probe') && entries.includes('probe');
  } catch {
    return false;
  }
}

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

  it('keys by the real directory under a respelled case-insensitive ancestor', async (t) => {
    const sens = join(root, 'Mid', 'Sens');
    if (!(await makeCaseSensitive(sens)))
      return t.skip('no case-sensitive directory available here');
    await writeTestFile(root, 'Mid/Sens/a.txt', '1');
    const [existing, existingRespelled, missing, missingRespelled, otherCase] =
      await guard.entryKeys([
        join(root, 'Mid', 'Sens', 'a.txt'),
        join(root, 'mid', 'Sens', 'a.txt'),
        join(root, 'Mid', 'Sens', 'new.txt'),
        join(root, 'MID', 'Sens', 'new.txt'),
        join(root, 'Mid', 'Sens', 'NEW.txt'),
      ]);
    assert.strictEqual(existing, existingRespelled);
    assert.strictEqual(missing, missingRespelled);
    // The case-sensitive directory still tells letter case apart.
    assert.notStrictEqual(missing, otherCase);
  });

  it('joins case respellings of a link above a case-sensitive directory', async (t) => {
    const sens = join(root, 'Real', 'Sens');
    if (!(await makeCaseSensitive(sens)))
      return t.skip('no case-sensitive directory available here');
    await writeTestFile(root, 'Real/Sens/a.txt', '1');
    if (!(await trySymlink(join(root, 'Real'), join(root, 'Lnk'), () => t.skip('no link right'))))
      return;
    const [existing, existingRespelled, missing, missingRespelled] = await guard.entryKeys([
      join(root, 'Lnk', 'Sens', 'a.txt'),
      join(root, 'lnk', 'Sens', 'a.txt'),
      join(root, 'Lnk', 'Sens', 'new.txt'),
      join(root, 'LNK', 'Sens', 'new.txt'),
    ]);
    assert.strictEqual(existing, existingRespelled);
    assert.strictEqual(missing, missingRespelled);
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
