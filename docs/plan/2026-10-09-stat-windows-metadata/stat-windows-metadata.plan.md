# Plan: `stat` stops implying "empty" and "world-writable" for Windows directories

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `d193a294`, 2026-10-09.
> **Drift check (run first)**: `git diff --stat d193a294..HEAD -- src/tools/stat.ts __tests__/tools.test.ts`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

`stat` on a Windows directory that holds files returns `size: 0`,
`permissions: "rw-rw-rw-"` and a top-level `fileCount: 0`. A model reads that
as "empty, writable by everyone" (issue #56). The first two values are libuv
constants on Windows; the third counts result rows, not contents. After this
lands, `stat` emits no result-row type counts, omits `size` for directories,
and on win32 reports `readOnly` instead of a POSIX triad.
Requirements covered: none, this is a fix. Diagnosis:
[`stat-windows-metadata.diagnose.md`](stat-windows-metadata.diagnose.md).

## Current state

- [`src/tools/stat.ts:14-27`](../../../src/tools/stat.ts#L14-L27) `FileInfo`
  has `size: number`, `permissions: string`, `isHidden: boolean`.
- [`stat.ts:31`](../../../src/tools/stat.ts#L31)
  `type StatOutput = BatchResult<FileInfo> & { fileCount: number; dirCount: number };`
- [`stat.ts:33-40`](../../../src/tools/stat.ts#L33-L40) `getPermissions(mode)`
  renders the nine POSIX bits.
- [`stat.ts:50-64`](../../../src/tools/stat.ts#L50-L64) `buildFileInfoResult`
  returns `size: stats.size` and `permissions: getPermissions(stats.mode)`
  unconditionally.
- [`stat.ts:127-141`](../../../src/tools/stat.ts#L127-L141) `classifyTypeCounts`
  counts result rows by type; used at
  [`stat.ts:169`](../../../src/tools/stat.ts#L169) and emitted at
  [`stat.ts:176`](../../../src/tools/stat.ts#L176).
- [`stat.ts:147-150`](../../../src/tools/stat.ts#L147-L150) description:
  `'Get metadata without reading contents, like ls -ld: type, size (a directory reports its own entry, not its contents), ' + 'tokenEstimate, timestamps, permissions, MIME type guessed from the extension, and symlink target. ' + 'Also checks whether paths exist.'`
- No output schema is published for `stat`; `StatOutput` is a TypeScript type
  only, so removing fields does not change `tools/list`.
- Tests: [`tools.test.ts:2633-2646`](../../../__tests__/tools.test.ts#L2633-L2646)
  `TC-FUNC-015s` asserts a file's `size > 0`. Nothing asserts `fileCount`,
  `dirCount`, or `permissions`. Tool tests use `harness.client.callTool` with
  `tmpDir`, `writeTestFile`, `mkdir`, `writeFile`; imitate that block.
- Surface budget [`tools.test.ts:3391-3393`](../../../__tests__/tools.test.ts#L3391-L3393):
  19 000 full / 9 150 read-only chars; v2.7.3 measured 18 508 / 8 894.
- Upstream fact: libuv `src/win/fs.c` `fs__stat_handle` sets `st_size = 0` for
  directories and mode `0666` / `0444` from `FILE_ATTRIBUTE_READONLY` alone.

## Scope

**In scope**:

- [`src/tools/stat.ts`](../../../src/tools/stat.ts)
- [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts)

**Files out of scope**:

- [`CHANGELOG.md`](../../../CHANGELOG.md): stamped by the Release workflow.
- [`src/core/fs.ts`](../../../src/core/fs.ts): passes `node:fs` stats through;
  the defect is in rendering, not the FS layer.
- [`README.md`](../../../README.md): its `stat` row names "permissions"
  generically and stays true.

## Steps

### 1. Add the regression test (red)

In [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts), after
`TC-FUNC-015s`, add `stat on a directory does not read as empty or
world-writable (#56)`: `mkdir` a directory with two files, `stat` it, and
assert on `structuredContent`:

- no `fileCount` / `dirCount` keys at the top level;
- `value.type === 'directory'` and `'size' in value === false`;
- if `process.platform === 'win32'`: `value.permissions === undefined` and
  `value.readOnly === false`; else `typeof value.permissions === 'string'`
  and `value.readOnly === undefined`.

**Verify**: `npm test -- --test-name-pattern="#56"` → 1 fail (the new test), 0 pass.

### 2. Fix `stat.ts` (green)

- Delete `classifyTypeCounts`, its call, and `fileCount`/`dirCount` from
  `StatOutput` and the `structured` object.
- `FileInfo`: `size?: number`, `permissions?: string`, `readOnly?: boolean`.
- `buildFileInfoResult`: spread `size` only when `!stats.isDirectory()`; on
  `process.platform === 'win32'` spread `{ readOnly: (stats.mode & 0o222) === 0 }`,
  else `{ permissions: getPermissions(stats.mode) }`. Comment the libuv reason
  in one or two lines.
- Description: `'Get metadata without reading contents, like ls -ld: type, size (files only; use list for directory contents), ' + 'tokenEstimate, timestamps, permissions (readOnly on Windows), MIME type guessed from the extension, and symlink target. ' + 'Also checks whether paths exist.'`

**Verify**: `npm test -- --test-name-pattern="stat|TOOL-SURFACE"` → all pass.

## Done

- [ ] `npm run check` exits 0
- [ ] `git status --short` lists only `src/tools/stat.ts`,
      `__tests__/tools.test.ts`, and this effort directory

## STOP

- A [Current state](#current-state) excerpt does not match.
- `TOOL-SURFACE-002` fails after step 2: the description grew past budget;
  shorten the `(readOnly on Windows)` clause rather than widening the budget.
- Any test other than the new one fails after step 2 and still fails after
  one fix attempt.
- The fix appears to need `src/core/fs.ts` or an output schema.

## Notes

- `isHidden` keeps the dot-prefix meaning; `node:fs` does not expose the
  Windows hidden attribute. Deferred, noted in the diagnosis.
- Route: straight to run-plan. Two steps against two files already read in
  this session; the gates are the test runner.
