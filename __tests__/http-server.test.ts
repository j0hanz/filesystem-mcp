import { ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import type { ClientRequest, OutgoingHttpHeaders, Server } from 'node:http';
import { request } from 'node:http';
import { type AddressInfo } from 'node:net';
import { json } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MAX_WATCHERS } from '../src/core/watcher-registry.ts';
import { startHttpServer } from '../src/transport.ts';
import {
  ALL_REGISTERED_TOOL_NAMES,
  bootHttpTest,
  cleanupTestRoot,
  createTestRoot,
  firstTextBlock,
  type HttpTestContext,
  TEST_API_KEY,
  writeTestFile,
} from './helpers.ts';

async function postWithoutEndingUpload(
  url: URL,
  headers: OutgoingHttpHeaders,
  send: (req: ClientRequest) => void,
): Promise<{ status: number | undefined; body: unknown }> {
  const response = Promise.withResolvers<{ status: number | undefined; body: unknown }>();
  const req = request(url, { method: 'POST', headers }, (res) => {
    void json(res).then(
      (body: unknown) => response.resolve({ status: res.statusCode, body }),
      response.reject,
    );
  });
  req.on('error', response.reject);
  const deadline = setTimeout(() => {
    response.reject(new Error('No response before the unfinished upload deadline'));
  }, 3000);
  try {
    send(req);
    const result = await response.promise;
    assert.strictEqual(req.writableEnded, false);
    return result;
  } finally {
    clearTimeout(deadline);
    req.destroy();
  }
}

