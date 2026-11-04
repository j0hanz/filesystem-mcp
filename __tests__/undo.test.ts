import type { Client } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import fsModule, {
  rename as fsRename,
  link,
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, type TestContext } from 'node:test';

import type * as z from 'zod/v4';

import { ErrorCode, type Problem } from '../src/core/errors.ts';
import { pathLabel } from '../src/core/fmt.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import type { PathGuard } from '../src/core/path.ts';
import type { PathCapture, UndoCapture, UndoRecord } from '../src/core/undo.ts';
import type { UndoEntry } from '../src/core/undo.ts';
import {
  NOT_RECORDING,
  plannedMkdirChain,
  restoreEntry,
  UndoJournal,
  UndoPreview,
} from '../src/core/undo.ts';
import { sha256Hex } from '../src/core/util.ts';
import type { FilesystemServerContext } from '../src/server.ts';
import { CREATE } from '../src/tools/create.ts';
import type { DefinedToolOf } from '../src/tools/define.ts';
import { DELETE } from '../src/tools/delete.ts';
import { EDIT } from '../src/tools/edit.ts';
import { MOVE } from '../src/tools/move.ts';
import { UNDO } from '../src/tools/undo.ts';
import {
  cleanupTestRoot,
  copyVia,
  createElicitationClientPair,
  createStdioClient,
  createTestClientPair,
  createTestHttpHarness,
  createTestRoot,
  createTestServer,
  fsErrorMatcher,
  makeGuard,
  trySymlink,
  withEnv,
} from './helpers.ts';
import { choose, runToolBodyResult, type ToolBodyOptions } from './tool-harness.ts';

type UndoArgs = z.input<typeof UNDO.def.input>;
interface UndoStep {
  readonly id: string;
  readonly tool: string;
  readonly results: readonly { path: string; error?: { code: string; message: string } }[];
  readonly truncated?: true;
  readonly totalResults?: number;
}
type UndoRun = Awaited<ReturnType<typeof runToolBodyResult<typeof UNDO.def.input, object>>> & {
  readonly structured: { readonly steps: readonly UndoStep[] };
};

const writeRecord = (size: number): UndoRecord => ({
  op: 'write',
  path: `/x${String(size)}`,
  bytes: Buffer.alloc(size),
  mode: 0o644,
  expect: null,
});

type WriteRecord = Extract<UndoRecord, { op: 'write' }>;
type RemoveRecord = Extract<UndoRecord, { op: 'remove' }>;
type RenameRecord = Extract<UndoRecord, { op: 'rename' }>;
const isWrite = (r: UndoRecord | undefined): r is WriteRecord => r?.op === 'write';
const isRemove = (r: UndoRecord | undefined): r is RemoveRecord => r?.op === 'remove';
const isRename = (r: UndoRecord | undefined): r is RenameRecord => r?.op === 'rename';

describe('UndoJournal', () => {
  it('returns 4-char ids and newest(n) newest first', (t) => {
    t.mock.method(Date, 'now', () => 0);
    const journal = new UndoJournal(1024 * 1024);
    const first = journal.add('edit', [writeRecord(1)]);
    const second = journal.add('edit', [writeRecord(1)]);
    const third = journal.add('edit', [writeRecord(1)]);
    for (const id of [first, second, third]) assert.match(id, /^[a-z0-9]{4}$/);
    const newestTwo = journal.newest(2);
    assert.deepStrictEqual(
      newestTwo.map((e) => e.id),
      [third, second],
    );
    assert.strictEqual(journal.newest(Infinity)[0]?.id, third);
  });

  it('the 65th add evicts the oldest', () => {
    const journal = new UndoJournal(1024 * 1024);
    const ids: string[] = [];
    for (let i = 0; i < 65; i++) ids.push(journal.add('edit', [writeRecord(1)]));
    assert.ok(ids[0] && ids[1]);
    assert.strictEqual(journal.get(ids[0]), undefined);
    assert.ok(journal.get(ids[1]));
    assert.strictEqual(journal.newest(Infinity).length, 64);
    assert.strictEqual(journal.newest(Infinity).at(-1)?.id, ids[1]);
  });

  it('a byte cap keeps only the newest entries', () => {
    // One 6-byte record weighs 518 (512 overhead + bytes): two do not fit in 520.
    const journal = new UndoJournal(520);
    const older = journal.add('edit', [writeRecord(6)]);
    const newer = journal.add('edit', [writeRecord(6)]);
    assert.strictEqual(journal.get(older), undefined);
    assert.ok(journal.get(newer));
  });

  it('entries expire after 30 minutes', (t) => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const journal = new UndoJournal(1024 * 1024);
    const id = journal.add('edit', [writeRecord(1)]);
    now = 29 * 60 * 1000;
    assert.ok(journal.get(id));
    now = 30 * 60 * 1000;
    assert.strictEqual(journal.get(id), undefined);
    assert.deepStrictEqual(journal.newest(Infinity), []);
  });

  it('replaceRecords keeps position; empty records delete the entry', (t) => {
    t.mock.method(Date, 'now', () => 0);
    const journal = new UndoJournal(1024 * 1024);
    const first = journal.add('edit', [writeRecord(1)]);
    const second = journal.add('edit', [writeRecord(1)]);
    const kept = [writeRecord(2)];
    journal.replaceRecords(first, kept);
    assert.strictEqual(journal.get(first)?.records, kept);
    assert.deepStrictEqual(
      journal.newest(Infinity).map((e) => e.id),
      [second, first],
    );
    journal.replaceRecords(second, []);
    assert.strictEqual(journal.get(second), undefined);
  });

  it('a maxBytes of 0 disables the journal', () => {
    assert.strictEqual(new UndoJournal(0).enabled, false);
    assert.strictEqual(new UndoJournal(1).enabled, true);
  });

  it('a ninth concurrent capture is undoable', () => {
    const journal = new UndoJournal(1024 * 1024);
    const caps = Array.from({ length: 9 }, () => journal.beginCapture());
    assert.ok(caps.every((c) => c.unavailableReason() === undefined));
    for (const c of caps) c.release();
  });

  it('an abandoned capture keeps its charge until release', () => {
    // One reserve of 2000 charges 2512 (512 record overhead).
    const journal = new UndoJournal(4096);
    const one = journal.beginCapture();
    assert.ok(one.reserve(2000));
    assert.strictEqual(one.reserve(2000), false);
    assert.strictEqual(one.unavailableReason(), 'too large to keep for undo');
    const two = journal.beginCapture();
    assert.strictEqual(two.reserve(2000), false);
    one.release();
    two.release();
    const three = journal.beginCapture();
    assert.ok(three.reserve(2000));
    three.release();
  });

  it('an abandoned capture frees the bytes of the records it dropped', () => {
    // A pushed record holds 2512 (2000 bytes + 512 overhead) and no reservation.
    const journal = new UndoJournal(4096);
    const big = journal.beginCapture();
    assert.ok(big.reserve(2000));
    big.push(writeRecord(2000));
    assert.strictEqual(big.reserve(2000), false);
    const small = journal.beginCapture();
    assert.ok(small.reserve(1200));
    big.release();
    small.release();
  });
});

