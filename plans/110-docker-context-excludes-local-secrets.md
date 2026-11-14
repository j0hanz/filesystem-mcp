# Plan 110: The Docker build context leaves local secret files out

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- .dockerignore Dockerfile .gitignore`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

A developer's working tree holds files that Git ignores but Docker does not:
registry auth token files (`.mcpregistry_*`), `.env` files, local agent
settings and other worktrees. `docker build .` sends everything not listed in
`.dockerignore` to the builder as build context. The `Dockerfile` copies only
named paths today, so the image is clean, but the context still reaches a
local or remote builder, and one future `COPY . .` would bake credentials
into a layer. `scripts/check-release-paths.sh` runs `docker build .` from the
developer's own tree.

Never print, open or copy the contents of `.mcpregistry_*` or `.env*` files
while working on this plan.

## Current state

`.dockerignore` (whole file, 13 lines):

```text
node_modules
dist
.git
.github
__tests__
docs
*.md
!README.md
Dockerfile
.dockerignore
eslint.config.mjs
knip.json
.prettierrc*
```

`Dockerfile` copies only these paths:

```text
COPY package.json package-lock.json ./
COPY src/ ./src/
COPY tsconfig.json ./
COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/package.json ./
```

`.gitignore` already lists `.env`, `.env.local`, `.env.*.local`,
`.mcpregistry_*`, `.mcp.json`, `.worktrees/`, `reports/`, `*.mcpb`.

## Commands you will need

| Purpose      | Command                             | Expected on success                  |
| :----------- | :---------------------------------- | :----------------------------------- |
| Format check | `npx prettier --check .`            | exit 0                               |
| Docker build | `docker build -t fsmcp-ctx-check .` | exit 0 (only if Docker is installed) |

## Scope

**In scope**:

- `.dockerignore`
- `plans/README.md`

**Out of scope**:

- `Dockerfile` (plan 102 owns the base-image pin; do not touch it here).
- `.gitignore`.
- Any file named `.mcpregistry_*` or `.env*`.

## Git workflow

- Branch: `chore/dockerignore-allowlist`
- One commit: `build(docker): send only the files the image needs as build context`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Switch `.dockerignore` to an allowlist

Replace the whole file with:

```text
# Allowlist: everything is excluded, then the paths the Dockerfile copies.
# A new COPY source must be added here, or the build fails loudly.
*
!package.json
!package-lock.json
!tsconfig.json
!src/
```

An allowlist cannot fall behind `.gitignore` the way a denylist does.

**Verify**: `grep -c "" .dockerignore` → `7`.

### Step 2: Confirm every COPY source is allowed

**Verify**: `grep -n "^COPY [^-]" Dockerfile` → every source path printed is
one of `package.json`, `package-lock.json`, `src/`, `tsconfig.json`. If the
list differs, add the missing source to the allowlist with a `!` line.

### Step 3: Build the image when Docker is installed

Run `docker --version`. If it fails, skip this step and say so in your
report (CI's "Release build paths" job builds the image and will catch a
broken context).

**Verify**: `docker build -t fsmcp-ctx-check .` → exit 0. Then
`docker image rm fsmcp-ctx-check`.

### Step 4: Format

**Verify**: `npx prettier --check .` → exit 0 (`.dockerignore` is not a
Prettier-formatted type; this only confirms nothing else moved).

## Test plan

No unit test. The image build in CI (`Release build paths`, which runs
`bash scripts/check-release-paths.sh`) is the regression check: a missing
allowlist entry fails the `COPY`.

## Done criteria

- [ ] `.dockerignore` starts with the `*` rule followed by `!` entries
- [ ] Step 2's grep shows no COPY source outside the allowlist
- [ ] `git diff --stat` lists only `.dockerignore` and `plans/README.md`
- [ ] `plans/README.md` status row updated, noting whether Step 3 ran

## STOP conditions

- The `Dockerfile` has a `COPY . .` or copies a path not shown in "Current
  state".
- `scripts/check-release-paths.sh` or `scripts/pack-mcpb.sh` builds an image
  with a context other than the repository root.

## Maintenance notes

- Anyone adding a `COPY` to the `Dockerfile` must add the source here.
- Plan 102 (base image pinned by digest) edits the `Dockerfile` only and does
  not conflict.
