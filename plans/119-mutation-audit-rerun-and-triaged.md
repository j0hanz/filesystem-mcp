# Plan 119: The path-guard mutation audit is rerun on current code, covers `path-utils.ts`, and its logic survivors are triaged

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- stryker.config.mjs docs/mutation-triage.md src/core/path.ts src/core/sensitive.ts src/core/path-utils.ts`
> Source drift in the three `src` files is expected and harmless here (the
> audit is rerun on whatever is current). Drift in `stryker.config.mjs` or
> `docs/mutation-triage.md` means someone already started: STOP.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: LOW (tests and a doc; no source change)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

Mutation testing changes one small thing in the code (flips a condition,
removes a block) and checks whether any test fails. A mutant that survives
is logic no test protects. The last audit of the path guard (2026-10-30)
left 279 survivors recorded as "not yet triaged"; about 235 of them are
logic mutants (conditions, comparisons, removed blocks), not message
strings. The guard files have had dozens of commits since, so the recorded
line numbers are stale. And the file that holds the containment primitive
itself, `src/core/path-utils.ts` (`isPathInsideDirectory`, `isSamePath`),
has never been mutated.

In a path guard, an unprotected condition may be a real escape. The earlier
audit proved it: five "removed checks" turned out to be real gaps. This plan
reruns the audit, adds `path-utils.ts`, and sorts every logic survivor into
"killed by a new test" or "recorded as a backstop, with the check that
covers it".

## Current state

`stryker.config.mjs` (whole config object):

```js
const SCOPED_TESTS = [
  'entry-verdict',
  'guards',
  'move-exdev',
  'path-guard-grant',
  'path-helpers',
  'relocation',
  'resources',
  'scan',
  'search-literal',
  'security',
  'unicode-paths',
].map((name) => `__tests__/${name}.test.ts`);

const testCommand = process.env.STRYKER_FULL
  ? 'npm test'
  : `node --test --test-timeout=60000 ${SCOPED_TESTS.join(' ')}`;

export default {
  mutate: ['src/core/path.ts', 'src/core/sensitive.ts'],
  testRunner: 'command',
  commandRunner: { command: testCommand },
  coverageAnalysis: 'off',
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  concurrency: 2,
  reporters: ['clear-text', 'progress', 'html', 'json'],
};
```

`package.json`: `"test:mutation": "stryker run"`. Not part of `npm run check`
or CI. Reports go to `reports/mutation/` (git-ignored).

`docs/mutation-triage.md` structure: an "Audit 1" section with a table
"Security checks that are backstops" (columns `Site`, `Check removed`,
`Covered by`), a list "Five removed checks were real gaps and now have
killing tests", a paragraph "Error and log text" (message-string mutants are
left alive on purpose), and:

```md
### Not yet triaged

