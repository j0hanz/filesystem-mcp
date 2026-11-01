import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { Logger } from '../src/core/observability.ts';
import { PathGuard } from '../src/core/path.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  trySymlink,
  type TestClientContext,
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
    assert.match(error.message, /Read-only root/u);
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

  it('RO-DEL-001: refuses a delete under a read-only dir', async () => {
    await writeFile(join(ro, 'existing.txt'), 'x');
    const guard = await guardFor([ro]);
    await assert.rejects(guard.validatePathForDelete(join(ro, 'existing.txt')), (error: unknown) => {
      assertReadOnlyDenied(error, ro);
      return true;
    });
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

  const structuredOf = (
    result: { structuredContent?: unknown; _meta?: unknown },
  ): Record<string, unknown> => {
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
});