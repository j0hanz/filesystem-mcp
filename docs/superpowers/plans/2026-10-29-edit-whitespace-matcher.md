# Edit whitespace matcher implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `edit` with `ignoreWhitespace: true` applies a large `oldText` and
edits a file of any size up to the text cap, instead of aborting with
re2-wasm's `Aborted(Cannot enlarge memory arrays ...)` (issue #157).

**Architecture:** `findEditMatches` (`src/tools/edit.ts:177`) compiles the
whole `oldText` into one RE2 pattern and runs it over the whole file. Both
share re2-wasm's fixed 16 MB heap. Measured on main: the abort starts at
3,000 lines of `oldText` (about 90 KB; 2,000 lines work) and, separately, at
a 9 MB file with a one-line `oldText` (5 MB works; the default cap is
10 MiB). The pattern is only literal tokens with no whitespace in them,
separated by whitespace gaps, and every gap is followed by a literal or the
end. So a greedy walk from each start is exact and needs no regex. A new
pure module `src/tools/flex-match.ts` does that walk in JS. `edit.ts`
drops its RE2 branch and calls the new module.

**Tech Stack:** TypeScript (Node ESM, `.ts` imports), Node built-in test
runner, `re2-wasm` (kept for other tools; used here only as the test oracle).

**Spec:** GitHub issue #157 plus the reproduction recorded in this header.
No separate design doc.

## Global Constraints

- No change to the advertised MCP surface: `__tests__/contract.test.ts` snapshot stays unchanged.
- Match spans must equal the current RE2 pattern's spans exactly (start, length, UTF-16 units).
- Horizontal whitespace means JS `\s` minus `\n`. re2-wasm with the `u` flag already accepts space, tab, `\r`, `\f`, `\v`, NBSP, U+3000 and U+2028 there; this was checked on main.
- No new dependency.
- Never hand-edit versions in `package.json`, `server.json` or the plugin manifests.
- Branch from `main` as `fix/edit-whitespace-oom`; commits use Conventional Commits.

## Review Focus

1. Unicode whitespace in the file (NBSP, U+3000, U+2028) between tokens: it must count as a gap, as RE2 counts it today.
2. Astral characters (emoji) before or inside the match: offsets must be UTF-16, never off by one per surrogate pair.
3. CRLF files: `\r` before each `\n` must be absorbed by gaps, including the exact-count edge gaps.
4. Repetitive content (`'a\n'` repeated) with a long `oldText` that almost matches: the walk is `O(hits of first literal × len(oldText))` and must stay fast at realistic sizes.
5. A search resumed at `from` (non-overlapping resume and the overlap re-scan): the walk must not reach back before `from`, the way RE2 on `content.slice(from)` cannot.

Items 1, 2, 3 and 5 are pinned by the differential test in Task 1. Item 4 is pinned by a timing test in Task 2.

---

### Task 1: Regex-free flexible matcher

**Files:**

- Create: `src/tools/flex-match.ts`
- Test: `__tests__/flex-match.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces:

```ts
export interface FlexMatch {
  /** UTF-16 offset into the full content. */
  start: number;
  /** UTF-16 length; always > 0, since oldText holds at least one non-whitespace character. */
  length: number;
}

/**
 * Leftmost non-overlapping matches of oldText's whitespace-flexible form,
 * scanning content from `from` (default 0). Spans equal those of the
 * pattern `findEditMatches` built before #157 run over `content.slice(from)`,
 * shifted by `from`. Lazy, so a caller can stop after a few.
 */
export function flexMatches(content: string, oldText: string, from?: number): Generator<FlexMatch>;
```

- [ ] **Step 1: Write the failing differential test**

Create `__tests__/flex-match.test.ts`. It holds an oracle: the old
pattern builder copied verbatim from `src/tools/edit.ts:162-216`
(`newlineRunPattern` plus the token loop), compiled with `compileRegex(pattern, { caseSensitive: true })`
and run with `execMatches` from `src/core/search.ts`. It calls `freeRegex` in a `finally`.
`oracle(content, oldText, from)` returns `{ start: from + m.start, length: m.text.length }[]`.
It runs over `content.slice(from)`, skips zero-length matches, and stops after 6 matches.

Generate cases with a seeded LCG (no `Math.random`), so failures reproduce:

- Alphabet: `'a'`, `'b'`, `'ab'`, `'('`, `';'`, `' '`, `'  '`, `'\t'`, `'\n'`, `'\n\n'`, `' \n'`, `'\r\n'`, `' '`, `'　'`, `' '`, `'😀'`.
- 3,000 cases. content is 0–40 pieces and oldText is 1–8 pieces. Skip an oldText with no `\S`.
- For each case, `from` ranges over `0`, `1`, and the first oracle match's end when there is one.

```ts
it('flexMatches equals the RE2 flexible pattern on generated cases', () => {
  for (const { content, oldText, from } of generatedCases(3000)) {
    const got = [...take(flexMatches(content, oldText, from), 6)];
    assert.deepStrictEqual(
      got,
      oracle(content, oldText, from),
      JSON.stringify({ content, oldText, from }),
    );
  }
});

