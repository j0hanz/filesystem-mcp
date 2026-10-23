# TDQS tier 2 descriptions implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the description gaps that issue #122 names for `edit`, `search_text`, `create`, `delete` and `stat`. Stop naming the write tool `edit` in the read-only tools `find_files` and `search_text`. Record the Glama scores after the next release.

**Architecture:** Only tool `description` strings and tests change. Task 1 changes the read-only tools and adds a guard test, so no read-only tool can name a write tool again. Task 2 changes the write tools, raises the full `tools/list` budget with a recorded reason, and pins each new claim with a test. Task 3 runs after a release and records the scores in #122. There is no runtime behavior change.

**Tech Stack:** TypeScript on Node 24 (type stripping), `node:test`, `@modelcontextprotocol/server` 2.3.1.

**Spec:** issue #122, "Raise Glama TDQS scores for the remaining tool descriptions" (https://github.com/j0hanz/filesystem-mcp/issues/122). Glama's per-tool reviews were fetched on 2026-10-23 from `https://glama.ai/mcp/servers/j0hanz/filesystem-mcp/tools/<name>`. The `delete` and `undo` pages say "Score is being calculated". Every new claim below was probed against the server at 575a6730.

## Global Constraints

- Line numbers are at commit 575a6730 (`main`). Find code by the quoted text.
- Branch: `docs/tdqs-tier2-descriptions`, from `main`.
- The #37 description rules apply. Lead with what the tool does. Name a sibling only for a real confusion pair. Add nothing the schema already says. A read-only tool never names a write tool, because `--read-only` removes write tools.
- Each description below is exact copy. Use it verbatim, because the budget numbers were measured from it.
- Every claim must be true for clients without elicitation too. Those clients get an `INVALID_INPUT` refusal instead of a prompt. So the text says "needs user confirmation", not "asks the user first".
- Any budget raise in `TOOL-SURFACE-002` (`__tests__/tools.test.ts:4189`) gets a dated comment. The comment gives the reason and the measured `full / read-only` sizes, in the form of the comments above it.
- Regenerate the contract snapshot with no `FS_*` variables set: `node --test --test-update-snapshots __tests__/contract.test.ts`. Commit the `.snapshot` diff with the change.
- Do not touch `mcpb/manifest.json`. Its tool blurbs are separate user-facing text, and its version is release-managed.
- Format the changed files before each commit: `npx prettier --write <files>`.
- Run one test file with `node --test --test-timeout=60000 __tests__/tools.test.ts`. Filter it with `--test-name-pattern="<name>"`.
- Commits use Conventional Commits with scope `tools`, like tier 1 (`fix(tools): ...`). Each body ends with `Refs #122` and these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_015x93MERvWLDzoqaguLSmJj`
- `npm run check` passes at the end of Task 2.

## Revision after review

The user ruled that a description explains the tool and when to use it, and
nothing else. After Task 2, the final pass therefore removed every
confirmation clause (`create`, `delete`, and tier 1's `move` sentence). The
model never handles the prompt, and the text read like a hint to pass
`overwrite: true`. It also trimmed the `search_text` glob clause to
`pattern filters files by glob` and reverted the `stat` sentence split.
`create` ships unchanged. The full `tools/list` measures 20518 and read-only
9759, so no budget raise is needed. The exact copy below is the pre-revision
draft; the source files are authoritative.

## Decisions

| Tool          | Change                     | New fact the schema lacks                     |
| :------------ | :------------------------- | :-------------------------------------------- |
| `find_files`  | drop `or edit`             | none (rule fix)                               |
| `search_text` | drop `or edit`, add clause | which pattern is text, which is a glob        |
| `stat`        | add clause, split sentence | missing path = own `NOT_FOUND` entry          |
| `edit`        | add clause                 | `path`+`edits` and `files` exclude each other |
| `create`      | add clause                 | `append` never needs confirmation             |
| `delete`      | add clause, fix claim      | recursive non-empty delete needs confirmation |
| `move`        | reword tier 1 clause       | same confirmation wording as siblings         |
| `patch`       | none                       | skipped, reason below                         |
| `undo`        | none yet                   | not scored; Task 3                            |

- **`edit`** spells out the exclusivity, because issue #122 asks for it. The schema states it only in property descriptions.
- **`delete`** today says "Revert with undo." with no condition. That is false for a delete whose undo capture was abandoned (protected files, over `FS_MAX_UNDO_BYTES`, a non-regular entry). The new text copies tier 1's `move` fix (1fc496c0).
- **`move`** is outside #122's table. Its tier 1 text says "asks the user first". A client without elicitation is refused instead, which the probe showed. Rewording it costs 4 characters and keeps one phrase for one behavior across `create`, `delete` and `move`.
- **`patch` is skipped.** Every fact a model needs to call it is already in the schema or the description. The one unstated fact is that the diff's `---`/`+++` file names are ignored. That changes no call, because `path` is required (TC-FUNC-061 patches `patch_target.txt` with headers naming `f.txt`). `patch` scores highest of the six at 4.5. A clause would add about 64 characters to every session's `tools/list` for one Parameters point.
- **Rejected:** "a workspace root is refused" for `delete`. It is a loud error with a clear message, not a silently wrong result, so #37's caveat rule does not keep it.

Measured with the exact copy below: full `tools/list` goes from 20424 to 20806 characters, and read-only from 9668 to 9792. The full budget is 20550, so Task 2 raises it to 20850. The read-only budget of 9850 stays.

## Review Focus

1. A client without elicitation calls `create` on an existing file, `delete` with `recursive: true` on a non-empty directory, or `move` onto an existing file. It must get an `INVALID_INPUT` that names the workaround, and nothing may change. TC-FUNC-009p and TC-FUNC-069b pin `create` and `delete`. Task 2 adds the `move` test.
2. `stat` with `paths` where one path is missing. The call must not fail, and the missing path must carry its own `NOT_FOUND` entry. The probe showed that a single missing `path`, or every path missing, gives `isError` with the same per-path entries. Task 1 adds the partial-batch test.
3. `edit` with `path`+`edits` and also `files`. It must be refused with `Provide exactly one of 'path' or 'files'`, and the file must stay unchanged. Task 2 adds the test.
4. `delete` of a non-empty directory without `recursive`. It fails with `Directory not empty. Set recursive: true.` The new text says "A recursive delete …" so it does not suggest that a prompt replaces the flag. No new test: the existing failure path is unchanged.
5. A future description edit names a write tool in a read-only tool. TOOL-SURFACE-003 (Task 1) fails on it.

---

### Task 1: Read-only descriptions and the read-only naming guard

**Files:**

- Modify: `src/tools/find-files.ts:65-67`
- Modify: `src/tools/search-text.ts:180-182`
- Modify: `src/tools/stat.ts:172-175`
- Test: `__tests__/tools.test.ts` (new test after TOOL-SURFACE-002, which ends at line 4217; new test after `stat reports a regular file under a symlinked parent as a file`, near line 3387)
- Modify: `__tests__/contract.test.ts.snapshot` (regenerated)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Changed`)

