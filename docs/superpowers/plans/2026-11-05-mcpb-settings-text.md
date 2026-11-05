# MCPB settings text: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person installing the Claude Desktop extension for the first time can fill in its settings without reading other docs.

**Architecture:** The change edits titles and descriptions in `mcpb/manifest.json` and one refusal message in `src/core/path.ts`. Setting keys and environment wiring stay as they are, so saved settings survive an upgrade. Tests pin the parts of the text that can go wrong later.

**Tech Stack:** MCPB manifest 0.3, TypeScript on Node 24+, `node:test`.

**Spec:** No design doc. The maintainer's request on 2026-11-05, restated here:

1. Tell a first-time user which files are blocked by default, and link the full list.
2. Show comma-separated values with several items, and say what each item does.
3. Write for people, in simple words.

## Global Constraints

- Branch: `fix/mcpb-settings-text`, from `main`.
- Do not stage `img.png` or `img1.png` from the repo root. Add files by name.
- Never edit a `version` field.
- Keep every `user_config` key and every `${user_config.*}` wiring line unchanged.
- Use no backticks in manifest text. Claude Desktop printed them literally in the maintainer's screenshots.
- Say "folder", not "directory", in manifest text.
- The secret-file list URL is exactly `https://github.com/j0hanz/filesystem-mcp/blob/main/docs/configuration.md#secret-files`.
- After changing code, run `graphify update .`.
- End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- End the PR description with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Review Focus

- A user who upgrades keeps their settings, because the keys did not change. Test in Task 1.
- A user copies an example with spaces after the commas, and each item still works. Test in Task 1.
- Someone renames the `## Secret files` heading, and the link in the form stops landing on the list. Test in Task 1.
- The Windows path example loses its backslashes through a JSON escaping mistake. Test in Task 1.
- A person who is refused a secret file in Claude Desktop is told about a flag they cannot set. Test in Task 2.

---

### Task 1: Rewrite the settings text

**Files:**

- Modify: `mcpb/manifest.json` (`user_config` titles and descriptions)
- Modify: `CHANGELOG.md`
- Test: `__tests__/mcpb-manifest.test.ts`, `__tests__/security.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the failing tests in `__tests__/mcpb-manifest.test.ts`**

Widen `user_config` to `Record<string, { title: string; description: string }>`.

```ts
const SECRET_LIST =
  'https://github.com/j0hanz/filesystem-mcp/blob/main/docs/configuration.md#secret-files';

it('MCPB-004: setting keys stay the same, so saved settings survive', () => {
  assert.deepStrictEqual(Object.keys(manifest.user_config), [
    'allowed_directories',
    'read_only',
    'read_only_dirs',
    'deny_patterns',
    'allow_patterns',
  ]);
});

