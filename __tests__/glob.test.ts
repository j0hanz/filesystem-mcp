import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

import { globEntries, type GlobEntriesOptions } from '../src/core/glob.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
} from './helpers.ts';

/** Walk and return root-relative POSIX paths, sorted, directories with a trailing `/`. */
async function walk(options: GlobEntriesOptions): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of globEntries(options)) {
    const rel = relative(options.cwd, entry.path).replaceAll('\\', '/');
    out.push(entry.dirent.isDirectory() ? `${rel}/` : rel);
  }
  return out.sort();
}

/**
 * A root with a .gitignore and a subdirectory whose name also exists in the
 * process cwd: fs.glob re-visits that directory with a dirent relative to the
 * walk root ("."), which used to resolve against the process cwd instead.
 */
async function withCollidingCwd(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await createTestRoot();
  const elsewhere = await createTestRoot();
  const previousCwd = process.cwd();
  try {
    await mkdir(join(root, 'shared'));
    await writeFile(join(root, 'shared', 'inner.txt'), 'NEEDLE');
    await writeFile(join(root, 'top.txt'), 'NEEDLE');
    await writeFile(join(root, '.gitignore'), '*.log\n');
    await mkdir(join(elsewhere, 'shared'));
    process.chdir(elsewhere);
    await fn(root);
  } finally {
    process.chdir(previousCwd);
    await cleanupTestRoot(root);
    await cleanupTestRoot(elsewhere);
  }
}

describe('globEntries', () => {
  it('walks every subdirectory when the process cwd holds a same-named entry', async () => {
    await withCollidingCwd(async (root) => {
      assert.deepStrictEqual(await walk({ cwd: root, pattern: '**/*', skipIgnored: true }), [
        'shared/inner.txt',
        'top.txt',
      ]);
    });
  });

  it('list, find_files and search_text see the colliding subdirectory', async () => {
    await withCollidingCwd(async (root) => {
      const harness = await createTestClientPair([root]);
      try {
        const listed = await harness.client.callTool({
          name: 'list',
          arguments: { path: root, maxDepth: 2 },
        });
        assert.notStrictEqual(listed.isError, true, firstTextBlock(listed).text);
        assert.match(firstTextBlock(listed).text ?? '', /inner\.txt/u);

        const found = await harness.client.callTool({
          name: 'find_files',
          arguments: { path: root, pattern: '**/*' },
        });
        assert.match(firstTextBlock(found).text ?? '', /inner\.txt/u);

        const searched = await harness.client.callTool({
          name: 'search_text',
          arguments: { path: root, searchPattern: 'NEEDLE' },
        });
        assert.match(firstTextBlock(searched).text ?? '', /inner\.txt/u);
      } finally {
        await harness.close();
      }
    });
  });
});
