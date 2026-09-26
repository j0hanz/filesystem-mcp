# Plan 005: `edit` matches and preserves CRLF line endings

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7ee3d49f..HEAD -- src/tools/edit.ts __tests__/tools.test.ts`
> This plan runs **after plan 002**, so `src/tools/edit.ts` is expected to
> have changed: plan 002 added a `newlineRunPattern` helper. Confirm plan 002
> is `DONE` in `plans/README.md` and that `grep -n "newlineRunPattern" src/tools/edit.ts`
> shows a definition and one call. Any _other_ change to the excerpts below is
> a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: plans/002-edit-whitespace-edges.md
- **Category**: bug
- **Planned at**: commit `7ee3d49f`, 2026-09-25

## Why this matters

`edit` finds `oldText` with a plain `indexOf`. The `read` tool's head, tail
and range modes strip `\r` from every line, so a model that read part of a
CRLF file (the default on Windows checkouts, and this project's maintainer
works on Windows) sends LF-only `oldText`, which can never match the file.
The error says the text "must match the file exactly", and the model cannot
see why it does not. Reproduced: file `"one\r\ntwo\r\nthree\r\n"`, edit
`"one\ntwo"` → `FAILED — no match`. When an edit _does_ match (a single-line
`oldText`), a multi-line `newText` is inserted with LF endings, leaving the
file with mixed line endings. `patch` does not have this problem: jsdiff
converts line endings automatically when the file is consistently CRLF. This
plan applies the same rule to `edit`.

## Current state

- `src/tools/edit.ts` — `applyEdits` (line ~328) runs each edit through
  `findEditMatches` and splices `newText` in. `findEditMatches`' `ignoreWhitespace`
  branch builds a regex from `oldText` tokens; after plan 002 its interior
  newline pattern lives in `newlineRunPattern`.

`src/tools/edit.ts` — `applyEdits` today (line numbers approximate after plan 002):

```ts
function applyEdits(
  content: string,
  edits: z.infer<typeof EditSpecSchema>[],
  ignoreWhitespace: boolean,
): EditResult {
  let newContent = content;
  let appliedEdits = 0;
  const unmatchedEdits: string[] = [];

  for (const [index, edit] of edits.entries()) {
    const found = findEditMatches(newContent, edit.oldText, ignoreWhitespace);
    // ... ambiguity check, then:
    if (!found.first) {
      unmatchedEdits.push(edit.oldText);
      continue;
    }

    const first = found.first;
    newContent =
      newContent.slice(0, first.startIndex) +
      edit.newText +
      newContent.slice(first.startIndex + first.length);
    appliedEdits += 1;
  }
```

`newlineRunPattern` after plan 002 (its first line is the one this plan changes):

```ts
function newlineRunPattern(token: string, edge: { leading: boolean; trailing: boolean }): string {
  if (!edge.leading && !edge.trailing) return '[^\\S\\n]*\\n+[^\\S\\n]*';
  const count = token.split('\n').length - 1;
  const lines = `(?:[^\\S\\n]*\\n){${String(count)}}`;
  // Nothing after the final newline unless the caller wrote indentation there.
  return edge.trailing && token.endsWith('\n') ? lines : `${lines}[^\\S\\n]*`;
}
```

Why the interior pattern must change: once `oldText` is converted to CRLF, a
blank line inside it is the whitespace token `"\r\n\r\n"`. The file has
`\r\n\r\n` too, but `[^\S\n]*\n+[^\S\n]*` cannot match it, because the `\r`
between the two `\n` breaks the `\n+` run. `(?:[^\S\n]*\n)+[^\S\n]*` means
"one or more lines of optional horizontal whitespace", and `\r` counts as
horizontal whitespace to `[^\S\n]`. On LF files it matches everything the old
pattern matched, and also blank lines that contain stray spaces.

The rule to copy — jsdiff's `autoConvertLineEndings` in `patch` — only
converts when the file is **consistently** CRLF and the incoming text has no
`\r` of its own. Mixed-ending files are left alone.

These behaviors were checked with a JS-regex simulation of the patterns
(RE2 is the real engine; `compileRegex` in `src/core/search.ts`):

| file                      | oldText → newText           | mode             | result                         |
| ------------------------- | --------------------------- | ---------------- | ------------------------------ |
| `one\r\ntwo\r\nthree\r\n` | `one\ntwo` → `uno\ndos`     | literal          | `uno\r\ndos\r\nthree\r\n`      |
| `one\r\ntwo\r\nthree\r\n` | `one\r\ntwo` → `uno\r\ndos` | literal          | same (already CRLF, untouched) |
| `a\r\n\r\nb\r\n`          | `a\n\nb` → `c\n\nd`         | ignoreWhitespace | `c\r\n\r\nd\r\n`               |
| `mixed\r\nlf\n`           | `mixed\nlf` → `x`           | literal          | no match (not converted)       |
| `a\n  \nb\n`              | `a\nb` → `c`                | ignoreWhitespace | `c\n`                          |

## Commands you will need

| Purpose        | Command                                                          | Expected on success |
| -------------- | ---------------------------------------------------------------- | ------------------- |
| Install        | `npm ci`                                                         | exit 0              |
| Typecheck      | `npm run type-check:test`                                        | exit 0              |
| Filtered tests | `node --test --test-name-pattern="CRLF" __tests__/tools.test.ts` | all pass            |
| All edit tests | `node --test --test-name-pattern="edit" __tests__/tools.test.ts` | all pass            |
| Lint           | `npm run lint`                                                   | exit 0              |
| Format files   | `npx prettier --write <files>`                                   | exit 0              |
| Full gate      | `npm run check`                                                  | exit 0              |

## Scope

**In scope**:

- `src/tools/edit.ts` — `applyEdits`, the first line of `newlineRunPattern`,
  and two new small helpers.
- `__tests__/tools.test.ts`

**Out of scope**:

- `src/core/read.ts` — do not stop the read tool stripping `\r`; that is the
  documented `readLines` behavior other tools rely on.
- `src/tools/patch.ts` — already correct via jsdiff.
- `src/tools/replace-text.ts` — replaces by regex over the whole file; a
  separate question.
- Mixed-ending files: no conversion, by design.

## Git workflow

- Branch: `advisor/005-edit-crlf-files` from `main` (after plan 002 merged).
- One commit, e.g. `fix(edit): match and keep CRLF endings in CRLF files`.
  If you are an AI agent, end with a `Co-Authored-By:` trailer naming your
  model, as recent commits do.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing tests

In `__tests__/tools.test.ts`, near the other `edit` tests, add one test
`edit converts LF edit text to CRLF in a CRLF file` that covers three cases,
each on its own file under `crlf/` (use `writeFile` with the exact string —
`writeTestFile` also works, it writes the string as given):

1. Literal: file `'one\r\ntwo\r\nthree\r\n'`, edit
   `{ oldText: 'one\ntwo', newText: 'uno\ndos' }` → not `isError`; content
   `=== 'uno\r\ndos\r\nthree\r\n'`.
2. ignoreWhitespace with a blank line: file `'a\r\n\r\nb\r\n'`, edit
   `{ oldText: 'a\n\nb', newText: 'c\n\nd' }`, `ignoreWhitespace: true` →
   content `=== 'c\r\n\r\nd\r\n'`.
3. Mixed endings are left alone: file `'mixed\r\nlf\n'`, edit
   `{ oldText: 'mixed\nlf', newText: 'x' }` → `isError === true`, content
   unchanged.

**Verify**: `node --test --test-name-pattern="CRLF" __tests__/tools.test.ts` →
the new test **fails** on case 1.

### Step 2: Add the line-ending helpers

Above `applyEdits` in `src/tools/edit.ts`, add:

```ts
// A file whose every newline is CRLF gets LF-only edit text converted to match
// — the rule jsdiff's autoConvertLineEndings applies for `patch`. Range, head
// and tail reads strip `\r`, so the oldText a model sends is LF-only; text that
// already carries a `\r` is taken as written. Mixed-ending files are not
// converted: there is no one ending to convert to.
function usesCrlf(content: string): boolean {
  return content.includes('\r\n') && !/(?<!\r)\n/u.test(content);
}

function toCrlf(text: string): string {
  return text.includes('\r') ? text : text.replaceAll('\n', '\r\n');
}
```

**Verify**: `npm run type-check:test` → exit 0 (do Step 3 first if the
unused-function lint/tsc check objects).

### Step 3: Convert inside `applyEdits`

In `applyEdits`, before the loop: `const crlf = usesCrlf(content);`

Inside the loop, at the top:

```ts
const oldText = crlf ? toCrlf(edit.oldText) : edit.oldText;
const newText = crlf ? toCrlf(edit.newText) : edit.newText;
```

Then use `oldText` in the `findEditMatches(newContent, oldText, ignoreWhitespace)`
call and `newText` in the splice. **Keep** `unmatchedEdits.push(edit.oldText)`
with the caller's original text, so the error message quotes what the caller
sent. If the ambiguity error (`ambiguousEditError`) is passed the edit text,
leave it as it is — it reports line numbers, not text.

**Verify**: case 1 of the new test passes:
`node --test --test-name-pattern="CRLF" __tests__/tools.test.ts` → case 2 may
still fail; continue.

### Step 4: Let the interior newline pattern cross `\r`

In `newlineRunPattern`, change the interior return to:

```ts
if (!edge.leading && !edge.trailing) return '(?:[^\\S\\n]*\\n)+[^\\S\\n]*';
```

and extend the helper's comment by one sentence: "Each newline may carry
horizontal whitespace before it, which covers the `\r` of a CRLF file and a
blank line with stray spaces."

**Verify**:

- `node --test --test-name-pattern="CRLF" __tests__/tools.test.ts` → pass.
- `node --test --test-name-pattern="ignoreWhitespace" __tests__/tools.test.ts`
  → all pass (plan 002's edge tests and the older ones).

### Step 5: Format and full gate

`npx prettier --write src/tools/edit.ts __tests__/tools.test.ts`

**Verify**: `npm run check` → exit 0.

## Test plan

- New (one test, three cases): literal CRLF conversion; ignoreWhitespace
  across a CRLF blank line; mixed-ending file untouched.
- Existing, must stay green: all `edit` tests, including plan 002's
  `ignoreWhitespace keeps …` tests and `edit with ignoreWhitespace rejects an
oldText that matches more than once` (interior newlines stay flexible).
- Pattern: model on `edit with ignoreWhitespace applies a unique indented oldText`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `node --test --test-name-pattern="CRLF" __tests__/tools.test.ts` → pass
- [ ] `grep -n "usesCrlf\|toCrlf" src/tools/edit.ts` → 2 definitions, and uses in `applyEdits`
- [ ] `grep -nF 'n+[' src/tools/edit.ts` → no matches (the old interior pattern is gone)
- [ ] `git status` shows only `src/tools/edit.ts` and `__tests__/tools.test.ts` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 002 is not `DONE`, or `newlineRunPattern` does not exist.
- Any existing `edit` test fails after Step 4. In particular, if
  `edit with ignoreWhitespace rejects an oldText that matches more than once`
  starts reporting a different match count, report it — do not adjust the
  expected count.
- RE2 rejects the new interior pattern (a `compileRegex` error).
- A test depends on LF being inserted into a CRLF file.

## Maintenance notes

- `usesCrlf` scans the whole file once per `edit` call; files are capped by
  the text size limit (default 10 MiB), so this is linear and cheap.
- If `replace_text` gets a similar complaint (a `\n`-bearing pattern not
  matching CRLF files), reuse `usesCrlf`/`toCrlf` by moving them to
  `src/core/` — not before there is a second caller.
- Reviewer: confirm the unmatched-edit error still quotes the caller's
  original LF text, not the converted CRLF text.
