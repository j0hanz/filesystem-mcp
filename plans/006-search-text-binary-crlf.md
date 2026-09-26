# Plan 006: `search_text` skips binary files and strips `\r` from CRLF lines

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7ee3d49f..HEAD -- src/core/search.ts src/tools/search-text.ts __tests__/core-fs.test.ts __tests__/tools.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `7ee3d49f`, 2026-09-25

## Why this matters

`search_text` reads every candidate file as UTF-8 text and splits it on `\n`.
There is no binary check at all: the comment at `search.ts:299` assumes a
binary file makes `readFile` throw, but a UTF-8 decode never throws. So
images, fonts, archives and compiled files under the size limit return
garbage "matching lines" full of NUL and U+FFFD characters. Reproduced: a
10-byte file containing NULs and `hello` came back as
`"blob.bin:1: \u0000��hello\u0000�"`. That wastes the model's context and
disagrees with the tool's own schema text ("default: all text files") and
with `replace_text`, which skips binary files. Separately, CRLF files keep
the `\r` on every returned line (`content`, `before`, `after`), so a regex
anchored with `$` (for example `;$`) matches nothing in a CRLF file, while
the `read` tool strips `\r`. After this plan, files containing a NUL byte are
skipped and counted in a new `skippedBinary` field, and lines are split on
`\r?\n`.

## Current state

- `src/core/search.ts` — `searchContent` (line ~205) is the scan engine
  behind `search_text`. The per-file loop is lines 240-301. Its summary type
  is `SearchContentOutcome` (lines 185-203).
- `src/tools/search-text.ts` — the tool. Its output schema lists the skip
  counters (lines ~108-113); `searchContentOutput` (line ~182) copies the
  engine summary into the structured result.
- `__tests__/core-fs.test.ts` — unit tests that call `searchContent`
  directly (`TC-FUNC-040` at line ~438 is the pattern to follow).

`src/core/search.ts:1` (imports):

```ts
import { stat as fsStat, readFile } from 'node:fs/promises';
```

`src/core/search.ts:256-263`:

```ts
      filesScanned++;

      try {
        const content = await readFile(entry.path, { encoding: 'utf-8', signal: options.signal });
        const lines = content.split('\n');
        // A trailing newline splits into a phantom empty last element; context
        // must not report it as a line the file has.
        const lineCount = content.endsWith('\n') ? lines.length - 1 : lines.length;
```

`src/core/search.ts:291-300`:

```ts
      } catch {
        // A read failure while the signal is aborted IS the abort, not an
        // unreadable file — stop rather than spend another iteration and then
        // report a cut-short scan as complete.
        if (options.signal?.aborted) {
          counters.stoppedByAbort = true;
          break;
        }
        // ignore read errors (e.g. binary files)
      }
```

`src/core/search.ts:194-197` (in the summary type):

```ts
/** Files the guard rejected or that could not be stat'd. */
skippedInaccessible: number;
/** Files skipped unread because they exceed maxFileSize. */
skippedTooLarge: number;
```

`src/core/search.ts:315-319` (the returned summary):

```ts
        truncated: stoppedReason !== undefined,
        skippedInaccessible: counters.skippedInaccessible,
        skippedTooLarge,
        ...(stoppedReason ? { stoppedReason } : {}),
```

`src/tools/search-text.ts:108-113` (output schema) and `:194-195`
(`searchContentOutput`):

```ts
  skippedInaccessible: NonNegInt.optional().describe(
    'Files skipped unread due to permission or access errors',
  ),
  skippedTooLarge: NonNegInt.optional().describe(
    'Files skipped unread because they exceed the text-file size limit; raise the limit or narrow pattern if a match was expected in one',
  ),
```

```ts
    ...(metadata.skippedInaccessible ? { skippedInaccessible: metadata.skippedInaccessible } : {}),
    ...(metadata.skippedTooLarge ? { skippedTooLarge: metadata.skippedTooLarge } : {}),
```

Design decisions already made (do not revisit):

- **Binary = contains a NUL byte**, the same heuristic `grep -I` and this
  repo's `read` probe use. Do **not** also require valid UTF-8: a Latin-1
  source file is still worth searching for ASCII text (read-only, a lossy
  decode is harmless here — unlike `edit`, where it corrupts the file).
