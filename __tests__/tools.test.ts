import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MAX_SEARCH_RESULTS } from '../src/core/util.js';
import { createServer } from '../src/server.js';
import { ALL_TOOLS, MUTATING_TOOL_NAMES, registeredTools } from '../src/tools/index.js';
import {
  ALL_REGISTERED_TOOL_NAMES,
  bootHttpTest,
  cleanupTestRoot,
  createElicitationClientPair,
  createTestClientPair,
  createTestRoot,
  failedSummary,
  firstTextBlock,
  type TestClientContext,
  trySymlink,
  withBoundary,
  writeTestFile,
} from './helpers.js';

describe('P0 Functional Tests - Tools (MCP Client)', () => {
  let tmpDir: string;
  let harness: TestClientContext;

  before(async () => {
    tmpDir = await createTestRoot();
    harness = await createTestClientPair([tmpDir]);
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
    if (tmpDir) {
      await cleanupTestRoot(tmpDir);
    }
  });

  it('TC-FUNC-001: Read single text file via MCP tool call', async () => {
    const file = join(tmpDir, 'hello.txt');
    await writeFile(file, 'Hello\nWorld\n');

    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: file },
    });
    assert.notStrictEqual(result.isError, true);
    const firstBlock = firstTextBlock(result);
    assert.strictEqual(firstBlock.type, 'text');
    assert.ok(firstBlock.text?.includes('Hello\nWorld\n'));
  });

  it('TC-FUNC-002: Read image file returns an image content block with base64 data', async () => {
    // Minimal 1x1 transparent PNG (known-good bytes).
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
        '890000000d49444154789c63f8cf00000001000100000005defb0a00000000' +
        '49454e44ae426082',
      'hex',
    );
    const file = join(tmpDir, 'pixel.png');
    await writeFile(file, pngBytes);

    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: file },
    });
    assert.notStrictEqual(result.isError, true);

    const imageBlock = (
      result.content as readonly { type: string; data?: string; mimeType?: string }[]
    ).find((b) => b.type === 'image');
    assert.ok(imageBlock, 'expected an image content block');
    assert.strictEqual(imageBlock.mimeType, 'image/png');
    assert.ok(imageBlock.data, 'image block must carry base64 data');
    const data = imageBlock.data;
    assert.ok(typeof data === 'string');
    assert.strictEqual(Buffer.from(data, 'base64').equals(pngBytes), true);

    const structured = result._meta as { results?: { value?: { kind?: string } }[] } | undefined;
    assert.strictEqual(structured?.results?.[0]?.value?.kind, 'image');
  });

  it('TC-FUNC-007: Read path outside allowed root returns isError: true with ACCESS_DENIED', async () => {
    const outsideFile = join(tmpdir(), 'outside_test.txt');
    await writeFile(outsideFile, 'secret');
    try {
      const result = await harness.client.callTool({
        name: 'read',
        arguments: { path: outsideFile },
      });
      assert.strictEqual(result.isError, true);
      const firstBlock = firstTextBlock(result);
      assert.ok(firstBlock.text);
    } finally {
      await rm(outsideFile, { force: true });
    }
  });

  it('TC-FUNC-009: Create single file via MCP tool call', async () => {
    const file = join(tmpDir, 'new.txt');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: file, content: 'new content' }] },
    });
    assert.notStrictEqual(result.isError, true);

    const content = await readFile(file, 'utf-8');
    assert.strictEqual(content, 'new content');
  });

  // An out-of-root path the access-grant pre-check refuses to even offer
  // (isUnsafeCwdPath), so the call reaches the plain ACCESS_DENIED envelope
  // instead of the "this client cannot show a confirmation" one. A grantable
  // out-of-root path (anything under tmpdir) would test the other branch.
  const UNGRANTABLE_DIR = process.platform === 'win32' ? 'C:\\Windows' : '/etc';

  it('TC-FUNC-009b: create reports isError when every requested file was denied', async () => {
    // Regression: create publishes {files, failures} with no `summary`, so the
    // total-failure check keyed on `summary` never fired and a fully-denied
    // write returned a success envelope.
    const outside = join(UNGRANTABLE_DIR, 'fsmcp_create_denied.txt');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: outside, content: 'nope' }] },
    });

    assert.strictEqual(result.isError, true);
    await assert.rejects(access(outside), 'the denied file must not exist');
  });

  it('TC-FUNC-009c: create stays a success when only some files were denied', async () => {
    const ok = join(tmpDir, 'partial.txt');
    const outside = join(UNGRANTABLE_DIR, 'fsmcp_create_partial.txt');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: {
        files: [
          { path: ok, content: 'written' },
          { path: outside, content: 'nope' },
        ],
      },
    });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(ok, 'utf-8'), 'written');
    await assert.rejects(access(outside), 'the denied file must not exist');
  });

  it('TC-FUNC-009d: move reports isError when every requested move was denied', async () => {
    const source = join(tmpDir, 'movable.txt');
    await writeFile(source, 'body');
    const result = await harness.client.callTool({
      name: 'move',
      arguments: {
        moves: [{ source, destination: join(UNGRANTABLE_DIR, 'fsmcp_move_denied.txt') }],
        copy: true,
      },
    });

    assert.strictEqual(result.isError, true);
  });

  it('TC-FUNC-010b: deleting a workspace root names the root, not the parent', async () => {
    // The parent of a root is out-of-root by construction, so the containment
    // check used to answer "Outside allowed directories" for the one directory
    // list_roots reports as allowed.
    const result = await harness.client.callTool({
      name: 'delete',
      arguments: { paths: [tmpDir], recursive: true },
    });

    assert.strictEqual(result.isError, true);
    const text = firstTextBlock(result).text ?? '';
    assert.match(text, /workspace root/i);
    await access(tmpDir);
  });

  it('TC-FUNC-012: --read-only suppresses mutating tools on client.listTools()', async () => {
    const readOnlyHarness = await createTestClientPair([tmpDir], { readOnly: true });
    try {
      const toolsResult = await readOnlyHarness.client.listTools();
      assert.strictEqual(toolsResult.tools.length, registeredTools(true).length);
      for (const tool of toolsResult.tools) {
        assert(!MUTATING_TOOL_NAMES.has(tool.name));
      }

      // Calling a mutating tool on read-only server should reject with -32602
      await assert.rejects(
        async () => {
          await readOnlyHarness.client.callTool({
            name: 'create',
            arguments: { files: [{ path: join(tmpDir, 'fail.txt'), content: 'fail' }] },
          });
        },
        (err: unknown) => {
          return (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code: ProtocolErrorCode }).code === ProtocolErrorCode.InvalidParams
          );
        },
      );
    } finally {
      await readOnlyHarness.close();
    }

    const allTools = registeredTools(false);
    assert.strictEqual(allTools.length, ALL_REGISTERED_TOOL_NAMES.length);
  });

  it('tools/list publishes slimmed schemas and preserves Zod runtime semantics', async () => {
    const pinHarness = await createTestClientPair([tmpDir]);
    try {
      const { tools } = await pinHarness.client.listTools();
      assert.ok(tools.length > 0);
      for (const tool of tools) {
        // The wire copy is slimmed: no $schema, no $defs, no titles.
        assert.strictEqual(
          (tool.inputSchema as { $schema?: string }).$schema,
          undefined,
          `${tool.name} must not publish a $schema key`,
        );
        // `edit` is the deliberate exception: EditSpec is used at two sites in
        // one document, so it carries an `id` and is hoisted (see below).
        if (tool.name !== 'edit') {
          assert.strictEqual(
            (tool.inputSchema as { $defs?: unknown }).$defs,
            undefined,
            `${tool.name} must publish a dereferenced input schema without $defs`,
          );
        }
        assert.strictEqual(
          (tool.outputSchema as { $defs?: unknown } | undefined)?.$defs,
          undefined,
          `${tool.name} must publish a dereferenced output schema without $defs`,
        );
      }

      // Zod defaults still reach the handler: edit applies with dryRun's
      // default (false), so the file on disk actually changes.
      const file = await writeTestFile(tmpDir, 'schema-defaults.txt', 'before body');
      const defaulted = await pinHarness.client.callTool({
        name: 'edit',
        arguments: { path: file, edits: [{ oldText: 'before body', newText: 'after body' }] },
      });
      assert.notStrictEqual(defaulted.isError, true);
      const edited = await readFile(file, 'utf-8');
      assert.strictEqual(edited, 'after body', 'Zod defaults must reach the tool handler');

      // Zod validation still runs with its error messages.
      const invalid = await pinHarness.client.callTool({
        name: 'read',
        arguments: { path: file, head: 0 },
      });
      assert.strictEqual(invalid.isError, true);
      const errorText = firstTextBlock(invalid).text ?? '';
      assert.match(errorText, /head/u);
    } finally {
      await pinHarness.close();
    }
  });

  it('TC-FUNC-013: Edit via MCP tool call', async () => {
    const file = join(tmpDir, 'edit.txt');
    await writeFile(file, 'original content');

    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'original', newText: 'modified' }],
      },
    });
    assert.notStrictEqual(result.isError, true);

    const content = await readFile(file, 'utf-8');
    assert.strictEqual(content, 'modified content');
  });

  it('TC-FUNC-015: Read non-existent file returns error in per-path results', async () => {
    const missing = join(tmpDir, 'missing.txt');
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: missing },
    });
    const structured = failedSummary(result);
    assert.strictEqual(structured?.summary?.failed, 1);
    assert.strictEqual(structured?.results?.[0]?.error?.code, 'NOT_FOUND');
  });

  it('TC-FUNC-017: Delete file via MCP tool call', async () => {
    const file = join(tmpDir, 'delete.txt');
    await writeFile(file, 'to delete');

    const result = await harness.client.callTool({
      name: 'delete',
      arguments: { paths: [file] },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result._meta as
      | {
          results?: { path?: string; value?: { deleted?: boolean } }[];
          summary?: { failed?: number };
        }
      | undefined;
    assert.strictEqual(structured?.summary?.failed, 0);
    assert.strictEqual(structured?.results?.[0]?.value?.deleted, true);

    const readRes = await harness.client.callTool({
      name: 'read',
      arguments: { path: file },
    });
    const readStructured = failedSummary(readRes);
    assert.strictEqual(readStructured?.summary?.failed, 1);
    assert.strictEqual(readStructured?.results?.[0]?.error?.code, 'NOT_FOUND');
  });

  it('TC-FUNC-021: Move/rename via MCP tool call', async () => {
    const file = join(tmpDir, 'old.txt');
    const newFile = join(tmpDir, 'new_name.txt');
    await writeFile(file, 'move me');

    const result = await harness.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: file, destination: newFile }] },
    });
    assert.notStrictEqual(result.isError, true);

    const oldRead = await harness.client.callTool({
      name: 'read',
      arguments: { path: file },
    });
    const oldStructured = failedSummary(oldRead);
    assert.strictEqual(oldStructured?.summary?.failed, 1);

    const newRead = await harness.client.callTool({
      name: 'read',
      arguments: { path: newFile },
    });
    assert.notStrictEqual(newRead.isError, true);
    const block = firstTextBlock(newRead);
    assert.ok(block.text?.includes('move me'));
  });

  it("read's resource_link and resourceUri name the same file", async () => {
    const file = join(tmpDir, 'uri_agreement.txt');
    await writeFile(file, 'content\n');

    // Request it by a path whose case differs from the resolved one. The link
    // used to be rebuilt from the *requested* path while resourceUri came from
    // the validated one, so the two disagreed and each keyed its own watcher.
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: file.replace(/^([a-z]):/iu, (_m, d: string) => `${d.toUpperCase()}:`) },
    });
    assert.notStrictEqual(result.isError, true);

    const structured = result._meta as {
      results?: { value?: { resourceUri?: string } }[];
    };
    const resourceUri = structured.results?.[0]?.value?.resourceUri;
    const link = (result.content as { type: string; uri?: string }[]).find(
      (c) => c.type === 'resource_link',
    );
    assert.ok(resourceUri, 'read must expose a resourceUri');
    assert.strictEqual(link?.uri, resourceUri);
  });

  it('a call where every path failed is reported as isError', async () => {
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { paths: [join(tmpDir, 'no_such_a.txt'), join(tmpDir, 'no_such_b.txt')] },
    });
    assert.strictEqual(result.isError, true, 'no path succeeded, so the call failed');
    assert.strictEqual(failedSummary(result)?.summary?.failed, 2);
  });

  it('a partly-failed batch is not isError', async () => {
    const ok = join(tmpDir, 'partial_ok.txt');
    await writeFile(ok, 'here\n');

    const result = await harness.client.callTool({
      name: 'read',
      arguments: { paths: [ok, join(tmpDir, 'partial_missing.txt')] },
    });
    assert.notStrictEqual(result.isError, true, 'one path really was read');
    assert.strictEqual(failedSummary(result)?.summary?.failed, 1);
  });

  it('TC-FUNC-052: List roots via MCP tool call', async () => {
    const result = await harness.client.callTool({ name: 'list_roots' });
    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as { roots?: string[]; hint?: string } | undefined;
    assert.ok((structured?.roots?.length ?? 0) > 0, 'Should have at least one allowed directory');
    assert.strictEqual(structured?.hint, undefined, 'a configured server pays for no hint');
  });

  it('TC-FUNC-052b: list_roots with no roots says how to configure them', async () => {
    // An empty `roots` reports the problem; without this the caller learns
    // nothing about the fix, and the elicitation route out is in no description.
    const bare = await createTestClientPair([]);
    try {
      const result = await bare.client.callTool({ name: 'list_roots' });
      assert.notStrictEqual(result.isError, true);
      const structured = result.structuredContent as { roots?: string[]; hint?: string };
      assert.deepStrictEqual(structured.roots, []);
      assert.match(structured.hint ?? '', /FS_ALLOWED_DIRS/);
      assert.match(structured.hint ?? '', /--allow-cwd/);
      assert.match(structured.hint ?? '', /approve the requested grant/);
    } finally {
      await bare.close();
    }
  });

  it('TC-FUNC-053: Copy with overwrite: true succeeds when destination exists', async () => {
    const src = join(tmpDir, 'copy_ow_src.txt');
    const dst = join(tmpDir, 'copy_ow_dst.txt');
    await writeFile(src, 'new source');
    await writeFile(dst, 'existing dst');

    const result = await harness.client.callTool({
      name: 'move',
      arguments: {
        moves: [{ source: src, destination: dst }],
        copy: true,
        overwrite: true,
      },
    });
    assert.notStrictEqual(result.isError, true);
    const dstContent = await readFile(dst, 'utf-8');
    assert.strictEqual(dstContent, 'new source');
  });

  it('TC-FUNC-054: Copy single file via MCP tool call', async () => {
    const src = join(tmpDir, 'copy_src.txt');
    const dst = join(tmpDir, 'copy_dst.txt');
    await writeFile(src, 'copy content');

    const result = await harness.client.callTool({
      name: 'move',
      arguments: {
        moves: [{ source: src, destination: dst }],
        copy: true,
      },
    });
    assert.notStrictEqual(result.isError, true);

    const srcContent = await readFile(src, 'utf-8');
    const dstContent = await readFile(dst, 'utf-8');
    assert.strictEqual(srcContent, 'copy content');
    assert.strictEqual(dstContent, 'copy content');
  });

  it('TC-FUNC-055: Copy recursive directory via MCP tool call', async () => {
    const srcDir = join(tmpDir, 'copy_src_dir');
    const dstDir = join(tmpDir, 'copy_dst_dir');
    await mkdir(join(srcDir, 'sub'), { recursive: true });
    await writeFile(join(srcDir, 'file1.txt'), 'file1');
    await writeFile(join(srcDir, 'sub', 'file2.txt'), 'file2');

    const result = await harness.client.callTool({
      name: 'move',
      arguments: {
        moves: [{ source: srcDir, destination: dstDir }],
        copy: true,
      },
    });
    assert.notStrictEqual(result.isError, true);

    const dst1 = await readFile(join(dstDir, 'file1.txt'), 'utf-8');
    const dst2 = await readFile(join(dstDir, 'sub', 'file2.txt'), 'utf-8');
    assert.strictEqual(dst1, 'file1');
    assert.strictEqual(dst2, 'file2');
  });

  it('TC-FUNC-056: Copy out-of-root source returns isError: true with ACCESS_DENIED', async () => {
    const outsideFile = join(tmpdir(), 'outside_copy.txt');
    await writeFile(outsideFile, 'secret');
    try {
      const result = await harness.client.callTool({
        name: 'move',
        arguments: {
          moves: [{ source: outsideFile, destination: join(tmpDir, 'stolen.txt') }],
          copy: true,
        },
      });
      assert.strictEqual(result.isError, true);
    } finally {
      await rm(outsideFile, { force: true });
    }
  });

  it('move and copy both refuse a destination inside the source directory', async () => {
    // `planTransfer` runs ONE containment guard for both ops. Move used to
    // build its own `source + sep` prefix test, which never matched a bare
    // filesystem root; the shared `isPathInsideDirectory` does. Pin both ops so
    // the stricter semantics stay deliberate — a directory moved or copied into
    // its own subtree recurses into itself.
    const srcDir = join(tmpDir, 'selfnest_src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'f.txt'), 'x');
    const inside = join(srcDir, 'nested', 'target');

    for (const copy of [false, true]) {
      const label = `copy=${String(copy)}`;
      const result = await harness.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: srcDir, destination: inside }], copy },
      });
      assert.strictEqual(result.isError, true, `${label} must be refused`);
      const { failures = [] } = result._meta as {
        failures?: { error: { code: string; message: string } }[];
      };
      assert.strictEqual(failures.length, 1, `${label} reports one failure`);
      assert.strictEqual(failures[0]?.error.code, 'INVALID_INPUT', label);
      assert.match(failures[0]?.error.message ?? '', /own subdirectory/, label);
      await assert.rejects(access(inside), `${label} created nothing`);
    }
  });

  it('TC-FUNC-058: list tool declares idempotentHint', () => {
    const listTool = ALL_TOOLS.find((t) => t.name === 'list');
    assert.ok(listTool, 'list tool should be defined');
    assert.strictEqual(listTool.annotations.idempotentHint, true);
  });

  // The declaration above stays the source of truth in code; the wire copy is
  // narrowed in defineTool, so the hint that costs every client tokens without
  // changing what it does never leaves the process.
  it('TC-FUNC-058b: list does not publish idempotentHint on the wire', async () => {
    const { tools } = await harness.client.listTools();
    const listTool = tools.find((t) => t.name === 'list');
    assert.ok(listTool, 'list must be registered');
    assert.strictEqual(listTool.annotations?.idempotentHint, undefined);
  });

  // A grant widens the allowed roots, and no resource list reads them: the
  // instructions resource has a fixed URI, the result template lists the
  // ResourceStore, and the file template lists nothing. Notifying here only
  // bought the client a re-fetch of a list that could not have changed.
  it('TC-FUNC-059: an access grant sends no resources/list_changed', async () => {
    const parentDir = await createTestRoot();
    const rootDir = join(parentDir, 'root');
    const outsideDir = join(parentDir, 'outside');
    await mkdir(rootDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, 'file.txt');
    await writeFile(outsideFile, 'test content');

    let notified = false;
    const notifier = {
      toolsChanged: () => {},
      promptsChanged: () => {},
      resourcesChanged: () => {
        notified = true;
      },
      resourceUpdated: () => {},
    };

    try {
      await withBoundary(parentDir, async () => {
        const serverCtx = await createServer({ cliAllowedDirs: [rootDir] }, { notifier });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client(
          { name: 'test-harness', version: '1.0.0' },
          { capabilities: { elicitation: {} } },
        );
        client.setRequestHandler('elicitation/create', async () => {
          return {
            action: 'accept',
            content: { confirm: true },
          };
        });
        await Promise.all([
          client.connect(clientTransport),
          serverCtx.mcp.connect(serverTransport),
        ]);

        try {
          assert.strictEqual(notified, false);
          const result = await client.callTool({
            name: 'read',
            arguments: { path: outsideFile },
          });
          assert.notStrictEqual(result.isError, true);
          assert.strictEqual(
            notified,
            false,
            'a grant must not announce a resource list that cannot have changed',
          );
        } finally {
          await client.close();
          serverCtx.disposeRuntimeState();
          await serverCtx.mcp.close();
        }
      });
    } finally {
      await cleanupTestRoot(parentDir);
    }
  });

  it('TC-FUNC-073: text tools ship metadata under _meta, data tools under structuredContent', async () => {
    const file = join(tmpDir, 'meta_split.txt');
    await writeFile(file, 'one\ntwo\n');

    // read authors its own text (the file), so its metadata moves to _meta —
    // a client that keys on structuredContent would otherwise hide the bytes.
    const readRes = await harness.client.callTool({ name: 'read', arguments: { path: file } });
    assert.notStrictEqual(readRes.isError, true);
    assert.strictEqual(readRes.structuredContent, undefined);
    const readMeta = readRes._meta as { summary?: { succeeded?: number } };
    assert.strictEqual(readMeta.summary?.succeeded, 1);

    // stat authors no text, so the JSON *is* its model-facing view and stays
    // where a programmatic client already looks for it.
    const statRes = await harness.client.callTool({ name: 'stat', arguments: { path: file } });
    assert.notStrictEqual(statRes.isError, true);
    assert.strictEqual(statRes._meta, undefined);
    const statStructured = statRes.structuredContent as { summary?: { succeeded?: number } };
    assert.strictEqual(statStructured.summary?.succeeded, 1);
  });

  it('TC-FUNC-074: read trailer carries continuation and hash', async () => {
    const file = join(tmpDir, 'trailer.txt');
    const body = Array.from({ length: 30 }, (_v, i) => `line${String(i + 1)}`).join('\n');
    await writeFile(file, `${body}\n`);

    const head = await harness.client.callTool({
      name: 'read',
      arguments: { path: file, head: 10, includeHash: true },
    });
    const headText = firstTextBlock(head).text ?? '';
    assert.match(headText, /^\/\/ truncated: .*"startLine":11,"endLine":20\}$/m);
    assert.match(headText, /^\/\/ sha256: [0-9a-f]{64}$/m);
    // The file's own lines survive ahead of the trailer, unaltered.
    assert.ok(headText.startsWith('line1\nline2\n'), headText.slice(0, 40));
    assert.ok(headText.indexOf('line10') < headText.indexOf('// truncated'));

    // A whole-file read is not truncated and was not asked for a hash.
    const full = await harness.client.callTool({ name: 'read', arguments: { path: file } });
    const fullText = firstTextBlock(full).text ?? '';
    assert.ok(!fullText.includes('// truncated'), 'a full read is not truncated');
    assert.ok(!fullText.includes('// sha256'), 'no hash unless includeHash');

    // tail has no args that read backwards, so it reports what it showed.
    const tail = await harness.client.callTool({
      name: 'read',
      arguments: { path: file, tail: 10 },
    });
    const tailText = firstTextBlock(tail).text ?? '';
    assert.match(tailText, /^\/\/ truncated: showing last 10 lines$/m);
    assert.ok(!tailText.includes('Continue:'), 'tail offers no continuation args');
  });

  it('TC-FUNC-060: diff two files returns a unified diff', async () => {
    const a = join(tmpDir, 'diff_a.txt');
    const b = join(tmpDir, 'diff_b.txt');
    await writeFile(a, 'x\ny\nz\n');
    await writeFile(b, 'x\nY\nz\n');
    const result = await harness.client.callTool({
      name: 'diff',
      arguments: { a, b },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result._meta as {
      linesAdded?: number;
      linesRemoved?: number;
    };
    assert.strictEqual(structured.linesAdded, 1);
    assert.strictEqual(structured.linesRemoved, 1);
    // The diff itself rides the text content block, not _meta.
    const diffText = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    assert.ok(diffText.includes('-y') && diffText.includes('+Y'));
  });

  it('TC-FUNC-061: patch applies a unified diff', async () => {
    const f = join(tmpDir, 'patch_target.txt');
    await writeFile(f, 'a\nb\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
    const result = await harness.client.callTool({
      name: 'patch',
      arguments: { path: f, diff },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(f, 'utf-8'), 'X\nb\nc\n');
  });

  it('TC-FUNC-062: patch that does not apply returns isError', async () => {
    const f = join(tmpDir, 'patch_bad.txt');
    await writeFile(f, 'q\nb\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
    const result = await harness.client.callTool({ name: 'patch', arguments: { path: f, diff } });
    assert.strictEqual(result.isError, true);
  });

  it('TC-FUNC-063: list paginates entries via nextCursor', async () => {
    const sub = join(tmpDir, 'page_dir');
    await mkdir(sub, { recursive: true });
    for (let i = 0; i < 4; i++) await writeFile(join(sub, `f${i}.txt`), 'x');
    const r1 = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2 },
    });
    const s1 = r1._meta as {
      nextCursor?: string;
      entryCount?: number;
      resourceUri?: string;
    };
    assert.strictEqual(s1.entryCount, 2);
    assert.ok(s1.nextCursor, 'first page should yield a nextCursor');
    assert.ok(s1.resourceUri, 'an incomplete first page carries the URI of the full entry list');
    const r2 = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2, cursor: s1.nextCursor },
    });
    const s2 = r2._meta as { nextCursor?: string; entryCount?: number; resourceUri?: string };
    assert.strictEqual(s2.entryCount, 2);
    assert.ok(!s2.nextCursor, 'second page is the last');
    assert.strictEqual(s2.resourceUri, undefined, 'later pages never carry the URI');
  });

  it('TC-FUNC-075b: list prunes an ignored directory and everything under it', async () => {
    const sub = join(tmpDir, 'gitignore_walk_dir');
    // Nested one level on purpose: fs.glob's function `exclude` drops a
    // rejected entry at the top level but not below it, so a top-level fixture
    // passes even when the walk leaks the ignored directory itself.
    await mkdir(join(sub, 'a', 'skipme', 'deep'), { recursive: true });
    await writeFile(join(sub, '.gitignore'), 'skipme/\n');
    await writeFile(join(sub, 'kept.txt'), 'k');
    await writeFile(join(sub, 'a', 'skipme', 'deep', 'buried.txt'), 'b');

    // maxDepth must reach the nested file: the tool's default is 1, top-level only.
    const pruned = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxDepth: 4 },
    });
    const prunedText = firstTextBlock(pruned).text ?? '';
    assert.match(prunedText, /kept\.txt/);
    // The directory AND its children stay out: the walk prunes, it does not
    // enumerate then filter, so `buried.txt` is never visited.
    assert.doesNotMatch(prunedText, /skipme/);
    assert.doesNotMatch(prunedText, /buried\.txt/);

    const all = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxDepth: 4, includeIgnored: true },
    });
    const allText = firstTextBlock(all).text ?? '';
    assert.match(allText, /kept\.txt/);
    assert.match(allText, /buried\.txt/);
  });

  it('TC-FUNC-075c: find_files drops a gitignored file below the top level', async () => {
    const sub = join(tmpDir, 'gitignore_file_dir');
    await mkdir(join(sub, 'nested'), { recursive: true });
    await writeFile(join(sub, '.gitignore'), '*.log\n');
    await writeFile(join(sub, 'nested', 'keep.txt'), 'k');
    await writeFile(join(sub, 'nested', 'drop.log'), 'd');

    const result = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: sub, pattern: '**/*' },
    });
    const text = firstTextBlock(result).text ?? '';
    assert.match(text, /keep\.txt/);
    // A nested match the exclude predicate rejects must not survive the walk.
    assert.doesNotMatch(text, /drop\.log/);
  });

  it('TC-FUNC-075: list text carries nextCursor', async () => {
    const sub = join(tmpDir, 'cursor_text_dir');
    await mkdir(sub, { recursive: true });
    for (let i = 0; i < 4; i++) await writeFile(join(sub, `g${String(i)}.txt`), 'x');

    const first = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2 },
    });
    const firstText = firstTextBlock(first).text ?? '';
    const match = /^\/\/ showing 1-2 of 4 entries\. Next page: list \{"cursor":"([^"]+)"\}$/m.exec(
      firstText,
    );
    assert.ok(match, `first page text should carry its position and cursor: ${firstText}`);
    const cursor = match[1];
    // The model passes back verbatim what it read, so the two must agree.
    assert.strictEqual(cursor, (first._meta as { nextCursor?: string }).nextCursor);

    const second = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2, cursor },
    });
    const secondText = firstTextBlock(second).text ?? '';
    // The last page carries no cursor and still owes its position, or a
    // two-row tail reads as the whole answer.
    assert.match(secondText, /^\/\/ showing 3-4 of 4 entries\.$/m);
    assert.doesNotMatch(secondText, /Next page/);
  });

  it('TC-FUNC-063b: list pages are stable and query-bound', async () => {
    const sub = join(tmpDir, 'stable_page_dir');
    await mkdir(sub, { recursive: true });
    for (const name of ['bravo.txt', 'charlie.txt']) {
      await writeFile(join(sub, name), 'x');
    }
    const first = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 1 },
    });
    const firstStructured = first._meta as {
      entries?: { name: string }[];
      nextCursor?: string;
    };
    const cursor = firstStructured.nextCursor;
    assert.ok(cursor);

    await rm(sub, { recursive: true, force: true });
    const second = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 10, cursor },
    });
    assert.notStrictEqual(second.isError, true);
    const secondStructured = second._meta as { entries?: { name: string }[] };
    assert.deepStrictEqual(
      [...(firstStructured.entries ?? []), ...(secondStructured.entries ?? [])].map(
        (entry) => entry.name,
      ),
      ['bravo.txt', 'charlie.txt'],
      'page two must read the first-page snapshot after the directory is removed',
    );

    const replay = await harness.client.callTool({
      name: 'list',
      arguments: { path: tmpDir, maxEntries: 10, cursor },
    });
    assert.strictEqual(replay.isError, true);
    assert.match(firstTextBlock(replay).text ?? '', /INVALID_INPUT/);
  });

  it('TC-FUNC-063a: list does not return a successful partial result after abort', async () => {
    const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    assert.ok(originalTimeout);
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: () => AbortSignal.abort(new DOMException('test timeout', 'TimeoutError')),
    });
    try {
      const result = await harness.client.callTool({
        name: 'list',
        arguments: { path: tmpDir, includeIgnored: true },
      });

      assert.strictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent, undefined);
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', originalTimeout);
    }
  });

  it('TC-LOG-001: Tool execution logs to stderr', async () => {
    const file = join(tmpDir, 'log-test.txt');
    await writeFile(file, 'initial line\n');
    const origErr = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const result = await harness.client.callTool({
        name: 'edit',
        arguments: { path: file, edits: [{ oldText: 'initial', newText: 'updated' }] },
      });
      assert.notStrictEqual(result.isError, true);
      assert.ok(
        lines.some((l) => l.includes('edit:')),
        'stderr should carry the edit log line',
      );
    } finally {
      console.error = origErr;
    }
  });

  it('TC-FUNC-064: copy skip via choice round-trip leaves dst untouched', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'skip' },
    }));
    try {
      const src = join(tmpDir, 'choice_skip_src.txt');
      const dst = join(tmpDir, 'choice_skip_dst.txt');
      await writeFile(src, 'new source');
      await writeFile(dst, 'existing dst');
      const result = await eh.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dst }], copy: true },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result._meta as { moves?: unknown[]; skipped?: string[] };
      assert.strictEqual(s.moves?.length, 0);
      assert.ok(s.skipped?.includes(dst));
      assert.strictEqual(await readFile(dst, 'utf-8'), 'existing dst');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-065: copy overwrite via choice round-trip replaces dst', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'overwrite' },
    }));
    try {
      const src = join(tmpDir, 'choice_ow_src.txt');
      const dst = join(tmpDir, 'choice_ow_dst.txt');
      await writeFile(src, 'new source');
      await writeFile(dst, 'existing dst');
      const result = await eh.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dst }], copy: true },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result._meta as { moves?: unknown[]; skipped?: string[] };
      assert.strictEqual(s.moves?.length, 1);
      assert.strictEqual(s.skipped, undefined);
      assert.strictEqual(await readFile(dst, 'utf-8'), 'new source');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-066: move skip via choice round-trip leaves src and dst intact', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'skip' },
    }));
    try {
      const src = join(tmpDir, 'move_skip_src.txt');
      const dst = join(tmpDir, 'move_skip_dst.txt');
      await writeFile(src, 'move me');
      await writeFile(dst, 'dst stays');
      const result = await eh.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dst }] },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result._meta as { moves?: unknown[]; skipped?: string[] };
      assert.strictEqual(s.moves?.length, 0);
      assert.ok(s.skipped?.includes(dst));
      assert.strictEqual(await readFile(src, 'utf-8'), 'move me');
      assert.strictEqual(await readFile(dst, 'utf-8'), 'dst stays');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-067: move overwrite via choice round-trip replaces dst', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'overwrite' },
    }));
    try {
      const src = join(tmpDir, 'move_ow_src.txt');
      const dst = join(tmpDir, 'move_ow_dst.txt');
      await writeFile(src, 'move me');
      await writeFile(dst, 'dst old');
      const result = await eh.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dst }] },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result._meta as { moves?: unknown[]; skipped?: string[] };
      assert.strictEqual(s.moves?.length, 1);
      assert.strictEqual(s.skipped, undefined);
      assert.strictEqual(await readFile(dst, 'utf-8'), 'move me');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-068: delete skip via choice round-trip leaves dir in place', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'skip' },
    }));
    try {
      const dir = join(tmpDir, 'del_skip_dir');
      await mkdir(join(dir, 'sub'), { recursive: true });
      await writeFile(join(dir, 'sub', 'f.txt'), 'x');
      const result = await eh.client.callTool({
        name: 'delete',
        arguments: { paths: [dir], recursive: true },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result._meta as {
        results?: { path?: string; value?: { deleted?: boolean }; error?: unknown }[];
        summary?: { failed?: number };
      };
      assert.strictEqual(s.summary?.failed, 0);
      // Skip is a successful outcome with `deleted: false`, not a failure.
      assert.ok(
        s.results?.some(
          (r) => r.path?.toLowerCase() === dir.toLowerCase() && r.value?.deleted === false,
        ),
      );
      await access(dir); // still exists
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-069: delete via choice round-trip removes the dir', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'delete' },
    }));
    try {
      const dir = join(tmpDir, 'del_choice_dir');
      await mkdir(join(dir, 'sub'), { recursive: true });
      await writeFile(join(dir, 'sub', 'f.txt'), 'x');
      const result = await eh.client.callTool({
        name: 'delete',
        arguments: { paths: [dir], recursive: true },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result._meta as {
        results?: { path?: string; value?: { deleted?: boolean } }[];
        summary?: { failed?: number };
      };
      assert.strictEqual(s.summary?.failed, 0);
      assert.strictEqual(s.results?.[0]?.path?.toLowerCase(), dir.toLowerCase());
      assert.strictEqual(s.results?.[0]?.value?.deleted, true);
      await assert.rejects(() => access(dir));
    } finally {
      await eh.close();
    }
  });

  // Without this guard the SDK rejects the whole call with `-32021`
  // MissingRequiredClientCapability — a protocol error the model never sees, on
  // a tool whose description promised only that recursive=true was needed.
  it('TC-FUNC-069b: a client without elicitation gets a tool error, not a protocol error', async () => {
    const eh = await createElicitationClientPair(
      [tmpDir],
      async () => {
        throw new Error('the server must not ask a client that cannot answer');
      },
      { noElicitation: true },
    );
    try {
      const dir = join(tmpDir, 'del_no_elicit_dir');
      await mkdir(join(dir, 'sub'), { recursive: true });
      await writeFile(join(dir, 'sub', 'f.txt'), 'x');

      const result = await eh.client.callTool({
        name: 'delete',
        arguments: { paths: [dir], recursive: true },
      });

      assert.strictEqual(result.isError, true, 'must surface as a tool error');
      const text = (result.content as { type: string; text?: string }[])
        .map((block) => block.text ?? '')
        .join('\n');
      assert.match(text, /confirmation this client cannot show/i);
      assert.match(text, /individually|elicitation capability/i);
      // R7/R14: the refusal must not have deleted anything on the way out.
      await access(join(dir, 'sub', 'f.txt'));
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-070: multi-select grant accepts a subset of dirs (#14)', async () => {
    const parentDir = await createTestRoot();
    const rootDir = join(parentDir, 'root');
    const outsideA = join(parentDir, 'outsideA');
    const outsideB = join(parentDir, 'outsideB');
    await mkdir(rootDir, { recursive: true });
    await mkdir(outsideA, { recursive: true });
    await mkdir(outsideB, { recursive: true });
    const srcA = join(outsideA, 'a.txt');
    const srcB = join(outsideB, 'b.txt');
    await writeFile(srcA, 'A content');
    await writeFile(srcB, 'B content');

    try {
      await withBoundary(parentDir, async () => {
        // Two out-of-root source dirs => one multi-select grant round. Accept
        // only the FIRST offered dir (a subset of one); the other stays denied.
        const eh = await createElicitationClientPair([rootDir], async (req: unknown) => {
          const env = req as { params?: { requestedSchema?: unknown } };
          const schema = env.params?.requestedSchema as
            | {
                properties?: { choice?: { items?: { anyOf?: { const?: string }[] } } };
              }
            | undefined;
          const offered = schema?.properties?.choice?.items?.anyOf ?? [];
          const first = offered[0]?.const;
          return {
            action: 'accept' as const,
            content: { choice: first ? [first] : [] },
          };
        });
        try {
          const result = await eh.client.callTool({
            name: 'move',
            arguments: {
              moves: [
                { source: srcA, destination: join(rootDir, 'a_copy.txt') },
                { source: srcB, destination: join(rootDir, 'b_copy.txt') },
              ],
              copy: true,
            },
          });
          assert.notStrictEqual(result.isError, true);
          const s = result._meta as {
            moves?: { from?: string; to?: string }[];
            failures?: { source?: string; error?: { code?: string } }[];
          };
          // The accepted dir's copy succeeded; the declined dir's failed closed.
          assert.strictEqual(s.moves?.length, 1, 'exactly one copy (the accepted dir) succeeds');
          assert.strictEqual(s.failures?.length, 1, 'exactly one failure (the declined dir)');
          assert.strictEqual(s.failures?.[0]?.error?.code, 'ACCESS_DENIED');
        } finally {
          await eh.close();
        }
      });
    } finally {
      await cleanupTestRoot(parentDir);
    }
  });

  it('TC-FUNC-071: multi-select grant ignores a non-offered dir (consent scope)', async () => {
    const parentDir = await createTestRoot();
    const rootDir = join(parentDir, 'root');
    const outsideA = join(parentDir, 'outsideA');
    const outsideB = join(parentDir, 'outsideB');
    const secretDir = join(parentDir, 'secret'); // within boundary, never offered
    await mkdir(rootDir, { recursive: true });
    await mkdir(outsideA, { recursive: true });
    await mkdir(outsideB, { recursive: true });
    await mkdir(secretDir, { recursive: true });
    const srcA = join(outsideA, 'a.txt');
    const srcB = join(outsideB, 'b.txt');
    await writeFile(srcA, 'A content');
    await writeFile(srcB, 'B content');
    await writeFile(join(secretDir, 'secret.txt'), 'secret');

    try {
      await withBoundary(parentDir, async () => {
        // Malicious client: accept the offered outsideA AND a non-offered
        // secretDir. Only outsideA/outsideB were in precheckAccess's grantDirs
        // (two dirs => multi-select branch); secretDir must be filtered out and
        // stay ungranted.
        const eh = await createElicitationClientPair([rootDir], async () => ({
          action: 'accept' as const,
          content: { choice: [outsideA, secretDir] },
        }));
        try {
          const result = await eh.client.callTool({
            name: 'move',
            arguments: {
              moves: [
                { source: srcA, destination: join(rootDir, 'a_copy.txt') },
                { source: srcB, destination: join(rootDir, 'b_copy.txt') },
              ],
              copy: true,
            },
          });
          assert.notStrictEqual(result.isError, true);
          const s = result._meta as { moves?: unknown[] };
          assert.strictEqual(s.moves?.length, 1, 'offered accepted dir is granted');

          // secretDir was never offered -> not granted -> read fails ACCESS_DENIED.
          const readRes = await eh.client.callTool({
            name: 'read',
            arguments: { path: join(secretDir, 'secret.txt') },
          });
          const rs = readRes._meta as {
            results?: { error?: { code?: string } }[];
            summary?: { failed?: number };
          };
          assert.strictEqual(rs.summary?.failed, 1);
          assert.strictEqual(rs.results?.[0]?.error?.code, 'ACCESS_DENIED');
        } finally {
          await eh.close();
        }
      });
    } finally {
      await cleanupTestRoot(parentDir);
    }
  });

  it('TC-FUNC-013r: replace_text replaces all occurrences across globbed files', async () => {
    const file = await writeTestFile(tmpDir, 'sub/rep.txt', 'foo bar foo\n');
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: tmpDir, pattern: '**/*.txt', searchPattern: 'foo', replacement: 'QUX' },
    });
    assert.notStrictEqual(result.isError, true);
    const content = await readFile(file, 'utf-8');
    assert.strictEqual(content, 'QUX bar QUX\n');
  });

  // RE2 reports offsets in code points; JS strings index in UTF-16 code units,
  // so every astral character earlier in the file used to shift the splice by
  // one and cut into surrounding text.
  it('replace_text and edit splice correctly past astral characters', async () => {
    const prefix = '# T\n\n> 🟢 a 🔺 b 📅 c\n\n';
    const file = await writeTestFile(
      tmpDir,
      'emoji/rep.md',
      `${prefix}Line with ALPHA and more.\n`,
    );

    for (const args of [
      { caseSensitive: false, isRegex: false },
      { caseSensitive: true, isRegex: false },
      { caseSensitive: true, isRegex: true },
      { caseSensitive: false, isRegex: false, wholeWord: true },
    ]) {
      await writeFile(file, `${prefix}Line with ALPHA and more.\n`);
      const result = await harness.client.callTool({
        name: 'replace_text',
        arguments: { path: file, searchPattern: 'ALPHA', replacement: 'BETA', ...args },
      });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(
        await readFile(file, 'utf-8'),
        `${prefix}Line with BETA and more.\n`,
        `replace_text with ${JSON.stringify(args)}`,
      );
    }

    await writeFile(file, `${prefix}Line with ALPHA and more.\n`);
    const edited = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'with ALPHA and', newText: 'with BETA and' }],
        ignoreWhitespace: true,
      },
    });
    assert.notStrictEqual(edited.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), `${prefix}Line with BETA and more.\n`);

    // The reported column is a UTF-16 offset into the line, as `indexOf` gives.
    const searched = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: join(tmpDir, 'emoji'), searchPattern: 'BETA' },
    });
    const sc = searched._meta as { matches?: { column: number }[] };
    assert.strictEqual(sc.matches?.[0]?.column, 'Line with '.length);
  });

  it('TC-FUNC-014: find_files returns matched files via callTool', async () => {
    await writeTestFile(tmpDir, 'findme.txt', 'x');
    const result = await harness.client.callTool({
      name: 'find_files',
      arguments: { pattern: '**/*.txt' },
    });
    assert.notStrictEqual(result.isError, true);
    const sc = result._meta as { results?: { path: string }[] };
    assert.ok(sc.results?.some((r) => r.path.endsWith('findme.txt')));
  });

  it('find_files pages are stable and reject cursor pattern replay', async () => {
    const dir = join(tmpDir, 'find_pages');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bravo.txt'), 'x');
    await writeFile(join(dir, 'charlie.txt'), 'x');
    const first = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: dir, pattern: '*.txt', maxResults: 1 },
    });
    const firstStructured = first._meta as {
      results?: { path: string }[];
      nextCursor?: string;
      resourceUri?: string;
    };
    const cursor = firstStructured.nextCursor;
    assert.ok(cursor);
    // The overflow entry is minted by this call and runs on ResourceStore's own
    // clock, not the page snapshot's.
    assert.ok(firstStructured.resourceUri, 'page one carries the overflow URI');

    await rm(dir, { recursive: true, force: true });
    const second = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: dir, pattern: '*.txt', maxResults: 10, cursor },
    });
    assert.notStrictEqual(second.isError, true);
    const secondStructured = second._meta as {
      results?: { path: string }[];
      resourceUri?: string;
    };
    assert.deepStrictEqual(
      [...(firstStructured.results ?? []), ...(secondStructured.results ?? [])].map(
        (entry) => entry.path,
      ),
      ['bravo.txt', 'charlie.txt'],
    );
    assert.strictEqual(
      secondStructured.resourceUri,
      undefined,
      'later pages must not replay a URI that expires on a different clock',
    );

    const replay = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: dir, pattern: '*.md', maxResults: 10, cursor },
    });
    assert.strictEqual(replay.isError, true);
    assert.match(firstTextBlock(replay).text ?? '', /INVALID_INPUT/);
  });

  it('TC-FUNC-015s: stat returns file metadata via callTool', async () => {
    const file = await writeTestFile(tmpDir, 'statme.txt', 'hello');
    const result = await harness.client.callTool({
      name: 'stat',
      arguments: { path: file },
    });
    assert.notStrictEqual(result.isError, true);
    const sc = result.structuredContent as {
      results?: { value?: { type?: string; size?: number } }[];
    };
    const value = sc.results?.[0]?.value;
    assert.ok(value, 'stat must return a value');
    assert.strictEqual(value.type, 'file');
    assert.ok(typeof value.size === 'number' && value.size > 0);
  });

  it('stat reports an own symlink and its target', async (t) => {
    const target = await writeTestFile(tmpDir, 'stat-link-target.txt', 'target');
    const linkPath = join(tmpDir, 'stat-link.txt');
    if (!(await trySymlink(target, linkPath, () => t.skip('symlink not permitted'), 'file')))
      return;

    const result = await harness.client.callTool({
      name: 'stat',
      arguments: { path: linkPath },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as {
      results?: { value?: { type?: string; symlinkTarget?: string } }[];
    };
    const value = structured.results?.[0]?.value;
    assert.ok(value, 'stat must return a value');
    assert.strictEqual(value.type, 'symlink');
    assert.strictEqual(value.symlinkTarget, target);
  });

  it('stat reports a regular file under a symlinked parent as a file', async (t) => {
    const targetDir = join(tmpDir, 'stat-real-parent');
    await mkdir(targetDir);
    await writeFile(join(targetDir, 'child.txt'), 'child');
    const linkDir = join(tmpDir, 'stat-linked-parent');
    if (!(await trySymlink(targetDir, linkDir, () => t.skip('symlink not permitted')))) return;

    const result = await harness.client.callTool({
      name: 'stat',
      arguments: { path: join(linkDir, 'child.txt') },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as {
      results?: { value?: { type?: string; symlinkTarget?: string } }[];
    };
    const value = structured.results?.[0]?.value;
    assert.ok(value, 'stat must return a value');
    assert.strictEqual(value.type, 'file');
    assert.strictEqual(value.symlinkTarget, undefined);
  });

  it('TC-FUNC-072: search_text finds a literal match via callTool', async () => {
    const dir = join(tmpDir, 'grep_dir');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'target.txt'), 'line one\nNEEDLE_MARK here\nline three\n');
    const result = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, searchPattern: 'NEEDLE_MARK' },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result._meta as {
      matches?: { line?: number; content?: string }[];
      totalMatches?: number;
    };
    assert.strictEqual(structured.totalMatches, 1);
    assert.strictEqual(structured.matches?.[0]?.line, 2);
    assert.ok(structured.matches?.[0]?.content?.includes('NEEDLE_MARK'));
  });

  it('search_text pages are stable and reject cursor query replay', async () => {
    const file = await writeTestFile(tmpDir, 'search_pages.txt', 'NEEDLE bravo\nNEEDLE charlie\n');
    const first = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 1 },
    });
    const firstStructured = first._meta as {
      matches?: { content: string }[];
      nextCursor?: string;
    };
    const cursor = firstStructured.nextCursor;
    assert.ok(cursor);

    await rm(file, { force: true });
    const second = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 10, cursor },
    });
    assert.notStrictEqual(second.isError, true);
    const secondStructured = second._meta as { matches?: { content: string }[] };
    assert.deepStrictEqual(
      [...(firstStructured.matches ?? []), ...(secondStructured.matches ?? [])].map(
        (match) => match.content,
      ),
      ['NEEDLE bravo', 'NEEDLE charlie'],
    );

    const replay = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'different query', maxResults: 10, cursor },
    });
    assert.strictEqual(replay.isError, true);
    assert.match(firstTextBlock(replay).text ?? '', /INVALID_INPUT/);
  });

  it('search_text externalizes the full match list on the first page only', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `NEEDLE line ${String(i)}`);
    const file = await writeTestFile(tmpDir, 'search_first_page.txt', `${lines.join('\n')}\n`);
    const first = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 60 },
    });
    const firstStructured = first._meta as {
      matches?: unknown[];
      nextCursor?: string;
      resourceUri?: string;
      truncated?: boolean;
    };
    assert.strictEqual(firstStructured.matches?.length, 60, 'maxResults is the page size');
    assert.ok(firstStructured.nextCursor, 'more matches remain');
    assert.ok(firstStructured.resourceUri, 'an incomplete first page carries the full-list URI');
    assert.strictEqual(
      firstStructured.truncated,
      undefined,
      'paging is not truncation: the engine hit no cap',
    );

    const second = await harness.client.callTool({
      name: 'search_text',
      arguments: {
        path: file,
        searchPattern: 'NEEDLE',
        maxResults: 60,
        cursor: firstStructured.nextCursor,
      },
    });
    assert.notStrictEqual(second.isError, true);
    const secondStructured = second._meta as { matches?: unknown[]; resourceUri?: string };
    assert.strictEqual(secondStructured.matches?.length, 60);
    assert.strictEqual(
      secondStructured.resourceUri,
      undefined,
      'a continuation page must not mint a new resource',
    );
  });

  it('the page trailer tracks position across pages and both search tools', async () => {
    // `_meta` reaches no client, so a page that hides matches has to say so in
    // the text or the caller reads a capped list as the whole answer.
    const lines = Array.from({ length: 9 }, (_, i) => `NEEDLE line ${String(i)}`);
    const file = await writeTestFile(tmpDir, 'trailer/hits.txt', `${lines.join('\n')}\n`);
    const first = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 4 },
    });
    assert.match(
      firstTextBlock(first).text ?? '',
      /^\/\/ showing 1-4 of 9 matches\. Next page: search_text \{"cursor":"/m,
    );

    const cursor = (first._meta as { nextCursor?: string }).nextCursor;
    assert.ok(cursor);
    const second = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 4, cursor },
    });
    // The whole point: page 2 must not repeat page 1's counter.
    assert.match(firstTextBlock(second).text ?? '', /^\/\/ showing 5-8 of 9 matches\./m);

    // The last page carries no cursor and still owes its position, or a
    // one-row tail reads as the whole answer.
    const lastCursor = (second._meta as { nextCursor?: string }).nextCursor;
    assert.ok(lastCursor);
    const last = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 4, cursor: lastCursor },
    });
    const lastText = firstTextBlock(last).text ?? '';
    assert.match(lastText, /^\/\/ showing 9-9 of 9 matches\.$/m);
    assert.doesNotMatch(lastText, /Next page/);

    const complete = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 50 },
    });
    assert.doesNotMatch(
      firstTextBlock(complete).text ?? '',
      /Next page/,
      'a complete set gets no trailer',
    );

    // Own subdirectory with two files of its own: pointing at the shared tmpDir
    // would borrow whatever earlier tests left there and pass for the wrong
    // reason when this test runs alone.
    await writeTestFile(tmpDir, 'trailer_files/a.txt', 'a');
    await writeTestFile(tmpDir, 'trailer_files/b.txt', 'b');
    const files = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: join(tmpDir, 'trailer_files'), pattern: '**/*', maxResults: 1 },
    });
    assert.match(
      firstTextBlock(files).text ?? '',
      /^\/\/ showing 1-1 of 2 files\. Next page: find_files \{"cursor":"/m,
    );
  });

  it('search_text says so in the text when the engine cut the scan', async () => {
    // One line over the hard result cap makes the engine stop, so totalMatches
    // is a floor rather than the real count.
    const lines = Array.from({ length: MAX_SEARCH_RESULTS + 1 }, (_, i) => `CAPPED ${String(i)}`);
    const file = await writeTestFile(tmpDir, 'capped/hits.txt', `${lines.join('\n')}\n`);
    const result = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'CAPPED', maxResults: 5 },
    });
    const text = firstTextBlock(result).text ?? '';
    assert.ok(text.includes(`// showing 1-5 of ${String(MAX_SEARCH_RESULTS)} matches.`), text);
    assert.ok(
      text.includes(
        `// scan stopped early: hit the server's ${String(MAX_SEARCH_RESULTS)}-result scan cap, not your maxResults.`,
      ),
      text,
    );
    assert.strictEqual(
      (result._meta as { truncated?: boolean }).truncated,
      true,
      'the engine reports its own stop state',
    );
  });

  it('HTTP pagination survives the per-request server factory', async () => {
    const root = await createTestRoot();
    const http = await bootHttpTest([root]);
    try {
      await writeTestFile(root, 'http-pages/bravo.txt', 'x');
      await writeTestFile(root, 'http-pages/charlie.txt', 'x');
      const client = await http.makeClient('http-pagination');
      const first = await client.callTool({
        name: 'list',
        arguments: { path: join(root, 'http-pages'), maxEntries: 1 },
      });
      const firstStructured = first._meta as { nextCursor?: string };
      const cursor = firstStructured.nextCursor;
      assert.ok(cursor);

      const second = await client.callTool({
        name: 'list',
        arguments: { path: join(root, 'http-pages'), maxEntries: 10, cursor },
      });
      assert.notStrictEqual(second.isError, true);
      const secondStructured = second._meta as { entries?: { name: string }[] };
      assert.deepStrictEqual(
        secondStructured.entries?.map((entry) => entry.name),
        ['charlie.txt'],
      );
    } finally {
      await http.close();
      await cleanupTestRoot(root);
    }
  });

  it('TOOL-SURFACE-001: published schemas carry no dead keywords or phantom fields', async () => {
    const { tools } = await harness.client.listTools();
    // Scoped to input schemas: `suggestion` is a legitimate output property on
    // PerFileError, but never a schema keyword.
    const inputSchemas = JSON.stringify(tools.map((t) => t.inputSchema));

    assert.ok(
      !inputSchemas.includes('suggestion'),
      'the non-standard suggestion keyword must not reach the wire',
    );

    for (const tool of tools) {
      assert.strictEqual(
        tool.annotations?.title,
        undefined,
        `${tool.name} must not duplicate its title into annotations`,
      );
    }

    // No tool publishes an outputSchema any more. Publishing one obliges the
    // result to carry structuredContent, and every tool that used to publish
    // (read, edit, delete, replace_text) authors its own text and now ships its
    // metadata under _meta instead — the two are mutually exclusive.
    for (const tool of tools) {
      assert.strictEqual(
        tool.outputSchema,
        undefined,
        `${tool.name} must not publish an outputSchema`,
      );
    }

    for (const name of ['read', 'stat']) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} must be registered`);
      const properties = tool.inputSchema.properties ?? {};
      assert.ok(
        !Object.keys(properties).includes('files'),
        `${name} must not declare a files property`,
      );
      assert.ok(
        !JSON.stringify(tool.inputSchema).includes('and files'),
        `${name} must not advertise a files param it does not accept`,
      );
    }

    const edit = tools.find((t) => t.name === 'edit');
    assert.ok(edit);
    const editInput = JSON.stringify(edit.inputSchema);
    // EditSpec is the one subschema with an `id`, so it is hoisted into `$defs`
    // and referenced from both use sites (edits and files[].edits) rather than
    // inlined twice.
    assert.strictEqual(
      editInput.split('"$ref"').length - 1,
      2,
      'edit must reference the hoisted EditSpec at both use sites',
    );
    assert.ok(
      (edit.inputSchema as { $defs?: Record<string, unknown> }).$defs?.['EditSpec'],
      'edit must publish EditSpec in $defs',
    );
    // Sentinel is the opening of EditSpecSchema's `oldText` description in
    // src/tools/edit.ts — reword that description and this count must move with
    // it. Hoisted, it appears once.
    assert.strictEqual(
      editInput.split('Exact literal text to locate').length - 1,
      1,
      "EditSpec's oldText description must appear only in the hoisted $defs entry",
    );

    // `oneOf` (not `anyOf`): `{path, paths}` matches two branches and so fails,
    // mirroring the superRefine in singleOrBatchPathsInput. `edit`'s single-file
    // branch additionally requires `edits`, so `{ path }` alone fails the wire
    // schema the same way it fails the runtime gate — it used to pass the first
    // and fail the second, which the model had no way to anticipate.
    const modeBranches = (name: string, branches: string[][]) => {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} must be registered`);
      assert.deepStrictEqual(
        (tool.inputSchema as { oneOf?: unknown }).oneOf,
        branches.map((required) => ({ required })),
        `${name} must advertise its input modes as oneOf`,
      );
    };
    modeBranches('read', [['path'], ['paths']]);
    modeBranches('stat', [['path'], ['paths']]);
    modeBranches('edit', [['path', 'edits'], ['files']]);

    // `read`'s line-mode exclusivity is published too, not just enforced in
    // validateReadRange: `{ path, head, tail }` must fail the advertised schema.
    const readTool = tools.find((t) => t.name === 'read');
    assert.ok(readTool, 'read must be registered');
    const readSchema = readTool.inputSchema as {
      not?: { anyOf?: { required: string[] }[] };
      dependentRequired?: Record<string, string[]>;
    };
    assert.strictEqual(
      readSchema.not,
      undefined,
      'read no longer publishes the line-param exclusivity as a not/anyOf block',
    );
    assert.deepStrictEqual(
      readSchema.dependentRequired,
      { endLine: ['startLine'] },
      'read must advertise that endLine needs startLine',
    );

    // The rule moved off the wire, so it is proven at the layer that enforces
    // it: validateReadRange rejects the pair by name and that reaches the client
    // as a tool error.
    const conflictFile = await writeTestFile(tmpDir, 'line-conflict.txt', 'a\nb\nc');
    const conflict = await harness.client.callTool({
      name: 'read',
      arguments: { path: conflictFile, head: 1, tail: 1 },
    });
    assert.strictEqual(conflict.isError, true);
    const conflictText = firstTextBlock(conflict).text;
    assert.ok(conflictText);
    assert.match(conflictText, /head|tail/i);
  });

  // The session-start cost a client pays before its first tool call. Lower this
  // ceiling when a step in the payload plan removes weight; never raise it
  // without a recorded reason. Baseline at commit 528760ea: 41410 / 20862.
  // After the payload trims and the opt-in outputSchema policy: 24246 / 11536,
  // a 41% cut. The three tools that still publish an output schema account for
  // 6334 of the full figure (read 2806, edit 2554, delete 974) — the plan's
  // projection put that add-back at ~4000, which is the whole of the gap
  // against its 18500 target.
  // Raised once since, deliberately: `replace_text` joined the tools that
  // publish an output schema (+2042) when its result moved to the shared
  // `{ results, summary }` envelope, whose value-XOR-error union a sample
  // response cannot convey. `list` was considered and refused — its fields are
  // plain scalars, so its 1599 chars bought nothing.
  // Raised again, deliberately: read's `continuation.args` was a free-form
  // record rendering as `additionalProperties: {}` — no validation keyword, so
  // it told a client nothing about what to pass back. Spelling out the three
  // fields it actually carries costs +42.
  it('TOOL-SURFACE-002: tools/list stays within the session-start budget', async () => {
    const BUDGET_CHARS = 26_900;
    const BUDGET_CHARS_READ_ONLY = 12_000;

    const full = await createTestClientPair([tmpDir]);
    try {
      const { tools } = await full.client.listTools();
      assert.strictEqual(tools.length, 13, 'tool count changed; update the budget deliberately');
      const size = JSON.stringify(tools).length;
      assert.ok(
        size <= BUDGET_CHARS,
        `tools/list is ${String(size)} chars, over the ${String(BUDGET_CHARS)} budget`,
      );
    } finally {
      await full.close();
    }

    const ro = await createTestClientPair([tmpDir], { readOnly: true });
    try {
      const { tools } = await ro.client.listTools();
      const size = JSON.stringify(tools).length;
      assert.ok(
        size <= BUDGET_CHARS_READ_ONLY,
        `read-only tools/list is ${String(size)} chars, over the ${String(BUDGET_CHARS_READ_ONLY)} budget`,
      );
    } finally {
      await ro.close();
    }
  });
});
