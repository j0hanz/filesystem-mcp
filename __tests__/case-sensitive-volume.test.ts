import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { ErrorCode } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { cleanupTestRoot, createTestRoot, fsErrorMatcher, makeGuard } from './helpers.ts';

const execFileAsync = promisify(execFile);

async function makeCaseSensitiveDir(): Promise<string | undefined> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return undefined;
  }

  const dir = await createTestRoot();

  if (process.platform === 'win32') {
    try {
      await execFileAsync('fsutil.exe', ['file', 'setCaseSensitiveInfo', dir, 'enable']);
    } catch {
      await cleanupTestRoot(dir);
      return undefined;
    }
  }

  // Probe on every platform: create Probe and probe as two sub-directories
  // and check readdir lists both. If it lists one, clean up and return undefined.
  try {
    const p1 = join(dir, 'Probe');
    const p2 = join(dir, 'probe');
    await mkdir(p1);
    try {
      await mkdir(p2);
    } catch {
      await cleanupTestRoot(dir);
      return undefined;
    }

    const entries = await readdir(dir);
    if (!entries.includes('Probe') || !entries.includes('probe')) {
      await cleanupTestRoot(dir);
      return undefined;
    }

    await rm(p1, { recursive: true, force: true });
    await rm(p2, { recursive: true, force: true });
    return dir;
  } catch {
    await cleanupTestRoot(dir);
    return undefined;
  }
}

describe('case-sensitive volume containment', () => {
  it(
    'a sibling that differs from the root only in case is outside the root',
    { todo: 'plan 115: remove when the guard is per-volume' },
    async (t) => {
      const base = await makeCaseSensitiveDir();
      if (base === undefined) return t.skip('no case-sensitive directory available here');

      try {
        // base/Proj is the allowed root; base/proj is a different folder.
        // 1. mkdir both; write base/proj/secret.txt = 'OUTSIDE'.
        const allowedRoot = join(base, 'Proj');
        const siblingDir = join(base, 'proj');
        await mkdir(allowedRoot);
        await mkdir(siblingDir);

        const secretFile = join(siblingDir, 'secret.txt');
        await writeFile(secretFile, 'OUTSIDE');

        // 2. Build the guard and GuardedFileSystem with base/Proj as the only root
        //    (same construction as __tests__/security.test.ts).
        const guard = await makeGuard([allowedRoot]);
        const fs = new GuardedFileSystem(guard);

        // 3. Assert each of these rejects with ACCESS_DENIED:
        //    fs.read(join(base, 'proj', 'secret.txt'))
        //    fs.writeFile(join(base, 'proj', 'new.txt'), 'x')
        const denied = fsErrorMatcher(ErrorCode.ACCESS_DENIED);
        await assert.rejects(fs.read(secretFile), denied);
        await assert.rejects(fs.writeFile(join(siblingDir, 'new.txt'), 'x'), denied);

        // 4. Assert base/proj/new.txt does not exist afterwards.
        assert.strictEqual(
          existsSync(join(siblingDir, 'new.txt')),
          false,
          'base/proj/new.txt does not exist afterwards',
        );
      } finally {
        await cleanupTestRoot(base);
      }
    },
  );
});
