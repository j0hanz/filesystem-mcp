# Plan 021: `replace_text` refuses regex mode on a file too large for RE2's wasm heap, instead of aborting

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/search.ts src/tools/replace-text.ts __tests__/tools.test.ts`
> Plans 019 and 020 touch `replace-text.ts` and `tools.test.ts` on other
> lines; only the excerpts quoted below must still match.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/019 (test net), plans/020 (same file; run after it)
- **Category**: bug
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

`@adguard/re2-wasm` runs RE2 in a wasm module with a fixed 16 MB heap
(`src/core/search.ts:43-48` documents this for compiled patterns). Matching
also copies the **input** string into that heap. `search_text` matches one
line at a time, so it never gets near the limit. `replace_text` in regex mode
tests and scans the **whole file as one string**
(`src/tools/replace-text.ts:221,231`). The default file-size limit is 10 MiB
(`FS_MAX_FILE_SIZE`, configurable up to 100 MiB).

Measured: an 8 MB input works (384 ms, synchronous); at about 10 MB the wasm
module dies with `Aborted(Cannot enlarge memory arrays … OOM)`. Through the
tool, `replace_text` with `isRegex: true` on a 9.5 MB file fails with an
`UNKNOWN` error carrying that abort text. The same file with a case-sensitive
literal pattern succeeds (that matcher uses `Buffer.indexOf`).

Regex mode is used whenever `isRegex`, `wholeWord`, or `caseSensitive: false`
is set (`replace-text.ts:459-466`). The fix: refuse regex mode above a safe
input size with a `TOO_LARGE` error that names the workaround.

## Current state

```ts
// src/core/search.ts:43-48 (comment above compileRegex)
 * Every compiled pattern owns memory in re2-wasm's fixed 16 MB heap, which
 * `ALLOW_MEMORY_GROWTH` is off for. re2-wasm never frees it and a
 * FinalizationRegistry does not keep up (V8 sees no pressure from the wasm
 * heap), so exhaustion is an emscripten `abort()` that kills regex search for
 * the rest of the process. Every caller MUST pass the result to
 * {@link freeRegex} when it is done with it.