**Interfaces:**

- Consumes: `createTestClientPair(roots, { readOnly?: boolean })`, `writeTestFile(dir, name, content)` and `harness`/`tmpDir` from the enclosing `describe`, as used by the neighboring tests.
- Produces: test `TOOL-SURFACE-003`. Task 2 does not depend on it.

- [ ] **Step 1: Write the guard test after TOOL-SURFACE-002**

```ts
it('TOOL-SURFACE-003: no read-only tool description names a write tool', async () => {
  const full = await createTestClientPair([tmpDir]);
  let writeNames: string[];
  try {
    const { tools } = await full.client.listTools();
    writeNames = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
  } finally {
    await full.close();
  }
  assert.ok(writeNames.length > 0);

  const ro = await createTestClientPair([tmpDir], { readOnly: true });
  try {
    const { tools } = await ro.client.listTools();
    for (const tool of tools) {
      for (const name of writeNames) {
        assert.doesNotMatch(
          tool.description ?? '',
          new RegExp(`\\b${name}\\b`, 'u'),
          `${tool.name} names the write tool ${name}, absent under --read-only`,
        );
      }
    }
  } finally {
    await ro.close();
  }
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test --test-timeout=60000 --test-name-pattern="TOOL-SURFACE-003" __tests__/tools.test.ts`
Expected: FAIL with `search_text names the write tool edit, absent under --read-only` (or the same for `find_files`).

