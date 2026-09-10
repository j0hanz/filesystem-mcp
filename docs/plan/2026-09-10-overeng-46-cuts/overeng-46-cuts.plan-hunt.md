# Plan hunt: overeng-46-cuts

Hunted 2026-09-10 against commit `1806f037` (HEAD at hunt time — the tree is
clean against the plan's base, so no drift re-checks were needed).

Method: one hunter agent per plan step (16 agents), each working its step
against the dead-step tells and verifying every cited path and symbol against
the live repo. Every candidate finding went to one blind refuter that never
saw the hunter's reasoning. Killed findings are dropped per protocol; nothing
was edited in the plan itself.

Result: steps 2–11 and 13–15 returned zero findings — not even suspected
ones. Five findings survived refutation, all in steps 1, 12, and 16.

## Confirmed findings

### 1. Step 12 (cut #11) — merged CORS mount widens the OPTIONS intercept to the `/mcp` prefix — Major

finding step 12 [`overeng-46-cuts.plan.md`](overeng-46-cuts.plan.md)

The step replaces the exact-path mount
`app.options('/mcp', corsPreflightHandler(...))`
([`src/transport/http.ts:144`](../../../src/transport/http.ts)) plus the
origin-reflecting `app.use('/mcp', corsOriginMiddleware(...))` (`:145`) with a
single `app.use('/mcp', corsMiddleware(allowedOriginHostnames));`. In Express,
`app.use` matches the whole path prefix, so the merged middleware answers
`OPTIONS /mcp/<any-subpath>` with `204` + preflight headers where the live
server today falls through the rate limiter and bearer auth to Express's
default 404 (keyless bind) or 401 (apiKey bind), and the request also stops
consuming rate-limit budget.

No test exercises `OPTIONS` on a subpath — the refuter confirmed the only
`OPTIONS` test coverage constructs the handler directly with mock requests
([`__tests__/http-policy.test.ts:403`](../../../__tests__/http-policy.test.ts)),
no Express mount, no path matching — so `npm run check` stays green while
observable behavior changes. That violates the plan's own STOP rule: "a
'simplification' that changes observable behavior is wrong by definition."

**Fix for write-plan**: in `corsMiddleware`'s OPTIONS arm, answer the preflight
only on the exact endpoint — e.g. guard with
`if (req.path !== '/mcp' && req.path !== '/mcp/') { next(); return; }` before
the `res.status(204).end()` — or keep a separate exact-path
`app.options('/mcp', ...)` mount. Either way, state the path-matching
semantics explicitly so a cold executor cannot ship the prefix widening.

### 2. Step 12 (cut #11) — the http.ts import edit is missing — Major

finding step 12 [`overeng-46-cuts.plan.md`](overeng-46-cuts.plan.md)

The step rewrites the mounts at
[`src/transport/http.ts:144-145`](../../../src/transport/http.ts) but never
touches the import block: `:41-42` imports `corsOriginMiddleware` and
`corsPreflightHandler` from `./http-policy.js`, and grep confirms the mounts
are their only other references. After the merge, `http-policy.ts` no longer
exports those two names, so type-check fails with TS2305 ×2 plus an unresolved
`corsMiddleware` — the executor's first Verify fails on something the step
never names, and per the plan's own STOP rule ("fails twice after one fix
attempt") an unnamed-but-obvious edit risks burning the fix attempt or
stopping the run.

The same step names the test-side import edit (`http-policy.test.ts :14`)
and the sibling cut #7 in the same step names its import edit, so this is an
omission, not a style choice.

**Fix for write-plan**: add the edit — `http.ts:41-42` import becomes
`import { corsMiddleware } from './http-policy.js';` (alongside whatever else
in that block stays).

### 3. Step 16 — README.md still references tasks.mjs and is out of scope — Major

finding step 16 [`overeng-46-cuts.plan.md`](overeng-46-cuts.plan.md)

Step 16 item 3 expects
`grep -rn "tasks.mjs" --exclude-dir=node_modules --exclude-dir=.git .` → no
hits, and the Done checklist repeats it. The refuter ran the exact grep on the
live tree: [`README.md`](../../../README.md) references `node scripts/tasks.mjs`
at `:425-428` (Scripts table) and `:447` (Contributing step 4). Step 1 rewrites
AGENTS.md, CONTRIBUTING.md, package.json, and ci.yml — README.md is absent from
the in-scope list, and the STOP rule forbids fixing any file outside it. As
written, the plan can never complete: the executor hits the mismatch and must
stop.

**Fix for write-plan**: add README.md to the in-scope list and a step-1
sub-item rewriting its Scripts table (`:425-428`) and the contributing step
(`:447`) to the new command surface — same content as the AGENTS.md rewrite.

### 4. Step 16 — the grep can never return "no hits" even with a README fix — Major

finding step 16 [`overeng-46-cuts.plan.md`](overeng-46-cuts.plan.md)

The refuter ran the plan's exact grep command on the live tree: it matches 30
files. `grep -rn` is a filesystem scan, not git-aware, and excludes only
`node_modules` and `.git`. Beyond README.md, it hits tracked plan-history files
under `docs/plan/2026-09-05-*` and `2026-09-07/09-*` (e.g.
[`docs/plan/2026-09-05-audit-seams/audit-seams.map.md:15`](../../../docs/plan/2026-09-05-audit-seams/audit-seams.map.md)),
the plan file itself (untracked), and untracked scratch files
(`temp_refs/dead-scan.mjs:12`, `.claude/overeng-audit-46-cuts.handoff.md`).
None of these are in scope, so the stated expected result is unachievable with
the command as given — both in step 16 item 3 and the Done checklist.

**Fix for write-plan**: scope the check to what it is actually asserting —
that no *live* code or docs still invoke the deleted script. Either use
`git grep -n "tasks.mjs" -- ':!docs'` (tracked files only, docs excluded), or
extend the exclude list (`--exclude-dir=docs --exclude-dir=.claude
--exclude-dir=temp_refs`) and say what "no hits" means: nothing outside
plan-history and scratch. Same change in the Done checklist.

### 5. Step 1 — "keep the scripts block alphabetical" is a false premise — Minor

finding step 1 [`overeng-46-cuts.plan.md`](overeng-46-cuts.plan.md)

The step says to add the `fix` script "(prettier will place it; keep the
scripts block alphabetical as it is today)". The block is not alphabetical
today — [`package.json:30-31`](../../../package.json) reads `"start": ...`
directly above `"lint": ...`, and `"knip"` (`:37`) precedes `"check:static"`
(`:38`) — and prettier enforces no script ordering:
[`.prettierrc:6`](../../../.prettierrc) declares only
`@trivago/prettier-plugin-sort-imports`,
which sorts imports, not package.json scripts. The non-alphabetical block
passes `prettier --check .` at HEAD, proving no gate enforces order.

