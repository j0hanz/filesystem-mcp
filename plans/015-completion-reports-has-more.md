# Plan 015: Path completion reports the true match count and `hasMore`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 1eb94134..HEAD -- src/core/path-completer.ts __tests__/resources.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `1eb94134`, 2026-09-26

## Why this matters

`completion/complete` on the `filesystem-mcp://file/{+path}` resource template
returns path suggestions. The MCP SDK already turns whatever array the
completer returns into the wire result: it keeps the first 100 values and
sets `total` to the full array length and `hasMore` to `length > 100`. This
server slices its own list to 100 **before** handing it to the SDK, so the SDK
only ever sees at most 100 items. In a directory with more than 100 matching
entries, clients get `total: 100, hasMore: false` and cannot tell the list was
cut. They then have no reason to narrow the prefix.

Deleting the local cap lets the SDK do the truncation it already does, and
clients get the real `total` and `hasMore: true`. The kept 100 are unchanged,
because the local sort still runs before the SDK slices.

The advisor reproduced this at `1eb94134`: a root holding 150 files, completed
with the root path plus a trailing separator, returns
`values.length === 100, total === 100, hasMore === false`.

## Current state

- `src/core/path-completer.ts` — builds the suggestion list. The constant
  and its three slices:

  ```ts
  // src/core/path-completer.ts:16
  const MAX_COMPLETION_ITEMS = 100;
  ```

  ```ts
  // src/core/path-completer.ts:187-205 (the three slice sites)
  export async function suggestPaths(pathGuard: PathGuard, value: string): Promise<string[]> {
    const allowed = pathGuard.getAllowedDirectories();

    try {
      if (!value) {
        return allowed.slice(0, MAX_COMPLETION_ITEMS);
      }

      const context = getSearchContext(value, allowed);
      if (!context) {
        return findRootPrefixMatches(value, allowed).slice(0, MAX_COMPLETION_ITEMS);
      }

      const { searchDir, prefix } = context;
      const dirMatches = await findMatchesInDirectory(searchDir, prefix, allowed, (p) =>
        pathGuard.isSensitive(p),
      );
      const rootMatches = findMatchingRoots(searchDir, prefix, allowed);
      return mergeCompletionMatches(dirMatches, rootMatches).slice(0, MAX_COMPLETION_ITEMS);
  ```

  And the comment that explains where the cap is applied
  (`src/core/path-completer.ts:136-140`, inside `findMatchesInDirectory`):

  ```ts
  // Stream via opendir and collect every match; the MAX_COMPLETION_ITEMS
  // cap is applied AFTER the alphabetical sort in mergeCompletionMatches
  // (slice at the call site). Capping here would keep the opendir-first
  // 100, not the alphabetically-first 100 — the sort would only reorder
  // an already-arbitrary subset.
  ```

- `src/resources.ts:237-248` — the only caller. It encodes every suggestion
  and returns the array to the SDK as the template variable's completer:

  ```ts
      complete: {
        path: async (value) => {
          const suggestions = await suggestPaths(
            options.pathGuard,
            decodeFileUriPath(value) ?? value,
          );
          return suggestions.map(encodeFileUriPath);
        },
      },
  ```

- The SDK side (installed `@modelcontextprotocol/server@2.1.0`,
  `node_modules/@modelcontextprotocol/server/dist/mcp-Dw2OlZ1f.mjs:2248-2253`),
  used for both prompt-argument and resource-template completion
  (call sites at lines 1818 and 1828 of the same file):

  ```js
  function createCompletionResult(suggestions) {
    return {
      completion: {
        values: suggestions.map(String).slice(0, 100),
        total: suggestions.length,
        hasMore: suggestions.length > 100,
      },
    };
  }
  ```

  The wire type is `CompleteResult`
  (`node_modules/@modelcontextprotocol/server/dist/createMcpHandler-Bt6U_Fqb.d.mts`,
  exported; `completion.values`, optional `total`, optional `hasMore`).

