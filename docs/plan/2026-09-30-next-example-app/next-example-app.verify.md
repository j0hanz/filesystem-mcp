# Verification: hooks — an event-driven example client

Against [`next-example-app.spec.md`](next-example-app.spec.md) with
[`next-example-app.spec-delta.md`](next-example-app.spec-delta.md) (R18),
commit `965de66b` (uncommitted working tree), 2026-10-02.

Primary evidence is `npm test` in `exampels/clients/hooks/` → `check: ok`
([`check.ts`](../../../exampels/clients/hooks/check.ts); scenario comment lines
cited). Commands were run from the repository root with `dist/` built.

| ID  | Verdict | Observation                                                                                     | Evidence                                                                                                                                               |
| --- | ------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | met     | same env/provider handling as gatekeeper; no key → no `authorization` header                    | check uses `LLM_BASE_URL`/`LLM_MODEL`/`FS_MCP_BIN`; probe with `--provider gemini`, key unset → `authorization header: (none)`; `--provider bogus` → exit 1 on both apps |
| R2  | met     | missing/blank args and no model → usage on stderr, exit 1, no model request                     | [`check.ts:172-183`](../../../exampels/clients/hooks/check.ts#L172-L183)                                                                              |
| R3  | met     | `watching <dir>` printed, no turn before a change; no `node:fs` in the app                      | [`check.ts:192-197`](../../../exampels/clients/hooks/check.ts#L192-L197); `grep "node:fs\|enum" hooks.ts` → 0                                         |
| R4  | met     | server that exits at once → exit 1, `filesystem-mcp exited`                                     | [`check.ts:185-190`](../../../exampels/clients/hooks/check.ts#L185-L190); direct run in run log step 3                                                 |
| R5  | met     | one burst → exactly one request after three quiet periods                                       | [`check.ts:209-210`](../../../exampels/clients/hooks/check.ts#L209-L210)                                                                              |
| R6  | met     | three writes 60 ms apart → one turn naming all three                                            | [`check.ts:216-230`](../../../exampels/clients/hooks/check.ts#L216-L230)                                                                              |
| R7  | met     | created/modified/deleted each named and labeled                                                 | [`check.ts:198-208`](../../../exampels/clients/hooks/check.ts#L198-L208)                                                                              |
| R8  | met     | `.git/index` write → 0 requests; `.github/ci.yml` → 1                                           | [`check.ts:232-246`](../../../exampels/clients/hooks/check.ts#L232-L246)                                                                              |
| R9  | met     | approved `edit` → no second turn                                                                | [`check.ts:248-261`](../../../exampels/clients/hooks/check.ts#L248-L261)                                                                              |
| R10 | met     | write during a turn → exactly one more turn naming it                                           | [`check.ts:263-283`](../../../exampels/clients/hooks/check.ts#L263-L283)                                                                              |
| R11 | met     | `why:` → `rejected by user: keep it`; EOF → `rejected by user`; file unchanged                  | [`check.ts:285-303`](../../../exampels/clients/hooks/check.ts#L285-L303)                                                                              |
| R12 | met     | `--yes` → edit applied, no `apply?` on stdout                                                   | [`check.ts:248-261`](../../../exampels/clients/hooks/check.ts#L248-L261)                                                                              |
| R13 | met     | `--yes` + EOF + out-of-root `stat` → `ERROR:`                                                   | [`check.ts:305-318`](../../../exampels/clients/hooks/check.ts#L305-L318)                                                                              |
| R14 | met     | HTTP 500 → `LLM 500` on stderr, process alive, next change runs                                 | [`check.ts:320-330`](../../../exampels/clients/hooks/check.ts#L320-L330)                                                                              |
| R15 | met     | `{bad` arguments → `ERROR: …` tool message                                                      | [`check.ts:332-339`](../../../exampels/clients/hooks/check.ts#L332-L339)                                                                              |
| R16 | met     | SIGINT at `apply?` → exit 0 within 5 s, file unchanged; SIGINT idle → exit 0                    | [`check.ts:341-350`](../../../exampels/clients/hooks/check.ts#L341-L350), [`:213-214`](../../../exampels/clients/hooks/check.ts#L213-L214)            |
| R17 | met     | server exits mid-session → exit 1, `filesystem-mcp exited`                                      | [`check.ts:352-365`](../../../exampels/clients/hooks/check.ts#L352-L365)                                                                              |
| R18 | met     | 346 lines ≤ 350 (delta); 1 dependency; no `enum`, no build step                                 | `node -e …split('\n').length` → 346; `dependencies` count → 1; `npm test` runs `node check.ts` directly                                               |
| R19 | met     | keyless check against stub on 127.0.0.1 covering the listed IDs                                 | `npm test` → `check: ok`; scenario comments name R2–R17, R21, R22                                                                                      |
| R20 | met     | table row present; app README names `client.listen`/`notifications/resources/updated`           | `exampels/README.md:20`; `hooks/README.md:82,85`                                                                                                       |
| R21 | met     | turn 2's first request has exactly `[system, user]`                                             | [`check.ts:281`](../../../exampels/clients/hooks/check.ts#L281)                                                                                       |
| R22 | met     | 30 scripted tool rounds → exactly 25 requests, `stopped after 25`                               | [`check.ts:367-375`](../../../exampels/clients/hooks/check.ts#L367-L375)                                                                              |

## Unmet

None.

## Unobservable

None. The Constraints-section timing bound (2 s p95 for 1 000 files) is not a
requirement ID and was not measured.

## Folded

- R18 from [`next-example-app.spec-delta.md`](next-example-app.spec-delta.md)
  merged into the canonical spec (cap 350, target 250); success criterion 3
  updated. The delta file stays as the record.

## What the change still owes

Every ID is met, but behavior is not correctness: bug-hunt
([`next-example-app.hunt.md`](next-example-app.hunt.md)) confirmed one Major
(partial `find_files` reported as deletions) and three Minors, and qc approved
with two non-blocking notes. Those findings are the next change, entering at
write-plan.