describe('UndoCapture via GuardedFileSystem', () => {
  let tmpDir: string;
  let ctx: FilesystemServerContext;

  before(async () => {
    tmpDir = await createTestRoot();
    ctx = await createTestServer([tmpDir]);
  });

  after(async () => {
    if (ctx) {
      ctx.disposeRuntimeState();
      await ctx.mcp.close();
    }
    if (tmpDir) {
      await cleanupTestRoot(tmpDir);
    }
  });

  const capture = () => new UndoJournal(32 * 1024 * 1024).beginCapture();
  const makeFs = (cap: UndoCapture) => new GuardedFileSystem(ctx.pathGuard, cap);

  it('an overwrite pushes write with the old bytes and the new hash', async () => {
    const file = join(tmpDir, 'overwrite.txt');
    await writeFile(file, 'old-content');
    const cap = capture();
    const fs = makeFs(cap);
    await fs.writeFile(file, 'new-content');
    await rm(file);
    assert.strictEqual(cap.unavailableReason(), undefined);
    const rec = cap.records[0];
    if (!isWrite(rec)) assert.fail('expected a write record');
    assert.strictEqual(rec.bytes.toString('utf8'), 'old-content');
    assert.strictEqual(rec.expect, sha256Hex('new-content'));
  });

  it('a new file pushes remove', async () => {
    const file = join(tmpDir, 'new-file.txt');
    const cap = capture();
    const fs = makeFs(cap);
    await fs.writeFile(file, 'fresh');
    const rec = cap.records[0];
    if (!isRemove(rec)) assert.fail('expected a remove record');
    assert.strictEqual(rec.expect, sha256Hex('fresh'));
  });

  it('append on an existing file pushes write with the combined hash', async () => {
    const file = join(tmpDir, 'append.txt');
    await writeFile(file, 'abc');
    const cap = capture();
    const fs = makeFs(cap);
    await fs.appendFile(file, 'def');
    const rec = cap.records[0];
    if (!isWrite(rec)) assert.fail('expected a write record');
    assert.strictEqual(rec.bytes.toString('utf8'), 'abc');
    assert.strictEqual(rec.expect, sha256Hex('abcdef'));
  });

  it('mkdir -p a/b/c pushes 3 rmdir, top-down', async () => {
    await mkdir(join(tmpDir, 'deep'), { recursive: true });
    const cap = capture();
    const fs = makeFs(cap);
    await fs.mkdir(join(tmpDir, 'deep', 'a', 'b', 'c'), { recursive: true });
    assert.deepStrictEqual(
      cap.records.map((r) => r.op),
      ['rmdir', 'rmdir', 'rmdir'],
    );
    const paths = cap.records.map((r) => (r as { path: string }).path);
    assert.ok(paths[0]?.endsWith(join('deep', 'a')));
    assert.ok(paths[2]?.endsWith(join('deep', 'a', 'b', 'c')));
  });

  it('recursive rm of a tree pushes post-order records', async (t) => {
    const tree = join(tmpDir, 'tree');
    await mkdir(join(tree, 'sub'), { recursive: true });
    await writeFile(join(tree, 'f.txt'), 'leaf');
    if (
      !(await trySymlink(
        join(tree, 'f.txt'),
        join(tree, 'link.txt'),
        () => t.skip('symlink not permitted'),
        'file',
      ))
    ) {
      return;
    }
    const cap = capture();
    const fs = makeFs(cap);
    await fs.rm(tree, { recursive: true, force: true });
    assert.strictEqual(cap.unavailableReason(), undefined);
    const ops = cap.records.map((r) => r.op);
    // post-order: children of sub (none), sub, then tree's files/link, then tree
    assert.ok(ops.includes('write'));
    assert.ok(ops.includes('symlink'));
    assert.ok(ops.includes('mkdir'));
    const last = cap.records.at(-1);
    assert.strictEqual(last?.op, 'mkdir');
    // every record under the tree root precedes the root's mkdir
    const rootMkdirs = cap.records.filter((r) => r.op === 'mkdir');
    assert.strictEqual(rootMkdirs.length, 2);
  });

  it('a tree containing .env abandons with contains protected files', async () => {
    const tree = join(tmpDir, 'protected-tree');
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, '.env'), 'SECRET=1');
    const cap = capture();
    const fs = makeFs(cap);
    await fs.rm(tree, { recursive: true, force: true });
    assert.strictEqual(cap.unavailableReason(), 'protected-tree: contains protected files');
    assert.deepStrictEqual(cap.records, []);
  });

  it('a budget of 3 bytes with a 4-byte file abandons', async () => {
    const file = join(tmpDir, 'big.txt');
    await writeFile(file, 'abcd');
    const cap = new UndoJournal(3).beginCapture();
    const fs = makeFs(cap);
    await fs.writeFile(file, 'x');
    assert.ok(cap.unavailableReason() !== undefined);
    assert.deepStrictEqual(cap.records, []);
  });

  it('records carry overhead: empty entries still count against the budget', async () => {
    const tree = join(tmpDir, 'empty-entries');
    await mkdir(join(tree, 'sub'), { recursive: true });
    for (let i = 0; i < 5; i++) await writeFile(join(tree, `e${i}.txt`), '');
    // 7 records (5 empty files, sub, tree) cost 7 * 512 overhead: over 3 KiB.
    const cap = new UndoJournal(3 * 1024).beginCapture();
    const fs = makeFs(cap);
    await fs.rm(tree, { recursive: true, force: true });
    assert.strictEqual(cap.unavailableReason(), 'empty-entries: too many changes to keep for undo');
    assert.deepStrictEqual(cap.records, []);
  });

  it('POSIX only: a tree containing a FIFO refuses capture, not silent omission', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX only');
      return;
    }
    const { spawnSync } = await import('node:child_process');
    const tree = join(tmpDir, 'fifo-tree');
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, 'ok.txt'), 'keep');
    const mk = spawnSync('mkfifo', [join(tree, 'pipe.fifo')]);
    if (mk.error !== undefined) {
      t.skip('mkfifo not available');
      return;
    }
    const cap = capture();
    const fs = makeFs(cap);
    await fs.rm(tree, { recursive: true, force: true });
    assert.strictEqual(cap.unavailableReason(), 'fifo-tree: cannot capture a non-regular entry');
    assert.deepStrictEqual(cap.records, []);
  });

  it('cp abandons with copies are not undoable yet', async () => {
    const src = join(tmpDir, 'cp-src.txt');
    const dest = join(tmpDir, 'cp-dest.txt');
    await writeFile(src, 'cp');
    const cap = capture();
    const fs = makeFs(cap);
    await copyVia(fs, src, dest);
    assert.strictEqual(cap.unavailableReason(), 'copies are not undoable yet');
  });

  it('after an abandon, mutations run but record nothing, and the first reason wins', async () => {
    const src = join(tmpDir, 'pin-src.txt');
    const mid = join(tmpDir, 'pin-mid.txt');
    await writeFile(src, 'src');
    await writeFile(mid, 'mid');
    const cap = capture();
    const fs = makeFs(cap);
    await copyVia(fs, src, join(tmpDir, 'pin-dest.txt')); // abandons: copies are not undoable yet
    await fs.writeFile(mid, 'replaced'); // the mutation runs; nothing is recorded
    await fs.rename(mid, src); // overwrites src; nothing is recorded
    assert.strictEqual((await lstat(src)).size, 8); // the write and rename both ran
    await fs.rm(src); // snapshotTree skips; nothing is recorded
    assert.strictEqual(cap.unavailableReason(), 'copies are not undoable yet');
    assert.deepStrictEqual(cap.records, []);
  });

  it('POSIX only: overwriting a 0o200 file succeeds and abandons', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX only');
      return;
    }
    if (process.getuid?.() === 0) {
      t.skip('root bypasses the 0200 mode bits');
      return;
    }
    const file = join(tmpDir, 'write-only.txt');
    await writeFile(file, 'hidden');
    await import('node:fs/promises').then((m) => m.chmod(file, 0o200));
    const cap = capture();
    const fs = makeFs(cap);
    await fs.writeFile(file, 'replacement');
    assert.strictEqual(cap.unavailableReason(), 'write-only.txt: could not read the old content');
    await import('node:fs/promises').then((m) => m.chmod(file, 0o644));
  });

  it('POSIX only: overwriting a FIFO abandons the capture', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX only');
      return;
    }
    const { spawnSync } = await import('node:child_process');
    const fifo = join(tmpDir, 'pipe.fifo');
    const mk = spawnSync('mkfifo', [fifo]);
    if (mk.error !== undefined) {
      t.skip('mkfifo not available');
      return;
    }
    const cap = capture();
    const fs = makeFs(cap);
    await fs.writeFile(fifo, 'replacement');
    assert.strictEqual(
      cap.unavailableReason(),
      'pipe.fifo: cannot capture a write over a non-regular file',
    );
  });

  it('win32 only: deleting a directory link whose target is gone abandons', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('win32 only');
      return;
    }
    const target = join(tmpDir, 'link-target-gone');
    const link = join(tmpDir, 'dir-link');
    const fsPromises = await import('node:fs/promises');
    await fsPromises.mkdir(target);
    await fsPromises.symlink(target, link, 'junction');
    await fsPromises.rm(target, { recursive: true });
    const cap = capture();
    const fs = makeFs(cap);
    await fs.rm(link);
    assert.strictEqual(
      cap.unavailableReason(),
      'dir-link: could not type a link whose target is gone',
    );
  });

  it('a file over the budget costs only its own undo and returns its charge', async () => {
    const big = join(tmpDir, 'over-budget.txt');
    const small = join(tmpDir, 'after-big.txt');
    await writeFile(big, 'x'.repeat(4000));
    await writeFile(small, 'old');
    const cap = new UndoJournal(2000).beginCapture();
    const fs = makeFs(cap);
    await fs.writeFile(big, 'new');
    await fs.writeFile(small, 'new');
    assert.strictEqual(cap.unavailableReason(), 'over-budget.txt: too large to keep for undo');
    assert.deepStrictEqual(
      cap.records.map((r) => r.op === 'write' && pathLabel(r.path)),
      ['after-big.txt'],
    );
    cap.release();
  });

  it('a refused write that never ran reports nothing', async () => {
    const big = join(tmpDir, 'never-written.txt');
    await writeFile(big, 'x'.repeat(4000));
    const cap = new UndoJournal(2000).beginCapture();
    await assert.rejects(makeFs(cap).writeFile(big, 'new', { signal: AbortSignal.abort() }));
    assert.strictEqual(cap.unavailableReason(), undefined);
    assert.deepStrictEqual(cap.records, []);
    assert.strictEqual(await readFile(big, 'utf8'), 'x'.repeat(4000));
    cap.release();
  });

  it('a write that fails part-way reports only that file', async () => {
    const kept = join(tmpDir, 'partway-kept.txt');
    const linked = join(tmpDir, 'partway-linked.txt');
    await writeFile(kept, 'old');
    await writeFile(linked, 'old');
    await link(linked, join(tmpDir, 'partway-other-name.txt')); // nlink > 1 writes in place
    const cap = capture();
    const fs = makeFs(cap);
    await fs.writeFile(kept, 'new');
    // Not a string or Buffer: handle.writeFile throws after the truncate.
    await assert.rejects(fs.writeFile(linked, 42 as unknown as string));
    assert.strictEqual(cap.unavailableReason(), 'partway-linked.txt: the write failed part-way');
    assert.deepStrictEqual(
      cap.records.map((r) => r.op === 'write' && pathLabel(r.path)),
      ['partway-kept.txt'],
    );
    cap.release();
  });

  it('undo keeps a folder a refused entry still uses, and removes what survivors made', async () => {
    const folder = join(tmpDir, 'shared-new', 'sub');
    const a = join(folder, 'a.txt');
    const b = join(folder, 'b.txt');
    // 2 rmdir + remove a = 1536 bytes; remove b would make 2048.
    const cap = new UndoJournal(1600).beginCapture();
    const fs = makeFs(cap);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(a, 'a');
    await fs.writeFile(b, 'b');
    assert.strictEqual(cap.unavailableReason(), 'b.txt: too many changes to keep for undo');
    const records = cap.journalRecords();
    assert.deepStrictEqual(
      records.map((r) => r.op),
      ['remove'],
    );

    const entry = { id: 'x', tool: 'create', createdAt: 0, records };
    const plain = new GuardedFileSystem(ctx.pathGuard);
    const preview = await restoreEntry(entry, plain, { dryRun: true });
    const real = await restoreEntry(entry, plain, { dryRun: false });
    assert.deepStrictEqual(
      preview.results.map((r) => pathLabel(r.path)),
      ['a.txt'],
    );
    assert.deepStrictEqual(
      real.results.map((r) => pathLabel(r.path)),
      ['a.txt'],
    );
    assert.deepStrictEqual(real.remaining, []);
    await assert.rejects(readFile(a, 'utf8'));
    assert.strictEqual(await readFile(b, 'utf8'), 'b');
    cap.release();
  });

  it('journalRecords drops every record that would change a refused path', () => {
    const refusedPath = join(tmpDir, 'refused-record.txt');
    const other = join(tmpDir, 'other-record.txt');
    const identity = { dev: 0n, ino: 0n, birthtimeNs: 0n };
    const records: UndoRecord[] = [
      { op: 'remove', path: refusedPath, expect: 'x' },
      { op: 'write', path: refusedPath, bytes: Buffer.alloc(1), mode: 0o644, expect: null },
      { op: 'rename', from: other, to: refusedPath, identity },
      { op: 'remove', path: other, expect: 'x' },
    ];
    const cap = capture();
    const saved = cap.forPath(other);
    saved.push(...records);
    saved.commit();
    const refused = cap.forPath(refusedPath);
    refused.abandon('no');
    refused.commit();
    assert.deepStrictEqual(cap.journalRecords(), [{ op: 'remove', path: other, expect: 'x' }]);
    cap.release();
  });

  it('a file written twice, then refused, has no record left to undo', async () => {
    const file = join(tmpDir, 'written-twice.txt');
    const big = 'x'.repeat(4000);
    const cap = new UndoJournal(2000).beginCapture();
    const fs = makeFs(cap);
    await fs.writeFile(file, big);
    await fs.writeFile(file, big);
    assert.strictEqual(cap.unavailableReason(), 'written-twice.txt: too large to keep for undo');
    assert.deepStrictEqual(cap.journalRecords(), []);
    cap.release();
  });

  it('a refused file then written again does not go back to the refused write', async () => {
    const file = join(tmpDir, 'refused-then-saved.txt');
    await writeFile(file, 'x'.repeat(4000));
    const cap = new UndoJournal(2000).beginCapture();
    const fs = makeFs(cap);
    await fs.writeFile(file, 'small');
    await fs.writeFile(file, 'smaller');
    assert.strictEqual(
      cap.unavailableReason(),
      'refused-then-saved.txt: too large to keep for undo',
    );
    assert.deepStrictEqual(cap.journalRecords(), []);
    cap.release();
  });

  describe('when the file handle will not close', () => {
    const failClose = (t: TestContext): (() => void) => {
      const realOpen = fsModule.open.bind(fsModule);
      t.mock.method(fsModule, 'open', async (...args: Parameters<typeof fsModule.open>) => {
        const handle = await realOpen(...args);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          throw new Error('close failed');
        };
        return handle;
      });
      syncBuiltinESMExports();
      return () => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      };
    };

    it('a refused in-place write still reports', async (t) => {
      const file = join(tmpDir, 'close-write.txt');
      await writeFile(file, 'x'.repeat(4000));
      await link(file, join(tmpDir, 'close-write-twin.txt'));
      const cap = new UndoJournal(2000).beginCapture();
      const restore = failClose(t);
      await assert.rejects(makeFs(cap).writeFile(file, 'new'), /close failed/u);
      restore();
      assert.strictEqual(await readFile(file, 'utf8'), 'new');
      assert.strictEqual(cap.unavailableReason(), 'close-write.txt: too large to keep for undo');
      cap.release();
    });

    it('a refused append still reports', async (t) => {
      const file = join(tmpDir, 'close-append.txt');
      await writeFile(file, 'x'.repeat(4000));
      const cap = new UndoJournal(2000).beginCapture();
      const restore = failClose(t);
      await assert.rejects(makeFs(cap).appendFile(file, 'more'), /close failed/u);
      restore();
      assert.ok((await readFile(file, 'utf8')).endsWith('more'));
      assert.strictEqual(cap.unavailableReason(), 'close-append.txt: too large to keep for undo');
      cap.release();
    });

    it('an append that made a file keeps its one record', async (t) => {
      const file = join(tmpDir, 'close-append-new.txt');
      const cap = capture();
      const restore = failClose(t);
      await assert.rejects(makeFs(cap).appendFile(file, 'new'), /close failed/u);
      restore();
      assert.strictEqual(await readFile(file, 'utf8'), 'new');
      assert.strictEqual(cap.unavailableReason(), undefined);
      assert.deepStrictEqual(
        cap.records.map((r) => r.op),
        ['remove'],
      );
      cap.release();
    });
  });

  it('journalRecords does not depend on which path committed first', () => {
    const dir = join(tmpDir, 'order');
    const file = join(dir, 'refused.txt');
    for (const refusedFirst of [true, false]) {
      const cap = new UndoJournal(1024 * 1024).beginCapture();
      const survivor = cap.forPath(dir);
      survivor.push({ op: 'rmdir', path: dir });
      const refused = cap.forPath(file);
      refused.abandon('no');
      for (const own of refusedFirst ? [refused, survivor] : [survivor, refused]) own.commit();
      assert.deepStrictEqual(cap.journalRecords(), []);
      cap.release();
    }
  });

  it('every mutation works with no capture', async () => {
    const fs = new GuardedFileSystem(ctx.pathGuard);
    const dir = join(tmpDir, 'plain', 'deep');
    const file = join(dir, 'f.txt');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, 'one');
    await fs.writeFile(file, 'two');
    await fs.appendFile(file, '!');
    assert.strictEqual(await readFile(file, 'utf8'), 'two!');
    await fs.rm(file);
    await fs.rmdir(dir);
    await assert.rejects(lstat(dir));
  });

  it('a directories entry keeps its folder when a file under it is refused', async () => {
    const folder = join(tmpDir, 'dirs-entry');
    // rmdir + one remove = 1024 bytes; the second remove would make 1536.
    const cap = new UndoJournal(1100).beginCapture();
    await runToolBodyResult(
      CREATE,
      {
        directories: [folder],
        files: [
          { path: join(folder, 'a.txt'), content: 'a' },
          { path: join(folder, 'b.txt'), content: 'b' },
        ],
      },
      { fs: makeFs(cap) },
    );
    assert.match(cap.unavailableReason() ?? '', /^[ab]\.txt: too many changes to keep for undo$/u);
    assert.deepStrictEqual(
      cap.journalRecords().map((r) => r.op),
      ['remove'],
    );
    cap.release();
  });

  it('an append that fails part-way reports only that entry', async () => {
    const kept = join(tmpDir, 'append-kept.txt');
    const log = join(tmpDir, 'append-partway.txt');
    await writeFile(log, 'old');
    const cap = capture();
    const fs = makeFs(cap);
    await fs.writeFile(kept, 'k');
    // Not a string: handle.writeFile throws, inside the write.
    await assert.rejects(fs.appendFile(log, 42 as unknown as string));
    assert.strictEqual(cap.unavailableReason(), 'append-partway.txt: the append failed part-way');
    assert.strictEqual(cap.records.length, 1);
    cap.release();
  });

  it('an append that made a file and removed it again costs nothing', async () => {
    const fresh = join(tmpDir, 'append-new-partway.txt');
    const cap = capture();
    await assert.rejects(makeFs(cap).appendFile(fresh, 42 as unknown as string));
    assert.strictEqual(cap.unavailableReason(), undefined);
    await assert.rejects(readFile(fresh, 'utf8'));
    cap.release();
  });

  it('an append cancelled before its write reports nothing', async () => {
    const log = join(tmpDir, 'append-cancelled.txt');
    await writeFile(log, 'old');
    // Passes the check before the open, then reports aborted: the window before the write.
    let checks = 0;
    const signal = {
      throwIfAborted() {
        if (++checks > 1) throw new DOMException('aborted', 'AbortError');
      },
    } as unknown as AbortSignal;
    const cap = capture();
    await assert.rejects(makeFs(cap).appendFile(log, 'x', { signal }));
    assert.strictEqual(checks, 2);
    assert.strictEqual(cap.unavailableReason(), undefined);
    assert.strictEqual(await readFile(log, 'utf8'), 'old');
    cap.release();
  });

  it('a move that replaced a directory costs only its own undo', async () => {
    const src = join(tmpDir, 'src-dir');
    const dest = join(tmpDir, 'dest-dir');
    const keep = join(tmpDir, 'keep.txt');
    const kept = join(tmpDir, 'kept.txt');
    await mkdir(src);
    await mkdir(dest);
    await writeFile(keep, 'keep');
    const cap = capture();
    // Windows refuses a rename onto a directory, so clear what POSIX would replace.
    const fs = new GuardedFileSystem(ctx.pathGuard, cap, {
      rename: async (a, b) => {
        await rm(b, { recursive: true, force: true });
        await fsRename(a, b);
      },
    });
    await fs.rename(src, dest);
    await fs.rename(keep, kept);
    assert.strictEqual(cap.unavailableReason(), 'dest-dir: move replaced a directory');
    const records = cap.journalRecords();
    assert.deepStrictEqual(
      records.map((r) => r.op === 'rename' && pathLabel(r.from)),
      ['keep.txt'],
    );
    cap.release();

    const restored = await restoreEntry(
      { id: 'x', tool: 'move', createdAt: 0, records },
      new GuardedFileSystem(ctx.pathGuard),
      { dryRun: false },
    );
    assert.deepStrictEqual(restored.remaining, []);
    assert.strictEqual(await readFile(keep, 'utf8'), 'keep');
    assert.ok((await lstat(dest)).isDirectory(), 'the refused move stays where it went');
  });

  it('a destination that cannot be read costs only that move its undo', async () => {
    class UnreadableOld extends GuardedFileSystem {
      override readSaved(): Promise<Buffer> {
        return Promise.reject(Object.assign(new Error('EIO: fake'), { code: 'EIO' }));
      }
    }
    const a = join(tmpDir, 'unread-a.txt');
    const existing = join(tmpDir, 'unread-existing.txt');
    const c = join(tmpDir, 'unread-c.txt');
    const d = join(tmpDir, 'unread-d.txt');
    await writeFile(a, 'a');
    await writeFile(existing, 'old');
    await writeFile(c, 'c');
    const cap = capture();
    const fs = new UnreadableOld(ctx.pathGuard, cap);
    await fs.rename(a, existing);
    await fs.rename(c, d);
    assert.strictEqual(
      cap.unavailableReason(),
      'unread-existing.txt: could not read the old content',
    );
    assert.deepStrictEqual(
      cap.records.map((r) => r.op === 'rename' && pathLabel(r.from)),
      ['unread-c.txt'],
    );
    cap.release();
  });

  it('a moved entry that cannot be inspected costs only that move its undo', async () => {
    const a = join(tmpDir, 'gone-a.txt');
    const b = join(tmpDir, 'gone-b.txt');
    const c = join(tmpDir, 'gone-c.txt');
    const d = join(tmpDir, 'gone-d.txt');
    await writeFile(a, 'a');
    await writeFile(c, 'c');
    let first = true;
    const cap = capture();
    const fs = new GuardedFileSystem(ctx.pathGuard, cap, {
      rename: async (from, to) => {
        await fsRename(from, to);
        if (first) await rm(to);
        first = false;
      },
    });
    await fs.rename(a, b);
    await fs.rename(c, d);
    assert.strictEqual(cap.unavailableReason(), 'gone-b.txt: could not inspect the moved entry');
    assert.deepStrictEqual(
      cap.records.map((r) => r.op === 'rename' && pathLabel(r.from)),
      ['gone-c.txt'],
    );
    cap.release();
  });

  it('a move that fails after a refusal reports nothing', async () => {
    const a = join(tmpDir, 'failing-a.txt');
    const b = join(tmpDir, 'failing-b.txt');
    await writeFile(a, 'a');
    await writeFile(b, 'x'.repeat(4000));
    const cap = new UndoJournal(2000).beginCapture();
    const fs = new GuardedFileSystem(ctx.pathGuard, cap, {
      rename: () => Promise.reject(Object.assign(new Error('EACCES: fake'), { code: 'EACCES' })),
    });
    await assert.rejects(fs.rename(a, b));
    assert.strictEqual(cap.unavailableReason(), undefined);
    assert.deepStrictEqual(cap.records, []);
    cap.release();
  });

  it('undo still refuses a moved entry that changed, in a partial move', async () => {
    const a = join(tmpDir, 'partial-a.txt');
    const b = join(tmpDir, 'partial-b.txt');
    const c = join(tmpDir, 'partial-c.txt');
    const d = join(tmpDir, 'partial-d.txt');
    await writeFile(a, 'a');
    await writeFile(c, 'c');
    await writeFile(d, 'x'.repeat(4000));
    const journal = new UndoJournal(2000);
    const cap = journal.beginCapture();
    await runToolBodyResult(
      MOVE,
      {
        moves: [
          { source: a, destination: b },
          { source: c, destination: d },
        ],
      },
      {
        fs: new GuardedFileSystem(ctx.pathGuard, cap),
        confirm: choose('overwrite'),
        undoJournal: journal,
      },
    );
    assert.strictEqual(cap.unavailableReason(), 'partial-d.txt: too large to keep for undo');
    const id = journal.add('move', cap.journalRecords());
    cap.release();

    await rm(b);
    await writeFile(b, 'someone else');
    const undone = (await runToolBodyResult(
      UNDO,
      { id },
      { fs: new GuardedFileSystem(ctx.pathGuard), undoJournal: journal },
    )) as UndoRun;
    const results = undone.structured.steps[0]?.results ?? [];
    assert.deepStrictEqual(
      results.map((r) => pathLabel(r.path)),
      ['partial-a.txt'],
    );
    assert.match(results[0]?.error?.message ?? '', /Not restored/u);
    assert.strictEqual(await readFile(b, 'utf8'), 'someone else');
    assert.strictEqual(await readFile(d, 'utf8'), 'c');
  });

  it('a folder chain that cannot be inspected costs only that folder, and names it', async () => {
    const cap = capture();
    const refused = cap.forPath(join(tmpDir, 'sub'));
    // A NUL makes lstat reject on every platform.
    assert.deepStrictEqual(await plannedMkdirChain(refused, join(tmpDir, 'bad\0name')), []);
    refused.commit();
    const kept = cap.forPath(join(tmpDir, 'other'));
    kept.push({ op: 'rmdir', path: join(tmpDir, 'other') });
    kept.commit();
    assert.strictEqual(cap.unavailableReason(), 'sub: could not inspect the parent folders');
    assert.strictEqual(cap.records.length, 1);
    cap.release();
  });

  it('a move records the exact file id, so batch siblings stay apart', async () => {
    const from = join(tmpDir, 'exact-id-a.txt');
    const to = join(tmpDir, 'exact-id-b.txt');
    await writeFile(from, 'x');
    const cap = capture();
    await makeFs(cap).rename(from, to);
    const exact = await lstat(to, { bigint: true });
    assert.deepStrictEqual(cap.records.find(isRename)?.identity, {
      dev: exact.dev,
      ino: exact.ino,
      birthtimeNs: exact.birthtimeNs,
    });
  });

  it('rename of a.txt to A.txt pushes exactly one rename record', async (t) => {
    const lower = join(tmpDir, 'case-a.txt');
    const upper = join(tmpDir, 'case-A.txt');
    await writeFile(lower, 'same');
    // Probe case sensitivity: on a case-sensitive filesystem, upper is absent.
    const probe = await import('node:fs/promises').then((m) =>
      m.stat(upper).then(
        () => undefined,
        () => 'absent',
      ),
    );
    if (probe === 'absent') {
      t.skip('case-sensitive filesystem');
      return;
    }
    const cap = capture();
    const fs = makeFs(cap);
    await fs.rename(lower, upper);
    assert.strictEqual(cap.records.length, 1);
    const rec = cap.records[0];
    if (!isRename(rec)) assert.fail('expected a rename record');
    await rm(upper);
  });
});

