# Spec delta: hooks line budget

amends [`next-example-app.spec.md`](next-example-app.spec.md) — raised by
run-plan step 3 ([`run log`](next-example-app.run.md)).

## MODIFIED

- **R18** was: "… and be at most 250 lines in `hooks.ts`." — now: "… and be
  at most 350 lines in `hooks.ts` as formatted by the repository's Prettier
  config, keeping `exampels/AGENTS.md`'s 250 as the target." Reason: the
  behaviors R1, R7, R9–R11 and R13 mandate — gatekeeper-parity providers,
  gate and elicitation handling, snapshot/diff discovery, own-write
  attribution — land at 346 lines under `printWidth: 100`; gatekeeper itself
  is 264 with fewer of them. Every remaining line is behavior or a comment a
  copying developer needs. Falsified by: `hooks.ts` over 350 lines, a second
  runtime dependency, a `tsx`/build step, or an `enum`.

Success criterion 3 reads accordingly: `wc -l hooks.ts` ≤ 350.
