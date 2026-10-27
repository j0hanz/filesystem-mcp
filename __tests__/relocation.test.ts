import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PathGuard } from '../src/core/path.ts';
import { withEnv } from './helpers.ts';

async function* names(...list: string[]): AsyncGenerator<string> {
  yield* list;
}

describe('PathGuard.relocationKeepsProtection', () => {
  const root = join('/r');
  const keeps = (
    list: string[],
    from: { from: string; requestedFrom?: string },
    to: string,
  ): Promise<boolean> =>
    withEnv({ FS_DENYLIST: 'secrets/**', FS_ALLOW_SENSITIVE: '1' }, () =>
      new PathGuard().relocationKeepsProtection(names(...list), from, to),
    );

  const cases: [string, string[], { from: string; requestedFrom?: string }, string, boolean][] = [
    ['an empty tree', [], { from: join(root, 'a') }, join(root, 'secrets'), true],
    ['entries staying unprotected', ['x', 'y/z'], { from: join(root, 'a') }, join(root, 'b'), true],
    [
      'an entry entering protection',
      ['x'],
      { from: join(root, 'a') },
      join(root, 'secrets'),
      false,
    ],
    ['an entry leaving protection', ['x'], { from: join(root, 'secrets') }, join(root, 'a'), false],
    [
      'protected on both sides',
      ['x'],
      { from: join(root, 'secrets', 'a') },
      join(root, 'secrets', 'b'),
      true,
    ],
    [
      'a requested spelling that was protected',
      ['x'],
      { from: join(root, 'a'), requestedFrom: join(root, 'secrets') },
      join(root, 'b'),
      false,
    ],
    [
      'a protected requested spelling landing protected',
      ['x'],
      { from: join(root, 'a'), requestedFrom: join(root, 'secrets') },
      join(root, 'secrets', 'b'),
      true,
    ],
  ];
  for (const [label, list, from, to, expected] of cases) {
    it(`${label}: ${String(expected)}`, async () => {
      assert.strictEqual(await keeps(list, from, to), expected);
    });
  }

  it('lets a failed walk propagate', async () => {
    async function* broken(): AsyncGenerator<string> {
      yield 'x';
      throw new Error('walk failed');
    }
    await assert.rejects(
      new PathGuard().relocationKeepsProtection(
        broken(),
        { from: join(root, 'a') },
        join(root, 'b'),
      ),
      /walk failed/,
    );
  });
});
