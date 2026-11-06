// Write a built server's tools/list as JSON, sorted by name, for TDQS scoring
// and for diffing two builds (the TDQS workflow compares a PR with its base).
// Usage: node scripts/tools-list.mjs <server entry> <root dir> <out file>
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [entry, root, out] = process.argv.slice(2);
if (!entry || !root || !out) {
  throw new Error('usage: node scripts/tools-list.mjs <server entry> <root dir> <out file>');
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(entry), resolve(root)],
  env: getDefaultEnvironment(),
  stderr: 'ignore',
});
const client = new Client({ name: 'tools-list', version: '0' });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

const sorted = tools.toSorted((a, b) => a.name.localeCompare(b.name));
writeFileSync(out, `${JSON.stringify({ tools: sorted }, null, 2)}\n`);
console.log(`${String(sorted.length)} tools -> ${out}`);
