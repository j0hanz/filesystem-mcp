import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type * as z from 'zod/v4';

import { GuardedFileSystem } from '../src/core/fs.ts';
import type { PathGuard } from '../src/core/path.ts';
import { STAT } from '../src/tools/index.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  makeGuard,
  type TestClientContext,
  trySymlink,
  withEnv,
  writeTestFile,
} from './helpers.ts';
import { runToolBodyResult, type ToolBodyOptions } from './tool-harness.ts';

type StatArgs = z.input<typeof STAT.def.input>;
type StatRow = Awaited<ReturnType<typeof stat>>['structured']['results'][number];

const valueOf = (row: StatRow | undefined) => (row && 'value' in row ? row.value : undefined);
const errorOf = (row: StatRow | undefined) => (row && 'error' in row ? row.error : undefined);
/** Zod issues of a schema refusal the harness's parse step throws. */
const issuesOf = (err: unknown): { message?: string }[] =>
  (err as { issues?: { message?: string }[] }).issues ?? [];

async function stat(args: StatArgs, options: ToolBodyOptions) {
  return runToolBodyResult(STAT, args, options);
}

async function statOne(path: string, options: ToolBodyOptions) {
  const { structured } = await stat({ path }, options);
  const value = valueOf(structured.results[0]);
  assert.ok(value, 'stat must return a value');
  return value;
}

