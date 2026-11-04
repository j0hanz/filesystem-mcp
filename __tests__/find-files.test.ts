import assert from 'node:assert/strict';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type * as z from 'zod/v4';

import { ErrorCode } from '../src/core/errors.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import type { PathGuard } from '../src/core/path.ts';
import { PageSnapshotStore, ResourceStore } from '../src/core/store.ts';
import { keepFirstResults } from '../src/tools/find-files.ts';
import { FIND_FILES } from '../src/tools/index.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  fsErrorMatcher,
  makeGuard,
  trySymlink,
  writeTestFile,
} from './helpers.ts';
import { runToolBodyResult } from './tool-harness.ts';

type FindArgs = z.input<typeof FIND_FILES.def.input>;

describe('find_files body', () => {
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

  it('reports filesScanned from the Scan', async () => {
    const dir = join(root, 'scanned_count');
    for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeTestFile(dir, name, 'x');
    const { structured } = await find({ path: dir, pattern: '**/*' });
    assert.strictEqual(structured.filesScanned, 3);
  });

  it('says which default-named folder it skipped', async () => {
    await writeTestFile(root, 'build/gen.ts', 'x');
    await writeTestFile(root, 'src/a.ts', 'x');
    const { text } = await find({ path: root, pattern: '**/*.ts' });
    assert.ok(
      (text ?? '').includes(
        '// skipped 1 folder by default name (build); pass includeIgnored: true to search it.',
      ),
    );
  });

  const find = (args: FindArgs, signal?: AbortSignal) =>
    runToolBodyResult(FIND_FILES, args, {
      guard,
      pageStore,
      resourceStore,
      ...(signal ? { signal } : {}),
    });

  it('a trailing globstar keeps sensitive and ignored dotfiles out', async () => {
    await writeTestFile(root, '.gitignore', '*.log\n');
    await writeTestFile(root, 'a/hooks/.env', 'SECRET=1\n');
    await writeTestFile(root, 'a/hooks/.noise.log', 'x');
    await writeTestFile(root, 'a/hooks/.keep', 'x');
    const { structured } = await find({ pattern: '**/hooks/**', includeHidden: true });
    assert.deepStrictEqual(structured.results, [{ path: 'a/hooks/.keep' }]);
  });

  it('finds matching files relative to the allowed root', async () => {
    await writeTestFile(root, 'sub/findme.txt', 'x');
    const { structured, text } = await find({ pattern: '**/findme.txt' });
    assert.deepStrictEqual(structured.results, [{ path: 'sub/findme.txt' }]);
    assert.strictEqual(structured.root, normalizePath(root));
    assert.strictEqual(text, 'sub/findme.txt');
  });

  it('drops a gitignored file below the top level', async () => {
    const sub = join(root, 'gitignore_file_dir');
    await writeTestFile(sub, '.gitignore', '*.log\n');
    await writeTestFile(sub, 'nested/keep.txt', 'k');
    await writeTestFile(sub, 'nested/drop.log', 'd');
    const { text } = await find({ path: sub, pattern: '**/*' });
    assert.match(text ?? '', /keep\.txt/);
    assert.doesNotMatch(text ?? '', /drop\.log/);
  });

  it("honors the allowed root's .gitignore below it", async () => {
    await writeFile(join(root, '.gitignore'), 'scoped_ignored/*.log\n');
    await writeTestFile(root, 'scoped_ignored/keep.txt', 'x');
    await writeTestFile(root, 'scoped_ignored/drop.log', 'x');
    const sub = join(root, 'scoped_ignored');

    const found = await find({ path: sub, pattern: '**/*' });
    assert.deepStrictEqual(
      found.structured.results.map((entry) => entry.path),
      ['scoped_ignored/keep.txt'],
    );
    const all = await find({ path: sub, pattern: '**/*', includeIgnored: true });
    assert.deepStrictEqual(
      all.structured.results.map((entry) => entry.path),
      ['scoped_ignored/drop.log', 'scoped_ignored/keep.txt'],
    );
  });

  it('omits sensitive files and does not enter a sensitive directory through a pattern prefix', async () => {
    const sub = join(root, 'boundary_walk');
    await writeTestFile(sub, '.env', 'SECRET=1\n');
    await writeTestFile(sub, 'vault.key/inner.txt', 'secret');
    await writeTestFile(sub, 'plain.txt', 'public');

    const found = await find({ path: sub, pattern: '*.txt', includeHidden: true });
    assert.deepStrictEqual(
      found.structured.results.map((entry) => entry.path),
      ['boundary_walk/plain.txt'],
    );
    assert.strictEqual(found.structured.skippedInaccessible, undefined);
    assert.doesNotMatch(found.text ?? '', /inaccessible|\.env|vault\.key/);
    const prefixed = await find({
      path: sub,
      pattern: 'vault.key/*.txt',
      includeHidden: true,
    });
    assert.deepStrictEqual(prefixed.structured.results, []);
  });

  it('does not follow a sensitive-named symlink directory', async (t) => {
    const sub = join(root, 'sensitive_link_walk');
    await writeTestFile(sub, 'clean/deep.txt', 'x');
    if (
      !(await trySymlink(join(sub, 'clean'), join(sub, 'alias.key'), () =>
        t.skip('symlink creation not permitted'),
      ))
    ) {
      return;
    }

    const { structured } = await find({ path: sub, pattern: '**/*.txt' });
    assert.deepStrictEqual(
      structured.results.map((entry) => entry.path),
      ['sensitive_link_walk/clean/deep.txt'],
    );
  });

  it('counts an unreadable directory', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX directory permissions as non-root');
    }
    const dir = join(root, 'find_locked');
    const locked = join(dir, 'locked');
    await writeTestFile(dir, 'a.ts', 'x');
    await writeTestFile(dir, 'locked/x.ts', 'x');
    await chmod(locked, 0o000);
    try {
      const { structured, text } = await find({ path: dir, pattern: '**/*.ts' });
      assert.strictEqual(structured.skippedInaccessible, 1);
      assert.match(text ?? '', /1 inaccessible entry/);
      assert.deepStrictEqual(
        structured.results.map((entry) => basename(entry.path)),
        ['a.ts'],
      );
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('filters by pattern', async () => {
    const dir = join(root, 'find_filter');
    await writeTestFile(dir, 'moduleA.ts', 'x');
    await writeTestFile(dir, 'notes.txt', 'x');
    await writeTestFile(dir, 'sub/moduleC.ts', 'x');
    await writeTestFile(dir, 'sub/readme.txt', 'x');

    const ts = (await find({ path: dir, pattern: '**/*.ts' })).structured.results;
    assert.strictEqual(ts.length, 2);
    assert.ok(ts.every((entry) => entry.path.endsWith('.ts')));
    const txt = (await find({ path: dir, pattern: '**/*.txt' })).structured.results;
    assert.strictEqual(txt.length, 2);
    assert.ok(txt.every((entry) => entry.path.endsWith('.txt')));
  });

  it('matches a slash-free glob at any depth', async () => {
    const dir = join(root, 'basename_glob');
    await writeTestFile(dir, 'top.ts', 'x');
    await writeTestFile(dir, 'sub/deep.ts', 'x');
    await writeTestFile(dir, 'sub/top.ts', 'x');
    const { structured } = await find({ path: dir, pattern: '*.ts' });
    assert.deepStrictEqual(
      structured.results.map((entry) => entry.path),
      ['basename_glob/sub/deep.ts', 'basename_glob/sub/top.ts', 'basename_glob/top.ts'],
    );
  });

  it('accepts a literal file name containing .. inside a segment', async () => {
    await writeTestFile(root, 'globby/docs/v1..2.md', 'x\n');
    const { structured } = await find({
      path: join(root, 'globby'),
      pattern: 'docs/v1..2.md',
    });
    assert.deepStrictEqual(
      structured.results.map((entry) => entry.path),
      ['globby/docs/v1..2.md'],
    );
  });

  it("sortBy 'name' orders by basename rather than full path", async () => {
    const dir = join(root, 'find_sort');
    await writeTestFile(dir, 'zzz/alpha.ts', '// a');
    await writeTestFile(dir, 'aaa/omega.ts', '// o');
    const names = async (sortBy?: 'name') =>
      (
        await find({ path: dir, pattern: '**/*.ts', ...(sortBy ? { sortBy } : {}) })
      ).structured.results.map((entry) => basename(entry.path));
    assert.deepStrictEqual(await names('name'), ['alpha.ts', 'omega.ts']);
    assert.deepStrictEqual(await names(), ['omega.ts', 'alpha.ts']);
  });

  it('pages a stable snapshot and externalizes the full result only once', async () => {
    const dir = join(root, 'find_pages');
    await writeTestFile(dir, 'bravo.txt', 'x');
    await writeTestFile(dir, 'charlie.txt', 'x');
    const args = { path: dir, pattern: '*.txt', maxResults: 1 };
    const first = await find(args);
    const cursor = first.structured.nextCursor;
    const uri = first.structured.resourceUri;
    assert.ok(cursor);
    assert.ok(uri);
    assert.strictEqual(first.structured.stoppedReason, undefined, 'page size is not a scan cap');
    assert.match(
      first.text ?? '',
      /^\/\/ showing 1-1 of 2 files\. Next page: find_files \{.*"pattern":"\*\.txt".*"cursor":"/m,
    );
    const link = first.resources?.[0];
    assert.ok(link?.type === 'resource_link');
    assert.strictEqual(link.uri, uri);
    const full = JSON.parse(resourceStore.getEntry(uri).text) as {
      root: string;
      results: { path: string }[];
    };
    assert.strictEqual(full.root, normalizePath(root));
    assert.deepStrictEqual(
      full.results.map((entry) => entry.path),
      ['find_pages/bravo.txt', 'find_pages/charlie.txt'],
    );

    await rm(dir, { recursive: true, force: true });
    const second = await find({ ...args, maxResults: 10, cursor });
    assert.deepStrictEqual(
      [...first.structured.results, ...second.structured.results].map((entry) => entry.path),
      ['find_pages/bravo.txt', 'find_pages/charlie.txt'],
    );
    assert.strictEqual(second.structured.resourceUri, undefined);
    assert.deepStrictEqual(second.resources, []);
    assert.match(second.text ?? '', /^\/\/ showing 2-2 of 2 files\.$/m);
    await assert.rejects(
      find({ ...args, pattern: '*.md', cursor }),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, 'Invalid cursor'),
    );
  });

  it('binds cursors to the query but not the page size', async () => {
    const dir = join(root, 'cursor_identity');
    for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeTestFile(dir, name, 'x');
    const base = { path: dir, pattern: '*.txt', maxResults: 1 };
    const first = await find(base);
    const cursor = first.structured.nextCursor;
    assert.ok(cursor);
    assert.strictEqual(
      (await find({ ...base, maxResults: 10, cursor })).structured.results.length,
      2,
    );
    const changes: Partial<FindArgs>[] = [
      { path: root },
      { pattern: '*' },
      { includeIgnored: true },
      { includeHidden: true },
      { sortBy: 'name' },
      { maxDepth: 2 },
    ];
    for (const change of changes) {
      await assert.rejects(
        find({ ...base, ...change, cursor }),
        fsErrorMatcher(ErrorCode.INVALID_INPUT, 'Invalid cursor'),
      );
    }
  });

  it('reports a timeout and externalizes an incomplete scan', async () => {
    await mkdir(join(root, 'timed-out'));
    const signal = AbortSignal.abort(new DOMException('test timeout', 'TimeoutError'));
    const result = await find(
      { path: join(root, 'timed-out'), pattern: '*.txt', includeIgnored: true },
      signal,
    );
    assert.strictEqual(result.structured.stoppedReason, 'timeout');
    assert.match(result.text ?? '', /scan stopped early: hit the time limit/);
    const uri = result.structured.resourceUri;
    assert.ok(uri);
    const full = JSON.parse(resourceStore.getEntry(uri).text) as { results: unknown[] };
    assert.deepStrictEqual(full.results, []);
  });
});

describe('find_files scan cap', () => {
  const counts = { skippedInaccessible: 0, skippedBinary: 0, skippedTooLarge: 0 };

  it('keeps the first results in walk order and preserves an earlier timeout', () => {
    const over = keepFirstResults({ results: ['a', 'b', 'c'], scanned: 3, ...counts }, 2);
    assert.deepStrictEqual(over, { results: ['a', 'b'], stoppedReason: 'maxResults' });
    const timedOut = keepFirstResults(
      { results: ['a', 'b', 'c'], scanned: 3, ...counts, stoppedReason: 'timeout' },
      2,
    );
    assert.strictEqual(timedOut.stoppedReason, 'timeout');
    const exact = keepFirstResults({ results: ['a', 'b'], scanned: 2, ...counts }, 2);
    assert.deepStrictEqual(exact, { results: ['a', 'b'] });
  });
});
