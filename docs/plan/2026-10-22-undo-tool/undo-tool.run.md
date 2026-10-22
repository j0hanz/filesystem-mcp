# Run: Every file-changing tool call can be reverted with a new `undo` tool

Executing [`undo-tool.plan.md`](undo-tool.plan.md), started 2026-10-22 at `797a7deb`.

- **1** 2026-10-22 — done. `npm run build` → exit 0; hash tests → 1 pass.
- **2** 2026-10-22 — done. UndoJournal tests → 6 pass, 0 fail.
- **3** 2026-10-22 — done. `npm run build` → exit 0; undo + core-fs suites → 93 tests, 82 pass, 0 fail (11 skip: platform/symlink-privilege skips).
- **4** 2026-10-22 — done. restoreEntry tests → 9 pass, 0 fail (1 suite-wide POSIX skip). `git grep "from '../tools" -- src/core` → empty.
- **5** 2026-10-22 — done. build + type-check:test → exit 0; undo suite → 29 pass; full `npm test` → 898 tests, 877 pass, 0 fail. No existing test needed an exact-text update.
- **6** 2026-10-22 — done. undo suite → 41 tests, 40 pass, 0 fail (1 POSIX skip); includes the issue example (case b), the HTTP id-required case (i), HTTP cross-request undo (j), and the stdio subprocess case (k). annotations test → 1 pass after adding 'undo' to the mutating set.
- **7** 2026-10-22 — done. delete wording, TOOL-SURFACE-002 count 14 + budget 20550 (measured 19949/9357), snapshot regenerated (only the undo tool, delete wording, and Write row changed), mcpb row added, README/configuration/client-guide/CONTRIBUTING/cli-help/CHANGELOG updated. `npm run check` → exit 0 (one knip fix: `FileIdentity` de-exported). `npm run test:coverage` → exit 0.

## Done

- [x] `npm run check` → exit 0 (909 tests, 888 pass, 21 skip)
- [x] `npm run test:coverage` → exit 0 (95.76 lines / 90.82 branches / 94.36 functions)
- [x] `node --test --test-timeout=60000 __tests__/undo.test.ts` → 41 tests, 40 pass, 0 fail; includes the issue example sequence and the HTTP id-required case
- [x] `git grep -n -e "This cannot be undone" -e "Permanently delete" -- src mcpb` → empty (exit 1)
- [x] `git grep --untracked -n "from '../tools" -- src/core` → empty (exit 1)
- [x] `git status --short` → only in-scope files; no test outside `__tests__/undo.test.ts` needed an exact-text update (Step 5)