# Plan 088: Three small text-tool fixes: BOM in `search_text`, no-op `patch`, busy `diff`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat d799cc5e..HEAD -- src/core/search.ts src/tools/patch.ts src/tools/diff.ts __tests__/search-text.test.ts __tests__/patch.test.ts`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none. Land after plan 084 if both are open, to keep the
  diffs in the matching code apart.
- **Category**: bug
- **Planned at**: commit `d799cc5e`, 2026-11-10

## Why this matters

Three independent defects, each a few lines. Each part below has its own
commit, so one can be dropped without the others.

1. **BOM.** A UTF-8 file that starts with a byte-order mark (common in
   Windows and .NET projects) keeps the mark on line 1 when `search_text`
   decodes it. A regex `^using` misses line 1, and a literal hit on line 1
   reports a column one too high.
2. **No-op patch.** `patch` rewrites the file even when the patch changes
   nothing (a hunk of context lines only). That bumps the modified time,
   fires file-watch notifications, and records an undo entry for a change
   that did not happen.
3. **Busy diff.** `diff` reports "the files differ in too many lines" for
   three different causes: a real timeout, a full diff queue, and a worker
   that failed to start. For the last two, the advice to compare smaller
   sections is wrong; a retry is what helps.

## Current state

### Part 1: `src/core/search.ts`

`scanFileBody`, lines 188-200:

```ts
const literal = scanCtx.literal?.needsRe2(buffer) ? undefined : scanCtx.literal;
if (literal && !literal.mayMatch(buffer)) return { matches: [] };
const content = buffer.toString('utf-8');
// RE2 receives the decoded text, not the raw bytes. Each invalid byte in an
// undecodable file decodes to U+FFFD, which is 3 bytes, so the raw size can
// understate the input threefold and exhaust the engine's fixed heap.
const decodedBytes = verdict.kind === 'text' ? buffer.length : Buffer.byteLength(content, 'utf8');
if (!literal && canPrefilter(scanCtx.source, buffer, decodedBytes)) {
  scanCtx.prefilter.lastIndex = 0;
  if (scanCtx.prefilter.exec(content) === null) return { matches: [] };
}

const lines = content.split(/\r?\n/u);
```

`buffer.toString('utf-8')` keeps a leading U+FEFF. `content` is the only text
the per-line scan uses after this point.

Tests: `__tests__/search-text.test.ts`. Inside
`describe('search_text body', …)` (line 30), `search(args)` (line 47) returns
`{ structured, text, isError }`; `structured.matches` is a list of
`{ file, line, column, content, matchCount }`. Model new tests on
`'does not match a phantom empty line after a trailing newline'` (line 238):

```ts
const { structured } = await search({ path: dir, searchPattern: '^$', isRegex: true });
assert.deepStrictEqual(
  structured.matches.map((match) => `${match.file}:${String(match.line)}`),
  ['phantom_line/blank.txt:2'],
);
```

### Part 2: `src/tools/patch.ts`

Lines 81-95:

```ts
async function applyPatchOnce(args: z.infer<typeof PatchInputSchema>, ctx: ToolCtx) {
  const done = await rewriteFile(
    {
      fs: ctx.fs,
      path: args.path,
      dryRun: args.dryRun,
      signal: ctx.signal,
      transport: ctx.transport,
      tool: 'patch',
    },
    (content) => {
      const result = patchContent(args, content);
      return { content: result.patched, result, write: true };
    },
  );
```

`src/core/rewrite.ts:131-137` writes only when the transform says so:

```ts
  const written = !dryRun && change.write;
  if (dryRun && change.write) fs.assertNoReadOnlyHardLink(validPath, stats);
  let modified = stats.mtime.toISOString();
  if (written) {
    await fs.writeFile(request.path, change.content, { signal });
```

The `edit` tool already guards the same case: `src/tools/edit.ts:614` returns
`write: result.appliedEdits > 0`.

Tests: `__tests__/patch.test.ts`. Inside `describe('patch body', …)`,
`patch(args)` (line 40) runs the tool with `{ path, diff, dryRun? }`. The
shared fixture is
`const DIFF = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';` (line 25).
Model on `'applies a unified diff and summarizes it'` (line 42).

### Part 3: `src/tools/diff.ts`

Lines 62-68:

