# Unify reads, file classification, and paged-scan consolidation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the file-classification/guarded-read seam (Candidate 1) and the Scan/Glob/paged-tool seam (Candidate 2) without changing any MCP wire contract or observable client behavior (except the intended UTF-16 `resources/read` base64 fix and unified binary classification).

**Architecture:**
- **Candidate 1 (hybrid C1-C + C1-A):** `src/core/mime.ts` folds `EXTRA_BINARY_EXTENSIONS` into `EXT_MAP` and treats UTF-16 byte-order marks as binary in `isBinarySample`. `GuardedFileSystem` (`src/core/fs.ts`) becomes the sole owner of all guarded reads via three methods (`read`, `readText`, `readNamedText`), using a typed `slice` (`head | tail | range`) vs full `binary?: 'refuse' | 'media' | 'allow' | 'raw'` and an optional `beforeBody` check run after `fstat` + 512-byte classification. `src/core/read.ts` becomes strictly internal to `src/core/fs.ts`; `countLines` moves to `src/core/fmt.ts`, and `createTooLargeError`, `BINARY_FILE_MESSAGE`, `NOT_UTF8_MESSAGE`, `binaryRefusal`, and `isBinaryRefusal` move to `src/core/errors.ts`.
- **Candidate 2 (hybrid C2-C + C2-A):** `isSafeGlobSyntax` and its three cap constants (`MAX_BRACE_ALTERNATIVES`, `MAX_DOTDOT_CHECK_CHARS`, `MAX_SEGMENT_WILDCARDS`) move from `src/core/glob.ts` into `src/core/schema.ts`, making `glob.ts` strictly internal to `src/core/scan.ts`. `ScanOptions` gains `includeSizes?: boolean` so `scan` `lstat`s admitted regular files once (`ScanEntry.size`), eliminating `src/tools/list.ts`'s second per-file `fs.stat` pass. `searchContent` (`src/core/search.ts`) accepts `fs: GuardedFileSystem` directly and reads via `fs.readText`, while `clipLine` and `MAX_MATCH_LINE_CHARS` move to `src/core/fmt.ts`. `src/tools/paged-scan.ts` owns `pagedScan` (defaulting `pageSizeField = 'maxResults'`, `allowFile = false`, `scopeSignal = false`, and attaching `nextCursor`, `resourceUri`, and `resources`), unifying `list.ts`, `find-files.ts`, and `search-text.ts`.

**Tech Stack:** TypeScript (Node, ESM `.ts` imports), Node built-in test runner, `zod/v4`.

**Spec:** [GLOSSARY.md](../../../GLOSSARY.md) (**File class**, **Scan**, **Text view**, **Mark**), [ADR-005](../../adr/005-one-scan-rule-for-every-walking-tool.md) (2026-11-13 Addendum), [ADR-015](../../adr/015-guarded-filesystem-owns-reads-and-classification.md), and [ADR-016](../../adr/016-paged-scan-and-scan-seam.md).

## Global Constraints

- Zero advertised MCP contract change: `__tests__/contract.test.ts` snapshot must remain identical.
- Preserve UTF-16 refusal on the `read` tool: even when `binary: true`, `tools/read.ts` still rejects UTF-16 files with `ErrorCode.INVALID_INPUT` and `"UTF-16 text file detected; convert it to UTF-8 first."`.
- `resources/read` serves UTF-16 files as a base64 `blob` (`mimeType: 'application/octet-stream'`) instead of lossy UTF-8 text.
- `.svg` dual rule stays intact: full `read` and `resources/read` treat `.svg` as `kind: 'image'` (`image/svg+xml`), while `readText` / `readNamedText` (**Scan**, **Rewrite**, `diff`) accept UTF-8 `.svg` as text (`isKnownBinaryExtension` excludes `'svg'`).
- Never hand-edit version fields in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, or `.cursor-plugin/plugin.json`.
- Verification gate after each task (or cohesive group): targeted tests first, then `npm run check` (static + full suite) at each milestone, and `graphify update .` after completing code edits.

