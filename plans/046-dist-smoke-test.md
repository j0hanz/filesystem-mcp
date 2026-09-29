# Plan 046: A smoke test runs the built `dist/index.js` the way `npx` will

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 4d751c94..HEAD -- __tests__/helpers.ts __tests__/dist-smoke.test.ts package.json tsconfig.json AGENTS.md CONTRIBUTING.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW — additive test; no runtime code changes.
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `4d751c94`, 2026-09-28

## Why this matters

Every process-level test spawns `src/index.ts` and lets Node strip the types.
The artifact users actually run — `dist/index.js`, declared as the package
`bin` and started by `npx -y @j0hanz/filesystem-mcp` in every README recipe,
the MCPB bundle and the Docker image — is never executed by the suite. A
broken shebang, a `.ts` import extension that `rewriteRelativeImportExtensions`
failed to rewrite, a missing `dist/transport.js` for the public
`./transport` export, or a runtime-only ESM resolution error would pass
`npm run check` and ship. `npm run check` already builds before it tests, so
one test that boots `dist/index.js` over stdio closes the gap at ~1 s cost.

## Current state

- `package.json:20-27`: `"bin": { "filesystem-mcp": "dist/index.js" }`,
  `"exports": { "./transport": { "types": "./dist/transport.d.ts", "default": "./dist/transport.js" }, … }`,
  `"files": ["dist", "README.md"]`.
- `package.json:31-40`: `"build": "tsc -p tsconfig.json"`;
  `"check": "npm run check:static && npm run test"` and `check:static`
  starts with `npm run build` — so under `npm run check` (local and CI,
  `.github/workflows/ci.yml:28`) `dist/` is always fresh when tests run.
  Under a bare `npm test`, `dist/` may be absent or stale.
- `tsconfig.json`: `"rewriteRelativeImportExtensions": true`, `outDir ./dist`,
  `rootDir ./src`, `declaration: true`.
- `src/index.ts:1`: `#!/usr/bin/env node`.
- `src/transport.ts:5-6`: `export { startServer } …; export { startHttpServer } …`.
- `__tests__/helpers.ts:429-454` — `createStdioClient(allowedDir, extraEnv = {}, cliFlags = [])`:

```ts
export async function createStdioClient(
  allowedDir: string,
  extraEnv: Record<string, string> = {},
  cliFlags: readonly string[] = [],
) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, 'src', 'index.ts'), ...cliFlags, allowedDir],
    cwd: repoRoot,
    env: { ...getDefaultEnvironment(), ...extraEnv },
  });
  const client = new Client(
    { name: 'stdio-test-harness', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await transport.close();
    },
  };
}
```

- `__tests__/cli.test.ts:11-38` — `runCli(args, env)` spawns
  `src/index.ts` with `stdio: ['ignore','pipe','pipe']`, strips inherited
  `FS_*` vars, and resolves `{ code, stdout, stderr }`.
- `__tests__/smoke.test.ts` — in-process smoke tests (`SMOKE-001`, `SMOKE-003`)
  asserting `listTools().tools.length === ALL_REGISTERED_TOOL_NAMES.length`.
- `knip.json`: `entry: ["__tests__/**/*.test.ts"]` — a new test file is
  picked up automatically. `tsconfig.test.json` includes `__tests__/**/*.ts`.
- `.gitignore` ignores `dist/`.

Conventions: tests are `node:test` + `node:assert/strict`; IDs like
`SMOKE-00N`; helper functions live in `__tests__/helpers.ts`; the Prettier
import-sort plugin orders imports.

## Commands you will need

| Purpose         | Command                                    | Expected on success            |
| --------------- | ------------------------------------------ | ------------------------------ |
| Build           | `npm run build`                            | exit 0; `dist/index.js` exists |
| Typecheck tests | `npm run type-check:test`                  | exit 0                         |
| New test only   | `npm test -- __tests__/dist-smoke.test.ts` | all pass                       |
| Full check      | `npm run check`                            | exit 0; 0 fail                 |
| Lint            | `npm run lint`                             | exit 0                         |

Baseline at planning time: 450 tests, 447 pass, 3 skips, 0 fail.

## Scope

**In scope**:

- `__tests__/helpers.ts` — one optional parameter on `createStdioClient`
- `__tests__/dist-smoke.test.ts` — new file
- `AGENTS.md` — one sentence (the test skips without a build)
- `plans/README.md` — status row

