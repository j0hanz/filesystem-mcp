import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { globEntries, type GlobEntriesOptions, isSafeGlobSyntax } from '../src/core/glob.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  trySymlink,
} from './helpers.ts';

const toPosix = (p: string): string => p.replaceAll('\\', '/');

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
  // fs.glob takes no signal, so a walk that yields nothing never reaches a
  // per-entry abort check. The walk must stop itself and say why, never end as
  // if it had swept the whole tree: move's protection walk reads "ended" as
  // "nothing protected inside".
  for (const skipIgnored of [false, true]) {
    it(`an aborted walk throws its reason instead of ending as complete (skipIgnored: ${String(skipIgnored)})`, async () => {
      const root = await createTestRoot();
      try {
        for (let i = 0; i < 20; i++)
          await mkdir(join(root, `d${String(i)}`, 'inner'), { recursive: true });
        const reason = new Error('deadline');
        await assert.rejects(
          walk({
            cwd: root,
            pattern: '**/*.nomatch',
            skipIgnored,
            signal: AbortSignal.abort(reason),
          }),
          (err: unknown) => err === reason,
        );
      } finally {
        await cleanupTestRoot(root);
      }
    });
  }

  it('walks every subdirectory when the process cwd holds a same-named entry', async () => {
    await withCollidingCwd(async (root) => {
      assert.deepStrictEqual(await walk({ cwd: root, pattern: '**/*', skipIgnored: true }), [
        'shared/inner.txt',
        'top.txt',
      ]);
    });
  });

  describe('isSafeGlobSyntax', () => {
    it('accepts .. inside a segment or a character class', () => {
      for (const ok of [
        'app/**/[...slug]/page.tsx',
        'docs/v1..2.md',
        '**/[..]x',
        'a/..b/c',
        '**/*.ts',
      ]) {
        assert.strictEqual(isSafeGlobSyntax(ok), true, ok);
      }
    });

    it('refuses a whole .. segment or brace alternative', () => {
      for (const bad of ['..', '../x', 'a/../b', 'a/..', '{a,..}/x', 'x/{..,b}', '..\\x']) {
        assert.strictEqual(isSafeGlobSyntax(bad), false, bad);
      }
    });

    it('still refuses absolute and drive-relative patterns', () => {
      assert.strictEqual(isSafeGlobSyntax('/etc/*'), false);
      assert.strictEqual(isSafeGlobSyntax('C:foo/*'), false);
      assert.strictEqual(isSafeGlobSyntax('   '), false);
    });

    it('refuses a pattern whose brace expansion or character classes reach .. or an absolute path', () => {
      for (const bad of [
        '..{,x}/*.txt',
        '.{.,}/*.txt',
        '{.,x}{.,y}/*.txt',
        '{a,{..,b}}/*.txt',
        '{.},.}./*.txt',
        'x{,/../..}/*.txt',
        '.[.]/*.txt',
        '[.][.]/*.txt',
        '{/etc,x}/*',
        '{C:,x}foo/*',
      ]) {
        assert.strictEqual(isSafeGlobSyntax(bad), false, bad);
      }
    });

    it('accepts ordinary brace sets and sequences', () => {
      for (const ok of [
        '**/*.{ts,tsx}',
        '{src,lib}/**/*.test.{ts,js}',
        'v1.{2,3}.md',
        'file{1..9}.txt',
        '{a..c}/*.ts',
        '.{{.,a}}/*.txt',
        '${..,x}/*.txt',
      ]) {
        assert.strictEqual(isSafeGlobSyntax(ok), true, ok);
      }
    });

    it('refuses a pattern with more alternatives than it can check', () => {
      assert.strictEqual(isSafeGlobSyntax('{a,b}'.repeat(13)), false);
    });
  });

  it('never yields an entry outside the walk root, whatever the pattern', async () => {
    const parent = await createTestRoot();
    try {
      const root = join(parent, 'root');
      await mkdir(join(root, 'sub'), { recursive: true });
      await writeFile(join(parent, 'outside.txt'), 'NEEDLE');
      await writeFile(join(root, 'top.txt'), 'NEEDLE');
      await writeFile(join(root, 'sub', 'inner.txt'), 'NEEDLE');
      for (const pattern of ['..{,x}/*.txt', '.{.,}/*.txt', `{${toPosix(parent)},x}/*.txt`]) {
        for (const skipIgnored of [false, true]) {
          const seen = await walk({ cwd: join(root, 'sub'), pattern, skipIgnored });
          assert.ok(
            seen.every((p) => !p.startsWith('..') && !isAbsolute(p)),
            `${pattern}: ${seen.join(', ')}`,
          );
        }
      }
    } finally {
      await cleanupTestRoot(parent);
    }
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

  it('find_files, search_text and replace_text refuse brace patterns that build ..', async () => {
    const parent = await createTestRoot();
    const root = join(parent, 'root');
    const sub = join(root, 'sub');
    await mkdir(sub, { recursive: true });
    await writeFile(join(parent, 'outside.txt'), 'NEEDLE outside');
    await writeFile(join(root, 'top.txt'), 'NEEDLE top');
    await writeFile(join(sub, 'inner.txt'), 'NEEDLE inner');
    const harness = await createTestClientPair([root]);
    try {
      for (const path of [sub, root]) {
        for (const pattern of ['..{,x}/*.txt', '.{.,}/*.txt']) {
          for (const [name, extra] of [
            ['find_files', {}],
            ['search_text', { searchPattern: 'NEEDLE' }],
            ['replace_text', { searchPattern: 'NEEDLE', replacement: 'CHANGED' }],
          ] as const) {
            const result = await harness.client.callTool({
              name,
              arguments: { path, pattern, ...extra },
            });
            const text = firstTextBlock(result).text ?? '';
            assert.strictEqual(result.isError, true, `${name} ${pattern} at ${path}: ${text}`);
            assert.match(text, /Invalid glob or unsafe path/u, `${name} ${pattern}`);
            assert.doesNotMatch(text, /top\.txt|outside\.txt|inaccessible/u, `${name} ${pattern}`);
          }
        }
      }
      assert.strictEqual(await readFile(join(root, 'top.txt'), 'utf8'), 'NEEDLE top');
      assert.strictEqual(await readFile(join(parent, 'outside.txt'), 'utf8'), 'NEEDLE outside');
      assert.strictEqual(await readFile(join(sub, 'inner.txt'), 'utf8'), 'NEEDLE inner');
    } finally {
      await harness.close();
      await cleanupTestRoot(parent);
    }
  });

  it('ignores a .gitignore that is a symlink or oversized', async (t) => {
    const root = await createTestRoot();
    const outside = await createTestRoot();
    try {
      await mkdir(join(root, 'linked'));
      await writeFile(join(root, 'linked', 'keep.txt'), 'x');
      await writeFile(join(outside, 'rules'), '*.txt\n');
      const linked = await trySymlink(
        join(outside, 'rules'),
        join(root, 'linked', '.gitignore'),
        () => t.diagnostic('symlink not permitted; symlink case skipped'),
        'file',
      );

      await mkdir(join(root, 'huge'));
      await writeFile(join(root, 'huge', 'keep.txt'), 'x');
      // 1 MiB of comment, then a rule: the rule must never take effect.
      await writeFile(join(root, 'huge', '.gitignore'), `${'#'.repeat(1024 * 1024)}\n*.txt\n`);

      const seen = await walk({ cwd: root, pattern: '**/*', skipIgnored: true, onlyFiles: true });
      assert.ok(seen.includes('huge/keep.txt'), 'an oversized .gitignore must be skipped');
      if (linked) {
        assert.ok(seen.includes('linked/keep.txt'), 'a symlinked .gitignore must be skipped');
      }
    } finally {
      await cleanupTestRoot(root);
      await cleanupTestRoot(outside);
    }
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

  it('a default-excluded name below a dot-directory is excluded too', async () => {
    const root = await createTestRoot();
    try {
      for (const file of ['.hidden/node_modules/q.js', '.hidden/keep.txt']) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), 'x');
      }
      assert.deepStrictEqual(
        await walk({ cwd: root, pattern: '**/*', skipIgnored: true, includeHidden: true }),
        ['.hidden/keep.txt'],
      );
    } finally {
      await cleanupTestRoot(root);
    }
  });

  it('includeHidden keeps literal names literal at any depth', async () => {
    const root = await createTestRoot();
    try {
      const files = [
        'target.txt',
        '.target.txt',
        'src/target.txt',
        '.src/target.txt',
        '.one/.two/target.txt',
        '.one/.two/.target.txt',
      ];
      for (const file of files) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), 'x');
      }
      assert.deepStrictEqual(
        await walk({ cwd: root, pattern: 'target.txt', includeHidden: true }),
        ['target.txt'],
      );
      assert.deepStrictEqual(
        await walk({ cwd: root, pattern: 'src/target.txt', includeHidden: true }),
        ['src/target.txt'],
      );
      assert.deepStrictEqual(
        await walk({
          cwd: root,
          pattern: 'target.txt',
          baseNameMatch: true,
          includeHidden: true,
        }),
        ['.one/.two/target.txt', '.src/target.txt', 'src/target.txt', 'target.txt'],
      );
      assert.deepStrictEqual(
        await walk({ cwd: root, pattern: '**/target.txt', includeHidden: true }),
        ['.one/.two/target.txt', '.src/target.txt', 'src/target.txt', 'target.txt'],
      );
      assert.deepStrictEqual(
        await walk({ cwd: root, pattern: '**/*', includeHidden: true }),
        [...files].sort(),
      );
    } finally {
      await cleanupTestRoot(root);
    }
  });

  it('loads gitignore rules inside nested hidden directories', async () => {
    const root = await createTestRoot();
    try {
      for (const file of [
        '.workspace/drop.txt',
        '.workspace/keep.txt',
        '.workspace/.nested/drop.txt',
        '.workspace/.nested/keep.txt',
      ]) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), 'x');
      }
      await writeFile(join(root, '.workspace/.gitignore'), 'drop.txt\n');
      await writeFile(join(root, '.workspace/.nested/.gitignore'), '!drop.txt\nkeep.txt\n');
      const options = { cwd: root, pattern: '**/*', includeHidden: true, skipIgnored: true };
      assert.deepStrictEqual(await walk(options), [
        '.workspace/.gitignore',
        '.workspace/.nested/.gitignore',
        '.workspace/.nested/drop.txt',
        '.workspace/keep.txt',
      ]);
      assert.deepStrictEqual(await walk({ ...options, maxDepth: 1 }), [
        '.workspace/.gitignore',
        '.workspace/keep.txt',
      ]);
      assert.deepStrictEqual(await walk({ ...options, skipIgnored: false }), [
        '.workspace/.gitignore',
        '.workspace/.nested/.gitignore',
        '.workspace/.nested/drop.txt',
        '.workspace/.nested/keep.txt',
        '.workspace/drop.txt',
        '.workspace/keep.txt',
      ]);
    } finally {
      await cleanupTestRoot(root);
    }
  });

  it('without includeHidden, .gitignore discovery stays out of dot-directories', async () => {
    const root = await createTestRoot();
    try {
      for (const file of ['.workspace/drop.txt', '.workspace/keep.txt']) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), 'x');
      }
      await writeFile(join(root, '.workspace/.gitignore'), 'drop.txt\n');
      // Searching every hidden tree (.venv, .terraform, ...) for rules would
      // dwarf a walk that skips hidden entries. Only a pattern naming the
      // directory reaches inside, and its rules are not looked for there.
      const options = { cwd: root, pattern: '.workspace/*.txt', skipIgnored: true };
      assert.deepStrictEqual(await walk(options), ['.workspace/drop.txt', '.workspace/keep.txt']);
      assert.deepStrictEqual(await walk({ ...options, includeHidden: true }), [
        '.workspace/keep.txt',
      ]);
    } finally {
      await cleanupTestRoot(root);
    }
  });

  it('includeHidden adds dot-prefixed names only where a leading wildcard can match the dot', async () => {
    const root = await createTestRoot();
    try {
      for (const file of [
        'foo1.txt',
        '.foo2.txt',
        'sub/foo3.txt',
        'sub/.foo4.txt',
        '.dir/foo5.txt',
        'src/foox/bar.ts',
        'src/.fooy/bar.ts',
        '.a.txt',
        'zoo.txt',
        '.zoo.txt',
        '.oo.txt',
      ]) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), 'x');
      }
      const hidden = (pattern: string): Promise<string[]> =>
        walk({ cwd: root, pattern, includeHidden: true });

      // A segment that starts with a literal, a brace set or a class gets no
      // dot-prefixed match, wherever its wildcard sits.
      assert.deepStrictEqual(await hidden('foo*.txt'), ['foo1.txt']);
      assert.deepStrictEqual(await hidden('**/foo*.txt'), [
        '.dir/foo5.txt',
        'foo1.txt',
        'sub/foo3.txt',
      ]);
      assert.deepStrictEqual(await hidden('src/foo*/bar.ts'), ['src/foox/bar.ts']);
      assert.deepStrictEqual(await hidden('{foo,zoo}*.txt'), ['foo1.txt', 'zoo.txt']);
      assert.deepStrictEqual(await hidden('[a-z]oo.txt'), ['zoo.txt']);
      // Nor does an extglob: `*(z)` repeats `z` and never matches the dot.
      assert.deepStrictEqual(await hidden('*(z)oo.txt'), ['zoo.txt']);

      // A leading `*` can.
      assert.deepStrictEqual(await hidden('*.txt'), [
        '.a.txt',
        '.foo2.txt',
        '.oo.txt',
        '.zoo.txt',
        'foo1.txt',
        'zoo.txt',
      ]);
      assert.deepStrictEqual(await hidden('**/*.txt'), [
        '.a.txt',
        '.dir/foo5.txt',
        '.foo2.txt',
        '.oo.txt',
        '.zoo.txt',
        'foo1.txt',
        'sub/.foo4.txt',
        'sub/foo3.txt',
        'zoo.txt',
      ]);

      // A leading `?` is one character, so the dot takes its place.
      assert.deepStrictEqual(await hidden('?oo.txt'), ['.oo.txt', 'zoo.txt']);
      assert.deepStrictEqual(await hidden('**/?oo.txt'), ['.oo.txt', 'zoo.txt']);
      assert.deepStrictEqual(await walk({ cwd: root, pattern: '?oo.txt' }), ['zoo.txt']);
      // A lone `?` never becomes `.`, the directory itself.
      assert.deepStrictEqual(
        await walk({ cwd: root, pattern: 'sub/?', includeHidden: true, onlyFiles: false }),
        [],
      );
      // Nor, through a brace set or a class, `..`, the directory above.
      for (const pattern of ['?{.,x}/*.txt', '?{,.}/*.txt', '?[.]/*.txt', '?.{,x}/*.txt']) {
        assert.deepStrictEqual(
          await walk({ cwd: join(root, 'sub'), pattern, includeHidden: true }),
          [],
          pattern,
        );
      }
    } finally {
      await cleanupTestRoot(root);
    }
  });
});

