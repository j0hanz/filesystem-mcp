# Audit fixes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix audit findings 1-6 and 8 of 2026-11-04: missing secret patterns, a delete that ignores cancel, a whole-file scan on every append, a keep-alive shorter than common proxies, a false overwrite prompt on folders, and code only tests reach.

**Architecture:** Six independent changes, each with its own test and commit, in the modules that already own the behaviour. No new files, modules, options or dependencies.

**Tech Stack:** TypeScript on Node 24+, `node:test`, Express 5, MCP SDK 2.x.

**Spec:** The audit report had no file. Each task quotes its finding, measured where a number exists. Audit finding 7 (`UndoPreview`) is out of scope: it is an open product decision.

## Global Constraints

- Work on a branch, not `main`. Never hand-edit a version in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json` or `.cursor-plugin/plugin.json`.
- Each user-visible fix adds one bullet under `## [Unreleased]` / `### Fixed` in `CHANGELOG.md`, in the existing style: bold sentence, then what changed.
- If a contract change is intended, run `node --test --test-update-snapshots __tests__/contract.test.ts` with no `FS_*` variables set and commit the `.snapshot` diff. No task here intends one.
- After modifying code, run `graphify update .`.
- Do not lower the coverage floor in `npm run test:coverage`. If deletions drop coverage below it, report the numbers.

## Review Focus

Each line has its test in the owning task.

1. A secret name in another case (`DEPLOY.PPK`) is still blocked, and an operator can still lift a new pattern with `--allow`. Task 1.
2. A delete cancelled during the undo snapshot leaves the tree intact and offers no undo id for a delete that never ran. Task 2.
3. An append to a file exactly at the size limit still reports its line count; one byte over reports 0 and does not scan. Task 3.
4. A client reusing a connection idle longer than the unchanged 10 s `headersTimeout` still gets an answer. Task 4.
5. A directory copied into an existing directory still keeps the source's times after the copy options go. Task 6.

---

### Task 1: Block the missing secret files

**Finding 1:** `isSensitive` returned false for `deploy.ppk`, `app.jks`, `app.keystore`, `key.p8`, `.envrc`, `.dockercfg`, `.s3cfg` and `.htpasswd`, while the README says private keys and cloud credentials are blocked.

**Files:**

- Modify: `src/core/sensitive.ts:283-320`
- Modify: `docs/configuration.md:103-106`, `CHANGELOG.md`
- Test: `__tests__/security.test.ts`

**Interfaces:**

- Consumes: `SensitiveMatcher`, `withEnv` from `__tests__/helpers.ts`
- Produces: nothing later tasks use

- [ ] **Step 1: Create the branch**

Run: `git switch -c fix/audit-2026-11-04`
Expected: `Switched to a new branch 'fix/audit-2026-11-04'`

- [ ] **Step 2: Write the failing tests**

```ts
const NEW_SECRET_NAMES = [
  '.envrc',
  'deploy.ppk',
  'app.jks',
  'app.keystore',
  'key.p8',
  '.dockercfg',
  '.s3cfg',
  '.htpasswd',
];

it('blocks private key and credential files by default', () => {
  const matcher = new SensitiveMatcher();
  for (const name of NEW_SECRET_NAMES) {
    assert.strictEqual(matcher.isSensitive(`/w/${name}`), true, name);
  }
  assert.strictEqual(matcher.isSensitive('/w/DEPLOY.PPK'), true, 'case-folded');
  assert.strictEqual(matcher.isSensitive('/w/key.p8.md'), false, 'a suffix is another name');
  assert.strictEqual(matcher.isSensitive('/w/.envrc.example'), false);
});

it('lets --allow lift a new built-in pattern', async () => {
  await withEnv({ FS_ALLOWLIST: 'debug.keystore' }, () => {
    const matcher = new SensitiveMatcher();
    assert.strictEqual(matcher.isSensitive('/w/debug.keystore'), false);
    assert.strictEqual(matcher.isSensitive('/w/release.keystore'), true);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test --test-name-pattern="private key and credential|lift a new built-in" __tests__/security.test.ts`
Expected: FAIL at `.envrc`.

- [ ] **Step 4: Add the patterns**

Add to `DEFAULT_SENSITIVE_PATTERNS`: `'.envrc'`, `'*.ppk'`, `'*.jks'`, `'*.keystore'`, `'*.p8'`, `'.dockercfg'`, `'.s3cfg'`, `'.htpasswd'`.

