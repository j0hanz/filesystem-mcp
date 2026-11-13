# Config Owns Flagged Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `src/core/config.ts` the one module that resolves every flagged **Setting** (flag, else `FS_*` variable, else default), so no other module writes the flag-beats-env rule.

**Architecture:** `config.ts` gains eight named reads that return parsed effective values, plus the two env parsers they need. Readers (`path.ts`, `util.ts`, `observability.ts`, `sensitive.ts`, `cli.ts`) call the reads and stop touching `process.env` for those Settings. Reads are lazy; the `cli` bag stays the exported write target.

**Tech Stack:** TypeScript (native, `.ts` import specifiers), Node built-in test runner (`node:test`, `node:assert/strict`), ESLint, knip.

**Spec:** `docs/adr/017-config-owns-flagged-settings.md` (decision) and the **Setting** entry in `GLOSSARY.md`.

## Global Constraints

- No observable behaviour change: same values, same warning text, same warning timing, same `--print-config` bytes. `__tests__/contract.test.ts.snapshot` must not change.
- `src/core/config.ts` may import only `./path-utils.ts`. It must never import `util.ts`, `observability.ts`, `sensitive.ts`, `path.ts` or `errors.ts`.
- Every read resolves on each call. No module-level snapshot of a Setting. The one memo allowed is the log-level memo keyed on the raw string, moved as is.
- An invalid or empty flag value falls back to the default, never to the variable (`cli.x ?? process.env[...]` keeps its `??`).
- Unions stay where they are: `FS_DENYLIST`/`--deny`, `FS_ALLOWLIST`/`--allow`, `FS_READ_ONLY_DIRS`/`--read-only-root`. `--port`, `--http-host`, `--api-key`, `--read-only` stay in `parseArgs`.
- No pass-through re-exports: when a name moves to `config.ts`, repoint every importer; do not leave a delegate in `util.ts` or `observability.ts`.
- Never hand-edit versions (`package.json`, `server.json`, manifests). No `CHANGELOG.md` entry: nothing user-visible changes.
- Work on branch `refactor/config-owns-settings`. Commit messages follow Conventional Commits, scope `config`.
- Run tests with `npm test -- --test-name-pattern="<pattern>"`; run the contract test with no `FS_*` variables set.

## Review Focus

1. Flag given an invalid value while the variable is valid (`--tool-timeout abc`, `FS_TOOL_TIMEOUT_MS=15000`): the default is used, not the variable. Pinned in Task 1.
2. Variable changed after a first read in the same process: the next read sees the new value, including the memoized log level. Pinned in Tasks 1 and 2.
3. `--root-boundary ''` with `FS_ROOT_BOUNDARY` set: the read returns `''`, not the variable and not `undefined`. Pinned in Task 3.
4. `FS_ALLOW_CWD_WALK=true` alone, no flag: cwd is a root and the walk is on. Pinned in Task 4.
5. A mistyped boolean variable (`FS_ALLOW_SENSITIVE=yes`): reads `false` and warns once, not once per read. Pinned in Task 3.

## File Structure

