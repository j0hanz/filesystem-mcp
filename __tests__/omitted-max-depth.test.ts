import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MAX_SEARCH_DEPTH } from '../src/core/util.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  type TestClientContext,
} from './helpers.ts';

// The schema says "omit for unlimited", so an omitted maxDepth must reach a
// file nested a few levels past the largest explicit value, in every walk.
describe('an omitted maxDepth', () => {
  let root: string;
  let harness: TestClientContext;

  before(async () => {
    root = await createTestRoot();
    const deep = join(root, ...Array.from({ length: MAX_SEARCH_DEPTH + 3 }, () => 'd'));
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'deep-needle.txt'), 'DEEPNEEDLE');
    harness = await createTestClientPair([root]);
  });

  after(async () => {
    await harness.close();
    await cleanupTestRoot(root);
  });

  it('is unlimited in search_text, find_files and replace_text', async () => {
    for (const [name, args] of [
      ['find_files', { pattern: '**/*.txt' }],
      ['search_text', { searchPattern: 'DEEPNEEDLE' }],
      ['replace_text', { searchPattern: 'DEEPNEEDLE', replacement: 'X', dryRun: true }],
    ] as const) {
      const result = await harness.client.callTool({ name, arguments: { path: root, ...args } });
      const text = firstTextBlock(result).text ?? '';
      assert.notStrictEqual(result.isError, true, `${name}: ${text}`);
      assert.match(JSON.stringify(result.structuredContent ?? text), /deep-needle\.txt/u, name);
    }
  });
});
