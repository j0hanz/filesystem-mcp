# Plan: Every file-changing tool call can be reverted with a new `undo` tool

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `797a7deb`, 2026-10-22, branch `feat/undo-tool`.
> **Drift check (run first)**: `git diff --stat 797a7deb..HEAD -- src __tests__ mcpb README.md docs/configuration.md docs/client-guide.md CONTRIBUTING.md CHANGELOG.md`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition. Expected at `797a7deb`: empty
> output.

## Goal

Every change this server makes is permanent. `delete` keeps no copy, and
`create`/`move` overwrites, `edit`, `patch` and `replace_text` discard the old
bytes. Git cannot recover untracked or ignored files, and client checkpoints do
not cover MCP tools (GitHub issue #111). Once this lands, every call that
changes files returns a short undo id (`· undo k3x9`), and a new `undo` tool
reverts one call by id, the last N calls, or (stdio only) the last call. It
restores a file only when its current bytes still match what the tool wrote.
History is in memory only.

Requirements covered: the "Desired outcome" and "How undo history works"
sections of issue #111. Two deliberate cuts, both from the issue's own staging
note ("delete and overwrites first"), are listed under [Notes](#notes):
**copy mode and cross-device moves report "not undoable"** instead of being
captured.

## Design (decided; do not re-litigate)

```text
 tools/call (any mutating tool except undo)
      │
      ▼
 ToolExecutor ── new UndoCapture(budget) ──► GuardedFileSystem(pathGuard, capture)
      │                                            │ each mutator: snapshot
      │                                            │ before-state, push record
      ▼                                            ▼
 run() returns or throws ───────────────► capture.records / capture.unavailable
      │
      ▼
 journal.add(tool, records) → id      text += " · undo <id>"
                                      or  " · not undoable: <reason>"
```

- **One new file per layer.** [`src/core/undo.ts`](../../../src/core/undo.ts)
  (new) owns records, `UndoCapture`, `UndoJournal`, and the restore engine.
  [`src/tools/undo.ts`](../../../src/tools/undo.ts) (new) is the tool.
- **The journal does not reuse `TtlLru`.** The issue suggested it, but
  `TtlLru.get` re-inserts an entry as most recently used
  ([`store.ts:46-47`](../../../src/core/store.ts#L46-L47)) and `set` on an
  existing key moves it to the newest slot. The journal is a stack: order is
  call order and must never change on read or on a partial undo. A plain
  insertion-ordered `Map` with three caps is ~40 lines and has the right
  semantics. `store.ts` is not touched.
- **Records are undone in reverse capture order.** Each mutator pushes records
  so that reversing them is correct (parents created before children on
  restore, children removed before parents).
- **A record is pushed after the mutation succeeds**, except for `rm`, which
  pushes before (a recursive `rm` can fail halfway with files already gone).
- **All or nothing per call.** When a snapshot would exceed the byte budget,
  touches a sensitive path, hits an unsupported op (`cp`), or **any capture
  read throws** (EACCES on a write-only file, EIO, a non-ENOENT stat error),
  the capture is abandoned: its records are dropped, the call still runs, and
  its result says `not undoable: <reason>`. A capture step never makes a
  mutation fail that works today: every capture read is wrapped in
  `try/catch` that calls `abandon`.
- **"Missing" means either error shape.** Guarded probes report a missing
  parent as `FsError(NOT_FOUND)`, not a Node ENOENT
  ([`path.ts:1126-1134`](../../../src/core/path.ts#L1126-L1134)). Every
  "absent" check in this plan uses one helper, which goes in
  `src/core/errors.ts` and is the same expression
  [`fs.ts:669`](../../../src/core/fs.ts#L669) already uses:

  ```ts
  export const isMissing = (error: unknown): boolean =>
    isNotFoundErrno(error) || (isFsError(error) && error.code === ErrorCode.NOT_FOUND);
  ```

  `destExists` in `fs.ts:669` switches to calling it.
- **No `src/core` → `src/tools` import.** `src/core/undo.ts` defines its own
  per-path result type. It is structurally the same as `PerPathResult` from
  `src/tools/batch.ts`, so the tool can pass it straight to `summarize`.
- **The `undo` tool is never captured.** No redo.

### Record shapes (exact; `src/core/undo.ts`)

```ts
interface FileIdentity { dev: number; ino: number; birthtimeMs: number }

export type UndoRecord =
  /** Put `bytes` back at `path`. expect = sha256 of the bytes that must be there now, or null = path must be absent. */
  | { op: 'write'; path: string; bytes: Buffer; mode: number; expect: string | null }
  /** Remove a file this call created, if its sha256 still equals `expect`. */
  | { op: 'remove'; path: string; expect: string }
  /** Remove a directory this call created, only if empty. */
  | { op: 'rmdir'; path: string }
  /** Recreate a directory this call deleted, only if `path` is absent. Default mode (see Notes). */
  | { op: 'mkdir'; path: string }
  /** Recreate a symlink this call deleted, only if `path` is absent. `type` matters on Windows only. */
  | { op: 'symlink'; path: string; target: string; type: 'file' | 'junction' }
  /** Move `to` back to `from`, if `to` is still the same object and `from` is absent or is that same object. */
  | { op: 'rename'; from: string; to: string; identity: FileIdentity };

/** One restored path; the same shape as `PerPathResult` in src/tools/batch.ts. */
export type UndoFileResult = { path: string; value: { restored: true } } | { path: string; error: Problem };
```

`symlink.type`: set at capture time.

- **On win32**, `'junction'` when the link's target is a directory
  (`fsStat(linkPath).isDirectory()`, where a dangling link counts as
  `'file'`), otherwise `'file'`. A junction needs no symlink privilege, and it
  needs an absolute target, so `target` is resolved against `dirname(path)`
  only for a junction.
- **Everywhere else**, always `'file'`. Node ignores the type there, and the
  target is passed through unchanged, so a relative link stays relative.

### Capture per mutator (`GuardedFileSystem`, all paths are the validated ones)

| Mutator | Pushed records, in order |
| :-- | :-- |
| `writeFile`, target existed | `write{old bytes, old mode, expect: sha256(new)}` |
| `writeFile`, new file | `remove{expect: sha256(new)}` |
| `appendFile`, target existed | `write{old bytes, old mode, expect: sha256(old+new)}` |
| `appendFile`, new file | `remove{expect: sha256(new)}` |
| `mkdir` | one `rmdir` per directory it created, top-down |
| `rename`, spelling-only (`sameEntry \|\| validOld === validNew`, fs.ts:218-224) | `rename` only; never snapshot `validNew`, it is the source itself |
| `rename`, destination existed (file) | `write{dest bytes, expect: null}`, then `rename` |
| `rename`, destination absent | `rename{from, to, identity of to after rename}` |
| `rename`, destination is a directory | abandon `"move replaced a directory"` |
| `rm` / `rmdir` | tree snapshot, post-order (see Step 3) |
| `cp` | abandon `"copies are not undoable yet"` |

### Restore per record (undo engine)

Every check and write goes through an un-captured `GuardedFileSystem`, so the
path guards and deny rules apply. `write` and `remove` run inside
`fs.lockForWrite(path, …)`. "Absent" means `fs.lstat(path)` rejects with
`isMissing(error)`.

The current bytes are hashed by `hashFile(fs, path)` in `src/core/undo.ts`. It
streams through the guarded `fs.open(path)` (fs.ts:513, no size cap), so a
file over `getMaxTextFileSize()` still hashes:

```ts
async function hashFile(fs: GuardedFileSystem, path: string): Promise<string> {
  await using handle = await fs.open(path);
  const hash = createHash('sha256');
  for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer); // the stream iterator yields `any`; cast as read.ts:111 does
  return hash.digest('hex');
}
```

| Record | Restored when | Action | Otherwise |
| :-- | :-- | :-- | :-- |
| `write`, expect null | path absent | `fs.writeFile(path, bytes, {mode})` | skip |
| `write`, expect hash | regular file, `hashFile` matches | `fs.writeFile(path, bytes)` | skip |
| `remove` | `hashFile` matches | `fs.rm(path)` | skip; absent counts as done |
| `rmdir` | directory, empty | `fs.rmdir(path)` | skip on ENOTEMPTY; absent counts as done |
| `mkdir` | path absent | `fs.mkdir(path)` | done if already a directory, else skip |
| `symlink` | path absent | `fs.symlink(target, path, type)` | skip |
| `rename` | `lstat(to)` has `identity`; `from` absent or `lstat(from)` has the same identity (a spelling-only rename) | `fs.mkdir(dirname(from), {recursive: true})`, then `fs.rename(to, from)` | skip |

A skip is reported per path as
`Problem.cancelled('Not restored: modified since this undo step was recorded', { path })`.
A thrown error is reported as `Problem.fromUnknown(error, ErrorCode.UNKNOWN, path)`.
Skipped and failed records stay in the entry. An entry with none left is
removed from the journal.

### Tool surface

```ts
undo({ id?: string /* /^[a-z0-9]{4}$/ */, steps?: int 1..20, dryRun?: boolean })
```

- The schema has no `.refine` and no id regex. The SDK validates the schema
  before the handler runs and answers with a plain
  `Input validation error: …` that carries no repo error code
  (`node_modules/@modelcontextprotocol/server/dist/mcp-DIH4cS6P.mjs:1780-1815`).
  So: `id: z.string().min(1).max(16).optional()`,
  `steps: z.number().int().min(1).max(20).optional()`. The cross-field rule
  is checked in `run`.
- `id` and `steps` together → `run` throws
  `new FsError(ErrorCode.INVALID_INPUT, 'Pass id or steps, not both.')`.
- Neither, not dryRun, `ctx.transport === 'http'` → `INVALID_INPUT`:
  `Over HTTP, pass the undo id from the tool result (or call undo with dryRun: true to list them).`
- Neither, on stdio or the in-memory pair → `steps: 1`.
- Unknown or expired `id` → `NOT_FOUND`: `Unknown or expired undo id "<id>".`
- Empty journal → success, text `undo: nothing to undo`.
- Journal disabled (`FS_MAX_UNDO_BYTES=0`) → `INVALID_INPUT`:
  `Undo is disabled (FS_MAX_UNDO_BYTES=0).`
- `dryRun: true` previews and writes nothing, on every transport. Each
  entry shows its id, tool, age in seconds, and per record its path and
  whether it would restore now.
  - With `id` or `steps`, it previews those entries.
  - With neither, it lists every live entry through `journal.list()`, which
    prunes expired entries first and returns them newest first. This is
    allowed over HTTP too.
- Dry-run checks run against a simulated state. The engine keeps
  `simulated: Map<string, boolean>` (path → exists), filled as each record
  "would restore": `remove` sets false, `write`/`mkdir`/`symlink` set true,
  and `rename` sets `to` false and `from` true. Each absent or present check
  consults the map before the disk. `rmdir` records are left out of dry-run
  results, because whether a directory is empty depends on writes the dry run
  did not make.
- Text: `undo: <id> (<tool>) <roster>` per entry, joined with ` · `. Roster
  items are `pathLabel(path)`, with ` SKIPPED` appended for a skip and
  ` FAILED` for an error. Structured: `{ steps: [{ id, tool, results: UndoFileResult[] }] }`.
- `isError: true` only when every record across the requested steps was
  skipped or failed.

### Result suffix on every captured call

In `ToolExecutor.execute()`, after `run` returns or throws:

- capture has records, not abandoned → `id = journal.add(def.name, records)`;
  `structured.undo = id`; text gets ` · undo <id>`.
- capture abandoned → `structured.undoUnavailable = reason`; text gets
  ` · not undoable: <reason>`.
- capture empty (dry run, all items failed before writing) → nothing.
- The text suffix goes at the **end of the first line** of the text, not the
  end of the text. Several tools return a summary line followed by more lines;
  for example, `replace_text` with `returnDiff: true` appends a unified diff
  (replace-text.ts:684). Code:
  `const nl = text.indexOf('\n'); text = nl < 0 ? text + s : text.slice(0, nl) + s + text.slice(nl);`.
- On the throw path the suffix goes on the error text from `failProgress`.

## Current state

- [`src/tools/define.ts:181`](../../../src/tools/define.ts#L181): one
  `GuardedFileSystem` per call, built in `toToolCtx`:

  ```ts
  fs: new GuardedFileSystem(deps.pathGuard),
  pageStore: deps.pageStore,
  ```

- [`define.ts:92-99`](../../../src/tools/define.ts#L92-L99): `ToolDeps`
  (`server, pathGuard, pageStore, resourceStore, era?, transport?`). The
  journal goes here.
- [`define.ts:202-213`](../../../src/tools/define.ts#L202-L213):
  `buildSuccessResponse`: with `text`, `structured` goes to `_meta`. Without
  it (only `create`), `JSON.stringify(structured)` is the text and
  `structuredContent`. Adding `undo` to `structured` therefore reaches both
  shapes. For `create`, do not append a text suffix (its text is JSON). The
  `undo` field inside it is enough.
- [`define.ts:430-459`](../../../src/tools/define.ts#L430-L459):
  `execute()`. `run` is at :442, `failProgress(error)` at :455.
- [`define.ts:498-501`](../../../src/tools/define.ts#L498-L501): `register`
  calls `new ToolExecutor(def.name, toToolCtx(ctx, deps), def, args).execute()`.
- [`src/core/fs.ts:65-70`](../../../src/core/fs.ts#L65-L70): constructor
  takes only `pathGuard`. The mutators:
  - `mkdir` :204-207 discards `fsMkdir`'s return value.
  - `rename` :209-226.
  - `writeFile(filePath, content: string, {signal})` :228-288. It already
    stats the existing mode at :242-255, which is the place to read the old
    bytes.
  - `appendFile` :296-365, with an `existed` probe at :309-315.
  - `rm` :409-412.
  - `rmdir` :414-417.
  - `cp` :419-429.
  - There is no `symlink` method.
- Other `new GuardedFileSystem(` sites are read-only and stay unchanged:
  `src/resources.ts:229` and `src/core/search.ts:507`, plus tests in
  `__tests__/core-fs.test.ts` and `__tests__/unicode-paths.test.ts`. That is
  why the capture argument is optional.
- Every tool mutation goes through `ctx.fs`. The full set of call sites
  (verified by grep):
  - `create.ts:205`, 313, 327, 383
  - `delete.ts:212`, 214
  - `edit.ts:369`
  - `move.ts:237`, 243, 568, 580, 586
  - `patch.ts:136`
  - `replace-text.ts:300`

  No tool imports `node:fs`.
- [`src/tools/move.ts:561-609`](../../../src/tools/move.ts#L561-L609):
  `performRenameWithFallback`. On EXDEV it calls `fsOps.cp`, then `fsOps.rm`.
  With capture, `cp` abandons, so a cross-device move is reported as not
  undoable with no move-specific code.
- [`src/tools/delete.ts:377`](../../../src/tools/delete.ts#L377) and
  [`:432`](../../../src/tools/delete.ts#L432): wording that undo
  contradicts:

  ```ts
  message: `Permanently delete "${p}" and all its contents? This cannot be undone.`,
  'Permanently delete files, directories, or symlinks, like rm or rm -r. Paths are exact; globs are not expanded.',
  ```

- [`src/tools/read.ts:48-49`](../../../src/tools/read.ts#L48-L49): the only
  sha256 helper, private:

  ```ts
  const sha256Hex = (data: string | Buffer): string =>
    createHash('sha256').update(data).digest('hex');
  ```

- [`src/core/util.ts:9-16`](../../../src/core/util.ts#L9-L16):
  `parseEnvInt(envVar, default, min, max)`. Exemplar use:
  `parseEnvInt('FS_MAX_WATCHERS', 256, 1, 4096)` in
  [`src/core/watcher-registry.ts:13`](../../../src/core/watcher-registry.ts#L13).
  `MIB` is exported from util.ts:7.
- [`src/server.ts:175`](../../../src/server.ts#L175):
  `const pageStore = extraDeps?.pageStore ?? new PageSnapshotStore();`. The
  injection option is declared at :59-63 and the deps object at :186-197.
  Ownership: `const ownsPages = extraDeps?.pageStore === undefined;` (:204),
  then `if (ownsPages) pageStore.clear();` (:212).
- [`src/transport/http.ts:282`](../../../src/transport/http.ts#L282):
  `const sharedPageStore = new PageSnapshotStore();`, injected at :303 and
  cleared in `teardown` at :358.
- `__tests__/helpers.ts:309-320`: `createTestHttpHarness` mirrors http.ts
  with its own `sharedPageStore`, and must get a shared journal the same way.
  `createTestServer` (:165-170) passes no `transport`, so the in-memory pair
  behaves like stdio (`ctx.transport === undefined`).
- [`src/tools/index.ts:16-30`](../../../src/tools/index.ts#L16-L30):
  `ALL_TOOLS`, 13 entries. `MUTATING_TOOL_NAMES` is derived from
  `readOnlyHint`, so `undo` (`readOnlyHint: false`) is dropped by
  `--read-only` automatically. The comment at :42-45 says "the mutating six".
- [`src/core/errors.ts:1-15`](../../../src/core/errors.ts#L1-L15): the
  `ErrorCode` set. There is no CONFLICT code, so "modified since" uses
  `Problem.cancelled`. `isFsError` is at :166, `isNotFoundErrno` at :196.
- [`src/core/fs.ts:665-674`](../../../src/core/fs.ts#L665-L674):
  `destExists`, whose missing test is
  `const missing = isNotFoundErrno(err) || (isFsError(err) && err.code === ErrorCode.NOT_FOUND);`.
- [`src/core/fs.ts:261-270`](../../../src/core/fs.ts#L261-L270): a mode
  given at creation is masked by the umask. Only the `fsChmod` at :268-270
  puts it back, and that runs only when `existingMode !== undefined`.
- [`tsconfig.json:17`](../../../tsconfig.json#L17):
  `"erasableSyntaxOnly": true`. No TypeScript parameter properties, enums or
  namespaces. Assign fields in the constructor body, as in the
  `UndoJournal` sketch.
- [`__tests__/tools.test.ts:4157`](../../../__tests__/tools.test.ts#L4157):
  the annotations test hardcodes
  `const mutating = new Set(['create', 'delete', 'edit', 'move', 'patch', 'replace_text']);`.
- [`__tests__/helpers.ts:55-76`](../../../__tests__/helpers.ts#L55-L76):
  `trySymlink(target, linkPath, skip, type = 'junction')`. Every symlink
  fixture goes through it, as `trySymlink(t, l, () => t.skip('symlink not permitted'), 'file')`,
  so Windows without the symlink privilege skips instead of failing.
- [`src/core/sensitive.ts:284`](../../../src/core/sensitive.ts#L284): `'.env'`
  is in the built-in sensitive list.
- Conventions:
  - **tool definition:** [`src/tools/stat.ts:169`](../../../src/tools/stat.ts#L169)
    (`defineTool`, `readOnlyHint`, `mapPaths` omitted because undo takes no
    caller paths);
  - **batch per-path results:** [`src/tools/batch.ts`](../../../src/tools/batch.ts)
    (`PerPathResult`, `summarize`, `isTotalFailure`);
  - **roster text:** [`src/tools/delete.ts:451-470`](../../../src/tools/delete.ts#L451-L470)
    with `joinRoster`/`pathLabel` from [`src/core/fmt.ts:81-93`](../../../src/core/fmt.ts#L81-L93);
  - **store unit test with `Date.now` mocked:** `__tests__/page-store.test.ts:82-108`;
  - **e2e mutation test:** `__tests__/mutation-regressions.test.ts:55-87`;
  - **HTTP shared-state test:** `__tests__/http-transport.test.ts:196-214`
    (LEGACY-HTTP-004).
- Decided constraint, ADR-003
  ([`docs/adr/003-http-serves-2025-era-clients-statelessly.md`](../../adr/003-http-serves-2025-era-clients-statelessly.md)):
  HTTP builds a fresh `McpServer` per request with no session, so state that
  must outlive a request "is shared at the endpoint, not per-connection". This
  is why there is one journal per endpoint and why an id is required over HTTP.

## Commands

| Purpose | Command | Expected on success |
| :-- | :-- | :-- |
| Typecheck src | `npm run build` | exit 0 |
| Typecheck tests | `npm run type-check:test` | exit 0 |
| One test file | `node --test --test-timeout=60000 __tests__/undo.test.ts` | all pass |
| Full suite | `npm test` | all pass |
| Snapshot update | `node --test --test-update-snapshots __tests__/contract.test.ts` (no `FS_*` set) | exit 0, `.snapshot` rewritten |
| Format + lint-fix | `npm run format && npm run lint:fix` | exit 0 |
| Full gate | `npm run check` | exit 0 |
| Coverage gate | `npm run test:coverage` | exit 0 (lines 92, branches 85, functions 91) |

On Windows PowerShell, clear `FS_*` first with
`Get-ChildItem env:FS_* | Remove-Item`.

## Scope

**In scope**, the only files to modify:

- `src/core/undo.ts` (new)
- `src/tools/undo.ts` (new)
- `__tests__/undo.test.ts` (new)
- [`src/core/fs.ts`](../../../src/core/fs.ts)
- [`src/core/util.ts`](../../../src/core/util.ts): `sha256Hex` and `getMaxUndoBytes`
- [`src/core/errors.ts`](../../../src/core/errors.ts): the `isMissing` helper only
- [`src/tools/read.ts`](../../../src/tools/read.ts): import `sha256Hex` instead of defining it
- [`src/tools/define.ts`](../../../src/tools/define.ts)
- [`src/tools/index.ts`](../../../src/tools/index.ts)
- [`src/tools/delete.ts`](../../../src/tools/delete.ts): wording only
- [`src/server.ts`](../../../src/server.ts)
- [`src/transport/http.ts`](../../../src/transport/http.ts)
- [`src/cli-help.ts`](../../../src/cli-help.ts): one `ENV_HELP` row
- [`__tests__/helpers.ts`](../../../__tests__/helpers.ts)
- [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts): the TOOL-SURFACE-002 count and budget, and `'undo'` added to the `mutating` set at :4157
- `docs/plan/2026-10-22-undo-tool/`: this plan and its hunt report
- `__tests__/contract.test.ts.snapshot`: regenerated, never hand-edited
- [`mcpb/manifest.json`](../../../mcpb/manifest.json): the `tools` array only
- [`README.md`](../../../README.md), [`docs/configuration.md`](../../configuration.md), [`docs/client-guide.md`](../../client-guide.md), [`CONTRIBUTING.md`](../../../CONTRIBUTING.md), [`CHANGELOG.md`](../../../CHANGELOG.md)

**Files out of scope**, leave alone even though they look related:

- [`src/core/store.ts`](../../../src/core/store.ts): the journal deliberately
  does not reuse `TtlLru` (see [Design](#design-decided-do-not-re-litigate)).
- [`src/transport/stdio.ts`](../../../src/transport/stdio.ts): the SDK probe
  instance never serves a `tools/call` (`stdio.cjs:464-509`), so a journal
  owned by `createServer` is already one per connection, the same as
  `pageStore`.
- `src/tools/{create,edit,patch,replace-text,move}.ts`: capture lives in
  `GuardedFileSystem`. If a tool needs undo code, the design is wrong
  (STOP).
- `package.json`, `server.json`, the `.codex-plugin`/`.cursor-plugin`
  manifests, and every version field: AGENTS.md says "Never hand-edit any
  of those versions". There is nothing to change there.
- `src/cli.ts`, `src/core/config.ts`: the setting is env-only, like
  `FS_MAX_WATCHERS`, with no CLI flag.

## Steps

### 1. Move `sha256Hex` to core

1. Add this to [`src/core/util.ts`](../../../src/core/util.ts), with
   `import { createHash } from 'node:crypto';`:

   ```ts
   export const sha256Hex = (data: string | Buffer): string =>
     createHash('sha256').update(data).digest('hex');
   ```

2. Delete the local copy and the `createHash` import from
   [`read.ts:3`](../../../src/tools/read.ts#L3) and
   [`read.ts:48-49`](../../../src/tools/read.ts#L48-L49).
3. Import `sha256Hex` from `../core/util.ts` in `read.ts`.

**Verify**: `npm run build && node --test --test-timeout=60000 --test-name-pattern="hash" __tests__/tools.test.ts` → exit 0, all pass.

### 2. Journal and budget setting, test-first

1. Add `export function getMaxUndoBytes(): number` to `util.ts`:
   `parseEnvInt('FS_MAX_UNDO_BYTES', 32 * MIB, 0, 1024 * MIB)`. It is read on
   each call, like `getMaxTextFileSize`, so tests can use `withEnv`.
2. Create `src/core/undo.ts` with the `UndoRecord` union above (exactly), plus:

   ```ts
   export interface UndoEntry { id: string; tool: string; createdAt: number; records: UndoRecord[] }

   const MAX_ENTRIES = 64;
   const TTL_MS = 30 * 60 * 1000;

   /** Byte weight of an entry: the saved bytes it pins. */
   const weigh = (records: readonly UndoRecord[]): number =>
     records.reduce((n, r) => n + (r.op === 'write' ? r.bytes.length : 0), 0);

   export class UndoJournal {
     // Insertion order is call order; nothing ever re-inserts, so the last key is the newest call.
     readonly #byId = new Map<string, UndoEntry>();
     readonly maxBytes: number;
     constructor(maxBytes = getMaxUndoBytes()) { this.maxBytes = maxBytes; }
     get enabled(): boolean { return this.maxBytes > 0; }
     add(tool: string, records: UndoRecord[]): string            // new id; then evict oldest while size > MAX_ENTRIES or sum(weigh) > maxBytes
                                                                 // (sum recomputed over live entries each time: <= 64 entries, so no running total to drift)
     get(id: string): UndoEntry | undefined                       // prunes expired first
     newest(n: number): UndoEntry[]                               // newest first, prunes expired first
     replaceRecords(id: string, records: UndoRecord[]): void      // in place; deletes the entry when records is empty
     list(): UndoEntry[]                                          // newest first, prunes expired first
     clear(): void
   }
   ```

3. Ids: 4 characters from `[a-z0-9]`, built from `randomBytes(4)` mapped over
   that 36-character alphabet. Regenerate on a collision with a live id.
4. Write `__tests__/undo.test.ts` first, with a `describe('UndoJournal')`
   block. Model the `Date.now` mocking on `page-store.test.ts:82-108`. The
   cases:
   - (a) `add` returns `/^[a-z0-9]{4}$/` ids, and `newest(2)` returns the last
     two newest first;
   - (b) the 65th add evicts the oldest;
   - (c) a byte cap of 10 with two 6-byte entries keeps only the newer one;
   - (d) an entry is gone after 30 minutes (mock `Date.now`);
   - (e) `replaceRecords` keeps the entry's position, and `replaceRecords(id, [])` deletes it;
   - (f) `new UndoJournal(0).enabled === false`.

**Verify**: `node --test --test-timeout=60000 --test-name-pattern="UndoJournal" __tests__/undo.test.ts` → 6 pass, 0 fail.

### 3. Capture in `GuardedFileSystem`, test-first

1. In `src/core/undo.ts` add:

   ```ts
   export class UndoCapture {
     readonly records: UndoRecord[] = [];
     unavailable: string | undefined;
     #bytes = 0;
     readonly maxBytes: number;
     constructor(maxBytes: number) { this.maxBytes = maxBytes; }   // no parameter property: erasableSyntaxOnly
     /** Reserve n saved bytes; past the budget the capture is abandoned and false comes back. */
     reserve(n: number): boolean
     /** The call stays runnable but not undoable; first reason wins, records are dropped. */
     abandon(reason: string): void
     push(...records: UndoRecord[]): void   // no-op once abandoned
   }
   ```

2. In [`fs.ts`](../../../src/core/fs.ts), change the constructor to
   `constructor(pathGuard: PathGuard, capture?: UndoCapture)` and store
   `readonly #capture`. Every hook below starts with
   `if (this.#capture && !this.#capture.unavailable)`.
3. Widen `writeFile` to `content: string | Buffer` and
   `options: { signal?; mode? }`. Right after the stat block (:242-255), add
   `const mode = existingMode ?? options.mode;`. Use `mode` in place of
   `existingMode` in both the create options (:266) and the `fsChmod` guard
   (:268-270), so a restored file gets its exact mode back despite the umask.
   Capture:
   - Where the stat at :244 succeeds and the target is a regular file,
     `reserve(size)`, then read the old bytes with `fsReadFile(validPath)`
     inside `try/catch → abandon('could not read the old content')`.
   - Where the stat fails with a non-ENOENT error (the warning branch at
     :250-254), abandon `'could not read the old content'`. Do not push
     `remove`: the file may exist.
   After the rename at :276, push `write` or `remove` per the
   [table](#capture-per-mutator-guardedfilesystem-all-paths-are-the-validated-ones).
   Hash the written bytes with `sha256Hex(content)`; a string hashes as UTF-8,
   which is what `fsWriteFile` writes.
4. `appendFile`: when `existed`, `reserve(size)` and read the old bytes before
   the open, inside `try/catch → abandon('could not read the old content')`. After the write, push `write{expect: sha256Hex(Buffer.concat([old, Buffer.from(content)]))}`
   or `remove{expect: sha256Hex(content)}`.
5. `mkdir`: do not use `fsMkdir`'s return value. On Windows it is a
   `\\?\C:\…` namespaced path that does not match `validPath`; this was seen
   on Node v24.15.0. Do not read `options` either: its type is a union that
   includes `number | string`.
   - Before `fsMkdir`, walk up from `validPath` with `fsLstat`, collecting
     each path that `isMissing` until the first one that exists.
   - After `fsMkdir` succeeds, push one `rmdir` per collected path, top-down
     (outermost first).
   - Wrap the walk in `try/catch → abandon('could not inspect the parent folders')`.
6. `rename`: after the existing respell block (:218-224), keep
   `const spellingOnly = sameEntry || validOld === validNew;` (computed before
   `validNew` is respelled).
   - When `spellingOnly`, skip the destination snapshot entirely.
   - Otherwise, before `fsRename`, `fsLstat(validNew)`:
     - a regular file → reserve and read its bytes, in `try/catch → abandon`;
     - a directory → abandon `'move replaced a directory'`;
     - missing (`isMissing`) → nothing;
     - any other error → abandon.
   - After `fsRename`, `fsLstat(validNew)` for `{dev, ino, birthtimeMs}`, then
     push the records in the table's order.
7. `rm` and `rmdir`: before the raw call, `#snapshotTree(validPath)`. Wrap the
   whole walk in `try/catch → abandon('could not read the deleted files')`.
   - Walk with `fsLstat`, plus `fsReaddir(dir)` (add `readdir as fsReaddir`
     to the `node:fs/promises` import at fs.ts:5-20), post-order.
   - A file: `reserve(size)`, `fsReadFile`, then
     `write{mode: stats.mode & 0o777, expect: null}`.
   - A symlink: `fsReadlink`, then `symlink{type}` per
     [Record shapes](#record-shapes-exact-srccoreundots).
   - A directory: its children first, then `mkdir`.
   - Any path where `this.pathGuard.isSensitive(path)` holds: abandon
     `'contains protected files'`.
   - ENOENT on the root (the `force` case): push nothing.
   - Push the records before the raw call (see
     [Design](#design-decided-do-not-re-litigate)).
8. `cp`: abandon `'copies are not undoable yet'` before `fsCp`.
9. Add a guarded
   `symlink(target: string, linkPath: string, type: 'file' | 'junction')`.
   Validate the link path with `validatePathForWrite`, then call
   `fsSymlink(type === 'junction' ? resolve(dirname(validPath), target) : target, validPath, type)`.
   (`'junction'` only ever comes from a win32 capture; see
   [Record shapes](#record-shapes-exact-srccoreundots).)
   Import `symlink as fsSymlink` from `node:fs/promises`, and `dirname` and
   `resolve` from `node:path`.
10. Add `isMissing` to `src/core/errors.ts` (exact code in
    [Design](#design-decided-do-not-re-litigate)) and make `destExists`
    (`fs.ts:669`) call it.
11. Tests first, in `describe('UndoCapture via GuardedFileSystem')`. Build
    `new GuardedFileSystem(guard, capture)` with the guard helper from
    `__tests__/helpers.ts` (see `core-fs.test.ts:52` for how a guard is made).
    Every symlink fixture uses `trySymlink(..., () => t.skip('symlink not permitted'), 'file')`.
    The cases:
    - (a) overwrite pushes `write` with the old bytes and the sha256 of the new;
    - (b) a new file pushes `remove`;
    - (c) append on an existing file;
    - (d) `mkdir -p a/b/c` pushes 3 `rmdir`, top-down;
    - (e) `rm` recursive of a tree with a file, a nested directory and a
      symlink pushes post-order records;
    - (f) a tree containing `.env` abandons with `contains protected files`
      (`'.env'` is built-in sensitive, `sensitive.ts:284`);
    - (g) a budget of 3 bytes and a 4-byte file abandons;
    - (h) `cp` abandons;
    - (i) POSIX only (`{ skip: process.platform === 'win32' }`): overwriting a
      `0o200` file still succeeds and abandons with
      `could not read the old content`;
    - (j) `rename` of `a.txt` to `A.txt` on a case-insensitive filesystem pushes
      exactly one `rename` record. Probe case sensitivity first: if `A.txt`
      resolves to the same file before the rename, the filesystem is
      case-insensitive; otherwise `t.skip`;
    - (k) without a capture, behaviour is unchanged (existing `core-fs.test.ts` passes).

**Verify**: `npm run build && node --test --test-timeout=60000 __tests__/undo.test.ts __tests__/core-fs.test.ts` → all pass.

### 4. Restore engine, test-first

1. In `src/core/undo.ts` add:

   ```ts
   export interface RestoreOutcome { results: UndoFileResult[]; remaining: UndoRecord[] }
   export async function restoreEntry(entry: UndoEntry, fs: GuardedFileSystem, opts: { dryRun: boolean }): Promise<RestoreOutcome>
   ```

2. Records run in reverse order, one at a time (serial: a tree restore needs
   parents before children). Each record follows the
   [restore table](#restore-per-record-undo-engine), using `hashFile` and
   `isMissing` exactly as given there. With `dryRun`, run only the checks
   against the `simulated` map (see [Tool surface](#tool-surface)): report
   `restored: true` for each record that would restore, leave out `rmdir`
   records, and write nothing.
3. `src/core/undo.ts` imports nothing from `src/tools/`. Run
   `git grep --untracked -n "from '../tools" -- src/core` and expect empty output.
4. Tests first, in `describe('restoreEntry')`. Capture with one `fs`, restore
   with a second `fs` that has no capture. Symlink fixtures use `trySymlink`
   as in Step 3. The cases:
   - (a) overwrite, then restore, gives the old bytes;
   - (b) overwrite, then an outside write, then restore is skipped with
     `modified since` and the file keeps the outside bytes;
   - (c) a deleted tree comes back with file bytes, mode (POSIX only:
     `if (process.platform !== 'win32')`), symlink target and an empty
     subdirectory;
   - (d) a created file and its created parents are removed;
   - (e) a created parent that gained a new file stays, with `rmdir`
     reported as skipped;
   - (f) a rename comes back;
   - (g) a rename over an existing file restores both;
   - (h) `dryRun` writes nothing and reports the same per-path outcomes as
     the real restore, `rmdir` records excepted. Check it on case (d) (a
     created file in created parents: the file reports `restored: true`) and
     on case (g) (a rename over an existing file: both paths report
     `restored: true`);
   - (i) a file deleted from a directory that was then deleted too
     (`write{expect: null}` whose parent is missing) is reported FAILED and
     stays in `remaining`, with no throw.

**Verify**: `node --test --test-timeout=60000 --test-name-pattern="restoreEntry" __tests__/undo.test.ts` → 9 pass, 0 fail (case c's symlink part may report skipped on Windows without the symlink privilege). Then `git grep --untracked -n "from '../tools" -- src/core` → empty output.

### 5. Wire capture and journal into the executor and transports

1. **`define.ts`, deps and context.**
   - Add `readonly undoJournal: UndoJournal` to `ToolDeps` (required) and to
     `ToolCtx`.
   - `toToolCtx(ctx, deps, capture?: UndoCapture)`: pass `undoJournal` through,
     and set `fs: new GuardedFileSystem(deps.pathGuard, capture)`.
2. **`define.ts`, `register`.** Build the capture only when
   `deps.undoJournal.enabled && !def.readOnlyHint && def.name !== 'undo'`, as
   `new UndoCapture(deps.undoJournal.maxBytes)`. Hand it to `toToolCtx` and
   to the executor.
3. **`define.ts`, `execute()`.** Add `#undoSuffix(structured?: object): string`.
   It implements [Result suffix](#result-suffix-on-every-captured-call): it
   returns `' · undo <id>'`, `' · not undoable: <reason>'` or `''`, and sets
   `undo`/`undoUnavailable` on `structured` when given.
   - Success path: call it on `result.structured` before `buildSuccessResponse`.
     Insert into `result.text` only when `result.text !== undefined`, at the
     end of its first line (exact code in
     [Result suffix](#result-suffix-on-every-captured-call)). Build a new
     `RunResult`; never mutate a shared object.
   - Error path: call `#undoSuffix()` and append it to the `failProgress`
     text.
   - The `input_required` return: commit nothing. No tool writes before
     asking; see `create.ts:201-202`, `move.ts:386-400`, `delete.ts:362`.
4. **`server.ts`.**
   - Add an `undoJournal?: UndoJournal` extraDep, documented like `pageStore`
     at :59-63.
   - `const undoJournal = extraDeps?.undoJournal ?? new UndoJournal();`, then
     add it to `deps`.
   - `const ownsUndo = extraDeps?.undoJournal === undefined;`, then
     `if (ownsUndo) undoJournal.clear();` in `disposeRuntimeState`.
5. **`http.ts`.** `const sharedUndoJournal = new UndoJournal();` next to
   `sharedPageStore` (:282). Inject it at :303 and clear it in `teardown`.
6. **`__tests__/helpers.ts`.** The same shared journal in
   `createTestHttpHarness`, next to `sharedPageStore` (:309).
7. **Test first**, in `describe('undo id on results')`, using
   `createTestClientPair`. The cases:
   - (a) `edit` text ends with `/ · undo [a-z0-9]{4}$/` and `_meta.undo`
     matches it;
   - (b) `create` (new file) has `structuredContent.undo`, and its text is
     still valid JSON;
   - (c) `edit` with `dryRun: true` has no suffix;
   - (d) `move` with `copy: true` ends with `· not undoable: copies are not undoable yet`;
   - (e) with `withEnv({ FS_MAX_UNDO_BYTES: '0' }, …)` around pair creation,
     `edit` has no suffix.

**Verify**: `npm run build && npm run type-check:test && node --test --test-timeout=60000 __tests__/undo.test.ts` → exit 0, all pass. Then `npm test` → all pass. Any existing test that asserted an exact mutating-tool text breaks here: update its expected string to allow the suffix. Each such edit is in scope only inside `__tests__/`, so list them in the report.

### 6. The `undo` tool, test-first

1. Create `src/tools/undo.ts` with `defineTool` per the
   [Tool surface](#tool-surface):
   - `name: 'undo'`, `title: 'Undo'`, `readOnlyHint: false`, no `mapPaths`,
     no `deadline`.
   - Description, under 200 characters: `'Revert earlier calls that changed files, by undo id or the last N calls. A file is restored only if unchanged since. dryRun lists the history.'`
   - Input: `z.strictObject({ id, steps, dryRun: defaultFalseBoolean(...) })`,
     with no `.refine` and no regex (see [Tool surface](#tool-surface)).
     `defaultFalseBoolean` comes from `../core/schema.ts`, as `delete.ts:27`
     imports it.
2. `run`:
   - First check, in [Tool surface](#tool-surface) order: disabled, then id
     plus steps, then the HTTP id rule.
   - Resolve the entries:
     - by `id` → `[journal.get(id)]`;
     - else by `steps` → `journal.newest(steps)`;
     - else, if `dryRun` → `journal.list()`;
     - else → `journal.newest(1)`.
   - Run `restoreEntry` on each, newest first.
   - Unless `dryRun`, call `journal.replaceRecords(entry.id, outcome.remaining)`.
   - `ctx.fs` already has no capture (Step 5 skips `undo`).
3. Register `UNDO` last in `ALL_TOOLS`
   ([`index.ts:16-30`](../../../src/tools/index.ts#L16-L30)). Change the
   comment at :43 from "the mutating six" to "the mutating tools".
4. Tests first, in `describe('undo tool')`, using `createTestClientPair`. The
   cases replay the issue's example:
   - (a) a fresh server: `undo()` → `undo: nothing to undo`, not `isError`;
   - (b) `edit a.ts`, `delete old.log`, then `create config.json` with
     `overwrite: true`. `undo()` restores `config.json`. `undo({steps:2})`
     recreates `old.log` and reverts `a.ts`. The next `undo()` says nothing
     to undo;
   - (c) `undo({id})` on the older of two edits to different files reverts
     only that one;
   - (d) two edits of the same file, then `undo({id: older})`, skip it as
     `modified since`, and `dryRun` still lists it;
   - (e) `id` plus `steps` → `INVALID_INPUT`;
   - (f) an unknown id → `NOT_FOUND`;
   - (g) `dryRun` lists ids, tools and paths and changes no bytes on disk;
   - (h) `{ readOnly: true }` → `undo` is not in `listTools()`.
5. HTTP, using `createTestHttpHarness`:
   - (i) `undo({})` → `INVALID_INPUT`, with the message in
     [Tool surface](#tool-surface);
   - (j) `edit`, then `undo({ id })` in a separate request, reverts the edit
     (the journal is shared across per-request servers).
6. stdio, using `createStdioClient(root)` (`__tests__/helpers.ts:446`, a real
   subprocess):
   - (k) `edit`, then `undo({})` as a separate call, reverts the edit. This is
     the case the 4th [STOP](#stop) bullet watches.
7. `tools.test.ts:4157`: add `'undo'` to the `mutating` set.

**Verify**: `npm run build && node --test --test-timeout=60000 __tests__/undo.test.ts` → all pass. Then `node --test --test-timeout=60000 --test-name-pattern="annotations" __tests__/tools.test.ts` → all pass.

### 7. Contract surfaces and docs

1. `delete.ts:377`: the message becomes
   `` `Delete "${p}" and all its contents?` ``. `delete.ts:432`: the
   description becomes
   `'Delete files, directories, or symlinks, like rm or rm -r. Paths are exact; globs are not expanded. Revert with undo.'`
2. `tools.test.ts:4191`: the count becomes `14`. Run `npm test --
   --test-name-pattern="TOOL-SURFACE-002"`. If it fails on size, set
   `BUDGET_CHARS` to the measured size rounded up to the next 50 plus ~380
   headroom (the same margin as now: 19 600 − 19 219). Add a dated comment
   line `// Raised 2026-10-22 to <N> full: undo tool (#111); measured <M>.`
   The read-only budget must not change, because undo is absent there.
3. Regenerate the snapshot: `Get-ChildItem env:FS_* | Remove-Item`, then
   `node --test --test-update-snapshots __tests__/contract.test.ts`. Run
   `git diff --stat __tests__/contract.test.ts.snapshot` and expect only the
   full export changed (the undo tool, the delete wording, and the Write row of
   the instructions).
4. `mcpb/manifest.json`: after `patch`, add
   `{ "name": "undo", "description": "Revert earlier file changes by undo id or the last N calls." }`.
   Change the `delete` description to `"Delete files or directories."`.
5. Docs:
   - `README.md:19`: "13 tools" becomes "14 tools".
   - README Tools table: after `delete`, add
     `` | `undo` ✎ | Reverts earlier changes by undo id or the last N calls, while the server runs. Skips files changed since. | ``
   - README :394-395 ("Short-lived result caches live in memory and / disappear
     when the server exits."): change it to "Short-lived result caches and the
     undo history (saved file contents) live in memory and disappear when the
     server exits."
   - `docs/configuration.md:112`: "six tools" becomes "seven tools" and add
     `` `undo` `` to the list. Add the env row
     `` | `FS_MAX_UNDO_BYTES` | Memory kept for undo. Default 32 MiB, 0 turns undo off. | ``
     next to `FS_MAX_WATCHERS`.
   - `docs/client-guide.md:281`: "six tools" becomes "seven tools".
   - `docs/client-guide.md:261-275`, the per-tool table: add an `undo` row
     after `delete`, matching its columns (changes files: yes; `dryRun`: yes;
     several paths: no; paged: no; data in `_meta`).
   - The `_meta` list near :300-302: add one sentence. Every call that
     changes files carries `undo` (the undo id) or `undoUnavailable` (the
     reason) in its `_meta`, or in `structuredContent` for `create`.
   - `CONTRIBUTING.md:92`: "all 13 tools" becomes "all 14 tools".
   - `src/cli-help.ts`: add
     `{ flags: 'FS_MAX_UNDO_BYTES', desc: 'Bytes of file content kept for undo (default 32 MiB, 0 disables)' }`
     after `FS_MAX_WATCHERS` (:133-136).
6. `CHANGELOG.md`: above `## [2.9.1]`, add `## [Unreleased]` and an
   `### Added` bullet describing the `undo` tool, `FS_MAX_UNDO_BYTES`, and
   the two not-undoable cases (copies, cross-device moves). Wrap the text at
   about 76 columns.
7. Run `npm run format && npm run lint:fix`. This covers `src` and
   `__tests__` too.

**Verify**: `npm run check` → exit 0. Then `npm run test:coverage` → exit 0.

## Done

All must hold:

- [ ] `npm run check` exits 0 (build, type-check:test, lint, prettier, knip, and the full suite)
- [ ] `npm run test:coverage` exits 0
- [ ] `node --test --test-timeout=60000 __tests__/undo.test.ts` passes, including the issue's example sequence (Step 6 case b) and the HTTP id-required case
- [ ] `git grep -n -e "This cannot be undone" -e "Permanently delete" -- src mcpb` prints nothing
- [ ] `git grep --untracked -n "from '../tools" -- src/core` prints nothing
- [ ] `git status --short` lists only files from the [in-scope list](#scope) (the plan directory included), plus test files under `__tests__/` named in the Step 5 report

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt.
- A step's verification fails twice after one fix attempt.
- A tool file other than `delete.ts` (wording) or `index.ts` needs a change
  for capture to work. That means a mutation bypasses `GuardedFileSystem`,
  and the plan's premise is false.
- The SDK serves a `tools/call` on a stdio instance whose `disposeRuntimeState`
  later runs while the connection stays open, which would empty the journal
  mid-session. The symptom is that Step 6 case (k), under `createStdioClient`,
  says nothing to undo while case (b) passes on the in-memory pair.
- An existing test outside `__tests__/undo.test.ts` fails for a reason other
  than an exact-text assertion on a mutating tool's result (Step 5) or the
  contract and budget changes in Step 7.
- `knip` flags an export that nothing uses, and removing it would break a
  step's design.

## Notes

- **Deliberate cuts, each with its ceiling:**
  - **Copy mode and cross-device moves** abandon capture. Undoing a forced `cp`
    means telling new files apart from overwritten ones across a merged tree.
    Upgrade path: snapshot destination entries in `cp` before `fsCp`, the same
    way `#snapshotTree` does. Add a `ponytail:` comment at the `cp` abandon
    naming this.
  - **Append stores the whole old file**, not its size. A multi-GB log goes
    over the budget and becomes not undoable. Upgrade path: a `truncate` record
    with a streamed after-hash. Add a `ponytail:` comment.
  - **The rename check is identity only.** A moved directory whose contents
    changed after the move is still moved back. Add a `ponytail:` comment.
  - **`delete` and `move` take no write lock** while capturing. Their snapshot
    can race a concurrent writer, as their mutation already can today.
  - **A recreated directory gets the default mode.** `GuardedFileSystem` has
    no chmod, and `mkdir`'s mode is masked by the umask. Files get their exact
    mode back (Step 3.3); directories do not. Add a `ponytail:` comment.
  - **A symlink is recreated with its original target text on POSIX.** On
    Windows, a directory symlink comes back as a junction to the absolute
    target.
- **What a reviewer should check:**
  - Ordering in `#snapshotTree`: post-order capture means a parent is
    recreated before its children.
  - That `UndoCapture.abandon` drops records already pushed. A half-captured
    `replace_text` must never be undoable.
  - That the undo tool's own `fs` has no capture.
  - That `create`'s JSON text stays parseable.
- File owner, extended attributes and hardlinks are not restored (issue
  #111, "Known limits").
- **Rollback:** `git switch main && git branch -D feat/undo-tool`. There is
  nothing persistent: no migrations and no on-disk state.