In `docs/configuration.md`, add them to the rows: `.envrc` to Environment files; `.htpasswd` to Package and git creds; `.dockercfg` and `.s3cfg` to Cloud and tools; `*.ppk`, `*.jks`, `*.keystore` and `*.p8` to Keys and certificates. Keep the table aligned; `prettier --check` enforces it.

Changelog: say that these files are now blocked and that `--allow` lifts one, for example `--allow debug.keystore`.

- [ ] **Step 5: Run the tests and the contract snapshot**

Run: `node --test __tests__/security.test.ts __tests__/contract.test.ts`
Expected: PASS, with no snapshot diff.

- [ ] **Step 6: Commit**

```bash
git add src/core/sensitive.ts docs/configuration.md CHANGELOG.md __tests__/security.test.ts
git commit -m "fix: block more private key and credential files"
```

### Task 2: A cancelled delete stops before removing anything

**Finding 2:** `rm` saves the tree for undo, then removes it. Neither step sees the cancel signal and `delete` has no deadline, so a cancel during the save still removes the folder.

**Files:**

- Modify: `src/core/fs.ts:979-988`, `src/tools/delete.ts:146-150,183-186,202-207`, `CHANGELOG.md`
- Test: `__tests__/delete.test.ts`

**Interfaces:**

- Consumes: `UndoJournal.beginCapture()`, `UndoCapture.unavailableReason()`, `UndoCapture.records`, `choose` and `runToolBodyResult` from `tool-harness.ts`
- Produces: `GuardedFileSystem.rm(filePath: string, options?: Parameters<typeof fsRm>[1], signal?: AbortSignal): Promise<void>`

- [ ] **Step 1: Write the failing test**

`GuardedFileSystem.readSaved` is public and runs once per saved file, so a subclass can fire the cancel mid-snapshot. Add `UndoJournal` and `makeGuard` imports if the file lacks them, and use the file's existing test-root helper for `root`.

```ts
it('a cancel during the undo snapshot deletes nothing and offers no undo', async () => {
  const tree = join(root, 'cancelled-tree');
  await mkdir(tree);
  await writeFile(join(tree, 'a.txt'), 'a');
  const controller = new AbortController();
  const capture = new UndoJournal().beginCapture();
  class CancelsDuringSnapshot extends GuardedFileSystem {
    override async readSaved(path: string): Promise<Buffer> {
      controller.abort();
      return super.readSaved(path);
    }
  }
  const cancelling = new CancelsDuringSnapshot(await makeGuard([root]), capture);
  const result = await runToolBodyResult(
    DELETE,
    { paths: [tree], recursive: true },
    { fs: cancelling, signal: controller.signal, confirm: choose('delete') },
  );
  assert.strictEqual(result.isError, true);
  assert.strictEqual(
    result.structured.results[0] && 'error' in result.structured.results[0]
      ? result.structured.results[0].error.code
      : undefined,
    ErrorCode.CANCELLED,
  );
  await access(join(tree, 'a.txt'));
  assert.strictEqual(capture.records.length, 0);
  assert.match(capture.unavailableReason() ?? '', /cancelled before anything was deleted/u);
  capture.release();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --test-name-pattern="cancel during the undo snapshot" __tests__/delete.test.ts`
Expected: FAIL at `isError`, or at `access` with `ENOENT`: the tree was deleted.

- [ ] **Step 3: Implement**

In `GuardedFileSystem.rm`, between `snapshotTree` and `fsRm`:

```ts
if (signal?.aborted) {
  capture?.abandon('cancelled before anything was deleted');
  signal.throwIfAborted();
}
```

The abandon keeps the executor from minting an undo id for a delete that never ran.

In `delete.ts`, add `'signal'` to the `Pick<ToolCtx, ...>` of `finalizeDeletion` and `executePlan`, and pass `ctx.signal` as the third argument of `ctx.fs.rm`. `diskWorld`'s `fs.rm(path)` in `undo.ts` stays as it is.

Changelog: a cancel that lands while a recursive delete saves its undo copy now keeps the folder.

- [ ] **Step 4: Run the tests**

Run: `node --test __tests__/delete.test.ts __tests__/undo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/fs.ts src/tools/delete.ts CHANGELOG.md __tests__/delete.test.ts
git commit -m "fix: stop a recursive delete cancelled during its undo snapshot"
```

### Task 3: An append to a large file does not scan it

**Finding 3:** Each `create` append counts lines over the whole file, inside the write lock, with no deadline. On a 2 GiB log the append took 3 ms and the count 5,934 ms.

**Files:**

- Modify: `src/tools/create.ts:358`, `CHANGELOG.md`
- Test: `__tests__/create.test.ts`