**Out of scope**:

- `package.json` scripts — do not make `npm test` build first; `npm run check` is the authoritative gate.
- `src/**` — no runtime changes.
- `Dockerfile`, `mcpb/`, `scripts/` — release-path checks live in `scripts/check-release-paths.sh` (plan 037).
- `__tests__/stdio.test.ts`, `__tests__/cli.test.ts` — keep them on `src/index.ts` for fast feedback.

## Git workflow

- Branch: `advisor/046-dist-smoke-test`
- Commit e.g. `test: boot the built dist/index.js over stdio`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Let the stdio helper target the built entry

In `__tests__/helpers.ts`, extend `createStdioClient` with a fourth parameter
and use it for the entry path:

```ts
export async function createStdioClient(
  allowedDir: string,
  extraEnv: Record<string, string> = {},
  cliFlags: readonly string[] = [],
  entry: 'src' | 'dist' = 'src',
) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const entryPath =
    entry === 'dist' ? join(repoRoot, 'dist', 'index.js') : join(repoRoot, 'src', 'index.ts');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPath, ...cliFlags, allowedDir],
    ...
```

Update the docstring's first line to: "Spawn the real stdio server — `src/index.ts` (Node strips the types) or, with `entry: 'dist'`, the built `dist/index.js` that `npx` runs — and connect a client."

**Verify**: `npm run type-check:test && npm run lint` → exit 0;
`npm test -- --test-name-pattern="STDIO-"` → all pass (default unchanged).

### Step 2: The smoke test file

Create `__tests__/dist-smoke.test.ts`:

```ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ALL_REGISTERED_TOOL_NAMES,
  cleanupTestRoot,
  createStdioClient,
  createTestRoot,
  firstTextBlock,
  writeTestFile,
} from './helpers.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const distEntry = join(repoRoot, 'dist', 'index.js');

/**
 * `npm run check` builds before it tests, so `dist/` is always fresh there
 * (local and CI). A bare `npm test` may run without a build: skip rather than
 * fail, and say why. A stale `dist/` is not detected — `npm run check` is the
 * authoritative run for this file.
 */
async function distIsBuilt(): Promise<boolean> {
  try {
    await access(distEntry);
    return true;
  } catch {
    return false;
  }
}

function runDist(
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const childEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('FS_')) childEnv[k] = v;
    }
    const child = spawn(process.execPath, [distEntry, ...args], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('Built artifact (dist/index.js, the npm bin)', () => {
  let tmpDir: string;
  let built = false;

  before(async () => {
    tmpDir = await createTestRoot();
    built = await distIsBuilt();
  });

  after(async () => {
    await cleanupTestRoot(tmpDir);
  });

  it('DIST-001: dist/index.js starts with the node shebang', async (t) => {
    if (!built) return t.skip('dist/ is not built; run `npm run build` (npm run check does)');
    const firstLine = (await readFile(distEntry, 'utf-8')).split('\n', 1)[0];
    assert.strictEqual(firstLine, '#!/usr/bin/env node');
  });

  it('DIST-002: --version prints the package version and exits 0', async (t) => {
    if (!built) return t.skip('dist/ is not built');
    const { version } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8')) as {
      version: string;
    };
    const { code, stdout, stderr } = await runDist(['--version']);
    assert.strictEqual(code, 0, stderr);
    assert.ok(stdout.includes(version), `stdout should contain ${version}: ${stdout}`);
  });

  it('DIST-003: serves the full tool list and reads a file over stdio', async (t) => {
    if (!built) return t.skip('dist/ is not built');
    const file = await writeTestFile(tmpDir, 'dist-smoke.txt', 'built artifact\n');
    const harness = await createStdioClient(tmpDir, {}, [], 'dist');
    try {
      const { tools } = await harness.client.listTools();
      assert.deepStrictEqual(
        tools.map((tool) => tool.name).sort(),
        [...ALL_REGISTERED_TOOL_NAMES].sort(),
      );
      const result = await harness.client.callTool({ name: 'read', arguments: { path: file } });
      assert.notStrictEqual(result.isError, true);
      assert.ok(firstTextBlock(result).text?.includes('built artifact'));
    } finally {
      await harness.close();
    }
  });

  it('DIST-004: the public ./transport export resolves and exposes both starters', async (t) => {
    if (!built) return t.skip('dist/ is not built');
    // A non-literal specifier keeps tsc from resolving dist/*.d.ts at type-check
    // time, so `npm run type-check:test` passes on an unbuilt clone.
    const specifier = pathToFileURL(join(repoRoot, 'dist', 'transport.js')).href;
    const mod = (await import(specifier)) as Record<string, unknown>;
    assert.strictEqual(typeof mod['startServer'], 'function');
    assert.strictEqual(typeof mod['startHttpServer'], 'function');
    await access(join(repoRoot, 'dist', 'transport.d.ts'));
  });
});
```