---

## File Structure

- **Candidate 1 (`mime`, `fmt`, `errors`, `read`, `fs`, `tools/read`, `resources`, `diff`, `rewrite`, `scan`)**:
  - Modify: `src/core/mime.ts`, `src/core/fmt.ts`, `src/core/errors.ts`, `src/core/read.ts`, `src/core/fs.ts`, `src/core/scan.ts`, `src/core/rewrite.ts`, `src/core/file-uri.ts`, `src/tools/read.ts`, `src/tools/diff.ts`, `src/tools/patch.ts`, `src/resources.ts`.
  - Migrate tests: `__tests__/core-fs.test.ts`, `__tests__/resources.test.ts`, `__tests__/read.test.ts`, `__tests__/scan.test.ts`, `__tests__/read-only-roots.test.ts`.
- **Candidate 2 (`schema`, `glob`, `fmt`, `scan`, `search`, `paged-scan`, `list`, `find-files`, `search-text`)**:
  - Create: `src/tools/paged-scan.ts`.
  - Modify: `src/core/schema.ts`, `src/core/glob.ts`, `src/core/fmt.ts`, `src/core/scan.ts`, `src/core/search.ts`, `src/tools/define.ts` (export `RunResult` if needed), `src/tools/patch.ts`, `src/tools/list.ts`, `src/tools/find-files.ts`, `src/tools/search-text.ts`.
  - Migrate tests: `__tests__/glob.test.ts`, `__tests__/path-guard-unc.test.ts`, `__tests__/scan.test.ts`, `__tests__/search.test.ts`, `__tests__/search-literal.test.ts`, `__tests__/core-fs.test.ts`, `__tests__/list.test.ts`, `__tests__/patch.test.ts`, `__tests__/search-text.test.ts`, `__tests__/outbound-regressions.test.ts`.

---

### Task 1: Relocate shared pure helpers (`countLines`, `createTooLargeError`, binary errors, `clipLine`)

**Files:**
- Modify: `src/core/fmt.ts`, `src/core/errors.ts`, `src/core/read.ts`, `src/core/search.ts`, `src/core/file-uri.ts`, `src/core/rewrite.ts`, `src/tools/patch.ts`, `src/tools/read.ts`
- Tests to update imports: `__tests__/patch.test.ts`, `__tests__/search-text.test.ts`, `__tests__/outbound-regressions.test.ts`

- [ ] **Step 1: Move `countLines`, `MAX_MATCH_LINE_CHARS`, and `clipLine` into `src/core/fmt.ts`**
  - Export `countLines(content: string): number` in `src/core/fmt.ts`.
  - Move `MAX_MATCH_LINE_CHARS = 1000` and `clipLine(line: string, column: number): string` from `src/core/search.ts` to `src/core/fmt.ts`.
- [ ] **Step 2: Move `createTooLargeError`, `BINARY_FILE_MESSAGE`, `NOT_UTF8_MESSAGE`, `binaryRefusal`, and `isBinaryRefusal` into `src/core/errors.ts`**
  - Preserve exact error messages, codes, hints, and `Cause` forwarding.
  - Keep internal helper imports inside `src/core/read.ts` and `src/core/fs.ts` pointing at `errors.ts` and `fmt.ts` (no re-export barrel).
- [ ] **Step 3: Re-wire pure helper imports and tests**
  - Update `src/core/file-uri.ts` (`countLines` from `./fmt.ts`), `src/tools/patch.ts` (`countLines` and `clipLine` from `../core/fmt.ts`), `src/core/rewrite.ts` (`createTooLargeError` from `./errors.ts`), and `src/core/search.ts` (`clipLine` from `./fmt.ts`).
  - Update `MAX_MATCH_LINE_CHARS` imports in `__tests__/patch.test.ts`, `__tests__/search-text.test.ts`, and `__tests__/outbound-regressions.test.ts` to import from `../src/core/fmt.ts`.
