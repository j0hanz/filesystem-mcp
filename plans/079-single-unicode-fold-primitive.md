# Plan 079: Single unicode fold primitive for search

> **Executor instructions**: Follow step by step. Verify each step. Update `plans/README.md` row when done.
>
> **Drift check**: `git diff --stat dda3542b..HEAD -- src/core/path-utils.ts src/core/search.ts`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: `dda3542b` 2026-10-16

## Why this matters

Path case handling and literal search case-fold use two spellings. `foldUnicodeSpelling` lives in `path-utils.ts` for path lookup; `search.ts` does its own ASCII fold. One owner prevents drift and honors workbench T-06/T-16.

## Current state

- `src/core/path-utils.ts:80-110` exports `foldUnicodeSpelling(s: string): string` (unicode NFC/NFD + case).
- `src/core/search.ts:120-200` has inline `toLowerCase` + kelvin/long-s handling for literal matcher.
- Both do similar but diverge on edge cases.

Conventions: `path-utils.ts` holds no-dependency primitives, imported by core. Tests in `__tests__/search-literal.test.ts` pin folding.

## Commands

| Purpose | Command                                    | Expected |
| ------- | ------------------------------------------ | -------- |
| Build   | `npm run build`                            | 0        |
| Tests   | `npm test -- --test-name-pattern="search"` | pass     |
| Lint    | `npm run lint`                             | 0        |

## Scope

In: `src/core/path-utils.ts`, `src/core/search.ts`
Out: `src/core/path.ts`, snapshots, docs

## Steps

### Step 1: Extend fold primitive to cover search needs

Add optional `caseSensitive` param to `foldUnicodeSpelling` or add wrapper `foldForSearch` that reuses core logic. Keep existing export signature.

**Verify**: `npm run build` 0

### Step 2: Route search through it

Replace inline fold in `createLiteralMatcher` with call to primitive. Remove duplicate kelvin/long-s branching -- primitive already handles.

**Verify**: `npm test -- --test-name-pattern="search"` pass

### Step 3: Full check

**Verify**: `npm run check` 0; `grep -n "KELVIN\|LONG_S" src/core/search.ts` → no hits

## Test plan

- Existing `search-literal` tests must still pass (they pin fold behavior).
- No new tests.

## Done criteria

- [ ] single owner in `path-utils.ts`
- [ ] `search.ts` delegates, no duplicate fold logic
- [ ] `npm run check` 0
- [ ] README updated

## STOP

- Fold behavior change breaks tests → keep old path, report
- Primitive cannot cover search caseSensitive modes → report

## Maintenance

- All future case folding must use `path-utils` primitive.
- Reviewer checks equivalence on kelvin/long-s edge.
