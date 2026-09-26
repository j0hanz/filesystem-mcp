# Plan 029: `read` refuses a UTF-16 file with a clear message instead of returning garbled text

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/mime.ts src/core/read.ts __tests__/tools.test.ts`
> If `mime.ts` or `core/read.ts` changed, compare the "Current state" excerpts
> against the live code before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

A UTF-16 file (a common output of Windows PowerShell 5 redirection, `.reg`
exports, some IDE-generated files) starts with a byte-order mark. The binary
probe treats that BOM as "text" (`src/core/mime.ts:189`), and every read path
then decodes the bytes as UTF-8 (`src/core/read.ts:424` for full reads, the
`StringDecoder('utf-8')` at `read.ts:188` for head/tail/range). `read`
therefore succeeds and returns `"��h\u0000e\u0000l…"`, which the
model takes for the file's content. Reproduced.

The other tools already disagree with `read`: `search_text` skips the file
as binary (it contains NUL bytes, `search.ts:267`) and `edit` refuses it
(`read.ts:421`). The smallest consistent fix is to refuse it in `read` too,
with a message that names the encoding — a clear refusal beats confident
garbage. Decoding UTF-16 (LE and BE, across the streaming readers) is a
separate feature; see maintenance notes.

## Current state

```ts
// src/core/mime.ts:165-170
function hasUtf16Bom(slice: Buffer): boolean {
  return (
    slice.length >= 2 &&
    ((slice[0] === 0xff && slice[1] === 0xfe) || (slice[0] === 0xfe && slice[1] === 0xff))
  );
}

// src/core/mime.ts:186-192
/** Single binary-vs-text verdict, shared by `detectMimeType` and the read path. */
export function isBinarySample(slice: Buffer): boolean {
  if (slice.length === 0) return false;
  if (hasUtf16Bom(slice)) return false;
  if (slice.includes(0)) return true;
  return !isUtf8Prefix(slice);
}
```

```ts
// src/core/read.ts:10 (import)
import { isBinarySample, isKnownBinaryExtension, MIME_SAMPLE_SIZE } from './mime.ts';

// src/core/read.ts:39-57
async function readProbe(handle: FileHandle, signal?: AbortSignal): Promise<Buffer> { … }

async function isProbablyBinary(
  filePath: string,
  handle: FileHandle,
  signal?: AbortSignal,
): Promise<boolean> {
  if (isKnownBinaryExtension(filePath)) return true;
  return isBinarySample(await readProbe(handle, signal));
}