describe('forMutation settles every exit', () => {
  const path = join('/root', 'a');
  const record: UndoRecord = { op: 'rmdir', path: join(path, 'x') };
  const body =
    (fn: (own: PathCapture) => void) =>
    (own: PathCapture): Promise<void> => {
      fn(own);
      return Promise.resolve();
    };
  const boom = new Error('boom');

  it('returns what run returns', async () => {
    const cap = new UndoJournal(1024 * 1024).beginCapture();
    assert.strictEqual(await cap.forMutation(path, () => Promise.resolve(7)), 7);
    cap.release();
  });

  const exits: {
    name: string;
    run: (own: PathCapture) => void;
    rejects: boolean;
    records: number;
    reason: string | undefined;
  }[] = [
    {
      name: 'no change',
      run: (o) => {
        o.push(record);
      },
      rejects: false,
      records: 0,
      reason: undefined,
    },
    {
      name: 'throw before change',
      run: (o) => {
        o.push(record);
        throw boom;
      },
      rejects: true,
      records: 0,
      reason: undefined,
    },
    {
      name: 'abandon, then throw before change',
      run: (o) => {
        o.abandon('no');
        throw boom;
      },
      rejects: true,
      records: 0,
      reason: undefined,
    },
    {
      name: 'change',
      run: (o) => {
        o.push(record);
        o.changed();
      },
      rejects: false,
      records: 1,
      reason: undefined,
    },
    {
      name: 'throw after change keeps records',
      run: (o) => {
        o.push(record);
        o.changed();
        throw boom;
      },
      rejects: true,
      records: 1,
      reason: undefined,
    },
    {
      name: 'abandon and change report the path',
      run: (o) => {
        o.abandon('no');
        o.changed();
        throw boom;
      },
      rejects: true,
      records: 0,
      reason: 'a: no',
    },
    {
      name: 'a second change hands over once',
      run: (o) => {
        o.push(record);
        o.changed();
        o.changed();
      },
      rejects: false,
      records: 1,
      reason: undefined,
    },
  ];

  for (const { name, run, rejects, records, reason } of exits) {
    it(name, async () => {
      const cap = new UndoJournal(1024 * 1024).beginCapture();
      const settled = cap.forMutation(path, body(run));
      if (rejects) await assert.rejects(settled, boom);
      else await settled;
      assert.strictEqual(cap.records.length, records);
      assert.strictEqual(cap.unavailableReason(), reason);
      cap.release();
    });
  }

  it('returns a reservation to the pool when run throws', async () => {
    // reserve adds a record's overhead, so the budget leaves room for one such charge, not two.
    const journal = new UndoJournal(4000);
    const cap = journal.beginCapture();
    await assert.rejects(
      cap.forMutation(
        path,
        body((own) => {
          assert.ok(own.reserve(3000));
          throw boom;
        }),
      ),
      boom,
    );
    const probe = journal.beginCapture();
    assert.ok(probe.reserve(3000), 'the reservation came back');
    probe.release();
    cap.release();
  });

  it('keeps no records and no second reason when the call was abandoned mid-mutation', async () => {
    const cap = new UndoJournal(1024 * 1024).beginCapture();
    await cap.forMutation(
      path,
      body((own) => {
        own.push(record);
        cap.abandon('copies are not undoable yet');
        own.changed();
      }),
    );
    assert.strictEqual(cap.records.length, 0);
    assert.strictEqual(cap.unavailableReason(), 'copies are not undoable yet');
    cap.release();
  });

  it('NOT_RECORDING records nothing and never throws', () => {
    assert.strictEqual(NOT_RECORDING.recording, false);
    assert.strictEqual(NOT_RECORDING.reserve(1), false);
    NOT_RECORDING.abandon('no');
    NOT_RECORDING.push(record);
    NOT_RECORDING.changed();
    assert.strictEqual(NOT_RECORDING.unavailableReason(), undefined);
  });
});

