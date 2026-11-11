# Plan 091: The Release workflow refuses a version that is not `MAJOR.MINOR.PATCH`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- .github/workflows/release.yml`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live file before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

The Release workflow's `custom_version` input advertises a prerelease
(`2.0.0-beta.1`) as its example. The workflow cannot ship one cleanly. It
commits, tags and pushes to `main` first, then publishes. `npm publish` runs
with no `--tag`, the Docker job tags the image `latest` unconditionally, and
the MCP registry job waits on npm. A prerelease dispatch would therefore push
a release commit to `main` and move Docker `latest` to a beta, with npm either
failing or publishing the beta as `latest`. No prerelease has ever been
released (`git tag` holds no `-` version), so the cheapest correct fix is to
refuse the input before anything is pushed.

## Current state

One file: `.github/workflows/release.yml` (dispatched by hand; jobs
`release` → `publish-npm`, `publish-docker`, `publish-mcp`, `publish-mcpb`).

The input (`.github/workflows/release.yml:15-18`):

```yaml
custom_version:
  description: 'Custom version (overrides bump, e.g. 2.0.0-beta.1)'
  required: false
  type: string
```

The step that settles the version (`:99-117`), inside job `release`:

```yaml
- name: Determine version
  id: ver
  env:
    CUSTOM_VERSION: ${{ inputs.custom_version }}
    BUMP: ${{ inputs.bump }}
  run: |
    CURRENT=$(node -p "require('./package.json').version")
    if [ -n "$CUSTOM_VERSION" ]; then
      NEW="$CUSTOM_VERSION"
    else
      IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
      case "$BUMP" in
        major) NEW="$((MAJOR + 1)).0.0" ;;
        minor) NEW="$MAJOR.$((MINOR + 1)).0" ;;
        patch) NEW="$MAJOR.$MINOR.$((PATCH + 1))" ;;
      esac
    fi
    echo "version=$NEW" >> "$GITHUB_OUTPUT"
    echo "### Version: $CURRENT → $NEW" >> "$GITHUB_STEP_SUMMARY"
```

Why a prerelease half-ships (for understanding only; do not edit these):

- `:225` `npm publish --access public --provenance --ignore-scripts`: no `--tag`.
- `:278` `type=raw,value=latest`: Docker `latest` for every release.
- The commit, tag and `git push --atomic ... main --follow-tags` happen in job
  `release`, before any publish job.

Conventions in this file: the step script is bash (it already uses `<<<`),
user input reaches the script only through `env:` (never interpolated into
`run:`), and errors use GitHub's `::error::` annotation form.

## Commands you will need

| Purpose     | Command                                              | Expected on success |
| ----------- | ---------------------------------------------------- | ------------------- |
| Install     | `npm ci`                                             | exit 0              |
| Format      | `npx prettier --check .github/workflows/release.yml` | exit 0              |
| Regex check | the bash snippet in Step 2                           | the listed output   |
| Full check  | `npm run check`                                      | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `.github/workflows/release.yml`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- The `publish-npm`, `publish-docker`, `publish-mcp` and `publish-mcpb` jobs.
  Making prereleases _work_ (an npm dist-tag, a conditional Docker `latest`,
  a registry decision) is a separate feature nobody has asked for.
- Any version field in `package.json`, `server.json`, `mcpb/manifest.json`,
  `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`. Only the Release
  workflow may change those.
- `.github/workflows/ci.yml`.

## Git workflow

- Branch: `advisor/091-release-refuses-prerelease-versions`
- One commit: `fix(release): refuse a version that is not MAJOR.MINOR.PATCH`
- Do NOT push or open a PR unless the operator instructed it. Do NOT dispatch
  the Release workflow.

## Steps

### Step 1: Refuse the version before it is used

In `.github/workflows/release.yml`, in the `Determine version` step, insert
this block between the closing `fi` and the line
`echo "version=$NEW" >> "$GITHUB_OUTPUT"`, at the same indentation as `fi`:

```bash
          # Nothing downstream handles a prerelease: npm would need a dist-tag,
          # Docker tags every release `latest`, and this job has already pushed
          # to main by the time either runs. Refuse before anything is written.
          if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo "::error::Version '$NEW' is not MAJOR.MINOR.PATCH. Prerelease and build suffixes are not supported by this workflow."
            exit 1
          fi
```

Then change the input description on line 16 to:

```yaml
description: 'Custom version (overrides bump, e.g. 2.20.0). MAJOR.MINOR.PATCH only.'
```

**Verify**:
`grep -n "is not MAJOR.MINOR.PATCH" .github/workflows/release.yml` → 1 match;
`grep -n "beta" .github/workflows/release.yml` → no matches.

### Step 2: Check the regex in a shell

Run this in bash (Git Bash on Windows is fine):

```bash
for v in 2.20.0 10.0.0 2.0.0-beta.1 2.0 v2.0.0 "2.0.0 " ""; do
  if [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "ok   [$v]"; else echo "refuse [$v]"; fi
done
```

**Verify**: output is exactly

```text
ok   [2.20.0]
ok   [10.0.0]
refuse [2.0.0-beta.1]
refuse [2.0]
refuse [v2.0.0]
refuse [2.0.0 ]
refuse []
```

### Step 3: Format and full check

**Verify**: `npx prettier --check .github/workflows/release.yml` → exit 0,
then `npm run check` → exit 0.

## Test plan

No automated test: no test in `__tests__/` or `scripts/` reads
`release.yml` (checked with `grep -rl "release.yml" __tests__ scripts` → no
matches). Step 2 is the check.

## Done criteria

- [ ] `grep -c "is not MAJOR.MINOR.PATCH" .github/workflows/release.yml` returns 1
- [ ] `grep -c "beta" .github/workflows/release.yml` returns 0
- [ ] `npx prettier --check .github/workflows/release.yml` exits 0
- [ ] `git status --short` lists only `.github/workflows/release.yml` and `plans/README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `Determine version` step does not match the excerpt.
- `grep -rl "release.yml\|custom_version" __tests__ scripts` returns a file:
  a test now pins this workflow and must be read first.
- Step 2 prints anything different from the expected output.

## Maintenance notes

- If prereleases are wanted later, three places must change together: an npm
  dist-tag at the `npm publish` line, `enable=` on the `type=raw,value=latest`
  Docker tag, and a decision on whether the MCP registry entry should move.
  Remove this refusal only in the same change.
- The claim that npm refuses an untagged prerelease was not tested; the
  refusal makes it moot.
- Reviewer: the check must sit before `echo "version=$NEW"`, so no later step
  ever sees a refused version.
