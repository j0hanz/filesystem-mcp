# Plan 105: A binary read never returns more than the size limit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/core/fs.ts __tests__/core-fs.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

`GuardedFileSystem.read` returns a file's bytes when the caller asks for
binary content (`binary: 'raw'`, `'media'` or `'allow'`). It checks the size
limit against a stat taken _before_ the file is opened, then reads the open
handle to end of file with no limit. A file that grows between the two (a log
being appended to, or a file replaced by a larger one) is read whole: up to
Node's 2 GiB buffer limit goes into memory and into the response. The limit
exists to prevent exactly that.

## Current state

`src/core/fs.ts`, method `read` (lines 1747-1787):

```ts
    const validPath = await this.#guard('read', filePath);
    signal?.throwIfAborted();
    const stats = await this.#statVerified(validPath, filePath, signal);
    assertFileStats(filePath, stats);
    await using handle = await this.#openVerified(validPath, filePath, signal);
    const probe = await readProbe(handle, signal);
    // ...
    const maxSize = options.maxSize ?? getMaxTextFileSize();

    if (bytes) {
      if (stats.size > maxSize) throw createTooLargeError(stats.size, maxSize, filePath);
      let content: Buffer;
      try {
        content = await fsReadFile(handle, signal ? { signal } : undefined);
      } catch (error) {
        // Node wraps even a TimeoutError signal reason in AbortError.
        if (error instanceof Error && error.name === 'AbortError') signal?.throwIfAborted();
        throw error;
      }
      return {
        type: 'bytes',
        content,
        // ...
```

`stats` comes from `#statVerified`, a separate stat (and on Linux a separate
open) from `handle`. `createTooLargeError(bytesRead, maxSize, requestedPath)`
is in `src/core/errors.ts:345`.

Tests for this method live in `__tests__/core-fs.test.ts`; existing calls
look like `fs.read(filePath, { binary: 'raw' })` (for example line 461). The
file already imports `fsPromises`, `mock`, `syncBuiltinESMExports`,
`writeTestFile`, `fsErrorMatcher` and `ErrorCode`.

## Commands you will need

| Purpose         | Command                                                      | Expected on success |
| :-------------- | :----------------------------------------------------------- | :------------------ |
| Build           | `npm run build`                                              | exit 0              |
| One test file   | `node --test --test-timeout=60000 __tests__/core-fs.test.ts` | all pass            |
| Read tool tests | `node --test --test-timeout=60000 __tests__/read.test.ts`    | all pass            |
| Full check      | `npm run check`                                              | exit 0              |

## Scope

**In scope**:

- `src/core/fs.ts` (the `if (bytes)` branch of `read` only)
- `__tests__/core-fs.test.ts` (one new test, plus updating `SDK-AUDIT-CANCEL-003`, `005`, `006` to intercept `handle.read` instead of `fsPromises.readFile`)
- `CHANGELOG.md` (one line under `## [Unreleased]`)
- `plans/README.md` (status row)

**Out of scope**:

- The text branch (`readByMode`): it has its own limits in `src/core/read.ts`.
- `#statVerified`, `#openVerified`, `readSaved`, `readText`.
- `src/tools/read.ts`.

## Git workflow

- Branch: `fix/binary-read-size-cap`
- One commit: `fix(read): bound a binary read by the size limit on the open handle`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing test

Add a test next to the existing `binary: 'raw'` tests in
`__tests__/core-fs.test.ts`:

- Write a 10-byte file with `writeTestFile`.
- Call `fs.read(filePath, { binary: 'raw', maxSize: 16, beforeBody: () => { appendFileSync(filePath, Buffer.alloc(64, 0x61)); } })`.
  `beforeBody` runs after the stat and the open and before the body is read,
  so the file grows to 74 bytes inside the window. Import `appendFileSync`
  from `node:fs`.
- Assert the call rejects with `fsErrorMatcher(ErrorCode.TOO_LARGE)`.