**Interfaces:**

- Consumes: `getMaxTextFileSize()` from `src/core/util.ts`, already imported
- Produces: nothing later tasks use

- [ ] **Step 1: Write the failing test**

Use `withEnv` to set the smallest allowed limit (`FS_MAX_FILE_SIZE` min 1 MiB), so the test needs only a small file. `MIB` comes from `src/core/util.ts`.

```ts
it('counts lines up to the size limit and not past it', async (t) => {
  await withEnv({ FS_MAX_FILE_SIZE: String(MIB) }, async () => {
    const count = t.mock.method(GuardedFileSystem.prototype, 'countFileLines');
    const content = 'x\n';
    const atLimit = await writeTestFile(root, 'at_limit.log', 'a'.repeat(MIB - content.length));
    const at = await create({ files: [{ path: atLimit, content, append: true }] });
    assert.strictEqual(at.structured.files[0]?.lineCount, 1);
    assert.strictEqual(count.mock.callCount(), 1);

    const over = await writeTestFile(root, 'over_limit.log', 'a'.repeat(MIB - content.length + 1));
    const past = await create({ files: [{ path: over, content, append: true }] });
    assert.strictEqual(past.structured.files[0]?.lineCount, 0);
    assert.strictEqual(count.mock.callCount(), 1, 'no scan past the limit');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test --test-name-pattern="counts lines up to the size limit" __tests__/create.test.ts`
Expected: FAIL on the over-limit `lineCount` or call count.

- [ ] **Step 3: Implement**

Replace line 358 with a count only when `stats.size <= getMaxTextFileSize()`, otherwise leave `lineCount` at its existing `0`. Add a one-line comment: past the limit the scan costs seconds per append (5.9 s at 2 GiB), so the count stays the existing unknown-as-zero. The leading-bytes MIME sniff above it stays.

Changelog: appending to a file over the size limit no longer scans it, and `lineCount` is 0 for such a file.

- [ ] **Step 4: Run the tests**

Run: `node --test __tests__/create.test.ts __tests__/core-fs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/create.ts CHANGELOG.md __tests__/create.test.ts
git commit -m "fix: skip the line count when appending past the size limit"
```

### Task 4: Keep idle HTTP connections longer than common proxies

**Finding 4:** `KEEPALIVE_TIMEOUT_MS` is 5 s, while its own comment says it must exceed any proxy's idle timeout, and the docs support reverse proxies. AWS ALB and nginx `keepalive_timeout` default to 60 s, so a proxy can reuse a connection the server already closed, which gives intermittent 502s.

**Files:**

- Modify: `src/transport/http.ts:46-48,342-343`, `CHANGELOG.md`
- Test: `__tests__/http-server.test.ts`

**Interfaces:**

- Consumes: `startHttpServer(port, options)` from `src/transport.ts`
- Produces: nothing later tasks use

- [ ] **Step 1: Write the failing test**

Add `Agent` to the `node:http` import and `setTimeout as sleep` from `node:timers/promises`. Use the file's existing temp-root setup for `tmpDir`.

```ts
describe('keep-alive', () => {
  it('outlasts a 60 s proxy idle timeout and keeps the header limit', async () => {
    const server = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    try {
      assert.strictEqual(server.keepAliveTimeout, 65_000);
      assert.strictEqual(server.headersTimeout, 10_000);
    } finally {
      await server[Symbol.asyncDispose]();
    }
  });

  // Slow on purpose: idle past the 10 s headersTimeout must not end the connection.
  it('answers on a connection idle past the header limit', async () => {
    const server = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const { port } = server.address() as AddressInfo;
    const get = () =>
      new Promise<{ status: number | undefined; reused: boolean }>((resolve, reject) => {
        const req = request({ port, path: '/healthz', agent }, (res) => {
          res.resume();
          res.on('end', () => {
            resolve({ status: res.statusCode, reused: req.reusedSocket });
          });
        });
        req.on('error', reject);
        req.end();
      });
    try {
      assert.strictEqual((await get()).status, 200);
      await sleep(11_000);
      assert.deepStrictEqual(await get(), { status: 200, reused: true });
    } finally {
      agent.destroy();
      await server[Symbol.asyncDispose]();
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test --test-name-pattern="keep-alive" __tests__/http-server.test.ts`
Expected: FAIL: `keepAliveTimeout` is 5000, and the second request is not on a reused socket.

- [ ] **Step 3: Implement**

