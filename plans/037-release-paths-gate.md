# Plan 037: Docker, MCPB and Smithery build paths run in CI and before the release job tags anything

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- .github/workflows/ci.yml .github/workflows/release.yml scripts/`
> Plan 036 edits `release.yml` (permissions, `--ignore-scripts`, the
> publisher step); that is expected. The `Install & validate` /
> `Commit, tag & push` steps quoted below must still be adjacent.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/036 (same file; run after it)
- **Category**: dx
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

The release job runs `npm run check`, then commits, tags and pushes. Only
**after** that do the Docker build, the MCPB pack and the Smithery publish run
— in separate jobs, on the tag. A broken `Dockerfile`, a packer change, or a
Smithery card the API rejects is discovered after the version already exists
on npm and as a git tag. It has happened: `CHANGELOG.md` records 2.5.1's
Smithery publish failing with HTTP 400, followed by four `fix(ci)` commits
(`17ee13ca`, `ac6c6a6e`, `7ee3d49f`, `ed142aa1`). The MCP Registry job also
`needs: publish-docker`, so a Docker failure silently skips that channel.

`scripts/publish-smithery.mjs` already has a `--dry-run` path (line 95) that
builds the server card from a real `tools/list` and exits without publishing;
nothing calls it. `scripts/pack-mcpb.sh` and `docker build` need no secrets.

This plan puts all three behind one script, runs it as a CI job on every
push/PR, and runs it in the release job before the tag step.

## Current state

```yaml
# .github/workflows/ci.yml:28-32 (the only job's tail)
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run check
```

(The job is named `check`, a matrix over `ubuntu-latest` and
`windows-latest`, `fail-fast: false`, `timeout-minutes: 15`, `permissions: contents: read`.)

```yaml
# .github/workflows/release.yml:120-132 (after plan 036: `npm ci --ignore-scripts`)
- name: Install & validate
  run: |
    npm ci
    npm run check

- name: Commit, tag & push
  env:
    VERSION: ${{ steps.ver.outputs.version }}
  run: |
    git add package.json package-lock.json server.json mcpb/manifest.json
    git commit -m "release: v$VERSION"
    git tag -a "v$VERSION" -m "v$VERSION"
    git push origin main --follow-tags
```

```bash
# scripts/pack-mcpb.sh (whole file)
#!/usr/bin/env bash
# Stage the built server, production node_modules, manifest and icon, then pack
# filesystem-mcp.mcpb at the repo root. Needs dev dependencies installed (tsc).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cd "$root"

npm run build
cp -r dist package.json package-lock.json LICENSE README.md "$stage/"
cp mcpb/manifest.json "$stage/manifest.json"
cp assets/logo.png "$stage/icon.png"
(cd "$stage" && npm ci --omit=dev --ignore-scripts)

npx -y @anthropic-ai/mcpb@2.1.2 pack "$stage" "$root/filesystem-mcp.mcpb"
```

`scripts/publish-smithery.mjs:6-7`: "Run from the repo root after
scripts/pack-mcpb.sh (needs dist/ and filesystem-mcp.mcpb). Needs
SMITHERY_API_KEY unless --dry-run." Line 95–98: on `--dry-run` it prints
`Dry run: j0hanz/filesystem-mcp@<version>, <n> tools, not published` and
exits 0. `*.mcpb` is gitignored (`.gitignore:16`), so the packed bundle never
reaches `git add`.

The `Dockerfile` is a two-stage `node:24-alpine` build; `docker build .` needs
no arguments. GitHub's `ubuntu-latest` runners ship Docker.

## Commands you will need

| Purpose              | Command                                            | Expected on success                      |
| -------------------- | -------------------------------------------------- | ---------------------------------------- |
| Run the gate locally | `bash scripts/check-release-paths.sh`              | exit 0; prints the Smithery dry-run line |
| Prettier             | `npx prettier --check .github/workflows/ scripts/` | exit 0                                   |
| Full check           | `npm run check`                                    | exit 0                                   |

Locally, `docker` may be absent; see STOP conditions.

## Scope

**In scope** (the only files you should modify):

- `scripts/check-release-paths.sh` — new
- `.github/workflows/ci.yml` — one new job
- `.github/workflows/release.yml` — one new step in the `release` job
- `plans/README.md` (status row)

**Out of scope**: `scripts/pack-mcpb.sh`, `scripts/publish-smithery.mjs`,
`Dockerfile`; the publish jobs themselves; multi-arch builds in CI (the gate
builds the runner's own arch only).

## Git workflow

- Branch: `advisor/037-release-paths-gate` (from plan 036's branch if it is
  not on `main` yet).
- One commit: `ci: build Docker, MCPB and the Smithery card before tagging a release`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it. Do NOT dispatch
  the Release workflow.

## Steps

### Step 1: One script owns the three paths

Create `scripts/check-release-paths.sh`:

```bash
#!/usr/bin/env bash
# The release-only build paths, runnable anywhere without secrets: pack the
# desktop bundle, build the Smithery card in dry-run mode, and build the Docker
# image for the current arch. CI runs this on every push; the Release workflow
# runs it before it tags, so a broken path fails before a version exists.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

