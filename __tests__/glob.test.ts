import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { globEntries, type GlobEntriesOptions } from '../src/core/glob.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
} from './helpers.ts';

/** Walk and return root-relative POSIX paths, sorted, directories with a trailing `/`. */
async function walk(options: GlobEntriesOptions): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of globEntries(options)) {
    const rel = relative(options.cwd, entry.path).replaceAll('\\', '/');
    out.push(entry.dirent.isDirectory() ? `${rel}/` : rel);
  }
  return out.sort();
}

/**
 * A root with a .gitignore and a subdirectory whose name also exists in the
 * process cwd: fs.glob re-visits that directory with a dirent relative to the
 * walk root ("."), which used to resolve against the process cwd instead.
 */
async function withCollidingCwd(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await createTestRoot();
  const elsewhere = await createTestRoot();
  const previousCwd = process.cwd();
  try {
    await mkdir(join(root, 'shared'));
    await writeFile(join(root, 'shared', 'inner.txt'), 'NEEDLE');
    await writeFile(join(root, 'top.txt'), 'NEEDLE');
    await writeFile(join(root, '.gitignore'), '*.log\n');
    await mkdir(join(elsewhere, 'shared'));
    process.chdir(elsewhere);
    await fn(root);
  } finally {
    process.chdir(previousCwd);
    await cleanupTestRoot(root);
    await cleanupTestRoot(elsewhere);
  }
}

describe('globEntries', () => {
  it('walks every subdirectory when the process cwd holds a same-named entry', async () => {
    await withCollidingCwd(async (root) => {
      assert.deepStrictEqual(await walk({ cwd: root, pattern: '**/*', skipIgnored: true }), [
        'shared/inner.txt',
        'top.txt',
      ]);
    });
  });

  it('list, find_files and search_text see the colliding subdirectory', async () => {
    await withCollidingCwd(async (root) => {
      const harness = await createTestClientPair([root]);
      try {
        const listed = await harness.client.callTool({
          name: 'list',
          arguments: { path: root, maxDepth: 2 },
        });
        assert.notStrictEqual(listed.isError, true, firstTextBlock(listed).text);
        assert.match(firstTextBlock(listed).text ?? '', /inner\.txt/u);

        const found = await harness.client.callTool({
          name: 'find_files',
          arguments: { path: root, pattern: '**/*' },
        });
        assert.match(firstTextBlock(found).text ?? '', /inner\.txt/u);

        const searched = await harness.client.callTool({
          name: 'search_text',
          arguments: { path: root, searchPattern: 'NEEDLE' },
        });
        assert.match(firstTextBlock(searched).text ?? '', /inner\.txt/u);
      } finally {
        await harness.close();
      }
    });
  });
});

