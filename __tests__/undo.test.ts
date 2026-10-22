import type { Client } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { Problem } from '../src/core/errors.ts';
import { pathLabel } from '../src/core/fmt.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import type { UndoRecord } from '../src/core/undo.ts';
import type { UndoEntry } from '../src/core/undo.ts';
import { restoreEntry, UndoCapture, UndoJournal } from '../src/core/undo.ts';
import { sha256Hex } from '../src/core/util.ts';
import type { FilesystemServerContext } from '../src/server.ts';
import {
  cleanupTestRoot,
  createStdioClient,
  createTestClientPair,
  createTestHttpHarness,
  createTestRoot,
  createTestServer,
  trySymlink,
  withEnv,
} from './helpers.ts';

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
    assert.ok(caps.every((c) => c.unavailable === undefined));
    for (const c of caps) journal.endCapture(c);
  });

  it('an abandoned capture keeps its charge until endCapture', () => {
    // One reserve of 2000 charges 2512 (512 record overhead).
    const journal = new UndoJournal(4096);
    const one = journal.beginCapture();
    assert.ok(one.reserve(2000));
    assert.strictEqual(one.reserve(2000), false);
    assert.strictEqual(one.unavailable, 'too large to keep for undo');
    const two = journal.beginCapture();
    assert.strictEqual(two.reserve(2000), false);
    journal.endCapture(one);
    journal.endCapture(two);
    const three = journal.beginCapture();
    assert.ok(three.reserve(2000));
    journal.endCapture(three);
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
    journal.endCapture(big);
    journal.endCapture(small);
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

  const capture = () => new UndoCapture(32 * 1024 * 1024);
  const makeFs = (cap: UndoCapture) => new GuardedFileSystem(ctx.pathGuard, cap);

  it('an overwrite pushes write with the old bytes and the new hash', async () => {
    const file = join(tmpDir, 'overwrite.txt');
    await writeFile(file, 'old-content');
    const cap = capture();
    const fs = makeFs(cap);
    await fs.writeFile(file, 'new-content');
    await rm(file);
    assert.strictEqual(cap.unavailable, undefined);
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
    assert.strictEqual(cap.unavailable, undefined);
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
    assert.strictEqual(cap.unavailable, 'contains protected files');
    assert.deepStrictEqual(cap.records, []);
  });

  it('a budget of 3 bytes with a 4-byte file abandons', async () => {
    const file = join(tmpDir, 'big.txt');
    await writeFile(file, 'abcd');
    const cap = new UndoCapture(3);
    const fs = makeFs(cap);
    await fs.writeFile(file, 'x');
    assert.ok(cap.unavailable !== undefined);
    assert.deepStrictEqual(cap.records, []);
  });

  it('records carry overhead: empty entries still count against the budget', async () => {
    const tree = join(tmpDir, 'empty-entries');
    await mkdir(join(tree, 'sub'), { recursive: true });
    for (let i = 0; i < 5; i++) await writeFile(join(tree, `e${i}.txt`), '');
    // 7 records (5 empty files, sub, tree) cost 7 * 512 overhead: over 3 KiB.
    const cap = new UndoCapture(3 * 1024);
    const fs = makeFs(cap);
    await fs.rm(tree, { recursive: true, force: true });
    assert.strictEqual(cap.unavailable, 'too many changes to keep for undo');
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
    assert.strictEqual(cap.unavailable, 'cannot capture a non-regular entry');
    assert.deepStrictEqual(cap.records, []);
  });

  it('cp abandons with copies are not undoable yet', async () => {
    const src = join(tmpDir, 'cp-src.txt');
    const dest = join(tmpDir, 'cp-dest.txt');
    await writeFile(src, 'cp');
    const cap = capture();
    const fs = makeFs(cap);
    await fs.cp(src, dest);
    assert.strictEqual(cap.unavailable, 'copies are not undoable yet');
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
    assert.strictEqual(cap.unavailable, 'could not read the old content');
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
    assert.strictEqual(cap.unavailable, 'cannot capture a write over a non-regular file');
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
    assert.strictEqual(cap.unavailable, 'could not type a link whose target is gone');
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
    const cap = new UndoCapture(32 * 1024 * 1024);
    const fs = new GuardedFileSystem(ctx.pathGuard, cap);
    await run(fs);
    assert.strictEqual(cap.unavailable, undefined);
    return { id: 'test', tool: 'test', createdAt: Date.now(), records: cap.records };
  };
  const dryRunAll = async (entries: UndoEntry[]) => {
    const simulated = new Map<string, string | null>();
    const relocations: [string, string][] = [];
    const directoryBackings = new Map<string, string | null>();
    const results = [];
    for (const entry of entries) {
      results.push(
        ...(
          await restoreEntry(entry, newFs(), {
            dryRun: true,
            simulated,
            relocations,
            directoryBackings,
          })
        ).results,
      );
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

  it('reserve charges before the read, so two captures cannot both pass the gate', () => {
    const journal = new UndoJournal(4096);
    const one = journal.beginCapture();
    const two = journal.beginCapture();
    assert.ok(one.reserve(2000));
    assert.strictEqual(two.reserve(2000), false);
    journal.endCapture(one);
    journal.endCapture(two);
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
    const simulated = new Map<string, string | null>();
    const relocations: [string, string][] = [];
    const directoryBackings = new Map<string, string | null>();
    const results = [];
    for (const entry of [moved, edited]) {
      const out = await restoreEntry(entry, newFs(), {
        dryRun: true,
        simulated,
        relocations,
        directoryBackings,
      });
      results.push(...out.results);
    }
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
        const cap = new UndoCapture(32 * 1024 * 1024);
        await run(new GuardedFileSystem(policyCtx.pathGuard, cap));
        assert.strictEqual(cap.unavailable, undefined);
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

      const simulated = new Map<string, string | null>();
      const relocations: [string, string][] = [];
      const directoryBackings = new Map<string, string | null>();
      const results = [];
      for (const entry of [movedQ, deletedP, movedX]) {
        results.push(
          ...(
            await restoreEntry(entry, new GuardedFileSystem(policyCtx.pathGuard), {
              dryRun: true,
              simulated,
              relocations,
              directoryBackings,
            })
          ).results,
        );
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
    assert.strictEqual(two.unavailable, 'too large to keep for undo');
    journal.endCapture(one);
    journal.endCapture(two);
    const three = journal.beginCapture();
    assert.ok(three.reserve(2000));
    journal.endCapture(three);
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

describe('undo tool', () => {
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

  it('a second concurrent undo of one id does not bring restored records back', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const x = join(tmp, 'tx.txt');
      const y = join(tmp, 'ty.txt');
      await writeFile(x, 'X0');
      await writeFile(y, 'Y0');
      const made = await call(pair.client, 'create', {
        files: [
          { path: x, content: 'X1', overwrite: true },
          { path: y, content: 'Y1', overwrite: true },
        ],
      });
      const id = (made.structuredContent as { undo?: string }).undo ?? '';
      await writeFile(y, 'Y-external');
      await Promise.all([call(pair.client, 'undo', { id }), call(pair.client, 'undo', { id })]);
      const third = firstTextBlock(await call(pair.client, 'undo', { id })) ?? '';
      assert.match(third, /ty\.txt SKIPPED/u);
      assert.ok(!third.includes('tx.txt'), `tx.txt was restored once: ${third}`);
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('a second concurrent undo of a fully restored id reports it gone', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const x = join(tmp, 'full.txt');
      await writeFile(x, 'X0');
      const made = await call(pair.client, 'create', {
        files: [{ path: x, content: 'X1', overwrite: true }],
      });
      const id = (made.structuredContent as { undo?: string }).undo ?? '';
      const results = await Promise.all([
        call(pair.client, 'undo', { id }),
        call(pair.client, 'undo', { id }),
      ]);
      assert.strictEqual(results.filter((r) => r.isError !== true).length, 1);
      const failed = results.find((r) => r.isError === true);
      assert.match(firstTextBlock(failed) ?? '', /Unknown or expired undo id/u);
      assert.strictEqual(await import('node:fs/promises').then((m) => m.readFile(x, 'utf8')), 'X0');
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('the issue example: edit, delete, create-overwrite, then undo them in order', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      await writeFile(join(tmp, 'a.ts'), 'original\n');
      await writeFile(join(tmp, 'old.log'), 'log-data\n');
      await writeFile(join(tmp, 'config.json'), '{"v":1}\n');
      const editRes = await call(pair.client, 'edit', {
        path: join(tmp, 'a.ts'),
        edits: [{ oldText: 'original', newText: 'changed' }],
      });
      assert.notStrictEqual(editRes.isError, true);
      const deleteRes = await call(pair.client, 'delete', { paths: [join(tmp, 'old.log')] });
      assert.notStrictEqual(deleteRes.isError, true);
      const createRes = await call(pair.client, 'create', {
        files: [{ path: join(tmp, 'config.json'), content: '{"v":2}\n', overwrite: true }],
      });
      assert.notStrictEqual(createRes.isError, true);

      const undoOne = await call(pair.client, 'undo', {});
      assert.notStrictEqual(undoOne.isError, true);
      const fsPromises = await import('node:fs/promises');
      assert.strictEqual(await fsPromises.readFile(join(tmp, 'config.json'), 'utf8'), '{"v":1}\n');

      const undoTwo = await call(pair.client, 'undo', { steps: 2 });
      assert.notStrictEqual(undoTwo.isError, true);
      assert.strictEqual(await fsPromises.readFile(join(tmp, 'a.ts'), 'utf8'), 'original\n');
      assert.strictEqual(await fsPromises.readFile(join(tmp, 'old.log'), 'utf8'), 'log-data\n');

      const undoEmpty = await call(pair.client, 'undo', {});
      assert.strictEqual(firstTextBlock(undoEmpty), 'undo: nothing to undo');
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('dryRun of two steps previews what the real undo restores', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const file = join(tmp, 'two-step.txt');
      await writeFile(file, 'v1');
      const del = await call(pair.client, 'delete', { paths: [file] });
      assert.notStrictEqual(del.isError, true);
      const mk = await call(pair.client, 'create', {
        files: [{ path: file, content: 'v2' }],
      });
      assert.notStrictEqual(mk.isError, true);
      const ed = await call(pair.client, 'edit', {
        path: file,
        edits: [{ oldText: 'v2', newText: 'v3' }],
      });
      assert.notStrictEqual(ed.isError, true);

      const dry = await call(pair.client, 'undo', { steps: 3, dryRun: true });
      assert.notStrictEqual(dry.isError, true);
      const dryText = firstTextBlock(dry) ?? '';
      assert.ok(
        !dryText.includes('SKIPPED') && !dryText.includes('FAILED'),
        `the preview must show all three steps restoring: ${dryText}`,
      );
      assert.strictEqual(
        await import('node:fs/promises').then((m) => m.readFile(file, 'utf8')),
        'v3',
        'dry run must not touch bytes',
      );

      const undone = await call(pair.client, 'undo', { steps: 3 });
      assert.notStrictEqual(undone.isError, true);
      assert.strictEqual(
        await import('node:fs/promises').then((m) => m.readFile(file, 'utf8')),
        'v1',
        'reverting edit, create, then delete puts v1 back',
      );
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('batch create in a new folder undoes all files and removes the folder', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const dir = join(tmp, 'batch-new', 'sub');
      const created = await call(pair.client, 'create', {
        files: [
          { path: join(dir, 'a.txt'), content: 'a' },
          { path: join(dir, 'b.txt'), content: 'b' },
        ],
      });
      assert.notStrictEqual(created.isError, true);
      const undone = await call(pair.client, 'undo', {});
      assert.notStrictEqual(undone.isError, true);
      const text = firstTextBlock(undone) ?? '';
      assert.ok(!text.includes('SKIPPED') && !text.includes('FAILED'), text);
      const fsPromises = await import('node:fs/promises');
      assert.strictEqual(
        await fsPromises.stat(join(tmp, 'batch-new')).then(
          () => true,
          () => false,
        ),
        false,
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

  it('undo by id reverts only that call', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const one = join(tmp, 'one.txt');
      const two = join(tmp, 'two.txt');
      await writeFile(one, 'one-old\n');
      await writeFile(two, 'two-old\n');
      const first = await call(pair.client, 'edit', {
        path: one,
        edits: [{ oldText: 'one-old', newText: 'one-new' }],
      });
      const second = await call(pair.client, 'edit', {
        path: two,
        edits: [{ oldText: 'two-old', newText: 'two-new' }],
      });
      const olderId = undoId(first);
      assert.notStrictEqual(undoId(second), olderId);
      const undone = await call(pair.client, 'undo', { id: olderId });
      assert.notStrictEqual(undone.isError, true);
      const fsPromises = await import('node:fs/promises');
      assert.strictEqual(await fsPromises.readFile(one, 'utf8'), 'one-old\n');
      assert.strictEqual(await fsPromises.readFile(two, 'utf8'), 'two-new\n');
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('an older id on a file edited again is skipped, and dryRun still lists it', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const file = join(tmp, 'twice.txt');
      await writeFile(file, 'v1\n');
      const first = await call(pair.client, 'edit', {
        path: file,
        edits: [{ oldText: 'v1', newText: 'v2' }],
      });
      await call(pair.client, 'edit', { path: file, edits: [{ oldText: 'v2', newText: 'v3' }] });
      const olderId = undoId(first);
      const undone = await call(pair.client, 'undo', { id: olderId });
      // Every record was skipped, so the call reports isError — and the older
      // entry is still listed by a later dry run.
      assert.strictEqual(undone.isError, true);
      assert.match(firstTextBlock(undone) ?? '', /SKIPPED/u);
      const fsPromises = await import('node:fs/promises');
      assert.strictEqual(await fsPromises.readFile(file, 'utf8'), 'v3\n');
      const dry = await call(pair.client, 'undo', { dryRun: true });
      assert.match(firstTextBlock(dry) ?? '', /undo: [a-z0-9]{4}/u);
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('id plus steps is INVALID_INPUT', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const result = await call(pair.client, 'undo', { id: 'aaaa', steps: 2 });
      assert.strictEqual(result.isError, true);
      assert.match(firstTextBlock(result) ?? '', /Pass id or steps, not both\./u);
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('an unknown id is NOT_FOUND', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const result = await call(pair.client, 'undo', { id: 'zzzz' });
      assert.strictEqual(result.isError, true);
      assert.match(firstTextBlock(result) ?? '', /Unknown or expired undo id "zzzz"\./u);
    } finally {
      await pair.close();
      await cleanupTestRoot(tmp);
    }
  });

  it('dryRun lists ids, tools and paths without changing bytes', async () => {
    const tmp = await createTestRoot();
    const pair = await createTestClientPair([tmp]);
    try {
      const file = join(tmp, 'dry.txt');
      await writeFile(file, 'a\n');
      const editRes = await call(pair.client, 'edit', {
        path: file,
        edits: [{ oldText: 'a', newText: 'b' }],
      });
      const id = undoId(editRes);
      const before = await (await import('node:fs/promises')).readFile(file, 'utf8');
      const dry = await call(pair.client, 'undo', { dryRun: true });
      assert.notStrictEqual(dry.isError, true);
      const text = firstTextBlock(dry) ?? '';
      assert.match(text, /undo: [a-z0-9]{4} \(edit\)/u);
      assert.ok(text.includes(pathLabel(file)));
      const fsPromises2 = await import('node:fs/promises');
      const after = await fsPromises2.readFile(file, 'utf8');
      assert.strictEqual(after, before);
      // The entry is still there: a real undo still works.
      const real = await call(pair.client, 'undo', { id });
      assert.notStrictEqual(real.isError, true);
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

  it('over HTTP, undo with steps is INVALID_INPUT', async () => {
    const tmp = await createTestRoot();
    const harness = await createTestHttpHarness([tmp]);
    try {
      const result = await call(harness.client, 'undo', { steps: 2 });
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
      const fsPromises = await import('node:fs/promises');
      assert.strictEqual(await fsPromises.readFile(file, 'utf8'), 'before\n');
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
      const fsPromises = await import('node:fs/promises');
      assert.strictEqual(await fsPromises.readFile(file, 'utf8'), 'before\n');
    } finally {
      await stdio.close();
      await cleanupTestRoot(tmp);
    }
  });
});
