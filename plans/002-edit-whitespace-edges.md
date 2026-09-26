# Plan 002: `edit` with `ignoreWhitespace` stops swallowing blank lines and the next line's indentation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7ee3d49f..HEAD -- src/tools/edit.ts __tests__/tools.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW-MED
- **Depends on**: none (plan 005 builds on this one)
- **Category**: bug
- **Planned at**: commit `7ee3d49f`, 2026-09-25

## Why this matters

With `ignoreWhitespace: true`, `edit` turns `oldText` into a regex in which
every whitespace run containing a newline becomes `[^\S\n]*\n+[^\S\n]*` —
"any number of newlines plus the indentation around them". That is right
_between_ two pieces of text, but wrong at the **edges** of `oldText`: an
`oldText` ending in `\n` also consumes every following blank line and the next
line's indentation, and all of it is replaced by `newText`. Reproduced: file
`"def f():\n    x = 1\n\n    y = 2\n"`, edit `"    x = 1\n"` → `"    x = 3\n"`
produced `"def f():\n    x = 3\ny = 2\n"` — the blank line and `y`'s
indentation are gone, and the tool reported success. In Python or YAML that
silently changes program meaning. An `oldText` that _starts_ with `\n`
likewise collapses the blank lines before the match. After this plan an edge
newline run matches exactly the newlines the caller wrote.

## Current state

- `src/tools/edit.ts` — the `edit` tool. `findEditMatches` (line 187) finds
  where `oldText` matches; its `ignoreWhitespace` branch (lines 195-240) builds
  the flexible pattern token by token.

`src/tools/edit.ts:195-215`:

```ts
  if (ignoreWhitespace) {
    // Make whitespace flexible (tolerate indentation/spacing differences)
    // without letting it cross line boundaries: a whitespace run that contains
    // a newline keeps at least one newline, so a single-line oldText cannot
    // match across a newline and a multi-line oldText cannot collapse onto one
    // line. Horizontal whitespace stays mandatory between word characters so
    // adjacent identifiers are not merged. Built token by token: `split` on
    // whitespace puts text at even indices and whitespace runs at odd ones.
    const tokens = oldText.split(/(\s+)/u);
    let pattern = '';
    for (const [i, token] of tokens.entries()) {
      if (i % 2 === 0) {
        pattern += RegExp.escape(token);
      } else if (token.includes('\n')) {
        pattern += '[^\\S\\n]*\\n+[^\\S\\n]*';
      } else if (/\w$/.test(tokens[i - 1] ?? '') && /^\w/.test(tokens[i + 1] ?? '')) {
        pattern += '[^\\S\\n]+';
      } else {
        pattern += '[^\\S\\n]*';
      }
    }
    const regex = compileRegex(pattern, { caseSensitive: true });
```

How the tokens look: `"    x = 1\n".split(/(\s+)/u)` is
`['', '    ', 'x', ' ', '=', ' ', '1', '\n', '']`. So:

- the **leading edge** token is index `1` when `tokens[0] === ''`;
- the **trailing edge** token is index `tokens.length - 2` when the last token
  is `''`.

The regex engine is RE2 (`compileRegex` from `src/core/search.ts`); it
supports `(?:…)` and `{n}` counted repetition.

The existing test that pins leading-indentation tolerance and must keep
passing (`__tests__/tools.test.ts:609-621`):

```ts
it('edit with ignoreWhitespace applies a unique indented oldText', async () => {
  const file = await writeTestFile(tmpDir, 'ambiguous/indented.txt', 'f() {\n    run();\n}\n');
  const result = await harness.client.callTool({
    name: 'edit',
    arguments: {
      path: file,
      edits: [{ oldText: '  run();', newText: '  go();' }],
      ignoreWhitespace: true,
    },
  });
  assert.notStrictEqual(result.isError, true);
  assert.strictEqual(await readFile(file, 'utf-8'), 'f() {\n  go();\n}\n');
});
```

Also must keep passing: `edit with ignoreWhitespace rejects an oldText that
matches more than once` (line ~672) — it relies on an _interior_ newline
staying flexible (`'if (x) {\nrun();'` matches both `\n  run();` and
`\n    run();`).

Repo conventions: small module-level helper functions with a short _why_
comment block above them (see the comment style in the excerpt); Prettier
(single quotes, width 100).

## Commands you will need

| Purpose        | Command                                                                      | Expected on success |
| -------------- | ---------------------------------------------------------------------------- | ------------------- |
| Install        | `npm ci`                                                                     | exit 0              |
| Typecheck      | `npm run type-check:test`                                                    | exit 0              |
| Filtered tests | `node --test --test-name-pattern="ignoreWhitespace" __tests__/tools.test.ts` | all pass            |
| Lint           | `npm run lint`                                                               | exit 0              |
| Format files   | `npx prettier --write <files>`                                               | exit 0              |
| Full gate      | `npm run check`                                                              | exit 0              |

## Scope

**In scope**:

- `src/tools/edit.ts` — only the `ignoreWhitespace` pattern construction in
  `findEditMatches` plus one new helper function.
- `__tests__/tools.test.ts`

**Out of scope**:

- The literal (non-`ignoreWhitespace`) matching path in `findEditMatches`.
- `applyEdits`, `handleEditFile`, the overlap re-scan (`scan(afterCodePoint(...))`).
- CRLF handling — plan 005 owns it. Do not add `\r` handling here.
- `src/tools/replace-text.ts` and `src/core/search.ts`.

## Git workflow

