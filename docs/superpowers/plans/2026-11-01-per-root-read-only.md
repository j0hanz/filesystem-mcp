# Per-Root Read-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one server instance mark specific directories read-only (`--read-only-root`, `FS_READ_ONLY_DIRS`) while other roots stay writable, refusing writes/moves/deletes under them at call time (issue #162).

**Architecture:** The mode is a plain containment check, not a per-root table: PathGuard holds a list of read-only directories (all spellings, realpath aliases included) and denies any _resolved_ write/delete path inside one. Enforcement lives in the three existing validation chokepoints (`validatePathForWrite`, `validatePathForDelete`); reads never check it. The global `--read-only` flag keeps its registration-time tool gate unchanged.

**Tech Stack:** TypeScript 7 (native), Node 24 test runner, Zod 4, existing MCP SDK. No new dependencies.

**Spec:** https://github.com/j0hanz/filesystem-mcp/issues/162 — the design decisions are settled in this plan's tasks; there is no separate spec document.

## Global Constraints

- `npm run check` must be green before any commit; tests run on Node's built-in runner (`npm test -- --test-name-pattern="..."`).
- Contract snapshot regenerates only with `node --test --test-update-snapshots __tests__/contract.test.ts` and **no `FS_*` environment variables set**; commit the `.snapshot` diff with the change.
- Never hand-edit version fields in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json` — the Release workflow owns them.
- Denials throw `FsError(ErrorCode.ACCESS_DENIED, ...)` with an actionable hint, matching `assertNotSensitiveFile`'s style (`src/core/path.ts:933`).
- No `outputSchema` on any tool; data fields ride `structuredContent` (`buildSuccessResponse` in `src/tools/define.ts:213`).
- New tests go in one focused file, `__tests__/read-only-roots.test.ts`, following the temp-dir setup pattern of `__tests__/sandbox.test.ts` (`describe(..., { concurrency: false }, ...)`).
- Commit messages are Conventional Commits, each ending with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

Inputs the issue implies but no task's happy path covers — each line is pinned by the named test in its owning task:

1. **Symlink alias:** a link in a writable root pointing into a read-only dir — edit through it denied (resolved-path check), read through it allowed, deleting the link itself allowed. → `RO-LINK-001` (Task 2).
2. **Move, every direction:** ro→rw, rw→ro, ro→ro all refused (the source side is a delete); rw→rw unaffected. → `RO-INT-003` (Task 4).
3. **Reads unaffected:** list/read/search_text/stat under a read-only root keep working — read-only means read-only, not invisible. → `RO-INT-002` (Task 4).
4. **Nested subtree:** a read-only dir _inside_ a writable root denies writes under it while sibling writes succeed. → `RO-NEST-001` (Task 2).
5. **Operator typo:** a read-only dir matching no allowed root warns (footgun: the root they meant stays writable) but changes nothing else. → `RO-STATE-005` (Task 1).

---

### Task 1: PathGuard read-only state

**Files:**

- Modify: `src/core/path.ts` (ServerOptions ~:106, PathGuard fields ~:227-260, `recomputeAllowedDirectories` :1308-1372)
- Test: `__tests__/read-only-roots.test.ts` (new)

**Interfaces:**

- Produces: `ServerOptions.readOnlyDirs?: string[]`; `PathGuard.getReadOnlyDirs(): string[]` (normalized configured dirs, deduped); `PathGuard.isReadOnlyPath(normalizedPath: string): boolean`. Task 2 consumes `isReadOnlyPath`; Task 3 feeds `readOnlyDirs`.
- Consumes: existing `resolveConfiguredDirs`, `resolveAllowedDirectoriesState`, `normalizeAllowedDirectories`, `isPathWithinDirectories`, `isPathInsideDirectory`, `isSamePath`, `Logger` — all already imported or local in `path.ts`.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/read-only-roots.test.ts`. Guard-level tests build the guard the way production does — `new PathGuard({...})` then `await recomputeAllowedDirectories()` (plain `initialize()` bypasses the read-only state by design). Temp roots in the suite's own `os.tmpdir()` subfolder, one `rw` and one `ro` directory per test.

