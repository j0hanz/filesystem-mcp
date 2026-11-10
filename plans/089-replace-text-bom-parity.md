# Plan 089: `replace_text` matches line 1 of a BOM file and keeps the mark

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7de7398a..HEAD -- src/tools/replace-text.ts __tests__/replace-text.test.ts`
> If anything changed, compare the "Current state" excerpts against the live
> code before proceeding; on a mismatch, treat it as a STOP condition. If
> `7de7398a` is not an ancestor of HEAD (a squash merge of PR #274 did that),
> rely on the excerpt comparison alone.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (the mark stays in the file; only line-1 matching changes)
- **Depends on**: plans 084 and 088 (PR #274). Do not execute until that PR
  is merged: both the `m` flag in the replacement matcher and the BOM strip
  in `search_text` come from it.
- **Category**: bug
- **Planned at**: commit `7de7398a`, 2026-11-10 (tip of the
  `fix-improve-plans-084-088-20261110` branch)

## Why this matters

`search_text` strips a leading UTF-8 BOM before matching (plan 088,
`src/core/search.ts:192`), so `^using` matches line 1 of a BOM file and its
columns are mark-free. `replace_text` does not strip it, so the same pattern
rewrites line 2 and reports success while the preview showed line 1. Before
plan 088 both tools missed line 1, so this divergence is new. The Codex
review of PR #274 reported exactly this gap (P2, inline at
`src/core/search.ts:192`).

The mark cannot simply be dropped the way search drops it: `replace_text`
writes the file, and writing without the BOM changes the file's encoding for
every other reader. So the fix strips the mark for matching only and
re-attaches it on the way out.

## Current state

Files:

- `src/tools/replace-text.ts`: `processEntry` (line 205) locks a file,
  reads it, and runs the replacement. The edit happens in its inner
  callback, lines 226-264.
- `__tests__/replace-text.test.ts`: the tool's tests. The table-driven
  anchors test at line 1237 (`'regex anchors match at every line, like
  search_text'`) is the pattern for the new test.
- `CHANGELOG.md`: has `## [Unreleased]` with a `### Fixed` list.

`src/tools/replace-text.ts:226-264`, the callback this plan edits (excerpt
from commit `7de7398a`):

```ts
        // Same rule as edit: an all-CRLF file gets its LF literal text converted.
        const eol =
          ctx.crlf && bytes.includes('\r\n') && usesCrlf(bytes.toString('utf-8'))
            ? ctx.crlf
            : undefined;
        if (!(eol?.matcher ?? matcher).testBuffer(bytes)) return undefined;
        const before = bytes.toString('utf-8');
        const limits: ReplaceLimits = {
          maxMatches: ctx.remaining,
          maxBytes: ctx.maxBytes,
          path: entryPath,
        };
        const { content, matchCount, more } = await (eol?.matcher ?? matcher).replace(
          before,
          eol?.replacement ?? replacement,
          signal,
          limits,
        );
        // An exhausted budget leaves matches unreplaced with nothing to replace, so the cut is marked here.
        if (matchCount === 0) {
          if (more) ctx.cut = true;
          return undefined;
        }
        // Multi-byte growth is only visible in UTF-8 bytes; the unit-count bails cannot see it.
        if (Buffer.byteLength(content, 'utf8') > limits.maxBytes) throw outputTooLarge(limits);
        // Spent before the write: a failed write still uses its share, so the cap is never exceeded.
        ctx.remaining -= matchCount;
        if (more) ctx.cut = true;
        // The write is the Rewrite's next step: from here a failure is the
        // caller's edit not landing.
        write.started = true;
        return { content, result: matchCount, write: true, before };
```

Facts the edit relies on:

- `rewriteEntry` hands the callback `bytes: Buffer`, and a `ScanSkip` above
  already refuses any file that does not decode losslessly, so
  `before.charCodeAt(0) === 0xfeff` is true exactly when the bytes start
  with `EF BB BF` (three bytes). `bytes.subarray(3)` is therefore the same
  text without the mark, as a zero-copy view.
