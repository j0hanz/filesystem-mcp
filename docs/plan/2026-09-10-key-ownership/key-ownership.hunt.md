# Hunt: key-ownership refactor (post-run)

Hunted 2026-09-10, against the uncommitted working-tree diff of
[`key-ownership.plan.md`](key-ownership.plan.md) (8 files, run log:
[`key-ownership.run.md`](key-ownership.run.md)).

## Confirmed

None.

## Suspected

None.

## Coverage

- Read fully: all 8 changed files — `src/core/input-required.ts`,
  `src/core/cursor.ts`, `src/tools/delete-file.ts`, `src/tools/move.ts`,
  `src/tools/define.ts`, `src/tools/list.ts`, `src/tools/search-files.ts`,
  `src/tools/search-content.ts`.
- Blast radius: judged from the brief's caller lists — `readAccepted*`,
  `pendingRoundTrip`, `paginate`, `defineTool` signatures unchanged; the three
  deleted `*QueryKey` builders were file-local (grep: zero remaining
  references). No blast-radius file needed opening past the brief.
- Dismissed tells: `search-content.ts:83` `.meta({ examples })` marker is
  pre-existing schema description, untouched by the diff.
- Took on trust: SDK `acceptedContent`/`isInputRequiredResult` behavior
  (unchanged usage); the 277-test suite as byte-identity proof (run by
  run-plan, not re-run here).
- Not audited: `__tests__/` (out of diff scope, unmodified), `src/server.ts`
  (codec wiring unchanged).