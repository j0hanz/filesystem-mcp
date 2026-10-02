# Architecture audit findings, 2026-10-02

Source: the repo-wide architecture audit at `72d448ea`. Workflow
`wf_1f329b17-c2b` ran 8 zone probes and priced every candidate
adversarially. Of 39 candidates, 9 survived, and two of those merged into
finding 2. The import graph has no cycles and no edges that run up the
gradient.

This file is the scope of the execution contract in
[`arch-audit-followups.map.md`](../arch-audit-followups.map.md). Line numbers
are as of `72d448ea`.

| #   | Finding                                       | Move                                   | Files |
| :-- | :-------------------------------------------- | :------------------------------------- | :---- |
| 1   | Completion uses the containment set as roots  | read `getRoots()`                      | 2     |
| 2   | Confirmation context threaded by hand ×7      | structural `PendingCtx`                | 6     |
| 3   | `read` rebuilds batch order and summary       | budget skips become batch items        | 3     |
| 4   | Per-request dispose hook copied, and missed   | `createServer` owns `onclose`          | 7     |
| 5   | Listen cap pre-check exists only on HTTP      | move into `prepareListenWatchers`      | 3     |
| 6   | Hidden `maxDepth ?? 100` default              | one meaning for an omitted depth       | 1     |
| 7   | `tools/list` budget counts dead schemas       | lower ceilings, drop the vacuous assert | 1     |
| 8   | `skipIgnored: false` contradicts ADR-001      | amend ADR-001 (write-adr)              | 1     |

## 1. Completion uses the containment set as roots

- **Now:** `src/core/path-completer.ts:188` reads `getAllowedDirectories()`.
  It picks the root at `:175` (`if (allowed.length === 1)`) and lists roots
  at `:192`. That set holds each root's realpath alias too. When one root is
  reached through a symlink, a junction, or an 8.3 short name, relative
  completion returns nothing, and an empty value lists the root twice. The
  pricer reproduced this with a junction-aliased root.
- **Rests on:** `src/core/path.ts:201-204` and `:255-259` say `getRoots()` is
  the list for "a caller choosing the root". Commit `797b8aef` moved the other
  callers to `getRoots()`. `plans/011` lists `path-completer` as
  containment-only and says "Do not change any of them". That entry missed the
  root pick at `:175`, so it is reopened here.
- **Move:** `suggestPaths` reads `getRoots()` to pick, name, and list roots. It
  keeps `getAllowedDirectories()` only for `findMatchesInDirectory` and
  `isAllowedCompletionDirectory`.
- **Size:** about +1 line. Files: `src/core/path-completer.ts`, plus a
  completion case in `__tests__/aliased-root.test.ts`, which is skipped where
  symlinks are not allowed.
- **Rejected:** deduplicating aliases inside `getAllowedDirectories()`.
  `precheckAccess`, grant verification, and the symlink ancestor walk need both
  spellings, so this would reopen the escape surface that plan 011 closed.

## 2. Confirmation context threaded by hand at seven sites

- **Now:** the same four fields (`requestState`, `droppedInputResponseKeys`,
  `clientCapabilities`, `serverCtx`) are passed one by one at four
  `pendingRoundTrip` sites: `src/tools/create.ts:155-158`,
  `src/tools/delete.ts:310-313`, `src/tools/move.ts:320-323`, and
  `src/tools/define.ts:319-322`. `describeRefusal(responses, key, dropped)`
  appears at three more sites, in create, delete, and move.
