# ADR-021: Same-Entry in a Batch follows the guard's directory rule

**Status**: accepted, 2026-11-16 (scope narrowed the same day)
**Deciders**: j0hanz, in the architecture review of 2026-11-16 (Candidate 2)

## Context

Batch tools decided "these two items name one entry" with whichever helper
each picked: `create` and `move` used `isEquivalentPath` / `unicodeMatchKey`,
`edit` used `isSamePath`, `delete` used `normalizeCaseForComparison` plus
identity. All read the global `IS_CASE_INSENSITIVE_FS`, while `PathGuard`
decides case sensitivity per directory.

Implementation showed most of that drift is harmless:

- Checks on validated paths (`create`'s Landing check, `delete`'s
  `seenTargets`, `move`'s destinations) already compare the guard's on-disk
  spellings, so a Respelling is already one Entry there.
- `edit` takes its write lock on the resolved path, so two spellings of one
  file serialize and both edits land (`__tests__/unicode-paths.test.ts`,
  "edit applies, and delete collapses, two spellings of one file").

The real defect was in `create`'s schema-level checks, which folded raw
spellings: two existing, distinct files whose names fold alike (`a b.txt` and
`a b.txt`) were refused as duplicates, and the Landing check refused them
again with "another entry in this batch".

## Decision

`PathGuard.entryKeys` returns one key per path; equal keys name one Entry.

- **Rule**: a path naming an existing entry, as spelled or as its one
  Respelling, keys on that entry, so two existing entries stay apart. A
  missing path keys on its folded spelling: Unicode form and space characters
  always fold; letter case folds only when the holding directory (or its
  nearest existing ancestor inside a root) is case-insensitive. Outside the
  roots, or when nothing can be read, `IS_CASE_INSENSITIVE_FS` decides.
- **Scope**: `create` only. Its duplicate-file and duplicate-directory checks
  leave the zod schema and run before planning, with the same
  `INVALID_INPUT` messages; its Landing check keys through `entryKeys`.

## Considered options

- **All four Batch tools** (the original scope). Rejected: `edit`
  deliberately serializes Respellings, and `delete` and `move` already
  compare validated paths; refusing Respellings in `edit` would break tested
  behaviour that loses no data.
- **Spelling-only keys** (fold every path). Rejected: merges two existing
  entries whose names fold alike.
- **Spelling plus inode.** Rejected: merges hard links, distinct Entries.
- **Keep a sync pre-check in the schemas.** Rejected: two rules drift again.
- **Make undo's `journalRecords` async.** Rejected: its paths are on-disk
  spellings, not client respellings.

## Consequences

- `create` overwrites two existing files whose names fold alike in one call.
- The advertised input schemas do not change; the contract snapshot stays.
- `define.ts` keeps its second schema parse for `create`'s
  file-versus-directory conflict check.
