# Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the bugs and security gaps from the 2026-11-03 repo audit, and delete the code it found unneeded.

**Architecture:** Small independent fixes, each at the shared code that owns the rule. No new modules, options or dependencies. One breaking default change (`replace_text` case) and one removed field (`maxResults`), both noted in the changelog.

**Tech Stack:** TypeScript on Node 24 (type stripping), `node:test`, Zod, Express.

**Spec:** The audit report exists only in chat, so each task restates its finding under **Finding** (numbers match the report). Finding 8 and the smaller findings left out of the report are out of scope; see Out of Scope.

## Global Constraints

- Work on branch `fix/audit-2026-11-03`, not `main`.
- No new dependencies.
- Never hand-edit a version in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json` or `.cursor-plugin/plugin.json`.
- A user-visible change gets one entry under `## [Unreleased]` in `CHANGELOG.md`, in the existing style: a bold sentence, then what changed. Use `### Changed`, `### Fixed` or `### Removed`.
- When the advertised surface changes, run `node --test --test-update-snapshots __tests__/contract.test.ts` with no `FS_*` variables set, and commit the `.snapshot` diff with the change.
- If a test written to fail passes before the fix, stop that task and report it. Findings 5 and 6 come from reading code, and the bug may not be real.

## Review Focus

Each line has a test in the task named.

1. Several outside folders, some accepted and some declined, plus an overwrite: accepted ones are written, declined ones fail, nothing loops (Task 1).
2. `--allow` on a newly denied file, such as `.git/config`: the file reads again (Task 2).
3. A project under `~/.config/myapp`: still grantable, because only credential folders and their parents are refused (Task 3).
4. `search_text` finds `GetUser` under its case-insensitive default, then `replace_text` with `getUser` matches nothing: zero matches, no write, no error (Task 4).
5. A plain file or sibling folder beside a nested root: still deletable (Task 5).

---

### Task 1: Declined grant no longer loops

**Finding 1:** `create` with one path outside the roots and one existing file, declining the grant and accepting the overwrite, alternates both prompts for 10 rounds and then fails with `still required input after 10 rounds`. Nothing is written. The confirm round sees the declined folder and asks for the grant again.

**Files:**
- Modify: `src/tools/define.ts:400-404`
- Test: `__tests__/relative-paths.test.ts` (after the test at line 203)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `this.toolCtx.requestState?.()`, which returns verified state with an `op` field.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Model both on the test at `relative-paths.test.ts:203`.

```ts
it('a declined grant plus an accepted overwrite writes the rest and stops asking', async () => {
  const outside = join(base, 'declined');
  await mkdir(outside, { recursive: true });
  await writeTestFile(root, 'existing.txt', 'old');
  const prompts: string[] = [];
  const harness = await createElicitationClientPair([root], (request) => {
    const { message, requestedSchema } = request.params as {
      message: string;
      requestedSchema?: { properties?: Record<string, unknown> };
    };
    prompts.push(message);
    return 'choice' in (requestedSchema?.properties ?? {})
      ? { action: 'accept' as const, content: { choice: 'overwrite' } }
      : { action: 'decline' as const };
  });
  try {
    const result = await harness.client.callTool({
      name: 'create',
      arguments: {
        files: [
          { path: join(outside, 'n.txt'), content: 'n' },
          { path: 'existing.txt', content: 'new' },
        ],
      },
    });
    assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
    assert.strictEqual(prompts.length, 2, JSON.stringify(prompts));
    assert.strictEqual(await readFile(join(root, 'existing.txt'), 'utf-8'), 'new');
    await assert.rejects(readFile(join(outside, 'n.txt')));
    const { failures } = result.structuredContent as { failures: { error: { code: string } }[] };
    assert.strictEqual(failures[0]?.error.code, 'ACCESS_DENIED');
  } finally {
    await harness.close();
  }
});
```