// Payload assembly, driven through the tool body with no MCP pair.
describe('stat body', () => {
  let root: string;
  let outside: string;
  let guard: PathGuard;

  before(async () => {
    root = await createTestRoot();
    outside = await createTestRoot();
    guard = await makeGuard([root]);
  });

  after(async () => {
    await cleanupTestRoot(root);
    await cleanupTestRoot(outside);
  });

  it('returns file metadata for a single path and a batch, with no authored text', async () => {
    const file = await writeTestFile(root, 'statme.txt', 'hello');
    for (const args of [{ path: file }, { paths: [file] }]) {
      const result = await stat(args, { guard });
      assert.strictEqual(result.text, undefined, 'stat is a data tool: no authored text');
      assert.strictEqual(result.isError, false);
      const value = valueOf(result.structured.results[0]);
      assert.ok(value, 'stat must return a value');
      assert.strictEqual(value.type, 'file');
      assert.strictEqual(value.size, 5);
      assert.strictEqual(value.tokenEstimate, 2);
      assert.strictEqual(value.mimeType, 'text/plain');
      assert.strictEqual(value.isHidden, false);
      assert.ok(!('entryCount' in value), 'a file must not report an entryCount');
    }
  });

  it('refuses path together with paths', async () => {
    const file = await writeTestFile(root, 'stat-both.txt', 'x');
    await assert.rejects(
      () => stat({ path: file, paths: [file] }, { guard }),
      (err) =>
        issuesOf(err).some((issue) =>
          (issue.message ?? '').includes("Cannot use both 'path' and 'paths'"),
        ),
    );
  });

  it('a directory does not read as empty or world-writable (#56)', async () => {
    const dir = join(root, 'stat-dir-56');
    await mkdir(dir);
    await writeFile(join(dir, 'a.txt'), 'hello');
    await writeFile(join(dir, 'b.txt'), 'world');

    const { structured } = await stat({ path: dir }, { guard });
    // Result-row type counts next to a directory entry read as "0 files inside".
    assert.deepStrictEqual(Object.keys(structured).sort(), ['results', 'summary']);
    const value = valueOf(structured.results[0]);
    assert.ok(value, 'stat must return a value');
    assert.strictEqual(value.type, 'directory');
    // libuv reports 0 for every directory on Windows; ext4 says 4096. Neither
    // describes the contents, so no number is better than a misleading one.
    assert.ok(!('size' in value), 'a directory must not report a size');
    assert.ok(!('tokenEstimate' in value), 'a directory must not report a tokenEstimate');

    if (process.platform === 'win32') {
      // libuv synthesizes mode 0666/0444 from FILE_ATTRIBUTE_READONLY alone,
      // so a POSIX triad would claim group/other access it never checked.
      assert.strictEqual(value.permissions, undefined);
      assert.strictEqual(value.readOnly, false);
    } else {
      assert.strictEqual(typeof value.permissions, 'string');
      assert.strictEqual(value.readOnly, undefined);
    }
  });

  it('reports an own symlink and its target', async (t) => {
    const target = await writeTestFile(root, 'stat-link-target.txt', 'target');
    const linkPath = join(root, 'stat-link.txt');
    if (!(await trySymlink(target, linkPath, () => t.skip('symlink not permitted'), 'file')))
      return;

    const value = await statOne(linkPath, { guard });
    assert.strictEqual(value.type, 'symlink');
    assert.strictEqual(value.symlinkTarget, target);
  });

  it('propagates TimeoutError when lstat on a symlink aborts on deadline', async () => {
    const file = await writeTestFile(root, 'stat-timeout-target.txt', 'hello');
    const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const fs = new (class extends GuardedFileSystem {
      override async statDetailed(
        filePath: string,
        options?: { signal?: AbortSignal },
      ): ReturnType<GuardedFileSystem['statDetailed']> {
        const res = await super.statDetailed(filePath, options);
        return { ...res, isSymlink: true };
      }
      override lstat(): Promise<never> {
        return Promise.reject(timeoutErr);
      }
    })(guard);

    const { structured, isError } = await stat({ path: file }, { fs });
    assert.strictEqual(isError, true);
    assert.strictEqual(errorOf(structured.results[0])?.code, 'TIMEOUT');
  });

  it('reports a regular file under a symlinked parent as a file', async (t) => {
    const targetDir = join(root, 'stat-real-parent');
    await mkdir(targetDir);
    await writeFile(join(targetDir, 'child.txt'), 'child');
    const linkDir = join(root, 'stat-linked-parent');
    if (!(await trySymlink(targetDir, linkDir, () => t.skip('symlink not permitted')))) return;

    const value = await statOne(join(linkDir, 'child.txt'), { guard });
    assert.strictEqual(value.type, 'file');
    assert.strictEqual(value.symlinkTarget, undefined);
  });

  it('a batch gives a missing path its own NOT_FOUND entry and keeps the rest', async () => {
    const present = await writeTestFile(root, 'stat_batch_present.txt', 'x');
    const missing = join(root, 'stat_batch_missing.txt');
    const { structured, isError } = await stat({ paths: [present, missing] }, { guard });
    assert.strictEqual(isError, false, 'a partial failure is not a failed call');
    assert.strictEqual(valueOf(structured.results[0])?.type, 'file');
    assert.strictEqual(errorOf(structured.results[1])?.code, 'NOT_FOUND');
    assert.deepStrictEqual(structured.summary, { total: 2, succeeded: 1, failed: 1 });

    const allMissing = await stat({ paths: [missing] }, { guard });
    assert.strictEqual(allMissing.isError, true, 'every path failing fails the call');
  });

  // A folder has no size, so stat counts its direct children instead. Secret
  // files are left out of the count, the same way listings hide them.
  describe('entryCount', () => {
    it('reports entryCount 0 for an empty folder, with no size', async () => {
      const empty = join(root, 'empty');
      await mkdir(empty);
      const value = await statOne(empty, { guard });
      assert.strictEqual(value.type, 'directory');
      assert.strictEqual(value.entryCount, 0);
      assert.ok(!('size' in value), 'a folder must not report a size');
    });

    it('counts hidden entries and folders but not secret files', async () => {
      const full = join(root, 'full');
      await mkdir(join(full, 'sub'), { recursive: true });
      await writeFile(join(full, 'a.txt'), 'hello');
      await writeFile(join(full, '.hidden'), 'hidden');
      await writeFile(join(full, '.env'), 'SECRET=1');
      const value = await statOne(full, { guard });
      assert.strictEqual(value.type, 'directory');
      // a.txt, .hidden and sub count; .env is a blocked secret file and does not.
      assert.strictEqual(value.entryCount, 3);
    });

    it('does not count a symlink to a secret file or outside the roots', async (t) => {
      const linked = join(root, 'linked');
      await mkdir(linked);
      await writeFile(join(linked, 'a.txt'), 'hello');
      await writeFile(join(linked, '.env'), 'SECRET=1');
      const skip = () => t.skip('symlink not permitted');
      if (!(await trySymlink(join(linked, '.env'), join(linked, 'env-link'), skip, 'file'))) return;
      if (!(await trySymlink(outside, join(linked, 'out-link'), skip))) return;

      // Only a.txt is listed; .env, env-link and out-link are hidden, so none count.
      const value = await statOne(linked, { guard });
      assert.strictEqual(value.entryCount, 1);
    });

    it('a failed count degrades to no entryCount and leaves a warning', async () => {
      const dir = join(root, 'count-fails');
      await mkdir(dir);
      const fs = new (class extends GuardedFileSystem {
        override countEntries(): Promise<number> {
          return Promise.reject(new Error('boom'));
        }
      })(guard);

      const { structured, logs } = await stat({ path: dir }, { fs });
      const value = valueOf(structured.results[0]);
      assert.ok(value, 'a failed count must not fail the stat');
      assert.strictEqual(value.type, 'directory');
      assert.ok(!('entryCount' in value), 'a failed count must not report an entryCount');
      assert.ok(
        logs.some((l) => l.level === 'warning' && String(l.data).includes('entry count failed')),
        'the degraded count must leave a trace',
      );
    });
  });
});

