import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { encodeFileUriPath, FILESYSTEM_FILE_URI_TEMPLATE } from '../src/core/file-uri.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  type TestClientContext,
  trySymlink,
  withEnv,
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
      if (name === 'list') {
        assert.match(firstTextBlock(result).text ?? '', /^alias-root\n/u);
      }
    }
  });

  it('completes as one root', async (t) => {
    if (!harness) return t.skip('symlink not permitted');
    const complete = async (value: string): Promise<string[]> => {
      const result = await harness?.client.complete({
        ref: { type: 'ref/resource', uri: FILESYSTEM_FILE_URI_TEMPLATE },
        argument: { name: 'path', value: encodeFileUriPath(value) },
      });
      return result?.completion.values ?? [];
    };
    const roots = await complete('');
    assert.strictEqual(roots.length, 1, JSON.stringify(roots));
    const relative = await complete('alias-pro');
    assert.ok(
      relative.some((v) => v.endsWith('alias-probe.txt')),
      JSON.stringify(relative),
    );
  });

  it('completion hides a name denied under the real path', async (t) => {
    const realDeny = join(base, 'real-deny');
    const aliasDeny = join(base, 'alias-deny');
    await mkdir(join(realDeny, 'private'), { recursive: true });
    await writeFile(join(realDeny, 'private', 'hidden.txt'), 'h');
    await writeFile(join(realDeny, 'private', 'visible.txt'), 'v');
    if (!(await trySymlink(realDeny, aliasDeny, () => undefined))) {
      return t.skip('symlink not permitted');
    }
    const deny = `${realDeny.replaceAll('\\', '/')}/private/hidden*`;
    await withEnv({ FS_DENYLIST: deny }, async () => {
      const pair = await createTestClientPair([aliasDeny]);
      try {
        const result = await pair.client.complete({
          ref: { type: 'ref/resource', uri: FILESYSTEM_FILE_URI_TEMPLATE },
          argument: {
            name: 'path',
            value: encodeFileUriPath(`${join(aliasDeny, 'private')}${sep}`),
          },
        });
        const values = result.completion.values;
        assert.ok(
          values.some((v) => v.endsWith('visible.txt')),
          JSON.stringify(values),
        );
        assert.ok(!values.some((v) => v.endsWith('hidden.txt')), JSON.stringify(values));
      } finally {
        await pair.close();
      }
    });
  });
});