- **Structured field only, no text trailer line.** Binary skips are expected
  on nearly every repo-wide search (images, fonts); a `// skipped N binary
files` line on every call would be noise. The count goes in `skippedBinary`
  (in `_meta`) only. Do not change `pageTrailer` in `src/core/fmt.ts`.
- Output schemas are not published in `tools/list`, so the new field does not
  affect the `TOOL-SURFACE-002` size budget test.

## Commands you will need

| Purpose      | Command                                                                 | Expected on success |
| ------------ | ----------------------------------------------------------------------- | ------------------- |
| Install      | `npm ci`                                                                | exit 0              |
| Typecheck    | `npm run type-check:test`                                               | exit 0              |
| Unit tests   | `node --test --test-name-pattern="binary" __tests__/core-fs.test.ts`    | pass                |
| Tool tests   | `node --test --test-name-pattern="search_text" __tests__/tools.test.ts` | all pass            |
| Lint         | `npm run lint`                                                          | exit 0              |
| Format files | `npx prettier --write <files>`                                          | exit 0              |
| Full gate    | `npm run check`                                                         | exit 0              |

## Scope

**In scope**:

- `src/core/search.ts` — `searchContent`'s per-file read and its summary.
- `src/tools/search-text.ts` — output schema field and `searchContentOutput`.
- `__tests__/core-fs.test.ts`
- `__tests__/tools.test.ts`

**Out of scope**:

- `src/core/fmt.ts` (`pageTrailer`) — no new trailer line (see decisions).
- `src/tools/replace-text.ts` — its stricter (UTF-8) gate is correct for a
  writer.
- `src/core/mime.ts` — no extension list; the NUL check is enough.
- `searchFiles` (the `find_files` engine) — it does not read contents.

## Git workflow

- Branch: `advisor/006-search-text-binary-crlf` from `main`.
- One commit, e.g. `fix(search_text): skip binary files and strip CR from lines`.
  If you are an AI agent, end with a `Co-Authored-By:` trailer naming your
  model, as recent commits do.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing unit test

In `__tests__/core-fs.test.ts`, after `TC-FUNC-040`, add
`searchContent skips binary files, keeps Latin-1 text, and strips CR`:

- Directory `join(tmpDir, 'search_binary_dir')` with three files:
  - `crlf.txt`: `'NEEDLE;\r\nnext\r\n'` (use `writeTestFile`)
  - `blob.bin`: `Buffer.from([0x00, 0x4e, 0x45, 0x45, 0x44, 0x4c, 0x45, 0x00])`
    (that is `\0NEEDLE\0`; use `writeFile`, already imported)
  - `latin1.txt`: `Buffer.from('caf\xe9 NEEDLE\n', 'latin1')`
- `const outcome = await searchContent(dir, 'NEEDLE;$', { isRegex: true }, ctx.pathGuard);`
  → `outcome.matches.length === 1`, `basename(outcome.matches[0].file) === 'crlf.txt'`,
  `outcome.matches[0].content === 'NEEDLE;'` (no trailing `\r`).
- `const all = await searchContent(dir, 'NEEDLE', { isRegex: false }, ctx.pathGuard);`
  → matched files (by `basename`) sorted are `['crlf.txt', 'latin1.txt']`,
  and `all.summary.skippedBinary === 1`.

**Verify**: `node --test --test-name-pattern="skips binary files" __tests__/core-fs.test.ts`
→ **fails** (also a type error on `skippedBinary` is expected at this point;
run the test file with `node --test`, which strips types and does not
type-check).

### Step 2: Read a buffer and skip NUL-bearing files

In `src/core/search.ts`, keep the `readFile` import and change the read in the
loop to:

```ts
const buffer = await readFile(entry.path, { signal: options.signal });
// A NUL byte marks a binary file, as it does for `read` and `grep -I`.
// Non-UTF-8 text is still searched: a lossy decode only affects the
// bytes a pattern could not have matched anyway.
if (buffer.includes(0)) {
  skippedBinary++;
  continue;
}
const content = buffer.toString('utf-8');
const lines = content.split(/\r?\n/u);
```

