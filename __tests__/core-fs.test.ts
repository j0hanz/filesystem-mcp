import assert from 'node:assert/strict';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { buildWrittenFileMeta } from '../src/core/file-uri.ts';
import { countFileLines, GuardedFileSystem } from '../src/core/fs.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import { searchContent, searchFiles } from '../src/core/search.ts';
import { getMaxTextFileSize } from '../src/core/util.ts';
import type { FilesystemServerContext } from '../src/server.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  createTestServer,
  trySymlink,
  writeNLineFile,
  writeTestFile,
} from './helpers.ts';

describe('Core Filesystem (GuardedFileSystem + core search) Tests', () => {
  let tmpDir: string;
  let ctx: FilesystemServerContext;
  let fs: GuardedFileSystem;

  before(async () => {
    tmpDir = await createTestRoot();
    ctx = await createTestServer([tmpDir]);
    fs = new GuardedFileSystem(ctx.pathGuard);
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

  describe('Read slicing & batch (TC-FUNC-002–006)', () => {
    it('TC-FUNC-002: readFile with head slicing returns first N lines', async () => {
      const filePath = await writeNLineFile(tmpDir, 'read_head.txt', 10);
      const result = await fs.readFile(filePath, { kind: 'head', lines: 5 });

      assert.strictEqual(result.readMode, 'head');
      assert.strictEqual(result.head, 5);
      assert.strictEqual(result.linesRead, 5);
      assert.strictEqual(result.hasMoreLines, true);
      assert.strictEqual(result.content, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
    });

    it('TC-FUNC-003: readFile with tail slicing returns last N lines', async () => {
      const filePath = await writeNLineFile(tmpDir, 'read_tail.txt', 10);
      const result = await fs.readFile(filePath, { kind: 'tail', lines: 3 });

      assert.strictEqual(result.readMode, 'tail');
      assert.strictEqual(result.tail, 3);
      assert.strictEqual(result.linesRead, 3);
      assert.strictEqual(result.content, 'Line 8\nLine 9\nLine 10');
    });

    it('TC-FUNC-004: readFile with line range returns specific lines', async () => {
      const filePath = await writeNLineFile(tmpDir, 'read_range.txt', 10);
      const result = await fs.readFile(filePath, {
        kind: 'range',
        start: 2,
        end: 4,
      });

      assert.strictEqual(result.readMode, 'range');
      assert.strictEqual(result.startLine, 2);
      assert.strictEqual(result.endLine, 4);
      assert.strictEqual(result.linesRead, 3);
      assert.strictEqual(result.content, 'Line 2\nLine 3\nLine 4');
    });

    it('TC-FUNC-006: readFile full returns entire content and line count', async () => {
      const filePath = await writeNLineFile(tmpDir, 'read_full.txt', 5);
      const result = await fs.readFile(filePath, { kind: 'full' });

      assert.strictEqual(result.readMode, 'full');
      assert.strictEqual(result.totalLines, 5);
      assert.strictEqual(result.hasMoreLines, false);
      assert.strictEqual(result.content, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n');
    });
  });

  describe('Editable text loading', () => {
    it('readEditableText returns validated path, content, and stats', async () => {
      const filePath = await writeTestFile(tmpDir, 'editable.txt', 'editable content');

      const result = await fs.readEditableText(filePath);

      assert.strictEqual(result.validPath, normalizePath(filePath));
      assert.strictEqual(result.content, 'editable content');
      assert.strictEqual(result.stats.size, Buffer.byteLength('editable content'));
    });

    it('readEditableText rejects files above the configured text limit', async () => {
      const previous = process.env['FS_MAX_FILE_SIZE'];
      const limit = 1024 * 1024;
      process.env['FS_MAX_FILE_SIZE'] = String(limit);
      try {
        const filePath = join(tmpDir, 'too-large.txt');
        await writeFile(filePath, Buffer.alloc(limit + 1, 0x61));

        await assert.rejects(
          fs.readEditableText(filePath),
          (error) =>
            isFsError(error) &&
            error.code === ErrorCode.TOO_LARGE &&
            error.message.includes('File too large for edit'),
        );
      } finally {
        if (previous === undefined) delete process.env['FS_MAX_FILE_SIZE'];
        else process.env['FS_MAX_FILE_SIZE'] = previous;
      }
    });

    it('readEditableText rejects binary files', async () => {
      const filePath = join(tmpDir, 'editable.png');
      await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

      await assert.rejects(
        fs.readEditableText(filePath),
        (error) =>
          isFsError(error) &&
          error.code === ErrorCode.INVALID_INPUT &&
          error.message === 'Binary file detected.',
      );
    });

    // Issue #11: the 512-byte binary probe must not reject a multi-byte
    // character cut by the sample boundary, but must still reject a byte that
    // no continuation can make valid.
    it('binary probe accepts UTF-8 split at the sample boundary', async () => {
      for (const [name, text] of [
        ['split-cjk.md', '我'.repeat(171)],
        ['split-emoji.txt', `${'a'.repeat(510)}${'😀'.repeat(4)}`],
        ['split-latin.txt', `${'a'.repeat(511)}${'é'.repeat(4)}`],
      ] as const) {
        const filePath = join(tmpDir, name);
        await writeFile(filePath, text);
        assert.strictEqual((await fs.readFile(filePath, { kind: 'full' })).content, text, name);
        assert.strictEqual((await fs.readEditableText(filePath)).content, text, name);
      }

      const invalid = join(tmpDir, 'split-invalid.txt');
      await writeFile(invalid, Buffer.concat([Buffer.alloc(511, 0x61), Buffer.from([0xc0, 0x61])]));
      await assert.rejects(
        fs.readFile(invalid, { kind: 'full' }),
        (error) => isFsError(error) && error.message === 'Binary file detected.',
      );
    });

    it('readEditableText rejects non-UTF-8 bytes past the binary probe', async () => {
      const filePath = join(tmpDir, 'latin1-late.txt');
      await writeFile(
        filePath,
        Buffer.concat([
          Buffer.alloc(600, 0x61),
          Buffer.from('\ncaf'),
          Buffer.from([0xe9]),
          Buffer.from('\n'),
        ]),
      );
      await assert.rejects(
        fs.readEditableText(filePath),
        (error) =>
          isFsError(error) &&
          error.code === ErrorCode.INVALID_INPUT &&
          error.message === 'Binary or non-UTF-8 file detected.',
      );
      // The read-only `read` tool path must stay lossy-but-tolerant: unchanged behavior.
      const fullRead = await fs.readFile(filePath, { kind: 'full' });
      assert.ok(fullRead.content.endsWith('caf\uFFFD\n'));

      const utf16 = join(tmpDir, 'utf16le.txt');
      await writeFile(
        utf16,
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello\n', 'utf16le')]),
      );
      await assert.rejects(
        fs.readEditableText(utf16),
        (error) =>
          isFsError(error) &&
          error.code === ErrorCode.INVALID_INPUT &&
          error.message === 'Binary or non-UTF-8 file detected.',
      );
    });
  });

  describe('Create nested & overwrite (TC-FUNC-010–011)', () => {
    it('TC-FUNC-010: writeFile in deep nested path after creating parent directories', async () => {
      const nestedPath = join(tmpDir, 'deep', 'nested', 'subfolder', 'file.txt');
      await fs.mkdir(dirname(nestedPath), { recursive: true });
      await fs.writeFile(nestedPath, 'deep nested content');

      const { content } = await fs.readRaw(nestedPath);
      assert.strictEqual(content.toString('utf-8'), 'deep nested content');
    });

    it('TC-FUNC-011: writeFile overwriting existing file', async () => {
      const filePath = join(tmpDir, 'overwrite_target.txt');
      await fs.writeFile(filePath, 'initial content');

      const initialRead = await fs.readRaw(filePath);
      assert.strictEqual(initialRead.content.toString('utf-8'), 'initial content');

      await fs.writeFile(filePath, 'overwritten content');

      const overwrittenRead = await fs.readRaw(filePath);
      assert.strictEqual(overwrittenRead.content.toString('utf-8'), 'overwritten content');
    });
  });

  describe('Append (TC-FUNC-047–052)', () => {
    it('TC-FUNC-047: appendFile creates a missing file with the content', async () => {
      const filePath = join(tmpDir, 'append_missing.txt');
      const { validPath } = await fs.appendFile(filePath, 'created by append\n');

      const { content } = await fs.readRaw(validPath);
      assert.strictEqual(content.toString('utf-8'), 'created by append\n');
    });

    it('TC-FUNC-048: appendFile appends to an existing file', async () => {
      const filePath = await writeTestFile(tmpDir, 'append_existing.txt', 'first\n');
      await fs.appendFile(filePath, 'second\n');

      const { content } = await fs.readRaw(filePath);
      assert.strictEqual(content.toString('utf-8'), 'first\nsecond\n');
    });

    it('TC-FUNC-049: appendFile keeps the existing inode and mode', async (t) => {
      // Windows stat cannot represent 0600 (chmod only toggles the readonly
      // bit), and its st_ino is not guaranteed stable across handles. POSIX
      // proves the no-temp-rename design; Windows gets it by construction —
      // fs.appendFile never creates a replacement file.
      if (process.platform === 'win32') return t.skip('POSIX-only inode/mode assertions');

      const filePath = await writeTestFile(tmpDir, 'append_inode_mode.txt', 'secret\n');
      await chmod(filePath, 0o600);
      const before = await stat(filePath);

      await fs.appendFile(filePath, 'more\n');

      const after = await stat(filePath);
      assert.strictEqual(after.ino, before.ino);
      assert.strictEqual(after.mode & 0o777, 0o600);
      const { content } = await fs.readRaw(filePath);
      assert.strictEqual(content.toString('utf-8'), 'secret\nmore\n');
    });

    it('TC-FUNC-050: appendFile follows an in-root symlink to its target', async (t) => {
      const target = await writeTestFile(tmpDir, 'append_link_target.txt', 't\n');
      const linkPath = join(tmpDir, 'append_link.txt');
      if (!(await trySymlink(target, linkPath, () => t.skip('symlink not permitted'), 'file')))
        return;

      await fs.appendFile(linkPath, 'appended\n');

      const { content } = await fs.readRaw(target);
      assert.strictEqual(content.toString('utf-8'), 't\nappended\n');
    });

    it('TC-FUNC-051: appendFile through an out-of-root symlink is denied', async (t) => {
      const outside = join(dirname(tmpDir), 'fsmcp_append_outside_target.txt');
      const linkPath = join(tmpDir, 'append_escape_link.txt');
      if (!(await trySymlink(outside, linkPath, () => t.skip('symlink not permitted'), 'file')))
        return;

      await assert.rejects(fs.appendFile(linkPath, 'nope'), (err: unknown) => {
        assert(isFsError(err));
        assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
        return true;
      });
    });

    it('TC-FUNC-052a: countFileLines matches countLines across the buffer boundary', async () => {
      // >64 KiB so the counter crosses its read-buffer boundary, with the
      // final line left unterminated to exercise the last-byte rule.
      const lines = Array.from({ length: 12000 }, (_, i) => `line-${String(i)}`);
      const filePath = await writeTestFile(tmpDir, 'count_lines_big.txt', lines.join('\n'));

      assert.strictEqual(await countFileLines(filePath), lines.length);
    });

    it('TC-FUNC-052c: a NUL final byte counts as an unterminated line, not an empty file', async () => {
      const filePath = await writeTestFile(tmpDir, 'count_lines_nul.txt', 'x\n\0');

      assert.strictEqual(await countFileLines(filePath), 2);
    });

    it('TC-FUNC-052d: a single physical line larger than the read buffer counts as 1 line', async () => {
      // Regression guard for the readLines() rewrite: FileHandle.readLines
      // decodes each physical line whole, so this ~200 KiB no-newline file
      // OOMs a multi-GB version of itself. The byte counter must not.
      const filePath = await writeTestFile(
        tmpDir,
        'count_lines_huge_line.txt',
        'x'.repeat(200 * 1024),
      );

      assert.strictEqual(await countFileLines(filePath), 1);
    });

    it('TC-FUNC-049b: appendFile to a sensitive file is denied', async () => {
      const envPath = join(tmpDir, '.env');
      await writeTestFile(tmpDir, '.env', 'SECRET=1\n');

      await assert.rejects(fs.appendFile(envPath, 'LEAKED=1\n'), (err: unknown) => {
        assert(isFsError(err));
        assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
        return true;
      });
      // Verify with plain node fs — the guarded read would block on .env too.
      assert.strictEqual(await readFile(envPath, 'utf-8'), 'SECRET=1\n');
    });

    it('TC-FUNC-049c: appendFile through an in-root symlink to a sensitive file is denied', async (t) => {
      const target = await writeTestFile(tmpDir, '.env', 'SECRET=1\n');
      const linkPath = join(tmpDir, 'env_link');
      if (!(await trySymlink(target, linkPath, () => t.skip('symlink not permitted'), 'file')))
        return;

      await assert.rejects(fs.appendFile(linkPath, 'LEAKED=1\n'), (err: unknown) => {
        assert(isFsError(err));
        assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
        return true;
      });
      assert.strictEqual(await readFile(target, 'utf-8'), 'SECRET=1\n');
    });

    it('TC-FUNC-047b: appendFile with an aborted signal writes nothing', async () => {
      const filePath = await writeTestFile(tmpDir, 'append_abort.txt', 'stable\n');
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(fs.appendFile(filePath, 'discarded\n', { signal: controller.signal }));
      assert.strictEqual((await fs.readRaw(filePath)).content.toString('utf-8'), 'stable\n');
    });

    it('TC-FUNC-047c: an aborted append to a missing file creates nothing', async () => {
      // 'a' mode creates the target on open; the abort check must precede the
      // open or a rejected call still leaves a new empty file behind.
      const filePath = join(tmpDir, 'append_abort_missing.txt');
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(fs.appendFile(filePath, 'nope\n', { signal: controller.signal }));
      await assert.rejects(stat(filePath), (err: unknown) => {
        assert(isFsError(err) || (err as NodeJS.ErrnoException).code === 'ENOENT');
        return true;
      });
    });

    it('TC-FUNC-052b: countFileLines handles empty and trailing-newline files', async () => {
      const emptyPath = await writeTestFile(tmpDir, 'count_lines_empty.txt', '');
      assert.strictEqual(await countFileLines(emptyPath), 0);

      const terminatedPath = await writeTestFile(tmpDir, 'count_lines_term.txt', 'a\nb\n');
      assert.strictEqual(await countFileLines(terminatedPath), 2);
    });

    it('TC-FUNC-052e: countFileLines counts LF only — a CRLF file is not double-counted', async () => {
      // Guards against a CR-counting "fix" for old-Mac files: every line is
      // terminated by a CR too, so counting both terminators doubles the
      // line count of the CRLF text files this server runs against on Windows.
      const filePath = await writeTestFile(tmpDir, 'count_lines_crlf.txt', 'a\r\nb\r\nc');

      assert.strictEqual(await countFileLines(filePath), 3);
    });

    it('TC-FUNC-053: appendFile to a non-regular file is rejected before the open', async () => {
      // 'a' on a FIFO blocks POSIX until a reader appears, unabortable; a
      // directory is the cross-platform stand-in for "target is not a file".
      await assert.rejects(fs.appendFile(tmpDir, 'nope\n'), (err: unknown) => {
        assert(isFsError(err));
        assert.strictEqual(err.code, ErrorCode.NOT_FILE);
        return true;
      });
    });

    it('TC-FUNC-054: buildWrittenFileMeta omits the URI over the text cap', () => {
      // An edit or patch can push a readable file past the text-size cap;
      // a resourceUri the store's readRaw would reject with TOO_LARGE must
      // never be advertised.
      const huge = 'x'.repeat(10 * 1024 * 1024 + 1);
      const meta = buildWrittenFileMeta(join(tmpDir, 'huge.txt'), huge, undefined);
      assert.strictEqual(meta.size, huge.length);
      assert.strictEqual(meta.resourceUri, undefined);
      assert.strictEqual(meta.resourceLink, undefined);

      const small = buildWrittenFileMeta(join(tmpDir, 'small.txt'), 'hi', undefined);
      assert.ok(small.resourceUri, 'under the cap the URI is advertised');
    });
  });

  describe('Stat metadata (TC-FUNC-031–034)', () => {
    it('TC-FUNC-031: statDetailed on a file returns stats and isSymlink=false', async () => {
      const filePath = await writeTestFile(tmpDir, 'stat_file.txt', 'stat metadata test');
      const detail = await fs.statDetailed(filePath);

      assert.strictEqual(detail.isSymlink, false);
      assert.strictEqual(detail.stats.isFile(), true);
      assert.strictEqual(detail.stats.isDirectory(), false);
      assert.strictEqual(detail.stats.size, Buffer.byteLength('stat metadata test'));
    });

    it('TC-FUNC-032: statDetailed on a dir returns stats.isDirectory()=true', async () => {
      const dirPath = join(tmpDir, 'stat_test_directory');
      await fs.mkdir(dirPath);

      const detail = await fs.statDetailed(dirPath);

      assert.strictEqual(detail.isSymlink, false);
      assert.strictEqual(detail.stats.isDirectory(), true);
      assert.strictEqual(detail.stats.isFile(), false);
    });

    it('lstat propagates an already-aborted signal', async () => {
      const filePath = await writeTestFile(tmpDir, 'aborted-lstat.txt', 'content');
      const reason = new Error('lstat aborted');
      const controller = new AbortController();
      controller.abort(reason);

      await assert.rejects(fs.lstat(filePath, { signal: controller.signal }), (error) => {
        assert.strictEqual(error, reason);
        return true;
      });
    });
  });

  describe('Search & Glob (TC-FUNC-039–046)', () => {
    it('TC-FUNC-039: searchFiles with pattern matching filters files', async () => {
      await writeTestFile(tmpDir, 'search_dir/moduleA.ts', 'export const a = 1;');
      await writeTestFile(tmpDir, 'search_dir/moduleB.ts', 'export const b = 2;');
      await writeTestFile(tmpDir, 'search_dir/notes.txt', 'some notes');
      await writeTestFile(tmpDir, 'search_dir/sub/moduleC.ts', 'export const c = 3;');
      await writeTestFile(tmpDir, 'search_dir/sub/readme.txt', 'readme doc');

      const searchDir = join(tmpDir, 'search_dir');

      const tsResults = await searchFiles(searchDir, '**/*.ts', {}, ctx.pathGuard);
      assert.strictEqual(tsResults.results.length, 3);
      assert.ok(tsResults.results.every((r) => r.path.endsWith('.ts')));

      const txtResults = await searchFiles(searchDir, '**/*.txt', {}, ctx.pathGuard);
      assert.strictEqual(txtResults.results.length, 2);
      assert.ok(txtResults.results.every((r) => r.path.endsWith('.txt')));
    });

    it("TC-FUNC-039b: searchFiles sortBy 'name' orders by basename, not full path", async () => {
      await writeTestFile(tmpDir, 'sort_dir/zzz/alpha.ts', '// a');
      await writeTestFile(tmpDir, 'sort_dir/aaa/omega.ts', '// o');

      const sortDir = join(tmpDir, 'sort_dir');
      const byName = await searchFiles(sortDir, '**/*.ts', { sortBy: 'name' }, ctx.pathGuard);
      assert.deepStrictEqual(
        byName.results.map((r) => basename(r.path)),
        ['alpha.ts', 'omega.ts'],
      );

      const byPath = await searchFiles(sortDir, '**/*.ts', {}, ctx.pathGuard);
      assert.deepStrictEqual(
        byPath.results.map((r) => basename(r.path)),
        ['omega.ts', 'alpha.ts'],
      );
    });

    it('TC-FUNC-040: searchContent matches literal patterns across files', async () => {
      const searchContentDir = join(tmpDir, 'search_content_dir');
      await writeTestFile(
        searchContentDir,
        'file1.txt',
        'First line\nTARGET_LITERAL_STRING in file1\nThird line',
      );
      await writeTestFile(searchContentDir, 'file2.txt', 'No match here\nStill nothing');
      await writeTestFile(
        searchContentDir,
        'file3.txt',
        'TARGET_LITERAL_STRING at line 1\nAnother TARGET_LITERAL_STRING line',
      );

      const outcome = await searchContent(
        searchContentDir,
        'TARGET_LITERAL_STRING',
        { isRegex: false },
        ctx.pathGuard,
      );

      assert.strictEqual(outcome.summary.filesMatched, 2);
      assert.strictEqual(outcome.summary.matchingLines, 3);
      assert.strictEqual(outcome.matches.length, 3);
      assert.ok(outcome.matches.every((m) => m.content.includes('TARGET_LITERAL_STRING')));
    });
  });

  describe('Delete guards (TC-FUNC-018–020)', () => {
    it('TC-FUNC-018: hasChildrenUnchecked distinguishes empty vs non-empty directories', async () => {
      const emptyDir = join(tmpDir, 'empty_dir_guard');
      await fs.mkdir(emptyDir);

      const emptyHasChildren = await fs.hasChildrenUnchecked(emptyDir);
      assert.strictEqual(emptyHasChildren, false);

      const nonEmptyDir = join(tmpDir, 'non_empty_dir_guard');
      await fs.mkdir(nonEmptyDir);
      await writeTestFile(nonEmptyDir, 'child.txt', 'child content');

      const nonEmptyHasChildren = await fs.hasChildrenUnchecked(nonEmptyDir);
      assert.strictEqual(nonEmptyHasChildren, true);
    });

    it('TC-FUNC-019: rm with recursive=true removes non-empty directory', async () => {
      const dirToDelete = join(tmpDir, 'dir_to_delete');
      await fs.mkdir(dirToDelete);
      await writeTestFile(dirToDelete, 'file1.txt', 'f1');
      await writeTestFile(dirToDelete, 'sub/file2.txt', 'f2');

      await fs.rm(dirToDelete, { recursive: true, force: true });

      await assert.rejects(
        () => fs.stat(dirToDelete),
        (err: unknown) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.NOT_FOUND);
          return true;
        },
      );
    });
  });

  describe('Invalid setting warnings (TC-FUNC-019b)', () => {
    it('TC-FUNC-019b: a rejected numeric setting warns once and is not gated by --log-level', () => {
      const priorLevel = process.env['FS_LOG_LEVEL'];
      const priorBytes = process.env['FS_MAX_FILE_SIZE'];
      const realError = console.error;
      const collected: string[] = [];

      process.env['FS_LOG_LEVEL'] = 'error';
      process.env['FS_MAX_FILE_SIZE'] = 'not-a-number';
      console.error = (...args: unknown[]) => {
        collected.push(args.map(String).join(' '));
      };

      try {
        const first = getMaxTextFileSize();
        const second = getMaxTextFileSize();

        assert.strictEqual(first, 10 * 1024 * 1024, 'falls back to the documented default');
        assert.strictEqual(second, first);

        const warnings = collected.filter((line) =>
          line.includes('Invalid FS_MAX_FILE_SIZE value'),
        );
        // Once per (setting, value), not once per call — and it reaches stderr
        // despite FS_LOG_LEVEL=error, which used to suppress this one warning
        // while leaving FS_ALLOW_SENSITIVE and FS_LOG_LEVEL typos visible.
        assert.strictEqual(
          warnings.length,
          1,
          `expected one warning, got ${JSON.stringify(collected)}`,
        );
        assert.match(
          warnings[0] ?? '',
          /^\[warning\] Invalid FS_MAX_FILE_SIZE value: not-a-number \(must be 1048576-104857600\)\. Using default: 10485760$/,
        );
      } finally {
        console.error = realError;
        if (priorLevel === undefined) delete process.env['FS_LOG_LEVEL'];
        else process.env['FS_LOG_LEVEL'] = priorLevel;
        if (priorBytes === undefined) delete process.env['FS_MAX_FILE_SIZE'];
        else process.env['FS_MAX_FILE_SIZE'] = priorBytes;
      }
    });
  });
});
