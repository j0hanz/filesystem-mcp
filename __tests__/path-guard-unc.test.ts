import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fsPromises, { lstat, mkdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { globEntries } from '../src/core/glob.ts';
import { Logger } from '../src/core/observability.ts';
import { suggestPaths } from '../src/core/path-completer.ts';
import { findProjectRoot } from '../src/core/path-discovery.ts';
import {
  isPathInsideDirectory,
  isPathWithinDirectories,
  isSamePath,
  isUncOrDevicePath,
  normalizePath,
} from '../src/core/path-utils.ts';
import { PathGuard } from '../src/core/path.ts';
import { snapshotTree, UndoJournal } from '../src/core/undo.ts';
import { FIND_FILES, LIST } from '../src/tools/index.ts';
import { seedRootsFromClient } from '../src/transport/stdio.ts';
import {
  cleanupTestRoot,
  copyVia,
  createTestClientPair,
  createTestRoot,
  createTestServer,
  fsErrorMatcher,
  makeGuard,
  trySymlink,
} from './helpers.ts';
import { runToolBodyResult } from './tool-harness.ts';

const OUT_OF_ROOT = [
  String.raw`\\fs-mcp-test.invalid\share\x.txt`,
  '//fs-mcp-test.invalid/share/x.txt',
  String.raw`/\fs-mcp-test.invalid\share\x.txt`,
  String.raw`\\?\UNC\fs-mcp-test.invalid\share\x.txt`,
  String.raw`\\.\pipe\fs-mcp-test`,
  String.raw`\\?\C:\Windows\x.txt`,
];

const PROJECT_ROOT = String.raw`\\fs-mcp-test.invalid\share\proj`;
const SHARE_PREFIX = '\\\\fs-mcp-test.invalid\\share\\';

const missing = (): Promise<never> =>
  Promise.reject(Object.assign(new Error('ENOENT: stubbed'), { code: 'ENOENT' }));

/**
 * Stub every filesystem call a guard can reach, so no path here can dial a host.
 * `echoRealpath` makes `realpath` answer with its argument, which an operator
 * root on a share needs; everything else fails as missing.
 */
function stubFilesystem(t: TestContext, { echoRealpath = false } = {}) {
  const realpath = echoRealpath
    ? t.mock.method(fsPromises, 'realpath', (path: string) => Promise.resolve(path))
    : t.mock.method(fsPromises, 'realpath', missing);
  const stat = t.mock.method(fsPromises, 'stat', missing);
  const others = [
    t.mock.method(fsPromises, 'lstat', missing),
    t.mock.method(fsPromises, 'readdir', missing),
    t.mock.method(fsPromises, 'opendir', missing),
  ];
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return {
    realpath,
    stat,
    total: () =>
      [realpath, stat, ...others].reduce((sum, method) => sum + method.mock.callCount(), 0),
  };
}

const UNC_TARGET = String.raw`\\fs-mcp-test.invalid\share\x.txt`;
const REAL_FS = {
  lstat: fsPromises.lstat.bind(fsPromises),
  readlink: fsPromises.readlink.bind(fsPromises),
  realpath: fsPromises.realpath.bind(fsPromises),
  stat: fsPromises.stat.bind(fsPromises),
};

/**
 * `links` exist only to `lstat` and `readlink`, as a link and its target. Other
 * paths reach the real call, except a UNC one, which fails as missing so no path
 * here can dial a host. `touched` names the calls that would have opened a link's
 * target: `realpath` or `stat` on it or below it, `lstat` only below it.
 * `uncDirs` makes every other UNC path a real folder, so a walk reaches past it.
 */
function stubLinks(
  t: TestContext,
  links: Readonly<Record<string, string>>,
  { echoRealpath = false, uncDirs = false } = {},
) {
  const targets = new Map(
    Object.entries(links).map(([link, target]) => [normalizePath(link), target]),
  );
  const targetOf = (path: string) => targets.get(normalizePath(path));
  const isRemote = (path: string) => path.startsWith('\\\\');
  const lstat = t.mock.method(fsPromises, 'lstat', (path: string, options?: never) => {
    if (targetOf(path) !== undefined) {
      return Promise.resolve({
        isSymbolicLink: () => true,
        isDirectory: () => false,
        isFile: () => false,
      });
    }
    if (uncDirs && isRemote(path)) {
      return Promise.resolve({
        isSymbolicLink: () => false,
        isDirectory: () => true,
        isFile: () => false,
      });
    }
    return isRemote(path) ? missing() : REAL_FS.lstat(path, options);
  });
  t.mock.method(fsPromises, 'readlink', (path: string) => {
    const target = targetOf(path);
    return target === undefined ? REAL_FS.readlink(path) : Promise.resolve(target);
  });
  const realpath = t.mock.method(fsPromises, 'realpath', (path: string) => {
    if (echoRealpath) return Promise.resolve(path);
    return isRemote(path) ? missing() : REAL_FS.realpath(path);
  });
  const stat = t.mock.method(fsPromises, 'stat', (path: string) =>
    isRemote(path) ? missing() : REAL_FS.stat(path),
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const argsOf = (method: { mock: { calls: readonly { arguments: readonly unknown[] }[] } }) =>
    method.mock.calls.map((call) => normalizePath(String(call.arguments[0])));
  return {
    touched: (link: string) => {
      const inside = (path: string) => isPathInsideDirectory(normalizePath(link), path);
      return [
        ...argsOf(realpath).filter(inside),
        ...argsOf(stat).filter(inside),
        ...argsOf(lstat).filter((path) => inside(path) && !isSamePath(path, link)),
      ];
    },
  };
}

describe(
  'UNC and device paths',
  { skip: process.platform !== 'win32' && 'Windows path shapes' },
  () => {
    let root: string;
    let guard: PathGuard;

    before(async () => {
      root = await createTestRoot();
      guard = await makeGuard([root]);
    });

    after(async () => {
      await cleanupTestRoot(root);
    });

    it('isUncOrDevicePath recognizes every spelling and nothing else', () => {
      for (const path of OUT_OF_ROOT) {
        assert.equal(isUncOrDevicePath(normalizePath(path)), true, path);
      }
      assert.equal(isUncOrDevicePath(normalizePath(String.raw`\\server`)), false);
      assert.equal(isUncOrDevicePath(normalizePath('C:\\x')), false);
    });

    it('refuses without a filesystem call', async (t) => {
      const fs = stubFilesystem(t);
      for (const path of OUT_OF_ROOT) {
        assert.deepEqual(await guard.precheckAccess([path]), [], path);
        await assert.rejects(
          guard.validateExistingPath(path),
          fsErrorMatcher(ErrorCode.ACCESS_DENIED),
        );
        assert.equal(fs.total(), 0, path);
      }
    });

    it('says network and device paths are never granted and a share must be a root', async (t) => {
      stubFilesystem(t);
      for (const path of OUT_OF_ROOT) {
        await assert.rejects(
          guard.validateExistingPath(path),
          fsErrorMatcher(ErrorCode.ACCESS_DENIED, /never granted.*configure the share as a root/iu),
        );
      }
    });

    it('does not contradict that with advice to accept a grant', async (t) => {
      stubFilesystem(t);
      for (const path of OUT_OF_ROOT) {
        await assert.rejects(guard.validateExistingPath(path), (error: unknown) => {
          assert.ok(isFsError(error));
          assert.strictEqual(error.problem.suggestion, undefined);
          return true;
        });
      }
    });

    it('refuses without a filesystem call under FS_ROOT_BOUNDARY', async (t) => {
      const previous = process.env['FS_ROOT_BOUNDARY'];
      t.after(() => {
        if (previous === undefined) delete process.env['FS_ROOT_BOUNDARY'];
        else process.env['FS_ROOT_BOUNDARY'] = previous;
      });
      process.env['FS_ROOT_BOUNDARY'] = root;
      const bounded = new PathGuard({ cliAllowedDirs: [root] });
      await bounded.recomputeAllowedDirectories();

      const fs = stubFilesystem(t);
      for (const path of OUT_OF_ROOT) {
        assert.deepEqual(await bounded.precheckAccess([path]), [], path);
        await assert.rejects(
          bounded.validateExistingPath(path),
          fsErrorMatcher(ErrorCode.ACCESS_DENIED),
        );
        assert.equal(fs.total(), 0, path);
      }
    });

    it('applyGrant refuses a share without a filesystem call', async (t) => {
      const fs = stubFilesystem(t);
      assert.equal(await guard.applyGrant(String.raw`\\localhost\C$\Windows`), false);
      assert.equal(await guard.applyGrant(String.raw`\\127.0.0.1\c$\Users\me\.ssh`), false);
      assert.equal(fs.total(), 0);
    });

    it('a stat over the wire answers ACCESS_DENIED and never asks', async (t) => {
      const pair = await createTestClientPair([root]);
      t.after(async () => {
        await pair.close();
        pair.serverCtx.disposeRuntimeState();
      });
      const fs = stubFilesystem(t);
      const result = await pair.client.callTool({
        name: 'stat',
        arguments: { path: OUT_OF_ROOT[0] },
      });
      assert.equal(result.isError, true);
      assert.notEqual(result['resultType'], 'input_required');
      assert.match(JSON.stringify(result.content), /ACCESS_DENIED/u);
      assert.equal(fs.total(), 0);
    });

    it('legacy seeding refuses a client root on a share', async (t) => {
      const ctx = await createTestServer([]);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client(
        { name: 'unc-roots-test', version: '1.0.0' },
        { capabilities: { roots: {} } },
      );
      client.setRequestHandler('roots/list', () => ({
        roots: [{ uri: 'file://fs-mcp-test.invalid/share/proj', name: 'share' }],
      }));
      await Promise.all([client.connect(clientTransport), ctx.mcp.connect(serverTransport)]);
      t.after(async () => {
        await client.close();
        await ctx.mcp.close();
        ctx.disposeRuntimeState();
      });
      const debug = t.mock.method(Logger, 'debug');
      const fs = stubFilesystem(t);

      assert.equal(await seedRootsFromClient(ctx), 0);
      assert.ok(
        debug.mock.calls.some(
          (call) => call.arguments[0] === '[Stdio] client root refused by grant policy',
        ),
      );
      assert.equal(fs.total(), 0);
    });

    describe('an operator root on a share', () => {
      const operatorGuard = (): PathGuard => {
        const shared = new PathGuard();
        shared.initialize([PROJECT_ROOT]);
        return shared;
      };

      it('keeps working', async (t) => {
        stubFilesystem(t, { echoRealpath: true });
        const shared = operatorGuard();
        const inside = String.raw`${PROJECT_ROOT}\a.txt`;
        assert.equal(await shared.validateExistingPath(inside), inside);
        assert.deepEqual(await shared.precheckAccess([inside]), []);
      });

      it('does not extend to a sibling on that share', async (t) => {
        const fs = stubFilesystem(t, { echoRealpath: true });
        const shared = operatorGuard();
        const sibling = String.raw`\\fs-mcp-test.invalid\share\other\a.txt`;
        assert.deepEqual(await shared.precheckAccess([sibling]), []);
        assert.equal(fs.stat.mock.callCount(), 0);
        assert.equal(fs.total(), 0);
        await assert.rejects(
          shared.validateExistingPath(sibling),
          fsErrorMatcher(ErrorCode.ACCESS_DENIED),
        );
      });

      it('suggestPaths does not touch the share', async (t) => {
        const fs = stubFilesystem(t, { echoRealpath: true });
        await suggestPaths(operatorGuard(), SHARE_PREFIX);
        assert.equal(fs.total(), 0);
      });
    });

    it('suggestPaths does not touch a share outside the roots', async (t) => {
      const fs = stubFilesystem(t);
      await suggestPaths(guard, SHARE_PREFIX);
      assert.equal(fs.total(), 0);
    });

    it('refuses a grant to a local link that resolves to a share', async (t) => {
      const link = String.raw`C:\fs-mcp-review\link`;
      const fs = stubFilesystem(t);
      fs.realpath.mock.mockImplementation((path: string) =>
        Promise.resolve(path.toLowerCase() === link.toLowerCase() ? PROJECT_ROOT : path),
      );
      fs.stat.mock.mockImplementation(() => Promise.resolve({ isDirectory: () => true } as never));
      const local = new PathGuard();
      local.initialize([String.raw`C:\fs-mcp-review\root`]);

      assert.deepEqual(await local.precheckAccess([link]), []);
      assert.equal(await local.applyGrant(link), false);
      assert.ok(!isPathWithinDirectories(PROJECT_ROOT, local.getAllowedDirectories()));
    });

    it('offers no grant for a local file link that resolves to a share', async (t) => {
      const link = String.raw`C:\fs-mcp-review\link.txt`;
      const fs = stubFilesystem(t);
      fs.realpath.mock.mockImplementation((path: string) =>
        Promise.resolve(
          path.toLowerCase() === link.toLowerCase()
            ? String.raw`\\fs-mcp-test.invalid\share\secret.txt`
            : path,
        ),
      );
      // A file: the walk up to a grant directory would stop at its local parent.
      fs.stat.mock.mockImplementation((path) =>
        Promise.resolve({
          isDirectory: () => String(path).toLowerCase() !== link.toLowerCase(),
        } as never),
      );
      const local = new PathGuard();
      local.initialize([String.raw`C:\fs-mcp-review\root`]);

      assert.deepEqual(await local.precheckAccess([link]), []);
    });

    it('entryVerdict rules on an out-of-root share without realpath', async (t) => {
      const fs = stubFilesystem(t);
      assert.equal(
        await guard.entryVerdict(String.raw`\\fs-mcp-test.invalid\share\x.txt`),
        'inaccessible',
      );
      assert.equal(fs.realpath.mock.callCount(), 0);
    });

    it('a lone leading double slash is a drive path, not a share', () => {
      const normalized = normalizePath(String.raw`\\server`);
      assert.equal(isUncOrDevicePath(normalized), false);
      assert.match(normalized, /^[a-z]:\\/u);
    });
  },
);

describe(
  'a link to a network path',
  { skip: process.platform !== 'win32' && 'Windows path shapes' },
  () => {
    let root: string;
    let other: string;
    let guard: PathGuard;
    let link: string;

    before(async () => {
      root = await createTestRoot();
      other = await createTestRoot();
      guard = await makeGuard([root]);
      link = join(root, 'looks-normal');
    });

    after(async () => {
      await cleanupTestRoot(root);
      await cleanupTestRoot(other);
    });

    const denied = fsErrorMatcher(ErrorCode.ACCESS_DENIED, /network or device path/u);

    it('refuses the link and a path through it, without following', async (t) => {
      const fs = stubLinks(t, { [link]: UNC_TARGET });
      await assert.rejects(guard.validateExistingPath(link), denied);
      await assert.rejects(guard.validateExistingPath(join(link, 'a.txt')), denied);
      assert.deepEqual(fs.touched(link), []);
    });

    it('refuses a write through it, without following', async (t) => {
      const fs = stubLinks(t, { [link]: UNC_TARGET });
      await assert.rejects(guard.validatePathForWrite(join(link, 'new.txt')), denied);
      assert.deepEqual(fs.touched(link), []);
    });

    it('refuses a delete through it, without following', async (t) => {
      const fs = stubLinks(t, { [link]: UNC_TARGET });
      await assert.rejects(guard.validatePathForDelete(join(link, 'a.txt')), denied);
      assert.deepEqual(fs.touched(link), []);
    });

    it('gives no advice about roots, which would not get past the link', async (t) => {
      stubLinks(t, { [link]: UNC_TARGET });
      for (const refused of [
        () => guard.validateExistingPath(link),
        () => guard.validatePathForWrite(join(link, 'new.txt')),
        () => guard.validatePathForDelete(join(link, 'a.txt')),
      ]) {
        await assert.rejects(refused, (error: unknown) => {
          assert.ok(isFsError(error));
          assert.strictEqual(error.problem.suggestion, undefined);
          return true;
        });
      }
    });

    it('entryVerdict calls it inaccessible, without following', async (t) => {
      const fs = stubLinks(t, { [link]: UNC_TARGET });
      assert.equal(await guard.entryVerdict(link), 'inaccessible');
      assert.deepEqual(fs.touched(link), []);
    });

    it('finds the host at the end of a chain', async (t) => {
      const one = join(root, 'one');
      const two = join(root, 'two');
      const fs = stubLinks(t, { [one]: two, [two]: UNC_TARGET });
      await assert.rejects(guard.validateExistingPath(one), denied);
      assert.deepEqual(fs.touched(one), []);
      assert.deepEqual(fs.touched(two), []);
    });

    it('finds the host through a relative target', async (t) => {
      const rel = join(root, 'rel');
      const hop = join(other, 'hop');
      const fs = stubLinks(t, {
        [rel]: join('..', basename(other), 'hop'),
        [hop]: UNC_TARGET,
      });
      await assert.rejects(guard.validateExistingPath(rel), denied);
      assert.deepEqual(fs.touched(rel), []);
      assert.deepEqual(fs.touched(hop), []);
    });

    it('treats a link cycle as reaching a host', async (t) => {
      const a = join(root, 'cycle-a');
      const b = join(root, 'cycle-b');
      stubLinks(t, { [a]: b, [b]: a });
      assert.equal(await guard.reachesRemoteLink(a), true);
    });

    it('resolves a relative target from the real folder under an aliased root', async (t) => {
      const base = await createTestRoot();
      t.after(() => cleanupTestRoot(base));
      const skip = () => t.skip('symlink creation not permitted');
      const repo = join(base, 'physical', 'repo');
      await mkdir(repo, { recursive: true });
      const alias = join(base, 'alias');
      if (!(await trySymlink(repo, alias, skip))) return;
      if (!(await trySymlink(UNC_TARGET, join(base, 'physical', 'hop'), skip, 'file'))) return;
      if (!(await trySymlink(join('..', 'hop'), join(repo, 'escape'), skip, 'file'))) return;
      const aliased = await makeGuard([alias]);
      assert.equal(await aliased.reachesRemoteLink(normalizePath(join(alias, 'escape'))), true);
    });

    const drain = async (pattern: string): Promise<string[]> => {
      const paths: string[] = [];
      for await (const entry of globEntries({ cwd: root, pattern, pathGuard: guard })) {
        paths.push(entry.path);
      }
      return paths;
    };

    for (const pattern of [
      'looks-normal/*',
      './looks-normal/*',
      'sub/../looks-normal/*',
      'looks-normal/deep/*.txt',
    ]) {
      it(`refuses the glob ${pattern} before it walks`, async (t) => {
        const fs = stubLinks(t, { [link]: UNC_TARGET });
        await assert.rejects(drain(pattern), denied);
        assert.deepEqual(fs.touched(link), []);
      });
    }

    it('a search names the refused pattern', async (t) => {
      stubLinks(t, { [link]: UNC_TARGET });
      await assert.rejects(
        runToolBodyResult(FIND_FILES, { path: root, pattern: 'looks-normal/*' }, { guard }),
        fsErrorMatcher(ErrorCode.ACCESS_DENIED, /looks-normal\/\*.*network or device path/u),
      );
    });

    it('no glob passes through a link named without a letter', async (t) => {
      const base = await createTestRoot();
      t.after(() => cleanupTestRoot(base));
      const target = join(base, 'outside');
      await mkdir(target);
      await writeFile(join(target, 'x.txt'), 'x');
      const cwd = join(base, 'cwd');
      await mkdir(join(cwd, 'a'), { recursive: true });
      const skip = () => t.skip('symlink creation not permitted');
      if (!(await trySymlink(target, join(cwd, '123'), skip))) return;
      if (!(await trySymlink(target, join(cwd, 'a', '123'), skip))) return;
      const walk = async (pattern: string): Promise<string[]> => {
        const paths: string[] = [];
        for await (const entry of globEntries({ cwd, pattern })) paths.push(entry.path);
        return paths;
      };
      for (const pattern of ['123/x.txt', '{123,x}/*', '*/123/*', '*/{123,x}/*']) {
        assert.deepEqual(await walk(pattern), [], pattern);
      }
      // A literal leading folder stays a way into a local link.
      assert.equal((await walk('123/*')).length, 1);
    });

    it('refuses a link found under another Unicode spelling', async (t) => {
      const onDisk = 'café-link';
      const fs = stubLinks(t, { [join(root, onDisk)]: UNC_TARGET });
      t.mock.method(fsPromises, 'readdir', () => Promise.resolve([onDisk]));
      syncBuiltinESMExports();
      await assert.rejects(guard.validateExistingPath(join(root, 'café-link')), denied);
      assert.deepEqual(fs.touched(join(root, onDisk)), []);
    });

    it('offers and applies no grant to one outside the roots', async (t) => {
      const outside = join(other, 'link');
      const fs = stubLinks(t, { [outside]: UNC_TARGET });
      assert.deepEqual(await guard.precheckAccess([outside]), []);
      assert.equal(await guard.applyGrant(outside), false);
      assert.deepEqual(fs.touched(outside), []);
    });

    it('still deletes the link itself', async (t) => {
      const fs = stubLinks(t, { [link]: UNC_TARGET });
      assert.ok(isSamePath(await guard.validatePathForDelete(link), link));
      assert.deepEqual(fs.touched(link), []);
    });

    it('still moves the link itself', async (t) => {
      const fs = stubLinks(t, { [link]: UNC_TARGET });
      const plan = await new GuardedFileSystem(guard).planTransfer('move', {
        source: link,
        destination: join(root, 'moved'),
      });
      assert.equal(plan.landing, plan.entry);
      assert.ok(isSamePath(plan.entry, link));
      assert.deepEqual(fs.touched(link), []);
    });

    it('abandons an undo capture without typing the link', async (t) => {
      const fs = stubLinks(t, { [link]: UNC_TARGET });
      const capture = new UndoJournal(32 * 1024 * 1024).beginCapture();
      await snapshotTree(capture, new GuardedFileSystem(guard), link);
      assert.equal(capture.unavailableReason(), 'a link to a network path');
      assert.deepEqual(fs.touched(link), []);
    });

    it('follows a link between two places on a share root', async (t) => {
      const shared = new PathGuard();
      shared.initialize([PROJECT_ROOT]);
      const inside = join(PROJECT_ROOT, 'link');
      stubLinks(t, { [inside]: join(PROJECT_ROOT, 'real.txt') }, { echoRealpath: true });
      assert.equal(await shared.validateExistingPath(inside), inside);
    });

    describe('with an operator root on a share', () => {
      const dir = join(PROJECT_ROOT, 'dir');
      const viaLink = join(dir, 'link', 'f.txt');
      const shared = (): PathGuard => {
        const g = new PathGuard();
        g.initialize([PROJECT_ROOT]);
        return g;
      };

      for (const [name, target] of [
        ['another host', '//other.fs-mcp-test.invalid/share/x'],
        ['a sibling on the same share, outside the root', '//fs-mcp-test.invalid/share/sibling/x'],
      ] as const) {
        it('refuses a link to ' + name, async (t) => {
          const fs = stubLinks(
            t,
            { [join(dir, 'link')]: target },
            { echoRealpath: true, uncDirs: true },
          );
          const g = shared();
          assert.equal(await g.reachesRemoteLink(normalizePath(viaLink)), true);
          await assert.rejects(g.validateExistingPath(viaLink), denied);
          assert.deepEqual(fs.touched(join(dir, 'link')), []);
        });
      }
    });

    it('keeps in-root links under a local root reached through a link to a share', async (t) => {
      const aliased = join(root, 'alias', 'proj');
      const shared = new PathGuard();
      shared.initialize([aliased]);
      const rel = join(aliased, 'rel');
      const abs = join(aliased, 'abs');
      stubLinks(
        t,
        {
          [join(root, 'alias')]: String.raw`\\fs-mcp-test.invalid\share`,
          [rel]: 'real.txt',
          [abs]: join(aliased, 'real.txt'),
        },
        { echoRealpath: true },
      );
      assert.equal(await shared.reachesRemoteLink(normalizePath(rel)), false);
      assert.equal(await shared.reachesRemoteLink(normalizePath(abs)), false);
      assert.ok(isSamePath(await shared.validateExistingPath(rel), rel));
      assert.ok(isSamePath(await shared.validateExistingPath(abs), abs));
    });

    it('keeps in-root links under a share root reached through another folder', async (t) => {
      const share = String.raw`\\fs-mcp-test.invalid\share`;
      const aliased = join(share, 'alias', 'proj');
      const shared = new PathGuard();
      shared.initialize([aliased]);
      const rel = join(aliased, 'rel');
      stubLinks(
        t,
        { [join(share, 'alias')]: join(share, 'real'), [rel]: 'real.txt' },
        { echoRealpath: true },
      );
      assert.equal(await shared.reachesRemoteLink(rel), false);
      assert.equal(await shared.validateExistingPath(rel), rel);
    });

    it('findProjectRoot does not open a marker linked to a share', async (t) => {
      const base = await createTestRoot();
      t.after(() => cleanupTestRoot(base));
      const start = join(base, 'proj');
      await mkdir(start);
      const marker = join(start, 'package.json');
      const made = await trySymlink(
        UNC_TARGET,
        marker,
        () => t.skip('symlinks need elevation here'),
        'file',
      );
      if (!made) return;
      const fs = stubLinks(t, {});
      assert.equal(await findProjectRoot(start, [base]), normalizePath(start));
      assert.deepEqual(fs.touched(marker), []);
    });

    /** A fresh root's folder holding a file and a real link; undefined where links need elevation. */
    const folderWithLink = async (t: TestContext) => {
      const base = await createTestRoot();
      t.after(() => cleanupTestRoot(base));
      const folder = join(base, 'folder');
      await mkdir(folder);
      await writeFile(join(folder, 'keep.txt'), 'kept');
      const real = join(folder, 'looks-normal');
      const made = await trySymlink(
        UNC_TARGET,
        real,
        () => {
          t.skip('symlinks need elevation here');
        },
        'file',
      );
      return made ? { base, folder, real, folderGuard: await makeGuard([base]) } : undefined;
    };

    it('refuses a folder copy holding one, before copying', async (t) => {
      const made = await folderWithLink(t);
      if (!made) return;
      const fs = stubLinks(t, {});
      const destination = join(made.base, 'copied');
      await assert.rejects(
        copyVia(new GuardedFileSystem(made.folderGuard), made.folder, destination),
        denied,
      );
      assert.equal(existsSync(destination), false);
      assert.deepEqual(fs.touched(made.real), []);
    });

    it('still moves a folder holding one on the same device', async (t) => {
      const made = await folderWithLink(t);
      if (!made) return;
      const fs = stubLinks(t, {});
      const destination = join(made.base, 'moved');
      await new GuardedFileSystem(made.folderGuard).rename(made.folder, destination);
      assert.equal((await lstat(join(destination, 'looks-normal'))).isSymbolicLink(), true);
      assert.deepEqual(fs.touched(made.real), []);
    });

    it('refuses a cross-device move of a folder holding one, or of the link', async (t) => {
      const made = await folderWithLink(t);
      if (!made) return;
      const fs = stubLinks(t, {});
      const across = new GuardedFileSystem(made.folderGuard, undefined, {
        rename: () => Promise.reject(Object.assign(new Error('stubbed'), { code: 'EXDEV' })),
      });
      await assert.rejects(across.rename(made.folder, join(made.base, 'moved')), denied);
      await assert.rejects(across.rename(made.real, join(made.base, 'moved-link')), denied);
      assert.equal(existsSync(join(made.base, 'moved')), false);
      assert.equal((await lstat(made.real)).isSymbolicLink(), true);
      assert.deepEqual(fs.touched(made.real), []);
    });

    it('list skips a real link and never resolves it', async (t) => {
      const listed = await createTestRoot();
      t.after(() => cleanupTestRoot(listed));
      const real = join(listed, 'looks-normal');
      const made = await trySymlink(
        UNC_TARGET,
        real,
        () => {
          t.skip('symlinks need elevation here');
        },
        'file',
      );
      if (!made) return;
      const listGuard = await makeGuard([listed]);
      const realpath = t.mock.method(fsPromises, 'realpath');
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      const result = await runToolBodyResult(LIST, { path: listed }, { guard: listGuard });
      assert.match(String(result.text), /skipped 1 inaccessible entry/u);
      assert.deepEqual(
        realpath.mock.calls.filter((call) =>
          isPathInsideDirectory(real, normalizePath(String(call.arguments[0]))),
        ),
        [],
      );
    });
  },
);
