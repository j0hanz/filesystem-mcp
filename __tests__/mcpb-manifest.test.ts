import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ALL_TOOLS } from '../src/tools/index.ts';

describe('MCPB manifest', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../mcpb/manifest.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
    tools: { name: string }[];
    server: { mcp_config: { env: Record<string, string> } };
    user_config: Record<string, { title: string; description: string }>;
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

  it('MCPB-007: the read-only folders example is a real value', () => {
    const text = manifest.user_config['read_only_dirs']?.description ?? '';
    assert.ok(text.includes('C:\\Work\\docs;C:\\Work\\archive'));
    assert.ok(text.includes('/Users/me/docs:/Users/me/archive'));
  });
});
