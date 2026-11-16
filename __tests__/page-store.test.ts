import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { paginate } from '../src/core/cursor.ts';
import { ErrorCode, FsError } from '../src/core/errors.ts';
import { invalidCursor, PageSnapshotStore } from '../src/core/store.ts';
import { fsErrorMatcher } from './helpers.ts';

describe('PageSnapshotStore', () => {
  it('a refused cursor names both ways it goes stale and the remedy', () => {
    assert.strictEqual(
      invalidCursor().message,
      'Invalid cursor: a page expires 300 seconds after its last read, and a cursor works only with the query that made it. Request the first page without a cursor.',
    );
  });

  const KEY = '{"method":"list","path":"k"}';
  const stale = fsErrorMatcher(ErrorCode.INVALID_INPUT, /Request the first page without a cursor/);

  it('a read keeps a snapshot alive; an unread one expires after 300 s', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const store = new PageSnapshotStore();
    const id = store.create({ queryKey: KEY, items: ['a'] });
    t.mock.timers.tick(299_000);
    assert.deepStrictEqual(store.read(id, KEY).items, ['a']);
    t.mock.timers.tick(299_000);
    assert.deepStrictEqual(store.read(id, KEY).items, ['a']);
    t.mock.timers.tick(300_001);
    assert.throws(() => store.read(id, KEY), stale);
  });

  it('reading a snapshot does not schedule a timer per read', (t) => {
    const timers = t.mock.method(globalThis, 'setTimeout');
    const store = new PageSnapshotStore();
    const id = store.create({ queryKey: KEY, items: ['a'] });
    for (let i = 0; i < 100; i++) store.read(id, KEY);
    assert.ok(timers.mock.callCount() <= 2, String(timers.mock.callCount()));
  });

  it('a refreshed snapshot still expires once reads stop', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const store = new PageSnapshotStore();
    const id = store.create({ queryKey: KEY, items: ['a'] });
    t.mock.timers.tick(200_000);
    store.read(id, KEY);
    t.mock.timers.tick(300_001);
    assert.throws(() => store.read(id, KEY), stale);
  });

  it('weighs a snapshot by its own weight when given one', () => {
    const store = new PageSnapshotStore();
    const older = store.create({ queryKey: KEY, items: ['x'], weight: 150_000 });
    const newer = store.create({ queryKey: KEY, items: ['y'], weight: 100_000 });
    assert.throws(() => store.read(older, KEY), stale);
    assert.deepStrictEqual(store.read(newer, KEY).items, ['y']);
  });

  it('a snapshot heavier than the cap alone survives and evicts the rest', () => {
    const store = new PageSnapshotStore();
    const other = store.create({ queryKey: KEY, items: ['x'] });
    const heavy = store.create({ queryKey: KEY, items: ['y'], weight: 210_000 });
    assert.deepStrictEqual(store.read(heavy, KEY).items, ['y']);
    assert.throws(() => store.read(other, KEY), stale);
  });

  it('evicts the least recently used snapshot past 200,000 items', () => {
    const store = new PageSnapshotStore();
    const older = store.create({ queryKey: KEY, items: new Array<number>(150_000).fill(0) });
    const newer = store.create({ queryKey: KEY, items: new Array<number>(100_000).fill(0) });
    assert.throws(() => store.read(older, KEY), stale);
    assert.strictEqual(store.read(newer, KEY).items.length, 100_000);
  });

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

    now = 300_000;
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

  it("a call view's discard drops the snapshots created through it, and only those", () => {
    const store = new PageSnapshotStore();
    const queryKey = '{"method":"list"}';
    const kept = store.create({ queryKey, items: ['kept'] });
    const view = store.forCall();
    const viewed = view.create({ queryKey, items: ['viewed'] });
    // The view shares the store's snapshots both ways.
    assert.deepStrictEqual(store.read(viewed, queryKey).items, ['viewed']);
    assert.deepStrictEqual(view.read(kept, queryKey).items, ['kept']);

    view.discard();
    assert.throws(() => store.read(viewed, queryKey), fsErrorMatcher(ErrorCode.INVALID_INPUT));
    assert.deepStrictEqual(store.read(kept, queryKey).items, ['kept']);
    store.discard(); // the store itself recorded nothing
    assert.deepStrictEqual(store.read(kept, queryKey).items, ['kept']);
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