- `testBuffer(buffer)` is a cheap "could match" probe on raw bytes. It must
  see the stripped view too: on a one-line BOM file, `^using` finds no
  match in the raw bytes and the probe would skip the file the strip would
  have made matchable.
- `before` is returned to the Rewrite and is the diff base; it must keep the
  mark so the dry-run diff shows both sides with it (a common prefix
  produces no diff noise).
- The matcher (`src/core/matcher.ts`) is not touched: the strip lives at
  the call site, so the literal fast path, `wholeWord` wrap and
  `Match plan parity` tests are unaffected.
- `search_text`'s strip, for the vocabulary to match:
  `const content = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;`
  (`src/core/search.ts:192`).

Conventions to match:

- Tests: `node:test` `describe`/`it`, `node:assert/strict`, the `replace(args)`
  helper (returns `{ isError, structured, text, rows }`;
  `structured.totalMatches` is the match count), `writeTestFile(root, …)`
  and `readFile(file, 'utf-8')`.
- Comments say why, in one or two lines.
- Commit messages are Conventional Commits, for example
  `fix(replace_text): make ^ and $ line-relative like search_text`.

## Commands you will need

| Purpose       | Command                                                            | Expected on success |
| :------------ | :----------------------------------------------------------------- | :------------------- |
| Install       | `npm ci`                                                           | exit 0               |
| One test file | `node --test --test-timeout=60000 __tests__/replace-text.test.ts`  | all pass             |
| Full check    | `npm run check`                                                    | exit 0               |

No contract snapshot refresh: no tool description changes in this plan.

## Scope

**In scope** (the only files you should modify):

- `src/tools/replace-text.ts`: only the callback excerpted above.
- `__tests__/replace-text.test.ts`
- `CHANGELOG.md` (one bullet under `## [Unreleased]` → `### Fixed`)
- `plans/README.md` (your status row)

**Out of scope** (do NOT touch):

- `src/core/matcher.ts` and `src/core/search.ts`: the matcher is shared
  reasoning; the search strip already exists.
- The `searchPattern` description string and
  `__tests__/contract.test.ts.snapshot`: the advertised surface does not
  change, and search_text's description does not mention its BOM handling
  either.
- `__tests__/tools.test.ts` and any budget.
- `src/core/rewrite.ts`: undo captures the old bytes itself and needs no
  change.

## Git workflow

- Branch: `advisor/089-replace-text-bom-parity` from `main`.
- One commit for tests plus fix, for example
  `fix(replace_text): match line 1 of a BOM file and keep the mark`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing test

In `__tests__/replace-text.test.ts`, after the
`'regex anchors match at every line, like search_text'` test (line 1237),
add `it('ignores a UTF-8 BOM when matching line 1, and keeps the mark in the file', …)`
as a table test in the same style, calling `replace` with
`{ path, searchPattern, replacement: 'X', caseSensitive: true, …extra }`.
Write the BOM as the `'﻿'` escape in the string literals, never as a
raw character.

| searchPattern    | extra          | before                          | after                          | matches |
| :--------------- | :------------- | :------------------------------ | :----------------------------- | :------ |
| `^using`         | `isRegex: true`  | `'﻿using A;\nusing B;\n'`   | `'﻿X A;\nX B;\n'`          | 2       |
| `using`          | none            | `'﻿using A;\nusing B;\n'`   | `'﻿X A;\nX B;\n'`          | 2       |
| `^foo`           | `isRegex: true`  | `'﻿foo\nbar\n'`             | `'﻿X\nbar\n'`              | 1       |

Per case: write the file, run `replace`, assert `isError` is not `true`,
assert `structured.totalMatches`, and assert the file content equals the
`after` column (which is what "keeps the mark" means).

Then one dry-run case, modeled on the `dryRun: true` call at
`__tests__/replace-text.test.ts:89`: same file and args as case 1 plus
`dryRun: true`; assert `isError` is not `true`, `structured.totalMatches`
is `2`, and the file on disk still equals the `before` string.

**Verify**: `node --test --test-timeout=60000 __tests__/replace-text.test.ts`
→ the new test FAILS (case 1 reports 1 match and leaves line 1 unrewritten);
all other tests pass.

