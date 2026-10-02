---
kind: frontier-ticket
id: T-14
title: "Why does search.ts cap an omitted maxDepth at 100, and what does an unbounded walk risk?"
map: M-01
status: closed
type: research
priority: 100
blocked_by: []
claimed:
---

Map: [Fix the 2026-10-02 architecture audit findings](../arch-audit-followups.map.md)

## Question

Find the facts that the maxDepth decision waits on: why `searchContent` and `searchFiles` turn an omitted `maxDepth` into 100, and what an unbounded `fs.glob` walk would risk if the default went away.

## Research context

- Unblocks: [Should an omitted maxDepth mean unlimited or a shared cap?](T-12-should-an-omitted-maxdepth-mean-unlimited-or-a-shared-cap.md).
- Starting sources:
  - `src/core/search.ts:351` and `:508` (`?? 100`); `src/core/glob.ts` around `:409` and `:432` (`createWalkFilter`, where depth is pruned only when `maxDepth` is defined and no filter is built when `skipIgnored` is false).
  - `src/core/util.ts:152` (`MAX_SEARCH_DEPTH`), `src/core/schema.ts:126-128`, `src/tools/replace-text.ts:497`.
  - `git log -S "?? 100" -- src` and commit `36b61a28`; `plans/` and `docs/plan/` for any record of the cap.
  - Node 24 `fs.glob` / `fsPromises.glob` docs on following symlinked directories and on cycles.
- Scope: why the cap was introduced, whether it was ever recorded as deliberate, whether `fs.glob` follows directory symlinks (the cycle risk), and what bounds a walk when `includeIgnored` is true. No code changes.
- Evidence: `file:line` for repo claims, commit hashes for history, and a nodejs.org URL for `fs.glob` behaviour.

## Resolution

The 100 cap was never recorded as a deliberate decision. It does not guard against symlink cycles, because Node 24's `fs.glob` cannot loop on one. In practice, walks are bounded by the cooperative 5 s deadline and the result caps, and depth plays no part.

- **Origin:** `git log -S "maxDepth ?? 100" -- src` returns a single commit, `71fb2074` (2026-06-30, "Cleanup and refactor"). That same commit deleted `DEFAULT_SEARCH_MAX_FILES` (20,000), `maxFilesScanned`, and `withTimedAbortSignal`. The 100 looks like a stand-in for those bounds, and the commit gives no reason for it. Commit `36b61a28` only renamed `search/engine.ts`. `MAX_SEARCH_DEPTH = 100` (`src/core/util.ts:152`, from `aa771dce`) is the schema's upper limit only (`src/core/schema.ts:126`). Since `f60ea228` (2026-06-14) the schema has said "omit for unlimited" (`:128`), so the contract and the code have disagreed since 2026-06-30. No plan or ADR records the cap.
- **Walk bounds in `glob.ts`:** when `skipIgnored` is false and `maxDepth` is undefined, no filter is built (`src/core/glob.ts:409`). `fs.glob` then gets no `exclude` (`:449-453`), so nothing is pruned. Depth pruning applies only when `maxDepth` is defined (`:432-433`). The `signal` reaches only the `.gitignore` discovery step; it is never passed to `fs.glob`. Because of the cap, `search_text` and `find_files` always build a filter, even with `includeIgnored: true`, and that filter prunes almost nothing.
- **Symlinks:** Node v24.15.0's `internal/fs/glob` expands `**` into a child only when `!fromSymlink && entry.isDirectory()`, so `**` never recurses through a symlink or a junction. A Windows junction loop gave finite results for `**`, `**/*`, and `**/.*/**`; `**/*` went exactly one level into the link. The docs (https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesglobpattern-options) say nothing about symlinks. Neither `glob.ts` nor `search.ts` skips symlinked directories itself.
- **`replace_text`:** it forwards `maxDepth` only when the caller set it (`src/tools/replace-text.ts:497`), so it is unbounded today. Its bounds are `maxResults` (default 100), the optional `maxFiles`, and the 5 s deadline. No test, changelog entry, or plan records a problem with this.
- **Other bounds:** the deadline is `DEFAULT_SEARCH_TIMEOUT_MS = 5000` (`src/core/util.ts:143`, wired in at `src/tools/define.ts:230-231`). It is cooperative only: `run` is awaited without a race (`define.ts:375`), and the signal is checked once per yielded entry (`src/core/concurrency.ts:124-128`). `MAX_SEARCH_RESULTS` is 10,000 (`util.ts:150`).

**Synthesis:** the inconsistency is an accident, not a design. The two options differ in contract and code shape, not in safety.

**Material uncertainty:**

- The intent of `71fb2074` is inferred from what its diff deletes.
- Symlink behaviour was verified on Windows junctions and v24.15.0 source only, not on POSIX symlinks. It is undocumented and could change in a later Node release.
- A walk that yields nothing can overrun the deadline under either option. That hazard is outside this map's destination.

Citations re-opened and checked by the parent session: `71fb2074`, `glob.ts:409/432-433/449-453`, `util.ts:143/150/152`, `define.ts:230-231/375`, `schema.ts:123-128`, `concurrency.ts:124-128`.
