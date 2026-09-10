# Plan hunt: key-ownership

Hunted 2026-09-10 against plan commit `cb60e0dd` plan revision (as written
this session). Every candidate went to one blind refuter; all four came back
confirmed. Zero suspected, zero killed.

## Findings

### 1. Step 2's Verify gate stops a healthy tree — CONFIRMED

Gate says `grep -rn 'confirm_' src/tools` → zero hits, but step 2 switches
only [`delete-file.ts`](../../../src/tools/delete-file.ts) and
[`move.ts`](../../../src/tools/move.ts); the three `confirm_` sites in
[`define.ts:318`](../../../src/tools/define.ts#L318),
[`:336`](../../../src/tools/define.ts#L336),
[`:341`](../../../src/tools/define.ts#L341) are step 3's work. A cold
executor completing step 2 correctly sees three hits and invokes the STOP
rule. Fix: scope the gate to the files switched, or merge the switch into
one step.

### 2. Steps 1 and 4 fail knip — unused exports — CONFIRMED

`check:static` ends with `knip` ([`package.json:35`](../../../package.json#L35));
[`knip.json`](../../../knip.json) defines `project: ["src/**/*.ts"]` with
entries only under `__tests__` and no rules disabling the default `exports`
issue type. Refuter ran the repo's installed knip 6.32.3 against a scratch
project mirroring the config: a freshly added export with zero importers
reports `Unused exports` and exits 1 — exactly the post-step-1 and post-step-4
state. Both gates fail on correctly-executed steps. Fix: add-export and
switch-importers must land inside the same step.

### 3. Done-list `QueryKey` gate is ambiguous — CONFIRMED

[`list.ts:243`](../../../src/tools/list.ts#L243) et al. already yield 6 hits
for `grep -rn 'QueryKey' src/tools`; after step 5 the count is still 6 (three
`pageQueryKey` imports + three calls — the substring survives inside
`pageQueryKey`). "No local builder functions" is a judgment call, not a
machine check. Fix: gate on `grep -rEn 'function [a-zA-Z]*QueryKey' src/tools`
→ zero hits.

### 4. Import-line shape breaks `prettier --check` on first verify — CONFIRMED

[`​.prettierrc`](../../../.prettierrc) pins `printWidth: 100`, not the
default 80 (first half of the claim killed, second survives): the four-name
single-line import is 106 chars measured, and the repo's pinned prettier 3.9.6
wraps it to a multi-line block. The plan's code blocks never show the wrapped
shape, so the executor's first `check:static` fails on formatting. Fix: show
the wrapped import block in the step, or tell the executor to run
`npm run fix` before the gate.

## Verdict

Four confirmed dead-gate defects, zero killed. Plan is **not** executable as
written. Fix in [key-ownership.plan.md](key-ownership.plan.md) step list
(gates and step boundaries only — Current state excerpts all verified
correct), then re-verify gates.

## Re-hunt 2026-09-10 (after revision)

The fix merged the six steps into three (export + every importer land in one
step, so knip never sees an unused export), gave each gate an exact expected
output, and showed the prettier-wrapped import shape. Every new gate was
re-verified against the live tree:

- `grep -rn 'confirm_' src` → the 7 baseline hits are exactly the 6 switch
  sites + the define.ts:336 comment, all covered by revised step 1; one hit
  remains after it. Checked.
- `grep -rEn 'function [a-zA-Z]*QueryKey' src/tools` → 3 hits today
  (`list.ts:243`, `search-content.ts:235`, `search-files.ts:101`), zero after
  revised step 2. Ran it; pattern matches nothing else in `src/tools`.
- `grep -rn 'JSON.stringify' src/tools` → 5 today, 2 survive step 2
  (`define.ts`, `read.ts`). Checked.
- Knip behavior: refuter's scratch-project experiment with the repo's
  installed knip 6.32.3 demonstrated the unused-export failure and a clean
  baseline; merged steps remove the intermediate state entirely.
- Prettier wrap shape: refuter ran the repo's pinned prettier 3.9.6 with
  `printWidth: 100` (`.prettierrc:4`) on the exact import line and produced
  the wrapped shape now shown in step 1.

No new steps added, no new claims introduced beyond gates already run.
**Verdict: clean — forward to run-plan.**
