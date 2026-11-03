import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { after, before, describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { ErrorCode } from '../src/core/errors.ts';
import { Logger } from '../src/core/observability.ts';
import { suggestPaths } from '../src/core/path-completer.ts';
import { isUncOrDevicePath, normalizePath } from '../src/core/path-utils.ts';
import { PathGuard } from '../src/core/path.ts';
import { seedRootsFromClient } from '../src/transport/stdio.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  createTestServer,
  fsErrorMatcher,
  makeGuard,
} from './helpers.ts';

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
