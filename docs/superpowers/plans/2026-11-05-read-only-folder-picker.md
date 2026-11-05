# Read-only folder picker: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People choose read-only folders in the Claude Desktop extension with a folder picker, as they do for allowed folders, on any OS and without typing paths or separators.

**Architecture:** MCPB can pass a multi-select value only as command-line arguments, and it spreads the values in place. A new last-position flag, `--read-only-roots`, makes every argument after it a read-only folder. `splitReadOnlyRoots` removes them from the argument list before parsing, so none can become a writable root.

**Tech Stack:** TypeScript on Node 24+, `node:util` `parseArgs`, `node:test`, MCPB manifest 0.3, `replaceVariables` from `@anthropic-ai/mcpb` (already a dev dependency).

**Spec:** No design doc. The maintainer's request on 2026-11-05: the read-only setting should be clickable like allowed folders, and OS differences should need no thought from the user.

## Global Constraints

- Branch: `fix/mcpb-settings-text`, the existing unpushed branch, on top of `ab10a63b`.
- Do not stage `img.png` or `img1.png`. Add files by name.
- Do not run `git stash`. The stack holds the maintainer's old work.
- Never edit a `version` field.
- Keep the `read_only_dirs` key, so saved settings stay attached to it.
- `--read-only-root` and `FS_READ_ONLY_DIRS` keep working unchanged.
- A folder chosen as read-only must never end up as a writable root.
- After changing code, run `graphify update .`.
- End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- End the PR description with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Review Focus

- A user upgrades with the setting saved as an empty string. `replaceVariables` treats `""` as missing and passes the literal `${user_config.read_only_dirs}`. The server must start with no read-only folders. Tests in Tasks 1 and 2.
- A user upgrades with `C:\a;C:\b` saved from the old text field. Both folders stay read-only. Test in Task 1.
- A chosen folder's name contains the separator, such as `a;b` on Windows. It stays one folder. Test in Task 1.
- A chosen folder is deleted later. The extension still starts, and the folder stays protected if it comes back, as `FS_READ_ONLY_DIRS` behaves today. Test in Task 1.
- A user chooses no folders. Nothing is added, and allowed folders still arrive as roots. Test in Task 2.

---

### Task 1: Add `--read-only-roots` to the server

**Files:**

- Modify: `src/cli.ts` (`parseArgs`, new exported helper)
- Modify: `src/cli-help.ts:30`, `docs/configuration.md:180`, `CHANGELOG.md`
- Test: `__tests__/cli.test.ts` (after `CLI-RO-002`)
- Add: `docs/superpowers/plans/2026-11-05-read-only-folder-picker.md`

**Interfaces:**

- Produces: `export function splitReadOnlyRoots(argv: readonly string[]): { args: string[]; readOnlyRoots: string[] }` in `src/cli.ts`. `args` is everything before the flag. `readOnlyRoots` is everything after it, minus entries matching `/^\$\{user_config\.[^}]+\}$/`. Without the flag, `args` is `argv` and `readOnlyRoots` is empty.

- [ ] **Step 1: Write the failing tests in `__tests__/cli.test.ts`**

Import `delimiter` from `node:path`. Give each test its own folder under `root`, created with `mkdir(..., { recursive: true })`. Each test parses `stdout` as `{ readOnlyDirs: string[]; allowedRoots: string[] }` and asserts `code === 0`.

| Test name                                                       | Arguments after `--print-config`                                    | Assertions                                                           |
| :-------------------------------------------------------------- | :------------------------------------------------------------------ | :------------------------------------------------------------------- |
| `CLI-RO-003: every folder after --read-only-roots is read-only` | `root, '--read-only-roots', a, b`                                   | `readOnlyDirs` equals both, normalized; `allowedRoots` holds neither |
| `CLI-RO-004: an unfilled placeholder adds nothing`              | `root, '--read-only-roots', '${user_config.read_only_dirs}'`        | `readOnlyDirs` is empty                                              |
| `CLI-RO-005: a list saved by the old text field is split`       | `root, '--read-only-roots', [a, b].join(delimiter)`                 | `readOnlyDirs` equals both, normalized                               |
| `CLI-RO-006: a folder name holding the separator stays whole`   | `root, '--read-only-roots', c`, where `c` is `` `x${delimiter}y` `` | `readOnlyDirs` equals `[normalizePath(c)]`                           |
| `CLI-RO-007: a missing folder still starts and stays listed`    | `root, '--read-only-roots', join(root, 'gone')`                     | `readOnlyDirs` includes `normalizePath(join(root, 'gone'))`          |

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="CLI-RO-00[3-7]" __tests__/cli.test.ts`
Expected: FAIL, because strict parsing rejects the unknown option.

- [ ] **Step 3: Implement in `src/cli.ts`**

- Add `splitReadOnlyRoots` as the Interfaces block defines it.
- In `parseArgs`, call it on `process.argv.slice(2)` and pass `args` to `utilParseArgs({ ...CLI_PARSER_CONFIG, args })`.
- Expand each `readOnlyRoots` entry with a private `async function expandSavedList(entry: string): Promise<string[]>`. If the entry does not contain `delimiter` from `node:path`, return it as is. If it is an existing directory, return it as is. Otherwise return `splitDirList(entry)`.
- Run the existing `--read-only-root` shape checks (`validateCliPath`, the whitespace refusal) over the expanded entries too.
- Build `readOnlyDirs` from `normalizeAndValidateDirs(v['read-only-root'] ?? [], allowMissingRoots)` followed by `normalizeAndValidateDirs(expanded, true)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="CLI-RO" __tests__/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Document the flag**

Add to `src/cli-help.ts`, after `--read-only-root <dir>`:

