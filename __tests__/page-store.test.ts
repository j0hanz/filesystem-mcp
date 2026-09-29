import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { paginate } from '../src/core/cursor.ts';
import { ErrorCode, FsError } from '../src/core/errors.ts';
import { PageSnapshotStore } from '../src/core/store.ts';
import { fsErrorMatcher } from './helpers.ts';

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
    await assert.rejects(
      () => replay(queryKeyTwo, cursor),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /Request the first page without a cursor/),
    );
    await assert.rejects(
      () => replay(queryKeyOne, Buffer.from(JSON.stringify({ offset: 1 })).toString('base64url')),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /Request the first page without a cursor/),
    );
    await assert.rejects(
      () => replay(queryKeyOne, 'not-a-cursor'),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /Request the first page without a cursor/),
    );
    await assert.rejects(
      () =>
        replay(
          queryKeyOne,
          Buffer.from(JSON.stringify({ snapshotId: 'evicted', offset: 0 })).toString('base64url'),
        ),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /Request the first page without a cursor/),
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
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /Request the first page without a cursor/),
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

  it('evicts least-recently-read snapshots and expires them', (t) => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    const store = new PageSnapshotStore();
    const queryKey = '{"method":"list"}';
    const first = store.create({ queryKey, items: ['a'] });
    const second = store.create({ queryKey, items: ['b'] });
    // Fill the store to its cap (32), then read `first` so `second` is the
    // least recently used entry when the next create evicts one.
    for (let i = 2; i < 32; i++) store.create({ queryKey, items: [String(i)] });
    store.read(first, queryKey);
    const third = store.create({ queryKey, items: ['c'] });

    assert.throws(
      () => store.read(second, queryKey),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /Request the first page without a cursor/),
    );
    assert.deepStrictEqual(store.read(first, queryKey).items, ['a']);
    assert.deepStrictEqual(store.read(third, queryKey).items, ['c']);

    now = 60_000;
    assert.throws(
      () => store.read(first, queryKey),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /Request the first page without a cursor/),
    );
  });

  it('does not create a snapshot when the complete result fits one page', async (t) => {
    const store = new PageSnapshotStore();
    t.mock.method(store, 'create', () => {
      throw new Error('create must not run for a single-page result');
    });
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

  it('a TOO_LARGE from externalize drops the resource but keeps the page', async () => {
    const store = new PageSnapshotStore();
    const base = {
      store,
      queryKey: '{"method":"list","path":"big"}',
      cursor: undefined,
      pageSize: 1,
      produce: async () => ({ items: ['a', 'b'], metadata: undefined, truncated: false }),
    };
    const page = await paginate({
      ...base,
      externalize: () => {
        throw new FsError(ErrorCode.TOO_LARGE, 'Resource too large to cache (1 bytes).');
      },
    });
    assert.deepStrictEqual(page.page, ['a']);
    assert.ok(page.nextCursor, 'paging must still work without the resource');
    assert.strictEqual(page.resource, undefined);

    await assert.rejects(
      paginate({
        ...base,
        externalize: () => {
          throw new FsError(ErrorCode.UNKNOWN, 'store exploded');
        },
      }),
      fsErrorMatcher(ErrorCode.UNKNOWN, 'store exploded'),
    );
  });
});
