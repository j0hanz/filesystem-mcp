import assert from 'node:assert/strict';
import { access, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type * as z from 'zod/v4';

import { ErrorCode } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { getMaxTextFileSize, MIB } from '../src/core/util.ts';
import { CREATE } from '../src/tools/create.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  makeGuard,
  trySymlink,
  withEnv,
  writeTestFile,
} from './helpers.ts';
import { choose, runToolBodyResult, schemaIssues, type ToolBodyOptions } from './tool-harness.ts';

type CreateArgs = z.input<typeof CREATE.def.input>;
interface CreateStructured {
  readonly files: readonly {
    path: string;
    size?: number;
    lineCount?: number;
    kind?: string;
    mimeType?: string;
    modified: string;
    resourceUri?: string;
  }[];
  readonly failures?: readonly { path: string; error: { code: string; message: string } }[];
  readonly skipped?: readonly string[];
}
type CreateRun = Awaited<ReturnType<typeof runToolBodyResult<typeof CREATE.def.input, object>>> & {
  readonly structured: CreateStructured;
};

describe('create body', () => {
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

  const create = async (
    args: CreateArgs,
    options: Partial<ToolBodyOptions> = {},
  ): Promise<CreateRun> => (await runToolBodyResult(CREATE, args, { fs, ...options })) as CreateRun;

  it('refuses a batch whose combined content exceeds the file limit', async () => {
    const half = 'x'.repeat(Math.ceil(getMaxTextFileSize() / 2) + 1);
    const issues = await schemaIssues(
      create({
        files: [
          { path: join(root, 'batch-a.txt'), content: half },
          { path: join(root, 'batch-b.txt'), content: half },
        ],
      }),
    );
    assert.ok(
      issues.some((m) => /^combined content .* Split the batch\.$/u.test(m)),
      issues.join('; '),
    );
  });

  it('counts the per-file size cap in UTF-8 bytes, not UTF-16 units', async () => {
    await withEnv({ FS_MAX_FILE_SIZE: String(1024 * 1024) }, async () => {
      const limit = getMaxTextFileSize();
      assert.strictEqual(limit, 1048576);
      // '€' is 1 UTF-16 unit but 3 UTF-8 bytes: 349526 units, 1048578 bytes.
      const over = '€'.repeat(Math.floor(limit / 3) + 1);
      assert.ok(over.length < limit);
      assert.strictEqual(Buffer.byteLength(over, 'utf8'), 1048578);
      const overPath = join(root, 'bytes-cap-over.txt');
      const issues = await schemaIssues(create({ files: [{ path: overPath, content: over }] }));
      assert.ok(
        issues.includes('Content exceeds maximum allowed text file size'),
        issues.join('; '),
      );
      await assert.rejects(stat(overPath), { code: 'ENOENT' });

      // Exactly at the limit in bytes is accepted.
      const exact = '€'.repeat(Math.floor(limit / 3)) + 'x'.repeat(limit % 3);
      assert.strictEqual(Buffer.byteLength(exact, 'utf8'), limit);
      const exactPath = join(root, 'bytes-cap-exact.txt');
      const ok = await create({ files: [{ path: exactPath, content: exact }] });
      assert.notStrictEqual(ok.isError, true);
      assert.strictEqual((await stat(exactPath)).size, limit);
    });
  });

  it('counts the combined batch cap in UTF-8 bytes', async () => {
    await withEnv({ FS_MAX_FILE_SIZE: String(1024 * 1024) }, async () => {
      const limit = getMaxTextFileSize();
      // Each entry is under the per-file cap. Together they are over it in bytes (1048584) but not in units (349528).
      const part = '€'.repeat(Math.ceil(limit / 6) + 1);
      assert.ok(2 * part.length < limit);
      assert.strictEqual(2 * Buffer.byteLength(part, 'utf8'), 1048584);
      const issues = await schemaIssues(
        create({
          files: [
            { path: join(root, 'bytes-batch-a.txt'), content: part },
            { path: join(root, 'bytes-batch-b.txt'), content: part },
          ],
        }),
      );
      assert.deepStrictEqual(issues, [
        'combined content is 1048584 bytes; one create call carries at most 1048576 (FS_MAX_FILE_SIZE). Split the batch.',
      ]);
    });
  });

  it('refuses a batch that names the same file twice', async () => {
    const file = join(root, 'dup-create', 'dup.txt');
    const caseless = process.platform === 'win32' || process.platform === 'darwin';
    for (const twin of caseless ? [file, join(root, 'dup-create', 'DUP.TXT')] : [file]) {
      const issues = await schemaIssues(
        create({
          files: [
            { path: file, content: 'AAAA' },
            { path: twin, content: 'BBBB' },
          ],
        }),
      );
      assert.ok(
        issues.some((m) => m.startsWith('duplicate of files[0].path')),
        issues.join('; '),
      );
    }
    await assert.rejects(access(file), 'nothing may be written when the batch is refused');
  });

  it('refuses a batch that names the same directory twice', async () => {
    const dir = join(root, 'dup-dir');
    const issues = await schemaIssues(
      create({
        directories: [dir, dir],
      }),
    );
    assert.ok(
      issues.some((m) => m.startsWith('duplicate of directories[0]')),
      issues.join('; '),
    );
  });

  it('refuses a batch that names the same path as both a directory and a file', async () => {
    const target = join(root, 'dir-file-collision');
    const issues = await schemaIssues(
      create({
        directories: [target],
        files: [{ path: target, content: 'conflict content' }],
      }),
    );
    assert.ok(
      issues.some((m) => m.includes('conflicts with directories[0]')),
      issues.join('; '),
    );
  });

  it('is a total failure when every requested file was denied', async () => {
    // create publishes {files, failures} with no `summary`; the total-failure
    // check must still fire for a fully-denied write.
    const denied = join(outside, 'create_denied.txt');
    const result = await create({ files: [{ path: denied, content: 'nope' }] });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structured.failures?.[0]?.error.code, 'ACCESS_DENIED');
    await assert.rejects(access(denied), 'the denied file must not exist');
  });

  it('stays a success when only some files were denied', async () => {
    const ok = join(root, 'partial.txt');
    const denied = join(outside, 'create_partial.txt');
    const result = await create({
      files: [
        { path: ok, content: 'written' },
        { path: denied, content: 'nope' },
      ],
    });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(ok, 'utf-8'), 'written');
    await assert.rejects(access(denied), 'the denied file must not exist');
  });

  it('denies append:true on a sensitive file', async () => {
    const envPath = await writeTestFile(root, '.env', 'SECRET=1\n');
    const result = await create({
      files: [{ path: envPath, content: 'LEAKED=1\n', append: true }],
    });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structured.failures?.[0]?.error.code, 'ACCESS_DENIED');
    assert.strictEqual(await readFile(envPath, 'utf-8'), 'SECRET=1\n');
  });

  it('appends to an existing file with append:true', async () => {
    const file = await writeTestFile(root, 'append_target.txt', 'first\n');
    const result = await create({ files: [{ path: file, content: 'second\n', append: true }] });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'first\nsecond\n');
  });

  it('reports the write time when the post-append stat fails', async (t) => {
    const file = await writeTestFile(root, 'append_stat_fails.txt', 'first\n');
    let appended = false;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
    const { appendFile, stat: statFile } = GuardedFileSystem.prototype;
    t.mock.method(
      GuardedFileSystem.prototype,
      'appendFile',
      async function (this: GuardedFileSystem, ...args: Parameters<typeof appendFile>) {
        const done = await appendFile.apply(this, args);
        appended = true;
        return done;
      },
    );
    t.mock.method(
      GuardedFileSystem.prototype,
      'stat',
      function (this: GuardedFileSystem, ...args: Parameters<typeof statFile>) {
        return appended ? Promise.reject(new Error('stat failed')) : statFile.apply(this, args);
      },
    );
    const before = Date.now();
    const result = await create({ files: [{ path: file, content: 'second\n', append: true }] });
    const after = Date.now();
    t.mock.restoreAll();

    assert.notStrictEqual(result.isError, true);
    const modified = result.structured.files[0]?.modified;
    const at = Date.parse(modified ?? '');
    assert.ok(at >= before && at <= after, modified);
  });

  it('counts lines up to the size limit and not past it', async (t) => {
    await withEnv({ FS_MAX_FILE_SIZE: String(MIB) }, async () => {
      const count = t.mock.method(GuardedFileSystem.prototype, 'countFileLines');
      const content = 'x\n';
      const atLimit = await writeTestFile(root, 'at_limit.log', 'a'.repeat(MIB - content.length));
      const at = await create({ files: [{ path: atLimit, content, append: true }] });
      assert.strictEqual(at.structured.files[0]?.lineCount, 1);
      assert.strictEqual(count.mock.callCount(), 1);

      const over = await writeTestFile(
        root,
        'over_limit.log',
        'a'.repeat(MIB - content.length + 1),
      );
      const past = await create({ files: [{ path: over, content, append: true }] });
      assert.strictEqual(past.structured.files[0]?.lineCount, 0);
      assert.strictEqual(count.mock.callCount(), 1, 'no scan past the limit');
    });
  });

  it('refuses a folder as NOT_FILE without asking', async () => {
    const dir = join(root, 'a_folder');
    await mkdir(dir);
    const other = join(root, 'beside_folder.txt');
    for (const overwrite of [undefined, true]) {
      // No confirm option: a prompt makes the harness throw.
      const result = await create({
        files: [
          { path: dir, content: 'x', ...(overwrite ? { overwrite } : {}) },
          { path: other, content: 'y', overwrite: true },
        ],
      });
      assert.strictEqual(result.structured.failures?.[0]?.error.code, ErrorCode.NOT_FILE);
      assert.strictEqual(result.structured.files.length, 1, 'the other entry still writes');
      assert.ok((await stat(dir)).isDirectory());
    }
  });

  it('refuses a link to a folder the same way', async (t) => {
    const dir = join(root, 'link_target');
    await mkdir(dir);
    const link = join(root, 'folder_link');
    if (!(await trySymlink(dir, link, () => t.skip('symlinks not permitted')))) return;
    const result = await create({ files: [{ path: link, content: 'x' }] });
    assert.strictEqual(result.structured.failures?.[0]?.error.code, ErrorCode.NOT_FILE);
  });

  it('creates a missing file with append:true', async () => {
    const file = join(root, 'append_new.txt');
    const result = await create({
      files: [{ path: file, content: 'born from append\n', append: true }],
    });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'born from append\n');
  });

  it('reports whole-file size and line count for an append', async () => {
    // Seed 2 lines, append an unterminated third: result must describe the
    // file on disk (5 bytes, 3 lines), not the appended chunk (1 byte, 1 line).
    const file = await writeTestFile(root, 'append_meta.txt', 'a\nb\n');
    const result = await create({ files: [{ path: file, content: 'c', append: true }] });

    assert.notStrictEqual(result.isError, true);
    const entry = result.structured.files[0];
    assert.strictEqual(entry?.size, 5);
    assert.strictEqual(entry?.lineCount, 3);
    assert.match(entry?.modified ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });

  it('mixes append and overwrite entries in one batch', async () => {
    const appendFile = await writeTestFile(root, 'batch_append.txt', 'keep\n');
    const overwriteFile = await writeTestFile(root, 'batch_overwrite.txt', 'discard\n');
    const result = await create({
      files: [
        { path: appendFile, content: 'kept\n', append: true },
        { path: overwriteFile, content: 'replaced\n', overwrite: true },
      ],
    });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(appendFile, 'utf-8'), 'keep\nkept\n');
    assert.strictEqual(await readFile(overwriteFile, 'utf-8'), 'replaced\n');
  });

  it('asks before replacing an existing file; Skip leaves it untouched', async () => {
    const asked: string[] = [];
    const existing = await writeTestFile(root, 'create_skip_existing.txt', 'keep me\n');
    const fresh = join(root, 'create_skip_fresh.txt');
    const result = await create(
      {
        files: [
          { path: existing, content: 'clobber\n' },
          { path: fresh, content: 'brand new\n' },
        ],
      },
      {
        confirm: (prompt) => {
          asked.push(prompt.message);
          assert.deepStrictEqual(prompt.choices, ['overwrite', 'skip']);
          return { action: 'accept', content: { choice: 'skip' } };
        },
      },
    );

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structured.files.length, 1, 'only the fresh file is written');
    assert.ok(result.structured.skipped?.includes(existing), 'the existing file is skipped');
    assert.strictEqual(asked.length, 1, 'exactly one prompt, for the existing file only');
    assert.match(asked[0] ?? '', /already exists/i);
    assert.strictEqual(await readFile(existing, 'utf-8'), 'keep me\n');
    assert.strictEqual(await readFile(fresh, 'utf-8'), 'brand new\n');
  });

  it('replaces the file once the overwrite is approved', async () => {
    const existing = await writeTestFile(root, 'create_ow_existing.txt', 'old\n');
    const result = await create(
      { files: [{ path: existing, content: 'new\n' }] },
      { confirm: choose('overwrite') },
    );

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.rounds, 1);
    assert.strictEqual(result.structured.files.length, 1);
    assert.strictEqual(result.structured.skipped, undefined);
    assert.strictEqual(await readFile(existing, 'utf-8'), 'new\n');
  });

  it('replaces an existing file without asking under overwrite: true', async () => {
    const existing = await writeTestFile(root, 'create_ow_flag.txt', 'old\n');
    const result = await create(
      { files: [{ path: existing, content: 'new\n', overwrite: true }] },
      {
        confirm: () => {
          throw new Error('overwrite: true must not prompt');
        },
      },
    );

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(existing, 'utf-8'), 'new\n');
  });

  it('asks again about a file that appears during the confirmation gap', async () => {
    const gapFile = join(root, 'create_gap_appears.txt');
    const existing = await writeTestFile(root, 'create_gap_existing.txt', 'old\n');
    let calls = 0;
    const result = await create(
      {
        files: [
          { path: existing, content: 'new\n' },
          { path: gapFile, content: 'clobber\n' },
        ],
      },
      {
        confirm: async () => {
          calls += 1;
          // Someone else writes the not-yet-existing entry while the human is
          // looking at the prompt for the other one.
          if (calls === 1) await writeFile(gapFile, 'written during the gap\n');
          return { action: 'accept', content: { choice: 'overwrite' } };
        },
      },
    );

    // One prompt per pending entry: existing, then existing and gapFile re-prompted together.
    assert.strictEqual(calls, 3, 'asked once, then asked again about both');
    assert.strictEqual(result.rounds, 2);
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(gapFile, 'utf-8'), 'clobber\n');
    assert.strictEqual(await readFile(existing, 'utf-8'), 'new\n');
  });

  it('reports a declined overwrite as declined by the user', async () => {
    const existing = await writeTestFile(root, 'create_ow_declined.txt', 'old\n');
    const result = await create(
      { files: [{ path: existing, content: 'new\n' }] },
      { confirm: () => ({ action: 'decline' }) },
    );

    assert.strictEqual(result.isError, true, 'one file, one refusal: a total failure');
    const failures = result.structured.failures ?? [];
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0]?.error.code, 'CANCELLED');
    assert.match(failures[0]?.error.message ?? '', /declined by the user/);
    assert.strictEqual(await readFile(existing, 'utf-8'), 'old\n');
  });

  it('appends to a file larger than max-file-size', async () => {
    // A >10 MiB file cannot pass through read/edit (TOO_LARGE), but appending
    // one line must still work — the bytes never enter model context.
    const oversize = 11 * 1024 * 1024;
    const file = join(root, 'append_oversize.log');
    await writeFile(file, Buffer.alloc(oversize, 0x61));
    const result = await create({ files: [{ path: file, content: 'x\n', append: true }] });

    assert.notStrictEqual(result.isError, true);
    const entry = result.structured.files[0];
    assert.strictEqual(entry?.size, oversize + 2);
    // The store serves resourceUri via readRaw, which rejects over-cap files
    // with TOO_LARGE — an unservable link must not be advertised at all.
    assert.strictEqual(entry?.resourceUri, undefined);
    const content = await readFile(file, 'utf-8');
    assert.ok(content.endsWith('x\n'));
  });

  it('still reports success for an append whose metadata reads fail', async (t) => {
    // A POSIX write-only (0222) file appends fine but cannot be opened 'r',
    // so the sample/line-count reads throw: the append is the commit point
    // and a reported failure would invite a retry that appends twice.
    if (process.platform === 'win32') return t.skip('POSIX-only 0222 append target');
    if (process.getuid?.() === 0) return t.skip('root bypasses the 0222 mode bits');

    const file = join(root, 'append_write_only.txt');
    await writeFile(file, 'seed\n');
    await chmod(file, 0o222);
    const result = await create({ files: [{ path: file, content: 'tail\n', append: true }] });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(
      result.structured.files[0]?.lineCount,
      0,
      'unreadable metadata degrades to lineCount 0, not a failed append',
    );
    await chmod(file, 0o644);
    assert.strictEqual(await readFile(file, 'utf-8'), 'seed\ntail\n');
  });

  it('takes the append result MIME from the resulting file, not the appended chunk', async () => {
    // Text appended to a binary file does not make it text.
    const file = join(root, 'append_binary_seed');
    await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const result = await create({
      files: [{ path: file, content: 'plain text tail', append: true }],
    });

    assert.notStrictEqual(result.isError, true);
    const entry = result.structured.files[0];
    assert.strictEqual(entry?.kind, 'binary');
    assert.strictEqual(entry?.mimeType, 'application/octet-stream');
    assert.strictEqual(entry?.size, 4 + 'plain text tail'.length);
  });

  it('answers an NTFS stream path with INVALID_INPUT, not a raw EINVAL', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('alternate data streams are an NTFS feature');
      return;
    }
    const result = await create({
      files: [{ path: join(root, 'ads-create.txt:hidden'), content: 'secret' }],
    });
    assert.strictEqual(result.isError, true);
    const failure = result.structured.failures?.[0];
    assert.strictEqual(failure?.error.code, 'INVALID_INPUT');
    assert.match(failure?.error.message ?? '', /NTFS alternate data streams are not supported/);
    assert.doesNotMatch(failure?.error.message ?? '', /EINVAL|\.tmp/);
  });

  it('stamps the resource_link lastModified with the structured modified', async () => {
    const file = join(root, 'created-stamped.txt');
    const result = await create({ files: [{ path: file, content: 'hello\n' }] });

    assert.notStrictEqual(result.isError, true);
    const link = (result.resources ?? []).find((c) => c.type === 'resource_link') as
      { annotations?: { lastModified?: string } } | undefined;
    assert.ok(result.structured.files[0]?.modified);
    assert.strictEqual(link?.annotations?.lastModified, result.structured.files[0]?.modified);
  });

  // H2 (2026-10 bug hunt): concurrent and aliased writes keep every change.
  // Its own root: it symlinks the root into itself.
  it('never overwrites, through an alias, a file that appeared after planning', async (t) => {
    const own = await createTestRoot();
    try {
      const file = join(own, 'concurrent-create.txt');
      const alias = join(own, 'create-alias');
      if (!(await trySymlink(own, alias, () => t.skip('symlinks not permitted')))) return;
      const result = await create(
        {
          files: [
            { path: file, content: 'first' },
            { path: join(alias, 'concurrent-create.txt'), content: 'second' },
          ],
        },
        { fs: new GuardedFileSystem(await makeGuard([own])) },
      );
      assert.strictEqual(result.structured.files.length, 1, JSON.stringify(result.structured));
      const failures = result.structured.failures ?? [];
      assert.strictEqual(failures.length, 1);
      assert.strictEqual(failures[0]?.error.code, 'CANCELLED');
      assert.match(failures[0]?.error.message ?? '', /appeared after overwrite/);
      const contents = await readFile(file, 'utf-8');
      assert.ok(contents === 'first' || contents === 'second');
    } finally {
      await cleanupTestRoot(own);
    }
  });
});