Set `KEEPALIVE_TIMEOUT_MS = 65_000` and extend its comment to say it clears the 60 s default of ALB and nginx. Add `const HEADERS_TIMEOUT_MS = 10_000;` and assign it to `httpServer.headersTimeout`, in place of `KEEPALIVE_TIMEOUT_MS + 5_000`. This keeps today's 10 s limit on a slow client sending headers. If the idle test fails on the second request, stop and report: Node would be applying `headersTimeout` to idle connections, and this decision needs revisiting.

Changelog: idle HTTP connections now stay open 65 s, so a reverse proxy no longer reuses one the server closed.

- [ ] **Step 4: Run the tests**

Run: `node --test __tests__/http-server.test.ts __tests__/http-transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transport/http.ts CHANGELOG.md __tests__/http-server.test.ts
git commit -m "fix: keep idle HTTP connections past common proxy timeouts"
```

### Task 5: `create` refuses a folder without asking

**Finding 6:** A path that is a folder gets `"already exists. Overwrite it?"`, and after a yes the rename fails. With `overwrite: true` the raw OS error comes back.

**Files:**

- Modify: `src/tools/create.ts:156-171,209-224`, `CHANGELOG.md`
- Test: `__tests__/create.test.ts`

**Interfaces:**

- Consumes: `destIdentity`, `EntryIdentity.itemType` from `src/core/fs.ts`
- Produces: nothing later tasks use

- [ ] **Step 1: Write the failing tests**

`create` here is the file's helper, which forwards `ToolBodyOptions`. With no `confirm` option, a prompt makes `runToolBodyResult` throw, so these fail on any prompt. `symlink` needs importing from `node:fs/promises`.

```ts
it('refuses a folder as NOT_FILE without asking', async () => {
  const dir = join(root, 'a_folder');
  await mkdir(dir);
  const other = join(root, 'beside_folder.txt');
  for (const overwrite of [undefined, true]) {
    const result = await create({
      files: [
        { path: dir, content: 'x', ...(overwrite ? { overwrite } : {}) },
        { path: other, content: 'y', overwrite: true },
      ],
    });
    assert.strictEqual(result.structured.failures?.[0]?.error.code, ErrorCode.NOT_FILE);
    assert.strictEqual(result.structured.files.length, 1, 'the other entry still writes');
    assert.ok((await stat(dir)).isDirectory());
  }
});

it('refuses a link to a folder the same way', async (t) => {
  const dir = join(root, 'link_target');
  await mkdir(dir);
  const link = join(root, 'folder_link');
  try {
    await symlink(dir, link, 'junction');
  } catch {
    return t.skip('cannot create symlinks here');
  }
  const result = await create({ files: [{ path: link, content: 'x' }] });
  assert.strictEqual(result.structured.failures?.[0]?.error.code, ErrorCode.NOT_FILE);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test --test-name-pattern="refuses a folder|link to a folder" __tests__/create.test.ts`
Expected: FAIL with `tool-harness: create asked for input`.

- [ ] **Step 3: Implement**

In phase 1:

- Skip the stat only for `append`, since `appendFile` already refuses a non-file.
- When `identity?.itemType === 'directory'`, record the requested path in a `Set<string>` named `folders` and return `undefined`.
- Then return `undefined` for `overwrite`, as before.

In the `runOverPaths` body, first line: `if (folders.has(path)) throw new FsError(ErrorCode.NOT_FILE, 'Not a regular file', path);`, the wording `assertFileStats` uses.

A FIFO or other non-file keeps today's prompt. If an existing test expects a prompt for a folder, it pinned this bug: change it to the new behaviour and say so in the commit.

Changelog: `create` on a folder now fails with `NOT_FILE`, without a prompt it could never honour.

- [ ] **Step 4: Run the tests**

Run: `node --test __tests__/create.test.ts __tests__/confirmation.test.ts __tests__/confirmation-gaps.test.ts __tests__/input-required.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/create.ts CHANGELOG.md __tests__/create.test.ts
git commit -m "fix: refuse a folder in create without an overwrite prompt"
```

### Task 6: Delete what only tests reach

**Findings 5 and 8:** `planTransfer`'s `copy` options are never passed in production (`src/tools/move.ts:104`), and their branches sit in security-sensitive copy code. `destExists` wraps one line and has one caller. Pure removal, no behaviour change, so no changelog entry.

**Files:**

- Modify: `src/core/fs.ts:101-107,130-131,142,253-261,275,306,519-555,590,610,1010-1051,1063,1099-1118,1141-1200,1505-1526,1595-1605`
- Modify: `src/tools/create.ts:19,245`
- Modify: `__tests__/helpers.ts:155-168`, `__tests__/transfer.test.ts:141-202,224-236`, `__tests__/read-only-roots.test.ts:251-266`, `__tests__/path-guard-unc.test.ts` (the test at line 674), `__tests__/core-fs.test.ts:30,2067-2071,2171-2173`

