# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Path containment no longer folds non-ASCII case.** On Windows and macOS, a sibling folder whose name differs from a root only by a character JavaScript folds but NTFS does not (U+212A Kelvin sign, U+017F long s) passed the containment check, so every tool could read, write and delete outside the root. Containment now folds `A-Z` only.
- **Paths naming an NTFS alternate data stream are refused on Windows.** Before, `move` with `copy: true` could write a hidden `file.txt:stream`, and `create` failed with a raw `EINVAL` naming its temp file. Now every tool answers `INVALID_INPUT`, including reads of `file.txt::$DATA`, which used to alias `file.txt`.

### Fixed

- **A cancelled write to a hard-linked file no longer goes through.** Cancellation was checked only before the file was opened, so a write cancelled while the file was open still truncated it and wrote the new bytes. The check now also runs before the truncate, so both links keep their old content.
- **Concurrent writes through two links of one file no longer mix.** Writes through different names of a hard-linked file could interleave their truncate and write, leaving `BAAA` for a write of `AAAA` and one of `B`. In-place writes to one file now run one at a time, so the file ends with one of the two whole contents.
- **`replace_text` transforms a hard-linked file once per run.** Walking two names of one file rewrote its bytes twice, so `x` became `xxx` where the dry run had previewed `xx`. Each file is now handled once, through its first name, and the dry run reports what the live run does.
- **`replace_text` refuses a replacement that would grow a file past the max file size.** A ``$` `` or `$'` expansion, or a replacement longer than its match, could turn a 44 KB file into tens of MB. Such a file now fails with `TOO_LARGE` and stays unchanged, in dry runs too. The scan stops building the result as soon as it crosses the limit.
- **`move` with a missing source reports `NOT_FOUND`.** Before, it reported `ACCESS_DENIED` "Move failed for ..." and suggested `list_roots`. `copy: true` already reported `NOT_FOUND`.
- **`create` measures its size cap in UTF-8 bytes.** Before, it counted UTF-16 units, so a file of multibyte text could be up to 3 × `FS_MAX_FILE_SIZE` bytes, and `read` and `edit` then refused it. The per-file and combined-batch caps now count the bytes written to disk, and the batch refusal says "bytes" instead of "characters".
- **A batch `read` with `head`, `tail` or `startLine`/`endLine` charges each slice the bytes it returns.** Before, it charged the whole file's size, so a slice of a file over the 512 KiB batch budget was skipped as `TOO_LARGE`, with advice to use the `head`/`tail` options it already used.
- **`edit` with `ignoreWhitespace` keeps the file's indentation.** The flexible match absorbed the matched lines' indentation, and newText was spliced in as written, so a block written at a different indentation came out mis-indented. newText lines are now re-indented to the matched lines, using the file's own tabs or spaces. Blank lines between matched lines are still part of the match; the schema description now says so.
- **`edit` no longer reports `(no change)` after an edit too large to diff.** When the line diff hit its 1-second limit, for example on a rewrite of a whole large file, the summary claimed nothing changed and a dry run showed no preview. It now reads `changed (too many lines to diff)`.
- **Writes to a hard-linked file update every link.** `edit`, `patch`, `replace_text`, `create` with overwrite, and `undo` now write a file that has more than one hard link in place. Before, the temp-file rename gave the edited path a new inode, and the other links kept the old content. A read-only hard-linked file now fails with `EACCES` on those writes, where the old temp-file rename replaced it.
- **`find_files` matches case-insensitively on Windows and macOS, and reports on-disk names.** Before, a pattern like `Upper.txt` matched nothing when the file was `Upper.TXT`, and a result could echo the pattern's spelling instead of the file's. Patterns now match the way the filesystem does, and results carry the on-disk name. Default excludes such as `node_modules` also match any spelling there.
- **`search_text` clips long match and context lines.** Before, a match on a multi-megabyte line returned the whole line, so one hit could fill the response. Match and context lines now return a 1000-character window around the match, with each cut marked by the number of characters removed.
- **`replace_text` with the default `caseSensitive: false` no longer times out on large files.** A literal search pattern of ASCII text is now matched natively, folding case exactly as RE2 does, so a 3 MB file with hundreds of matches is rewritten in milliseconds instead of stopping at the deadline with `0 match(es)`. Such searches also no longer refuse files over 4 MiB as too large for a regex replace.
- **`replace_text` `maxMatches` is a strict bound.** Before, the cap was checked only between files, so a file with more matches than the cap was rewritten in full, files already in flight all counted, and a named file ignored the cap; none of that set `stoppedReason`. Now at most `maxMatches` matches are replaced, in walk order, and the run stops mid-file with `stoppedReason: 'maxMatches'`. This is a behavior change for named files: a `path` that names one file now honors an explicit `maxMatches` and may leave later matches unreplaced. A named file without `maxMatches` still replaces every match.
- **`replace_text` literal text follows a CRLF file's line endings.** In a file whose every newline is CRLF, LF in a literal `searchPattern` and `replacement` is now converted to CRLF, as `edit` already does. Before, `"a\nb"` matched nothing there, and an LF replacement wrote mixed line endings. `isRegex` patterns are still taken as written; use `\r?\n` to match either ending.
- **`replace_text` `wholeWord` uses Unicode word boundaries.** Before, the match ignored non-ASCII letters and punctuation edges, so `café` matched inside `cafés` and `-x` matched inside `a-x`, and standalone words were skipped. Letters, digits, combining marks and `_` now count as word characters in any script.

## [2.12.1] - 2026-10-29

A patch release with one output fix. No caller needs to adapt.

### Fixed

- **`list` with `includeSizes` spells `directories` in its totals line.**
  Before, it printed `directorys` for every count other than 1.

## [2.12.0] - 2026-10-28

A hardening release. Overwrite and delete prompts catch an entry swapped
while they are open, a cross-device `move` stages its copy, and the scanning
tools report what they skipped and why. Before upgrading, read under
Changed: `replace_text`'s match cap is now `maxMatches` and its stop reason
reads `'maxMatches'`; a cross-device `move` onto an existing directory now
refuses where it merged; `create` reports a file that appears during
confirmation as `CANCELLED`; `search_text` skips binary files it searched
before, and `replace_text` counts a binary or oversized file as skipped
where it failed; and `list` returns a partial result on timeout where it
failed.

### Security

- **`move`, `copy` and `create` ask again when a destination is replaced
  while the overwrite prompt is open.** Before, the call overwrote whatever
  now sat at the destination, not the file you were asked about. A second
  replacement refuses that entry.
- **`create`, `move` and `copy` refuse an entry replaced after you approved
  overwriting it.** Before, a file swapped in between the approval and the
  write was overwritten instead of the one you were asked about.
- **`delete` refuses any entry replaced after it was planned.** Before, a
  socket or FIFO swapped in between planning and deletion skipped the
  identity check and was deleted though no one had approved it.
- **`delete` asks again for a directory that was replaced while the prompt
  was open.** Before, the call failed that entry.

### Changed

- **`replace_text`'s match cap is `maxMatches`.** Before, it was `maxResults`,
  which is a page size in every other tool.
- **`replace_text` reports `stoppedReason: 'maxMatches'` when it hits its
  match cap.** Before, it reported `'maxResults'`.
- **A cross-device `move` copies into a temporary sibling and renames it
  into place.** A move onto an existing directory now refuses, as a
  same-device move does; before, the trees were merged. A copy that fails
  part-way leaves nothing at the destination; before, it left a partial
  tree. Undo of a cross-device move still fails with `EXDEV`.
- **`create` reports a file that appears while its confirmation is open as
  `CANCELLED`.** Before, it reported `INVALID_INPUT`, as if the call were
  malformed.
- **Write tools over stdio link every file stdio can read back.** Before,
  `create` with `append` linked only text files under about 1.7 MB, and a
  binary file got no link in the last 64 KiB under the limit.
- **`list` returns what it found when it times out.** Before, it failed with
  `TIMEOUT`.
- **`search_text` skips every file `read` calls binary.** Before, it
  skipped only a file with a NUL byte, so it searched a PDF or a short
  Latin-1 file that `read`, `edit` and `replace_text` refuse. A file
  whose first 512 bytes are text is still searched, its later bad bytes
  read lossily.
- **`replace_text` counts a binary file in `skippedBinary` whether or not
  the text appears in it.** Before, it counted one only when the search
  text matched its bytes, and in regex mode a binary file over 4 MiB failed
  with `TOO_LARGE`. A binary file you name now fails with `INVALID_INPUT`
  even when nothing in it matches.
- **`replace_text` counts a file over the text size limit in
  `skippedTooLarge`, as `search_text` does.** Before, each one was a
  `TOO_LARGE` failure row, and a run with nothing else to change reported
  an error. A file you name still fails with `TOO_LARGE`.

### Deprecated

- **`replace_text`'s `maxResults`** is read as `maxMatches`. Use `maxMatches`;
  `maxResults` is removed in the next release.

### Fixed

- **get-help and `internal://instructions` give the right TOO_LARGE advice
  for the stdio message limit.** Before, they advised only head/tail, which
  can't return a media or binary file, and named the file size limit in MB.
- **`edit` with `dryRun` reports the file's own modified time.** Before,
  `modified` was the time of the preview, although nothing was written.
- **`replace_text` stats each file right after it writes it.** Before, it
  stat'd only the first changed file, after the whole scan, so its link's
  `lastModified` could be a later writer's.
- **`create` with `append` reports the write time when it cannot stat the
  file afterwards.** Before, `modified` read 1970-01-01.
- **`read` over stdio no longer offers a link that `resources/read`
  refuses.** Before, a slice of a text file just under the 10 MiB file size
  limit came back with a `resourceUri` and a `resource_link` that failed with
  `TOO_LARGE`. The same held for a slice of an SVG over about 7.3 MiB, which
  `resources/read` returns as base64.
- **`find_files`, `search_text`, `replace_text` and `list` count the entries
  and directories they could not read in `skippedInaccessible`.** Before, an
  unreadable folder looked empty and `list` skipped such entries without a
  word; `replace_text` skipped most of them without a word and reported a file
  it was denied permission to read as a failure.
- **`replace_text` returns its files and diff in walk order.** Before, they
  came back in a different order from one run to the next.
- **`replace_text` honours `maxFiles` in walk order and no longer spends it on
  entries it skips.** Before, a skipped file used up a slot.
- **`search_text` on a file you name but cannot read fails with the reason.**
  Before, it returned an empty result.
- **A pending entry that disappears while the prompt is open no longer fails
  the whole call.** In `move`, `copy`, `create` and `delete`, that entry gets
  its own result and the rest proceeds.
- **A destination or directory that becomes pending while the prompt is open
  is asked about again.** Before, it failed the whole call.
- **One confirmation reissues its question at most once.** Before, a
  reprompt cleared the flag that stops a second reissue, so a client that
  kept answering in a shape the SDK drops saw four rounds; a confirmation now
  runs three rounds at most.
- **`list` reports `stoppedReason: 'maxResults'` in `_meta` and in the
  externalized tree when it stops at its entry cap.** Before, only the text
  trailer said so.
- **`find_files` reports `stoppedReason: 'maxResults'` only when a match
  past its result cap was dropped.** Before, a search that matched exactly
  as many files as the cap was reported as truncated.
- **`find_files`, `search_text`, `replace_text` and `list` report
  `'timeout'` only when the deadline cut work short.** Before, a deadline
  that fired after every entry had finished turned a complete run into a
  timeout, and `replace_text` said it stopped early.
- **The constraints help text states the file size limit in MiB with one
  decimal.** Before, it was floored to whole MB: a `FS_MAX_FILE_SIZE` of
  10.5 MiB read as `10 MB`; it now reads `10.5 MiB`.

## [2.11.0] - 2026-10-24

A security release. On Linux, tools refuse a path swapped for a symlink
while they check it; on macOS, grants refuse system folders reached by their
real path; and the MCP SDK moves to 2.4.0. Before upgrading, read the
`create` and `move` entry under Security if you script either tool: a
destination whose stat fails for a reason other than "not found" now needs
confirmation. On Linux, a file literally named with a trailing ` (deleted)`
is now refused by `stat` and `list` sizes, as reads already refuse it.

### Security

- **A path swapped for a symlink while a tool checks it is refused on
  Linux.** `stat`, and every tool that checks a file's size or type before
  acting (`move`, `edit`, `read`, `list` with sizes, resource reads), now stat
  an open descriptor that is re-checked against the allowed folders. A parent
  directory swapped for a symlink out of the roots is refused with
  `ACCESS_DENIED`, and a file swapped for a symlink with
  `SYMLINK_NOT_ALLOWED`. Before, the stat could describe the outside file.
  FIFOs and files without read permission stat as before.
- **`create` and `move` ask before overwriting a destination they cannot
  stat.** A destination whose stat failed for any reason other than "not
  found" used to count as absent, so it could be overwritten without the
  usual confirmation. This applies on every platform, including Windows
  lock errors.
- **A grant can no longer reach a system folder by its real path on
  macOS.** `/etc` there is a link to `/private/etc`, and the grant check
  compared the resolved path against `/etc` only, so a folder link that
  resolved into `/etc` was offered for access. Each system folder now also
  counts by its real path, so `--allow-cwd` from `/private` itself is
  refused too.

### Changed

- **MCP SDK 2.4.0.** `@modelcontextprotocol/server` and the test client move
  from 2.3.1 to 2.4.0, and `@modelcontextprotocol/node` from 2.1.1 to 2.1.2.
  The server uses none of the SDK's new features, such as the Skills
  extension: the advertised tools, prompts, resources and capabilities are
  unchanged. `@modelcontextprotocol/express` 2.0.2 is unchanged (latest).