| File                                                      | Role after this plan                                                                                                                                              |
| :-------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/config.ts`                                      | The `cli` bag, the eight Setting reads, `parseTrueEnvFlag`, `parseEnvInt`, `LoggingLevel`, `LOG_LEVEL_ORDER`                                                      |
| `src/core/util.ts`                                        | Loses `parseEnvInt`, `parseIntSetting`, `parseTrueEnvFlag`, `getMaxTextFileSize`, `getToolTimeoutMs`; keeps `getMaxInboundMessageBytes`, `getMaxUndoBytes`, `MIB` |
| `src/core/observability.ts`                               | Loses the level type, order, parser and memo; keeps `isLevelEnabled`, `write`, `Logger`                                                                           |
| `src/core/path.ts`, `src/core/sensitive.ts`, `src/cli.ts` | Call the reads                                                                                                                                                    |
| `__tests__/config.test.ts`                                | New: precedence table for all eight Settings                                                                                                                      |

---

### Task 1: Numeric Settings and the env parsers move into config

**Files:**

- Create: `__tests__/config.test.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/util.ts:4-5,10-44,59-72,133-141,168-181` (cut, doc comments included), and `:127-129`, `:159-161` (import source only)
- Modify (import repoint only): `src/cli.ts:22-24`, `src/core/file-uri.ts:10`, `src/core/fs.ts:79`, `src/core/rewrite.ts:9`, `src/core/path.ts:51`, `src/core/sensitive.ts:17`, `src/core/watcher-registry.ts:10`, `src/instructions.ts:5`, `src/resources.ts:36`, `src/tools/create.ts:21`, `src/tools/define.ts:50`, `src/tools/read.ts:39`, `src/tools/replace-text.ts:41`, `src/transport/http.ts:26`, `__tests__/core-fs.test.ts:43`, `__tests__/create.test.ts:11`, `__tests__/rewrite.test.ts:13`

**Interfaces:**

- Consumes: `warnInvalidSetting(name, value, expected, fallback)` from `src/core/path-utils.ts`; `withEnv(vars, fn)` from `__tests__/helpers.ts`.
- Produces, all exported from `src/core/config.ts`:
  - `parseTrueEnvFlag(value: string | undefined, name?: string): boolean`
  - `parseEnvInt(envVar: string, defaultValue: number, min: number, max: number): number`
  - `getMaxTextFileSize(): number`
  - `getToolTimeoutMs(): number`

- [ ] **Step 1: Branch, and commit the decision documents on their own**

The ADR, the glossary entry and this plan are already in the working tree, uncommitted. `npm run fix` runs prettier over them, so format first and keep them out of the refactor commits.

```bash
git switch -c refactor/config-owns-settings
npx prettier --write GLOSSARY.md docs/adr/017-config-owns-flagged-settings.md docs/superpowers/plans/2026-11-13-config-owns-settings.md
git add GLOSSARY.md docs/adr/017-config-owns-flagged-settings.md docs/superpowers/plans/2026-11-13-config-owns-settings.md
git commit -m "docs(config): record ADR-017, the Setting term and the plan"
```

- [ ] **Step 2: Write the failing test**

Create `__tests__/config.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cli,
  type CliOverrides,
  getMaxTextFileSize,
  getToolTimeoutMs,
  parseEnvInt,
  parseTrueEnvFlag,
} from '../src/core/config.ts';
import { withEnv } from './helpers.ts';

const MIB = 1024 * 1024;

/** Run `fn` with the flag bag set to exactly `overrides`, then put the bag back. */
async function withCli<T>(overrides: CliOverrides, fn: () => T | Promise<T>): Promise<T> {
  const saved = { ...cli };
  for (const key of Object.keys(cli)) Reflect.deleteProperty(cli, key);
  Object.assign(cli, overrides);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(cli)) Reflect.deleteProperty(cli, key);
    Object.assign(cli, saved);
  }
}

describe('Setting: tool timeout', () => {
  const cases: readonly [
    name: string,
    flag: string | undefined,
    env: string | undefined,
    want: number,
  ][] = [
    ['default', undefined, undefined, 5000],
    ['variable only', undefined, '15000', 15000],
    ['flag only', '20000', undefined, 20000],
    ['flag beats variable', '20000', '15000', 20000],
    ['invalid flag falls to the default, not the variable', 'abc', '15000', 5000],
    ['empty flag falls to the default, not the variable', '', '15000', 5000],
    ['variable out of range falls to the default', undefined, '50', 5000],
  ];
  for (const [name, flag, env, want] of cases) {
    it(name, async () => {
      await withEnv({ FS_TOOL_TIMEOUT_MS: env }, () =>
        withCli(flag === undefined ? {} : { toolTimeout: flag }, () => {
          assert.strictEqual(getToolTimeoutMs(), want);
        }),
      );
    });
  }

  it('is resolved on every read', async () => {
    await withCli({}, async () => {
      await withEnv({ FS_TOOL_TIMEOUT_MS: '15000' }, () => {
        assert.strictEqual(getToolTimeoutMs(), 15000);
      });
      await withEnv({ FS_TOOL_TIMEOUT_MS: '16000' }, () => {
        assert.strictEqual(getToolTimeoutMs(), 16000);
      });
    });
  });
});

