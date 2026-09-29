# Plan 041: `--root-boundary` constrains every allowed root, not only grants

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 4d751c94..HEAD -- src/core/path.ts src/cli-help.ts README.md __tests__/path-guard-grant.test.ts __tests__/stdio.test.ts CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED — a misconfigured deployment that today has access to a root
  outside its boundary loses that access (this is the documented contract).
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `4d751c94`, 2026-09-28

## Why this matters

The CLI help, the README and `src/instructions.ts` all promise that
`--root-boundary <path>` / `FS_ROOT_BOUNDARY` "require all allowed roots to
fall under this path". The implementation applies the boundary only to roots
added at runtime through the access-grant round-trip (and, on the legacy stdio
leg, to client-declared roots). The three startup sources — positional
directories, `FS_ALLOWED_DIRS`, and `--allow-cwd` — are placed in the allowed
set unfiltered. An operator who sets `FS_ROOT_BOUNDARY=/srv/projects` on a
container and also passes `--allow-cwd` from `/home/app` gets `/home/app` as a
live root, contrary to what every document says. After this plan, a startup
root outside the boundary is skipped with a `warning` log line naming both
paths, the same way an unsafe `--allow-cwd` directory is skipped today, and a
test pins each of the three sources.

## Current state

- `src/core/path.ts` — `PathGuard`, the security boundary. Its
  `recomputeAllowedDirectories()` (lines 780–828) assembles the allowed set.
- `src/cli-help.ts:44-46` — the flag text: `Require all allowed roots to fall under this path (env: FS_ROOT_BOUNDARY)`.
- `README.md` — CLI-flag table row `--root-boundary <path>` and env row
  `FS_ROOT_BOUNDARY` say the same.
- `__tests__/path-guard-grant.test.ts` — the existing tests for the boundary
  (grants only), with the `beforeEach`/`afterEach` env save/restore pattern.
- `__tests__/stdio.test.ts` — `STDIO-CLI-002` boots the real binary with
  `--root-boundary` and checks a traversal is refused.

Live code at `src/core/path.ts:806-828` (the assembly):

```ts
    const baseline = [...cliAllowedDirs, ...envAllowedDirs, ...allowCwdDirs];

    const signal = AbortSignal.timeout(ROOTS_TIMEOUT_MS);
    // FS_ROOT_BOUNDARY is the only filter grants answer to (see
    // `grantedDirectories`); without one they pass through as accepted.
    const grantsToInclude =
      boundaries.length > 0
        ? await filterRootsWithin(this.grantedDirectories, boundaries, signal)
        : this.grantedDirectories;

    const combined = [...baseline, ...grantsToInclude];
    const nextState = await resolveAllowedDirectoriesState(combined, signal);
    // Commit boundaries and the allowed set together, after every await has
    // resolved, so a rejecting recompute leaves the guard's previous,
    // consistent view intact.
    this.rootBoundaries = boundaries;
    this.initialize(nextState, combined);
  }
```

`baseline` is never filtered. The helpers that already exist at
`src/core/path.ts:51-88`:

```ts
/** True when `normalizedRoot` really resolves inside `bounds` (FS_ROOT_BOUNDARY). */
async function isRootWithin(
  normalizedRoot: string,
  bounds: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    signal?.throwIfAborted();
    const realPath = await withAbort(realpath(normalizedRoot), signal);
    return isPathWithinDirectories(normalizePath(realPath), bounds);
  } catch (error) {
    rethrowIfAborted(error);
    if (isNotFoundErrno(error)) {
      return false;
    }
    Logger.warn('grantBoundary: realpath failed unexpectedly', { ... });
    return false;
  }
}

async function filterRootsWithin(
  roots: readonly string[],
  bounds: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const normalizedBounds = normalizeAllowedDirectories(bounds);
  const normalizedRoots = roots.map(normalizePath);
  const results = await Promise.all(
    normalizedRoots.map((root) => isRootWithin(root, normalizedBounds, signal)),
  );
  return normalizedRoots.filter((_, i) => results[i]);
}
```

The precedent for "skip a startup root and say so" is the unsafe-cwd branch a
few lines above, `src/core/path.ts:799-805`:

