import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildFileResourceUri } from '../src/core/file-uri.js';
import { INSTRUCTIONS_URI } from '../src/instructions.js';
import {
  ALL_REGISTERED_TOOL_NAMES,
  cleanupTestRoot,
  createTestHttpHarness,
  createTestRoot,
  failedSummary,
  firstTextBlock,
  type TestHttpContext,
  writeTestFile,
} from './helpers.js';

describe('HTTP In-Process Transport (createMcpHandler / handler.fetch)', () => {
  let tmpDir: string;
  let httpHarness: TestHttpContext;

  before(async () => {
    tmpDir = await createTestRoot();
    httpHarness = await createTestHttpHarness([tmpDir]);
  });

  after(async () => {
    if (httpHarness) {
      await httpHarness.close();
    }
    if (tmpDir) {
      await cleanupTestRoot(tmpDir);
    }
  });

  it('HTTP-001: Connects client and lists tools over in-process StreamableHTTP', async () => {
    const listResult = await httpHarness.client.listTools();
    assert.strictEqual(listResult.tools.length, ALL_REGISTERED_TOOL_NAMES.length);
  });

  it('HTTP-002: Executes tool calls over in-process HTTP transport', async () => {
    const filePath = await writeTestFile(tmpDir, 'http_file.txt', 'HTTP transport content');

    const result = await httpHarness.client.callTool({
      name: 'read',
      arguments: { path: filePath },
    });

    assert.notStrictEqual(result.isError, true);
    const firstBlock = firstTextBlock(result);
    assert.strictEqual(firstBlock.type, 'text');
    assert.ok(firstBlock.text?.includes('HTTP transport content'));
  });

  it('HTTP-003: Reads static resource over in-process HTTP transport', async () => {
    const res = await httpHarness.client.readResource({ uri: INSTRUCTIONS_URI });
    assert.strictEqual(res.contents.length, 1);
    const content = res.contents[0];
    assert.ok(content);
    assert.strictEqual(content.mimeType, 'text/markdown');
  });

  it('HTTP-004: Tool business error returns failed summary over HTTP', async () => {
    const result = await httpHarness.client.callTool({
      name: 'read',
      arguments: { path: join(tmpDir, 'non_existent_http.txt') },
    });

    // A business error stays a tool *result* — a structured per-path summary,
    // never a JSON-RPC protocol error. It is still a failed call: every path
    // failed, so `isError` says so rather than handing the client an error
    // message it would read as file content.
    assert.strictEqual(result.isError, true);
    const structured = failedSummary(result);
    assert.strictEqual(structured?.summary?.failed, 1);
    assert.strictEqual(structured?.results?.[0]?.error?.code, 'NOT_FOUND');
  });

  it('HTTP-005: modern discover carries the serverInfo _meta stamp and cache hints on the wire', () => {
    // Spec PR #3002: server identity rides _meta['io.modelcontextprotocol/serverInfo']
    // on 2026-era responses; getServerVersion() reads the discover result's stamp.
    const version = httpHarness.client.getServerVersion();
    assert.ok(version, 'the modern discover result must retain server identity');
    assert.strictEqual(version?.name, 'filesystem-mcp');
    assert.ok(version.version, 'the _meta serverInfo stamp must carry a version');

    // ttlMs/cacheScope are hidden from the public DiscoverResult type but kept
    // at runtime; the cast reads what serverConfig.cacheHints actually emitted
    // (the wire parse defaults an OMITTED hint to 0/'private', so these values
    // prove the advertised policy reached the wire).
    const discover = httpHarness.client.getDiscoverResult() as
      { ttlMs?: number; cacheScope?: string } | undefined;
    assert.ok(discover, 'a modern connection must retain its discover result');
    assert.strictEqual(discover.ttlMs, 3_600_000);
    assert.strictEqual(discover.cacheScope, 'public');
  });
});