- **Rests on:** `src/core/input-required.ts:183-184` ("One home ... a future
  fix cannot miss two of three sites"). Commits `b69e5333`, `5b5b8d75`, and
  `4c0b4c3e` each spread one field to every site, and `plans/049:272` had a
  step only for threading a field.
- **Move:** declare a structural `PendingCtx` in `input-required.ts`.
  `pendingRoundTrip` and `describeRefusal(ctx, key)` take it. `ToolCtx`
  satisfies it, so core imports nothing from tools. Callers keep sorting the
  pending set.
- **Open:** the two pricers disagreed on whether to add `readPendingChoice`.
  One found that its `'proceed' | 'skip' | refusal text` union mixes two kinds
  of string and saves about one line per site.
- **Size:** about −10 lines. Files: `input-required.ts`, create, delete, move,
  define, and `__tests__/input-required.test.ts` (13 calls, which must change
  in the same commit). Refusal text must stay byte-identical, because
  `tools.test.ts` pins it.

## 3. `read` rebuilds batch order and summary

- **Now:** `src/tools/read.ts:394-422` splits the budget-skipped paths from
  the surviving paths. It special-cases an empty survivor list, because
  `src/tools/batch.ts:19-23` rejects one. It then re-orders the results by
  path and recounts the summary. `src/tools/delete.ts:364-367` recounts the
  summary too.
- **Rests on:** `README.md:324`, which says `batch.ts` owns the batch result.
- **Move:** `collectFileBudget` returns one item per requested path, each with
  an optional `skip`, and every item goes through `runOverPaths`. A
  `summarize()` export from `batch.ts` is shared with `delete`. `delete` keeps
  `processInParallel`, because its confirmation round must finish before
  anything is deleted (R14).
- **Visible changes:** a budget-skipped `TOO_LARGE` result gains the default
  suggestion text, and the progress total counts every requested path. No test
  pins either.
- **Size:** about −28 lines. Files: `read.ts`, `batch.ts`, `delete.ts`.

## 4. Per-request dispose hook copied, and missed

- **Now:** the `previousOnClose ... disposeRuntimeState()` hook is at
  `src/transport/http.ts:330-334`, and is copied at
  `__tests__/input-required.test.ts:98` and `:577`. The harness factories in
  `__tests__/helpers.ts:297-312` and `__tests__/cli.test.ts:125` leave it out.
  `src/resources.ts:302-305` says that without it nothing else ends those
  leases.
- **Move:** `createServer` sets `onclose` to dispose its own state and chains
  any previous handler. Remove the explicit `disposeRuntimeState()` only at
  teardowns where the server is connected: `helpers.ts:180`,
  `progress.test.ts:154`, `roots-seeding.test.ts:42`, and
  `tools.test.ts:1467`. Keep it on paths that never connect, because `close()`
  without a transport never fires `onclose`: `stdio.ts:145`,
  `capabilities.test.ts:74`, `core-fs.test.ts:39`, and `resources.test.ts:747`.
- **Size:** about −14 lines across 7 files. `disposeRuntimeState` is
  idempotent (`src/server.ts:196`), so each file can land on its own and stay
  green.

## 5. Listen cap pre-check exists only on HTTP

- **Now:** `src/transport/http.ts:203-221` checks capacity before the ack.
  stdio (`src/transport/stdio.ts:319`) does not. It reaches the cap late,
  after creating and tearing down watchers, and its wording differs.
- **Rests on:** `src/transport/shared.ts:3-4`, "only where the lease is
  released differs".
- **Move:** move the pre-check, with the HTTP wording, to the top of
  `prepareListenWatchers` as an early `{ ok: false, message }`. HTTP drops its
  inline block and its `MAX_WATCHERS` import. Update the row in
  `docs/plan/2026-09-15-sdk-listen-hook/deletion-map.md:15`. Add an over-cap
  test for both legs, because neither leg has one today.
- **Size:** about −10 lines. Files: `shared.ts`, `http.ts`, deletion map, and
  tests.

## 6. Hidden `maxDepth ?? 100` default

- **Now:** `src/core/search.ts:351` and `:508` have
  `maxDepth: options.maxDepth ?? 100`. `replace_text` forwards an omitted
  `maxDepth` as unbounded (`src/tools/replace-text.ts:497`). The schema caps an
  explicit value at `MAX_SEARCH_DEPTH = 100` (`src/core/schema.ts:126`,
  `src/core/util.ts:152`).
- **Rests on:** `src/core/schema.ts:128` ("omit for unlimited"), and the parity
  comment at `search.ts:344-346`, which says a search previews what a replace
  would touch.
- **Move:** depends on the maxDepth decision ticket. Either forward
  `maxDepth` only when it is set (unlimited everywhere), or apply
  `MAX_SEARCH_DEPTH` in all three walks and reword the schema.
- **Size:** net 0 lines with 1 file, or 3 files with the shared cap.

## 7. `tools/list` budget counts dead schemas

- **Now:** the comment at `__tests__/tools.test.ts:3290-3297` still accounts
  for output schemas, which `src/tools/define.ts:411` stopped publishing. The
  ceilings are 26,900 and 12,000 characters (`:3305-3306`). Measured sizes are
  18,154 (full) and 8,950 (read-only), so a regression of 48% would pass.
- **Rests on:** the test's own rule at `:3287-3288`: lower the ceiling when
  weight is removed.
- **Move:** set the ceilings to about 18,500 and 9,200, rewrite the comment as
  a baseline after `f9199c80`, and delete the vacuous `outputSchema?.$defs`
  assert at `:606-610`.
- **Size:** about −17 lines, 1 test file. Measure again after any other batch
  that changes tool descriptions.

## 8. `skipIgnored: false` contradicts ADR-001

- **Now:** `src/tools/move.ts:443` passes `skipIgnored: false` inside
  `assertTreeHasNoProtectedEntries`. ADR-001 line 46 says the only form a call
  site may take is `skipIgnored: !args.includeIgnored`. The code is right: a
  protection walk must see ignored trees. Plan 042 wrote this line without
  arguing with the ADR.
- **Move:** amend ADR-001 through write-adr. Line 46 applies to tools that
  translate their public `includeIgnored` input. A dated amendment names the
  move protection walk as an internal exception.
- **Size:** documentation only, about +4 lines.
