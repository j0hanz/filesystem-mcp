# Run: fix the hooks bug-hunt findings

Executing [`hooks-hunt-fixes.plan.md`](hooks-hunt-fixes.plan.md), started 2026-10-02 at `965de66b` (uncommitted tree).

- **1** 2026-10-02 — done. Drift check matched (`?? exampels/clients/hooks/`, ` M exampels/README.md`, 346 lines). Three scenarios added to `check.ts` (R9 rename, R23 idle + recovery, R23 startup); `npm test` → `AssertionError: rename is an own write (R9)`, exit 1.
- **2** 2026-10-02 — done after one STOP. First run: R23 idle scenario timed out — `find_files` with `maxResults: 2` on three files returned `// showing 1-2 of 3 files. Next page: …`, not `// scan stopped early` (probe against `dist/`). Resolved per the plan's amendment: refuse on either trailer, log `scan incomplete`; check regexes updated; startup scenario given a third file. Second run: one assertion failed because two files at page size two is a complete page — fixed by the third file. Third run: `check: ok`. `ownDeletes` and the tool-name branch are gone; `pending` re-arms the timer. README "What changed", "Not reacting to itself" and Limits rewritten. Line budget 367 > 350 → second R18 delta (≤ 400) recorded in [`hooks-hunt-fixes.spec-delta.md`](hooks-hunt-fixes.spec-delta.md).

## Done

- [x] hooks `npm test` → `check: ok`; `R23` ×3 and `rename` ×2 in `check.ts`.
- [ ] `hooks.ts` ≤ 350 — **367**, carried by the R18 delta (≤ 400); `ownDeletes` → 0; `'delete' ||` → 0.
- [x] `npx prettier --check exampels` → clean.
- [x] `git status --short` → `M exampels/README.md`, `?? exampels/clients/hooks/`, the two effort directories.
- [x] gatekeeper `npm test` → `check: ok` (unchanged, sanity).

## Ponytail cuts — 2026-10-02

Applied 7 of the 8 ponytail-review findings: `hooks.ts` 367 → 359 (dropped the redundant `No files matching` filter clause; `converse` rethrows the abort instead of returning a bool; `Promise.allSettled` replaces the five-step close chain), `check.ts` 426 → 394 (`STOP_AFTER_MS` trigger deleted; `sleep` merged into `quiet`; `r.end()` and `trigger()` replace the repeated stop/trigger rituals; R17's `trigger` const renamed `killFile`). Skipped: moving `system`/`openaiTools` from module-level `let`s into the `try` — nets zero lines and nests ~90 lines deeper. `npm test` → `check: ok` on hooks and gatekeeper; Prettier clean. Net −40 lines.