**Verify**: `node --test --test-timeout=60000 --test-name-pattern="grows" __tests__/core-fs.test.ts`
→ the new test FAILS (the read resolves with 74 bytes). Name the test so the
pattern matches, for example `a binary read of a file that grows past maxSize is refused`.

### Step 2: Read at most `maxSize + 1` bytes

Replace the body of the `if (bytes)` branch so the read is bounded by the
handle, not by the earlier stat. Keep the early `stats.size > maxSize` refusal
(it avoids opening work for an obviously large file) and keep the abort
handling. Target shape:

```ts
    if (bytes) {
      if (stats.size > maxSize) throw createTooLargeError(stats.size, maxSize, filePath);
      // The stat above is older than this handle: a file that grew since must not be read whole.
      const buffer = Buffer.allocUnsafe(maxSize + 1);
      let filled = 0;
      try {
        while (filled < buffer.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
          signal?.throwIfAborted();
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
      } catch (error) {
        // Node wraps even a TimeoutError signal reason in AbortError.
        if (error instanceof Error && error.name === 'AbortError') signal?.throwIfAborted();
        throw error;
      }
      if (filled > maxSize) throw createTooLargeError(filled, maxSize, filePath);
      const content = buffer.subarray(0, filled);
      return {
        // unchanged fields
```

`readProbe(handle, signal)` has already run on this handle. Open
`src/core/read.ts`, find `readProbe`, and check whether it reads at an
explicit position (a number) or the current position (`null`). If it uses an
explicit position, the file position is still 0 and the loop above is
correct with `null`. If it advances the position, pass an explicit running
position (`filled`) instead of `null`.

If `fsReadFile` is no longer used anywhere else in `fs.ts` after this change,
remove it from the import list (lint will tell you).

Also update `SDK-AUDIT-CANCEL-003`, `SDK-AUDIT-CANCEL-005`, and `SDK-AUDIT-CANCEL-006`
in `__tests__/core-fs.test.ts` (around lines 107–164): they currently mock
`fsPromises.readFile`, which the bounded loop no longer calls. Wrap
`fsPromises.open` with `t.mock.method(fsPromises, 'open', ...)` so the returned
`FileHandle`'s `read` method triggers `controller.abort(reason)` (for `003`/`005`)
or rejects with `failure` (for `006`) on the first `handle.read` call, and remove
the `nativeSignal` assertion (since `FileHandle.read` does not accept an `AbortSignal`).

**Verify**: `node --test --test-timeout=60000 __tests__/core-fs.test.ts __tests__/read.test.ts`
→ all pass, including the new test.

### Step 3: Changelog and full check

Under `## [Unreleased]` in `CHANGELOG.md`, add under `### Fixed` (create the
heading after `### Changed` if missing):

```md
- **read**: a binary read of a file that grows while it is being read is refused with `TOO_LARGE` once it passes the size limit; before, the whole file was returned.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- The new growth test from Step 1.
- Existing `binary: 'raw'` tests (abort, timeout, content equality) must still
  pass; they cover the unchanged paths.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] The new test passes and failed before Step 2
- [ ] `git diff --stat` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

- The `if (bytes)` branch does not match the excerpt.
- `maxSize` can be `Infinity` or larger than 2 GiB at this call site
  (`Buffer.allocUnsafe` would throw). Check every caller that passes
  `maxSize` (`grep -n "maxSize" src/tools/read.ts src/resources.ts`); if one
  passes an unbounded value, stop and report.
- An existing abort or timeout test for `binary: 'raw'` other than `SDK-AUDIT-CANCEL-003`, `005`, `006` fails, or `003`/`005`/`006` still fail after updating their mock to `handle.read`.

## Maintenance notes

- Allocating `maxSize + 1` bytes up front is acceptable at the default limit
  (10 MiB). If the limit is raised to its 100 MiB maximum and memory matters,
  allocate `min(stats.size, maxSize) + 1` and grow once.
- Reviewer: confirm the returned `content` for an unchanged file is
  byte-identical to before (existing tests compare content).
