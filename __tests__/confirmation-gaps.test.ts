import assert from 'node:assert/strict';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { GuardedFileSystem } from '../src/core/fs.ts';
import {
  cleanupTestRoot,
  createElicitationClientPair,
  createTestRoot,
  firstTextBlock,
  trySymlink,
  writeTestFile,
} from './helpers.ts';

type Pair = Awaited<ReturnType<typeof createElicitationClientPair>>;

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function swap(path: string, content: string): Promise<void> {
  await rm(path);
  await writeFile(path, content);
}

/** Runs body with a root and an elicitation client; onPrompt gets the 1-based prompt number. */
async function withPrompts(
  choice: string,
  onPrompt: (root: string, n: number) => Promise<void>,
  body: (ctx: { root: string; pair: Pair; prompts: () => number }) => Promise<void>,
): Promise<void> {
  const root = await createTestRoot();
  let pair: Pair | undefined;
  let n = 0;
  try {
    pair = await createElicitationClientPair([root], async () => {
      n += 1;
      await onPrompt(root, n);
      return { action: 'accept' as const, content: { choice } };
    });
    await body({ root, pair, prompts: () => n });
  } finally {
    await pair?.close();
    await cleanupTestRoot(root);
  }
}

/** Runs `action` once, on the first write lock taken (the approved round), then locks for real. */
function beforeFirstWriteLock(t: TestContext, action: () => Promise<void>): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
  const { lockForWrite } = GuardedFileSystem.prototype;
  let done = false;
  t.mock.method(
    GuardedFileSystem.prototype,
    'lockForWrite',
    async function (this: GuardedFileSystem, ...args: Parameters<typeof lockForWrite>) {
      if (!done) {
        done = true;
        await action();
      }
      return lockForWrite.apply(this, args);
    },
  );
}

/** Runs `action` after the approved round's plan stat of `dest.txt` (its 2nd stat), which still sees the original. */
function afterApprovedPlanStat(t: TestContext, action: () => Promise<void>): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
  const { stat } = GuardedFileSystem.prototype;
  let seen = 0;
  t.mock.method(
    GuardedFileSystem.prototype,
    'stat',
    async function (this: GuardedFileSystem, ...args: Parameters<typeof stat>) {
      const result = await stat.apply(this, args);
      if (args[0].endsWith('dest.txt') && (seen += 1) === 2) await action();
      return result;
    },
  );
}

/** Runs `action` after the `n`th lstat of a path ending in `name`. */
function afterNthLstat(t: TestContext, name: string, n: number, action: () => Promise<void>): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
  const { lstat } = GuardedFileSystem.prototype;
  let seen = 0;
  t.mock.method(
    GuardedFileSystem.prototype,
    'lstat',
    async function (this: GuardedFileSystem, ...args: Parameters<typeof lstat>) {
      const result = await lstat.apply(this, args);
      if (args[0].endsWith(name) && (seen += 1) === n) await action();
      return result;
    },
  );
}

/** The delete result row for the first requested path. */
function deleteError(result: Awaited<ReturnType<Pair['client']['callTool']>>) {
  const meta = result._meta as
    { results?: { error?: { code: string; message: string } }[] } | undefined;
  return meta?.results?.[0]?.error;
}