Add a second test, `'a partly accepted multi-folder grant plus an overwrite stops asking'`. Use two outside folders and answer the grant with `{ choice: [firstDir] }`, as `TC-FUNC-070` does at `__tests__/tools.test.ts:681`. Both the grant and the overwrite forms use a `choice` field here, so tell them apart by message: the grant message starts with `Grant filesystem access`. Assert 2 prompts, the accepted file written, the declined file absent, and `existing.txt` overwritten.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test --test-name-pattern="stops asking" __tests__/relative-paths.test.ts`
Expected: FAIL with `still required input after 10 rounds`.

- [ ] **Step 3: Skip the grant check on a non-grant round**

In `precheckGrant`, directly after `if (grantDirs.length === 0) return undefined;`:

```ts
// The grant round always comes first. A folder still ungranted in a later
// round was declined, and validateAccess fails it closed.
const state = this.toolCtx.requestState?.();
if (state !== undefined && state.op !== 'grant') return undefined;
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test __tests__/relative-paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the changelog entry and commit**

`### Fixed`: `**Declining a folder request no longer loops.**`

```bash
git add src/tools/define.ts __tests__/relative-paths.test.ts CHANGELOG.md
git commit -m "fix: stop re-asking for a declined grant on later rounds"
```

### Task 2: Block the missing secret files

**Finding 2:** `isSensitive` returns false for `.git/config`, `.yarnrc.yml`, `.config/gh/hosts.yml`, `.azure/accessTokens.json`, `.config/gcloud/credentials.db` and `terraform.tfstate`. A repo cloned with a token in its URL hands that token to the model on a plain `read`, while the README says cloud credentials are blocked.

**Files:**
- Modify: `src/core/sensitive.ts:283-308`
- Modify: `docs/configuration.md:80`
- Test: `__tests__/security.test.ts:585-641`
- Modify: `CHANGELOG.md`

**Interfaces:** none. `DEFAULT_SENSITIVE_PATTERNS` stays private.

- [ ] **Step 1: Write the failing tests**

In the test at line 585, add to `denied`: `.git/config`, `.yarnrc.yml`, `.config/gh/hosts.yml`, `.azure/accessTokens.json`, `.azure/a/b.json`, `.config/gcloud/credentials.db`, `terraform.tfstate`, `x.tfstate.backup`.

Add to `allowed`: `.git/HEAD`, `git/config`, `src/config`, `.config/gh/config.yml`, `azure/x`, `tfstate.md`.

In the `fixtures` table at line 616, add:

```ts
'.git/config': '/r/.git/config',
'.yarnrc.yml': '/r/.yarnrc.yml',
'.config/gh/hosts.yml': '/home/u/.config/gh/hosts.yml',
'.azure/**': '/home/u/.azure/accessTokens.json',
'.config/gcloud/**': '/home/u/.config/gcloud/credentials.db',
'*.tfstate': '/r/terraform.tfstate',
'*.tfstate.*': '/r/terraform.tfstate.backup',
```

Add a test, `'--allow lifts a newly denied file'`: with `withEnv({ FS_ALLOWLIST: '.git/config' }, ...)`, `new SensitiveMatcher().isSensitive('/r/.git/config')` is `false`. Use the same `withEnv` form as the fixtures test.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test --test-name-pattern="denylist|deny entry|newly denied" __tests__/security.test.ts`
Expected: FAIL with `.git/config must be denied`.

- [ ] **Step 3: Add the seven patterns**

Add the seven keys above to `DEFAULT_SENSITIVE_PATTERNS`, then add them to the table in `docs/configuration.md:80`. A probe through `FS_DENYLIST` already confirmed they match these targets and leave the `allowed` names readable.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test __tests__/security.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the changelog entry and commit**

`### Changed`, because reads that worked now refuse: `**More secret files are blocked by default.**` List the patterns and say `--allow` lifts them.

```bash
git add src/core/sensitive.ts docs/configuration.md __tests__/security.test.ts CHANGELOG.md
git commit -m "fix: deny git, yarn, gh, azure, gcloud and terraform secrets by default"
```

### Task 3: Close the holes in the grant safety list

