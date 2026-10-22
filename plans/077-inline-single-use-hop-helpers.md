# Plan 077: Inline single-use hop helpers

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat dda3542b..HEAD -- src/core/path.ts src/core/path-completer.ts src/tools/list.ts`
> If any in-scope file changed, compare "Current state" excerpts against live code; on mismatch treat as STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `dda3542b`, 2026-10-16

## Why this matters

Three helpers are called from exactly one site each, adding indirection with no reuse. Inlining them removes ~30 lines and makes the call graph explicit. This is workbench batch G (T-07/T-14) pending delivery — low risk, pure deletion.

## Current state

- Files:
  - `src/core/path.ts:308-325` — `isEntryAccessible` hops through `findAllowedRootByName` style helper (single caller in `src/tools/list.ts`).
  - `src/core/path-completer.ts:120-150` — path completion helper used only by completer.
  - `src/tools/list.ts:130-160` — list collect calls thin wrapper around `pathGuard.isEntryAccessible`.

Excerpts (from `docs/plan/2026-10-16-arch-audit-findings-3/assets/audit-findings.md` finding 9/10):

```
src/core/path.ts:317 — helper X called only from src/tools/list.ts:142
src/core/path-completer.ts:135 — helper Y single-use
src/tools/list.ts:145 — wrapper Z single-use
```

Conventions: keep `PathGuard` validation order (validate → isSensitive checks). After T-10 sensitive prune already lands, do not re-add ancestor loop.

## Commands you will need

| Purpose   | Command                   | Expected |
| --------- | ------------------------- | -------- |
| Build     | `npm run build`           | exit 0   |
| Typecheck | `npm run type-check:test` | exit 0   |
| Tests     | `npm test`                | exit 0   |
| Lint      | `npm run lint`            | exit 0   |

## Scope

**In scope**: `src/core/path.ts`, `src/core/path-completer.ts`, `src/tools/list.ts`

**Out of scope**: `src/core/fs.ts`, contract snapshot, docs

## Git workflow

- Branch: `advisor/077-inline-single-use-hops`
- Commit: `refactor(path): inline single-use hop helpers`

## Steps

### Step 1: Inline helpers

- In `src/core/path.ts` remove helper function, move its body into sole caller.
- Same for `path-completer.ts`.
- In `src/tools/list.ts` replace wrapper call with direct `pathGuard.isEntryAccessible` logic if still needed, or delete wrapper.

**Verify**: `npm run build && npm run type-check:test` → exit 0

### Step 2: Full check

**Verify**: `npm test` → all pass; `npm run check:static` → exit 0; `grep -rn "helperName" src/core/path.ts` → no match (confirm deletion)

## Test plan

- No new tests; existing `guards`, `path`, `list` suites cover paths.
- Verify: `npm test -- --test-name-pattern="guards|path"` pass.

## Done criteria

- [ ] helpers deleted, callers inlined
- [ ] `npm run check` exit 0
- [ ] git status only in-scope files
- [ ] README row updated

## STOP conditions

- Excerpt mismatch → drift
- Helper has >1 caller now → scope changed, report
- Verification fails twice

## Maintenance notes

- Future helpers must have ≥2 callers to justify existence.
- Reviewer: verify no behavior change, only inlining.
