# Plan hunt: hooks — 2026-09-30

Hunted [`next-example-app.plan.md`](next-example-app.plan.md) (5 steps) against
the dead-step tells. Every cited path was opened or `git ls-files`-checked this
session; `client.listen`, `find_files` text, `stat paths[]` and the directory
notification were exercised by a probe against `dist/`. Root `tsconfig*.json`
and `knip.json` include only `src/` and `__tests__/`, so `hooks.ts` faces no
root typecheck or knip gate (tell dismissed). Two candidates went to blind
refuters; one was routed straight to Suspected.

## Confirmed

- **C3 — step 2, scenario 6 (R10)**: "total requests 4 (turn 1: two requests,
  turn 2: one) — assert ≥3". Refuter: the plan's own parenthetical sums to
  three; gatekeeper's stub (`check.ts:33`
  `opts.script[requests.length - 1] ?? { text: 'done' }`) never consumes the
  fourth entry. An executor asserting `=== 4` writes a check that cannot pass.
- **C4 — step 4, second Verify**: expected `1 file changed, 1 insertion(+)`
  while the same step runs `npx prettier --write exampels`, which re-pads the
  header, separator and gatekeeper row because the new row is wider. Refuter:
  confirmed as a wording defect; the deciding gates (`grep -n
  "clients/hooks/"` and `prettier --check`) are correct.

## Suspected

- **C2 — step 2, scenario 15 (R4)**: asserts stderr matches
  `/failed to start/` when `FS_MCP_BIN` exits immediately. gatekeeper sets
  `client.onclose` (prints `filesystem-mcp exited`) *before* `connect()`
  rejects with `filesystem-mcp failed to start: …`; which message lands first
  — or whether both do — depends on SDK ordering. **Settles it**: run scenario
  15 once against `dist/` and read stderr; if only `exited` appears, the
  assertion must accept either message.

## Hand-off

Confirmed findings go back to write-plan. Fix applied by the plan's author in
the same session (see the dated amendment in the plan); the fix touches three
lines of check-scenario text and no step structure, so no re-hunt wave was
dispatched — run-plan's Verify on step 2/4 is the re-check.