```ts
if (isUnsafeCwdPath(cwd)) {
  Logger.emit('warning', `Skipped adding unsafe current working directory to allowed list: ${cwd}`);
} else {
  allowCwdDirs.push(cwd);
}
```

One subtlety: `isRootWithin` returns `false` on `ENOENT`. Startup roots may
legitimately not exist when `--allow-missing-roots` / `FS_ALLOW_MISSING_ROOTS`
is set (`resolveConfiguredDirs('FS_ALLOWED_DIRS', { allowMissing })` at
`path.ts:785`). A missing root must not be dropped by the boundary filter
merely because it cannot be realpath'd; for a missing root the lexical check
(`isPathWithinDirectories(normalizedRoot, bounds)`) is the only one available
and is what this plan uses. Containment at access time still realpaths every
path (`validateExistingPathDetailed`, `path.ts:525-552`), so nothing is lost.

Conventions to match: `Logger.emit('warning', …)` for operator-facing startup
warnings (see the excerpt above); `normalizePath` / `isPathWithinDirectories`
from `./path-utils.ts`; tests use `assert` from `node:assert/strict`,
`describe`/`it` from `node:test`, IDs like `TC-PG-0NN`.

## Commands you will need

| Purpose           | Command                                              | Expected on success |
| ----------------- | ---------------------------------------------------- | ------------------- |
| Build + typecheck | `npm run build && npm run type-check:test`           | exit 0              |
| Targeted tests    | `npm test -- --test-name-pattern="TC-PG\|STDIO-CLI"` | all pass            |
| Full static check | `npm run check:static`                               | exit 0              |
| Full check        | `npm run check`                                      | exit 0; 0 fail      |
| Format plans      | `npx prettier --write plans/README.md`               | exit 0              |

Baseline at planning time: `npm test` → 450 tests, 447 pass, 3 platform skips,
0 fail.

## Scope

**In scope** (the only files you should modify):

- `src/core/path.ts` — `recomputeAllowedDirectories` and one new private helper
- `__tests__/path-guard-grant.test.ts` — three new tests
- `__tests__/stdio.test.ts` — one new end-to-end test
- `README.md` — one sentence in "Configuration" (see step 4)
- `CHANGELOG.md` — one `### Fixed` bullet under `## [Unreleased]`
- `plans/README.md` — status row

**Out of scope** (do NOT touch, even though they look related):

- `applyGrant` / `precheckAccess` / `grantedDirectories` in `path.ts` — the
  grant path already honors the boundary and is pinned by TC-PG-002/003.
- `src/transport/stdio.ts` `seedRootsFromClient` — legacy roots already pass
  `applyGrant`, which enforces the boundary.
- `src/cli.ts`, `src/cli-help.ts` — the help text is already correct.
- `isUnsafeCwdPath` and the unsafe-path denylist.
- Any version field (`package.json`, `server.json`, `mcpb/manifest.json`).

## Git workflow

- Branch: `advisor/041-root-boundary-startup-roots`
- Commit per step; free-form messages in the repo's style, e.g.
  `fix(path): apply FS_ROOT_BOUNDARY to startup roots, not only grants`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing unit tests

In `__tests__/path-guard-grant.test.ts`, inside the existing
`describe('PathGuard grant round-trip', …)` block (it already saves and
restores `FS_ROOT_BOUNDARY` in `beforeEach`/`afterEach`), append after
`TC-PG-011`:

- **TC-PG-012**: `process.env['FS_ROOT_BOUNDARY'] = root;` create
  `outside = await mkDir(createdDirs, 'fsmcp-pg012-')`; build
  `new PathGuard({ cliAllowedDirs: [root, outside] })`, call
  `recomputeAllowedDirectories()`. Assert `containsPath(guard.getRoots(), root)`
  is true and `containsPath(guard.getRoots(), outside)` is false. Write a file
  in `outside` with `writeTestFile(outside, 'f.txt', 'x')` and assert
  `guard.validateExistingPath(<that file>)` rejects with
  `fsErrorMatcher(ErrorCode.ACCESS_DENIED)`.
- **TC-PG-013**: same shape, but the outside root arrives via
  `FS_ALLOWED_DIRS`: wrap the guard construction in
  `withEnv({ FS_ALLOWED_DIRS: outside }, async () => { … })` (import `withEnv`
  from `./helpers.ts`) with `cliAllowedDirs: [root]`. Same assertions.