describe('globEntries characterization', () => {
  const FILES = [
    'a.txt',
    'keep.log',
    'x.log',
    '.dotfile',
    '.hidden/h.txt',
    'dist/o.js',
    'node_modules/m.js',
    'src/b.ts',
    'src/deep/c.ts',
    'src/deep/deeper/d.ts',
    'src/node_modules/n.js',
    'sub/y.log',
    'sub/z.txt',
  ];
  /** Shared by the "no .gitignore applied" cases (plain without skipIgnored, ignored without skipIgnored). */
  const WITHOUT_SKIP_IGNORED = [
    'a.txt',
    'dist/o.js',
    'keep.log',
    'node_modules/m.js',
    'src/b.ts',
    'src/deep/c.ts',
    'src/deep/deeper/d.ts',
    'src/node_modules/n.js',
    'sub/y.log',
    'sub/z.txt',
    'x.log',
  ];
  let plain: string;
  let ignored: string;

  before(async () => {
    plain = await createTestRoot();
    ignored = await createTestRoot();
    for (const root of [plain, ignored]) {
      for (const file of FILES) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), 'x');
      }
    }
    await writeFile(join(ignored, '.gitignore'), '*.log\n!keep.log\n');
    await writeFile(join(ignored, 'sub', '.gitignore'), 'z.txt\n');
  });

  after(async () => {
    await cleanupTestRoot(plain);
    await cleanupTestRoot(ignored);
  });

  it('skipIgnored drops default-excluded dirs at any depth', async () => {
    assert.deepStrictEqual(await walk({ cwd: plain, pattern: '**/*', skipIgnored: true }), [
      'a.txt',
      'keep.log',
      'src/b.ts',
      'src/deep/c.ts',
      'src/deep/deeper/d.ts',
      'sub/y.log',
      'sub/z.txt',
      'x.log',
    ]);
  });

  it('without skipIgnored every non-hidden file is walked', async () => {
    assert.deepStrictEqual(
      await walk({ cwd: plain, pattern: '**/*', skipIgnored: false }),
      WITHOUT_SKIP_IGNORED,
    );
  });

  it('includeHidden adds dotfiles and dot-directory contents', async () => {
    assert.deepStrictEqual(
      await walk({ cwd: plain, pattern: '**/*', skipIgnored: true, includeHidden: true }),
      [
        '.dotfile',
        '.hidden/h.txt',
        'a.txt',
        'keep.log',
        'src/b.ts',
        'src/deep/c.ts',
        'src/deep/deeper/d.ts',
        'sub/y.log',
        'sub/z.txt',
        'x.log',
      ],
    );
  });

  it('maxDepth 0 yields only top-level entries', async () => {
    assert.deepStrictEqual(
      await walk({
        cwd: plain,
        pattern: '**/*',
        skipIgnored: true,
        maxDepth: 0,
        onlyFiles: false,
      }),
      ['a.txt', 'keep.log', 'src/', 'sub/', 'x.log'],
    );
  });

  it('maxDepth 1 yields one level down, directories at the edge included', async () => {
    assert.deepStrictEqual(
      await walk({
        cwd: plain,
        pattern: '**/*',
        skipIgnored: true,
        maxDepth: 1,
        onlyFiles: false,
      }),
      [
        'a.txt',
        'keep.log',
        'src/',
        'src/b.ts',
        'src/deep/',
        'sub/',
        'sub/y.log',
        'sub/z.txt',
        'x.log',
      ],
    );
  });

  it('root and nested .gitignore both apply, negation re-includes', async () => {
    assert.deepStrictEqual(await walk({ cwd: ignored, pattern: '**/*', skipIgnored: true }), [
      'a.txt',
      'keep.log',
      'src/b.ts',
      'src/deep/c.ts',
      'src/deep/deeper/d.ts',
    ]);
  });

  it('gitignore and maxDepth combine', async () => {
    assert.deepStrictEqual(
      await walk({
        cwd: ignored,
        pattern: '**/*',
        skipIgnored: true,
        maxDepth: 1,
        onlyFiles: false,
      }),
      ['a.txt', 'keep.log', 'src/', 'src/b.ts', 'src/deep/', 'sub/'],
    );
  });

  it('gitignore with includeHidden lists the .gitignore files', async () => {
    assert.deepStrictEqual(
      await walk({ cwd: ignored, pattern: '**/*', skipIgnored: true, includeHidden: true }),
      [
        '.dotfile',
        '.gitignore',
        '.hidden/h.txt',
        'a.txt',
        'keep.log',
        'src/b.ts',
        'src/deep/c.ts',
        'src/deep/deeper/d.ts',
        'sub/.gitignore',
      ],
    );
  });

  it('without skipIgnored a .gitignore is not applied', async () => {
    assert.deepStrictEqual(
      await walk({ cwd: ignored, pattern: '**/*', skipIgnored: false }),
      WITHOUT_SKIP_IGNORED,
    );
  });

  it('baseNameMatch matches a slash-free glob at any depth', async () => {
    assert.deepStrictEqual(
      await walk({ cwd: plain, pattern: '*.ts', skipIgnored: true, baseNameMatch: true }),
      ['src/b.ts', 'src/deep/c.ts', 'src/deep/deeper/d.ts'],
    );
  });

  it('baseNameMatch respects maxDepth', async () => {
    assert.deepStrictEqual(
      await walk({
        cwd: plain,
        pattern: '*.ts',
        skipIgnored: true,
        baseNameMatch: true,
        maxDepth: 1,
      }),
      ['src/b.ts'],
    );
  });

  it('a prefixed globstar with includeHidden stays inside the prefix', async () => {
    assert.deepStrictEqual(
      await walk({ cwd: plain, pattern: 'src/**', skipIgnored: true, includeHidden: true }),
      ['src/b.ts', 'src/deep/c.ts', 'src/deep/deeper/d.ts'],
    );
  });
});
