import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  type TestClientContext,
  trySymlink,
} from './helpers.ts';

// A root configured through an alias (a symlink or junction, a Windows 8.3
// short name, macOS /tmp -> /private/tmp) is ONE root. The guard also allows
// its realpath for containment, but a caller choosing "the root" must see one.
describe('a root configured through an alias', () => {
  let base: string;
  let alias: string;
  let harness: TestClientContext | undefined;

  before(async () => {
    base = await createTestRoot();
    const real = join(base, 'real-root');
    await mkdir(real);
    await writeFile(join(real, 'alias-probe.txt'), 'ALIASNEEDLE');
    alias = join(base, 'alias-root');
    if (!(await trySymlink(real, alias, () => undefined))) return;
    harness = await createTestClientPair([alias]);
  });

  after(async () => {
    await harness?.close();
    await cleanupTestRoot(base);
  });

  it('lists as one root', async (t) => {
    if (!harness) return t.skip('symlink not permitted');
    const result = await harness.client.callTool({ name: 'list_roots' });
    const roots = (result.structuredContent as { roots: string[] }).roots;
    assert.strictEqual(roots.length, 1, JSON.stringify(roots));
  });

  it('is the default path for tools called without one', async (t) => {
    if (!harness) return t.skip('symlink not permitted');
    for (const [name, args] of [
      ['find_files', { pattern: '**/*.txt' }],
      ['list', {}],
      ['search_text', { searchPattern: 'ALIASNEEDLE' }],
    ] as const) {
      const result = await harness.client.callTool({ name, arguments: args });
      assert.notStrictEqual(result.isError, true, `${name}: ${firstTextBlock(result).text ?? ''}`);
      assert.match(firstTextBlock(result).text ?? '', /alias-probe\.txt/u, name);
    }
  });
});