```ts
if (diffText === undefined) {
  throw new FsError(
    ErrorCode.TOO_LARGE,
    `Diff not computed: the files differ in too many lines to diff within ${String(DIFF_TIMEOUT_MS)} ms. Compare smaller sections with read + startLine/endLine.`,
    args.a,
  );
}
```

`twoFilesPatch` (`src/core/diff.ts:144`) returns `undefined` for a timeout,
for a full queue (`src/core/diff.ts:121`,
`if (pendingWorkerDiffs >= MAX_PENDING_WORKER_DIFFS) return undefined;`) and
for a worker that cannot start (`src/core/diff.ts:112-115`). The caller cannot
tell them apart, and this plan does not change that; it makes the message
true for all three.

`__tests__/diff.test.ts:285-296` asserts only that the message includes
`Diff not computed` and that the code is `TOO_LARGE`. Both stay true.

### Conventions

- Tests: `describe` / `it` from `node:test`, `node:assert/strict`,
  `writeTestFile(root, 'dir/name.txt', content)` from `__tests__/helpers.ts`.
- Comments say why, in one or two lines.
- Commit messages are Conventional Commits, for example
  `fix(tools): break basename ties with path in find_files sortBy name`.

## Commands you will need

| Purpose      | Command                                                          | Expected on success |
| :----------- | :--------------------------------------------------------------- | :------------------ |
| Install      | `npm ci`                                                         | exit 0              |
| Search tests | `node --test --test-timeout=60000 __tests__/search-text.test.ts` | all pass            |
| Patch tests  | `node --test --test-timeout=60000 __tests__/patch.test.ts`       | all pass            |
| Diff tests   | `node --test --test-timeout=60000 __tests__/diff.test.ts`        | all pass            |
| Full check   | `npm run check`                                                  | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/search.ts` (the `content` line in `scanFileBody`)
- `src/tools/patch.ts` (the `write:` value at line 93)
- `src/tools/diff.ts` (the message string at line 65)
- `__tests__/search-text.test.ts`, `__tests__/patch.test.ts`
- `CHANGELOG.md` (bullets under `## [Unreleased]` then `### Fixed`)
- `plans/README.md` (your status row)

**Out of scope** (do NOT touch):

- `src/core/matcher.ts` and `src/tools/replace-text.ts`: `replace_text` must
  keep a file's BOM in place, which needs its own design. See "Maintenance
  notes".
- `src/core/diff.ts`: no new return type, no new reason enum. Every caller of
  `twoFilesPatch` (`edit`, `patch`, `replace_text`, `diff`) reads `undefined`
  as "no diff", and changing that is a wider refactor.
- `src/core/rewrite.ts`.
- `src/core/read.ts` and `src/tools/edit.ts` BOM handling.

## Git workflow

- Branch: `advisor/088-text-tool-small-fixes` from `main`.
- Three commits, one per part, for example:
  - `fix(search_text): ignore a UTF-8 BOM when matching the first line`
  - `fix(patch): skip the write when a patch changes nothing`
  - `fix(diff): say a retry can help when the diff was not computed`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (part 1): failing BOM test

In `__tests__/search-text.test.ts`, inside `describe('search_text body', …)`,
add `it('ignores a UTF-8 BOM when matching and counting columns on line 1', …)`:

- `await writeTestFile(root, 'bom/a.cs', '﻿using A;\nusing B;\n');`
- Regex: `search({ path: join(root, 'bom'), searchPattern: '^using', isRegex: true })`
  → `structured.matches.map((m) => m.line)` deep-equals `[1, 2]`.
- Literal: `search({ path: join(root, 'bom'), searchPattern: 'using', caseSensitive: true })`
  → both matches have the same `column`, and `matches[0].content` does not
  start with `'﻿'`.

**Verify**: `node --test --test-timeout=60000 __tests__/search-text.test.ts` →
the new test FAILS (lines are `[2]`); all others pass.

### Step 2 (part 1): strip the mark

In `src/core/search.ts`, replace the line
`const content = buffer.toString('utf-8');` with:

```ts
const decoded = buffer.toString('utf-8');
// A leading BOM is an encoding mark, not text: left in, ^ misses line 1 and its columns shift.
const content = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
```

Leave the `decodedBytes` line as it is (it may keep using `content`; three
bytes of difference do not matter to that bound).