- [ ] **Step 4: Run `npm run check:static` and affected unit tests (`patch`, `search-text`, `outbound-regressions`)**

---

### Task 2: Unify binary & UTF-16 classification in `src/core/mime.ts`

**Files:**
- Modify: `src/core/mime.ts`
- Check callers: `src/tools/stat.ts`, `src/tools/read.ts`, `src/core/file-uri.ts`, `src/tools/create.ts`, `src/core/read.ts`, `src/core/scan.ts`
- Tests: `__tests__/mime.test.ts` (if present, or add/extend tests covering unified `EXT_MAP` + UTF-16 BOM in `isBinarySample` and `detectMimeType`)

- [ ] **Step 1: Write failing tests for unified `mime.ts` rules**
  - Verify `isBinarySample(Buffer.from([0xff, 0xfe, 0x61, 0x00])) === true` and BE `0xfe 0xff` `=== true`.
  - Verify `detectMimeType('archive.bin', Buffer.from('hello'))` returns `{ mimeType: 'application/octet-stream', kind: 'binary' }`.
  - Verify `detectMimeType('notes.txt', Buffer.from([0xff, 0xfe, 0x61, 0x00]))` classifies as `{ mimeType: 'application/octet-stream', kind: 'binary' }` (not text), while `detectMimeType('notes.txt')` without sample stays `'text/plain'`.
- [ ] **Step 2: Implement unified `EXT_MAP` and UTF-16 BOM binary probe in `src/core/mime.ts`**
  - Fold `EXTRA_BINARY_EXTENSIONS` entries into `EXT_MAP` (`{ mimeType: 'application/octet-stream', kind: 'binary' }`, keeping `mp4` and media types accurate; check existing tests so `.bin`, `.dat`, `.sqlite`, etc. keep exact expected MIME types).
  - Derive `KNOWN_BINARY_EXTENSIONS` from `Object.entries(EXT_MAP)` (`kind !== 'text'`, excluding `'svg'`).
  - Include `hasUtf16Bom(slice)` inside `isBinarySample(slice)`.
  - Ensure `detectMimeType(path, sample?)` checks `isBinarySample` for text extensions when `sample` is supplied so `.txt`/`.md`/`.json` holding binary/UTF-16 probes classify as `{ mimeType: 'application/octet-stream', kind: 'binary' }`.
- [ ] **Step 3: Run static check and mime/read tests**

---

### Task 3: Consolidate single-open `read`, `readText`, and `readNamedText` onto `GuardedFileSystem`

**Files:**
- Modify: `src/core/fs.ts`, `src/core/read.ts` (make strictly internal to `fs.ts` or merge private helpers), `src/core/scan.ts` (remove `readText`, `readNamedText`, `TextVerdict` exports), `src/core/rewrite.ts`, `src/tools/diff.ts`
- Tests to migrate: `__tests__/core-fs.test.ts`, `__tests__/scan.test.ts`, `__tests__/read-only-roots.test.ts`

