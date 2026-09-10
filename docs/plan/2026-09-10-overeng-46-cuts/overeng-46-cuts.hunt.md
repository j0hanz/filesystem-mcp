# Hunt: overeng-46-cuts (landed change)

Hunted 2026-09-10 against the landed working tree (all changes uncommitted vs
base `1806f037`). Method: four hunter agents over the 36 changed code files
(transport-entry, tools, core, tests), every candidate to one blind refuter
that never saw the hunter's reasoning. 7 agents, 270 tool calls. The prior
[`overeng-46-cuts.plan-hunt.md`](overeng-46-cuts.plan-hunt.md) was read first;
nothing it dismissed was re-raised.

## Confirmed findings

All three are the same defect class — stale comments naming symbols the
refactor deleted. Zero functional findings.

### 1. `computeAllowedOriginHostnames` docstring still cites `corsPreflightHandler` — Minor

finding [`src/transport/http-policy.ts:318`](../../../src/transport/http-policy.ts#L318)

Step 12 merged `corsPreflightHandler` into `corsMiddleware` but left this
docstring pointing at the deleted symbol.

**Trigger:** maintainer greps `corsPreflightHandler` after reading the
docstring; no definition exists.
**Impact:** documentation only — behavior verified identical (old
`app.options('/mcp', ...)` pattern and the new mounted middleware A/B-tested
equal on Express 5.2.1: 204 on `/mcp`, `/mcp/`, `/mcp?x=1`; fall-through on
`/mcp/sub`, `/mcpfoo`, `/mcp//`).
**Ruled out:** grep across the repo — the only remaining `corsPreflightHandler`
occurrence is this comment line.
**Fix:** "consulted by corsPreflightHandler" → "consulted by corsMiddleware".

### 2. `sharedStore` closure-safety comment cites deleted `getNotifier` — Minor

finding [`src/transport/http.ts:277`](../../../src/transport/http.ts#L277)

Step 12 inlined `makeHttpModernFactory` (deleting the `getNotifier` getter,
old `:85/:93`) but the comment still says "same as `getNotifier`".

**Trigger:** maintainer reads the closure-safety rationale and searches for
the cited precedent.
**Impact:** documentation only — the safety claim itself holds (the inline
factory defers the `modernHandler.notify` read exactly as the old getter did).
**Ruled out:** repo-wide grep — `getNotifier` survives only in this comment
and the plan doc; old getter confirmed deleted by the diff.
**Fix:** drop the "(same as `getNotifier`)" parenthetical.

### 3. TC-SEC-031 case-5 comment cites deleted `corsOriginMiddleware` — Minor

finding [`__tests__/http-policy.test.ts:464`](../../../__tests__/http-policy.test.ts#L464)

"Origin reflection still happens, same as the live corsOriginMiddleware
mount" — the merged `corsMiddleware` (`src/transport/http.ts:110`) is the live
mount now. The stale text was authored into the plan itself (plan `:775`)
by the same step that deleted the function.

**Trigger:** reader follows the comment to find the live mount; the named
function does not exist.
**Impact:** documentation only; the assertion itself exercises the current
middleware correctly.
**Ruled out:** grep — zero `corsOriginMiddleware` definitions in `src/`; live
mount read verbatim at `http.ts:110`.
**Fix:** "same as the live corsMiddleware mount".

## Suspected

None.

## Plan-Notes attention points — all closed

1. **Step 12 OPTIONS interception** — preflight fires before the rate limiter
   and bearer auth (`http.ts:110` before `:115/:147`); mount-relative
   `req.path === '/'` guard verified endpoint-exact by A/B test on the
   installed Express. The `httpServer.close` override traced: teardown
   `.catch` guarantees `originalClose(callback)` always runs, return contract
   and double-close semantics unchanged.
2. **Step 13 delete reassembly** — output order matches input order on every
   traced path (duplicate paths deduped pre-existing before index math;
   phase-1-fail + pending mixes; mid-batch phase-2 throws; validPath
   collisions). One dismissed near-miss: a thrown phase-2 error now reports
   the requested path, which matches the published "Requested path" schema —
   the old code violated its own contract.
3. **Step 14 `parsed` definite-assignment** — the catch ends in return/throw
   on every path; `CliExitError`'s hardcoded exit code matches every old
   literal-1 call site; deny dedup, empty-string port, and env fallbacks all
   preserved.

## Coverage

Read fully, end to end, with complete diffs vs `1806f037`: all 36 changed code
files — 7 transport/entry files, 9 tool files, 13 core files, 6 test files.
Blast radius opened: `cli-help.ts`, `stdio.ts`, `transport/http.ts` +
`http-policy.ts` (middleware order), `tools/batch.ts`, `concurrency.ts`,
`search.ts`, `page-store.ts`, `path-discovery.ts`, `glob.ts`/`fs.ts` at the
changed contracts, SDK type declarations
(`CompleteResourceTemplateCallback`, `ResourceTemplate.complete`), plus
`git show` of every base version compared. Callers grepped for every removed
export (`timedSignal`, `isIgnoredByGitignore`, `createSearchMatcher`,
`toStatPerPathPayload`, `preFilterByBudget`, `buildReplacementPlan`,
`getNotifier`, `corsOriginMiddleware`, `corsPreflightHandler`, `ctx.fs`,
`ctx.resources`, `FileInfo`, inspector fixtures) at base and worktree.

Not audited (named): the 9 changed non-code files the brief skipped
(`.dockerignore`, `ci.yml`, `AGENTS.md`, `CONTRIBUTING.md`, `README.md`,
`package.json`, both tsconfigs, plan dir) — docs/config, no executable
semantics; `cli.test.ts` (unchanged); unchanged test files beyond the
grep-level caller checks.

Third-party behavior taken on trust or verified read-only: nodejs.org v24.15.0
sources for `fs.glob` exclude receiving Dirent objects (dead string branch
removed) and `util.styleText` colorization; SDK `dist` type declarations read;
Express 5.2.1 mount semantics A/B-tested with the installed package (dependency
only — no repo code executed).

## Verdict

**Worst thing:** three comments name deleted symbols — no functional defect
exists in the landed 46-cut refactor. All three fixes are one-line comment
edits; applied as the post-hunt task in the same session, gate re-run green.