Not gate-breaking: the executor can place `"fix"` anywhere and the Verify
passes. But the placement guidance is unactionable as written.

**Fix for write-plan**: drop the parenthetical; replace with a concrete
placement, e.g. "add `"fix"` directly after `"check:static"`".

## Verdict

**REQUEST_CHANGES** — the plan routes back to [write-plan] to fix the five
findings above, then re-hunt. Two of the five (findings 3 and 4) make the
plan's own Done checklist unsatisfiable as written, so they are not optional
polish: the executor stops at step 16 no matter how cleanly steps 1–15 run.
Finding 1 is the only behavior-change risk in the plan and must be resolved
before run-plan sees it.

## Re-hunt 2026-09-10 (after fixes)

All five findings were fixed in the plan by write-plan:

1. `corsMiddleware` gained the endpoint-exact guard
   `if (req.method !== 'OPTIONS' || req.path !== '/')` — Express mount
   semantics verified empirically against the installed express (mounted at
   `/mcp`: `/mcp` and `/mcp/` both give `req.path === '/'`, `/mcp/foo` gives
   `/foo`), so `OPTIONS /mcp/sub` keeps falling through as today. TC-SEC-031
   gains a subpath fall-through case inside the existing `it` (test count
   stays 277).
2. The step now names the `http.ts:41-42` import edit.
3. README.md added to the in-scope list with a step-1 sub-item rewriting its
   Scripts table and Contributing step.
4. Step 16 item 3 and the Done checklist now use
   `git grep -n "tasks.mjs" -- ':!docs'` (tracked-only, docs excluded) — run
   at HEAD, every tracked hit outside `docs/` is a file step 1 rewrites.
5. The false "alphabetical" placement guidance replaced with a concrete
   placement (after `"check:static"`).

Re-hunt ran the same protocol scoped to the three changed steps (1, 12, 16):
one hunter each, blind refuters for candidates. **Zero findings — nothing
confirmed, nothing suspected.** The plan is clean and ready for run-plan.