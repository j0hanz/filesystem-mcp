# Plan 078: Dedupe PathGuard test recompute pairs

> **Executor instructions**: Follow step by step. Run verification each step. On STOP report. Update row in `plans/README.md` when done.
>
> **Drift check**: `git diff --stat dda3542b..HEAD -- __tests__/guards.test.ts __tests__/path-guard-grant.test.ts __tests__/helpers.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: `dda3542b` 2026-10-16

## Why this matters

`guards.test.ts` and `path-guard-grant.test.ts` recreate the same `PathGuard` + assert shape 16 times (was 19). Helper `makeGuard` in `helpers.ts:157` already drops in. Dedupe cuts churn and keeps future guard changes to one place. Workbench batch H (T-08/T-15) pending.

## Current state

- `__tests__/guards.test.ts:40-200` — 8 pairs: `const guard = makeGuard([root]); assert...`
- `__tests__/path-guard-grant.test.ts:30-180` — 8 pairs same shape.
- `__tests__/helpers.ts:157` `makeGuard(roots: string[])` already exists, creates PathGuard with test config.

Excerpt:

```ts
// before per test
const guard = new PathGuard({ allowedRoots: [root], ... });
assert.equal(guard.isPathAllowed(p), true);
```

Conventions: tests use `node:test` `describe/it`, `assert.strict`, `createTestRoot`/`cleanupTestRoot`. No mocking needed.

## Commands

| Purpose | Command                                    | Expected |
| ------- | ------------------------------------------ | -------- |
| Tests   | `npm test -- --test-name-pattern="guards"` | pass     |
| Full    | `npm run check`                            | exit 0   |

## Scope

In: `__tests__/guards.test.ts`, `__tests__/path-guard-grant.test.ts`, `__tests__/helpers.ts`
Out: src files, snapshots, docs

## Steps

### Step 1: Add helper `assertGuardAllows(root, path, expected)`

In `helpers.ts` next to `makeGuard`, add small helper wrapping makeGuard + assert. Keep existing `makeGuard` export.

**Verify**: `npm run build` exit 0

### Step 2: Replace 16 pairs

Replace each recompute pair with single call to helper. Keep test names. No logic change.

**Verify**: `npm test -- --test-name-pattern="guards|grant"` pass

### Step 3: Full check

**Verify**: `npm run check` exit 0; `grep -c "new PathGuard" __tests__/guards.test.ts` ≤2

## Test plan

- Existing suites must pass; no new logic.
- Use `grep helper` to confirm no leftover raw PathGuard in test bodies beyond setup.

## Done criteria

- [ ] 16 pairs replaced
- [ ] `npm run check` exit 0
- [ ] only in-scope files changed
- [ ] README row updated

## STOP

- Helper signature mismatch → report
- Pair count ≠16 → recount, report
- Tests fail after replace → revert

## Maintenance

- New guard tests must use helper.
- Reviewer checks helper covers both allow/deny cases.
