// Keyless end-to-end check: runs the real agent and server against a scripted
// stub LLM on 127.0.0.1. Run `npm run build` at the repo root first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type StubReply = { tool: string; args: string } | { text: string };

const here = import.meta.dirname;
const serverBin = process.env.FS_MCP_BIN ?? resolve(here, '../../../dist/index.js');

async function runAgent(opts: {
  script: StubReply[];
  stdin: string;
  dir: string;
  env?: Record<string, string>;
}): Promise<{ code: number | null; stderr: string; requests: any[] }> {
  const requests: any[] = [];
  const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const reply = opts.script[requests.length - 1] ?? { text: 'done' };
      const message =
        'text' in reply
          ? { role: 'assistant', content: reply.text }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call_${requests.length}`,
                  type: 'function',
                  function: { name: reply.tool, arguments: reply.args },
                },
              ],
            };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise<void>((ok) => stub.listen(0, '127.0.0.1', ok));
  const port = (stub.address() as AddressInfo).port;

  const child = spawn(process.execPath, [join(here, 'agent.ts'), opts.dir, 'go'], {
    env: {
      ...process.env,
      LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
      LLM_MODEL: 'stub',
      FS_MCP_BIN: serverBin,
      ...opts.env,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  child.stdin.end(opts.stdin);
  const timer = setTimeout(() => child.kill(), 60_000);
  const code = await new Promise<number | null>((ok) => child.on('close', ok));
  clearTimeout(timer);
  stub.close();
  return { code, stderr, requests };
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gatekeeper-'));
  await writeFile(join(dir, 'a.txt'), 'hello\n');
  return dir;
}

const lastToolMessage = (r: { requests: any[] }): string => r.requests[1].messages.at(-1).content;

// Read round trip: the tool result reaches the model, after its tool_calls.
let dir = await workspace();
let r = await runAgent({
  dir,
  stdin: '',
  script: [{ tool: 'read', args: JSON.stringify({ path: 'a.txt' }) }],
});
assert.equal(r.code, 0, r.stderr);
const msgs = r.requests[1].messages;
const i = msgs.findIndex((m: any) => m.role === 'tool');
assert.ok(msgs[i - 1].tool_calls?.length, 'assistant tool_calls precede the tool reply');
assert.match(msgs[i].content, /hello/);

// Malformed arguments and unknown tools come back as ERROR results.
r = await runAgent({ dir, stdin: '', script: [{ tool: 'read', args: '{bad' }] });
assert.match(lastToolMessage(r), /^ERROR: /);
r = await runAgent({ dir, stdin: '', script: [{ tool: 'nope', args: '{}' }] });
assert.match(lastToolMessage(r), /^ERROR: /);

// Missing model and an unreachable LLM exit 1.
r = await runAgent({ dir, stdin: '', script: [], env: { LLM_MODEL: '' } });
assert.equal(r.code, 1);
assert.match(r.stderr, /--model/);
r = await runAgent({ dir, stdin: '', script: [], env: { LLM_BASE_URL: 'http://127.0.0.1:9/v1' } });
assert.equal(r.code, 1);

// Approval gate on a destructive tool.
const readA = (): Promise<string> => readFile(join(dir, 'a.txt'), 'utf8');
const editCall = {
  tool: 'edit',
  args: JSON.stringify({ path: 'a.txt', edits: [{ oldText: 'hello', newText: 'bye' }] }),
};
r = await runAgent({ dir, stdin: 'why: keep it\n', script: [editCall] });
assert.equal(await readA(), 'hello\n');
assert.equal(lastToolMessage(r), 'rejected by user: keep it');
r = await runAgent({ dir, stdin: '', script: [editCall] }); // EOF at the prompt = N
assert.equal(r.code, 0, r.stderr);
assert.equal(await readA(), 'hello\n');
assert.equal(lastToolMessage(r), 'rejected by user');
r = await runAgent({ dir, stdin: 'y\n', script: [editCall] });
assert.equal(await readA(), 'bye\n');
// A failing dry run goes straight to the model; the 'y' is never read.
r = await runAgent({
  dir,
  stdin: 'y\n',
  script: [
    {
      tool: 'edit',
      args: JSON.stringify({ path: 'a.txt', edits: [{ oldText: 'zzz', newText: 'q' }] }),
    },
  ],
});
assert.match(lastToolMessage(r), /^ERROR: /);
assert.equal(await readA(), 'bye\n');

console.log('check: ok');
