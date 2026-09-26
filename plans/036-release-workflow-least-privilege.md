# Plan 036: The release workflow grants each job only the permission it uses, runs installs without lifecycle scripts, and pins the registry publisher

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- .github/workflows/release.yml`
> If the file changed, compare the "Current state" excerpts against the live
> file before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (the next release run is the real test; see Done criteria)
- **Depends on**: none — run **before** plan 037 (same file)
- **Category**: security (supply chain)
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

`release.yml` sets `contents: write`, `id-token: write` and
`packages: write` at the **workflow** level, so every job inherits all three.
The `release` job runs `npm ci` and the full `npm run check` — the entire dev
toolchain and test suite — while holding a token that can push to `main` and
mint OIDC identities for npm trusted publishing. The `publish-mcp` job
downloads `mcp-publisher` from `releases/latest` with `curl | tar`, verifies
nothing, and runs it with `id-token: write`. A compromised dev dependency or
a hijacked publisher release could publish a tampered package under this
project's name.

Three changes, each standard practice:

1. Top-level `permissions: contents: read`; each job declares what it needs.
2. `npm ci --ignore-scripts` everywhere the workflow installs. The Dockerfile
   (`Dockerfile:8`) and the MCPB packer (`scripts/pack-mcpb.sh:15`) already
   install this way and build fine, so no dependency needs a lifecycle
   script.
3. Pin `mcp-publisher` to a tagged release and verify its SHA-256 before
   running it.

Not done here: SHA-pinning the `actions/*` and `docker/*` steps. Without
Dependabot (rejected earlier because it fights the exact `@modelcontextprotocol/*`
pins) SHA pins rot silently; tag pins stay. Recorded in maintenance notes.

## Current state

```yaml
# .github/workflows/release.yml:20-23
permissions:
  contents: write
  id-token: write
  packages: write
```

Jobs and what each actually needs:

| Job              | Lines   | Uses                                                      | Needs                               |
| ---------------- | ------- | --------------------------------------------------------- | ----------------------------------- |
| `release`        | 34–138  | `git push origin main --follow-tags`, `gh release create` | `contents: write`                   |
| `publish-npm`    | 143–184 | `npm publish --provenance`                                | `contents: read`, `id-token: write` |
| `publish-docker` | 189–240 | `docker/login-action` with `GITHUB_TOKEN`, push to GHCR   | `contents: read`, `packages: write` |
| `publish-mcp`    | 245–275 | `mcp-publisher login github-oidc`                         | `contents: read`, `id-token: write` |
| `publish-mcpb`   | 280–321 | `gh release upload` (already declares `contents: write`)  | as declared                         |

```yaml
# .github/workflows/release.yml:120-123
- name: Install & validate
  run: |
    npm ci
    npm run check

# .github/workflows/release.yml:160-163
- name: Install & build
  run: |
    npm ci
    npm run build

# .github/workflows/release.yml:299-302
- name: Pack
  run: |
    npm ci
    bash scripts/pack-mcpb.sh
```

```yaml
# .github/workflows/release.yml:257-266
- name: Publish
  run: |
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    curl -fsSL "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${OS}_${ARCH}.tar.gz" \
      | tar xz mcp-publisher
    chmod +x mcp-publisher
    ./mcp-publisher login github-oidc
    ./mcp-publisher publish
```

`scripts/pack-mcpb.sh:15` runs `npm ci --omit=dev --ignore-scripts` and
`Dockerfile:8` runs `npm ci --ignore-scripts`; `package.json` has no
`prepare`/`postinstall` script (`grep -n '"prepare"\|"postinstall"' package.json`
prints nothing).

## Commands you will need

| Purpose             | Command                                                                           | Expected on success           |
| ------------------- | --------------------------------------------------------------------------------- | ----------------------------- |
| YAML formatting     | `npx prettier --check .github/workflows/release.yml`                              | exit 0                        |
| Resolve publisher   | `gh release view --repo modelcontextprotocol/registry --json tagName -q .tagName` | prints a tag such as `v1.x.y` |
| Local install proof | `npm ci --ignore-scripts && npm run build`                                        | exit 0 (in your worktree)     |
| Full check          | `npm run check`                                                                   | exit 0                        |

`gh` must be authenticated (`gh auth status`). No test-suite change.

## Scope

**In scope** (the only files you should modify):

- `.github/workflows/release.yml`
- `plans/README.md` (status row)

**Out of scope**: `ci.yml` (plan 037 adds a job there); `Dockerfile`,
`scripts/*`; action version tags; the version-bump logic; Smithery
publishing.

## Git workflow

- Branch: `advisor/036-release-workflow-least-privilege`.
- One commit: `ci(release): least-privilege job permissions, --ignore-scripts, pinned mcp-publisher`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it. Do NOT dispatch
  the Release workflow.

## Steps

### Step 1: Permissions per job

1. Replace lines 20–23 with:

   ```yaml
   # Least privilege: each job below declares what it needs.
   permissions:
     contents: read
   ```

2. In the `release` job (after `timeout-minutes: 15`, before `outputs:`) add:

   ```yaml
   permissions:
     contents: write
   ```

3. In `publish-npm` (after `timeout-minutes: 10`) add:

   ```yaml
   permissions:
     contents: read
     id-token: write
   ```

4. In `publish-docker` (after `timeout-minutes: 30`) add:

   ```yaml
   permissions:
     contents: read
     packages: write
   ```

5. In `publish-mcp` (after `timeout-minutes: 10`) add:

   ```yaml
   permissions:
     contents: read
     id-token: write
   ```

6. `publish-mcpb` already has `permissions: contents: write`; leave it.

### Step 2: No lifecycle scripts on install

Change the three `npm ci` lines (release: 122, publish-npm: 162, publish-mcpb: 301) to `npm ci --ignore-scripts`.

**Verify (local proof)**: in your worktree run
`npm ci --ignore-scripts && npm run build` → exit 0.

### Step 3: Pin and verify `mcp-publisher`

1. Resolve the current release tag:
   `gh release view --repo modelcontextprotocol/registry --json tagName -q .tagName`
   → `<TAG>`.
2. Download the Linux amd64 asset and compute its digest:

   ```bash
   curl -fsSL -o /tmp/mcp-publisher.tar.gz \
     "https://github.com/modelcontextprotocol/registry/releases/download/<TAG>/mcp-publisher_linux_amd64.tar.gz"
   sha256sum /tmp/mcp-publisher.tar.gz
   ```

   (On Windows Git Bash `sha256sum` exists; PowerShell:
   `Get-FileHash -Algorithm SHA256`.) If the release publishes a checksums
   file, compare against it and prefer that value.

3. Replace the `Publish` step body (lines 258–266) with:

   ```yaml
   - name: Publish
     env:
       MCP_PUBLISHER_VERSION: <TAG>
       MCP_PUBLISHER_SHA256: <hex digest from step 2>
     run: |
       # Pinned + verified: this job holds id-token:write, so an unreviewed
       # "latest" binary must never run here. Bump the two env values together.
       curl -fsSL -o mcp-publisher.tar.gz \
         "https://github.com/modelcontextprotocol/registry/releases/download/${MCP_PUBLISHER_VERSION}/mcp-publisher_linux_amd64.tar.gz"
       echo "${MCP_PUBLISHER_SHA256}  mcp-publisher.tar.gz" | sha256sum -c -
       tar xzf mcp-publisher.tar.gz mcp-publisher
       chmod +x mcp-publisher
       ./mcp-publisher login github-oidc
       ./mcp-publisher publish
   ```

   `ubuntu-latest` is x86-64, so the `uname` dance is gone on purpose.

Run `npx prettier --write .github/workflows/release.yml`.

**Verify**: `npx prettier --check .github/workflows/release.yml` → exit 0;
`grep -c "ignore-scripts" .github/workflows/release.yml` → `3`;
`grep -n "releases/latest" .github/workflows/release.yml` → nothing;
`grep -n "^permissions:" -A 1 .github/workflows/release.yml` → `contents: read`.

### Step 4: Full gate

**Verify**: `npm run check` → exit 0 (the workflow file is prettier-checked
as part of it).

## Test plan

- No unit tests apply. The verification is static (greps above) plus the
  local `--ignore-scripts` build proof.
- The first real Release dispatch after this lands is the end-to-end test:
  every job must reach its "Summary" step. Whoever runs it should watch the
  `MCP Registry` job's checksum line.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] Top-level `permissions:` is exactly `contents: read`; five jobs declare
      their own block (`grep -c "permissions:" .github/workflows/release.yml` → `6`)
- [ ] `grep -c "ignore-scripts" .github/workflows/release.yml` → `3`
- [ ] `grep -n "sha256sum -c" .github/workflows/release.yml` → one line
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 036 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `npm ci --ignore-scripts && npm run build` fails locally (a dependency
  needs a lifecycle script after all — report which).
- The registry release has no `mcp-publisher_linux_amd64.tar.gz` asset or
  `gh` cannot reach it — do not guess a URL or a digest.
- Any job's steps use a permission not listed in the table above (a step
  added since `8c2a82cd`) — report it rather than widening the block.

## Maintenance notes

- Bumping `mcp-publisher` is now a two-value edit (`MCP_PUBLISHER_VERSION`,
  `MCP_PUBLISHER_SHA256`). A failed `sha256sum -c` means the asset changed
  under the same tag — treat as an incident, not a typo.
- Deferred: SHA-pinning `actions/checkout`, `actions/setup-node`, `docker/*`.
  Reasonable once an automated bumper exists; hand-maintained SHA pins tend
  to freeze on a vulnerable version.
- Reviewer focus: `publish-npm` keeps `id-token: write` (provenance) and
  nothing else; `release` keeps `contents: write` and nothing else.