- **TC-PG-014**: a **missing** root inside the boundary survives:
  `process.env['FS_ROOT_BOUNDARY'] = root;` `const missing = join(root, 'not-yet');`
  `withEnv({ FS_ALLOW_MISSING_ROOTS: '1' }, …)` with
  `new PathGuard({ cliAllowedDirs: [root, missing] })`. Assert
  `containsPath(guard.getRoots(), missing)` is true. (This pins the ENOENT
  fallback so the fix cannot over-filter.)

**Verify**: `npm test -- --test-name-pattern="TC-PG-01[234]"` → TC-PG-012 and
TC-PG-013 **fail** (outside root present), TC-PG-014 passes.

### Step 2: Filter the baseline in `recomputeAllowedDirectories`

In `src/core/path.ts`, add a private module-level helper next to
`filterRootsWithin` (after line 88):

```ts
/**
 * Startup roots must fall under FS_ROOT_BOUNDARY like every other root. An
 * existing root must *resolve* inside the boundary; a root that does not exist
 * yet (allowed by FS_ALLOW_MISSING_ROOTS) can only be checked lexically, and
 * access-time validation realpaths every path under it anyway.
 */
async function partitionStartupRoots(
  roots: readonly string[],
  bounds: readonly string[],
  signal?: AbortSignal,
): Promise<{ kept: string[]; dropped: string[] }> {
  const normalizedBounds = normalizeAllowedDirectories(bounds);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const root of roots.map(normalizePath)) {
    let inside: boolean;
    try {
      signal?.throwIfAborted();
      const realPath = await withAbort(realpath(root), signal);
      inside = isPathWithinDirectories(normalizePath(realPath), normalizedBounds);
    } catch (error) {
      rethrowIfAborted(error);
      inside = isNotFoundErrno(error) && isPathWithinDirectories(root, normalizedBounds);
    }
    (inside ? kept : dropped).push(root);
  }
  return { kept, dropped };
}
```

Then change the assembly (`path.ts:806-828`) so `baseline` is filtered when a
boundary is configured, with a warning per dropped root, and move the
`signal` declaration above its first use:

```ts
const signal = AbortSignal.timeout(ROOTS_TIMEOUT_MS);
let baseline = [...cliAllowedDirs, ...envAllowedDirs, ...allowCwdDirs];
if (boundaries.length > 0) {
  const { kept, dropped } = await partitionStartupRoots(baseline, boundaries, signal);
  for (const root of dropped) {
    Logger.emit(
      'warning',
      `Skipped allowed root outside FS_ROOT_BOUNDARY (${boundaries.join(', ')}): ${root}`,
    );
  }
  baseline = kept;
}
```

Keep the grants filter and everything after it unchanged. `realpath`,
`withAbort`, `rethrowIfAborted`, `isNotFoundErrno`, `normalizePath`,
`isPathWithinDirectories`, `normalizeAllowedDirectories` are all already
imported in this file (they are used by `isRootWithin` / `filterRootsWithin`).

**Verify**: `npm run build && npm run type-check:test` → exit 0;
`npm test -- --test-name-pattern="TC-PG"` → all TC-PG tests pass, including
012–014.

### Step 3: End-to-end test through the real binary

In `__tests__/stdio.test.ts`, inside
`describe('Stdio CLI flags (real subprocess)', …)` (line 169; it contains
`STDIO-CLI-001` and `STDIO-CLI-002` and owns a `tmpDir` created in `before`),
add after `STDIO-CLI-002`:

```ts
it('STDIO-CLI-003: --root-boundary drops a positional root outside the boundary', async () => {
  const outside = await createTestRoot();
  const harness = await createStdioClient(tmpDir, {}, ['--root-boundary', tmpDir, outside]);
  try {
    const roots = await harness.client.callTool({ name: 'list_roots', arguments: {} });
    const listed = (roots.structuredContent as { roots: string[] }).roots;
    assert.ok(
      listed.some((r) => r.toLowerCase() === tmpDir.toLowerCase()),
      'in-boundary root stays',
    );
    assert.ok(
      !listed.some((r) => r.toLowerCase() === outside.toLowerCase()),
      'outside root is dropped',
    );
  } finally {
    await harness.close();
    await cleanupTestRoot(outside);
  }
});
```

