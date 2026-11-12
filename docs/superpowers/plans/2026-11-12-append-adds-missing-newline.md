# Append Adds a Missing Newline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `create` with `append: true` starts the appended content on a new line when the existing file does not end with one, so appended entries never run together (issue #153).

**Architecture:** The rule lives in `GuardedFileSystem.#appendValid` (`src/core/fs.ts`), the one place every append passes through. Just before the write, on a file this call did not create, it reads the file's last byte through a separate read handle and prepends a separator to the content when that byte is not a line feed. The undo record's `expect` hash covers the separator. `create` changes only its `append` field description.

**Tech Stack:** TypeScript (Node, ESM `.ts` imports), Node built-in test runner, zod.

**Spec:** none written. Source is issue #153 (owner's question 3 and the reporter's answer) plus the decisions below, made on 2026-11-12. The owner reviews them with this plan.

## Decisions

- **Always on, no new option.** A flag would add contract surface for a behaviour nobody wants off; a caller who needs a mid-line join has `edit`.
- **Separator follows the appended content:** `'\r\n'` when `content` contains `'\r\n'`, else `'\n'`. Content is written verbatim, so this keeps an all-CRLF file all-CRLF when the caller sends CRLF.
- **No separator** when: this call created the file, the file is empty, `content` is `''`, `content` starts with `'\n'` or `'\r\n'`, or the file's last byte is `0x0A`.
- **Fail soft:** when the last byte cannot be read (a POSIX mode-0222 file), no separator is added and the append still lands.
- A file ending in a lone `'\r'` counts as not ending with a newline.

## Global Constraints

- The append stays non-atomic and keeps its inode and mode; no temp file, no rename.
- The append handle stays write-only (`APPEND_NOFOLLOW`); the tail read uses its own handle opened with `READ_NOFOLLOW`.
- The tail read runs only after `#assertFdWithinRoots` has passed.
- An append with `content: ''` writes zero bytes, as today.
- Contract change is intended: update `__tests__/contract.test.ts.snapshot` with `node --test --test-update-snapshots __tests__/contract.test.ts`, no `FS_*` variables set, and commit the diff.
- Never hand-edit versions in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`.
- Work on branch `feat/append-newline`, not `main`.
- Gate: `npm run check` green at the end of every task. After code changes run `graphify update .`.

## Review Focus

1. **Content that already opens with a newline:** `'\nsecond'` onto `'first'` gives `'first\nsecond'`, not a blank line. Test in Task 1 (`adds no separator when content starts with a newline`).
2. **Empty content:** `''` onto `'first'` leaves `'first'` byte for byte. Test in Task 1 (`an empty append writes nothing`).
3. **Undo after a separated append:** the journal's `expect` hash includes the separator, so undo restores `'abc'`, not a refusal. Test in Task 1 (`append on an existing file pushes write with the combined hash`, updated).
4. **CRLF content onto an unterminated CRLF file:** `'b\r\n'` onto `'a\r\nx'` gives `'a\r\nx\r\nb\r\n'`. Test in Task 1 (`separator is CRLF when content uses CRLF`).
5. **Two appends to one file in one batch:** both land, each on its own line. Test in Task 2 (`two appends to one unterminated file land on separate lines`).

---

## File Structure

- `src/core/fs.ts:1192-1295`: `#appendValid` gains the separator; new private `#appendSeparator`.
- `src/tools/create.ts:42-47`: `append` description.
- `__tests__/core-fs.test.ts`: the rule's tests, next to `TC-FUNC-048`.
- `__tests__/undo.test.ts:283-293, 311`: two expectations change.
- `__tests__/create.test.ts`: one wire-level test, one batch test, one fixture fix at `274-291`.
- `__tests__/contract.test.ts.snapshot`, `CHANGELOG.md`.

---

### Task 1: The separator rule in `GuardedFileSystem`

**Files:**

- Modify: `src/core/fs.ts:1192-1295`
- Test: `__tests__/core-fs.test.ts` (after `TC-FUNC-048`, line 615), `__tests__/undo.test.ts:283-293, 311`

**Interfaces:**

- Consumes: `READ_NOFOLLOW` from `src/core/read.ts`, `CHAR_LF` (`src/core/fs.ts:91`), `fsOpen`, `FileHandle`.
- Produces: `appendFile(filePath, content, options)` keeps its signature; its written bytes are now `separator + content`.

- [ ] **Step 1: Write the failing tests in `__tests__/core-fs.test.ts`**

Each seeds with `writeTestFile(tmpDir, name, seed)`, calls `fs.appendFile(filePath, content)`, and asserts `(await fs.readRaw(filePath)).content.toString('utf-8')`.

| Test name                                                           | seed        | content        | expected            |
| :------------------------------------------------------------------ | :---------- | :------------- | :------------------ |
| `adds a newline before content when the file does not end with one` | `'first'`   | `'second\n'`   | `'first\nsecond\n'` |
| `adds no separator to an empty file`                                | `''`        | `'only'`       | `'only'`            |
| `adds no separator when content starts with a newline`              | `'first'`   | `'\nsecond'`   | `'first\nsecond'`   |
| `adds no separator when content starts with CRLF`                   | `'first'`   | `'\r\nsecond'` | `'first\r\nsecond'` |
| `an empty append writes nothing`                                    | `'first'`   | `''`           | `'first'`           |
| `separator is CRLF when content uses CRLF`                          | `'a\r\nx'`  | `'b\r\n'`      | `'a\r\nx\r\nb\r\n'` |
| `a file ending in a lone CR gets a separator`                       | `'first\r'` | `'second'`     | `'first\r\nsecond'` |

