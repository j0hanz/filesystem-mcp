# Plan hunt: registrar enforcement and two internal forwarding layers

**Date:** 2026-09-28

**Baseline:** `b2a6fac5`

**Plan:** [arch-audit-seams.plan.md](arch-audit-seams.plan.md)

**Verdict:** zero confirmed defects; zero suspected defects.

The plan has not been executed. This review checked the five steps against
the current repository, without changing implementation files.

## Step coverage

| Step | Evidence checked | Result |
| :-- | :-- | :-- |
| 1. Registrar boundary | Existing [restriction](../../../eslint.config.mjs#L149-L166), all four virtual lint contexts, installed ESLint API, and test-project type compatibility. | The `.ts` gap exists. An in-memory repaired configuration rejects it while retaining `.js` and builtin restrictions and permitting core imports and the transport/factory edge. |
| 2. Public input modes | Existing [edit case](../../../__tests__/tools.test.ts#L635-L652), [stat case](../../../__tests__/tools.test.ts#L2355-L2369), and [mixed mutation case](../../../__tests__/tools.test.ts#L293-L309). | The named tests and both input forms exist; resetting edit content inside the loop avoids state-dependent failures. |
| 3. Batch collapse | [Executor](../../../src/tools/batch.ts), all four callsites, [tool context](../../../src/tools/define.ts#L41-L83), and [scheduler](../../../src/core/concurrency.ts#L32-L97). | The proposed generic signature and all four caller changes type-check together in an in-memory compiler overlay. No compatibility API or cast is needed. |
| 4. Atomic-write collapse | [Private helper](../../../src/core/fs.ts#L69-L130), [sole forwarding caller](../../../src/core/fs.ts#L223-L229), shared resolver, append comment, and [commit-boundary assertions](../../../__tests__/core-fs.test.ts#L348-L399). | The implementation has one caller; the shared resolver and the final pre-rename cancellation check are explicitly retained. |
| 5. Final gates | Repository scripts, exact PowerShell deletion gate, baseline SHA, scope inventory, and relative links. | Commands resolve. The deletion gate rejects baseline net zero as documented; implementation must later satisfy its two negative totals. |

## Dead-step checks

- **Invented API:** none found. A virtual new test containing all 13 boundary
  cases type-checked against the real test project and installed ESLint types.
  Twenty-six baseline/repaired in-memory lint checks exercised the planned
  matching behavior and controls.
- **Unresolvable path:** 82 existing file/line links resolved. The only
  absent implementation path is the explicitly new
  [boundary test](../../../__tests__/registrar-boundaries.test.ts), which
  Step 1 creates. All eight files to modify are tracked.
- **Convention violation:** none found. The plan uses the existing Node test
  runner, `.ts` imports, strict types, local dependency contracts, and
  release-owned versions. The existing characterization and virtual tests
  need no dependency-manifest change.
- **Missing gate:** every step carries a command and expected outcome.
  The enforcement step includes an explicit three-case red expectation.
  Refactors follow green characterization and change their callsites
  atomically.
- **Assumed dependency/version:** none found. Node v24.15.0, npm 12.0.2,
  TypeScript, ESLint, and the declared scripts were available during recon.

## Executed baseline checks

- `npm run check`: 437 tests, 434 passed, three platform skips, no failures;
  static checks also passed.
- `npm run build && npm run type-check:test`: exit 0.
- Focused tool/filesystem/concurrency command: 150 tests, 148 passed, two
  platform skips, no failures.
- The plan's narrow test-name command: exit 0 on existing cases. The new
  boundary file is deliberately absent, so this is not a claim that its
  future regression cases already passed.
- `git diff --check`: exit 0.
- The exact deletion-gate block was executed against the unchanged baseline
  and rejected net zero with its documented error.

No candidate remained for blind refutation, so no refuter was dispatched.
These checks establish that the plan is executable, not that its proposed
changes are implemented or verified after implementation.

## Handoff

Ready for run-plan when implementation is requested. No run or
implementation-verification record has been created.