(`createStdioClient` puts `cliFlags` before the positional `tmpDir`, so both
roots are positionals; only `tmpDir` is inside the boundary.) On Windows the
runner's `tmpdir()` can be an 8.3 alias, so compare case-insensitively as
shown; if the assertion still fails only on Windows because of path aliasing,
compare with `isSamePath` from `../src/core/path-utils.ts` instead.

**Verify**: `npm test -- --test-name-pattern="STDIO-CLI"` → all pass.

### Step 4: Documentation

- `README.md`, section "## Configuration", after the numbered list of root
  sources, add one sentence: `When --root-boundary / FS_ROOT_BOUNDARY is set, a configured root that does not fall under it is skipped at startup with a warning; only roots under the boundary (and later grants under it) are allowed.`
- `CHANGELOG.md`: if there is no `## [Unreleased]` heading above
  `## [2.6.3]`, add one; under it add `### Fixed` with a bullet:
  `**`--root-boundary`now applies to startup roots.** Positional directories,`FS_ALLOWED_DIRS`and`--allow-cwd` roots outside the boundary are skipped with a warning instead of being allowed; previously only access grants were checked.`

**Verify**: `npx prettier --check README.md CHANGELOG.md` → exit 0.

### Step 5: Full check

**Verify**: `npm run check` → exit 0, `fail 0`, `pass` ≥ 451.

## Test plan

- New: TC-PG-012 (positional root outside boundary dropped), TC-PG-013
  (`FS_ALLOWED_DIRS` root outside boundary dropped), TC-PG-014 (missing root
  inside boundary kept under `FS_ALLOW_MISSING_ROOTS`), STDIO-CLI-003 (real
  binary; `list_roots` omits the outside root).
- Pattern: TC-PG-002/003 in the same file (env pin, `new PathGuard(...)`,
  `recomputeAllowedDirectories()`, `getRoots()` / `containsPath`).
- Existing tests that must keep passing unchanged: TC-PG-002, TC-PG-003,
  TC-PG-005 (grant with no boundary), TC-PG-011, STDIO-CLI-002,
  `http-shared-guard.test.ts` and `subscriptions-listen.test.ts` (both boot
  with `FS_ROOT_BOUNDARY: tmpdir()` and roots under it — they exercise the new
  filter's "kept" path).

## Done criteria

- [ ] `npm run check` exits 0
- [ ] TC-PG-012, TC-PG-013, TC-PG-014, STDIO-CLI-003 exist and pass
- [ ] `git stash` of `src/core/path.ts` alone (revert the fix, keep tests)
      makes TC-PG-012 and TC-PG-013 fail; `git stash pop` restores green
- [ ] `grep -n "Skipped allowed root outside FS_ROOT_BOUNDARY" src/core/path.ts` → 1 match
- [ ] README and CHANGELOG updated; `npx prettier --check .` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpt at `src/core/path.ts:806-828` does not match the live code.
- TC-PG-014 fails after step 2 — the ENOENT fallback is not behaving as
  specified; do not loosen the filter to make it pass.
- Any existing test that boots with `FS_ROOT_BOUNDARY` starts failing because
  its root is _outside_ the boundary it sets — report which test; it may be
  relying on the bug.
- The Windows CI job fails STDIO-CLI-003 with an aliasing mismatch that
  `isSamePath` does not resolve.

## Maintenance notes

- `partitionStartupRoots` and `isRootWithin`/`filterRootsWithin` are
  deliberately separate: grants are always existing directories (they were
  offered from a real ancestor), so the ENOENT-lexical fallback must not leak
  into the grant path. A reviewer should confirm `filterRootsWithin` is
  untouched.
- If `--allow-missing-roots` semantics change (e.g. roots created later are
  re-validated), revisit the lexical fallback.
- Deferred: a startup _refusal_ (non-zero exit) instead of skip-with-warning.
  Skipping matches the existing unsafe-cwd behavior and keeps plugin hosts
  that pass `${PWD}` from crashing when the cwd is outside the boundary.