**Finding 3:** `isUnsafeCwdPath` returns false for `~/.config`, which contains `.config/gcloud`, because home credential folders are only checked for "inside", not "contains". `~/.azure` also passes. On Linux, `/proc`, `/sys`, `/dev` and `/boot` are missing, so reading `/proc/self/environ` can offer a grant for a file that holds `FS_API_KEY`.

**Files:**
- Modify: `src/core/path-discovery.ts:64,82,98-100`
- Test: `__tests__/path-guard-grant.test.ts` (after the test at line 239)
- Modify: `CHANGELOG.md`

**Interfaces:** `isUnsafeCwdPath(normalizedCwd: string): boolean` keeps its signature. `isPathInsideDirectory(directory, candidate)` is inclusive, directory first.

- [ ] **Step 1: Write the failing tests**

Import `homedir` from `node:os` if it is not already imported.

```ts
it('a folder holding a home credential folder is unsafe, its siblings are not', () => {
  const home = homedir();
  for (const sub of ['.config', '.config/gh', '.config/gcloud', '.azure', '.azure/x']) {
    assert.ok(isUnsafeCwdPath(join(home, sub)), `${sub} must be unsafe`);
  }
  for (const sub of ['projects', '.config/myapp']) {
    assert.strictEqual(isUnsafeCwdPath(join(home, sub)), false, `${sub} must stay grantable`);
  }
});

it(
  'Linux virtual and boot folders are unsafe',
  { skip: process.platform === 'win32' && 'POSIX paths' },
  () => {
    for (const dir of ['/proc', '/proc/self', '/sys', '/dev', '/dev/shm', '/boot']) {
      assert.ok(isUnsafeCwdPath(dir), `${dir} must be unsafe`);
    }
  },
);
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test --test-name-pattern="credential folder" __tests__/path-guard-grant.test.ts`
Expected: FAIL with `.config must be unsafe`.

- [ ] **Step 3: Extend the lists and the check**

Add `/proc`, `/sys`, `/dev` and `/boot` to the POSIX list at line 64. Add `.config/gh` and `.azure` to `UNSAFE_HOME_SUBDIRS`. Replace the loop body at line 99:

```ts
const secrets = normalizePath(join(home, sub));
if (isPathInsideDirectory(secrets, candidate) || isPathInsideDirectory(candidate, secrets)) {
  return true;
}
```

- [ ] **Step 4: Run the tests on Windows and Linux**

Run from PowerShell:

```powershell
node --test __tests__/path-guard-grant.test.ts
wsl bash -lc "source ~/.nvm/nvm.sh && cd /mnt/c/filesystem-mcp && node --test __tests__/path-guard-grant.test.ts"
```

Expected: PASS on both, with the Linux test run (not skipped) under WSL.

- [ ] **Step 5: Add the changelog entry and commit**

`### Fixed`: `**Grants refuse more unsafe folders.**` Name `~/.config`, `~/.azure` and the Linux folders.

```bash
git add src/core/path-discovery.ts __tests__/path-guard-grant.test.ts CHANGELOG.md
git commit -m "fix: refuse grants on folders holding credentials and on Linux virtual dirs"
```

### Task 4: `replace_text` matches case by default

**Finding 4:** `replace_text` defaults to case-insensitive, while its description says "like sed -i" and "Exact literal text". Renaming `getUser` to `fetchUser` also rewrites `GetUser` and `GETUSER`. This is a breaking default change. `search_text` keeps its own default.

**Files:**
- Modify: `src/tools/replace-text.ts:81-83`
- Modify: `__tests__/replace-text.test.ts` (lines 98, 111, 195, 1025)
- Modify: `__tests__/contract.test.ts.snapshot`
- Modify: `CHANGELOG.md`

**Interfaces:** the `replace_text` input `caseSensitive` default goes from `false` to `true`.

- [ ] **Step 1: Write the failing tests**

In `replace-text.test.ts`, using the `replace` helper at line 102 and the same file fixture as its neighbours:

```ts
it('matches case exactly by default, and ignores case when asked', async () => {
  // file holds 'getUser GetUser GETUSER'
  const exact = await replace({ path: file, searchPattern: 'getUser', replacement: 'fetchUser' });
  assert.strictEqual(await readFile(file, 'utf-8'), 'fetchUser GetUser GETUSER');
  assert.strictEqual(exact.structured.totalMatches, 1);

  await writeFile(file, 'getUser GetUser GETUSER');
  await replace({ path: file, searchPattern: 'getUser', replacement: 'x', caseSensitive: false });
  assert.strictEqual(await readFile(file, 'utf-8'), 'x x x');
});

it('a pattern that differs only in case is zero matches, not an error', async () => {
  // file holds 'GetUser'
  const result = await replace({ path: file, searchPattern: 'getUser', replacement: 'x' });
  assert.notStrictEqual(result.isError, true);
  assert.strictEqual(result.structured.totalMatches, 0);
  assert.strictEqual(await readFile(file, 'utf-8'), 'GetUser');
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test --test-name-pattern="by default, and ignores|only in case" __tests__/replace-text.test.ts`
Expected: FAIL. The file reads `fetchUser fetchUser fetchUser`.

- [ ] **Step 3: Change the default**

```ts
caseSensitive: z
  .boolean()
  .default(true)
  .describe('Match case exactly (default: true). Pass false to ignore case.'),
```

- [ ] **Step 4: Pin the tests that relied on the old default**

A trial run showed exactly four tests break: `case-insensitive literal replaces 300 matches` (98), `case-insensitive literal rewrites exactly` (111), `converts LF literal text to CRLF` (195) and `treats non-ASCII letters and punctuation edges` (1025). In each, pass `caseSensitive: false` on the calls that use the default. Update the comment at line 215 if its wording no longer holds.

Run: `node --test __tests__/replace-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the contract snapshot**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`
Expected: the `.snapshot` diff shows only the `caseSensitive` default and description. If the `tools/list` budget test in `__tests__/tools.test.ts` fails, shorten the description rather than raise the budget.

- [ ] **Step 6: Add the changelog entry and commit**

`### Changed`: `**`replace_text` matches case by default.**` Say that `caseSensitive: false` restores the old behaviour.

```bash
git add src/tools/replace-text.ts __tests__/replace-text.test.ts __tests__/contract.test.ts.snapshot CHANGELOG.md
git commit -m "fix!: make replace_text case-sensitive by default"
```

### Task 5: Refuse deleting a folder that holds a root

**Finding 5:** Deleting an allowed root is refused, and so is deleting a folder that contains a read-only folder. A folder that contains a root is not refused. With roots `/w` and `/w/sub/proj`, deleting `/w/sub` removes the root.

**Files:**
- Modify: `src/core/path.ts:1359-1368`
- Test: `__tests__/delete.test.ts` (after the test at line 77)
- Modify: `CHANGELOG.md`

