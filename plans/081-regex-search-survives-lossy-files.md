# Plan 081: Keep lossy files from exhausting the regex engine, and report exhaustion truthfully

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5ebbd489..HEAD -- src/core/search.ts src/core/matcher.ts __tests__/search-text.test.ts __tests__/re2-abort.test.ts CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `5ebbd489`, 2026-11-03

## Why this matters

`search_text` guards the RE2 engine by the size of a file's raw bytes, but RE2
receives the decoded text. Every invalid UTF-8 byte decodes to U+FFFD, which is
3 bytes, so a file of 2.8 MiB or more that is mostly invalid bytes reaches RE2
at over 8 MB and aborts its fixed 16 MB WebAssembly heap.

Three things go wrong, all reproduced on `5ebbd489`:

1. **Matches disappear.** A valid `NEEDLE` line in such a file was found at
   2.6 MiB and missed at 2.8 MiB.
2. **The reason is false.** The result says `skipped 1 inaccessible entry`,
   which says nothing about memory or size.
3. **The damage lasts until restart.** Each abort leaks heap. Searching one
   3.99 MiB lossy file once made valid 3 MB files abort; 5 searches took 1 MB
   files with them; 20 more took 0.1 MB files. Regex search was then dead for
   the rest of the process. (Those counts include aborts the size checks
   themselves caused.)

`SECURITY.md` promises that no input can crash or hang the server. This does
not crash it, but one file in an allowed folder can disable a feature silently.

## Current state

- `src/core/search.ts` — content search. `scanFile` decodes the file, runs a
  whole-buffer prefilter, then matches line by line.
- `src/core/matcher.ts` — owns RE2: `compileRegex`, `freeRegex`,
  `RE2_MAX_INPUT_BYTES` (4 MiB).
- `src/core/scan.ts` — the walk. A callback that throws is counted as
  inaccessible; a returned `ScanSkip` is counted by its verdict. A named file
  (`scope.explicitFile`) rethrows the callback's error.
- `__tests__/search-text.test.ts` — tool-body tests for `search_text`.

`src/core/search.ts:165-183`, where raw size decides both guards:

```ts
const literal = scanCtx.literal?.needsRe2(buffer) ? undefined : scanCtx.literal;
if (literal && !literal.mayMatch(buffer)) return { matches: [] };
const content = buffer.toString('utf-8');
if (!literal && canPrefilter(scanCtx.source, buffer)) {
  scanCtx.prefilter.lastIndex = 0;
  if (scanCtx.prefilter.exec(content) === null) return { matches: [] };
}
```

```ts
const checkLineSize = !literal && buffer.length > RE2_MAX_INPUT_BYTES;
```

`src/core/search.ts:339-346`:

```ts
/** Whether one whole-buffer RE2 test is a sound "cannot match" check for this file. */
function canPrefilter(source: string, buffer: Buffer): boolean {
  if (buffer.length > RE2_MAX_INPUT_BYTES) return false;
  if (BUFFER_ANCHOR_RE.test(source)) return false;
  if (INLINE_FLAGS_RE.test(source)) return false;
  if (source.includes('$') && buffer.includes(CR)) return false;
  return true;
}
```

`src/core/matcher.ts:140-148`, the compile path:

```ts
try {
  return new RE2(pattern, flags);
} catch (error) {
  if (!(error instanceof SyntaxError)) throw error;
  throw new SyntaxError(
    `${error.message} — lookahead, lookbehind, and backreferences are not supported.`,
    { cause: error },
  );
}
```

Facts verified by probe on `@adguard/re2-wasm` 1.2.1:

- The abort is thrown as an `Error` whose `name` is `RuntimeError` and whose
  `message` starts with `Aborted(`. The engine also writes it to stderr, never
  to stdout, so the stdio protocol stays intact.
- `[^x]` repeated 2500 times compiles to about 0.8 MB. Compiling 19 of them
  without freeing aborts. Afterwards, even with all of them freed, a 1 MB input
  aborts.