- [ ] **Step 3: Write the `stat` pin test after `stat reports a regular file under a symlinked parent as a file`**

```ts
it('stat batch gives a missing path its own NOT_FOUND entry and keeps the rest', async () => {
  const present = await writeTestFile(tmpDir, 'stat_batch_present.txt', 'x');
  const missing = join(tmpDir, 'stat_batch_missing.txt');
  const result = await harness.client.callTool({
    name: 'stat',
    arguments: { paths: [present, missing] },
  });
  assert.notStrictEqual(result.isError, true);
  const { results } = result.structuredContent as {
    results: { value?: { type: string }; error?: { code: string } }[];
  };
  assert.strictEqual(results[0]?.value?.type, 'file');
  assert.strictEqual(results[1]?.error?.code, 'NOT_FOUND');
});
```

Run: `node --test --test-timeout=60000 --test-name-pattern="stat batch gives" __tests__/tools.test.ts`
Expected: PASS. It pins behavior the new `stat` text claims.

- [ ] **Step 4: Replace the three descriptions**

`src/tools/find-files.ts:65-67`:

```ts
  description:
    'Find files by name or glob pattern; returns file paths relative to the root, ready to pass to read. ' +
    'A pattern without / matches file names at any depth. search_text searches contents.',
```

`src/tools/search-text.ts:180-182`. The old "Patterns match within one line" moves into the `searchPattern` clause, so "pattern" means only the glob parameter:

```ts
  description:
    'Search file contents for literal text or an RE2 regex, like grep; returns matching lines with line numbers ' +
    'and paths relative to the root, ready to pass to read. ' +
    'searchPattern is the text to find, matched within one line; pattern is a glob that limits which files are searched. ' +
    'find_files matches file names.',
```

`src/tools/stat.ts:172-175`. Splitting the first sentence answers Glama's "run-on" note on Conciseness:

```ts
  description:
    'Get metadata without reading contents, like ls -ld. Returns type, size (files) or entryCount (directories; secret files not counted), ' +
    'tokenEstimate, timestamps, permissions (readOnly on Windows), MIME type guessed from the extension, and symlink target. ' +
    'Also checks whether paths exist: each missing path gets its own NOT_FOUND entry.',
```

- [ ] **Step 5: Regenerate the contract snapshot**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`
Expected: PASS. `git diff --stat __tests__/contract.test.ts.snapshot` shows 6 changed description lines: 3 tools in the full surface and 3 in the read-only one.

- [ ] **Step 6: Run the guard, budget and contract tests**

Run: `node --test --test-timeout=60000 --test-name-pattern="TOOL-SURFACE" __tests__/tools.test.ts`
Expected: PASS. Full measures 20548 against the 20550 budget, and read-only measures 9792 against 9850. No budget change.

Run: `node --test --test-timeout=60000 __tests__/contract.test.ts`
Expected: PASS.

- [ ] **Step 7: Add the CHANGELOG entry**

Under `## [Unreleased]` → `### Changed`, after the tier 1 bullet:

```markdown
- **`search_text`, `find_files` and `stat` descriptions are clearer.**
  `search_text` says that `searchPattern` is the text to find and that
  `pattern` is a glob that limits which files are searched. `search_text` and
  `find_files` no longer name `edit`, which `--read-only` removes. `stat` says
  that each missing path gets its own `NOT_FOUND` entry.
```

- [ ] **Step 8: Format and commit**

```bash
npx prettier --write src/tools/find-files.ts src/tools/search-text.ts src/tools/stat.ts __tests__/tools.test.ts CHANGELOG.md
git add src/tools/find-files.ts src/tools/search-text.ts src/tools/stat.ts __tests__/tools.test.ts __tests__/contract.test.ts.snapshot CHANGELOG.md
git commit -m "fix(tools): tell search_text's patterns apart and stop naming edit" -m "Read-only tools named edit, which --read-only removes. search_text did not say which of pattern and searchPattern is the text to find, and stat did not say that a missing path gets its own NOT_FOUND entry. A new surface test keeps write tools out of read-only descriptions." -m "Refs #122" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x93MERvWLDzoqaguLSmJj"
```

### Task 2: Write-tool descriptions, confirmation wording, budget raise

**Files:**

