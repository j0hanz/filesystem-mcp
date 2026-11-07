// browser: a local web UI for one workspace. filesystem-mcp does the file
// work; when it needs a person's OK, the question is shown in the page.
import { Client } from '@modelcontextprotocol/client';
import type { CallToolRequest } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '8787' },
    'read-only': { type: 'boolean', default: false },
  },
});
if (!positionals[0]) {
  console.error('usage: node server.ts <dir> [--port 8787] [--read-only]');
  process.exit(1);
}
const dir = resolve(positionals[0]);

const serverArgs = [...(values['read-only'] ? ['--read-only'] : []), dir];
const bin = process.env.FS_MCP_BIN;
const transport = new StdioClientTransport({
  command: bin ? process.execPath : 'npx',
  args: bin ? [resolve(bin), ...serverArgs] : ['-y', '@j0hanz/filesystem-mcp', ...serverArgs],
  cwd: dir,
  stderr: 'pipe',
});

// Manual multi-round-trip mode. When the server needs a confirmation,
// callTool() returns it as an `input_required` result instead of calling an
// elicitation handler. A web backend cannot wait on a person mid-request, so
// it passes the questions to the page, and the page repeats the call with the
// answers plus the server's opaque requestState.
const client = new Client(
  { name: 'browser', version: '1.0.0' },
  {
    // Declared even though no handler is registered: without it the server
    // refuses risky calls outright instead of asking.
    capabilities: { elicitation: { form: {} } },
    // input_required is 2026-07-28 vocabulary; a pinned era fails loudly.
    versionNegotiation: { mode: { pin: '2026-07-28' } },
    inputRequired: { autoFulfill: false },
  },
);
let closing = false;
client.onclose = () => {
  if (closing) return;
  console.error('filesystem-mcp exited');
  process.exit(1);
};

// The page's whole API. Each route is one MCP request.
const routes: Record<string, (body: any) => Promise<unknown>> = {
  // { name, arguments, inputResponses?, requestState? } → a CallToolResult,
  // or { resultType: 'input_required', inputRequests, requestState }.
  call: (body) => client.callTool(body as CallToolRequest['params'], { allowInputRequired: true }),
  // The file template completes its {+path} variable (percent-encoded).
  complete: (body) =>
    client.complete({
      ref: { type: 'ref/resource', uri: 'filesystem-mcp://file/{+path}' },
      argument: { name: 'path', value: String(body.value) },
    }),
  // Text comes back as `text`, images and other binaries as base64 `blob`.
  // The server marks file reads cacheable for 5 s; a viewer that just saved
  // the file wants the bytes on disk, so it bypasses the client's cache.
  read: (body) => client.readResource({ uri: String(body.uri) }, { cacheMode: 'bypass' }),
  info: async () => ({
    roots: (await client.callTool({ name: 'list_roots', arguments: {} })).structuredContent,
    tools: (await client.listTools()).tools.map((tool) => tool.name),
  }),
};

const page = await readFile(join(import.meta.dirname, 'index.html'));
let port = 0;

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, body: unknown, type = 'application/json'): void => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  // Any other Host is a DNS-rebinding page reaching 127.0.0.1; refuse it.
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? ''))
    return send(403, { error: 'unexpected Host' });
  if (req.method === 'GET' && req.url === '/') return send(200, page, 'text/html; charset=utf-8');
  const route = routes[req.url?.replace(/^\/api\//, '') ?? ''];
  // JSON POSTs only: another site's page cannot send one without a CORS
  // preflight, which this server never approves.
  if (!route || req.method !== 'POST' || req.headers['content-type'] !== 'application/json')
    return send(404, { error: 'not found' });
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    send(200, await route(JSON.parse(raw || '{}')));
  } catch (error) {
    // Thrown, not isError: unknown tool, bad URI, a file outside the roots.
    send(500, { error: error instanceof Error ? error.message : 'Request failed' });
  }
}

await client.connect(transport);
const http = createServer((req, res) => void handle(req, res));
http.listen(Number(values.port), '127.0.0.1', () => {
  port = (http.address() as AddressInfo).port;
  console.log(`browser: http://127.0.0.1:${port}/  (workspace ${dir})`);
});
process.on('SIGINT', () => {
  closing = true; // the server exiting now is not a crash
  http.close();
  void client.close().then(() => process.exit(0));
});
