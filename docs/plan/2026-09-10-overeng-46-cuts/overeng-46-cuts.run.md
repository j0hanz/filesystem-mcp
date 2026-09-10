# Run: Apply the 46 verified over-engineering cuts — behavior-preserving, −677 lines net

Executing [`overeng-46-cuts.plan.md`](overeng-46-cuts.plan.md), started 2026-09-10 at `1806f037`.

- **1** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0` (after one
  `npx prettier --write README.md` reflow, as the plan allows).
- **2** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0`.
- **3** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0`.
- **4** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0` (one
  `npx prettier --write src/core/schema.ts` reflow).
- **5** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0`.
- **6** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0`.
- **7** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0` (one
  `npx prettier --write src/core/search.ts` reflow).
- **8** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0` (one
  `npx prettier --write src/tools/move.ts` reflow).
- **9** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0` (one
  `npx prettier --write src/core/path-completer.ts` reflow; one lint fix:
  `gitignoreMatcher && ...` → `gitignoreMatcher?.isIgnored(...)` in list.ts).
- **10** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0` (one fix
  cycle: dropped now-unused `parse` import and the stale `'grantBoundary'` label
  arg left by the cut itself).
- **11** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0`.
- **12** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0` (one
  `npx prettier --write src/transport/http.ts` reflow).
- **13** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0` (one
  fix cycle: dropped a stray `await` on sync `ProgressSession.complete`; one
  `npx prettier --write src/tools/define.ts src/tools/delete-file.ts` reflow).
- **14** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0` (one fix
  cycle: dot-notation on the now-typed `parsed.values` reads — `v.deny`,
  `v.safe`, `v.json`, `v.port`; pure equivalence).
- **15** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0` (one
  `npx prettier --write __tests__/inspector-http.test.ts` reflow).
- **16** 2026-09-10 — done. `npm run check` → exit 0, `pass 277`, `fail 0`;
  `git grep -n "tasks.mjs" -- ':!docs'` → no hits; `git status` shows only
  in-scope files.

## Done

- [x] `npm run check` exits 0 with `pass 277` and `fail 0` — ran 2026-09-10:
  exit 0, `tests 277`, `pass 277`, `fail 0`.
- [x] `npm test` alone exits 0, `pass 277` — ran 2026-09-10: exit 0,
  `tests 277`, `pass 277`, `fail 0`.
- [x] `git grep -n "tasks.mjs" -- ':!docs'` returns nothing — exit 1, no
  hits.
- [x] `git status` shows no files outside the in-scope list — all 47 changed
  files map to the plan's In-scope section; the only untracked path is
  `docs/plan/2026-09-10-overeng-46-cuts/` (plan, run log, plan-hunt).
- [x] `git diff --stat` shows a net line deletion — `47 files changed,
  559 insertions(+), 1164 deletions(-)` = net −605. Below the expected
  ≈ −677 by 72 lines: the ten prettier reflow passes (steps 1–15) plus
  reflowed multi-line shapes in http.ts, cli.ts, inspector-config.test.ts
  added back lines the plan's line-arithmetic could not precount. Net
  deletion holds; no step grew its file.
- [x] `package.json` / `server.json` `"version"` byte-identical to
  `1806f037` — both read `"version": "2.1.7"` before and after;
  `git diff 1806f037 -- package.json` has no version-line change
  (`grep '^[+-].*version'` → no matches).

## Post-run reviews (2026-09-10)

- **bug-hunt** (`overeng-46-cuts.hunt.md`): zero functional findings; 3 Minor
  doc-rot comments (stale `corsPreflightHandler` docstring, stale
  `getNotifier`/`corsOriginMiddleware` comment references). Fixes applied
  post-hunt; gate re-run green (pass 277, fail 0).
- **qc**: all six standards clean, no missed code-judo; one blocking item —
  `.dockerignore` rewritten with CRLF (whole-file EOL flip vs base). Fixed:
  rewritten with LF; diff is now exactly the one-entry deletion. Gate re-run
  green (pass 277, fail 0).