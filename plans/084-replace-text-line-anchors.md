# Plan 084: `replace_text` regex anchors match at every line, as `search_text` does

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat d799cc5e..HEAD -- src/core/matcher.ts src/tools/replace-text.ts __tests__/replace-text.test.ts __tests__/contract.test.ts.snapshot`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (changes what `^` and `$` match for existing regex users)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d799cc5e`, 2026-11-10

## Why this matters

`search_text` runs its regex on one line at a time, so `^` and `$` match at
every line. `replace_text` runs the same pattern over the whole file without
the multi-line flag, so `^` matches only at the start of the file and `$` only
at its end. A user who previews `^import` with `search_text` sees N hits, then
`replace_text` rewrites one and reports success. With `wholeWord: true` a `^`
can never match at all. The module's own header promises that a preview shows
exactly what the replacement will touch, and the tool is described as "like
sed -i", where anchors are per line.

After this plan, `^` and `$` in a `replace_text` regex are line-relative, and
the tool description says so.

## Current state

Files:

- `src/core/matcher.ts`: owns pattern compilation and the replacement matcher.
- `src/tools/replace-text.ts`: the tool; holds the schema text clients see.
- `__tests__/replace-text.test.ts`: tests, driven through `runToolBodyResult`.
- `__tests__/contract.test.ts.snapshot`: snapshot of every tool description.
- `CHANGELOG.md`: has an `## [Unreleased]` section with a `### Fixed` list.

`src/core/matcher.ts:175-179`: the flag is opt-in:

```ts
export function compileRegex(
  pattern: string,
  options: { caseSensitive?: boolean; multiline?: boolean } = {},
): Regex {
  const flags = `g${options.multiline ? 'm' : ''}${options.caseSensitive ? '' : 'i'}u`;
```

`src/core/matcher.ts:551-571`: the replacement matcher compiles without it:

```ts
export function createReplacementMatcher(args: {
  searchPattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}): ReplacementMatcher {
  const plan = planMatch(args.searchPattern, {
    isRegex: args.isRegex,
    caseSensitive: args.caseSensitive,
    wholeWord: args.wholeWord,
  });
  if (!args.isRegex && !args.wholeWord && args.caseSensitive && plan.literal) {
    return createCaseSensitiveLiteralMatcher(args.searchPattern);
  }
  const regex = compileRegex(plan.source, { caseSensitive: args.caseSensitive });
```

`src/core/matcher.ts:311`: the `wholeWord` wrap. The lead group consumes one
non-word character, so a user `^` after it can only match with the `m` flag
(the lead consumes the `\n`, and `^` then matches after it):

```ts
const source = flags.wholeWord ? `([^${WORD_CLASS}])(?:${pattern})([^${WORD_CLASS}]|$)` : pattern;
```

`src/tools/replace-text.ts:64-68`: the schema text:

```ts
  searchPattern: nonBlankString('searchPattern')
    .max(10000)
    .describe(
      'Literal text or RE2 regex to search for. Can span multiple lines. When isRegex=true, lookaround and backreferences are not supported. Cannot be empty or whitespace-only.',
    ),
```

Facts measured against the installed `@adguard/re2-wasm` on 2026-11-10 (do not
re-derive them):

| Pattern, flags       | Text              | Matches |
| :------------------- | :---------------- | :------ |
| `^foo`, `gu` (today) | `foo\nfoo\nfoo\n` | 1       |
| `^foo`, `gmu`        | `foo\nfoo\nfoo\n` | 3       |
| `foo$`, `gmu`        | `foo\nfoo\nfoo\n` | 3       |
| `^foo`, `gmu`        | `foo\r\nfoo\r\n`  | 2       |
| `foo$`, `gmu`        | `foo\r\nfoo\r\n`  | 0       |
| `foo(\r?)$`, `gmu`   | `foo\r\nfoo\r\n`  | 2       |
| `\Afoo`, `gmu`       | `foo\nfoo\n`      | 1       |
| `one\ntwo`, `gmu`    | `one\ntwo\n`      | 1       |
| `a.*b`, `gmu`        | `a\nb\n`          | 0       |