describe('Setting: max file size', () => {
  const cases: readonly [
    name: string,
    flag: string | undefined,
    env: string | undefined,
    want: number,
  ][] = [
    ['default', undefined, undefined, 10 * MIB],
    ['variable only', undefined, String(2 * MIB), 2 * MIB],
    ['flag beats variable', String(4 * MIB), String(2 * MIB), 4 * MIB],
    ['flag below the range falls to the default, not the variable', '1', String(2 * MIB), 10 * MIB],
    ['variable above the range falls to the default', undefined, String(101 * MIB), 10 * MIB],
  ];
  for (const [name, flag, env, want] of cases) {
    it(name, async () => {
      await withEnv({ FS_MAX_FILE_SIZE: env }, () =>
        withCli(flag === undefined ? {} : { maxFileSize: flag }, () => {
          assert.strictEqual(getMaxTextFileSize(), want);
        }),
      );
    });
  }
});

describe('env parsers', () => {
  it('parseTrueEnvFlag reads true and 1 as true, everything else as false', () => {
    assert.strictEqual(parseTrueEnvFlag('true'), true);
    assert.strictEqual(parseTrueEnvFlag(' 1 '), true);
    assert.strictEqual(parseTrueEnvFlag('TRUE'), true);
    assert.strictEqual(parseTrueEnvFlag('false'), false);
    assert.strictEqual(parseTrueEnvFlag('0'), false);
    assert.strictEqual(parseTrueEnvFlag(''), false);
    assert.strictEqual(parseTrueEnvFlag(undefined), false);
  });

  it('parseEnvInt reads the named variable and falls to the default out of range', async () => {
    await withEnv({ FS_CONFIG_TEST_INT: '7' }, () => {
      assert.strictEqual(parseEnvInt('FS_CONFIG_TEST_INT', 3, 1, 10), 7);
    });
    await withEnv({ FS_CONFIG_TEST_INT: '11' }, () => {
      assert.strictEqual(parseEnvInt('FS_CONFIG_TEST_INT', 3, 1, 10), 3);
    });
    await withEnv({ FS_CONFIG_TEST_INT: undefined }, () => {
      assert.strictEqual(parseEnvInt('FS_CONFIG_TEST_INT', 3, 1, 10), 3);
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="Setting: tool timeout"`
Expected: FAIL, `config.ts` does not provide an export named `getMaxTextFileSize`.

- [ ] **Step 4: Move the parsers and the two getters into `src/core/config.ts`**

Cut from `src/core/util.ts` and paste into `config.ts`, bodies unchanged: `parseEnvInt`, `parseIntSetting` (stays non-exported), `parseTrueEnvFlag`, `getMaxTextFileSize`, `getToolTimeoutMs`, each with its doc comment. Add `import { warnInvalidSetting } from './path-utils.ts';` to `config.ts`. `config.ts` cannot import `MIB` from `util.ts` (cycle): declare a private `const MIB = 1024 * 1024;` in `config.ts`; `util.ts` keeps its exported `MIB`.

In `util.ts`: `getMaxInboundMessageBytes` and `getMaxUndoBytes` stay and import `getMaxTextFileSize` and `parseEnvInt` from `./config.ts`. Drop the `cli` import and the `warnInvalidSetting` import if nothing else in the file uses them.

- [ ] **Step 5: Repoint every importer**

For each file in the Files list, import the moved name from `config.ts` (relative path per file) and leave the other names on the `util.ts` import. One import statement per module (`no-duplicate-imports` is on): merge into an existing `config.ts` import where the file already has one (`src/cli.ts:9`, `src/core/path.ts:17`, `src/core/sensitive.ts:9`).

- [ ] **Step 6: Run the tests**

Run: `npm test -- --test-name-pattern="Setting:|env parsers"`
Expected: PASS, 15 tests.

Run: `npm run fix`
Expected: exit 0 (formats import order, then lint, type-check, knip and the full suite pass).

- [ ] **Step 7: Commit**

```bash
git add src __tests__
git commit -m "refactor(config): resolve max file size and tool timeout in config"
```

---

### Task 2: The log level moves into config

**Files:**

- Modify: `src/core/config.ts`
- Modify: `src/core/observability.ts:1-52`
- Modify (import repoint only): `src/tools/define.ts:43`, `__tests__/tool-harness.ts:17`
- Test: `__tests__/config.test.ts`

**Interfaces:**

- Consumes: `withCli` from Task 1's test file.
- Produces, exported from `src/core/config.ts`:
  - `type LoggingLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency'`
  - `LOG_LEVEL_ORDER: readonly LoggingLevel[]` (most severe first; today's `LEVEL_ORDER`)
  - `getLogLevel(): LoggingLevel`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/config.test.ts` (add `getLogLevel` and `type LoggingLevel` to the `config.ts` import):

```ts
describe('Setting: log level', () => {
  const cases: readonly [
    name: string,
    flag: string | undefined,
    env: string | undefined,
    want: LoggingLevel,
  ][] = [
    ['default', undefined, undefined, 'info'],
    ['variable only, trimmed and lowercased, warn is warning', undefined, ' WARN ', 'warning'],
    ['flag beats variable', 'debug', 'error', 'debug'],
    ['invalid flag falls to the default, not the variable', 'bogus-flag-level', 'error', 'info'],
  ];
  for (const [name, flag, env, want] of cases) {
    it(name, async () => {
      await withEnv({ FS_LOG_LEVEL: env }, () =>
        withCli(flag === undefined ? {} : { logLevel: flag }, () => {
          assert.strictEqual(getLogLevel(), want);
        }),
      );
    });
  }

  it('follows a variable changed after the first read', async () => {
    await withCli({}, async () => {
      await withEnv({ FS_LOG_LEVEL: 'error' }, () => {
        assert.strictEqual(getLogLevel(), 'error');
      });
      await withEnv({ FS_LOG_LEVEL: 'debug' }, () => {
        assert.strictEqual(getLogLevel(), 'debug');
      });
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="Setting: log level"`
Expected: FAIL, `config.ts` does not provide an export named `getLogLevel`.

- [ ] **Step 3: Move the level type, order, parser and memo into `src/core/config.ts`**

Cut `LoggingLevel`, `LEVEL_ORDER` (rename to `LOG_LEVEL_ORDER`, export it), `isLoggingLevel`, `parseLogLevel`, `cachedRaw`, `cachedLevel` and `getLogLevel` (export it) from `observability.ts:5-52` into `config.ts`, bodies and comments unchanged. `observability.ts` imports `getLogLevel`, `LOG_LEVEL_ORDER` and `type LoggingLevel` from `./config.ts`, uses `LOG_LEVEL_ORDER` in `isLevelEnabled`, and drops its `cli` and `warnInvalidSetting` imports if unused. Repoint the `LoggingLevel` imports at `src/tools/define.ts:43` and `__tests__/tool-harness.ts:17` to `config.ts`.

- [ ] **Step 4: Run the tests**

Run: `npm test -- --test-name-pattern="Setting: log level"`
Expected: PASS, 5 tests.

Run: `npm run fix`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src __tests__
git commit -m "refactor(config): resolve the log level in config"
```

---

### Task 3: Root boundary and the boolean Settings

**Files:**

- Modify: `src/core/config.ts`
- Modify: `src/core/path.ts:1622-1631,1637-1638` (and its imports at `:17`, `:51`)
- Modify: `src/core/sensitive.ts:375-376` (and its imports at `:9`, `:17`)
- Modify: `src/cli.ts:353-356`
- Test: `__tests__/config.test.ts`

**Interfaces:**

- Consumes: `parseTrueEnvFlag` (Task 1), `withCli` (Task 1).
- Produces, exported from `src/core/config.ts`:
  - `getRootBoundary(): string | undefined` returns `cli.rootBoundary ?? process.env['FS_ROOT_BOUNDARY']`, unparsed
  - `getAllowMissingRoots(): boolean` returns `cli.allowMissingRoots ?? parseTrueEnvFlag(process.env['FS_ALLOW_MISSING_ROOTS'], 'FS_ALLOW_MISSING_ROOTS')`
  - `getAllowSensitive(): boolean` same shape over `cli.allowSensitive` and `FS_ALLOW_SENSITIVE`
  - `getAllowCwdWalk(): boolean` same shape over `cli.allowCwdWalk` and `FS_ALLOW_CWD_WALK`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/config.test.ts` (extend the `config.ts` import with the four reads):

```ts
describe('Setting: root boundary', () => {
  const cases: readonly [
    name: string,
    flag: string | undefined,
    env: string | undefined,
    want: string | undefined,
  ][] = [
    ['unset', undefined, undefined, undefined],
    ['variable only', undefined, '/srv/a', '/srv/a'],
    ['flag beats variable', '/srv/b', '/srv/a', '/srv/b'],
    ['empty flag stays empty, not the variable', '', '/srv/a', ''],
  ];
  for (const [name, flag, env, want] of cases) {
    it(name, async () => {
      await withEnv({ FS_ROOT_BOUNDARY: env }, () =>
        withCli(flag === undefined ? {} : { rootBoundary: flag }, () => {
          assert.strictEqual(getRootBoundary(), want);
        }),
      );
    });
  }
});

const BOOLEAN_SETTINGS = [
  ['allow missing roots', 'FS_ALLOW_MISSING_ROOTS', 'allowMissingRoots', getAllowMissingRoots],
  ['allow sensitive', 'FS_ALLOW_SENSITIVE', 'allowSensitive', getAllowSensitive],
  ['cwd walk', 'FS_ALLOW_CWD_WALK', 'allowCwdWalk', getAllowCwdWalk],
] as const;

for (const [label, envVar, field, read] of BOOLEAN_SETTINGS) {
  describe(`Setting: ${label}`, () => {
    const cases: readonly [
      name: string,
      flag: true | undefined,
      env: string | undefined,
      want: boolean,
    ][] = [
      ['default', undefined, undefined, false],
      ['variable true', undefined, 'true', true],
      ['variable 1', undefined, '1', true],
      ['variable false', undefined, 'false', false],
      ['flag beats a false variable', true, 'false', true],
    ];
    for (const [name, flag, env, want] of cases) {
      it(name, async () => {
        await withEnv({ [envVar]: env }, () =>
          withCli(flag === undefined ? {} : { [field]: flag }, () => {
            assert.strictEqual(read(), want);
          }),
        );
      });
    }

    it('a mistyped variable reads false and warns once', async (t) => {
      const warn = t.mock.method(console, 'error', () => {});
      // A value no other test uses: the warning is deduplicated per name and value for the process.
      await withEnv({ [envVar]: `yes-${field}` }, () =>
        withCli({}, () => {
          assert.strictEqual(read(), false);
          assert.strictEqual(read(), false);
        }),
      );
      assert.strictEqual(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0]?.arguments[0]), new RegExp(`Invalid ${envVar} value`));
    });
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="Setting: root boundary"`
Expected: FAIL, `config.ts` does not provide an export named `getRootBoundary`.

- [ ] **Step 3: Add the four reads to `src/core/config.ts`**

Each body is the single expression given in the Interfaces block. Doc-comment each with its flag and variable names.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="Setting: (root boundary|allow missing roots|allow sensitive|cwd walk)"`
Expected: PASS, 22 tests.

- [ ] **Step 5: Make the readers ask config**

- `src/core/path.ts:1622-1624`: `const allowMissing = getAllowMissingRoots();`
- `src/core/path.ts:1628-1631`: read `const rawBoundary = getRootBoundary();` and keep the conditional spread, `...(rawBoundary !== undefined ? { rawValue: rawBoundary } : {})`. Keep the comment on `:1627`.
- `src/core/path.ts:1637-1638`: `const walkCwd = getAllowCwdWalk();` It stays inside `if (allowCwd)`.
- `src/core/path.ts` imports: `cli` and `parseTrueEnvFlag` are no longer used there; remove them.
- `src/core/sensitive.ts:375-376`: `const allowSensitive = getAllowSensitive();` Keep the `cli` import (the pattern lists at `:380` and `:393` still read it); remove `parseTrueEnvFlag` from its imports.
- `src/cli.ts:353`: `rootBoundary: getRootBoundary() ?? null,`
- `src/cli.ts:354-356`: `allowMissingRoots: getAllowMissingRoots(),`

- [ ] **Step 6: Run the checks**

Run: `npm run fix`
Expected: exit 0. `__tests__/cli.test.ts` (`--print-config` policy fields), `__tests__/security.test.ts`, `__tests__/path-guard-grant.test.ts` and `__tests__/read-only-roots.test.ts` pass unchanged.

- [ ] **Step 7: Commit**

```bash
git add src __tests__
git commit -m "refactor(config): resolve root boundary and the boolean settings in config"
```

---

### Task 4: cwd-is-a-root, and parseArgs asks config

**Files:**

- Modify: `src/core/config.ts` (`CliOverrides`, one read)
- Modify: `src/cli.ts:221-227,236-239,244-246`
- Test: `__tests__/config.test.ts`

**Interfaces:**

- Consumes: `getAllowMissingRoots` (Task 3), `parseTrueEnvFlag` (Task 1).
- Produces:
  - `CliOverrides.allowCwd?: boolean`, doc comment `` `--allow-cwd` ``
  - `getAllowCwd(): boolean`, exported from `src/core/config.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/config.test.ts` (add `getAllowCwd` to the import):

```ts
describe('Setting: cwd is a root', () => {
  const cases: readonly [
    name: string,
    flags: CliOverrides,
    env: string | undefined,
    want: boolean,
  ][] = [
    ['default', {}, undefined, false],
    ['--allow-cwd', { allowCwd: true }, undefined, true],
    ['--walk-cwd implies it', { allowCwdWalk: true }, undefined, true],
    ['FS_ALLOW_CWD_WALK alone implies it', {}, 'true', true],
    ['a false variable does not', {}, 'false', false],
  ];
  for (const [name, flags, env, want] of cases) {
    it(name, async () => {
      await withEnv({ FS_ALLOW_CWD_WALK: env }, () =>
        withCli(flags, () => {
          assert.strictEqual(getAllowCwd(), want);
        }),
      );
    });
  }

  it('FS_ALLOW_CWD_WALK alone also turns the walk on', async () => {
    await withEnv({ FS_ALLOW_CWD_WALK: 'true' }, () =>
      withCli({}, () => {
        assert.strictEqual(getAllowCwd(), true);
        assert.strictEqual(getAllowCwdWalk(), true);
      }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="Setting: cwd is a root"`
Expected: FAIL, `config.ts` does not provide an export named `getAllowCwd`.

- [ ] **Step 3: Add the field and the read**

Add `allowCwd?: boolean` to `CliOverrides`. `getAllowCwd()` keeps today's short-circuit order from `src/cli.ts:236-239`, so the variable is not parsed (and cannot warn) when a flag already answers:

```ts
export function getAllowCwd(): boolean {
  return (
    Boolean(cli.allowCwd) ||
    Boolean(cli.allowCwdWalk) ||
    parseTrueEnvFlag(process.env['FS_ALLOW_CWD_WALK'], 'FS_ALLOW_CWD_WALK')
  );
}
```

- [ ] **Step 4: Make `parseArgs` ask config**

- After `src/cli.ts:226`, add `if (v['allow-cwd']) cli.allowCwd = true;`
- `src/cli.ts:236-239`: `const allowCwd = getAllowCwd();`
- `src/cli.ts:244-246`: `const allowMissingRoots = getAllowMissingRoots();`
- `readOnly` (`:240-241`) and `port`, `httpHost`, `apiKey` stay as written; `parseTrueEnvFlag` stays imported in `cli.ts` for `FS_READ_ONLY`.

- [ ] **Step 5: Run the checks**

Run: `npm test -- --test-name-pattern="Setting: cwd is a root"`
Expected: PASS, 6 tests.

Run: `npm run fix`
Expected: exit 0; `__tests__/cli.test.ts` passes unchanged.

- [ ] **Step 6: Commit**

```bash
git add src __tests__
git commit -m "refactor(config): parseArgs asks config for cwd and missing roots"
```

---

### Task 5: Say what config now is, and prove nothing moved

**Files:**

- Modify: `src/core/config.ts:1-8,40`
- Modify: `src/cli.ts:212-216`

**Interfaces:**

- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Replace the header of `src/core/config.ts` (lines 1-8) with**

```ts
// Settings: the one owner of the flag-beats-env rule (ADR-017).
//
// `parseArgs` (cli.ts) assigns flag values onto `cli` once at startup. Each
// Setting has one named read here that answers flag, else `FS_*` variable,
// else default, parsed, and warns once about a rejected value. Reads resolve
// on every call: flags land after module load, and tests change the
// environment per case. No other module applies the flag-beats-env rule;
// path-discovery.ts reads a directory-list variable by name only when it is
// handed no raw value.
//
// This module imports only `path-utils.ts`, which imports no repo module, so
// any core module can read it without a cycle. Keep it that way.
```

Change the `cli` doc comment (line 40) to: `/** Written once by cli.ts; an absent key means "not set on the command line". Read it through the Setting reads below; only the two pattern lists are read directly (sensitive.ts). */`

- [ ] **Step 2: Replace the comment at `src/cli.ts:212-216` with**

```ts
    // `--http-host` and `--api-key` are returned to the caller and handed to
    // the server as config. Every other flag lands in the CLI-override store
    // (core/config.ts), whose Setting reads answer flag, else variable, else
    // default for every reader. Nothing writes process.env.
```

- [ ] **Step 3: Verify no reader bypasses config**

Run: `git grep -nE "process\.env\['FS_(LOG_LEVEL|MAX_FILE_SIZE|TOOL_TIMEOUT_MS|ROOT_BOUNDARY|ALLOW_MISSING_ROOTS|ALLOW_SENSITIVE|ALLOW_CWD_WALK)'\]" -- src`
Expected: every hit is in `src/core/config.ts`. (`src/core/path-discovery.ts` reads `FS_ROOT_BOUNDARY` through a variable name, only when no `rawValue` is passed; this grep does not see it and it stays.)

Run: `git grep -nE "cli\.(logLevel|maxFileSize|toolTimeout|rootBoundary|allowSensitive|allowCwdWalk|allowMissingRoots|allowCwd)\b" -- src`
Expected: hits only in `src/core/config.ts` (reads) and `src/cli.ts` (the `cli.x = ...` assignments in `parseArgs`).

Run: `git grep -nE "^import .* from '\./" -- src/core/config.ts`
Expected: one line, `./path-utils.ts`.

- [ ] **Step 4: Full check, with the contract snapshot untouched**

Run, with no `FS_*` variables set: `npm run check`
Expected: exit 0.

Run: `git diff --exit-code main -- __tests__/contract.test.ts.snapshot`
Expected: exit 0, no output.

- [ ] **Step 5: Refresh the knowledge graph**

Run: `graphify update .`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src __tests__
git commit -m "docs(config): describe config as the owner of settings"
```
