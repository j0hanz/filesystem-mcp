# Plan 001: `edit`, `patch` and `diff` refuse files that are not valid UTF-8 instead of corrupting them

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7ee3d49f..HEAD -- src/core/read.ts src/core/fs.ts __tests__/core-fs.test.ts __tests__/tools.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `7ee3d49f`, 2026-09-25

## Why this matters

`edit` and `patch` read the whole file, decode it as UTF-8, apply the change,
and write the decoded string back. The only binary/encoding check is a probe
of the **first 512 bytes**. A file whose first 512 bytes are ASCII but which
contains a Latin-1 / Windows-1252 byte later (common in legacy sources, `.ini`,
`.properties`) is decoded lossily: every invalid byte becomes U+FFFD, and the
write-back permanently replaces it with the bytes `EF BF BD` — anywhere in the
file, not just in the edited region. The tool reports success. This was
reproduced: a file with `é` (byte `0xE9`) at offset ~606, edited elsewhere,
came back with `efbfbd` in its place. UTF-16 files (the probe treats a UTF-16
BOM as text) are corrupted the same way. `diff` shares the reader, so two files
that differ only in such bytes diff as identical. After this plan, those three
tools refuse such a file with `INVALID_INPUT`, as `replace_text` already does.

## Current state

- `src/core/read.ts` — the file-reading pipeline. `ReadSpec` (line 58) is the
  read-mode union; `readFullContent` (line 410) decodes lossily; `readByMode`
  (line 442) dispatches `kind: 'full'`.
- `src/core/fs.ts` — `GuardedFileSystem.readEditableText` (line 337) is the
  reader `edit` (`src/tools/edit.ts:373`), `patch` (`src/tools/patch.ts:77`) and
  `diff` (`src/tools/diff.ts:44-45`) use. It calls `readFileWithStats` with
  `kind: 'full'`.
- The `read` tool also uses `kind: 'full'` via `GuardedFileSystem.readFile`. It
  is read-only, so it must keep its current lossy-but-tolerant behavior. **Do
  not change what `read` returns.**

`src/core/read.ts:58-62`:

```ts
export type ReadSpec =
  | { kind: 'full'; signal?: AbortSignal }
  | { kind: 'head'; lines: number; signal?: AbortSignal }
  | { kind: 'tail'; lines: number; signal?: AbortSignal }
  | { kind: 'range'; start: number; end?: number; signal?: AbortSignal };
```

`src/core/read.ts:410-419`:

```ts
async function readFullContent(
  handle: FileHandle,
  maxSize: number,
  requestedPath: string,
  signal?: AbortSignal,
): Promise<{ content: string; totalLines: number }> {
  const buffer = await readFileBufferWithLimit(handle, maxSize, requestedPath, signal);
  const content = buffer.toString('utf-8');
  return { content, totalLines: countLines(content) };
}
```

`src/core/read.ts:451-458` (inside `readByMode`):

```ts
    case 'full': {
      assertSizeWithinLimit(stats.size, options.maxSize, filePath);
      const { content, totalLines } = await readFullContent(
        handle,
        options.maxSize,
        filePath,
        options.signal,
      );
```

`src/core/fs.ts:352-356` (inside `readEditableText`):

```ts
const { content } = await readFileWithStats(filePath, validPath, stats, {
  kind: 'full',
  ...(options?.signal ? { signal: options.signal } : {}),
});
return { validPath, content, stats };
```

**The exemplar to match** — `replace_text` already has the exact guard, with
the error text this plan reuses (`src/tools/replace-text.ts:353-361`):

```ts
  // Only bytes that decode to UTF-8 losslessly survive the string round trip;
  // anything else would be written back with U+FFFD in place of every bad byte.
  // NUL is valid UTF-8 but marks a binary file, as it does for `read`.
  if (!isUtf8(buffer) || buffer.includes(0)) {
    if (ctx.singleFile) {
      throw new FsError(ErrorCode.INVALID_INPUT, 'Binary or non-UTF-8 file detected.', validPath);
    }
```

`isUtf8` comes from `node:buffer` (`import { Buffer, isUtf8 } from 'node:buffer';`
at `replace-text.ts:3`). `read.ts` already imports `ErrorCode` and `FsError`
from `./errors.ts` (line 8).

Repo conventions: TypeScript strict with `exactOptionalPropertyTypes` (so an
optional field is added only when defined, with the
`...(x !== undefined ? { x } : {})` spread pattern); Prettier (single quotes,
width 100, trailing commas); comments explain _why_, one short block above the
code.

