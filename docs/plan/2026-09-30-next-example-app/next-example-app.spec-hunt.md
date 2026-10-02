# Spec hunt: hooks — 2026-09-30

Hunted [`next-example-app.spec.md`](next-example-app.spec.md) (R1–R22) against
write-specs' done-when checklist and the cold-executor guess check. Four
candidates went to blind refuters (one `general-purpose` subagent each, claim
reasoning withheld).

## Confirmed

None.

## Suspected

None.

## Killed (recorded for the trail; not findings)

| #   | Candidate                                                                   | Refuter evidence (abridged)                                                                                                                                                                                                                              |
| :-- | :-------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | "modified" undefined in R7                                                  | Terms: "The `baseline` is the set of workspace files and their modification times the app last recorded." — modified = present in both, recorded mtime differs. Size/content are not part of the baseline.                                             |
| G2  | R8's `.git/` scenario unreachable under `includeHidden: true`               | `src/core/glob.ts:501-506` `DEFAULT_EXCLUDED_NAMES` holds `.git`, applied via `skipIgnored: !args.includeIgnored` (`find-files.ts:114`), independent of `includeHidden`. Scenario reachable. Refuter labeled this "confirmed" but its evidence rules the claim out; treated as killed. |
| G3  | Baseline advance after a failed / capped / aborted turn unspecified         | Constraint: "Baseline refresh after a change shall complete within 2 s … measured from notification to the first model request" — refresh happens at turn start, before any request can fail. Later turns diff against the refreshed baseline.       |
| G4  | R17 silent on server death mid-turn                                         | "watching" is the whole running state (R14: "end that turn, and keep watching"); R17 scenario "a server that exits mid-session" covers mid-turn. R15 covers only individual tool-call failures.                                                           |

Dismissed without dispatch (plan-level, not spec gaps): how own-write paths are
identified for R9 vs R10 (observable behavior is fixed by both scenarios);
whether the `dryRun` preview is still printed under `--yes` (output-only, no
requirement depends on it).

## Verdict

Zero findings. Forward to write-plan.
