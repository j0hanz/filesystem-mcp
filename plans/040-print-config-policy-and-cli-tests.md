# Plan 040: `--print-config` shows the access policy, and the CLI has tests (including API-key masking)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/cli.ts src/core/sensitive.ts src/core/config.ts README.md`
> Plans 030 and 031 touch `cli.ts` (one line) and `sensitive.ts` (the pattern
> array); that is expected. `runPrintConfig` and `buildDenyTiers` /
> `buildAllowPatterns` as quoted below must still match.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx / tests
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

`ACCESS_DENIED` is the first recovery path the server instructions name, and
`--print-config` is the one command meant to explain the effective
configuration (README: "Print the active configuration"). It prints
transport, `readOnly`, roots, tools, a masked key and the max file size — and
nothing that decides a denial: no deny/allow patterns, no `allowSensitive`,
no root boundary. An operator asking "why is this file denied?" cannot
answer it from the tool.

Separately, `src/cli.ts` (53 commits since June) has almost no tests: only
`--read-only` and `--root-boundary` are exercised end to end. Nothing pins
that `--print-config` masks the API key — the one place a secret could leak
into a pasted bug report.

## Current state

```ts
// src/cli.ts:200-233
export async function runPrintConfig(options: {
  allowedDirs: string[];
  allowCwd: boolean;
  readOnly: boolean;
  /** Resolved `--port`. Present means the launch this reports on is an HTTP bind. */
  port?: number;
  httpHost?: string;
  apiKey?: string;
}): Promise<void> {
  const pathGuard = new PathGuard({
    allowCwd: options.allowCwd,
    cliAllowedDirs: options.allowedDirs,
  });
  await pathGuard.recomputeAllowedDirectories();
  const allowedRoots = pathGuard.getRoots();

  const tools = registeredTools(options.readOnly).map((t) => t.name);

  // Derived, never assumed: `--print-config --port 3000` reports the HTTP bind
  // that `--port` would actually have started, not the stdio default.
  const config = {
    transport:
      options.port !== undefined
        ? `http://${options.httpHost ?? '127.0.0.1'}:${String(options.port)}`
        : 'stdio',
    readOnly: options.readOnly,
    allowedRoots,
    tools,
    apiKey: options.apiKey ? '***' : null,
    limits: { maxFileSizeBytes: getMaxTextFileSize() },
  };

  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}
```

`cli.ts:83-91` `parsePortOption` throws `CliExitError('Error: --port / FS_PORT must be an integer between 1 and 65535')`
for out-of-range values; `src/index.ts:78-88` logs the message and sets exit
code 1. `cli.ts:146-160` writes flag overrides into `cli` (`src/core/config.ts`).

```ts
// src/core/sensitive.ts:299-320 (module-private today)
function buildDenyTiers(): { builtin: readonly string[]; operator: readonly string[] } { … }
function buildAllowPatterns(): readonly string[] { … }
```

`src/core/config.ts` exports `cli: CliOverrides` with optional
`rootBoundary`, `allowSensitive`, `allowMissingRoots`, `denyPatterns`,
`allowPatterns`. `parseTrueEnvFlag(value, name)` (imported in `cli.ts` from
`./core/path-utils.ts`) parses a boolean env var.

Test conventions: `__tests__/stdio.test.ts:158-202` spawns the real entry
(`createStdioClient(tmpDir, env, cliFlags)` from `helpers.ts:429`) for
argv-only behavior. For `--print-config` (which prints JSON and exits) use
`spawn(process.execPath, [join(repoRoot, 'src', 'index.ts'), ...flags, root])`
directly and collect stdout/stderr; `helpers.ts:456-466` shows the spawn
shape (`repoRoot = fileURLToPath(new URL('..', import.meta.url))`).

## Commands you will need

| Purpose      | Command                                                                                 | Expected on success |
| ------------ | --------------------------------------------------------------------------------------- | ------------------- |
| Static check | `npm run check:static`                                                                  | exit 0              |
| CLI tests    | `node --test __tests__/cli.test.ts`                                                     | all pass            |
| Manual       | `node src/index.ts --print-config --deny "secrets/**" .`                                | JSON with `policy`  |
| Format       | `npx prettier --write src/cli.ts src/core/sensitive.ts __tests__/cli.test.ts README.md` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/sensitive.ts` — export one describer built on the two private
  builders
- `src/cli.ts` — `runPrintConfig`
- `README.md` — the `--print-config` row's description, if it lists fields
- `__tests__/cli.test.ts` — new file
- `plans/README.md` (status row)

**Out of scope**: HTTP policy fields (rate limit, allowed hosts/origins,
trust proxy, public URL) — deferred; `--help` text; the `cli` override store.

## Git workflow

- Branch: `advisor/040-print-config-policy-and-cli-tests`.
- Two commits: `feat(cli): --print-config reports the deny/allow policy and boundary`,
  `test(cli): pin --print-config masking and --port validation`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Tests first (they must fail now)

Create `__tests__/cli.test.ts`:

```ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanupTestRoot, createTestRoot } from './helpers.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function runCli(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'src', 'index.ts'), ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
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

describe('CLI (real subprocess)', () => {
  let root: string;
  before(async () => {
    root = await createTestRoot();
  });
  after(async () => {
    await cleanupTestRoot(root);
  });

  it('--print-config masks the API key and reports the access policy', async () => {
    const key = 'cli-test-dummy-key-0123456789';
    const { code, stdout, stderr } = await runCli(
      ['--print-config', '--api-key', key, '--deny', 'secrets/**', '--root-boundary', root, root],
      { FS_ALLOWLIST: 'secrets/README.md' },
    );
    assert.strictEqual(code, 0, stderr);
    assert.ok(!stdout.includes(key) && !stderr.includes(key), 'the key must never be printed');
    const config = JSON.parse(stdout) as {
      apiKey: string | null;
      policy: {
        allowSensitive: boolean;
        builtinDeny: string[];
        operatorDeny: string[];
        allow: string[];
        rootBoundary: string | null;
        allowMissingRoots: boolean;
      };
    };
    assert.strictEqual(config.apiKey, '***');
    assert.strictEqual(config.policy.allowSensitive, false);
    assert.ok(config.policy.builtinDeny.includes('.env'));
    assert.deepStrictEqual(config.policy.operatorDeny, ['secrets/**']);
    assert.deepStrictEqual(config.policy.allow, ['secrets/README.md']);
    assert.strictEqual(config.policy.rootBoundary, root);
    assert.strictEqual(config.policy.allowMissingRoots, false);
  });

  it('--allow-sensitive empties the built-in deny tier in --print-config', async () => {
    const { code, stdout } = await runCli(['--print-config', '--allow-sensitive', root]);
    assert.strictEqual(code, 0);
    const config = JSON.parse(stdout) as {
      policy: { allowSensitive: boolean; builtinDeny: string[] };
    };
    assert.strictEqual(config.policy.allowSensitive, true);
    assert.deepStrictEqual(config.policy.builtinDeny, []);
  });

  it('--port outside 1-65535 exits 1 with a message naming the flag', async () => {
    for (const port of ['0', '70000', 'abc']) {
      const { code, stderr } = await runCli(['--port', port, root]);
      assert.strictEqual(code, 1, `--port ${port} must fail`);
      assert.match(stderr, /--port \/ FS_PORT must be an integer between 1 and 65535/);
    }
  });
});
```

**Verify**: `node --test __tests__/cli.test.ts` → the first two tests
**fail** (`config.policy` is undefined); the third passes already (it is a
characterization test). If the third fails, STOP and report the stderr.

### Step 2: Export a policy describer

In `src/core/sensitive.ts`, directly after `buildAllowPatterns` (line ~320),
add:

```ts
/** The three pattern tiers as configured, for `--print-config`. Read-only view; the matcher compiles its own. */
export function describeSensitivePolicy(): {
  allowSensitive: boolean;
  builtinDeny: readonly string[];
  operatorDeny: readonly string[];
  allow: readonly string[];
} {
  const tiers = buildDenyTiers();
  return {
    allowSensitive: tiers.builtin.length === 0,
    builtinDeny: tiers.builtin,
    operatorDeny: tiers.operator,
    allow: buildAllowPatterns(),
  };
}
```

### Step 3: Print it

In `src/cli.ts`:

1. Add `import { describeSensitivePolicy } from './core/sensitive.ts';`.
2. In `runPrintConfig`, extend the `config` object after `limits`:

   ```ts
       limits: { maxFileSizeBytes: getMaxTextFileSize() },
       // Everything that can produce ACCESS_DENIED, read through the same
       // sources the guard and the matcher use (flag beats env).
       policy: {
         ...describeSensitivePolicy(),
         rootBoundary: cli.rootBoundary ?? process.env['FS_ROOT_BOUNDARY'] ?? null,
         allowMissingRoots:
           cli.allowMissingRoots ??
           parseTrueEnvFlag(process.env['FS_ALLOW_MISSING_ROOTS'], 'FS_ALLOW_MISSING_ROOTS'),
       },
   ```

   `cli` and `parseTrueEnvFlag` are already imported in `cli.ts`.

3. `README.md`: find the `--print-config` row in the Configuration reference
   (`grep -n "print-config" README.md`). If its description enumerates the
   printed fields, append "and the deny/allow policy"; if it just says
   "Print the active configuration", leave it.

Run `npx prettier --write src/cli.ts src/core/sensitive.ts __tests__/cli.test.ts README.md`.

**Verify**: `node --test __tests__/cli.test.ts` → 3 pass;
`node src/index.ts --print-config --deny "secrets/**" .` → JSON whose
`policy.operatorDeny` is `["secrets/**"]`.

### Step 4: Full gate

**Verify**: `npm run check` → exit 0 (knip: `describeSensitivePolicy` is
consumed by `cli.ts`).

## Test plan

- New `__tests__/cli.test.ts`: key masking in both streams + policy fields;
  `--allow-sensitive` empties the built-in tier; three invalid `--port`
  values exit 1 with the documented message.
- Existing: `STDIO-CLI-001/002` in `stdio.test.ts`.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `node --test __tests__/cli.test.ts` reports 3 pass
- [ ] `grep -n "describeSensitivePolicy" src/core/sensitive.ts src/cli.ts` prints the definition, the import and one call
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 040 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `--port` characterization test fails before any change (the message
  text differs from `cli.ts:88` as quoted) — report the stderr verbatim.
- `stdout` of `--print-config` contains anything before the JSON (a startup
  banner moved to stdout) — `JSON.parse` would fail; report, do not strip.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The policy block is additive JSON; scripts that parse `--print-config`
  keep working.
- Deferred: HTTP policy (rate limit, allowed hosts/origins, trust proxy,
  public URL) when `--port` is set. Add it as `policy.http` next to this
  block, reading through `http-policy.ts`'s own resolvers.
- Reviewer focus: the key is masked by the existing `'***'` line; the new
  block must never include `apiKey` or `FS_REQUEST_STATE_KEY`.