describe('HTTP 2025-era (legacy) clients', () => {
  let tmpDir: string;
  let harness: TestHttpContext;
  let legacy: Client;

  before(async () => {
    tmpDir = await createTestRoot();
    harness = await createTestHttpHarness([tmpDir]);

    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => harness.handler.fetch(new Request(url, init)),
    });
    legacy = new Client(
      { name: 'legacy-http', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } },
    );
    legacy.setRequestHandler('elicitation/create', async () => ({
      action: 'accept',
      content: { choice: 'delete' },
    }));
    await legacy.connect(transport);
    assert.strictEqual(
      legacy.getProtocolEra(),
      'legacy',
      'a client with no versionNegotiation option must open with the 2025 handshake',
    );
  });

  after(async () => {
    await legacy.close();
    await harness.close();
    await cleanupTestRoot(tmpDir);
  });

  it('LEGACY-HTTP-001: tools list and read work over the stateless legacy leg', async () => {
    const listResult = await legacy.listTools();
    assert.strictEqual(listResult.tools.length, ALL_REGISTERED_TOOL_NAMES.length);

    const filePath = await writeTestFile(tmpDir, 'legacy_read.txt', 'legacy content');
    const result = await legacy.callTool({ name: 'read', arguments: { path: filePath } });
    assert.notStrictEqual(result.isError, true);
    const firstBlock = firstTextBlock(result);
    assert.strictEqual(firstBlock.type, 'text');
    assert.ok(firstBlock.text?.includes('legacy content'));
  });

  it('LEGACY-HTTP-002: a confirmation the client cannot answer fails closed with the named workaround', async () => {
    const dir = join(tmpDir, 'legacy_del_dir');
    await writeTestFile(tmpDir, 'legacy_del_dir/f.txt', 'x');

    const result = await legacy.callTool({
      name: 'delete',
      arguments: { paths: [dir], recursive: true },
    });

    assert.strictEqual(result.isError, true, 'must surface as a tool error, not a protocol error');
    const text = (result.content as { type: string; text?: string }[])
      .map((block) => block.text ?? '')
      .join('\n');
    assert.match(text, /confirmation this client cannot show/i);
    assert.match(text, /individually|elicitation capability/i);
    // Nothing was touched on the way out — the per-request instance never
    // reached the SDK's own elicitation round-trip.
    await access(join(dir, 'f.txt'));
  });

  it('LEGACY-HTTP-003: resources/subscribe is refused and takes no watcher lease', async () => {
    const filePath = await writeTestFile(tmpDir, 'legacy_watch.txt', 'x');
    const uri = buildFileResourceUri(filePath);

    assert.notStrictEqual(
      legacy.getServerCapabilities()?.resources?.subscribe,
      true,
      'a stateless legacy instance must not advertise resources/subscribe',
    );
    assert.notStrictEqual(
      legacy.getServerCapabilities()?.resources?.listChanged,
      true,
      'a stateless legacy instance has no stream to send list_changed on',
    );
    await assert.rejects(legacy.subscribeResource({ uri }));
    assert.strictEqual(
      harness.registry.size(),
      0,
      'a refused subscribe must not take a watcher lease on the throwaway instance',
    );
  });

  it('LEGACY-HTTP-004: the endpoint-shared result store serves a legacy request', async () => {
    await writeTestFile(tmpDir, 'legacy_pages/one.txt', 'x');
    await writeTestFile(tmpDir, 'legacy_pages/two.txt', 'x');
    await writeTestFile(tmpDir, 'legacy_pages/three.txt', 'x');

    const result = await legacy.callTool({
      name: 'list',
      arguments: { path: join(tmpDir, 'legacy_pages'), maxEntries: 1 },
    });
    const structured = result._meta as { resourceUri?: string };
    assert.ok(structured.resourceUri, 'an incomplete first page must carry the full-list URI');

    const read = await legacy.readResource({ uri: structured.resourceUri });
    assert.ok(
      read.contents.length > 0,
      'the externalized result must be readable by a legacy client',
    );
  });
});