So `m` changes only `^` and `$`. `.` still does not cross a newline, multi-line
patterns still work, and `\A` / `\z` still anchor to the whole file. In a CRLF
file RE2's `$` does not match before `\r`; that limit is documented, not fixed,
by this plan.

Conventions to match:

- Tests use Node's built-in runner with `describe` / `it` and
  `node:assert/strict`. In `__tests__/replace-text.test.ts`, the
  `describe('replace_text body', …)` block (line 36) defines
  `replace(args)` (line 49), which returns `{ isError, structured, text, rows }`;
  `structured.totalMatches` is the match count. Files are created with
  `writeTestFile(root, 'dir/name.txt', content)` and read back with
  `readFile(file, 'utf-8')`. Model new tests on the `wholeWord` table test at
  lines 1100-1126.
- Comments explain why, in one or two lines. No comment restating the code.
- Commit messages are Conventional Commits, for example
  `fix(core): guard diff-budget against oversized folded length`.

## Commands you will need

| Purpose          | Command                                                           | Expected on success      |
| :--------------- | :---------------------------------------------------------------- | :----------------------- |
| Install          | `npm ci`                                                          | exit 0                   |
| One test file    | `node --test --test-timeout=60000 __tests__/replace-text.test.ts` | all pass                 |
| Contract refresh | `node --test --test-update-snapshots __tests__/contract.test.ts`  | exit 0, snapshot updated |
| Format plans/src | `npx prettier --write <file>`                                     | exit 0                   |
| Full check       | `npm run check`                                                   | exit 0                   |

Run the contract refresh with no `FS_*` environment variables set.

## Scope

**In scope** (the only files you should modify):

- `src/core/matcher.ts`
- `src/tools/replace-text.ts` (the `searchPattern` description string only)
- `__tests__/replace-text.test.ts`
- `__tests__/contract.test.ts.snapshot` (regenerated, never hand-edited)
- `CHANGELOG.md`
- `plans/README.md` (your status row)

**Out of scope** (do NOT touch):

- `src/core/search.ts`: `search_text` is already per line; its prefilter
  already compiles with `multiline: true`.
- `planMatch` and the `wholeWord` wrap at `matcher.ts:311`: it works under
  `m` as written.
- CRLF handling of `$`: documenting it is in scope, changing it is not.
- Any version number (`package.json`, `server.json`, manifests).

## Git workflow

- Branch: `advisor/084-replace-text-line-anchors` from `main`.
- One commit for tests plus fix, for example
  `fix(replace_text): make ^ and $ line-relative like search_text`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing tests

In `__tests__/replace-text.test.ts`, inside `describe('replace_text body', …)`,
add one `it('regex anchors match at every line, like search_text', …)` that
runs these cases. For each: write the file, call `replace` with
`isRegex: true, caseSensitive: true`, assert `isError` is not `true`, assert
`structured.totalMatches`, and assert the file content.

| searchPattern | replacement | extra args        | before            | after        | matches |
| :------------ | :---------- | :---------------- | :---------------- | :----------- | :------ |
| `^foo`        | `X`         | none              | `foo\nfoo\nfoo\n` | `X\nX\nX\n`  | 3       |
| `foo$`        | `X`         | none              | `foo\nfoo\nfoo\n` | `X\nX\nX\n`  | 3       |
| `^foo`        | `X`         | `wholeWord: true` | `foo bar\nfoo\n`  | `X bar\nX\n` | 2       |
| `foo$`        | `X`         | `wholeWord: true` | `bar foo\nfoo\n`  | `bar X\nX\n` | 2       |
| `\\Afoo`      | `X`         | none              | `foo\nfoo\n`      | `X\nfoo\n`   | 1       |
| `^foo`        | `X`         | none              | `foo\r\nfoo\r\n`  | `X\r\nX\r\n` | 2       |
| `foo(\\r?)$`  | `X$1`       | none              | `foo\r\nfoo\r\n`  | `X\r\nX\r\n` | 2       |
| `one\\ntwo`   | `X`         | none              | `one\ntwo\n`      | `X\n`        | 1       |

