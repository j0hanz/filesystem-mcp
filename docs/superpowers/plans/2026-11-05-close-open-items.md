# Close open items: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the open issue and PR queue and fix the small defects found in the 2026-11-05 roadmap review, then release.

**Architecture:** Five independent small changes on one branch: a pre-flight refusal in `GuardedFileSystem`'s Transfer path, two distribution manifest fixes, and two documentation edits. Task 7 lists GitHub and release actions, which change nothing in the repository and need the maintainer's go-ahead.

**Tech Stack:** TypeScript on Node 24+, `node:test`, MCP registry `server.json`, MCPB `manifest.json`.

**Spec:** No design doc. The requirements are [issue #209](https://github.com/j0hanz/filesystem-mcp/issues/209) and the "Now" list of the 2026-11-05 roadmap, restated here:

1. Add `--read-only` to the registry Docker entry, which mounts `:ro` (`server.json:96`).
2. Add `undo` to the README comparison table.
3. Refuse a directory move onto a non-empty directory before anything is copied (#209).
4. Close #153 with a docs line, triage #5, #57, PR #59 and PR #125, and release `[Unreleased]`.
5. Expose `FS_ALLOWLIST` in the MCPB extension.

## Global Constraints

- Branch: `fix/close-open-items`, from `main`.
- Never edit a `version` field in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json` or `.cursor-plugin/plugin.json`.
- Add no dependency.
- Every behaviour change gets a line under `## [Unreleased]` in `CHANGELOG.md`, in the existing bold-sentence style.
- Regenerate the contract snapshot only with `node --test --test-update-snapshots __tests__/contract.test.ts`, with no `FS_*` variables set.
- After changing code, run `graphify update .`.
- End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- End the PR description with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Review Focus

- A batch where one pair is refused: the sibling pair still moves, and the refusal shows in the tool text. Test in Task 1.
- A destination that gains a file while the overwrite prompt is open: the move is refused at execution, and nothing changes. Test in Task 1.
- Undo of a directory move after something recreated the origin with files: both trees stay intact and undo reports a failure. Test in Task 1.
- A source that is a link to a directory, moved onto a non-empty directory: the link and the directory stay intact. Test in Task 1.
- A destination that is a link to a non-empty directory: `resolveTransferDestination` (`src/core/path.ts:1551`) follows the link, so this is a merge. The move is refused, and the link and its target stay intact. Test in Task 1.

---

### Task 1: Refuse a directory move onto a non-empty directory (#209)

Today a same-device move asks the overwrite question, then fails with raw `EPERM` (Windows) or `ENOTEMPTY` (POSIX). A cross-device move first copies the whole tree into staging. `planTransfer` (`src/core/fs.ts:520`) is where all pairs settle before the prompt, so the refusal goes there, with a recheck in `executeTransfer` (`src/core/fs.ts:568`) because a prompt can be open between the two.

> Issue #209 says a move onto an empty directory "still replaces it, as today". That holds on POSIX only: probed on Windows 11, `fs.rename` of a directory onto an empty directory fails with `EPERM`. Leave this as it is. The test below skips on `win32`.

**Files:**

- Modify: `src/core/fs.ts` (`planTransfer`, `executeTransfer`, new private method)
- Modify: `CHANGELOG.md`
- Test: `__tests__/move.test.ts` (new `describe` inside `move body`, before `overlapping batches`), `__tests__/move-exdev.test.ts:81`, `__tests__/undo.test.ts` (after the test at `:835`)

**Interfaces:**

- Produces: `async #refuseDirectoryMerge(entry: string, destination: string, requested: string): Promise<void>`, private to `GuardedFileSystem`. Throws `FsError(ErrorCode.INVALID_INPUT, <message>, requested)`.
- Exact message, used by every test below:

```ts
`A move cannot merge directories: destination "${requested}" is a non-empty directory. Choose a new destination name, or use copy: true to merge and keep the source.`;
```

- [ ] **Step 1: Write the failing tests in `__tests__/move.test.ts`**

Add `describe('a directory move onto a non-empty directory', ...)` using the `move` helper and `root` of that file. Give each test its own folder under `root`. Build `src/x.txt` and `dst/y.txt` in each. Define `const MERGE = /cannot merge directories/;`. Every refusal test ends with `src/x.txt` and `dst/y.txt` unchanged.

| Test name                                                | Setup and call                                                                                    | Assertions                                                                                                                       |
| :------------------------------------------------------- | :------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------- |
| `refuses without asking`                                 | `confirm` records prompts                                                                         | `isError === true`, no prompts, `failures[0].error.code === 'INVALID_INPUT'`, message and `text` match `MERGE`                   |
| `a refused pair leaves its sibling to run`               | second pair moves a file to a new name                                                            | `isError` not true, `moves.length === 1`, `failures.length === 1`, `text` matches `MERGE`, the file moved                        |
| `refuses a destination filled while the prompt was open` | `dst` starts empty; `confirm` writes `dst/late.txt`, then answers `overwrite`                     | exactly one prompt, failure matches `MERGE`, `src/x.txt` and `dst/late.txt` intact                                               |
| `a link to a directory is not refused as a merge`        | `trySymlink` a link `lnk` to `src`, move `lnk` onto `dst`, approve; skip if `trySymlink` is false | `failures[0]` message does not match `MERGE` when the move fails; `lnk`, `src/x.txt` and `dst/y.txt` still present when it fails |
| `a destination link to a full directory is refused`      | `trySymlink` `dstLink` to `dst`, skip if false; move `src` onto `dstLink`                         | no prompts, failure matches `MERGE`; `dstLink` is still a link; `dst/y.txt` intact                                               |
| `a case-only rename of a full directory still works`     | move `CaseDir` (holding a file) to `casedir`                                                      | no failure; `readdir(parent)` includes `casedir`; child file present                                                             |
| `an empty destination still takes the move`              | skip on `win32`; `dst` empty; approve                                                             | `moves.length === 1`, `dst/x.txt` present, `src` gone                                                                            |
| `a file source onto a directory is unchanged`            | move `a.txt` onto `dst`; approve                                                                  | failure message does not match `MERGE`                                                                                           |

- [ ] **Step 2: Tighten `refuses to merge into an existing directory` in `__tests__/move-exdev.test.ts:81`**

Build the `GuardedFileSystem` with a `rename` spy that counts calls and rejects `EXDEV`, and assert:

```ts
await assert.rejects(spied.rename(src, dst), (err: unknown) => {
  assert.ok(isFsError(err));
  assert.strictEqual(err.code, ErrorCode.INVALID_INPUT);
  assert.match(err.message, /cannot merge directories/);
  return true;
});
assert.strictEqual(renames, 0); // nothing reached the cross-device copy
```

Keep the existing `readdir` and `leftovers` assertions.

- [ ] **Step 3: Add the undo test to `__tests__/undo.test.ts`, after the test at `:835`**

Name: `undo of a directory move fails cleanly when the origin was refilled`. Follow that test's setup. Move `d` (holding `a.txt`) to `e`, create `d/new.txt`, call undo. Assert a failed row in the shape the `:835` test uses, plus `e/a.txt` and `d/new.txt` both still on disk.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="non-empty directory|refuses to merge|origin was refilled"`
Expected: FAIL. `refuses without asking` fails because a prompt fires. The undo test may already pass, because it only pins that both trees survive. The link, case-only, empty-destination and file-source tests also pass today and guard against over-refusing.

- [ ] **Step 5: Implement `#refuseDirectoryMerge` in `src/core/fs.ts`**

- `fsLstat` both `entry` and `destination`, each through `unlessMissing`. Return unless both exist and both are real directories. `lstat` matters for `entry`: moving a link renames the link. `destination` has already been resolved through any link.
- Then `await this.hasChildrenUnchecked(destination).catch(() => false)`, and throw when true. An unreadable destination falls through, so the rename reports what it reports today.
- Call it from `planTransfer` when `op === 'move' && !respelling`, after the own-subdirectory check and before `#relocationWalk`.
- Call it from `executeTransfer` when `op === 'move' && !plan.respelling`, after the identity checks and before `createParents`.
- `copy` is not touched: it merges on purpose.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="non-empty directory|refuses to merge|origin was refilled"`
Expected: PASS.

Run: `npm test -- __tests__/undo.test.ts __tests__/move.test.ts __tests__/move-exdev.test.ts`
Expected: PASS. Undo restores a directory through `fs.rename` (`src/core/undo.ts:671`), so it now gets this refusal. If an existing undo test pinned the raw errno, or undo's dry-run preview (`src/core/undo.ts:700` onward) now disagrees with the real run, stop and report it.

- [ ] **Step 7: Add the changelog line under `### Fixed`**

```markdown
- **A directory move onto a non-empty directory is refused up front.** It asked to overwrite, then failed with a raw `EPERM` or `ENOTEMPTY`, and a cross-device move first copied the whole tree. It now answers `INVALID_INPUT` before any prompt or copy. `copy: true` still merges.
```

- [ ] **Step 8: Commit**

```bash
git add src/core/fs.ts CHANGELOG.md __tests__/move.test.ts __tests__/move-exdev.test.ts __tests__/undo.test.ts
git commit -m "fix(move): refuse a directory move onto a non-empty directory"
```

Add `Closes #209` to the commit body.

### Task 2: Add `--read-only` to the registry's read-only mount

The OCI entry mounts `{host_dir}:/workspace:ro` without `--read-only`, so write tools are advertised and every call fails on the read-only mount. Keep `:ro` and add the flag: users of this entry can't write today, so they lose nothing, and the entry stays safe by default. `docs/configuration.md:115-116` already pairs the two.

**Files:**

- Modify: `server.json` (OCI package `packageArguments`, and the `-v` description)
- Modify: `CHANGELOG.md`
- Test: Create `__tests__/server-json.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test**

```ts
describe('registry manifest', () => {
  it('REG-001: a read-only mount comes with --read-only', () => {
    const oci = manifest.packages.find((p) => p.runtimeArguments);
    assert.ok(oci);
    const mount = oci.runtimeArguments.find((a) => a.name === '-v');
    assert.match(mount.value, /:ro$/);
    const names = oci.packageArguments.map((a) => a.name ?? a.valueHint);
    assert.ok(names.includes('--read-only'));
    // The server takes flags before the positional folder, as the README's Docker example does.
    assert.ok(names.indexOf('--read-only') < names.indexOf('/workspace'));
  });
});
```

Read `server.json` the way `__tests__/mcpb-manifest.test.ts:8-10` reads its manifest, with a narrow type for `manifest`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- __tests__/server-json.test.ts`
Expected: FAIL on `names.includes('--read-only')`.

- [ ] **Step 3: Edit `server.json`**

Add this as the first entry of the OCI package's `packageArguments`:

```json
{
  "type": "named",
  "name": "--read-only",
  "description": "Remove every tool that writes, to match the read-only mount.",
  "format": "boolean",
  "isRequired": true
}
```

Change the `-v` description to `Mount the directory to expose to the server, read-only.`

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- __tests__/server-json.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the changelog line under `### Fixed`**

```markdown
- **The registry's Docker entry no longer advertises tools that cannot work.** It mounted the folder read-only but kept every write tool, so each write failed with `EROFS`. It now passes `--read-only`.
```

- [ ] **Step 6: Commit**

```bash
git add server.json CHANGELOG.md __tests__/server-json.test.ts
git commit -m "fix(registry): pair the read-only Docker mount with --read-only"
```

### Task 3: Let MCPB users unblock a built-in secret pattern

The refusal text tells users to restart with `--allow <pattern>` or `FS_ALLOWLIST` (`src/core/path.ts:1086`), and Claude Desktop extension users have no way to do that. An empty value is safe: `src/core/sensitive.ts:390` treats an empty `FS_ALLOWLIST` as unset, as it does `FS_DENYLIST`.

**Files:**

- Modify: `mcpb/manifest.json` (`mcp_config.env`, `user_config`)
- Modify: `README.md:202-203`
- Modify: `CHANGELOG.md`
- Test: `__tests__/mcpb-manifest.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing test `MCPB-003: every setting reaches the server`**

Widen the manifest type at `:10` with `server.mcp_config.{args,env}` and `user_config`.

```ts
const wired = JSON.stringify(manifest.server.mcp_config);
for (const key of Object.keys(manifest.user_config)) {
  assert.ok(wired.includes(`\${user_config.${key}}`), `${key} is not passed to the server`);
}
assert.strictEqual(manifest.server.mcp_config.env.FS_ALLOWLIST, '${user_config.allow_patterns}');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- __tests__/mcpb-manifest.test.ts`
Expected: FAIL on `FS_ALLOWLIST`.

- [ ] **Step 3: Edit `mcpb/manifest.json`**

Add `"FS_ALLOWLIST": "${user_config.allow_patterns}"` to `env`. Add this after `deny_patterns`:

```json
"allow_patterns": {
  "type": "string",
  "title": "Unblocked secret files",
  "description": "Comma-separated built-in secret-file patterns to unblock, for example .env.example. The AI can then read matching files, so list only what it should see. Extra blocked files always win.",
  "default": "",
  "required": false
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- __tests__/mcpb-manifest.test.ts`
Expected: PASS.

- [ ] **Step 4a: Pin that an unset setting changes nothing**

An upgrading user has no stored value for the new setting, and a host may pass it as empty or as the raw placeholder. Add this test to `__tests__/security.test.ts`, after `lets --allow lift a new built-in pattern` (`:339`):

```ts
it('an empty or unfilled FS_ALLOWLIST lifts nothing', async () => {
  for (const value of ['', '${user_config.allow_patterns}']) {
    await withEnv({ FS_ALLOWLIST: value }, () => {
      const matcher = new SensitiveMatcher();
      assert.strictEqual(matcher.isSensitive('/w/.env'), true);
      assert.strictEqual(matcher.isSensitive('/w/.env.example'), true);
    });
  }
});
```

Run: `npm test -- --test-name-pattern="lifts nothing"`
Expected: PASS.

- [ ] **Step 4b: Validate and boot the real bundle path**

Run: `bash scripts/pack-mcpb.sh`
Expected: exit 0. The script boots the staged tree with `--version` and packs `filesystem-mcp.mcpb` (gitignored).

- [ ] **Step 4c: Install the bundle by hand**

This is the only check a test can't do. Open `filesystem-mcp.mcpb` in Claude Desktop over an existing install. Confirm that it starts, the old settings survive, the new field is empty, and `.env` is still refused. If any of that fails, drop this task from the branch and report it. Tasks 1, 2, 4 and 5 don't depend on it.

- [ ] **Step 5: Update the docs**

In `README.md:202-203`, change the sentence to: `The extension's settings also let you turn on read-only mode, block more files, and unblock a built-in secret file.`

Add under `### Added` in `CHANGELOG.md`:

```markdown
- **The Claude Desktop extension can unblock a secret file.** Its new "Unblocked secret files" setting passes `FS_ALLOWLIST`, the fix the `ACCESS_DENIED` message names.
```

- [ ] **Step 6: Commit**

```bash
git add mcpb/manifest.json README.md CHANGELOG.md __tests__/mcpb-manifest.test.ts __tests__/security.test.ts
git commit -m "feat(mcpb): add a setting that unblocks a built-in secret pattern"
```

### Task 4: Add undo to the README comparison table

Three of the README's demos sell undo, and the table at `README.md:122-135` omits it. The reference server's README has no match for `undo`, `revert` or `rollback`, checked on 2026-11-05.

**Files:**

- Modify: `README.md:120` and the table at `:122-135`

**Interfaces:** none.

- [ ] **Step 1: Edit the table**

Add this row after `Delete files`, and change the date on line 120 to `2026-11-05`:

```markdown
| Undo a change | `undo` reverts recent changes; skips files edited since | None |
```

Run: `npx prettier --write README.md`
Expected: the table realigns, and `git diff --stat` shows only `README.md`.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): list undo in the comparison with the reference server"
```

### Task 5: Say that append adds no newline (#153)

The reporter of #153 hit this: `append` writes the text verbatim. The schema is the one place a model reads it. The new text is shorter than the old, so the `tools/list` budget test stays green.

**Files:**

- Modify: `src/tools/create.ts:40-42`
- Modify: `__tests__/contract.test.ts.snapshot` (regenerated)

**Interfaces:** none.

- [ ] **Step 1: Run the contract test to confirm it is green first**

Run: `node --test __tests__/contract.test.ts`
Expected: PASS. Stop and report it if not: a regenerated snapshot would hide the difference.

- [ ] **Step 2: Change the description**

```ts
'Append the content verbatim, adding no newline; creates the file if it does not exist',
```

- [ ] **Step 3: Regenerate the snapshot and read the diff**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`
Expected: PASS.

Run: `git diff --stat __tests__/contract.test.ts.snapshot`
Expected: only the `append` description lines changed.

- [ ] **Step 4: Commit**

```bash
git add src/tools/create.ts __tests__/contract.test.ts.snapshot
git commit -m "docs(create): say that append adds no newline"
```

### Task 6: Retire the project board docs

Do this task only if the maintainer chose to retire the board (see the handoff question). `docs/project-board.md` describes a hosted board that #57 and PR #59 never created. The roadmap review could not confirm the board's absence directly: the `gh` token lacks `read:project`.

**Files:**

- Delete: `docs/project-board.md`
- Modify: `CONTRIBUTING.md:180-185`

**Interfaces:** none.

- [ ] **Step 1: Edit `CONTRIBUTING.md`**

Rename the heading to `## Issues`, and replace the paragraph with:

```markdown
Issues are the work items, and pull requests link to them. The labels are
bug, enhancement, maintenance, documentation, and blocked.
```

- [ ] **Step 2: Delete the page and check for stale links**

Run: `git rm docs/project-board.md`

Use Grep for `project-board` in `*.md`, excluding `.claude/`, `.worktrees/` and `graphify-out/`.
Expected: no hits outside `plans/` and `docs/superpowers/`.

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs: remove the project board that was never created"
```

### Task 7: Verify, open the PR, then do the maintainer actions

- [ ] **Step 1: Run the full check**

Run: `npm run check`
Expected: exit 0.

Run: `graphify update .`
Expected: exit 0. Commit the result if `graphify-out/` shows as changed in `git status`.

- [ ] **Step 2: Open the PR**

Use the `writeup:pr` skill and `.github/PULL_REQUEST_TEMPLATE.md`. Merging closes #209.

- [ ] **Step 3: Get the maintainer's go-ahead for steps 4 to 8**

These are public and post under the maintainer's name. Show the text below and wait.

- [ ] **Step 4: Comment on and close #153, after the PR merges**

```text
Thanks for answering. `append` stays as it is and writes exactly what it is sent, and its description now says so: send the newline as part of the content. I'm closing this because append and prepend both work today, as described above. Please reopen it if a client or model still can't find them.
```

Run: `gh issue close 153 --reason completed --comment "<text above>"`

- [ ] **Step 5: Close #5 as spam**

Run: `gh issue close 5 --reason "not planned"`

- [ ] **Step 6: Close PR #125 without merging**

Its only change is a third-party badge in the README.

Run: `gh pr close 125 --comment "Thanks, but I'm not adding third-party audit badges to the README."`

- [ ] **Step 7: Close PR #59 and #57, if the board is retired**

PR #59 changes no files.

Run: `gh pr close 59 --delete-branch --comment "No changes here, and the board is not being set up."`

Run: `gh issue close 57 --reason "not planned" --comment "Not setting up a hosted board. The open issue list is small enough to manage directly."`

If the board is kept, close only PR #59, without the second sentence of its comment, and leave #57 open.

- [ ] **Step 8: Release**

Use the `release` skill on `main`. `[Unreleased]` holds `feat` entries and no breaking change, so a minor release (2.17.0) fits.
