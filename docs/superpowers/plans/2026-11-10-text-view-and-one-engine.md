# Text view and one matching engine: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `search_text`, `edit`, `patch` and `replace_text` read a file through one Text view, and `search_text` and `replace_text` match through one engine, so a search previews exactly what a replacement touches.

**Architecture:** A new core module, `src/core/text-view.ts`, hides a leading BOM and shows an all-CRLF file as LF; the Rewrite (`src/core/rewrite.ts`) hands every transform the view and restores it on write, and search reads the same view. Then `src/core/matcher.ts` grows one `MatchEngine` that both tools drive: it feeds the regex engine one line at a time when the needle cannot match a line break, and the whole text when it can.

**Tech Stack:** TypeScript 7 (run by Node's type stripping, imports end in `.ts`), Node built-in test runner, `@adguard/re2-wasm`, `diff` (jsdiff) 9, zod 4.

**Spec:** `docs/adr/013-one-text-view-and-one-matching-engine.md`, with the terms **Text view**, **Match plan** and **Rewrite** in `GLOSSARY.md`. Read both before any task.

## Global Constraints

- Three pull requests, in order, each with `npm run check` green: **PR A** = Tasks 1–3, **PR B** = Task 4, **PR C** = Tasks 5–7. Branch from `main` for each; never commit to `main`.
- A file with mixed line endings, or with a lone `\r`, is shown as written. Only a file whose every line ends in `\r\n` is shown with LF endings.
- The Rewrite reports `before` and `after` as the text on disk (BOM and `\r\n` included).
- Decoding and the binary, undecodable and too-large verdicts stay in `readText` (`src/core/scan.ts`, ADR-005). The Text view takes decoded text.
- The regex engine takes at most `RE2_MAX_INPUT_BYTES` (4 MiB, `src/core/matcher.ts:40`) per call.
- A `search_text` hit keeps its shape: `line`, `column`, `content`, `matchCount`, optional `before`/`after`. No new field.
- Every compiled `Regex` is released with `freeRegex` in a `finally` (see the comment on `compileRegex`).
- Tests use `node:test` and `node:assert/strict`; tool tests go through `runToolBodyResult` from `__tests__/tool-harness.ts`; filesystem tests use `createTestRoot`, `makeGuard` and `cleanupTestRoot` from `__tests__/helpers.ts`.
- Write a BOM in test source as the escape `'﻿'`, never as a raw character.
- Do not hand-edit any version field (see `CLAUDE.md`, Releases).
- Commit messages follow the repository's Conventional Commits style, scope = tool or module (`feat(text-view): …`, `fix(replace_text): …`).

## Review Focus

1. **A file with a lone `\r` or `\r\r\n`.** It must come back byte-identical from a Rewrite that changes another line. Pinned in Task 1 (round trip) and Task 2 (edit through the harness).
2. **A client types `\r\n` in a literal needle against an all-CRLF file** (`edit` `oldText`, `replace_text` `searchPattern`). It matched before and must still match. Pinned in Tasks 2 and 3.
3. **A regex judged line-bound that can in fact match `\n`** (`[[:space:]]`, `\x0a`, `\W`, `\D`, `\p{Cc}`, `(?s).`, a raw newline in the source). A wrong "cannot cross" silently drops matches, so each must be judged as crossing. Pinned in Task 5.
4. **A text that ends in a newline, and an empty file, with `^` or `$`.** `replace_text` today matches the empty position after the last newline (`^`→`x` on `a\nb\n` gives `xa\nxb\nx`) and the empty file; `search_text` reports neither. After Task 6 `replace_text` follows search. Pinned in Tasks 5 and 6.
5. **A file over 4 MiB.** A line-bound regex must search and replace it; a regex that can cross a line must refuse it (`TOO_LARGE` for a named file, counted in `skippedTooLarge` for a walked one). Pinned in Tasks 5 and 7.

---

## File Structure

| File                                      | Responsibility                                              | Tasks   |
| :---------------------------------------- | :---------------------------------------------------------- | :------ |
| `src/core/text-view.ts` (new)             | The Text view: view, accept, restore, byte prefilter rule   | 1       |
| `__tests__/text-view.test.ts` (new)       | The view's interface suite                                  | 1       |
| `src/core/rewrite.ts`                     | Hands transforms the view; restores on write                | 2, 3    |
| `src/tools/edit.ts`, `src/tools/patch.ts` | Transforms over view text                                   | 2       |
| `src/tools/replace-text.ts`               | Transform over view text; later drives the engine           | 3, 6    |
| `src/core/util.ts`                        | Loses `usesCrlf`, `toCrlf`                                  | 3       |
| `src/core/search.ts`                      | Reads through the view; later drives the engine             | 4, 7    |
| `src/core/matcher.ts`                     | `MatchEngine`, `replaceMatches`; loses `ReplacementMatcher` | 5, 6, 7 |
| `__tests__/match-engine.test.ts` (new)    | The engine's interface suite, with search/replace parity    | 5       |
| `src/tools/search-text.ts`                | Description copy                                            | 7       |

---

## PR A: the Text view under the Rewrite

### Task 1: The Text view module

**Files:**

- Create: `src/core/text-view.ts`
- Test: `__tests__/text-view.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:

```ts
export interface TextView {
  /** The decoded file as it is on disk. */
  readonly disk: string;
  /** The text a tool judges: no leading BOM; LF endings when `crlf`. */
  readonly text: string;
  readonly bom: boolean;
  readonly crlf: boolean;
  /** Text a client wrote against the file on disk, as the view shows it. */
  accept(text: string): string;
  /** Text produced from `text`, as it goes to disk. */
  restore(text: string): string;
}
export function viewText(disk: string): TextView;
/** The bytes a byte-level prefilter may test, or undefined when it must not run. */
export function prefilterBytes(bytes: Buffer): Buffer | undefined;
```

Rules the tests below do not fully determine:

- `bom` is `disk.charCodeAt(0) === 0xfeff`. The body is `disk` without that character.
- `crlf` is true when the body contains `\r\n` and matches neither a bare `\n` nor a lone `\r`: `!/(?<!\r)\n|\r(?!\n)/u.test(body)`.
- `accept` drops a leading U+FEFF when `bom`, and replaces `\r\n` with `\n` when `crlf`; otherwise it returns its input.
- `restore` replaces `/\r?\n/g` with `\r\n` when `crlf`, then prefixes U+FEFF when `bom`.
- `prefilterBytes` returns `undefined` when the bytes contain a CR (byte 13); otherwise the bytes without a leading `EF BB BF`.

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { prefilterBytes, viewText } from '../src/core/text-view.ts';

const BOM = '﻿';

describe('Text view', () => {
  it('shows an LF file as written', () => {
    const view = viewText('a\nb\n');
    assert.deepEqual([view.text, view.bom, view.crlf], ['a\nb\n', false, false]);
  });

  it('hides a leading BOM and puts it back', () => {
    const view = viewText(`${BOM}a\nb\n`);
    assert.deepEqual([view.text, view.bom], ['a\nb\n', true]);
    assert.equal(view.restore('x\nb\n'), `${BOM}x\nb\n`);
  });

  it('shows an all-CRLF file with LF endings and restores them', () => {
    const view = viewText('a\r\nb\r\n');
    assert.deepEqual([view.text, view.crlf], ['a\nb\n', true]);
    assert.equal(view.restore('a\nx\nb\n'), 'a\r\nx\r\nb\r\n');
  });

  it('restore does not double a CR a transform wrote', () => {
    assert.equal(viewText('a\r\nb\r\n').restore('a\r\nb\n'), 'a\r\nb\r\n');
  });

  for (const disk of ['a\r\nb\n', 'a\rb\r\n', 'a\r\r\nb\r\n', 'a\r', '', 'no newline']) {
    it(`shows ${JSON.stringify(disk)} as written`, () => {
      const view = viewText(disk);
      assert.deepEqual([view.text, view.crlf], [disk, false]);
    });
  }

  for (const disk of ['a\nb', `${BOM}a\r\nb\r\n`, 'a\r\r\nb\r\n', `${BOM}`, 'a\r\nb']) {
    it(`round-trips ${JSON.stringify(disk)}`, () => {
      const view = viewText(disk);
      assert.equal(view.restore(view.text), disk);
    });
  }

  it('accept turns client CRLF text into view text only for a CRLF file', () => {
    assert.equal(viewText('a\r\nb\r\n').accept('a\r\nb'), 'a\nb');
    assert.equal(viewText('a\nb\n').accept('a\r\nb'), 'a\r\nb');
  });

  it('accept drops a leading BOM only for a BOM file', () => {
    assert.equal(viewText(`${BOM}a\n`).accept(`${BOM}a`), 'a');
    assert.equal(viewText('a\n').accept(`${BOM}a`), `${BOM}a`);
  });

  it('prefilterBytes drops the BOM bytes and refuses bytes holding a CR', () => {
    assert.deepEqual(prefilterBytes(Buffer.from(`${BOM}ab`)), Buffer.from('ab'));
    assert.deepEqual(prefilterBytes(Buffer.from('ab')), Buffer.from('ab'));
    assert.equal(prefilterBytes(Buffer.from('a\r\nb')), undefined);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test __tests__/text-view.test.ts`
Expected: FAIL, cannot find module `../src/core/text-view.ts`.

- [ ] **Step 3: Implement `viewText` and `prefilterBytes` in `src/core/text-view.ts`**

Open the file with a module comment that names the glossary term, as `src/core/matcher.ts:1-7` does for the Match plan.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test __tests__/text-view.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/text-view.ts __tests__/text-view.test.ts
git commit -m "feat(text-view): one view of a file's text for every text tool"
```

### Task 2: A named-file Rewrite reads through the view (`edit`, `patch`)

**Files:**

- Modify: `src/core/rewrite.ts:24-62, 123-160`
- Modify: `src/tools/edit.ts:20, 535-560, ~593` (`applyEdits` and its `rewriteFile` call)
- Modify: `src/tools/patch.ts:81-96, 215-230`
- Test: `__tests__/rewrite.test.ts`, `__tests__/edit.test.ts`, `__tests__/patch.test.ts`

**Interfaces:**

- Consumes: `TextView`, `viewText` from Task 1.
- Produces:

```ts
// src/core/rewrite.ts
export function rewriteFile<T>(
  request: RewriteRequest & { readonly tool: string },
  transform: (content: string, view: TextView) => Change<T> | Promise<Change<T>>,
): Promise<Rewritten<T>>;
```

`content` is `view.text`. `Change.content` is view text. `Rewritten.before` is `view.disk`; `Rewritten.after` is `view.restore(change.content)`, and that is what `fs.writeFile` receives and what `report()` measures. The internal `apply` takes the view in place of `before`. Task 3 relies on `apply` accepting a `TextView`.

- [ ] **Step 1: Write the failing tests**

In `__tests__/rewrite.test.ts`, inside `describe('Rewrite', …)`:

```ts
it('a transform sees view text and the file keeps its BOM and CRLF', async () => {
  await writeFile(path, '﻿one\r\ntwo\r\n');
  let seen = '';
  const done = await rewriteFile({ fs, path, dryRun: false, tool: 'edit' }, (content, view) => {
    seen = content;
    assert.deepEqual([view.bom, view.crlf], [true, true]);
    return { content: content.replace('two', 'two\nthree'), result: 1, write: true };
  });
  assert.equal(seen, 'one\ntwo\n');
  assert.equal(await readFile(path, 'utf8'), '﻿one\r\ntwo\r\nthree\r\n');
  assert.equal(done.before, '﻿one\r\ntwo\r\n');
  assert.equal(done.after, '﻿one\r\ntwo\r\nthree\r\n');
});

it('a dry run reports the on-disk text it would write', async () => {
  await writeFile(path, 'one\r\n');
  const done = await rewriteFile({ fs, path, dryRun: true, tool: 'edit' }, (content) => ({
    content: content + 'two\n',
    result: 1,
    write: true,
  }));
  assert.equal(done.after, 'one\r\ntwo\r\n');
  assert.equal(await readFile(path, 'utf8'), 'one\r\n');
});
```

In `__tests__/edit.test.ts`, through the file's existing harness helper (follow the neighbouring tests for the call shape):

- `'oldText typed with CRLF matches an all-CRLF file'`: file `a\r\nb\r\nc\r\n`, edit `{ oldText: 'a\r\nb', newText: 'x' }`; assert the file is `x\r\nc\r\n`.
- `'a lone CR elsewhere in the file survives an edit'`: file `a\rb\r\nc\r\n`, edit `{ oldText: 'c', newText: 'd' }`; assert the file is `a\rb\r\nd\r\n`.
- `'oldText on line 1 of a BOM file matches and the mark stays'`: file `﻿a\nb\n`, edit `{ oldText: 'a\nb', newText: 'x' }`; assert the file is `﻿x\n`.

In `__tests__/patch.test.ts`:

- `'a CRLF diff applies to an all-CRLF file'`: file `a\r\nb\r\n`, diff `--- a\r\n+++ a\r\n@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n`; assert the file is `a\r\nc\r\n`.
- `'an LF diff applies to an all-CRLF file'`: same file, the same diff with `\n` endings; assert `a\r\nc\r\n`.
- `'a diff whose first line carries the BOM applies to a BOM file'`: file `﻿a\nb\n`, diff `--- a\n+++ a\n@@ -1,2 +1,2 @@\n-﻿a\n+﻿z\n b\n`; assert the file is `﻿z\nb\n`.
- `'a diff without the BOM applies to a BOM file'`: same file, diff lines `-a`, `+z`, ` b`; assert `﻿z\nb\n`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test __tests__/rewrite.test.ts __tests__/edit.test.ts __tests__/patch.test.ts`
Expected: the new Rewrite tests fail (`seen` holds the BOM and `\r\n`); record which of the new edit and patch tests already pass, since jsdiff converts some line endings itself.

- [ ] **Step 3: Change `rewriteFile` and `apply` in `src/core/rewrite.ts`**

`rewriteFile` builds `viewText(content)` from `readNamedText`'s content and passes `(view.text, view)` to the transform. `apply` takes `view: TextView` where it took `before: string`, sets `after = view.restore(change.content)`, writes `after`, and returns `before: view.disk`. For this task `rewriteEntry` keeps its behaviour by passing an identity view: `{ disk: before, text: before, bom: false, crlf: false, accept: (t) => t, restore: (t) => t }`. Update the `Change.content` doc comment to say it is view text.

- [ ] **Step 4: Change `edit` to match in view text**

In `applyEdits` (`src/tools/edit.ts:535`), add a `view: TextView` parameter; replace the `usesCrlf`/`toCrlf` lines with `const oldText = view.accept(edit.oldText)` and `const newText = view.accept(edit.newText)`. Pass the view from the `rewriteFile` transform. Remove the `toCrlf, usesCrlf` import.

- [ ] **Step 5: Change `patch` to view the diff**

In the `rewriteFile` transform (`src/tools/patch.ts:91`), take `(content, view)` and call `patchContent({ ...args, diff: view.accept(args.diff) }, content, view.bom)`. In `patchContent`, after `parsePatch`, when the new `bom` parameter is true and the first hunk's `oldStart` is 0 or 1: drop a leading U+FEFF from the body of that hunk's first old-side line (prefix ` ` or `-`) and of its first new-side line (prefix ` ` or `+`). `stripCr` and `mismatchDetail` stay: a mixed-ending file is still shown as written.

- [ ] **Step 6: Run to verify they pass**

Run: `node --test __tests__/rewrite.test.ts __tests__/edit.test.ts __tests__/patch.test.ts`
Expected: PASS, all tests, old and new.

- [ ] **Step 7: Prune duplicated tool tests**

In `__tests__/edit.test.ts` and `__tests__/patch.test.ts`, delete tests whose only assertion is that a BOM or CRLF survives or converts and that `__tests__/text-view.test.ts` now covers. Keep the tests added in Step 1 and any test that pins an error message, a diff shown to the client, or indentation next to a BOM (`edit.ts:199-200`). List each deleted test name in the commit body.

- [ ] **Step 8: Run the full check and commit**

Run: `npm run check`
Expected: exits 0.

```bash
git add src/core/rewrite.ts src/tools/edit.ts src/tools/patch.ts __tests__/rewrite.test.ts __tests__/edit.test.ts __tests__/patch.test.ts
git commit -m "feat(rewrite): edit and patch read a named file through the Text view"
```

### Task 3: A walked-file Rewrite reads through the view (`replace_text`)

**Files:**

- Modify: `src/core/rewrite.ts:64-82`
- Modify: `src/tools/replace-text.ts:197, 210-275, 315-340, 400-406, 440, 491`
- Modify: `src/core/util.ts:124-135` (delete `usesCrlf`, `toCrlf`)
- Modify: the `replace_text` input description, if it tells the client to write `\r?\n`
- Test: `__tests__/rewrite.test.ts`, `__tests__/replace-text.test.ts`

**Interfaces:**

- Consumes: `viewText`, `prefilterBytes`, `TextView` (Task 1); `apply` taking a view (Task 2).
- Produces:

```ts
// src/core/rewrite.ts
export function rewriteEntry<T>(
  request: RewriteRequest,
  transform: (
    bytes: Buffer,
    stats: Stats,
    /** Decodes and views the bytes once; the Rewrite restores through the same view. */
    open: () => TextView,
  ) => Promise<Change<T> | undefined>,
): Promise<Rewritten<T> | ScanSkip | undefined>;
```

`Change.before` is removed: `open()` holds the decoded text.

- [ ] **Step 1: Write the failing tests**

In `__tests__/replace-text.test.ts`, through the file's harness helper. Each writes one file, runs `replace_text` on it by name, and asserts the file's bytes:

| Test name                                            | File             | Args                                                            | File after           |
| :--------------------------------------------------- | :--------------- | :-------------------------------------------------------------- | :------------------- |
| `a regex $ matches before CRLF`                      | `foo\r\nbar\r\n` | `searchPattern: 'foo$'`, `isRegex: true`, `replacement: 'X'`    | `X\r\nbar\r\n`       |
| `a literal typed with CRLF matches an all-CRLF file` | `a\r\nb\r\n`     | `searchPattern: 'a\r\nb'`, `replacement: 'x'`                   | `x\r\n`              |
| `a literal typed with LF matches an all-CRLF file`   | `a\r\nb\r\n`     | `searchPattern: 'a\nb'`, `replacement: 'x\ny'`                  | `x\r\ny\r\n`         |
| `a mixed-ending file is matched as written`          | `a\r\nb\nc\n`    | `searchPattern: 'b\nc'`, `replacement: 'x'`                     | `a\r\nx\n`           |
| `a regex \r does not match an all-CRLF file`         | `a\r\nb\r\n`     | `searchPattern: 'a\\r\\n'`, `isRegex: true`, `replacement: 'x'` | unchanged, 0 matches |
| `line 1 of a BOM CRLF file matches ^ and keeps both` | `﻿a\r\nb\r\n`    | `searchPattern: '^a$'`, `isRegex: true`, `replacement: 'x'`     | `﻿x\r\nb\r\n`        |

In `__tests__/rewrite.test.ts`: `'rewriteEntry restores through the view its transform opened'`: file `﻿a\r\n`; the transform calls `open()`, asserts `text === 'a\n'`, returns `{ content: 'b\n', result: 1, write: true }`; assert the file is `﻿b\r\n` and `done.before === '﻿a\r\n'`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test __tests__/rewrite.test.ts __tests__/replace-text.test.ts`
Expected: `a regex $ matches before CRLF` fails with the file unchanged; the `rewriteEntry` test fails to compile or assert.

- [ ] **Step 3: Change `rewriteEntry`**

Memoise `open` over `viewText(verdict.bytes.toString('utf8'))`; after the transform returns a change, call `apply` with `open()`. Remove `before` from `Change`.

- [ ] **Step 4: Change `processEntry` in `src/tools/replace-text.ts`**

Replace lines 233–262 (the `eol` choice, the BOM handling and the restore) with this order:

1. `const probe = prefilterBytes(bytes)`; when it is defined and `matcher.testBuffer(probe)` is false, return `undefined`.
2. `const view = open()`.
3. Pick the matcher and replacement: `ctx.lf` when `view.crlf` and `ctx.lf` is defined, else the base pair.
4. Run `replace(view.text, …)`; keep the `matchCount === 0`, `more`, budget and `write.started` logic as it is.
5. The size check measures `view.restore(content)`: `Buffer.byteLength(view.restore(content), 'utf8') > limits.maxBytes`.
6. Return `{ content, result: matchCount, write: true }`.

Replace `createCrlfVariant` with `createLfVariant(args, matcher): ReplaceContext['lf']`: `undefined` when `args.isRegex`, or when neither `args.searchPattern` nor `args.replacement` contains `\r\n`; otherwise the pair built from both with `\r\n` replaced by `\n`, reusing `matcher` when the pattern is unchanged. Rename the context field `crlf` to `lf` at lines 197, 403–405, 440 and 491.

- [ ] **Step 5: Delete `usesCrlf` and `toCrlf` from `src/core/util.ts`**

Run: `npm run check:static`
Expected: exits 0, no remaining importer.

- [ ] **Step 6: Update the client-facing copy**

Run: `grep -n "CRLF\|\\\\r" src/tools/replace-text.ts src/core/schema.ts`
Where a description tells the client how to match line endings, state: `A file whose lines all end in CRLF is matched as if they ended in LF; write \n, not \r\n, in a regex.` If the advertised text changes, update the snapshot with `node --test --test-update-snapshots __tests__/contract.test.ts` (no `FS_*` variables set).

- [ ] **Step 7: Run, prune, check**

Run: `node --test __tests__/rewrite.test.ts __tests__/replace-text.test.ts`
Expected: PASS.

Prune `__tests__/replace-text.test.ts` by the rule in Task 2 Step 7; keep the six tests from Step 1 and the plan 089 BOM test. Then:

Run: `npm run check`
Expected: exits 0.

- [ ] **Step 8: Commit and open PR A**

```bash
git add src/core/rewrite.ts src/core/util.ts src/tools/replace-text.ts __tests__/rewrite.test.ts __tests__/replace-text.test.ts __tests__/contract.test.ts.snapshot
git commit -m "fix(replace_text): match through the Text view, so \$ sees the end of a CRLF line"
```

---

## PR B: search reads through the view

### Task 4: `search_text` reads the Text view

**Files:**

- Modify: `src/core/search.ts:188-200, 369-376`
- Test: `__tests__/search-text.test.ts`

**Interfaces:**

- Consumes: `viewText`, `prefilterBytes` (Task 1).
- Produces: nothing new. `scanFileBody` matches `viewText(decoded).text`.

- [ ] **Step 1: Write the tests**

In `__tests__/search-text.test.ts`, through the harness:

- `'a BOM CRLF file reports line 1 at column 0 without the mark or a CR'`: file `﻿foo\r\nbar\r\n`, `searchPattern: '^foo$'`, `isRegex: true`; assert one hit with `line: 1`, `column: 0`, `content: 'foo'`.
- `'a mixed-ending file still matches $ before CRLF'`: file `foo\r\nbar\n`, `searchPattern: 'foo$'`, `isRegex: true`; assert one hit on line 1 with `content: 'foo'`.

- [ ] **Step 2: Run them**

Run: `node --test __tests__/search-text.test.ts`
Expected: both PASS already (search strips the BOM and splits on `\r?\n` today). They pin behaviour across the change.

- [ ] **Step 3: Read through the view**

In `scanFileBody`: replace the BOM strip at lines 190–192 with `const content = viewText(buffer.toString('utf-8')).text`. Give `literal.mayMatch` the result of `prefilterBytes(buffer)` and skip that test when it is `undefined`. Keep `content.split(/\r?\n/u)`: a mixed-ending file is shown as written. In `canPrefilter`, replace the `buffer.includes(CR)` test with `content.includes('\r')` (pass `content` in), so an all-CRLF file gets the prefilter; delete the `CR` constant if unused.

- [ ] **Step 4: Run the search suites and the full check**

Run: `node --test __tests__/search-text.test.ts __tests__/search.test.ts __tests__/search-literal.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: exits 0.

- [ ] **Step 5: Commit and open PR B**

```bash
git add src/core/search.ts __tests__/search-text.test.ts
git commit -m "refactor(search): read each file through the Text view"
```

---

## PR C: one matching engine

### Task 5: The `MatchEngine`

**Files:**

- Modify: `src/core/matcher.ts` (add; nothing removed in this task)
- Test: `__tests__/match-engine.test.ts` (new)

**Interfaces:**

- Consumes: `planMatch`, `compileRegex`, `freeRegex`, `execMatches`, `createYielder`, `RE2_MAX_INPUT_BYTES`, the `wholeWord` lead/trail handling at `matcher.ts:423-440` (all in the same file).
- Produces:

```ts
export interface TextMatch {
  /** UTF-16 offsets into the text given to `matches`. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly groups: (string | undefined)[];
  readonly named: Record<string, string> | undefined;
}

export interface MatchEngine {
  /** Whether the needle may match a line break. */
  readonly crossesLines: boolean;
  /** False only when these bytes cannot hold a match. Give it `prefilterBytes`' result. */
  mayMatch(bytes: Buffer): boolean;
  /**
   * Every match in view text, left to right, never overlapping. Yields to the
   * event loop and throws the signal's reason on abort. Throws TOO_LARGE by
   * the 4 MiB rule; `path` labels that error.
   */
  matches(
    text: string,
    options?: { signal?: AbortSignal; path?: string },
  ): AsyncGenerator<TextMatch, void>;
  /** Releases every compiled pattern. Idempotent. */
  dispose(): void;
}

export function createMatchEngine(
  needle: string,
  flags: { isRegex: boolean; caseSensitive: boolean; wholeWord?: boolean },
): MatchEngine;
```

Decisions the tests do not fully determine:

- **`crossesLines`.** For a literal needle: `needle.includes('\n')`. For a regex it is `true` unless the source passes every test below (then `false`):
  - contains no raw `\n` or `\r` character;
  - contains no `[^`;
  - contains no `[:`;
  - does not match `INLINE_FLAGS_RE` (`src/core/search.ts:76`; move the constant into `matcher.ts`);
  - every backslash is followed by one of `d w b B S t`, or by a character that is not an ASCII letter or digit.
- **Line mode** (`crossesLines` false). A line is what search calls a line: the text split on `\n`, without the empty element after a final newline, and an empty text has no lines. Each line is matched on its own, with one trailing `\r` removed first; offsets are reported in the whole text. The regex is compiled without `m`. A line over `RE2_MAX_INPUT_BYTES` (UTF-8) that must go to the regex engine throws `FsError(ErrorCode.TOO_LARGE, <the message at src/core/search.ts:225>, path)`.
- **Text mode** (`crossesLines` true). The regex is compiled with `multiline: true` and run over the whole text. A text over `RE2_MAX_INPUT_BYTES` (UTF-8) that must go to the regex engine throws `FsError(ErrorCode.TOO_LARGE, 'File too large for a pattern that can match across lines (<n> > 4194304 bytes). Use a pattern that stays on one line, or pass caseSensitive: true with a literal searchPattern.', path)`.
- **Native literal pass.** When `planMatch(...).literal` is defined, `wholeWord` is off and `literal.needsRe2(text)` is false, matches come from `indexOf` (on `foldAsciiCase(text)` when case-insensitive) and the regex engine is not called, so neither size rule applies. A literal needle that contains `\n` is matched this way over the whole text.
- **`wholeWord`.** As today: the scanned string is `TEXT_START + line` (or `+ text`), walked with `execMatches(regex, scanned, true, ENDS_NON_WORD)`, the lead and trail groups trimmed from the reported match.
- **`mayMatch`.** For a literal plan: `literal.mayMatch(bytes)` unless `literal.needsRe2(bytes)`, then `true`. For a regex: `true`.
- **Regex compile is lazy**, on the first text that needs it, so a literal search never touches the wasm heap.

- [ ] **Step 1: Write the failing tests**

`__tests__/match-engine.test.ts`. Helper:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode } from '../src/core/errors.ts';
import { createMatchEngine } from '../src/core/matcher.ts';
import { fsErrorMatcher } from './helpers.ts';

