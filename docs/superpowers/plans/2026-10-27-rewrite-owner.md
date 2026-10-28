# Rewrite owner implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the **Rewrite** one owner, `src/core/rewrite.ts`, and give
the content verdict one reader, `readText` in `src/core/scan.ts`. `edit`,
`patch` and `replace_text` each lock, read, write, stat and report a file
in their own way today, and they disagree. A dry run of `edit` reports the
preview time as `modified`; `replace_text` stats only its first changed
file, after the whole scan; `create` with `append` reports 1970-01-01 when
its stat fails. `replace_text` decides a file is binary only after the
search text matched it, by a rule `read` does not use, and `search_text`
uses a third rule. This plan finishes ADR-005's content verdict, the "PR 2"
that the scan owner plan reserved.

**Architecture:** `readText(fs, path, signal)` is the one guarded read that
returns a verdict instead of throwing: `text`, `binary`, `undecodable` or
`tooLarge`. It opens through `fs.open` (validation, `O_NOFOLLOW`, the
descriptor re-check), checks the size against `getMaxTextFileSize()`, reads
the bytes in the chunked, signal-checked loop that `search_text` uses
today, then applies `read`'s binary rule to the leading bytes and a strict
UTF-8 check to the rest. `readNamedText` is its face for a file the client
names: it throws `readEditableText`'s refusals, which it replaces.
`rewrite.ts` builds on `readText` and `GuardedFileSystem` (`lockForWrite`,
`writeFile`, `stat`). It owns lock-or-dry-run, the read, the atomic write,
a stat after every real write, the **modified** rule and one written-file
report. A tool supplies only a content transform. `fs.ts` gets no new
policy; it loses `readEditableText`.

**Tech Stack:** TypeScript (Node ESM, `.ts` imports), Node built-in test
runner, `node:buffer` `isUtf8`.

**Spec:** `docs/adr/005-one-scan-rule-for-every-walking-tool.md` (content
classes, "a file the client names is not a scan") and the **Rewrite** and
**Scan** entries in `GLOSSARY.md`. The decisions come from the 2026-10-27
grilling of the rewrite candidate.

## Design

These decisions are settled. Do not reopen them.

**Who is behind the Rewrite:**

| Tool           | Today                                                                                             | After                                      |
| :------------- | :------------------------------------------------------------------------------------------------ | :----------------------------------------- |
| `edit`         | lock `src/tools/edit.ts:480-485`, read `:343-345`, write `:368-371`, modified `:380-387`          | `rewriteFile`, `tool: 'edit'`              |
| `patch`        | lock `src/tools/patch.ts:61-65`, read `:68-72`, write `:136-139`, modified `:141-147`             | `rewriteFile`, `tool: 'patch'`             |
| `replace_text` | lock `src/tools/replace-text.ts:322-331`, own read `:355-385`, one stat after the scan `:658-676` | `rewriteEntry`                             |
| `diff`         | `fs.readEditableText` at `src/tools/diff.ts:40-44`                                                | `readNamedText`; reads only, not a Rewrite |
| `create`       | own write path `src/tools/create.ts:294-391`                                                      | not a Rewrite; shares the modified rule    |

**Verdict per caller.** `readText` decides in this order: size, then
`read`'s binary rule on the first `MIME_SAMPLE_SIZE` bytes (known binary
extension, UTF-16 BOM, `isBinarySample`), then strict UTF-8 (`isUtf8` and
no NUL anywhere). The size comes first because `search_text` and
`readEditableText` both check it first today. Nothing matches before the
verdict.

