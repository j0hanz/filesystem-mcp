# Plan 118: Re-running a release whose tag is already pushed finishes it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- .github/workflows/release.yml`
> If the file changed since this plan was written (plan 117 changes other
> jobs in it; that is expected), compare the "Current state" excerpts for
> the `release` job against the live file; on a mismatch there, STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (the release workflow cannot be run end to end before merging)
- **Depends on**: none. Plan 117 edits the same file; do them one at a time.
- **Category**: dx
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

The `release` job bumps the version, commits, tags, pushes to `main`, and
then creates the GitHub release. If anything fails after the push (the
`gh release create` call, or the runner dying), a re-run starts again from
the commit the workflow was dispatched on: it makes a new release commit and
tag, and the push is rejected because `main` has moved and the tag exists.
Every publish job (`npm`, Docker, MCP Registry, MCPB) depends on the
`release` job's output, so none of them can run. Recovery today means
publishing four artifacts by hand.

After this plan, a re-run notices that the tag for the computed version is
already on the remote, skips the bump, validation and push, creates the
GitHub release if it is missing, and lets the publish jobs proceed.

## Current state

`.github/workflows/release.yml`, job `release`. Steps in order (line numbers
at the planned commit):

1. checkout (44), setup-node (51)
2. `Require dispatch on main` (57)
3. `Require green CI for this commit` (68)
4. `Configure git` (94)
5. `Determine version`, `id: ver` (99-124): computes `NEW` from
   `package.json` at the dispatched commit and the `bump` / `custom_version`
   inputs, validates `MAJOR.MINOR.PATCH`, writes `version=$NEW` to
   `$GITHUB_OUTPUT`.
6. `Bump package.json, server.json, MCPB and plugin manifests` (126)
7. `Install & validate` (170)
8. `Release-only build paths (Docker, MCPB)` (175)
9. `Commit, tag & push` (180-194)
10. `Create GitHub release` (196-200):

```yaml
- name: Create GitHub release
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    VERSION: ${{ steps.ver.outputs.version }}
  run: gh release create "v$VERSION" --title "v$VERSION" --generate-notes
```

The job output is `version: ${{ steps.ver.outputs.version }}`. Publish jobs
check out `ref: v${{ needs.release.outputs.version }}`.

The end of `Determine version`:

```yaml
          echo "version=$NEW" >> "$GITHUB_OUTPUT"
          echo "### Version: $CURRENT → $NEW" >> "$GITHUB_STEP_SUMMARY"
```

A re-run of the same workflow run has the same `GITHUB_SHA` and the same
inputs, so `Determine version` computes the same `NEW` both times.

## Commands you will need

| Purpose      | Command                                              | Expected on success |
| :----------- | :--------------------------------------------------- | :------------------ |
| YAML/format  | `npx prettier --check .github/workflows/release.yml` | exit 0              |
| Shell syntax | `bash -n <file holding one run: block>`              | exit 0              |

## Scope

**In scope**:

- `.github/workflows/release.yml`, job `release` only
- `plans/README.md`

**Out of scope**:

- The publish jobs (plan 117 owns `publish-npm`).
- The CI gate step and the main-branch check: they must still run on a resume.
- `CLAUDE.md`/`AGENTS.md` release notes.

## Git workflow

- Branch: `ci/release-resume`
- One commit: `ci(release): resume a release whose tag is already pushed`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Detect an already-pushed tag in `Determine version`

Append to the `run:` script of `Determine version`, after the two `echo`
lines shown above:

```bash
          # A re-run after the push: the tag is on the remote already. Resume
          # only when that tag really carries this version; anything else is a
          # conflict a person must look at.
          if git ls-remote --exit-code --tags origin "refs/tags/v$NEW" >/dev/null 2>&1; then
            git fetch --no-tags origin "refs/tags/v$NEW:refs/tags/v$NEW"
            TAGGED=$(git show "v$NEW:package.json" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")
            if [ "$TAGGED" != "$NEW" ]; then
              echo "::error::Tag v$NEW exists but its package.json says $TAGGED"
              exit 1
            fi
            echo "resume=true" >> "$GITHUB_OUTPUT"
            echo "::notice::Tag v$NEW is already pushed; resuming after the push step"
          fi
```

`git ls-remote` over HTTPS needs no credential for a public repository.
The checkout uses `persist-credentials: false`, and the repository is public
(`package.json` `repository.url` is a public GitHub URL).

### Step 2: Skip the mutating steps on a resume

Add this line to each of the four steps `Bump package.json, server.json, MCPB and plugin manifests`,
`Install & validate`, `Release-only build paths (Docker, MCPB)` and
`Commit, tag & push`, directly under the step's `name:`:

```yaml
if: steps.ver.outputs.resume != 'true'
```

Do not add it to any other step.

### Step 3: Make the GitHub release step idempotent

Replace its `run:` line with:

```yaml
run: |
  if gh release view "v$VERSION" >/dev/null 2>&1; then
    echo "::notice::GitHub release v$VERSION already exists"
  else
    gh release create "v$VERSION" --title "v$VERSION" --generate-notes
  fi
```

### Step 4: Checks

**Verify**: `npx prettier --check .github/workflows/release.yml` → exit 0.
**Verify**: `grep -c "steps.ver.outputs.resume != 'true'" .github/workflows/release.yml` → `4`.
**Verify**: copy the full `run:` script of `Determine version` into a
scratch file outside the repository and run `bash -n` on it → exit 0.
**Verify** (logic, locally, read-only): in a scratch shell at the repo root,

```bash
NEW=$(node -p "require('./package.json').version")
git ls-remote --exit-code --tags origin "refs/tags/v$NEW" >/dev/null 2>&1 && echo present || echo absent
git show "v$NEW:package.json" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version"
```

→ prints `present` and then the same version as `NEW` (the current version
is always tagged). This proves the two commands the new block relies on.

## Test plan

The workflow cannot be exercised before merge. The four verifications above
and review are the gate.

## Done criteria

- [ ] All Step 4 verifications pass
- [ ] `git diff --stat` lists only `.github/workflows/release.yml` and `plans/README.md`
- [ ] The `Require dispatch on main` and `Require green CI for this commit` steps have no `if:`
- [ ] `plans/README.md` status row updated

## STOP conditions

- The local `git show "v$NEW:package.json"` check fails (tags are missing
  locally: run `git fetch --tags` once and retry; if it still fails, STOP).
- The repository is private (then `git ls-remote origin` needs a credential
  the job does not have at that point).
- The `release` job's steps are not in the order listed in "Current state".

## Maintenance notes

- A resume skips `npm run check`. That is safe because the tag being resumed
  was pushed only after the same check passed in the first attempt.
- A new dispatch (not a re-run) with the same `custom_version` as an
  existing tag also resumes. That is the intended manual recovery path:
  dispatch again with `custom_version` set to the stuck version.
- `publish-npm` already tolerates "version already on npm"; Docker pushes and
  the MCPB upload (`--clobber`) are idempotent. `publish-mcp` has not been
  checked for a second publish of the same version; watch it on the first
  resume.