### Removed

- **Smithery publishing.** Releases no longer update the Smithery listing.
  Smithery's API has refused every server update since 2.10.0 and shuts
  down on 2026-10-31, along with its CLI and API keys. Each release still
  ships to npm, GHCR, the MCP Registry and the `.mcpb` release asset.

## [2.10.1] - 2026-10-23

A fix patch. `undo` restores, previews and reports large calls correctly,
and eight tool descriptions say more exactly what each tool does. Before
upgrading, read the large-call `undo` entry under Fixed if you read every
path from an `undo` result: a step now lists at most 100 paths.

### Changed

- **`move`, `list` and `diff` descriptions say more about how each tool
  behaves.** `move` says that `undo` reverts a move whose result gives an
  undo id, but never a copy. `list` says it shows one level by default. It skips
  hidden entries unless `includeHidden` is set, and ignored ones, such as
  `.gitignore` matches, `node_modules`, `dist`, `build`, `out` and `tmp`,
  unless `includeIgnored` is set. It points to `find_files` for a search by
  name pattern. `diff` says that identical files give no
  hunks and that binary and non-UTF-8 files are refused.
- **`search_text`, `find_files` and `stat` descriptions are clearer.**
  `search_text` says that `searchPattern` is the text to find and that
  `pattern` filters files by glob. `search_text` and
  `find_files` no longer name `edit`, which `--read-only` removes. `stat` says
  that each missing path gets its own `NOT_FOUND` entry.
- **`edit` and `delete` descriptions are more exact.** `edit` says that
  `path` with `edits` and `files` are two forms that exclude each other.
  `delete` says that `undo` reverts a delete only when its result gives an
  undo id. Before, it promised undo for every delete.

### Fixed

- `undo` moves a file back after an append to it. Before, undoing a move, an
  append to the moved file and a later write to it skipped the move as
  modified, though nothing outside the server had touched the file.
- `undo` of a large call no longer drops a stdio connection. Each step lists
  at most 100 paths in restore order, within 2 MiB shared by all steps;
  skipped and failed paths are kept before restored ones, and a cut list
  carries `truncated` and `totalResults`. Before, undoing a recursive delete
  of tens of thousands of files restored them all and then sent a result
  past the 10 MiB stdio message limit, which closed the connection.
- `undo` reports progress per restored path, so a client that resets its
  request timeout on progress no longer cancels a long restore part-way.
- `undo` with `dryRun: true` lists what the undo then does, folders it
  removes included. Before, after folder moves, deletes, or changes made
  outside the server, the preview could report a file restored that the
  undo then skipped, or skipped one the undo then restored.
- `undo` with `dryRun: true` reads each file under the lock a write to it
  holds. Before, a preview that overlapped an `edit` could judge a restore
  from a half-written file.
- `undo` with `dryRun: true` fails on the same path check as the undo.
  Before, on Linux, when a folder's parent had become a file, the preview
  reported a later check's error instead.
- `undo` leaves a link that took the place of a folder the undone call
  created, and reports that folder as skipped. Before, undoing the call
  removed the link, on Windows a junction, in the folder's place.
- `undo` tells apart files a batch call created together. Before, on
  Windows two such files could share one identity, so undoing a change to
  one could skip moving the other back.

## [2.10.0] - 2026-10-23

A feature release. A new `undo` tool reverts earlier calls that changed
files, while the server runs. Before upgrading, read Changed if you parse
the text result of a tool that changes files, or budget server memory.

### Added

- New `undo` tool: every call that changes files returns an undo id
  (`· undo k3x9` in the text, `undo` in `_meta`, or in `structuredContent`
  for `create`), and `undo` reverts one call by id, the last N calls, or
  (stdio only) the last call. A file is restored only when its current bytes
  still match what the tool wrote; `dryRun: true` previews the history.
  History is in memory only and disappears when the server exits. Over
  HTTP an id is required.
- `FS_MAX_UNDO_BYTES` env var: memory kept for undo, default 32 MiB, 0
  turns undo off.
- Copies (`move` with `copy: true`) and cross-device moves report
  `not undoable` instead of being captured.

### Changed

- The first line of a text result from a tool that changes files ends with
  `· undo <id>` or `· not undoable: <reason>`, errors included. Parsers
  that match that whole line need to allow the suffix.
- The server keeps up to 32 MiB of replaced file content for undo by
  default. Set `FS_MAX_UNDO_BYTES=0` to keep the old memory profile.
- `delete` no longer describes itself as permanent; it names `undo`.

## [2.9.1] - 2026-10-16

A security and fix patch. The denylist now covers the subtree of every
directory its list names for every tool, the same hide `list` already
held. `list` with sizes respects the per-call time limit, and raw `EPERM`
failures are walked past the same as `EACCES`. Before upgrading, read
Security if you relied on `find_files`, `search_text` or `replace_text`
showing entries under a directory whose own name a `--deny` or
`FS_DENYLIST` pattern covered; those calls now hide the subtree.

### Security

- `list` with `includeSizes` (or `sortBy: 'size'`) now stats each listed file
  through the guarded filesystem, which re-validates the path before the
  stat call. The unguarded call could describe an entry swapped in between
  the walk and the stat.
- `find_files`, `search_text` and `replace_text` now hide the contents of a
  directory whose own name the denylist covers, the same subtree `list` already
  hid. Before, those tools surfaced paths (and content matches) under a
  denylisted directory name while `list` hid the whole subtree. The hide holds
  through literal pattern prefixes (`vault.key/*.txt`) and through a
  denylisted symlink standing in for the directory.

### Added

- Codex plugin manifest (`.codex-plugin/plugin.json`) at the repo root, so
  Codex installs the server as a plugin, and continuous security analysis in
  the repository's CI.

### Fixed

- Raw OS `EPERM` failures are now skipped during walks and sweeps, the same as
  `EACCES`. Before, an unwrapped `EPERM` surfaced as a warning in path
  completion and as a per-file failure in `replace_text` where an `EACCES`
  was silently skipped.
- `list` with `includeSizes` (or `sortBy: 'size'`) now respects the per-call
  time limit: the guarded stat is raced against the call's abort signal, so a
  stalled validation no longer holds the entry past the deadline.

## [2.9.0] - 2026-10-15

