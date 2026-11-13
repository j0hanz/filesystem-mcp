import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { Logger } from '../src/core/observability.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import { PathGuard } from '../src/core/path.ts';
import {
  cleanupTestRoot,
  copyVia,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  type TestClientContext,
  trySymlink,
} from './helpers.ts';

// Per-root read-only (#162): PathGuard holds a configured list of read-only
// directories (CLI --read-only-root / env FS_READ_ONLY_DIRS) and answers
// containment on it. Guard-level half of the feature; the write/delete
// denial and tool-level halves live in later describe blocks.
describe('PathGuard read-only directories', { concurrency: false }, () => {
  let base: string;
  let rw: string;
  let ro: string;

  before(async () => {
    base = await createTestRoot();
    rw = join(base, 'rw');
    ro = join(base, 'ro');
    await mkdir(rw);
    await mkdir(ro);
  });

  after(async () => {
    await cleanupTestRoot(base);
  });

  it('RO-STATE-001: marks paths inside a configured read-only dir', async () => {
    const guard = new PathGuard({ cliAllowedDirs: [rw], readOnlyDirs: [ro] });
    await guard.recomputeAllowedDirectories();
    assert.equal(guard.isReadOnlyPath(join(ro, 'x.txt')), true);
    assert.equal(guard.isReadOnlyPath(ro), true);
    assert.equal(guard.isReadOnlyPath(join(rw, 'x.txt')), false);
  });

  it('RO-STATE-002: picks up FS_READ_ONLY_DIRS', async () => {
    process.env['FS_READ_ONLY_DIRS'] = ro;
    try {
      const guard = new PathGuard({ cliAllowedDirs: [rw] });
      await guard.recomputeAllowedDirectories();
      assert.equal(guard.isReadOnlyPath(join(ro, 'x.txt')), true);
      assert.equal(guard.isReadOnlyPath(join(rw, 'x.txt')), false);
    } finally {
      delete process.env['FS_READ_ONLY_DIRS'];
    }
  });

  it('RO-STATE-003: matches a symlinked read-only dir through its realpath alias', async (t) => {
    const real = join(base, 'ro-real');
    await mkdir(real);
    const alias = join(base, 'ro-alias');
    if (!(await trySymlink(real, alias, () => undefined))) return t.skip('symlink not permitted');
    const guard = new PathGuard({ cliAllowedDirs: [rw], readOnlyDirs: [alias] });
    await guard.recomputeAllowedDirectories();
    assert.equal(guard.isReadOnlyPath(join(real, 'file.txt')), true);
    assert.equal(guard.isReadOnlyPath(join(alias, 'file.txt')), true);
  });

  it('RO-STATE-004: getReadOnlyDirs returns the normalized CLI+env union, deduped', async () => {
    const other = join(base, 'other-ro');
    await mkdir(other);
    process.env['FS_READ_ONLY_DIRS'] = ro;
    try {
      const guard = new PathGuard({ cliAllowedDirs: [rw], readOnlyDirs: [ro, other] });
      await guard.recomputeAllowedDirectories();
      assert.deepEqual(guard.getReadOnlyDirs(), [normalizePath(ro), normalizePath(other)]);
    } finally {
      delete process.env['FS_READ_ONLY_DIRS'];
    }
  });

  it('RO-STATE-005: warns when a read-only dir matches no allowed root, and keeps it', async () => {
    const stray = join(base, 'stray-ro');
    await mkdir(stray);
    const warns: string[] = [];
    const originalWarn = Logger.warn;
    Logger.warn = (message: string) => {
      warns.push(message);
    };
    try {
      const guard = new PathGuard({ cliAllowedDirs: [rw], readOnlyDirs: [stray] });
      await guard.recomputeAllowedDirectories();
      assert.ok(
        warns.some(
          (m) =>
            m.includes('Read-only root matches no allowed root') &&
            m.includes(normalizePath(stray)),
        ),
        warns.join('\n'),
      );
      assert.equal(guard.isReadOnlyPath(join(stray, 'f.txt')), true);
    } finally {
      Logger.warn = originalWarn;
    }
  });

  it('RO-STATE-006: a read-only subtree inside a writable root', async () => {
    const subtree = join(rw, 'protected');
    await mkdir(subtree, { recursive: true });
    const guard = new PathGuard({ cliAllowedDirs: [rw], readOnlyDirs: [subtree] });
    await guard.recomputeAllowedDirectories();
    assert.equal(guard.isReadOnlyPath(join(subtree, 'file.txt')), true);
    assert.equal(guard.isReadOnlyPath(join(rw, 'other.txt')), false);
  });

  it('RO-PROJ-001: a missing read-only dir is projected through a symlinked ancestor', async (t) => {
    const real = join(base, 'proj-real');
    await mkdir(real);
    const alias = join(base, 'proj-alias');
    if (!(await trySymlink(real, alias, () => undefined))) return t.skip('symlink not permitted');
    // refs does not exist yet; only the alias spelling names where it will be.
    const guard = new PathGuard({ cliAllowedDirs: [rw], readOnlyDirs: [join(alias, 'refs')] });
    await guard.recomputeAllowedDirectories();
    assert.equal(guard.isReadOnlyPath(join(real, 'refs', 'x.txt')), true);
    assert.equal(guard.isReadOnlyPath(join(alias, 'refs', 'x.txt')), true);
  });

  it('RO-MISSING-001: keeps a missing FS_READ_ONLY_DIRS entry protected across recomputes', async () => {
    const missing = join(rw, 'future-protected');
    process.env['FS_READ_ONLY_DIRS'] = missing;
    try {
      const guard = new PathGuard({ cliAllowedDirs: [rw] });
      await guard.recomputeAllowedDirectories();
      await assert.rejects(
        guard.validatePathForWrite(join(missing, 'file.txt')),
        (error: unknown) => {
          assertReadOnlyDenied(error, missing);
          return true;
        },
      );

      await mkdir(missing);
      await guard.recomputeAllowedDirectories();
      await assert.rejects(
        guard.validatePathForWrite(join(missing, 'file.txt')),
        (error: unknown) => {
          assertReadOnlyDenied(error, missing);
          return true;
        },
      );
    } finally {
      delete process.env['FS_READ_ONLY_DIRS'];
    }
  });

  it(
    'RO-WHITESPACE-001: rejects edge whitespace before normalizing read-only paths',
    { skip: process.platform === 'win32' },
    async () => {
      const guard = new PathGuard({ cliAllowedDirs: [rw], readOnlyDirs: [`${ro} `] });
      await assert.rejects(guard.recomputeAllowedDirectories(), /leading or trailing whitespace/u);

      process.env['FS_READ_ONLY_DIRS'] = `${ro} `;
      try {
        const envGuard = new PathGuard({ cliAllowedDirs: [rw] });
        await assert.rejects(
          envGuard.recomputeAllowedDirectories(),
          /leading or trailing whitespace/u,
        );
      } finally {
        delete process.env['FS_READ_ONLY_DIRS'];
      }
    },
  );

  it('RO-PARENT-001: refuses deleting a directory that contains a read-only dir', async () => {
    const parent = join(rw, 'parent');
    const subtree = join(parent, 'protected');
    await mkdir(subtree, { recursive: true });
    const guard = await guardFor([subtree]);
    await assert.rejects(guard.validatePathForDelete(parent), (error: unknown) => {
      assertReadOnlyDenied(error, subtree);
      return true;
    });
    // A copy reads its source without removing it, so the parent stays readable.
    await guard.validatePathForDelete(parent, { allowReadOnly: true });
    // A file beside the subtree is unaffected: the check is dir-scoped.
    await guard.validatePathForDelete(join(parent, 'plain.txt'));
  });

  // Both roots allowed, one read-only: the shape issue #162 asks for. Without
  // ro inside the allowed set, out-of-root ACCESS_DENIED would mask the
  // read-only check these tests pin.
  const guardFor = async (readOnlyDirs: string[]): Promise<PathGuard> => {
    const guard = new PathGuard({ cliAllowedDirs: [rw, ro], readOnlyDirs });
    await guard.recomputeAllowedDirectories();
    return guard;
  };

  const assertReadOnlyDenied = (error: unknown, dir: string): void => {
    assert.ok(isFsError(error), String(error));
    assert.equal(error.code, ErrorCode.ACCESS_DENIED);
    assert.match(error.message, /^Read-only root.*Read-only folders setting/u);
    assert.ok(error.message.includes(normalizePath(dir)), error.message);
  };

  it('RO-WRITE-001: refuses a write under a read-only dir', async () => {
    const guard = await guardFor([ro]);
    await assert.rejects(guard.validatePathForWrite(join(ro, 'new.txt')), (error: unknown) => {
      assertReadOnlyDenied(error, ro);
      return true;
    });
  });

  it('RO-WRITE-002: a write under the writable root is unaffected', async () => {
    const guard = await guardFor([ro]);
    await guard.validatePathForWrite(join(rw, 'new.txt'));
  });

  it('RO-HARDLINK-001: refuses in-place writes through a hard-link alias', async (t) => {
    const protectedFile = join(ro, 'hardlink-target.txt');
    const alias = join(rw, 'hardlink-alias.txt');
    await writeFile(protectedFile, 'original');
    try {
      await link(protectedFile, alias);
    } catch {
      return t.skip('hard links are not supported');
    }

    const guard = await guardFor([ro]);
    const fs = new GuardedFileSystem(guard);
    for (const mutate of [
      () => fs.writeFile(alias, 'overwrite'),
      () => fs.appendFile(alias, 'append'),
    ]) {
      await assert.rejects(mutate(), (error: unknown) => {
        assert.ok(isFsError(error), String(error));
        assert.equal(error.code, ErrorCode.ACCESS_DENIED);
        assert.match(error.message, /multiply-linked/u);
        return true;
      });
    }
    assert.equal(await readFile(protectedFile, 'utf8'), 'original');
  });

  it('RO-MOVE-DESC-001: refuses directory moves that populate a missing protected subtree', async () => {
    const source = join(rw, 'move-source');
    const destination = join(rw, 'move-destination');
    await mkdir(join(source, 'protected'), { recursive: true });
    await writeFile(join(source, 'protected', 'f.txt'), 'keep');

    const fs = new GuardedFileSystem(await guardFor([join(destination, 'protected')]));
    await assert.rejects(fs.rename(source, destination), (error: unknown) => {
      assertReadOnlyDenied(error, join(destination, 'protected'));
      return true;
    });
    assert.equal(await readFile(join(source, 'protected', 'f.txt'), 'utf8'), 'keep');
  });

  it('RO-MOVE-DESC-002: rechecks mapped descendants in the cross-device fallback', async () => {
    const source = join(rw, 'exdev-source');
    const destination = join(rw, 'exdev-destination');
    const protectedDir = join(destination, 'protected');
    await mkdir(join(source, 'protected'), { recursive: true });
    await writeFile(join(source, 'protected', 'f.txt'), 'keep');

    const guard = await guardFor([]);
    const fs = new GuardedFileSystem(guard, undefined, {
      rename: async () => {
        process.env['FS_READ_ONLY_DIRS'] = protectedDir;
        await guard.recomputeAllowedDirectories();
        throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      },
    });
    try {
      await assert.rejects(fs.rename(source, destination), (error: unknown) => {
        assertReadOnlyDenied(error, protectedDir);
        return true;
      });
      assert.equal(await readFile(join(source, 'protected', 'f.txt'), 'utf8'), 'keep');
    } finally {
      delete process.env['FS_READ_ONLY_DIRS'];
    }
  });

  it('RO-REGIME-001: every GuardedFileSystem op honours its read-only rule', async (t) => {
    const dir = join(ro, 'regime');
    const file = join(dir, 'f.txt');
    await mkdir(join(dir, 'empty'), { recursive: true });
    await writeFile(file, 'keep');
    await writeFile(join(rw, 'src.txt'), 'src');
    const fs = new GuardedFileSystem(await guardFor([ro]));

    // Reads and metadata probes are allowed inside the read-only dir.
    assert.equal((await fs.lstat(file)).stats.isFile(), true);
    assert.equal((await fs.lstatExact(file)).stats.isFile(), true);
    assert.equal((await fs.stat(file)).stats.isFile(), true);
    assert.equal((await fs.statDetailed(file)).stats.isFile(), true);
    assert.equal(await fs.countEntries(dir), 2);
    assert.equal((await fs.read(file, { binary: 'raw' })).content.toString(), 'keep');
    const link = join(dir, 'link.txt');
    if (await trySymlink('f.txt', link, () => undefined, 'file')) {
      assert.equal((await fs.readlink(link)).linkString, 'f.txt');
    } else {
      t.diagnostic('symlink not permitted; readlink unchecked');
    }

    // Every mutation is refused, including a move OUT of it.
    for (const mutate of [
      () => fs.writeFile(file, 'x'),
      () => fs.appendFile(file, 'x'),
      () => fs.mkdir(join(dir, 'new')),
      () => fs.symlink('f.txt', join(dir, 'new-link'), 'file'),
      () => fs.rm(file),
      () => fs.rmdir(join(dir, 'empty')),
      () => fs.rename(file, join(rw, 'moved.txt')),
      () => copyVia(fs, join(rw, 'src.txt'), join(dir, 'copied.txt')),
      () => fs.lockForWrite(file, () => Promise.resolve()),
    ]) {
      await assert.rejects(mutate(), (error: unknown) => {
        assertReadOnlyDenied(error, ro);
        return true;
      });
    }
    assert.equal(await readFile(file, 'utf8'), 'keep');
  });

  it('RO-DEL-001: refuses a delete under a read-only dir', async () => {
    await writeFile(join(ro, 'existing.txt'), 'x');
    const guard = await guardFor([ro]);
    await assert.rejects(
      guard.validatePathForDelete(join(ro, 'existing.txt')),
      (error: unknown) => {
        assertReadOnlyDenied(error, ro);
        return true;
      },
    );
  });

  it('RO-DEL-002: refuses a delete of a missing file under a read-only dir', async () => {
    const guard = await guardFor([ro]);
    await assert.rejects(guard.validatePathForDelete(join(ro, 'missing.txt')), (error: unknown) => {
      assertReadOnlyDenied(error, ro);
      return true;
    });
  });

  it('RO-LINK-001: a symlink from the writable root into a read-only dir', async (t) => {
    await writeFile(join(ro, 'linked.txt'), 'x');
    const link = join(rw, 'to-ro.txt');
    if (!(await trySymlink(join(ro, 'linked.txt'), link, () => undefined, 'file'))) {
      return t.skip('symlink not permitted');
    }
    const guard = await guardFor([ro]);
    // Reads follow the link into the read-only dir.
    await guard.validateExistingPath(link);
    // Writing through the link resolves to the read-only target.
    await assert.rejects(guard.validatePathForWrite(link), (error: unknown) => {
      assertReadOnlyDenied(error, ro);
      return true;
    });
    // Deleting the link itself touches only the writable root.
    await guard.validatePathForDelete(link);
  });

  it('RO-NEST-001: a read-only subtree denies writes under it, not beside it', async () => {
    const subtree = join(rw, 'protected');
    await mkdir(subtree, { recursive: true });
    const guard = await guardFor([subtree]);
    await assert.rejects(
      guard.validatePathForWrite(join(subtree, 'file.txt')),
      (error: unknown) => {
        assertReadOnlyDenied(error, subtree);
        return true;
      },
    );
    await guard.validatePathForWrite(join(rw, 'sibling.txt'));
  });

  it('RO-GRANT-001: grants stay writable unless inside a read-only dir', async () => {
    const granted = join(base, 'granted');
    await mkdir(granted);
    const guard = await guardFor([ro]);
    assert.equal(await guard.applyGrant(granted, 'access'), true);
    await guard.validatePathForWrite(join(granted, 'f.txt'));
    assert.equal(await guard.applyGrant(join(ro, 'inside'), 'access'), true);
    await assert.rejects(
      guard.validatePathForWrite(join(ro, 'inside', 'f.txt')),
      (error: unknown) => {
        assertReadOnlyDenied(error, ro);
        return true;
      },
    );
  });

  // No undo test on purpose: read-only dirs are fixed per process, so a
  // journal entry can only target a writable root unless it sat under a
  // read-only dir all along — which these checks then refuse during restore,
  // because undo revalidates through the same guard methods
  // (src/core/undo.ts restoreEntry -> validatePathForWrite / entryLockKey).
});