- Modify: `src/tools/edit.ts:456-459`
- Modify: `src/tools/create.ts:130-132`
- Modify: `src/tools/delete.ts:418-419`
- Modify: `src/tools/move.ts:614`
- Test: `__tests__/tools.test.ts` (new test after `edit refuses a batch that names the same file twice` at line 1286; new test after `TC-FUNC-067: move overwrite via choice round-trip replaces dst` at line 2695; `TOOL-SURFACE-002` budget at lines 4183-4191)
- Modify: `__tests__/contract.test.ts.snapshot` (regenerated)
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: `createElicitationClientPair(roots, handler, { noElicitation: true })` and `firstTextBlock(result)`, as used by TC-FUNC-009p (`__tests__/tools.test.ts:666`).
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the `edit` pin test after `edit refuses a batch that names the same file twice`**

```ts
it('edit refuses path with edits and files in one call, writing nothing', async () => {
  const f = await writeTestFile(tmpDir, 'edit_both_forms.txt', 'one\n');
  const spec = [{ oldText: 'one', newText: 'two' }];
  const result = await harness.client.callTool({
    name: 'edit',
    arguments: { path: f, edits: spec, files: [{ path: f, edits: spec }] },
  });
  assert.strictEqual(result.isError, true);
  assert.match(firstTextBlock(result).text ?? '', /Provide exactly one of 'path' or 'files'/u);
  assert.strictEqual(await readFile(f, 'utf-8'), 'one\n');
});
```

- [ ] **Step 2: Write the `move` pin test after TC-FUNC-067**

```ts
it('TC-FUNC-067b: a client without elicitation gets a tool error for a move onto an existing file', async () => {
  const eh = await createElicitationClientPair(
    [tmpDir],
    async () => {
      throw new Error('the server must not ask a client that cannot answer');
    },
    { noElicitation: true },
  );
  try {
    const src = await writeTestFile(tmpDir, 'move_no_elicit_src.txt', 'src\n');
    const dst = await writeTestFile(tmpDir, 'move_no_elicit_dst.txt', 'dst\n');
    const result = await eh.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: src, destination: dst }] },
    });
    assert.strictEqual(result.isError, true, 'must surface as a tool error');
    assert.match(firstTextBlock(result).text ?? '', /confirmation this client cannot show/i);
    assert.strictEqual(await readFile(src, 'utf-8'), 'src\n');
    assert.strictEqual(await readFile(dst, 'utf-8'), 'dst\n');
  } finally {
    await eh.close();
  }
});
```

- [ ] **Step 3: Run both pin tests**

Run: `node --test --test-timeout=60000 --test-name-pattern="edit refuses path with edits|TC-FUNC-067b" __tests__/tools.test.ts`
Expected: PASS, 2 tests. Both pin behavior the new text claims.

- [ ] **Step 4: Replace the four descriptions**

`src/tools/edit.ts:456-459`:

```ts
  description:
    'Edit text files in place by replacing exact oldText with newText, like str_replace. ' +
    'Pass path with edits, or files for a batch; never both. ' +
    'Each oldText must match exactly once, and a file is written only if all its edits match. ' +
    'replace_text replaces every occurrence across files.',
```

`src/tools/create.ts:130-132`:

```ts
  description:
    'Write whole text files (create new ones, overwrite, or append) or make empty directories. ' +
    'Missing parent directories are created. ' +
    'Replacing an existing file needs user confirmation unless overwrite: true; append never does. ' +
    'edit or patch changes part of an existing file.',
```

`src/tools/delete.ts:418-419`:

```ts
  description:
    'Delete files, directories, or symlinks, like rm or rm -r. Paths are exact; globs are not expanded. ' +
    'A recursive delete of a non-empty directory needs user confirmation. ' +
    'undo reverts a delete whose result gives an undo id.',
```

`src/tools/move.ts:614`, one line:

```ts
    'Overwriting an existing file needs user confirmation, unless a copy passes overwrite: true. ' +
```

- [ ] **Step 5: Run the budget test and see it fail**

Run: `node --test --test-timeout=60000 --test-name-pattern="TOOL-SURFACE-002" __tests__/tools.test.ts`
Expected: FAIL with `tools/list is 20806 chars, over the 20550 budget`.

- [ ] **Step 6: Raise the full budget with its reason**

In `__tests__/tools.test.ts`, add after the `// review flagged; measured 20397 / 9668.` comment line (4188):