type Flags = { isRegex?: boolean; caseSensitive?: boolean; wholeWord?: boolean };

async function spans(needle: string, text: string, flags: Flags = {}): Promise<[number, number][]> {
  const engine = createMatchEngine(needle, { isRegex: false, caseSensitive: true, ...flags });
  try {
    const out: [number, number][] = [];
    for await (const m of engine.matches(text)) out.push([m.start, m.end]);
    return out;
  } finally {
    engine.dispose();
  }
}
const crosses = (needle: string, isRegex = true): boolean => {
  const engine = createMatchEngine(needle, { isRegex, caseSensitive: true });
  try {
    return engine.crossesLines;
  } finally {
    engine.dispose();
  }
};
const re = { isRegex: true };
```

Tests, one `it` each:

```ts
// crossesLines: line-bound
for (const p of [
  'foo',
  'a.b',
  '^a$',
  '\\d+\\w*',
  'a\\.b',
  '\\bfoo\\b',
  '[abc]+',
  'a|b',
  '\\S+',
  'a\\tb',
])
  it(`${p} cannot cross a line`, () => assert.equal(crosses(p), false));

// crossesLines: Review Focus 3
for (const p of [
  'a\\nb',
  'a\\s+b',
  '[^x]',
  '\\W',
  '\\D',
  '\\x0a',
  '\\p{Cc}',
  '(?s)a.b',
  '[[:space:]]',
  'a\nb',
  '\\Afoo',
  'foo\\z',
  '\\Qa\\E',
  '\\012',
  '\\r',
])
  it(`${JSON.stringify(p)} may cross a line`, () => assert.equal(crosses(p), true));

