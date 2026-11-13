# ADR-016: Paged tool scans live in `src/tools/paged-scan.ts`; `glob.ts` stays internal to Scan

**Status**: accepted, 2026-11-13
**Deciders**: j0hanz, in the architecture review of Candidate 2 (Scan, Glob & Paged-Scan Consolidation)

## Context

Three paged scanning tools (`list`, `find_files`, `search_text`) duplicated the exact cursor lifecycle (`resolvePathOrRoot`, `pageQueryKey`, `paginate`, `resolveScanScope`, `resultPaths`, `pageTrailer`, and cursor/resource output plumbing). Meanwhile, `list.ts` re-called `fs.stat` on every file already admitted by **Scan**, `core/schema.ts` imported `isSafeGlobSyntax` from `core/glob.ts`, `tools/patch.ts` imported `clipLine` from `core/search.ts`, and `searchContent` constructed `new GuardedFileSystem(pathGuard)` internally instead of accepting `GuardedFileSystem`.

## Decision

- **`src/tools/paged-scan.ts`** owns `pagedScan`. It resolves `args.path` via `resolvePathOrRoot` before snapshot lookup, computes `pageQueryKey`, gates `resolveScanScope` and `resultPaths` behind cache misses (with `scopeSignal` defaulting to `false` so expired deadlines still reach `scan`), externalizes incomplete first pages, builds `pageTrailer`, and attaches `nextCursor`, `resourceUri`, and `resources`. It lives in `src/tools/` so `core/scan.ts` and `core/cursor.ts` remain free of tool arguments and Markdown formatting.
- **Single-pass file sizes (`src/core/scan.ts`)**: `ScanOptions.includeSizes?: boolean` captures `lstat` size once per admitted regular file onto `ScanEntry.size`, eliminating per-file `fs.stat` calls in `tools/list.ts`.
- **Internal `glob.ts` and separated pure helpers**: `isSafeGlobSyntax` and its three cap constants (`MAX_BRACE_ALTERNATIVES`, `MAX_DOTDOT_CHECK_CHARS`, `MAX_SEGMENT_WILDCARDS`) move to `src/core/schema.ts`, making `src/core/glob.ts` strictly internal to `src/core/scan.ts`. `clipLine` and `MAX_MATCH_LINE_CHARS` move from `src/core/search.ts` to `src/core/fmt.ts`.
- **Injected `GuardedFileSystem` in `searchContent` (`src/core/search.ts`)**: `searchContent(scope, pattern, options, fs)` accepts `fs: GuardedFileSystem` and reads via `fs.readText`.

## Considered options

- **Declarative formatting slots (`summaryLine`, `trailerGap`, `afterTrailer`) in `paged-scan.ts`.** Rejected: over-fits single-tool text layout (`list`'s total-bytes line) at the cost of eight interface types.
- **Merge `core/search.ts` into `tools/search-text.ts` or let `paged-scan` return raw `trailer` only.** Rejected: inlining `searchContent` drops direct unit coverage of **Match plan** + **Scan** skip accounting; leaving `nextCursor`/`resourceUri` attachment to each caller wastes three copies of identical boilerplate.

## Consequences

- `list`, `find_files`, and `search_text` share one paging/scope/trailer invariant, fixing `search_text`'s double `resolvePathOrRoot` call.
- `core/schema.ts` no longer depends on directory traversal code in `core/glob.ts`, and `tools/patch.ts` no longer depends on `core/search.ts`.
- No wire schema or tool description changes; `__tests__/contract.test.ts` stays unchanged.
