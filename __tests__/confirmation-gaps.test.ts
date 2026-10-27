import assert from 'node:assert/strict';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  cleanupTestRoot,
  createElicitationClientPair,
  createTestRoot,
  firstTextBlock,
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
        await pair.client.callTool({
          name: 'move',
          arguments: { copy: true, moves: [{ source, destination }] },
        });
        assert.strictEqual(prompts(), 2);
        assert.strictEqual(await readFile(destination, 'utf8'), 'SOURCE');
      },
    );
  });

  it('create re-prompts for a file swapped during confirmation', async () => {
    await withPrompts(
      'overwrite',
      async (root, n) => {
        if (n === 1) await swap(join(root, 'dst.txt'), 'SWAPPED');
      },
      async ({ root, pair, prompts }) => {
        const path = await writeTestFile(root, 'dst.txt', 'ORIGINAL');
        await pair.client.callTool({
          name: 'create',
          arguments: { files: [{ path, content: 'NEW' }] },
        });
        assert.strictEqual(prompts(), 2);
        assert.strictEqual(await readFile(path, 'utf8'), 'NEW');
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