Declare `let skippedBinary = 0;` next to `let skippedTooLarge = 0;`
(line ~237). Leave `filesScanned++` where it is (a binary file was examined).
`lineCount` stays as it is: a trailing `\r\n` still ends with `\n`.

Replace the comment `// ignore read errors (e.g. binary files)` with
`// unreadable mid-scan (deleted, permission changed): skip the file`.

**Verify**: `npm run type-check:test` → errors only about `skippedBinary`
missing from the summary type (fixed next). If other errors appear, STOP.

### Step 3: Add `skippedBinary` to the engine summary

- In `SearchContentOutcome['summary']`, after `skippedTooLarge`, add:

  ```ts
  /** Files skipped because they contain a NUL byte (binary). */
  skippedBinary: number;
  ```

- In the returned `summary` object, add `skippedBinary,` after `skippedTooLarge,`.

**Verify**: `npm run type-check:test` → exit 0, and
`node --test --test-name-pattern="skips binary files" __tests__/core-fs.test.ts` → pass.

### Step 4: Surface it in the tool's structured output

In `src/tools/search-text.ts`:

- Output schema, after `skippedTooLarge`:

  ```ts
  skippedBinary: NonNegInt.optional().describe('Files skipped because they are binary'),
  ```

- In `searchContentOutput`, after the `skippedTooLarge` spread:

  ```ts
    ...(metadata.skippedBinary ? { skippedBinary: metadata.skippedBinary } : {}),
  ```

**Verify**: `npm run type-check:test` → exit 0.

### Step 5: Tool-level test

In `__tests__/tools.test.ts`, after
`search_text names the files it skipped in the text, with or without matches`
(line ~2244), add `search_text skips binary files and reports the count`:

- `writeTestFile(tmpDir, 'search_bin/text.txt', 'BINNEEDLE\n')` and
  `writeFile(join(tmpDir, 'search_bin', 'blob.bin'), Buffer.from([0x00, ...Buffer.from('BINNEEDLE'), 0x00]))`.
- Call `search_text` with `{ path: join(tmpDir, 'search_bin'), searchPattern: 'BINNEEDLE' }`.
- Assert `firstTextBlock(result).text === 'text.txt:1: BINNEEDLE'` (no trailer
  — nothing was truncated or too large), and
  `(result._meta as { skippedBinary?: number }).skippedBinary === 1`.

**Verify**: `node --test --test-name-pattern="search_text" __tests__/tools.test.ts` → all pass.

### Step 6: Format and full gate

`npx prettier --write src/core/search.ts src/tools/search-text.ts __tests__/core-fs.test.ts __tests__/tools.test.ts`

**Verify**: `npm run check` → exit 0.

## Test plan

- Unit: NUL file skipped and counted; Latin-1 file still matched; CRLF line
  returned without `\r`; `$`-anchored regex matches a CRLF line.
- Tool: binary file absent from the text, `skippedBinary` in `_meta`, no new
  trailer line.
- Existing, must stay green: all `search_text` tests (paging, context,
  externalization, skip trailer), `TC-FUNC-040`, and
  `find_files and search_text match a slash-free glob at any depth`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "skippedBinary" src/core/search.ts src/tools/search-text.ts` → counter, type field, summary field, schema field, output spread
- [ ] `grep -n "e.g. binary files" src/core/search.ts` → no matches
- [ ] `grep -nF 'split(/\r?\n/u)' src/core/search.ts` → 1 match
- [ ] `git diff --stat` shows no change to `src/core/fmt.ts`
- [ ] `git status` shows only the four in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- An existing test expects a match inside a binary file, or a `\r` at the end
  of a returned line.
- `searchContent` turns out to be used by a tool other than `search_text`
  whose output would change (`grep -rn "searchContent(" src`).
- Adding the output field changes `tools/list` size (it should not; output
  schemas are not published).

## Maintenance notes

- Reading into a `Buffer` then decoding costs the same as `readFile` with
  `encoding` (Node decodes the same buffer internally).
- If users ask why a binary file did not show up, the answer is in
  `_meta.skippedBinary`; if models need to see it, add it to `pageTrailer`
  **only when** it is the sole reason for "No matches".
- The existing per-file `stat` + `readFile` pair (two syscalls) and the serial
  loop are known performance limits; out of scope here.
