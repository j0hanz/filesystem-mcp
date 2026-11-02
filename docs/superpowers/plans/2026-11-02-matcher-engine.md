# Matcher Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the text-matching judgment one deep home (`src/core/matcher.ts`) behind a named **Match plan** entry, so `search_text` previews exactly what `replace_text` touches, and the matcher machinery becomes unit-testable without booting the server.

**Architecture:** Four behavior-preserving steps on one branch (`worktree-matcher-engine`): (1) a bug-fix change that makes replace's case-sensitive literal obey search's RE2 bail; (2) the judgment half of `core/search.ts` moves to `core/matcher.ts` behind `planMatch`; (3) the replace-side matcher trio moves in beside it; (4) the DiffBudget moves to its own module and scan's `window`/`onSettled` pair is documented as scan's admission seam. Only step (1) changes wire behavior.

**Tech Stack:** TypeScript 7 native compile (ADR-009), Node test runner, RE2 via re2-wasm (fixed 16 MB heap — every compiled regex must be freed).

**Spec:** The grilled decisions of 2026-11-02 (this session), restated as Global Constraints. `GLOSSARY.md` defines **Match plan**.

## Global Constraints

- Pure refactor in Tasks 2-4: zero wire-visible behavior change; `__tests__/contract.test.ts` must not change (only Task 1 may alter behavior, and only for needles containing U+FFFD or a lone surrogate in case-sensitive literal mode).
- Five deliberate divergences preserved verbatim: `wholeWord` replace-only; too-large skip (search) vs `TOO_LARGE` fail (replace); the whole-buffer prefilter is search-only; `maxResults` (search) vs `maxMatches` (replace); `needsRe2` is the shared per-text trigger.
- Unit tests at the new seams only; `__tests__/tools.test.ts` content untouched — the single allowed edit is the `RE2_MAX_INPUT_BYTES` import path re-point in Task 2.
- `createCrlfVariant` stays in `src/tools/replace-text.ts`; `src/tools/edit.ts` is untouched (its `flexMatches` is an independent family).
- No version bumps — the Release workflow owns them.
- `npm run check` green at the end of every task.

## Review Focus

