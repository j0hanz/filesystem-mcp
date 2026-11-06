# Test report follow-ups implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five items from the 2026-11-06 client test run that held up against source: patch error wording, read hash labelling, undo skip reasons, the grant advice on ungrantable paths, and the missing structured error on thrown failures.

**Architecture:** All five are message or metadata fixes. Two touch tool text (`patch`, `read`). One makes undo's skip reasons specific (`src/core/undo.ts`). One picks the access-denied suggestion (`src/core/path.ts`). One adds `_meta.error` to the executor's thrown-error result (`src/tools/define.ts`). Guards, undo capture and confirmation flow do not change.

**Tech Stack:** TypeScript (Node, ESM), zod v4, Node built-in test runner, jsdiff.

**Spec:** This plan's **Findings** section below. The verification ran in conversation (workflow `wf_11021dd0-cad`), so the findings are embedded here.

## Findings (spec)

Checked against source on 2026-11-06. The report items judged by design (#1 confirmation without elicitation, #2 all-or-nothing delete, #5 copy not undoable, #6 multi-read headers, #8 case defaults) are NOT in scope.

1. **Patch error blames order for any failure.** `src/tools/patch.ts:250` always adds `(hunks must be in file order)`, even for one hunk. The message shows no expected or actual line. (Report #4.)
2. **Read hash is not labelled as a slice hash.** `src/tools/read.ts:278` hashes `result.content`, which is only the slice for head/tail/range reads. The trailer at `:388` prints `// sha256: <hex>` the same way for full and partial reads. No tool takes the hash back, so this is a labelling fix only. (Report #3.)
3. **Undo skip reasons are generic.** Seven `skip()` calls in `restoreEntry` (`src/core/undo.ts:1164,1188,1201,1209,1217,1240,1250`) fall back to `SKIP_MSG` ("it or its folder was modified"). The full path is already printed by `src/tools/undo.ts:80-87`; only the reason is vague. (Report #9.)
4. **Ungrantable path gets grant advice.** `throwAccessDenied` (`src/core/path.ts:1092-1099`) always attaches `OUTSIDE_ROOTS_SUGGESTION` ("...needs a new startup root or an accepted grant"). `precheckAccess` never offers a grant for `isUnsafeCwdPath` targets (`C:\Windows`, `/etc`, ...), so `C:\Windows\win.ini` gets advice it can never follow. The sensitive-file denial text (`path.ts:1086`) is deliberate (commit `f542e1bf`, `__tests__/security.test.ts:137`) and stays. (Report #7, Q2.)
5. **Thrown errors carry no structured error.** `failProgress` (`src/tools/define.ts:319-331`) returns text only. Batch failures carry `Problem {code, message, path?, suggestion?}` per path; whole-call failures carry nothing a client can parse. (Report #10.)

## Global Constraints

- Test runner: Node built-in. One file: `npm test -- __tests__/<file>.test.ts`. Pattern: `npm test -- --test-name-pattern="<pattern>"`.
- Contract snapshot: Task 2 changes a schema description. After it, with **no `FS_*` environment variables set**, run `node --test --test-update-snapshots __tests__/contract.test.ts`, then `npm test -- __tests__/contract.test.ts`. Commit the `.snapshot` diff with the task.
- Never edit `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`. Do not edit `CHANGELOG.md`.
- No new dependencies.
- Text tools keep their metadata under `_meta`, never `structuredContent` (`src/tools/define.ts:209-216`): Claude Code shows `structuredContent` in place of the text.
- Every commit message ends with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branch off `main` first; commit after each task.
- `npm run check` must pass at the end; run `npm run fix` first if it does not.
- After the last code change: `graphify update .`. A large graph diff is expected.
- Windows host: PowerShell; pass `C:/...` paths to node.

## Review Focus

1. A single stale hunk must not mention file order. Pinned in Task 1 (`names the mismatched line for a single stale hunk`).
2. A diagnosis over budget (`first === -1`) with several hunks keeps the order suffix, since order may be the cause. Pinned in Task 1 (extend `keeps the generic refusal when the diagnosis is over budget`).
3. A very long file or context line must not flood the error. Pinned in Task 1 (`truncates long lines in the mismatch detail`).
4. A full read with `includeHash` keeps the plain `// sha256:` trailer. Pinned in Task 2 (extend `trailer carries continuation and hash`).
5. A grantable out-of-root path (a temp dir) keeps the grant advice. Pinned in Task 4 (`keeps grant advice for a grantable outside path`).

---

### Task 1: Patch mismatch names the line, not the order

**Files:**
- Modify: `src/tools/patch.ts:241-252`
- Test: `__tests__/patch.test.ts`

**Interfaces:**
- Consumes: `MAX_MATCH_LINE_CHARS` (1000) from `src/core/search.ts:31`.
- Produces: none used by other tasks.

- [ ] **Step 1: Write the failing tests** in the `describe` that holds `names the failing hunk`:

```ts
it('names the mismatched line for a single stale hunk', async () => {
  const f = join(root, 'patch_one_stale.txt');
  await writeFile(f, 'q\nb\nc\n');
  const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
  await assert.rejects(patch({ path: f, diff }), (error: unknown) => {
    assert.ok(isFsError(error));
    assert.match(error.message, /hunk 1 \(starting at line 1\) does not match file content: expected "a", found "q"/u);
    assert.doesNotMatch(error.message, /file order/u);
    return true;
  });
});

it('truncates long lines in the mismatch detail', async () => {
  const f = join(root, 'patch_long_stale.txt');
  await writeFile(f, `${'q'.repeat(5000)}\nb\n`);
  const diff = `--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-${'a'.repeat(5000)}\n+X\n b\n`;
  await assert.rejects(patch({ path: f, diff }), (error: unknown) => {
    assert.ok(isFsError(error));
    assert.ok(error.message.length < 2 * MAX_MATCH_LINE_CHARS + 300, String(error.message.length));
    return true;
  });
});
```

Import `MAX_MATCH_LINE_CHARS` from `../src/core/search.ts`.

In `names the failing hunk` (hunk 2 of 2 fails), add: `assert.match(message, /expected "d", found "Z" \(hunks must be in file order\)/u)` (switch it to the callback form of `assert.rejects`). In `keeps the generic refusal when the diagnosis is over budget`, add: `assert.match(message, /\(hunks must be in file order\)/u)`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- __tests__/patch.test.ts`
Expected: FAIL on the two new tests and the `expected "d"` assertion.

- [ ] **Step 3: Implement in `src/tools/patch.ts`**

- When `first >= 0`: take the failing hunk `parsedPatch.hunks[first]`. Its first line starting with `' '` or `'-'` (prefix stripped) is `expected`. The file line at its `oldStart` (1-indexed, `content.split('\n')`) is `found`; use `''` past the end. Append `: expected "<expected>", found "<found>"` to `where`. Cut each value to `MAX_MATCH_LINE_CHARS` with `…`. Skip the detail if the hunk has no context or `-` line.
- Append ` (hunks must be in file order)` only when `hunks.length > 1 && first !== 0`. Hunk 1 is never clamped, so its failure is always its own context.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- __tests__/patch.test.ts __tests__/tools.test.ts`
Expected: PASS (`TC-FUNC-062` still matches `did not apply cleanly`).

- [ ] **Step 5: Commit**

```bash
git add src/tools/patch.ts __tests__/patch.test.ts
git commit -m "fix(patch): name the mismatched line; blame order only when it can apply"
```

### Task 2: Label a slice hash as a slice hash

**Files:**
- Modify: `src/tools/read.ts:73` (schema description), `src/tools/read.ts:388` (trailer)
- Modify: `__tests__/contract.test.ts.snapshot` (regenerated)
- Modify: `docs/client-guide.md` (the `includeHash` line, if it describes the hash)
- Test: `__tests__/read.test.ts`

**Interfaces:**
- Consumes: `PerPathReadValue` fields `head`, `tail`, `startLine` (`src/tools/read.ts:300-303`).
- Produces: none.

- [ ] **Step 1: Write the failing test.** In `trailer carries continuation and hash (#TC-FUNC-074)`, change the head assertion to `assert.match(headText, /^\/\/ sha256 \(slice\): [0-9a-f]{64}$/m)`. Add a full read with the hash:

```ts
const fullHashed = (await read({ path: file, includeHash: true }, { guard })).text ?? '';
assert.match(fullHashed, /^\/\/ sha256: [0-9a-f]{64}$/m);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- __tests__/read.test.ts`
Expected: FAIL on the `(slice)` match.

- [ ] **Step 3: Implement**

- Trailer: print `// sha256 (slice): <hex>` when `v.head !== undefined || v.tail !== undefined || v.startLine !== undefined`; otherwise keep `// sha256: <hex>`.
- Schema description, exact copy: `'Include SHA-256 hash of the returned content. For head, tail or a line range it covers that slice, not the whole file.'`
- Regenerate the contract snapshot (see Global Constraints).

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- __tests__/read.test.ts __tests__/contract.test.ts __tests__/sandbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/read.ts __tests__/read.test.ts __tests__/contract.test.ts.snapshot docs/client-guide.md
git commit -m "fix(read): mark a head/tail/range hash as a slice hash"
```

### Task 3: Undo says why each path was skipped

**Files:**
- Modify: `src/core/undo.ts:1141-1250`
- Test: `__tests__/undo.test.ts`

**Interfaces:**
- Consumes: `restoreEntry`, `captureOne`, `newFs` test helpers (`__tests__/undo.test.ts:1138-1145`).
- Produces: none. The existing rename message at `src/core/undo.ts:1288` stays.

- [ ] **Step 1: Write the failing tests** next to `an outside write after capture is skipped as modified since` (`__tests__/undo.test.ts:1248`):

```ts
it('a folder that gained a file is skipped as no longer empty', async () => {
  const dir = join(tmpDir, 'restore-filled');
  const entry = await captureOne((fs) => fs.mkdir(dir, { recursive: true }));
  await writeFile(join(dir, 'new.txt'), 'x');
  const outcome = await restoreEntry(entry, newFs(), { dryRun: false });
  const skipped = outcome.results.find((r): r is { path: string; error: Problem } => 'error' in r);
  assert.ok(skipped);
  assert.match(skipped.error.message, /^Not restored: the folder is no longer empty$/u);
});
```

In the `:1248` test, tighten to `/^Not restored: its content was modified since this undo step was recorded$/u`. In the `:2788` test, change the expected substring to `` `// ${y}: skipped not restored: its content was modified since` ``.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- __tests__/undo.test.ts`
Expected: FAIL on the three changed assertions.

- [ ] **Step 3: Implement.** Replace `SKIP_MSG` with one message per cause and make `skip()`'s `message` parameter required. Exact copy:

| Call site | Message |
| :-- | :-- |
| `:1164` blocked parent | `Not restored: its parent folder could not be restored` |
| `:1188` write, `record.expect === null` | `Not restored: something was created at this path since this undo step was recorded` |
| `:1188` write, hash differs | `Not restored: its content was modified since this undo step was recorded` |
| `:1201` remove, hash differs | `Not restored: its content was modified since this undo step was recorded` |
| `:1209` rmdir, link in place | `Not restored: a link now sits where the folder was` |
| `:1217` rmdir, `ENOTEMPTY` | `Not restored: the folder is no longer empty` |
| `:1240` mkdir, non-folder in place | `Not restored: a file or link now occupies the folder's path` |
| `:1250` symlink, path taken | `Not restored: something now occupies the link's path` |

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- __tests__/undo.test.ts __tests__/delete.test.ts __tests__/move.test.ts`
Expected: PASS (`: SKIPPED Not restored` at `:3071` still matches).

- [ ] **Step 5: Commit**

```bash
git add src/core/undo.ts __tests__/undo.test.ts
git commit -m "fix(undo): say why each skipped path was not restored"
```

### Task 4: No grant advice for paths that can never be granted

**Files:**
- Modify: `src/core/errors.ts:68-70`, `src/core/path.ts:753` and `:1092-1099`
- Test: `__tests__/read.test.ts:487-500`

**Interfaces:**
- Consumes: `isUnsafeCwdPath(normalized: string): boolean` (`src/core/path-discovery.ts:93`, already imported in `path.ts`).
- Produces: `export const NO_GRANT_SUGGESTION: string` in `src/core/errors.ts`. `throwAccessDenied(requestedPath: string, hint?: string, suggestion = OUTSIDE_ROOTS_SUGGESTION): never`.

- [ ] **Step 1: Write the failing tests** in `__tests__/read.test.ts`.

In `names the code and the next step for a refused path`: the `C:\Windows\win.ini` / `/etc/hostname` target is unsafe, so set `advice` to `'Use a path under an allowed root; list_roots names them. This system location is never granted; it needs a startup root.'` and add `assert.ok(!single.text?.includes('accepted grant'))`.

Add:

```ts
it('keeps grant advice for a grantable outside path', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'fs-mcp-outside-'));
  try {
    const result = await read({ path: join(outside, 'x.txt') }, { guard });
    assert.ok(result.text?.includes(OUTSIDE_ROOTS_SUGGESTION), result.text);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
```

Imports to add if missing: `mkdtemp`, `rm` from `node:fs/promises`; `tmpdir` from `node:os`; `OUTSIDE_ROOTS_SUGGESTION` from `../src/core/errors.ts`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- __tests__/read.test.ts --test-name-pattern="refused path|grantable outside"`
Expected: FAIL on the new `advice` text.

- [ ] **Step 3: Implement**

- `errors.ts`: add `NO_GRANT_SUGGESTION` with the exact text above.
- `path.ts`: give `throwAccessDenied` the `suggestion` parameter. At `:753` pass `isUnsafeCwdPath(normalizedRequested) ? NO_GRANT_SUGGESTION : OUTSIDE_ROOTS_SUGGESTION`. Leave the other call sites on the default.
- Add above `:753`: `// shortcut: lexical check only, so a link aliasing C:\Windows still gets grant advice; use isUnsafeGrantTarget if validateAccess turns async.`

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- __tests__/read.test.ts __tests__/security.test.ts __tests__/path-guard-grant.test.ts __tests__/guards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/errors.ts src/core/path.ts __tests__/read.test.ts
git commit -m "fix(path): drop grant advice for system paths that are never granted"
```

### Task 5: Thrown tool errors carry the problem in `_meta`

**Files:**
- Modify: `src/tools/define.ts:319-331`
- Modify: `docs/client-guide.md` (the error-handling section: one line saying `_meta.error` holds `{code, message, path?, suggestion?}`)
- Test: `__tests__/tools.test.ts:528-535`

**Interfaces:**
- Consumes: `Problem.fromUnknown(error: unknown, defaultCode: ErrorCode): Problem` (`src/core/errors.ts`).
- Produces: thrown-error results shaped `{ isError: true, content: [text], _meta: { error: Problem } }`. No `structuredContent`.

- [ ] **Step 1: Write the failing test.** Extend `TC-FUNC-062: patch that does not apply returns isError`:

```ts
const meta = result._meta as { error?: { code?: string; message?: string; path?: string } } | undefined;
assert.strictEqual(meta?.error?.code, 'INVALID_INPUT');
assert.match(meta?.error?.message ?? '', /did not apply cleanly/);
assert.strictEqual(result.structuredContent, undefined);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- __tests__/tools.test.ts --test-name-pattern="TC-FUNC-062"`
Expected: FAIL, `meta?.error?.code` is `undefined`.

- [ ] **Step 3: Implement.** In `failProgress`, compute the `Problem` once with `Problem.fromUnknown(error, this.def.defaultErrorCode ?? ErrorCode.UNKNOWN)`. Build the text from it with `formatDetailedError` plus `undoSuffix`, so the text stays byte-identical. Return `_meta: { error: problem }` alongside `content` and `isError`, and widen the return type to match.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- __tests__/tools.test.ts __tests__/contract.test.ts __tests__/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `npm run check`, then `graphify update .`
Expected: check passes.

```bash
git add src/tools/define.ts __tests__/tools.test.ts docs/client-guide.md graphify-out
git commit -m "feat(tools): attach the Problem to thrown errors under _meta"
```
