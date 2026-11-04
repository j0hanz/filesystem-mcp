import assert from 'node:assert/strict';
import fsPromises, {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type * as z from 'zod/v4';

import { GuardedFileSystem } from '../src/core/fs.ts';
import { PathGuard } from '../src/core/path.ts';
import { MOVE } from '../src/tools/move.ts';
import { READ } from '../src/tools/read.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  makeGuard,
  trySymlink,
  withEnv,
  writeTestFile,
} from './helpers.ts';
import { choose, runToolBodyResult, type ToolBodyOptions } from './tool-harness.ts';

type MoveArgs = z.input<typeof MOVE.def.input>;
interface MoveStructured {
  readonly moves: readonly { from: string; to: string }[];
  readonly failures?: readonly {
    source: string;
    destination: string;
    error: { code: string; message: string; path?: string; suggestion?: string };
  }[];
  readonly skipped?: readonly string[];
}
type MoveRun = Awaited<ReturnType<typeof runToolBodyResult<typeof MOVE.def.input, object>>> & {
  readonly structured: MoveStructured;
};

describe('move body', () => {
  let root: string;
  let outside: string;
  let fs: GuardedFileSystem;

  before(async () => {
    root = await createTestRoot();
    outside = await createTestRoot();
    fs = new GuardedFileSystem(await makeGuard([root]));
  });

  after(async () => {
    await cleanupTestRoot(root);
    await cleanupTestRoot(outside);
  });

  const move = async (args: MoveArgs, options: Partial<ToolBodyOptions> = {}): Promise<MoveRun> =>
    runToolBodyResult(MOVE, args, { fs, ...options });

  it('names the failing pair, code and reason in its text', async () => {
    const source = join(root, 'move_reason_missing.txt');
    const destination = join(root, 'move_reason_dest.txt');
    const result = await move({ moves: [{ source, destination }] });

    const failure = result.structured.failures?.[0];
    assert.ok(failure);
    assert.strictEqual(
      result.text,
      `move: nothing · 1 failed\n// ${source} → ${destination}: ${failure.error.code} ${failure.error.message}`,
    );
  });

  it('is a total failure when every requested copy was denied', async () => {
    const source = await writeTestFile(root, 'movable.txt', 'body');
    const result = await move({
      moves: [{ source, destination: join(outside, 'move_denied.txt') }],
      copy: true,
    });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structured.failures?.[0]?.error.code, 'ACCESS_DENIED');
  });

  it('refuses an NTFS stream destination for a copy and writes nothing', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('alternate data streams are an NTFS feature');
      return;
    }
    const source = await writeTestFile(root, 'ads/ads-src.txt', 'body');
    const before = await readdir(join(root, 'ads'));
    const result = await move({
      copy: true,
      moves: [{ source, destination: join(root, 'ads', 'ads-dst.txt:hidden') }],
    });
    assert.strictEqual(result.isError, true);
    const failure = result.structured.failures?.[0];
    assert.strictEqual(failure?.error.code, 'INVALID_INPUT');
    assert.match(failure?.error.message ?? '', /NTFS alternate data streams are not supported/);
    assert.deepStrictEqual(await readdir(join(root, 'ads')), before, 'no host file was created');
  });

  it('performs a case-only rename (a Respelling) on a case-insensitive filesystem', async (t) => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      t.skip('case-only rename is only special on a case-insensitive filesystem');
      return;
    }
    const dir = join(root, 'case_rename');
    const lower = await writeTestFile(root, 'case_rename/foo.txt', 'same bytes\n');
    const upper = join(dir, 'Foo.txt');

    const result = await move({ moves: [{ source: lower, destination: upper }] });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structured.moves.length, 1, 'a Respelling is real work, not a no-op');
    assert.deepStrictEqual(await readdir(dir), ['Foo.txt']);
    assert.strictEqual(await readFile(upper, 'utf-8'), 'same bytes\n');
  });

  it('skips a Self-move without prompting, failing, or touching the file', async () => {
    const file = await writeTestFile(root, 'self_move.txt', 'stay\n');
    for (const copy of [false, true]) {
      const result = await move(
        { moves: [{ source: file, destination: file }], copy },
        {
          confirm: () => {
            throw new Error('a Self-move must not prompt');
          },
        },
      );
      assert.notStrictEqual(result.isError, true);
      assert.deepStrictEqual(result.structured.moves, []);
      assert.strictEqual(result.structured.failures, undefined);
      assert.strictEqual(result.text, `${copy ? 'copy' : 'move'}: nothing`);
      assert.strictEqual(await readFile(file, 'utf-8'), 'stay\n');
    }
  });

  it('copies over an existing destination without asking under overwrite: true', async () => {
    const src = await writeTestFile(root, 'copy_ow_src.txt', 'new source');
    const dst = await writeTestFile(root, 'copy_ow_dst.txt', 'existing dst');

    const result = await move(
      { moves: [{ source: src, destination: dst }], copy: true, overwrite: true },
      {
        confirm: () => {
          throw new Error('overwrite: true must not prompt');
        },
      },
    );
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(dst, 'utf-8'), 'new source');
  });

  it('a failed forced file copy over an existing file keeps the old bytes and leaves no temp file', async (t) => {
    const src = await writeTestFile(root, 'copy_fail_src.txt', 'new bytes');
    const dst = await writeTestFile(root, 'copy_fail_dst.txt', 'old bytes');
    // Stand in for an unreadable source: the copy leaves partial bytes behind
    // before its failure is raised.
    t.mock.method(fsPromises, 'cp', async (_source: unknown, destination: string) => {
      await fsPromises.writeFile(destination, 'partial copy bytes');
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    syncBuiltinESMExports();
    try {
      const result = await move({
        moves: [{ source: src, destination: dst }],
        copy: true,
        overwrite: true,
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structured.moves.length, 0);
      assert.strictEqual(result.structured.failures?.length, 1);
      assert.strictEqual(await readFile(dst, 'utf-8'), 'old bytes');
      assert.strictEqual(await readFile(src, 'utf-8'), 'new bytes');
      assert.strictEqual(
        (await readdir(root)).some((entry) => entry.includes('.tmp')),
        false,
        'the staged copy must be cleaned up',
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it('a failed merged directory copy keeps the old bytes of the failing entry, leaves no temp file, and says it stopped part-way', async (t) => {
    const srcDir = join(root, 'merge_fail_src');
    const dstDir = join(root, 'merge_fail_dst');
    await mkdir(srcDir, { recursive: true });
    await mkdir(dstDir, { recursive: true });
    const doomed = join(srcDir, 'doomed.txt');
    await writeFile(doomed, 'new bytes');
    await writeFile(join(srcDir, 'fresh.txt'), 'fresh bytes');
    await writeFile(join(dstDir, 'doomed.txt'), 'old bytes');
    await writeFile(join(dstDir, 'keep.txt'), 'kept bytes');
    const realCp = fsPromises.cp;
    // The guard returns a drive letter in a different case than the request on
    // Windows, so the doomed copy is matched case-insensitively.
    const samePath = (a: unknown, b: string) =>
      typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
    // Stand in for an unreadable source entry: whichever shape the copy takes -
    // one whole-tree call, or one call per entry - the doomed entry's copy has
    // already written partial bytes when it fails.
    t.mock.method(
      fsPromises,
      'cp',
      async (source: unknown, destination: string, options: unknown) => {
        if (samePath(source, srcDir) || samePath(source, doomed)) {
          const partial = destination.endsWith('doomed.txt')
            ? destination
            : join(destination, 'doomed.txt');
          await fsPromises.writeFile(partial, 'partial copy bytes');
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        }
        return (realCp as (...args: unknown[]) => Promise<void>)(source, destination, options);
      },
    );
    syncBuiltinESMExports();
    try {
      const result = await move({
        moves: [{ source: srcDir, destination: dstDir }],
        copy: true,
        overwrite: true,
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structured.moves.length, 0);
      assert.strictEqual(result.structured.failures?.length, 1);
      assert.strictEqual(await readFile(join(dstDir, 'doomed.txt'), 'utf-8'), 'old bytes');
      assert.strictEqual(await readFile(join(dstDir, 'keep.txt'), 'utf-8'), 'kept bytes');
      assert.strictEqual(
        (await readdir(dstDir)).some((entry) => entry.includes('.tmp')),
        false,
        'the staged copy must be cleaned up',
      );
      assert.match(
        result.structured.failures?.[0]?.error.message ?? '',
        /part-way/,
        'the failure must say the copy stopped part-way',
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it('a failed merged copy of a nested directory keeps the old bytes there too', async (t) => {
    const srcDir = join(root, 'merge_deep_src');
    const dstDir = join(root, 'merge_deep_dst');
    await mkdir(join(srcDir, 'nested'), { recursive: true });
    await mkdir(join(dstDir, 'nested'), { recursive: true });
    const doomed = join(srcDir, 'nested', 'doomed.txt');
    await writeFile(doomed, 'new bytes');
    await writeFile(join(srcDir, 'top.txt'), 'top bytes');
    await writeFile(join(dstDir, 'nested', 'doomed.txt'), 'old bytes');
    const realCp = fsPromises.cp;
    const samePath = (a: unknown, b: string) =>
      typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
    t.mock.method(
      fsPromises,
      'cp',
      async (source: unknown, destination: string, options: unknown) => {
        if (samePath(source, srcDir) || samePath(source, doomed)) {
          const partial = destination.endsWith('doomed.txt')
            ? destination
            : join(destination, 'nested', 'doomed.txt');
          await fsPromises.writeFile(partial, 'partial copy bytes');
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        }
        return (realCp as (...args: unknown[]) => Promise<void>)(source, destination, options);
      },
    );
    syncBuiltinESMExports();
    try {
      const result = await move({
        moves: [{ source: srcDir, destination: dstDir }],
        copy: true,
        overwrite: true,
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(
        await readFile(join(dstDir, 'nested', 'doomed.txt'), 'utf-8'),
        'old bytes',
      );
      assert.strictEqual(
        (await readdir(join(dstDir, 'nested'))).some((entry) => entry.includes('.tmp')),
        false,
        'the staged copy inside the merged subdirectory must be cleaned up',
      );
      assert.match(result.structured.failures?.[0]?.error.message ?? '', /part-way/);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it('a merged copy re-checks a staged entry whose destination ancestor was swapped for a link mid-copy', async (t) => {
    const srcDir = join(root, 'merge_swap_src');
    const dstDir = join(root, 'merge_swap_dst');
    const srcInner = join(srcDir, 'inner');
    const dstInner = join(dstDir, 'inner');
    const victimInner = join(outside, 'merge_swap_victim');
    await mkdir(srcInner, { recursive: true });
    await mkdir(dstInner, { recursive: true });
    await mkdir(victimInner, { recursive: true });
    await writeFile(join(srcInner, 'trigger.txt'), 'trigger');
    await writeFile(join(srcInner, 'target.txt'), 'new bytes');
    await writeFile(join(dstInner, 'target.txt'), 'old bytes');
    await writeFile(join(victimInner, 'target.txt'), 'victim bytes');
    const samePath = (a: unknown, b: string) =>
      typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
    const realCp = fsPromises.cp;
    const realReaddir = fsPromises.readdir;
    const realRename = fsPromises.rename;
    let swapped = false;
    // Whatever the directory order is, trigger.txt is copied first: the link
    // swap it performs must precede the staged copy of target.txt.
    const reorder = async (path: unknown, options: unknown): Promise<unknown> => {
      const entries = await (realReaddir as (...args: unknown[]) => Promise<unknown>)(
        path,
        options,
      );
      if (samePath(path, srcInner) && Array.isArray(entries)) {
        (entries as { name: string }[]).sort(
          (a, b) => Number(b.name === 'trigger.txt') - Number(a.name === 'trigger.txt'),
        );
      }
      return entries;
    };
    t.mock.method(fsPromises, 'readdir', reorder as unknown as typeof fsPromises.readdir);
    t.mock.method(
      fsPromises,
      'cp',
      async (source: unknown, destination: string, options: unknown) => {
        if (samePath(source, join(srcInner, 'trigger.txt'))) {
          await (realCp as (...args: unknown[]) => Promise<void>)(source, destination, options);
          if (!swapped) {
            swapped = true;
            await realRename(dstInner, `${dstInner}.gone`);
            await fsPromises.symlink(victimInner, dstInner, 'junction');
          }
          return;
        }
        return (realCp as (...args: unknown[]) => Promise<void>)(source, destination, options);
      },
    );
    syncBuiltinESMExports();
    try {
      const result = await move({
        moves: [{ source: srcDir, destination: dstDir }],
        copy: true,
        overwrite: true,
      });
      assert.strictEqual(result.isError, true, 'the swapped destination must be refused');
      assert.strictEqual(await readFile(join(victimInner, 'target.txt'), 'utf-8'), 'victim bytes');
      assert.strictEqual(
        (await readdir(victimInner)).some((entry) => entry.includes('.tmp')),
        false,
        'no staging may be created outside the roots',
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it('a merged copy matches the plain copy: new files, nested merges, links, timestamps', async (t) => {
    const srcDir = join(root, 'merge_ok_src');
    const dstDir = join(root, 'merge_ok_dst');
    const linkTarget = await writeTestFile(root, 'merge_ok_target.txt', 'target bytes');
    await mkdir(join(srcDir, 'nested'), { recursive: true });
    await mkdir(join(dstDir, 'nested'), { recursive: true });
    const link = join(srcDir, 'link');
    if (
      !(await trySymlink(linkTarget, link, () => t.skip('symlink creation not permitted'), 'file'))
    )
      return;
    await writeFile(join(srcDir, 'over.txt'), 'new over');
    await writeFile(join(srcDir, 'added.txt'), 'added');
    await writeFile(join(srcDir, 'nested', 'deep_over.txt'), 'new deep');
    await writeFile(join(srcDir, 'nested', 'deep_new.txt'), 'deep new');
    await writeFile(join(dstDir, 'over.txt'), 'old over');
    await writeFile(join(dstDir, 'untouched.txt'), 'kept');
    await writeFile(join(dstDir, 'nested', 'deep_over.txt'), 'old deep');
    // Everything on the source side is stamped 2001, everything on the
    // destination side now: what survives must say where it came from.
    const oldTime = new Date('2001-02-03T04:05:06.000Z');
    for (const p of [
      srcDir,
      join(srcDir, 'nested'),
      join(srcDir, 'over.txt'),
      join(srcDir, 'added.txt'),
      join(srcDir, 'nested', 'deep_over.txt'),
      join(srcDir, 'nested', 'deep_new.txt'),
    ]) {
      await utimes(p, oldTime, oldTime);
    }

    const result = await move({
      moves: [{ source: srcDir, destination: dstDir }],
      copy: true,
      overwrite: true,
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(join(dstDir, 'over.txt'), 'utf-8'), 'new over');
    assert.strictEqual(await readFile(join(dstDir, 'added.txt'), 'utf-8'), 'added');
    assert.strictEqual(
      await readFile(join(dstDir, 'nested', 'deep_over.txt'), 'utf-8'),
      'new deep',
    );
    assert.strictEqual(await readFile(join(dstDir, 'nested', 'deep_new.txt'), 'utf-8'), 'deep new');
    assert.strictEqual(await readFile(join(dstDir, 'untouched.txt'), 'utf-8'), 'kept');
    assert.strictEqual(await readFile(linkTarget, 'utf-8'), 'target bytes');
    const copiedLink = await lstat(join(dstDir, 'link'));
    assert.strictEqual(copiedLink.isSymbolicLink(), true, 'the link is copied as a link');
    assert.strictEqual(await readlink(join(dstDir, 'link')), linkTarget);
    // fs.cp keeps the source's times on everything it touches, including the
    // existing merged directories themselves.
    const keptTime = async (p: string) =>
      assert.strictEqual((await stat(p)).mtimeMs, oldTime.getTime(), p);
    await keptTime(join(dstDir, 'over.txt'));
    await keptTime(join(dstDir, 'added.txt'));
    await keptTime(join(dstDir, 'nested', 'deep_over.txt'));
    await keptTime(join(dstDir, 'nested', 'deep_new.txt'));
    await keptTime(join(dstDir, 'nested'));
    await keptTime(dstDir);
  });

  it('a merged copy still refuses a source directory landing on an existing file', async () => {
    const srcDir = join(root, 'merge_dir_src');
    const dstDir = join(root, 'merge_dir_dst');
    await mkdir(join(srcDir, 'conflict'), { recursive: true });
    await mkdir(dstDir, { recursive: true });
    await writeFile(join(srcDir, 'conflict', 'inside.txt'), 'inside');
    await writeFile(join(dstDir, 'conflict'), 'an existing file, not a directory');

    const result = await move({
      moves: [{ source: srcDir, destination: dstDir }],
      copy: true,
      overwrite: true,
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(
      await readFile(join(dstDir, 'conflict'), 'utf-8'),
      'an existing file, not a directory',
    );
    assert.strictEqual(
      (await readdir(dstDir)).some((entry) => entry.includes('.tmp')),
      false,
      'a refusal must not leave staging behind',
    );
  });

  it('a merged copy still refuses a source file landing on an existing directory', async () => {
    const srcDir = join(root, 'merge_file_src');
    const dstDir = join(root, 'merge_file_dst');
    await mkdir(srcDir, { recursive: true });
    await mkdir(join(dstDir, 'conflict.txt'), { recursive: true });
    await writeFile(join(srcDir, 'conflict.txt'), 'a file, not a directory');
    await writeFile(join(dstDir, 'conflict.txt', 'inside.txt'), 'kept');

    const result = await move({
      moves: [{ source: srcDir, destination: dstDir }],
      copy: true,
      overwrite: true,
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(await readFile(join(dstDir, 'conflict.txt', 'inside.txt'), 'utf-8'), 'kept');
  });

  it('refuses a merged copy whose destination tree contains a path-denied file', async () => {
    await withEnv({ FS_DENYLIST: 'merged-dst/secret.txt' }, async () => {
      const own = await createTestRoot();
      try {
        const ownFs = new GuardedFileSystem(await makeGuard([own]));
        const srcDir = join(own, 'src');
        const dstDir = join(own, 'merged-dst');
        await mkdir(srcDir, { recursive: true });
        await mkdir(dstDir, { recursive: true });
        await writeFile(join(srcDir, 'secret.txt'), 'top secret\n');
        await writeFile(join(srcDir, 'plain.txt'), 'plain\n');
        await writeFile(join(dstDir, 'secret.txt'), 'old secret\n');

        const result = await move(
          { moves: [{ source: srcDir, destination: dstDir }], copy: true, overwrite: true },
          { fs: ownFs },
        );
        assert.strictEqual(result.isError, true);
        const failure = result.structured.failures?.[0]?.error;
        assert.strictEqual(failure?.code, 'ACCESS_DENIED');
        assert.match(failure?.message ?? '', /protected/i);
        assert.strictEqual(await readFile(join(dstDir, 'secret.txt'), 'utf-8'), 'old secret\n');
        assert.strictEqual(await readFile(join(srcDir, 'secret.txt'), 'utf-8'), 'top secret\n');
        await assert.rejects(access(join(dstDir, 'plain.txt')), 'the denial must stop the copy');
      } finally {
        await cleanupTestRoot(own);
      }
    });
  });

  it('a forced file copy replaces the destination with the source bytes, mode and timestamps', async () => {
    const src = await writeTestFile(root, 'copy_place_src.txt', 'placed bytes');
    const dst = await writeTestFile(root, 'copy_place_dst.txt', 'old bytes');
    await chmod(src, 0o604);
    const mtime = new Date('2001-02-03T04:05:06.000Z');
    await utimes(src, mtime, mtime);

    const result = await move({
      moves: [{ source: src, destination: dst }],
      copy: true,
      overwrite: true,
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(dst, 'utf-8'), 'placed bytes');
    const placed = await stat(dst);
    assert.strictEqual(placed.mtimeMs, mtime.getTime());
    if (process.platform !== 'win32') {
      assert.strictEqual(placed.mode & 0o7777, 0o604);
    }
    assert.strictEqual(
      (await readdir(root)).some((entry) => entry.includes('.tmp')),
      false,
      'the staging directory must be gone',
    );
  });

  it('copies a symlink over an existing file as before: the link reads through to its target', async (t) => {
    const target = await writeTestFile(root, 'copy_link_target.txt', 'target bytes');
    const link = join(root, 'copy_link');
    if (!(await trySymlink(target, link, () => t.skip('symlink creation not permitted'), 'file')))
      return;
    const dst = await writeTestFile(root, 'copy_link_dst.txt', 'old bytes');

    const result = await move({
      moves: [{ source: link, destination: dst }],
      copy: true,
      overwrite: true,
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual((await lstat(dst)).isSymbolicLink(), false);
    assert.strictEqual(await readFile(dst, 'utf-8'), 'target bytes');
    assert.strictEqual(await readFile(target, 'utf-8'), 'target bytes');
    assert.strictEqual(
      (await readdir(root)).some((entry) => entry.includes('.tmp')),
      false,
    );
  });

  it('copies a single file and leaves the source in place', async () => {
    const src = await writeTestFile(root, 'copy_src.txt', 'copy content');
    const dst = join(root, 'copy_dst.txt');

    const result = await move({ moves: [{ source: src, destination: dst }], copy: true });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(src, 'utf-8'), 'copy content');
    assert.strictEqual(await readFile(dst, 'utf-8'), 'copy content');
  });

  it('fails NOT_FOUND naming the source when it does not exist', async () => {
    for (const copy of [false, true]) {
      const src = join(root, `missing_src_${String(copy)}.txt`);
      const dst = join(root, `missing_dst_${String(copy)}.txt`);
      const result = await move({ moves: [{ source: src, destination: dst }], copy });

      assert.strictEqual(result.isError, true);
      const failures = result.structured.failures ?? [];
      assert.strictEqual(failures.length, 1);
      assert.strictEqual(failures[0]?.error.code, 'NOT_FOUND');
      assert.strictEqual(failures[0]?.error.path, src);
      assert.doesNotMatch(failures[0]?.error.suggestion ?? '', /list_roots/);
    }
  });

  it('moves a dangling symlink as the link itself', async (t) => {
    const link = join(root, 'move_dangling_link');
    const dst = join(root, 'move_dangling_link_moved');
    const target = join(root, 'move_dangling_gone.txt');
    if (!(await trySymlink(target, link, () => t.skip('symlink creation not permitted'), 'file'))) {
      return;
    }

    const result = await move({ moves: [{ source: link, destination: dst }] });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual((await lstat(dst)).isSymbolicLink(), true);
    assert.strictEqual(await readlink(dst), target);
  });

  it('copies a directory recursively', async () => {
    const srcDir = join(root, 'copy_src_dir');
    const dstDir = join(root, 'copy_dst_dir');
    await writeTestFile(root, 'copy_src_dir/file1.txt', 'file1');
    await writeTestFile(root, 'copy_src_dir/sub/file2.txt', 'file2');

    const result = await move({ moves: [{ source: srcDir, destination: dstDir }], copy: true });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(join(dstDir, 'file1.txt'), 'utf-8'), 'file1');
    assert.strictEqual(await readFile(join(dstDir, 'sub', 'file2.txt'), 'utf-8'), 'file2');
  });

  it('refuses to copy an out-of-root source', async () => {
    const outsideFile = await writeTestFile(outside, 'outside_copy.txt', 'secret');
    const stolen = join(root, 'stolen.txt');
    const result = await move({
      moves: [{ source: outsideFile, destination: stolen }],
      copy: true,
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structured.failures?.[0]?.error.code, 'ACCESS_DENIED');
    await assert.rejects(access(stolen));
  });

  it('refuses, for move and copy alike, a destination inside the source directory', async () => {
    // `planTransfer` runs ONE containment guard for both ops; a directory moved
    // or copied into its own subtree recurses into itself.
    const srcDir = join(root, 'selfnest_src');
    await writeTestFile(root, 'selfnest_src/f.txt', 'x');
    const inside = join(srcDir, 'nested', 'target');

    for (const copy of [false, true]) {
      const label = `copy=${String(copy)}`;
      const result = await move({ moves: [{ source: srcDir, destination: inside }], copy });
      assert.strictEqual(result.isError, true, `${label} must be refused`);
      const failures = result.structured.failures ?? [];
      assert.strictEqual(failures.length, 1, `${label} reports one failure`);
      assert.strictEqual(failures[0]?.error.code, 'INVALID_INPUT', label);
      assert.match(failures[0]?.error.message ?? '', /own subdirectory/, label);
      await assert.rejects(access(inside), `${label} created nothing`);
    }
  });

  it('refuses a directory whose tree contains a path-denied file', async (t) => {
    // `secrets/**` is path-based: it denies secrets/x.txt but not public/x.txt,
    // so moving the directory used to carry the file out of the rule.
    await withEnv({ FS_DENYLIST: 'secrets/**,linked-secrets/**' }, async () => {
      const own = await createTestRoot();
      try {
        const ownFs = new GuardedFileSystem(await makeGuard([own]));
        const run = (args: MoveArgs) => move(args, { fs: ownFs });
        const failureOf = (result: MoveRun) => result.structured.failures?.[0]?.error;
        const secret = await writeTestFile(own, 'secrets/inner/x.txt', 'top secret\n');
        const plainDir = join(own, 'plain');
        await writeTestFile(own, 'plain/ok.txt', 'ok\n');

        for (const copy of [false, true]) {
          const label = `copy=${String(copy)}`;
          const result = await run({
            moves: [{ source: join(own, 'secrets'), destination: join(own, 'public') }],
            copy,
          });
          assert.strictEqual(result.isError, true, `${label} must be refused`);
          assert.strictEqual(failureOf(result)?.code, 'ACCESS_DENIED', label);
          assert.match(failureOf(result)?.message ?? '', /protected/i, label);
          await assert.rejects(access(join(own, 'public')), `${label} created nothing`);
          assert.strictEqual(await readFile(secret, 'utf-8'), 'top secret\n', label);
        }

        const linkedTarget = join(own, 'linked-target');
        await writeTestFile(own, 'linked-target/inner/x.txt', 'via symlink\n');
        const linkedSource = join(own, 'linked-secrets');
        if (
          await trySymlink(linkedTarget, linkedSource, () =>
            t.diagnostic('symlink not permitted; symlinked directory coverage skipped'),
          )
        ) {
          const copied = await run({
            moves: [{ source: linkedSource, destination: join(own, 'public-link') }],
            copy: true,
          });
          assert.strictEqual(copied.isError, true, 'symlink copy must be refused');
          assert.strictEqual(failureOf(copied)?.code, 'ACCESS_DENIED', 'symlink copy');
          assert.match(failureOf(copied)?.message ?? '', /protected/i, 'symlink copy');
          await assert.rejects(access(join(own, 'public-link')), 'symlink copy created nothing');
          assert.strictEqual(
            await readFile(join(linkedSource, 'inner/x.txt'), 'utf-8'),
            'via symlink\n',
          );

          const moved = await run({
            moves: [{ source: linkedSource, destination: join(own, 'public-link') }],
          });
          assert.notStrictEqual(moved.isError, true, 'symlink move must succeed');
          await access(join(own, 'public-link'));
          assert.strictEqual(
            await readFile(join(linkedTarget, 'inner/x.txt'), 'utf-8'),
            'via symlink\n',
            'symlink move left the linked target intact',
          );
        }

        const credentialsDir = join(own, 'credentials-dir');
        const credentials = await writeTestFile(own, 'credentials-dir/credentials', 'key\n');
        for (const copy of [false, true]) {
          const label = `destination copy=${String(copy)}`;
          const result = await run({
            moves: [{ source: credentialsDir, destination: join(own, '.aws') }],
            copy,
          });
          assert.strictEqual(result.isError, true, `${label} must be refused`);
          assert.strictEqual(failureOf(result)?.code, 'ACCESS_DENIED', label);
          assert.match(failureOf(result)?.message ?? '', /protected/i, label);
          await assert.rejects(access(join(own, '.aws')), `${label} created nothing`);
          assert.strictEqual(await readFile(credentials, 'utf-8'), 'key\n', label);
        }

        const proj = join(own, 'proj');
        await writeTestFile(own, 'proj/.env', 'SECRET=1\n');
        await writeTestFile(own, 'proj/app.ts', 'x\n');
        const envMove = await run({
          moves: [{ source: proj, destination: join(own, 'proj-moved') }],
        });
        assert.notStrictEqual(envMove.isError, true);
        assert.strictEqual(await readFile(join(own, 'proj-moved', 'app.ts'), 'utf-8'), 'x\n');
        await access(join(own, 'proj-moved', '.env'));
        const envRead = await runToolBodyResult(
          READ,
          { path: join(own, 'proj-moved', '.env') },
          { fs: ownFs },
        );
        assert.strictEqual(envRead.isError, true);

        // A clean tree still moves: the pre-walk must not refuse everything.
        const clean = await run({ moves: [{ source: plainDir, destination: join(own, 'moved') }] });
        assert.notStrictEqual(clean.isError, true);
        assert.strictEqual(await readFile(join(own, 'moved', 'ok.txt'), 'utf-8'), 'ok\n');
      } finally {
        await cleanupTestRoot(own);
      }
    });
  });

  describe('overwrite Confirmation', () => {
    for (const copy of [false, true]) {
      const op = copy ? 'copy' : 'move';

      it(`${op}: Skip leaves source and destination intact`, async () => {
        const src = await writeTestFile(root, `${op}_skip_src.txt`, 'new source');
        const dst = await writeTestFile(root, `${op}_skip_dst.txt`, 'existing dst');
        const asked: string[] = [];
        const result = await move(
          { moves: [{ source: src, destination: dst }], copy },
          {
            confirm: (prompt) => {
              asked.push(prompt.message);
              assert.deepStrictEqual(prompt.choices, ['overwrite', 'skip']);
              return { action: 'accept', content: { choice: 'skip' } };
            },
          },
        );
        assert.notStrictEqual(result.isError, true);
        assert.strictEqual(asked.length, 1);
        assert.match(asked[0] ?? '', /already exists/);
        assert.strictEqual(result.structured.moves.length, 0);
        assert.ok(result.structured.skipped?.includes(dst));
        assert.match(result.text ?? '', /SKIPPED/);
        assert.strictEqual(await readFile(src, 'utf-8'), 'new source');
        assert.strictEqual(await readFile(dst, 'utf-8'), 'existing dst');
      });

      it(`${op}: an approved overwrite replaces the destination`, async () => {
        const src = await writeTestFile(root, `${op}_ow_src.txt`, 'new source');
        const dst = await writeTestFile(root, `${op}_ow_dst.txt`, 'existing dst');
        const result = await move(
          { moves: [{ source: src, destination: dst }], copy },
          { confirm: choose('overwrite') },
        );
        assert.notStrictEqual(result.isError, true);
        assert.strictEqual(result.rounds, 1);
        assert.strictEqual(result.structured.moves.length, 1);
        assert.strictEqual(result.structured.skipped, undefined);
        assert.strictEqual(await readFile(dst, 'utf-8'), 'new source');
        if (copy) assert.strictEqual(await readFile(src, 'utf-8'), 'new source');
        else await assert.rejects(access(src));
      });

      it(`${op}: a declined overwrite is CANCELLED and changes nothing`, async () => {
        const src = await writeTestFile(root, `${op}_decline_src.txt`, 'new source');
        const dst = await writeTestFile(root, `${op}_decline_dst.txt`, 'existing dst');
        // A refused pair cancels the call; the executor answers it as a tool error.
        await assert.rejects(
          move(
            { moves: [{ source: src, destination: dst }], copy },
            { confirm: () => ({ action: 'decline' }) },
          ),
          { code: 'CANCELLED', message: /overwrite of .* was declined by the user/ },
        );
        assert.strictEqual(await readFile(src, 'utf-8'), 'new source');
        assert.strictEqual(await readFile(dst, 'utf-8'), 'existing dst');
      });
    }

    it('cancels a destination replaced again while the prompt was open', async () => {
      const src = await writeTestFile(root, 'replaced_src.txt', 'new source');
      const dst = await writeTestFile(root, 'replaced_dst.txt', 'v1');
      let calls = 0;
      const run = move(
        { moves: [{ source: src, destination: dst }] },
        {
          confirm: async () => {
            calls += 1;
            // Swapped once before each answer: the reprompt shows the new entry,
            // and a second swap after it is refused rather than overwritten.
            await mkdir(join(root, 'swap'), { recursive: true });
            const swapped = join(root, 'swap', `v${String(calls)}`);
            await writeFile(swapped, `v${String(calls + 1)}`);
            await rename(swapped, dst);
            return { action: 'accept', content: { choice: 'overwrite' } };
          },
        },
      );
      await assert.rejects(run, {
        code: 'CANCELLED',
        message: /replaced again while the prompt was open/,
      });
      assert.strictEqual(calls, 2, 'asked, then asked again about the swapped entry');
      assert.strictEqual(await readFile(src, 'utf-8'), 'new source');
    });
  });

  // H3 (2026-10 bug hunt): an overlapping move batch is refused with no data loss.
  describe('overlapping batches', () => {
    it('refuses a swap [A->B, B->A] and both files survive', async () => {
      const a = await writeTestFile(root, 'swapA', 'AAA\n');
      const b = await writeTestFile(root, 'swapB', 'BBB\n');
      const result = await move({
        moves: [
          { source: a, destination: b },
          { source: b, destination: a },
        ],
      });
      assert.strictEqual(result.isError, true, 'a doomed swap is a total failure');
      assert.strictEqual(await readFile(a, 'utf-8'), 'AAA\n');
      assert.strictEqual(await readFile(b, 'utf-8'), 'BBB\n');
    });

    it('refuses a chain [B->C, A->B] and destroys no file', async () => {
      const a = await writeTestFile(root, 'chainA', 'AAA\n');
      const b = await writeTestFile(root, 'chainB', 'BBB\n');
      const c = join(root, 'chainC');
      const result = await move({
        moves: [
          { source: b, destination: c },
          { source: a, destination: b },
        ],
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(await readFile(a, 'utf-8'), 'AAA\n');
      assert.strictEqual(await readFile(b, 'utf-8'), 'BBB\n');
      await assert.rejects(readFile(c, 'utf-8'), 'C must never be created');
    });

    it('still runs independent moves in one batch', async () => {
      const x = await writeTestFile(root, 'indX', 'X\n');
      const y = await writeTestFile(root, 'indY', 'Y\n');
      const result = await move({
        moves: [
          { source: x, destination: join(root, 'indX2') },
          { source: y, destination: join(root, 'indY2') },
        ],
      });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(await readFile(join(root, 'indX2'), 'utf-8'), 'X\n');
      assert.strictEqual(await readFile(join(root, 'indY2'), 'utf-8'), 'Y\n');
    });
  });
});

describe('relocation walk', () => {
  let root: string;
  let outside: string;
  before(async () => {
    root = await createTestRoot();
    outside = await createTestRoot();
  });
  after(async () => {
    await cleanupTestRoot(root);
    await cleanupTestRoot(outside);
  });

  const guardFor = async (readOnlyDirs: string[] = []): Promise<PathGuard> => {
    const guard = new PathGuard({ cliAllowedDirs: [root], readOnlyDirs });
    await guard.recomputeAllowedDirectories();
    return guard;
  };

  it('checks no entry on disk when the destination is missing', async (t) => {
    const guard = await guardFor();
    const spy = t.mock.method(guard, 'validateTransferPathForWrite');
    for (const n of ['1', '2', '3']) await writeTestFile(root, `pkg/${n}.txt`, n);
    await new GuardedFileSystem(guard).planTransfer('move', {
      source: join(root, 'pkg'),
      destination: join(root, 'a', 'b', 'pkg2'),
    });
    assert.strictEqual(spy.mock.callCount(), 0);
  });

  it('still refuses an entry landing in a read-only folder', async () => {
    const guard = await guardFor([join(root, 'out', 'pkg2', 'sub')]);
    const x = await writeTestFile(root, 'ro/sub/x.txt', 'x');
    await assert.rejects(
      new GuardedFileSystem(guard).planTransfer('move', {
        source: join(root, 'ro'),
        destination: join(root, 'out', 'pkg2'),
      }),
      { code: 'ACCESS_DENIED' },
    );
    await access(x);
  });

  it('still refuses when an entry would change protection', async () => {
    const guard = await guardFor();
    await writeTestFile(root, '.aws/credentials', 'key');
    await assert.rejects(
      new GuardedFileSystem(guard).planTransfer('move', {
        source: join(root, '.aws'),
        destination: join(root, 'plain'),
      }),
      { code: 'ACCESS_DENIED' },
    );
  });

  it('keeps the full check for a copy into an existing folder', async (t) => {
    const guard = await guardFor();
    const spy = t.mock.method(guard, 'validateTransferPathForWrite');
    for (const n of ['1', '2']) await writeTestFile(root, `cp/${n}.txt`, n);
    await mkdir(join(root, 'cpdest'));
    await new GuardedFileSystem(guard).planTransfer('copy', {
      source: join(root, 'cp'),
      destination: join(root, 'cpdest'),
    });
    assert.strictEqual(spy.mock.callCount(), 2);
  });

  it('refuses a merge through a link in the destination', async (t) => {
    const guard = await guardFor();
    await writeTestFile(root, 'mg/sub/x.txt', 'x');
    await mkdir(join(root, 'mgdest'));
    if (!(await trySymlink(outside, join(root, 'mgdest', 'sub'), () => t.skip('no symlinks')))) {
      return;
    }
    await assert.rejects(
      new GuardedFileSystem(guard).planTransfer('copy', {
        source: join(root, 'mg'),
        destination: join(root, 'mgdest'),
      }),
      { code: 'ACCESS_DENIED' },
    );
  });
});