it('a literal crosses a line only when it holds a newline', () => {
  assert.equal(crosses('a.b[^x]', false), false);
  assert.equal(crosses('a\nb', false), true);
});

it('^ and $ match once per line and not after the final newline', async () => {
  assert.deepEqual(await spans('^', 'a\nb\n', re), [
    [0, 0],
    [2, 2],
  ]);
  assert.deepEqual(await spans('$', 'a\nb\n', re), [
    [1, 1],
    [3, 3],
  ]);
});

it('an empty text has no lines', async () => {
  assert.deepEqual(await spans('^', '', re), []);
});

it('$ matches before a CR a mixed-ending file kept', async () => {
  assert.deepEqual(await spans('foo$', 'foo\r\nbar\n', re), [[0, 3]]);
});

it('a regex that can cross a line matches across it', async () => {
  assert.deepEqual(await spans('a\\s+b', 'a\nb\n', re), [[0, 3]]);
});

it('a dot never crosses a line', async () => {
  assert.deepEqual(await spans('a.b', 'a\nb\naxb', re), [[4, 7]]);
});

it('a literal with a newline matches across lines natively', async () => {
  assert.deepEqual(await spans('a\nb', 'xa\nb\n'), [[1, 4]]);
});

it('offsets are UTF-16 units after an astral character on an earlier line', async () => {
  assert.deepEqual(await spans('b+', '😀\nabb', re), [[4, 6]]);
});

