# ADR-021: Same-Entry in a Batch follows the guard's directory rule

**Status**: accepted, 2026-11-16
**Deciders**: j0hanz, in the architecture review of 2026-11-16 (Candidate 2)

## Context

Batch tools decided "these two items name one entry" with whichever helper
each picked:

- `create` and `move` used `isEquivalentPath` / `unicodeMatchKey` (Unicode
  and full case fold).
- `edit` used `isSamePath` (ASCII case fold, no Unicode).
- `delete` used `normalizeCaseForComparison` (ASCII only) plus identity.

All of them read the global `IS_CASE_INSENSITIVE_FS`, while `PathGuard`
decides case sensitivity per directory (`isDirectoryCaseSensitive`). So an
NFC and an NFD spelling of one name were duplicates in `create` but not in
`edit`, and a case-sensitive folder on Windows or macOS was judged by the
wrong rule.

## Decision

`PathGuard` answers same-Entry for Batch tools through one async method that
returns a key per path; equal keys name one Entry (a Respelling).

- **Rule**: Unicode form and space characters always fold; letter case folds
  only when the directory that holds the entry is case-insensitive. A
  missing entry or parent takes the rule of its nearest existing ancestor
  inside a root; with no such ancestor it falls back to
  `IS_CASE_INSENSITIVE_FS`.
- **Scope**: the duplicate checks of `create`, `edit`, `delete` and `move`.
  `edit`'s and `create`'s checks leave their zod schemas and run in `run`
  before any change, with the same `INVALID_INPUT` messages.
- **Out of scope**: root and grant comparisons in `path.ts`, Scan name
  matching, containment checks (`isPathInsideDirectory`, `nestedIndexes`),
  `delete`'s identity check for an entry replaced during Confirmation, and
  undo's refused-path filter, which compares spellings the server recorded.

## Considered options

- **Global flag, sync.** Rejected: still disagrees with the guard in
  case-sensitive directories.
- **Spelling plus inode.** Rejected: merges hard links, which are distinct
  Entries.
- **Keep a sync pre-check in the schemas.** Rejected: two rules drift again.
- **A sync key from a cached directory rule.** Rejected: adds cache state and
  invalidation for no caller that needs sync.
- **Make undo's `journalRecords` async.** Rejected: its paths are on-disk
  spellings, not client respellings.

## Consequences

- The advertised input schemas do not change (refinements are not in the JSON
  schema); the contract snapshot stays the same.
- `define.ts` keeps its second schema parse: `create`'s file-versus-directory
  conflict check still runs there.
