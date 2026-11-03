import assert from 'node:assert/strict';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode } from '../src/core/errors.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import {
  cleanupTestRoot,
  createElicitationClientPair,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  fsErrorMatcher,
  makeGuard,
  type TestClientContext,
  trySymlink,
  withEnv,
  writeTestFile,
} from './helpers.ts';

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/** `rel` under `dir` as the guard spells it (on Windows its roots carry a lowercase drive letter). */
const under = (dir: string, rel: string): string => join(normalizePath(dir), rel);

// A desktop host starts the server outside the project and an HTTP client
// never shares its working directory, so a relative path the server itself
// printed (search_text, find_files) resolves against the roots once the
// working directory puts it outside every one.
describe('relative paths', () => {
  let base: string;
  let root: string;
  let second: string;
  let elsewhere: string;
  let previousCwd: string;

  before(async () => {
    base = await createTestRoot();
    root = join(base, 'root');
    second = join(base, 'second');
    elsewhere = join(base, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await writeTestFile(root, 'src/a.ts', 'export const NEEDLE = 1;\n');
    await writeTestFile(root, 'only-first.txt', 'first');
    await writeTestFile(root, 'both.txt', 'first');
    await writeTestFile(second, 'both.txt', 'second');
    await writeTestFile(second, 'only-second.txt', 'second');
    await writeTestFile(second, '.env', 'SECRET=1');
    previousCwd = process.cwd();
    process.chdir(elsewhere);
  });

  after(async () => {
    process.chdir(previousCwd);
    await cleanupTestRoot(base);
  });

  describe('PathGuard.resolveRelativePaths', () => {
    it('resolves against the one root when the working directory is outside it', async () => {
      const guard = await makeGuard([root]);
      const resolved = await guard.resolveRelativePaths(['src/a.ts', 'missing/new.txt']);
      assert.strictEqual(resolved.get('src/a.ts'), under(root, 'src/a.ts'));
      assert.strictEqual(resolved.get('missing/new.txt'), under(root, 'missing/new.txt'));
    });

    it('leaves absolute and home-relative paths alone', async () => {
      const guard = await makeGuard([root]);
      const resolved = await guard.resolveRelativePaths([join(root, 'src/a.ts'), '~/notes.md']);
      assert.strictEqual(resolved.size, 0, JSON.stringify([...resolved]));
    });

    it('keeps resolving against a working directory inside a root', async () => {
      const guard = await makeGuard([root]);
      process.chdir(join(root, 'src'));
      try {
        assert.strictEqual((await guard.resolveRelativePaths(['a.ts'])).size, 0);
      } finally {
        process.chdir(elsewhere);
      }
    });

    it('picks the one root the path exists under when there are several', async () => {
      const guard = await makeGuard([root, second]);
      const resolved = await guard.resolveRelativePaths(['only-first.txt', 'only-second.txt']);
      assert.strictEqual(resolved.get('only-first.txt'), under(root, 'only-first.txt'));
      assert.strictEqual(resolved.get('only-second.txt'), under(second, 'only-second.txt'));
    });

    it('refuses a path that exists under more than one root', async () => {
      const guard = await makeGuard([root, second]);
      await assert.rejects(
        guard.resolveRelativePaths(['both.txt']),
        fsErrorMatcher(ErrorCode.INVALID_INPUT, 'exists under more than one root'),
      );
    });

    it('refuses a path that exists under none of several roots', async () => {
      const guard = await makeGuard([root, second]);
      await assert.rejects(
        guard.resolveRelativePaths(['nowhere.txt']),
        fsErrorMatcher(ErrorCode.INVALID_INPUT, 'exists under none of the 2 roots'),
      );
    });

    it('never probes a blocked name, so its existence stays hidden', async () => {
      // Only the second root holds .env; probing would pick it and say so.
      const guard = await makeGuard([root, second]);
      const resolved = await guard.resolveRelativePaths(['.env']);
      assert.strictEqual(resolved.get('.env'), under(root, '.env'));
    });

    it('answers the same whether a target through a symlink out of the roots exists or not', async (t) => {
      // A probe that followed root/ext would rewrite only where the outside
      // file exists, and the two errors would tell the caller which is which.
      const outside = join(base, 'outside');
      await writeTestFile(outside, 'present.txt', 'outside');
      if (!(await trySymlink(outside, join(root, 'ext'), () => t.skip('symlink not permitted')))) {
        return;
      }
      const guard = await makeGuard([root, second]);
      const resolved = await guard.resolveRelativePaths(['ext/present.txt', 'ext/missing.txt']);
      assert.strictEqual(resolved.get('ext/present.txt'), under(root, 'ext/present.txt'));
      assert.strictEqual(resolved.get('ext/missing.txt'), under(root, 'ext/missing.txt'));
    });

    it('never probes a directory a path deny rule covers, trailing slash or not', async () => {
      await mkdir(join(root, 'vault/sub'), { recursive: true });
      await withEnv({ FS_DENYLIST: 'vault/*' }, async () => {
        const guard = await makeGuard([root, second]);
        const resolved = await guard.resolveRelativePaths(['vault/sub/', 'vault/none/']);
        assert.strictEqual(resolved.get('vault/sub/'), under(root, 'vault/sub/'));
        assert.strictEqual(resolved.get('vault/none/'), under(root, 'vault/none/'));
      });
    });

    it('changes nothing when no root is configured', async () => {
      const guard = await makeGuard([]);
      assert.strictEqual((await guard.resolveRelativePaths(['src/a.ts'])).size, 0);
    });
  });

  describe('through the tools', () => {
    let harness: TestClientContext;

    before(async () => {
      harness = await createTestClientPair([root]);
    });

    after(async () => {
      await harness.close();
    });

    it('reads a path that search_text printed', async () => {
      const search = await harness.client.callTool({
        name: 'search_text',
        arguments: { searchPattern: 'NEEDLE' },
      });
      const printed = /^(\S+):1:/mu.exec(firstTextBlock(search).text ?? '')?.[1];
      assert.strictEqual(printed, 'src/a.ts');
      const read = await harness.client.callTool({ name: 'read', arguments: { path: printed } });
      assert.notStrictEqual(read.isError, true, firstTextBlock(read).text);
      assert.match(firstTextBlock(read).text ?? '', /export const NEEDLE = 1;/u);
    });

    it('creates a relative path under the root, not the working directory', async () => {
      const result = await harness.client.callTool({
        name: 'create',
        arguments: { files: [{ path: 'out/new.txt', content: 'made' }] },
      });
      assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
      assert.strictEqual(await readFile(join(root, 'out/new.txt'), 'utf-8'), 'made');
      assert.strictEqual(await exists(join(elsewhere, 'out/new.txt')), false);
    });

    it('refuses a batch whose relative and absolute entries name one file', async () => {
      const result = await harness.client.callTool({
        name: 'create',
        arguments: {
          files: [
            { path: 'dup.txt', content: 'one' },
            { path: join(root, 'dup.txt'), content: 'two' },
          ],
        },
      });
      assert.strictEqual(result.isError, true);
      assert.match(firstTextBlock(result).text ?? '', /duplicate of files\[0\]\.path/u);
      assert.strictEqual(await exists(join(root, 'dup.txt')), false);
    });

    it('still blocks a relative secret-file path', async () => {
      await writeTestFile(root, '.env', 'SECRET=1');
      const result = await harness.client.callTool({ name: 'read', arguments: { path: '.env' } });
      assert.strictEqual(result.isError, true);
      assert.match(firstTextBlock(result).text ?? '', /Sensitive file blocked/u);
    });
  });

  it('a declined grant plus an accepted overwrite writes the rest and stops asking', async () => {
    const outside = join(base, 'declined');
    await mkdir(outside, { recursive: true });
    await writeTestFile(root, 'existing.txt', 'old');
    const prompts: string[] = [];
    const harness = await createElicitationClientPair([root], (request) => {
      const { message, requestedSchema } = request.params as {
        message: string;
        requestedSchema?: { properties?: Record<string, unknown> };
      };
      prompts.push(message);
      return 'choice' in (requestedSchema?.properties ?? {})
        ? { action: 'accept' as const, content: { choice: 'overwrite' } }
        : { action: 'decline' as const };
    });
    try {
      const result = await harness.client.callTool({
        name: 'create',
        arguments: {
          files: [
            { path: join(outside, 'n.txt'), content: 'n' },
            { path: 'existing.txt', content: 'new' },
          ],
        },
      });
      assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
      assert.strictEqual(prompts.length, 2, JSON.stringify(prompts));
      assert.strictEqual(await readFile(join(root, 'existing.txt'), 'utf-8'), 'new');
      await assert.rejects(readFile(join(outside, 'n.txt')));
      const { failures } = result.structuredContent as {
        failures: { error: { code: string } }[];
      };
      assert.strictEqual(failures[0]?.error.code, 'ACCESS_DENIED');
    } finally {
      await harness.close();
    }
  });

  it('a partly accepted multi-folder grant plus an overwrite stops asking', async () => {
    const outsideA = join(base, 'partly-a');
    const outsideB = join(base, 'partly-b');
    await mkdir(outsideA, { recursive: true });
    await mkdir(outsideB, { recursive: true });
    await writeTestFile(root, 'existing.txt', 'old');
    const prompts: string[] = [];
    const harness = await createElicitationClientPair([root], (request) => {
      const { message, requestedSchema } = request.params as {
        message: string;
        requestedSchema?: { properties?: { choice?: { items?: { enum?: string[] } } } };
      };
      prompts.push(message);
      if (!message.startsWith('Grant filesystem access')) {
        return { action: 'accept' as const, content: { choice: 'overwrite' } };
      }
      const first = requestedSchema?.properties?.choice?.items?.enum?.[0];
      return { action: 'accept' as const, content: { choice: first ? [first] : [] } };
    });
    try {
      const result = await harness.client.callTool({
        name: 'create',
        arguments: {
          files: [
            { path: join(outsideA, 'n.txt'), content: 'a' },
            { path: join(outsideB, 'n.txt'), content: 'b' },
            { path: 'existing.txt', content: 'new' },
          ],
        },
      });
      assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
      assert.strictEqual(prompts.length, 2, JSON.stringify(prompts));
      assert.strictEqual(await readFile(join(outsideA, 'n.txt'), 'utf-8'), 'a');
      await assert.rejects(readFile(join(outsideB, 'n.txt')));
      assert.strictEqual(await readFile(join(root, 'existing.txt'), 'utf-8'), 'new');
    } finally {
      await harness.close();
    }
  });

  it('keeps a relative path meaning one file across the rounds of a confirmed call', async () => {
    // The first round asks for a grant, the second for an overwrite. A grant
    // that counted as a root would make the third round resolve the same
    // relative paths against two roots and refuse the call the user approved.
    const outside = join(base, 'granted');
    await mkdir(outside, { recursive: true });
    await writeTestFile(root, 'existing.txt', 'old');
    const prompts: string[] = [];
    const harness = await createElicitationClientPair([root], (request) => {
      const { message, requestedSchema } = request.params as {
        message: string;
        requestedSchema?: { properties?: Record<string, unknown> };
      };
      prompts.push(message);
      const asksChoice = 'choice' in (requestedSchema?.properties ?? {});
      return {
        action: 'accept' as const,
        content: asksChoice ? { choice: 'overwrite' } : { confirm: true },
      };
    });
    try {
      const result = await harness.client.callTool({
        name: 'create',
        arguments: {
          files: [
            { path: join(outside, 'n.txt'), content: 'n' },
            { path: 'brand-new.txt', content: 'b' },
            { path: 'existing.txt', content: 'new' },
          ],
        },
      });
      assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
      assert.strictEqual(prompts.length, 2, JSON.stringify(prompts));
      assert.strictEqual(await readFile(join(outside, 'n.txt'), 'utf-8'), 'n');
      assert.strictEqual(await readFile(join(root, 'brand-new.txt'), 'utf-8'), 'b');
      assert.strictEqual(await readFile(join(root, 'existing.txt'), 'utf-8'), 'new');

      // The grant still lets absolute paths in, and relative ones still mean the root.
      const later = await harness.client.callTool({
        name: 'read',
        arguments: { path: 'brand-new.txt' },
      });
      assert.match(firstTextBlock(later).text ?? '', /^b/u);
    } finally {
      await harness.close();
    }
  });

  // Results are printed relative to the root, not to the folder searched, so
  // `a.ts` from a search of `src` cannot be read back as `<root>/a.ts`.
  describe('result paths', () => {
    let harness: TestClientContext;

    before(async () => {
      await writeTestFile(root, 'a.ts', 'DECOY\n');
      await writeTestFile(root, 'src/core/x.ts', 'NEEDLE core\n');
      harness = await createTestClientPair([root]);
    });

    after(async () => {
      await harness.close();
    });

    it('search_text prints a scoped match relative to the root, and it reads back', async () => {
      const result = await harness.client.callTool({
        name: 'search_text',
        arguments: { path: 'src', searchPattern: 'NEEDLE' },
      });
      const { root: reported, matches } = result._meta as {
        root: string;
        matches: { file: string }[];
      };
      assert.deepStrictEqual(
        matches.map((m) => m.file),
        ['src/a.ts', 'src/core/x.ts'],
      );
      assert.strictEqual(reported, normalizePath(root));
      const read = await harness.client.callTool({
        name: 'read',
        arguments: { path: matches[0]?.file },
      });
      assert.match(firstTextBlock(read).text ?? '', /NEEDLE = 1/u);
    });

    it('find_files and replace_text print scoped paths relative to the root', async () => {
      const found = await harness.client.callTool({
        name: 'find_files',
        arguments: { path: 'src', pattern: '*.ts' },
      });
      const { root: reported, results } = found._meta as {
        root: string;
        results: { path: string }[];
      };
      assert.deepStrictEqual(
        results.map((r) => r.path),
        ['src/a.ts', 'src/core/x.ts'],
      );
      assert.strictEqual(reported, normalizePath(root));

      const replaced = await harness.client.callTool({
        name: 'replace_text',
        arguments: { path: 'src/core', searchPattern: 'NEEDLE', replacement: 'X', dryRun: true },
      });
      const preview = replaced._meta as { root: string; results: { path: string }[] };
      assert.deepStrictEqual(
        preview.results.map((r) => r.path),
        ['src/core/x.ts'],
      );
      assert.match(firstTextBlock(replaced).text ?? '', /--- src\/core\/x\.ts/u);
    });

    it("find_files' cached full result names the root its paths are relative to", async () => {
      const found = await harness.client.callTool({
        name: 'find_files',
        arguments: { path: 'src', pattern: '*.ts', maxResults: 1 },
      });
      const { resourceUri } = found._meta as { resourceUri?: string };
      assert.ok(resourceUri, 'a split result is cached');
      const { contents } = await harness.client.readResource({ uri: resourceUri });
      const cached = JSON.parse((contents[0] as { text: string }).text) as {
        root: string;
        results: { path: string }[];
      };
      assert.strictEqual(cached.root, normalizePath(root));
      assert.deepStrictEqual(
        cached.results.map((r) => r.path),
        ['src/a.ts', 'src/core/x.ts'],
      );
    });

    it('list names a listed subfolder by its path from the root', async () => {
      const listed = await harness.client.callTool({
        name: 'list',
        arguments: { path: 'src/core' },
      });
      assert.match(firstTextBlock(listed).text ?? '', /^src\/core\n└── x\.ts/u);
      const top = await harness.client.callTool({ name: 'list', arguments: {} });
      assert.match(firstTextBlock(top).text ?? '', /^root\n/u);
    });

    it('prints absolute paths when the working directory is a subfolder of the root', async () => {
      // Relative paths resolve against the working directory there, so `src/a.ts`
      // would name <root>/src/src/a.ts.
      process.chdir(join(root, 'src'));
      try {
        const result = await harness.client.callTool({
          name: 'search_text',
          arguments: { path: root, searchPattern: 'NEEDLE core' },
        });
        const { matches } = result._meta as { matches: { file: string }[] };
        assert.deepStrictEqual(
          matches.map((m) => m.file),
          [under(root, 'src/core/x.ts')],
        );
      } finally {
        process.chdir(elsewhere);
      }
    });

    it('prints absolute paths for a name that would not read back as given', async () => {
      const guard = await makeGuard([root]);
      const paths = guard.resultPaths(root);
      assert.strictEqual(paths.show(join(root, '~', 'x.txt')), join(root, '~', 'x.txt'));
      assert.strictEqual(paths.show(join(root, 'src', 'a.ts')), 'src/a.ts');
    });

    it(
      'keeps a backslash in a POSIX name, so the printed path names that file, not a/b',
      {
        skip: process.platform === 'win32' && 'backslash is a separator on Windows',
      },
      async () => {
        await writeTestFile(root, 'bs/a\\b.txt', 'BACKSLASH_NEEDLE\n');
        await writeTestFile(root, 'bs/a/b.txt', 'other\n');
        const result = await harness.client.callTool({
          name: 'search_text',
          arguments: { path: 'bs', searchPattern: 'BACKSLASH_NEEDLE' },
        });
        const { matches } = result._meta as { matches: { file: string }[] };
        assert.deepStrictEqual(
          matches.map((m) => m.file),
          ['bs/a\\b.txt'],
        );
        const read = await harness.client.callTool({
          name: 'read',
          arguments: { path: matches[0]?.file },
        });
        assert.match(firstTextBlock(read).text ?? '', /BACKSLASH_NEEDLE/u);
      },
    );

    it(
      'prints a blank name absolute, since a blank path is refused',
      {
        skip: process.platform === 'win32' && 'Windows has no blank file names',
      },
      async () => {
        await writeTestFile(root, 'blank/ ', 'BLANK_NEEDLE\n');
        const found = await harness.client.callTool({
          name: 'find_files',
          arguments: { path: 'blank', pattern: '*' },
        });
        const { results } = found._meta as { results: { path: string }[] };
        assert.deepStrictEqual(
          results.map((r) => r.path),
          ['blank/ '],
          'a name with a non-blank folder reads back as given',
        );
        const paths = (await makeGuard([root])).resultPaths(root);
        assert.strictEqual(paths.show(join(root, ' ')), join(root, ' '));
      },
    );

    it('names the root as configured, not its realpath, in every tool', async (t) => {
      const real = join(base, 'real-root');
      const link = join(base, 'link-root');
      await writeTestFile(real, 'src/r.ts', 'ALIAS_NEEDLE\n');
      if (!(await trySymlink(real, link, () => t.skip('symlink not permitted')))) return;
      const pair = await createTestClientPair([link]);
      try {
        const rootOf = async (name: string, args: Record<string, unknown>) =>
          ((await pair.client.callTool({ name, arguments: args }))._meta as { root?: string }).root;
        const replace = { searchPattern: 'ALIAS_NEEDLE', replacement: 'X', dryRun: true };
        for (const [name, args] of [
          ['search_text', { searchPattern: 'ALIAS_NEEDLE' }],
          ['search_text', { path: 'src', searchPattern: 'ALIAS_NEEDLE' }],
          ['find_files', { path: 'src', pattern: '*.ts' }],
          ['replace_text', replace],
          ['replace_text', { ...replace, path: 'src' }],
        ] as const) {
          assert.strictEqual(
            await rootOf(name, args),
            normalizePath(link),
            `${name} ${JSON.stringify(args)}`,
          );
        }
      } finally {
        await pair.close();
      }
    });

    it('prints absolute paths with several roots, where a shared name would read back as ambiguous', async () => {
      await writeTestFile(root, 'shared/package.json', '{"SHARED_NEEDLE": 1}\n');
      await writeTestFile(second, 'shared/package.json', '{"SHARED_NEEDLE": 2}\n');
      const pair = await createTestClientPair([root, second]);
      try {
        const result = await pair.client.callTool({
          name: 'search_text',
          arguments: { path: join(root, 'shared'), searchPattern: 'SHARED_NEEDLE' },
        });
        const { matches } = result._meta as { matches: { file: string }[] };
        assert.deepStrictEqual(
          matches.map((m) => m.file),
          [under(root, 'shared/package.json')],
        );
        const read = await pair.client.callTool({
          name: 'read',
          arguments: { path: matches[0]?.file },
        });
        assert.match(firstTextBlock(read).text ?? '', /"SHARED_NEEDLE": 1/u);
      } finally {
        await pair.close();
      }
    });

    it('prints absolute paths for a folder the user granted during the session', async () => {
      const granted = join(base, 'granted-results');
      await writeTestFile(granted, 'g.txt', 'GRANTED_NEEDLE\n');
      const pair = await createElicitationClientPair([root], () => ({
        action: 'accept' as const,
        content: { confirm: true },
      }));
      try {
        const result = await pair.client.callTool({
          name: 'search_text',
          arguments: { path: granted, searchPattern: 'GRANTED_NEEDLE' },
        });
        assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
        const { matches } = result._meta as { matches: { file: string }[] };
        assert.deepStrictEqual(
          matches.map((m) => normalizePath(m.file)),
          [normalizePath(join(granted, 'g.txt'))],
        );
        // A bare `sub` would name the root's sub, not the granted one.
        await writeTestFile(granted, 'sub/h.txt', 'h\n');
        const listed = await pair.client.callTool({
          name: 'list',
          arguments: { path: join(granted, 'sub') },
        });
        const header = (firstTextBlock(listed).text ?? '').split('\n')[0] ?? '';
        assert.strictEqual(normalizePath(header), normalizePath(join(granted, 'sub')));
      } finally {
        await pair.close();
      }
    });
  });

  // A client on Windows, or a model that saw a Windows path, can send one to a
  // server on POSIX, where `C:\x` is a relative name. It is refused, not made
  // under the root as a file named `C:\x` or a `C:` folder.
  describe(
    'Windows drive paths on a POSIX host',
    { skip: process.platform === 'win32' && 'a drive path is native on Windows' },
    () => {
      const drivePaths = ['C:\\Users\\x\\f.txt', 'C:/Users/x/f.txt', 'C:', 'c:foo.txt'];
      let harness: TestClientContext;

      before(async () => {
        harness = await createTestClientPair([root]);
      });

      after(async () => {
        await harness.close();
      });

      it('refuses them in create, read, list and find_files, and writes nothing', async () => {
        for (const path of drivePaths) {
          for (const [name, args] of [
            ['create', { files: [{ path, content: 'z' }] }],
            ['read', { path }],
            ['list', { path }],
            ['find_files', { path, pattern: '*' }],
          ] as const) {
            const result = await harness.client.callTool({ name, arguments: args });
            assert.strictEqual(result.isError, true, `${name} ${path}`);
            assert.match(
              firstTextBlock(result).text ?? '',
              /Windows-style path received on a POSIX host/u,
              `${name} ${path}`,
            );
          }
        }
        for (const dir of [root, elsewhere]) {
          const names = await readdir(dir);
          assert.ok(!names.some((n) => /^[A-Za-z]:/u.test(n)), `${dir}: ${names.join(', ')}`);
        }
      });

      it('neither resolves them against a root nor offers a grant for them', async () => {
        const guard = await makeGuard([root]);
        assert.strictEqual((await guard.resolveRelativePaths(drivePaths)).size, 0);
        assert.deepStrictEqual(await guard.precheckAccess(drivePaths), []);
      });

      it('prints a found name that starts with a drive absolute, since it would be refused', async () => {
        const paths = (await makeGuard([root])).resultPaths(root);
        assert.strictEqual(paths.show(join(root, 'C:', 'x.txt')), join(root, 'C:', 'x.txt'));
      });

      it('still reaches a real C: folder under the root by the path a search prints', async () => {
        await writeTestFile(root, 'C:/kept.txt', 'DRIVE_NAME_NEEDLE\n');
        const search = await harness.client.callTool({
          name: 'search_text',
          arguments: { searchPattern: 'DRIVE_NAME_NEEDLE' },
        });
        const { matches } = search._meta as { matches: { file: string }[] };
        assert.deepStrictEqual(
          matches.map((m) => m.file),
          [under(root, 'C:/kept.txt')],
        );
        const read = await harness.client.callTool({
          name: 'read',
          arguments: { path: matches[0]?.file },
        });
        assert.match(firstTextBlock(read).text ?? '', /DRIVE_NAME_NEEDLE/u);
      });
    },
  );

  it('names the roots when a relative path is ambiguous', async () => {
    const harness = await createTestClientPair([root, second]);
    try {
      const result = await harness.client.callTool({
        name: 'read',
        arguments: { path: 'both.txt' },
      });
      assert.strictEqual(result.isError, true);
      const text = firstTextBlock(result).text ?? '';
      assert.match(text, /exists under more than one root/u);
      assert.ok(text.includes(under(root, 'both.txt')) && text.includes(under(second, 'both.txt')));
    } finally {
      await harness.close();
    }
  });
});
