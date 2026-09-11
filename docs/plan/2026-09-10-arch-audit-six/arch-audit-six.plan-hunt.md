# Plan hunt: arch-audit-six

Adversarial pass over [`arch-audit-six.plan.md`](arch-audit-six.plan.md),
2026-09-10, against commit `8bf08572`.

Six steps checked against all five dead-step tells. Every path and symbol the
plan cites was verified against the repo. Three candidates reached a blind
refuter; one came back confirmed.

**Verdict: one confirmed defect. The plan does not go to run-plan until it is
fixed.**

## Confirmed

### 1. Step 4, item 5 — an edit no gate can see

[Step 4](arch-audit-six.plan.md) item 5 instructs:

> Fix the claim this makes false at [`instructions.ts:71`](../../../src/instructions.ts#L71):
> all three paged tools now carry the cursor in the trailer text *and* in
> `_meta`, so remove the `the text (list) or _meta (find_files, search_text)`
> split and say it plainly once.

**Tell:** step with no gate.

**Trigger:** the executor edits [`src/instructions.ts:71`](../../../src/instructions.ts#L71),
or forgets to, then runs step 4's Verify.

**Impact:** the string ships to every model client as part of the server's
`instructions`. Nothing distinguishes an unedited line 71, a correct rewrite,
and an invented one.

**Ruled out**, independently:

- Step 4's Verify is `npm run check:static && npm test`. `check:static` is
  `npm run build && npm run type-check && npm run type-check:test && eslint . &&
  prettier --check . && knip` ([`package.json`](../../../package.json)) — none of
  which reads the meaning of a string literal.
- The tests that touch `buildSectionsRecord` compare the module's output to
  itself. [`__tests__/resources.test.ts:157`](../../../__tests__/resources.test.ts#L157)
  asserts `instructionsContent.text` equals `rendered`, both derived from the
  same call; [`__tests__/prompts.test.ts:74`](../../../__tests__/prompts.test.ts#L74)
  does the same with `assert.equal(textContent.text, fullInstructions);`. Any
  rewrite of line 71 passes identically. So does no rewrite at all.
- The one content-level test stops short. TC-FUNC-055 at
  [`__tests__/resources.test.ts:61-64`](../../../__tests__/resources.test.ts#L61-L64)
  enumerates the constraints keys from `allowed_roots:` through
  `ephemeral_results:` and moves on to error recovery at line 66 — it never
  reaches `pagination:`. `grep -rn "pagination:" __tests__/ src/` returns exactly
  one hit: `src/instructions.ts:71`, with no test hit.
- The plan's own Done checklist greps for `excludePatterns|respectGitignore`,
  `FilesystemServerContext`, the seven renamed constants, and `name: '`. None
  names this line. `git status` gives no signal either: `src/instructions.ts` is
  legitimately modified by step 5's constant renames regardless.
- Step 5 cannot force the executor past it. Line 71 spells the wire names as
  literals — `find_files, search_text` — not through the `SEARCH_FILES` /
  `SEARCH_CONTENT` constants that step 5 renames, so the rename sweep does not
  touch it.

**What the fix has to supply** — this is the plan author's call, not the
hunter's:

1. The exact replacement sentence, quoted in the step, so there is nothing to
   author at execution time.
2. A check that fails when it is missing. The cheapest one that matches the
   repo's existing shape is an assertion in the TC-FUNC-055 chain at
   [`resources.test.ts:61-64`](../../../__tests__/resources.test.ts#L61-L64),
   which already walks the constraints keys and would only need
   `pagination:` added to the walk — and, unlike the tautological tests, would
   actually read the shipped text.
3. A corresponding line in the plan's Done checklist.

## Suspected

None.

## Coverage

- Steps hunted: 1 through 6, all six.
- Candidates raised and refuted: 3. Two were killed by the refuter against the
  repo and are not reported here.
- Refuters: blind, one dispatch per candidate, no in-thread fallback used.
- Checks run during the hunt that dismissed a tell before it became a candidate:
  `searchFiles` caller enumeration, `new`/`instanceof FilesystemServerContext`
  across `src` and `__tests__`, `handleList` return-type and return-object line
  ranges, `scripts/` occurrence count in `README.md`, and `respectGitignore`
  occurrence set.

## Route

Back to [write-plan](arch-audit-six.plan.md) for finding 1, then straight to
run-plan. Steps 1, 2, 3, 5 and 6 are clean and need no rework.