```ts
// Raised 2026-10-23 to 20850 full (read-only unchanged): the edit, create,
// delete and move descriptions say which edit form to use and when a write
// needs user confirmation, gaps the Glama TDQS review flagged (#122);
// measured 20806 / 9792.
```

Set `const BUDGET_CHARS = 20_850;`. Keep `BUDGET_CHARS_READ_ONLY = 9_850`. If the date is not 2026-10-23, use the commit date. If the measured numbers differ, the copy differs from this plan. Fix the copy, not the comment.

- [ ] **Step 7: Regenerate the contract snapshot**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`
Expected: PASS. The snapshot diff changes 4 description lines, all in the full surface. Write tools are absent from the read-only surface.

- [ ] **Step 8: Update the CHANGELOG**

In the tier 1 bullet, replace `` `move` says that overwriting an existing file asks the user
  first unless a copy passes `overwrite: true` `` with `` `move` says that overwriting an existing file needs user
  confirmation unless a copy passes `overwrite: true` ``. Then add after the Task 1 bullet:

```markdown
- **`edit`, `create` and `delete` descriptions say more about their inputs
  and confirmations.** `edit` says that `path` with `edits` and `files` are
  two forms that exclude each other. `create` says that replacing an existing
  file needs user confirmation unless `overwrite: true`, and that `append`
  never does. `delete` says that a recursive delete of a non-empty directory
  needs user confirmation, and that `undo` reverts a delete only when its
  result gives an undo id. Before, it promised undo for every delete.
```

- [ ] **Step 9: Run the full check**

Run: `npm run check`
Expected: exit 0. All static checks pass, and the tests show 0 fail.

- [ ] **Step 10: Format and commit**

```bash
npx prettier --write src/tools/edit.ts src/tools/create.ts src/tools/delete.ts src/tools/move.ts __tests__/tools.test.ts CHANGELOG.md
git add src/tools/edit.ts src/tools/create.ts src/tools/delete.ts src/tools/move.ts __tests__/tools.test.ts __tests__/contract.test.ts.snapshot CHANGELOG.md
git commit -m "fix(tools): say which edit form to use and when a write needs confirmation" -m "A model could not tell from edit's description that path with edits and files exclude each other, or from create's that append never needs confirmation. delete promised undo for every delete, though protected or oversized trees are not kept for undo. move, create and delete now say needs user confirmation: a client without elicitation is refused, not asked." -m "Refs #122" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015x93MERvWLDzoqaguLSmJj"
```

- [ ] **Step 11: Put the skip reasons in the PR description**

When the branch becomes a PR, its description must carry two reasons, copied from **Decisions** above. `patch` got no clause, and why. `undo` waits for its first score (Task 3). This meets #122's "or the PR lists the reason it skips that tool".

### Task 3: Record the scores after the next release

Blocked until the user releases a version that contains Tasks 1-2, and until Glama has scored it. The release type and version are the user's call. This task changes no code.

**Files:** none in the repo. It writes a comment on issue #122.

- [ ] **Step 1: Confirm that Glama scored the new release**

Fetch `https://glama.ai/mcp/servers/j0hanz/filesystem-mcp` with WebFetch. Check that its schema changelog lists the new version. The API returns 401, so use the web pages.
Expected: the new version is listed, and the tool pages no longer say "Score is being calculated". Otherwise, stop and retry later.

- [ ] **Step 2: Collect every tool's score**

For each of the 14 tools, fetch `https://glama.ai/mcp/servers/j0hanz/filesystem-mcp/tools/<name>`. Record the TDQS and the 6 dimension scores, and also the server score and coherence.
Expected: a 14-row table. Each row has a tool name, a TDQS and 6 dimension scores.

- [ ] **Step 3: Check the server score against the formula**

Definition quality is 0.6 × mean + 0.4 × min. The server score is 0.7 × definition quality + 0.3 × coherence.
Expected: the result matches Glama's server score to 0.01. If it does not, note the difference in the comment. Do not adjust the formula.

- [ ] **Step 4: Comment on #122**

Post the table, the server score, and the before/after values for the tools this plan changed (the baseline is #122's scope table). Tick the last 2 acceptance boxes. If `undo` is the lowest tool, say so and open a follow-up issue for its description. The lowest tool counts for 40% of definition quality.
