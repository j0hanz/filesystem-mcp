import assert from 'node:assert/strict';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type * as z from 'zod/v4';

import { ErrorCode } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { RE2_MAX_INPUT_BYTES } from '../src/core/matcher.ts';
import type { PathGuard } from '../src/core/path.ts';
import { MAX_MATCH_LINE_CHARS } from '../src/core/search.ts';
import { PageSnapshotStore, ResourceStore } from '../src/core/store.ts';
import { MAX_SEARCH_RESULTS } from '../src/core/util.ts';
import { SEARCH_TEXT } from '../src/tools/index.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  fsErrorMatcher,
  makeGuard,
  trySymlink,
  withEnv,
  writeTestFile,
} from './helpers.ts';
import { runToolBodyResult, type ToolBodyOptions } from './tool-harness.ts';

type SearchArgs = z.input<typeof SEARCH_TEXT.def.input>;

describe('search_text body', () => {
  let root: string;
  let guard: PathGuard;
  let pageStore: PageSnapshotStore;
  let resourceStore: ResourceStore;

  beforeEach(async () => {
    root = await createTestRoot();
    guard = await makeGuard([root]);
    pageStore = new PageSnapshotStore();
    resourceStore = new ResourceStore();
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  const search = (args: SearchArgs, options: Partial<ToolBodyOptions> = {}) =>
    runToolBodyResult(SEARCH_TEXT, args, { guard, pageStore, resourceStore, ...options });

  it('says which default-named folder it skipped', async () => {
    await writeTestFile(root, 'build/gen.ts', 'needle\n');
    await writeTestFile(root, 'src/a.ts', 'other\n');
    const result = await search({ path: root, searchPattern: 'needle' });
    assert.equal(
      result.text,
      "No matches for 'needle'\n\n// skipped 1 folder by default name (build); pass includeIgnored: true to search it.",
    );
  });

  it('names a skipped folder as a path a later call can use', async () => {
    await writeTestFile(root, 'src/build/gen.ts', 'needle\n');
    const result = await search({ path: join(root, 'src'), searchPattern: 'needle' });
    assert.match(result.text ?? '', /by default name \(src\/build\);/);
  });

  it('caps the skipped folder names at five', async () => {
    for (let i = 1; i <= 7; i++) await writeTestFile(root, `p${String(i)}/dist/x.ts`, 'needle\n');
    const result = await search({ path: root, searchPattern: 'needle' });
    assert.match(
      result.text ?? '',
      /skipped 7 folders by default name \(.*, \+2 more\); pass includeIgnored: true to search them\./,
    );
  });

  it('stays silent about a gitignored default-named folder', async () => {
    await writeTestFile(root, '.gitignore', 'build/\n');
    await writeTestFile(root, 'build/gen.ts', 'needle\n');
    const result = await search({ path: root, searchPattern: 'needle' });
    assert.ok(!(result.text ?? '').includes('by default name'));
  });

  it('prints a named file once, on every page and with context', async () => {
    const file = await writeTestFile(root, 'named/one.txt', 'NEEDLE a\nmid\nNEEDLE b\n');
    const first = await search({ path: file, searchPattern: 'NEEDLE', maxResults: 1, context: 1 });
    assert.ok(first.text?.startsWith('// named/one.txt\n1: NEEDLE a\n2- mid'), first.text);
    const cursor = first.structured.nextCursor;
    assert.ok(cursor);
    const second = await search({
      path: file,
      searchPattern: 'NEEDLE',
      maxResults: 1,
      context: 1,
      cursor,
    });
    assert.ok(second.text?.startsWith('// named/one.txt\n2- mid\n3: NEEDLE b'), second.text);
  });

  it('finds literal matches and renders root-relative paths and line numbers', async () => {
    const dir = join(root, 'grep_dir');
    await writeTestFile(dir, 'target.txt', 'line one\nNEEDLE_MARK here\nline three\n');
    const { structured, text } = await search({ path: dir, searchPattern: 'NEEDLE_MARK' });
    assert.strictEqual(structured.totalMatches, 1);
    assert.strictEqual(structured.matches[0]?.line, 2);
    assert.ok(structured.matches[0]?.content.includes('NEEDLE_MARK'));
    assert.strictEqual(text, 'grep_dir/target.txt:2: NEEDLE_MARK here\n\n// 1 match · 1 file');
  });

  it('prints the match count when one page holds every match', async () => {
    await writeTestFile(root, 'count/a.txt', 'NEEDLE here\nNEEDLE again\n');
    await writeTestFile(root, 'count/b.txt', 'one NEEDLE\n');
    const { text } = await search({ path: root, searchPattern: 'NEEDLE' });
    assert.match(text ?? '', /\/\/ 3 matches · 2 files/u);
  });

  it('leaves the count to the pager when matches span pages', async () => {
    await writeTestFile(root, 'pages/a.txt', 'NEEDLE one\n');
    await writeTestFile(root, 'pages/b.txt', 'NEEDLE two\n');
    const { text } = await search({ path: root, searchPattern: 'NEEDLE', maxResults: 1 });
    assert.doesNotMatch(text ?? '', /\/\/ \d+ matches/u);
    assert.match(text ?? '', /showing 1-/u);
  });

  it('no count line on zero matches', async () => {
    await writeTestFile(root, 'none/a.txt', 'nothing here\n');
    const { text } = await search({ path: root, searchPattern: 'NEEDLE' });
    assert.match(text ?? '', /No matches/u);
    assert.doesNotMatch(text ?? '', /matches ·/u);
  });

  it("honors the allowed root's .gitignore below it", async () => {
    await writeFile(join(root, '.gitignore'), 'scoped_ignored/*.log\n');
    await writeTestFile(root, 'scoped_ignored/keep.txt', 'NEEDLE_G\n');
    await writeTestFile(root, 'scoped_ignored/drop.log', 'NEEDLE_G\n');
    const sub = join(root, 'scoped_ignored');

    const found = await search({ path: sub, searchPattern: 'NEEDLE_G' });
    assert.deepStrictEqual(
      found.structured.matches.map((match) => match.file),
      ['scoped_ignored/keep.txt'],
    );
    const all = await search({ path: sub, searchPattern: 'NEEDLE_G', includeIgnored: true });
    assert.deepStrictEqual(
      all.structured.matches.map((match) => match.file),
      ['scoped_ignored/drop.log', 'scoped_ignored/keep.txt'],
    );
  });

  it('omits sensitive files and does not search through a sensitive pattern prefix', async () => {
    const dir = join(root, 'boundary_walk');
    await writeTestFile(dir, '.env', 'SECRET=needle\n');
    await writeTestFile(dir, 'vault.key/inner.txt', 'needle\n');
    await writeTestFile(dir, 'plain.txt', 'needle\n');

    const found = await search({ path: dir, searchPattern: 'needle', includeHidden: true });
    assert.deepStrictEqual(
      found.structured.matches.map((match) => match.file),
      ['boundary_walk/plain.txt'],
    );
    assert.strictEqual(found.structured.skippedInaccessible, undefined);
    assert.doesNotMatch(found.text ?? '', /inaccessible|\.env|vault\.key/);
    const prefixed = await search({
      path: dir,
      searchPattern: 'needle',
      pattern: 'vault.key/*.txt',
      includeHidden: true,
    });
    assert.deepStrictEqual(prefixed.structured.matches, []);
  });

  it('does not follow a sensitive-named symlink directory', async (t) => {
    const dir = join(root, 'sensitive_link_walk');
    await writeTestFile(dir, 'clean/deep.txt', 'needle\n');
    if (
      !(await trySymlink(join(dir, 'clean'), join(dir, 'alias.key'), () =>
        t.skip('symlink creation not permitted'),
      ))
    ) {
      return;
    }

    const { structured } = await search({ path: dir, searchPattern: 'needle' });
    assert.deepStrictEqual(
      structured.matches.map((match) => match.file),
      ['sensitive_link_walk/clean/deep.txt'],
    );
  });

  it('matches a slash-free glob at any depth but searches an explicit file alone', async () => {
    const dir = join(root, 'basename_glob');
    const top = await writeTestFile(dir, 'top.ts', 'NEEDLE\n');
    await writeTestFile(dir, 'sub/deep.ts', 'NEEDLE\n');
    await writeTestFile(dir, 'sub/top.ts', 'NEEDLE\n');

    const found = await search({ path: dir, pattern: 'deep.ts', searchPattern: 'NEEDLE' });
    assert.deepStrictEqual(
      found.structured.matches.map((match) => match.file),
      ['basename_glob/sub/deep.ts'],
    );
    const named = await search({ path: top, searchPattern: 'NEEDLE' });
    assert.deepStrictEqual(
      named.structured.matches.map((match) => match.file),
      ['basename_glob/top.ts'],
    );
  });

  it('searches a named file containing glob metacharacters, not its decoy', async () => {
    const target = await writeTestFile(root, 'globby/[slug].tsx', 'export const NEEDLE_A = 1;\n');
    await writeTestFile(root, 'globby/s.tsx', 'export const NEEDLE_A = 2;\n');
    const { structured } = await search({ path: target, searchPattern: 'NEEDLE_A' });
    assert.deepStrictEqual(
      structured.matches.map((match) => match.file),
      ['globby/[slug].tsx'],
    );
  });

  it('ignores glob, hidden, and ignored filters for an explicitly named file', async () => {
    const target = await writeTestFile(root, 'explicit_scope/.hidden.log', 'NEEDLE_SCOPE\n');
    await writeTestFile(root, 'explicit_scope/.gitignore', '*.log\n');
    await writeTestFile(root, 'explicit_scope/nested/.hidden.log', 'NEEDLE_SCOPE\n');
    const { structured, text } = await search({
      path: target,
      searchPattern: 'NEEDLE_SCOPE',
      pattern: '**/*.ts',
      includeHidden: false,
      includeIgnored: false,
    });
    assert.strictEqual(
      text,
      '// explicit_scope/.hidden.log\n1: NEEDLE_SCOPE\n\n// 1 match · 1 file',
    );
    assert.deepStrictEqual(
      structured.matches.map(({ file, line }) => ({ file, line })),
      [{ file: 'explicit_scope/.hidden.log', line: 1 }],
    );
  });

  it('does not match a phantom empty line after a trailing newline', async () => {
    const dir = join(root, 'phantom_line');
    await writeTestFile(dir, 'trailing.txt', 'alpha\nbeta\n');
    await writeTestFile(dir, 'blank.txt', 'alpha\n\nbeta\n');
    await writeTestFile(dir, 'empty.txt', '');

    const { structured } = await search({ path: dir, searchPattern: '^$', isRegex: true });
    assert.deepStrictEqual(
      structured.matches.map((match) => `${match.file}:${String(match.line)}`),
      ['phantom_line/blank.txt:2'],
    );
    assert.strictEqual(structured.totalMatches, 1);
  });

  it('replays a stable snapshot after the file is removed', async () => {
    const file = await writeTestFile(root, 'search_pages.txt', 'NEEDLE bravo\nNEEDLE charlie\n');
    const args = { path: file, searchPattern: 'NEEDLE', maxResults: 1 };
    const first = await search(args);
    const cursor = first.structured.nextCursor;
    assert.ok(cursor);

    await rm(file, { force: true });
    const second = await search({ ...args, maxResults: 10, cursor });
    assert.deepStrictEqual(
      [...first.structured.matches, ...second.structured.matches].map((match) => match.content),
      ['NEEDLE bravo', 'NEEDLE charlie'],
    );
    await assert.rejects(
      search({ ...args, searchPattern: 'different query', cursor }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, 'Invalid cursor'),
    );
  });

  it('binds cursors to the query but not the page size', async () => {
    const dir = join(root, 'cursor_identity');
    for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeTestFile(dir, name, 'NEEDLE\n');
    const base = { path: dir, searchPattern: 'NEEDLE', maxResults: 1 };
    const first = await search(base);
    const cursor = first.structured.nextCursor;
    assert.ok(cursor);
    assert.strictEqual(
      (await search({ ...base, maxResults: 10, cursor })).structured.matches.length,
      2,
    );
    const changes: Partial<SearchArgs>[] = [
      { path: root },
      { pattern: '*.txt' },
      { searchPattern: 'NEEDL' },
      { isRegex: true },
      { includeHidden: true },
      { includeIgnored: true },
      { caseSensitive: true },
      { maxDepth: 2 },
      { context: 1 },
    ];
    for (const change of changes) {
      await assert.rejects(
        search({ ...base, ...change, cursor }),
        fsErrorMatcher(ErrorCode.INVALID_INPUT, 'Invalid cursor'),
      );
    }
  });

  it('rejects a cursor for a named file when its context changes', async () => {
    const file = await writeTestFile(root, 'search_ctx_cursor.txt', 'NEEDLE a\nNEEDLE b\n');
    const args = { path: file, searchPattern: 'NEEDLE', maxResults: 1 };
    const first = await search(args);
    const cursor = first.structured.nextCursor;
    assert.ok(cursor);
    await assert.rejects(
      search({ ...args, context: 1, cursor }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, 'Invalid cursor'),
    );
  });

  it('returns context and renders overlapping lines grep-style once', async () => {
    const dir = join(root, 'grep_context');
    await writeTestFile(dir, 'a.txt', 'import x\nNEEDLE one\nconst y\nNEEDLE two\n}\nfiller\n');
    await writeTestFile(dir, 'b.txt', 'foo\nNEEDLE\nbar\n');
    const { structured, text } = await search({ path: dir, searchPattern: 'NEEDLE', context: 1 });
    assert.deepStrictEqual(
      structured.matches.map((match) => [match.file, match.line, match.before, match.after]),
      [
        ['grep_context/a.txt', 2, ['import x'], ['const y']],
        ['grep_context/a.txt', 4, ['const y'], ['}']],
        ['grep_context/b.txt', 2, ['foo'], ['bar']],
      ],
    );
    assert.strictEqual(
      text,
      [
        'grep_context/a.txt-1- import x',
        'grep_context/a.txt:2: NEEDLE one',
        'grep_context/a.txt-3- const y',
        'grep_context/a.txt:4: NEEDLE two',
        'grep_context/a.txt-5- }',
        '--',
        'grep_context/b.txt-1- foo',
        'grep_context/b.txt:2: NEEDLE',
        'grep_context/b.txt-3- bar',
        '',
        '// 3 matches · 2 files',
      ].join('\n'),
    );
    const plain = await search({ path: dir, searchPattern: 'NEEDLE' });
    assert.ok(
      plain.structured.matches.every((match) => !('before' in match) && !('after' in match)),
    );
  });

  it('lets a match beat context on a shared line and stops at the last line', async () => {
    const dir = join(root, 'grep_context_adjacent');
    await writeTestFile(dir, 'c.txt', 'x\nNEEDLE a\nNEEDLE b\n');
    const { structured, text } = await search({ path: dir, searchPattern: 'NEEDLE', context: 1 });
    assert.deepStrictEqual(
      structured.matches.map((match) => [match.line, match.before, match.after]),
      [
        [2, ['x'], ['NEEDLE b']],
        [3, ['NEEDLE a'], []],
      ],
    );
    assert.strictEqual(
      text,
      [
        'grep_context_adjacent/c.txt-1- x',
        'grep_context_adjacent/c.txt:2: NEEDLE a',
        'grep_context_adjacent/c.txt:3: NEEDLE b',
        '',
        '// 2 matches · 1 file',
      ].join('\n'),
    );
  });

  it('clips multi-megabyte match and context lines', async () => {
    const dir = join(root, 'grep_clip_long_line');
    await writeTestFile(
      dir,
      'big.txt',
      'ctx' +
        'c'.repeat(2_000_000) +
        '\n' +
        'x'.repeat(1_000_000) +
        'NEEDLE' +
        'x'.repeat(1_000_000) +
        '\n',
    );
    const { structured, text } = await search({ path: dir, searchPattern: 'NEEDLE', context: 1 });
    assert.ok((text ?? '').length < 5000);
    const match = structured.matches[0];
    assert.ok(match);
    assert.ok(match.content.includes('NEEDLE'));
    assert.ok(match.content.startsWith('…['));
    assert.ok(match.content.endsWith(' chars]'));
    assert.ok(match.content.length < MAX_MATCH_LINE_CHARS + 100);
    assert.strictEqual(match.column, 1_000_000);
    const before = match.before?.[0];
    assert.ok(before !== undefined && before.length < MAX_MATCH_LINE_CHARS + 100);
  });

  it('counts an unreadable directory', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX directory permissions as non-root');
    }
    const dir = join(root, 'search_locked');
    const locked = join(dir, 'locked');
    await writeTestFile(dir, 'a.ts', 'needle');
    await writeTestFile(dir, 'locked/x.ts', 'needle');
    await chmod(locked, 0o000);
    try {
      const { structured } = await search({ path: dir, searchPattern: 'needle' });
      assert.strictEqual(structured.skippedInaccessible, 1);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('fails when an explicitly named file is unreadable', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX directory permissions as non-root');
    }
    const file = await writeTestFile(root, 'search_named_locked/b.txt', 'needle');
    await chmod(file, 0o000);
    try {
      await assert.rejects(search({ path: file, searchPattern: 'needle' }));
    } finally {
      await chmod(file, 0o644);
    }
  });

  it('keeps anchors, word boundaries and CRLF semantics after prefiltering', async () => {
    const dir = join(root, 'prefilter_semantics');
    await writeTestFile(dir, 'lf.txt', 'x\nimport a\n  import b\nfoo$bar\n');
    await writeTestFile(dir, 'crlf.txt', 'alpha\r\nbeta end\r\ngamma\r\n');
    const run = async (searchPattern: string, isRegex: boolean, caseSensitive = true) => {
      const { structured } = await search({ path: dir, searchPattern, isRegex, caseSensitive });
      return structured.matches
        .map(
          (match) =>
            `${match.file.replace(/^prefilter_semantics\//u, '')}:${match.line}:${match.column}`,
        )
        .sort();
    };

    assert.deepStrictEqual(await run('^import', true), ['lf.txt:2:0']);
    assert.deepStrictEqual(await run('end$', true), ['crlf.txt:2:5']);
    assert.deepStrictEqual(await run(String.raw`\bimport\b`, true), ['lf.txt:2:0', 'lf.txt:3:2']);
    assert.deepStrictEqual(await run('IMPORT', false, false), ['lf.txt:2:0', 'lf.txt:3:2']);
    assert.deepStrictEqual(await run('foo$bar', false), ['lf.txt:4:0']);
    assert.deepStrictEqual(await run(String.raw`\Aimport`, true), ['lf.txt:2:0']);
    assert.deepStrictEqual(await run('(?-m)^import', true), ['lf.txt:2:0']);
    assert.deepStrictEqual(await run('(?i)IMPORT', true), ['lf.txt:2:0', 'lf.txt:3:2']);
  });

  it('reports a UTF-16 column after an astral character', async () => {
    const file = await writeTestFile(root, 'emoji.txt', '😀 BETA\n');
    const { structured } = await search({ path: file, searchPattern: 'BETA' });
    assert.strictEqual(structured.matches[0]?.column, 3);
  });

  it('returns the same first page across runs', async () => {
    const dir = join(root, 'determinism');
    for (let i = 0; i < 40; i++) {
      await writeTestFile(dir, `f${String(i).padStart(2, '0')}.txt`, 'DET_HIT\nDET_HIT\nDET_HIT\n');
    }
    const once = async () =>
      (
        await search({ path: dir, searchPattern: 'DET_HIT', maxResults: 25 })
      ).structured.matches.map((match) => `${match.file}:${String(match.line)}`);
    const first = await once();
    assert.deepStrictEqual(first, await once());
    assert.strictEqual(first.length, 25);
  });

  it('externalizes the full match list on the first page only', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `NEEDLE line ${String(i)}`);
    const file = await writeTestFile(root, 'search_first_page.txt', `${lines.join('\n')}\n`);
    const args = { path: file, searchPattern: 'NEEDLE', maxResults: 60 };
    const first = await search(args);
    assert.strictEqual(first.structured.matches.length, 60);
    assert.strictEqual(first.structured.truncated, undefined, 'paging is not engine truncation');
    assert.strictEqual(first.structured.stoppedReason, undefined);
    const cursor = first.structured.nextCursor;
    const uri = first.structured.resourceUri;
    assert.ok(cursor);
    assert.ok(uri);
    const link = first.resources?.[0];
    assert.ok(link?.type === 'resource_link');
    assert.strictEqual(link.uri, uri);
    const full = JSON.parse(resourceStore.getEntry(uri).text) as { matches: { line: number }[] };
    assert.strictEqual(full.matches.length, 120);
    assert.strictEqual(full.matches[0]?.line, 1);
    assert.strictEqual(full.matches[119]?.line, 120);

    const second = await search({ ...args, cursor });
    assert.strictEqual(second.structured.matches.length, 60);
    assert.strictEqual(second.structured.resourceUri, undefined);
    assert.deepStrictEqual(second.resources, []);
  });

  it('reports the page position on the first, intermediate, and last pages', async () => {
    const lines = Array.from({ length: 9 }, (_, i) => `NEEDLE line ${String(i)}`);
    const file = await writeTestFile(root, 'trailer/hits.txt', `${lines.join('\n')}\n`);
    const args = { path: file, searchPattern: 'NEEDLE', maxResults: 4 };
    const first = await search(args);
    assert.match(
      first.text ?? '',
      /^\/\/ showing 1-4 of 9 matches\. Next page: search_text \{.*"searchPattern":"NEEDLE".*"cursor":"/m,
    );
    const cursor = first.structured.nextCursor;
    assert.ok(cursor);
    const second = await search({ ...args, cursor });
    assert.match(second.text ?? '', /^\/\/ showing 5-8 of 9 matches\./m);
    const lastCursor = second.structured.nextCursor;
    assert.ok(lastCursor);
    const last = await search({ ...args, cursor: lastCursor });
    assert.match(last.text ?? '', /^\/\/ showing 9-9 of 9 matches\.$/m);
    assert.doesNotMatch(last.text ?? '', /Next page/);
    const complete = await search({ ...args, maxResults: 50 });
    assert.doesNotMatch(complete.text ?? '', /Next page/);
  });

  it('reports the hard scan cap separately from the page size', async () => {
    const lines = Array.from({ length: MAX_SEARCH_RESULTS + 1 }, (_, i) => `CAPPED ${String(i)}`);
    const file = await writeTestFile(root, 'capped/hits.txt', `${lines.join('\n')}\n`);
    const { structured, text } = await search({
      path: file,
      searchPattern: 'CAPPED',
      maxResults: 5,
    });
    assert.ok((text ?? '').includes(`// showing 1-5 of ${String(MAX_SEARCH_RESULTS)} matches.`));
    assert.ok(
      (text ?? '').includes(
        `// scan stopped early: hit the server's ${String(MAX_SEARCH_RESULTS)}-result scan cap, not your maxResults.`,
      ),
    );
    assert.strictEqual(structured.truncated, true);
    assert.strictEqual(structured.stoppedReason, 'maxResults');
  });

  it('reports a timeout after the named search scope is resolved', async () => {
    const file = await writeTestFile(root, 'timeout.txt', 'needle\n');
    const controller = new AbortController();
    const fs = new (class extends GuardedFileSystem {
      override async stat(...args: Parameters<GuardedFileSystem['stat']>) {
        const result = await super.stat(...args);
        controller.abort(new DOMException('test timeout', 'TimeoutError'));
        return result;
      }
    })(guard);
    const result = await search(
      { path: file, searchPattern: 'needle' },
      { fs, signal: controller.signal },
    );
    assert.strictEqual(result.structured.stoppedReason, 'timeout');
    assert.strictEqual(result.structured.truncated, true);
    assert.match(result.text ?? '', /scan stopped early: hit the time limit/);
    const uri = result.structured.resourceUri;
    assert.ok(uri);
    const full = JSON.parse(resourceStore.getEntry(uri).text) as {
      stoppedReason?: string;
      truncated?: boolean;
    };
    assert.strictEqual(full.stoppedReason, 'timeout');
    assert.strictEqual(full.truncated, true);
  });

  it('names files skipped for size with or without matches', async () => {
    const limit = 1024 * 1024;
    await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
      const dir = join(root, 'skipped_big');
      await writeTestFile(dir, 'big.txt', `BIGNEEDLE\n${'a'.repeat(limit)}`);
      const skipLine = '// skipped 1 file over the text size limit; results may be incomplete.';
      const alone = await search({ path: dir, searchPattern: 'BIGNEEDLE' });
      assert.strictEqual(alone.text, `No matches for 'BIGNEEDLE'\n\n${skipLine}`);

      await writeTestFile(dir, 'small.txt', 'BIGNEEDLE\n');
      const beside = await search({ path: dir, searchPattern: 'BIGNEEDLE' });
      assert.strictEqual(
        beside.text,
        `skipped_big/small.txt:1: BIGNEEDLE\n\n// 1 match · 1 file\n\n${skipLine}`,
      );
    });
  });

  it('counts a file over the size limit in filesScanned', async () => {
    const limit = 1024 * 1024;
    await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
      const dir = join(root, 'scanned_big');
      await writeTestFile(dir, 'big.txt', `NEEDLE\n${'a'.repeat(limit)}`);
      await writeTestFile(dir, 'small.txt', 'NEEDLE\n');
      const { structured } = await search({ path: dir, searchPattern: 'NEEDLE' });
      assert.strictEqual(structured.filesScanned, 2);
      assert.strictEqual(structured.skippedTooLarge, 1);
    });
  });

  it('explains zero matches caused by a likely regex or a glob that selects no files', async () => {
    const dir = join(root, 'zero_hint');
    await writeTestFile(dir, 'a.ts', 'const TOKEN1 = 1;\nconst token2 = 2;\n');
    const regexLine =
      '// searchPattern was matched as literal text but looks like a regex; pass isRegex=true to match it as one.';
    const globLine =
      "// no files were searched: nothing under path matched pattern '**/*.py' after the hidden/ignored/maxDepth filters. pattern is a file-name glob; the text to find goes in searchPattern.";
    const text = async (args: SearchArgs) => (await search({ path: dir, ...args })).text;

    assert.strictEqual(
      await text({ searchPattern: 'TOKEN1|token2' }),
      `No matches for 'TOKEN1|token2'\n${regexLine}`,
    );
    assert.strictEqual(
      await text({ searchPattern: 'TOKEN1', pattern: '**/*.py' }),
      `No matches for 'TOKEN1'\n${globLine}`,
    );
    for (const literal of ['foo(', 'a.b', 'x || y', 'arr[0]', 'string | undefined', '|x| x']) {
      assert.strictEqual(await text({ searchPattern: literal }), `No matches for '${literal}'`);
    }
  });

  it('reports a binary skip and gives no pattern hint when every file was skipped', async () => {
    const dir = join(root, 'only_binary');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'b.bin'), Buffer.from([0, 0x61, 0x7c, 0x62, 0]));
    const { text } = await search({ path: dir, searchPattern: 'a|b' });
    assert.strictEqual(
      text,
      "No matches for 'a|b'\n\n// skipped 1 binary file; results may be incomplete.",
    );
  });

  it('keeps the pattern hint when a binary skip sits beside searched text files', async () => {
    const dir = join(root, 'binary_beside_text');
    await writeTestFile(dir, 'a.ts', 'const x = 1;\n');
    await writeFile(join(dir, 'b.bin'), Buffer.from([0, 0x61, 0x7c, 0x62, 0]));
    const { text } = await search({ path: dir, searchPattern: 'foo|bar' });
    assert.strictEqual(
      text,
      "No matches for 'foo|bar'\n" +
        '// searchPattern was matched as literal text but looks like a regex; pass isRegex=true to match it as one.' +
        '\n\n// skipped 1 binary file; results may be incomplete.',
    );
  });

  it('keeps the skip line on a later page', async () => {
    const dir = join(root, 'paged_binary');
    await writeTestFile(dir, 'a.txt', 'PAGED\nPAGED\nPAGED\n');
    await writeFile(join(dir, 'b.bin'), Buffer.from([0, 0x61, 0]));
    const args = { path: dir, searchPattern: 'PAGED', maxResults: 1 };
    const first = await search(args);
    const cursor = first.structured.nextCursor;
    assert.ok(cursor);
    const second = await search({ ...args, cursor });
    assert.match(second.text ?? '', /\/\/ skipped 1 binary file; results may be incomplete\./);
  });

  it('refuses a named binary file', async () => {
    const dir = join(root, 'named_binary');
    await mkdir(dir, { recursive: true });
    const blob = join(dir, 'b.bin');
    await writeFile(blob, Buffer.from([0, 0x61, 0]));
    await assert.rejects(
      search({ path: blob, searchPattern: 'a' }),
      fsErrorMatcher(ErrorCode.BINARY_FILE),
    );
  });

  it('refuses a named UTF-16 file', async () => {
    const dir = join(root, 'named_utf16');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'u.txt');
    await writeFile(file, Buffer.from([0xff, 0xfe, 0x61, 0x00]));
    await assert.rejects(
      search({ path: file, searchPattern: 'a' }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /UTF-16/),
    );
  });

  it('refuses a named file with an overlong regex line, and names the line', async () => {
    const file = await writeTestFile(
      join(root, 'named_overlong'),
      'huge.txt',
      `${'a'.repeat(RE2_MAX_INPUT_BYTES + 1024)} NEEDLE`,
    );
    await assert.rejects(
      search({ path: file, searchPattern: 'NEEDLE', isRegex: true }),
      fsErrorMatcher(ErrorCode.TOO_LARGE, /line/),
    );
  });

  it('tells a literal search refused for an overlong line how to recover', async () => {
    const file = await writeTestFile(
      join(root, 'named_overlong_literal'),
      'huge.txt',
      `${'a'.repeat(RE2_MAX_INPUT_BYTES + 1024)} café`,
    );
    await assert.rejects(
      search({ path: file, searchPattern: 'café' }),
      fsErrorMatcher(ErrorCode.TOO_LARGE, /pass caseSensitive: true/),
    );
    const { structured } = await search({ path: file, searchPattern: 'café', caseSensitive: true });
    assert.strictEqual(structured.totalMatches, 1);
  });

  it('still searches a named undecodable file lossily', async () => {
    const dir = join(root, 'named_lossy');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'late-latin1.txt');
    await writeFile(
      file,
      Buffer.concat([
        Buffer.alloc(600, 'a'),
        Buffer.from('\nNEEDLE caf'),
        Buffer.from([0xe9, 0x0a]),
      ]),
    );
    const { structured } = await search({ path: file, searchPattern: 'NEEDLE' });
    assert.strictEqual(structured.totalMatches, 1);
  });

  /** A valid head past the 512-byte binary probe, then `tail` undecodable bytes. */
  const lossyBody = (tail: Buffer): Buffer =>
    Buffer.concat([Buffer.from(`${'text line\n'.repeat(100)}NEEDLE here\n`), tail]);

  it('finds a match in a lossy file whose decoded text outgrows the regex limit', async () => {
    const dir = join(root, 'lossy_lines');
    await mkdir(dir, { recursive: true });
    // 64 KiB invalid-byte lines: 3.9 MiB raw, about 11.7 MB decoded, each line small.
    const line = Buffer.concat([Buffer.alloc(64 * 1024, 0xe9), Buffer.from('\n')]);
    await writeFile(
      join(dir, 'latin.log'),
      lossyBody(Buffer.concat(new Array<Buffer>(62).fill(line))),
    );

    const { structured } = await search({ path: dir, searchPattern: 'NEE+DLE', isRegex: true });

    assert.strictEqual(structured.totalMatches, 1);
    assert.strictEqual(structured.skippedInaccessible, undefined);
  });

  it('counts a walked lossy file with one overlong decoded line as too large', async () => {
    const dir = join(root, 'lossy_walked');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'latin.log'), lossyBody(Buffer.alloc(3_900_000, 0xe9)));

    const { structured } = await search({ path: dir, searchPattern: 'NEE+DLE', isRegex: true });

    assert.strictEqual(structured.skippedTooLarge, 1);
    assert.strictEqual(structured.skippedInaccessible, undefined);
  });

  it('refuses a named lossy file with one overlong decoded line, and names the line', async () => {
    const dir = join(root, 'lossy_named');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'latin.log');
    await writeFile(file, lossyBody(Buffer.alloc(3_900_000, 0xe9)));

    await assert.rejects(
      search({ path: file, searchPattern: 'NEE+DLE', isRegex: true }),
      fsErrorMatcher(ErrorCode.TOO_LARGE, /line/),
    );
  });

  it('leaves regex search whole after repeated searches over a lossy file', async () => {
    const dir = join(root, 'lossy_repeat');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'latin.log'), lossyBody(Buffer.alloc(3_900_000, 0xe9)));
    for (let i = 0; i < 3; i++) {
      await search({ path: dir, searchPattern: 'NEE+DLE', isRegex: true });
    }

    const body = 'abc NEEDLE\n';
    const large = await writeTestFile(
      join(root, 'lossy_after'),
      'valid.txt',
      body.repeat(Math.floor((3.9 * 1024 * 1024) / body.length)),
    );
    const { structured } = await search({
      path: large,
      searchPattern: 'NEE+DLE',
      isRegex: true,
      maxResults: 1,
    });
    assert.ok((structured.totalMatches ?? 0) >= 1);
  });

  it('skips binary files and reports the count', async () => {
    const dir = join(root, 'search_bin');
    await writeTestFile(dir, 'text.txt', 'BINNEEDLE\n');
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0x00, ...Buffer.from('BINNEEDLE'), 0x00]));
    const { structured, text } = await search({ path: dir, searchPattern: 'BINNEEDLE' });
    assert.strictEqual(
      text,
      'search_bin/text.txt:1: BINNEEDLE\n\n// 1 match · 1 file\n\n// skipped 1 binary file; results may be incomplete.',
    );
    assert.strictEqual(structured.filesScanned, 2);
    assert.strictEqual(structured.skippedBinary, 1);
  });
});
