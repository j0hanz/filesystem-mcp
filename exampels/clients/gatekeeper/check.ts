// Keyless end-to-end check: runs the real agent and server against a scripted
// stub LLM on 127.0.0.1. Run `npm run build` at the repo root first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Call = { tool: string; args: string };
type StubReply = Call | { calls: Call[] } | { text: string };

const here = import.meta.dirname;
const serverBin = process.env.FS_MCP_BIN ?? resolve(here, '../../../dist/index.js');

async function runAgent(opts: {
  script: StubReply[];
  stdin: string;
  dir: string;
  env?: Record<string, string>;
  nodeArgs?: string[];
  beforeReply?: (n: number) => Promise<void>;
}): Promise<{ code: number | null; stderr: string; requests: any[] }> {
  const requests: any[] = [];
  const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      requests.push(JSON.parse(body));
      await opts.beforeReply?.(requests.length);
      const reply = opts.script[requests.length - 1] ?? { text: 'done' };
      const message =
        'text' in reply
          ? { role: 'assistant', content: reply.text }
          : {
              role: 'assistant',
              content: null,
              tool_calls: ('calls' in reply ? reply.calls : [reply]).map((call, n) => ({
                id: `call_${requests.length}_${n}`,
                type: 'function',
                function: { name: call.tool, arguments: call.args },
              })),
            };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise<void>((ok) => stub.listen(0, '127.0.0.1', ok));
  const port = (stub.address() as AddressInfo).port;

  const child = spawn(
    process.execPath,
    [...(opts.nodeArgs ?? []), join(here, 'agent.ts'), opts.dir, 'go'],
    {
      env: {
        ...process.env,
        LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
        LLM_MODEL: 'stub',
        FS_MCP_BIN: serverBin,
        ...opts.env,
      },
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
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
// OpenAI and Anthropic reject function schemas with top-level combinators.
for (const { function: fn } of r.requests[0].tools) {
  assert.equal(fn.parameters.type, 'object', fn.name);
  for (const key of ['oneOf', 'anyOf', 'allOf', 'not']) assert.ok(!(key in fn.parameters), fn.name);
}

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

// Server confirmations: access outside the root, then an overwrite choice.
const outside = await workspace();
const statOutside = {
  tool: 'stat',
  args: JSON.stringify({ path: join(outside, 'a.txt') }),
};
r = await runAgent({ dir, stdin: 'y\n', script: [statOutside] });
assert.doesNotMatch(lastToolMessage(r), /^ERROR: /);
r = await runAgent({ dir, stdin: 'n\n', script: [statOutside] });
assert.match(lastToolMessage(r), /^ERROR: /);
const overwrite = {
  tool: 'create',
  args: JSON.stringify({ files: [{ path: 'a.txt', content: 'new\n' }] }),
};
r = await runAgent({ dir, stdin: 'y\n1\n', script: [overwrite] }); // gate y, then choice 1
assert.equal(await readA(), 'new\n');

// Server dies mid-turn: the session ends with a clear message instead of
// carrying on with no tools.
const trigger = join(outside, 'kill-server');
const dyingServer = join(outside, 'dying-server.mjs');
await writeFile(
  dyingServer,
  `import { existsSync } from 'node:fs';
setInterval(() => existsSync(${JSON.stringify(trigger)}) && process.exit(0), 100);
await import(${JSON.stringify(pathToFileURL(serverBin).href)});`,
);
r = await runAgent({
  dir,
  stdin: '',
  script: [],
  env: { FS_MCP_BIN: dyingServer },
  beforeReply: async () => {
    await writeFile(trigger, '');
    await new Promise((ok) => setTimeout(ok, 3000));
  },
});
assert.equal(r.code, 1);
assert.match(r.stderr, /filesystem-mcp exited/);

// Ctrl+C at a gate ends the turn: the next line starts a new turn instead of
// answering a leftover prompt.
const sigintAtGate = join(outside, 'sigint-at-gate.mjs');
await writeFile(
  sigintAtGate,
  `const write = process.stdout.write.bind(process.stdout);
let fired = false;
process.stdout.write = (chunk, ...rest) => {
  if (!fired && String(chunk).includes('apply?')) {
    fired = true;
    process.emit('SIGINT'); // pressed while the prompt shows, before any answer
  }
  return write(chunk, ...rest);
};`,
);
const createFile = (name: string): Call => ({
  tool: 'create',
  args: JSON.stringify({ files: [{ path: name, content: 'x\n' }] }),
});
r = await runAgent({
  dir,
  stdin: 'n\nsecond\n',
  script: [{ calls: [createFile('x1.txt'), createFile('x2.txt')] }],
  nodeArgs: ['--import', pathToFileURL(sigintAtGate).href],
});
assert.ok(
  r.requests.some((req) => req.messages.at(-1).content === 'second'),
  'line after Ctrl+C starts a new turn',
);

console.log('check: ok');