it('MCPB-005: settings text is plain enough for the form', () => {
  for (const { title, description } of Object.values(manifest.user_config)) {
    assert.doesNotMatch(`${title} ${description}`, /`|director/i);
  }
});

it('MCPB-006: the block settings link the list, and the link has a target', () => {
  const { deny_patterns: deny, allow_patterns: allow } = manifest.user_config;
  assert.ok(deny?.description.includes(SECRET_LIST));
  assert.ok(allow?.description.includes(SECRET_LIST));
  const docs = readFileSync(new URL('../docs/configuration.md', import.meta.url), 'utf8');
  assert.match(docs, /^## Secret files$/m);
});

it('MCPB-007: the read-only folders example is a real value', () => {
  const text = manifest.user_config['read_only_dirs']?.description ?? '';
  assert.ok(text.includes('C:\\Work\\docs;C:\\Work\\archive'));
  assert.ok(text.includes('/Users/me/docs:/Users/me/archive'));
});
```

- [ ] **Step 2: Add the example test to `__tests__/security.test.ts`, after `an empty or unfilled FS_ALLOWLIST lifts nothing`**

```ts
it('the examples in the extension settings do what their text says', async () => {
  await withEnv(
    {
      FS_DENYLIST: 'private/**, *.sqlite, salaries.xlsx',
      FS_ALLOWLIST: '.env.example, debug.keystore',
    },
    () => {
      const matcher = new SensitiveMatcher();
      for (const blocked of [
        '/w/private/a.txt',
        '/w/sub/private/c.txt',
        '/w/sub/data.sqlite',
        '/w/sub/salaries.xlsx',
        '/w/.env',
        '/w/release.keystore',
      ]) {
        assert.strictEqual(matcher.isSensitive(blocked), true, blocked);
      }
      for (const open of ['/w/.env.example', '/w/debug.keystore', '/w/ok.txt']) {
        assert.strictEqual(matcher.isSensitive(open), false, open);
      }
    },
  );
});
```

- [ ] **Step 3: Run the tests**

Run: `npm test -- __tests__/mcpb-manifest.test.ts __tests__/security.test.ts`
Expected: MCPB-005, MCPB-006 and MCPB-007 fail. MCPB-004 and the example test pass, because they guard what already works.

- [ ] **Step 4: Replace the titles and descriptions in `mcpb/manifest.json`**

Use this exact text. Change no other field.

| Key                   | Title                  |
| :-------------------- | :--------------------- |
| `allowed_directories` | Allowed folders        |
| `read_only`           | Read-only mode         |
| `read_only_dirs`      | Read-only folders      |
| `deny_patterns`       | Extra blocked files    |
| `allow_patterns`      | Unblocked secret files |

`allowed_directories`:

```text
The folders the AI can use. The AI must ask you before it opens anything else.
```

`read_only`:

```text
Turn this on so the AI can read files but never change, move, or delete them.
```

`read_only_dirs`. Folders inside an allowed folder work too, as `--read-only-root` documents. Escape the backslashes in JSON.

```text
Optional. Folders the AI can read but not change. Each one must be in the list above or inside a folder in it. For more than one, type the full paths with a semicolon between them on Windows: C:\Work\docs;C:\Work\archive. On macOS and Linux, use a colon: /Users/me/docs:/Users/me/archive
```

`deny_patterns`:

```text
Optional. Files the AI can never open, with a comma between each: private/**, *.sqlite, salaries.xlsx. That example blocks everything in any folder named private, every .sqlite file, and any file named salaries.xlsx. Environment files, private keys, and cloud and SSH credentials are already blocked. Full list: https://github.com/j0hanz/filesystem-mcp/blob/main/docs/configuration.md#secret-files
```

`allow_patterns`:

```text
Optional. Leave this empty unless the AI needs a file that is blocked by default. List the files with a comma between each: .env.example, debug.keystore. The AI can then read them, so list only what you are happy for it to see. Anything in Extra blocked files stays blocked. Full list: https://github.com/j0hanz/filesystem-mcp/blob/main/docs/configuration.md#secret-files
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- __tests__/mcpb-manifest.test.ts __tests__/security.test.ts`
Expected: PASS.

- [ ] **Step 6: Validate the bundle**

Run: `bash scripts/pack-mcpb.sh`
Expected: exit 0.

- [ ] **Step 7: Add the changelog line under `### Changed`**

```markdown
- **The Claude Desktop extension's settings explain themselves.** They name what is blocked by default, link the full list, and show examples with several items. Saved settings carry over.
```

- [ ] **Step 8: Commit**

```bash
git add mcpb/manifest.json CHANGELOG.md __tests__/mcpb-manifest.test.ts __tests__/security.test.ts
git commit -m "docs(mcpb): write the settings for people installing it for the first time"
```

### Task 2: Name the extension setting in the refusal

A person using Claude Desktop cannot restart the server with a flag. `src/core/path.ts:1086` offers them only that.

**Files:**

- Modify: `src/core/path.ts:1086`
- Modify: `docs/configuration.md:388`
- Modify: `CHANGELOG.md`
- Test: `__tests__/security.test.ts:137`

**Interfaces:** none.

- [ ] **Step 1: Tighten the matcher in `TC-SEC-008`**

```ts
/--allow <pattern>[\s\S]*FS_ALLOWLIST[\s\S]*Unblocked secret files[\s\S]*--allow-sensitive[\s\S]*FS_ALLOW_SENSITIVE=1/,
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="TC-SEC-008" __tests__/security.test.ts`
Expected: FAIL on the message.

- [ ] **Step 3: Edit the message**

Change `restart the server with --allow <pattern> (or FS_ALLOWLIST);` to the following. Leave the rest of the string as it is, because `__tests__/read.test.ts:496` and `__tests__/relative-paths.test.ts:199` match its start.

```text
restart the server with --allow <pattern> (or FS_ALLOWLIST), or in the Claude Desktop extension add it to the Unblocked secret files setting;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- __tests__/security.test.ts __tests__/read.test.ts __tests__/relative-paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the docs**

At the end of the paragraph at `docs/configuration.md:388`, add: `In the Claude Desktop extension, add the file to the Unblocked secret files setting.`

Add under `### Changed` in `CHANGELOG.md`:

```markdown
- **Refusing a secret file names the extension setting.** The message offered only a restart with a flag, which a Claude Desktop user cannot do.
```

- [ ] **Step 6: Commit**

```bash
git add src/core/path.ts docs/configuration.md CHANGELOG.md __tests__/security.test.ts
git commit -m "fix(path): name the extension setting when refusing a secret file"
```

### Task 3: Verify and open the PR

- [ ] **Step 1: Run the full check**

Run: `npm run check`
Expected: exit 0.

Run: `graphify update .`
Expected: exit 0.

- [ ] **Step 2: Ask the maintainer to check the form**

Run: `bash scripts/pack-mcpb.sh`
Expected: exit 0.

Ask the maintainer to install `filesystem-mcp.mcpb` in Claude Desktop and report three things: whether the text is easy to follow, whether the URL is clickable, and whether their saved settings survived. If the URL is not clickable, keep it: a person can still copy it.

- [ ] **Step 3: Open the PR**

Use the `writeup:pr` skill and `.github/PULL_REQUEST_TEMPLATE.md`.