- `__tests__/resources.test.ts:701-742` — `describe('filesystem resource path completion', …)`
  exercises the completer directly through `getResourceContracts`. That path
  bypasses the SDK, so it cannot see `total`/`hasMore`. The new test goes
  through a real client instead.
- `__tests__/helpers.ts:107-130` — `createTestClientPair(allowedDirs)` returns
  `{ client, serverCtx, close }`: a real `Client` linked in-memory to a
  `createServer` instance. `client.complete(params)` is the typed request
  method (`@modelcontextprotocol/client` `index.d.mts:2278`).
- `src/core/file-uri.ts:15` exports
  `FILESYSTEM_FILE_URI_TEMPLATE = 'filesystem-mcp://file/{+path}'`, and the
  same module exports `encodeFileUriPath` (already imported by
  `resources.test.ts` at line 17).

## Commands you will need

| Purpose      | Command                                                                 | Expected on success |
| ------------ | ----------------------------------------------------------------------- | ------------------- |
| Static check | `npm run check:static`                                                  | exit 0              |
| All tests    | `npm test`                                                              | all pass            |
| One suite    | `npm test -- --test-name-pattern="filesystem resource path completion"` | suite passes        |

`npm run check:static` = build + `tsc -p tsconfig.test.json` + eslint
(`--max-warnings=0`) + `prettier --check .` + knip.

## Scope

**In scope** (the only files you should modify):