it('a case-insensitive literal folds ASCII only', async () => {
  assert.deepEqual(await spans('k', 'K K', { caseSensitive: false }), [
    [0, 1],
    [2, 3],
  ]);
});

it('wholeWord skips a match inside a word', async () => {
  assert.deepEqual(await spans('cat', 'cat concat\ncat', { wholeWord: true }), [
    [0, 3],
    [11, 14],
  ]);
});

it('a line-bound regex matches a text over 4 MiB', async () => {
  const text =
    'x'
      .repeat(1024)
      .concat('\n')
      .repeat(5 * 1024) + 'needle1\n';
  assert.equal((await spans('needle\\d', text, re)).length, 1);
});

it('a regex that can cross a line refuses a text over 4 MiB', async () => {
  const text = 'x'
    .repeat(1024)
    .concat('\n')
    .repeat(5 * 1024);
  await assert.rejects(spans('a\\s+b', text, re), fsErrorMatcher(ErrorCode.TOO_LARGE));
});

it('a case-sensitive literal matches a text over 4 MiB without the regex engine', async () => {
  const text = 'x'.repeat(5 * 1024 * 1024) + 'needle';
  assert.equal((await spans('needle', text)).length, 1);
});

it('stops when the signal aborts', async () => {
  const engine = createMatchEngine('a', { isRegex: true, caseSensitive: true });
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  try {
    await assert.rejects(async () => {
      for await (const m of engine.matches('a'.repeat(10), { signal: controller.signal })) void m;
    }, /stop/);
  } finally {
    engine.dispose();
  }
});
```

Check `fsErrorMatcher`'s signature in `__tests__/helpers.ts` and adapt the two calls to it.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test __tests__/match-engine.test.ts`
Expected: FAIL, `createMatchEngine` is not exported.