describe('Real HTTP Server integration', () => {
  let tmpDir: string;
  let http: HttpTestContext;
  let base: URL;
  let port: number;

  beforeEach(async () => {
    tmpDir = await createTestRoot();
    http = await bootHttpTest([tmpDir]);
    ({ base, port } = http);
  });

  afterEach(async () => {
    await http.close();
    await cleanupTestRoot(tmpDir);
  });

  it('1. /healthz is open and reports ok', async () => {
    const r = await fetch(new URL(`http://127.0.0.1:${port}/healthz`));
    assert.strictEqual(r.status, 200);
    const body = (await r.json()) as { status: string };
    assert.strictEqual(body.status, 'ok');
  });

  it('2. POST /mcp without Authorization -> 401', async () => {
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(r.status, 401);
  });

  for (const contentType of ['text/plain', undefined]) {
    it(`rejects an unfinished ${contentType ?? 'missing Content-Type'} upload before reading its body`, async () => {
      const result = await postWithoutEndingUpload(
        base,
        {
          authorization: ['Bearer', TEST_API_KEY].join(' '),
          ...(contentType ? { 'content-type': contentType } : {}),
          'content-length': 5 * 1024 * 1024,
        },
        (req) => {
          req.flushHeaders();
          req.write('x');
        },
      );
      assert.strictEqual(result.status, 415);
      assert.deepStrictEqual(result.body, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message: 'Unsupported Media Type: Content-Type must be application/json',
        },
      });
    });
  }

  it('rejects an unframed empty JSON request before raw conversion', async () => {
    const result = await postWithoutEndingUpload(
      base,
      {
        authorization: ['Bearer', TEST_API_KEY].join(' '),
        'content-type': 'application/json',
      },
      (req) => {
        req.useChunkedEncodingByDefault = false;
        req.flushHeaders();
        assert.strictEqual(req.hasHeader('content-length'), false);
        assert.strictEqual(req.hasHeader('transfer-encoding'), false);
      },
    );
    assert.strictEqual(result.status, 400);
    assert.deepStrictEqual(result.body, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Invalid JSON in request body' },
    });
  });

  it('preserves InvalidRequest for JSON with an explicit zero content length', async () => {
    const result = await postWithoutEndingUpload(
      base,
      {
        authorization: ['Bearer', TEST_API_KEY].join(' '),
        'content-type': 'application/json',
        'content-length': 0,
      },
      (req) => req.flushHeaders(),
    );
    assert.strictEqual(result.status, 400);
    const body = result.body as { id: unknown; error: { code: unknown } };
    assert.strictEqual(body.id, null);
    assert.strictEqual(body.error.code, -32600);
  });

  for (const contentType of ['application/json; charset=utf-8', 'application/json; charset=']) {
    it(`accepts a completed modern request with ${contentType}`, async () => {
      const response = await fetch(base, {
        method: 'POST',
        headers: {
          authorization: ['Bearer', TEST_API_KEY].join(' '),
          'content-type': contentType,
          'mcp-method': 'server/discover',
          'mcp-protocol-version': '2026-07-28',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'admission',
          method: 'server/discover',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': { name: 'admission-test', version: '1.0.0' },
            },
          },
        }),
      });
      assert.strictEqual(response.status, 200);
      const body = (await response.json()) as { id: unknown; error?: unknown };
      assert.strictEqual(body.id, 'admission');
      assert.strictEqual(body.error, undefined);
    });
  }

  it('authenticates an unsupported upload before rejecting its content type', async () => {
    const result = await postWithoutEndingUpload(
      base,
      { 'content-type': 'text/plain', 'content-length': 5 * 1024 * 1024 },
      (req) => {
        req.flushHeaders();
        req.write('x');
      },
    );
    assert.strictEqual(result.status, 401);
    assert.deepStrictEqual(result.body, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Unauthorized' },
    });
  });

  it('3. Full MCP handshake + tool call over real HTTP with bearer', async () => {
    const client = await http.makeClient('http-server-test');
    try {
      const tools = await client.listTools();
      assert.strictEqual(tools.tools.length, ALL_REGISTERED_TOOL_NAMES.length);

      const file = await writeTestFile(tmpDir, 'real.txt', 'real-http-body');
      const res = await client.callTool({ name: 'read', arguments: { path: file } });
      assert.notStrictEqual(res.isError, true);
      const block = firstTextBlock(res);
      assert.ok(block.text?.includes('real-http-body'));
    } finally {
      await client.close();
    }
  });

  it('externalized tool result is readable back over HTTP', async () => {
    const client = await http.makeClient('result-roundtrip');
    try {
      // Two entries and a one-entry page: an incomplete first page externalizes
      // the full list.
      await writeTestFile(tmpDir, 'page-a.txt', 'body a\n');
      await writeTestFile(tmpDir, 'page-b.txt', 'body b\n');
      const res = (await client.callTool({
        name: 'list',
        arguments: { path: tmpDir, maxEntries: 1 },
      })) as {
        _meta?: { resourceUri?: string };
      };
      const uri = res._meta?.resourceUri;
      assert.ok(uri, 'an incomplete list page must externalize a result uri');
      const read = await client.readResource({ uri });
      assert.ok(read.contents.length > 0, 'the externalized result must be readable');
    } finally {
      await client.close();
    }
  });

  it('4. Legacy 2025 initialize over HTTP is served statelessly', async () => {
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${TEST_API_KEY}`,
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy-probe', version: '1.0.0' },
        },
      }),
    });
    assert.strictEqual(r.status, 200);
    const text = await r.text();
    assert.match(text, /"serverInfo"/);
    assert.match(text, /filesystem-mcp/);
  });

  it('5. POST /mcp with an oversized body -> 413', async () => {
    const tooBig = 'x'.repeat(5 * 1024 * 1024); // > DEFAULT_MAX_REQUEST_BODY_SIZE (4 MiB)
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: tooBig,
    });
    assert.strictEqual(r.status, 413);
    const body = (await r.json()) as { error?: { code?: number } };
    assert.ok(body.error, '413 must carry a JSON-RPC error object');
  });

  it('6. POST /mcp with malformed JSON -> 400 ParseError', async () => {
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: '{not json',
    });
    assert.strictEqual(r.status, 400);
    const body = (await r.json()) as { error?: { code?: number } };
    assert.ok(body.error, '400 must carry a JSON-RPC error object');
  });

  it('GET and DELETE /mcp preserve the SDK JSON-RPC 405 response', async () => {
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(base, {
        method,
        headers: { Authorization: ['Bearer', TEST_API_KEY].join(' ') },
      });
      assert.strictEqual(r.status, 405);
      assert.match(r.headers.get('content-type') ?? '', /^application\/json/u);
      assert.strictEqual(r.headers.get('allow'), 'POST, OPTIONS', 'RFC 9110 §15.5.6');
      const body = (await r.json()) as { error?: { code?: number; message?: string } };
      assert.strictEqual(body.error?.code, -32000);
      assert.strictEqual(body.error?.message, 'Method not allowed.');
    }
  });

  it('7. subscriptions/listen over remaining watcher capacity -> 400 InvalidParams pre-ack', async () => {
    const resourceSubscriptions = Array.from(
      { length: MAX_WATCHERS + 1 },
      (_, i) => `file:///fake-${i}`,
    );
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${TEST_API_KEY}`,
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscriptions/listen',
        params: { notifications: { resourceSubscriptions } },
      }),
    });
    assert.strictEqual(r.status, 400);
    const body = (await r.json()) as { error?: { code?: number; message?: string } };
    assert.strictEqual(body.error?.code, ProtocolErrorCode.InvalidParams);
    assert.ok(body.error?.message?.includes('watcher slots'));
  });

  async function requestWithHost(
    path: string,
    method: 'GET' | 'POST',
    host: string,
  ): Promise<{ status: number | undefined; body: unknown }> {
    const response = Promise.withResolvers<{ status: number | undefined; body: unknown }>();
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          host,
          authorization: ['Bearer', TEST_API_KEY].join(' '),
          'content-type': 'application/json',
        },
      },
      (res) => {
        void json(res).then(
          (body: unknown) => response.resolve({ status: res.statusCode, body }),
          response.reject,
        );
      },
    );
    req.on('error', response.reject);
    req.end(method === 'POST' ? '{}' : undefined);
    return response.promise;
  }

  for (const [method, path] of [
    ['POST', '/mcp'],
    ['GET', '/healthz'],
  ] as const) {
    it(`refuses a foreign Host header on ${method} ${path} with 403`, async () => {
      const result = await requestWithHost(path, method, 'evil.example');
      assert.strictEqual(result.status, 403);
      assert.strictEqual((result.body as { error?: { code?: number } }).error?.code, -32000);
    });
  }

  it('refuses a foreign Origin on POST /mcp with 403 under the loopback default', async () => {
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        origin: 'http://evil.example',
        'content-type': 'application/json',
        authorization: ['Bearer', TEST_API_KEY].join(' '),
      },
      body: '{}',
    });
    assert.strictEqual(r.status, 403);
    const body = (await r.json()) as { error?: { code?: number } };
    assert.strictEqual(body.error?.code, -32000);
  });
});

// The bearer credential reaches the server as `RuntimeConfig.apiKey`, never
// through `process.env`. These two prove the option is what the bind policy and
// the auth middleware actually read: with API_KEY deleted from the environment
// the option alone still demands a bearer, and with the option omitted an
// exported API_KEY no longer turns auth on.
describe('the api key travels as config, not env', () => {
  let tmpDir: string;
  let httpServer: Server;
  let savedApiKey: string | undefined;
  let savedStateKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await createTestRoot();
    savedApiKey = process.env['FS_API_KEY'];
    savedStateKey = process.env['FS_REQUEST_STATE_KEY'];
    Reflect.deleteProperty(process.env, 'FS_API_KEY');
    process.env['FS_REQUEST_STATE_KEY'] = 'a'.repeat(32);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (savedApiKey === undefined) Reflect.deleteProperty(process.env, 'FS_API_KEY');
    else process.env['FS_API_KEY'] = savedApiKey;
    if (savedStateKey === undefined) {
      Reflect.deleteProperty(process.env, 'FS_REQUEST_STATE_KEY');
    } else process.env['FS_REQUEST_STATE_KEY'] = savedStateKey;
    await cleanupTestRoot(tmpDir);
  });

  it('the apiKey option demands a bearer with API_KEY absent from the environment', async () => {
    httpServer = await startHttpServer(0, { cliAllowedDirs: [tmpDir] }, { apiKey: TEST_API_KEY });
    const port = (httpServer.address() as AddressInfo).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp`);

    const anon = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(anon.status, 401, 'the option alone must switch auth on');
    assert.match(
      anon.headers.get('www-authenticate') ?? '',
      /^Bearer /,
      'the 401 must carry an RFC 6750 challenge',
    );
  });

  it('an exported API_KEY does not switch auth on when the option is omitted', async () => {
    process.env['FS_API_KEY'] = TEST_API_KEY;
    httpServer = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    const port = (httpServer.address() as AddressInfo).port;

    const anon = await fetch(new URL(`http://127.0.0.1:${port}/mcp`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.notStrictEqual(anon.status, 401, 'env is read at the CLI boundary, not here');
  });
});

