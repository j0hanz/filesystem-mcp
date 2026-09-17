import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { normalizePath } from '../src/core/path-utils.ts';
import {
  ALL_REGISTERED_TOOL_NAMES,
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  writeTestFile,
} from './helpers.ts';

describe('Smoke Tests', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await createTestRoot();
  });

  after(async () => {
    await cleanupTestRoot(tmpDir);
  });

  it('SMOKE-001: Server starts and connects via linked pair', async () => {
    const harness = await createTestClientPair([tmpDir]);
    assert.ok(harness.client, 'harness.client should be defined');
    assert.ok(harness.serverCtx, 'harness.serverCtx should be defined');
    await harness.close();
  });

  it('SMOKE-003: tools/list returns every registered tool via MCP client', async () => {
    const harness = await createTestClientPair([tmpDir]);
    const toolsResult = await harness.client.listTools();
    assert.strictEqual(toolsResult.tools.length, ALL_REGISTERED_TOOL_NAMES.length);
    assert.deepStrictEqual(
      toolsResult.tools.map((t) => t.name).sort(),
      [...ALL_REGISTERED_TOOL_NAMES].sort(),
    );
    await harness.close();
  });

  it('SMOKE-004: list_roots returns allowed dirs via MCP client', async () => {
    const harness = await createTestClientPair([tmpDir]);
    const result = await harness.client.callTool({ name: 'list_roots' });
    assert.notStrictEqual(result.isError, true);

    const structured = result.structuredContent as { roots?: string[] } | undefined;
    assert.ok(structured?.roots, 'should return roots');

    const normalizedTmpDir = normalizePath(tmpDir);
    const hasDir = structured?.roots?.some((d) => normalizePath(d) === normalizedTmpDir);
    assert.ok(hasDir, 'tmpDir should be in allowed directories');

    await harness.close();
  });

  it('SMOKE-005: read returns file content via MCP client', async () => {
    const harness = await createTestClientPair([tmpDir]);
    const filePath = await writeTestFile(tmpDir, 'test.txt', 'Hello, MCP!');
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: filePath },
    });
    assert.notStrictEqual(result.isError, true);

    const firstBlock = firstTextBlock(result);
    assert.strictEqual(firstBlock.type, 'text');
    assert.ok(firstBlock.text?.includes('Hello, MCP!'));
    await harness.close();
  });

  it('SMOKE-006: Path traversal returns isError: true via MCP client', async () => {
    const harness = await createTestClientPair([tmpDir]);
    const badPath = join(tmpDir, '../../../etc/passwd');
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: badPath },
    });

    assert.strictEqual(result.isError, true, 'Path traversal should return isError: true');
    const firstBlock = firstTextBlock(result);
    assert.strictEqual(firstBlock.type, 'text');
    assert.ok(firstBlock.text);
    await harness.close();
  });
});
