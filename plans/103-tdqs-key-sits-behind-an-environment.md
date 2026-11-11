# Plan 103: The TDQS workflow's key sits behind an environment, and its header says what is true

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- .github/workflows/tdqs.yml`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live file before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

The TDQS workflow scores the server's tool definitions on a hosted service
and holds an API key for it. Its header comment says "The secret never meets
PR code". That holds for a pull request from a fork, which gets no secrets.
It does not hold for a pull request from a branch in this repository: GitHub
runs the workflow file **from the pull request's head**, the workflow
triggers on changes to itself, and the `score` job reads the key. A same-repo
branch that edits `tdqs.yml` can therefore run any step with the key. Agent
branches open pull requests in this repository without manual approval (the
first line of `ci.yml` says so). The key is low-value (30 scoring calls a
day), so this is a small exposure, but the comment states a guarantee the
workflow does not give.

A workflow file cannot protect itself against its own edits. The protection
has to live in repository settings: a GitHub Environment holds the secret and
requires a reviewer before a job may use it. This plan makes the code half of
that change and corrects the comment. **The settings half is the operator's
and is listed at the end.**

## Current state

One file: `.github/workflows/tdqs.yml`.

Header and trigger (`:1-17`):

```yaml
# Scores the advertised tool definitions on tdqs.dev (the rubric Glama uses).
# Kept apart from ci.yml, which must stay secret-free. The secret never meets
# PR code: `definitions` builds and runs the PR with no secret and hands the
# tools/list JSON on as data; `score` holds the key and runs only the pinned
# tdqs CLI on that JSON. A hosted score spends one of the account's 30 daily
# calls, so `score` runs only when tools/list differs from the base branch.
name: TDQS

on:
  pull_request:
    paths:
      # Schema limits and copy live across src/, so any of it can change tools/list.
      - 'src/**'
      - 'package-lock.json'
      - 'scripts/tools-list.mjs'
      - '.github/workflows/tdqs.yml'
  workflow_dispatch:
```

The job that holds the key (`:85-100`):

```yaml
score:
  name: TDQS score
  needs: definitions
  if: ${{ needs.definitions.outputs.changed == 'true' }}
  runs-on: ubuntu-latest
  timeout-minutes: 10
  permissions: {}
  env:
    # Empty on fork PRs, which receive no secrets; the score step skips then.
    TDQS_API_KEY: ${{ secrets.TDQS_API_KEY }}
    # Passed through env, never interpolated into the script: it is PR-built data.
    TOOLS_JSON: ${{ needs.definitions.outputs.tools }}
  steps:
    - name: Score definitions
      if: ${{ env.TDQS_API_KEY != '' }}
```

How GitHub Environments behave (GitHub Actions documentation): a job that
names an `environment:` can read that environment's secrets; if the
environment has required reviewers, the job waits for approval before it
starts; an environment that does not exist is created with no protection the
first time a job names it. Repository secrets stay readable by every job, so
the key is protected only once it is **moved** from a repository secret to an
environment secret.

## Commands you will need

| Purpose | Command                                           | Expected on success |
| ------- | ------------------------------------------------- | ------------------- |
| Format  | `npx prettier --check .github/workflows/tdqs.yml` | exit 0              |
| Check   | `npm run check`                                   | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `.github/workflows/tdqs.yml`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `.github/workflows/ci.yml` and `release.yml`.
- The `definitions` job.
- Repository settings: you cannot and must not change secrets or
  environments. Never print, read or copy the key.

## Git workflow

- Branch: `advisor/103-tdqs-key-sits-behind-an-environment`
- One commit: `ci(tdqs): take the key from a protected environment`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Correct the header

Replace the second and third header sentences so the comment reads:

```yaml
# Scores the advertised tool definitions on tdqs.dev (the rubric Glama uses).
# Kept apart from ci.yml, which must stay secret-free. `definitions` builds and
# runs the PR with no secret and hands the tools/list JSON on as data; `score`
# holds the key and runs only the pinned tdqs CLI on that JSON. A fork PR gets
# no key. A branch in this repository can edit this file, so the key lives in
# the `tdqs` environment, whose required reviewer approves each `score` run.
# A hosted score spends one of the account's 30 daily calls, so `score` runs
# only when tools/list differs from the base branch.
```

**Verify**: `grep -c "never meets" .github/workflows/tdqs.yml` → `0`.

### Step 2: Name the environment on the `score` job

Add one line to the `score` job, directly after `timeout-minutes: 10`:

```yaml
environment: tdqs
```

Change the comment above `TDQS_API_KEY` to:

```yaml
# Empty on fork PRs, and until the `tdqs` environment holds the key; the score step skips then.
```

**Verify**: `grep -n "environment: tdqs" .github/workflows/tdqs.yml` → 1
match, inside the `score` job. `npx prettier --check .github/workflows/tdqs.yml`
→ exit 0.

### Step 3: Full check

**Verify**: `npm run check` → exit 0.

### Step 4: Hand the settings steps to the operator

Put this list in your final report, word for word. Do not attempt the steps.

1. In the repository settings, open Environments and create (or open) the
   environment named `tdqs`.
2. Add a required reviewer (the maintainer).
3. Add the secret `TDQS_API_KEY` to that environment, with a newly issued
   key from the scoring service.
4. Delete the repository-level secret `TDQS_API_KEY`, and revoke the old key
   at the scoring service.

Until step 4 is done the workflow behaves as before.

## Test plan

No automated test: workflow behavior can only be observed on GitHub. After
the operator's steps, a pull request that changes `tools/list` should show
the `TDQS score` job waiting for approval.

## Done criteria

- [ ] `grep -c "never meets" .github/workflows/tdqs.yml` returns 0
- [ ] `grep -c "environment: tdqs" .github/workflows/tdqs.yml` returns 1
- [ ] `npx prettier --check .github/workflows/tdqs.yml` exits 0
- [ ] `git status --short` lists only `.github/workflows/tdqs.yml` and `plans/README.md`
- [ ] The operator steps are in the report
- [ ] `plans/README.md` status row updated to `DONE (code); operator settings steps pending`

## STOP conditions

Stop and report back (do not improvise) if:

- The `score` job does not match the excerpt, or already names an
  environment.
- The header comment differs from the excerpt.
- Anything asks you to read or print a secret value.

## Maintenance notes

- Cost of the protection: each scoring run waits for one approval click.
  Scoring runs only when `tools/list` changes, which is rare. If the
  maintainer finds the click not worth it, the honest alternative is to keep
  Step 1 only (a true comment) and accept the exposure of a low-value key.
- A branch can still delete the `environment:` line in its own pull request;
  the job then has no access to the environment secret at all, which is the
  safe outcome.
- `tdqs.yml` also runs on `workflow_dispatch`; that path needs the same
  approval once the environment is protected.
