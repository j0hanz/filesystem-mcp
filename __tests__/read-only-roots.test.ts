import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Logger } from '../src/core/observability.ts';
import { PathGuard } from '../src/core/path.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import { cleanupTestRoot, createTestRoot, trySymlink } from './helpers.ts';

// Per-root read-only (#162): PathGuard holds a configured list of read-only
// directories (CLI --read-only-root / env FS_READ_ONLY_DIRS) and answers
// containment on it. Guard-level half of the feature; the write/delete
// denial and tool-level halves live in later describe blocks.
describe('PathGuard read-only directories', { concurrency: false }, () => {
  let base: string;
  let rw: string;
  let ro: string;

  before(async () => {
    base = await createTestRoot();
    rw = join(base, 'rw');
    ro = join(base, 'ro');
    await mkdir(rw);
    await mkdir(ro);
  });

  after(async () => {
    await cleanupTestRoot(base);
  });

  it('RO-STATE-001: marks paths inside a configured read-only dir', async () => {
    const guard = new PathGuard({ cliAllowedDirs: [rw], readOnlyDirs: [ro] });
    await guard.recomputeAllowedDirectories();
    assert.equal(guard.isReadOnlyPath(join(ro, 'x.txt')), true);
    assert.equal(guard.isReadOnlyPath(ro), true);
    assert.equal(guard.isReadOnlyPath(join(rw, 'x.txt')), false);
  });

  it('RO-STATE-002: picks up FS_READ_ONLY_DIRS', async () => {
    process.env['FS_READ_ONLY_DIRS'] = ro;
    try {
      const guard = new PathGuard({ cliAllowedDirs: [rw] });
      await guard.recomputeAllowedDirectories();
      assert.equal(guard.isReadOnlyPath(join(ro, 'x.txt')), true);
      assert.equal(guard.isReadOnlyPath(join(rw, 'x.txt')), false);
    } finally {
      delete process.env['FS_READ_ONLY_DIRS'];
    }
  });

  it('RO-STATE-003: matches a symlinked read-only dir through its realpath alias', async (t) => {
    const real = join(base, 'ro-real');
    await mkdir(real);
    const alias = join(base, 'ro-alias');
    if (!(await trySymlink(real, alias, () => undefined))) return t.skip('symlink not permitted');
    const guard = new PathGuard({ cliAllowedDirs: [rw], readOnlyDirs: [alias] });
    await guard.recomputeAllowedDirectories();
    assert.equal(guard.isReadOnlyPath(join(real, 'file.txt')), true);
    assert.equal(guard.isReadOnlyPath(join(alias, 'file.txt')), true);
  });

  it('RO-STATE-004: getReadOnlyDirs returns the normalized CLI+env union, deduped', async () => {
    const other = join(base, 'other-ro');
    await mkdir(other);
    process.env['FS_READ_ONLY_DIRS'] = ro;
    try {
      const guard = new PathGuard({ cliAllowedDirs: [rw], readOnlyDirs: [ro, other] });
      await guard.recomputeAllowedDirectories();
      assert.deepEqual(guard.getReadOnlyDirs(), [normalizePath(ro), normalizePath(other)]);
    } finally {
      delete process.env['FS_READ_ONLY_DIRS'];
    }
  });

  it('RO-STATE-005: warns when a read-only dir matches no allowed root, and keeps it', async () => {
    const stray = join(base, 'stray-ro');
    await mkdir(stray);
    const warns: string[] = [];
    const originalWarn = Logger.warn;
    Logger.warn = (message: string) => {
      warns.push(message);
    };
    try {
      const guard = new PathGuard({ cliAllowedDirs: [rw], readOnlyDirs: [stray] });
      await guard.recomputeAllowedDirectories();
      assert.ok(
        warns.some(
          (m) =>
            m.includes('Read-only root matches no allowed root') &&
            m.includes(normalizePath(stray)),
        ),
        warns.join('\n'),
      );
      assert.equal(guard.isReadOnlyPath(join(stray, 'f.txt')), true);
    } finally {
      Logger.warn = originalWarn;
    }
  });

  it('RO-STATE-006: a read-only subtree inside a writable root', async () => {
    const subtree = join(rw, 'protected');
    await mkdir(subtree);
    const guard = new PathGuard({ cliAllowedDirs: [rw], readOnlyDirs: [subtree] });
    await guard.recomputeAllowedDirectories();
    assert.equal(guard.isReadOnlyPath(join(subtree, 'file.txt')), true);
    assert.equal(guard.isReadOnlyPath(join(rw, 'other.txt')), false);
  });
});