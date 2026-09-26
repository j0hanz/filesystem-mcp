import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { cli } from '../src/core/config.ts';
import { ErrorCode, isFsError } from '../src/core/errors.ts';
import type { PathGuard } from '../src/core/path.ts';
import { SensitiveMatcher } from '../src/core/sensitive.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  makeGuard,
  trySymlink,
  withEnv,
  writeTestFile,
} from './helpers.ts';

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
          assert.match(err.message, /--allow-sensitive/);
          assert.match(err.message, /FS_ALLOW_SENSITIVE=1/);
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

    it('TC-SEC-020: a sibling whose name starts with the root name and a backslash stays outside', async (t) => {
      if (process.platform === 'win32') {
        t.skip('backslash is a separator on Windows');
        return;
      }

      const sibling = `${root}\\secret.txt`;
      const siblingDir = `${root}\\dir`; // one literal backslash, as above

      await writeFile(sibling, 'outside');
      await mkdir(siblingDir);
      await writeFile(join(siblingDir, 'f.txt'), 'x');

      try {
        await assert.rejects(
          guard.validateExistingPath(sibling),
          (err) => {
            assert(isFsError(err));
            assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
            return true;
          },
          'Should reject a sibling file named "<root>\\secret.txt"',
        );

        await assert.rejects(
          guard.validatePathForWrite(sibling),
          (err) => {
            assert(isFsError(err));
            assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
            return true;
          },
          'Should reject writing to a sibling file named "<root>\\secret.txt"',
        );

        await assert.rejects(
          guard.validatePathForDelete(join(siblingDir, 'f.txt')),
          (err) => {
            assert(isFsError(err));
            assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
            return true;
          },
          'Should reject deleting inside a sibling directory named "<root>\\dir"',
        );
      } finally {
        await rm(sibling, { force: true });
        await rm(siblingDir, { recursive: true, force: true });
      }
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
    // Pin env vars via helpers.withEnv for the duration of one block and
    // restore them after. FS_ALLOW_SENSITIVE is always pinned so a developer
    // machine running with it set cannot flip these assertions. Why the
    // restore is a finally and never t.after (FIFO hook ordering) is pinned
    // in withEnv's doc in helpers.ts.

    it('TC-ALLOW-001: an allow pattern relieves only the built-ins it matches', () => {
      const matcher = new SensitiveMatcher(['.env', '.env.*'], ['.env.example']);
      assert.strictEqual(
        matcher.isSensitive('.env.example'),
        false,
        'allow entry should lift the .env.* hit on .env.example',
      );
      assert.strictEqual(matcher.isSensitive('.env'), true, '.env itself stays sensitive');
    });

    it('TC-ALLOW-002: FS_ALLOWLIST relieves built-ins via the default construction', async () => {
      await withEnv(
        { FS_ALLOWLIST: '.env.example, dev.pem', FS_ALLOW_SENSITIVE: undefined },
        () => {
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
        },
      );
    });

    it('TC-ALLOW-003: FS_DENYLIST entries are never relieved by an allow pattern', async () => {
      await withEnv(
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

    it('TC-ALLOW-005: a typo in the allow pattern fails closed', async () => {
      await withEnv({ FS_ALLOWLIST: 'env.example', FS_ALLOW_SENSITIVE: undefined }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(
          matcher.isSensitive('.env.example'),
          true,
          'a non-matching allow pattern must not relieve anything',
        );
      });
    });

    it('TC-ALLOW-006: without an allow list the built-ins apply exactly as before', async () => {
      await withEnv({ FS_ALLOWLIST: undefined, FS_ALLOW_SENSITIVE: undefined }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('.env.example'), true);
        assert.strictEqual(matcher.isSensitive('.env'), true);
      });
    });

    it('TC-ALLOW-007: FS_ALLOW_SENSITIVE still suppresses all built-ins regardless of allow entries', async () => {
      await withEnv({ FS_ALLOW_SENSITIVE: '1', FS_ALLOWLIST: '.env.example' }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('.env'), false);
        assert.strictEqual(matcher.isSensitive('.env.example'), false);
      });
    });

    it('TC-ALLOW-008: wildcard denies match hidden files (dot segments match like any other)', async () => {
      await withEnv({ FS_DENYLIST: 'secrets/**', FS_ALLOW_SENSITIVE: '1' }, () => {
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
      await withEnv({ FS_DENYLIST: '**', FS_ALLOW_SENSITIVE: '1' }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('/root/.htpasswd'), true);
      });
    });

    it('TC-ALLOW-009: built-in star patterns deny dot-leading basenames', async () => {
      await withEnv({ FS_ALLOW_SENSITIVE: undefined, FS_DENYLIST: undefined }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('.id_rsa'), true, '*id_rsa* must match .id_rsa');
        assert.strictEqual(matcher.isSensitive('.key'), true, '*.key must match .key');
        assert.strictEqual(matcher.isSensitive('server.pem'), true);
      });
    });

    it('TC-ALLOW-010: wildcard allow relief reaches hidden files', async () => {
      await withEnv({ FS_ALLOWLIST: 'fixtures/**', FS_ALLOW_SENSITIVE: undefined }, () => {
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

    it('TC-ALLOW-013: path-tier patterns still match UNC-style double-slash roots', async () => {
      await withEnv({ FS_ALLOW_SENSITIVE: undefined, FS_DENYLIST: undefined }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(
          matcher.isSensitive('//server/share/.aws/credentials'),
          true,
          'builtin path-tier deny must match a UNC allowed root',
        );
      });
      await withEnv({ FS_DENYLIST: 'secrets/**', FS_ALLOW_SENSITIVE: '1' }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('//server/share/secrets/.env'), true);
        assert.strictEqual(matcher.isSensitive('//server/share/public/readme.txt'), false);
      });
    });

    it('TC-ALLOW-014: brace alternatives in env lists survive the comma split', async () => {
      // '*.{pem,key}' is one pattern, not '*.{pem' + 'key}' — the depth-0
      // split must not tear a documented brace group apart.
      await withEnv(
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
      await withEnv({ FS_DENYLIST: '*.{pem,key}', FS_ALLOW_SENSITIVE: '1' }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('server.pem'), true);
        assert.strictEqual(matcher.isSensitive('server.key'), true);
      });
    });

    it('TC-ALLOW-015: metacharacters inside [...] classes are members, not brace syntax', () => {
      // '[{}].env' means the two names '{.env' and '}.env' — '{' and '}' are
      // class members, not brace syntax, so the scanners must skip the class
      // interior or the deny silently tears apart and fails open. ',' is NOT
      // a member of this class: '[{}]' does not match a comma.
      const matcher = new SensitiveMatcher(['[{}].env']);
      assert.strictEqual(matcher.isSensitive('}.env'), true);
      assert.strictEqual(matcher.isSensitive('{.env'), true);
      assert.strictEqual(matcher.isSensitive(',.env'), false);
      assert.strictEqual(matcher.isSensitive('x.env'), false);

      // A class inside a brace group keeps its comma through the split.
      const nested = new SensitiveMatcher(['*.{[1,2],old}']);
      assert.strictEqual(nested.isSensitive('a.1'), true);
      assert.strictEqual(nested.isSensitive('a.2'), true);
      assert.strictEqual(nested.isSensitive('a.old'), true);
      assert.strictEqual(nested.isSensitive('a.new'), false);
    });

    it('TC-ALLOW-016: terminal ** denies match paths containing newlines', async () => {
      // '.' never matches a newline without the regex 's' flag, so a deny
      // ending in '/**' must compile its globstar newline-safe — filenames
      // can legally contain '\n' on both POSIX and NTFS.
      await withEnv({ FS_DENYLIST: 'secrets/**', FS_ALLOW_SENSITIVE: '1' }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('/r/secrets/plan\nnotes'), true);
        assert.strictEqual(matcher.isSensitive('/r/secrets/plan\rnotes'), true);
        assert.strictEqual(matcher.isSensitive('/r/public/plan\nnotes'), false);
      });
    });

    it('TC-ALLOW-017: class commas in env lists survive the split', async () => {
      // 'x[1,2].env' is one pattern: the depth-0 comma split must skip the
      // class interior, matching the --deny flag's behavior for the same
      // pattern instead of tearing into 'x[1' and '2].env'.
      await withEnv({ FS_DENYLIST: 'x[1,2].env', FS_ALLOW_SENSITIVE: '1' }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('/r/x1.env'), true);
        assert.strictEqual(matcher.isSensitive('/r/x2.env'), true);
        assert.strictEqual(matcher.isSensitive('/r/x3.env'), false);
      });
    });

    it('TC-ALLOW-018: --deny/--allow flag tiers follow the same relief rules as env', async () => {
      // The flag tier (cli.denyPatterns/cli.allowPatterns) merges into the
      // same two tiers as the env vars — an explicit --deny is never
      // relieved by --allow, and --allow relieves built-ins only.
      await withEnv(
        { FS_ALLOW_SENSITIVE: undefined, FS_DENYLIST: undefined, FS_ALLOWLIST: undefined },
        () => {
          const savedDeny = cli.denyPatterns ?? [];
          const savedAllow = cli.allowPatterns ?? [];
          try {
            cli.denyPatterns = ['.env.example'];
            cli.allowPatterns = ['.env.example'];
            const denied = new SensitiveMatcher();
            assert.strictEqual(
              denied.isSensitive('.env.example'),
              true,
              'an explicit --deny must never be relieved by --allow',
            );

            cli.denyPatterns = [];
            const relieved = new SensitiveMatcher();
            assert.strictEqual(relieved.isSensitive('.env.example'), false);
            assert.strictEqual(
              relieved.isSensitive('.env'),
              true,
              'flag allow relief stays scoped to the listed pattern',
            );
          } finally {
            cli.denyPatterns = savedDeny;
            cli.allowPatterns = savedAllow;
          }
        },
      );
    });

    it('TC-ALLOW-019: a leading ] in a class is a literal member', () => {
      // '[]a].env' has members ']' and 'a' — classEnd keeps the leading ']'
      // and the regex translation must escape it, or the 'u' flag parses
      // '[]a]' as an empty class plus stray literals and the deny fails open.
      const bracket = new SensitiveMatcher(['[]a].env']);
      assert.strictEqual(bracket.isSensitive('].env'), true);
      assert.strictEqual(bracket.isSensitive('a.env'), true);
      assert.strictEqual(bracket.isSensitive('b.env'), false);
      // '[!]].env': negated class of ']' — matches anything except ']'.
      const negated = new SensitiveMatcher(['[!]].env']);
      assert.strictEqual(negated.isSensitive('x.env'), true);
      assert.strictEqual(negated.isSensitive('].env'), false);
      // '[^].env': '^' is a literal member (glob negation is '!' only) —
      // unescaped it would become the JS any-character class and match
      // 'x.env' too, over-relieving on the allow side.
      const caret = new SensitiveMatcher(['[^].env']);
      assert.strictEqual(caret.isSensitive('^.env'), true);
      assert.strictEqual(caret.isSensitive('x.env'), false);
    });

    it('TC-ALLOW-022: an unbalanced brace in an env list drops only itself', async () => {
      // '{bad, secrets/**' has no closing brace; the brace-aware split must
      // not swallow every separator behind it into one bogus literal and
      // silently drop the real 'secrets/**' deny.
      await withEnv({ FS_DENYLIST: '{bad, secrets/**', FS_ALLOW_SENSITIVE: '1' }, () => {
        const unmatchedOpen = new SensitiveMatcher();
        assert.strictEqual(unmatchedOpen.isSensitive('/r/secrets/plan'), true);
        assert.strictEqual(unmatchedOpen.isSensitive('/r/public/plan'), false);
      });
      await withEnv({ FS_DENYLIST: 'x}, secrets/**', FS_ALLOW_SENSITIVE: '1' }, () => {
        const strayClose = new SensitiveMatcher();
        assert.strictEqual(strayClose.isSensitive('/r/secrets/plan'), true);
        assert.strictEqual(strayClose.isSensitive('/r/public/plan'), false);
      });
    });

    it('TC-ALLOW-020: absolute patterns stay rooted — no **/ alias over-relief', async () => {
      // '/abs/secret' must not gain the '**/abs/secret' unrooted alias: that
      // matches 'other/abs/secret' too, and on the allow side it relieves
      // files the operator never named.
      await withEnv({ FS_DENYLIST: '/abs/secret', FS_ALLOW_SENSITIVE: '1' }, () => {
        const deny = new SensitiveMatcher();
        assert.strictEqual(deny.isSensitive('/abs/secret'), true);
        assert.strictEqual(deny.isSensitive('/x/abs/secret'), false);
      });
      await withEnv({ FS_ALLOWLIST: '/r/ok.pem' }, () => {
        const allow = new SensitiveMatcher();
        assert.strictEqual(allow.isSensitive('/r/ok.pem'), false);
        assert.strictEqual(allow.isSensitive('/x/r/ok.pem'), true);
        assert.strictEqual(allow.isSensitive('/r/other.pem'), true);
      });
    });

    it('TC-ALLOW-021: mid-pattern ** matches zero or more whole segments', async () => {
      // 'secrets/**/credentials' denies secrets/credentials and any depth of
      // subdirectory under secrets/ — the globstar consumes its separator,
      // so no double slash may sneak into the compiled regex.
      await withEnv({ FS_DENYLIST: 'secrets/**/credentials', FS_ALLOW_SENSITIVE: '1' }, () => {
        const matcher = new SensitiveMatcher();
        assert.strictEqual(matcher.isSensitive('/r/secrets/credentials'), true);
        assert.strictEqual(matcher.isSensitive('/r/secrets/a/credentials'), true);
        assert.strictEqual(matcher.isSensitive('/r/secrets/a/b/credentials'), true);
        assert.strictEqual(matcher.isSensitive('/r/credentials'), false);
      });
    });
  });

  describe('helpers.withEnv restore semantics', () => {
    it('withEnv restores unset by deleting and empty string as set', async () => {
      Reflect.deleteProperty(process.env, 'FS_PIN_TEST');
      await withEnv({ FS_PIN_TEST: 'x' }, () => {
        assert.strictEqual(process.env['FS_PIN_TEST'], 'x');
      });
      assert.ok(!('FS_PIN_TEST' in process.env));
      process.env['FS_PIN_TEST'] = '';
      await withEnv({ FS_PIN_TEST: 'x' }, () => {
        assert.strictEqual(process.env['FS_PIN_TEST'], 'x');
      });
      assert.strictEqual(process.env['FS_PIN_TEST'], '');
      Reflect.deleteProperty(process.env, 'FS_PIN_TEST');
    });
  });
});
