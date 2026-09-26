// Publish filesystem-mcp.mcpb to Smithery with a server card built from the
// server's own tools/list. The Smithery CLI copies the manifest's `tools` into
// the card, but Smithery requires an `inputSchema` on each tool there and the
// MCPB schema rejects that key, so the CLI cannot publish this bundle.
//
// Run from the repo root after scripts/pack-mcpb.sh (needs dist/ and
// filesystem-mcp.mcpb). Needs SMITHERY_API_KEY unless --dry-run.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const SERVER = 'j0hanz/filesystem-mcp';
const RELEASES = `https://api.smithery.ai/servers/${encodeURIComponent(SERVER)}/releases`;
const IN_PROGRESS = new Set(['PENDING', 'WORKING']);

async function listTools() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js', tmpdir()],
  });
  const client = new Client({ name: 'publish-smithery', version: '0' });
  try {
    await client.connect(transport, { timeout: 15_000 });
    const { tools } = await client.listTools(undefined, { timeout: 15_000 });
    return tools;
  } finally {
    await client.close();
  }
}

const manifest = JSON.parse(await readFile('mcpb/manifest.json', 'utf8'));
const dirs = manifest.user_config.allowed_directories;
const tools = await listTools();
const payload = {
  type: 'stdio',
  runtime: 'node',
  serverCard: { serverInfo: { name: manifest.name, version: manifest.version }, tools },
  configSchema: {
    type: 'object',
    properties: {
      allowed_directories: {
        type: 'array',
        items: { type: 'string' },
        title: dirs.title,
        description: dirs.description,
      },
    },
    required: ['allowed_directories'],
  },
};

if (process.argv.includes('--dry-run')) {
  console.log(`Dry run: ${SERVER}@${manifest.version}, ${tools.length} tools, not published`);
  process.exit(0);
}

const key = process.env.SMITHERY_API_KEY;
// GitHub passes a missing secret and an empty one alike as "".
if (!key) throw new Error('SMITHERY_API_KEY is empty or not set');
const headers = { Authorization: `Bearer ${key}` };

async function readJson(res, what) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} returned non-JSON: ${text.slice(0, 500)}`);
  }
}

const form = new FormData();
form.set('payload', JSON.stringify(payload));
const bundle = await readFile('filesystem-mcp.mcpb');
form.set('bundle', new Blob([bundle], { type: 'application/zip' }), 'server.mcpb');
const release = await readJson(
  await fetch(RELEASES, { method: 'PUT', headers, body: form }),
  'Smithery publish',
);

// Stdio releases usually answer SUCCESS at once; poll the rest for up to 5 minutes.
let { status } = release;
for (let polls = 0; IN_PROGRESS.has(status); polls++) {
  if (polls === 60) {
    throw new Error(`Smithery release ${release.deploymentId} still ${status} after 5 minutes`);
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const url = `${RELEASES}/${release.deploymentId}`;
  ({ status } = await readJson(await fetch(url, { headers }), 'Smithery status check'));
}
if (status !== 'SUCCESS') {
  throw new Error(`Smithery release ${release.deploymentId} ended as ${status}`);
}
console.log(`Published ${SERVER}@${manifest.version} to Smithery (${release.deploymentId})`);