describe('rate limiting', () => {
  let tmpDir: string;
  let http: HttpTestContext;
  let base: URL;

  beforeEach(async () => {
    tmpDir = await createTestRoot();
    http = await bootHttpTest([tmpDir], { FS_RATE_LIMIT_RPM: '2' });
    ({ base } = http);
  });

  afterEach(async () => {
    await http.close();
    await cleanupTestRoot(tmpDir);
  });

  it('third authenticated POST within the window is rejected with 429', async () => {
    const headers = {
      'content-type': 'application/json',
      Authorization: `Bearer ${TEST_API_KEY}`,
    };
    // Lightweight bodies that the handler resolves quickly (legacy initialize
    // returns 400) so the limiter — which runs before the handler — counts
    // them before any handler work. The third is rate-limited pre-handler.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'rl', version: '1' },
      },
    });
    const r1 = await fetch(base, { method: 'POST', headers, body });
    const r2 = await fetch(base, { method: 'POST', headers, body });
    const r3 = await fetch(base, { method: 'POST', headers, body });
    assert.ok(r1.status < 500 && r2.status < 500);
    assert.strictEqual(r3.status, 429);
    const r3body = (await r3.json()) as { error?: { code?: number } };
    assert.ok(r3body.error, '429 must carry a JSON-RPC error object');
  });
});