// End to end over the tool surface: both roots allowed, ro also read-only —
// the shape issue #162 asks for.
describe('read-only roots over the MCP surface', { concurrency: false }, () => {
  let base: string;
  let rw: string;
  let ro: string;
  let pair: TestClientContext;

  const structuredOf = (result: {
    structuredContent?: unknown;
    _meta?: unknown;
  }): Record<string, unknown> => {
    const value = result.structuredContent ?? result._meta;
    assert.ok(value, 'tool must publish structured metadata');
    return value as Record<string, unknown>;
  };

  before(async () => {
    base = await createTestRoot();
    rw = join(base, 'rw');
    ro = join(base, 'ro');
    await mkdir(rw);
    await mkdir(ro);
    await writeFile(join(ro, 'readme.txt'), 'RONEEDLE\n');
    pair = await createTestClientPair([rw, ro], { readOnlyDirs: [ro] });
  });

  after(async () => {
    await pair.close();
    await cleanupTestRoot(base);
  });

  it('RO-INT-001: create is refused under the read-only root, not the writable one', async () => {
    const denied = await pair.client.callTool({
      name: 'create',
      arguments: { files: [{ path: join(ro, 'new.txt'), content: 'nope' }] },
    });
    assert.strictEqual(denied.isError, true);
    assert.match(firstTextBlock(denied).text ?? '', /Read-only root/u);

    const allowed = await pair.client.callTool({
      name: 'create',
      arguments: { files: [{ path: join(rw, 'writable.txt'), content: 'yes' }] },
    });
    assert.notStrictEqual(allowed.isError, true, firstTextBlock(allowed).text ?? '');
  });

  it('RO-INT-002: reads under the read-only root still work', async () => {
    for (const [name, args] of [
      ['read', { path: join(ro, 'readme.txt') }],
      ['list', { path: ro }],
      ['search_text', { searchPattern: 'RONEEDLE', path: ro }],
      ['stat', { path: join(ro, 'readme.txt') }],
    ] as const) {
      const result = await pair.client.callTool({ name, arguments: { ...args } });
      assert.notStrictEqual(result.isError, true, `${name}: ${firstTextBlock(result).text ?? ''}`);
    }
  });

  it('RO-INT-003: move is refused in every direction involving the read-only root', async () => {
    await writeFile(join(rw, 'src.txt'), 'S');
    await writeFile(join(ro, 'victim.txt'), 'V');
    for (const [label, source, destination] of [
      ['rw to ro', join(rw, 'src.txt'), join(ro, 'moved.txt')],
      ['ro to rw', join(ro, 'victim.txt'), join(rw, 'moved.txt')],
      ['ro to ro', join(ro, 'victim.txt'), join(ro, 'moved-victim.txt')],
    ] as const) {
      const result = await pair.client.callTool({
        name: 'move',
        arguments: { moves: [{ source, destination }] },
      });
      assert.strictEqual(result.isError, true, label);
      // The refusal rides per-item in the metadata's failures; the text line
      // is a summary.
      const failures = structuredOf(result)['failures'] as {
        error?: { code?: string; message?: string };
      }[];
      const error = failures[0]?.error;
      assert.strictEqual(error?.code, 'ACCESS_DENIED', label);
      assert.match(error?.message ?? '', /Read-only root/u, label);
    }
    const fine = await pair.client.callTool({
      name: 'move',
      arguments: {
        moves: [{ source: join(rw, 'src.txt'), destination: join(rw, 'src-moved.txt') }],
      },
    });
    assert.notStrictEqual(fine.isError, true, firstTextBlock(fine).text ?? '');
  });

  it('RO-INT-004: list_roots reports the read-only directories', async () => {
    const result = await pair.client.callTool({ name: 'list_roots', arguments: {} });
    const value = structuredOf(result) as { roots: string[]; readOnlyDirs: string[] };
    assert.deepEqual(value.roots, [normalizePath(rw), normalizePath(ro)]);
    assert.deepEqual(value.readOnlyDirs, [normalizePath(ro)]);
  });

  it('RO-INT-005: undo of a writable-root create still restores', async () => {
    const created = await pair.client.callTool({
      name: 'create',
      arguments: { files: [{ path: join(rw, 'undo-me.txt'), content: 'UNDO' }] },
    });
    assert.notStrictEqual(created.isError, true, firstTextBlock(created).text ?? '');
    const id = structuredOf(created)['undo'];
    assert.equal(typeof id, 'string');

    const undone = await pair.client.callTool({ name: 'undo', arguments: { id } });
    assert.notStrictEqual(undone.isError, true, firstTextBlock(undone).text ?? '');

    const restored = await pair.client.callTool({
      name: 'read',
      arguments: { path: join(rw, 'undo-me.txt') },
    });
    assert.strictEqual(restored.isError, true, 'the restored file must be gone');
  });

  it('RO-COPY-001: copy out of the read-only root is allowed; copy into it is refused', async () => {
    // A copy writes nothing under the source root, so copying a template out
    // of the read-only tree into the workspace is the #162 use case itself.
    const out = await pair.client.callTool({
      name: 'move',
      arguments: {
        moves: [{ source: join(ro, 'readme.txt'), destination: join(rw, 'copied.txt') }],
        copy: true,
      },
    });
    assert.notStrictEqual(out.isError, true, firstTextBlock(out).text ?? '');

    const into = await pair.client.callTool({
      name: 'move',
      arguments: {
        moves: [{ source: join(rw, 'writable.txt'), destination: join(ro, 'staged.txt') }],
        copy: true,
      },
    });
    assert.strictEqual(into.isError, true);
    const failures = structuredOf(into)['failures'] as {
      error?: { code?: string; message?: string };
    }[];
    assert.strictEqual(failures[0]?.error?.code, 'ACCESS_DENIED');
    assert.match(failures[0]?.error?.message ?? '', /Read-only root/u);
  });

  it('RO-INT-006: recursive copies validate the actual destination of every entry', async () => {
    const container = join(rw, 'dest');
    const nested = join(container, 'protected');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'f.txt'), 'PROTECTED');
    const source = join(ro, 'source-tree');
    await mkdir(source, { recursive: true });
    await mkdir(join(source, 'protected'), { recursive: true });
    await writeFile(join(source, 'protected', 'f.txt'), 'OVERWRITE');
    const localPair = await createTestClientPair([rw, ro], { readOnlyDirs: [nested] });
    try {
      const denied = await localPair.client.callTool({
        name: 'move',
        arguments: {
          moves: [{ source, destination: container }],
          copy: true,
          overwrite: true,
        },
      });
      assert.strictEqual(denied.isError, true);
      const meta = (denied.structuredContent ?? denied._meta) as Record<string, unknown>;
      const failures = meta['failures'] as {
        error?: { code?: string; message?: string };
      }[];
      assert.ok(failures, JSON.stringify(denied).slice(0, 600));
      assert.strictEqual(failures[0]?.error?.code, 'ACCESS_DENIED');
      assert.match(failures[0]?.error?.message ?? '', /Read-only root/u);
      assert.equal(await readFile(join(nested, 'f.txt'), 'utf8'), 'PROTECTED');

      // A source named differently still copies under the container.
      const other = join(ro, 'other-dir');
      await mkdir(other, { recursive: true });
      const fine = await localPair.client.callTool({
        name: 'move',
        arguments: {
          moves: [{ source: other, destination: join(container, 'other-dir') }],
          copy: true,
        },
      });
      assert.notStrictEqual(fine.isError, true, firstTextBlock(fine).text ?? '');
    } finally {
      await localPair.close();
    }
  });

  it('RO-STAT-001: stat on a symlink inside the read-only root reports its target', async (t) => {
    const target = join(rw, 'link-target.txt');
    await writeFile(target, 'T');
    const link = join(ro, 'to-rw.txt');
    if (!(await trySymlink(target, link, () => undefined, 'file'))) {
      return t.skip('symlink not permitted');
    }
    const result = await pair.client.callTool({ name: 'stat', arguments: { path: link } });
    assert.notStrictEqual(
      result.isError,
      true,
      `${String(existsSync(link))}: ${JSON.stringify(result).slice(0, 600)}`,
    );
    const value = structuredOf(result) as {
      results?: { value?: { type?: string; symlinkTarget?: string } }[];
    };
    const entry = value.results?.[0]?.value;
    assert.equal(entry?.type, 'symlink', JSON.stringify(value));
    assert.equal(typeof entry?.symlinkTarget, 'string', JSON.stringify(value));
  });
});