(The doubled backslashes are how the pattern is written in a TypeScript string
literal.)

**Verify**: `node --test --test-timeout=60000 __tests__/replace-text.test.ts`
→ the new test FAILS (first failing case is `^foo` with 1 match instead of 3),
every other test passes.

### Step 2: Compile the replacement regex with the multi-line flag

In `src/core/matcher.ts`, in `createReplacementMatcher`, change the
`compileRegex` call to pass `multiline: true`, with a one-line comment giving
the reason:

```ts
// `m`, so ^ and $ are line-relative as in search_text, which matches line by line.
const regex = compileRegex(plan.source, { caseSensitive: args.caseSensitive, multiline: true });
```

Change nothing else in the file.

**Verify**: `node --test --test-timeout=60000 __tests__/replace-text.test.ts`
→ all pass, including the new test.

### Step 3: Say so in the schema text

In `src/tools/replace-text.ts`, replace the `searchPattern` description string
with:

```ts
      'Literal text or RE2 regex to search for. Can span multiple lines. When isRegex=true, ^ and $ match at every line (use \\A and \\z for the whole file; in CRLF files write (\\r?)$), and lookaround and backreferences are not supported. Cannot be empty or whitespace-only.',
```

Then regenerate the contract snapshot:
`node --test --test-update-snapshots __tests__/contract.test.ts`

**Verify**: `git diff --stat __tests__/contract.test.ts.snapshot` → exactly one
file, and `git diff __tests__/contract.test.ts.snapshot` shows only the
`searchPattern` description of `replace_text` changed.

### Step 4: Changelog

In `CHANGELOG.md`, under `## [Unreleased]` → `### Fixed`, add one bullet in
the style of its neighbours:

```md
- **replace_text**: `^` and `$` in a regex now match at every line, as `search_text` previews them; before, they matched only the start and end of the file. Use `\A` and `\z` to anchor to the whole file.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- One new test in `__tests__/replace-text.test.ts` with the eight cases of
  step 1. It covers the regression (`^` / `$` per line), `wholeWord` with
  anchors, the whole-file escape hatch (`\A`), CRLF, and a multi-line pattern
  that must keep working.
- Pattern to follow: the `wholeWord` `cases` helper at
  `__tests__/replace-text.test.ts:1100-1126`.
- Verification: `npm run check` → exit 0.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "multiline: true" src/core/matcher.ts` shows one match inside `createReplacementMatcher`
- [ ] The new test `regex anchors match at every line, like search_text` exists and passes
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- After step 2, any case of the step 1 table fails. In particular, if
  `wholeWord` with `foo$` reports 1 match instead of 2, do NOT edit
  `planMatch`, `execMatches` or `ENDS_NON_WORD`; report the case and its
  actual count.
- Any pre-existing test in `__tests__/replace-text.test.ts` or the
  `Match plan parity` block starts failing after step 2.
- The contract snapshot diff touches anything besides the `replace_text`
  `searchPattern` description.

## Maintenance notes

- This is a behaviour change for anyone who relied on `^` meaning "start of
  file" in `replace_text`. The changelog entry names the replacement (`\A`).
  The release type is the maintainer's call.
- `$` in CRLF files still does not match before `\r` (RE2 semantics). If
  clients trip on it, the fix is to rewrite a trailing `$` to `(?:\r?$)`-style
  handling inside the matcher, with the `\r` kept out of the replaced span.
- Reviewers: check that the snapshot diff is one string, and that no literal
  (non-regex) path changed behaviour: escaped literals contain no anchors.
