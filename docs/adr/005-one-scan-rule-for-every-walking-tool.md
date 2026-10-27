# ADR-005: One Scan rule for every tool that walks a scope

**Status**: accepted, 2026-10-27
**Deciders**: j0hanz, in the architecture review of the walked-entry policy; merged as [#142](https://github.com/j0hanz/filesystem-mcp/pull/142)

## Context

Four tools walk a directory scope for a client: `search_text`, `find_files`,
`replace_text` and `list`. Each one decided for itself what to do with an
entry it found, and a fact-finding pass confirmed 29 places where they
disagree. 13 of them a client can see, and 10 look like bugs. Examples:

- `replace_text` reports a `PERMISSION_DENIED` entry as a failure row that
  `list` skips, because its hand-written skip list
  (`src/tools/replace-text.ts`) omits a code that `SKIPPABLE_FS_CODES` has.
- Core search tells a sensitive entry from an inaccessible one by matching
  the text of the `FsError` message that `PathGuard` throws.
- A binary file over 4 MiB is `skippedBinary` in search but a `TOO_LARGE`
  failure in replace, although search is meant to preview what replace
  touches.
- A directory the walk could not read looks empty, so a scan with holes
  reads as complete.
- `maxDepth` is 1-based with a maximum of 50 in `list` and 0-based with a
  maximum of 100 elsewhere. `maxResults` is a page size in search and find
  but a hard match cap in replace.

ADR-001 already gives the ignore rules one flag. This decision gives the
rest of the policy one owner. The glossary calls that policy a **Scan**.

## Decision

A new core module, `src/core/scan.ts`, owns the Scan for all four tools:
resolving the scope, walking it, ruling on each entry, how wide to run in
parallel, the result order, the stop rule and the counters. A tool supplies
only a callback for each usable entry. The module also exports one guarded
read that gives a content verdict. A tool calls that read from its callback,
so `replace_text` can keep its write lock around the read.

The rules every tool now shares:

- **A sensitive entry leaves no trace.** It is never counted, because a count
  would tell the client that a protected file exists under the scope.
- **Every other entry the scan cannot use is counted**, including a
  directory it could not read. That covers denied, missing, out-of-root and
  permission-denied entries. `PathGuard` returns a verdict for an entry
  instead of throwing, so nothing depends on the wording of an error message.
- **Content has four classes:**
  - text;
  - binary, decided by `read`'s rule;
  - undecodable;
  - too large, which is a skip and not a failure.

  `search_text` reads an undecodable file lossily. `replace_text` skips it,
  because it must write UTF-8 back.

- **A scan does not follow a symlinked file.** One link must not pull a file
  outside the scope into a recursive search or replace. `list` still shows
  the link entry itself.
- **A file the client names is not a scan.** An error on that file fails the
  call.
- **One stop rule:**
  - abort comes before timeout, and timeout before the cap;
  - hitting the cap exactly is not truncation;
  - skipped entries do not use up the cap;
  - results come back in walk order;
  - the entry cap is 20000.
- **Inputs mean one thing:**
  - `maxDepth` is 0-based with a maximum of 100 everywhere;
  - `maxResults` is a page size everywhere;
  - `replace_text`'s cap becomes `maxMatches`, and it accepts `maxResults` as
    a deprecated alias for one release.

## Considered options

- **Keep per-tool behavior behind options in one module.** Rejected: it
  moves the divergence into one file but does not end it.
- **Follow symlinked files whose landing is inside a root.** Rejected: the
  same file could be scanned twice, and `replace_text` could write through a
  link the client never named.
- **Count sensitive entries.** Rejected: the count reveals that protected
  files exist, and `stat` already promises not to count them.
- **Keep suppressing unreadable directories.** Rejected: the client cannot
  tell a complete scan from one with holes.

## Consequences

- This is a breaking contract change. The `maxDepth` schema of `list` and
  the `maxMatches` rename for `replace_text` change
  `__tests__/contract.test.ts.snapshot`, and the CHANGELOG has to call them
  out.
- `list` now returns partial results on a timeout instead of failing, so
  `docs/client-guide.md` has to change.
- Tests of the walk policy move to `__tests__/scan.test.ts`. The tool tests
  that only re-checked that policy through `callTool` are removed.
- The walks inside move protection, undo, `stat`'s entry count and
  `delete`'s child check are not Scans. Move protection and undo's checks
  must see every entry and fail closed (ADR-001 amendment). The others read
  one level for a different question.
