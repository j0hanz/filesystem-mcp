import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { IS_CASE_INSENSITIVE_FS } from '../src/core/path-utils.ts';
import type { PathGuard } from '../src/core/path.ts';
import { cleanupTestRoot, createTestRoot, makeGuard, writeTestFile } from './helpers.ts';

// ADR-021: equal keys name one Entry. Names are escapes so the source's own
// normalization cannot change them.
describe('PathGuard.entryKeys', () => {
  let root: string;
  let guard: PathGuard;
  const caseless = IS_CASE_INSENSITIVE_FS;

  beforeEach(async () => {
    root = await createTestRoot();
    guard = await makeGuard([root]);
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  it('folds Unicode form and spaces', async () => {
    const [a, b, c, d] = await guard.entryKeys([
      join(root, 'café.txt'),
      join(root, 'café.txt'),
      join(root, 'shot PM.png'),
      join(root, 'shot PM.png'),
    ]);
    assert.strictEqual(a, b);
    assert.strictEqual(c, d);
  });

  it('folds case by the directory rule', async () => {
    await writeTestFile(root, 'k/Name.txt', 'x');
    const [a, b] = await guard.entryKeys([
      join(root, 'k', 'Name.txt'),
      join(root, 'k', 'NAME.txt'),
    ]);
    assert.strictEqual(a === b, caseless);
  });

  it('uses the nearest existing ancestor for a missing parent', async () => {
    const [a, b] = await guard.entryKeys([join(root, 'new', 'x.txt'), join(root, 'NEW', 'X.txt')]);
    assert.strictEqual(a === b, caseless);
  });

  it('keeps different names apart', async () => {
    const [a, b] = await guard.entryKeys([join(root, 'a.txt'), join(root, 'b.txt')]);
    assert.notStrictEqual(a, b);
  });

  it('falls back to the platform rule outside the roots', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'entry-keys-out-'));
    try {
      const [a, b] = await guard.entryKeys([join(outside, 'Out.txt'), join(outside, 'OUT.txt')]);
      assert.strictEqual(a === b, caseless);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('yields keys under an unreadable folder', { skip: process.platform === 'win32' }, async () => {
    const locked = join(root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      const keys = await guard.entryKeys([join(locked, 'a.txt'), join(locked, 'b.txt')]);
      assert.strictEqual(keys.length, 2);
      assert.notStrictEqual(keys[0], keys[1]);
    } finally {
      await chmod(locked, 0o755);
    }
  });
});