Notes for the executor: `t.skip(message)` is the `node:test` way to record a
skip; the `return` keeps the body from running. `firstTextBlock` and
`writeTestFile` are existing helpers. If ESLint flags
`@typescript-eslint/no-unsafe-*` on the dynamic import, those rules are
already off for `__tests__/**` (`eslint.config.mjs`, `project/tests`); if it
flags `import()` with a non-literal under another rule, add a one-line
`// eslint-disable-next-line <rule> -- see comment above` (the config errors
on _unused_ disables, so only add it if the lint run demands it).

**Verify**: `npm run build && npm test -- __tests__/dist-smoke.test.ts` →
4 pass, 0 skip. Then rename `dist` temporarily
(`Rename-Item dist dist.bak`), run the same command → 4 skipped, 0 fail;
restore (`Rename-Item dist.bak dist`).

### Step 3: Prove it catches what it should

Break the artifact on purpose and confirm the test goes red, then restore:

1. `npm run build`, then edit `dist/index.js` line 1 to `#!/usr/bin/env nodejs` → `npm test -- __tests__/dist-smoke.test.ts` → DIST-001 fails. `npm run build` again.
2. `Remove-Item dist/transport.js` → DIST-004 fails. `npm run build` again.

**Verify**: both failures observed, then `npm test -- __tests__/dist-smoke.test.ts` → 4 pass.

### Step 4: Document and full check

`AGENTS.md`, under "## Commands", add one line after the test-filter note:
`\`**tests**/dist-smoke.test.ts\` boots \`dist/index.js\`; it skips when \`dist/\` is absent, so run \`npm run build\` (or \`npm run check\`) first to exercise it.`

**Verify**: `npm run check` → exit 0, `fail 0`, and the run shows 4 new
passes (no skips from this file, since `check` builds first).

## Test plan

- New file `__tests__/dist-smoke.test.ts` with DIST-001..004: shebang;
  `--version`; full tool list + one `read` over stdio from the built entry;
  the `./transport` export resolves with both functions and its `.d.ts`.
- Pattern: `smoke.test.ts` (tool-list assertion) and `cli.test.ts` `runCli`
  (subprocess with `FS_*` stripped).
- Mutation checks in step 3 prove DIST-001 and DIST-004 are live.

## Done criteria

- [ ] `npm run check` exits 0 and reports 4 more passing tests than baseline (≥ 451 pass)
- [ ] `npm test -- __tests__/dist-smoke.test.ts` with `dist/` absent → 4 skipped, 0 failed
- [ ] `createStdioClient`'s default behavior is unchanged (`npm test -- --test-name-pattern="STDIO-"` green)
- [ ] `npm run type-check:test` passes on a tree where `dist/` is absent (no literal `../dist/...` import in the test)
- [ ] `AGENTS.md` updated; `npx prettier --check .` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `dist/index.js` does not start with `#!/usr/bin/env node` after a fresh
  `npm run build` — that is a real product bug (tsc dropped the shebang);
  report it rather than changing the assertion.
- DIST-003 fails after a fresh build while `STDIO-001` passes — the emitted
  JavaScript differs from the TypeScript run; capture `stderr` from the child
  and report.
- The Windows CI job fails DIST-002 on `--version` output — report the exact
  stdout; do not loosen to a regex without knowing why.

## Maintenance notes

- If `bin` or `exports` in `package.json` change, update `distEntry` and
  DIST-004 accordingly — they are the two places the test hard-codes the
  package contract.
- The test deliberately does not build. If someone later makes `npm test`
  build first, remove the skip logic rather than leaving two paths.
- Deferred: running the packed tarball (`npm pack` → install into a temp dir →
  `npx`) would also validate `files` and the published layout; it costs
  several seconds and network-free install semantics — worth it only if a
  packaging regression ever ships.