- [ ] **Step 3: Implement `createMatchEngine` in `src/core/matcher.ts`**

Add it below `planMatch`. Reuse `execMatches` for every regex walk; do not read `regex.lastIndex` or `match.index` anywhere else (see the comment at `matcher.ts:226-247`). Check the signal with `createYielder` between matches and between lines.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test __tests__/match-engine.test.ts __tests__/matcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/matcher.ts __tests__/match-engine.test.ts
git commit -m "feat(matcher): one engine that matches by line or by text as the needle allows"
```

### Task 6: `replace_text` drives the engine

**Files:**

- Modify: `src/core/matcher.ts:314-328, 393-572` (delete `ReplacementMatcher`, `createRegexReplacementMatcher`, `createCaseInsensitiveLiteralMatcher`, `createCaseSensitiveLiteralMatcher`, `createReplacementMatcher`)
- Modify: `src/tools/replace-text.ts` (context, `processEntry`, `createLfVariant`, dispose)
- Test: `__tests__/match-engine.test.ts`, `__tests__/matcher.test.ts`, `__tests__/replace-text.test.ts`

**Interfaces:**

- Consumes: `MatchEngine`, `createMatchEngine` (Task 5); `ReplaceLimits`, `outputTooLarge`, `expandDollarTokens` (existing).
- Produces:

```ts
// src/core/matcher.ts
export function replaceMatches(
  engine: MatchEngine,
  text: string,
  replacement: string,
  options: {
    /** True only for isRegex: $1, $&, $<name> are expanded. */
    expand: boolean;
    signal?: AbortSignal;
    limits: ReplaceLimits;
  },
): Promise<{ content: string; matchCount: number; more: boolean }>;
```

It keeps today's rules from `createRegexReplacementMatcher.replace`: stop at `limits.maxMatches` with `more: true`; throw `outputTooLarge(limits)` once the growing result passes `limits.maxBytes`; turn a `RangeError` into `outputTooLarge(limits, error)`.

- [ ] **Step 1: Write the failing tests**

In `__tests__/match-engine.test.ts`, a `describe('replaceMatches', …)` with a helper `rep(needle, text, replacement, flags)` that builds an engine, calls `replaceMatches` with `expand: Boolean(flags.isRegex)` and `limits: { maxMatches: 1000, maxBytes: 1 << 20, path: 'p' }`, disposes, and returns `content`:

```ts
it('^ follows the lines a search reports', async () => {
  assert.equal(await rep('^', 'a\nb\n', 'x', re), 'xa\nxb\n');
  assert.equal(await rep('$', 'a\nb\n', 'x', re), 'ax\nbx\n');
  assert.equal(await rep('^', '', 'x', re), '');
});
it('expands $1 and $& for a regex only', async () => {
  assert.equal(await rep('(a)(b)', 'ab', '$2$1-$&', re), 'ba-ab');
  assert.equal(await rep('ab', 'ab', '$&', {}), '$&');
});
it("$` and $' see the whole text, not the line", async () => {
  assert.equal(await rep('b', 'a\nb\nc', "[$`|$']", re), 'a\n[a\n|\nc]\nc');
});
it('stops at maxMatches and says more', async () => {
  // call replaceMatches directly with maxMatches: 1 on 'aaa' / 'a' → { content: 'xaa', matchCount: 1, more: true }
});
```

Parity suite, same file, `describe('a search previews its replacement', …)`: for each case below, collect the engine's matches once, and assert that (a) the set of 1-based start lines equals `lines`, and (b) `replaceMatches` with replacement `'#'` changes exactly `count` places.

| needle  | flags                     | text                  | lines   | count |
| :------ | :------------------------ | :-------------------- | :------ | :---- |
| `foo$`  | regex                     | `foo\nfoo bar\nfoo\n` | 1, 3    | 2     |
| `^`     | regex                     | `a\nb\n`              | 1, 2    | 2     |
| `a\s+b` | regex                     | `a\nb\na b\n`         | 1, 3    | 2     |
| `K`     | literal, case-insensitive | `k\nK\nK\n`           | 1, 2, 3 | 3     |
| `a\nb`  | literal                   | `a\nb\na\nb`          | 1, 3    | 2     |

In `__tests__/replace-text.test.ts`, through the harness:

- `'^ does not add a line after the final newline'`: file `a\nb\n`, `searchPattern: '^'`, `isRegex: true`, `replacement: 'x'`; assert the file is `xa\nxb\n`.
- `'a line-bound regex replaces in a file over 4 MiB'`: file of 5 MiB of `x` lines ending in `needle1\n`, `searchPattern: 'needle\\d'`, `isRegex: true`, `replacement: 'done'`; assert the file ends with `done\n`. Raise the text file size limit for the test with `withEnv` if the default refuses a 5 MiB file.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test __tests__/match-engine.test.ts __tests__/replace-text.test.ts`
Expected: FAIL, `replaceMatches` is not exported; the `^` test shows `xa\nxb\nx`.