- [ ] **Step 1: Define the unified `GuardedFileSystem` read interface in `src/core/fs.ts`**
  - Export `ReadSlice`, `BinaryPolicy = 'refuse' | 'media' | 'allow' | 'raw'`, `ReadProbeMeta`, `ReadOptions` (discriminated or typed so `slice` and `binary: 'raw'` cannot conflict cleanly, with optional `beforeBody?: (meta: ReadProbeMeta) => void`), `ReadResult` (`ReadTextResult | ReadBytesResult`), `TextVerdict` (carrying `validPath` on `'text'` and `'undecodable'`), `ReadTextOptions`, `ReadNamedTextOptions`, `NamedTextResult`.
  - Add three methods on `GuardedFileSystem`:
    - `read(filePath: string, options?: ReadOptions): Promise<ReadResult>` (single open + `fstat` + `readProbe` + `detectMimeType` + binary/UTF-16 policy + optional `beforeBody` + bounded body or line slice).
    - `readText(filePath: string, options?: ReadTextOptions): Promise<TextVerdict>` (single open, early bailout on `isKnownBinaryExtension` and binary/UTF-16 probes, EOF-capable bounded read, full-buffer `isUtf8` + NUL check, returns `{ kind: 'text' | 'undecodable', validPath, bytes, stats }` or `'binary'` / `'tooLarge'`).
    - `readNamedText(filePath: string, options?: ReadNamedTextOptions): Promise<NamedTextResult>` (calls `this.readText` and maps non-text verdicts via `refusalOf` using `tool` label).
  - Remove `GuardedFileSystem.readRaw` and `GuardedFileSystem.readFile`.
- [ ] **Step 2: Keep `src/core/read.ts` internal to `fs.ts`**
  - Stop importing `core/read.ts` outside `src/core/fs.ts`. Update `src/tools/read.ts` to import types from `core/fs.ts` and `BINARY_FILE_MESSAGE` / `isBinaryRefusal` / `createTooLargeError` from `core/errors.ts`.
  - Remove `readText`, `readNamedText`, `TextVerdict`, and unused probe/read helpers from `src/core/scan.ts` (keeping `ScanSkip`, `SkipVerdict`, `skipOf`, `refusalOf`, `probeDirectory`).
- [ ] **Step 3: Migrate `src/core/rewrite.ts` and `src/tools/diff.ts` to `fs.readText` / `fs.readNamedText`**
- [ ] **Step 4: Replace obsolete tests in `__tests__/scan.test.ts` and `__tests__/core-fs.test.ts` and `__tests__/read-only-roots.test.ts`**
  - Replace `readNamedText(fs, ...)` / `readText(fs, ...)` tests in `__tests__/scan.test.ts` with `fs.readNamedText(...)` / `fs.readText(...)` tests in `__tests__/core-fs.test.ts` (replace, do not duplicate).
  - Migrate all `fs.readRaw(...)` assertions in `__tests__/core-fs.test.ts` and `__tests__/read-only-roots.test.ts` to `fs.read(path, { binary: 'raw' })`, and migrate `__tests__/core-fs.test.ts`'s `readFileBufferWithLimit` / `readFileWithStats` unit tests onto `GuardedFileSystem.read`.
- [ ] **Step 5: Run targeted suites (`core-fs`, `scan`, `diff`, `edit`, `patch`, `rewrite`) + `npm run check:static`**

---

### Task 4: Migrate `src/tools/read.ts` and `src/resources.ts` to single-open `GuardedFileSystem.read`

**Files:**
- Modify: `src/tools/read.ts`, `src/resources.ts`
- Tests to migrate: `__tests__/read.test.ts`, `__tests__/resources.test.ts`

- [ ] **Step 1: Update `src/resources.ts` (`createFilesystemResource.read`)**
  - Replace pre-`fs.stat(...)` + `fs.readRaw(...)` with one `fs.read(rawPath, { binary: 'raw', signal: ctx.mcpReq.signal, beforeBody })` call.
  - Inside `beforeBody`, check `readFloorOver(options.transport, stats.size, fileKind !== 'text')` so oversized `stdio` reads (including UTF-16 binary blobs) still reject before buffering the body.
  - Serve UTF-16 files (`fileKind === 'binary'`) as base64 `blob` with `mimeType: 'application/octet-stream'`.