// A dry run promises what the live call would do, so it answers the same
// read-only refusal; a preview of a write the root refuses would mislead.
describe('dry runs under a read-only root', { concurrency: false }, () => {
  let base: string;
  let rw: string;
  let ro: string;
  let pair: TestClientContext;

  const edits = [{ oldText: 'retries = 1', newText: 'retries = 3' }];

  before(async () => {
    base = await createTestRoot();
    rw = join(base, 'rw');
    ro = join(base, 'ro');
    await mkdir(rw);
    await mkdir(ro);
    await writeFile(join(rw, 'x.txt'), 'retries = 1\n');
    await writeFile(join(ro, 'x.txt'), 'retries = 1\n');
    pair = await createTestClientPair([base], { readOnlyDirs: [ro] });
  });

  after(async () => {
    await pair.close();
    await cleanupTestRoot(base);
  });

  it('RO-DRY-001: edit is refused', async () => {
    const result = await pair.client.callTool({
      name: 'edit',
      arguments: { path: join(ro, 'x.txt'), edits, dryRun: true },
    });
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /Read-only root:/u);
  });

  it('RO-DRY-002: patch is refused', async () => {
    const result = await pair.client.callTool({
      name: 'patch',
      arguments: {
        path: join(ro, 'x.txt'),
        diff: '--- x.txt\n+++ x.txt\n@@ -1,1 +1,1 @@\n-retries = 1\n+retries = 3\n',
        dryRun: true,
      },
    });
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /Read-only root:/u);
  });

  it('RO-DRY-004: edit outside the read-only root still previews, writing nothing', async () => {
    const result = await pair.client.callTool({
      name: 'edit',
      arguments: { path: join(rw, 'x.txt'), edits, dryRun: true },
    });
    assert.notStrictEqual(result.isError, true, firstTextBlock(result).text ?? '');
    assert.match(firstTextBlock(result).text ?? '', /\+retries = 3/u);
    assert.strictEqual(await readFile(join(rw, 'x.txt'), 'utf8'), 'retries = 1\n');
  });

  it('RO-DRY-005: edit through a symlink into the read-only root is refused', async (t) => {
    const alias = join(rw, 'alias.txt');
    if (!(await trySymlink(join(ro, 'x.txt'), alias, () => undefined))) {
      return t.skip('symlink not permitted');
    }
    const result = await pair.client.callTool({
      name: 'edit',
      arguments: { path: alias, edits, dryRun: true },
    });
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /Read-only root:/u);
    await rm(alias);
  });

  it('RO-DRY-006: edit on a hard link into the read-only root is refused', async () => {
    const linked = join(rw, 'linked.txt');
    await link(join(ro, 'x.txt'), linked);
    const result = await pair.client.callTool({
      name: 'edit',
      arguments: { path: linked, edits, dryRun: true },
    });
    await rm(linked);
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /multiply-linked/u);
  });

  // Last: its live half rewrites rw/x.txt.
  it('RO-DRY-003: replace_text skips the root as the live call does', async () => {
    const args = { path: base, searchPattern: 'retries = 1', replacement: 'retries = 3' };
    const dry = await pair.client.callTool({
      name: 'replace_text',
      arguments: { ...args, dryRun: true },
    });
    const dryText = firstTextBlock(dry).text ?? '';
    assert.doesNotMatch(dryText, /ro[\\/]x\.txt/u);
    assert.match(dryText, /rw[\\/]x\.txt/u);
    assert.match(dryText, /1 inaccessible entry/u);

    const live = await pair.client.callTool({ name: 'replace_text', arguments: args });
    const countOf = (r: typeof dry) => (r._meta as { totalMatches: number }).totalMatches;
    assert.strictEqual(countOf(dry), countOf(live));
    assert.strictEqual(await readFile(join(ro, 'x.txt'), 'utf8'), 'retries = 1\n');
  });
});