bash scripts/pack-mcpb.sh
node scripts/publish-smithery.mjs --dry-run
docker build --tag filesystem-mcp:release-check .
```

On Windows, mark it executable for git: `git update-index --chmod=+x scripts/check-release-paths.sh`
after `git add`.

**Verify**: `bash scripts/check-release-paths.sh` → exit 0 and a line
`Dry run: j0hanz/filesystem-mcp@… tools, not published`. If `docker` is not
installed locally, run the first two lines by hand and note that the Docker
step was verified in CI only.

### Step 2: CI job

Append to `.github/workflows/ci.yml` (same indentation as the `check` job,
under `jobs:`):

```yaml
release-paths:
  name: Release build paths
  runs-on: ubuntu-latest
  timeout-minutes: 15
  permissions:
    contents: read
  steps:
    - uses: actions/checkout@v6
    - uses: actions/setup-node@v6
      with:
        node-version-file: .nvmrc
        cache: npm
    - run: npm ci --ignore-scripts
    - run: bash scripts/check-release-paths.sh
```

### Step 3: Release job runs the gate before it tags

In `.github/workflows/release.yml`, between `Install & validate` and
`Commit, tag & push`, insert:

```yaml
- name: Release-only build paths (Docker, MCPB, Smithery dry run)
  run: bash scripts/check-release-paths.sh
```

Run `npx prettier --write .github/workflows/ci.yml .github/workflows/release.yml`.

**Verify**: `npx prettier --check .github/workflows/ scripts/` → exit 0;
`grep -n "check-release-paths" .github/workflows/ci.yml .github/workflows/release.yml`
→ two lines.

### Step 4: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- No unit tests. The gate itself is the test: it must pass locally (minus
  Docker if absent) and the new CI job must be green on the branch's first
  push.
- Existing CI `check` job unchanged.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `scripts/check-release-paths.sh` exists, is executable in git
      (`git ls-files -s scripts/check-release-paths.sh` starts with `100755`)
- [ ] `grep -n "check-release-paths" .github/workflows/ci.yml .github/workflows/release.yml` prints 2 lines
- [ ] The release step sits **before** `Commit, tag & push`
      (`grep -n "Release-only build paths\|Commit, tag" .github/workflows/release.yml`
      prints the gate's line number first)
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 037 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `scripts/pack-mcpb.sh` or the Smithery dry run fails locally on a clean
  worktree — that is a real release-path defect; report the output.
- `docker build .` fails locally on a machine that has Docker — same.
- The Release job has gained steps between `Install & validate` and
  `Commit, tag & push` since `8c2a82cd`; report the order rather than guess.

## Maintenance notes

- The gate adds roughly 2–4 minutes to CI (npx download of the MCPB packer,
  a Docker build with layer cache cold). If that hurts, cache
  `~/.npm/_npx` and use `docker/build-push-action` with `cache-from: type=gha`
  and `push: false` in the CI job — same script for the release job.
- The Smithery dry run exercises card construction, not the upload; an API
  contract change on Smithery's side still surfaces only on a real publish.