## Commands you will need

| Purpose        | Command                                                               | Expected on success |
| -------------- | --------------------------------------------------------------------- | ------------------- |
| Install        | `npm ci`                                                              | exit 0              |
| Typecheck      | `npm run type-check:test`                                             | exit 0              |
| One test file  | `node --test __tests__/core-fs.test.ts`                               | all pass            |
| Filtered tests | `node --test --test-name-pattern="non-UTF-8" __tests__/tools.test.ts` | all pass            |
| Lint           | `npm run lint`                                                        | exit 0              |
| Format files   | `npx prettier --write <files>`                                        | exit 0              |
| Full gate      | `npm run check`                                                       | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/read.ts`
- `src/core/fs.ts`
- `__tests__/core-fs.test.ts`
- `__tests__/tools.test.ts`

**Out of scope** (do NOT touch):

- `src/tools/edit.ts`, `src/tools/patch.ts`, `src/tools/diff.ts` — the fix
  lives in the shared reader so all three get it; no tool code changes.
- `src/core/mime.ts` (`isBinarySample`, `MIME_SAMPLE_SIZE`) — the 512-byte
  probe is also used by `read`, `stat` and MIME detection; widening it would
  change the `read` tool.
- `src/tools/replace-text.ts` — already correct.
- `CHANGELOG.md`, and the `version` field in `package.json`, `server.json`,
  `mcpb/manifest.json` — the Release workflow owns those.

## Git workflow

- Branch: `advisor/001-edit-reject-non-utf8` from `main`.
- One commit. Conventional Commits subject, body says why. Example from this
  repo's log: `fix(ci): fail the Smithery step on an empty API key`. Use e.g.
  `fix(edit): refuse non-UTF-8 files instead of rewriting their bytes`. If you
  are an AI agent, end the message with a `Co-Authored-By:` trailer naming your
  model, as recent commits do.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a `strictUtf8` flag to the full-read spec

In `src/core/read.ts`:

1. Add `import { isUtf8 } from 'node:buffer';` to the builtin-imports group at
   the top (Prettier's sort-imports plugin will order it; run Prettier after).
2. Change the `full` member of `ReadSpec` to
   `{ kind: 'full'; signal?: AbortSignal; strictUtf8?: boolean }`.
3. Give `readFullContent` a fifth parameter `strictUtf8: boolean` and, after
   the `readFileBufferWithLimit` call and before `toString`, add:

   ```ts
   // The binary probe samples only the first 512 bytes. A caller that writes the
   // text back must refuse any byte the decode would replace with U+FFFD.
   if (strictUtf8 && (!isUtf8(buffer) || buffer.includes(0))) {
     throw new FsError(
       ErrorCode.INVALID_INPUT,
       'Binary or non-UTF-8 file detected.',
       requestedPath,
     );
   }
   ```

4. In `readByMode`'s `case 'full'`, pass `spec.strictUtf8 === true` as the
   new fifth argument.

**Verify**: `npm run type-check:test` → exit 0.

### Step 2: Turn it on for editable reads only

In `src/core/fs.ts` `readEditableText`, change the spec object to:

```ts
const { content } = await readFileWithStats(filePath, validPath, stats, {
  kind: 'full',
  strictUtf8: true,
  ...(options?.signal ? { signal: options.signal } : {}),
});
```

Do not change `GuardedFileSystem.readFile` (the `read` tool's path).

**Verify**: `node --test __tests__/core-fs.test.ts` → all pass (the existing
`readEditableText rejects binary files` test must still see the message
`'Binary file detected.'` — the 512-byte probe runs first and still produces
it for a PNG).

### Step 3: Add the unit test

In `__tests__/core-fs.test.ts`, inside `describe('Editable text loading', …)`,
after the `binary probe accepts UTF-8 split at the sample boundary` test, add a
test named `readEditableText rejects non-UTF-8 bytes past the binary probe`:

- Write `Buffer.concat([Buffer.alloc(600, 0x61), Buffer.from('\ncaf'), Buffer.from([0xe9]), Buffer.from('\n')])`
  to `join(tmpDir, 'latin1-late.txt')`.
- `assert.rejects(fs.readEditableText(filePath), (error) => isFsError(error) && error.code === ErrorCode.INVALID_INPUT && error.message === 'Binary or non-UTF-8 file detected.')`.
- Also assert `(await fs.readFile(filePath, { kind: 'full' })).content` does
  **not** throw and ends with `caf`, then the replacement character U+FFFD,
  then a newline (in TypeScript source write the escape sequence
  backslash-u-FFFD, not a pasted glyph) — this pins that the `read` path is
  unchanged.
- Add a second case in the same test for a UTF-16 LE file:
  `Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello\n', 'utf16le')])`
  → `readEditableText` rejects with the same code and message.

