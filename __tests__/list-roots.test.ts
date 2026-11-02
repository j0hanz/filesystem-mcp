import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { normalizePath } from '../src/core/path-utils.ts';
import { LIST_ROOTS } from '../src/tools/index.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  type TestClientContext,
} from './helpers.ts';
import { runToolBodyResult } from './tool-harness.ts';

// Payload assembly, driven through the tool body with no MCP pair; the wire
// tier below pins the response placement the executor adds.
describe('list_roots body', () => {
  let root: string;

  before(async () => {
    root = await createTestRoot();
  });

  after(async () => {
    await cleanupTestRoot(root);
  });

  it('reports the configured roots with no hint', async () => {
    const result = await runToolBodyResult(LIST_ROOTS, {}, { roots: [root] });
    // getRoots reports the canonical spelling (lowercase drive on Windows).
    assert.deepStrictEqual(result.structured.roots, [normalizePath(root)]);
    assert.strictEqual(result.structured.readOnlyDirs.length, 0);
    assert.strictEqual(result.structured.hint, undefined, 'a configured server pays for no hint');
  });

  it('with no roots says how to configure them', async () => {
    // An empty `roots` reports the problem; without this the caller learns
    // nothing about the fix, and the elicitation route out is in no description.
    const result = await runToolBodyResult(LIST_ROOTS, {});
    assert.deepStrictEqual(result.structured.roots, []);
    assert.match(result.structured.hint ?? '', /FS_ALLOWED_DIRS/);
    assert.match(result.structured.hint ?? '', /--allow-cwd/);
    assert.match(result.structured.hint ?? '', /approve the requested grant/);
  });
});

// list_roots is a data tool: no authored text, so the JSON is the model-facing
// view and ships as structuredContent (#TC-FUNC-052).
describe('list_roots over the wire', () => {
  let root: string;
  let harness: TestClientContext;

  before(async () => {
    root = await createTestRoot();
    harness = await createTestClientPair([root]);
  });

  after(async () => {
    await harness.close();
    await cleanupTestRoot(root);
  });

  it('ships the roots as structuredContent', async () => {
    const result = await harness.client.callTool({ name: 'list_roots' });
    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as { roots?: string[]; hint?: string } | undefined;
    assert.ok((structured?.roots?.length ?? 0) > 0, 'Should have at least one allowed directory');
    assert.strictEqual(structured?.hint, undefined, 'a configured server pays for no hint');
  });
});
