import assert from 'node:assert/strict';
import { chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { PathGuard } from '../src/core/path.ts';
import { cleanupTestRoot, createTestRoot, makeGuard } from './helpers.ts';

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
    const nfc = 'café.txt';
    const nfd = 'café.txt';
    const narrow = 'shot PM.png';
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
      const keys = await guard.entryKeys([join(locked, 'x.txt'), join(locked, 'X.txt')]);
      assert.strictEqual(keys.length, 2);
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

  it('honors an aborted signal', async () => {
    await assert.rejects(guard.entryKeys([join(root, 'k', 'a')], AbortSignal.abort()));
  });
});