// src/core/read.ts:428-438
async function assertNotBinary(
  validPath: string,
  filePath: string,
  handle: FileHandle,
  normalized: ReadOptions,
): Promise<void> {
  normalized.signal?.throwIfAborted();
  const isBinary = await isProbablyBinary(validPath, handle, normalized.signal);
  if (!isBinary) return;
  throw new FsError(ErrorCode.INVALID_INPUT, 'Binary file detected.', filePath);
}
```

`assertNotBinary` runs for every `read` mode before the mode-specific reader
(`readFileWithStats`, line 523). `isProbablyBinary` has no other caller
(`grep -rn isProbablyBinary src` → lines 50 and 435 only).

The `isBinarySample` exemption stays: `detectMimeType` uses it to report
`text/plain` for `stat`/`list`, which is correct — the file is text, just not
UTF-8.

Test conventions: `__tests__/tools.test.ts`, `TC-FUNC-015` (line 793) reads a
missing file and asserts `failedSummary(result)?.results?.[0]?.error?.code`.

## Commands you will need

| Purpose        | Command                                                                          | Expected on success |
| -------------- | -------------------------------------------------------------------------------- | ------------------- |
| Static check   | `npm run check:static`                                                           | exit 0              |
| All tests      | `npm test`                                                                       | all pass            |
| Filter by name | `npm test -- --test-name-pattern="UTF-16"`                                       | passes              |
| Format         | `npx prettier --write src/core/mime.ts src/core/read.ts __tests__/tools.test.ts` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/mime.ts` — export `hasUtf16Bom`
- `src/core/read.ts` — `assertNotBinary` (and delete `isProbablyBinary`)
- `__tests__/tools.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope**: `isBinarySample`'s BOM exemption; `search.ts`;
`replace-text.ts`; `edit`'s strict-UTF-8 check; decoding UTF-16.

## Git workflow

- Branch: `advisor/029-utf16-read-refused-clearly`.
- One commit: `fix(read): refuse UTF-16 files by name instead of decoding them as UTF-8`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Regression test (it must fail now)

In `__tests__/tools.test.ts`, directly after `TC-FUNC-015` (ends line 802),
add:

```ts
it('read refuses a UTF-16 file with a message that names the encoding', async () => {
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('hello\nworld\n', 'utf16le'),
  ]);
  const file = join(tmpDir, 'utf16le.txt');
  await writeFile(file, utf16);

  for (const extra of [{}, { head: 1 }, { tail: 1 }, { startLine: 1, endLine: 1 }]) {
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: file, ...extra },
    });
    assert.strictEqual(result.isError, true, `mode ${JSON.stringify(extra)} must refuse`);
    const error = failedSummary(result)?.results?.[0]?.error;
    assert.strictEqual(error?.code, 'INVALID_INPUT');
    assert.match(error?.message ?? '', /UTF-16/);
  }
});
```

**Verify**: `npm test -- --test-name-pattern="UTF-16"` → **fails** on the
first mode (`isError` is not true; garbled text is returned). If it passes,
STOP.

### Step 2: Name the encoding at the probe

1. In `src/core/mime.ts` line 165, change `function hasUtf16Bom(` to
   `export function hasUtf16Bom(`.
2. In `src/core/read.ts`:
   - Change the import on line 10 to
     `import { hasUtf16Bom, isBinarySample, isKnownBinaryExtension, MIME_SAMPLE_SIZE } from './mime.ts';`
   - Delete `isProbablyBinary` (lines 50–57).
   - Replace `assertNotBinary` (lines 428–438) with:

     ```ts
     async function assertNotBinary(
       validPath: string,
       filePath: string,
       handle: FileHandle,
       normalized: ReadOptions,
     ): Promise<void> {
       normalized.signal?.throwIfAborted();
       if (isKnownBinaryExtension(validPath)) {
         throw new FsError(ErrorCode.INVALID_INPUT, 'Binary file detected.', filePath);
       }
       const probe = await readProbe(handle, normalized.signal);
       // A UTF-16 BOM passes the binary probe (it is text), but every reader
       // here decodes UTF-8 and would hand back U+FFFD and NULs as content.
       if (hasUtf16Bom(probe)) {
         throw new FsError(
           ErrorCode.INVALID_INPUT,
           'UTF-16 text file detected; convert it to UTF-8 to read it.',
           filePath,
         );
       }
       if (isBinarySample(probe)) {
         throw new FsError(ErrorCode.INVALID_INPUT, 'Binary file detected.', filePath);
       }
     }
     ```

Run `npx prettier --write src/core/mime.ts src/core/read.ts __tests__/tools.test.ts`.

**Verify**: `npm test -- --test-name-pattern="UTF-16"` → passes;
`npm test -- --test-name-pattern="Binary"` → all pass.

### Step 3: Full gate

**Verify**: `npm run check` → exit 0 (knip must not report `hasUtf16Bom`:
it now has a consumer in `read.ts`).

## Test plan

- New test: a UTF-16LE file with BOM is refused in all four read modes with
  `INVALID_INPUT` and a message containing `UTF-16`.
- Existing: every binary-detection test (`TC-FUNC-002` image read, "Binary
  file detected" cases), `stat`/`list` mime tests (unchanged: the BOM file
  still reports as text there).

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "isProbablyBinary" src/core/read.ts` prints nothing
- [ ] `grep -n "^export function hasUtf16Bom" src/core/mime.ts` prints one line
- [ ] The new test exists and passes
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 029 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The regression test passes before Step 2.
- After Step 2 a `read` of a UTF-8 file that merely _starts_ with `0xFF 0xFE`
  bytes exists in the fixtures and now fails (none is known).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Deferred feature: decoding UTF-16 for `read`. The full-read path is a
  two-line change (`utf16le` with a `swap16` for BE), but the streaming
  head/tail/range readers split on the LF byte and use a UTF-8
  `StringDecoder`, so they need their own decoder and a 2-byte line
  terminator. Do it as one change for all modes or not at all — a `read` that
  works for full reads and fails for `head` is worse than this refusal.
- The message deliberately says what to do (convert to UTF-8), matching the
  `Sensitive file blocked. Start the server with --allow-sensitive …` style.
