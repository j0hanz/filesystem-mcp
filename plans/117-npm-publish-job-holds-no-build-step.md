# Plan 117: The job that can publish to npm runs no install and no build

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- .github/workflows/release.yml`
> If the file changed since this plan was written, compare the "Current
> state" excerpts against the live file before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (the release workflow cannot be run end to end before merging)
- **Depends on**: none. Plan 118 edits the same file; do them one at a time.
- **Category**: security
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

npm publishing uses Trusted Publishing: the `publish-npm` job has
`id-token: write`, and any step in that job can mint the token that
authorizes a publish. Today the same job runs `npm ci` and `npm run build`,
which execute the whole dev-dependency toolchain (compiler and its
transitive packages). A compromised dev dependency would run with the
publish credential in reach. Splitting the job so that the credentialed part
only uploads an already-built tarball removes that exposure. The same
reasoning applies to checkouts that leave a Git credential on disk.

## Current state

`.github/workflows/release.yml:205-238`:

```yaml
publish-npm:
  name: npm
  needs: release
  runs-on: ubuntu-latest
  timeout-minutes: 10
  permissions:
    contents: read
    id-token: write
  env:
    VERSION: ${{ needs.release.outputs.version }}
  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      with:
        ref: v${{ needs.release.outputs.version }}

    - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
      with:
        node-version-file: .nvmrc
        registry-url: 'https://registry.npmjs.org'

    - name: Install & build
      run: |
        npm ci --ignore-scripts
        npm run build

    - name: Publish
      run: |
        npm publish --access public --provenance --ignore-scripts || {
          if npm view "@j0hanz/filesystem-mcp@$VERSION" version 2>/dev/null; then
            echo "::notice::v$VERSION already on npm — skipped"
          else
            exit 1
          fi
        }
```

A `Summary` step follows. Other jobs that need `publish-npm`:
`publish-mcp` has `needs: [release, publish-npm, publish-docker]`.

Checkouts without `persist-credentials: false`: `publish-npm` (line 216),
`publish-docker` (line 263), `publish-mcp` (line 324). The `release` job
(line 44-49) and `publish-mcpb` (line 366-369) already set it.

Repo conventions for workflows: every action is pinned to a full commit SHA
with the version in a trailing comment; each job declares its own
`permissions`. No workflow in the repo uses `actions/upload-artifact` or
`actions/download-artifact` yet.

`package.json` `"files": ["dist", "README.md"]`, so `npm pack` after a build
produces the publishable tarball.

## Commands you will need

| Purpose       | Command                                                                    | Expected on success                 |
| :------------ | :------------------------------------------------------------------------- | :---------------------------------- |
| YAML/format   | `npx prettier --check .github/workflows/release.yml`                       | exit 0                              |
| Pack locally  | `npm run build && npm pack --dry-run`                                      | lists `dist/` files and `README.md` |
| Resolve a SHA | `gh api repos/actions/upload-artifact/git/ref/tags/<tag> --jq .object.sha` | a 40-char SHA                       |

## Scope

**In scope**:

- `.github/workflows/release.yml` (jobs `publish-npm`, plus a new job
  `build-npm`; the three `persist-credentials` lines)
- `plans/README.md`

**Out of scope**:

- The `release` job, `publish-docker`'s build steps, `publish-mcp`'s publish
  step, `publish-mcpb`.
- Attestations for the Docker image and the `.mcpb` file (worth doing, a
  separate plan).
- `ci.yml`, `scorecard.yml`, `tdqs.yml`.

## Git workflow

- Branch: `ci/npm-publish-split`
- One commit: `ci(release): build the npm tarball in a job without the publish token`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Resolve pinned SHAs for the artifact actions

Find the latest release tag of each action and its commit SHA:

```bash
gh api repos/actions/upload-artifact/releases/latest --jq .tag_name
gh api repos/actions/upload-artifact/git/ref/tags/<tag> --jq '.object.sha, .object.type'
gh api repos/actions/download-artifact/releases/latest --jq .tag_name
gh api repos/actions/download-artifact/git/ref/tags/<tag> --jq '.object.sha, .object.type'
```

If `.object.type` is `tag` (an annotated tag), resolve it to the commit:
`gh api repos/actions/<name>/git/tags/<sha> --jq .object.sha`.

**Verify**: you hold two 40-character commit SHAs and their version tags.

### Step 2: Add `build-npm`

Insert before `publish-npm`:

```yaml
# ─────────────────────────────────────────
# 2a. Build the npm tarball (no publish token in this job)
# ─────────────────────────────────────────
build-npm:
  name: npm tarball
  needs: release
  runs-on: ubuntu-latest
  timeout-minutes: 10
  permissions:
    contents: read
  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      with:
        ref: v${{ needs.release.outputs.version }}
        persist-credentials: false

    - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
      with:
        node-version-file: .nvmrc

    - name: Install, build & pack
      run: |
        npm ci --ignore-scripts
        npm run build
        npm pack --ignore-scripts

    - uses: actions/upload-artifact@<SHA> # <tag>
      with:
        name: npm-tarball
        path: '*.tgz'
        if-no-files-found: error
        retention-days: 1
