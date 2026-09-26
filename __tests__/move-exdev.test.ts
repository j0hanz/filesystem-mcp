import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import type { GuardedFileSystem } from '../src/core/fs.ts';
import { performRenameWithFallback } from '../src/tools/move.ts';

type FsOps = Pick<GuardedFileSystem, 'rename' | 'cp' | 'rm'>;

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: fake`), { code });

function fakeOps(behavior: {
  rename?: () => Promise<void>;
  cp?: () => Promise<void>;
  rm?: () => Promise<void>;
}): { ops: FsOps; calls: string[] } {
  const calls: string[] = [];
  const ops = {
    rename: async () => {
      calls.push('rename');
      await (behavior.rename ?? (() => Promise.resolve()))();
    },
    cp: async () => {
      calls.push('cp');
      await (behavior.cp ?? (() => Promise.resolve()))();
    },
    rm: async () => {
      calls.push('rm');
      await (behavior.rm ?? (() => Promise.resolve()))();
    },
  } as unknown as FsOps;
  return { ops, calls };
}

describe('performRenameWithFallback (EXDEV)', () => {
  it('a plain rename never copies', async () => {
    const { ops, calls } = fakeOps({});
    await performRenameWithFallback('/src', '/dst', ops, 'src');
    assert.deepStrictEqual(calls, ['rename']);
  });

  it('EXDEV falls back to copy then remove', async () => {
    const { ops, calls } = fakeOps({ rename: () => Promise.reject(errno('EXDEV')) });
    await performRenameWithFallback('/src', '/dst', ops, 'src');
    assert.deepStrictEqual(calls, ['rename', 'cp', 'rm']);
  });

  it('a non-EXDEV rename error is rethrown untouched', async () => {
    const { ops, calls } = fakeOps({ rename: () => Promise.reject(errno('EACCES')) });
    await assert.rejects(
      performRenameWithFallback('/src', '/dst', ops, 'src'),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'EACCES',
    );
    assert.deepStrictEqual(calls, ['rename']);
  });

  it('a failed copy rethrows the copy error and never removes the source', async () => {
    const { ops, calls } = fakeOps({
      rename: () => Promise.reject(errno('EXDEV')),
      cp: () => Promise.reject(errno('ENOSPC')),
    });
    await assert.rejects(
      performRenameWithFallback('/src', '/dst', ops, 'src'),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOSPC',
    );
    assert.deepStrictEqual(calls, ['rename', 'cp']);
  });

  it('copy ok but remove failed says the destination holds a copy', async () => {
    const { ops } = fakeOps({
      rename: () => Promise.reject(errno('EXDEV')),
      rm: () => Promise.reject(errno('EPERM')),
    });
    await assert.rejects(performRenameWithFallback('/src', '/dst', ops, 'src'), (err: unknown) => {
      assert.ok(isFsError(err));
      assert.notStrictEqual(err.code, ErrorCode.CANCELLED);
      assert.match(
        err.message,
        /copy succeeded but source removal failed \(destination holds a copy\)/,
      );
      return true;
    });
  });
});