- [ ] **Step 3: Implement `replaceMatches`**

One splice loop over `engine.matches(text, { signal, path: limits.path })`, with `expandDollarTokens(replacement, m.text, m.groups, m.start, text, m.named)` when `expand`.

- [ ] **Step 4: Switch `replace_text` to the engine**

In `src/tools/replace-text.ts`: the context holds `engine: MatchEngine` and `lf?: { engine: MatchEngine; replacement: string }` in place of the matchers; `handleSearchAndReplace` builds them with `createMatchEngine(args.searchPattern, args)`; `processEntry` calls `engine.mayMatch(probe)` and `replaceMatches(engine, view.text, replacement, { expand: args.isRegex, signal, limits })`; the `finally` disposes both engines. `createLfVariant` builds its engine with `createMatchEngine`.

- [ ] **Step 5: Delete the old matchers and retarget their tests**

Delete the five names listed under Files from `src/core/matcher.ts`. In `__tests__/matcher.test.ts`, every test that called one of them now calls `createMatchEngine` plus `replaceMatches` with the same needle, flags and text and the same expected result; a test that only pinned `testBuffer` becomes a `mayMatch` test or is deleted when Task 5's tests cover it. A test whose expected value differs only by the trailing empty line or the empty file (Review Focus 4) takes the new value; list each such test in the commit body.

