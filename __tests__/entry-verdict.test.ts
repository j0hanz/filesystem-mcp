import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { PathGuard } from '../src/core/path.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  makeGuard,
  trySymlink,
  writeTestFile,
} from './helpers.ts';

describe('PathGuard.entryVerdict', () => {
  let root: string;
  let other: string;
  let guard: PathGuard;

  before(async () => {
    root = await createTestRoot();
    other = await createTestRoot();
    guard = await makeGuard([root]);
    await writeTestFile(root, 'a.txt', 'x');
    await writeTestFile(root, '.env', 'S=1');
    await writeTestFile(other, 'secret.txt', 'x');
  });

  after(async () => {
    await cleanupTestRoot(root);
    await cleanupTestRoot(other);
  });

  const rows: {
    name: string;
    expected: 'ok' | 'sensitive' | 'inaccessible';
    entry: string;
    link?: string;
    setup?: () => Promise<void>;
  }[] = [
    { name: 'plain', expected: 'ok', entry: 'a.txt' },
    { name: 'env', expected: 'sensitive', entry: '.env' },
    {
      name: 'uppercase-env',
      expected: 'sensitive',
      entry: '.ENV',
      setup: async () => {
        await writeTestFile(root, '.ENV', 'S=1');
      },
    },
    { name: 'link-to-env', expected: 'sensitive', entry: 'link', link: '.env' },
    { name: 'outside', expected: 'inaccessible', entry: 'out', link: join('OTHER', 'secret.txt') },
    { name: 'missing', expected: 'inaccessible', entry: 'gone.txt' },
    { name: 'dangling', expected: 'inaccessible', entry: 'd', link: 'nowhere' },
    {
      name: 'dangling-outside',
      expected: 'inaccessible',
      entry: 'x',
      link: join('OTHER', 'missing'),
    },
  ];

  for (const row of rows) {
    it(`entryVerdict ${row.name} is ${row.expected}`, async (t) => {
      await row.setup?.();
      if (row.link !== undefined) {
        const target = row.link.startsWith('OTHER')
          ? join(other, row.link.slice('OTHER'.length + 1))
          : join(root, row.link);
        if (
          !(await trySymlink(
            target,
            join(root, row.entry),
            () => t.skip('symlink creation not permitted'),
            'file',
          ))
        ) {
          return;
        }
      }
      assert.equal(await guard.entryVerdict(join(root, row.entry)), row.expected);
    });
  }

  it('isEntryAccessible is true only for ok', async () => {
    assert.equal(await guard.isEntryAccessible(join(root, 'a.txt')), true);
    assert.equal(await guard.isEntryAccessible(join(root, '.env')), false);
    assert.equal(await guard.isEntryAccessible(join(root, 'gone.txt')), false);
  });
});