A feature and security release. `read` returns any binary file, `list`
shows file sizes, `stat` counts a directory's entries, `create` makes
empty directories, and the per-call time limit is configurable. Search
results and relative paths now resolve against the root, so what a tool
prints reads back as given, and a name that differs from the disk only in
Unicode form resolves everywhere. Path validation follows symlink chains,
and a denylist blocks every Unicode spelling of a name it covers. Some
calls that used to succeed are now refused. Before upgrading, read
Changed if you join `search_text`, `find_files` or `replace_text` result
paths onto the folder you searched, or check calls against the published
input schemas (`read`, `stat` and `edit` no longer publish a top-level
`oneOf`, and `create`'s `files` is now optional). Read Security if you
pass glob patterns with nested groups or long `*` runs, rely on a name
whose Unicode spelling a denylist pattern missed, or write through
chained or broken symlinks. Read Fixed if you run on Linux or macOS where
clients send Windows-style paths, or send batches that name one target by
two spellings.

### Security

- **A denylist pattern blocks every Unicode spelling of a name.** A
  `--deny` or `FS_DENYLIST` pattern matched only the bytes it was typed
  with. So `--deny 'café.txt'` did not block a `café.txt` stored
  decomposed (NFD), and `--deny 'secret notes.txt'` did not block a name with
  U+00A0 or U+202F, when a client sent the name exactly as stored. A pattern
  now also matches after NFC normalization, with every space character read
  as a plain space, and keeps every match it had. An `--allow` entry still
  relieves only the spelling it names. The built-in list has no such
  characters and is unchanged
  ([#101](https://github.com/j0hanz/filesystem-mcp/issues/101)).
- **A glob pattern can no longer freeze the server.** `find_files`,
  `search_text` and `replace_text` refuse a pattern that puts `|`, `*` or a
  nested group inside `*(…)` or `+(…)`, or that has more than three `*` runs
  and extglob groups (`?(…)`, `@(…)`, `!(…)`, `+(…)`, `*(…)`) together in one
  path segment. Node matches globs synchronously, and such
  patterns backtracked for minutes on one long file name, blocking every
  client. The refusal is the usual `Invalid glob or unsafe path` error.
- **Path validation follows symlink chains.** A write target reached
  through a symlink that pointed through another symlink, or through a
  broken link, bypassed the root check. Ancestor resolution now follows
  every hop before falling back to parent traversal, and a broken chain
  is refused, so a write never resolves through a link the guard did not
  check.
- **Directory walks no longer name secret files in errors.** A
  `search_text` or `replace_text` run that could not read or rewrite a
  secret file reported its name in the failure list or the skipped-file
  count. Walks now omit such entries from both.
- **An ambiguity error no longer lists denylisted names.** A name the
  denylist covered was refused, but a Unicode-equivalent spelling of it
  listed the protected names and the real directory in the
  `INVALID_INPUT` error. The denylist now wins before the ambiguity
  check, so the error never names what it hides.
- **A missing relative path no longer reports what is outside the
  roots.** With several roots, deciding which root a relative name sat
  under followed a symlink out of every root: a missing target answered
  "exists under none of the roots" and a present one `ACCESS_DENIED`, so
  the error told a caller whether an outside file exists. The probe now
  goes through the same validation as the call, which refuses such a
  path the same way whether or not the target exists, and refuses a
  denylisted name before touching the filesystem.

### Added

- **`--tool-timeout` sets the time limit for one call.** `list`, `stat`,
  `read`, `find_files`, `search_text` and `replace_text` stopped after a fixed
  5 seconds, so a search over a large repository always ended early.
  `--tool-timeout <ms>` or `FS_TOOL_TIMEOUT_MS` now sets the limit, from 1000
  to 600000 ms. The default stays 5000, and `--print-config` reports the value
  as `limits.toolTimeoutMs`. Most clients give up on a call after 60 seconds.
- **`FS_READ_ONLY` turns on read-only mode from the environment**, like
  `--read-only`, for clients that can only pass environment variables.
- **The Claude Desktop extension can run read-only and block more files.**
  Its settings gain a read-only switch and a comma-separated list of patterns
  to block, passed to the server as `FS_READ_ONLY` and `FS_DENYLIST`.
- **`create` makes empty directories.** A new `directories` list creates each
  one like `mkdir -p`, and leaves one that already exists as it is. `files` is
  now optional; a call needs at least one of the two. Directories are made only
  after any overwrite confirmation is answered. The result lists them in
  `directories`, and a failed one joins `failures`.
- **`list` can show file sizes.** `includeSizes: true` adds each file's
  size to the tree and a totals line of counts and bytes, so finding
  what takes the space no longer needs a `stat` call per file
  ([#99](https://github.com/j0hanz/filesystem-mcp/issues/99)).
  `sortBy: "size"` orders each directory largest first; the default
  name order is unchanged.
- **`stat` on a directory reports `entryCount`**, the number of entries
  directly inside it, so "is this folder empty?" takes one call
  ([#56](https://github.com/j0hanz/filesystem-mcp/issues/56)). Hidden and
  ignored entries count. Secret files, and symlinks to them or to anything
  outside the allowed folders, do not, so the count never reveals what `list`
  hides.
- **`read` can return any binary file.** With `binary: true`, a full read of a
  file that is not text, an image or audio (a PDF, zip, sqlite database, font,
  …) returns it as an embedded `resource` block with its MIME type and base64
  bytes, instead of refusing it as binary. The size limit is unchanged. Line
  ranges of a binary file are still refused, and without the flag the refusal
  now names it
  ([#98](https://github.com/j0hanz/filesystem-mcp/issues/98)).

### Changed

- **`read`, `stat` and `edit` no longer publish a top-level `oneOf`**, and
  `read` no longer publishes `dependentRequired`. The OpenAI and Anthropic
  function-calling APIs reject a top-level `oneOf`, `anyOf` or `allOf`, so
  these schemas could not go to a model as they were. The rules themselves are
  unchanged and still checked when the tool runs: `path` or `paths`, `path`
  with `edits` or `files`, and `endLine` needs `startLine`, which the `endLine`
  description now says. A call that breaks one gets the same
  `Input validation error`.
- **A `replace_text` timeout says what it already wrote.** A live run that
  hits its time limit keeps the files it already rewrote. Its text now
  names them and warns that re-running the same replacement applies it to
  them again.
- **A relative path resolves against the root when the server runs outside
  it.** Desktop hosts start the server outside the project, and an HTTP client
  never shares its working directory, so `read` with `src/a.ts` failed with
  "Outside allowed directories" right after `search_text` printed
  `src/a.ts`. A relative path still resolves against the working directory
  while that lands inside a root. Otherwise it resolves against the roots:
  the one root, or with several, the one root it exists under. Only
  configured roots and those a client declares count; a folder granted during
  the session does not, so approving one never changes what a relative path
  names. A relative path that exists under several roots, or under none of
  several, is refused with `INVALID_INPUT` naming the roots. With a root
  configured, a relative path no longer turns into a request to grant access
  to the server's working directory. A `create` or `edit` batch that names
  one file by both a relative and an absolute path is refused as a
  duplicate, as two spellings of one absolute path already were.
- **Search results name files from the root, so they read back as given.**
  `search_text`, `find_files` and `replace_text` printed paths relative to
  the folder they searched: a search of `src` printed `a.ts`, which `read`
  or `edit` resolved to `<root>/a.ts`, another file when the root holds
  one. They now print paths relative to the root holding that folder
  (`src/a.ts`), in their text and in `matches[].file`, `results[].path` and
  diff headers. `find_files`' `root` field now names that root, as
  `list_roots` shows it, instead of the folder searched, and `search_text`
  and `replace_text` gain the same field. A path whose relative spelling
  would not read back as the same file is printed absolute instead: with
  the working directory in a subfolder of a root, with several roots and the
  working directory outside them, under a folder granted during the
  session, or for a name such as `~` or a blank one. `list` keeps its
  entries relative to the listed folder, but the tree's first line now names
  a listed subfolder the same way (`src/core`, not `core`). `find_files`'
  cached full result (its `resourceUri`) is now the whole result, an object
  with `root` and `results`, like `search_text`'s, instead of a bare array.
- **Literal `search_text` is about twice as fast.** A literal pattern (the
  default, `isRegex: false`) is matched in native code instead of RE2, which
  copied every file into its heap just to rule it out. Each file also costs
  two fewer filesystem calls. On a 7,300-file tree, a literal search that
  stopped at the 5-second limit after about 3,200 files now finishes in 2 to
  4 seconds. Results are unchanged, with one exception: a literal search now
  searches a line longer than 4 MiB, which RE2 cannot take, instead of
  counting its file in `skippedTooLarge`. RE2 still handles regex searches,
  case-insensitive patterns with non-ASCII letters, patterns holding U+FFFD,
  and a case-insensitive pattern with a `k` or `s` in a file that holds the
  Kelvin sign or the long s, which RE2 matches as those letters; there a line
  over 4 MiB still counts its file in `skippedTooLarge`.
- **A batched `read` counts image, audio and binary files at their base64
  size** against its 512 KiB budget, because that is what it returns.
- **Hidden-pattern variants walk in one pass.** `find_files`,
  `search_text` and `replace_text` walk the hidden and dotted variants
  of a pattern in one glob call, about a third faster on a large tree.
  Results are unchanged; a run capped early keeps a different set of
  the files it met. `list` over a directory past `entryCap` now keeps
  the entries best by sort order instead of whichever the walk met
  first.

### Fixed

- **A path that differs from the disk only in Unicode spelling resolves.**
  `café` finds a folder stored decomposed (NFD), and `shot PM.png` finds a
  macOS screenshot whose name holds U+202F. Both answered `Path not found`
  although `list` showed them. A name missing as typed is now compared with
  its folder's entries after NFC normalization, with every space character
  read as U+0020. One match is used and checked like any other path: root
  containment after each symlink, and the denylist on the on-disk name. Two
  matches are refused as ambiguous, and no match is still `NOT_FOUND`. A
  write to such a name lands on the existing entry, and a move that changes
  only a name's Unicode form renames it
  ([#101](https://github.com/j0hanz/filesystem-mcp/issues/101)).
- **A Windows drive path is refused on Linux and macOS.** `C:\x`, `C:/x`
  and `C:` were relative names there, so `create` made a file named
  `C:\Users\x\f.txt`, or a `C:` folder, inside the root and reported success.
  Every tool, the file resource and a positional root now refuse them with
  `Windows-style path received on a POSIX host`, and no longer offer an
  access grant for them. Windows is unchanged.
- **A file whose name holds a backslash gets its own `resourceUri` on Linux
  and macOS.** `a\b.txt` and `a/b.txt` shared one URI, and `resources/read`
  and subscriptions on it went to `a/b.txt`.
- **A cancelled or timed-out read no longer shuts the server down.** A file
  read that started after its call was cancelled, for example a
  `replace_text` worker opening its next file after the 5-second deadline,
  raised an uncaught `AbortError` and the server exited.
- **Write tools over stdio link only files `resources/read` can return.**
  A written file whose `resources/read` result would exceed the stdio message
  limit once JSON-encoded no longer gets a `resource_link` that the read
  always refuses.
- **Batch mutations refuse overlapping or duplicate paths.** A batch
  that names one target by two spellings, through a symlinked parent or
  another Unicode form, or a `delete` batch that names a path together
  with its ancestor, is refused before anything runs, and parallel
  writes that race on equivalent paths are serialized.
- **A `replace_text` failure to write back is reported, not skipped.**
  Only discovery and read errors skip a file now; a rewrite that fails
  is listed as failed. A failure reading metadata after a finished
  write no longer reports the write as failed.
- **Renaming a link never destroys its target.** Moving a symlink onto
  its own target, in any spelling, re-spelled the destination, skipped
  the overwrite check, and renamed the link over the file it pointed
  at. Such a move is now the no-op an exact self-move already was, and
  a rename that changes only a name's Unicode form renames the link
  itself.
- **A `read` slice counts its lines exactly.** A newline is counted
  only between retained lines, so `head`, `tail` and range results
  report the line count the returned text has.
- **A directory's `entryCount` holds up under races and deadlines.** A
  directory or ancestor swapped for a symlink between validation and
  the count could have another directory's entries counted; the opened
  directory is now re-checked, and every entry is checked under its
  real spelling, as `list` does. A `stat` that runs out of time while
  counting ends `TIMEOUT` instead of returning success without
  `entryCount`, and a stalled directory open or read is released at
  the deadline instead of holding the call.
- **`create` progress counts directories and files against one
  total.** Each phase reported progress from one, so a call with at
  least as many directories as files lost every file-phase tick and
  its total jumped between phases.
- **`search_text` reads virtual files and stops on cancel.** A file
  that reports a size of 0 while holding text, such as procfs, was
  searched as empty; it is now read to its end. A large file was also
  read in one call that never checked the cancel signal, so a search
  on a slow filesystem could hold past its deadline; reads now go in
  chunks with a signal check.
- **Image and audio reads honor `includeHash`**, and their per-path
  value now reports `size`, `modified` and a `resourceUri` alongside
  the media block.

## [2.8.1] - 2026-10-13

A maintenance release. Internal refactors give the read path, paged
snapshots, confirmations and shared helpers one owner each; no tool, input
or output field changed. Read Changed if you match on the text of a `read`
size refusal.

### Changed

- **`read` size refusals share one wording.** A file, single line or tail
  that exceeds the size limit now reports
  `File exceeds size limit (<bytes> > <limit> bytes[, <detail>])` instead of
  `File too large (...)`, and the remedy ("Use head to preview.", "Use a
  narrower range or head.", "Use a narrower tail or head.") moves from the
  message into the error's `suggestion`. The `TOO_LARGE` code is unchanged.

## [2.8.0] - 2026-10-13

A security and reliability release. It closes four sandbox gaps: glob
patterns that reached above the searched folder, reads that followed a
symlink swapped in mid-read, a recursive-delete confirmation that could be
spent on a different directory, and completion and grant checks that drifted
from the path guard. Over stdio, a response or request that would overflow
the transport is now refused instead of dropping the connection. No tool or
input field was removed; `read` `startLine` and `endLine` now accept values
above 100,000. Some calls that used to succeed are now refused. Before
upgrading, read Security if you pass glob patterns with brace sets, ranges or
drive prefixes, grant client roots through a symlinked `FS_ROOT_BOUNDARY`, or
have a recursive `delete` prompt open across the upgrade. Read Changed if you
use stdio with request IDs or progress tokens over 1 KiB or results near
10 MiB, batch `move` or `copy` entries whose destinations nest, match on the
empty `oldText` or `searchPattern` error text, or start stdio with
`FS_API_KEY`. Read Fixed if you rely on `includeHidden` matching dotfiles
through a literal pattern.

### Security

- **A glob `pattern` can no longer reach outside the `path` it searches
  ([#68](https://github.com/j0hanz/filesystem-mcp/issues/68)).** `find_files`,
  `search_text` and `replace_text` rejected `../*.txt` but not a pattern that
  builds `..` or a root from parts: brace sets (`..{,x}/*.txt`,
  `.{.,}/*.txt`, `{/etc,x}/*`), one-character classes (`[.][.]/*.txt`), letter
  ranges (`.{Z..a}./*.txt`), or a leading backslash on Linux and macOS
  (`\etc\*`). Below an allowed root, `replace_text` rewrote files in the
  parent folder; at an allowed root, the names of entries above it leaked
  through skip counts and per-file errors. The pattern check now looks at
  every brace alternative the way the glob engine reads it, and the walk
  itself drops any match outside its `path`, so a pattern the check does not
  foresee narrows the search instead of widening it. A drive-rooted
  alternative (`C:/x`, `{C:,x}/y`) is now refused on every host, as `C:x`
  already was.
- **A glob with a huge brace range no longer freezes the server.** The glob
  engine expands `{1..100000}` and compares the alternatives pairwise on the
  event loop, which blocked every other request for most of a minute. A
  pattern that expands to more than 1024 alternatives is now refused.
- **`search_text`, batch `read`, and an append's result now read through the
  same symlink-swap guard as every other read.** `search_text` read each
  file by name after validating it, so a symlink swapped in between returned
  matches from a file outside the allowed folders. A batch `read`, and the
  MIME type and line count an append reports, skipped the Linux check that
  the opened file still sits inside the allowed folders, so swapping a
  parent folder for a symlink leaked them there. These reads now refuse a
  swapped final symlink on Linux and macOS and, on Linux, re-check the
  opened file's real location. Windows has no equivalent open flag, so
  there the swap window stays as narrow as for every other read; creating
  a symlink on Windows needs privilege. Exploiting this took a local
  process able to write inside an allowed folder.
- **A recursive `delete` confirmation now authorizes only the directory it
  asked about.** The confirmation sealed only the path, so a directory
  replaced at that path while the prompt was open was deleted on the retry.
  It now also seals each directory's identity (type, device, inode and birth
  time), and a retry whose target no longer matches is refused for that path
  with `INVALID_INPUT`. A confirmed directory swapped for a file or symlink
  is reported per path and never deleted. One removed during the prompt gets
  its own `NOT_FOUND` (or a no-op with `ignoreIfNotExists`) instead of
  failing the whole batch. A confirmation minted by 2.7.6 carries no
  identities and cannot authorize a recursive delete; repeat the call.
- **Path completion no longer lists inside a directory the guard refuses,
  and an access grant follows the startup boundary rule.** Completion used
  its own copy of the directory check, so it listed the contents of a
  directory whose own name is sensitive (such as `vault.key`). It now asks
  the guard, and a refusal still returns the matching roots. A client root
  that does not exist yet, spelled through a symlinked `FS_ROOT_BOUNDARY`,
  was refused as a grant although the same spelling is kept as a startup
  root; grants now project it the same way. The same rule refuses two grants
  the old lexical fallback accepted: a missing folder under an in-boundary
  symlink that points outside the boundary, and one whose parent cannot be
  resolved. The sensitive-file check moves into the one access check that
  runs it.

### Changed

- **Over stdio, a response that would overflow the client's 10 MiB message
  reader returns `TOO_LARGE` instead of dropping the connection.** This
  covers read-only tools, any tool called with `dryRun: true`, and
  `resources/read`, at 10 MiB less 256 KiB of JSON-encoded result. The
  refusal says what to do instead (smaller slices, fewer files per preview,
  or HTTP), and the call keeps none of the links or cursors it cached. A
  file resource over the limit is refused from its size before it is read,
  and a cached result too large to read back over stdio is no longer handed
  out as a link. HTTP is unchanged, and a mutating call is never measured
  after it commits.
- **Over stdio, a request ID or `_meta.progressToken` over 1024
  JSON-encoded bytes is refused with `InvalidRequest` before dispatch**, so
  the call never runs. Every response echoes the ID and every progress frame
  the token, so a multi-megabyte value could push a frame past the client's
  reader. The progress-token refusal carries the request ID.

- **Leaner internals from the fourth over-engineering audit.** Net -39 lines
  across 8 files: `ToolCtx` drops three fields only the executor read,
  `delete` inlines its one-caller removal helper and shares one identity
  check, stdio reuses `normalizeUnknownError`, and the link-returning tools
  return once instead of branching on whether a link exists.
- **One declaration of the tool dependencies, one way to build an error.**
  Net -31 lines across 3 files: the tool registrar extends `ToolDeps`
  instead of re-declaring and copying its six fields, and every `Problem`
  in `errors.ts`, including `FsError`'s, goes through the one builder that
  drops unset keys. ADR-002 records that its legacy-harness migration
  covers 15 test files, not six.
- **`find_files` walks its entries inline.** The one-caller generator that
  validated each walked path is folded into its caller, with the same
  abort, refusal and cap order (net -10 lines, no behavior change).
- **An empty `edit` `oldText` or `search_text`/`replace_text` `searchPattern`
  is refused with the same message as a blank one**, "… cannot be empty or
  whitespace-only", instead of "oldText required" or the validator's
  generic too-short text. The three fields now share one non-blank text
  schema. The write tools spread the shared file metadata instead of
  copying it field by field, and `list`, `find_files`, `search_text`,
  `edit` and `replace_text` drop one-caller wrappers (net -111 lines
  across 8 files).
- **One helper for a notification that can fail only because the client
  left.** The resource-updated and list-changed sends in stdio, the
  resource registrar and the server each wrote their own catch-and-log;
  `voidSend` now owns it, and the registrar builds its contracts through
  the same `getResourceContracts` list the tests exercise (net -6 lines, no
  behavior change; the list-changed debug line now formats its error like
  the other two).
- **The API key stops at the HTTP host.** The server used the key only to
  mark its cacheable lists `private`; the HTTP host now passes that scope
  instead of the secret. A stdio server started with `FS_API_KEY`, where
  the key has no effect, now reports those lists as `public` to 2026-era
  clients. The CLI result is passed through instead of being rebuilt
  twice, and stdio's oversized-ID refusal uses the shared JSON-RPC error
  builder.

### Fixed

- **`read` continues past line 100,000.** `startLine` and `endLine` now
  accept any positive 32-bit integer (the declared maximum is 2147483647);
  `head` and `tail` stay capped at 100,000. Lines before `startLine` are
  counted without being decoded.
- **A line ending inside an incomplete UTF-8 sequence no longer corrupts
  the next line.** The decoder carried the leftover bytes across the
  newline; each line now decodes on its own.
- **`move` and `copy` refuse batch entries whose destinations nest.** Two
  recursive copies into `out` and `out/sub` raced over shared files. Both
  entries are now refused, as overlapping source and destination pairs
  already were.
- **A "skip" answer for a directory survives the directory being emptied
  while the prompt is open.** The retry treated the emptied directory as no
  longer needing confirmation and deleted it.
- **`includeHidden` no longer widens literal pattern segments.** Every
  segment got a dot variant, so `foo.txt` also matched `.foo.txt` and
  `foo*.txt` matched `.foo1.txt`. Only a segment that starts with `*` or `?`
  gets one now. With `includeHidden`, a `.gitignore` inside a hidden
  directory now applies to the walk.

## [2.7.6] - 2026-10-12

A security and reliability release. It closes a symlink-swap sandbox escape
and fixes six high-severity issues found by a stress and fuzz sweep. No
schema-legal tool call changes shape and the declared tool surface is
unchanged. Three changes can turn a call that used to succeed into a refusal;
read Fixed before upgrading if you batch `move` entries that swap or chain
files, or call `create` on a path another process may create at the same
moment. Error wording changed for the `replace_text` size refusal, the
sensitive-file block, and an ambiguous `edit` (see Changed); error codes did
not.

### Security

- **A symlink swapped onto a path between validation and the file operation can
  no longer escape the sandbox on reads or appends.** The read and append open
  seams now open the resolved target with `O_NOFOLLOW`, so a regular file
  swapped for a symlink is refused rather than followed outside the allowed
  folders, and the opened descriptor's real path is re-checked against the
  allowed folders (on Linux) to catch a swapped parent directory, before any
  byte is read or written. The same descriptor check covers the text reads
  behind `edit`, `patch`, and `diff`. Legitimate symlinks that resolve inside
  an allowed folder are unaffected.
- **`create` no longer overwrites a file that appears after its overwrite
  check.** Without `overwrite: true`, a path that did not exist when `create`
  checked whether to ask for confirmation, but exists by the time it writes,
  is now refused with `INVALID_INPUT` (`create refused: "<path>" appeared
after overwrite confirmation was checked`) instead of being silently
  replaced.

### Changed

- **`replace_text` refuses a file over the text size limit with the shared
  `createTooLargeError` wording** its streaming reader already returns,
  `File exceeds size limit (N > M bytes)` with the path in the error
  envelope, instead of a per-tool hand-rolled message. Refusal-path only;
  no successful call changes shape. Batch failure rows in the text output now
  show the full relative path instead of the file name, so same-named files
  in different folders stay distinguishable.
- **The sensitive-file error points to the narrowest fix.** It now suggests
  `--allow <pattern>` (or `FS_ALLOWLIST`) to unblock one built-in secret-file
  pattern, names `--allow-sensitive` as the switch that turns the whole list
  off, and says paths blocked with `--deny` or `FS_DENYLIST` stay blocked.
  Previously it only suggested `--allow-sensitive`.
- **`--help` describes `--allow-sensitive` and `FS_ALLOW_SENSITIVE` as turning
  off the built-in secret-file denylist** (`.env`, keys, credentials), names
  the env vars for `--walk-cwd`, `--deny`, and `--allow-missing-roots`, and
  sizes its name column from the longest entry so `FS_ALLOW_UNRESTRICTED_HOSTS`
  no longer runs into its description.
- **An ambiguous `edit` reports "matches at least N places"** when it stopped
  counting early, instead of presenting the partial count as exact.
- **Documentation.** The README is rewritten for new users with a per-client
  quick start, and new `docs/configuration.md`, `SECURITY.md`, and
  `docs/client-guide.md` cover every flag and limit, the security policy, and
  building a client. Four example clients (`fsq`, `browser`, `tail`, `python`)
  live under `examples/clients/`, and the misspelled `exampels/` folder is now
  `examples/`.

### Fixed

- **A regex search or replace over a many-match or very long input no longer
  freezes the whole server.** `search_text`, `replace_text`, and `edit` with
  `ignoreWhitespace` scan through RE2, which copies the whole input on every
  match, so a dense pattern ran for tens of seconds with the event loop pinned
  and the 5-second timeout unable to fire. The scans now yield periodically so
  the timeout fires, other requests interleave, and an aborted `replace_text`
  never writes a partially-substituted file. `edit` stops as soon as a match is
  known ambiguous instead of counting every occurrence.
- **Concurrent or aliased writes no longer silently lose changes.** Two edits
  of one file — two batch entries reaching it through a symlinked parent, or two
  overlapping tool calls — each read the same base and the last atomic rename
  won, dropping the other's changes while both reported success. `edit`,
  `patch`, `replace_text`, and `create` now serialize the read-modify-write per
  resolved file.
- **A `move` batch whose entries overlap is refused instead of destroying
  data.** A swap (`A→B`, `B→A`) or a chain (`B→C`, `A→B`) ran its renames
  concurrently and lost a file; such a batch now fails closed per entry with a
  clear message, and independent entries still run in parallel.
- **Over stdio, a `read` whose result would exceed the client's 10 MiB message
  buffer now returns a clear `TOO_LARGE` error** telling you to read a slice,
  instead of a response that overflowed the buffer and dropped the whole
  connection. This could happen for a file under the size limit once its text
  was JSON-encoded. The cap applies to stdio only — HTTP streams responses with
  no such frame limit and keeps returning large reads. An image or audio file
  that trips the cap is told to connect over HTTP, since media cannot be read
  as a slice.
- **A file containing a single line larger than the regex input bound is now
  reported as skipped** rather than aborting the regex engine and returning a
  misleading "no files were searched" with a wrong reason. A later search in
  the same process keeps working.

## [2.7.5] - 2026-10-09

A hardening and documentation release. Nothing breaks for existing callers:
no schema-legal tool call is affected, and the declared tool surface is
unchanged.

### Added

- **`tools/call` arguments are bounded before schema validation.** A payload
  carrying more than 4096 array elements plus object members is now answered
  with a tool error before any schema runs, instead of being fully parsed and
  traversed first. The largest schema-legal call (an `edit` batch of 5 files
  by 100 edits) is 1517 nodes, so no legitimate call comes near the cap.

### Changed

- **`FS_ALLOWED_ORIGINS` documents browser-extension origins.** The README
  and `--help` now describe the two forms the Origin gate already accepts: an
  extension ID (the hostname of a `chrome-extension://` origin) and a
  lowercase `<scheme>://*` entry such as `moz-extension://*`. `http://*` and
  `https://*` are not honoured. A new test pins this behaviour.

## [2.7.4] - 2026-10-09

A fix release for `stat` output that read as "empty, writable by everyone"
on Windows (issue #56). The declared schema is unchanged; only the `stat`
description text moved. Callers that read `fileCount`, `dirCount`, a
directory's `size`, or `permissions` on Windows should read the Fixed entry
before upgrading.

### Fixed

- **`stat` no longer implies a Windows directory is empty or world-writable**
  (issue #56). The top-level `fileCount` and `dirCount` are removed: they
  counted result rows by type, so a single directory always read as
  `fileCount: 0`. Directories no longer report `size`, which libuv fixes at
  0 on Windows and which never described contents; use `list` for that. On
  Windows, `permissions` is replaced by `readOnly`, the one fact libuv
  encodes in the mode there. Linux and macOS keep the `rwx` triads.

## [2.7.3] - 2026-10-07

A fix release for empty search results that read like a genuine miss
(issue #55). Nothing breaks for existing callers. The only change to the
declared surface is that `searchPattern` no longer publishes `examples`.

### Fixed

- **An empty `search_text` or `replace_text` result says why it is empty**
  (issue #55). A literal search whose `searchPattern` looks like a regex
  (`a|b`, `\d+`, `.*`) now adds a line naming `isRegex=true`. A glob that
  selected no files now says that nothing was searched, instead of reading
  as a content miss. The regex-shaped `searchPattern` examples, which showed
  no `isRegex` flag, are removed from both tools.

## [2.7.2] - 2026-10-07

A fix release for clients that sent tool arguments as a serialized string
(issue #51). Nothing breaks for existing callers. The only change to the
declared surface is that `edit` now inlines its edit-spec schema instead of
referencing it through `$defs`.

### Fixed

- **`edit` publishes a schema every client can read.** Its input schema no
  longer hoists the `oldText`/`newText` spec into `$defs` behind a `$ref`;
  the spec is inlined at both `edits` and `files[].edits`. Clients whose
  schema converter could not follow the `$ref` treated `edit` as an opaque
  input and sent its arguments as a serialized string.
- **Stringified-and-spread arguments are recovered.** When a client
  serializes a tool's arguments and then spreads the string into an object
  (`{ "0": "{", "1": "\"", … }`), every tool now reassembles and parses the
  payload. A payload that does not encode a JSON object fails with a message
  naming the cause instead of `Unrecognized keys: "0", "1", …`.

## [2.7.1] - 2026-10-02

A fix release from the 2026-10-02 architecture audit. Searches stop at
their deadline even when the walk finds nothing, completion handles aliased
roots, an omitted search `maxDepth` is unlimited as documented, and two
small result changes follow from internal cleanups. Nothing breaks for
existing callers, and the declared surface (tools, capabilities,
instructions, prompts, resources) is identical to 2.7.0.

### Changed

- **`read` reports every requested path the same way.** A file skipped
  because the batch's combined size budget ran out now returns a
  `TOO_LARGE` row with the default suggestion, like any other oversized
  file, and the progress total counts every requested path.
- **Stdio refuses an over-cap listen up front.** A `subscriptions/listen`
  that names more not-yet-watched URIs than the watcher slots left is
  rejected before any watcher starts, with the same message HTTP sends.

### Fixed

- **Walks stop at their deadline.** The timeout reached only `.gitignore`
  discovery and each yielded entry, so a walk over a large tree with few or
  no matches ran past its deadline and could then report a complete scan.
  The walk now prunes every entry once the deadline fires and fails with the
  timeout: `search_text`, `find_files` and `replace_text` report
  `stoppedReason: 'timeout'`, and `list` and `move` fail with the timeout
  even when the walk yields nothing. A walk with no other filter
  (`includeIgnored: true` and no `maxDepth`) now runs a per-entry check.
- **Completion with aliased roots.** A root reachable by two paths sat in
  the containment set twice, so relative path completion found nothing and
  an empty value listed the root twice. Completion now picks and lists
  roots from the configured root list.
- **An omitted `maxDepth` is unlimited in `search_text` and `find_files`.**
  Both tools capped an omitted `maxDepth` at 100, while `replace_text` and
  the schema said unlimited. Searches without `maxDepth` can now return
  matches deeper than 100 levels.

## [2.7.0] - 2026-09-29

A feature and hardening release. Two security fixes close fail-open gaps in
the sensitive-file policy and the root boundary, resource links and write
results now carry modification times, `--print-config` reports the protocol
revisions the binary negotiates, and one inbound-message bound derived from
`FS_MAX_FILE_SIZE` now governs both transports. The only published schema
change is `create`'s `files` description. Before upgrading, read
**Security** (directory `move`/`copy` can now refuse a tree it used to
transfer; `--root-boundary` can now skip startup roots it used to allow),
**Changed** (one `create` call's combined content is capped at
`FS_MAX_FILE_SIZE`), and **Fixed** (subdirectory walks can return fewer
entries now that ancestor `.gitignore` files apply).

### Security

- **Directory move/copy keeps the sensitive-file policy invariant.** A directory transfer is refused (`ACCESS_DENIED`, nothing moves) when any entry in its tree would change protection status: a file denied at its source but not at the destination (an operator `secrets/**` moved to `public/`), or a file that would land on a protected path (a tree that would create `.aws/credentials`). Entries protected by name (`.env`, `*.pem`) stay protected either way and move with their directory as before. The pre-walk fails closed when it cannot inspect the whole tree.
- **`--root-boundary` now applies to startup roots.** Positional directories, `FS_ALLOWED_DIRS` and `--allow-cwd` roots outside the boundary are skipped with a warning instead of being allowed; previously only access grants were checked.

### Added

- **Modification times on links and results.** `resource_link` blocks from `read`, `create`, `edit`, `patch` and `replace_text` carry `annotations.lastModified`; `read` entries carry `modified`, and `create` and `replace_text` results carry `lastModified`. Cached-result resources report their creation time the same way.
- **`--print-config` reports protocol and wire limits.** A `protocol` block names the modern revision, the legacy versions the SDK supports and the pinned SDK packages; `limits` adds `maxInboundMessageBytes`.

### Changed

- **One inbound-message bound for both transports.** The stdio read buffer and the HTTP body limit are both `3 × FS_MAX_FILE_SIZE + 1 MiB` (31 MiB by default; previously 10 MiB on stdio and 4 MiB on HTTP), and the 413 response and stdio overflow log name the bound. One `create` call's combined content is now capped at `FS_MAX_FILE_SIZE`, so a schema-valid batch always fits on the wire; a larger batch is refused with a message to split it.
- **MCP SDK 2.2.0.** `@modelcontextprotocol/server` and the test client move from 2.1.0 to 2.2.0 (patch-level SDK fixes: no unhandled rejection when notifying a closed connection; `subscriptions/listen` streams that honor no notification type now close after the acknowledgement). `@modelcontextprotocol/node` 2.1.0 and `@modelcontextprotocol/express` 2.0.1 are unchanged (latest).
- **`search_text` is faster on large trees.** Files are read with bounded concurrency and each file is tested once as a whole before its lines are scanned, so a search over thousands of non-matching files no longer approaches the 5 s limit. Results are unchanged; `filesScanned` may count a few files past the result cap.

### Fixed

- **Dropped confirmations are asked again.** When the SDK discards a client's answer to a confirmation form (a wrapped result instead of the bare elicitation result), `create`, `delete` and `move` re-issue the question once instead of refusing; a second drop is named as such in the `CANCELLED` refusal.
- **Rejected stdio cancellation requests preserve subscriptions.** Requests mistaken for cancellation notifications no longer suppress queued subscriptions or detach active file watchers.
- **File-resource reads honor cancellation.** Cancelled requests stop before starting work, and raw file reads pass the request signal to Node's buffered read.
- **URL-only elicitation clients receive actionable tool errors.** Operations requiring a confirmation form now explain the existing workaround instead of failing with a missing-capability protocol error.
- **Legacy confirmation progress stays increasing.** Access-grant and overwrite rounds no longer restart the same progress token; startup notifications wait until work is reported or the call finishes.
- **Browser clients can read recovery headers.** Allowed origins can inspect `WWW-Authenticate` on authentication failures and `Retry-After` on rate-limit responses.
- **Subdirectory walks honor the repository's `.gitignore`.** `find_files`,
  `search_text`, `replace_text` and `list` scoped to a subdirectory now apply
  every `.gitignore` from that directory up to the allowed root that contains
  it, nearest file winning, as git does. Nothing above an allowed root is read.
- **`search_text` on a file whose name contains glob characters.** Naming `pages/[slug].tsx` searched other same-directory files (the name was read as a glob); it now searches exactly that file.
- **`search_text` counts skipped binary files as scanned** and caps matches per file before assembling results.
- **Globs may contain `..` inside a segment.** `docs/v1..2.md` and `**/[..]x` are accepted by `find_files`, `search_text` and `replace_text`; only a whole `..` segment or brace alternative is refused. (Brackets remain a character class, as in any glob.)

## [2.6.3] - 2026-09-28

A small release for plugin hosts. A root argument written as `${NAME}` now
reads that variable from the environment, which lets the Copilot CLI and
Antigravity CLI plugins start the server with the project as its root.
Nothing changes for other arguments, and the declared surface (tools,
capabilities, instructions, prompts, resources) is identical to 2.6.2.

### Added

- **`${NAME}` placeholders in root arguments.** A positional root given as
  exactly `${NAME}` is now read from the server's environment, and dropped
  when the variable is unset or empty. Plugin hosts that pass their
  variables through unexpanded (Antigravity CLI, or Copilot CLI launched from
  PowerShell) no longer produce a nonexistent root or a startup failure.
  This lets the Copilot CLI and Antigravity CLI plugins start the server
  with `${PWD}` as the project root.

## [2.6.2] - 2026-09-28

A fix release so the server starts on runtimes older than Node 24. Nothing
changes on Node 24 and later, and the declared surface (tools, capabilities,
instructions, prompts, resources) is identical to 2.6.1.

### Fixed

- **Startup crash on Node 22.** The server crashed at startup with
  `TypeError: RegExp.escape is not a function` on runtimes without
  `RegExp.escape` (added in Node 24). npm only warns on `engines`, so
  directory sandboxes such as mcp.so's tool fetch still ran it there. A
  fallback implementing the same algorithm now takes over when the native
  function is missing. The supported range is still Node 24 and later.

## [2.6.1] - 2026-09-26

A fix release for the dry-run metadata of the editing tools. `edit`'s dry
run regressed in 2.6.0 and reported metadata for the wrong input. Read
**Fixed** before upgrading if a client reads `resourceUri` from a `patch` dry
run: that field and the `resource_link` block are no longer returned there.
The declared surface (tools, capabilities, instructions, prompts, resources)
is identical to 2.6.0 apart from two output-schema field descriptions.

### Fixed

- **`edit` dry-run metadata.** A dry run reported the size, line count and
  MIME type of the file's path string instead of the would-be content.
  Regressed in 2.6.0.
- **`patch` dry run no longer links the file.** A dry run advertised a
  `resourceUri` and a `resource_link` for content it never wrote, matching
  neither `edit` nor `replace_text`.
- **`resourceUri` descriptions.** The `edit` and `patch` output schemas now
  say the field is omitted on a dry run or over the text-size cap. `edit`'s
  previous text ("omitted when no edit matched") never matched its behavior.

## [2.6.0] - 2026-09-26

A hardening and stability release. Five security fixes close fail-open
access gaps, the walking and editing tools gain a batch of correctness
fixes, and the 21 verified over-engineering audit cuts land with no
published surface change. The declared surface (tools, capabilities,
instructions, prompts, resources) is identical to 2.5.2. Read **Changed**
before upgrading: HTTP requests are refused before their body is parsed,
several tools now refuse files they previously mishandled (UTF-16,
non-UTF-8, oversized regex inputs, duplicate batch paths), and `edit`'s
diff fields are now optional.

### Security

- **POSIX path containment.** `isPathInsideDirectory` treated `\` as a
  path separator on every platform, so on POSIX a pre-existing sibling
  directory named `<root>\x` outside the sandbox was judged inside the
  root — allowing reads, writes, and deletes outside it. A backslash now
  separates path components only on Windows.
- **Sensitive files denied by default.** Modern SSH key types and common
  credential stores are refused by the sensitive-file guard.
- **Safer grant targets.** Grants for ancestors of the home and system
  directories, and for subtrees of well-known secret files, are refused
  outright.
- **Windows reserved device names.** `CON`, `PRN`, `AUX`, and friends are
  refused on Windows only, so the same name on POSIX stays usable.
- **Hardened .gitignore loading.** The walker loads only regular
  `.gitignore` files under 1 MiB, so a special file or a huge generated
  ignore list can no longer stall or poison the walk.

### Added

- **`--print-config` reports the access policy.** The deny and allow glob
  lists and the configured boundary print alongside the roots.
- **Structured resources errors.** Protocol errors carry the Problem
  identity fields in `error.data`.
- **Coalesced `list_changed`.** Same-tick `resources/list_changed`
  notifications are debounced into one.
- **HTTP error observability.** Node-adapter 500s reach the logger via
  the SDK's `onerror` hook.

### Changed

- **Request bodies are parsed after auth.** `POST /mcp` now mounts its
  JSON parser after CORS, rate limiting, and bearer auth: an
  unauthenticated or rate-limited request is refused without its body
  being read, malformed JSON from an unauthenticated caller gets 401
  instead of 400, and parser refusals carry the CORS header.
- **Tighter default exclusion in walks.** A default-excluded name (e.g.
  `node_modules`) is now also excluded below a dot-directory, and the walk
  prunes past `maxDepth`. Large-tree walks drop from ~3.7 s to ~0.43 s.
- **`search_text` skips binary files.** Files containing a NUL byte are
  skipped (counted in a new `skippedBinary` field) and CRLF lines split
  correctly, so `$`-anchored patterns match.
- **`read` refuses UTF-16 files by name.** They previously decoded as
  lossy UTF-8; they now answer `INVALID_INPUT`.
- **`edit`, `patch`, and `diff` refuse non-UTF-8 files.** A stray Latin-1
  byte used to be silently rewritten as U+FFFD on save; these tools now
  answer `INVALID_INPUT`. `read` keeps its tolerant behavior.
- **Every diff is bounded by 1 s.** A pathological diff degrades instead
  of freezing: the `diff` tool answers `TOO_LARGE`, and `edit`'s
  `linesAdded`/`linesRemoved`/`diff` fields are now optional and may be
  absent.
- **`replace_text` guards the regex engine's input size.** Regex-mode
  replacements above RE2's safe input size answer `TOO_LARGE` and name
  the `caseSensitive: true` workaround.
- **Path validation refuses only a whole `..` segment.** `;`, `|`, and
  backtick are ordinary characters again, so
  `app/blog/[...slug]/page.tsx` and `docs/v1..2.md` are legal.
- **Duplicate paths rejected in batch mode.** `create` and `edit` refuse
  a batch that names one file twice instead of racing the entries.
- **Aliased roots count once.** A root configured through a symlink or an
  8.3 short name lists once in `list_roots` and `--print-config`.
- **Malformed subscribe paths answer `-32602`** with `error.data`,
  matching `resources/read`.
- **`FS_PUBLIC_URL` fragments are stripped**, per RFC 8707.
- **Leaner internals from the over-engineering audit.** 21 verified cuts,
  net -201 lines: the Smithery publish check uses the SDK's stdio client,
  tsconfig keeps only the `lib` entries in use, `win32.parse` replaces a
  hand-rolled drive-spec parser, and the batch tools share one
  `perPathEnvelope` schema factory.

### Fixed

- **Watchers survive atomic replaces.** A file subscription watches the
  parent directory, so replace-by-rename still notifies.
- **`edit` matches CRLF files.** Consistently-CRLF files match and keep
  their line endings.
- **`edit` edge newlines under `ignoreWhitespace`.** A newline run at the
  very start or end of `oldText` matches exactly, without swallowing
  surrounding blank lines.
- **Case-only renames work.** `move` performs a case-only rename instead
  of reporting nothing.
- **Pagination survives an oversized cache.** A page larger than the
  cache returns instead of failing.
- **Batch read budgets by returned bytes.** Ranged reads are bounded
  again, and a batch skips only the file that does not fit.
- **Walk dirents anchor to the walk root.** A dirent whose parent path
  came back relative no longer crashes the `ignore` library.
- **Atomic writes commit unraced.** An abort that fires mid-rename
  reports cancelled without double-applying on retry, and the temp file
  keeps the target's mode.
- **No phantom last match.** `search_text` no longer matches the empty
  line after a trailing newline, and match lines own their strings.
- **Path completion reports `hasMore`.** Completions past 100 matches say
  so instead of truncating silently.
- **Refusals name the real env vars.** Error messages point at
  `FS_ALLOW_SENSITIVE` and `FS_API_KEY`, and the next-page hint prints a
  callable form.
- **Diff stats count lines only inside hunks.** Content lines starting
  with `--` or `++` are no longer dropped.
- **An empty Smithery key fails the publish step** instead of passing
  green.

## [2.5.2] - 2026-09-25

A maintenance release: the MCP SDK moves to 2.1.0 and the bundle publishes to
Smithery. The published surface (tools, capabilities, instructions, prompts,
resources) is identical to 2.5.1, so nothing needs adapting before you
upgrade.

### Changed

- **MCP SDK 2.1.0.** `@modelcontextprotocol/server` and
  `@modelcontextprotocol/node` move from 2.0.0 to 2.1.0, and
  `@modelcontextprotocol/express` from 2.0.0 to 2.0.1. `ignore` moves to
  7.0.10.

### Fixed

- **Smithery publishing.** The Smithery CLI copies the bundle manifest's tools
  into its server card, and Smithery rejects a card whose tools lack an
  `inputSchema`, which the MCPB manifest cannot carry, so every CLI publish
  failed with 400. The Release workflow now sends the unchanged bundle through
  Smithery's API with a server card built from the server's own `tools/list`,
  and fails with Smithery's reason when a publish is rejected.

## [2.5.1] - 2026-09-25

A distribution release: the server now ships as a Claude Desktop extension
and a Cursor plugin. No source file changed, so the published surface is
byte-identical to 2.5.0 and nothing needs adapting before you upgrade.

### Added

- **Desktop extension bundle.** Each GitHub release now carries
  `filesystem-mcp.mcpb`, an MCP Bundle with the server and its production
  dependencies. Open it with Claude Desktop, pick the directories to allow,
  and it runs on Claude Desktop's built-in Node.js. The README links the
  latest bundle under Configure in Claude Desktop.
- **Cursor plugin manifest.** `.cursor-plugin/plugin.json` and `mcp.json` at
  the repo root let Cursor install the server as a plugin. It passes no
  directory, so the server uses the workspace roots Cursor declares or asks
  before touching a path.
- **Smithery publishing.** The Release workflow publishes the bundle to
  Smithery as `j0hanz/filesystem-mcp` when a `SMITHERY_API_KEY` secret is set.
- **README: comparison with the reference server and a Privacy Policy.** The
  comparison lists what differs from `@modelcontextprotocol/server-filesystem`;
  the policy states that the server collects nothing, makes no outbound
  requests, and keeps nothing after it exits.

## [2.5.0] - 2026-09-23

A release for the model reading the tools: every tool description is
rewritten for tool selection, and auditing each one against the code surfaced
six bugs, fixed here. No tool is renamed and no input field changes shape.
Read Changed before upgrading if a caller passes `find_files` or
`search_text` a glob without `/` and expects top-level matches only, or
parses `list` tree text. Read Fixed if a caller parses `edit` or
`replace_text` result text, sends `patch` hunks out of file order, names a
binary file as `replace_text`'s `path`, or matches a `resources/subscribe`
error code.

### Changed

- **Tool descriptions were rewritten for models.** Each now leads with what
  the tool does and the command it resembles (grep, cat, sed -i, git apply),
  and names a sibling only where the two are easy to confuse. Anything the
  parameter schema already says, operator-only setup, and imperative
  reminders are gone, as are claims that did not match the code. Read-only
  tools no longer name write tools, which are absent under `--read-only`.
  `tools/list` shrinks from about 20,100 to 18,100 characters.
- **`find_files` and `search_text` match a glob without `/` at any depth**,
  the way `replace_text` already did. `*.ts` or `config.ts` used to match
  only at the top of the searched directory, so a search could not preview
  what a replace with the same glob would touch. A pattern containing `/`
  stays anchored to the searched directory; `maxDepth: 0` keeps a search to
  the top level.
- **`list` marks directories with a trailing `/`** in its tree.

### Fixed

- **`replace_text` corrupted binary and non-UTF-8 files** that contained a
  match, rewriting every undecodable byte as U+FFFD. A sweep now skips such
  files and counts them (`N binary skipped`); naming one as `path` is an
  `INVALID_INPUT` error.
- **Dry-run previews reached no model.** `edit` with `dryRun` and
  `replace_text` with `dryRun` or `returnDiff` put the diff only in `_meta`,
  which clients do not show the model. The diff now follows the summary line,
  and `edit` quotes each `oldText` that did not match.
- **`replace_text` stopped early and failed without saying so.** Hitting
  `maxResults`, `maxFiles`, or the timeout now adds a `// scan stopped early`
  line, a diff cut at 20 KB says so, and each failed file's reason follows the
  summary instead of only a failure count.
- **`search_text` and `find_files` hid skipped files.** A lone match in a
  file over the size limit read as `No matches`; the text now says how many
  files were skipped as too large or inaccessible.
- **`list` pages after the first drew an empty tree** when `maxDepth` was
  above 1. Entries whose parent directory sat on an earlier page are now drawn
  under that parent.
- **`patch` could duplicate content.** jsdiff tried each hunk at its header
  line even when that pointed back into text an earlier hunk had already
  changed, and emitted the region between twice. Each hunk now starts after
  the previous one: out-of-order hunks are rejected and nothing is written,
  while in-order hunks with wrong line numbers land in the right place.
- **A failed `edit` named no `oldText`.** The error now quotes each one that
  did not match.
- **`resources/subscribe` misrouted custom-scheme URIs.** A listed
  `filesystem-mcp://result/` URI was answered as not found; it is now refused
  as not supporting subscriptions, like other non-file resources. An
  unparseable URI answers `-32602` instead of `-32603`.
- **CORS reflection could disagree with the Origin gate.** A localhost
  Origin passed the preflight even when `FS_ALLOWED_ORIGINS` had replaced the
  loopback default and the request itself was refused with 403. Reflection
  now uses the SDK's own Origin check over the same list.

## [2.4.1] - 2026-09-17

A bug-fix release. One paging line reported the wrong range; the published
surface is byte-identical to 2.4.0, so nothing needs adapting before you
upgrade.

### Fixed

- **`search_text` reported the wrong range when `context` was set.** The
  `// showing X-Y of Z matches` trailer counted rendered rows, which include
  the grep-style context lines and the `--` separators between groups, while
  the total counted matching lines. A search with `context: 2` over ten
  matches read `// showing 1-50 of 10 matches`. Both sides now count matching
  lines. The default `context: 0` was never affected, and neither were `list`
  or `find_files`.
- **`--help` no longer documents fleet mode.** The `FS_REQUEST_STATE_KEY`
  entry still described a shared-key requirement for the deployment mode
  removed in 2.1.1. The key is optional, and 32 bytes or more when set.

## [2.4.0] - 2026-09-17

A trim release: one over-engineering audit applied across the tree, plus
three confirmation-flow refinements. No tool is renamed and no input field
changes shape. Read Removed before upgrading if a launcher passes `--safe` or
`--json` (the parser is strict, so an unknown flag now stops startup), and
Changed if a caller reads `resourceUri` off a `diff` or `stat` result or
parses the `--print-config` table.

### Security

- **Confirmation tokens are bound to their request and caller.** The
  `requestState` a `delete`, `move`, `copy`, `create` or access-grant
  confirmation carries is now HMAC-bound to the JSON-RPC method that minted
  it and to the authenticated caller (`clientId` on the HTTP leg; empty on
  stdio), on top of the operation and path binding it already had. A token
  echoed under another method or by another caller is refused with the SDK's
  `-32602 Invalid or expired requestState`. A well-behaved client sees no
  change: it echoes the token on the same connection it received it on.

### Changed

- **A refused confirmation says why.** When a `create` overwrite, a `move` or copy overwrite, or a `delete` confirmation comes back without an accepted answer, the `CANCELLED` error used to say `declined or missing`. It now says `declined by the user`, `dismissed by the user`, `answered without a valid choice`, or `not answered`, read from the SDK's `inputResponse` view of the retried call. Nothing about which choices are offered or what proceeds changes.
- **Confirmation forms label their field.** The `input_required` forms for overwrite, delete and access-grant confirmations now carry a `title` on their one field — `Confirm` for the yes/no grant, `Action` for the overwrite/skip and delete/skip choice, `Allow` for the multi-directory grant — so a host that renders the form shows that label instead of the property name `confirm` or `choice`. The offered values and the `message` text are unchanged.
- **`tools/list` publishes the SDK's own schema conversion.** Each tool's
  `inputSchema` is now the Zod schema handed straight to `registerTool`, so the
  wire copy carries the `$schema` key and the `examples` arrays the server
  used to strip. About 1.1 kB more per session start; validation, defaults and
  error messages are unchanged.
- **`--print-config` always prints JSON.** The coloured table and the `--json`
  switch that selected between the two are gone.
- **`diff` and `stat` no longer externalize their result.** Both carried the
  whole payload inline already; the `resourceUri` field and the
  `resource_link` block that pointed at a duplicate store entry are dropped.
- **Path completion is uncached.** The 100 ms result cache in front of
  `completion/complete` is gone; a completion is one directory read.

### Removed

- The `--safe` alias for `--read-only` and the `--json` switch. The argument
  parser is strict, so a launcher still passing either exits at startup with
  `Unknown option`; pass `--read-only`, and drop `--json`.
- `FS_MAX_INLINE_MATCHES`, deprecated in 2.2.0 and ignored since. Unset it;
  every removed variable is ignored, not rejected.
- `FS_KEEPALIVE_TIMEOUT_MS`, `FS_MAX_REQUEST_BYTES`, `FS_MAX_READ_MANY_BYTES`
  and `FS_SEARCH_TIMEOUT_MS`. Their defaults (5000 ms, 4 MiB, 512 KiB, 5000 ms)
  are now constants; `FS_MAX_WATCHERS` and `FS_RATE_LIMIT_RPM` stay.
- `tsx` as a development dependency: tests and the stdio harness run on
  Node 24's native type stripping.

## [2.3.0] - 2026-09-16

A security fix for operator deny rules, three additions, and two write tools
that stop guessing. No tool is renamed or removed and no existing input field
changes shape: `create` gains `append` and `overwrite`, `search_text` gains
`context`. Read Security if you rely on `--deny` or `FS_DENYLIST`, and Changed
before upgrading if a caller overwrites files with `create` or passes `edit` an
`oldText` that is not unique.

### Security

- **Deny/allow glob matching is no longer fail-open on hidden files.**
  `posix.matchesGlob` runs with `dot:false` semantics on Node 24, so in 2.2.0
  a deny like `secrets/**` silently let `secrets/.token` through. The denylist
  now compiles its own matcher: `*` and `**` match dot-leading names like any
  other, a terminal `**` matches paths containing newlines, and `{`, `}` and
  `,` inside a `[...]` character class are class members, not brace syntax.
  UNC roots (`//server/share/...`) and NTFS alternate-data-stream spellings
  are matched as their plain path. Upgrade if a deny pattern covers a
  directory that holds dotfiles.

### Added

- `docs/adr/002`, recording that the three 2025-era-only paths (legacy
  `roots/list` seeding, `resources/subscribe`, the deprecated client
  capabilities accessor) are removed together at a dated trigger, and marking
  each site with `sunset(SEP-2577)` so the removal is one grep.
- **`--allow <pattern>` / `FS_ALLOWLIST`: scoped relief from the built-in
  sensitive-file denylist.** Each entry is a glob following the documented
  `--deny` syntax (`*`, `**`, `?`, `[...]` classes, `{a,b}` alternation;
  comma- or newline-separated in the env form). An allow entry lifts only the
  built-in patterns it matches — `--allow dev.pem` exempts that one file
  while every other `.pem` stays denied. Explicit operator denies
  (`--deny` / `FS_DENYLIST`) are never relieved: deny always beats allow,
  fail-closed. A matching allow for a builtin hit that turns out to be a
  typo'd or non-matching pattern relieves nothing.
- **`create` entries accept `append: true`.** The entry adds its content to
  the end of the named file (created if missing) instead of overwriting —
  appending to a multi-GB log never reads it back through model context.
  The result describes the resulting file: size and timestamps from a real
  post-append stat, MIME sniffed from the file's leading bytes, line count
  streamed in bounded memory, and no `resourceUri` when the file exceeds the
  text-size cap the resource store would reject. The append is the commit
  point: a metadata read failure (a POSIX write-only file, say) degrades the
  reported line count rather than failing the append, so a retry cannot
  double-append.
- **`search_text` returns context lines.** `context: N` (0 to 10, default 0)
  carries N lines either side of each match, like `grep -C`. Each match gains
  `before` and `after` string arrays, present only when `context` is greater
  than 0, and the text block switches to grep's layout: `file:line: text` for a
  match, `file-line- text` for a context line, `--` between groups that are
  not adjacent. A line two windows share prints once, as a match when it is
  one. Context lines are not matches: `totalMatches`, `maxResults` and paging
  count matching lines as before, and a cursor minted under one `context`
  value is rejected under another. With `context` unset the output is
  byte-identical to 2.2.0.

### Changed

- **Confirmation forms offer plain enums.** The `input_required` forms for
  overwrite, delete and access-grant confirmations used to carry each option
  as a titled `oneOf`/`anyOf` entry; they now carry a plain `enum` of the same
  values, built by the SDK from one Zod schema per form. A client that rendered
  the per-option title now renders the value — `overwrite`, `skip`, `delete`,
  or the directory path — which is what the title already said.
- **Tool log lines name their request.** Every line a tool writes through its
  request logger now carries `[req <id>]` after the level tag — the JSON-RPC
  id of the `tools/call` — followed by the client's `traceparent` when the
  request carried one in `_meta`, so interleaved HTTP calls can be told apart
  and matched to client-side traces. Both values are client-supplied and are
  stripped of control characters and Unicode line separators before they
  reach stderr — as is the message itself — so a crafted id or path cannot
  forge log lines. Progress-sink failures, which run detached from a
  request, keep their plain prefix.
- **`create` asks before replacing an existing file.** It used to overwrite
  silently, the one write tool with no guard on existing content: `edit` needs
  `oldText` to match, `patch` needs its hunk context, `move` and `delete`
  already confirm. An entry whose path exists now takes the same
  `input_required` round-trip as a `move` onto an existing destination: the
  call writes nothing and returns one Overwrite/Skip prompt per existing file;
  the client retries with the answers, Overwrite replaces the file, Skip lands
  its path in a new `skipped` output array and counts as work done, not a
  failure. A path that did not exist when the prompt went out but does on the
  retry fails closed. Set `overwrite: true` on an entry to replace it without
  the prompt — the same bypass copy has — and `append: true` entries never
  prompt, since an append destroys nothing. A client without the elicitation
  capability gets a tool error naming those two ways forward. A call that
  relied on the silent overwrite now prompts, or errors on such a client — add
  `overwrite: true`.
- **`edit` refuses an `oldText` that matches more than once.** It used to
  splice the first occurrence and report success, so an `oldText` without
  enough surrounding context silently changed a block the caller may not have
  meant. The edit now fails with `INVALID_INPUT` and writes nothing, naming
  the edit, how many places matched, and the first five lines they sit on
  (`edits[0]: oldText matches 3 places (lines 2, 4, 6)`). Edits apply in
  order, so once an earlier edit in the same call has applied, the message
  says the lines are `after earlier edits`. This holds under `dryRun` and
  `ignoreWhitespace`, and a second occurrence counts even when it overlaps the
  first. A call that relied on first-match now fails — add surrounding lines
  to `oldText`, or use `replace_text` with `caseSensitive: true` to change
  every occurrence. In `files` mode only the ambiguous file fails.
- **The HTTP endpoint serves 2025-era clients.** `--port` mode used to answer
  a client that opened with the 2025 `initialize` handshake with HTTP 400; it
  now serves each such request from a fresh server instance, the SDK's
  stateless legacy posture. Reads, listings, searches, edits, prompts, cached
  results and pagination work unchanged. What a stateless request cannot do
  fails closed: a confirmation round-trip (recursive delete, overwrite,
  out-of-root grant) returns the same tool error a client without elicitation
  gets, naming the way forward; `resources/subscribe` is not advertised on
  that leg and is refused with method-not-found rather than accepted onto an
  instance that no longer exists. Modern clients are unaffected. See
  `docs/adr/003`.

### Removed

- **`edit` results no longer carry `lineRange`.** Each result's `_meta` value
  used to include a `[firstLine, lastLine]` pair; it was a conservative bound,
  documented nowhere and read by nothing in the server. `dryRun` returns the
  real unified diff, and `linesAdded`/`linesRemoved` carry the magnitude.

## [2.2.0] - 2026-09-11

Six architecture-audit findings land together, plus a correctness fix the
review of them turned up. No tool name, input schema, output schema, or
annotation changes shape. Two behaviors change deliberately and one bug in
file exclusion is fixed — see below before upgrading if you parse the `list`
text block or rely on `--log-level` to silence startup warnings.

### Fixed

- **Ignored files and directories could survive a walk.** Node's `fs.glob`
  drops a rejected entry when `exclude` is an array of patterns, but when it
  is a function it only prunes descent — it still yields the rejected entry
  itself, and any rejected entry below the top level. The internal filter
  returns an array when no `.gitignore` is found and a function when one is,
  so the mere presence of a `.gitignore` anywhere under the root silently
  changed which entries survived. In practice `find_files`, `search_text` and
  `replace_text` returned nested gitignored files — a `*.log` rule dropped
  `drop.log` but kept `sub/drop2.log`. The predicate is now re-applied before
  an entry is yielded, so both forms agree.
- **The `.gitignore` pre-walk ignores cancellation.** The discovery pass that
  collects `.gitignore` files prunes only `node_modules`, `.git`, `.hg` and
  `.svn` — not `dist`, `target` or `vendor` — so on a large tree it ran
  uninterruptibly and outside the calling tool's own timeout. It now receives
  the caller's `AbortSignal`.

### Changed

- **`list` reports its position on every page.** The text block now carries
  the same `// showing 1-20 of 57 entries.` trailer the other paged tools
  emit, including on the final page, which previously shipped a bare tree and
  read as the complete answer. The cursor moves into that line as
  `Next page: list {"cursor":"..."}`; the old bare `nextCursor: <value>` line
  is gone, and `_meta.nextCursor` is unchanged. The first-page resource
  pointer is now a plain `full tree at <uri>` line.
- **Invalid-setting warnings are no longer silenced by `--log-level`.** A
  rejected value for `FS_MAX_FILE_SIZE`, `FS_MAX_READ_MANY_BYTES`,
  `FS_SEARCH_TIMEOUT_MS`, `FS_MAX_WATCHERS`, `FS_MAX_REQUEST_BYTES`,
  `FS_RATE_LIMIT_RPM` or `FS_KEEPALIVE_TIMEOUT_MS` used to print through the
  logger, so `--log-level=error` hid it while the same typo in
  `FS_ALLOW_SENSITIVE` or `FS_LOG_LEVEL` still printed. All of them now reach
  stderr once per setting, regardless of level.
- **`list` prunes ignored directories during the walk** instead of
  enumerating everything and filtering afterwards, so the contents of an
  ignored directory are never visited.
- Five tool modules and seven export constants renamed to the wire name they
  register (`search-text.ts`/`SEARCH_TEXT`, `find-files.ts`/`FIND_FILES`,
  `replace-text.ts`/`REPLACE_TEXT`, `list-roots.ts`/`LIST_ROOTS`,
  `delete.ts`/`DELETE`, plus `STAT` and `READ`). Internal only — every
  `name:` string on the wire is byte-identical.

### Removed

- **The `excludePatterns` walk option.** It only ever received the default
  exclude list or an empty array, always selected by the same boolean that
  set `respectGitignore`, so the two fields encoded one decision. One
  `skipIgnored` flag now selects both, and `glob.ts` owns what it means. See
  [ADR-001](docs/adr/001-one-skipignored-flag-owns-both-exclusion-rules.md).
- **The `FilesystemServerContext` class.** It is the interface it already was
  to every consumer; two of its five constructor arguments fed fields only
  its own dispose read.
- **Two of three copies of the invalid-setting warning.** `primitives.ts`
  owns it now, which also removes `util.ts`'s only dependency on
  `observability.ts`.

### Added

- `docs/adr/` and its first record, fixing why a walk's exclusion rules are
  one flag rather than two fields, and what that costs.

## [2.1.8] - 2026-09-10

An internal-only release: the third pass over the over-engineering audit,
46 verified cuts across 47 files, net 605 lines removed. No tool, CLI
flag, environment variable, or wire payload changes shape; the OPTIONS
preflight stays endpoint-exact and still fires ahead of the rate limiter
and bearer auth.

### Removed

- **Three CORS middlewares collapsed into one.**
  `reflectAllowedOrigin`, `corsOriginMiddleware`, and
  `corsPreflightHandler` are one `corsMiddleware`: origin reflection on
  every request, preflight answered only on the exact mount-relative `/`
  (so `OPTIONS /mcp/sub` keeps falling through to its 404), via a single
  `app.use('/mcp', ...)` mount.
- **The HTTP per-request factory indirection.**
  `makeHttpModernFactory` and its `getNotifier` getter are inlined into
  `startHttpServer`, and process shutdown disposes the server through
  `http.Server`'s own `Symbol.asyncDispose` instead of a hand-rolled
  close-promise.
- **Dead exports across core and tools.** `timedSignal` (the
  `AbortSignal.timeout` pass-through it wrapped), `isIgnoredByGitignore`,
  `createSearchMatcher`, `toStatPerPathPayload`, `preFilterByBudget`,
  `buildReplacementPlan`, `getRelativeDepth` (inlined to one comparison),
  `isFilesystemRoot` (subsumed by the `isUnsafeCwdPath` root check), the
  `FileInfo` interface, and `server.ts`'s never-read `ctx.fs`/`ctx.resources`
  fields.
- **The delete reassembly's by-path map.** `delete_file` phase 2 writes
  results back by index into the preallocated result array; the
  `byPath`/plan-by-requested bookkeeping is gone.
- **Progress plumbing in `define.ts`.** The tick guard,
  `closeWithDone`/`closeWithFail`, and `composeSignal` — the timeout
  composes through `AbortSignal.any`, and `ProgressSession.complete/fail`
  are called where the removed wrappers stood.
- **Task-runner residue.** `scripts/tasks.mjs` is deleted — the npm
  scripts it wrapped are the documented surface now — and with it
  `docker-compose.yml`, whose only remaining job was referencing the old
  wrapper.
- **Test scaffolding nobody used.** `__tests__/inspector-fixtures.ts` (its
  two exports duplicated by `bootHttpTest` and a direct `writeFile`),
  `MockResponse.writeHead` and the `end(chunk)` body, and the `readOnly`
  options no caller ever passed to `createElicitationClientPair` or
  `createTestHttpHarness`.

### Changed

- `cli.ts` reads `util.parseArgs` values through their inferred type
  (dot access for the plain-named flags), and `CliExitError` carries no
  exit-code parameter — every construction site already exited 1.
- `core/store.ts` prunes expired entries in one loop and enforces size
  limits in one `while`; the second pass and the unreachable-state
  `Logger.error` are gone.
- README, AGENTS.md, and CONTRIBUTING.md document `npm run check` /
  `npm test` directly; CI invokes the same scripts.

## [2.1.7] - 2026-09-10

A single-defect release: file corruption in `replace_text` on any file
containing emoji. No tool, CLI flag, environment variable, or wire payload
changes shape.

### Fixed

- **`replace_text` no longer corrupts files containing astral characters.**
  re2-wasm reports `exec().index`, `lastIndex`, and the replace-callback
  offset in code points, while every JS string operation indexes in UTF-16
  code units. The two agree until the first astral character — most emoji —
  past which every offset is short by one per surrogate pair, so RE2's own
  `[Symbol.replace]` spliced into the middle of neighbouring words and
  silently dropped characters while reporting success and a correct match
  count. `edit` corrupted identically under `ignoreWhitespace: true`, and
  `search_text` reported a column short by the same amount; the
  case-sensitive literal paths of both were unaffected, matching on
  `indexOf`. One `execMatches` generator in `core/search.ts` is now the
  single owner of the conversion, and no caller reads `match.index` or
  `regex.lastIndex` any more. It also owns the advance between matches,
  which the wrapper computed by adding a UTF-16 length to a code-point
  index — an emoji inside a match could skip the one after it. Reported in
  [#24](https://github.com/j0hanz/filesystem-mcp/issues/24).
- **`` $` `` and `$'` in a `replace_text` template resolve against the right
  offset.** They slice the input around the match, and took the same
  uncorrected offset the splice did.

## [2.1.6] - 2026-09-09

An internal-only release: the second pass over the over-engineering audit's
residue list, 22 verified cuts across 22 files, net 308 lines removed. No
tool, CLI flag, environment variable, or wire payload changes shape; the
only behaviour change is that an aborted `FS_ROOT_BOUNDARY` check now
propagates the abort instead of silently dropping grant roots.

### Removed

- **Dead read knobs.** `ReadSpec`'s unreachable options (`skipBinary`,
  per-spec encodings), the write-only `truncated` field on full reads, the
  `ReadSpecCommon` intermediate, and a `ReadContentOptions` interface that
  was byte-identical to `NormalizedBase` with a converter between them.
  Range reads are now byte-bounded through one shape end to end.
- **Duplicate regex work in search.** `search_text` no longer re-executes
  the pattern to compute a match's column offset — `findLineMatches`
  returns count and column from the single exec it already ran.
- **A second pass over replaced files.** `replace_in_files` counted matches
  with a separate `count()` call per file and re-detected MIME types with a
  lossy utf-8 roundtrip; the matcher now counts inside its own `replace`
  callback and reads the `mimeType` `readRaw` already computed.
- **The `edit` regex cache.** Patterns are compiled per edit and freed in
  `try/finally` — the cache reused a fixed 16 MB wasm heap across edits for
  nothing a per-edit compile does not do correctly.
- **Unreachable guards and flags.** `PathGuard`'s unfiltered-grant fallback
  path, `cli.ts`'s `assertDirectory` wrapper, `index.ts`'s
  `keepForceExitTimer` flag and its dead `shutdown_error` catch, the
  try/catch around the `get-help` prompt body (nothing in it can throw),
  `defaultValue` on `input_required` forms (no caller ever passed one),
  `ResourceEntry.storedAt` (only `expiresAt` was ever read), and
  `FsError`'s `path` getter (every `.path` reader reads `problem.path`).
- **Single-use indirection.** `sensitive.ts`'s `CompiledPattern` interface,
  `path-completer.ts`'s `getRootPrefix`, and `define.ts`'s optional
  `ctx` fallback and `ToolCtx.authInfo` field.

### Changed

- `filterRootsWithin` resolves root containment with `Promise.all`, so an
  aborted boundary check rejects instead of filtering every root out as
  "within=false" — a late abort no longer reports a grant as outside the
  boundary.
- `stoppedReason` narrows to `'maxResults' | 'timeout'` on both search
  tools, with the invariant documented at each `resolve()` site.

## [2.1.5] - 2026-09-06

An internal-only release: the over-engineering audit, 39 verified cuts across
45 files, net 299 lines removed. No tool, CLI flag, environment variable, or
wire payload changes behaviour.

### Removed

- **The error `details` channel.** `Problem.details` and the `FsError.details`
  getter carried `errno` and `syscall` that nothing read and no response ever
  rendered, and `FsError`'s constructor loses its `details` parameter. The
  client-visible error shape — `code`, `message`, `path`, `suggestion`,
  `issues` — is unchanged.
- **Dead internal surface.** `PathGuard.isServerContext`, `getRootBoundaries`,
  and the `fromAllowedDirectories` test factory; `fs.ts`'s `hash`,
  `createReadStream`, and `StatPath`; `parseEnvDirList` and the
  `pairFailureSchema` factory. Watcher-registry, resources, transport,
  prompts, and CLI exports are trimmed to their real consumers.
- **Unreachable configuration.** Progress total, batch concurrency, `stat` MIME
  knobs, `hasErrorShape`'s `code` parameter, and `fmt`'s stream parameter. None
  was reachable from a tool argument or an environment variable.

### Changed

- `edit` and `replace_in_files` call diff v9 synchronously — the library is
  sync, so the `await` bought nothing.
- Cursor first-page and replay handling folds into `paginate`; `search_text`
  drops its sort indirection and compiles the pattern once per request.

## [2.1.4] - 2026-09-06

A fix release for silent truncation in the text the two search tools return.
No tool, CLI flag, or environment variable changes behaviour and the structured
payload is untouched — only the text block gains trailing `//` lines.

### Fixed

- **`search_text` and `find_files` now say when a page hides results.** The
  position in the set, the next-page cursor, and the engine's stop state lived
  only in the structured half, which the SDK ships under `_meta` for a tool
  that authors its own text — and no client renders that, so a capped page read
  exactly like a complete answer. Both tools now append
  `// showing 5-8 of 9 matches. Next page: search_text {"cursor":"..."}`, on
  every page of a split set including the last one, which has no cursor. A scan
  the engine cut gets a second line,
  `// scan stopped early: hit the server's 10000-result scan cap`, which names
  the cap rather than echoing `maxResults` — that is also the caller's
  page-size argument. The stop line is independent of the cursor, so a
  truncation with too few results to page still says so.
- **`read`'s continuation echoes the path the caller wrote.** It carried the
  resolved absolute path instead, which on Windows is a backslash-doubling JSON
  string that also spells out the server root. Its hint now names the line to
  resume from (`More lines remain from 501.`) rather than the generic
  `File was truncated.`

## [2.1.3] - 2026-09-06

A release that lands the three seams from the 2026-09-05 architecture audit.
One tool behaviour changes — how `list`, `find_files`, and `search_text`
decide when to store their full result — and one environment variable is
deprecated. The wire format, CLI flags, and every other tool are untouched.

### Changed

- **`list`, `find_files`, and `search_text` externalize on one rule.** An
  incomplete first page — more pages follow, or the engine's hard cap cut the
  set — now carries `resourceUri` to the full result in the resource store, for
  all three tools. Before, `list` stored one only on hard-cap overflow,
  `find_files` on any incompleteness, and `search_text` whenever a page held
  more than `FS_MAX_INLINE_MATCHES` matches. Continuation pages never carry it
  and never mint a new one; `search_text` used to store a fresh copy on every
  continuation page that crossed the inline cap.
- **`search_text` shows a whole page inline.** `maxResults` is the page size and
  the inline count; the separate 50-match inline slice is gone. `truncated` now
  means only that the engine cut the match list (hard result cap or timeout) —
  a set that spans several pages has `nextCursor` and is not "truncated".

### Deprecated

- **`FS_MAX_INLINE_MATCHES`** is read only to log a startup warning; it has no
  effect. Use `maxResults` to set the `search_text` page size. The variable is
  removed in the next major release.

## [2.1.2] - 2026-09-05

A fix release for two transport-boundary defects. No tool, no CLI flag, and no
environment variable changes behaviour, and the wire format is untouched — an
MCP client needs to do nothing.

### Fixed

- **`FS_MAX_REQUEST_BYTES` now applies to every POST, not just JSON ones.** The
  Express body parser leaves `req.body` undefined for anything but
  `application/json`, and handing that undefined body to the Node adapter made
  it read the raw stream with no limit — so a `text/plain` upload, or one with
  no `Content-Type` at all, was buffered unbounded before being rejected. Such
  a POST is now answered `415` before its body is read, and a request with no
  body framing gets a JSON-RPC ParseError instead of being forwarded. The `415`
  envelope matches the one the SDK would have produced.
- **A stdio server no longer outlives its connection.** When the SDK closed the
  transport on a fatal read error — a `ReadBuffer` overflow, for one — nothing
  released the watchers the connection had acquired, and the process stayed
  alive after the client was gone. Teardown now also runs on the transport's
  own close, not only on an explicit `close()`, and it unrefs stdin: the SDK
  pauses stdin only when no other `'data'` listener remains, which otherwise
  holds the event loop open with nothing left to serve. A server instance whose
  construction finishes after teardown is disposed rather than published.

## [2.1.1] - 2026-09-05

A cleanup release. No tool, no CLI flag, and no environment variable changes
behaviour, and the wire format is untouched — an MCP client needs to do nothing.

**One `./transport` export narrows.** `RuntimeConfig` no longer accepts
`eventBus` or `deploymentMode`. This is shipped as a patch rather than a major
because neither field was reachable: `index.ts` builds its `RuntimeConfig` from
`httpHost` and `apiKey` alone, so no CLI invocation could ever set them, and
only a caller importing `startHttpServer` from `@j0hanz/filesystem-mcp/transport`
and passing one explicitly is affected. If that is you, drop both fields —
single-instance behaviour is identical.

### Removed

- **Fleet deployment mode.** `RuntimeConfig.eventBus` and
  `RuntimeConfig.deploymentMode`, the two boot guards that enforced them, and
  `assertFleetRequestStateKey`. The feature fanned change events across
  load-balanced instances, but two instances of a filesystem server either serve
  the same disk, where the fan-out buys nothing, or different disks, where the
  shared state is wrong. `FS_REQUEST_STATE_KEY` stays: it keeps in-flight
  `input_required` rounds alive across a restart, which has nothing to do with
  deployment topology.
- **The `qa` npm script** and the `scripts/qa*` harness behind it. It drove the
  MCP Inspector against `dist/` and rendered an HTML report, duplicating
  `__tests__/inspector-*.test.ts`, and no CI job ever ran it.
- **The `ProgressSink` interface.** `McpProgressSink` was its only
  implementation, so `ProgressSession` now holds that type directly instead of an
  array behind an abstraction. Progress notifications on the wire are unchanged.

### Changed

- The `get-help` prompt no longer rejects a `topic` for blankness or shell
  metacharacters. The handler resolves a topic by `Object.hasOwn` against a
  frozen record, so an unrecognized one already falls through to the not-found
  reply and nothing downstream interprets the string. A non-empty check remains.
- A CLI startup error for an unreadable allowed directory now carries Node's own
  message instead of a string rebuilt from `errno`, and attaches the original
  error as `cause`:

  ```text
  Cannot access directory /no/such/dir: ENOENT: no such file or directory, stat '/no/such/dir'
  ```

## [2.1.0] - 2026-09-05

A minor release, not a major one: the package's own API is untouched. Its
`./transport` exports and every CLI flag and environment variable are byte-for-
byte what 2.0.0 shipped. What changed is how tool results look on the wire, and
an MCP client reading them is not an npm dependent of this package.

**If you maintain a custom MCP client, read the first entry before upgrading.**
Nothing else here needs action.

### Changed

- **Where tool metadata lives.** Tools that return a text result (`read`,
  `list`, `diff`, `patch`, `edit`, `delete`, `move`, `replace_text`,
  `search_text`, `find_files`) now ship their metadata under `_meta` instead of
  `structuredContent`. Clients that treat `structuredContent` as the canonical
  model view — Claude Code among them — discard the text blocks whenever it is
  present, so the model never saw the file `read` returned or the tree from
  `list`. It is the same object under a different field: a client doing
  `result.structuredContent.results` reads `result._meta.results` instead.
  Only `stat`, `create` and `list_roots` keep `structuredContent`.
- `read` appends a `// truncated:` line carrying the continuation args, and a
  `// sha256:` line when `includeHash` is set, after a blank line so neither can
  be read as file bytes. `list` appends a `nextCursor:` line, and a `truncated:`
  notice on hard-cap overflow.
- No tool publishes an `outputSchema` any more. Publishing one obliges the
  result to carry `structuredContent`, which every publisher has stopped doing.
- `stat`, `create` and `list_roots` no longer return a one-line text summary.
  Their value is the metadata, so they return JSON text and keep
  `structuredContent`.

### Fixed

- `list_roots` returns a `hint` naming the three ways to configure a root when
  it has none to list. An unconfigured server used to answer `{"roots":[]}` and
  leave the caller to guess; the elicitation route out — call a tool with a
  concrete path and approve the grant — appeared in no tool description.
  Present only when `roots` is empty.

## [2.0.0] - 2026-08-27

This is a breaking release. Every tool name and every environment variable
changed, and neither has a compatibility fallback. Read the two migration
tables below before upgrading.

### Breaking — tool names

The tool surface was consolidated from 17 tools to 13. Batch behaviour moved
into the single-item tools rather than living in separate `*_many` tools, and
the remaining names were made consistent.

| 1.x tool             | 2.0 equivalent                  |
| :------------------- | :------------------------------ |
| `ls`                 | `list`                          |
| `grep`               | `search_text`                   |
| `find`               | `find_files`                    |
| `mv`                 | `move`                          |
| `rm`                 | `delete`                        |
| `roots`              | `list_roots`                    |
| `apply_patch`        | `patch`                         |
| `diff_files`         | `diff`                          |
| `search_and_replace` | `replace_text`                  |
| `write`              | `create`                        |
| `tree`               | `list` with `maxDepth`          |
| `stat_many`          | `stat` with `paths[]`           |
| `calculate_hash`     | `read` with `includeHash: true` |
| `mkdir`              | removed — see below             |

`edit`, `read`, and `stat` keep their names. Both `read` and `stat` accept
either a single `path` or a `paths[]` batch.

**`mkdir` has no direct replacement.** `create` writes files and creates any
missing parent directories along the way, so a directory can be produced as a
side effect of writing a file inside it. Creating an empty directory on its own
is no longer possible through a tool call.

### Breaking — environment variables

Every environment variable is now prefixed `FS_`, with no fallback to the old
name. A configuration file carrying 1.x names will be read as entirely unset,
which for `FS_API_KEY` means an HTTP server starts unauthenticated. Audit
deployment configuration before upgrading.

| 1.19.1 variable                 | 2.0 variable             |
| :------------------------------ | :----------------------- |
| `FILESYSTEM_MCP_API_KEY`        | `FS_API_KEY`             |
| `FILESYSTEM_MCP_HTTP_HOST`      | `FS_HTTP_HOST`           |
| `FILESYSTEM_MCP_LOG_LEVEL`      | `FS_LOG_LEVEL`           |
| `FS_CONTEXT_ALLOW_SENSITIVE`    | `FS_ALLOW_SENSITIVE`     |
| `FS_CONTEXT_DENYLIST`           | `FS_DENYLIST`            |
| `FS_CONTEXT_MAX_REQUEST_BYTES`  | `FS_MAX_REQUEST_BYTES`   |
| `FS_CONTEXT_MAX_INLINE_MATCHES` | `FS_MAX_INLINE_MATCHES`  |
| `MAX_FILE_SIZE`                 | `FS_MAX_FILE_SIZE`       |
| `MAX_READ_MANY_TOTAL_SIZE`      | `FS_MAX_READ_MANY_BYTES` |
| `DEFAULT_SEARCH_TIMEOUT`        | `FS_SEARCH_TIMEOUT_MS`   |

`FS_ALLOWED_DIRS` and `NO_COLOR` keep their names.

These 1.19.1 variables are no longer read and have no replacement:
`FS_CONTEXT_ALLOWLIST`, `FS_CONTEXT_MAX_INLINE_CHARS`,
`FS_CONTEXT_STRIP_STRUCTURED`, `FS_CONTEXT_SEARCH_WORKERS`,
`FS_CONTEXT_SEARCH_WORKERS_DEBUG`, `FS_CONTEXT_LIST_CURSOR_TTL_MS`,
`FS_CONTEXT_DIAGNOSTICS`, `FS_CONTEXT_DIAGNOSTICS_DETAIL`,
`FS_CONTEXT_TOOL_LOG_ERRORS`, `MAX_SEARCH_SIZE`,
`FILESYSTEM_MCP_MAX_HTTP_SESSIONS`, `FILESYSTEM_MCP_MAX_TASK_TTL_MS`, and
`FILESYSTEM_MCP_MAX_CONCURRENT_TASKS`.

2.0 adds `FS_ROOT_BOUNDARY`, `FS_ALLOW_CWD_WALK`, `FS_ALLOW_MISSING_ROOTS`,
`FS_TRUST_PROXY`, `FS_ALLOWED_HOSTS`, `FS_ALLOWED_ORIGINS`,
`FS_ALLOW_UNRESTRICTED_HOSTS`, `FS_PUBLIC_URL`, `FS_RATE_LIMIT_RPM`,
`FS_MAX_WATCHERS`, and `FS_REQUEST_STATE_KEY`. The README documents every
variable with its default and accepted range.

Boolean parsing also changed. `true` and `1` enable a variable; `false`, `0`,
and empty disable it. Any other value now logs a warning once and reads as
disabled, where 1.x accepted it silently as false.
`FS_ALLOW_UNRESTRICTED_HOSTS` goes through the same grammar as every other
boolean rather than its own.

### Breaking — package exports

The package root export was removed. `dist/index.js` is the CLI entry point: it
parses `process.argv` and starts a server on import, and its declaration file
was empty, so importing the package root never gave callers an API. The
`filesystem-mcp` binary and the `./transport` subpath export are unaffected.

### Added

- `FS_PORT` mirrors `--port`, so the HTTP transport can be enabled entirely
  from the environment. An empty string reads as unset.
- `FS_KEEPALIVE_TIMEOUT_MS` replaces the hard-coded 5-second HTTP keep-alive.
  `headersTimeout` is derived from it as the configured value plus 5 seconds.
  Set this above the idle timeout of any proxy in front of the server.
- The published `server.json` now declares `--read-only`, the `FS_ALLOWED_DIRS`
  environment variable, and the Docker runtime arguments (`-i`, `--rm`, and the
  volume mount), so registry clients generate a working install command for
  both the npm and container packages.

### Fixed

- **`--api-key` and `--http-host` had no effect.** Both were parsed and
  documented but never reached the HTTP server, so `--api-key <secret>` started
  an unauthenticated server. `--log-level`, `--max-file-size`,
  `--root-boundary`, `--allow-sensitive`, and `--deny` were dropped the same
  way. All seven now take precedence over their environment variable, as
  `--help` has always claimed.
- **`FS_LOG_LEVEL` / `--log-level` now filters output.** The value was parsed
  and ignored; every message reached stderr regardless. Messages below the
  configured severity are now suppressed — with the default of `info`, `debug`
  output no longer appears unless requested.
- A loopback HTTP bind rejected `Host: localhost` and `Host: [::1]` with
  `403 Invalid Host`, so `http://localhost:<port>/mcp` failed on a default
  server. All three loopback spellings are accepted.
- Host allow-list values consisting only of separators or whitespace read as an
  empty allow-list that rejected every request; they now read as unset.
- A `500` on the HTTP POST route replied with `id: null` even when the request
  carried an id, leaving clients waiting for a correlatable response.
- **`delete` reported a narrower error shape than every other tool.** Its
  `failures[].error` published only `code` and `message`, dropping the `path`
  and `suggestion` the handler had already computed. It now emits
  `PerFileError`, matching `create`, `move`, and `replace`.

### Changed

- Updated core dependencies.
- Refined internal schemas and agent configurations.
- `--api-key` is documented as development-only; `FS_API_KEY` is the supported
  channel, since argv is world-readable.

### Removed

- **Removed the experimental tasks subsystem.** The task store, task-augmented
  tool execution, and the `FILESYSTEM_MCP_MAX_TASK_TTL_MS` /
  `FILESYSTEM_MCP_MAX_CONCURRENT_TASKS` settings are gone. SEP-2663 removed
  tasks from the SDK; long operations report through progress notifications
  instead.
- **Removed the `logging` capability and the `logging/setLevel` handler.**
  Clients calling `logging/setLevel` now receive `METHOD_NOT_FOUND`. The
  handler only set a field nothing read, and SEP-2577 deprecates the subsystem;
  diagnostics go to stderr, controlled by `FS_LOG_LEVEL`.
- Removed dead diagnostics, tracing, and performance tests from `observability.test.ts`.
- Removed dead W3C trace surface and unreachable diagnostics config from `observability.ts`.
- Removed dead `startPerfMeasure`/`withOpsTrace` and `withToolDiagnostics` subsystems.
- Removed dead `RESOURCE_STORE_DIAGNOSTICS_CHANNEL` and `LIFECYCLE_CHANNEL` publishers.

[2.1.2]: https://github.com/j0hanz/filesystem-mcp/compare/v2.1.1...v2.1.2
[2.1.1]: https://github.com/j0hanz/filesystem-mcp/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/j0hanz/filesystem-mcp/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/j0hanz/filesystem-mcp/compare/v1.19.1...v2.0.0