// The wire tier: what the executor adds around the body (response shape, the
// deadline) and behavior that needs a whole server (the deny list from env).
describe('stat over the wire', () => {
  let root: string;
  let harness: TestClientContext;

  before(async () => {
    root = await createTestRoot();
    harness = await createTestClientPair([root]);
  });

  after(async () => {
    await harness.close();
    await cleanupTestRoot(root);
  });

  it('ships the batch as structuredContent and its JSON as the text', async () => {
    const file = await writeTestFile(root, 'wire.txt', 'hello');
    const result = await harness.client.callTool({ name: 'stat', arguments: { path: file } });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result._meta, undefined);
    const sc = result.structuredContent as {
      results: { value?: { type?: string; size?: number } }[];
    };
    assert.strictEqual(sc.results[0]?.value?.type, 'file');
    assert.strictEqual(sc.results[0]?.value?.size, 5);
    assert.deepStrictEqual(JSON.parse(firstTextBlock(result).text ?? ''), sc);
  });

  it('reports TIMEOUT when the deadline fires mid-count', async () => {
    const dir = join(root, 'slow');
    await mkdir(dir);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored in the finally below
    const original = GuardedFileSystem.prototype.countEntries;
    try {
      // The deadline fires at 1000 ms; the count wakes at 1500 ms and sees the abort.
      GuardedFileSystem.prototype.countEntries = async function (_dirPath, options) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        options?.signal?.throwIfAborted();
        return 0;
      };
      const result = await withEnv({ FS_TOOL_TIMEOUT_MS: '1000' }, () =>
        harness.client.callTool({ name: 'stat', arguments: { path: dir } }),
      );
      assert.strictEqual(result.isError, true);
      const sc = result.structuredContent as { results: { error?: { code: string } }[] };
      assert.strictEqual(sc.results[0]?.error?.code, 'TIMEOUT');
    } finally {
      GuardedFileSystem.prototype.countEntries = original;
    }
  });

  it('does not count a secret under a directory alias when the deny rule names its real path', async (t) => {
    const real = join(root, 'real', 'sub');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'secret.txt'), 'shh');
    await writeFile(join(real, 'visible.txt'), 'hi');
    const skip = () => t.skip('symlink not permitted');
    if (!(await trySymlink(join(root, 'real'), join(root, 'alias'), skip))) return;
    // A symlink whose own real location is denied: list walks the real
    // directory, so it hides the link even though its target is visible.
    if (!(await trySymlink(join(real, 'visible.txt'), join(real, 'link.txt'), skip))) return;

    // A separate server, so the deny rule applies here and not to the harness above.
    const denied = await withEnv({ FS_DENYLIST: 'real/sub/secret.txt,real/sub/link.txt' }, () =>
      createTestClientPair([root]),
    );
    try {
      const alias = join(root, 'alias', 'sub');
      const list = await denied.client.callTool({ name: 'list', arguments: { path: alias } });
      const listed = firstTextBlock(list).text ?? '';
      assert.match(listed, /visible\.txt/u);
      assert.doesNotMatch(listed, /secret\.txt/u);
      assert.doesNotMatch(listed, /link\.txt/u);

      const viaAlias = await denied.client.callTool({ name: 'stat', arguments: { path: alias } });
      const viaReal = await denied.client.callTool({ name: 'stat', arguments: { path: real } });
      const count = (result: typeof viaAlias) =>
        (result.structuredContent as { results: { value?: { entryCount?: number } }[] }).results[0]
          ?.value?.entryCount;
      // secret.txt and link.txt are hidden under both spellings, so only visible.txt counts.
      assert.strictEqual(count(viaAlias), 1);
      assert.strictEqual(count(viaReal), 1);
    } finally {
      await denied.close();
    }
  });
});