it('flexMatches applies a 5,000-line oldText', () => {
  const body =
    Array.from({ length: 5000 }, (_, i) => `    line_${i} = value(${i});`).join('\n') + '\n';
  assert.deepStrictEqual(
    [...flexMatches(body, body.replaceAll('    ', '  '))],
    [{ start: 0, length: body.length }],
  );
});
```

`take(gen, n)` is a small local helper in the test file.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --test-name-pattern="flexMatches"`
Expected: FAIL, cannot resolve `../src/tools/flex-match.ts`.

- [ ] **Step 3: Implement `flexMatches` in `src/tools/flex-match.ts`**

Move the explanatory comment from `edit.ts:191-199` and the doc comment of
`newlineRunPattern` (`edit.ts:153-161`) here. They describe the rules this
module now owns.

Build the spec from `oldText.split(/(\s+)/u)`. Even indices are literals and odd indices are gaps, using the same rules as today:

| Gap token     | Position              | Rule                                                               |
| :------------ | :-------------------- | :----------------------------------------------------------------- |
| contains `\n` | interior              | ≥1 `\n`; consume the whole `\s` run                                |
| contains `\n` | leading edge          | exactly `count` × (H* `\n`), then H*                               |
| contains `\n` | trailing edge         | exactly `count` × (H* `\n`); then H* unless the token ends in `\n` |
| no `\n`       | between `\w` and `\w` | H+                                                                 |
| no `\n`       | otherwise             | H*                                                                 |

`count` is `token.split('\n').length - 1`. H is `\s` minus `\n`. Drop the empty
literals at index 0 and `last`; they mark that the leading or trailing gap is an edge.

The walk is not fixed by the signature, so here is the algorithm:

```text
L0 = first literal
p  = content.indexOf(L0, from)
while p != -1:
  start = p
  if lead gap:  walk back from p over H*; for count times require '\n' and
                walk back over H* before it; never below `from`; fail -> next p
  pos = p + L0.length
  for each (gap, literal) after L0:
    interior nl gap: consume every \s; fail unless ≥1 was '\n'
    H* / H+ gap:     consume every H; H+ fails on zero
    literal:         fail unless content.startsWith(literal, pos); pos += len
  if trail gap: H* consumes all H; exact-count consumes count × (H* '\n'),
                then all H unless the token ends in '\n'
  on success: yield { start, length: pos - start }; p = indexOf(L0, pos)
  on failure: p = indexOf(L0, p + 1)
```

Greedy is exact because the next literal always starts with a non-`\s`
character. Leftmost order holds because a backward walk crosses only
whitespace, and each `L0` occurrence starts with non-whitespace.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="flexMatches"`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/flex-match.ts __tests__/flex-match.test.ts
git commit -m "feat(edit): add a regex-free whitespace-flexible matcher"
```

### Task 2: `edit` uses the matcher; RE2 leaves the path

**Files:**

- Modify: `src/tools/edit.ts:19-20` (imports), `:153-168` (delete `newlineRunPattern`), `:190-245` (the `ignoreWhitespace` branch)
- Test: `__tests__/tools.test.ts`, next to `edit with ignoreWhitespace re-indents a 2000-line block well inside the deadline` (line 1407)

**Interfaces:**

- Consumes: `flexMatches(content, oldText, from?)` from Task 1.
- Produces: no new export. `findEditMatches` keeps its signature and its `EditMatches` result.

- [ ] **Step 1: Write the failing regression tests**

Add these to `__tests__/tools.test.ts`, using `harness`, `tmpDir` and `writeTestFile` as the neighboring tests do:

```ts
it('edit with ignoreWhitespace applies a 5,000-line oldText (#157)', async () => {
  const body =
    Array.from({ length: 5_000 }, (_, i) => `    v${String(i)} = ${String(i)};`).join('\n') + '\n';
  const file = await writeTestFile(tmpDir, 'flex/big-old.js', body);
  const result = await harness.client.callTool({
    name: 'edit',
    arguments: {
      path: file,
      edits: [{ oldText: body.replaceAll('    ', '  '), newText: 'done();\n' }],
      ignoreWhitespace: true,
    },
  });
  assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
  assert.strictEqual(await readFile(file, 'utf-8'), 'done();\n');
});

it('edit with ignoreWhitespace edits a 9 MB file (#157)', async () => {
  const filler = '    filler_line_with_some_text = 12345;\n';
  const file = await writeTestFile(
    tmpDir,
    'flex/big-file.txt',
    `${filler.repeat(240_000)}    unique_marker();\n`,
  );
  const result = await harness.client.callTool({
    name: 'edit',
    arguments: {
      path: file,
      edits: [{ oldText: 'unique_marker();', newText: 'done();' }],
      ignoreWhitespace: true,
    },
  });
  assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
  assert.ok((await readFile(file, 'utf-8')).endsWith('    done();\n'));
});

it('edit with ignoreWhitespace stays fast on repetitive near-matches', async () => {
  const file = await writeTestFile(tmpDir, 'flex/repetitive.txt', 'a\n'.repeat(200_000));
  const started = Date.now();
  const result = await harness.client.callTool({
    name: 'edit',
    arguments: {
      path: file,
      edits: [{ oldText: `${'a\n'.repeat(200)}b`, newText: 'x' }],
      ignoreWhitespace: true,
      dryRun: true,
    },
  });
  const elapsed = Date.now() - started;
  // A dry run reports an unmatched edit without failing (edit.ts:390).
  assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
  assert.ok(elapsed < 2000, `took ${String(elapsed)} ms`);
});
```

The repetitive case is about 200,000 candidate lines times 200 lines each,
so roughly 4e7 character checks. Expect well under 2 s.

- [ ] **Step 2: Run them to verify the first two fail**

Run: `npm test -- --test-name-pattern="#157"`
Expected: FAIL, both tests. The result text contains `Aborted(Cannot enlarge memory arrays`.

- [ ] **Step 3: Replace the `ignoreWhitespace` branch of `findEditMatches`**

Replace `edit.ts:190-245` with a `scan(from)` that iterates
`flexMatches(content, oldText, from)`. Keep `add`, the early stop when `add`
returns true, and the stop after one match when `from > 0`. Keep the
overlap re-scan from `afterCodePoint(content, startIndex + lead)` and its
comment. Delete the `try/finally`/`freeRegex`, the `execMatches`
offset comment and `newlineRunPattern`. Remove the
`compileRegex, execMatches, freeRegex` import. Remove `escapeRegExp` from
the `../core/util.ts` import if nothing else in `edit.ts` uses it.
`toCrlf` and `usesCrlf` stay.

- [ ] **Step 4: Run the edit tests to verify they pass**

Run: `npm test -- --test-name-pattern="edit"`
Expected: PASS. That covers the three new tests and every existing `edit with ignoreWhitespace …` test, unmodified (`tools.test.ts:1305-1520`).

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: exits 0, and `contract.test.ts` passes with no snapshot diff.

- [ ] **Step 6: Commit**

```bash
git add src/tools/edit.ts __tests__/tools.test.ts
git commit -m "fix(edit): match ignoreWhitespace without one giant RE2 pattern" -m "Closes #157."
```

## Execution notes

- The matcher landed in `src/tools/edit.ts` as an exported `flexMatches`,
  with its tests in `__tests__/tools.test.ts`, not in new files: it is an
  `edit` internal, not a tool.
- The whitespace constraint above was wrong. re2-wasm's `[^\S\n]` matches
  only ASCII `[ \t\f\r]` (the check that said otherwise had its escapes
  mangled by the shell). The matcher uses JS `\s` minus `\n`, the class
  oldText is split on, so an NBSP oldText now matches the same NBSP in the
  file; on main it did not. The oracle uses the same widened class.
- The walk is `O(candidates × oldText)`: 200,000 repetitive lines with a
  1,000-line near-match take about 3 s. The timing guard uses a 100-line
  prefix.
