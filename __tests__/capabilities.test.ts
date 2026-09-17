import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  type TestClientContext,
} from './helpers.ts';

describe('Capability Negotiation', () => {
  let tmpDir: string;
  let harness: TestClientContext;

  before(async () => {
    tmpDir = await createTestRoot();
    harness = await createTestClientPair([tmpDir]);
  });

  after(async () => {
    await harness.close();
    await cleanupTestRoot(tmpDir);
  });

  it('CAP-001: initialize advertises the exact capability sub-flags', () => {
    const capabilities = harness.client.getServerCapabilities();
    assert.ok(capabilities, 'server capabilities should be negotiated');
    assert.strictEqual(capabilities.resources?.subscribe, true, 'resources.subscribe');
    assert.strictEqual(capabilities.resources?.listChanged, true, 'resources.listChanged');
    assert.strictEqual(capabilities.tools?.listChanged, true, 'tools.listChanged');
    assert.strictEqual(capabilities.prompts?.listChanged, true, 'prompts.listChanged');
    assert.ok(capabilities.completions, 'completions capability should be present');
  });

  it('CAP-002: initialize returns instructions naming filesystem-mcp', () => {
    const instructions = harness.client.getInstructions();
    assert.ok(
      instructions?.includes('filesystem-mcp'),
      'instructions should mention filesystem-mcp',
    );
  });
});