279 mutants survived on both Windows and Linux (87 in `sensitive.ts`, 192
in `path.ts`); Linux alone killed 21 more, in POSIX-only branches. Apart
from the security checks and message text above, the logic-branch and
equivalent survivors among them are open for the next round.
```

Tests for the guard live in `__tests__/security.test.ts`,
`__tests__/guards.test.ts`, `__tests__/path-helpers.test.ts`,
`__tests__/path-guard-grant.test.ts`, `__tests__/unicode-paths.test.ts`,
`__tests__/entry-verdict.test.ts`. Use the file that already tests the
function a mutant sits in.

## Commands you will need

| Purpose             | Command                                                 | Expected on success                     |
| :------------------ | :------------------------------------------------------ | :-------------------------------------- |
| Scoped mutation run | `npm run test:mutation`                                 | finishes; report in `reports/mutation/` |
| One file only       | `npx stryker run --mutate src/core/path-utils.ts`       | finishes                                |
| Full-suite confirm  | `STRYKER_FULL=1 npx stryker run --mutate <file>:<line>` | finishes                                |
| Tests               | `npm test`                                              | all pass                                |
| Full check          | `npm run check`                                         | exit 0                                  |

A scoped run of one file can take from several minutes to over an hour.
Run one file at a time.

## Scope

**In scope**:

- `stryker.config.mjs` (add `src/core/path-utils.ts` to `mutate`)
- `__tests__/*.test.ts` (new killing tests only)
- `docs/mutation-triage.md` (an "Audit 2" section)
- `plans/README.md`

**Out of scope**:

- Any file under `src/`. If a survivor reveals a real bug, do not fix it:
  write a failing test marked `{ todo: 'plan 119 finding' }`, record it, and
  report it.
- Adding Stryker to CI (too slow for every push; see Maintenance notes).
- `StringLiteral` survivors in messages and log text (accepted as-is by the
  existing triage doc).

## Git workflow

- Branch: `test/mutation-audit-2`
- Commit per file audited: `test(security): kill surviving mutants in <file>`, and one
  `docs: record mutation audit 2`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `path-utils.ts` and run it first

Change `mutate` to
`['src/core/path.ts', 'src/core/sensitive.ts', 'src/core/path-utils.ts']`.

Run `npx stryker run --mutate src/core/path-utils.ts`. Open
`reports/mutation/mutation.json` (or the clear-text output) and list the
survivors whose mutator is NOT `StringLiteral`.

**Verify**: you have a list of survivors for `path-utils.ts` with file, line,
mutator and the replaced code.

### Step 2: Triage each logic survivor in `path-utils.ts`

For each survivor, in this order of priority: `isPathInsideDirectory`,
`isPathWithinDirectories`, `isSamePath`, `normalizeCaseForComparison`,
`isUncOrDevicePath`, `isUnresolvableDrivePath`, then the rest:

1. Read the mutated line and decide what input would behave differently
   under the mutant.
2. If such an input exists, write a test in `__tests__/path-helpers.test.ts`
   that asserts the correct result for it. Rerun only that mutant
   (`npx stryker run --mutate src/core/path-utils.ts:<line>`) and confirm it
   is now killed.
3. If no input can distinguish it (an equivalent mutant), or another check
   refuses the same input with the same error code (a backstop), add a row
   to the triage table with the reason.

**Verify**: `npx stryker run --mutate src/core/path-utils.ts` → every
remaining survivor is either `StringLiteral` or has a row in the triage doc.

### Step 3: Rerun and triage `sensitive.ts`

Same procedure. Start with the glob-parser loop bounds and comparisons (the
previous audit recorded 24 `ConditionalExpression` and 12 `EqualityOperator`
survivors there). Killing tests go in `__tests__/guards.test.ts` or the file
that already tests `isSensitive` patterns (find it with
`grep -ln "isSensitive\|describeSensitivePolicy" __tests__/*.ts`).

**Verify**: as in Step 2, for `src/core/sensitive.ts`.

### Step 4: Rerun and triage `path.ts`

Same procedure. This is the largest file. Work through mutators in this
order: `ConditionalExpression`, `EqualityOperator`, `BlockStatement`,
`LogicalOperator`, then the rest. Windows-only and POSIX-only branches can
only be judged on that platform; record the ones you cannot run as
"needs <platform>" in the doc instead of guessing.

**Verify**: as in Step 2, for `src/core/path.ts`.

### Step 5: Record the audit

Add to `docs/mutation-triage.md` a section
`## Audit 2: path.ts, sensitive.ts, path-utils.ts (<date>, commit <sha>)`
with: totals per file (mutants, killed, survived), the new backstop rows,
the list of new killing tests by name, any real gaps found (with the `todo`
test that shows each), and the survivors left for a platform you could not
run. Replace the old "Not yet triaged" paragraph with a pointer to Audit 2.

**Verify**: `npm run check` → exit 0.

## Test plan

New tests are whatever Steps 2 to 4 require. Each must fail under its mutant
and pass on real code; the per-mutant rerun in each step proves it.

## Done criteria

- [ ] `grep -n "path-utils.ts" stryker.config.mjs` prints the `mutate` line
- [ ] `docs/mutation-triage.md` has an "Audit 2" section and no "Not yet triaged" count
- [ ] Every non-`StringLiteral` survivor of the final run is listed in the doc (as backstop, equivalent, needs-platform, or real gap)
- [ ] `npm run check` exits 0; no file under `src/` is modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- A survivor shows a real escape (an input outside the roots, or a
  sensitive file, is admitted when the mutant is NOT applied, i.e. on real
  code). Write the `todo` test, stop, and tell the operator directly; it
  falls under `SECURITY.md`.
- A scoped run of one file takes more than three hours.
- More than 150 logic survivors remain in `path.ts` after the rerun. Report
  the count by mutator; the reviewer will narrow the scope.

## Maintenance notes

- This plan can be split: Steps 1-2 (`path-utils.ts`) are worth landing on
  their own.
- A scheduled (weekly) or label-triggered mutation job is the follow-up, once
  a full run's duration is known from this audit. Record the durations in
  the doc for that purpose.
- Plan 115 (case-sensitive volumes) and any future change to containment
  should start from the tests this plan adds.