**Interfaces:** consumes `isSamePath` and `isPathInsideDirectory`, both already used in `path.ts`, and the local `allowedDirs`.

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses a directory that holds another allowed root, and spares its neighbours', async () => {
  const top = await createTestRoot();
  const a = join(top, 'a');
  const sub = join(a, 'sub');
  const b = join(sub, 'proj');
  try {
    await mkdir(b, { recursive: true });
    await mkdir(join(a, 'other'));
    await writeFile(join(b, 'keep.txt'), 'keep');
    await writeFile(join(sub, 'beside.txt'), 'x');
    const guard = await makeGuard([a, b]);
    const result = await del(
      { paths: [sub], recursive: true },
      { fs: new GuardedFileSystem(guard) },
    );
    assert.strictEqual(result.isError, true);
    assert.match(result.text ?? '', /Allowed root inside/);
    await access(join(b, 'keep.txt'));

    // A copy leaves its source in place, so it may still read the parent.
    await guard.validatePathForDelete(sub, { allowReadOnly: true });
    // The check covers only directories that hold the root.
    await guard.validatePathForDelete(join(sub, 'beside.txt'));
    await guard.validatePathForDelete(join(a, 'other'));
  } finally {
    await cleanupTestRoot(top);
  }
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test --test-name-pattern="holds another allowed root" __tests__/delete.test.ts`
Expected: FAIL, because `result.isError` is not `true`.

If it passes, stop and report. The finding was read from code only.

- [ ] **Step 3: Add the check beside the read-only one**

Inside `if (stats.isDirectory()) {`, before `const inside = ...`:

```ts
// Excludes the root itself: delete.ts names that case, as "workspace root".
const root = allowedDirs.find(
  (dir) => !isSamePath(realTarget, dir) && isPathInsideDirectory(realTarget, dir),
);
if (root !== undefined) {
  throw new FsError(
    ErrorCode.ACCESS_DENIED,
    `Allowed root inside: ${realTarget} contains ${root}. Deletes and moves of a parent directory are refused there.`,
    requestedPath,
  );
}
```

A trial without the `isSamePath` exclusion broke `refuses an allowed root reached through an aliasing junction` at `delete.test.ts:77`, so keep it.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test __tests__/delete.test.ts __tests__/read-only-roots.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the changelog entry and commit**

`### Fixed`: `**A root can no longer be removed through its parent.**`

```bash
git add src/core/path.ts __tests__/delete.test.ts CHANGELOG.md
git commit -m "fix: refuse deleting or moving a directory that holds an allowed root"
```

### Task 6: Path completion checks the real path

**Finding 6:** Completion checks the denylist only under the spelling the client typed, while `list` also checks the real path. With root `/alias -> /real` and a deny on `/real/private/hidden*`, completing `/alias/private/` shows the blocked name. File contents stay safe.

**Files:**
- Modify: `src/core/path-completer.ts:125-126`
- Test: `__tests__/aliased-root.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:** consumes `pathGuard.isSensitive(path: string): boolean` and the local `listable`.

- [ ] **Step 1: Write the failing test**

Add it to the aliased-root suite, using the `complete` form from line 64. Needs its own client pair, since the deny must be set before the pair is created:

```ts
it('completion hides a name denied under the real path', async (t) => {
  // Fixture: base/real-deny/private/{hidden.txt,visible.txt}, alias base/alias-deny -> base/real-deny.
  // Deny with withEnv as security.test.ts does:
  //   FS_DENYLIST = `${realDeny.replaceAll('\\', '/')}/private/hidden*`
  // Skip with t.skip('symlink not permitted') when trySymlink fails.
  const values = await complete(`${join(aliasDeny, 'private')}${sep}`);
  assert.ok(values.some((v) => v.endsWith('visible.txt')), JSON.stringify(values));
  assert.ok(!values.some((v) => v.endsWith('hidden.txt')), JSON.stringify(values));
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test --test-name-pattern="denied under the real path" __tests__/aliased-root.test.ts`
Expected: FAIL on the `hidden.txt` assertion. If the test skips on Windows, run it under WSL as in Task 3.

If it passes, stop and report. The finding was read from code only.

- [ ] **Step 3: Check both spellings**

```ts
if (pathGuard.isSensitive(fullPath) || pathGuard.isSensitive(join(listable, entry.name))) continue;
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test __tests__/aliased-root.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the changelog entry and commit**

`### Fixed`: `**Path completion hides names denied under their real path.**`

```bash
git add src/core/path-completer.ts __tests__/aliased-root.test.ts CHANGELOG.md
git commit -m "fix: check the real path when completing file names"
```

### Task 7: HTTP status and auth scheme

**Finding 9:** `content-type: application/json; charset=latin1` answers 500 and logs an error, though the client made the mistake.

**Finding 10:** `bearer <valid key>` answers 401. The HTTP standard (RFC 9110) makes the scheme name case-insensitive.

> The audit missed this: `__tests__/http-policy.test.ts:142-145` deliberately asserts that lowercase is rejected. This task reverses that test. Confirm the reversal during plan review.

**Files:**
- Modify: `src/transport/http.ts:61-73`
- Modify: `src/transport/http-policy.ts:96-100`
- Test: `__tests__/http-server.test.ts` (after line 118), `__tests__/http-policy.test.ts:141-145`
- Modify: `CHANGELOG.md`

**Interfaces:** `validateBearerAuthorization` keeps its signature. The slice at `http-policy.ts:289` stays correct, since the scheme length does not change.

- [ ] **Step 1: Write the failing tests**

In `http-server.test.ts`, send the request with the helper its neighbours use, sending a complete JSON body:

```ts
it('answers 415 for an unsupported charset', async () => {
  // POST /mcp, authorization: Bearer TEST_API_KEY,
  // content-type: application/json; charset=latin1, body: a JSON-RPC ping
  assert.strictEqual(result.status, 415);
  assert.deepStrictEqual(result.body, {
    jsonrpc: '2.0',
    id: null,
    error: {
      code: -32000,
      message: 'Unsupported Media Type: Content-Type charset must be UTF-8',
    },
  });
});
```

In `http-policy.test.ts`, remove the lowercase assertion from TC-SEC-024 and add:

```ts
it('TC-SEC-024b: the auth scheme name is case-insensitive', () => {
  for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
    assert.strictEqual(validateBearerAuthorization(validKey, `${scheme} ${validKey}`), true, scheme);
  }
  assert.strictEqual(validateBearerAuthorization(validKey, 'bearer wrong-key'), false);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test --test-name-pattern="unsupported charset" __tests__/http-server.test.ts`
Expected: FAIL with status 500.

Run: `node --test --test-name-pattern="TC-SEC-024b" __tests__/http-policy.test.ts`
Expected: FAIL on `bearer`.

- [ ] **Step 3: Implement both**

In `http.ts`, beside the 413 branch, add a branch for `err.status === 415`. It calls `sendJsonRpcError` with status 415, code `JSONRPC_SERVER_ERROR` and the message above, and writes no error log.

In `http-policy.ts`, replace the prefix check with `/^bearer /iu.test(authHeader)`, and slice by `'Bearer '.length`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test __tests__/http-server.test.ts __tests__/http-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the changelog entries and commit**

`### Fixed`: `**An unsupported charset answers 415, not 500.**` and `**The bearer scheme name is case-insensitive.**`

```bash
git add src/transport/http.ts src/transport/http-policy.ts __tests__/http-server.test.ts __tests__/http-policy.test.ts CHANGELOG.md
git commit -m "fix: answer 415 for a bad charset and accept any case of the bearer scheme"
```

### Task 8: Delete code that no longer earns its place

**Findings 7, 11, 12, 13:**

- `maxResults` on `replace_text` was due out after 2.12.0. Versions up to 2.15.0 have shipped with it.
- `GuardedFileSystem.cp` has no callers in `src`.
- `escapeRegExpFallback` serves Node versions below the `engines` floor of 24.
- `createCaseSensitiveLiteralMatcher` repeats a check `plan.literal` already made, and `resources.ts:224` validates a path that the next call validates again.

Each is pure removal, with no behaviour change except the removed field and the Node floor.

> `util.ts:117-120` records that the fallback was kept on purpose, because npm only warns on `engines`. After this task, Node below 24 crashes when it first escapes a pattern. Confirm during plan review. If you want to keep the fallback, drop that part.

**Files:**
- Modify: `src/tools/replace-text.ts:97-105,114-122,412`; `__tests__/tools.test.ts:1005-1011`
- Modify: `src/core/fs.ts:978-993`; `__tests__/helpers.ts`; `__tests__/read-only-roots.test.ts:258,338`; `__tests__/transfer.test.ts:98,164`; `__tests__/undo.test.ts:333,344`
- Modify: `src/core/util.ts:78-122`; `src/core/matcher.ts:12,289`; `src/core/sensitive.ts:17,154`; `__tests__/edit.test.ts:10,630`
- Delete: `__tests__/regexp-escape.test.ts`
- Modify: `src/core/matcher.ts:498-506,549-553`; `__tests__/matcher.test.ts:181,187-188,239`; `src/resources.ts:224`
- Modify: `__tests__/contract.test.ts.snapshot`, `CHANGELOG.md`

**Interfaces:**
- Produces: `copyVia(fs: GuardedFileSystem, source: string, destination: string, options?: Parameters<typeof fsCp>[2]): Promise<void>` in `__tests__/helpers.ts`, running `planTransfer('copy', { source, destination }, options ? { copy: options } : {})` then `executeTransfer(plan)`.
- Changes: `createCaseSensitiveLiteralMatcher(searchPattern: string): ReplacementMatcher`, no longer `| undefined`.

- [ ] **Step 1: Remove `maxResults` from `replace_text`**

Delete the comment and field at lines 97-105 and the `.superRefine` at lines 114-122. Change line 412 to `const explicitCap = args.maxMatches;`. Leave `maxResults` on `search_text` and `find_files` alone.

Measure the new size with the same `JSON.stringify(tools).length` the budget test uses. Set `BUDGET_CHARS` to that size rounded up to the next 50, and add a `Lowered 2026-11-03` comment in the style of lines 1005-1008, with the measured number.

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`, then `node --test __tests__/tools.test.ts __tests__/replace-text.test.ts`
Expected: PASS. The snapshot diff removes only `maxResults`.

- [ ] **Step 2: Remove `GuardedFileSystem.cp`**

Delete lines 978-993 of `fs.ts`. Add `copyVia` to `helpers.ts`, and switch all six test call sites to it.

Run: `node --test __tests__/read-only-roots.test.ts __tests__/transfer.test.ts __tests__/undo.test.ts`
Expected: PASS.

- [ ] **Step 3: Use native `RegExp.escape`**

Delete lines 78-122 of `util.ts`, including the `escapeRegExp` export. Call `RegExp.escape` directly in `matcher.ts`, `sensitive.ts` and `edit.test.ts`, and drop the imports. Delete `__tests__/regexp-escape.test.ts`.

Run: `node --test __tests__/matcher.test.ts __tests__/security.test.ts __tests__/edit.test.ts`
Expected: PASS.

- [ ] **Step 4: Remove the two duplicate checks**

In `matcher.ts`, delete the bail at lines 501-506 and change the signature as above. In `createReplacementMatcher`:

```ts
if (!args.isRegex && !args.wholeWord && args.caseSensitive && plan.literal) {
  return createCaseSensitiveLiteralMatcher(args.searchPattern);
}
```

In `matcher.test.ts`, delete the `assert.ok(matcher)` lines that only narrowed `undefined`, and delete lines 187-188. The `planMatch` tests at lines 33-37 already pin those two needles.

Delete `resources.ts:224`.

Run: `node --test __tests__/matcher.test.ts __tests__/replace-text.test.ts __tests__/resources.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the changelog entry and commit**

`### Removed`: `**`replace_text` no longer accepts `maxResults`.**` Say to use `maxMatches`.

```bash
git add -A src __tests__ CHANGELOG.md
git commit -m "refactor: remove expired alias, test-only cp, regexp fallback and duplicate checks"
```

- [ ] **Step 6: Run the full check on both platforms**

Run from PowerShell:

```powershell
npm run check
wsl bash -lc "source ~/.nvm/nvm.sh && cd /mnt/c/filesystem-mcp && npm test"
npm run test:coverage
graphify update .
```

Expected: all pass, 0 failed, and the coverage floor holds. If deletions drop coverage below the floor, report the numbers and do not lower the floor.

## Out of Scope

- **Finding 8, `UndoPreview` (about -480 lines).** Replacing it makes a multi-step dry run approximate. This is a product decision and has no plan until it is made.
- **`create` prompting "Overwrite?" for a path that is a directory.** Also a smaller audit item, left out of the report, and not fixed here.
