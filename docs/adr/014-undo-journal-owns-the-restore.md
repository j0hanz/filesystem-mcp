# ADR-014: The undo journal owns the restore

**Status**: accepted, 2026-11-12
**Deciders**: j0hanz, in the grilling of the undo-restore candidate from that day's architecture review

## Context

`UndoJournal` in `src/core/undo.ts` held the entries and the two operations
that keep them consistent after a restore: `reidentify`, which re-keys move
records when a restore replaces a file, and `replaceRecords`, which drops what
was restored. The restore itself ran in the undo tool
(`src/tools/undo.ts`), which had to:

1. take the journal's lock;
2. pick the entries (an id, the newest N, all on a bare dry run, or the newest one);
3. build one `UndoPreview` shared by every entry of a dry run;
4. pass an `onRewrite` callback that called `journal.reidentify`;
5. call `journal.replaceRecords` after each real restore.

A caller that skipped step 4 or 5 left the journal unable to restore later
moves, and nothing failed at the time. Six tests in `__tests__/undo.test.ts`
rebuilt steps 4 and 5 by hand around `restoreEntry`, so the tests exercised
a copy of the protocol rather than the module.

## Decision

`UndoJournal.restore(selection, fs, { dryRun, signal, onProgress })` owns the
whole restore: the lock, the selection rule and its `NOT_FOUND` refusal, the
shared dry-run preview, the re-keying and the pruning. It returns one
`{ id, tool, results }` step per entry, newest first.

- The undo tool keeps only what depends on the transport and the client:
  the disabled check, the id-or-steps rule, the HTTP refusals, and the report.
- `restoreEntry` and `restoreOrder` are private.
- `UndoPreview` stays exported, marked `@internal`, for one emulator test
  whose shape no record sequence reaches.
- Entries are selected before the first await, so an entry a concurrent call
  adds during a restore is not taken by it.
- An abort keeps what finished: restored records leave the journal, the rest
  stay under their id, and the call rejects.

## Considered options

- **A free function that takes the journal.** Same depth, but a second caller
  could still pass a different journal or none; rejected.
- **The tool keeps the selection.** Smaller move, but the interface then takes
  entries the caller must have fetched and pruned correctly; rejected.
- **Keep `restoreEntry` exported without `onRewrite`.** Two interfaces to one
  behaviour, and record-level tests would still bypass the journal; rejected.

## Consequences

- Locality: the journal-consistency rules live in one module; tests reach
  restore only through `journal.add` and `journal.restore`.
- No advertised surface changes; the contract snapshot does not either.
- Do not add a second restore path beside the journal; extend `restore`.
