// Publish filesystem-mcp.mcpb to Smithery with a server card built from the
// server's own tools/list. The Smithery CLI copies the manifest's `tools` into
// the card, but Smithery requires an `inputSchema` on each tool there and the
// MCPB schema rejects that key, so the CLI cannot publish this bundle.
//
// Run from the repo root after scripts/pack-mcpb.sh (needs dist/ and
// filesystem-mcp.mcpb). Needs SMITHERY_API_KEY unless --dry-run.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const SERVER = 'j0hanz/filesystem-mcp';
const RELEASES = `https://api.smithery.ai/servers/${encodeURIComponent(SERVER)}/releases`;
const IN_PROGRESS = new Set(['PENDING', 'WORKING']);

async function listTools() {
  const child = spawn(process.execPath, ['dist/index.js', tmpdir()], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tools/list timed out')), 15_000);
      child.on('exit', (code) => reject(new Error(`server exited (${code}) before tools/list`)));
      let buffered = '';
      child.stdout.on('data', (chunk) => {
        const lines = (buffered + chunk).split('\n');
        buffered = lines.pop();
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            send({ method: 'notifications/initialized' });
            send({ id: 2, method: 'tools/list' });
          } else if (msg.id === 2) {
            clearTimeout(timer);
            resolve(msg.result.tools);
          }
        }
      });
      send({
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'publish-smithery', version: '0' },
        },
      });
    });
  } finally {
    child.kill();
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
if (!key) throw new Error('SMITHERY_API_KEY is not set');
const headers = { Authorization: `Bearer ${key}` };

const form = new FormData();
form.set('payload', JSON.stringify(payload));
const bundle = await readFile('filesystem-mcp.mcpb');
form.set('bundle', new Blob([bundle], { type: 'application/zip' }), 'server.mcpb');
const res = await fetch(RELEASES, { method: 'PUT', headers, body: form });
const release = await res.json();
if (!res.ok) {
  throw new Error(`Smithery publish failed: HTTP ${res.status} ${JSON.stringify(release)}`);
}

// Stdio releases usually answer SUCCESS at once; poll the rest for up to 5 minutes.
let { status } = release;
for (let polls = 0; IN_PROGRESS.has(status) && polls < 60; polls++) {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  ({ status } = await (await fetch(`${RELEASES}/${release.deploymentId}`, { headers })).json());
}
if (status !== 'SUCCESS') {
  throw new Error(`Smithery release ${release.deploymentId} ended as ${status}`);
}
console.log(`Published ${SERVER}@${manifest.version} to Smithery (${release.deploymentId})`);
