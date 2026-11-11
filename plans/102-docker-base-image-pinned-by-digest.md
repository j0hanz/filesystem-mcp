# Plan 102: The Docker base image is pinned by digest and Dependabot proposes its updates

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- Dockerfile .github/dependabot.yml`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live files before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

The published container image is built `FROM node:24-alpine`, a tag that
moves. Two builds of the same release commit can produce different images,
and a changed base image reaches users without any review. Everything else in
the release path is pinned: GitHub Actions by commit SHA, npm packages by
lockfile. Dependabot keeps those pins fresh but is not configured for Docker,
so nothing would propose base-image security updates once the image is
pinned. This plan pins the base image by digest and adds the Dependabot
entry, so the pin does not rot.

## Current state

`Dockerfile` (two stages, both from the same tag):

```dockerfile
# ---- Builder Stage ----
FROM node:24-alpine AS builder
```

```dockerfile
# ---- Release Stage ----
FROM node:24-alpine
```

`.github/dependabot.yml` (complete):

```yaml
version: 2
updates:
  # One PR per week for all action bumps instead of one PR per action.
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 2
    cooldown:
      default-days: 7
    groups:
      actions:
        patterns: ['*']

  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 3
    cooldown:
      default-days: 7
    groups:
      # Patch and minor bumps land together; a major still gets its own PR
      # because it usually needs code changes.
      npm-minor-patch:
        update-types: [minor, patch]
    ignore:
      # ...
```

The release workflow builds the image for publication with
`docker/build-push-action`; a digest that names a multi-platform index works
for every platform that index lists.

## Commands you will need

| Purpose        | Command                                                                           | Expected on success                |
| -------------- | --------------------------------------------------------------------------------- | ---------------------------------- |
| Get the digest | `docker buildx imagetools inspect node:24-alpine --format "{{.Manifest.Digest}}"` | one line, `sha256:` + 64 hex chars |
| Build          | `docker build -t filesystem-mcp:pin-check .`                                      | exit 0                             |
| Smoke          | `docker run --rm filesystem-mcp:pin-check --version`                              | prints a version, exit 0           |
| Format         | `npx prettier --check .github/dependabot.yml`                                     | exit 0                             |

## Scope

**In scope** (the only files you should modify):

- `Dockerfile` (the two `FROM` lines only)
- `.github/dependabot.yml`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- Any other line of the `Dockerfile`.
- `.github/workflows/release.yml` and `.dockerignore`.
- Moving to a different base image or Node major.

## Git workflow

- Branch: `advisor/102-docker-base-image-pinned-by-digest`
- One commit: `build(docker): pin the base image by digest`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Read the current digest

Run:

```bash
docker buildx imagetools inspect node:24-alpine --format "{{.Manifest.Digest}}"
```

**Verify**: the output is one line matching `^sha256:[0-9a-f]{64}$`. Keep it;
below it is written `<DIGEST>`.

### Step 2: Pin both stages

In `Dockerfile`, change the two `FROM` lines to (same digest in both):

```dockerfile
FROM node:24-alpine@<DIGEST> AS builder
```

```dockerfile
FROM node:24-alpine@<DIGEST>
```

The tag stays in front of the digest: Docker uses the digest, and the tag
tells a reader and Dependabot which line of releases to follow.

**Verify**: `grep -c "^FROM node:24-alpine@sha256:[0-9a-f]\{64\}" Dockerfile`
→ `2`.

### Step 3: Build and run once

```bash
docker build -t filesystem-mcp:pin-check .
docker run --rm filesystem-mcp:pin-check --version
```

**Verify**: both exit 0 and the second prints a version number.

### Step 4: Tell Dependabot about Docker

In `.github/dependabot.yml`, append this entry after the `npm` entry (one
blank line before it, same indentation as the other entries):

```yaml
# The Dockerfile pins its base image by digest; this keeps the pin fresh.
- package-ecosystem: docker
  directory: /
  schedule:
    interval: weekly
  open-pull-requests-limit: 1
  cooldown:
    default-days: 7
```

**Verify**: `npx prettier --check .github/dependabot.yml` → exit 0;
`grep -c "package-ecosystem" .github/dependabot.yml` → `3`.

## Test plan

No automated test. Step 3 is the check that the pinned image builds and
starts.

## Done criteria

- [ ] `grep -c "^FROM node:24-alpine@sha256:" Dockerfile` returns 2
- [ ] `grep -c "package-ecosystem: docker" .github/dependabot.yml` returns 1
- [ ] `docker build -t filesystem-mcp:pin-check .` exits 0
- [ ] `npx prettier --check .` exits 0
- [ ] `git status --short` lists only `Dockerfile`, `.github/dependabot.yml`, `plans/README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `docker` or `docker buildx` is not available. Do not invent or copy a
  digest from anywhere else; a wrong digest breaks the release build.
- The digest command prints anything other than one `sha256:` line.
- `docker build` fails after the pin.
- `scripts/check-release-paths.sh` or a test parses the `FROM` lines
  (`grep -rn "alpine" scripts __tests__`); report what it expects.

## Maintenance notes

- Dependabot will now open a weekly PR when the `node:24-alpine` digest
  moves. Each one changes the published image, so it deserves the same review
  as an action bump.
- When the project moves to a new Node major, change the tag and the digest
  together.
- Reviewer: confirm the digest names a multi-platform index if the release
  workflow builds more than one platform
  (`docker buildx imagetools inspect node:24-alpine` lists the platforms).