describe('Confirmation gaps', () => {
  it('move re-prompts for a destination swapped during confirmation', async () => {
    await withPrompts(
      'overwrite',
      async (root, n) => {
        if (n === 1) await swap(join(root, 'dest.txt'), 'SWAPPED');
      },
      async ({ root, pair, prompts }) => {
        const source = await writeTestFile(root, 'src.txt', 'SOURCE');
        const destination = await writeTestFile(root, 'dest.txt', 'ORIGINAL');
        const result = await pair.client.callTool({
          name: 'move',
          arguments: { moves: [{ source, destination }] },
        });
        assert.strictEqual(prompts(), 2);
        assert.notStrictEqual(result.isError, true);
        assert.strictEqual(await readFile(destination, 'utf8'), 'SOURCE');
      },
    );
  });

  it('move swapped twice refuses that destination', async () => {
    await withPrompts(
      'overwrite',
      async (root, n) => {
        if (n === 1) await swap(join(root, 'dest.txt'), 'SWAP1');
        if (n === 2) await swap(join(root, 'dest.txt'), 'SWAP2');
      },
      async ({ root, pair, prompts }) => {
        const source = await writeTestFile(root, 'src.txt', 'SOURCE');
        const destination = await writeTestFile(root, 'dest.txt', 'ORIGINAL');
        const result = await pair.client.callTool({
          name: 'move',
          arguments: { moves: [{ source, destination }] },
        });
        assert.strictEqual(prompts(), 2);
        assert.strictEqual(result.isError, true);
        assert.match(firstTextBlock(result).text ?? '', /replaced again while the prompt was open/);
        assert.strictEqual(await readFile(destination, 'utf8'), 'SWAP2');
        assert.strictEqual(await exists(source), true);
      },
    );
  });

  it('move proceeds when a pending destination vanishes', async () => {
    await withPrompts(
      'overwrite',
      async (root, n) => {
        if (n === 1) await rm(join(root, 'destB.txt'));
      },
      async ({ root, pair, prompts }) => {
        const srcA = await writeTestFile(root, 'srcA.txt', 'A');
        const destA = await writeTestFile(root, 'destA.txt', 'oldA');
        const srcB = await writeTestFile(root, 'srcB.txt', 'B');
        const destB = await writeTestFile(root, 'destB.txt', 'oldB');
        const result = await pair.client.callTool({
          name: 'move',
          arguments: {
            moves: [
              { source: srcA, destination: destA },
              { source: srcB, destination: destB },
            ],
          },
        });
        // One round, one prompt per pending entry: no re-prompt.
        assert.strictEqual(prompts(), 2);
        assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
        assert.strictEqual(await readFile(destA, 'utf8'), 'A');
        assert.strictEqual(await readFile(destB, 'utf8'), 'B');
      },
    );
  });

  it('copy re-prompts for a destination swapped during confirmation', async () => {
    await withPrompts(
      'overwrite',
      async (root, n) => {
        if (n === 1) await swap(join(root, 'dest.txt'), 'SWAPPED');
      },
      async ({ root, pair, prompts }) => {
        const source = await writeTestFile(root, 'src.txt', 'SOURCE');
        const destination = await writeTestFile(root, 'dest.txt', 'ORIGINAL');
        const result = await pair.client.callTool({
          name: 'move',
          arguments: { copy: true, moves: [{ source, destination }] },
        });
        assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
        assert.strictEqual(prompts(), 2);
        assert.strictEqual(await readFile(destination, 'utf8'), 'SOURCE');
      },
    );
  });

  for (const copy of [false, true]) {
    const tool = copy ? 'copy' : 'move';
    it(`${tool} refuses a destination replaced after its overwrite was approved`, async (t) => {
      await withPrompts(
        'overwrite',
        async () => {},
        async ({ root, pair, prompts }) => {
          const source = await writeTestFile(root, 'src.txt', 'SOURCE');
          const destination = await writeTestFile(root, 'dest.txt', 'ORIGINAL');
          afterApprovedPlanStat(t, () => swap(destination, 'SWAPPED'));
          const result = await pair.client.callTool({
            name: 'move',
            arguments: { ...(copy && { copy }), moves: [{ source, destination }] },
          });
          assert.strictEqual(prompts(), 1);
          assert.match(
            firstTextBlock(result).text ?? '',
            /replaced after the overwrite was approved/,
          );
          assert.strictEqual(await readFile(destination, 'utf8'), 'SWAPPED');
          await access(source); // not consumed
        },
      );
    });
  }

  for (const copy of [false, true]) {
    const tool = copy ? 'copy' : 'move';
    it(`${tool} writes a destination that vanished after its overwrite was approved`, async (t) => {
      await withPrompts(
        'overwrite',
        async () => {},
        async ({ root, pair, prompts }) => {
          const source = await writeTestFile(root, 'src.txt', 'SOURCE');
          const destination = await writeTestFile(root, 'dest.txt', 'ORIGINAL');
          afterApprovedPlanStat(t, () => rm(destination));
          const result = await pair.client.callTool({
            name: 'move',
            arguments: { ...(copy && { copy }), moves: [{ source, destination }] },
          });
          assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
          assert.strictEqual(prompts(), 1);
          assert.strictEqual(await readFile(destination, 'utf8'), 'SOURCE');
        },
      );
    });
  }

  it('create re-prompts for a file swapped during confirmation', async () => {
    await withPrompts(
      'overwrite',
      async (root, n) => {
        if (n === 1) await swap(join(root, 'dst.txt'), 'SWAPPED');
      },
      async ({ root, pair, prompts }) => {
        const path = await writeTestFile(root, 'dst.txt', 'ORIGINAL');
        const result = await pair.client.callTool({
          name: 'create',
          arguments: { files: [{ path, content: 'NEW' }] },
        });
        assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
        assert.strictEqual(prompts(), 2);
        assert.strictEqual(await readFile(path, 'utf8'), 'NEW');
      },
    );
  });

  it('create refuses a file replaced after its overwrite was approved', async (t) => {
    await withPrompts(
      'overwrite',
      async () => {},
      async ({ root, pair, prompts }) => {
        const dst = await writeTestFile(root, 'dst.txt', 'ORIGINAL');
        const other = await writeTestFile(root, 'other.txt', 'ORIGINAL');
        beforeFirstWriteLock(t, () => swap(dst, 'SWAPPED'));
        const result = await pair.client.callTool({
          name: 'create',
          arguments: {
            files: [
              { path: dst, content: 'NEW' },
              { path: other, content: 'NEW' },
            ],
          },
        });
        // One round, one prompt per pending entry: no re-prompt.
        assert.strictEqual(prompts(), 2);
        assert.match(
          firstTextBlock(result).text ?? '',
          /replaced after the overwrite was approved/,
        );
        assert.strictEqual(await readFile(dst, 'utf8'), 'SWAPPED');
        assert.strictEqual(await readFile(other, 'utf8'), 'NEW');
      },
    );
  });

  // Entries validate their paths concurrently, so either may take the write lock first.
  for (const delayFirstLock of [false, true]) {
    it(`create cancels the later writer naming one approved file through a symlinked parent (first lock delayed: ${delayFirstLock})`, async (t) => {
      await withPrompts(
        'overwrite',
        async () => {},
        async ({ root, pair }) => {
          const real = await writeTestFile(root, 'real/f.txt', 'ORIGINAL');
          if (
            !(await trySymlink(join(root, 'real'), join(root, 'alias'), () =>
              t.skip('no symlinks'),
            ))
          )
            return;
          // Delaying the first entry's lock makes the second entry the writer that wins.
          if (delayFirstLock) beforeFirstWriteLock(t, () => new Promise((r) => setTimeout(r, 50)));
          const result = await pair.client.callTool({
            name: 'create',
            arguments: {
              files: [
                { path: real, content: 'FIRST' },
                { path: join(root, 'alias', 'f.txt'), content: 'SECOND' },
              ],
            },
          });
          // The winning write replaces the file the other entry was approved against.
          const text = firstTextBlock(result).text ?? '';
          assert.strictEqual(text.match(/replaced after the overwrite was approved/g)?.length, 1);
          const content = await readFile(real, 'utf8');
          assert.ok(['FIRST', 'SECOND'].includes(content), content);
          if (delayFirstLock) assert.strictEqual(content, 'SECOND');
        },
      );
    });
  }

  it('create writes a file that vanished after its overwrite was approved', async (t) => {
    await withPrompts(
      'overwrite',
      async () => {},
      async ({ root, pair, prompts }) => {
        const dst = await writeTestFile(root, 'dst.txt', 'ORIGINAL');
        beforeFirstWriteLock(t, () => rm(dst));
        const result = await pair.client.callTool({
          name: 'create',
          arguments: { files: [{ path: dst, content: 'NEW' }] },
        });
        assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
        assert.strictEqual(prompts(), 1);
        assert.strictEqual(await readFile(dst, 'utf8'), 'NEW');
      },
    );
  });

  it('create proceeds when a pending file vanishes', async () => {
    await withPrompts(
      'overwrite',
      async (root, n) => {
        if (n === 1) await rm(join(root, 'b.txt'));
      },
      async ({ root, pair, prompts }) => {
        const a = await writeTestFile(root, 'a.txt', 'oldA');
        const b = await writeTestFile(root, 'b.txt', 'oldB');
        const result = await pair.client.callTool({
          name: 'create',
          arguments: {
            files: [
              { path: a, content: 'newA' },
              { path: b, content: 'newB' },
            ],
          },
        });
        // One round, one prompt per pending entry: no re-prompt.
        assert.strictEqual(prompts(), 2);
        assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
        assert.strictEqual(await readFile(a, 'utf8'), 'newA');
        assert.strictEqual(await readFile(b, 'utf8'), 'newB');
      },
    );
  });

  it('delete refuses a directory replaced after its delete was approved', async (t) => {
    await withPrompts(
      'delete',
      async () => {},
      async ({ root, pair, prompts }) => {
        const target = join(root, 'target');
        const other = await writeTestFile(root, 'other.txt', 'other');
        await writeTestFile(root, 'target/child.txt', 'original');
        // 1st lstat plans the prompt round, 2nd plans the approved retry.
        afterNthLstat(t, 'target', 2, async () => {
          await rm(target, { recursive: true });
          await writeTestFile(root, 'target/child.txt', 'replacement');
        });
        const result = await pair.client.callTool({
          name: 'delete',
          arguments: { paths: [target, other], recursive: true },
        });
        assert.strictEqual(prompts(), 1);
        assert.strictEqual(deleteError(result)?.code, 'CANCELLED', JSON.stringify(result));
        assert.match(deleteError(result)?.message ?? '', /replaced after the delete was approved/);
        assert.strictEqual(await readFile(join(target, 'child.txt'), 'utf8'), 'replacement');
      },
    );
  });

  it('delete refuses a socket replaced after it was planned', async (t) => {
    if (process.platform === 'win32') return t.skip('unix sockets need POSIX');
    await withPrompts(
      'delete',
      async () => {},
      async ({ root, pair }) => {
        const sock = join(root, 's.sock');
        const other = await writeTestFile(root, 'other.txt', 'other');
        const listen = (server: Server) =>
          new Promise<void>((resolve) => server.listen(sock, resolve));
        const first = createServer();
        const second = createServer();
        await listen(first);
        try {
          afterNthLstat(t, 's.sock', 1, async () => {
            await new Promise((resolve) => first.close(resolve));
            await rm(sock, { force: true });
            await listen(second);
          });
          const result = await pair.client.callTool({
            name: 'delete',
            arguments: { paths: [sock, other] },
          });
          assert.strictEqual(deleteError(result)?.code, 'CANCELLED', JSON.stringify(result));
          assert.strictEqual(await exists(sock), true);
        } finally {
          first.close();
          second.close();
        }
      },
    );
  });

  it('delete proceeds when a pending directory vanishes', async () => {
    await withPrompts(
      'delete',
      async (root, n) => {
        if (n === 1) await rename(join(root, 'target'), join(root, 'moved'));
      },
      async ({ root, pair, prompts }) => {
        await writeTestFile(root, 'target/child.txt', 'original');
        await writeTestFile(root, 'other/child.txt', 'other');
        const result = await pair.client.callTool({
          name: 'delete',
          arguments: {
            paths: [join(root, 'target'), join(root, 'other')],
            recursive: true,
            ignoreIfNotExists: true,
          },
        });
        // One round, one prompt per pending entry: no re-prompt.
        assert.strictEqual(prompts(), 2);
        assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
        assert.strictEqual(await exists(join(root, 'other')), false);
        assert.strictEqual(await readFile(join(root, 'moved', 'child.txt'), 'utf8'), 'original');
      },
    );
  });
});
