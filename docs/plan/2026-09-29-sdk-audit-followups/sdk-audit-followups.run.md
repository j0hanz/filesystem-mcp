# Run: SDK audit follow-ups

Executing [sdk-audit-followups.plan.md](sdk-audit-followups.plan.md), started
2026-09-29 at `bfe5ac37`.

## Orientation

- Drift check: no committed changes in the plan's implementation scope.
- Starting worktree: only this effort's plan and plan-hunt artifacts untracked.
- No earlier run log; start at step 1. Preserve the plan unchanged.

## Seams under test

- Step 1: the exported file-resource contract and
  [`GuardedFileSystem.readRaw`](../../../src/core/fs.ts); observe abort reasons,
  absence of started work, native signal identity, and unchanged resource bytes.
- Step 2: [`pendingRoundTrip`](../../../src/core/input-required.ts) and an actual
  modern create call; observe per-mode refusal and unchanged target contents.
- Step 3: [`ProgressSession`](../../../src/tools/progress.ts) and real legacy
  tool calls; capture same-token wire progress over one/two confirmation rounds.
- Step 4: [`corsMiddleware`](../../../src/transport/http-policy.ts) and real HTTP
  responses; observe exposed header names without changing Origin admission.

## Steps

- **1** 2026-09-29 - done. Each `SDK-AUDIT-CANCEL-001` through `004`
  was observed red (missing rejection, validation already started, missing native
  signal, missing forwarded signal), then green. Resource slice: 75 passed,
  one existing platform skip. Both source/test typechecks exit 0. The first test
  typecheck found two test-only typing errors; an async rejection callback and
  text-content narrowing corrected both on the single retry. No scope deviation.
- **2** 2026-09-29 - done. The actual modern URL-only create regression was
  red with `-32021`, then green with a tool error, the existing overwrite hint,
  no elicitation, and unchanged bytes. Added the 30-case compatibility matrix
  across six capability shapes and five operations. Input-required suite:
  58 passed. Both typechecks exit 0. No scope deviation.
- **3** 2026-09-29 - done. Idle-session and actual legacy one/two-form
  regressions were red with premature zero frames, then green with lazy startup.
  Same-token sequences are nonempty and increasing; terminal-only and no-token
  cases pass, as do the original sequence assertions. Progress/tool slice:
  127 passed, one existing platform skip. Both typechecks exit 0. No deviation;
  the executor and signed request-state shape are unchanged.
- **4** 2026-09-29 - done. Allowed-origin policy and actual 401, 429, and
  authenticated-response tests were red for missing exposure, then green.
  Disallowed/absent origins keep their prior policy. HTTP slice: 60 passed;
  both typechecks exit 0. Only the allowed-origin response branch changed.
- **5** 2026-09-29 - done. Added four Unreleased fix entries and formatted
  only the changed implementation/test files. `npm run check` exits 0:
  525 passed, three pre-existing platform skips, zero failures (528 total).
  Build, test typecheck, lint, formatting, and knip all passed. No dependency,
  version, transport, mutation-commit, or plan changes; no commit created.

## Done

| Checklist command or condition | Final result |
| --- | --- |
| `npm exec --no -- tsc --noEmit -p tsconfig.json` | Exit 0 |
| `npm run type-check:test` | Exit 0 |
| `npm test -- __tests__\core-fs.test.ts __tests__\resources.test.ts` | Exit 0: 77 passed, one existing skip; cancellation 001-006 pass |
| `npm test -- __tests__\input-required.test.ts` | Exit 0: 58 passed; mode matrix and modern URL-only regression pass |
| `npm test -- __tests__\progress.test.ts __tests__\tools.test.ts` | Exit 0: 129 passed, one existing skip; progress 001-006 pass |
| `npm test -- __tests__\http-policy.test.ts __tests__\http-server.test.ts` | Exit 0: 60 passed; CORS 001-004 pass |
| `npm run check` | Exit 0: all static checks, 529 passed, three existing skips |
| `git diff --check` | Exit 0, no output |
| Implementation scope | Twelve changed tracked files, exactly the plan's allowlist |
| Changelog | Four fixes under Unreleased; no release or legacy HTTP capability claim |

All 55 added test cases pass; none is skipped. The only failed post-fix gate
was step 1's initial test typecheck, corrected and passed on its one retry.
No STOP condition or implementation-scope deviation remains.

## Reviews

Correctness and QC were handed to a separate static reviewer on their respective
axes. QC approved with no blocking comments. The
[correctness hunt](sdk-audit-followups.hunt.md) found two minor regressions,
confirmed by separate blind refuters: the first positive tick's throttle budget,
and native timeout-reason classification. Both were corrected test-first within
the plan's existing progress/filesystem scope:

- BH1: deterministic-clock regression was red with missing first work progress,
  then green. Startup no longer consumes a work-tick allowance; subsequent
  ticks remain rate limited.
- BH2: native-boundary regression was red with `CANCELLED`, then green with
  `TIMEOUT` and the original signal reason. An unrelated concurrent I/O failure
  is still propagated unchanged.

Four additional regression cases were added during review. The source and test
typechecks, affected slice gates, full repository check, and whitespace/scope
checks passed again. The follow-up static review confirmed both issues resolved,
with no new correctness candidates/suspicions and QC approval. No plan edit,
out-of-scope implementation change, or unresolved finding remains.

The plan cites no spec requirement IDs, so verify-specs is not applicable and
no verify artifact is created.