```ts
// RO-STATE-001
it('RO-STATE-001: marks paths inside a configured read-only dir', async () => {
  const guard = new PathGuard({ cliAllowedDirs: [rw], readOnlyDirs: [ro] });
  await guard.recomputeAllowedDirectories();
  assert.equal(guard.isReadOnlyPath(join(ro, 'x.txt')), true);
  assert.equal(guard.isReadOnlyPath(ro), true);
  assert.equal(guard.isReadOnlyPath(join(rw, 'x.txt')), false);
});

// RO-STATE-002: same via process.env['FS_READ_ONLY_DIRS'] (unset after; list form, splitDirList handles separators)
// RO-STATE-003: readOnlyDirs names a symlink to ro; isReadOnlyPath(realpath(ro)/file) is true (alias spellings)
// RO-STATE-004: getReadOnlyDirs() returns the normalized configured list, deduped, CLI+env unioned
// RO-STATE-005: a read-only dir that is not equal to, inside, or containing any allowed root
//               emits Logger.warn('Read-only root matches no allowed root: ...') and is still kept
// RO-STATE-006: readOnlyDirs inside a writable root (nested subtree): isReadOnlyPath(subtree/file) true,
//               isReadOnlyPath(rw/other.txt) false
```

Symlink creation may need privileges on Windows — mirror whatever skip/conditional pattern `__tests__/aliased-root.test.ts` uses for its symlink tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="RO-STATE"`
Expected: FAIL — `isReadOnlyPath is not a function`.

- [ ] **Step 3: Implement the state in `src/core/path.ts`**

- `ServerOptions` gains `readOnlyDirs?: string[]`.
- Fields: `private readOnlyDirsState: string[] = [];` and `private readOnlySpellings: string[] = [];` next to `rootBoundaries`.
- In `recomputeAllowedDirectories`, after the `boundaries` resolution and before `combined` is used:

```ts
const cliReadOnlyDirs = this.options?.readOnlyDirs ?? [];
const envReadOnlyDirs = await resolveConfiguredDirs('FS_READ_ONLY_DIRS', { allowMissing });
const readOnlyCombined = normalizeAllowedDirectories([...cliReadOnlyDirs, ...envReadOnlyDirs]);
const readOnlySpellings = await resolveAllowedDirectoriesState(readOnlyCombined, signal);
```

- Footgun warning, after `combined` exists: for each `ro` in `readOnlyCombined`, warn `Read-only root matches no allowed root: ${ro}` unless some root in `combined` satisfies `isSamePath(root, ro) || isPathInsideDirectory(root, ro) || isPathInsideDirectory(ro, root)`.
- Commit the two fields in the same late block as `this.rootBoundaries = boundaries;` so a rejecting recompute leaves the old view.
- `resolveAllowedDirectoriesState` already adds each dir's realpath alias, so a symlinked read-only dir is matched by both spellings.
- One comment line: read-only dirs are deliberately **not** filtered by `FS_ROOT_BOUNDARY` — a dir outside every boundary denies nothing new, since paths there are already refused.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="RO-STATE"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/path.ts __tests__/read-only-roots.test.ts
git commit -m "feat(path-guard): hold configured read-only directories

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 2: Deny writes and deletes under read-only dirs

**Files:**

- Modify: `src/core/path.ts` (`validatePathForWrite` :1124-1170, `validatePathForDelete` :1172-1257)
- Test: `__tests__/read-only-roots.test.ts`

**Interfaces:**

- Consumes: `isReadOnlyPath` from Task 1.
- Produces: denial behavior every mutating tool inherits (`create`, `edit`, `patch`, `replace_text`, `move`, `delete`, `undo` restore) because `src/core/fs.ts` funnels every mutation through these validators. Error copy is fixed below — later surfaces quote it.

- [ ] **Step 1: Write the failing tests**

```ts
// Two roots again: rw writable, ro read-only via options. Guard per test, recompute.
// RO-WRITE-001: await assert.rejects(guard.validatePathForWrite(join(ro, 'new.txt')),
//   FsError with code ACCESS_DENIED and message containing 'Read-only root' and the ro dir)
// RO-WRITE-002: guard.validatePathForWrite(join(rw, 'new.txt')) resolves
// RO-DEL-001:  validatePathForDelete of an existing file under ro rejects ACCESS_DENIED
// RO-DEL-002:  validatePathForDelete of a MISSING file under ro rejects ACCESS_DENIED
//               (pins the missing-target branch respelled through the real parent)
// RO-LINK-001: symlink in rw -> file in ro:
//                validateExistingPath(link) resolves (reads allowed)
//                validatePathForWrite(link) rejects ACCESS_DENIED (resolved target is in ro)
//                validatePathForDelete(link) resolves (deleting the link touches only rw)
// RO-NEST-001: ro subtree inside rw root: validatePathForWrite(subtree/file) rejects,
//                validatePathForWrite(rw/sibling.txt) resolves
// RO-GRANT-001: applyGrant(grantedDir, 'access') outside every ro dir -> validatePathForWrite
//                (grantedDir/file) resolves (grants default writable); a grant landing inside a
//                configured ro dir stays denied
```

No dedicated undo test: modes are fixed per process, so a journal entry can only ever target a writable root unless it sat under a ro dir all along — which Task 2's checks then refuse during restore (`src/core/undo.ts:751-754` revalidates through the same guard methods). State this reasoning as a comment in the test file, not a test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="RO-(WRITE|DEL|LINK|NEST|GRANT)"`
Expected: FAIL — writes/deletes under `ro` currently resolve.

