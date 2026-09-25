import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ALL_TOOLS } from '../src/tools/index.ts';

describe('MCPB manifest', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../mcpb/manifest.json', import.meta.url), 'utf8'),
  ) as { version: string; tools: { name: string }[] };
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
});