- A valid 3.95 MiB file passes on a fresh heap, so the existing 4 MiB bound is
  sound for undamaged state.
- `replace_text` is not affected by the lossy route: it skips undecodable files.

Conventions:

- Errors: `new FsError(ErrorCode.X, message, path, cause, suggestion)`, as in
  `outputTooLarge` at `src/core/matcher.ts:305-313`.
- Comments state the why, in full sentences. Match the surrounding style.
- Glossary term: a **Scan** "rules on every entry it finds: usable, sensitive,
  inaccessible, binary, undecodable or too large".
- Test helper: `search(args)` in `__tests__/search-text.test.ts` wraps
  `runToolBodyResult(SEARCH_TEXT, ...)` and returns `{ structured, text }`.

## Commands you will need

| Purpose       | Command                                           | Expected on success |
| ------------- | ------------------------------------------------- | ------------------- |
| One test file | `node --test __tests__/search-text.test.ts`       | all pass            |
| New test file | `node --test __tests__/re2-abort.test.ts`         | all pass            |
| Full check    | `npm run check`                                   | exit 0              |
| Graph update  | `graphify update .` (project rule after any edit) | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/search.ts`
- `src/core/matcher.ts`
- `__tests__/search-text.test.ts`
- `__tests__/re2-abort.test.ts` (create)
- `CHANGELOG.md` (the `[Unreleased]` section)
- `graphify-out/` (only what `graphify update .` rewrites)

**Out of scope** (do NOT touch, even though they look related):

- `src/core/scan.ts` — its counting rules are correct; this plan changes what
  `scanFile` hands it.
- `src/tools/replace-text.ts` and the replacement matchers — a RE2 abort there
  already surfaces as a visible failure row with nothing written.
- `RE2_MAX_INPUT_BYTES` — do not change the value.
- Reloading the WebAssembly module, worker threads, or a pattern-complexity
  limit. Each is a larger design; see Maintenance notes.
- Version fields in `package.json`, `server.json` and the manifests.

## Git workflow

- Branch: `advisor/081-regex-search-survives-lossy-files`
- Commit per step, Conventional Commits, as in `git log`:
  `fix(search): keep the pattern hint beside a binary skip`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing lossy-file tests

Add these to the `search_text body` describe block in
`__tests__/search-text.test.ts`, directly after the existing test
`still searches a named undecodable file lossily`. `Buffer` is a global;
`mkdir`, `writeFile` and `join` are already imported there.

```ts
/** A valid head past the 512-byte binary probe, then `tail` undecodable bytes. */
const lossyBody = (tail: Buffer): Buffer =>
  Buffer.concat([Buffer.from(`${'text line\n'.repeat(100)}NEEDLE here\n`), tail]);

it('finds a match in a lossy file whose decoded text outgrows the regex limit', async () => {
  const dir = join(root, 'lossy_lines');
  await mkdir(dir, { recursive: true });
  // 64 KiB invalid-byte lines: 3.9 MiB raw, about 11.7 MB decoded, each line small.
  const line = Buffer.concat([Buffer.alloc(64 * 1024, 0xe9), Buffer.from('\n')]);
  await writeFile(
    join(dir, 'latin.log'),
    lossyBody(Buffer.concat(new Array<Buffer>(62).fill(line))),
  );

  const { structured } = await search({ path: dir, searchPattern: 'NEE+DLE', isRegex: true });

  assert.strictEqual(structured.totalMatches, 1);
  assert.strictEqual(structured.skippedInaccessible, undefined);
});

it('counts a walked lossy file with one overlong decoded line as too large', async () => {
  const dir = join(root, 'lossy_walked');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'latin.log'), lossyBody(Buffer.alloc(3_900_000, 0xe9)));

  const { structured } = await search({ path: dir, searchPattern: 'NEE+DLE', isRegex: true });

  assert.strictEqual(structured.skippedTooLarge, 1);
  assert.strictEqual(structured.skippedInaccessible, undefined);
});