- [ ] **Step 3: Implement `assertWritable` and its three call sites**

Private method on `PathGuard`, exact copy:

```ts
private assertWritable(path: string): void {
  const normalized = normalizePath(path);
  if (!this.isReadOnlyPath(normalized)) return;
  const ro = this.readOnlySpellings.find((dir) => isPathInsideDirectory(dir, normalized));
  throw new FsError(
    ErrorCode.ACCESS_DENIED,
    `Read-only root: ${path} is inside ${ro ?? 'a read-only root'} (--read-only-root / FS_READ_ONLY_DIRS). Writes, moves, and deletes are refused there.`,
    path,
  );
}
```

Call sites — always on a _resolved_ spelling, never the raw request:

1. `validatePathForWrite`: `this.assertWritable(resolvedTarget);` immediately before `return resolvedTarget;` (after the sensitive-file check).
2. `validatePathForDelete`, missing-target branch: `this.assertWritable(join(normalizedRealParent, basename(target)));` before `return target;` — the target does not exist to realpath, so spell it through the validated real parent, closing the symlinked-ancestor alias hole.
3. `validatePathForDelete`, symlink branch: `this.assertWritable(link);` before `return link;`.
4. `validatePathForDelete`, final branch: `this.assertWritable(realTarget);` before `return realTarget;`.