| Verdict                          | `edit`, `patch`, `diff` (named)                                         | `replace_text` walked   | `replace_text` named                                                   | `search_text` (walked or named)               |
| :------------------------------- | :---------------------------------------------------------------------- | :---------------------- | :--------------------------------------------------------------------- | :-------------------------------------------- |
| `text`                           | transform runs                                                          | transform runs          | transform runs                                                         | searched                                      |
| `binary`, by extension or sample | `INVALID_INPUT` `Binary file detected.`                                 | `skippedBinary`         | failure row, `INVALID_INPUT` `Binary or non-UTF-8 file detected.`      | `skippedBinary`                               |
| `binary`, UTF-16 BOM             | `INVALID_INPUT` `UTF-16 text file detected; convert it to UTF-8 first.` | `skippedBinary`         | failure row, as above                                                  | `skippedBinary`                               |
| `undecodable`                    | `INVALID_INPUT` `Binary or non-UTF-8 file detected.`                    | `skippedBinary`         | failure row, as above                                                  | searched lossily; with a NUL, `skippedBinary` |
| `tooLarge`                       | `TOO_LARGE` `File too large for <tool> (<n> bytes > <max> bytes)`       | `skippedTooLarge` (new) | failure row, `TOO_LARGE` `File exceeds size limit (<n> > <max> bytes)` | `skippedTooLarge` (unchanged)                 |
| not a regular file               | `NOT_FILE` `Not a regular file`                                         | n/a (`onlyFiles`)       | n/a                                                                    | n/a                                           |

- `replace_text` counts `undecodable` in `skippedBinary`. ADR-005 says only
  that it skips such a file, because it must write UTF-8 back, and adds no
  counter. A new counter would split one reason in two.
- The named-file messages are today's, byte for byte. `edit`, `patch` and
  `diff` keep `readEditableText`'s; `replace_text` keeps its own
  (`replace-text.ts:363`, `:373`). `tools.test.ts:3185` and `:3221` pin
  the `replace_text` ones.
- `search_text` keeps its NUL rule for a file whose leading bytes pass:
  `grep -I` and today's `search.ts:373-376` skip a NUL anywhere. Other bad
  bytes past the leading bytes are read lossily (ADR-005).
- The RE2 input cap is not `tooLarge`. A file over `RE2_MAX_INPUT_BYTES`
  in regex mode stays a `TOO_LARGE` failure row in `replace_text`
  (`tools.test.ts:3164`) and stays `skippedTooLarge` for an over-long line
  in `search_text`.

**The modified rule (one rule, `rewrite.ts`):**

| Case                                      | `modified`                      |
| :---------------------------------------- | :------------------------------ |
| Dry run, or a real run that wrote nothing | the mtime read with the content |
| Real run that wrote                       | the post-write stat's mtime     |
| Real run that wrote, stat failed          | the write time                  |

Never EPOCH, never undefined, never the preview time. Today `edit` breaks
the first row (`edit.ts:384`, the preview time) and `create` breaks the
last (`create.ts:369`, EPOCH). `patch` already keeps it (`patch.ts:144`,
`:146`). A real `edit` with no applied edit wrote nothing, so it reports
the mtime it read; today it stats the unchanged file, which gives the same
time.

**Line endings stay in the transforms.** `edit`'s CRLF conversion
(`edit.ts:289-314`) and jsdiff's `autoConvertLineEndings` in `patch` stay
where they are. `replace_text` stays verbatim. No visible EOL change.

**Interfaces.**