describe('restoreEntry', () => {
  let tmpDir: string;
  let ctx: FilesystemServerContext;

  before(async () => {
    tmpDir = await createTestRoot();
    ctx = await createTestServer([tmpDir]);
  });

  after(async () => {
    if (ctx) {
      ctx.disposeRuntimeState();
      await ctx.mcp.close();
    }
    if (tmpDir) {
      await cleanupTestRoot(tmpDir);
    }
  });

  const newFs = () => new GuardedFileSystem(ctx.pathGuard);
  const captureOne = async (
    run: (fs: GuardedFileSystem) => Promise<unknown>,
  ): Promise<UndoEntry> => {
    const cap = new UndoJournal(32 * 1024 * 1024).beginCapture();
    const fs = new GuardedFileSystem(ctx.pathGuard, cap);
    await run(fs);
    assert.strictEqual(cap.unavailableReason(), undefined);
    return { id: 'test', tool: 'test', createdAt: Date.now(), records: cap.records };
  };
  const dryRunAll = async (entries: UndoEntry[]) => {
    const preview = new UndoPreview(newFs());
    const results = [];
    for (const entry of entries) {
      results.push(...(await restoreEntry(entry, newFs(), { dryRun: true, preview })).results);
    }
    return results;
  };

  it('overwrite, then restore, gives the old bytes back', async () => {
    const file = join(tmpDir, 'restore-overwrite.txt');
    await writeFile(file, 'before');
    const entry = await captureOne((fs) => fs.writeFile(file, 'after'));
    assert.strictEqual(
      await import('node:fs/promises').then((m) => m.readFile(file, 'utf8')),
      'after',
    );
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    assert.strictEqual(
      await import('node:fs/promises').then((m) => m.readFile(file, 'utf8')),
      'before',
    );
    assert.deepStrictEqual(outcome.remaining, []);
  });

  it('restore over a hardlinked file puts the old bytes back on every link', async (t) => {
    const file = join(tmpDir, 'restore-hardlink.txt');
    const twin = join(tmpDir, 'restore-hardlink-twin.txt');
    await writeFile(file, 'before');
    try {
      await link(file, twin);
    } catch {
      return t.skip('hard links not supported here');
    }
    const entry = await captureOne((fs) => fs.writeFile(file, 'after'));
    assert.strictEqual(await readFile(twin, 'utf8'), 'after');

    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });

    assert.deepStrictEqual(outcome.remaining, []);
    assert.strictEqual(await readFile(twin, 'utf8'), 'before');
    assert.strictEqual((await lstat(file)).nlink, 2);
  });

  it('a dry run across two hard-linked names previews both steps and writes nothing', async (t) => {
    const file = join(tmpDir, 'dry-hardlink.txt');
    const twin = join(tmpDir, 'dry-hardlink-twin.txt');
    await writeFile(file, 'A');
    try {
      await link(file, twin);
    } catch {
      return t.skip('hard links not supported here');
    }
    const aEntry = await captureOne((fs) => fs.writeFile(file, 'B'));
    const bEntry = await captureOne((fs) => fs.writeFile(twin, 'C'));
    assert.strictEqual(await readFile(twin, 'utf8'), 'C');

    const dry = await dryRunAll([bEntry, aEntry]); // newest first, as undo steps: 2

    assert.deepStrictEqual(
      dry.filter((r) => 'error' in r),
      [],
      dry.map((r) => ('error' in r ? r.error.message : 'ok')).join('\n'),
    );
    assert.strictEqual(await readFile(file, 'utf8'), 'C');
    assert.strictEqual(await readFile(twin, 'utf8'), 'C');
    assert.strictEqual((await lstat(file)).nlink, 2);
  });

  it('a write whose path already holds the saved bytes counts as restored', async () => {
    const file = join(tmpDir, 'already-restored.txt');
    await writeFile(file, 'A');
    const entry = await captureOne((fs) => fs.writeFile(file, 'B'));
    await writeFile(file, 'A');
    const dry = await dryRunAll([entry]);
    assert.deepStrictEqual(
      dry.filter((r) => 'error' in r),
      [],
    );
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    assert.deepStrictEqual(
      outcome.results.filter((r) => 'error' in r),
      [],
    );
    assert.deepStrictEqual(outcome.remaining, []);
  });

  it('a symlink to the saved bytes is still skipped', async (t) => {
    const file = join(tmpDir, 'link-restored.txt');
    const target = join(tmpDir, 'link-restored-target.txt');
    await writeFile(file, 'A');
    await writeFile(target, 'A');
    const entry = await captureOne((fs) => fs.writeFile(file, 'B'));
    await rm(file);
    if (!(await trySymlink(target, file, () => t.skip('symlinks unavailable'), 'file'))) return;
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    assert.strictEqual(outcome.results.filter((r) => 'error' in r).length, 1);
    assert.strictEqual(outcome.remaining.length, 1);
  });

  it('an outside write after capture is skipped as modified since', async () => {
    const file = join(tmpDir, 'restore-raced.txt');
    await writeFile(file, 'before');
    const entry = await captureOne((fs) => fs.writeFile(file, 'tool-write'));
    await writeFile(file, 'outside-write');
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    assert.strictEqual(
      await import('node:fs/promises').then((m) => m.readFile(file, 'utf8')),
      'outside-write',
    );
    const skipped = outcome.results.find(
      (r): r is { path: string; error: Problem } => 'error' in r,
    );
    assert.ok(skipped);
    assert.match(skipped.error.message, /modified since/);
  });

  it('a deleted tree comes back with bytes, mode, symlink and subdirectory', async (t) => {
    const tree = join(tmpDir, 'restore-tree');
    await mkdir(join(tree, 'sub'), { recursive: true });
    await writeFile(join(tree, 'f.txt'), 'leaf');
    if (
      !(await trySymlink(
        join(tree, 'f.txt'),
        join(tree, 'link.txt'),
        () => t.skip('symlink not permitted'),
        'file',
      ))
    ) {
      return;
    }
    const fsPromises = await import('node:fs/promises');
    if (process.platform !== 'win32') await fsPromises.chmod(join(tree, 'f.txt'), 0o600);
    const entry = await captureOne((fs) => fs.rm(tree, { recursive: true, force: true }));
    assert.strictEqual(
      await fsPromises.stat(join(tree, 'f.txt')).then(
        () => true,
        () => false,
      ),
      false,
    );
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    assert.strictEqual(await fsPromises.readFile(join(tree, 'f.txt'), 'utf8'), 'leaf');
    if (process.platform !== 'win32') {
      assert.strictEqual((await fsPromises.stat(join(tree, 'f.txt'))).mode & 0o777, 0o600);
    }
    assert.strictEqual(await fsPromises.readlink(join(tree, 'link.txt')), join(tree, 'f.txt'));
    assert.ok((await fsPromises.stat(join(tree, 'sub'))).isDirectory());
    assert.deepStrictEqual(outcome.remaining, []);
  });

  it('a deleted directory comes back with its mode, never wider', async (t) => {
    if (process.platform === 'win32') {
      t.skip('directory mode bits are POSIX-only');
      return;
    }
    const fsPromises = await import('node:fs/promises');
    const tree = join(tmpDir, 'private-tree');
    const empty = join(tmpDir, 'private-empty');
    await mkdir(join(tree, 'inner'), { recursive: true });
    await mkdir(empty);
    await fsPromises.chmod(tree, 0o700);
    await fsPromises.chmod(join(tree, 'inner'), 0o700);
    await fsPromises.chmod(empty, 0o700);
    const entry = await captureOne(async (fs) => {
      await fs.rm(tree, { recursive: true, force: true }); // snapshotTree path
      await fs.rmdir(empty); // GuardedFileSystem.rmdir path
    });
    await restoreEntry(entry, newFs(), { dryRun: false });
    assert.strictEqual((await fsPromises.stat(tree)).mode & 0o777, 0o700);
    assert.strictEqual((await fsPromises.stat(join(tree, 'inner'))).mode & 0o777, 0o700);
    assert.strictEqual((await fsPromises.stat(empty)).mode & 0o777, 0o700);
  });

  it('a restored directory keeps owner rwx so its children come back', async (t) => {
    if (process.platform === 'win32') {
      t.skip('directory mode bits are POSIX-only');
      return;
    }
    // A non-owner can delete a 0557 tree through the other-write bit; the
    // restore's mkdir then makes the server the owner of an owner-r-x folder.
    const fsPromises = await import('node:fs/promises');
    const dir = join(tmpDir, 'owner-narrow');
    const child = join(dir, 'f.txt');
    const entry: UndoEntry = {
      id: 'test',
      tool: 'test',
      createdAt: Date.now(),
      records: [
        { op: 'write', path: child, bytes: Buffer.from('kept'), mode: 0o644, expect: null },
        { op: 'mkdir', path: dir, mode: 0o557 },
      ],
    };
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    assert.deepStrictEqual(outcome.remaining, []);
    assert.strictEqual(await fsPromises.readFile(child, 'utf8'), 'kept');
    assert.strictEqual((await fsPromises.stat(dir)).mode & 0o700, 0o700);
  });

  it('a created file and its created parents are removed', async () => {
    const file = join(tmpDir, 'created-parents', 'a', 'new.txt');
    const entry = await captureOne(async (fs) => {
      await fs.mkdir(join(tmpDir, 'created-parents', 'a'), { recursive: true });
      await fs.writeFile(file, 'fresh');
    });
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    assert.strictEqual(
      await import('node:fs/promises').then((m) =>
        m.stat(file).then(
          () => true,
          () => false,
        ),
      ),
      false,
    );
    assert.strictEqual(
      await import('node:fs/promises').then((m) =>
        m.stat(join(tmpDir, 'created-parents')).then(
          () => true,
          () => false,
        ),
      ),
      false,
    );
    assert.deepStrictEqual(outcome.remaining, []);
  });

  it('a created parent that gained a new file stays, rmdir skipped', async () => {
    const parent = join(tmpDir, 'kept-parent', 'a');
    const entry = await captureOne(async (fs) => {
      await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(join(parent, 'tool-made.txt'), 'x');
    });
    await writeFile(join(parent, 'outsider.txt'), 'y');
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    const fsPromises = await import('node:fs/promises');
    assert.ok((await fsPromises.stat(parent)).isDirectory());
    assert.strictEqual(
      await fsPromises.stat(join(parent, 'tool-made.txt')).then(
        () => true,
        () => false,
      ),
      false,
      'the tool-made file must be removed',
    );
    const skippedRmdir = outcome.results.find(
      (r) => r.path.toLowerCase() === parent.toLowerCase() && 'error' in r,
    );
    assert.ok(skippedRmdir, 'the parent rmdir must be reported skipped');
  });

  it('a rename comes back', async () => {
    const from = join(tmpDir, 'rename-from.txt');
    const to = join(tmpDir, 'rename-to.txt');
    await writeFile(from, 'payload');
    const entry = await captureOne((fs) => fs.rename(from, to));
    assert.strictEqual(
      await import('node:fs/promises').then((m) =>
        m.stat(from).then(
          () => true,
          () => false,
        ),
      ),
      false,
    );
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    assert.strictEqual(
      await import('node:fs/promises').then((m) => m.readFile(from, 'utf8')),
      'payload',
    );
    assert.deepStrictEqual(outcome.remaining, []);
  });

  it('a rename over an existing file restores both', async () => {
    const from = join(tmpDir, 'rename-over-from.txt');
    const to = join(tmpDir, 'rename-over-to.txt');
    await writeFile(from, 'incoming');
    await writeFile(to, 'clobbered-old');
    const entry = await captureOne((fs) => fs.rename(from, to));
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    const fsPromises = await import('node:fs/promises');
    assert.strictEqual(await fsPromises.readFile(to, 'utf8'), 'clobbered-old');
    assert.strictEqual(await fsPromises.readFile(from, 'utf8'), 'incoming');
    assert.deepStrictEqual(outcome.remaining, []);
  });

  it('dryRun writes nothing and reports the same per-path outcomes', async () => {
    // case (d): a created file in created parents
    const file = join(tmpDir, 'dry-run-parents', 'a', 'new.txt');
    const entry = await captureOne(async (fs) => {
      await fs.mkdir(join(tmpDir, 'dry-run-parents', 'a'), { recursive: true });
      await fs.writeFile(file, 'fresh');
    });
    const dry = await restoreEntry(entry, newFs(), { dryRun: true });
    const fsPromises = await import('node:fs/promises');
    assert.strictEqual(
      await fsPromises.stat(file).then(
        () => true,
        () => false,
      ),
      true,
      'dry run must not remove anything',
    );
    const fileResult = dry.results.find((r) => r.path.toLowerCase() === file.toLowerCase());
    assert.ok(fileResult && 'value' in fileResult && fileResult.value.restored);
    // case (g): a rename over an existing file
    const from = join(tmpDir, 'dry-rename-from.txt');
    const to = join(tmpDir, 'dry-rename-to.txt');
    await writeFile(from, 'incoming');
    await writeFile(to, 'clobbered-old');
    const entry2 = await captureOne((fs) => fs.rename(from, to));
    const dry2 = await restoreEntry(entry2, newFs(), { dryRun: true });
    assert.strictEqual(
      await fsPromises.readFile(to, 'utf8'),
      'incoming',
      'dry run must not touch bytes',
    );
    const fromResult = dry2.results.find((r) => r.path.toLowerCase() === from.toLowerCase());
    const toResult = dry2.results.find((r) => r.path.toLowerCase() === to.toLowerCase());
    assert.ok(fromResult && 'value' in fromResult && fromResult.value.restored);
    assert.ok(toResult && 'value' in toResult && toResult.value.restored);
  });

  it('a file whose parent was also deleted is FAILED and stays in remaining', async () => {
    const tree = join(tmpDir, 'restore-failed-tree');
    await mkdir(tree, { recursive: true });
    const file = join(tree, 'gone.txt');
    await writeFile(file, 'data');
    const entry = await captureOne((fs) => fs.rm(tree, { recursive: true, force: true }));
    // Drop the tree's own mkdir record so the parent is missing at restore.
    entry.records = entry.records.filter((r) => r.op !== 'mkdir');
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    const failed = outcome.results.find((r) => 'error' in r);
    assert.ok(failed?.error, 'must report a failure, not throw');
    assert.ok(outcome.remaining.length > 0);
  });

  it('a skipped move-over retries in dependency order once from is free', async () => {
    const from = join(tmpDir, 'retry-from.txt');
    const to = join(tmpDir, 'retry-to.txt');
    await writeFile(from, 'incoming');
    await writeFile(to, 'clobbered-old');
    const entry = await captureOne((fs) => fs.rename(from, to));
    // Occupy `from` so both records skip: the rename has nowhere to go and
    // the overwritten file is still in place at `to`.
    await writeFile(from, 'squatter');
    const first = await restoreEntry(entry, newFs(), { dryRun: false });
    assert.strictEqual(first.remaining.length, 2);
    await rm(from);
    // The retry must run the rename first, then write the old bytes back to
    // `to`; the reverse order leaves `to` missing until a third try.
    const retry = await restoreEntry({ ...entry, records: first.remaining }, newFs(), {
      dryRun: false,
    });
    const fsPromises = await import('node:fs/promises');
    assert.strictEqual(await fsPromises.readFile(from, 'utf8'), 'incoming');
    assert.strictEqual(await fsPromises.readFile(to, 'utf8'), 'clobbered-old');
    assert.deepStrictEqual(retry.remaining, []);
  });

  it('dry run: a write undone by an earlier-step rename still reports restored', async () => {
    const a = join(tmpDir, 'sim-edit-a.txt');
    const b = join(tmpDir, 'sim-edit-b.txt');
    await writeFile(a, 'v1');
    const entry = await captureOne(async (fs) => {
      await fs.writeFile(a, 'v2');
      await fs.rename(a, b);
    });
    const dry = await restoreEntry(entry, newFs(), { dryRun: true });
    assert.deepStrictEqual(
      dry.results.filter((r) => 'error' in r),
      [],
    );
  });

  it('an edit after a move: undoing both steps still moves the file back', async () => {
    const a = join(tmpDir, 'edit-after-move-a.txt');
    const b = join(tmpDir, 'edit-after-move-b.txt');
    await writeFile(a, 'v1');
    const journal = new UndoJournal();
    const moved = await captureOne((fs) => fs.rename(a, b));
    const edited = await captureOne((fs) => fs.writeFile(b, 'v2'));
    journal.add('move', moved.records);
    const onRewrite = (
      was: Parameters<UndoJournal['reidentify']>[0],
      identity: Parameters<UndoJournal['reidentify']>[1],
    ) => {
      journal.reidentify(was, identity);
    };
    const movedInJournal = journal.newest(Infinity)[0];
    assert.ok(movedInJournal);
    const second = await restoreEntry(edited, newFs(), { dryRun: false, onRewrite });
    const first = await restoreEntry(movedInJournal, newFs(), { dryRun: false });
    const fsPromises = await import('node:fs/promises');
    assert.deepStrictEqual([second.remaining, first.remaining], [[], []]);
    assert.strictEqual(await fsPromises.readFile(a, 'utf8'), 'v1');
  });

  it('an unrelated file that took the moved name is not adopted by the move', async () => {
    const a = join(tmpDir, 'adopt-a.txt');
    const b = join(tmpDir, 'adopt-b.txt');
    await writeFile(a, 'v1');
    const journal = new UndoJournal();
    const moved = await captureOne((fs) => fs.rename(a, b));
    const moveId = journal.add('move', moved.records);
    await rm(b);
    await writeFile(b, 'outsider');
    const edited = await captureOne((fs) => fs.writeFile(b, 'v2'));
    const onRewrite = (
      was: Parameters<UndoJournal['reidentify']>[0],
      identity: Parameters<UndoJournal['reidentify']>[1],
    ) => {
      journal.reidentify(was, identity);
    };
    await restoreEntry(edited, newFs(), { dryRun: false, onRewrite });
    const entry = journal.get(moveId);
    assert.ok(entry);
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    const fsPromises = await import('node:fs/promises');
    assert.strictEqual(outcome.remaining.length, 1);
    assert.strictEqual(await fsPromises.readFile(b, 'utf8'), 'outsider');
    await assert.rejects(fsPromises.stat(a));
  });

  it('a move chain survives an edit: three steps undo back to the start', async () => {
    const a = join(tmpDir, 'chain3-a.txt');
    const b = join(tmpDir, 'chain3-b.txt');
    const c = join(tmpDir, 'chain3-c.txt');
    await writeFile(a, 'v1');
    const journal = new UndoJournal();
    const ids = [
      journal.add('move', (await captureOne((fs) => fs.rename(a, b))).records),
      journal.add('move', (await captureOne((fs) => fs.rename(b, c))).records),
      journal.add('edit', (await captureOne((fs) => fs.writeFile(c, 'v2'))).records),
    ];
    const onRewrite = (
      was: Parameters<UndoJournal['reidentify']>[0],
      identity: Parameters<UndoJournal['reidentify']>[1],
    ) => {
      journal.reidentify(was, identity);
    };
    const remaining: number[] = [];
    for (const id of ids.reverse()) {
      const entry = journal.get(id);
      assert.ok(entry);
      remaining.push(
        (await restoreEntry(entry, newFs(), { dryRun: false, onRewrite })).remaining.length,
      );
    }
    const fsPromises = await import('node:fs/promises');
    assert.deepStrictEqual(remaining, [0, 0, 0]);
    assert.strictEqual(await fsPromises.readFile(a, 'utf8'), 'v1');
  });

  it('an append between a move and an edit: three steps undo back to the start', async () => {
    const a = join(tmpDir, 'append-chain-a.txt');
    const b = join(tmpDir, 'append-chain-b.txt');
    await writeFile(a, 'v1');
    const journal = new UndoJournal();
    const ids = [
      journal.add('move', (await captureOne((fs) => fs.rename(a, b))).records),
      // An append keeps the inode, so it saves the same identity the edit saves next.
      journal.add('append', (await captureOne((fs) => fs.appendFile(b, '+'))).records),
      journal.add('edit', (await captureOne((fs) => fs.writeFile(b, 'v2'))).records),
    ];
    const onRewrite = (
      was: Parameters<UndoJournal['reidentify']>[0],
      identity: Parameters<UndoJournal['reidentify']>[1],
    ) => {
      journal.reidentify(was, identity);
    };
    const remaining: number[] = [];
    for (const id of ids.reverse()) {
      const entry = journal.get(id);
      assert.ok(entry);
      remaining.push(
        (await restoreEntry(entry, newFs(), { dryRun: false, onRewrite })).remaining.length,
      );
    }
    const fsPromises = await import('node:fs/promises');
    assert.deepStrictEqual(remaining, [0, 0, 0]);
    assert.strictEqual(await fsPromises.readFile(a, 'utf8'), 'v1');
  });

  it('reserve charges before the read, so two captures cannot both pass the gate', () => {
    const journal = new UndoJournal(4096);
    const one = journal.beginCapture();
    const two = journal.beginCapture();
    assert.ok(one.reserve(2000));
    assert.strictEqual(two.reserve(2000), false);
    one.release();
    two.release();
  });

  it('a deleted moved directory: undoing both steps moves the new tree back', async () => {
    const a = join(tmpDir, 'dirmove-a');
    const b = join(tmpDir, 'dirmove-b');
    await mkdir(a, { recursive: true });
    await writeFile(join(a, 'f.txt'), 'inside');
    const journal = new UndoJournal();
    const moveId = journal.add('move', (await captureOne((fs) => fs.rename(a, b))).records);
    const delEntry = await captureOne((fs) => fs.rm(b, { recursive: true, force: true }));
    const onRewrite = (
      was: Parameters<UndoJournal['reidentify']>[0],
      identity: Parameters<UndoJournal['reidentify']>[1],
    ) => {
      journal.reidentify(was, identity);
    };
    const first = await restoreEntry(delEntry, newFs(), { dryRun: false, onRewrite });
    const moveEntry = journal.get(moveId);
    assert.ok(moveEntry);
    const second = await restoreEntry(moveEntry, newFs(), { dryRun: false, onRewrite });
    const fsPromises = await import('node:fs/promises');
    assert.deepStrictEqual([first.remaining, second.remaining], [[], []]);
    assert.strictEqual(await fsPromises.readFile(join(a, 'f.txt'), 'utf8'), 'inside');
  });

  it('dry run: a file edit inside a directory that was later moved previews as restored', async () => {
    const a = join(tmpDir, 'dryprefix-a');
    const b = join(tmpDir, 'dryprefix-b');
    await mkdir(a, { recursive: true });
    await writeFile(join(a, 'f.txt'), 'v1');
    const edited = await captureOne((fs) => fs.writeFile(join(a, 'f.txt'), 'v2'));
    const moved = await captureOne((fs) => fs.rename(a, b));
    const results = await dryRunAll([moved, edited]);
    assert.deepStrictEqual(
      results.filter((r) => 'error' in r),
      [],
    );
  });

  it('dry run: an edit inside a folder moved twice previews as restored', async () => {
    const a = join(tmpDir, 'twice-a');
    const b = join(tmpDir, 'twice-b');
    const c = join(tmpDir, 'twice-c');
    await mkdir(a, { recursive: true });
    await writeFile(join(a, 'f.txt'), 'v1');
    const edited = await captureOne((fs) => fs.writeFile(join(a, 'f.txt'), 'v2'));
    const first = await captureOne((fs) => fs.rename(a, b));
    const second = await captureOne((fs) => fs.rename(b, c));
    const results = await dryRunAll([second, first, edited]);
    assert.deepStrictEqual(
      results.filter((r) => 'error' in r),
      [],
    );
  });

  it('dry run does not remap a length-changing lowercase alias', async (t) => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      t.skip('case-insensitive filesystem required');
      return;
    }
    const from = join(tmpDir, 'unicode-İ');
    const to = join(tmpDir, 'unicode-moved');
    await mkdir(from, { recursive: true });
    await writeFile(join(from, 'f.txt'), 'before');
    const edited = await captureOne((fs) => fs.writeFile(join(from, 'f.txt'), 'after'));
    const moved = await captureOne((fs) => fs.rename(from, to));
    const aliasEntry: UndoEntry = {
      ...edited,
      records: edited.records.map((record) =>
        record.op === 'write'
          ? { ...record, path: join(tmpDir, 'unicode-i\u0307', 'f.txt') }
          : record,
      ),
    };
    const malformed = `${to}\u0307`;
    await mkdir(malformed, { recursive: true });
    await writeFile(join(malformed, 'f.txt'), 'after');

    const results = await dryRunAll([moved, aliasEntry]);
    assert.deepStrictEqual(
      results.filter((result) => 'error' in result).map((result) => result.path),
      [join(tmpDir, 'unicode-i\u0307', 'f.txt')],
    );
  });

  it('dry run across a case-only folder rename and a move previews as restored', async (t) => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      t.skip('case-insensitive filesystem required');
      return;
    }
    const lower = join(tmpDir, 'case-cd');
    const upper = join(tmpDir, 'CASE-CD');
    const away = join(tmpDir, 'case-away');
    await mkdir(lower, { recursive: true });
    await writeFile(join(lower, 'f.txt'), 'v1');
    const edited = await captureOne((fs) => fs.writeFile(join(lower, 'f.txt'), 'v2'));
    const recased = await captureOne((fs) => fs.rename(lower, upper));
    const moved = await captureOne((fs) => fs.rename(upper, away));
    const results = await dryRunAll([moved, recased, edited]);
    assert.deepStrictEqual(
      results.filter((r) => 'error' in r),
      [],
    );
  });

  it('dry run after an external case-only folder rename previews as restored', async (t) => {
    const lower = join(tmpDir, 'external-case-cd');
    const upper = join(tmpDir, 'EXTERNAL-CASE-CD');
    const away = join(tmpDir, 'external-case-away');
    await mkdir(lower, { recursive: true });
    await writeFile(join(lower, 'f.txt'), 'v1');
    const fsPromises = await import('node:fs/promises');
    const caseInsensitive = await fsPromises.stat(upper).then(
      () => true,
      () => false,
    );
    if (!caseInsensitive) {
      t.skip('case-insensitive filesystem required');
      return;
    }
    const edited = await captureOne((fs) => fs.writeFile(join(lower, 'f.txt'), 'v2'));
    await fsPromises.rename(lower, upper);
    const moved = await captureOne((fs) => fs.rename(upper, away));
    const results = await dryRunAll([moved, edited]);
    assert.deepStrictEqual(
      results.filter((r) => 'error' in r),
      [],
    );
  });

  it('an edit inside a folder moved twice restores for real', async () => {
    const a = join(tmpDir, 'twice-real-a');
    const b = join(tmpDir, 'twice-real-b');
    const c = join(tmpDir, 'twice-real-c');
    await mkdir(a, { recursive: true });
    await writeFile(join(a, 'f.txt'), 'v1');
    const edited = await captureOne((fs) => fs.writeFile(join(a, 'f.txt'), 'v2'));
    const first = await captureOne((fs) => fs.rename(a, b));
    const second = await captureOne((fs) => fs.rename(b, c));
    for (const entry of [second, first, edited]) {
      assert.deepStrictEqual((await restoreEntry(entry, newFs(), { dryRun: false })).remaining, []);
    }
    const fsPromises = await import('node:fs/promises');
    assert.strictEqual(await fsPromises.readFile(join(a, 'f.txt'), 'utf8'), 'v1');
  });

  it('dry run: a folder move inside a folder that was later moved previews as restored', async () => {
    const p = join(tmpDir, 'nested-p');
    const s = join(tmpDir, 'nested-s');
    await mkdir(join(p, 'q'), { recursive: true });
    await writeFile(join(p, 'q', 'f.txt'), 'v1');
    const inner = await captureOne((fs) => fs.rename(join(p, 'q'), join(p, 'r')));
    const outer = await captureOne((fs) => fs.rename(p, s));
    const results = await dryRunAll([outer, inner]);
    assert.deepStrictEqual(
      results.filter((r) => 'error' in r),
      [],
    );
  });

  it('dry run: a moved folder that a later delete removed previews as restored', async () => {
    const k = join(tmpDir, 'recreated-k');
    const m = join(tmpDir, 'recreated-m');
    await mkdir(k, { recursive: true });
    await writeFile(join(k, 'f.txt'), 'v1');
    const moved = await captureOne((fs) => fs.rename(k, m));
    const deleted = await captureOne((fs) => fs.rm(m, { recursive: true, force: true }));
    const results = await dryRunAll([deleted, moved]);
    assert.deepStrictEqual(
      results.filter((r) => 'error' in r),
      [],
    );
  });

  it('dry run does not use a replacement tree as backing for a recreated directory', async () => {
    const policyCtx = await withEnv({ FS_DENYLIST: '**/X/blocked.txt' }, () =>
      createTestServer([tmpDir]),
    );
    try {
      const capture = async (run: (fs: GuardedFileSystem) => Promise<unknown>) => {
        const cap = new UndoJournal(32 * 1024 * 1024).beginCapture();
        await run(new GuardedFileSystem(policyCtx.pathGuard, cap));
        assert.strictEqual(cap.unavailableReason(), undefined);
        return { id: 'test', tool: 'test', createdAt: Date.now(), records: cap.records };
      };
      const x = join(tmpDir, 'X');
      const p = join(tmpDir, 'P');
      const q = join(tmpDir, 'Q');
      assert.strictEqual(policyCtx.pathGuard.isSensitive(join(x, 'blocked.txt')), true);
      assert.strictEqual(policyCtx.pathGuard.isSensitive(join(p, 'blocked.txt')), false);
      await mkdir(x, { recursive: true });
      await writeFile(join(x, 'f.txt'), 'saved');
      const movedX = await capture((fs) => fs.rename(x, p));
      const deletedP = await capture((fs) => fs.rm(p, { recursive: true, force: true }));
      await mkdir(q, { recursive: true });
      await writeFile(join(q, 'blocked.txt'), 'not part of X');
      const movedQ = await capture((fs) => fs.rename(q, p));

      const policyFs = new GuardedFileSystem(policyCtx.pathGuard);
      const preview = new UndoPreview(policyFs);
      const results = [];
      for (const entry of [movedQ, deletedP, movedX]) {
        results.push(...(await restoreEntry(entry, policyFs, { dryRun: true, preview })).results);
      }
      assert.deepStrictEqual(
        results.filter((result) => 'error' in result),
        [],
      );
    } finally {
      policyCtx.disposeRuntimeState();
      await policyCtx.mcp.close();
    }
  });

  it('refuses to move a folder back when an entry added since would enter protection', async () => {
    const policyCtx = await withEnv({ FS_DENYLIST: '**/Guarded/blocked.txt' }, () =>
      createTestServer([tmpDir]),
    );
    try {
      const guarded = join(tmpDir, 'Guarded');
      const open = join(tmpDir, 'Open');
      await mkdir(guarded, { recursive: true });
      await writeFile(join(guarded, 'f.txt'), 'kept');
      const cap = new UndoJournal(32 * 1024 * 1024).beginCapture();
      await new GuardedFileSystem(policyCtx.pathGuard, cap).rename(guarded, open);
      const moved = { id: 'test', tool: 'test', createdAt: Date.now(), records: cap.records };
      await writeFile(join(open, 'blocked.txt'), 'added after the move');

      const policyFs = new GuardedFileSystem(policyCtx.pathGuard);
      const preview = new UndoPreview(policyFs);
      for (const options of [{ dryRun: true, preview }, { dryRun: false }]) {
        const { results } = await restoreEntry(moved, policyFs, options);
        assert.deepStrictEqual(
          results.map((result) => ('error' in result ? result.error.code : 'restored')),
          ['ACCESS_DENIED'],
          `dryRun=${String(options.dryRun)}`,
        );
      }
      await lstat(join(open, 'blocked.txt'));
    } finally {
      policyCtx.disposeRuntimeState();
      await policyCtx.mcp.close();
    }
  });

  it('an aborted restore returns every unprocessed record and touches nothing', async () => {
    const file = join(tmpDir, 'abort-restore.txt');
    await writeFile(file, 'v1');
    const entry = await captureOne((fs) => fs.writeFile(file, 'v2'));
    const outcome = await restoreEntry(entry, newFs(), {
      dryRun: false,
      signal: AbortSignal.abort(),
    });
    const fsPromises = await import('node:fs/promises');
    assert.deepStrictEqual(outcome.results, []);
    assert.strictEqual(outcome.remaining.length, entry.records.length);
    assert.strictEqual(await fsPromises.readFile(file, 'utf8'), 'v2');
  });

  it('a skipped directory restore does not restore its children through a symlink', async (t) => {
    const tree = join(tmpDir, 'swapped-tree');
    const elsewhere = join(tmpDir, 'swapped-elsewhere');
    await mkdir(tree, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(tree, 'file.txt'), 'saved');
    const entry = await captureOne((fs) => fs.rm(tree, { recursive: true, force: true }));
    if (!(await trySymlink(elsewhere, tree, () => t.skip('symlink not permitted')))) return;
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    const fsPromises = await import('node:fs/promises');
    assert.deepStrictEqual(await fsPromises.readdir(elsewhere), []);
    assert.strictEqual(outcome.remaining.length, entry.records.length);
  });

  it('a blocked folder does not block a sibling that shares its prefix', async () => {
    const pfx = join(tmpDir, 'pfx');
    const pfx2 = join(tmpDir, 'pfx2');
    for (const dir of [pfx, pfx2]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'f.txt'), 'saved');
    }
    // pfx2 first, so the reverse pass blocks pfx before it reaches pfx2.
    const entry = await captureOne(async (fs) => {
      await fs.rm(pfx2, { recursive: true, force: true });
      await fs.rm(pfx, { recursive: true, force: true });
    });
    await writeFile(pfx, 'a file where the folder was');
    await restoreEntry(entry, newFs(), { dryRun: false });
    const fsPromises = await import('node:fs/promises');
    assert.strictEqual(await fsPromises.readFile(join(pfx2, 'f.txt'), 'utf8'), 'saved');
  });

  it('win32 only: a deleted directory junction comes back as a junction to the same folder', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('junctions are win32 only');
      return;
    }
    const fsPromises = await import('node:fs/promises');
    const target = join(tmpDir, 'junction-target');
    const link = join(tmpDir, 'junction-link');
    await mkdir(target, { recursive: true });
    await fsPromises.symlink(target, link, 'junction');
    const before = await fsPromises.readlink(link);
    const entry = await captureOne((fs) => fs.rm(link));
    const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
    assert.deepStrictEqual(outcome.remaining, []);
    assert.strictEqual(await fsPromises.readlink(link), before);
    assert.ok((await fsPromises.stat(link)).isDirectory());
  });

  it('live captures share one byte budget', () => {
    const journal = new UndoJournal(4096);
    const one = journal.beginCapture();
    const two = journal.beginCapture();
    assert.ok(one.reserve(2000));
    one.push(writeRecord(2000));
    assert.strictEqual(two.reserve(2000), false);
    assert.strictEqual(two.unavailableReason(), 'too large to keep for undo');
    one.release();
    two.release();
    const three = journal.beginCapture();
    assert.ok(three.reserve(2000));
    three.release();
  });

  describe('a dry run lists what the real undo then does', () => {
    /** Journal the captured calls oldest first, preview them all, then undo them all. */
    /** `only` undoes just that call, by its index in `calls`, the way an undo by id does. */
    const previewThenUndo = async (calls: UndoEntry[], only?: number) => {
      const journal = new UndoJournal();
      const added = calls.map((call) => journal.add(call.tool, call.records));
      const ids = only === undefined ? added.reverse() : added.slice(only, only + 1);
      const outcome = (r: { path: string; error?: { code: string } }) =>
        `${r.path} ${r.error?.code ?? 'ok'}`;
      const entries = ids.map((id) => journal.get(id)).filter((e) => e !== undefined);
      const dry = (await dryRunAll(entries)).map(outcome);
      const real: string[] = [];
      for (const id of ids) {
        const entry = journal.get(id);
        assert.ok(entry);
        const out = await restoreEntry(entry, newFs(), {
          dryRun: false,
          onRewrite: (was, identity) => {
            journal.reidentify(was, identity);
          },
        });
        journal.replaceRecords(id, out.remaining);
        real.push(...out.results.map(outcome));
      }
      return { dry, real };
    };

    it('an edit inside a folder, the folder moved, then edited again', async () => {
      const d = join(tmpDir, 'oracle-d1');
      const e = join(tmpDir, 'oracle-d1-moved');
      await mkdir(d, { recursive: true });
      await writeFile(join(d, 'f.txt'), 'v0');
      const { dry, real } = await previewThenUndo([
        await captureOne((fs) => fs.writeFile(join(d, 'f.txt'), 'v1')),
        await captureOne((fs) => fs.rename(d, e)),
        await captureOne((fs) => fs.writeFile(join(e, 'f.txt'), 'v2')),
      ]);
      assert.ok(
        real.every((r) => r.endsWith(' ok')),
        real.join('\n'),
      );
      assert.deepStrictEqual(dry, real);
    });

    it('nested folder moves across a deleted parent', async () => {
      const a = join(tmpDir, 'oracle-d2-a');
      const c = join(tmpDir, 'oracle-d2-c');
      const n = join(tmpDir, 'oracle-d2-n');
      await mkdir(join(a, 'b', 'x'), { recursive: true });
      await mkdir(c, { recursive: true });
      await writeFile(join(a, 'one.txt'), '1');
      const { dry, real } = await previewThenUndo([
        await captureOne((fs) => fs.rename(join(a, 'b', 'x'), join(a, 'b', 'y'))),
        await captureOne((fs) => fs.rename(a, join(c, 'a2'))),
        await captureOne((fs) => fs.rename(join(c, 'a2', 'b'), n)),
        await captureOne((fs) => fs.rm(c, { recursive: true, force: true })),
      ]);
      assert.ok(
        real.every((r) => r.endsWith(' ok')),
        real.join('\n'),
      );
      assert.deepStrictEqual(dry, real);
    });

    it('a moved file changed outside the server is not promised back', async () => {
      const f = join(tmpDir, 'oracle-d3-f.txt');
      const g = join(tmpDir, 'oracle-d3-g.txt');
      await writeFile(f, 'v0');
      const moved = await captureOne((fs) => fs.rename(f, g));
      const overwritten = await captureOne((fs) => fs.writeFile(g, 'v1'));
      await writeFile(g, 'external');
      const edited = await captureOne((fs) => fs.writeFile(g, 'v3'));
      const { dry, real } = await previewThenUndo([moved, overwritten, edited]);
      assert.deepStrictEqual(
        real.map((r) => r.split(' ').pop()),
        ['ok', 'CANCELLED', 'CANCELLED'],
      );
      assert.deepStrictEqual(dry, real);
    });

    it('a file moved out of a folder that was then removed outside the server', async () => {
      const a = join(tmpDir, 'oracle-parent-a');
      await mkdir(a, { recursive: true });
      await writeFile(join(a, 'x.txt'), 'x');
      const moved = await captureOne((fs) =>
        fs.rename(join(a, 'x.txt'), join(tmpDir, 'oracle-parent-x.txt')),
      );
      await rm(a, { recursive: true });
      const { dry, real } = await previewThenUndo([moved]);
      assert.ok(
        real.every((r) => r.endsWith(' ok')),
        real.join('\n'),
      );
      assert.deepStrictEqual(dry, real);
    });

    it('a deleted folder holding a symlink', async (t) => {
      const dir = join(tmpDir, 'oracle-link-dir');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'target.txt'), 'x');
      const link = join(dir, 'link');
      if (
        !(await trySymlink(
          join(dir, 'target.txt'),
          link,
          () => t.skip('symlink not permitted'),
          'file',
        ))
      ) {
        return;
      }
      const { dry, real } = await previewThenUndo([
        await captureOne((fs) => fs.rm(dir, { recursive: true, force: true })),
      ]);
      assert.ok(
        real.every((r) => r.endsWith(' ok')),
        real.join('\n'),
      );
      assert.deepStrictEqual(dry, real);
    });

    it('a change two folders down moves with the folder it sits in', async () => {
      const c = join(tmpDir, 'oracle-deep-c');
      const d = join(tmpDir, 'oracle-deep-d');
      await mkdir(join(c, 'x', 'y'), { recursive: true });
      const { dry, real } = await previewThenUndo([
        await captureOne((fs) => fs.writeFile(join(c, 'x', 'y', 'g.txt'), 'g1')),
        await captureOne((fs) => fs.rm(join(c, 'x', 'y', 'g.txt'))),
        await captureOne((fs) => fs.rename(c, d)),
        await captureOne((fs) => fs.writeFile(join(d, 'x', 'y', 'g.txt'), 'g2')),
      ]);
      assert.ok(
        real.every((r) => r.endsWith(' ok')),
        real.join('\n'),
      );
      assert.deepStrictEqual(dry, real);
    });

    it('a folder the call made, now a link, is left in place', async (t) => {
      const made = join(tmpDir, 'oracle-made');
      const target = join(tmpDir, 'oracle-made-target');
      const link = join(tmpDir, 'oracle-made-link');
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'keep.txt'), 'k');
      if (!(await trySymlink(target, link, () => t.skip('symlink not permitted')))) return;
      const calls = [
        await captureOne((fs) => fs.mkdir(made, { recursive: true })),
        await captureOne((fs) => fs.rmdir(made)),
        await captureOne((fs) => fs.rename(link, made)),
      ];
      const { dry, real } = await previewThenUndo(calls, 0);
      assert.deepStrictEqual(
        real.map((r) => r.split(' ').pop()),
        ['CANCELLED'],
      );
      assert.deepStrictEqual(dry, real);
      const fsPromises = await import('node:fs/promises');
      assert.ok((await fsPromises.lstat(made)).isSymbolicLink());
    });

    it('a folder move back under a parent that is now a file', async () => {
      const a = join(tmpDir, 'oracle-filed');
      await mkdir(a, { recursive: true });
      await writeFile(join(a, 'x.txt'), 'x');
      const calls = [
        await captureOne((fs) => fs.rename(join(a, 'x.txt'), join(tmpDir, 'oracle-filed-x.txt'))),
        await captureOne((fs) => fs.rm(a, { recursive: true })),
        await captureOne((fs) => fs.writeFile(a, 'a file now')),
      ];
      const { dry, real } = await previewThenUndo(calls, 0);
      assert.ok(!real[0]?.endsWith(' ok'), real.join('\n'));
      assert.deepStrictEqual(dry, real);
    });

    it('protection checked on the tree the earlier steps leave', async () => {
      // `.docker/config.json` is denylisted by default; `docker-old/config.json` is not.
      // (`.aws` is not used: its folder is itself a credential folder now, so a move refuses.)
      for (const external of [false, true]) {
        const docker = join(tmpDir, `oracle-policy-${String(external)}`, '.docker');
        const old = join(dirname(docker), 'docker-old');
        await mkdir(docker, { recursive: true });
        await writeFile(join(docker, 'notes.txt'), 'n');
        const moved = await captureOne((fs) => fs.rename(docker, old));
        if (external) await writeFile(join(old, 'config.json'), 'outside the server');
        const later = await captureOne((fs) =>
          external ? fs.rm(join(old, 'config.json')) : fs.writeFile(join(old, 'config.json'), 'c'),
        );
        const { dry, real } = await previewThenUndo([moved, later]);
        assert.deepStrictEqual(dry, real, `external: ${String(external)}`);
      }
    });

    it('a link to outside the roots that an earlier step moves away', async (t) => {
      const outside = await createTestRoot();
      try {
        const d = join(tmpDir, 'oracle-lock-d');
        const link = join(tmpDir, 'oracle-lock-l');
        await mkdir(d, { recursive: true });
        await writeFile(join(d, 'f.txt'), 'v0');
        if (!(await trySymlink(outside, link, () => t.skip('symlink not permitted')))) return;
        const calls = [
          await captureOne((fs) => fs.writeFile(join(d, 'f.txt'), 'v1')),
          await captureOne((fs) => fs.rm(d, { recursive: true, force: true })),
          await captureOne((fs) => fs.rename(link, d)),
        ];
        const { dry, real } = await previewThenUndo(calls);
        assert.ok(
          real.every((r) => r.endsWith(' ok')),
          real.join('\n'),
        );
        assert.deepStrictEqual(dry, real);
      } finally {
        await cleanupTestRoot(outside);
      }
    });

    it('win32 only: the Kelvin sign and k name two files', async (t) => {
      if (process.platform !== 'win32') {
        t.skip('NTFS case folding');
        return;
      }
      const k = join(tmpDir, 'oracle-k.txt');
      const kelvin = join(tmpDir, 'oracle-K.txt');
      await writeFile(k, 'k0');
      await writeFile(kelvin, 'K0');
      const { dry, real } = await previewThenUndo([
        await captureOne((fs) => fs.writeFile(k, 'k1')),
        await captureOne((fs) => fs.writeFile(kelvin, 'K1')),
      ]);
      assert.ok(
        real.every((r) => r.endsWith(' ok')),
        real.join('\n'),
      );
      assert.deepStrictEqual(dry, real);
    });

    it('a folder now spelled in the other Unicode form', async () => {
      const nfc = join(tmpDir, 'oracle-café');
      const nfd = join(tmpDir, 'oracle-café');
      const calls = [
        await captureOne((fs) => fs.mkdir(nfc, { recursive: true })),
        await captureOne((fs) => fs.rename(nfc, nfd)),
        await captureOne((fs) => fs.writeFile(join(nfd, 'keep.txt'), 'k')),
      ];
      const { dry, real } = await previewThenUndo(calls, 0);
      assert.deepStrictEqual(dry, real);
    });

    it('a folder moved onto the name of a deleted folder', async () => {
      const s = join(tmpDir, 'oracle-d5-s');
      const t = join(tmpDir, 'oracle-d5-t');
      await mkdir(s, { recursive: true });
      await writeFile(join(s, 'f.txt'), 'from-s');
      const { dry, real } = await previewThenUndo([
        await captureOne(async (fs) => {
          await fs.mkdir(t, { recursive: true });
          await fs.writeFile(join(t, 'f.txt'), 'from-t');
        }),
        await captureOne((fs) => fs.rm(t, { recursive: true, force: true })),
        await captureOne((fs) => fs.rename(s, t)),
      ]);
      assert.ok(
        real.every((r) => r.endsWith(' ok')),
        real.join('\n'),
      );
      assert.deepStrictEqual(dry, real);
    });

    it('two edits through two hard-linked names preview what the real undo does', async (t) => {
      const a = join(tmpDir, 'oracle-hl-a.txt');
      const b = join(tmpDir, 'oracle-hl-b.txt');
      await writeFile(a, 'A');
      try {
        await link(a, b);
      } catch {
        return t.skip('hard links not supported here');
      }
      const { dry, real } = await previewThenUndo([
        await captureOne((fs) => fs.writeFile(a, 'B')),
        await captureOne((fs) => fs.writeFile(b, 'C')),
      ]);
      assert.ok(
        real.every((r) => r.endsWith(' ok')),
        real.join('\n'),
      );
      assert.deepStrictEqual(dry, real);
      assert.strictEqual(await readFile(a, 'utf8'), 'A');
      assert.strictEqual(await readFile(b, 'utf8'), 'A');
      assert.strictEqual((await lstat(a)).nlink, 2);
    });

    it('a dry run does not promise a restore the real undo skips', async (t) => {
      const a = join(tmpDir, 'oracle-hl-rev-a.txt');
      const b = join(tmpDir, 'oracle-hl-rev-b.txt');
      await writeFile(a, 'A');
      try {
        await link(a, b);
      } catch {
        return t.skip('hard links not supported here');
      }
      const first = await captureOne((fs) => fs.writeFile(a, 'B'));
      await writeFile(b, 'C'); // external in-place write through the twin
      const second = await captureOne((fs) => fs.writeFile(b, 'B'));
      const { dry, real } = await previewThenUndo([first, second]);
      // The journal's paths are validated spellings (lowercase drive letter).
      assert.ok(
        real.some((r) => r.toLowerCase().endsWith(`${a.toLowerCase()} cancelled`)),
        real.join('\n'),
      );
      assert.deepStrictEqual(dry, real);
    });

    it('a dry run does not promise removing a file the real undo refuses to remove', async (t) => {
      const a = join(tmpDir, 'oracle-hl-rm-a.txt');
      const b = join(tmpDir, 'oracle-hl-rm-b.txt');
      const created = await captureOne((fs) => fs.writeFile(a, 'A')); // create: a remove record
      try {
        await link(a, b);
      } catch {
        return t.skip('hard links not supported here');
      }
      await writeFile(b, 'B'); // external in-place edit through the twin
      const edited = await captureOne((fs) => fs.writeFile(b, 'A'));
      const { dry, real } = await previewThenUndo([created, edited]);
      // The journal's paths are validated spellings (lowercase drive letter).
      assert.ok(
        real.some((r) => r.toLowerCase().endsWith(`${a.toLowerCase()} cancelled`)),
        real.join('\n'),
      );
      assert.deepStrictEqual(dry, real);
      assert.strictEqual(await readFile(a, 'utf8'), 'B'); // live refused the removal
    });

    it('an edit through the moved name after a move of its hard-linked twin', async (t) => {
      const a = join(tmpDir, 'oracle-hl-mv-a.txt');
      const b = join(tmpDir, 'oracle-hl-mv-b.txt');
      const c = join(tmpDir, 'oracle-hl-mv-c.txt');
      await writeFile(a, 'v1');
      try {
        await link(a, b);
      } catch {
        return t.skip('hard links not supported here');
      }
      const { dry, real } = await previewThenUndo([
        await captureOne((fs) => fs.writeFile(a, 'v2')),
        await captureOne((fs) => fs.rename(b, c)), // c is still the shared inode
        await captureOne((fs) => fs.writeFile(c, 'v3')),
      ]);
      assert.ok(
        real.every((r) => r.endsWith(' ok')),
        real.join('\n'),
      );
      assert.deepStrictEqual(dry, real);
      assert.strictEqual(await readFile(a, 'utf8'), 'v1');
      assert.strictEqual(await readFile(b, 'utf8'), 'v1');
      assert.strictEqual(
        await lstat(c).then(
          () => true,
          () => false,
        ),
        false,
      );
      assert.strictEqual((await lstat(a)).nlink, 2);
    });

    it('a move of one name, then an edit through its twin', async (t) => {
      const a = join(tmpDir, 'oracle-hl-ia-a.txt');
      const b = join(tmpDir, 'oracle-hl-ia-b.txt');
      const c = join(tmpDir, 'oracle-hl-ia-c.txt');
      await writeFile(a, 'v1');
      try {
        await link(a, b);
      } catch {
        return t.skip('hard links not supported here');
      }
      const { dry, real } = await previewThenUndo([
        await captureOne((fs) => fs.rename(b, c)),
        await captureOne((fs) => fs.writeFile(a, 'v2')),
      ]);
      assert.ok(
        real.every((r) => r.endsWith(' ok')),
        real.join('\n'),
      );
      assert.deepStrictEqual(dry, real);
      assert.strictEqual(await readFile(a, 'utf8'), 'v1');
      assert.strictEqual(await readFile(b, 'utf8'), 'v1');
      assert.strictEqual(
        await lstat(c).then(
          () => true,
          () => false,
        ),
        false,
      );
      assert.strictEqual((await lstat(a)).nlink, 2);
    });

    it('a write after one link was removed previews the fresh-inode restore', async (t) => {
      const a = join(tmpDir, 'oracle-hl-drop-a.txt');
      const b = join(tmpDir, 'oracle-hl-drop-b.txt');
      await writeFile(a, 'v1');
      try {
        await link(a, b);
      } catch {
        return t.skip('hard links not supported here');
      }
      const writeB = await captureOne((fs) => fs.writeFile(b, 'v2')); // in-place capture, both names 'v2'
      const removeA = await captureOne((fs) => fs.rm(a)); // snapshot bytes 'v2', undo recreates a
      const { dry, real } = await previewThenUndo([writeB, removeA]);
      assert.ok(
        real.every((r) => r.endsWith(' ok')),
        real.join('\n'),
      );
      assert.deepStrictEqual(dry, real);
      assert.strictEqual(await readFile(a, 'utf8'), 'v2'); // recreated by the newer step
      assert.strictEqual(await readFile(b, 'utf8'), 'v1'); // reverted, on a fresh inode
      assert.strictEqual((await lstat(a)).nlink, 1); // a is a fresh inode now
    });
  });

  it('a dry run waits for a writer that holds the path', async () => {
    const file = join(tmpDir, 'preview-lock.txt');
    await writeFile(file, 'v1');
    const entry = await captureOne((fs) => fs.writeFile(file, 'v2'));
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = (): void => undefined;
    const taken = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const writer = newFs().lockForWrite(file, async () => {
      holding();
      await held;
    });
    await taken;
    let finished = false;
    const dry = restoreEntry(entry, newFs(), { dryRun: true }).then((out) => {
      finished = true;
      return out;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(finished, false, 'the preview read the file while a writer held it');
    release();
    await writer;
    assert.deepStrictEqual(
      (await dry).results.filter((r) => 'error' in r),
      [],
    );
  });

  it('dry run: chained moves restore through simulated intermediate paths', async () => {
    const a = join(tmpDir, 'chain-a.txt');
    const b = join(tmpDir, 'chain-b.txt');
    const c = join(tmpDir, 'chain-c.txt');
    await writeFile(a, 'data');
    const entry = await captureOne(async (fs) => {
      await fs.rename(a, b);
      await fs.rename(b, c);
    });
    const dry = await restoreEntry(entry, newFs(), { dryRun: true });
    assert.deepStrictEqual(
      dry.results.filter((r) => 'error' in r),
      [],
    );
    assert.deepStrictEqual(dry.remaining, []);
  });

  it('a dry run refuses a write live undo must refuse on a read-only hard link', async (t) => {
    const rw = await createTestRoot();
    const ro = await createTestRoot();
    const server = await createTestServer([rw], { readOnlyDirs: [ro] });
    try {
      const file = join(rw, 'ro-linked.txt');
      const twin = join(ro, 'ro-linked-twin.txt');
      await writeFile(file, 'A');
      const cap = new UndoJournal(32 * 1024 * 1024).beginCapture();
      const guarded = new GuardedFileSystem(server.pathGuard, cap);
      await guarded.writeFile(file, 'B'); // captured while the file is still single-linked
      assert.strictEqual(cap.unavailableReason(), undefined);
      try {
        await link(file, twin);
      } catch {
        return t.skip('hard links not supported here');
      }
      const entry = { id: 't', tool: 'test', createdAt: Date.now(), records: cap.records };

      const preview = new UndoPreview(new GuardedFileSystem(server.pathGuard));
      const dry = await restoreEntry(entry, new GuardedFileSystem(server.pathGuard), {
        dryRun: true,
        preview,
      });
      assert.strictEqual(dry.results.filter((r) => !('error' in r)).length, 0);
      assert.ok(
        dry.results.some((r) => 'error' in r && r.error.code === ErrorCode.ACCESS_DENIED),
        JSON.stringify(dry.results.map((r) => ('error' in r ? r.error.code : 'ok'))),
      );
      assert.strictEqual(await readFile(file, 'utf8'), 'B'); // the dry run wrote nothing

      const live = await restoreEntry(entry, new GuardedFileSystem(server.pathGuard), {
        dryRun: false,
      });
      assert.ok(live.results.some((r) => 'error' in r && r.error.code === ErrorCode.ACCESS_DENIED));
      assert.strictEqual(await readFile(file, 'utf8'), 'B');
    } finally {
      server.disposeRuntimeState();
      await server.mcp.close();
      await cleanupTestRoot(rw);
      await cleanupTestRoot(ro);
    }
  });

  it('a previewed unlink drops the modeled link count for later writes', async (t) => {
    const a = join(tmpDir, 'direct-world-a.txt');
    const b = join(tmpDir, 'direct-world-b.txt');
    await writeFile(a, 'v1');
    try {
      await link(a, b);
    } catch {
      return t.skip('hard links not supported here');
    }
    // The record grammar cannot reach this shape: a remove record exists only
    // for a file the call created, every hard link to it appears after that
    // create entry, and undo runs newest-first, so a previewed removal always
    // runs after every write. The world interface reaches it directly.
    const world = new UndoPreview(newFs()).world();
    const inode = await world.identity(a);
    await world.rm(b); // a successful previewed removal through one name
    await world.writeFile(a, Buffer.from('v2'), 0o644);
    // The remaining name must get a fresh identity, as live writeFile does once
    // the unlink left one name; a missing decrement or a reseed from the
    // unchanged disk count keeps the inode and fails here.
    assert.notDeepStrictEqual(await world.identity(a), inode);
  });
});

