import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  rename as nodeRename,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { PathGuard } from '../src/core/path.ts';
import { withEnv } from './helpers.ts';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

const rejectsWith =
  (code: ErrorCode, message: RegExp) =>
  (error: unknown): boolean => {
    assert.ok(isFsError(error), String(error));
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  };

describe('GuardedFileSystem Transfer', { concurrency: false }, () => {
  let base: string;
  let n = 0;
  // A fresh root per test: names never collide, and the guard is built under
  // the env the test sets.
  const setup = async (): Promise<{ root: string; fs: GuardedFileSystem }> => {
    const root = join(base, `t${String((n += 1))}`);
    await mkdir(root);
    const guard = new PathGuard({ cliAllowedDirs: [root] });
    await guard.recomputeAllowedDirectories();
    return { root, fs: new GuardedFileSystem(guard) };
  };

  before(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'fsmcp-transfer-')));
  });
  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('a one-shot rename refuses a directory whose entry would leave protection', async () => {
    await withEnv({ FS_DENYLIST: 'vault/*.dat', FS_ALLOW_SENSITIVE: '1' }, async () => {
      const { root, fs } = await setup();
      await mkdir(join(root, 'vault'));
      await writeFile(join(root, 'vault', 'x.dat'), 'secret');
      await assert.rejects(
        fs.rename(join(root, 'vault'), join(root, 'pub')),
        rejectsWith(ErrorCode.ACCESS_DENIED, /protected entries/u),
      );
      assert.equal(existsSync(join(root, 'vault', 'x.dat')), true);
    });
  });

  it('a Self-move plans as a no-op', async () => {
    const { root, fs } = await setup();
    await writeFile(join(root, 'a.txt'), 'a');
    const plan = await fs.planTransfer('move', {
      source: join(root, 'a.txt'),
      destination: join(root, 'a.txt'),
    });
    assert.equal(plan.noop, true);
  });

  it('a Respelling is real work for a move and a no-op for a copy', async (t) => {
    if (!CASE_INSENSITIVE) return t.skip('needs a case-insensitive filesystem');
    const { root, fs } = await setup();
    await writeFile(join(root, 'a.txt'), 'a');
    const pair = { source: join(root, 'a.txt'), destination: join(root, 'A.txt') };
    const move = await fs.planTransfer('move', pair);
    assert.equal(move.noop, false);
    assert.equal(move.respelling, true);
    assert.equal(move.existing, undefined);
    assert.equal((await fs.planTransfer('copy', pair)).noop, true);
  });

  it('refuses a directory transferred into its own subdirectory', async () => {
    const { root, fs } = await setup();
    await mkdir(join(root, 'd'));
    for (const op of ['move', 'copy'] as const) {
      await assert.rejects(
        fs.planTransfer(op, { source: join(root, 'd'), destination: join(root, 'd', 'in') }),
        rejectsWith(ErrorCode.INVALID_INPUT, /own subdirectory/u),
      );
    }
    await assert.rejects(
      fs.cp(join(root, 'd'), join(root, 'd', 'in')),
      rejectsWith(ErrorCode.INVALID_INPUT, /own subdirectory/u),
    );
  });

  it('refuses a destination created after the plan', async () => {
    const { root, fs } = await setup();
    await writeFile(join(root, 'a.txt'), 'a');
    const plan = await fs.planTransfer('move', {
      source: join(root, 'a.txt'),
      destination: join(root, 'b.txt'),
    });
    await writeFile(join(root, 'b.txt'), 'late');
    await assert.rejects(
      fs.executeTransfer(plan),
      rejectsWith(ErrorCode.CANCELLED, /created during confirmation/u),
    );
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'late');
    assert.equal(existsSync(join(root, 'a.txt')), true);
  });

  it('refuses a destination replaced after the plan', async () => {
    const { root, fs } = await setup();
    await writeFile(join(root, 'a.txt'), 'a');
    await writeFile(join(root, 'b.txt'), 'seen');
    // Alive alongside b.txt, so it is a different inode on every filesystem.
    await writeFile(join(root, 'c.txt'), 'swapped');
    const plan = await fs.planTransfer('copy', {
      source: join(root, 'a.txt'),
      destination: join(root, 'b.txt'),
    });
    assert.notEqual(plan.existing, undefined);
    await nodeRename(join(root, 'c.txt'), join(root, 'b.txt'));
    await assert.rejects(
      fs.executeTransfer(plan),
      rejectsWith(ErrorCode.CANCELLED, /replaced after the overwrite was approved/u),
    );
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'swapped');
  });

  it('walks again at execute: a protected entry added after the plan is refused', async () => {
    await withEnv({ FS_DENYLIST: 'vault/*.dat', FS_ALLOW_SENSITIVE: '1' }, async () => {
      const { root, fs } = await setup();
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'ok.txt'), 'ok');
      const plan = await fs.planTransfer('move', {
        source: join(root, 'src'),
        destination: join(root, 'vault'),
      });
      await writeFile(join(root, 'src', 'late.dat'), 'entering protection');
      await assert.rejects(fs.executeTransfer(plan), (error: unknown) => {
        assert.ok(isFsError(error), String(error));
        assert.equal(error.code, ErrorCode.ACCESS_DENIED);
        return true;
      });
      assert.equal(existsSync(join(root, 'src', 'late.dat')), true);
      assert.equal(existsSync(join(root, 'vault')), false);
    });
  });
});