it('refuses a named lossy file with one overlong decoded line, and names the line', async () => {
  const dir = join(root, 'lossy_named');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'latin.log');
  await writeFile(file, lossyBody(Buffer.alloc(3_900_000, 0xe9)));

  await assert.rejects(
    search({ path: file, searchPattern: 'NEE+DLE', isRegex: true }),
    fsErrorMatcher(ErrorCode.TOO_LARGE, /line/),
  );
});

it('leaves regex search whole after repeated searches over a lossy file', async () => {
  const dir = join(root, 'lossy_repeat');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'latin.log'), lossyBody(Buffer.alloc(3_900_000, 0xe9)));
  for (let i = 0; i < 3; i++) {
    await search({ path: dir, searchPattern: 'NEE+DLE', isRegex: true });
  }

  const body = 'abc NEEDLE\n';
  const large = await writeTestFile(
    join(root, 'lossy_after'),
    'valid.txt',
    body.repeat(Math.floor((3.9 * 1024 * 1024) / body.length)),
  );
  const { structured } = await search({
    path: large,
    searchPattern: 'NEE+DLE',
    isRegex: true,
    maxResults: 1,
  });
  assert.ok((structured.totalMatches ?? 0) >= 1);
});
```

**Verify**: `node --test --test-name-pattern="lossy" __tests__/search-text.test.ts`
→ the four new tests fail. `still searches a named undecodable file lossily`
is also matched by that filter and passes. stderr shows `Aborted(Cannot enlarge memory arrays`.

### Step 2: Measure decoded bytes

In `src/core/search.ts` `scanFile`, add this directly after
`const content = buffer.toString('utf-8');`:

```ts
// RE2 receives the decoded text, not the raw bytes. Each invalid byte in an
// undecodable file decodes to U+FFFD, which is 3 bytes, so the raw size can
// understate the input threefold and exhaust the engine's fixed heap.
const decodedBytes = verdict.kind === 'text' ? buffer.length : Buffer.byteLength(content, 'utf8');
```

Pass it to the prefilter gate and the line check:

```ts
if (!literal && canPrefilter(scanCtx.source, buffer, decodedBytes)) {
```

```ts
const checkLineSize = !literal && decodedBytes > RE2_MAX_INPUT_BYTES;
```

Change `canPrefilter` to take the measure:

```ts
function canPrefilter(source: string, buffer: Buffer, decodedBytes: number): boolean {
  if (decodedBytes > RE2_MAX_INPUT_BYTES) return false;
```

Leave the other three checks in `canPrefilter` as they are.

**Verify**: `node --test --test-name-pattern="lossy" __tests__/search-text.test.ts`
→ all pass, and stderr has no `Aborted(`.

### Step 3: Name the abort in `matcher.ts`

Add this to `src/core/matcher.ts`, directly above `compileRegex`'s doc comment:

```ts
/** True for the abort re2-wasm raises when its fixed heap is exhausted. */
export function isRe2Abort(error: unknown): boolean {
  return (
    error instanceof Error && error.name === 'RuntimeError' && error.message.startsWith('Aborted(')
  );
}

/** The refusal a heap-exhausting call gets. An abort leaks heap, so it warns about what follows. */
export function re2AbortError(path: string | undefined, cause: unknown): FsError {
  return new FsError(
    ErrorCode.TOO_LARGE,
    'The regex engine ran out of its fixed 16 MB of memory. Regex search can keep failing on smaller inputs until the server restarts.',
    path,
    cause,
    'Restart the server, or use a literal searchPattern with caseSensitive: true, which does not need the engine.',
  );
}
```

In `compileRegex`, add a check as the first line of the `catch`:

```ts
} catch (error) {
  if (isRe2Abort(error)) throw re2AbortError(undefined, error);
  if (!(error instanceof SyntaxError)) throw error;
```

Replace the sentence in `compileRegex`'s doc comment that reads "heap), so
exhaustion is an emscripten `abort()` that kills regex search for the rest of
the process." with:

```text
heap), so exhaustion is an emscripten `abort()`. An abort leaks heap: each one
shrinks the largest input the engine can take, until regex search fails on
small files too. Only a restart restores it.
```

Keep the line wrapping and the sentence that follows.

**Verify**: `npm run build` → exit 0.

### Step 4: Report a runtime abort truthfully in `scanFile`

In `src/core/search.ts`, rename the existing `scanFile` to `scanFileBody`
without changing its signature, and add this above it:

```ts
/**
 * A RE2 abort is not the file being unreadable, which is what the Scan would
 * count a throw as. A named file fails the call with the reason; a walked file
 * counts as too large, and the log says what happened.
 */
async function scanFile(entryPath: string, scanCtx: ScanContext): Promise<FileScan | ScanSkip> {
  try {
    return await scanFileBody(entryPath, scanCtx);
  } catch (error) {
    if (!isRe2Abort(error)) throw error;
    if (scanCtx.named) throw re2AbortError(entryPath, error);
    Logger.warn(
      `Regex engine ran out of memory on ${entryPath}; regex search may keep failing until the server restarts.`,
    );
    // Only a named file's refusal reads the size, and that branch threw above.
    return new ScanSkip({ kind: 'tooLarge', size: 0 });
  }
}
```

Add `isRe2Abort` and `re2AbortError` to the existing import from
`./matcher.ts`. Add this import in sorted position; Prettier's import sorter
will confirm the order:

```ts
import { Logger } from './observability.ts';
```

Update the comment at the line check, which currently says "OOMs the wasm
module for the rest of the process". Replace those words with "aborts the
wasm module and leaks its heap". Keep the rest of that comment.

**Verify**: `node --test __tests__/search-text.test.ts` → all pass.

### Step 5: Test the residual abort in its own process

`node --test` runs each file in its own process, so this file's deliberate heap
damage cannot reach other tests. Create `__tests__/re2-abort.test.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ErrorCode } from '../src/core/errors.ts';
import { compileRegex, freeRegex, type Regex } from '../src/core/matcher.ts';
import { SEARCH_TEXT } from '../src/tools/index.ts';
import { cleanupTestRoot, createTestRoot, fsErrorMatcher, writeTestFile } from './helpers.ts';
import { runToolBodyResult } from './tool-harness.ts';

const LARGE_PROGRAM = '[^x]'.repeat(2500);

describe('a RE2 abort', () => {
  let root: string;
  let dir: string;
  let file: string;

  before(async () => {
    root = await createTestRoot();
    dir = `${root}/walked`;
    const body = 'abc NEEDLE\n';
    file = await writeTestFile(
      dir,
      'valid.txt',
      body.repeat(Math.floor((3.9 * 1024 * 1024) / body.length)),
    );
  });

  after(async () => {
    await cleanupTestRoot(root);
  });

  it('is reported as the engine running out of memory, not as an unreadable file', async () => {
    const live: Regex[] = [];
    await assert.rejects(
      async () => {
        for (let i = 0; i < 60; i++) live.push(compileRegex(LARGE_PROGRAM));
      },
      fsErrorMatcher(ErrorCode.TOO_LARGE, /restart/i),
    );
    for (const regex of live) freeRegex(regex);

    // The abort above leaked heap, so this valid file now aborts too.
    const walked = await runToolBodyResult(
      SEARCH_TEXT,
      { path: dir, searchPattern: 'NEE+DLE', isRegex: true },
      { roots: [root] },
    );
    assert.strictEqual(walked.structured.skippedTooLarge, 1);
    assert.strictEqual(walked.structured.skippedInaccessible, undefined);

    await assert.rejects(
      runToolBodyResult(
        SEARCH_TEXT,
        { path: file, searchPattern: 'NEE+DLE', isRegex: true },
        { roots: [root] },
      ),
      fsErrorMatcher(ErrorCode.TOO_LARGE, /restart/i),
    );
  });
});
```

If `fsErrorMatcher` or `Regex` is not exported from the named module, import it
from where `__tests__/search-text.test.ts` and `src/core/matcher.ts` show it.

**Verify**: `node --test __tests__/re2-abort.test.ts` → 1 test passes.

### Step 6: Record the change

In `CHANGELOG.md` under `## [Unreleased]`, add a `### Fixed` heading if there is
none, placed after `### Changed`, with this bullet:

```markdown
- **Regex search no longer exhausts its engine on non-UTF-8 files.** `search_text` sized the engine's input by a file's raw bytes, so a file of about 2.8 MiB or more of mostly invalid bytes aborted the engine, lost that file's matches, and reported it as inaccessible. Each abort also shrank what the engine could take until restart, until regex search failed on small files. The size is now measured after decoding. If the engine still runs out of memory, a walked file counts as too large and a named file answers `TOO_LARGE` with advice.
```

**Verify**: `npx prettier --check CHANGELOG.md` → exit 0.

### Step 7: Full check

Run `npm run check`, then `graphify update .`.

**Verify**: `npm run check` → exit 0. The contract snapshot test passes without
updating the snapshot, because no tool description changed.

## Test plan

Four tests in `__tests__/search-text.test.ts` and one in
`__tests__/re2-abort.test.ts`, all given above:

| Case                                    | Regression it pins                    |
| :-------------------------------------- | :------------------------------------ |
| Lossy file, small lines, walked         | The missed match                      |
| Lossy file, one overlong line, walked   | The false "inaccessible" reason       |
| Lossy file, one overlong line, named    | A clear refusal naming the line       |
| Valid 3.9 MiB file after lossy searches | No heap damage                        |
| Residual abort, compile, walked, named  | Truthful report for what still aborts |

Structural pattern: the test `refuses a named file with an overlong regex line,
and names the line` in `__tests__/search-text.test.ts`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `node --test __tests__/re2-abort.test.ts` exits 0
- [ ] `grep -n "buffer.length > RE2_MAX_INPUT_BYTES" src/core/search.ts` returns no matches
- [ ] `grep -n "for the rest of" src/core/matcher.ts src/core/search.ts` returns no matches
- [ ] `git diff --stat 5ebbd489..HEAD -- __tests__/contract.test.ts.snapshot` shows no change
- [ ] `git status` shows only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- Step 1's tests pass before Step 2. The bug may be fixed already, or the
  fixture no longer reaches the engine.
- Step 5's first assertion fails because 60 compiles do not abort. The engine's
  heap or memory use has changed, so the facts in this plan are stale.
- `__tests__/re2-abort.test.ts` passes alone but another test file starts to
  fail. That would mean test files share a process, against this plan's premise.
- A `re2-wasm` version other than 1.2.1 is installed.
- The fix appears to need a change in `src/core/scan.ts`.

## Maintenance notes

- **Any new RE2 caller must measure decoded bytes.** `RE2_MAX_INPUT_BYTES` limits
  what the engine receives, not what is on disk.
- **The heap is still shared and fixed.** A valid 3.95 MiB input needs about
  8 MB, and each large pattern holds up to about 0.8 MB, twice per search because
  of the prefilter. Roughly 5 concurrent searches with 10,000-character patterns
  could still abort. This plan makes that truthful, not impossible. Deferred
  because a real fix (a pattern-size limit, admission control, or reloading the
  module) is a design decision for the maintainer.
- **`replace_text` keeps its current failure row** with `Aborted(...)` text. It
  writes nothing and is visible, so it stays out of scope, but the wording could
  use `re2AbortError` later.
- **Reviewers should check** that `decodedBytes` costs nothing for valid UTF-8,
  since `verdict.kind === 'text'` skips the measure.