### Step 2: Strip for matching, re-attach for writing

In `src/tools/replace-text.ts`, in the callback excerpted in "Current
state", make these edits and no others:

1. Move `const before = bytes.toString('utf-8');` up to just before the
   `testBuffer` line, and insert the strip between them:

   ```ts
        const before = bytes.toString('utf-8');
        // A leading BOM is an encoding mark, not text: search_text strips it, and
        // left in, ^ misses line 1. It goes back on before the write below.
        const bom = before.charCodeAt(0) === 0xfeff;
        if (!(eol?.matcher ?? matcher).testBuffer(bom ? bytes.subarray(3) : bytes)) return undefined;
   ```

   (the old `if (!(eol?.matcher ?? matcher).testBuffer(bytes)) return undefined;`
   line is replaced by this; the `eol` block above it is untouched).

2. Pass the stripped text to `replace`:

   ```ts
        const { content, matchCount, more } = await (eol?.matcher ?? matcher).replace(
          bom ? before.slice(1) : before,
   ```

3. Re-attach before the budget check and return the re-attached text:

   ```ts
        // The mark goes back on, so the file keeps its BOM and the check sees final bytes.
        const patched = bom ? before[0] + content : content;
        // Multi-byte growth is only visible in UTF-8 bytes; the unit-count bails cannot see it.
        if (Buffer.byteLength(patched, 'utf8') > limits.maxBytes) throw outputTooLarge(limits);
   ```

   and the return becomes
   `return { content: patched, result: matchCount, write: true, before };`.

`before` is unchanged: the diff base and the undo still see the file as it
is, mark included.

**Verify**: `node --test --test-timeout=60000 __tests__/replace-text.test.ts`
→ all pass, including the new test and
`'regex anchors match at every line, like search_text'`.

### Step 3: Changelog and full check

In `CHANGELOG.md`, under `## [Unreleased]` → `### Fixed`, add one bullet in
the style of its neighbours (next to the search_text BOM bullet from plan
088):

```md
- **replace_text**: a UTF-8 byte-order mark no longer hides line 1 from `^` patterns; the mark stays in the file, matching `search_text`.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- One new test with the three live cases (regex line 1, literal line 1,
  line 1 only) plus the dry-run case: the regression (line 1 now rewrites),
  the kept behaviour (literal matching never cared about the mark, and must
  still keep it), and the file-keeps-the-mark guarantee.
- Pattern: the table test at `__tests__/replace-text.test.ts:1237`.
- Verification: `npm run check` → exit 0.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "0xfeff" src/tools/replace-text.ts` shows one match
- [ ] `grep -n "bytes.subarray(3)" src/tools/replace-text.ts` shows one match
- [ ] The new test exists and passes
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- After step 2, the new dry-run case or any existing test fails, in
  particular `'regex anchors match at every line, like search_text'` (its
  files have no BOM and must behave identically) or any `Match plan parity`
  test.
- A case's `after` content comes back without the leading `'﻿'`: that
  means a path other than the excerpted callback also transforms the text.
  Report it; do not add the mark back elsewhere.
- `testBuffer` on the `subarray` view behaves differently from the full
  buffer (case 1 still skips the file after step 2). Report; do not edit
  `src/core/matcher.ts`.

## Maintenance notes

- This closes the Codex review finding on PR #274 (inline at
  `src/core/search.ts:192`, P2). When it lands, a one-line reply on that
  thread pointing at the commit keeps the review history honest.
- The strip is byte-exact because the lossless-decode gate above the
  callback guarantees `U+FEFF` decodes from `EF BB BF`. If `rewriteEntry`
  ever changes how it hands text to tools, re-check that equivalence.
- A file that is only a BOM now behaves like an empty file with the mark
  re-attached: a `^$` pattern reports a match and rewrites identical bytes.
  That matches `replace_text`'s existing write-always semantics; no
  special case was added.
- `diff` and `edit` still see a leading BOM as text. `diff` of a BOM file
  against a stripped twin shows line 1 differing; that is a byte-true diff,
  not a defect.
