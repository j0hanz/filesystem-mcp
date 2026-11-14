# Plan 120: knip checks the shipped code from its real entry points

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- knip.json package.json .github/workflows/ci.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live files before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

knip finds unused files, exports and dependencies. Its configuration names
only the test files as entry points. So anything a test imports counts as
used, including a source file that nothing in the shipped server imports.
Proof that the shipped graph is not being checked: `npx knip --production`
reports all six runtime dependencies as unused, because in production mode
it finds no entry to start from. The clean `knip` run in CI is therefore
weak evidence. After this plan, knip also walks the graph from the two real
entry points, and CI fails on a source file or a runtime dependency that the
server does not use.

## Current state

`knip.json` (whole file):

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": ["__tests__/**/*.test.ts"],
  "project": ["src/**/*.ts", "__tests__/helpers.ts", "__tests__/tool-harness.ts"],
  "ignoreDependencies": ["@stryker-mutator/command-runner"]
}
```

`package.json`:

- `"bin": { "filesystem-mcp": "dist/index.js" }` → source entry `src/index.ts`
- `"exports": { "./transport": { "default": "./dist/transport.js" } }` → source entry `src/transport.ts`
- `"check:static": "npm run build && npm run type-check:test && npm run lint && prettier --check . && knip"`

`src/core/diff.ts:38,53` starts a worker thread from a file URL
(`const WORKER_URL = new URL(...)`, `new Worker(WORKER_URL)`), so
`src/core/diff-worker.ts` is reached at run time without an `import`.

`.github/workflows/ci.yml:62-64`:

```yaml
- name: Knip
  if: ${{ !cancelled() && steps.install.outcome == 'success' }}
  run: npx knip
```

The workflow comment at line 37-38 says the steps mirror `check:static` and
the two must stay in sync.

In knip's configuration a trailing `!` on a pattern marks it as a production
entry or project file.

## Commands you will need

| Purpose           | Command                                                            | Expected on success |
| :---------------- | :----------------------------------------------------------------- | :------------------ |
| Default run       | `npx knip --no-progress`                                           | no findings, exit 0 |
| Production run    | `npx knip --production --no-progress`                              | see steps           |
| Narrow production | `npx knip --production --include files,dependencies --no-progress` | no findings, exit 0 |
| Full check        | `npm run check`                                                    | exit 0              |

## Scope

**In scope**:

- `knip.json`
- `package.json` (`check:static` script only)
- `.github/workflows/ci.yml` (the `Knip` step only)
- `plans/120-knip-checks-the-production-graph.md` (append a "Findings" section)
- `plans/README.md`

**Out of scope**:

- Removing or un-exporting anything in `src/`. Exports used only by tests
  are a deliberate pattern here (unit tests import internals). This plan
  records them; it does not act on them.
- `ignoreDependencies` (the `@stryker-mutator/command-runner` entry is a
  known item, not this plan).

## Git workflow

- Branch: `chore/knip-production-entries`
- One commit: `chore(knip): check the shipped graph from its real entry points`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Record the baseline

**Verify**: `npx knip --production --no-progress` → lists
`@adguard/re2-wasm`, `@modelcontextprotocol/express`,
`@modelcontextprotocol/node`, `diff`, `express`, `ignore` as unused
dependencies (the symptom this plan fixes). If it lists none, STOP.

### Step 2: Add production entries

Change `knip.json` to:

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": [
    "src/index.ts!",
    "src/transport.ts!",
    "src/core/diff-worker.ts!",
    "__tests__/**/*.test.ts"
  ],
  "project": ["src/**/*.ts!", "__tests__/helpers.ts", "__tests__/tool-harness.ts"],
  "ignoreDependencies": ["@stryker-mutator/command-runner"]
}
```

**Verify**: `npx prettier --check knip.json` → exit 0.
**Verify**: `npx knip --no-progress` → no findings (the default run must
stay clean).

### Step 3: Read the production report

Run `npx knip --production --no-progress`. Expected: no unused
dependencies any more. It may list unused exports (things only tests use)
and possibly unused files.

- **Unused files** or **unused dependencies** reported: these are real
  findings. Do not delete anything. List them in "Findings" and STOP unless
  the list is empty.
- **Unused exports / types**: copy the list into a "Findings" section at the
  end of this plan file (symbol and file, one per line). No action.

**Verify**: `npx knip --production --include files,dependencies --no-progress` → no findings, exit 0.

### Step 4: Make the narrow production run part of the check

`package.json`, `check:static`: append
` && knip --production --include files,dependencies` after `knip`.

`.github/workflows/ci.yml`, the `Knip` step:

```yaml
run: |
  npx knip
  npx knip --production --include files,dependencies
```

**Verify**: `npm run check:static` → exit 0.
**Verify**: `npx prettier --check .github/workflows/ci.yml package.json` → exit 0.

## Test plan

No unit test. Proof that the new check bites: temporarily create
`src/core/unused-probe.ts` containing `export const probe = 1;`, run
`npx knip --production --include files,dependencies --no-progress`, confirm
it reports the file, then delete the probe file.

## Done criteria

- [ ] `npx knip --no-progress` and the narrow production run both exit 0
- [ ] The probe-file check in "Test plan" was done and the probe file is gone (`git status` clean of it)
- [ ] This plan file has a "Findings" section (possibly "none")
- [ ] `git diff --stat` lists only in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

- Step 3 reports an unused file or runtime dependency. That is a real
  finding for the maintainer; report it with the knip output.
- knip 6 rejects the `!` suffix or the `--include` flag (check
  `npx knip --help`); report the version (`npx knip --version`).
- The default run stops being clean after Step 2.

## Maintenance notes

- A new worker, bin or package export needs an entry in `knip.json`.
- Unused **exports** in production mode are not enforced on purpose. If the
  team later wants test-only exports marked, knip supports a `@internal`
  JSDoc tag; that is a separate decision.
