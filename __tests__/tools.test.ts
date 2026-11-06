import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildFileResourceUri } from '../src/core/file-uri.ts';
import { MAX_TOOL_INPUT_ELEMENTS } from '../src/core/util.ts';
import { createRuntimeState, createServer } from '../src/server.ts';
import { MUTATING_TOOL_NAMES, registeredTools } from '../src/tools/index.ts';
import { ProgressSession } from '../src/tools/progress.ts';
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
} from './helpers.ts';

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

  it('replace_text and resources/read refuse sensitive files', async () => {
    const token = 'example-sentinel-9f3c1e';
    const dir = join(tmpDir, 'boundary_walk');
    const envFile = await writeTestFile(tmpDir, 'boundary_walk/.env', `SECRET=${token}\n`);
    await writeTestFile(tmpDir, 'boundary_walk/vault.key/inner.txt', `note ${token}\n`);
    const plain = await writeTestFile(tmpDir, 'boundary_walk/plain.txt', `note ${token}\n`);

    const replaced = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: token, replacement: 'REDACTED', includeHidden: true },
    });
    assert.notStrictEqual(replaced.isError, true);
    const replacedMeta = replaced._meta as { summary?: { failed?: number } };
    assert.strictEqual(replacedMeta.summary?.failed, 0);
    assert.doesNotMatch(firstTextBlock(replaced).text ?? '', /failed|\.env/);
    assert.strictEqual(
      await readFile(envFile, 'utf-8'),
      `SECRET=${token}\n`,
      '.env must be untouched',
    );
    assert.strictEqual(
      await readFile(join(dir, 'vault.key/inner.txt'), 'utf-8'),
      `note ${token}\n`,
      'a file under a sensitive-named directory must be untouched',
    );
    assert.strictEqual(await readFile(plain, 'utf-8'), 'note REDACTED\n');

    // A second replace_text that matches 0 files must still succeed cleanly, not fail on .env.
    const noMatchReplace = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: token, replacement: 'REDACTED', includeHidden: true },
    });
    assert.notStrictEqual(noMatchReplace.isError, true);

    await assert.rejects(
      harness.client.readResource({ uri: buildFileResourceUri(envFile) }),
      'resources/read of a sensitive file must be refused',
    );
  });

  it('TC-FUNC-009p: a client without elicitation gets a tool error naming overwrite: true', async () => {
    const eh = await createElicitationClientPair(
      [tmpDir],
      async () => {
        throw new Error('the server must not ask a client that cannot answer');
      },
      { noElicitation: true },
    );
    try {
      const existing = await writeTestFile(tmpDir, 'create_no_elicit.txt', 'keep me\n');
      const result = await eh.client.callTool({
        name: 'create',
        arguments: { files: [{ path: existing, content: 'clobber\n' }] },
      });
      assert.strictEqual(result.isError, true, 'must surface as a tool error');
      const text = (result.content as { type: string; text?: string }[])
        .map((block) => block.text ?? '')
        .join('\n');
      assert.match(text, /confirmation this client cannot show/i);
      assert.match(text, /overwrite/i);
      assert.strictEqual(await readFile(existing, 'utf-8'), 'keep me\n');
    } finally {
      await eh.close();
    }
  });

  it('a missing path under an out-of-root junction answers ACCESS_DENIED, not NOT_FOUND', async (t) => {
    const top = await createTestRoot();
    const root = join(top, 'root');
    const outside = join(top, 'outside');
    try {
      await mkdir(root);
      await mkdir(outside);
      if (
        !(await trySymlink(outside, join(root, 'out'), () =>
          t.skip('symlink creation not permitted'),
        ))
      ) {
        return;
      }
      const pair = await createTestClientPair([root]);
      try {
        const escaping = await pair.client.callTool({
          name: 'stat',
          arguments: { path: join(root, 'out', 'nope') },
        });
        const escapingText = firstTextBlock(escaping).text ?? '';
        assert.match(escapingText, /ACCESS_DENIED/);
        assert.doesNotMatch(escapingText, /NOT_FOUND/);

        const inside = await pair.client.callTool({
          name: 'stat',
          arguments: { path: join(root, 'nope') },
        });
        assert.match(firstTextBlock(inside).text ?? '', /NOT_FOUND/);

        const read = await pair.client.callTool({
          name: 'read',
          arguments: { path: join(root, 'out', 'nope') },
        });
        assert.strictEqual(read.isError, true);
        assert.doesNotMatch(firstTextBlock(read).text ?? '', /not found/i);
      } finally {
        await pair.close();
      }
    } finally {
      await cleanupTestRoot(top);
    }
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

  it('tools/call arguments over MAX_TOOL_INPUT_ELEMENTS are answered with a tool error before schema validation', async () => {
    // 1000 is `read`'s own schema cap; this payload is far past it, so only
    // the SDK's structural count can be the error that comes back.
    const paths = Array.from(
      { length: MAX_TOOL_INPUT_ELEMENTS + 1 },
      (_, i) => `${tmpDir}/never-${String(i)}.txt`,
    );
    const result = await harness.client.callTool({ name: 'read', arguments: { paths } });
    assert.strictEqual(result.isError, true);
    const text = (result.content as { type: string; text?: string }[])
      .map((c) => c.text ?? '')
      .join('\n');
    assert.match(
      text,
      new RegExp(`more than the maximum of ${String(MAX_TOOL_INPUT_ELEMENTS)} elements`),
    );
    assert.ok(!text.includes('Input validation error'), 'the cap must fire before the schema');
  });

  it('the largest schema-legal edit batch (5 files x 100 edits) is not refused by the element cap', async () => {
    // 2 top-level members + 5 files + 5x2 file members + 500 edits + 500x2
    // edit members = 1517 nodes. Must stay well under MAX_TOOL_INPUT_ELEMENTS;
    // if a schema cap is ever raised past the headroom, this test is the alarm.
    const files = await Promise.all(
      Array.from({ length: 5 }, async (_, f) => {
        const path = join(tmpDir, `cap-${String(f)}.txt`);
        await writeFile(path, 'unrelated content\n');
        return {
          path,
          edits: Array.from({ length: 100 }, (_, e) => ({
            oldText: `absent-${String(f)}-${String(e)}`,
            newText: '',
          })),
        };
      }),
    );
    // The tool may legitimately report unmatched oldText as an error; only the
    // element-cap message would mean the cap refused a schema-legal call.
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: { files, dryRun: true },
    });
    const text = (result.content as { type: string; text?: string }[])
      .map((c) => c.text ?? '')
      .join('\n');
    assert.notStrictEqual(result.isError, true, text.slice(0, 300));
    assert.ok(!/more than the maximum of \d+ elements/.test(text), text.slice(0, 300));
  });

  it('read alone declares the client result-size hint in tools/list', async () => {
    const harness = await createTestClientPair([tmpDir]);
    try {
      const { tools } = await harness.client.listTools();
      const key = 'anthropic/maxResultSizeChars';
      assert.strictEqual(tools.find((tool) => tool.name === 'read')?._meta?.[key], 200_000);
      for (const tool of tools.filter((candidate) => candidate.name !== 'read')) {
        assert.strictEqual(tool._meta?.[key], undefined, tool.name);
      }
    } finally {
      await harness.close();
    }
  });

  it('tools/list publishes slimmed schemas and preserves Zod runtime semantics', async () => {
    const pinHarness = await createTestClientPair([tmpDir]);
    try {
      const { tools } = await pinHarness.client.listTools();
      assert.ok(tools.length > 0);
      for (const tool of tools) {
        // The wire copy is the SDK's own conversion of the Zod schema: no $defs
        // and no $ref anywhere — clients whose converter cannot follow a $ref
        // fall back to serializing the arguments (issue #51).
        assert.strictEqual(
          (tool.inputSchema as { $defs?: unknown }).$defs,
          undefined,
          `${tool.name} must publish a dereferenced input schema without $defs`,
        );
        assert.ok(
          !JSON.stringify(tool.inputSchema).includes('"$ref"'),
          `${tool.name} must publish an input schema without $ref`,
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
    const edits = [{ oldText: 'original', newText: 'modified' }];
    for (const args of [{ path: file, edits }, { files: [{ path: file, edits }] }]) {
      await writeFile(file, 'original content');
      const result = await harness.client.callTool({ name: 'edit', arguments: args });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(result.structuredContent, undefined);
      assert.strictEqual(failedSummary(result)?.summary?.failed, 0);
      // The executor appends the undo handle to the body's summary line.
      assert.match(firstTextBlock(result).text ?? '', /^edit: edit\.txt .* · undo \S+$/mu);

      const content = await readFile(file, 'utf-8');
      assert.strictEqual(content, 'modified content');
    }
  });

  it('recovers arguments a client serialized and spread into indexed keys (issue #51)', async () => {
    const file = join(tmpDir, 'edit-split-args.txt');
    await writeFile(file, 'original content');
    const payload = { path: file, edits: [{ oldText: 'original', newText: 'modified' }] };
    // A string spread into an object is what such clients put on the wire:
    // { "0": "{", "1": "\"", … }.
    const spread = (text: string): Record<string, unknown> =>
      Object.fromEntries(text.split('').entries());
    const recovered = await harness.client.callTool({
      name: 'edit',
      arguments: spread(JSON.stringify(payload)),
    });
    assert.notStrictEqual(recovered.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'modified content');

    for (const encoded of ['abc', JSON.stringify(['not', 'an', 'object'])]) {
      const rejected = await harness.client.callTool({
        name: 'edit',
        arguments: spread(encoded),
      });
      assert.strictEqual(rejected.isError, true);
      const text = firstTextBlock(rejected).text ?? '';
      assert.match(
        text,
        new RegExp(`arrived as a ${String(encoded.length)}-character string`, 'u'),
      );
      assert.doesNotMatch(text, /Unrecognized keys/u);
    }
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

  // idempotentHint is gone from the declarations (production never read it); pin
  // that it stays off the wire too — it costs every client tokens without
  // changing what any tool does.
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
    // The ResourceStore's list-changed hook is the channel every transport
    // routes resources/list_changed through.
    const state = createRuntimeState(
      { cliAllowedDirs: [rootDir] },
      {
        onResourcesChanged: () => {
          notified = true;
        },
      },
    );

    try {
      await withBoundary(parentDir, async () => {
        const serverCtx = await createServer({ cliAllowedDirs: [rootDir] }, { state });
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
          await serverCtx.mcp.close();
        }
      });
    } finally {
      state.dispose();
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

  it('TC-FUNC-061: patch applies a unified diff', async () => {
    const f = join(tmpDir, 'patch_target.txt');
    await writeFile(f, 'a\nb\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
    const result = await harness.client.callTool({
      name: 'patch',
      arguments: { path: f, diff },
    });
    assert.notStrictEqual(result.isError, true);
    const uri = (result._meta as { resourceUri?: string }).resourceUri;
    assert.ok(uri, 'a real write links the file');
    assert.ok(
      (result.content as { type: string; uri?: string }[]).some(
        (block) => block.type === 'resource_link' && block.uri === uri,
      ),
    );
    assert.strictEqual(await readFile(f, 'utf-8'), 'X\nb\nc\n');
  });

  it('TC-FUNC-062: patch that does not apply returns isError', async () => {
    const f = join(tmpDir, 'patch_bad.txt');
    await writeFile(f, 'q\nb\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
    const result = await harness.client.callTool({ name: 'patch', arguments: { path: f, diff } });
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /INVALID_INPUT.*did not apply cleanly/);
  });

  it('TC-FUNC-063: list sends text, metadata and its resource link over MCP', async () => {
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
    assert.strictEqual(r1.structuredContent, undefined);
    assert.match(firstTextBlock(r1).text ?? '', /showing 1-2 of 4 entries/);
    assert.ok(
      (r1.content as { type: string; uri?: string }[]).some(
        (block) => block.type === 'resource_link' && block.uri === s1.resourceUri,
      ),
    );
    const r2 = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2, cursor: s1.nextCursor },
    });
    const s2 = r2._meta as { nextCursor?: string; entryCount?: number; resourceUri?: string };
    assert.strictEqual(s2.entryCount, 2);
    assert.ok(!s2.nextCursor, 'second page is the last');
    assert.strictEqual(s2.resourceUri, undefined, 'later pages never carry the URI');
    const invalid = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2, includeHidden: true, cursor: s1.nextCursor },
    });
    assert.strictEqual(invalid.isError, true);
    assert.match(firstTextBlock(invalid).text ?? '', /INVALID_INPUT/);
  });

  it('TC-FUNC-063a: list returns a partial result after a timeout', async (t) => {
    t.mock.method(AbortSignal, 'timeout', () =>
      AbortSignal.abort(new DOMException('test timeout', 'TimeoutError')),
    );
    const result = await harness.client.callTool({
      name: 'list',
      arguments: { path: tmpDir, includeIgnored: true },
    });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual((result._meta as { stoppedReason?: string }).stoppedReason, 'timeout');
    assert.match(firstTextBlock(result).text ?? '', /scan stopped early: hit the time limit/);
  });

  it('a timed-out list externalizes a partial tree', async (t) => {
    const dir = join(tmpDir, 'list_timeout_partial');
    for (let i = 0; i < 20; i++) await writeTestFile(dir, `f${String(i)}.txt`, 'x');
    const controller = new AbortController();
    t.mock.method(AbortSignal, 'timeout', () => controller.signal);
    // A pre-aborted walk collects nothing, so the deadline fires on the third tick.
    let ticks = 0;
    t.mock.method(ProgressSession.prototype, 'set', () => {
      if (++ticks === 3) controller.abort(new DOMException('test timeout', 'TimeoutError'));
    });
    const result = await harness.client.callTool({
      name: 'list',
      arguments: { path: dir, maxEntries: 2 },
    });

    assert.notStrictEqual(result.isError, true);
    const meta = result._meta as { resourceUri?: string; stoppedReason?: string };
    assert.strictEqual(meta.stoppedReason, 'timeout');
    assert.ok(meta.resourceUri, 'a partial first page still carries the full-tree URI');
    const resource = await harness.client.readResource({ uri: meta.resourceUri });
    const first = resource.contents[0];
    const tree = JSON.parse(first && 'text' in first ? first.text : '{}') as {
      stoppedReason?: string;
      truncated?: boolean;
    };
    assert.strictEqual(tree.stoppedReason, 'timeout');
    assert.strictEqual(tree.truncated, true);
  });

  it('TC-LOG-001: Tool execution logs to stderr', async (t) => {
    const file = join(tmpDir, 'log-test.txt');
    await writeFile(file, 'initial line\n');
    const lines: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: { path: file, edits: [{ oldText: 'initial', newText: 'updated' }] },
    });
    assert.notStrictEqual(result.isError, true);
    assert.ok(
      lines.some((l) => /^\[\w+\] \[req [^\]]+\] \[edit\] edit:/.test(l)),
      'stderr should carry the edit log line tagged with its request id',
    );
  });

  it('TC-FUNC-067b: a client without elicitation gets a tool error for a move onto an existing file', async () => {
    const eh = await createElicitationClientPair(
      [tmpDir],
      async () => {
        throw new Error('the server must not ask a client that cannot answer');
      },
      { noElicitation: true },
    );
    try {
      const src = await writeTestFile(tmpDir, 'move_no_elicit_src.txt', 'src\n');
      const dst = await writeTestFile(tmpDir, 'move_no_elicit_dst.txt', 'dst\n');
      const result = await eh.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dst }] },
      });
      assert.strictEqual(result.isError, true, 'must surface as a tool error');
      assert.match(firstTextBlock(result).text ?? '', /confirmation this client cannot show/i);
      assert.strictEqual(await readFile(src, 'utf-8'), 'src\n');
      assert.strictEqual(await readFile(dst, 'utf-8'), 'dst\n');
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
      const other = join(tmpDir, 'del_no_elicit_other.txt');
      await writeFile(other, 'x');

      const result = await eh.client.callTool({
        name: 'delete',
        arguments: { paths: [dir, other], recursive: true },
      });

      assert.strictEqual(result.isError, true, 'must surface as a tool error');
      const text = (result.content as { type: string; text?: string }[])
        .map((block) => block.text ?? '')
        .join('\n');
      assert.match(text, /confirmation this client cannot show/i);
      assert.match(text, /other paths/i);
      assert.doesNotMatch(text, /individually/i);
      // R7/R14: the refusal must not have deleted anything on the way out.
      await access(join(dir, 'sub', 'f.txt'));
      await access(other);
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
            { properties?: { choice?: { items?: { enum?: string[] } } } } | undefined;
          const offered = schema?.properties?.choice?.items?.enum ?? [];
          const first = offered[0];
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
    assert.strictEqual((result._meta as { totalMatches?: number }).totalMatches, 2);
    const content = await readFile(file, 'utf-8');
    assert.strictEqual(content, 'QUX bar QUX\n');
  });

  it('replace_text publishes maxMatches and no maxResults', async () => {
    const { tools } = await harness.client.listTools();
    const props = tools.find((t) => t.name === 'replace_text')?.inputSchema.properties as {
      maxResults?: object;
      maxMatches?: object;
    };
    assert.strictEqual(props.maxResults, undefined);
    assert.ok(props.maxMatches);
  });

  it('TC-FUNC-014: find_files returns matched files via callTool', async () => {
    await writeTestFile(tmpDir, 'findme.txt', 'x');
    // The shared tmpDir holds more than find_files' default 100 results of *.txt.
    const result = await harness.client.callTool({
      name: 'find_files',
      arguments: { pattern: '**/findme.txt' },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent, undefined);
    assert.match(firstTextBlock(result).text ?? '', /findme\.txt/);
    const sc = result._meta as { results?: { path: string }[] };
    assert.ok(sc.results?.some((r) => r.path.endsWith('findme.txt')));
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
    assert.strictEqual(result.structuredContent, undefined);
    assert.match(firstTextBlock(result).text ?? '', /grep_dir\/target\.txt:2: NEEDLE_MARK here/);
    const structured = result._meta as {
      matches?: { line?: number; content?: string }[];
      totalMatches?: number;
    };
    assert.strictEqual(structured.totalMatches, 1);
    assert.strictEqual(structured.matches?.[0]?.line, 2);
    assert.ok(structured.matches?.[0]?.content?.includes('NEEDLE_MARK'));
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
    // EditSpec carries no `id`, so it is inlined at both use sites (edits and
    // files[].edits) instead of hoisted behind a `$ref` (issue #51).
    // Sentinel is the opening of EditSpecSchema's `oldText` description in
    // src/tools/edit.ts — reword that description and this count must move with
    // it.
    assert.strictEqual(
      editInput.split('Exact literal text to locate').length - 1,
      2,
      "EditSpec's oldText description must be inlined at both use sites",
    );

    // OpenAI and Anthropic reject these top-level keys in function parameters,
    // so no tool may publish one. The path/paths, edits/files and line-range
    // rules are enforced by superRefine at call time instead.
    for (const tool of tools) {
      for (const key of ['oneOf', 'anyOf', 'allOf', 'not', 'dependentRequired']) {
        assert.ok(
          !(key in tool.inputSchema),
          `${tool.name}: top-level ${key} breaks OpenAI/Anthropic function calling`,
        );
      }
    }

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

  it('every tool publishes exactly its read-only or mutating annotations', async () => {
    const { tools } = await harness.client.listTools();
    const mutating = new Set(['create', 'delete', 'edit', 'move', 'patch', 'replace_text', 'undo']);
    for (const tool of tools) {
      const readOnlyHint = !mutating.has(tool.name);
      assert.deepStrictEqual(
        tool.annotations,
        {
          readOnlyHint,
          openWorldHint: false,
          ...(readOnlyHint ? {} : { destructiveHint: true }),
        },
        tool.name,
      );
    }
  });

  // The session-start cost a client pays before its first tool call. Lower this
  // ceiling when a change removes weight; never raise it without a recorded
  // reason. History before this baseline (the 528760ea start at 41410 / 20862,
  // and the output-schema add-backs) no longer applies: since f9199c80 no tool
  // publishes an output schema. Baseline measured 2026-10-02, after the arch
  // audit follow-ups: 18154 full / 8950 read-only. Each ceiling sits about 2%
  // above its measurement, so a regression of a few hundred characters fails.
  // Raised 2026-10-06 to 18620 full (read-only unchanged): `edit` inlines
  // EditSpec at both use sites instead of a `$ref`, which some clients cannot
  // follow (issue #51).
  // Raised 2026-10-15 to 19600 full / 9550 read-only: `list` gains opt-in
  // includeSizes and sortBy inputs (#99); measured 19219 / 9357.
  // Raised 2026-10-22 to 20550 full (read-only unchanged): undo tool (#111);
  // measured 19949 / 9357.
  // Raised 2026-10-23 to 9850 read-only (full unchanged): the list and diff
  // descriptions name their default skips and refusals, gaps the Glama TDQS
  // review flagged; measured 20397 / 9668.
  // Raised 2026-10-28 to 20750 full (read-only unchanged): replace_text
  // gains maxMatches beside the deprecated maxResults alias; measured 20673.
  // Raised 2026-11-01 to 20900 full and 9900 read-only: list_roots names
  // readOnlyDirs (#162); measured 20849 / 9863.
  // Lowered 2026-11-03 to 20700 full (read-only unchanged): replace_text drops
  // the deprecated maxResults alias; measured 20698.
  // Raised 2026-11-03 to 20800 full (read-only unchanged): edit caps oldText
  // (maxLength in two places) and patch caps diff (maxLength); measured 20758.
  // Raised 2026-11-04 to 20950 full and 10050 read-only: read declares its result
  // size in _meta and points at stat's tokenEstimate; measured 20913 / 10010.
  // Raised 2026-11-04 to 21100 full and 10200 read-only: read gains lineNumbers;
  // measured 21085 / 10182.
  // Raised 2026-11-04 to 21150 full and 10250 read-only: list names .git among its
  // skips, and search_text says a named file prints once; measured 21139 / 10236.
  it('TOOL-SURFACE-002: tools/list stays within the session-start budget', async () => {
    // Raised 2026-11-05 to 22100 full and 10650 read-only: the report-gap
    // wording (create, delete, search_text, replace_text, undo, stat) says
    // what happens without a prompt, how previews assume reverts, and
    // Windows creation times; measured 21993 / 10579.
    // Raised 2026-11-06 to 22650 full and 10700 read-only: the v2.18.2 TDQS
    // review asked for paging, dryRun/undo paths and sibling routing in the
    // descriptions; stat's created clause shrank to pay part of it; measured
    // 22595 / 10670.
    // Raised 2026-11-06 to 23150 full and 10950 read-only: the tdqs.dev round-2
    // report scored delete, diff, list, move, read and stat at Usage 4 for naming
    // no sibling, and move says a non-empty directory target is refused;
    // measured 23100 / 10914.
    const BUDGET_CHARS = 23_150;
    const BUDGET_CHARS_READ_ONLY = 10_950;

    const full = await createTestClientPair([tmpDir]);
    try {
      const { tools } = await full.client.listTools();
      assert.strictEqual(tools.length, 14, 'tool count changed; update the budget deliberately');
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

  it('TOOL-SURFACE-003: no read-only tool description names a write tool', async () => {
    const full = await createTestClientPair([tmpDir]);
    let writeNames: string[];
    try {
      const { tools } = await full.client.listTools();
      writeNames = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    } finally {
      await full.close();
    }
    assert.ok(writeNames.length > 0);

    const ro = await createTestClientPair([tmpDir], { readOnly: true });
    try {
      const { tools } = await ro.client.listTools();
      for (const tool of tools) {
        for (const name of writeNames) {
          assert.doesNotMatch(
            tool.description ?? '',
            new RegExp(`\\b${name}\\b`, 'u'),
            `${tool.name} names the write tool ${name}, absent under --read-only`,
          );
        }
      }
    } finally {
      await ro.close();
    }
  });
});