- [ ] **Step 2: Update `src/tools/read.ts` (`readOnePath` and `budgetBytes`)**
  - Replace `detectMimeType` media pre-branch and `readFile`-then-`catch`-`readRaw` fallback with one `ctx.fs.read(filePath, ...)` call (`binary: isRangeRead ? 'refuse' : args.binary ? 'allow' : 'media'`).
  - Keep batch `collectFileBudget` pre-flight sizing using unified `detectMimeType(path)`.
  - Preserve exact error behavior: UTF-16 fails with `INVALID_INPUT` even when `binary: true`, while binary refusal messages on `read` and range reads match existing assertions.
- [ ] **Step 3: Migrate tests in `__tests__/resources.test.ts` and `__tests__/read.test.ts`**
  - Update `__tests__/resources.test.ts:417, 439` from mocking `GuardedFileSystem.prototype.readRaw` to `GuardedFileSystem.prototype.read` (verifying `beforeBody` + single open + `signal` forwarding).
  - Add a resource read test verifying a UTF-16 BOM file (`.txt`) serves as a base64 `blob` via `resources/read`, while `__tests__/read.test.ts:224-231` continues rejecting UTF-16 under `binary: true`.
  - Update `__tests__/read.test.ts:300` subclass hook from `override async readFile` to `override async read`.
- [ ] **Step 4: Run `__tests__/read.test.ts`, `__tests__/resources.test.ts`, and `npm run check:static`**

---

### Task 5: Decouple `schema.ts` from `glob.ts`, isolate `glob.ts` behind `scan.ts`, and inject `fs` into `searchContent`

**Files:**
- Modify: `src/core/schema.ts`, `src/core/glob.ts`, `src/core/scan.ts`, `src/core/search.ts`, `src/core/path.ts` (comment cleanup if referencing internal `glob.ts`)
- Tests to update: `__tests__/glob.test.ts`, `__tests__/search.test.ts`, `__tests__/search-literal.test.ts`, `__tests__/core-fs.test.ts`, `__tests__/scan.test.ts`, `__tests__/path-guard-unc.test.ts`

- [ ] **Step 1: Move `isSafeGlobSyntax` and its constants to `src/core/schema.ts`**
  - Move `MAX_BRACE_ALTERNATIVES`, `MAX_DOTDOT_CHECK_CHARS`, `MAX_SEGMENT_WILDCARDS`, and `isSafeGlobSyntax` (plus its private regex/brace helpers) from `src/core/glob.ts` into `src/core/schema.ts`.
  - Remove the `./glob.ts` import from `src/core/schema.ts`.
  - Leave `glob.ts` focused purely on traversal for `src/core/scan.ts` (`globEntries`, `foldPatternCase`, `GitignoreManager`).
- [ ] **Step 2: Add `ScanOptions.includeSizes?: boolean` and `ScanEntry.size?: number` to `src/core/scan.ts`**
  - When `includeSizes` is `true`, capture `lstat` size once per admitted regular file (`type === 'file'`) before invoking `onEntry` (and for explicit named files in `scanNamedFile` when `stats.isFile()`).
  - Non-abort `lstat` failures omit `size` rather than dropping the entry; `signal.aborted` during `lstat` cuts the scan cleanly (`stoppedReason: 'timeout'`).
- [ ] **Step 3: Inject `fs: GuardedFileSystem` into `searchContent` (`src/core/search.ts`)**
  - Update `searchContent(scope, pattern, options, fs: GuardedFileSystem)` to remove internal `new GuardedFileSystem(pathGuard)` construction, call `fs.readText(entryPath, { signal })`, and use `fs.pathGuard` for `scan`.