`src/core/read.ts` (read's rule, one owner of its refusals):

```ts
/** read's binary rule on a file's leading bytes; undefined for text. */
export function binaryKind(validPath: string, probe: Buffer): 'binary' | 'utf16' | undefined;
/** The refusal `read`, `edit`, `patch` and `diff` give for a binary verdict. */
export function binaryRefusal(kind: 'binary' | 'utf16', filePath: string): FsError;
export const NOT_UTF8_MESSAGE = 'Binary or non-UTF-8 file detected.';
```

`src/core/scan.ts`:

```ts
export type TextVerdict =
  | { readonly kind: 'text'; readonly bytes: Buffer; readonly stats: Stats }
  | { readonly kind: 'undecodable'; readonly bytes: Buffer; readonly stats: Stats }
  | { readonly kind: 'binary'; readonly utf16: boolean }
  | { readonly kind: 'tooLarge'; readonly size: number };

/** The one content verdict: guarded open, size, read's binary rule, strict UTF-8. Never decodes. */
export async function readText(
  fs: GuardedFileSystem,
  path: string,
  signal?: AbortSignal,
): Promise<TextVerdict>;

/** A file the client named: any verdict but text fails the call with today's refusal. */
export async function readNamedText(
  fs: GuardedFileSystem,
  filePath: string,
  options?: { readonly signal?: AbortSignal | undefined; readonly tool?: string },
): Promise<{ validPath: string; content: string; stats: Stats }>;
```

A verdict carries bytes, not a string. `search_text` tests a literal
needle against the bytes before it decodes anything, and decoding every
walked file would cost it that.

`src/core/rewrite.ts`:

```ts
export interface RewriteRequest {
  readonly fs: GuardedFileSystem;
  /** Locked and written as given, as each caller does today. */
  readonly path: string;
  readonly dryRun: boolean;
  readonly signal?: AbortSignal | undefined;
  readonly transport?: Transport;
}

/** `write: false` reports without writing (an edit that applied nothing). */
export interface Change<T> {
  readonly content: string;
  readonly result: T;
  readonly write: boolean;
}

export type WrittenFileReport = WrittenFileMeta & {
  readonly validPath: string;
  readonly modified: string;
};

export interface Rewritten<T> {
  readonly kind: 'text';
  readonly validPath: string;
  readonly before: string;
  readonly after: string;
  readonly result: T;
  readonly written: boolean;
  readonly modified: string;
  /** Built on demand: replace_text links only its walk-first file. */
  report(): WrittenFileReport;
}

export type Skipped =
  | { readonly kind: 'binary' | 'undecodable' }
  | { readonly kind: 'tooLarge'; readonly size: number };

/** A file the client named (edit, patch): readNamedText's refusals fail the call. */
export function rewriteFile<T>(
  request: RewriteRequest & { readonly tool: string },
  transform: (content: string) => Change<T> | Promise<Change<T>>,
): Promise<Rewritten<T>>;

/** A walked file (replace_text): a non-text verdict comes back untransformed; undefined writes nothing. */
export function rewriteEntry<T>(
  request: RewriteRequest,
  transform: (content: string, bytes: Buffer) => Promise<Change<T> | undefined>,
): Promise<Rewritten<T> | Skipped | undefined>;

/** The modified rule after a real write. */
export function modifiedAfterWrite(stats: Stats | undefined, writtenAt: Date): string;
/** Post-write stat for advisory metadata; undefined when it fails. */
export function statAfterWrite(
  fs: GuardedFileSystem,
  validPath: string,
): Promise<Stats | undefined>;
```

Both entry points share one private `run`. A real run does all of this
inside `fs.lockForWrite(path, …)`: read, transform, then, when
`change.write`, `fs.writeFile(path, content, { signal })` (undo Capture
unchanged), `writtenAt = new Date()`, `statAfterWrite`, and
`modifiedAfterWrite`. A dry run does the same steps without the lock and
without the write. `report()` returns
`{ validPath, modified, ...buildWrittenFileMeta({ validPath, content: after, dryRun, lastModified: modified, transport }) }`.

## Global Constraints

- `npm run check` passes after every task's commit. Export only what a
  caller or a test imports; knip flags the rest.
- `__tests__/contract.test.ts.snapshot` stays unchanged. Never run
  `--test-update-snapshots` for this work. No tool publishes an
  `outputSchema`, so `skippedTooLarge` under `replace_text`'s `_meta` does
  not touch it. If `contract.test.ts` fails, stop and report; do not
  update the snapshot.
- Out of scope: `create`'s confirm-then-lock swap gap, ADR-005's
  `maxResults` to `maxMatches` rename, the `TOO_LARGE` wording in
  `get-help`, and anything in `src/core/outbound.ts` beyond calling it.
- Keep every MCP-level tool test. Flip only the assertions this change
  moves, and name them in the commit body.
- Tests that need POSIX mode bits skip with
  `if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('needs POSIX permissions as non-root');`.
  Verify them once in WSL with fixtures in `/tmp`: run a script file that
  starts with `source ~/.nvm/nvm.sh`, through
  `wsl -- bash /mnt/c/<path>/script.sh`.
- Do not touch the versions in `package.json`, `server.json`,
  `mcpb/manifest.json`, `.codex-plugin/plugin.json` or
  `.cursor-plugin/plugin.json`.
- Work on branch `refactor/rewrite-owner`.

## Review Focus

1. **A dry run takes no lock and writes nothing.** Covered by Task 3's
   `dry run neither locks nor writes`, which holds the file's lock while
   the dry run completes.
2. **A failed write in `replace_text` stays a failure row.** `processEntry`
   sets `write.started` when its transform returns a change, the last step
   before `fs.writeFile`. A write error after that must not be rethrown as
   inaccessible. Covered by GUARD-009 at `__tests__/guards.test.ts:285`
   (POSIX; run it in WSL).
3. **`search_text` reads no slower.** `readText` takes over
   `search.ts:342-370` unchanged: one `fs.open`, one `fstat`, the read of
   exactly that size in `READ_CHUNK_BYTES` chunks with a signal check
   before each. The binary probe is a `subarray` of the bytes already read,
   so no file costs an extra syscall.
4. **The named-file refusals did not move.** Covered by the moved
   `readEditableText` cases (Task 2) and `tools.test.ts:3185`, `:3221`,
   `:3640`.
5. **`search_text`'s binary rule changed on purpose.** A short Latin-1
   file is now `skippedBinary`, because its first bytes fail
   `isBinarySample`, as `read` already says. That flips
   `core-fs.test.ts:841-866`; see Task 1.
6. **The mode survives a real write.** `fs.writeFile` carries it
   (`fs.ts:364-371`); no test covered that. Task 3 adds one.

---

### Task 1: `readText`, and `search_text` reads through it

**Files:**

- Modify: `src/core/read.ts`.
  - Add `binaryKind` and `binaryRefusal` (§ Interfaces), taken from
    `assertNotBinary` (`:433-457`). `binaryKind` returns `'binary'` for a
    known binary extension or `isBinarySample(probe)`, `'utf16'` for
    `hasUtf16Bom(probe)`, checked in today's order: extension, BOM,
    sample.
  - `assertNotBinary` reads the probe, then throws
    `binaryRefusal(kind, filePath)` when `binaryKind` returns one. It now
    reads the 512-byte probe of a known binary extension too; `read` falls
    back to `binary: true` on the same refusal.
  - Add `NOT_UTF8_MESSAGE`; use it at `:416`.
- Modify: `src/core/scan.ts`. Add `TextVerdict` and `readText`. Move
  `READ_CHUNK_BYTES` (`search.ts:62`) and the read loop
  (`search.ts:346-370`) into it, with their comments. Then
  `binaryKind(path, bytes.subarray(0, MIME_SAMPLE_SIZE))`, then
  `!isUtf8(bytes) || bytes.includes(0)` gives `undecodable`.
- Modify: `src/core/search.ts`.
  - `scanFile` (`:339-376`) calls
    `readText(scanCtx.fs, entryPath, scanCtx.signal)`. `tooLarge` and
    `binary` map to today's `FileScan` kinds; an `undecodable` verdict
    whose bytes hold a NUL is `binary`; any other verdict's `bytes` is the
    `buffer` the rest of `scanFile` already uses.
  - Drop `ScanContext.maxFileSize` (`:329`, `:461`, `:473`) and the
    imports that go unused.
- Modify: `__tests__/core-fs.test.ts:841-866`. Rename it
  `searchContent skips binary files by read's rule and strips CR`. The
  `latin1.txt` file (`caf\xe9` inside its first 512 bytes) is now binary:
  assert `skippedBinary === 2` and that the literal search matches only
  `crlf.txt`.
- Modify: `CHANGELOG.md` `## [Unreleased]` `### Changed`:
  - **`search_text` skips every file `read` calls binary.** Before, it
    skipped only a file with a NUL byte, so it searched a PDF or a short
    Latin-1 file that `read`, `edit` and `replace_text` refuse. A file
    whose first 512 bytes are text is still searched, its later bad bytes
    read lossily.
- Test: `__tests__/scan.test.ts`, new `describe('readText')`.

- [ ] **Step 1: Write failing verdict tests** in `scan.test.ts`, with
      `fs = new GuardedFileSystem(guard)`:
  - `readText text verdict carries bytes and stats`: `a.txt` with
    `'héllo\n'`; `kind === 'text'`, `bytes` equal the file,
    `stats.size === 7`.
  - `readText binary by extension`: `a.png` holding `'plain text'`;
    `{ kind: 'binary', utf16: false }`.
  - `readText binary by sample`: `b.txt` with a NUL at byte 3;
    `{ kind: 'binary', utf16: false }`.
  - `readText UTF-16 BOM`: `FF FE` plus `'hi'` in UTF-16LE;
    `{ kind: 'binary', utf16: true }`.
  - `readText undecodable past the probe`: 600 `a`s, then `0xe9`;
    `kind === 'undecodable'`. Same for a NUL at byte 600.
  - `readText too large`: under `withEnv({ FS_MAX_FILE_SIZE: String(MIB) })`,
    a file of `MIB + 1` bytes gives `{ kind: 'tooLarge', size: MIB + 1 }`.
  - `readText pre-aborted signal rejects`.
- [ ] **Step 2: Write the failing search test** in `core-fs.test.ts`, next
      to the flipped one: `searchContent searches bytes past the probe lossily`.
      A `.txt` of 600 `a`s, `\nNEEDLE caf`, `0xe9`, `\n` is matched; a
      `.txt` of 600 `a`s, `\nNEEDLE`, a NUL, `\n` is `skippedBinary`; a
      `.png` holding `NEEDLE` is `skippedBinary`. Then flip
      `core-fs.test.ts:841-866` as listed above.
- [ ] **Step 3: Run.**
      `npm test -- --test-name-pattern="readText|searchContent"`.
      Expected: FAIL. `readText` is not exported; the `.png` and
      `latin1.txt` are searched.
- [ ] **Step 4: Implement** the changes listed above.
- [ ] **Step 5: Run.** All these pass:
  - `npm test -- --test-name-pattern="readText|searchContent"`
  - `npm test -- --test-name-pattern="search_text"`
  - `npm test -- --test-name-pattern="H1 \+ H6"`
  - `npm test -- --test-name-pattern="binary"`
- [ ] **Step 6: Commit.**
      `refactor(search_text): read through the one content verdict`.
      Name the flipped `core-fs.test.ts` assertion in the body.

### Task 2: `readNamedText` replaces `readEditableText`

No visible change: every refusal keeps its code and text.

**Files:**

- Modify: `src/core/scan.ts`. Add `readNamedText`: `fs.stat(filePath)`,
  `assertFileStats` (`NOT_FILE`), then `readText(fs, validPath, signal)`.
  A `text` verdict returns
  `{ validPath, content: bytes.toString('utf8'), stats }`. Otherwise
  throw:
  - `tooLarge`: `FsError(TOO_LARGE, "File too large for <tool ?? 'edit'> (<size> bytes > <max> bytes)", filePath, { size, maxFileSize })`, as `fs.ts:644-652`;
  - `binary`: `binaryRefusal(utf16 ? 'utf16' : 'binary', filePath)`;
  - `undecodable`: `FsError(INVALID_INPUT, NOT_UTF8_MESSAGE, filePath)`.
- Delete: `GuardedFileSystem.readEditableText` (`src/core/fs.ts:638-665`).
- Modify: `src/core/read.ts`. With `readEditableText` gone, nothing passes
  `strictUtf8`. Remove it from `ReadSpec` (`:38`), `readFullContent`
  (`:405-420`) and `readByMode` (`:485`). `NOT_UTF8_MESSAGE` keeps its
  Task 1 home and loses this use.
- Modify the callers, keeping each `tool` label:
  - `src/tools/diff.ts:40-44`: `readNamedText(ctx.fs, args.a, { signal: ctx.signal, tool: 'diff' })`, and the same for `args.b`.
  - `src/tools/edit.ts:343-345`: `readNamedText(ctx.fs, filePath, { signal: ctx.signal })`.
  - `src/tools/patch.ts:69-72`: `readNamedText(ctx.fs, args.path, { signal: ctx.signal, tool: 'patch' })`.
- Modify: `src/tools/replace-text.ts:373`. Use `NOT_UTF8_MESSAGE`.
- Move: `__tests__/core-fs.test.ts:340-452` (`describe('Editable text loading')`)
  to `__tests__/scan.test.ts` as `describe('readNamedText')`. Rename each
  `readEditableText` to `readNamedText` and call
  `readNamedText(fs, path)`. The `fs.readFile` assertions inside
  `binary probe accepts UTF-8 split at the sample boundary` and
  `partial reads never combine UTF-8 bytes across line boundaries` stay in
  `core-fs.test.ts`; split those two tests so the `fs.readFile` half
  stays and the `readNamedText` half moves.
- Modify: `__tests__/core-fs.test.ts:168`. Drop the `readEditableText` row
  of the descriptor re-check table: `readNamedText` opens through
  `fs.open`, which the `open` row already covers.

- [ ] **Step 1: Move the tests first**, importing `readNamedText` from
      `../src/core/scan.ts`.
- [ ] **Step 2: Run.** `npm test -- --test-name-pattern="readNamedText"`.
      Expected: FAIL, not exported.
- [ ] **Step 3: Implement** the changes listed above. Check with
      `grep -rn "readEditableText\|strictUtf8" src __tests__` that nothing
      is left.
- [ ] **Step 4: Run.** All these pass:
  - `npm test -- --test-name-pattern="readNamedText"`
  - `npm test -- --test-name-pattern="edit|patch|diff"`
  - `npm run check:static`
- [ ] **Step 5: Commit.**
      `refactor(core): read a named text file through readText`

### Task 3: `rewrite.ts`, with `edit` and `patch` behind it

**Files:**

- Create: `src/core/rewrite.ts` (§ Interfaces). `statAfterWrite` is
  `postWriteStat` (`src/tools/batch.ts:71-79`) taking `fs` instead of
  `ctx`; it stays in `batch.ts` until Task 5. `modifiedAfterWrite` is
  `(stats?.mtime ?? writtenAt).toISOString()`.
- Modify: `src/tools/edit.ts`.
  - `run` (`:480-485`) drops its lock choice and calls `editOnce` directly.
  - `editOnce` (`:337-414`) calls
    `rewriteFile({ fs: ctx.fs, path: filePath, dryRun, signal: ctx.signal, transport: ctx.transport, tool: 'edit' }, transform)`.
    The transform runs `applyEdits`, throws the no-match error of
    `:357-366` on a real run with unmatched edits, and returns
    `{ content: editResult.content, result: editResult, write: editResult.appliedEdits > 0 }`.
  - After it returns: the `unifiedPatch` and `diffStatsFromPatch` of
    `:347-352`, from `done.before`, `done.after` and
    `basename(done.validPath)`; the dry-run `diff`; and the log line of
    `:372-376` when `done.written`.
  - The value is `{ path: report.validPath, ...fileMeta, modified: report.modified, … }`
    from `done.report()`. Delete `:380-394` and the `postWriteStat`
    import.
- Modify: `src/tools/patch.ts`.
  - `run` (`:61-65`) calls `applyPatchOnce` directly.
  - The transform is `:74-129` (parse, clamp, apply, the line-count
    backstop), returning `{ content: patched, result: { linesAdded, linesRemoved }, write: true }`.
  - The log line of `:138` runs when `done.written`. Delete `:136-154`
    except what builds the result from `done.report()`, and the
    `postWriteStat` import.
- Test: `__tests__/rewrite.test.ts` (new), with a real temp dir
  (`createTestRoot`, `makeGuard`, `new GuardedFileSystem(guard)`).
- Test: `__tests__/tools.test.ts`, next to `:2160`.

- [ ] **Step 1: Write failing interface tests** in `rewrite.test.ts`. The
      transform is `(c) => ({ content: c.toUpperCase(), result: 1, write: true })`
      unless a test says otherwise.
  - `dry run neither locks nor writes`: hold
    `fs.lockForWrite(path, () => held)` on an unresolved promise. A dry
    `rewriteFile` resolves while it is held, with `written === false`,
    `after` upper-cased, and the file's bytes unchanged.
  - `real run waits for the write lock`: same hold; the real run has not
    resolved after a `setImmediate`, and resolves with the file upper-cased
    once the hold is released.
  - `real run reports the written file`: `report()` has `validPath`,
    `size`, `lineCount`, `mimeType: 'text/plain'`, `kind: 'text'`, and
    `modified` equal to `(await stat(path)).mtime.toISOString()`.
  - `dry run reports the current mtime`: `utimes` the file to
    `2001-01-01T00:00:00Z`; a dry run's `modified` is
    `'2001-01-01T00:00:00.000Z'`. So is a real run whose transform returns
    `write: false`, and the file is not rewritten.
  - `a failed post-write stat reports the write time`: mock `fs.stat` to
    reject on its second call (the first is `readNamedText`'s). `modified`
    lies between a `Date` taken before the call and one taken after.
  - `a real write keeps the file mode` (POSIX skip): `chmod 0o600`, real
    run, `(await stat(path)).mode & 0o777 === 0o600`.
  - `rewriteFile refuses a non-text file with today's errors`: a `.png`
    (`Binary file detected.`), a UTF-16 BOM file, 600 `a`s then `0xe9`
    (`Binary or non-UTF-8 file detected.`), and under
    `FS_MAX_FILE_SIZE` a `MIB + 1` file with `tool: 'patch'`
    (`File too large for patch`). The transform never runs, and no file
    changes.
  - `rewriteEntry returns the verdict without transforming`: the same
    four files give `binary`, `binary`, `undecodable` and
    `{ kind: 'tooLarge', size: MIB + 1 }`.
  - `rewriteEntry writes nothing when the transform declines`: a
    transform returning `undefined` resolves `undefined`; the file is
    unchanged.
  - `a transform that throws writes nothing`: the error comes back and
    the file is unchanged.
- [ ] **Step 2: Write the failing tool test** in `tools.test.ts`:
      `edit dryRun reports the file's own modified time`. `utimes` a file
      to `2001-01-01T00:00:00Z`, run `edit` with `dryRun: true`, and
      assert `results[0].value.modified === '2001-01-01T00:00:00.000Z'`.
- [ ] **Step 3: Run.**
      `npm test -- --test-name-pattern="rewrite|dryRun reports the file's own"`.
      Expected: FAIL. The module is missing, and `edit` reports the
      preview time.
- [ ] **Step 4: Implement** the changes listed above. Add to `CHANGELOG.md`
      `### Fixed`:
  - **`edit` with `dryRun` reports the file's own modified time.** Before,
    `modified` was the time of the preview, although nothing was written.
- [ ] **Step 5: Run.** All these pass:
  - `npm test -- --test-name-pattern="rewrite|dryRun reports the file's own"`
  - `npm test -- --test-name-pattern="edit|patch"`
  - `npm test -- --test-name-pattern="H2"`
  - `npm test -- --test-name-pattern="undo"`
- [ ] **Step 6: Commit.**
      `refactor(core): give the Rewrite one owner for edit and patch`

### Task 4: `replace_text` behind the Rewrite

**Files:**

- Modify: `src/tools/replace-text.ts`.
  - `processEntry` (`:309-353`) calls
    `rewriteEntry({ fs, path: entryPath, dryRun, signal, transport }, transform)`.
    The transform is `matcher.testBuffer(bytes)`, then `matcher.replace`,
    and returns `undefined` on no match. When it returns a change it sets
    `write.started = true`; the write is the next step, so a failed write
    stays a failure row (Review Focus 2).
  - A `Skipped` outcome: on a walked file, `tooLarge` is
    `{ kind: 'tooLarge' }` and `binary` or `undecodable` is
    `{ kind: 'binary' }`. On a named file (`ctx.singleFile`) throw today's
    errors inside the `try`, so they stay failure rows:
    `createTooLargeError(size, getMaxTextFileSize(), entryPath)` and
    `FsError(INVALID_INPUT, NOT_UTF8_MESSAGE, entryPath)`.
  - Delete `readReplacementPlan` (`:355-385`), `ReplacementPlan`
    (`:289-293`) and `ReplaceContext.maxFileSize` (`:283`, `:540`, `:571`).
    `onChanged` and `patchWithinBudget` (`:426-443`) take the
    `Rewritten<number>`, diffing `before` against `after`.
  - `primary` (`:550`, `:604-607`) keeps `{ index, report }` instead of
    the content. Replace the stat and `buildWrittenFileMeta` of `:658-676`
    with `primary?.report().resourceLink`. Every written file is now
    stat'd right after its write, inside its lock.
  - Add `skippedTooLarge` to `EntryOutcome`, `ReplaceSummary`, the output
    type (`:97-108`) and `buildSearchAndReplaceStructuredResult`
    (`:520`), omitted when 0. Add
    `` ` · ${n} too large skipped` `` to the summary text after the
    binary count (`:707-709`), and count it in the zero-match hint's
    `incomplete` (`:749-753`).
  - Drop the imports that go unused (`isUtf8`, `readFileBufferWithLimit`,
    `buildWrittenFileMeta`).
- Modify: `__tests__/tools.test.ts:3202-3217`. Rename it
  `replace_text counts walked files over the text size limit in skippedTooLarge`.
  Assert `isError` is not true, `_meta.skippedTooLarge === 2`,
  `summary.failed === 0`, the text matches `/2 too large skipped/`, and
  both files still start with `FIND\n`. `:3185-3200` (a named file) is
  unchanged.
- Modify: `CHANGELOG.md` `## [Unreleased]`:
  - Under `### Changed`: **`replace_text` counts a binary file in
    `skippedBinary` whether or not the text appears in it.** Before, it
    counted one only when the search text matched its bytes, and in regex
    mode a binary file over 4 MiB failed with `TOO_LARGE`. A binary file
    you name now fails with `INVALID_INPUT` even when nothing in it
    matches.
  - Under `### Changed`: **`replace_text` counts a file over the text size
    limit in `skippedTooLarge`, as `search_text` does.** Before, each one
    was a `TOO_LARGE` failure row, and a run with nothing else to change
    reported an error. A file you name still fails with `TOO_LARGE`.
  - Under `### Fixed`: **`replace_text` stats each file right after it
    writes it.** Before, it stat'd only the first changed file, after the
    whole scan, so its link's `lastModified` could be a later writer's.
- Test: `__tests__/tools.test.ts`, next to `:3221`.

- [ ] **Step 1: Write failing tests.**
  - `replace_text counts a binary file without a match`: a dir with
    `text.txt` (`foo`) and `blob.bin` (bytes without `foo`). Assert
    `_meta.skippedBinary === 1`.
  - `replace_text refuses a named binary file without a match`: name
    `blob.bin`, search `zzz`. Assert `isError` and
    `results[0].error.code === 'INVALID_INPUT'`.
  - Flip `:3202-3217` as listed above.
- [ ] **Step 2: Run.**
      `npm test -- --test-name-pattern="replace_text counts|replace_text refuses a named binary"`.
      Expected: FAIL on all three.
- [ ] **Step 3: Implement** the changes listed above and the CHANGELOG
      entries.
- [ ] **Step 4: Run.** All these pass:
  - `npm test -- --test-name-pattern="replace_text"`
  - `npm test -- --test-name-pattern="GUARD-009"` (and once in WSL)
  - `npm test -- --test-name-pattern="zero-match|hint"`
- [ ] **Step 5: Commit.**
      `refactor(replace_text): rewrite each file through the Rewrite`.
      Name the flipped `tools.test.ts` assertion in the body.

### Task 5: `create` keeps the modified rule

**Files:**

- Modify: `src/tools/create.ts`.
  - Append: take `writtenAt = new Date()` right after `appendFile`
    resolves (`:314-316`). `:369` becomes
    `modified = modifiedAfterWrite(stats, writtenAt)`.
  - Overwrite: `:375-378` become `writtenAt = new Date()`,
    `fileStats = await statAfterWrite(ctx.fs, written.validPath)`,
    `modified = modifiedAfterWrite(fileStats, writtenAt)`; `created` keeps
    its fallback to the write time.
  - `created` on append (`:368`) keeps its EPOCH fallback. The modified
    rule does not cover a birth time, and an append did not create the
    file, so the write time would be wrong there.
- Delete: `postWriteStat` (`src/tools/batch.ts:71-79`) and its `Stats`
  import (`:1`). `create` was its last caller.
- Modify: `CHANGELOG.md` `### Fixed`:
  - **`create` with `append` reports the write time when it cannot stat
    the file afterwards.** Before, `modified` read 1970-01-01.
- Test: `__tests__/tools.test.ts`, next to `:545`.

- [ ] **Step 1: Write a failing test.**
      `create append reports the write time when the post-append stat fails`.
      Mock `GuardedFileSystem.prototype.appendFile` to set a flag after the
      real call resolves, and `GuardedFileSystem.prototype.stat` to reject
      once the flag is set. Assert `files[0].modified` lies between a
      `Date` taken before the call and one taken after.
- [ ] **Step 2: Run.**
      `npm test -- --test-name-pattern="create append reports the write time"`.
      Expected: FAIL, `modified` is `1970-01-01T00:00:00.000Z`.
- [ ] **Step 3: Implement** the changes listed above.
- [ ] **Step 4: Run.** `npm run check` passes. Then run
      `git diff --stat main -- __tests__/contract.test.ts.snapshot`; it
      must print nothing. Run `npm run test:coverage` once; the floors
      hold.
- [ ] **Step 5: Commit.**
      `fix(create): report the write time when the append stat fails`
