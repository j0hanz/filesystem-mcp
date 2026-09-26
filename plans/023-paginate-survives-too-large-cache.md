# Plan 023: A paged tool still answers its first page when the full set is too large to cache

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/cursor.ts src/core/store.ts __tests__/page-store.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

`search_text`, `find_files` and `list` all page through `paginate`
(`src/core/cursor.ts`). On an incomplete first page, `paginate` also
"externalizes" the **whole** result set into the resource store as
pretty-printed JSON so the client can fetch it by URI. The store refuses an
entry over 10 MiB by throwing `TOO_LARGE`, and nothing catches it: the whole
tool call fails, even though the 50-row page it was about to return is fine.

Reproduced: 10 files × 1,000 matching lines, `search_text` with `context: 10`
and `maxResults: 50` → `isError` with
`TOO_LARGE: Resource too large to cache (20161054 bytes)` plus the unrelated
hint "Use head/tail or line ranges to read partially". The same search with
`context: 0` succeeds. Any broad search with a few context lines, or long
lines, hits this. `find_files` and `list` share the path and are one big tree
away from the same failure.

After this plan, a `TOO_LARGE` from the store means "no `resource` on this
page" and nothing else.

## Current state

```ts
// src/core/cursor.ts:1-2 (imports)
import type { PageSnapshot, PageSnapshotStore } from './store.ts';
import { invalidCursor } from './store.ts';
```

```ts
// src/core/cursor.ts:86-104 (tail of paginate)
  const produced = await params.produce();
  const { items, metadata } = produced;
  const incomplete = items.length > params.pageSize || produced.truncated;
  const first: Page<T, M> =
    items.length <= params.pageSize
      ? { page: items, metadata, nextCursor: undefined, offset: 0 }
      : pageResult(
          params.store.create({
            queryKey: params.queryKey,
            items,
            metadata,
          }),
          0,
          params.pageSize,
          { items, metadata },
        );
  if (!incomplete || params.externalize === undefined) return first;
  return { ...first, resource: params.externalize(produced.items, produced.metadata) };
}
```

```ts
// src/core/store.ts:128-133 (ResourceStore.putText)
  putText(params: { name: string; mimeType?: string; text: string }): ResourceEntry {
    const entryBytes = Buffer.byteLength(params.text, 'utf8');
    if (entryBytes > MAX_ENTRY_BYTES) {
      if (this.#entries.prune()) this.#onListChanged?.();
      throw new FsError(ErrorCode.TOO_LARGE, `Resource too large to cache (${entryBytes} bytes).`);
    }
```

The three `externalize` callbacks (`src/tools/search-text.ts:322-329`,
`src/tools/find-files.ts:145-147`, `src/tools/list.ts:299-314`) all call
`putJsonResource(store, name, value)` (`src/core/store.ts:173`), which calls
`putText`. `isFsError` and `ErrorCode` come from `src/core/errors.ts`.

Existing unit test for `paginate`: `__tests__/page-store.test.ts` (imports
`paginate`, `ErrorCode`, `PageSnapshotStore`, `fsErrorMatcher`; its first
`it` builds `paginate({ store, queryKey, cursor: undefined, pageSize: 1, produce })`).

## Commands you will need

| Purpose      | Command                                                                | Expected on success |
| ------------ | ---------------------------------------------------------------------- | ------------------- |
| Static check | `npm run check:static`                                                 | exit 0              |
| All tests    | `npm test`                                                             | all pass            |
| Unit file    | `node --test __tests__/page-store.test.ts`                             | all pass            |
| Format       | `npx prettier --write src/core/cursor.ts __tests__/page-store.test.ts` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/cursor.ts` — the last two lines of `paginate` and one import
- `__tests__/page-store.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `MAX_ENTRY_BYTES` in `store.ts` — the cap is deliberate.
- The three tools' `externalize` callbacks — one fix in `paginate` covers all.
- Trimming `context` lines from the externalized JSON — a different design.

## Git workflow

- Branch: `advisor/023-paginate-survives-too-large-cache`.
- One commit: `fix(cursor): return the page when the full set is too large to cache`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Regression test (it must fail now)

In `__tests__/page-store.test.ts`, add a new `it` inside the existing
`describe('PageSnapshotStore', …)`:

```ts
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
```

Add `FsError` to the import from `'../src/core/errors.ts'` in that test file.

**Verify**: `node --test __tests__/page-store.test.ts` → the new test
**fails** (`paginate` rejects with TOO_LARGE). If it passes, STOP.

### Step 2: Catch exactly one error class

In `src/core/cursor.ts`:

1. Add `import { ErrorCode, isFsError } from './errors.ts';` to the imports.
2. Replace the last two lines of `paginate` (lines 102–103) with:

   ```ts
   if (!incomplete || params.externalize === undefined) return first;
   try {
     return { ...first, resource: params.externalize(produced.items, produced.metadata) };
   } catch (error) {
     // The store refuses an entry over its byte cap. The page itself is
     // fine; the caller simply gets no full-set resource for this query.
     if (isFsError(error) && error.code === ErrorCode.TOO_LARGE) return first;
     throw error;
   }
   ```

Run `npx prettier --write src/core/cursor.ts __tests__/page-store.test.ts`.

**Verify**: `node --test __tests__/page-store.test.ts` → all pass.

### Step 3: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- New unit test: `TOO_LARGE` from `externalize` → page and cursor returned,
  `resource` absent; any other `FsError` still propagates.
- Existing: every `search_text` / `find_files` / `list` pagination and
  `resource_link` test in `tools.test.ts` (unchanged behavior when the store
  accepts the entry).
- No end-to-end test: producing a >10 MiB JSON payload in the suite costs
  seconds and memory for a one-line catch.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "ErrorCode.TOO_LARGE" src/core/cursor.ts` prints one line
- [ ] The new test exists and passes
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 023 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The regression test passes before Step 2.
- Importing `./errors.ts` from `cursor.ts` creates an import cycle warning in
  the build or knip output (it should not: `errors.ts` has no cursor import).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Only `TOO_LARGE` is swallowed. If the store ever throws a different code for
  "will not cache", add it here — do not widen the catch to every `FsError`.
- Reviewer focus: the `first` page returned in the catch is the same object
  the success path spreads, so `nextCursor` and the snapshot are intact.
