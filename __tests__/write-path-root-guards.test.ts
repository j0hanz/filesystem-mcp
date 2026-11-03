// Issue #200: tests that fail when each write-path / root guard is removed.
// The fd re-check stub makes `/proc/self/fd/N` read back as an out-of-root
// path on every OS, so the Windows/macOS runs exercise the Linux-only check.
// The unicode-respelling scenario reaches a directory scan through a link
// that leaves the roots, where a missing ancestor check would answer with the
// ambiguity error instead of ACCESS_DENIED.
import assert from 'node:assert/strict';
import type { PathLike } from 'node:fs';
import fsPromises, { link, readFile, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { TestContext } from 'node:test';

import { ErrorCode } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { Logger } from '../src/core/observability.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import { PathGuard } from '../src/core/path.ts';
import { SensitiveMatcher } from '../src/core/sensitive.ts';
import type { FilesystemServerContext } from '../src/server.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  createTestServer,
  fsErrorMatcher,
  trySymlink,
  withEnv,
  writeTestFile,
} from './helpers.ts';

describe('Write-path and root guards (issue #200)', () => {
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

  /** `/proc/self/fd/N` reads back as the out-of-root path, on every OS. */
  function stubDescriptorOutside(t: TestContext): void {
    const originalReadlink = fsPromises.readlink.bind(fsPromises);
    t.mock.method(fsPromises, 'readlink', (path: PathLike) =>
      String(path).startsWith('/proc/self/fd/')
        ? Promise.resolve('/outside-roots/secret.txt')
        : originalReadlink(path),
    );
    syncBuiltinESMExports();
  }

  it('an in-place write to a hard-linked file refuses when the descriptor re-check reports outside the roots, bytes unchanged', async (t) => {
    const target = await writeTestFile(tmpDir, 'guard-hardlink.txt', 'KEEP\n');
    await link(target, join(tmpDir, 'guard-hardlink.alias'));
    stubDescriptorOutside(t);
    try {
      await assert.rejects(
        fs.writeFile(target, 'CHANGED'),
        fsErrorMatcher(ErrorCode.ACCESS_DENIED, 'TOCTOU'),
      );
      assert.strictEqual(await readFile(target, 'utf8'), 'KEEP\n');
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it('an append to an existing file refuses the same way, bytes unchanged', async (t) => {
    const target = await writeTestFile(tmpDir, 'guard-append.txt', 'KEEP\n');
    stubDescriptorOutside(t);
    try {
      await assert.rejects(
        fs.appendFile(target, 'MORE'),
        fsErrorMatcher(ErrorCode.ACCESS_DENIED, 'TOCTOU'),
      );
      assert.strictEqual(await readFile(target, 'utf8'), 'KEEP\n');
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  // Windows temp lives under the user profile, which isUnsafeCwdPath always
  // refuses, so a safe temporary cwd exists only on POSIX.
  it(
    'with allowCwd set, a temporary working directory becomes a root',
    { skip: process.platform === 'win32' },
    async () => {
      await withEnv(
        {
          FS_ALLOWED_DIRS: undefined,
          FS_ROOT_BOUNDARY: undefined,
          FS_ALLOW_CWD_WALK: undefined,
          FS_READ_ONLY_DIRS: undefined,
        },
        async () => {
          const previous = process.cwd();
          process.chdir(tmpDir);
          try {
            const guard = new PathGuard({ allowCwd: true });
            await guard.recomputeAllowedDirectories();
            assert.ok(
              guard.allowedRootContaining(normalizePath(join(tmpDir, 'probe.txt'))) !== undefined,
              `expected cwd ${tmpDir} among roots: ${JSON.stringify(guard.getRoots())}`,
            );
          } finally {
            process.chdir(previous);
          }
        },
      );
    },
  );

  it('with allowCwd set and home as the working directory, no root is added and the warning logs', async () => {
    await withEnv(
      {
        FS_ALLOWED_DIRS: undefined,
        FS_ROOT_BOUNDARY: undefined,
        FS_ALLOW_CWD_WALK: undefined,
        FS_READ_ONLY_DIRS: undefined,
      },
      async () => {
        const home = homedir();
        const previous = process.cwd();
        process.chdir(home);
        const warns: string[] = [];
        const originalWarn = Logger.warn;
        Logger.warn = (message: string) => {
          warns.push(message);
        };
        try {
          const guard = new PathGuard({ allowCwd: true });
          await guard.recomputeAllowedDirectories();
          assert.equal(
            guard.allowedRootContaining(normalizePath(join(home, 'probe.txt'))),
            undefined,
            `home must not become a root: ${JSON.stringify(guard.getRoots())}`,
          );
          assert.ok(
            warns.some((m) =>
              m.includes('Skipped adding unsafe current working directory to allowed list'),
            ),
            warns.join('\n'),
          );
        } finally {
          Logger.warn = originalWarn;
          process.chdir(previous);
        }
      },
    );
  });

  it('a Unicode respelling reached through a link that leaves the roots refuses with ACCESS_DENIED, not an ambiguity error', async (t) => {
    const outside = await createTestRoot();
    const linkPath = join(tmpDir, 'door');
    if (!(await trySymlink(outside, linkPath, () => t.skip()))) return;
    try {
      // Two entries folding to the same unicodeMatchKey, neither the typed
      // spelling: a directory scan on the outside dir would refuse as
      // ambiguous and list names that are outside the roots.
      await writeFile(join(outside, 'café file.txt'), 'a');
      await writeFile(join(outside, 'café file.txt'), 'a');
      const requested = join(linkPath, 'café file.txt');
      const assertNotOutside = (error: unknown): boolean => {
        assert.ok(
          !(error as Error).message.includes('Ambiguous'),
          `ambiguity error must not answer a respelling that leaves the roots: ${(error as Error).message}`,
        );
        assert.ok(
          !(error as Error).message.includes(outside),
          `error must not name the outside directory: ${(error as Error).message}`,
        );
        return true;
      };
      await assert.rejects(
        ctx.pathGuard.validateExistingPath(requested),
        (error: unknown) =>
          fsErrorMatcher(ErrorCode.ACCESS_DENIED)(error) && assertNotOutside(error),
      );
      await assert.rejects(
        ctx.pathGuard.validatePathForDelete(requested),
        (error: unknown) =>
          fsErrorMatcher(ErrorCode.ACCESS_DENIED)(error) && assertNotOutside(error),
      );
    } finally {
      await cleanupTestRoot(outside);
    }
  });

  it('a newline-separated FS_DENYLIST denies every listed name', async () => {
    // Operator entries, not built-ins: a broken newline split must show here,
    // not hide behind a pattern the built-in list already denies.
    await withEnv({ FS_DENYLIST: '*.ledger\n*.deck\n', FS_ALLOWLIST: undefined }, async () => {
      const matcher = new SensitiveMatcher();
      assert.equal(matcher.isSensitive('/proj/a.ledger'), true);
      assert.equal(matcher.isSensitive('/proj/a.deck'), true);
      assert.equal(matcher.isSensitive('/proj/main.ts'), false);
    });
  });

  it('a newline-separated FS_ALLOWLIST relieves every listed name', async () => {
    await withEnv({ FS_ALLOWLIST: '*.pem\n*.key', FS_DENYLIST: undefined }, async () => {
      const matcher = new SensitiveMatcher();
      assert.equal(matcher.isSensitive('/proj/server.pem'), false);
      assert.equal(matcher.isSensitive('/proj/server.key'), false);
      // A built-in outside the list still denies.
      assert.equal(matcher.isSensitive('/proj/.env'), true);
    });
  });

  // keepOwner's lchown only runs where process.getuid exists, and proving the
  // default implementation keeps the owner needs no root: a non-root chown of
  // a file the process itself owns succeeds.
  it(
    'writeFile keeps a file’s owner through the default lchown',
    { skip: process.platform === 'win32' },
    async (t) => {
      const target = await writeTestFile(tmpDir, 'owner-kept.txt', 'old\n');
      const existing = await stat(target);
      const calls: { path: string; uid: number; gid: number }[] = [];
      const originalLchown = fsPromises.lchown.bind(fsPromises);
      t.mock.method(fsPromises, 'lchown', (path: PathLike, uid: number, gid: number) => {
        calls.push({ path: String(path), uid, gid });
        return originalLchown(path, uid, gid);
      });
      syncBuiltinESMExports();
      try {
        await fs.writeFile(target, 'new\n');
        assert.equal(calls.length, 1, `expected one lchown call, got ${JSON.stringify(calls)}`);
        assert.equal(calls[0]?.uid, existing.uid);
        assert.equal(calls[0]?.gid, existing.gid);
        assert.ok(calls[0]?.path.endsWith('.tmp'), calls[0]?.path);
        assert.strictEqual(await readFile(target, 'utf8'), 'new\n');
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    },
  );
});
