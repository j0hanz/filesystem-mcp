import assert from 'node:assert/strict';
import { access, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PathGuard } from '../src/core/path.ts';
import {
  cleanupTestRoot,
  createElicitationClientPair,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  trySymlink,
  withEnv,
  writeTestFile,
} from './helpers.ts';

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

describe('Data-loss guards', () => {
  let root: string;

  before(async () => {
    root = await createTestRoot();
  });

  after(async () => {
    if (root) await cleanupTestRoot(root);
  });

  it('GUARD-001: a destination that appears during confirmation is asked about again', async () => {
    const srcA = await writeTestFile(root, 'g001/srcA.txt', 'A');
    const destA = await writeTestFile(root, 'g001/destA.txt', 'oldA');
    const srcB = await writeTestFile(root, 'g001/srcB.txt', 'B');
    const destB = join(root, 'g001', 'destB.txt');

    let calls = 0;
    const eh = await createElicitationClientPair([root], async () => {
      calls += 1;
      // The second destination appears while the human is looking at the first prompt.
      if (calls === 1) await writeFile(destB, 'gap');
      return { action: 'accept' as const, content: { choice: 'overwrite' } };
    });
    try {
      const result = await eh.client.callTool({
        name: 'move',
        arguments: {
          moves: [
            { source: srcA, destination: destA },
            { source: srcB, destination: destB },
          ],
        },
      });
      // One prompt per pending entry: destA, then destA and destB re-prompted together.
      assert.strictEqual(calls, 3, 'asked once, then asked again about both');
      assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
      assert.strictEqual(await readFile(destA, 'utf-8'), 'A');
      assert.strictEqual(await readFile(destB, 'utf-8'), 'B');
    } finally {
      await eh.close();
    }
  });

  it('GUARD-002: two copy entries with one destination; only the first lands', async () => {
    const s1 = await writeTestFile(root, 'g002/s1.txt', 'one');
    const s2 = await writeTestFile(root, 'g002/s2.txt', 'two');
    const d = join(root, 'g002', 'd.txt');

    const h = await createTestClientPair([root]);
    try {
      const result = await h.client.callTool({
        name: 'move',
        arguments: {
          copy: true,
          moves: [
            { source: s1, destination: d },
            { source: s2, destination: d },
          ],
        },
      });
      assert.strictEqual(await readFile(d, 'utf-8'), 'one');
      assert.strictEqual(await exists(s1), true, 's1 still exists');
      assert.strictEqual(await exists(s2), true, 's2 still exists');
      assert.match(JSON.stringify(result._meta), /already targets destination/);
    } finally {
      await h.close();
    }
  });

  it('GUARD-002b: two move entries with one destination; only the first moves', async () => {
    const s1 = await writeTestFile(root, 'g002b/s1.txt', 'one');
    const s2 = await writeTestFile(root, 'g002b/s2.txt', 'two');
    const d = join(root, 'g002b', 'd.txt');

    const h = await createTestClientPair([root]);
    try {
      const result = await h.client.callTool({
        name: 'move',
        arguments: {
          moves: [
            { source: s1, destination: d },
            { source: s2, destination: d },
          ],
        },
      });
      assert.strictEqual(await readFile(d, 'utf-8'), 'one');
      assert.strictEqual(await exists(s1), false, 's1 moved away');
      assert.strictEqual(await readFile(s2, 'utf-8'), 'two', 's2 untouched');
      assert.match(JSON.stringify(result._meta), /already targets destination/);
    } finally {
      await h.close();
    }
  });

  it('GUARD-004: a delete whose target vanishes during confirmation reports NOT_FOUND without errno text', async () => {
    const dir = join(root, 'g004-dir');
    await writeTestFile(root, 'g004-dir/a.txt', 'x');

    let calls = 0;
    const eh = await createElicitationClientPair([root], async () => {
      calls += 1;
      await rm(dir, { recursive: true });
      return { action: 'accept' as const, content: { choice: 'delete' } };
    });
    try {
      const result = await eh.client.callTool({
        name: 'delete',
        arguments: { paths: [dir], recursive: true },
      });
      assert.strictEqual(calls, 1, 'one confirmation round');
      const meta = result._meta as {
        results?: { error?: { code?: string } }[];
        summary?: { failed?: number };
      };
      assert.strictEqual(meta.summary?.failed, 1);
      assert.strictEqual(meta.results?.[0]?.error?.code, 'NOT_FOUND');
      const wire = JSON.stringify(result);
      assert.match(wire, /Path not found/);
      assert.doesNotMatch(wire, /ENOENT|lstat/);
    } finally {
      await eh.close();
    }
  });

  it('GUARD-004b: the same vanished target with ignoreIfNotExists reports no failure', async () => {
    const dir = join(root, 'g004b-dir');
    await writeTestFile(root, 'g004b-dir/a.txt', 'x');

    let calls = 0;
    const eh = await createElicitationClientPair([root], async () => {
      calls += 1;
      await rm(dir, { recursive: true });
      return { action: 'accept' as const, content: { choice: 'delete' } };
    });
    try {
      const result = await eh.client.callTool({
        name: 'delete',
        arguments: { paths: [dir], recursive: true, ignoreIfNotExists: true },
      });
      assert.strictEqual(calls, 1, 'one confirmation round');
      const meta = result._meta as { summary?: { failed?: number } };
      assert.strictEqual(meta.summary?.failed, 0);
    } finally {
      await eh.close();
    }
  });

  it('GUARD-005: a grant whose recompute throws leaves the allowed set unchanged', async () => {
    await withEnv({ FS_ROOT_BOUNDARY: undefined }, async () => {
      const guard = new PathGuard({ cliAllowedDirs: [root] });
      await guard.recomputeAllowedDirectories();
      const before = guard.getAllowedDirectories();
      const outside = await createTestRoot();
      try {
        const original = guard.recomputeAllowedDirectories.bind(guard);
        guard.recomputeAllowedDirectories = () => Promise.reject(new Error('recompute failed'));
        await assert.rejects(guard.applyGrant(outside), /recompute failed/);
        guard.recomputeAllowedDirectories = original;
        await guard.recomputeAllowedDirectories();
        assert.deepStrictEqual(
          guard.getAllowedDirectories(),
          before,
          'a rolled-back grant must not reappear',
        );
      } finally {
        await cleanupTestRoot(outside);
      }
    });
  });

  it('GUARD-006: a broken symlink to .env or a two-hop symlink escape is blocked by PathGuard', async (t) => {
    const outside = await createTestRoot();
    try {
      const envLink = join(root, 'g006-env-link');
      if (
        !(await trySymlink(
          join(root, '.env'),
          envLink,
          () => t.skip('symlinks not permitted'),
          'file',
        ))
      ) {
        return;
      }
      const guard = new PathGuard({ cliAllowedDirs: [root] });
      await guard.recomputeAllowedDirectories();
      await assert.rejects(guard.validatePathForWrite(envLink), /Sensitive file/);

      const escapeLink = join(root, 'g006-escape');
      const hopLink = join(root, 'g006-hop');
      await trySymlink(outside, escapeLink, () => {});
      await trySymlink(join(escapeLink, 'missing.txt'), hopLink, () => {}, 'file');
      await assert.rejects(guard.validateExistingPath(hopLink), /Outside allowed directories/);
    } finally {
      await cleanupTestRoot(outside);
    }
  });

  it('GUARD-007: precheckAccess skips sensitive files and two move entries with overlapping sources fail closed', async () => {
    const outside = await createTestRoot();
    const h = await createTestClientPair([root]);
    try {
      const guard = new PathGuard({ cliAllowedDirs: [root] });
      await guard.recomputeAllowedDirectories();
      assert.deepStrictEqual(await guard.precheckAccess([join(outside, '.env')]), []);

      const src = await writeTestFile(root, 'g007/src.txt', 'hello');
      const d1 = join(root, 'g007', 'd1.txt');
      const d2 = join(root, 'g007', 'd2.txt');
      const moved = await h.client.callTool({
        name: 'move',
        arguments: {
          moves: [
            { source: src, destination: d1 },
            { source: src, destination: d2 },
          ],
        },
      });
      assert.strictEqual(moved.isError, true);
      assert.strictEqual(await exists(src), true, 'overlapping source move leaves source intact');

      const dupDel = await writeTestFile(root, 'g007/del.txt', 'bye');
      const deleted = await h.client.callTool({
        name: 'delete',
        arguments: { paths: [dupDel, join(root, 'g007', '.', 'del.txt')] },
      });
      assert.notStrictEqual(deleted.isError, true);
      assert.strictEqual((deleted._meta as { summary?: { failed?: number } }).summary?.failed, 0);
    } finally {
      await h.close();
      await cleanupTestRoot(outside);
    }
  });

  it('GUARD-008: two moves of separate links to one target both run', async (t) => {
    const h = await createTestClientPair([root]);
    try {
      const target = await writeTestFile(root, 'g008/target.txt', 't');
      const l1 = join(root, 'g008', 'l1');
      const l2 = join(root, 'g008', 'l2');
      if (!(await trySymlink(target, l1, () => t.skip('no symlinks'), 'file'))) return;
      await trySymlink(target, l2, () => {}, 'file');
      const moved = await h.client.callTool({
        name: 'move',
        arguments: {
          moves: [
            { source: l1, destination: join(root, 'g008', 'm1') },
            { source: l2, destination: join(root, 'g008', 'm2') },
          ],
        },
      });
      assert.notStrictEqual(moved.isError, true, firstTextBlock(moved).text);
      assert.strictEqual(await exists(l1), false);
      assert.strictEqual(await exists(l2), false);
      assert.strictEqual(await readFile(join(root, 'g008', 'm1'), 'utf-8'), 't');
    } finally {
      await h.close();
    }
  });

  it('GUARD-009: replace_text reports a walked file it could read but not write', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      t.skip('needs POSIX directory permissions as non-root');
      return;
    }
    const h = await createTestClientPair([root]);
    const dir = join(root, 'g009');
    const file = await writeTestFile(root, 'g009/a.txt', 'needle');
    await chmod(dir, 0o555);
    try {
      const res = await h.client.callTool({
        name: 'replace_text',
        arguments: { path: dir, searchPattern: 'needle', replacement: 'pin' },
      });
      const summary = ((res.structuredContent ?? res._meta) as { summary?: { failed?: number } })
        .summary;
      assert.strictEqual(summary?.failed, 1, firstTextBlock(res).text);
      assert.strictEqual(await readFile(file, 'utf-8'), 'needle');
    } finally {
      await chmod(dir, 0o755);
      await h.close();
    }
  });

  it('GUARD-010: a delete batch naming a directory and its child refuses both', async () => {
    const h = await createTestClientPair([root]);
    try {
      const child = await writeTestFile(root, 'g010/sub/child.txt', 'c');
      const parent = join(root, 'g010');
      const res = await h.client.callTool({
        name: 'delete',
        arguments: { paths: [parent, child], recursive: true },
      });
      assert.strictEqual(res.isError, true, firstTextBlock(res).text);
      assert.match(JSON.stringify(res.structuredContent ?? res._meta), /inside, another path/);
      assert.strictEqual(await exists(child), true);
    } finally {
      await h.close();
    }
  });
});