describe('ancestor .gitignore', () => {
  let root: string;
  before(async () => {
    root = await createTestRoot();
    await writeFile(join(root, '.gitignore'), '*.log\noutdir/\n');
    await mkdir(join(root, 'pkg', 'outdir'), { recursive: true });
    await writeFile(join(root, 'pkg', '.gitignore'), '!keep.log\n');
    await writeFile(join(root, 'pkg', 'a.txt'), 'a');
    await writeFile(join(root, 'pkg', 'a.log'), 'a');
    await writeFile(join(root, 'pkg', 'keep.log'), 'k');
    await writeFile(join(root, 'pkg', 'outdir', 'out.js'), 'o');
  });
  after(async () => cleanupTestRoot(root));

  it("applies the allowed root's rules to a walk scoped below it, nearest file winning", async () => {
    const seen = await walk({
      cwd: join(root, 'pkg'),
      pattern: '**/*',
      skipIgnored: true,
      ignoreCeiling: root,
    });
    assert.deepStrictEqual(seen, ['a.txt', 'keep.log']);
  });

  it('without a ceiling only the walk root and below are consulted (previous behavior)', async () => {
    const seen = await walk({ cwd: join(root, 'pkg'), pattern: '**/*', skipIgnored: true });
    assert.deepStrictEqual(seen, ['a.log', 'a.txt', 'keep.log', 'outdir/out.js']);
  });

  it('a ceiling file that ignores the walk root itself is skipped whole, so the walk is not emptied', async () => {
    await writeFile(join(root, '.gitignore'), '*.log\noutdir/\npkg/\n');
    try {
      const seen = await walk({
        cwd: join(root, 'pkg'),
        pattern: '**/*',
        skipIgnored: true,
        ignoreCeiling: root,
      });
      // The whole root file is skipped (its `pkg/` rule would hide everything the
      // caller asked for), so its `*.log` and `outdir/` rules do not apply either.
      assert.deepStrictEqual(seen, ['a.log', 'a.txt', 'keep.log', 'outdir/out.js']);
    } finally {
      await writeFile(join(root, '.gitignore'), '*.log\noutdir/\n');
    }
  });

  it('never reads above the ceiling', async () => {
    // A .gitignore at the ceiling's parent must not apply: give the parent a
    // rule that would hide a.txt and confirm a.txt survives.
    const outer = await createTestRoot();
    try {
      const inner = join(outer, 'repo');
      await mkdir(join(inner, 'pkg'), { recursive: true });
      await writeFile(join(outer, '.gitignore'), 'a.txt\n');
      await writeFile(join(inner, 'pkg', 'a.txt'), 'a');
      const seen = await walk({
        cwd: join(inner, 'pkg'),
        pattern: '**/*',
        skipIgnored: true,
        ignoreCeiling: inner,
      });
      assert.deepStrictEqual(seen, ['a.txt']);
    } finally {
      await cleanupTestRoot(outer);
    }
  });
});