- [ ] **Step 6: Run, check, commit**

Run: `node --test __tests__/match-engine.test.ts __tests__/matcher.test.ts __tests__/replace-text.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: exits 0.

```bash
git add src/core/matcher.ts src/tools/replace-text.ts __tests__/match-engine.test.ts __tests__/matcher.test.ts __tests__/replace-text.test.ts
git commit -m "feat(replace_text): replace through the one matching engine"
```

### Task 7: `search_text` drives the engine

**Files:**

- Modify: `src/core/search.ts:74-98, 143-261, 263-308, 363-376`
- Modify: `src/tools/search-text.ts:198-199` (description)
- Modify: `__tests__/contract.test.ts.snapshot` (regenerated)
- Modify: `docs/adr/013-one-text-view-and-one-matching-engine.md` (status line: add the merged PR links)
- Test: `__tests__/search-text.test.ts`, `__tests__/search.test.ts`

**Interfaces:**

- Consumes: `MatchEngine`, `createMatchEngine` (Task 5); `viewText`, `prefilterBytes` (Task 1).
- Produces: `searchContent` keeps its signature and `SearchContentOutcome` its shape.

Decisions:

- `ScanContext` holds `engine: MatchEngine` in place of `regex`, `prefilter`, `literal` and `source`. `searchContent` builds it with `createMatchEngine(pattern, { isRegex, caseSensitive })` and disposes it in the `finally`.
- `scanFileBody` walks `engine.matches(content, { signal, path: entryPath })` and groups matches by the line each starts on: `line` is that 1-based line, `column` the first match's offset within the line, `matchCount` the number of matches starting on the line (stop counting at `MAX_MATCHES_PER_LINE`), `content` is `own(clipLine(line, column))` for that line alone. `before`/`after` context is unchanged.
- Split the text into lines only once a file has a match.
- Stop a file once it holds `maxResults + 1` hit lines, as today.
- `TOO_LARGE` from the engine: rethrow for a named file (`scanCtx.named`); for a walked file return `new ScanSkip({ kind: 'tooLarge', size: buffer.length })`.
- `findLineMatches`, `canPrefilter`, `BUFFER_ANCHOR_RE`, the second compile and the `checkLineSize` block are deleted; their rules live in the engine. If a search benchmark you run shows the whole-text prefilter mattered, add it inside `createMatchEngine`'s line mode, not here.
- Description at `src/tools/search-text.ts:199`: replace `searchPattern matches line by line (case-insensitive by default);` with `searchPattern is case-insensitive by default; a regex can match across a line break, and the hit is reported on the line where the match starts;`.

- [ ] **Step 1: Write the failing tests**

In `__tests__/search-text.test.ts`, through the harness:

- `'a regex match across a line break is reported on its first line'`: file `a\nb\nc\n`, `searchPattern: 'a\\s+b'`, `isRegex: true`; assert exactly one hit: `line: 1`, `column: 0`, `content: 'a'`, `matchCount: 1`.
- `'context shows the lines a cross-line match runs onto'`: same file and pattern, `context: 1`; assert the hit's `after` is `['b']`.
- `'a dot does not match across a line break'`: file `a\nb\n`, `searchPattern: 'a.b'`, `isRegex: true`; assert no hits.
- `'a named file over 4 MiB refuses a regex that can cross a line'`: 5 MiB file, `searchPattern: 'a\\s+b'`, `isRegex: true`, path names the file; assert the call fails with `TOO_LARGE`.
- `'a walked file over 4 MiB is counted too large for a regex that can cross a line'`: same file, path names its directory; assert `summary.skippedTooLarge === 1` and no hits.
- `'a line-bound regex searches a file over 4 MiB'`: same file ending in `needle1\n`, `searchPattern: 'needle\\d'`, `isRegex: true`; assert one hit.

Raise the text file size limit with `withEnv` if the default refuses a 5 MiB file.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test __tests__/search-text.test.ts`
Expected: the first two fail with no hits; the two refusal tests fail because the file is searched.

- [ ] **Step 3: Switch `scanFileBody` and `searchContent` to the engine**

Apply the decisions above.

- [ ] **Step 4: Update the description and the contract snapshot**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`
Expected: the snapshot diff shows only the `search_text` description line (and any `get-help` text that quotes it). Unset every `FS_*` variable first.

- [ ] **Step 5: Run the search suites and the full check**

Run: `node --test __tests__/search-text.test.ts __tests__/search.test.ts __tests__/search-literal.test.ts __tests__/match-engine.test.ts`
Expected: PASS. A test in `search.test.ts` that asserted a regex does not match across a line takes the new result; list it in the commit body.

Run: `npm run check`
Expected: exits 0.

- [ ] **Step 6: Commit and open PR C**

```bash
git add src/core/search.ts src/tools/search-text.ts __tests__/search-text.test.ts __tests__/search.test.ts __tests__/contract.test.ts.snapshot docs/adr/013-one-text-view-and-one-matching-engine.md
git commit -m "feat(search_text): search through the one matching engine; a regex can match across lines"
```
