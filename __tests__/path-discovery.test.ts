import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  findProjectRoot,
  getUnsafeSystemDirs,
  isUnsafeCwdPath,
} from '../src/core/path-discovery.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import { PathGuard } from '../src/core/path.ts';
import { cleanupTestRoot, createTestRoot, withEnv } from './helpers.ts';

describe('findProjectRoot (--walk-cwd)', () => {
  let root: string;

  before(async () => {
    root = await createTestRoot();
  });

  after(async () => {
    await cleanupTestRoot(root);
  });

  async function dir(...parts: string[]): Promise<string> {
    const p = join(root, ...parts);
    await mkdir(p, { recursive: true });
    return p;
  }

  it('walks up to the nearest marker', async () => {
    const proj = await dir('a', 'proj');
    await writeFile(join(proj, 'package.json'), '{}');
    const start = await dir('a', 'proj', 'src', 'deep');
    assert.equal(await findProjectRoot(start, [root]), normalizePath(proj));
  });

  it('the nearest marker wins', async () => {
    const proj = await dir('b', 'proj');
    await writeFile(join(proj, 'package.json'), '{}');
    const sub = await dir('b', 'proj', 'sub');
    await writeFile(join(sub, 'pyproject.toml'), '');
    const start = await dir('b', 'proj', 'sub', 'src');
    assert.equal(await findProjectRoot(start, [root]), normalizePath(sub));
  });

  it('a .git directory counts', async () => {
    const proj = await dir('c', 'proj');
    await dir('c', 'proj', '.git');
    const start = await dir('c', 'proj', 'src');
    assert.equal(await findProjectRoot(start, [root]), normalizePath(proj));
  });

  it('stops at the ceiling', async () => {
    const d = await dir('d');
    await writeFile(join(d, 'package.json'), '{}');
    const proj = await dir('d', 'proj');
    const start = await dir('d', 'proj', 'src');
    assert.equal(await findProjectRoot(start, [proj]), normalizePath(start));
  });

  it('no marker returns the start', async () => {
    const start = await dir('e', 'proj', 'src');
    assert.equal(await findProjectRoot(start, [root]), normalizePath(start));
  });

  it('the walk sets the root', async () => {
    const proj = await dir('f', 'proj');
    await writeFile(join(proj, 'package.json'), '{}');
    const start = await dir('f', 'proj', 'src');
    await withEnv(
      {
        FS_ALLOW_CWD_WALK: '1',
        FS_ROOT_BOUNDARY: root,
        FS_ALLOWED_DIRS: undefined,
        FS_READ_ONLY_DIRS: undefined,
      },
      async () => {
        const previous = process.cwd();
        process.chdir(start);
        try {
          const guard = new PathGuard({ allowCwd: true });
          await guard.recomputeAllowedDirectories();
          assert.deepEqual(guard.getRoots(), [normalizePath(proj)]);
        } finally {
          process.chdir(previous);
        }
      },
    );
  });

  it('flags system root directories derived from environment variables', async () => {
    if (process.platform !== 'win32') return;
    await withEnv({ SystemRoot: 'D:\\Windows', ProgramFiles: 'D:\\Program Files' }, async () => {
      assert.strictEqual(isUnsafeCwdPath('D:\\Windows\\System32'), true);
      assert.strictEqual(isUnsafeCwdPath('D:\\Program Files\\App'), true);
    });
  });

  it('caches resolved system directories across calls with unchanged environment', () => {
    const first = getUnsafeSystemDirs();
    const second = getUnsafeSystemDirs();
    assert.strictEqual(first, second, 'must return the exact cached array instance');
  });
});