```

### Step 3: Reduce `publish-npm` to download and publish

- `needs: [release, build-npm]`.
- Remove the checkout step and the `Install & build` step.
- Keep `setup-node` with `registry-url`, but replace `node-version-file: .nvmrc`
  (there is no checkout now) with a literal `node-version: '26'` and a
  comment `# Matches .nvmrc; no checkout in this job.`
- Add before `Publish`:

```yaml
- uses: actions/download-artifact@<SHA> # <tag>
  with:
    name: npm-tarball
```

- Change the publish command to publish the tarball:

```yaml
- name: Publish
  run: |
    tarball=$(ls ./*.tgz)
    npm publish "$tarball" --access public --provenance --ignore-scripts || {
```

and leave the fallback block unchanged.

- Leave the `Summary` step unchanged.

### Step 4: `persist-credentials: false` on the remaining checkouts

Add `persist-credentials: false` under `with:` for the checkouts in
`publish-docker` and `publish-mcp`.

**Verify**: `grep -c "persist-credentials: false" .github/workflows/release.yml`
→ `5` (release, build-npm, publish-docker, publish-mcp, publish-mcpb).

### Step 5: Checks

**Verify**: `npx prettier --check .github/workflows/release.yml` → exit 0.
**Verify**: the block between `publish-npm:` and the next job header contains
no `npm ci`, no `npm run build`, no `actions/checkout`:

```bash
awk '/^  publish-npm:/{f=1;next} /^  publish-docker:/{f=0} f' .github/workflows/release.yml | grep -n "npm ci\|npm run build\|actions/checkout"
```

→ prints nothing.
**Verify**: `npm run build && npm pack --dry-run` → the file list contains
`dist/index.js` and `README.md`. Delete any `.tgz` it created (dry run
creates none).

## Test plan

There is no way to run the release workflow before merge. The checks above
plus review are the gate. The first real release after this lands is the
test; see Maintenance notes.

## Done criteria

- [ ] All Step 5 verifications pass
- [ ] Both new actions are pinned by 40-character SHA with a version comment
- [ ] `git diff --stat` lists only `.github/workflows/release.yml` and `plans/README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

- `gh` is not authenticated or cannot reach the API, so the SHAs cannot be
  resolved. Do not guess a SHA and do not use a tag reference.
- The npm Trusted Publisher configuration for this package is restricted to
  a job name or environment. You cannot see it from the repo; state in your
  report that the maintainer must confirm the npmjs.com trusted-publisher
  entry names the workflow file `release.yml` and no specific job.
- `npm pack` output differs from what `npm publish` would send (for example a
  `prepack` script exists in `package.json`).

## Maintenance notes

- npm provenance is generated at publish time from the OIDC token and
  records the workflow, so publishing a pre-built tarball keeps provenance.
- If the first release fails at `publish-npm`, the fallback is to re-run
  that job after fixing; the tag and GitHub release already exist by then
  (see plan 118 for making the whole workflow resumable).
- Follow-up not planned here: `actions/attest-build-provenance` for the
  Docker image and the `.mcpb` asset.