One comment where you add them: throws from `validatePathForDelete` are swallowed where it serves as a probe (`resolveTransferDestination`'s `.catch(() => undefined)`, `entryLockKey`) — by design; the write-side validation still denies those calls.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="RO-"`
Expected: PASS (Task 1's 6 plus these 8).

- [ ] **Step 5: Commit**

```bash
git add src/core/path.ts __tests__/read-only-roots.test.ts
git commit -m "feat(path-guard): refuse writes and deletes under read-only dirs

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: CLI flag, startup log, print-config, manifests, help

**Files:**

- Modify: `src/cli.ts` (`CLI_PARSER_CONFIG` :125-147, `parseArgs` :149-228, `runPrintConfig` :234-288)
- Modify: `src/index.ts` (:87-102), `src/cli-help.ts` (:26, :153)
- Modify: `server.json` (packageArguments :22-45, environmentVariables :46-54), `mcpb/manifest.json` (:20-27, :54-76)
- Test: `__tests__/cli.test.ts` (extend)

**Interfaces:**

- Consumes: `ServerOptions.readOnlyDirs` (Task 1), `PathGuard.getReadOnlyDirs()` (Task 1).
- Produces: `parseArgs()` return gains `readOnlyDirs: string[]`; `--read-only-root <dir>` repeatable flag; `FS_READ_ONLY_DIRS` env (':' Unix / ';' Windows list, like `FS_ALLOWED_DIRS`); `--print-config` JSON gains `readOnlyDirs: string[]`.

- [ ] **Step 1: Write the failing tests in `__tests__/cli.test.ts`**

```ts
// CLI-RO-001: parseArgs on ['--read-only-root', A, '--read-only-root', B, rw]
//              -> readOnlyDirs deep-equals [normalizePath(A), normalizePath(B)]
// CLI-RO-002: no flag -> readOnlyDirs is []
// CLI-RO-003: ['--read-only', '--read-only-root', A, rw] -> readOnly true AND readOnlyDirs [A]
// CLI-RO-004: --read-only-root on a missing dir rejects (CliExitError); with --allow-missing-roots kept
// CLI-RO-005: with FS_READ_ONLY_DIRS set, --print-config stdout parses as JSON whose readOnlyDirs
//              lists the env dir (follow the existing print-config test's invocation pattern)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="CLI-RO"`
Expected: FAIL — unknown option `--read-only-root` / missing field.

- [ ] **Step 3: Implement**

- `cli.ts` parser config: `'read-only-root': { type: 'string', multiple: true },` next to `'read-only'`.
- In `parseArgs`: `const readOnlyDirs = await normalizeAndValidateDirs(v['read-only-root'] ?? [], allowMissingRoots);` and return it. Positional roots are untouched — a read-only dir need not be an allowed root.
- `index.ts`: destructure `readOnlyDirs`; after the existing `Read-only mode` block print

```ts
if (readOnlyDirs.length > 0) {
  console.error('Read-only directories (writes, moves, deletes refused):');
  for (const dir of readOnlyDirs) console.error(`- ${dir}`);
}
```

and add `readOnlyDirs` to `serverOptions`.

- `runPrintConfig`: pass `readOnlyDirs` into its `PathGuard`, and add `readOnlyDirs: pathGuard.getReadOnlyDirs(),` right after `readOnly` in the JSON — the guard recompute already ran there, so env-sourced dirs appear too.
- `cli-help.ts`: add a `--read-only-root <dir>` row next to `--read-only` (flag, env var, repeatable, containment semantics: applies to any directory, including subtrees of writable roots), and extend the `--read-only` example to show mixed mode (`filesystem-mcp --read-only-root /data/refs /workspace`).
- `server.json`: packageArguments gains `{"type": "named", "name": "--read-only-root", "description": "Mark a directory read-only: writes, moves, and deletes under it are refused. Repeat for multiple.", "format": "filepath", "isRequired": false, "isRepeated": true}` after `--read-only`; environmentVariables gains an `FS_READ_ONLY_DIRS` entry mirroring the `FS_ALLOWED_DIRS` copy with the separator note. **Do not touch any version field.**
- `mcpb/manifest.json`: env gains `"FS_READ_ONLY_DIRS": "${user_config.read_only_dirs}"`; `user_config` gains `read_only_dirs` — `{"type": "directory", "title": "Read-only directories", "description": "Directories the AI may read but never change. Writes, moves, and deletes under them are refused.", "multiple": true, "default": "", "required": false}`. **Do not touch `version`.** If `__tests__/mcpb-manifest.test.ts` pins the manifest shape, extend its expectation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="CLI-RO|mcpb"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/index.ts src/cli-help.ts server.json mcpb/manifest.json __tests__/cli.test.ts __tests__/mcpb-manifest.test.ts
git commit -m "feat(cli): add --read-only-root and FS_READ_ONLY_DIRS

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 4: list_roots surface, end-to-end enforcement, contract snapshot

**Files:**

- Modify: `src/tools/list-roots.ts`, `__tests__/helpers.ts` (:186-191, :199-204)
- Test: `__tests__/read-only-roots.test.ts` (extend)
- Regenerate: `__tests__/contract.test.ts.snapshot`

**Interfaces:**

- Consumes: `getReadOnlyDirs()` (Task 1); denial behavior (Task 2); `readOnlyDirs` option (Task 3).
- Produces: `RootsOutput` gains `readOnlyDirs: string[]` (always present, `[]` when none); `createTestServer`/`createTestClientPair` options gain `readOnlyDirs?: string[]` (the spread already forwards into `createServer`).

- [ ] **Step 1: Write the failing integration tests**

Use `createTestClientPair([rw, ro], { readOnlyDirs: [ro] })` — real tool calls, no mocks:

```ts
// RO-INT-001: create under ro -> isError true, text contains 'Read-only root';
//              same create under rw -> ok
// RO-INT-002: read, list, search_text, stat under ro all succeed (read-only, not invisible)
// RO-INT-003: move rw->ro, ro->rw, ro->ro each isError; move rw->rw ok
// RO-INT-004: list_roots -> structured.roots contains both; structured.readOnlyDirs equals [ro]
// RO-INT-005: a create under rw returns an undo id; undo by that id restores the file
//              (restore path unaffected)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="RO-INT"`
Expected: FAIL — `readOnlyDirs` not accepted by helpers / absent from list_roots.

- [ ] **Step 3: Implement**

- `helpers.ts`: add `readOnlyDirs?: string[]` to both option object types (`createTestServer` :188, `createTestClientPair` :202). The spread in `createTestServer` already forwards it.
- `list-roots.ts`: `RootsOutput` gains `readOnlyDirs: string[]`; the returned `structured` gains `readOnlyDirs: ctx.fs.pathGuard.getReadOnlyDirs()`; append to the description: `'Directories marked read-only appear in readOnlyDirs; writes, moves, and deletes under them are refused.'`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="RO-INT"`
Expected: PASS.

- [ ] **Step 5: Regenerate the contract snapshot**

With **no `FS_*` environment variables set**:

```bash
node --test --test-update-snapshots __tests__/contract.test.ts
```

Review the `.snapshot` diff: expected changes are the `list_roots` output shape and the get-help text. Anything else is a bug — investigate before committing.

- [ ] **Step 6: Commit**

```bash
git add src/tools/list-roots.ts __tests__/helpers.ts __tests__/read-only-roots.test.ts __tests__/contract.test.ts.snapshot
git commit -m "feat(tools): list_roots reports read-only directories

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 5: Docs, ADR, full check

**Files:**

- Modify: `README.md` (read-only section), `docs/configuration.md`
- Create: `docs/adr/010-per-root-read-only.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Document the feature**

- `README.md`: extend the `--read-only` coverage with `--read-only-root` / `FS_READ_ONLY_DIRS` — repeatable, containment semantics (any directory, including a subtree of a writable root), global `--read-only` unchanged (still removes the mutating tools entirely), mixed mode keeps all tools advertised and refuses at call time with `Read-only root: ...`.
- `docs/configuration.md`: same facts in that file's flag/env table style.
- `docs/adr/010-per-root-read-only.md`: context (issue #162), decision — plain containment on all resolved spellings inside the three PathGuard validators, not a per-root mode table; read-only dirs unfiltered by `FS_ROOT_BOUNDARY`; grants default writable; global flag keeps the registration-time gate; undo covered transitively by restore-time revalidation. Consequences — the check shares the documented TOCTOU window of the PathGuard class comment (`src/core/path.ts:212`); `list_roots` and `--print-config` are the discovery surfaces.

- [ ] **Step 2: Run the full check**

Run: `npm run check`
Expected: static checks, tests, and the `dist/` smoke test all green.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/configuration.md docs/adr/010-per-root-read-only.md
git commit -m "docs: per-root read-only mode (issue #162)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
