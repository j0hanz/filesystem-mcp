import assert from 'node:assert/strict';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type * as z from 'zod/v4';

import { ErrorCode } from '../src/core/errors.ts';
import { formatByteSize } from '../src/core/fmt.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import type { PathGuard } from '../src/core/path.ts';
import { PageSnapshotStore, ResourceStore } from '../src/core/store.ts';
import { LIST } from '../src/tools/index.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  fsErrorMatcher,
  makeGuard,
  trySymlink,
  writeTestFile,
} from './helpers.ts';
import { runToolBodyResult, type ToolBodyOptions } from './tool-harness.ts';

type ListArgs = z.input<typeof LIST.def.input>;

describe('list body', () => {
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

  const list = (args: ListArgs, options: Partial<ToolBodyOptions> = {}) =>
    runToolBodyResult(LIST, args, { guard, pageStore, resourceStore, ...options });

  it('replays a second page from the same snapshot', async () => {
    await writeTestFile(root, 'a.txt', 'a');
    await writeTestFile(root, 'b.txt', 'b');

    const first = await list({ path: root, maxEntries: 1 });
    const cursor = first.structured.nextCursor;
    assert.ok(cursor);
    const second = await list({ path: root, maxEntries: 1, cursor });

    assert.deepStrictEqual(
      first.structured.entries.map((entry) => entry.name),
      ['a.txt'],
    );
    assert.deepStrictEqual(
      second.structured.entries.map((entry) => entry.name),
      ['b.txt'],
    );
    assert.strictEqual(second.structured.nextCursor, undefined);
  });

  it('stores the full result behind the first page resource', async () => {
    await writeTestFile(root, 'a.txt', 'a');
    await writeTestFile(root, 'b.txt', 'b');

    const first = await list({ path: root, maxEntries: 1 });
    const uri = first.structured.resourceUri;
    assert.ok(uri);
    const link = first.resources?.[0];
    assert.ok(link?.type === 'resource_link');
    assert.strictEqual(link.uri, uri);
    const full = JSON.parse(resourceStore.getEntry(uri).text) as { entries: { name: string }[] };
    assert.deepStrictEqual(
      full.entries.map((entry) => entry.name),
      ['a.txt', 'b.txt'],
    );
  });

  it('the full-tree resource says what the page says it left out', async () => {
    await writeTestFile(root, '.gitignore', 'docs/\n');
    await writeTestFile(root, 'docs/x.md', 'x');
    await writeTestFile(root, 'a/b/c.txt', 'x');
    await writeTestFile(root, 'a/top.txt', 'x');

    const first = await list({ path: root, maxDepth: 2, maxEntries: 1 });
    const uri = first.structured.resourceUri;
    assert.ok(uri);
    const full = JSON.parse(resourceStore.getEntry(uri).text) as {
      markdown: string;
      unexpandedDirectories?: number;
      ignoredDirs?: { total: number; first: string[] };
    };
    assert.strictEqual(full.unexpandedDirectories, 1);
    assert.deepStrictEqual(full.ignoredDirs, { total: 1, first: ['docs'] });
    assert.match(
      full.markdown,
      /^\/\/ depth limit 2: contents of 1 directory not listed or counted; raise maxDepth or list one directly\.$/m,
    );
    assert.match(
      full.markdown,
      /^\/\/ hid 1 ignored folder \(docs\); pass includeIgnored: true to list it\.$/m,
    );
  });

  it('reports and externalizes a partial tree when a scan times out', async () => {
    const dir = join(root, 'partial');
    for (let i = 0; i < 20; i++) await writeTestFile(dir, `f${String(i)}.txt`, 'x');
    const controller = new AbortController();
    let ticks = 0;
    const result = await list(
      { path: dir, maxEntries: 2 },
      {
        signal: controller.signal,
        onProgress: () => {
          if (++ticks === 3) controller.abort(new DOMException('test timeout', 'TimeoutError'));
        },
      },
    );

    assert.strictEqual(result.structured.stoppedReason, 'timeout');
    assert.ok(result.structured.entryCount > 0);
    assert.match(result.text ?? '', /scan stopped early: hit the time limit/);
    const uri = result.structured.resourceUri;
    assert.ok(uri);
    const tree = JSON.parse(resourceStore.getEntry(uri).text) as {
      stoppedReason?: string;
      truncated?: boolean;
    };
    assert.strictEqual(tree.stoppedReason, 'timeout');
    assert.strictEqual(tree.truncated, true);
  });

  it('draws later-page entries under their ancestors', async () => {
    const sub = join(root, 'tree_page_dir');
    for (const dir of ['a', 'b']) {
      await mkdir(join(sub, dir), { recursive: true });
      for (let i = 0; i < 3; i++) await writeFile(join(sub, dir, `${dir}${String(i)}.txt`), 'x');
    }

    const first = await list({ path: sub, maxDepth: 2, maxEntries: 4 });
    assert.match(
      first.text ?? '',
      /^tree_page_dir\n├── a\/\n│ {3}├── a0\.txt\n│ {3}└── a1\.txt\n└── b\/\n\n\/\/ showing 1-4 of 8/,
    );
    const cursor = first.structured.nextCursor;
    assert.ok(cursor);
    const second = await list({ path: sub, maxDepth: 2, maxEntries: 4, cursor });
    assert.match(
      second.text ?? '',
      /^tree_page_dir\n├── a\/\n│ {3}└── a2\.txt\n└── b\/\n {4}├── b0\.txt\n {4}├── b1\.txt\n {4}└── b2\.txt\n\n\/\/ showing 5-8 of 8/,
    );
  });

  it('prunes an ignored directory and everything under it', async () => {
    const sub = join(root, 'gitignore_walk_dir');
    await mkdir(join(sub, 'a', 'skipme', 'deep'), { recursive: true });
    await writeFile(join(sub, '.gitignore'), 'skipme/\n');
    await writeFile(join(sub, 'kept.txt'), 'k');
    await writeFile(join(sub, 'a', 'skipme', 'deep', 'buried.txt'), 'b');

    const pruned = await list({ path: sub, maxDepth: 4 });
    assert.match(pruned.text ?? '', /kept\.txt/);
    assert.doesNotMatch(pruned.text ?? '', /── skipme|buried\.txt/);
    assert.match(
      pruned.text ?? '',
      /^\/\/ hid 1 ignored folder \(gitignore_walk_dir\/a\/skipme\); pass includeIgnored: true to list it\.$/m,
    );

    const all = await list({ path: sub, maxDepth: 4, includeIgnored: true });
    assert.match(all.text ?? '', /kept\.txt/);
    assert.match(all.text ?? '', /buried\.txt/);
  });

  it("honors the allowed root's .gitignore when listing a subdirectory", async () => {
    await writeFile(join(root, '.gitignore'), 'scoped_ignored/*.log\n');
    await writeTestFile(root, 'scoped_ignored/keep.txt', 'x');
    await writeTestFile(root, 'scoped_ignored/drop.log', 'x');
    const sub = join(root, 'scoped_ignored');

    const result = await list({ path: sub });
    assert.deepStrictEqual(
      result.structured.entries.map((entry) => entry.name),
      ['keep.txt'],
    );
    const all = await list({ path: sub, includeIgnored: true });
    assert.deepStrictEqual(
      all.structured.entries.map((entry) => entry.name),
      ['drop.log', 'keep.txt'],
    );
  });

  it('says how many directories the depth limit left unexpanded', async () => {
    await writeTestFile(root, 'a/b/c.txt', 'x');
    await writeTestFile(root, 'a/top.txt', 'x');
    const { text, structured } = await list({ path: root, maxDepth: 2, includeSizes: true });
    assert.match(
      text ?? '',
      /^\/\/ depth limit 2: contents of 1 directory not listed or counted; raise maxDepth or list one directly\.$/m,
    );
    assert.strictEqual(structured.unexpandedDirectories, 1);
    const flat = await list({ path: root });
    assert.ok(!(flat.text ?? '').includes('depth limit'), 'the default one-level list stays plain');
    const deep = await list({ path: root, maxDepth: 3 });
    assert.ok(!(deep.text ?? '').includes('depth limit'), 'a tree that fits has nothing to report');
  });

  it('says which ignored folders it hid, and never a sensitive one', async () => {
    await writeTestFile(root, '.gitignore', 'docs/\nvault.key/\n');
    for (const file of [
      'docs/a.md',
      'node_modules/x.js',
      '.git/HEAD',
      'vault.key/inner.txt',
      'src/a.ts',
      'src/node_modules/y.js',
    ]) {
      await writeTestFile(root, file, 'x');
    }
    const noteOf = (text: string | undefined) =>
      (text ?? '').split('\n').find((line) => line.startsWith('// hid ')) ?? '';

    const hidden = await list({ path: root, includeHidden: true });
    const note = noteOf(hidden.text);
    assert.match(
      note,
      /^\/\/ hid 3 ignored folders \(.*\); pass includeIgnored: true to list them\.$/,
    );
    for (const name of ['.git', 'docs', 'node_modules']) assert.ok(note.includes(name), name);
    assert.ok(!(hidden.text ?? '').includes('vault.key'), 'a sensitive folder leaves no trace');
    assert.ok(!note.includes('src/'), 'a folder below the depth limit is not counted');

    const plain = noteOf((await list({ path: root })).text);
    assert.match(plain, /^\/\/ hid 2 ignored folders /);
    assert.ok(!plain.includes('.git'), 'hidden folders are not reported without includeHidden');

    assert.strictEqual(noteOf((await list({ path: root, includeIgnored: true })).text), '');
  });

  it('shows sizes and a totals line', async () => {
    const sub = join(root, 'sizes_dir');
    await mkdir(join(sub, 'dir1'), { recursive: true });
    await writeFile(join(sub, 'a.txt'), '12345');
    await writeFile(join(sub, 'b.txt'), 'x'.repeat(1024));
    await writeFile(join(sub, 'c.txt'), 'x'.repeat(1536));

    const { text, structured } = await list({ path: sub, includeSizes: true });
    assert.match(text ?? '', /a\.txt \(5 B\)/);
    assert.match(text ?? '', /b\.txt \(1 KiB\)/);
    assert.match(text ?? '', /c\.txt \(1\.5 KiB\)/);
    assert.match(text ?? '', /dir1\/$/m);
    assert.match(text ?? '', /^\/\/ 3 files, 1 directory, 2\.5 KiB total$/m);
    assert.strictEqual(structured.totalFiles, 3);
    assert.strictEqual(structured.totalDirectories, 1);
    assert.strictEqual(structured.totalBytes, 2565);
    assert.deepStrictEqual(
      structured.entries
        .filter((entry) => entry.type === 'file')
        .map(({ name, size }) => ({
          name,
          size,
        })),
      [
        { name: 'a.txt', size: 5 },
        { name: 'b.txt', size: 1024 },
        { name: 'c.txt', size: 1536 },
      ],
    );
    assert.strictEqual(formatByteSize(1024 * 1024 - 1), '1 MiB');
  });

  it('pluralizes directory counts in the totals line', async () => {
    const many = join(root, 'sizes_many_dirs');
    await mkdir(join(many, 'd1'), { recursive: true });
    await mkdir(join(many, 'd2'), { recursive: true });
    await writeFile(join(many, 'a.txt'), '12345');
    assert.match(
      (await list({ path: many, includeSizes: true })).text ?? '',
      /^\/\/ 1 file, 2 directories, 5 B total$/m,
    );

    const flat = join(root, 'sizes_no_dirs');
    await writeTestFile(flat, 'a.txt', '12345');
    assert.match(
      (await list({ path: flat, includeSizes: true })).text ?? '',
      /^\/\/ 1 file, 0 directories, 5 B total$/m,
    );
  });

  it('orders files largest first within each directory when sorting by size', async () => {
    const sub = join(root, 'sort_dir');
    await mkdir(join(sub, 'mid'), { recursive: true });
    await writeFile(join(sub, 'big.txt'), 'x'.repeat(2000));
    await writeFile(join(sub, 'small.txt'), 'x'.repeat(10));
    await writeFile(join(sub, 'zero.txt'), '');
    await writeFile(join(sub, 'mid', 'mid.txt'), 'x'.repeat(100));

    const { text } = await list({
      path: sub,
      maxDepth: 2,
      includeSizes: true,
      sortBy: 'size',
    });
    assert.match(text ?? '', /mid\/\n│ {3}└── mid\.txt \(100 B\)/);
    assert.match(
      text ?? '',
      /big\.txt \(2 KiB\)[\s\S]*small\.txt \(10 B\)[\s\S]*zero\.txt \(0 B\)/,
    );
  });

  it('omits sizes and totals from the default output', async () => {
    const sub = join(root, 'default_dir');
    await mkdir(join(sub, 'dir1'), { recursive: true });
    await writeFile(join(sub, 'a.txt'), '12345');

    const { text, structured } = await list({ path: sub });
    assert.doesNotMatch(text ?? '', /\(\d|\/\//);
    assert.strictEqual('totalBytes' in structured, false);
    assert.strictEqual(structured.entries[0]?.size, undefined);
  });

  it('omits sensitive files and directories from the tree and size totals', async () => {
    const sub = join(root, 'secrets_dir');
    await writeTestFile(sub, '.env', 'SECRET=1');
    await writeTestFile(sub, 'vault.key/inner.txt', 'secret');
    await writeTestFile(sub, 'plain.txt', 'x');

    const { text, structured } = await list({
      path: sub,
      maxDepth: 2,
      includeHidden: true,
      includeSizes: true,
    });
    assert.doesNotMatch(text ?? '', /\.env|vault\.key|inner\.txt/);
    assert.strictEqual(structured.totalFiles, 1);
    assert.strictEqual(structured.totalBytes, 1);
    assert.deepStrictEqual(
      structured.entries.map((entry) => entry.name),
      ['plain.txt'],
    );
  });

  it('does not draw a sensitive-named symlink directory', async (t) => {
    const sub = join(root, 'sensitive_link_walk');
    await writeTestFile(sub, 'clean/deep.txt', 'x');
    if (
      !(await trySymlink(join(sub, 'clean'), join(sub, 'alias.key'), () =>
        t.skip('symlink creation not permitted'),
      ))
    ) {
      return;
    }

    const { text } = await list({ path: sub, maxDepth: 3 });
    assert.doesNotMatch(text ?? '', /alias\.key/);
  });

  it('preserves sizes and totals across pages and rejects a different size query', async () => {
    const sub = join(root, 'pages_dir');
    for (let i = 0; i < 4; i++) {
      await writeTestFile(sub, `f${String(i)}.txt`, 'x'.repeat(i + 1));
    }
    const args = { path: sub, maxEntries: 2, includeSizes: true, sortBy: 'size' } as const;
    const first = await list(args);
    assert.strictEqual(first.structured.totalBytes, 10);
    assert.strictEqual(first.structured.entryCount, 2);
    assert.deepStrictEqual(
      first.structured.entries.map((entry) => entry.name),
      ['f3.txt', 'f2.txt'],
    );
    assert.match(first.text ?? '', /f3\.txt \(4 B\)[\s\S]*f2\.txt \(3 B\)/);

    const cursor = first.structured.nextCursor;
    assert.ok(cursor);
    const second = await list({ ...args, cursor });
    assert.deepStrictEqual(
      second.structured.entries.map((entry) => entry.name),
      ['f1.txt', 'f0.txt'],
    );
    assert.match(second.text ?? '', /f1\.txt \(2 B\)[\s\S]*f0\.txt \(1 B\)/);
    assert.strictEqual(second.structured.totalBytes, 10);
    await assert.rejects(
      list({ ...args, includeSizes: false, cursor }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, 'Invalid cursor'),
    );
  });

  it('prints a callable cursor and the position of the final page', async () => {
    const sub = join(root, 'cursor_text_dir');
    for (let i = 0; i < 4; i++) await writeTestFile(sub, `g${String(i)}.txt`, 'x');

    const first = await list({ path: sub, maxEntries: 2 });
    const match =
      /^\/\/ showing 1-2 of 4 entries\. Next page: list (\{.*"cursor":"([^"]+)".*\})$/m.exec(
        first.text ?? '',
      );
    assert.ok(match, `first page must carry its position and cursor: ${first.text ?? ''}`);
    const cursor = match[2];
    assert.strictEqual(cursor, first.structured.nextCursor);
    const printed = LIST.def.input.parse(JSON.parse(match[1] ?? '{}'));
    const literal = await list(printed);
    assert.strictEqual(literal.structured.entryCount, 2);

    const second = await list({ path: sub, maxEntries: 2, cursor });
    assert.match(second.text ?? '', /^\/\/ showing 3-4 of 4 entries\.$/m);
    assert.doesNotMatch(second.text ?? '', /Next page/);
  });

  it('replays a stable snapshot after the directory is removed', async () => {
    const sub = join(root, 'stable_page_dir');
    await writeTestFile(sub, 'bravo.txt', 'x');
    await writeTestFile(sub, 'charlie.txt', 'x');
    const first = await list({ path: sub, maxEntries: 1 });
    const cursor = first.structured.nextCursor;
    assert.ok(cursor);

    await rm(sub, { recursive: true, force: true });
    const second = await list({ path: sub, maxEntries: 10, cursor });
    assert.deepStrictEqual(
      [...first.structured.entries, ...second.structured.entries].map((entry) => entry.name),
      ['bravo.txt', 'charlie.txt'],
    );
    assert.strictEqual(second.structured.resourceUri, undefined);
    await assert.rejects(
      list({ path: root, maxEntries: 10, cursor }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, 'Invalid cursor'),
    );
  });

  it('binds cursors to the query but not the page size', async () => {
    const sub = join(root, 'cursor_identity');
    for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeTestFile(sub, name, 'x');
    const base = { path: sub, maxEntries: 1 };
    const first = await list(base);
    const cursor = first.structured.nextCursor;
    assert.ok(cursor);
    assert.strictEqual((await list({ ...base, maxEntries: 10, cursor })).structured.entryCount, 2);
    for (const change of [
      { path: root },
      { maxDepth: 2 },
      { includeHidden: true },
      { includeIgnored: true },
    ]) {
      await assert.rejects(
        list({ ...base, ...change, cursor }),
        fsErrorMatcher(ErrorCode.INVALID_INPUT, 'Invalid cursor'),
      );
    }

    const rootPage = await list({ maxDepth: 2, maxEntries: 1 });
    const rootCursor = rootPage.structured.nextCursor;
    assert.ok(rootCursor);
    const spelled = await list({
      path: normalizePath(root),
      maxDepth: 2,
      maxEntries: 1,
      cursor: rootCursor,
    });
    assert.ok(spelled.structured.entryCount > 0);
  });

  it('returns a partial result when the signal is already timed out', async () => {
    const signal = AbortSignal.abort(new DOMException('test timeout', 'TimeoutError'));
    const result = await list({ path: root, includeIgnored: true }, { signal });
    assert.strictEqual(result.structured.stoppedReason, 'timeout');
    assert.match(result.text ?? '', /scan stopped early: hit the time limit/);
  });

  it('sizes files from the scan, with no second stat per file', async () => {
    const dir = join(root, 'list_sizes_once');
    await writeTestFile(dir, 'a.txt', 'abc');
    await writeTestFile(dir, 'sub/b.txt', 'hello');
    const statted: string[] = [];
    const fs = new (class extends GuardedFileSystem {
      override async stat(...args: Parameters<GuardedFileSystem['stat']>) {
        statted.push(args[0]);
        return super.stat(...args);
      }
    })(guard);
    const result = await list({ path: dir, includeSizes: true, maxDepth: 2 }, { fs });
    const sizes = Object.fromEntries(
      result.structured.entries.map((e) => [e.relativePath, e.size]),
    );
    assert.deepEqual(sizes, { 'a.txt': 3, sub: undefined, 'sub/b.txt': 5 });
    assert.deepEqual(
      statted.filter((path) => path.endsWith('.txt')),
      [],
      'the scan already lstat-ed each file',
    );
  });

  it('counts an unreadable directory', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX directory permissions as non-root');
    }
    const dir = join(root, 'list_locked');
    const locked = join(dir, 'locked');
    await writeTestFile(dir, 'a.ts', 'x');
    await writeTestFile(dir, 'locked/x.ts', 'x');
    await chmod(locked, 0o000);
    try {
      const { structured, text } = await list({ path: dir, maxDepth: 3 });
      assert.strictEqual(structured.skippedInaccessible, 1);
      assert.ok(structured.entries.some((entry) => entry.relativePath === 'locked'));
      assert.match(text ?? '', /1 inaccessible entry/);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('does not probe a directory at the depth bound', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX directory permissions as non-root');
    }
    const dir = join(root, 'list_bound');
    const locked = join(dir, 'locked');
    await writeTestFile(dir, 'a.ts', 'x');
    await writeTestFile(dir, 'locked/x.ts', 'x');
    await chmod(locked, 0o000);
    try {
      const { structured, text } = await list({ path: dir, maxDepth: 1 });
      assert.strictEqual(structured.skippedInaccessible ?? 0, 0);
      assert.ok(structured.entries.some((entry) => entry.relativePath === 'locked'));
      assert.doesNotMatch(text ?? '', /may be incomplete/);
    } finally {
      await chmod(locked, 0o755);
    }
  });
});
