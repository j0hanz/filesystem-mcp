# Text View Owns the Mark Rule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Mark rule (when a leading U+FEFF in client text is the file's mark) out of `edit` and `patch` into the Text view, so both tools follow one rule.

**Architecture:** `TextView` gains `locate`, which runs a caller's attempt as typed and, in a marked file after a miss, once more with the leading U+FEFF removed, keeping that only when it lands at the file start; and `place`, which takes the mark's U+FEFF off text placed at the file start. `edit` and `patch` pass their match or apply step as the attempt and stop calling `unmark`, which leaves the interface. `patch` changes in one case: it now tries line 1 as typed first.

**Tech Stack:** TypeScript (Node, ESM `.ts` imports), Node built-in test runner, `diff` (jsdiff) for `applyPatch`.

**Spec:** decisions from the 2026-11-12 architecture review grilling (candidate "Text view owns where the mark lands"); `GLOSSARY.md` term **Mark** (already in the working tree); `docs/adr/013-one-text-view-and-one-matching-engine.md`, whose 2026-11-10 accept/unmark addendum this supersedes.

## Global Constraints

- One rule for both tools, edit's: try client text as typed; only on a miss, in a marked file, retry with the leading U+FEFF removed, kept only if it lands at the file start; text placed at the file start of a marked file loses its leading U+FEFF.
- When both tries miss, the client sees the typed attempt's failure (edit: `unmatchedEdits` holds `edit.oldText`; patch: the typed attempt's `FsError`).
- `patch` still drops a leading U+FEFF of the diff text itself, for every file (`src/tools/patch.ts:100`); that is the diff's own mark, not the Mark rule.
- No change to the advertised MCP surface: `__tests__/contract.test.ts` snapshot must not change (patch's `diff` description already says "a leading BOM is ignored").
- Never hand-edit versions in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`.
- Gate: `npm run check` green at the end of every task. After code changes run `graphify update .`.

## Review Focus

1. **A context line on file line 1 keeps its U+FEFF content:** in a file holding a mark and then a U+FEFF as text, a typed context line must not lose that U+FEFF to `place`; only `+` lines take `place`. Test in Task 3 (`a typed context line 1 keeps a second U+FEFF`).
2. **Typed U+FEFF that is content, in a double-mark file:** `patch` with line 1 typed as the view shows it (one U+FEFF) now applies; before, it was stripped and failed. Test in Task 3 (`line 1 typed as the view shows it applies to a double-mark file`).
3. **Retry error masking:** when the stripped retry also fails, the client sees the typed failure, not the retry's. Test in Task 1 (`rethrows the typed failure when the retry also fails`) and Task 3 (`a mismatched marked diff reports the typed line`).
4. **A file with no mark never retries:** a typed miss in an unmarked file runs the attempt once. Test in Task 1 (`an unmarked file runs the attempt once`).
5. **Hunk 1 not at line 1:** a marked file whose first hunk starts past line 1 gets no stripping and no placement; a leading U+FEFF on a later `+` line stays. Covered by existing `__tests__/patch.test.ts:189-201`.

---

## File Structure

- `src/core/text-view.ts` — `TextView` gains `locate` and `place`; loses `unmark` in Task 3.
- `src/tools/edit.ts:563-579` — the typed-then-bare block becomes one `view.locate` call.
- `src/tools/patch.ts:98-104, 223-266` — `patchContent` takes the needle and placement transforms; the transform runs it through `view.locate`.
- `__tests__/text-view.test.ts` — the rule's tests.
- `__tests__/patch.test.ts` — two new behaviour tests; existing BOM tests stay as wiring pins.
- `docs/adr/013-one-text-view-and-one-matching-engine.md` — new dated addendum.
- `CHANGELOG.md`, `GLOSSARY.md`.

---

### Task 1: `TextView.locate` and `TextView.place`

**Files:**

- Modify: `src/core/text-view.ts:7-48`
- Test: `__tests__/text-view.test.ts` (after the `unmark` test at `:61`)

**Interfaces:**

- Produces, on `TextView`:

```ts
/** Where an attempt landed: `start` 0 is the file start. */
export interface Landing<T> { value: T; start: number }

/**
 * The Mark rule (GLOSSARY). Runs `attempt` with client text as typed
 * (`needle` is the identity). In a marked file, when that misses (returns
 * undefined or throws), runs it once more with `needle` removing a leading
 * U+FEFF, and keeps that landing only when `start === 0`. Otherwise the typed
 * outcome stands: its landing, undefined, or its thrown error.
 */
locate<T>(
  attempt: (needle: (text: string) => string) => Landing<T> | undefined | Promise<Landing<T> | undefined>,
): Promise<Landing<T> | undefined>;

/** `text` as placed at `start`: at the start of a marked file, without its leading U+FEFF. */
place(text: string, start: number): string;
```

`Landing` is exported from `src/core/text-view.ts`.

- [ ] **Step 1: Write the failing tests**

In `describe('Text view')`, with `BOM = '﻿'` as the file already defines:

```ts
it('locate keeps a typed landing and never retries', async () => {
  const calls: string[] = [];
  const hit = await viewText(`${BOM}a\n`).locate((needle) => {
    calls.push(needle(`${BOM}x`));
    return { value: 'typed', start: 4 };
  });
  assert.deepEqual(hit, { value: 'typed', start: 4 });
  assert.deepEqual(calls, [`${BOM}x`]);
});
it('locate retries stripped in a marked file and keeps a landing at the start', async () => {
  const hit = await viewText(`${BOM}a\n`).locate((needle) =>
    needle(`${BOM}a`) === 'a' ? { value: 'bare', start: 0 } : undefined,
  );
  assert.deepEqual(hit, { value: 'bare', start: 0 });
});
it('locate drops a stripped landing past the start', async () => {
  const hit = await viewText(`${BOM}a\nx\n`).locate((needle) =>
    needle(`${BOM}x`) === 'x' ? { value: 'bare', start: 2 } : undefined,
  );
  assert.equal(hit, undefined);
});
it('an unmarked file runs the attempt once', async () => {
  let calls = 0;
  const hit = await viewText('a\n').locate(() => {
    calls += 1;
    return undefined;
  });
  assert.equal(hit, undefined);
  assert.equal(calls, 1);
});
it('locate retries after a typed throw and keeps a landing at the start', async () => {
  const hit = await viewText(`${BOM}a\n`).locate((needle) => {
    if (needle(BOM) === BOM) throw new Error('typed');
    return { value: 'bare', start: 0 };
  });
  assert.deepEqual(hit, { value: 'bare', start: 0 });
});
it('rethrows the typed failure when the retry also fails', async () => {
  const typed = new Error('typed');
  await assert.rejects(
    viewText(`${BOM}a\n`).locate((needle) => {
      throw needle(BOM) === BOM ? typed : new Error('retry');
    }),
    (e) => e === typed,
  );
});
it('place drops a leading U+FEFF only at the start of a marked file', () => {
  const marked = viewText(`${BOM}a\n`);
  assert.equal(marked.place(`${BOM}b`, 0), 'b');
  assert.equal(marked.place(`${BOM}${BOM}b`, 0), `${BOM}b`);
  assert.equal(marked.place(`${BOM}b`, 3), `${BOM}b`);
  assert.equal(viewText('a\n').place(`${BOM}b`, 0), `${BOM}b`);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern="locate|place|unmarked file runs|rethrows the typed"`
Expected: FAIL, `locate is not a function` / `place is not a function`.

- [ ] **Step 3: Implement `locate` and `place` in `src/core/text-view.ts`**

`place` is `start === 0 ? unmark(text) : text` over the existing `unmark` body. `locate` awaits the typed attempt inside try/catch; returns its landing if defined; if the file has no mark, returns undefined or rethrows; otherwise awaits the stripped attempt in its own try/catch and returns its landing only when `start === 0`, else rethrows the typed error if there was one, else returns undefined.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- --test-name-pattern="Text view"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/text-view.ts __tests__/text-view.test.ts
git commit -m "feat(text-view): own the Mark rule with locate and place"
```

### Task 2: `edit` goes through `locate` and `place`

**Files:**

- Modify: `src/tools/edit.ts:563-579`
- Test: `__tests__/edit.test.ts:491-535` (existing; unchanged)

**Interfaces:**

- Consumes: `TextView.locate`, `TextView.place`, `Landing` from Task 1.

- [ ] **Step 1: Record the edit BOM tests green before the change**

Run: `npm test -- --test-name-pattern="BOM|mark"`
Expected: PASS; note the count.

- [ ] **Step 2: Replace the block**

The attempt calls `findEditMatches(newContent, needle(typed), ignoreWhitespace, tick, signal)` and returns `{ value: { found, oldText: needle(typed) }, start: found.first.startIndex }` when `found.count > 0`, else undefined. On a landing, `newText = view.place(view.accept(edit.newText), landing.start)`. On no landing, `found` is the typed miss (count 0) and the existing unmatched path runs. The ambiguity check (`found.count > 1`) and everything after `:580` stay. Replace the two comments at `:563-564` and `:577-578` with one: `// The Mark rule (GLOSSARY): the Text view decides when a leading U+FEFF is the file's mark.`

- [ ] **Step 3: Run the edit tests**

Run: `npm test -- --test-name-pattern="BOM|mark|edit"`
Expected: PASS, BOM/mark count equal to Step 1.

- [ ] **Step 4: Commit**

```bash
git add src/tools/edit.ts
git commit -m "refactor(edit): place oldText and newText through the Mark rule"
```

### Task 3: `patch` goes through `locate` and `place`; `unmark` leaves the interface

**Files:**

- Modify: `src/tools/patch.ts:98-104` (transform), `:223-266` (`patchContent`)
- Modify: `src/core/text-view.ts` (drop `unmark` from the interface and object; `place` keeps its body)
- Modify: `__tests__/text-view.test.ts:61-67` (delete the `unmark` test; `place` covers it)
- Test: `__tests__/patch.test.ts` (after `:201`)
- Modify: `docs/adr/013-one-text-view-and-one-matching-engine.md`, `CHANGELOG.md`, `GLOSSARY.md`

**Interfaces:**

- Consumes: `TextView.locate`, `TextView.place`, `Landing` from Task 1.
- Produces: `patchContent(args, content, needle: (text: string) => string, place: (text: string) => string)`. `needle` applies to context and `-` lines on old line 1; `place` applies to `+` lines on new line 1; both only when hunk 1's `oldStart <= 1`.

- [ ] **Step 1: Write the failing tests**

```ts
it('line 1 typed as the view shows it applies to a double-mark file', async () => {
  const f = join(root, 'patch_bom_twice_typed.txt');
  await writeFile(f, '﻿﻿a\nb\n');
  await patch({ path: f, diff: '--- a\n+++ a\n@@ -1,2 +1,2 @@\n ﻿a\n-b\n+c\n' });
  assert.strictEqual(await readFile(f, 'utf-8'), '﻿﻿a\nc\n');
});
it('a typed context line 1 keeps a second U+FEFF', async () => {
  const f = join(root, 'patch_bom_twice_context.txt');
  await writeFile(f, '﻿﻿a\nb\n');
  await patch({ path: f, diff: '--- a\n+++ a\n@@ -1,2 +1,3 @@\n ﻿a\n+n\n b\n' });
  assert.strictEqual(await readFile(f, 'utf-8'), '﻿﻿a\nn\nb\n');
});
it('a mismatched marked diff reports the typed line', async () => {
  const f = join(root, 'patch_bom_mismatch.txt');
  await writeFile(f, '﻿a\nb\n');
  await assert.rejects(
    patch({ path: f, diff: '--- a\n+++ a\n@@ -1,2 +1,2 @@\n-﻿q\n+z\n b\n' }),
    (e: unknown) => e instanceof Error && e.message.includes('expected "﻿q"'),
  );
});
```

Use the file's existing `patch` helper and assertion style; if it returns an error result instead of throwing, assert on that result's message the same way.

- [ ] **Step 2: Run to verify the first fails**

Run: `npm test -- --test-name-pattern="double-mark|second U\+FEFF|reports the typed line"`
Expected: all three FAIL. The first two with `patch did not apply cleanly` (today line 1 is always stripped, so `﻿a` becomes `a` and misses the view's `﻿a`); the third because today's message shows the stripped `expected "q"`.

- [ ] **Step 3: Rewire `patch`**

In `patchContent`, replace the `unmark` parameter with `needle` and `place` per the Interfaces block; old-line-1 context and `-` lines take `needle`, new-line-1 `+` lines take `place`. In the transform at `:98-104`, keep the diff's own U+FEFF drop and `view.accept`, then:

```ts
const landing = await view.locate((needle) => {
  const result = patchContent({ ...args, diff }, content, needle, (text) => view.place(text, 0));
  return { value: result, start: result.atStart ? 0 : 1 };
});
```

`patchContent` adds `atStart: boolean` (hunk 1 `oldStart <= 1`) to its return. `landing` is always defined when no error was thrown, because the attempt never returns undefined; read it as `landing!.value` behind an `assert`-free guard (`if (!landing) throw new Error('unreachable')`) only if the type checker needs it.

- [ ] **Step 4: Drop `unmark`**

Remove `unmark` from `TextView` and `viewText`; inline its one-line body into `place`. Delete the `unmark` test at `__tests__/text-view.test.ts:61-67`.

- [ ] **Step 5: Run the patch, edit and view suites**

Run: `npm test -- --test-name-pattern="patch|edit|Text view|BOM|mark"`
Expected: PASS, including `__tests__/patch.test.ts:154-201` unchanged.

- [ ] **Step 6: Record the decision**

- `docs/adr/013-one-text-view-and-one-matching-engine.md`: append `## Addendum: the Text view owns the Mark rule (2026-11-12)`. It supersedes the 2026-11-10 accept/unmark addendum: `locate` and `place` decide when a leading U+FEFF is the mark; `edit` and `patch` hand in their attempt and the start it lands on; `unmark` leaves the interface; `patch` now tries line 1 as typed first, like `edit`; when both tries miss, the typed failure is reported. Reason: six fix commits on this rule in one week, two after the earlier addendum.
- `CHANGELOG.md`: add `## [Unreleased]` above `## [2.20.0]` with `### Changed` and one bullet: `- **patch**: in a file that starts with a byte-order mark, line 1 of a diff is now matched as typed first and only then with its leading U+FEFF removed, as \`edit\` does; a diff that types a U+FEFF after the mark as text now applies.`
- `GLOSSARY.md`: the **Mark** term and the Text view edit are already in the working tree.

- [ ] **Step 7: Full check and graph**

Run: `npm run check`
Expected: exit 0, no contract snapshot diff.
Run: `graphify update .`

- [ ] **Step 8: Commit**

```bash
git add src/tools/patch.ts src/core/text-view.ts __tests__/text-view.test.ts __tests__/patch.test.ts docs/adr/013-one-text-view-and-one-matching-engine.md CHANGELOG.md GLOSSARY.md
git commit -m "refactor(patch): match line 1 through the Mark rule, typed first"
```
