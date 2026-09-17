import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { paginate } from '../src/core/cursor.ts';
import { ErrorCode, isFsError } from '../src/core/errors.ts';
import { PageSnapshotStore } from '../src/core/store.ts';

function assertInvalidCursor(error: unknown): boolean {
  assert(isFsError(error));
  assert.strictEqual(error.code, ErrorCode.INVALID_INPUT);
  assert.match(error.message, /Request the first page without a cursor/);
  return true;
}

describe('PageSnapshotStore', () => {
  it('stores pages, rejects old and malformed cursors, and checks query keys', async () => {
    const store = new PageSnapshotStore();
    const queryKeyOne = '{"method":"list","path":"one"}';
    const queryKeyTwo = '{"method":"list","path":"two"}';
    const first = await paginate({
      store,
      queryKey: queryKeyOne,
      cursor: undefined,
      pageSize: 1,
      produce: async () => ({ items: ['a', 'b'], metadata: { total: 2 }, truncated: false }),
    });

    assert.deepStrictEqual(first.page, ['a']);
    const cursor = first.nextCursor;
    assert.ok(cursor);
    const replay = (queryKey: string, malformedCursor: string) =>
      paginate({
        store,
        queryKey,
        cursor: malformedCursor,
        pageSize: 1,
        produce: () => {
          throw new Error('produce must not run on replay');
        },
      });
    await assert.rejects(() => replay(queryKeyTwo, cursor), assertInvalidCursor);
    await assert.rejects(
      () => replay(queryKeyOne, Buffer.from(JSON.stringify({ offset: 1 })).toString('base64url')),
      assertInvalidCursor,
    );
    await assert.rejects(() => replay(queryKeyOne, 'not-a-cursor'), assertInvalidCursor);
    await assert.rejects(
      () =>
        replay(
          queryKeyOne,
          Buffer.from(JSON.stringify({ snapshotId: 'evicted', offset: 0 })).toString('base64url'),
        ),
      assertInvalidCursor,
    );
    const decodedCursor = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    await assert.rejects(
      () =>
        replay(
          queryKeyOne,
          Buffer.from(JSON.stringify({ ...decodedCursor, offset: 99 })).toString('base64url'),
        ),
      assertInvalidCursor,
    );

    const second = await paginate({
      store,
      queryKey: queryKeyOne,
      cursor,
      pageSize: 1,
      produce: () => {
        throw new Error('produce must not run on replay');
      },
    });
    assert.deepStrictEqual(second.page, ['b']);
    assert.deepStrictEqual(second.metadata, { total: 2 });
    assert.strictEqual(second.nextCursor, undefined);
  });

  it('evicts least-recently-read snapshots and expires them', () => {
    let now = 0;
    const store = new PageSnapshotStore({ maxSnapshots: 2, ttlMs: 10, now: () => now });
    const queryKey = '{"method":"list"}';
    const first = store.create({ queryKey, items: ['a'] });
    const second = store.create({ queryKey, items: ['b'] });
    store.read(first, queryKey);
    const third = store.create({ queryKey, items: ['c'] });

    assert.throws(() => store.read(second, queryKey), assertInvalidCursor);
    assert.deepStrictEqual(store.read(first, queryKey).items, ['a']);
    assert.deepStrictEqual(store.read(third, queryKey).items, ['c']);

    now = 10;
    assert.throws(() => store.read(first, queryKey), assertInvalidCursor);
  });

  it('does not create a snapshot when the complete result fits one page', async () => {
    const store = new PageSnapshotStore({ maxSnapshots: 0 });
    const result = await paginate({
      store,
      queryKey: '{"method":"list"}',
      cursor: undefined,
      pageSize: 1,
      produce: async () => ({ items: ['complete'], metadata: undefined, truncated: false }),
    });

    assert.deepStrictEqual(result.page, ['complete']);
    assert.strictEqual(result.nextCursor, undefined);
  });
});