**Verify**: `node --test --test-timeout=60000 __tests__/search-text.test.ts` →
all pass. Commit part 1.

### Step 3 (part 2): failing no-op patch test

In `__tests__/patch.test.ts`, inside `describe('patch body', …)`, add
`it('writes nothing when the patch changes nothing', …)`:

- Create `file = join(root, 'f.txt')` with content `'a\nb\n'` (use
  `writeFile` from `node:fs/promises`, already imported).
- Record `const before = (await stat(file)).mtimeMs;` (add `stat` to the
  `node:fs/promises` import).
- Wait 20 ms: `await sleep(20);` (`sleep` is already imported from
  `node:timers/promises`).
- Run `patch({ path: file, diff: '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n a\n b\n' })`.
- Assert the result is not an error, `(await stat(file)).mtimeMs === before`,
  and the content is still `'a\nb\n'`.

**Verify**: `node --test --test-timeout=60000 __tests__/patch.test.ts` → the
new test FAILS on the `mtimeMs` assertion; all others pass. If it fails
because the result IS an error (the tool already refuses such a diff), see
STOP conditions.

### Step 4 (part 2): skip the write

In `src/tools/patch.ts`, change the transform's return to:

```ts
// A patch of context lines only changes nothing: no write, no undo entry, no watcher event.
return { content: result.patched, result, write: result.patched !== content };
```

**Verify**: `node --test --test-timeout=60000 __tests__/patch.test.ts` → all
pass. Commit part 2.

### Step 5 (part 3): honest message

In `src/tools/diff.ts`, replace the message template with:

```ts
        `Diff not computed: the files differ in too many lines to diff within ${String(DIFF_TIMEOUT_MS)} ms, or the server was busy with other diffs. Retry once; if it fails again, compare smaller sections with read + startLine/endLine.`,
```

**Verify**: `node --test --test-timeout=60000 __tests__/diff.test.ts` → all
pass. Then `grep -rn "too many lines to diff within" __tests__ docs README.md`
→ no match that quotes the old sentence in full; if one does, update that
quote to the new text only if the file is a test in `__tests__/`, otherwise
STOP.

### Step 6: Changelog and full check

In `CHANGELOG.md`, under `## [Unreleased]` then `### Fixed`, add:

```md
- **search_text**: a UTF-8 byte-order mark no longer hides line 1 from `^` patterns or shifts its column numbers.
- **patch**: a patch that changes nothing no longer rewrites the file or records an undo entry.
- **diff**: the "Diff not computed" error now says a retry can help, since a busy server produces it too.
```

**Verify**: `npm run check` → exit 0. Commit part 3 with the changelog.

## Test plan

- `__tests__/search-text.test.ts`: one new test (regex and literal on a BOM
  file).
- `__tests__/patch.test.ts`: one new test (context-only patch leaves mtime and
  content alone).
- Part 3 is a message change; the existing test at
  `__tests__/diff.test.ts:285-296` still covers the code and the prefix.
- Verification: `npm run check` → exit 0.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "0xfeff" src/core/search.ts` shows one match
- [ ] `grep -n "write: true" src/tools/patch.ts` shows no match
- [ ] `grep -n "busy with other diffs" src/tools/diff.ts` shows one match
- [ ] Both new tests exist and pass
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- Step 3's test fails because `patch` returns an error for the context-only
  diff. Then part 2's premise is false: drop steps 3 and 4, remove the test,
  note it in your report, and continue with part 3.
- After step 4, the test `'dryRun counts the lines its diff shows, not the ones the input re-adds'`
  or any other existing patch test fails.
- After step 2, any existing `search_text` test fails, in particular the
  snapshot and pagination tests.
- The contract snapshot test (`__tests__/contract.test.ts`) fails. None of
  these changes should touch the advertised surface.

## Maintenance notes

- After part 1, `search_text '^using'` matches line 1 of a BOM file, while
  `replace_text` with the same pattern still does not (its text keeps the
  mark so the file keeps it). Closing that needs the replace matcher to skip
  a leading BOM and re-attach it; plan it separately if a user reports it.
- Part 3 is the cheap half of a larger fix. Telling a full queue apart from a
  timeout means changing what `twoFilesPatch` returns for all four callers;
  do that only if the retry advice proves insufficient.
- A reviewer should check that part 2 does not change `dryRun` output: a dry
  run never wrote, so only the live path differs.
