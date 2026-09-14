import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.js';
import type { PathGuard } from '../src/core/path.js';
import { SensitiveMatcher } from '../src/core/sensitive.js';
import {
  cleanupTestRoot,
  createTestRoot,
  makeGuard,
  trySymlink,
  writeTestFile,
} from './helpers.js';

describe('Security (P0)', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTestRoot();
  });

  afterEach(async () => {
    if (root) {
      await cleanupTestRoot(root);
    }
  });

  describe('PathGuard boundary enforcement', () => {
    let guard: PathGuard;

    beforeEach(async () => {
      guard = await makeGuard([root]);
    });

    it('TC-SEC-005: Blocks directory traversal via ..', async () => {
      const traversePath = join(root, '..', '..', '..', 'etc', 'passwd');

      await assert.rejects(
        guard.validateExistingPath(traversePath),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
          return true;
        },
        'Should reject traversal outside allowed root',
      );
    });

    it('TC-SEC-006: Blocks symlink escape', async (t) => {
      const linkPath = join(root, 'escape_link');
      const outsideTarget = tmpdir();

      if (!(await trySymlink(outsideTarget, linkPath, () => t.skip('symlink not permitted'))))
        return;

      await assert.rejects(
        guard.validateExistingPath(linkPath),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
          return true;
        },
        'Should reject paths accessed through a symlink escaping the root',
      );
    });

    it('TC-SEC-007: Blocks absolute path outside root', async () => {
      const outsidePath = resolve(tmpdir(), 'some-other-dir', 'file.txt');

      await assert.rejects(
        guard.validateExistingPath(outsidePath),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
          return true;
        },
        'Should reject absolute paths completely outside the root',
      );
    });

    it('TC-SEC-008: Blocks access to sensitive file .env', async () => {
      const envPath = await writeTestFile(root, '.env', 'SECRET=1');

      await assert.rejects(
        guard.validateExistingPath(envPath),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
          return true;
        },
        'Should reject access to .env',
      );
    });

    it('TC-SEC-009: Blocks access to sensitive file *.pem', async () => {
      const pemPath = await writeTestFile(root, 'server.pem', 'KEY');

      await assert.rejects(
        guard.validateExistingPath(pemPath),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
          return true;
        },
        'Should reject access to *.pem',
      );
    });

    it('TC-SEC-010: Blocks access to sensitive file *id_rsa*', async () => {
      const rsaPath = await writeTestFile(root, 'id_rsa', 'KEY');

      await assert.rejects(
        guard.validateExistingPath(rsaPath),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
          return true;
        },
        'Should reject access to id_rsa',
      );
    });
  });

  describe('SensitiveMatcher directly', () => {
    it('TC-SEC-011: Prevents NTFS ADS bypass attempt', (t) => {
      const matcher = new SensitiveMatcher();
      if (process.platform !== 'win32') {
        t.skip('NTFS ADS stripping is Windows-only');
        return;
      }
      assert.strictEqual(matcher.isSensitive('.env:stream'), true);
    });

    it('TC-SEC-012: FS_ALLOW_SENSITIVE=1 override allows sensitive files', () => {
      const matcher = new SensitiveMatcher([]);
      assert.strictEqual(
        matcher.isSensitive('.env'),
        false,
        'Should allow .env when patterns are empty',
      );
      assert.strictEqual(matcher.isSensitive('server.pem'), false);
    });

    it('TC-SEC-013: Custom FS_DENYLIST rules', () => {
      const matcher = new SensitiveMatcher(['*.secret']);
      assert.strictEqual(matcher.isSensitive('data.secret'), true, 'Should match custom pattern');
      assert.strictEqual(
        matcher.isSensitive('data.txt'),
        false,
        'Should not match unrelated files',
      );
    });
  });

  describe('SensitiveMatcher directly (extended)', () => {
    it('TC-SENS-001: path-glob pattern matches under any parent via **/ prefix', () => {
      const matcher = new SensitiveMatcher(['.aws/credentials']);
      assert.strictEqual(
        matcher.isSensitive('/home/u/.aws/credentials'),
        true,
        'non-rooted path pattern should match under any parent via **/ prefix',
      );
    });

    it('TC-SENS-002: path-glob pattern does not match a sibling of the pattern dir', () => {
      const matcher = new SensitiveMatcher(['.aws/credentials']);
      assert.strictEqual(
        matcher.isSensitive('/home/u/other'),
        false,
        'should not match an unrelated path',
      );
    });

    it('TC-SENS-003: rooted path glob does NOT get the **/ prefix', () => {
      const matcher = new SensitiveMatcher(['/abs/path/secret']);
      assert.strictEqual(
        matcher.isSensitive('/abs/path/secret'),
        true,
        'rooted pattern should match the exact absolute path',
      );
      assert.strictEqual(
        matcher.isSensitive('other/secret'),
        false,
        'rooted pattern must NOT match via **/ prefix on unrelated parents',
      );
    });

    it('TC-SENS-004: default .mcpregistry_*_token pattern matches', () => {
      const matcher = new SensitiveMatcher();
      assert.strictEqual(
        matcher.isSensitive('.mcpregistry_github_token'),
        true,
        'default .mcpregistry_*_token pattern should match',
      );
    });

    it('TC-SENS-005: trailing dot/space is trimmed before matching on Windows', (t) => {
      if (process.platform !== 'win32') {
        t.skip('trailing dot/space trim is Windows-only (Win32 syscall boundary)');
        return;
      }
      const matcher = new SensitiveMatcher();
      // Win32 strips trailing dots/spaces at the syscall boundary, so ".env "
      // and ".env." create ".env". The matcher trims before denylist matching
      // or the exact-name patterns are bypassed.
      assert.strictEqual(matcher.isSensitive('.env '), true, '".env " should be caught as ".env"');
      assert.strictEqual(matcher.isSensitive('.env.'), true, '".env." should be caught as ".env"');
    });
  });

  describe('SensitiveMatcher allow-list relief (--allow / FS_ALLOWLIST)', () => {
    // Pin env vars for the duration of one test and restore them after.
    // FS_ALLOW_SENSITIVE is always pinned so a developer machine running
    // with it set cannot flip these assertions.
    const withEnv = (
      t: TestContext,
      vars: Record<string, string | undefined>,
      run: () => void,
    ): void => {
      const saved: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(vars)) {
        saved[name] = process.env[name];
        // Reflect over `delete`: unset must mean the key is gone entirely.
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
      t.after(() => {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) Reflect.deleteProperty(process.env, name);
          else process.env[name] = value;
        }
      });
      run();
    };

    it('TC-ALLOW-001: an allow pattern relieves only the built-ins it matches', () => {
      const matcher = new SensitiveMatcher(['.env', '.env.*'], ['.env.example']);
      assert.strictEqual(
        matcher.isSensitive('.env.example'),
        false,
        'allow entry should lift the .env.* hit on .env.example',
      );
      assert.strictEqual(matcher.isSensitive('.env'), true, '.env itself stays sensitive');
    });

    it('TC-ALLOW-002: FS_ALLOWLIST relieves built-ins via the default construction', (t) => {
      withEnv(t, { FS_ALLOWLIST: '.env.example, dev.pem', FS_ALLOW_SENSITIVE: undefined }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('.env.example'), false);
        assert.strictEqual(matcher.isSensitive('dev.pem'), false);
        assert.strictEqual(matcher.isSensitive('.env'), true);
        assert.strictEqual(
          matcher.isSensitive('server.pem'),
          true,
          'allow relief is per-pattern, not a global switch',
        );
        assert.strictEqual(
          matcher.isSensitive('.env.development'),
          true,
          'allow is exact-pattern, not prefix-wide',
        );
      });
    });

    it('TC-ALLOW-003: FS_DENYLIST entries are never relieved by an allow pattern', (t) => {
      withEnv(
        t,
        {
          FS_DENYLIST: '.env.example',
          FS_ALLOWLIST: '.env.example',
          FS_ALLOW_SENSITIVE: undefined,
        },
        () => {
          const matcher = new SensitiveMatcher();
          assert.strictEqual(
            matcher.isSensitive('.env.example'),
            true,
            'explicit deny always beats allow',
          );
        },
      );
    });

    it('TC-ALLOW-004: Windows spellings of an allowed name stay relieved; denied names stay denied', (t) => {
      if (process.platform !== 'win32') {
        t.skip('ADS stripping and trailing-dot trim are Windows-only');
        return;
      }
      const matcher = new SensitiveMatcher(['.env', '.env.*'], ['.env.example']);
      assert.strictEqual(
        matcher.isSensitive('.env.example '),
        false,
        'trailing-space spelling strips to the allowed name',
      );
      assert.strictEqual(
        matcher.isSensitive('.env.example:stream'),
        false,
        'ADS spelling strips to the allowed name',
      );
      assert.strictEqual(
        matcher.isSensitive('.env '),
        true,
        'trailing-space spelling of .env still denied',
      );
      assert.strictEqual(
        matcher.isSensitive('.env:stream'),
        true,
        'ADS spelling of .env still denied',
      );
    });

    it('TC-ALLOW-005: a typo in the allow pattern fails closed', (t) => {
      withEnv(t, { FS_ALLOWLIST: 'env.example', FS_ALLOW_SENSITIVE: undefined }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(
          matcher.isSensitive('.env.example'),
          true,
          'a non-matching allow pattern must not relieve anything',
        );
      });
    });

    it('TC-ALLOW-006: without an allow list the built-ins apply exactly as before', (t) => {
      withEnv(t, { FS_ALLOWLIST: undefined, FS_ALLOW_SENSITIVE: undefined }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('.env.example'), true);
        assert.strictEqual(matcher.isSensitive('.env'), true);
      });
    });

    it('TC-ALLOW-007: FS_ALLOW_SENSITIVE still suppresses all built-ins regardless of allow entries', (t) => {
      withEnv(t, { FS_ALLOW_SENSITIVE: '1', FS_ALLOWLIST: '.env.example' }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('.env'), false);
        assert.strictEqual(matcher.isSensitive('.env.example'), false);
      });
    });

    it('TC-ALLOW-008: wildcard denies match hidden files (dot segments match like any other)', (t) => {
      withEnv(t, { FS_DENYLIST: 'secrets/**', FS_ALLOW_SENSITIVE: '1' }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(
          matcher.isSensitive('/root/secrets/.env'),
          true,
          'operator wildcard deny must catch dot-leading segments',
        );
        assert.strictEqual(matcher.isSensitive('/root/secrets/.npmrc'), true);
        assert.strictEqual(matcher.isSensitive('/root/secrets/readme.txt'), true);
        assert.strictEqual(matcher.isSensitive('/root/public/.env'), false);
      });
      withEnv(t, { FS_DENYLIST: '**', FS_ALLOW_SENSITIVE: '1' }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('/root/.htpasswd'), true);
      });
    });

    it('TC-ALLOW-009: built-in star patterns deny dot-leading basenames', (t) => {
      withEnv(t, { FS_ALLOW_SENSITIVE: undefined, FS_DENYLIST: undefined }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('.id_rsa'), true, '*id_rsa* must match .id_rsa');
        assert.strictEqual(matcher.isSensitive('.key'), true, '*.key must match .key');
        assert.strictEqual(matcher.isSensitive('server.pem'), true);
      });
    });

    it('TC-ALLOW-010: wildcard allow relief reaches hidden files', (t) => {
      withEnv(t, { FS_ALLOWLIST: 'fixtures/**', FS_ALLOW_SENSITIVE: undefined }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(
          matcher.isSensitive('/r/fixtures/.env.example'),
          false,
          'wildcard allow must relieve dot-leading segments too',
        );
        assert.strictEqual(matcher.isSensitive('/r/fixtures/dev.pem'), false);
        assert.strictEqual(
          matcher.isSensitive('/r/other/.env.example'),
          true,
          'relief is still scoped to the allow pattern',
        );
      });
    });

    it('TC-ALLOW-011: brace alternation in deny patterns still expands', () => {
      const matcher = new SensitiveMatcher(['*.{pem,key}']);
      assert.strictEqual(matcher.isSensitive('server.pem'), true);
      assert.strictEqual(matcher.isSensitive('server.key'), true);
      assert.strictEqual(matcher.isSensitive('server.crt'), false);
    });

    it('TC-ALLOW-012: nested brace groups expand every alternative', () => {
      const matcher = new SensitiveMatcher(['data/{x,{y,z}}/secret']);
      assert.strictEqual(matcher.isSensitive('/root/data/x/secret'), true);
      assert.strictEqual(matcher.isSensitive('/root/data/y/secret'), true);
      assert.strictEqual(matcher.isSensitive('/root/data/z/secret'), true);
      assert.strictEqual(matcher.isSensitive('/root/data/w/secret'), false);
    });

    it('TC-ALLOW-013: path-tier patterns still match UNC-style double-slash roots', (t) => {
      withEnv(t, { FS_ALLOW_SENSITIVE: undefined, FS_DENYLIST: undefined }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(
          matcher.isSensitive('//server/share/.aws/credentials'),
          true,
          'builtin path-tier deny must match a UNC allowed root',
        );
      });
      withEnv(t, { FS_DENYLIST: 'secrets/**', FS_ALLOW_SENSITIVE: '1' }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('//server/share/secrets/.env'), true);
        assert.strictEqual(matcher.isSensitive('//server/share/public/readme.txt'), false);
      });
    });

    it('TC-ALLOW-014: brace alternatives in env lists survive the comma split', (t) => {
      // '*.{pem,key}' is one pattern, not '*.{pem' + 'key}' — the depth-0
      // split must not tear a documented brace group apart.
      withEnv(
        t,
        { FS_ALLOWLIST: '*.{pem,key}, .env.example', FS_ALLOW_SENSITIVE: undefined },
        () => {
          const matcher = new SensitiveMatcher();
          assert.strictEqual(matcher.isSensitive('server.pem'), false);
          assert.strictEqual(matcher.isSensitive('server.key'), false);
          assert.strictEqual(matcher.isSensitive('.env.example'), false);
          assert.strictEqual(
            matcher.isSensitive('.env'),
            true,
            'relief stays scoped to the listed patterns',
          );
        },
      );
      withEnv(t, { FS_DENYLIST: '*.{pem,key}', FS_ALLOW_SENSITIVE: '1' }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('server.pem'), true);
        assert.strictEqual(matcher.isSensitive('server.key'), true);
      });
    });
  });
});