- [ ] **Step 4: Migrate tests**
  - Update `__tests__/glob.test.ts` so `isSafeGlobSyntax` tests import from `../src/core/schema.ts` (and evaluate whether `glob.test.ts` / `path-guard-unc.test.ts` traversal checks stay internal or test through `scan` / `FIND_FILES` per replace-don't-layer).
  - Update `searchContent(...)` callers in `__tests__/search.test.ts`, `__tests__/search-literal.test.ts`, and `__tests__/core-fs.test.ts` to pass `new GuardedFileSystem(guard)` / `fs`.
  - Add direct `includeSizes: true` tests in `__tests__/scan.test.ts` (regular files carry `size`, directories/symlinks omit `size`, mid-scan abort during size `lstat` returns `stoppedReason: 'timeout'`).
- [ ] **Step 5: Run `scan`, `glob`, `search`, `search-literal`, and `path-guard-unc` tests + `npm run check:static`**

---

### Task 6: Extract `src/tools/paged-scan.ts` and migrate `list.ts`, `find-files.ts`, and `search-text.ts`

**Files:**
- Modify: `src/tools/define.ts` (export `RunResult<T>`), `src/tools/list.ts`, `src/tools/find-files.ts`, `src/tools/search-text.ts`
- Create: `src/tools/paged-scan.ts`
- Tests: `__tests__/list.test.ts`, `__tests__/find-files.test.ts`, `__tests__/search-text.test.ts`

- [ ] **Step 1: Implement `src/tools/paged-scan.ts`**
  - Export `pagedScan(options)` implementing the hybrid C2-C + C2-A interface:
    - Defaults: `pageSizeField = 'maxResults'`, `allowFile = false`, `scopeSignal = false`.
    - Sequence: `ctx.fs.pathGuard.resolvePathOrRoot(args.path)` -> `pageQueryKey(tool, { ...args, path: resolvedPath }, ['cursor', pageSizeField])` -> `paginate(...)`.
    - On cache miss: `resolveScanScope(resolvedPath, ctx.fs, { allowFile, ...(scopeSignal ? { signal: ctx.signal } : {}) })`, derive `paths = ctx.fs.pathGuard.resultPaths(scope.root)`, run `produce({ scope, paths, fs: ctx.fs, signal: ctx.signal, onProgress: ctx.onProgress })`, externalize via `putJsonResource`.
    - Build `trailer` from `PagedScanMeta`, invoke `render({ page, metadata, offset, trailer, resourceUri })`, automatically merge `nextCursor` / `resourceUri` onto `structured` and attach `resources: paged.resource ? [paged.resource.link] : []` (or omit when empty if matching `list.ts`).
- [ ] **Step 2: Migrate `src/tools/list.ts`, `src/tools/find-files.ts`, and `src/tools/search-text.ts`**
  - **`list.ts`**: pass `includeSizes: wantSizes` into `scan()`, remove `options.fs.stat(...)` and `withAbort` per-file size logic from `collect()`, remove `fs` from `CollectOptions` (uses `pathGuard` only), and drive `LIST.run` via `pagedScan` with `pageSizeField: 'maxEntries'`.
  - **`find-files.ts`**: keep `keepFirstResults` exported for `__tests__/find-files.test.ts`; drive `FIND_FILES.run` via `pagedScan`.
  - **`search-text.ts`**: drive `SEARCH_TEXT.run` via `pagedScan` with `allowFile: true` and `scopeSignal: true`, passing `fs` directly to `searchContent`.
- [ ] **Step 3: Update `__tests__/list.test.ts:474`**
  - Replace the `GuardedFileSystem.prototype.stat` deadline hook with `lstat` hook or `scan` timeout test covering `includeSizes: true` (replace-don't-layer).
- [ ] **Step 4: Run `list`, `find-files`, `search-text`, and `contract` tests**

---

### Task 7: Final verification and knowledge graph sync

- [ ] **Step 1: Verify `__tests__/contract.test.ts` is clean without snapshot updates**
- [ ] **Step 2: Run full repository check: `npm run check`** (static checks + full Node test suite + `dist-smoke` if `dist/` built cleanly)
- [ ] **Step 3: Run `graphify update .` to refresh `graphify-out/`**
- [ ] **Step 4: Verify no unintended diffs or leftover exports (`src/core/read.ts` unused externally, `schema.ts` free of `glob.ts`, `tools/patch.ts` free of `search.ts`)**