```ts
{
  flags: '--read-only-roots <dir...>',
  desc: 'Like --read-only-root for every argument after it; must come last. For hosts that pass a folder list as arguments',
},
```

Add to the table in `docs/configuration.md`, after `--read-only-root`:

```markdown
| `--read-only-roots <dir...>` | | Like `--read-only-root` for every argument after it, so it must come last. The Claude Desktop extension uses this. |
```

Add under `### Added` in `CHANGELOG.md`:

```markdown
- **`--read-only-roots` takes a list of read-only folders.** Every argument after it is read-only, so it must come last. A folder that does not exist yet is accepted and protected once it appears.
```

Run: `npx prettier --write docs/configuration.md`
Expected: only the table realigns.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/cli-help.ts docs/configuration.md CHANGELOG.md __tests__/cli.test.ts docs/superpowers/plans/2026-11-05-read-only-folder-picker.md
git commit -m "feat(cli): add --read-only-roots for hosts that pass a folder list"
```

### Task 2: Turn the setting into a folder picker

**Files:**

- Modify: `mcpb/manifest.json` (`mcp_config.args`, `mcp_config.env`, `user_config.read_only_dirs`)
- Modify: `CHANGELOG.md`
- Test: `__tests__/mcpb-manifest.test.ts`

**Interfaces:**

- Consumes: `splitReadOnlyRoots` from Task 1.

- [ ] **Step 1: Write the failing tests**

Widen the manifest type with `server.mcp_config.args: string[]` and `user_config` entries' optional `type`, `multiple` and `default`. Import `replaceVariables` from `@anthropic-ai/mcpb` and `splitReadOnlyRoots` from `../src/cli.ts`.

Replace `MCPB-007` with:

```ts
it('MCPB-007: read-only folders use the folder picker', () => {
  const setting = manifest.user_config['read_only_dirs'];
  assert.strictEqual(setting?.type, 'directory');
  assert.strictEqual(setting.multiple, true);
  assert.deepStrictEqual(setting.default, []);
  assert.doesNotMatch(setting.description, /semicolon|colon/);
  assert.strictEqual(manifest.server.mcp_config.env['FS_READ_ONLY_DIRS'], undefined);
});
```

Add:

```ts
describe('MCPB-011: arguments the host builds', () => {
  const build = (readOnly: string | string[]) => {
    const argv = replaceVariables(manifest.server.mcp_config.args, {
      __dirname: '/x',
      'user_config.allowed_directories': ['/w', '/v'],
      'user_config.read_only_dirs': readOnly,
    }) as string[];
    return splitReadOnlyRoots(argv.slice(1));
  };

  it('keeps chosen folders out of the roots', () => {
    assert.deepStrictEqual(build(['/w/a', '/w/b']), {
      args: ['/w', '/v'],
      readOnlyRoots: ['/w/a', '/w/b'],
    });
  });

  it('adds nothing when no folder is chosen', () => {
    assert.deepStrictEqual(build([]), { args: ['/w', '/v'], readOnlyRoots: [] });
  });

  it('adds nothing for a setting saved empty by the old text field', () => {
    assert.deepStrictEqual(build(''), { args: ['/w', '/v'], readOnlyRoots: [] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- __tests__/mcpb-manifest.test.ts`
Expected: `MCPB-007` and all three `MCPB-011` tests fail.

- [ ] **Step 3: Edit `mcpb/manifest.json`**

- `args` becomes `["${__dirname}/dist/index.js", "${user_config.allowed_directories}", "--read-only-roots", "${user_config.read_only_dirs}"]`.
- Remove the `FS_READ_ONLY_DIRS` line from `env`.
- Replace the `read_only_dirs` entry with:

```json
"read_only_dirs": {
  "type": "directory",
  "title": "Read-only folders",
  "description": "Optional. Folders the AI can read but not change. Each one must be in Allowed folders or inside one of them.",
  "multiple": true,
  "default": [],
  "required": false
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- __tests__/mcpb-manifest.test.ts`
Expected: PASS. `MCPB-003` still passes, because the setting's placeholder is now in `args`.

- [ ] **Step 5: Add the changelog line under `### Changed`**

```markdown
- **The Claude Desktop extension picks read-only folders with a folder picker.** There are no paths or separators to type. A list saved by the old text field keeps working.
```

- [ ] **Step 6: Commit**

```bash
git add mcpb/manifest.json CHANGELOG.md __tests__/mcpb-manifest.test.ts
git commit -m "feat(mcpb): choose read-only folders with a folder picker"
```

### Task 3: Verify and hand over

- [ ] **Step 1: Run the full check**

Run: `npm run check`
Expected: exit 0.

Run: `graphify update .`
Expected: exit 0.

- [ ] **Step 2: Pack the bundle**

Run: `bash scripts/pack-mcpb.sh`
Expected: exit 0.

- [ ] **Step 3: Ask the maintainer to test it in Claude Desktop**

The expansion code is the published MCPB library, and Claude Desktop's own behaviour is the one thing the tests above cannot show. Ask them to install `filesystem-mcp.mcpb` and report:

1. "Read-only folders" opens a folder picker that accepts several folders.
2. With two folders chosen, Claude can read a file in each and cannot write in either, including the second.
3. With none chosen, the extension starts and writes work.
4. Any old saved value still applies, or the form asks them to choose again.
5. The settings text is easy to follow, and whether the URL is clickable.

If the picker does not start the server, or the second folder is writable, stop and report it. Revert Task 2 and keep the typed field.

- [ ] **Step 4: Open the PR**

Use the `writeup:pr` skill and `.github/PULL_REQUEST_TEMPLATE.md`. Its subject covers both the settings text and the picker.