```

```ts
// src/tools/replace-text.ts:212-222
function createRegexReplacementMatcher(
  regex: Regex,
  expandReplacement: boolean,
): ReplacementMatcher {
  return {
    testBuffer(buffer: Buffer): boolean {
      // The regex is global and shared across every file in the batch, so a
      // previous file's match would otherwise start this scan mid-string.
      regex.lastIndex = 0;
      return regex.test(buffer.toString('utf-8'));
    },
```

```ts
// src/tools/replace-text.ts:337-352 (readReplacementPlan)
await using fileHandle = await ctx.fs.open(validPath);
const stats = await fileHandle.stat();
if (stats.size > maxFileSize) {
  throw new FsError(
    ErrorCode.TOO_LARGE,
    `File too large: ${validPath} (${String(stats.size)} bytes > ${String(maxFileSize)} bytes)`,
  );
}

const buffer = await readFileBufferWithLimit(fileHandle, maxFileSize, validPath, signal);
if (!matcher.testBuffer(buffer)) return undefined;
```

A throw from `testBuffer` propagates out of `readReplacementPlan` into
`processEntry`'s catch (`replace-text.ts:328-334`), which records it as a
per-file failure with `Problem.fromUnknown(error, ErrorCode.UNKNOWN, entryPath)`
— an `FsError`'s own code (`TOO_LARGE`) survives that conversion.

`src/core/util.ts:7` exports `MIB`. `FsError` and `ErrorCode` are already
imported in `replace-text.ts`.

## Commands you will need

| Purpose        | Command                                                                                     | Expected on success |
| -------------- | ------------------------------------------------------------------------------------------- | ------------------- |
| Static check   | `npm run check:static`                                                                      | exit 0              |
| All tests      | `npm test`                                                                                  | all pass            |
| Filter by name | `npm test -- --test-name-pattern="regex mode on a file"`                                    | passes              |
| Format         | `npx prettier --write src/core/search.ts src/tools/replace-text.ts __tests__/tools.test.ts` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/search.ts` — one exported constant next to the heap comment
- `src/tools/replace-text.ts` — `createRegexReplacementMatcher.testBuffer`
- `__tests__/tools.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `search_text` / `src/core/search.ts` matching — line-by-line, unaffected.
- `compileRegex` / `freeRegex` — pattern memory is a different budget.
- Changing regex replace to work line by line — it would change what
  multi-line patterns match. Deferred.

## Git workflow

- Branch: `advisor/021-replace-text-regex-input-cap`.
- One commit: `fix(replace_text): refuse regex mode above RE2's safe input size`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Regression test (it must fail now)

In `__tests__/tools.test.ts`, directly after the `$`-expansion test added by
plan 019 (or after `TC-FUNC-013r` if 019 is absent), add:

```ts
it('replace_text regex mode on a file past the RE2 input cap fails that file with TOO_LARGE', async () => {
  const size = RE2_MAX_INPUT_BYTES + 1;
  const big = await writeTestFile(tmpDir, 'regex_cap/big.txt', 'x'.repeat(size - 5) + 'FIND\n');
  const asRegex = await harness.client.callTool({
    name: 'replace_text',
    arguments: { path: big, searchPattern: 'FIND', replacement: 'FOUND', isRegex: true },
  });
  assert.strictEqual(asRegex.isError, true);
  const failure = failedSummary(asRegex)?.results?.[0]?.error;
  assert.strictEqual(failure?.code, 'TOO_LARGE');
  assert.match(failure?.message ?? '', /regex/i);
  assert.ok((await readFile(big, 'utf-8')).endsWith('FIND\n'), 'file must be untouched');

  const literal = await harness.client.callTool({
    name: 'replace_text',
    arguments: { path: big, searchPattern: 'FIND', replacement: 'FOUND', caseSensitive: true },
  });
  assert.notStrictEqual(literal.isError, true, 'the literal matcher has no input cap');
  assert.ok((await readFile(big, 'utf-8')).endsWith('FOUND\n'));
});
```

Add `RE2_MAX_INPUT_BYTES` to the existing import from `'../src/core/util.ts'`?
No — it lives in `search.ts`: add
`import { RE2_MAX_INPUT_BYTES } from '../src/core/search.ts';` (prettier
sorts imports).

**Verify**: `npm run build` → fails (constant does not exist yet). Proceed.

### Step 2: The constant

In `src/core/search.ts`, directly below the heap comment block (after line
48, before `compileRegex`), add:

```ts
/**
 * Largest input one RE2 call may scan as a single string. The input is copied
 * into the same fixed 16 MB wasm heap as the patterns; about 10 MB of input
 * aborts the module. 4 MiB leaves room for the copy and the pattern set.
 */
export const RE2_MAX_INPUT_BYTES = 4 * MIB;
```

Add `MIB` to the import from `'./util.ts'` in `search.ts` (check the existing
import line for that module and extend it).

### Step 3: Refuse before the wasm call

In `src/tools/replace-text.ts`, `createRegexReplacementMatcher.testBuffer`
(lines 217–222), insert before `regex.lastIndex = 0;`:

```ts
if (buffer.length > RE2_MAX_INPUT_BYTES) {
  throw new FsError(
    ErrorCode.TOO_LARGE,
    `File too large for a regex replace (${String(buffer.length)} > ${String(RE2_MAX_INPUT_BYTES)} bytes). Regex mode is used for isRegex, wholeWord, or the default caseSensitive: false; pass caseSensitive: true with a literal searchPattern, or split the file.`,
  );
}
```

Add `RE2_MAX_INPUT_BYTES` to the import from `'../core/search.ts'` in
`replace-text.ts` (the file already imports `compileRegex`/`freeRegex` from
there — extend that line).

Run `npx prettier --write src/core/search.ts src/tools/replace-text.ts __tests__/tools.test.ts`.

**Verify**: `npm test -- --test-name-pattern="regex mode on a file"` → passes.

### Step 4: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- New test: a file of `RE2_MAX_INPUT_BYTES + 1` bytes; regex mode → per-file
  `TOO_LARGE` whose message mentions regex, file untouched; literal mode on the
  same file succeeds.
- Existing: every `replace_text` test in `tools.test.ts`, including plan 019's
  `$`-expansion table.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "RE2_MAX_INPUT_BYTES" src/core/search.ts src/tools/replace-text.ts` shows the definition and one use
- [ ] The new test exists and passes
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 021 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1's assertion on `failure?.code` sees `UNKNOWN` with an `Aborted(`
  message even after Step 3 — the abort happens before `testBuffer` (report
  the stack).
- The literal-mode call in the test fails — that is a different bug.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If `@adguard/re2-wasm` is ever built with `ALLOW_MEMORY_GROWTH`, raise or
  drop the cap together with the comment in `search.ts`.
- `search_text` stays uncapped by design: it never hands RE2 more than one
  line. If a per-line cap is ever wanted, it belongs beside this constant.
- Reviewer focus: the check runs before any wasm call, on the raw byte length
  (UTF-8 bytes are what get copied into the heap).