Plus one POSIX-only test, skipped when `process.platform === 'win32'` or `process.getuid?.() === 0`:

```ts
it('appends without a separator when the file cannot be read', async (t) => {
  // seed 'first', chmod 0o222, appendFile 'second', chmod 0o644
  assert.strictEqual(await readFile(filePath, 'utf-8'), 'firstsecond');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- --test-name-pattern="separator|newline before content|empty append|lone CR|cannot be read"`
Expected: FAIL on the first, sixth and seventh rows (`'firstsecond\n'` and so on); the no-separator rows pass already.

- [ ] **Step 3: Update the two undo expectations in `__tests__/undo.test.ts`**

Line 292: `sha256Hex('abcdef')` becomes `sha256Hex('abc\ndef')`.
Line 311: `'concurrent-data-appended'` becomes `'concurrent-data\n-appended'` (the racer's file is not one this call created, so the rule applies).

- [ ] **Step 4: Implement `#appendSeparator` and use it in `#appendValid`**

```ts
async #appendSeparator(validPath: string, handle: FileHandle, content: string): Promise<'' | '\n' | '\r\n'>
```

- Returns `''` for empty content, content starting with `'\n'` or `'\r\n'`, or `(await handle.stat()).size === 0`.
- Otherwise opens `validPath` with `READ_NOFOLLOW`, reads 1 byte at position `size - 1`, closes. Any error from the open or read returns `''`.
- Last byte `CHAR_LF` returns `''`; else `content.includes('\r\n') ? '\r\n' : '\n'`.

In `#appendValid`: after the `#assertFdWithinRoots` line, compute `const text = created ? content : (await this.#appendSeparator(validPath, handle, content)) + content;`. Pass `text` to `handle.writeFile`, and use `text` in the `saved` branch's `expect` hash. The `remove` branch keeps `sha256Hex(content)`: it runs only when `created`.

Add one comment line above the tail read: `// shortcut: another process writing between this read and the write can cost or double a newline, upgrade to a locked read if that is reported.`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="append"`
Expected: PASS, except `counts lines up to the size limit and not past it` in `create.test.ts`, which Task 2 fixes.

- [ ] **Step 6: Commit**

```bash
git add src/core/fs.ts __tests__/core-fs.test.ts __tests__/undo.test.ts
git commit -m "feat(fs): start an append on a new line when the file does not end with one"
```

---

### Task 2: `create` surface, contract, changelog

**Files:**

- Modify: `src/tools/create.ts:42-47`, `__tests__/create.test.ts:274-291`, `__tests__/contract.test.ts.snapshot`, `CHANGELOG.md`
- Test: `__tests__/create.test.ts` (after line 240)

**Interfaces:**

- Consumes: Task 1's `appendFile` behaviour.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing tests in `__tests__/create.test.ts`**

```ts
it('starts appended content on a new line when the file does not end with one', async () => {
  const file = await writeTestFile(root, 'append_unterminated.txt', 'first');
  const result = await create({ files: [{ path: file, content: 'second', append: true }] });
  assert.notStrictEqual(result.isError, true);
  assert.strictEqual(await readFile(file, 'utf-8'), 'first\nsecond');
  assert.strictEqual(result.structured.files[0]?.lineCount, 2);
});

it('two appends to one unterminated file land on separate lines', async () => {
  const file = await writeTestFile(root, 'append_twice.txt', 'x');
  await create({
    files: [
      { path: file, content: 'a', append: true },
      { path: file, content: 'b', append: true },
    ],
  });
  assert.deepStrictEqual((await readFile(file, 'utf-8')).split('\n').sort(), ['a', 'b', 'x']);
});
```

- [ ] **Step 2: Fix the size-limit fixture at lines 274-291**

Both seeds currently end without a newline, so the separator now pushes `at_limit.log` past the limit. End each seed with `'\n'` at the same byte total: `'a'.repeat(MIB - content.length - 1) + '\n'` and `'a'.repeat(MIB - content.length) + '\n'`. The first `lineCount` expectation becomes `2`.

- [ ] **Step 3: Run to verify**

Run: `npm test -- --test-name-pattern="append|size limit"`
Expected: PASS (Task 1 already supplies the behaviour; these pin the wire).

- [ ] **Step 4: Change the `append` description in `src/tools/create.ts`**

Exact copy:

```ts
'Add content to the end, on a new line if the file does not end with one; creates a missing file. Never asks; wins over overwrite. lineCount is 0 past FS_MAX_FILE_SIZE.',
```

- [ ] **Step 5: Update the contract snapshot**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`
Expected: `git diff --stat __tests__/contract.test.ts.snapshot` shows only the `append` description line changed.

- [ ] **Step 6: Add the changelog entry under `## [Unreleased]` → `### Changed`**

```markdown
- **create**: `append: true` now starts the content on a new line when the existing file does not end with one; before, the text was joined to the last line. The newline is CRLF when the content uses CRLF. Nothing is added to an empty or new file, or when the content already starts with a newline (#153).
```

- [ ] **Step 7: Run the full gate**

Run: `npm run check`
Expected: exit 0.

Run: `graphify update .`

- [ ] **Step 8: Commit**

```bash
git add src/tools/create.ts __tests__/create.test.ts __tests__/contract.test.ts.snapshot CHANGELOG.md graphify-out
git commit -m "feat(create): say append starts on a new line (#153)"
```