describe('undo id on results', () => {
  const firstTextBlock = (result: unknown): string | undefined => {
    const blocks = (result as { content?: { type: string; text?: string }[] }).content;
    return blocks?.find((b) => b.type === 'text')?.text;
  };

  it('an edit result carries the undo id in text and _meta', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const file = join(tmp, 'suffix-edit.txt');
      await writeFile(file, 'before body');
      const result = await pair.client.callTool({
        name: 'edit',
        arguments: { path: file, edits: [{ oldText: 'before body', newText: 'after body' }] },
      });
      assert.notStrictEqual(result.isError, true);
      const text = firstTextBlock(result) ?? '';
      assert.match(text, / · undo [a-z0-9]{4}$/u);
      const meta = result._meta as { undo?: string };
      assert.match(text.slice(text.length - 4), new RegExp(`^${meta.undo ?? ''}$`, 'u'));
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('nine edits at once each carry an undo id', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const files = Array.from({ length: 9 }, (_, i) => join(tmp, `burst-${String(i)}.txt`));
      await Promise.all(files.map((f) => writeFile(f, 'before')));
      const results = await Promise.all(
        files.map((path) =>
          pair.client.callTool({
            name: 'edit',
            arguments: { path, edits: [{ oldText: 'before', newText: 'after' }] },
          }),
        ),
      );
      for (const result of results) {
        assert.match((result._meta as { undo?: string }).undo ?? '', /^[a-z0-9]{4}$/u);
      }
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('a create result carries undo in structuredContent and stays valid JSON text', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const result = await pair.client.callTool({
        name: 'create',
        arguments: { files: [{ path: join(tmp, 'suffix-create.txt'), content: 'new' }] },
      });
      assert.notStrictEqual(result.isError, true);
      const structured = result.structuredContent as { undo?: string };
      assert.match(structured.undo ?? '', /^[a-z0-9]{4}$/u);
      assert.ok(JSON.parse(firstTextBlock(result) ?? '') !== undefined);
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('a dry run carries no suffix', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const file = join(tmp, 'suffix-dry.txt');
      await writeFile(file, 'before body');
      const result = await pair.client.callTool({
        name: 'edit',
        arguments: {
          path: file,
          edits: [{ oldText: 'before body', newText: 'after body' }],
          dryRun: true,
        },
      });
      assert.notStrictEqual(result.isError, true);
      assert.ok(!(firstTextBlock(result) ?? '').includes('undo'));
      assert.strictEqual((result._meta as { undo?: string }).undo, undefined);
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('a copy ends with not undoable: copies are not undoable yet', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const src = join(tmp, 'suffix-copy.txt');
      await writeFile(src, 'cp');
      const result = await pair.client.callTool({
        name: 'move',
        arguments: {
          moves: [{ source: src, destination: join(tmp, 'suffix-copy-dest.txt') }],
          copy: true,
        },
      });
      assert.notStrictEqual(result.isError, true);
      assert.match(firstTextBlock(result) ?? '', / · not undoable: copies are not undoable yet$/u);
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('FS_MAX_UNDO_BYTES=0 removes the suffix', async () => {
    const tmp = await createTestRoot();
    const pair = await withEnv({ FS_MAX_UNDO_BYTES: '0' }, () => createTestClientPair([tmp]));
    try {
      const file = join(tmp, 'suffix-disabled.txt');
      await writeFile(file, 'before body');
      const result = await pair.client.callTool({
        name: 'edit',
        arguments: { path: file, edits: [{ oldText: 'before body', newText: 'after body' }] },
      });
      assert.notStrictEqual(result.isError, true);
      assert.ok(!(firstTextBlock(result) ?? '').includes('undo'));
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });
});

describe('undo body', () => {
  let root: string;
  let guard: PathGuard;
  let fs: GuardedFileSystem;
  let journal: UndoJournal;

  beforeEach(async () => {
    root = await createTestRoot();
    guard = await makeGuard([root]);
    fs = new GuardedFileSystem(guard);
    journal = new UndoJournal();
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  /** Run a mutating body under an undo capture and journal it, as the executor does; returns its undo id. */
  const journaled = async <I extends z.ZodType, O extends object>(
    tool: DefinedToolOf<I, O>,
    args: z.input<I>,
  ): Promise<string> => {
    const capture = journal.beginCapture();
    try {
      const result = await runToolBodyResult(tool, args, {
        fs: new GuardedFileSystem(guard, capture),
      });
      assert.notStrictEqual(result.isError, true, result.text);
      assert.ok(capture.records.length > 0, `${tool.name} recorded nothing`);
      return journal.add(tool.name, capture.records);
    } finally {
      capture.release();
    }
  };

  const undo = async (args: UndoArgs, options: Partial<ToolBodyOptions> = {}): Promise<UndoRun> =>
    await runToolBodyResult(UNDO, args, { fs, undoJournal: journal, ...options });

  const onlyStep = (result: UndoRun): UndoStep => {
    assert.strictEqual(result.structured.steps.length, 1);
    const [step] = result.structured.steps;
    assert.ok(step);
    return step;
  };

  it('a fresh journal has nothing to undo', async () => {
    const result = await undo({});
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.text, 'undo: nothing to undo');
    assert.deepStrictEqual(result.structured.steps, []);
  });

  it('a second concurrent undo of one id does not bring restored records back', async () => {
    const x = join(root, 'tx.txt');
    const y = join(root, 'ty.txt');
    await writeFile(x, 'X0');
    await writeFile(y, 'Y0');
    const id = await journaled(CREATE, {
      files: [
        { path: x, content: 'X1', overwrite: true },
        { path: y, content: 'Y1', overwrite: true },
      ],
    });
    await writeFile(y, 'Y-external');
    await Promise.all([undo({ id }), undo({ id })]);
    const third = (await undo({ id })).text ?? '';
    assert.match(third, /ty\.txt SKIPPED/u);
    assert.ok(!third.includes('tx.txt'), `tx.txt was restored once: ${third}`);
  });

  it('a second concurrent undo of a fully restored id reports it gone', async () => {
    const x = join(root, 'full.txt');
    await writeFile(x, 'X0');
    const id = await journaled(CREATE, { files: [{ path: x, content: 'X1', overwrite: true }] });
    const settled = await Promise.allSettled([undo({ id }), undo({ id })]);
    assert.strictEqual(settled.filter((s) => s.status === 'fulfilled').length, 1);
    const failed = settled.find((s) => s.status === 'rejected');
    assert.ok(fsErrorMatcher(ErrorCode.NOT_FOUND, /Unknown or expired undo id/u)(failed?.reason));
    assert.strictEqual(await readFile(x, 'utf8'), 'X0');
  });

  it('the issue example: edit, delete, create-overwrite, then undo them in order', async () => {
    await writeFile(join(root, 'a.ts'), 'original\n');
    await writeFile(join(root, 'old.log'), 'log-data\n');
    await writeFile(join(root, 'config.json'), '{"v":1}\n');
    await journaled(EDIT, {
      path: join(root, 'a.ts'),
      edits: [{ oldText: 'original', newText: 'changed' }],
    });
    await journaled(DELETE, { paths: [join(root, 'old.log')] });
    await journaled(CREATE, {
      files: [{ path: join(root, 'config.json'), content: '{"v":2}\n', overwrite: true }],
    });

    const undoOne = await undo({});
    assert.notStrictEqual(undoOne.isError, true);
    assert.strictEqual(await readFile(join(root, 'config.json'), 'utf8'), '{"v":1}\n');

    const undoTwo = await undo({ steps: 2 });
    assert.notStrictEqual(undoTwo.isError, true);
    assert.deepStrictEqual(
      undoTwo.structured.steps.map((s) => s.tool),
      ['delete', 'edit'],
      'newest first',
    );
    assert.strictEqual(await readFile(join(root, 'a.ts'), 'utf8'), 'original\n');
    assert.strictEqual(await readFile(join(root, 'old.log'), 'utf8'), 'log-data\n');

    assert.strictEqual((await undo({})).text, 'undo: nothing to undo');
  });

  it('dryRun of three steps previews what the real undo restores', async () => {
    const file = join(root, 'two-step.txt');
    await writeFile(file, 'v1');
    await journaled(DELETE, { paths: [file] });
    await journaled(CREATE, { files: [{ path: file, content: 'v2' }] });
    await journaled(EDIT, { path: file, edits: [{ oldText: 'v2', newText: 'v3' }] });

    const dry = await undo({ steps: 3, dryRun: true });
    assert.notStrictEqual(dry.isError, true);
    const dryText = dry.text ?? '';
    assert.ok(
      !dryText.includes('SKIPPED') && !dryText.includes('FAILED'),
      `the preview must show all three steps restoring: ${dryText}`,
    );
    assert.strictEqual(await readFile(file, 'utf8'), 'v3', 'dry run must not touch bytes');

    const undone = await undo({ steps: 3 });
    assert.notStrictEqual(undone.isError, true);
    assert.strictEqual(
      await readFile(file, 'utf8'),
      'v1',
      'reverting edit, create, then delete puts v1 back',
    );
  });

  it('dryRun across two hard-linked names previews what the real undo restores', async (t) => {
    const a = join(root, 'linked-a.txt');
    const b = join(root, 'linked-b.txt');
    await writeFile(a, 'A');
    try {
      await link(a, b);
    } catch {
      return t.skip('hard links not supported here');
    }
    await journaled(EDIT, { path: a, edits: [{ oldText: 'A', newText: 'B' }] });
    await journaled(EDIT, { path: b, edits: [{ oldText: 'B', newText: 'C' }] });

    const dry = await undo({ steps: 2, dryRun: true });
    assert.notStrictEqual(dry.isError, true);
    const dryText = dry.text ?? '';
    assert.ok(!dryText.includes('SKIPPED') && !dryText.includes('FAILED'), dryText);
    assert.strictEqual(await readFile(a, 'utf8'), 'C');
    assert.strictEqual((await lstat(a)).nlink, 2);

    const undone = await undo({ steps: 2 });
    assert.notStrictEqual(undone.isError, true);
    assert.strictEqual(await readFile(a, 'utf8'), 'A');
    assert.strictEqual(await readFile(b, 'utf8'), 'A');
  });

  it('batch create in a new folder undoes all files and removes the folder', async () => {
    const dir = join(root, 'batch-new', 'sub');
    await journaled(CREATE, {
      files: [
        { path: join(dir, 'a.txt'), content: 'a' },
        { path: join(dir, 'b.txt'), content: 'b' },
      ],
    });
    const undone = await undo({});
    assert.notStrictEqual(undone.isError, true);
    const text = undone.text ?? '';
    assert.ok(!text.includes('SKIPPED') && !text.includes('FAILED'), text);
    const step = onlyStep(undone);
    assert.deepStrictEqual([step.truncated, step.totalResults], [undefined, undefined]);
    await assert.rejects(lstat(join(root, 'batch-new')), { code: 'ENOENT' });
  });

  it('a large step lists 100 paths, skipped ones first, and reports the total', async () => {
    const files = Array.from({ length: 100 }, (_, i) =>
      join(root, 'wide', `d${String(i)}`, 'f.txt'),
    );
    await journaled(CREATE, { files: files.map((path) => ({ path, content: 'x' })) });
    // Three changed files: their removes and folders skip, and so does the shared parent.
    for (const path of files.slice(-3)) await writeFile(path, 'changed');
    const step = onlyStep(await undo({}));
    assert.strictEqual(step.results.length, 100);
    assert.strictEqual(step.truncated, true);
    assert.ok((step.totalResults ?? 0) > 200, `totalResults: ${String(step.totalResults)}`);
    assert.strictEqual(step.results.filter((r) => r.error !== undefined).length, 7);
  });

  it(
    'listed paths share one byte budget across steps',
    // The test needs ~2.5 KB paths; macOS caps a path at 1024 bytes (PATH_MAX).
    { skip: process.platform === 'darwin' && 'macOS PATH_MAX is below the paths this needs' },
    async () => {
      // ~2.5 KB paths, listed twice per skipped result: five 100-path steps outgrow the budget.
      const deep = join(
        root,
        ...Array.from({ length: 12 }, (_, i) => `${String(i)}${'d'.repeat(199)}`),
      );
      await mkdir(deep, { recursive: true });
      const files: string[] = [];
      for (let k = 0; k < 5; k++) {
        const batch = Array.from({ length: 100 }, (_, i) =>
          join(deep, `f${String(k)}-${String(i)}.txt`),
        );
        await journaled(CREATE, { files: batch.map((path) => ({ path, content: 'x' })) });
        files.push(...batch);
      }
      for (const path of files) await writeFile(path, 'changed');
      const { steps } = (await undo({ steps: 5 })).structured;
      const listed = steps.flatMap((s) => s.results);
      assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= 2 * 1024 * 1024);
      assert.ok(listed.length < 500, `listed: ${String(listed.length)}`);
      assert.ok(steps.some((s) => s.truncated === true && s.totalResults === 100));
    },
  );

  it('a restore reports progress per record while it runs', async () => {
    const files = Array.from({ length: 100 }, (_, i) => join(root, 'ticks', `f${String(i)}.txt`));
    await journaled(CREATE, { files: files.map((path) => ({ path, content: 'x' })) });
    const frames: { current: number; total?: number }[] = [];
    const undone = await undo(
      {},
      {
        onProgress: (p) => {
          frames.push(p);
        },
      },
    );
    // Each folder the batch created is recorded once per file but removed once.
    const total = onlyStep(undone).totalResults;
    assert.ok(total !== undefined && total > 100, `totalResults: ${String(total)}`);
    assert.deepStrictEqual(
      frames,
      Array.from({ length: total }, (_, i) => ({ current: i + 1, total })),
    );
  });

  it('undo by id reverts only that call', async () => {
    const one = join(root, 'one.txt');
    const two = join(root, 'two.txt');
    await writeFile(one, 'one-old\n');
    await writeFile(two, 'two-old\n');
    const olderId = await journaled(EDIT, {
      path: one,
      edits: [{ oldText: 'one-old', newText: 'one-new' }],
    });
    const newerId = await journaled(EDIT, {
      path: two,
      edits: [{ oldText: 'two-old', newText: 'two-new' }],
    });
    assert.notStrictEqual(newerId, olderId);
    const undone = await undo({ id: olderId });
    assert.notStrictEqual(undone.isError, true);
    assert.strictEqual(onlyStep(undone).id, olderId);
    assert.strictEqual(await readFile(one, 'utf8'), 'one-old\n');
    assert.strictEqual(await readFile(two, 'utf8'), 'two-new\n');
  });

  it('an older id on a file edited again is skipped, and dryRun still lists it', async () => {
    const file = join(root, 'twice.txt');
    await writeFile(file, 'v1\n');
    const olderId = await journaled(EDIT, {
      path: file,
      edits: [{ oldText: 'v1', newText: 'v2' }],
    });
    await journaled(EDIT, { path: file, edits: [{ oldText: 'v2', newText: 'v3' }] });
    const undone = await undo({ id: olderId });
    // Every record was skipped, so the call reports isError — and the older
    // entry is still listed by a later dry run.
    assert.strictEqual(undone.isError, true);
    assert.match(undone.text ?? '', /SKIPPED/u);
    assert.strictEqual(await readFile(file, 'utf8'), 'v3\n');
    const dry = await undo({ dryRun: true });
    assert.ok(dry.structured.steps.some((s) => s.id === olderId));
  });

  it('id plus steps is INVALID_INPUT', async () => {
    await assert.rejects(
      undo({ id: 'aaaa', steps: 2 }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, 'Pass id or steps, not both.'),
    );
  });

  it('an unknown id is NOT_FOUND', async () => {
    await assert.rejects(
      undo({ id: 'zzzz' }),
      fsErrorMatcher(ErrorCode.NOT_FOUND, 'Unknown or expired undo id "zzzz".'),
    );
  });

  it('dryRun lists ids, tools and paths without changing bytes', async () => {
    const file = join(root, 'dry.txt');
    await writeFile(file, 'a\n');
    const id = await journaled(EDIT, { path: file, edits: [{ oldText: 'a', newText: 'b' }] });
    const dry = await undo({ dryRun: true });
    assert.notStrictEqual(dry.isError, true);
    const text = dry.text ?? '';
    assert.ok(text.startsWith(`undo: ${id} (edit)`), text);
    assert.ok(text.includes(pathLabel(file)));
    assert.strictEqual(await readFile(file, 'utf8'), 'b\n');
    // The entry is still there: a real undo still works.
    const real = await undo({ id });
    assert.notStrictEqual(real.isError, true);
    assert.strictEqual(await readFile(file, 'utf8'), 'a\n');
  });

  it('over HTTP, only an undo id or a dry run is accepted', async () => {
    for (const args of [{}, { steps: 2 }]) {
      await assert.rejects(
        undo(args, { transport: 'http' }),
        fsErrorMatcher(
          ErrorCode.INVALID_INPUT,
          /Over HTTP, pass the undo id from the tool result/u,
        ),
        JSON.stringify(args),
      );
    }
    assert.deepStrictEqual((await undo({ dryRun: true }, { transport: 'http' })).structured, {
      steps: [],
    });
  });

  it('a disabled journal refuses every undo', async () => {
    await assert.rejects(
      undo({ dryRun: true }, { undoJournal: new UndoJournal(0) }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, 'Undo is disabled (FS_MAX_UNDO_BYTES=0).'),
    );
  });
});

// What the executor and the hosting legs add around the body: capture
// wiring, registration, and the transports' shared journal.
describe('undo tool over the wire', () => {
  const firstTextBlock = (result: unknown): string | undefined => {
    const blocks = (result as { content?: { type: string; text?: string }[] }).content;
    return blocks?.find((b) => b.type === 'text')?.text;
  };
  const undoId = (result: unknown): string => {
    const match = / · undo ([a-z0-9]{4})/u.exec(firstTextBlock(result) ?? '');
    assert.ok(match, `no undo id in: ${firstTextBlock(result) ?? ''}`);
    return match?.[1] ?? '';
  };
  const call = async (client: Client, name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });

  it('a fresh server has nothing to undo', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const result = await call(pair.client, 'undo', {});
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(firstTextBlock(result), 'undo: nothing to undo');
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('a delete with one oversized path reports it and still undoes the other', async () => {
    const tmp = await createTestRoot();
    const pair = await withEnv({ FS_MAX_UNDO_BYTES: '2000' }, () => createTestClientPair([tmp]));
    try {
      const small = join(tmp, 'small.txt');
      const big = join(tmp, 'big.txt');
      await writeFile(small, 'keep');
      await writeFile(big, 'x'.repeat(4000));

      const deleted = await call(pair.client, 'delete', { paths: [small, big] });
      assert.notStrictEqual(deleted.isError, true);
      const firstLine = (firstTextBlock(deleted) ?? '').split('\n')[0] ?? '';
      assert.match(
        firstLine,
        / · undo [a-z0-9]{4} · not undoable: big\.txt: too large to keep for undo$/u,
      );
      const meta = deleted._meta as { undo?: string; undoUnavailable?: string };
      assert.strictEqual(meta.undo, undoId(deleted));
      assert.strictEqual(meta.undoUnavailable, 'big.txt: too large to keep for undo');

      const undone = await call(pair.client, 'undo', { id: undoId(deleted) });
      assert.notStrictEqual(undone.isError, true);
      assert.strictEqual(await readFile(small, 'utf8'), 'keep');
      await assert.rejects(readFile(big, 'utf8'));
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  const OVERSIZED_WRITES: readonly {
    readonly tool: string;
    readonly args: (root: string, small: string, big: string) => Record<string, unknown>;
    readonly suffix: boolean;
  }[] = [
    {
      tool: 'replace_text',
      args: (root) => ({ path: root, searchPattern: 'old', replacement: 'new' }),
      suffix: true,
    },
    {
      tool: 'edit',
      args: (_root, small, big) => ({
        files: [small, big].map((path) => ({
          path,
          edits: [{ oldText: 'old', newText: 'new' }],
        })),
      }),
      suffix: true,
    },
    {
      tool: 'create',
      args: (_root, small, big) => ({
        files: [small, big].map((path) => ({ path, content: 'new', overwrite: true })),
      }),
      suffix: false,
    },
  ];

  for (const { tool, args, suffix } of OVERSIZED_WRITES) {
    it(`${tool}: one file over the budget stays as written, the other is restored`, async () => {
      const tmp = await createTestRoot();
      const pair = await withEnv({ FS_MAX_UNDO_BYTES: '2000' }, () => createTestClientPair([tmp]));
      try {
        const small = join(tmp, 'small.txt');
        const big = join(tmp, 'big.txt');
        await writeFile(small, 'old');
        await writeFile(big, `old${'x'.repeat(4000)}`);

        const result = await call(pair.client, tool, args(tmp, small, big));
        assert.notStrictEqual(result.isError, true);
        const meta = (result.structuredContent ?? result._meta) as {
          undo?: string;
          undoUnavailable?: string;
        };
        assert.strictEqual(meta.undoUnavailable, 'big.txt: too large to keep for undo');
        assert.match(meta.undo ?? '', /^[a-z0-9]{4}$/u);
        if (suffix) {
          assert.match(
            (firstTextBlock(result) ?? '').split('\n')[0] ?? '',
            / · undo [a-z0-9]{4} · not undoable: big\.txt: too large to keep for undo$/u,
          );
        }
        const written = await readFile(big, 'utf8');

        const undone = await call(pair.client, 'undo', { id: meta.undo });
        assert.notStrictEqual(undone.isError, true);
        assert.strictEqual(await readFile(small, 'utf8'), 'old');
        assert.strictEqual(await readFile(big, 'utf8'), written);
      } finally {
        await pair.close();
        await cleanupTestRoot(tmp);
      }
    });
  }

  it('a replace_text in which no file could be saved has no undo id and reports each file', async () => {
    const tmp = await createTestRoot();
    const pair = await withEnv({ FS_MAX_UNDO_BYTES: '2000' }, () => createTestClientPair([tmp]));
    try {
      for (const name of ['a.txt', 'b.txt']) {
        await writeFile(join(tmp, name), `old${'x'.repeat(4000)}`);
      }
      const result = await call(pair.client, 'replace_text', {
        path: tmp,
        searchPattern: 'old',
        replacement: 'new',
      });
      assert.notStrictEqual(result.isError, true);
      const meta = result._meta as { undo?: string; undoUnavailable?: string };
      assert.strictEqual(meta.undo, undefined);
      assert.deepStrictEqual(meta.undoUnavailable?.split('; ').sort(), [
        'a.txt: too large to keep for undo',
        'b.txt: too large to keep for undo',
      ]);
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('a create with one oversized append restores the other entries and their folders', async () => {
    const tmp = await createTestRoot();
    const pair = await withEnv({ FS_MAX_UNDO_BYTES: '4096' }, () => createTestClientPair([tmp]));
    try {
      const log = join(tmp, 'big.log');
      const top = join(tmp, 'new');
      const fresh = join(top, 'sub', 'a.txt');
      await writeFile(log, 'x'.repeat(8000));

      const result = await call(pair.client, 'create', {
        files: [
          { path: log, content: 'more', append: true },
          { path: fresh, content: 'a' },
        ],
      });
      assert.notStrictEqual(result.isError, true);
      const meta = result.structuredContent as { undo?: string; undoUnavailable?: string };
      assert.strictEqual(meta.undoUnavailable, 'big.log: too large to keep for undo');
      assert.ok((firstTextBlock(result) ?? '').includes('big.log: too large to keep for undo'));

      const undone = await call(pair.client, 'undo', { id: meta.undo });
      assert.notStrictEqual(undone.isError, true);
      await assert.rejects(lstat(top));
      assert.ok((await readFile(log, 'utf8')).endsWith('more'));
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('a create that reaches one file through a link does not delete it on undo', async (t) => {
    const tmp = await createTestRoot();
    const pair = await withEnv({ FS_MAX_UNDO_BYTES: '2000' }, () => createTestClientPair([tmp]));
    try {
      const real = join(tmp, 'real');
      const alias = join(tmp, 'alias');
      const kept = join(tmp, 'kept.txt');
      await mkdir(real);
      if (!(await trySymlink(real, alias, () => t.skip('no symlink privilege')))) return;
      const content = 'x'.repeat(4000);
      const created = await call(pair.client, 'create', {
        files: [
          { path: join(real, 'f.txt'), content, overwrite: true },
          { path: join(alias, 'f.txt'), content, overwrite: true },
          { path: kept, content: 'kept', overwrite: true },
        ],
      });
      const meta = created.structuredContent as { undo?: string; undoUnavailable?: string };
      assert.match(meta.undoUnavailable ?? '', /f\.txt: too large to keep for undo$/u);

      const undone = await call(pair.client, 'undo', { id: meta.undo });
      assert.notStrictEqual(undone.isError, true);
      assert.strictEqual(await readFile(join(real, 'f.txt'), 'utf8'), content);
      await assert.rejects(lstat(kept));
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('a refused file that shares its name with another path in the call is named in full', async () => {
    const tmp = await createTestRoot();
    const pair = await withEnv({ FS_MAX_UNDO_BYTES: '2000' }, () => createTestClientPair([tmp]));
    try {
      await mkdir(join(tmp, 'refused'));
      await mkdir(join(tmp, 'saved'));
      await writeFile(join(tmp, 'refused', 'x.txt'), `old${'x'.repeat(4000)}`);
      await writeFile(join(tmp, 'saved', 'x.txt'), 'old');
      const result = await call(pair.client, 'replace_text', {
        path: tmp,
        searchPattern: 'old',
        replacement: 'new',
      });
      const meta = result._meta as { undoUnavailable?: string };
      assert.ok(
        meta.undoUnavailable
          ?.toLowerCase()
          .endsWith(`${join(tmp, 'refused', 'x.txt')}: too large to keep for undo`.toLowerCase()),
        meta.undoUnavailable,
      );
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('undo of a create keeps the folder a refused file uses, and says nothing of it', async () => {
    const tmp = await createTestRoot();
    // rmdir + one remove = 1024 bytes; the second remove would make 1536.
    const pair = await withEnv({ FS_MAX_UNDO_BYTES: '1100' }, () => createTestClientPair([tmp]));
    try {
      const folder = join(tmp, 'new');
      const created = await call(pair.client, 'create', {
        directories: [folder],
        files: ['a.txt', 'b.txt'].map((name) => ({ path: join(folder, name), content: name })),
      });
      const meta = created.structuredContent as { undo?: string; undoUnavailable?: string };
      const refused = /^([ab]\.txt): too many changes/u.exec(meta.undoUnavailable ?? '')?.[1];
      assert.ok(refused, meta.undoUnavailable);
      const saved = refused === 'a.txt' ? 'b.txt' : 'a.txt';

      for (const dryRun of [true, false]) {
        const undone = await call(pair.client, 'undo', { id: meta.undo, dryRun });
        assert.notStrictEqual(undone.isError, true);
        const text = firstTextBlock(undone) ?? '';
        assert.ok(text.includes(saved), text);
        assert.doesNotMatch(text, /SKIPPED/u);
      }
      assert.strictEqual(await readFile(join(folder, refused), 'utf8'), refused);
      await assert.rejects(lstat(join(folder, saved)));
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('a partial move names the refused destination and undoes the other', async () => {
    const tmp = await createTestRoot();
    const pair = await withEnv({ FS_MAX_UNDO_BYTES: '2000' }, () =>
      createElicitationClientPair([tmp], () =>
        Promise.resolve({ action: 'accept', content: { choice: 'overwrite' } }),
      ),
    );
    try {
      const [a, b, c, d] = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((name) => join(tmp, name)) as [
        string,
        string,
        string,
        string,
      ];
      await writeFile(a, 'a');
      await writeFile(c, 'c');
      await writeFile(d, 'x'.repeat(4000));

      const moved = await call(pair.client, 'move', {
        moves: [
          { source: a, destination: b },
          { source: c, destination: d },
        ],
      });
      assert.notStrictEqual(moved.isError, true);
      assert.match(
        (firstTextBlock(moved) ?? '').split('\n')[0] ?? '',
        / · undo [a-z0-9]{4} · not undoable: d\.txt: too large to keep for undo$/u,
      );
      const meta = moved._meta as { undo?: string; undoUnavailable?: string };
      assert.strictEqual(meta.undoUnavailable, 'd.txt: too large to keep for undo');
      assert.strictEqual(meta.undo, undoId(moved));

      const undone = await call(pair.client, 'undo', { id: meta.undo });
      assert.notStrictEqual(undone.isError, true);
      assert.strictEqual(await readFile(a, 'utf8'), 'a');
      await assert.rejects(lstat(b));
      assert.strictEqual(await readFile(d, 'utf8'), 'c');
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('a copy with new parents keeps the call-wide reason and no undo id', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const [a, b] = [join(tmp, 'a.txt'), join(tmp, 'b.txt')];
      await writeFile(a, 'a');
      await writeFile(b, 'b');
      const copied = await call(pair.client, 'move', {
        moves: [
          { source: a, destination: join(tmp, 'new', 'a.txt') },
          { source: b, destination: join(tmp, 'new', 'b.txt') },
        ],
        copy: true,
      });
      assert.notStrictEqual(copied.isError, true);
      assert.match(
        (firstTextBlock(copied) ?? '').split('\n')[0] ?? '',
        / · not undoable: copies are not undoable yet$/u,
      );
      const meta = copied._meta as { undo?: string; undoUnavailable?: string };
      assert.strictEqual(meta.undo, undefined);
      assert.strictEqual(meta.undoUnavailable, 'copies are not undoable yet');
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('a deleted file comes back by its undo id, and the undo itself is not journaled', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const file = join(tmp, 'gone.txt');
      await writeFile(file, 'keep me\n');
      const del = await call(pair.client, 'delete', { paths: [file] });
      assert.notStrictEqual(del.isError, true);
      const id = undoId(del);
      const undone = await call(pair.client, 'undo', { id });
      assert.notStrictEqual(undone.isError, true);
      assert.strictEqual(await readFile(file, 'utf8'), 'keep me\n');
      // undo authors its own text, so its steps ship under _meta.
      assert.strictEqual(undone.structuredContent, undefined);
      const { steps } = undone._meta as {
        steps: { id: string; tool: string; results: { path: string; error?: unknown }[] }[];
      };
      assert.deepStrictEqual(
        steps.map((s) => [s.id, s.tool, s.results.length]),
        [[id, 'delete', 1]],
      );
      assert.strictEqual(steps[0]?.results[0]?.error, undefined);
      assert.ok(!(firstTextBlock(undone) ?? '').includes(' · undo '));
      assert.strictEqual(
        firstTextBlock(await call(pair.client, 'undo', {})),
        'undo: nothing to undo',
      );
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('non-recursive delete on a non-empty folder records no undo step', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const dir = join(tmp, 'non-empty');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'keep.txt'), 'keep');
      const del = await call(pair.client, 'delete', { paths: [dir] });
      assert.strictEqual(del.isError, true);
      assert.ok(!(firstTextBlock(del) ?? '').includes('undo'));
      const undoRes = await call(pair.client, 'undo', {});
      assert.strictEqual(firstTextBlock(undoRes), 'undo: nothing to undo');
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('readOnly mode does not register undo', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp], { readOnly: true });
    try {
      const { tools } = await pair.client.listTools();
      assert.ok(!tools.some((t) => t.name === 'undo'));
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('over HTTP, undo with no id or dryRun is INVALID_INPUT', async () => {
    const tmp = await createTestRoot();
    const harness = await createTestHttpHarness([tmp]);
    try {
      const result = await call(harness.client, 'undo', {});
      assert.strictEqual(result.isError, true);
      assert.match(
        firstTextBlock(result) ?? '',
        /Over HTTP, pass the undo id from the tool result/u,
      );
    } finally {
      await harness.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('over HTTP, undo by id in a separate request reverts the edit', async () => {
    const tmp = await createTestRoot();
    const harness = await createTestHttpHarness([tmp]);
    try {
      const file = join(tmp, 'http-edit.txt');
      await writeFile(file, 'before\n');
      const editRes = await call(harness.client, 'edit', {
        path: file,
        edits: [{ oldText: 'before', newText: 'after' }],
      });
      assert.notStrictEqual(editRes.isError, true);
      const id = undoId(editRes);
      const undone = await call(harness.client, 'undo', { id });
      assert.notStrictEqual(undone.isError, true);
      assert.strictEqual(await readFile(file, 'utf8'), 'before\n');
    } finally {
      await harness.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('over stdio, undo with no arguments reverts the last call', async () => {
    const tmp = await createTestRoot();
    const stdio = await createStdioClient(tmp);
    try {
      const file = join(tmp, 'stdio-edit.txt');
      await writeFile(file, 'before\n');
      const editRes = await call(stdio.client, 'edit', {
        path: file,
        edits: [{ oldText: 'before', newText: 'after' }],
      });
      assert.notStrictEqual(editRes.isError, true);
      assert.match(firstTextBlock(editRes) ?? '', / · undo [a-z0-9]{4}$/u);
      const undone = await call(stdio.client, 'undo', {});
      assert.notStrictEqual(undone.isError, true);
      assert.strictEqual(await readFile(file, 'utf8'), 'before\n');
    } finally {
      await stdio.close();
      await cleanupTestRoot(tmp);
    }
  });
});
