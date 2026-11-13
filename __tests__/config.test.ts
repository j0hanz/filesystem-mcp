import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cli,
  type CliOverrides,
  getAllowCwd,
  getAllowCwdWalk,
  getAllowMissingRoots,
  getAllowSensitive,
  getLogLevel,
  getMaxTextFileSize,
  getRootBoundary,
  getToolTimeoutMs,
  type LoggingLevel,
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