**Verify**: `node --test --test-name-pattern="past the binary probe" __tests__/core-fs.test.ts` → 1 test, pass.

### Step 4: Add the tool-level regression test

In `__tests__/tools.test.ts`, next to the existing test
`replace_text leaves binary and non-UTF-8 files untouched` (around line 1690),
add `edit, patch and diff refuse a non-UTF-8 file and leave its bytes intact`:

- `const bytes = Buffer.concat([Buffer.from('a'.repeat(600) + '\nhello\n'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])]);`
  written to `join(tmpDir, 'nonutf8', 'late.txt')` (create the dir with
  `mkdir(..., { recursive: true })`; `mkdir` is already imported).
- `edit` with `{ path, edits: [{ oldText: 'hello', newText: 'bye' }] }` →
  `result.isError === true`, `failedSummary(result)?.results?.[0]?.error?.code === 'INVALID_INPUT'`,
  and `assert.deepStrictEqual(await readFile(path), bytes)`.
- `patch` with `{ path, diff: '--- f\n+++ f\n@@ -2,1 +2,1 @@\n-hello\n+bye\n' }`
  (line 1 is the 600 `a`s, line 2 is `hello`) → `isError === true` and the
  bytes are unchanged. The patch would apply cleanly to a UTF-8 file, so the
  refusal can only come from the new check.
- `diff` with `{ a: path, b: path }` → `isError === true`.

Model the assertions on `edit rejects an oldText that matches more than once`
(line ~574) for `edit`, and on `TC-FUNC-062` (line ~1097) for `patch`.

**Verify**: `node --test --test-name-pattern="non-UTF-8" __tests__/tools.test.ts` → 2 tests (the new one and the existing replace_text one), pass.

### Step 5: Format and run the full gate

`npx prettier --write src/core/read.ts src/core/fs.ts __tests__/core-fs.test.ts __tests__/tools.test.ts`

**Verify**: `npm run check` → exit 0.

## Test plan

- Unit (`__tests__/core-fs.test.ts`): late Latin-1 byte rejected by
  `readEditableText`; UTF-16 LE file rejected; `readFile` full on the same
  Latin-1 file still returns lossy content (unchanged behavior).
- Tool (`__tests__/tools.test.ts`): `edit`, `patch`, `diff` all return
  `isError` on the file, and the on-disk bytes are byte-for-byte unchanged.
- Existing tests that must stay green: `readEditableText rejects binary files`
  (message `'Binary file detected.'`), `binary probe accepts UTF-8 split at the
sample boundary`, every `edit`/`patch`/`diff` test in `tools.test.ts`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `node --test --test-name-pattern="past the binary probe" __tests__/core-fs.test.ts` → 1 pass
- [ ] `node --test --test-name-pattern="non-UTF-8" __tests__/tools.test.ts` → 2 pass
- [ ] `grep -n "strictUtf8" src/core/read.ts src/core/fs.ts` shows the spec field, the `readFullContent` check, the `readByMode` pass-through, and the `readEditableText` call site
- [ ] `git status` shows only the four in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- An existing test fails because it edits, patches or diffs a file that is not
  valid UTF-8 and expects success — that is a behavior this plan changes on
  purpose; report which test rather than editing it.
- `readEditableText` turns out to have callers other than `edit.ts`,
  `patch.ts`, `diff.ts` (`grep -rn "readEditableText" src`) — a new caller may
  need the lossy behavior.
- The fix seems to need a change in `src/core/mime.ts`.

## Maintenance notes

- Any new tool that reads text in order to write it back must use
  `readEditableText` (or pass `strictUtf8: true`), not `readFile`.
- `diff` now errors on non-UTF-8 input instead of producing a misleading diff.
  If users need to diff legacy-encoded files, that is a feature (decode with a
  named encoding), not a reason to relax this check.
- Reviewer: confirm `read` output is unchanged for non-UTF-8 files — only the
  editable path is strict.
