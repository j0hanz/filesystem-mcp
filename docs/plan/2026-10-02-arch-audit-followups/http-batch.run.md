# Run: createServer owns the per-request dispose hook and prepareListenWatchers owns the listen cap pre-check

Executing [`http-batch.plan.md`](http-batch.plan.md), started 2026-10-02 at `fada7b47` (worktree `C:\fsmcp-wt-http`).

- **1** 2026-10-02 — done. Drift check empty; branch `refactor/http-batch-dispose-listen-cap`; stdio + http-server tests → 52 pass, fail 0.
- **2** 2026-10-02 - done. New disposal test red: `true !== false`.
- **3** 2026-10-02 - done. Disposal test green; `type-check:test` exit 0; http-server + input-required + stdio 115 pass, fail 0.
- **4** 2026-10-02 - done. `previousOnClose` only in `src/server.ts`; http-server + input-required 93 pass.
- **5** 2026-10-02 - done. Four dispose lines removed; remaining sites as planned; name-filtered run 40 pass; tools/progress/roots-seeding 134 pass, fail 0 (1 skipped).
- **6** 2026-10-02 - done. STDIO-017 red (`Cannot subscribe to ...: watcher limit 1 reached`); STDIO-018 and tightened HTTP test 7 pass. Deviation: an unrelated `STDIO-017` (create at the advertised file limit) already exists, so the ID is duplicated, as the plan specifies.
- **7** 2026-10-02 - done. stdio + http-server + subscriptions-listen + http-shared-guard 72 pass; `type-check:test` exit 0; `git grep MAX_WATCHERS` in http.ts exit 1.
- **8** 2026-10-02 - done. Deletion map edited in worktree; one `cap pre-check` match on shared.ts row; prettier check clean.
- **9** 2026-10-02 - done. `npm run check` exit 0: tests 555, pass 552, fail 0, skipped 3.

## Done

- [x] `npm run check` exit 0, fail 0, skipped 3, pass 552.
- [x] `previousOnClose` matches only `src/server.ts`.
- [x] `MAX_WATCHERS` in `src/transport/http.ts`: no output, exit 1.
- [x] `disposeRuntimeState()` calls remain only at `stdio.ts` x2, `capabilities.test.ts`, `core-fs.test.ts`, `resources.test.ts` (plus server.ts internals).
- [x] Disposal test and STDIO-017 each red before their fix step, green after.
- [x] `git status --short`: 12 modified in-scope files in the worktree, no untracked files, no commit.

- **post-run** 2026-10-02: parent renumbered the new stdio tests to STDIO-018 and STDIO-019, because STDIO-017 already named an existing test (the create at the file limit). `node --test --test-name-pattern="STDIO-01[89]"` → pass 2, fail 0.