- Branch: `advisor/002-edit-whitespace-edges` from `main`.
- One commit, Conventional Commits, e.g.
  `fix(edit): match edge newlines in ignoreWhitespace exactly`, body says why.
  If you are an AI agent, end with a `Co-Authored-By:` trailer naming your
  model, as recent commits do.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing tests first

In `__tests__/tools.test.ts`, directly after the test
`edit with ignoreWhitespace applies a unique indented oldText`, add:

1. `edit with ignoreWhitespace keeps the blank line and indentation after a trailing newline`
   - file `ambiguous/trailing-edge.py` with content `'def f():\n    x = 1\n\n    y = 2\n'`
   - edit `{ oldText: '    x = 1\n', newText: '    x = 3\n' }`, `ignoreWhitespace: true`
   - assert not `isError`, and file content `=== 'def f():\n    x = 3\n\n    y = 2\n'`
2. `edit with ignoreWhitespace keeps the blank lines before a leading newline`
   - file `ambiguous/leading-edge.txt` with content `'a\n\n\n    y = 2\n'`
   - edit `{ oldText: '\n    y = 2', newText: '\n    y = 3' }`, `ignoreWhitespace: true`
   - assert not `isError`, and content `=== 'a\n\n\n    y = 3\n'`

Use `writeTestFile(tmpDir, …)` and `harness.client.callTool` exactly as the
neighbouring test does.

**Verify**: `node --test --test-name-pattern="ignoreWhitespace keeps" __tests__/tools.test.ts`
→ both new tests **fail** (first shows `'def f():\n    x = 3\ny = 2\n'`,
second shows `'a\n    y = 3\n'`). If either passes already, STOP.

### Step 2: Add the edge-aware helper

Above `findEditMatches` in `src/tools/edit.ts`, add:

```ts
/**
 * Pattern for a whitespace run of oldText that contains a newline. Between two
 * pieces of text it stays flexible — at least one newline, as many as the file
 * has. At either edge of oldText it matches exactly the newlines written: a
 * flexible edge swallows the blank lines around the match and, at the trailing
 * edge, the next line's indentation, all of which newText then replaces.
 */
function newlineRunPattern(token: string, edge: { leading: boolean; trailing: boolean }): string {
  if (!edge.leading && !edge.trailing) return '[^\\S\\n]*\\n+[^\\S\\n]*';
  const count = token.split('\n').length - 1;
  const lines = `(?:[^\\S\\n]*\\n){${String(count)}}`;
  // Nothing after the final newline unless the caller wrote indentation there.
  return edge.trailing && token.endsWith('\n') ? lines : `${lines}[^\\S\\n]*`;
}
```

**Verify**: `npm run type-check:test` → exit 0 (the helper is unused for now;
if `noUnusedLocals` complains, do Step 3 before verifying).

### Step 3: Use it in the token loop

In the `ignoreWhitespace` branch, compute `const last = tokens.length - 1;`
right after `const tokens = …`, and replace the line
`pattern += '[^\\S\\n]*\\n+[^\\S\\n]*';` with:

```ts
pattern += newlineRunPattern(token, {
  leading: i === 1 && tokens[0] === '',
  trailing: i === last - 1 && tokens[last] === '',
});
```

Update the existing comment block above `const tokens` by one sentence:
"A newline run at either edge of oldText matches exactly, so the edit cannot
reach past the lines the caller named."

**Verify**: `node --test --test-name-pattern="ignoreWhitespace" __tests__/tools.test.ts`
→ all pass, including the 2 new tests and the existing
`applies a unique indented oldText` and `rejects an oldText that matches more than once`.

### Step 4: Format and full gate

`npx prettier --write src/tools/edit.ts __tests__/tools.test.ts`

**Verify**: `npm run check` → exit 0.

## Test plan

- New: trailing-edge newline keeps the following blank line and indentation.
- New: leading-edge newline keeps the preceding blank lines.
- Existing, must stay green: leading indentation tolerance
  (`applies a unique indented oldText`), interior newline flexibility
  (`rejects an oldText that matches more than once`), overlap counting
  (`edit counts overlapping occurrences of oldText as ambiguous`), and every
  other `edit` test.
- Pattern: model the new tests on `edit with ignoreWhitespace applies a unique indented oldText`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `node --test --test-name-pattern="ignoreWhitespace" __tests__/tools.test.ts` → all pass, count includes the 2 new tests
- [ ] `grep -n "newlineRunPattern" src/tools/edit.ts` → 2 lines (definition + one call)
- [ ] `grep -nF 'n+[' src/tools/edit.ts` → exactly 1 line, and it is inside `newlineRunPattern` (the flexible interior pattern has one owner)
- [ ] `git status` shows only `src/tools/edit.ts` and `__tests__/tools.test.ts` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Either new test passes before Step 3 (the bug is already fixed — report).
- An existing `ignoreWhitespace` test fails after Step 3 — do not "fix" the
  test; report which one and its actual vs expected output.
- RE2 rejects the `{n}` quantifier (a `compileRegex` error mentioning the
  pattern) — report the error text.
- The fix seems to need changes in `applyEdits`, the overlap re-scan, or any
  file outside scope.

## Maintenance notes

- Plan 005 (CRLF) edits the same loop: it changes the _interior_ pattern to
  `(?:[^\S\n]*\n)+[^\S\n]*` so blank lines in CRLF files match. The edge
  patterns from this plan already tolerate `\r` because `\r` is horizontal
  whitespace to `[^\S\n]`.
- Reviewer: check that an `oldText` consisting only of whitespace cannot
  reach this code — `EditSpecSchema` rejects blank `oldText` (`isBlank`), so
  index 1 is never both leading and trailing with no text between.