**Interfaces:**

- Consumes: nothing from earlier tasks
- Produces:
  - `planTransfer(op, pair, { signal }?: { signal?: AbortSignal })`
  - `#relocationWalk(op, entry, requestedFrom, destination, signal?, acrossDevices = false)`
  - `#copy(source, destination)`, `#copyIntoPlace(validSource, validDest)`, `#copyMerging(validSource, validDest)`, `#copyMergedDir(source, destination)`
  - `async function bothOfKind(source: string, destination: string): Promise<'file' | 'directory' | undefined>`: lstats both ends, returns the kind when both are regular files or both directories, and `undefined` otherwise or on any lstat failure
  - `copyVia(fs, source, destination): Promise<void>` in `__tests__/helpers.ts`

- [ ] **Step 1: Pin the default the removal must keep**

Add to `__tests__/transfer.test.ts`:

```ts
it('a directory merged into another keeps the source directory times', async () => {
  const { root, fs } = await setup();
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'dst'));
  await writeFile(join(root, 'src', 'a.txt'), 'new');
  await writeFile(join(root, 'dst', 'a.txt'), 'old');
  const oldTime = new Date('2001-02-03T04:05:06.000Z');
  await utimes(join(root, 'src'), oldTime, oldTime);
  await copyVia(fs, join(root, 'src'), join(root, 'dst'));
  assert.equal(await readFile(join(root, 'dst', 'a.txt'), 'utf8'), 'new');
  assert.equal((await stat(join(root, 'dst'))).mtimeMs, oldTime.getTime());
});
```

Run: `node --test --test-name-pattern="keeps the source directory times" __tests__/transfer.test.ts`
Expected: PASS before the removal. It guards the next step.

- [ ] **Step 2: Remove the `copy` option from `fs.ts`**

- Remove `TransferPlan.copy`, the `CopyFilter` type, and the `filter` parameter and both its uses in `#relocationWalk`. Update the `#moveAcrossDevices` call to the new signature.
- In `#copy`, remove `callerFilter`, the `force`/`recursive` conditions and the `options` spread. It calls `bothOfKind` once: `'file'` goes to `#copyIntoPlace`, `'directory'` to `#copyMerging`, anything else to the plain `fsCp`, which keeps its guard `filter`.
- In `#copyMergedDir`, source times are always preserved, so `sourceStats` is unconditional. Its inner `fsCp` keeps its guard `filter`.
- Replace `fileOverFile` and `directoryIntoDirectory` with `bothOfKind`, and update doc comments that mention the option.

- [ ] **Step 3: Update the tests**

Drop the `options` parameter from `copyVia`. Delete the tests that exist only for the option:

- `keeps the plain cp refusal of a non-recursive directory copy, merged or not`
- `passes preserveTimestamps: false through to a staged overwrite`
- `a copy filter prunes the Relocation walk`
- `RO-COPY-FILTER-001`
- `lets a copy filter that refuses the link copy the rest`

Remove imports they leave unused.

Run: `npm run type-check:test`
Expected: exit 0. An error naming `copy` or `filter` is a missed call site.

- [ ] **Step 4: Inline `destExists`**

In `create.ts:245`, use `(await destIdentity(ctx.fs, resolvedTarget, 'create')) !== undefined`, and drop the import. Delete `destExists` from `fs.ts`. In `core-fs.test.ts`, keep `STAT-FD-006` and `STAT-FD-010` on `destIdentity`: a refused stat is `!== undefined`, and `never-created.txt` and a path under a regular file are `=== undefined`.

- [ ] **Step 5: Run the affected tests**

Run: `node --test __tests__/transfer.test.ts __tests__/move.test.ts __tests__/move-exdev.test.ts __tests__/read-only-roots.test.ts __tests__/path-guard-unc.test.ts __tests__/core-fs.test.ts __tests__/create.test.ts __tests__/relocation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/fs.ts src/tools/create.ts __tests__
git commit -m "refactor: remove test-only copy options and the destExists wrapper"
```

- [ ] **Step 7: Run the full check on both platforms**

From PowerShell, one command at a time:

```powershell
npm run check
wsl bash -lc "source ~/.nvm/nvm.sh && cd /mnt/c/filesystem-mcp && npm test"
npm run test:coverage
graphify update .
```

Expected: all pass, 0 failed, and the coverage floor holds.
