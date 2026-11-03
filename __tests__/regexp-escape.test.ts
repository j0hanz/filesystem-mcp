import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { escapeRegExpFallback } from '../src/core/util.ts';
import {
  ALL_REGISTERED_TOOL_NAMES,
  cleanupTestRoot,
  createStdioClient,
  createTestRoot,
} from './helpers.ts';

// Node 22 has no RegExp.escape (it shipped in Node 24). Directory sandboxes
// such as mcp.so's "Fetch tools" run the published package on Node 22, where
// the sensitive-file matcher used to crash the server at startup.
const WITHOUT_NATIVE_ESCAPE = {
  NODE_OPTIONS: '--import=data:text/javascript,delete%20RegExp.escape',
};

describe('RegExp.escape fallback', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await createTestRoot();
  });

  after(async () => {
    await cleanupTestRoot(tmpDir);
  });

  it('fallback output matches native RegExp.escape', () => {
    const ascii = Array.from({ length: 0x80 }, (_, code) => String.fromCharCode(code));
    const inputs = [
      '',
      ...ascii,
      ...ascii.map((ch) => `_${ch}`),
      'a-b.c',
      '1.5',
      'foo(bar)?',
      '\u00a0\u2028\u2029\ufeff\u3000',
      'caf\u00e9 \u65e5\u672c',
      '\u{1f600}',
      'x\ud800y',
      '\udc00',
    ];
    // Native RegExp.escape (Node 24+) is the independent oracle.
    const mismatches = inputs.filter((s) => escapeRegExpFallback(s) !== RegExp.escape(s));
    assert.deepEqual(
      mismatches.map((s) => JSON.stringify(s)),
      [],
    );
  });

  it('stdio server starts and lists every tool when RegExp.escape is missing', async () => {
    const harness = await createStdioClient(tmpDir, WITHOUT_NATIVE_ESCAPE);
    try {
      const { tools } = await harness.client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [...ALL_REGISTERED_TOOL_NAMES].sort());
    } finally {
      await harness.close();
    }
  });
});