1. **RE2 heap leaks:** every compiled regex freed on every path (fixed 16 MB wasm heap, never reclaimed) — pinned by matcher.test.ts dispose tests; the CRLF double-dispose identity check stays tool-side.
2. **U+FFFD / lone-surrogate needles:** all paths agree post-fix (search, replace fast path, replace regex path) — pinned by replace-text-bail.test.ts.
3. **wholeWord resume:** `ENDS_NON_WORD` back-up and `TEXT_START` prepend (issue #158 regression class) — pinned by matcher.test.ts wholeWord tests.
4. **$-token precedence:** `$12` prefers group 12, falls back to group 1 + literal `2`, stays literal when neither; a named group absent from the match renders literally — pinned by matcher.test.ts dollar-token tests.
5. **Fold characters U+212A / U+017F:** `needsRe2` consulted on both Buffer and decoded-string forms (testBuffer vs replace disagreeing is the drift class this refactor ends) — pinned by matcher.test.ts needsRe2 tests.

---

### Task 1: Bail the case-sensitive literal to RE2

**Files:**

- Modify: `src/tools/replace-text.ts:389-420` (`createCaseSensitiveLiteralMatcher`), `:643-646` (fast-path call)
- Test: `__tests__/replace-text-bail.test.ts` (new)

**Interfaces:**

- Consumes: today's `createCaseSensitiveLiteralMatcher(searchPattern: string): ReplacementMatcher` (replace-text.ts:389).
- Produces: `createCaseSensitiveLiteralMatcher(searchPattern: string): ReplacementMatcher | undefined` — `undefined` when the needle contains U+FFFD or is not its own UTF-8 round trip; the caller falls through to the regex path.

- [ ] **Step 1: Write the failing test**

New file. Harness pattern from `__tests__/read-only-roots.test.ts`: Client over InMemoryTransport against `createServer(createRuntimeState(...))` from `__tests__/helpers.ts`.

- test `case-sensitive literal with a lone-surrogate needle matches what search matches`: write a file containing a literal U+FFFD; `replace_text` needle `'\uD800'`, `caseSensitive: true`, `isRegex: false`; assert the file reports exactly 1 match and the U+FFFD is replaced. Run `search_text` with the same needle and assert both tools name the same file (parity is the point).
- test `case-sensitive literal with a U+FFFD needle matches invalid-byte decodes`: write a file whose decoded text contains U+FFFD produced by an invalid raw byte (0xFF); needle `'�'`, `caseSensitive: true`; assert 1 match (today: 0 — `testBuffer` hunts the EF BF BD bytes, the file has none).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- __tests__/replace-text-bail.test.ts`
Expected: FAIL — matchCount 0 in both tests.

- [ ] **Step 3: Implement the bail**

First lines of `createCaseSensitiveLiteralMatcher`, mirroring `createLiteralMatcher`'s bail (`src/core/search.ts:146-148`):

```ts
if (searchPattern.includes('�') || Buffer.from(searchPattern).toString() !== searchPattern) {
  return undefined;
}
```

Widen its return type to `ReplacementMatcher | undefined`. In `createReplacementMatcher` (replace-text.ts:643-646) capture the result and fall through when undefined:

```ts
if (!args.isRegex && !args.wholeWord && args.caseSensitive) {
  const fast = createCaseSensitiveLiteralMatcher(args.searchPattern);
  if (fast) return fast;
}
```

The existing `:647-648` path then serves it (escaped source, `expandReplacement: args.isRegex` false — replacement inserted verbatim).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- __tests__/replace-text-bail.test.ts`
Expected: PASS. Then `npm run check` — green.

- [ ] **Step 5: Commit**

```bash
git add __tests__/replace-text-bail.test.ts src/tools/replace-text.ts
git commit -m "fix(replace-text): bail the case-sensitive literal to RE2 for U+FFFD and lone-surrogate needles

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

The fix's honest cost, accepted by the drift decision: a whole buffer over 4 MiB under such a needle now hits the regex matcher's `TOO_LARGE` refusal (replace-text.ts:269-274) where it previously reported a silent 0-match. That matches replace's regex-mode contract and the deliberate skip-vs-fail divergence.

### Task 2: The judgment moves to core/matcher.ts behind planMatch

**Files:**

- Create: `src/core/matcher.ts`
- Modify: `src/core/search.ts` (:65-331 blocks, :470, :476-478, :484-487, :504-506), `src/tools/replace-text.ts:36-44` (import re-point), `__tests__/tools.test.ts:28` (import re-point)
- Test: `__tests__/matcher.test.ts` (new)
- The commit also carries the already-written `GLOSSARY.md` (the **Match plan** term, sitting uncommitted in the tree).

**Interfaces:**

- Produces (moved verbatim from `src/core/search.ts`, exported): `createYielder`, `RE2_MAX_INPUT_BYTES`, `MAX_MATCHES_PER_LINE`, `countOccurrences`, `foldAsciiCase`, `LiteralMatcher`, `LineHit`, `createLiteralMatcher`, `compileRegex`, `freeRegex`, `execMatches`.
- Produces (new):

```ts
export interface MatchPlan {
  /** Native literal pass; undefined when RE2 must judge the needle itself. */
  readonly literal: LiteralMatcher | undefined;
  /** RE2 source: the needle as given, escaped when literal, wrapped for wholeWord when asked. */
  readonly source: string;
}
export function planMatch(
  needle: string,
  flags: { isRegex: boolean; caseSensitive: boolean; wholeWord?: boolean },
): MatchPlan;
```

- Consumes: `escapeRegExp` from `core/util.ts` (stays there); the wholeWord wrap from replace-text.ts `buildSearchPattern` (:637-641) moves in as a private helper with `WORD_CLASS` (:197).

- [ ] **Step 1: Write the failing tests**

New file `__tests__/matcher.test.ts`, importing from `../src/core/matcher.ts` and `escapeRegExp` from `../src/core/util.ts`:

- `planMatch` case-sensitive literal: `.literal` defined with `needsRe2` always false; `.source === escapeRegExp('a.b')`.
- `planMatch` regex: `literal === undefined`, `.source === 'a+'`.
- `planMatch` bails: needles `'�'` and `'\uD800'` → `literal === undefined` in both case modes; non-ASCII needle with `caseSensitive: false` → `literal === undefined`.
- `planMatch` wholeWord: `.source` for needle `'foo'` equals the wrapped source `buildSearchPattern` produces today (lead group + escaped needle + trail group — copy the expected string from the current implementation's output).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- __tests__/matcher.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/core/matcher.ts`**

Move verbatim from `src/core/search.ts`: `:65` (`MAX_MATCHES_PER_LINE`), `:73-83` (`createYielder`), `:91` (`RE2_MAX_INPUT_BYTES`), `:105-171` (`LiteralMatcher`, `LineHit`, `KELVIN_SIGN`, `LONG_S`, `foldAsciiCase`, `countOccurrences`, `createLiteralMatcher`), `:200-237` (`compileRegex`, `freeRegex`), `:273-331` (`execMatches`). Add `planMatch` plus the private wholeWord-wrap helper (from replace-text.ts `buildSearchPattern` `:637-641` + `WORD_CLASS` `:197`). File header: one short paragraph naming the **Match plan** (see GLOSSARY.md).

- [ ] **Step 4: Rewire `searchContent`**

- `:470` source build → `const plan = planMatch(pattern, { isRegex: options.isRegex, caseSensitive: Boolean(options.caseSensitive) })`.
- `:476-478` working regex → `compileRegex(plan.source, Boolean(options.caseSensitive))`.
- `:484-487` prefilter → same expression, using `plan.source`.
- `:504-506` → `const literal = plan.literal`.

`scanFile` keeps its per-file logic (`:403-409`) — only the creation side rewires. `MAX_MATCH_LINE_CHARS` and `canPrefilter` stay in search.ts.

- [ ] **Step 5: Re-point imports**

- `src/tools/replace-text.ts:36-44`: the moved names import from `../core/matcher.ts`.
- `__tests__/tools.test.ts:28`: `RE2_MAX_INPUT_BYTES` imports from `../src/core/matcher.ts`; `MAX_MATCH_LINE_CHARS` and `searchContent` stay on `../src/core/search.ts` (the only other search.ts imports in tests — core-fs.test.ts:37, outbound-regressions.test.ts:12, search-literal.test.ts:8 — use names that stay).

- [ ] **Step 6: Run tests**

Run: `npm test -- __tests__/matcher.test.ts` — PASS. Then `npm run check` — green; the contract snapshot must be unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/core/matcher.ts src/core/search.ts src/tools/replace-text.ts __tests__/tools.test.ts __tests__/matcher.test.ts GLOSSARY.md
git commit -m "refactor(matcher): one Match plan entry owns the judgment

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 3: The replace trio moves beside the judgment

**Files:**

- Modify: `src/core/matcher.ts` (grows), `src/tools/replace-text.ts` (shrinks)
- Test: `__tests__/matcher.test.ts` (extends)

**Interfaces:**

- Produces (moved verbatim, exported): `ReplacementMatcher` (:178-192), `createCaseSensitiveLiteralMatcher` (with Task 1's `| undefined`), `createCaseInsensitiveLiteralMatcher` (:349-387), `createRegexReplacementMatcher` (:262-346), `createReplacementMatcher` (:643-655).
- Becomes private in matcher.ts: `expandDollarTokens` (:233-260), `DOLLAR_TOKEN` (:194), `ENDS_NON_WORD` (:199), `TEXT_START` (:202).
- Consumes: `planMatch` from Task 2; `freeRegex`, `execMatches`, `RE2_MAX_INPUT_BYTES` in-module.

- [ ] **Step 1: Write the failing tests**

Extend `__tests__/matcher.test.ts` — pinning at the seam what today only wire tests pin:

- dollar tokens: `$12` prefers group 12, falls back to group 1 + literal `2`, stays literal when neither exists; a named group absent from the match renders literally; `$&`, `` $` ``, `$'`.
- wholeWord resume: `foo foo foo` transforms all three in one pass (back-up over `ENDS_NON_WORD`); a match at text start is found (`TEXT_START`, issue #158).
- case-sensitive splice: `maxMatches` cap respected, matchCount exact, `write: false` when 0 matches.
- case-insensitive: fold+splice path matches `FOO` for needle `foo`; content containing U+212A delegates to the regex fallback (`needsRe2`).
- dispose: regex matcher `dispose()` frees without error and is idempotent.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- __tests__/matcher.test.ts`
Expected: FAIL — factories not exported from `src/core/matcher.ts`.

- [ ] **Step 3: Move the trio verbatim into matcher.ts**

Constants `:194`, `:199`, `:202`; `ReplacementMatcher` `:178-192`; `expandDollarTokens` `:233-260`; the three factories `:262-346`, `:349-387`, `:389-420`; `createReplacementMatcher` `:643-655`. Inside `createReplacementMatcher`, replace the inline `buildSearchPattern` + `compileRegex` + `createLiteralMatcher` calls with `const plan = planMatch(args.searchPattern, { isRegex: args.isRegex, caseSensitive: args.caseSensitive, wholeWord: args.wholeWord })`: the fast path keeps Task 1's shape; the regex becomes `compileRegex(plan.source, args.caseSensitive)`; the case-insensitive literal becomes `plan.literal` under today's `!isRegex && !wholeWord` condition (`:650-654`). `buildSearchPattern` dissolves into `planMatch`.

- [ ] **Step 4: Shrink the tool file**

`src/tools/replace-text.ts` keeps: the input schema, `createCrlfVariant` (now importing `createReplacementMatcher` from `../core/matcher.ts`), the DiffBudget (until Task 4), `processEntry`, `handleSearchAndReplace` wiring, and the result text. Delete the moved blocks.

- [ ] **Step 5: Run tests**

Run: `npm test -- __tests__/matcher.test.ts __tests__/replace-text-bail.test.ts __tests__/search-literal.test.ts` — PASS. Then `npm run check` — green; contract snapshot unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/core/matcher.ts src/tools/replace-text.ts __tests__/matcher.test.ts
git commit -m "refactor(matcher): the replace trio lives beside the judgment

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

### Task 4: The DiffBudget owns its folding; scan's admission seam is named

**Files:**

- Create: `src/core/diff-budget.ts`
- Modify: `src/tools/replace-text.ts` (:143, :548-602, call sites `:805-811`, `:826`), `src/core/scan.ts:218-221` (comment only)
- Test: `__tests__/diff-budget.test.ts` (new)

**Interfaces:**

- Produces (moved verbatim from replace-text.ts, exported): `MAX_DIFF_SIZE` (:143), the `DiffBudget` interface (:548-557), `fold` (:560-566), `settle` (:569-575), `finishDiff` (:578-581), `patchWithinBudget` (:585-602 — keep the existing parameter order).
- Consumes: nothing new — pure data and pure functions.

- [ ] **Step 1: Write the failing tests**

New file `__tests__/diff-budget.test.ts`, importing from `../src/core/diff-budget.ts` — unit pins mirroring the wire pins at tools.test.ts:4265-4414:

- first-fit fold in walk order under forced out-of-order settle (store three patches, settle them out of order, assert the walk-first ones that fit are kept);
- a patch alone over the whole budget is refused (`patch.length > remaining`);
- a full budget refuses fast without counting unsettled stored patches;
- `finishDiff` drains stored patches in index order after the walk;
- `settle` advances only over the contiguous prefix.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- __tests__/diff-budget.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Move the budget verbatim**

Into `src/core/diff-budget.ts`: `MAX_DIFF_SIZE`, `DiffBudget`, `fold`, `settle`, `finishDiff`, `patchWithinBudget`, with their comments. `src/tools/replace-text.ts` imports them; the wiring at `:805-811` and `:826` is untouched.

- [ ] **Step 4: Name the seam**

Extend the `window`/`onSettled` doc comment at `src/core/scan.ts:218-221` with one paragraph: this is scan's admission seam — a consumer bounds how far the walk may run ahead of its settled prefix; every dispatched index settles, admitted or refused; the sole consumer today is the diff budget (`core/diff-budget.ts`).

- [ ] **Step 5: Run tests**

Run: `npm test -- __tests__/diff-budget.test.ts` — PASS. Then `npm run check` — green; contract snapshot unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/core/diff-budget.ts src/tools/replace-text.ts src/core/scan.ts __tests__/diff-budget.test.ts
git commit -m "refactor(diff-budget): the diff budget owns its folding; scan's admission seam is named

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
