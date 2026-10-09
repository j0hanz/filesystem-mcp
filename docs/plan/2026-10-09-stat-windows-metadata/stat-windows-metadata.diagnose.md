# Diagnose: stat misreports Windows directories as empty and world-writable (#56)

Issue: <https://github.com/j0hanz/filesystem-mcp/issues/56>

## Repro

At `d193a294` (v2.7.3), Windows 11, Node 24.15.0, `dist/index.js` over stdio
(MCP client from `@modelcontextprotocol/client`). Root is a temp directory
holding two files, `a.txt` (5 B) and `b.txt` (5 B).

`stat { path: <root> }` returns, on every run:

```json
{
  "results": [{ "path": "...\\ai-test-56", "value": {
    "name": "ai-test-56", "type": "directory", "size": 0,
    "permissions": "rw-rw-rw-", "isHidden": false, "...": "timestamps" } }],
  "summary": { "total": 1, "succeeded": 1, "failed": 0 },
  "fileCount": 0,
  "dirCount": 1
}
```

Identical in shape and values to the issue's paste. The directory is not
empty and has normal NTFS ACLs. The reporter's model read `fileCount: 0` as
"no files inside" and `rw-rw-rw-` as "writable by owner, group and others";
the tool output supports both readings, so this is a tool defect, not a model
one.

Raw Node probes on the same machine:

| Path               | `stats.mode` (octal) | `stats.size` |
| :----------------- | :------------------- | :----------- |
| directory, 2 files | `40666`              | 0            |
| directory `+H`     | `40666`              | 0            |
| `.dotdir`          | `40666`              | 0            |
| `ro.txt` (`+R`)    | `100444`             | 3            |
| `run.exe`          | `100666`             | 3            |

## Pinned cause

Three fields in `src/tools/stat.ts` are honest on POSIX and misleading on
Windows, and one is misleading everywhere:

1. **`fileCount` / `dirCount`** (`stat.ts:127-141`, emitted at `:176`). These
   count the *result rows* by type: one directory stat'd = `dirCount: 1,
   fileCount: 0`. Nothing in the name or the description says so, and a
   single-path call always yields `0/1` or `1/0`. Next to a directory entry,
   `fileCount: 0` reads as "contains no files". This is the line that made the
   reporter's model say "empty", and it is platform-independent. Added in
   `a9818877` (stat batch refactor); no test covers it.

2. **`permissions`** (`stat.ts:33-40`, `getPermissions(stats.mode)`). It
   renders the nine POSIX bits of `stats.mode`. On Windows libuv synthesizes
   that mode with no ACL lookup, in `src/win/fs.c` `fs__stat_handle`
   ([libuv v1.x, lines 1954–1967](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c)):
   `FILE_ATTRIBUTE_READONLY` → `r--r--r--`, otherwise `rw-rw-rw-`, for every
   file and directory, regardless of owner or ACL. So `rw-rw-rw-` is not
   "everyone can write"; it only means "the read-only attribute is clear".

3. **`size: 0`** for directories (`stat.ts:54`). Same libuv routine sets
   `st_size = 0` for anything with `FILE_ATTRIBUTE_DIRECTORY` (line 1956).
   The description already says a directory "reports its own entry, not its
   contents", but a literal `0` next to `fileCount: 0` corroborates the
   "empty" reading. On ext4 the same field says `4096`, which is just as
   unrelated to contents.

4. **`isHidden`** (`stat.ts:61`) is `name.startsWith('.')`. A directory with
   the Windows hidden attribute reports `isHidden: false`. Not in the issue,
   but the same class of bug (POSIX convention applied to Windows metadata).

The guarded `fs.statDetailed` / `lstat` path (`src/core/fs.ts`) passes
`node:fs` stats through unchanged; nothing in this repo rewrites `mode` or
`size`. The cause is the rendering in `stat.ts`, not the FS layer.

## Verdict

Confirmed, reproduces on demand (every run). The server returns values that
are technically what `node:fs` reports, but the output shape invites exactly
the two wrong conclusions in the issue:

- "the folder is empty": driven by `fileCount: 0` (result-row count, a naming
  bug) reinforced by `size: 0` (libuv Windows constant);
- "rw-rw-rw- for owner/group/others": driven by `permissions` rendering a
  mode libuv fabricates from a single attribute bit on Windows.

Suggested fix direction for write-plan (not implemented here):

- Rename or drop `fileCount`/`dirCount`. If batch type counts are worth
  keeping, move them under `summary` with names that cannot be read as
  contents (`summary.directories`, `summary.files`), or omit them when
  `total === 1`.
- On `process.platform === 'win32'`, replace `permissions` with
  `readOnly: boolean` (the only fact libuv encodes), or omit it.
  Alternatively emit `permissions` only when the mode is meaningful.
- For directories, omit `size` or set it to `null`, so no number can be
  mistaken for contents. Pair with a sentence in the description pointing to
  `list` for contents (`list` already returns `totalEntries`).
- `isHidden`: `node:fs` does not expose `FILE_ATTRIBUTE_HIDDEN`, so either
  document the dot-prefix semantics in the description or drop the field on
  win32.

## Handoff

- write-plan: cause above; repro = `stat` on a two-file directory on win32
  must not yield `fileCount: 0` as a top-level field, and must not render
  POSIX permission triads from a synthesized mode.
- write-qa: regression-worthy. A platform-neutral test can assert the output
  shape (`fileCount` absent or namespaced); a win32-gated test can assert
  `permissions` is absent / `readOnly` present. Both are fast and in-memory
  via `__tests__/helpers.ts`.