- `src/core/path-completer.ts`
- `__tests__/resources.test.ts`
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/resources.ts` — the caller is already correct; it returns the full
  array to the SDK.
- The sort order in `mergeCompletionMatches` (directories first, then
  `localeCompare`) — clients see the same first 100 as before.
- `src/prompts.ts` topic completion — a fixed short list, no cap involved.
- Any attempt to stop `findMatchesInDirectory` early for huge directories —
  it already collects every match today; see Maintenance notes.

## Git workflow

- Branch: `advisor/015-completion-has-more` from `main`.
- Commit per step, conventional-commit style matching the log, for example
  `test(resources): pin completion total and hasMore past 100 matches` and
  `fix(resources): let the SDK cap path completion so hasMore is reported`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the regression test (it must fail now)

In `__tests__/resources.test.ts`, inside
`describe('filesystem resource path completion', …)` (after the existing
`it(...)`), add:

```ts
it('reports the full match count and hasMore past 100 suggestions', async () => {
  const dir = join(root, 'many');
  await mkdir(dir);
  for (let i = 0; i < 150; i += 1) {
    await writeFile(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x');
  }
  const harness = await createTestClientPair([root]);
  try {
    const result = await harness.client.complete({
      ref: { type: 'ref/resource', uri: FILESYSTEM_FILE_URI_TEMPLATE },
      argument: { name: 'path', value: encodeFileUriPath(`${dir}${sep}`) },
    });
    assert.strictEqual(result.completion.values.length, 100);
    assert.strictEqual(result.completion.total, 150);
    assert.strictEqual(result.completion.hasMore, true);
    // Still the alphabetically-first 100: the local sort runs before the
    // SDK slices.
    assert.ok(result.completion.values[0]?.endsWith('f000.txt'));
    assert.ok(result.completion.values[99]?.endsWith('f099.txt'));
  } finally {
    await harness.close();
  }
});
```

Imports to add or extend at the top of the file (run
`npx prettier --write __tests__/resources.test.ts` afterwards to order them):

- `mkdir` joins the existing `import { writeFile } from 'node:fs/promises';`
  → `import { mkdir, writeFile } from 'node:fs/promises';`
- `sep` joins the existing `import { join } from 'node:path';`
  → `import { join, sep } from 'node:path';`
- `FILESYSTEM_FILE_URI_TEMPLATE` joins the existing
  `import { buildFileResourceUri, encodeFileUriPath, extractPath } from '../src/core/file-uri.ts';`
- `createTestClientPair` is already imported from `./helpers.ts`
  (lines 26-33); no change there.

**Verify**:
`npm test -- --test-name-pattern="reports the full match count"` → the test
**fails** on `total` (actual `100`, expected `150`). If it passes on the
unmodified source, STOP.

### Step 2: Delete the local cap

In `src/core/path-completer.ts`:

1. Delete line 16, `const MAX_COMPLETION_ITEMS = 100;`.
2. In `suggestPaths`, drop the three `.slice(0, MAX_COMPLETION_ITEMS)` calls:
   - `return allowed.slice(0, MAX_COMPLETION_ITEMS);` → `return allowed;`
     (`getAllowedDirectories()` already returns a fresh copy —
     `src/core/path.ts:213-218` ends in `return [...this.allowedDirectoriesState];`
     — so no further copy is needed).
   - `return findRootPrefixMatches(value, allowed).slice(0, MAX_COMPLETION_ITEMS);`
     → `return findRootPrefixMatches(value, allowed);`
   - `return mergeCompletionMatches(dirMatches, rootMatches).slice(0, MAX_COMPLETION_ITEMS);`
     → `return mergeCompletionMatches(dirMatches, rootMatches);`
3. Replace the comment at lines 136-140 with:

   ```ts
   // Stream via opendir and collect every match. Do not cap here: the
   // SDK's completion result keeps the first 100 values and reports the
   // full length as `total` / `hasMore`, so the list must reach it whole
   // and already sorted (mergeCompletionMatches). Capping here would
   // keep the opendir-first 100, not the alphabetically-first 100, and
   // hide the true count from the client.
   ```

4. Update the `suggestPaths` doc comment (lines 183-186) by appending one
   sentence: `Returns every match, sorted; the SDK truncates to 100 and reports the total.`

**Verify**:

- `npm test -- --test-name-pattern="filesystem resource path completion"` →
  both tests in the suite pass.
- `grep -n "MAX_COMPLETION_ITEMS" src/` → no matches.

### Step 3: Full gate

Run `npx prettier --write src/core/path-completer.ts __tests__/resources.test.ts`.

**Verify**: `npm run check` → exit 0; all tests pass.

## Test plan

- New test: 150 files in one directory, completed through a real
  `Client.complete` call → `values.length === 100`, `total === 150`,
  `hasMore === true`, first value ends with `f000.txt`, hundredth ends with
  `f099.txt`.
- Existing test `'returns {+path} values that round-trip back to the file they named'`
  must keep passing (encoding path unchanged).
- Pattern: in-process client usage as in `__tests__/aliased-root.test.ts`
  (`createTestClientPair` + `harness.close()` in `finally`).

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] The new completion test exists and passes
- [ ] `grep -rn "MAX_COMPLETION_ITEMS" src/` returns no matches
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 015 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows an in-scope file changed and the excerpts no longer
  match.
- The Step 1 test passes on the unmodified source, or fails on something
  other than `total` (for example `values.length` is not 100). The SDK's
  truncation may differ from `createCompletionResult` as quoted; report the
  observed `completion` object.
- After Step 2, `values.length` exceeds 100. That would mean the SDK does not
  truncate, and removing the local cap would ship an unbounded list. Revert
  and report.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The 100-item cap now lives only in the SDK (`createCompletionResult`). If an
  SDK upgrade changes that number or stops truncating, this completer's
  output size follows it. The Step 1 test's `values.length === 100` assertion
  catches that on the next bump.
- Cost is unchanged in kind. `findMatchesInDirectory` already streamed and
  collected every match before this plan. The only new per-call work is
  `encodeFileUriPath` over the full list in `resources.ts`, which is linear
  string work. If completion in very large directories (tens of thousands of
  matches) ever shows up in a profile, cap the **collection** at a high bound
  and still return `total` honestly — do not bring back a 100-item slice.
