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
    user_config: Record<string, unknown>;
  };
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
});
