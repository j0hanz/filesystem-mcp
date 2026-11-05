import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { replaceVariables } from '@anthropic-ai/mcpb';

import { splitReadOnlyRoots } from '../src/cli.ts';
import { ALL_TOOLS } from '../src/tools/index.ts';

describe('MCPB manifest', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../mcpb/manifest.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
    tools: { name: string }[];
    server: { mcp_config: { args: string[]; env: Record<string, string> } };
    user_config: Record<
      string,
      { title: string; description: string; type?: string; multiple?: boolean; default?: unknown }
    >;
  };
  const SECRET_LIST =
    'https://github.com/j0hanz/filesystem-mcp/blob/main/docs/configuration.md#secret-files';
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };

  it('MCPB-001: version tracks package.json', () => {
    assert.equal(manifest.version, pkg.version);
  });

  it('MCPB-002: declares exactly the registered tools', () => {
    const declared = manifest.tools.map((t) => t.name).sort();
    const registered = ALL_TOOLS.map((t) => t.name).sort();
    assert.deepEqual(declared, registered);
  });

  it('MCPB-003: every setting reaches the server', () => {
    const wired = JSON.stringify(manifest.server.mcp_config);
    for (const key of Object.keys(manifest.user_config)) {
      assert.ok(wired.includes(`\${user_config.${key}}`), `${key} is not passed to the server`);
    }
    assert.strictEqual(
      manifest.server.mcp_config.env['FS_ALLOWLIST'],
      '${user_config.allow_patterns}',
    );
  });

  it('MCPB-004: setting keys stay the same, so saved settings survive', () => {
    assert.deepStrictEqual(Object.keys(manifest.user_config), [
      'allowed_directories',
      'read_only',
      'read_only_dirs',
      'deny_patterns',
      'allow_patterns',
    ]);
  });

  it('MCPB-005: settings text is plain enough for the form', () => {
    for (const { title, description } of Object.values(manifest.user_config)) {
      assert.doesNotMatch(`${title} ${description}`, /`|director/i);
    }
  });

  it('MCPB-006: the block settings link the list, and the link has a target', () => {
    const { deny_patterns: deny, allow_patterns: allow } = manifest.user_config;
    assert.ok(deny?.description.includes(SECRET_LIST));
    assert.ok(allow?.description.includes(SECRET_LIST));
    const docs = readFileSync(new URL('../docs/configuration.md', import.meta.url), 'utf8');
    assert.match(docs, /^## Secret files$/m);
  });

  it('MCPB-007: read-only folders use the folder picker', () => {
    const setting = manifest.user_config['read_only_dirs'];
    assert.strictEqual(setting?.type, 'directory');
    assert.strictEqual(setting.multiple, true);
    assert.deepStrictEqual(setting.default, []);
    assert.doesNotMatch(setting.description, /semicolon|colon/);
    assert.match(setting.description, /no effect while Read-only mode is on/);
    assert.strictEqual(manifest.server.mcp_config.env['FS_READ_ONLY_DIRS'], undefined);
  });

  describe('MCPB-011: arguments the host builds', () => {
    const build = (readOnly: string | string[]): ReturnType<typeof splitReadOnlyRoots> => {
      const argv = replaceVariables(manifest.server.mcp_config.args, {
        __dirname: '/x',
        'user_config.allowed_directories': ['/w', '/v'],
        'user_config.read_only_dirs': readOnly,
      }) as string[];
      return splitReadOnlyRoots(argv.slice(1));
    };

    it('keeps chosen folders out of the roots', () => {
      assert.deepStrictEqual(build(['/w/a', '/w/b']), {
        args: ['/w', '/v'],
        readOnlyRoots: ['/w/a', '/w/b'],
      });
    });

    it('adds nothing when no folder is chosen', () => {
      assert.deepStrictEqual(build([]), { args: ['/w', '/v'], readOnlyRoots: [] });
    });

    it('adds nothing for a setting saved empty by the old text field', () => {
      assert.deepStrictEqual(build(''), { args: ['/w', '/v'], readOnlyRoots: [] });
    });
  });

  it('MCPB-008: no example value ends in a period someone could copy', () => {
    const text = Object.values(manifest.user_config)
      .map((setting) => setting.description)
      .join(' ');
    assert.doesNotMatch(text, /(\\archive|\/archive|salaries\.xlsx|debug\.keystore)\./);
  });

  it('MCPB-009: the block setting says how to block a folder, and claims only what is blocked', () => {
    const text = manifest.user_config['deny_patterns']?.description ?? '';
    assert.match(text, /To block a folder, add \/\*\* after its name/);
    // prod.env is open: only .env, .env.* and .envrc are on the list.
    assert.doesNotMatch(text, /Environment files/);
    assert.match(text, /Files such as \.env/);
  });

  it('MCPB-010: the unblock setting says it allows changes in every folder', () => {
    const text = manifest.user_config['allow_patterns']?.description ?? '';
    assert.match(text, /read and change/);
    assert.match(text, /in every allowed folder/);
  });
});
