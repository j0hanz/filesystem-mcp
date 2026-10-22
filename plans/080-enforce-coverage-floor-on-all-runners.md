# Plan 080: Enforce coverage floor on all runners

> **Executor instructions**: Follow step by step. Verify each step. Update `plans/README.md` row when done.
>
> **Drift check**: `git diff --stat dda3542b..HEAD -- .github/workflows/ci.yml package.json`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: ci
- **Planned at**: `dda3542b` 2026-10-16

## Why this matters

Coverage floor (lines 92 branches 85 functions 91) only runs on ubuntu via `test:coverage`. Windows can regress coverage undetected. Move floor check into matrix or add windows job.

## Current state

- `package.json:38` has `test:coverage` script with floors enforced.
- `.github/workflows/ci.yml` runs coverage only on ubuntu check job.
- No coverage gate on windows.

## Commands

| Purpose  | Command                 | Expected           |
| -------- | ----------------------- | ------------------ |
| Build    | `npm run build`         | 0                  |
| Coverage | `npm run test:coverage` | pass if floors met |
| Full     | `npm run check`         | 0                  |

## Scope

In: `.github/workflows/ci.yml`, `package.json`
Out: src, tests, docs

## Steps

### Step 1: Add coverage to matrix or duplicate job

Add `npm run test:coverage` to windows check job or create parallel job. Keep ubuntu as primary gate.

**Verify**: `cat .github/workflows/ci.yml | grep -n coverage`

### Step 2: Full check locally

**Verify**: `npm run test:coverage` passes on this platform

### Step 3: CI sanity

Push to branch and verify both runners pass.

**Verify**: manual CI check

## Test plan

- Local coverage still passes.
- CI shows coverage step on both OS when landed.

## Done criteria

- [ ] coverage floor enforced on ubuntu and windows or matrix
- [ ] `npm run check` 0
- [ ] README updated

## STOP

- Windows Node coverage unsupported -- report, keep ubuntu only
- Floor needs adjustment -- report, do not lower silently

## Maintenance

- Keep floor numbers synced in package.json.
- Reviewer checks CI minutes cost.
