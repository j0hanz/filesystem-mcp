// Keyless end-to-end check: the real app and server against a scripted stub
// LLM on 127.0.0.1. Run `npm run build` at the repo root first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Call = { tool: string; args: string };
type StubReply = Call | { calls: Call[] } | { text: string } | { status: number };
type Run = {
  child: ChildProcess;
  requests: any[];
  ready: Promise<void>;
  done: Promise<number | null>;
  out: () => string;
  err: () => string;
  stop: () => Promise<void>;
  end: () => Promise<number | null>; // stop, then wait for exit
};

const here = import.meta.dirname;
const serverBin = process.env.FS_MCP_BIN ?? resolve(here, '../../../dist/index.js');
const QUIET = 200; // HOOKS_QUIET_MS for every run
const TASK = 'keep it tidy';
const quiet = (n: number): Promise<void> => new Promise((ok) => setTimeout(ok, QUIET * n));
async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await quiet(0.125);
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'hooks-check-'));
// The app is a daemon, so every run ends with SIGINT. child.kill() would not
// run handlers on Windows; this preload emits SIGINT in-process instead, on a
// stdout marker or when a stop file appears.
const stopPreload = join(scratch, 'stop.mjs');
await writeFile(
  stopPreload,
  `import { existsSync } from 'node:fs';
const fire = () => process.emit('SIGINT');
if (process.env.STOP_FILE) setInterval(() => existsSync(process.env.STOP_FILE) && fire(), 50);
const marker = process.env.STOP_ON_STDOUT;
if (marker) {
  const write = process.stdout.write.bind(process.stdout);
  let fired = false;
  process.stdout.write = (chunk, ...rest) => {
    if (!fired && String(chunk).includes(marker)) { fired = true; fire(); }
    return write(chunk, ...rest);
  };
}
`,
);

let runs = 0;
async function runHooks(opts: {
  dir: string;
  script: StubReply[];
  positionals?: string[];
  args?: string[];
  stdin?: string | null; // null keeps stdin open
  env?: Record<string, string>;
  beforeReply?: (n: number) => Promise<void>;
}): Promise<Run> {
  const requests: any[] = [];
  const stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      requests.push(JSON.parse(body));
      await opts.beforeReply?.(requests.length);
      const reply = opts.script[requests.length - 1] ?? { text: 'done' };
      if ('status' in reply) {
        res.statusCode = reply.status;
        return res.end('boom');
      }
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
  const stopFile = join(scratch, `stop-${++runs}`);

  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(stopPreload).href,
      join(here, 'hooks.ts'),
      ...(opts.positionals ?? [opts.dir, TASK]),
      ...(opts.args ?? []),
    ],
    {
      env: {
        ...process.env,
        LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
        LLM_MODEL: 'stub',
        FS_MCP_BIN: serverBin,
        HOOKS_QUIET_MS: String(QUIET),
        STOP_FILE: stopFile,
        ...opts.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let out = '';
  let err = '';
  let markReady: () => void = () => {};
  const ready = new Promise<void>((ok) => (markReady = ok));
  child.stdout!.on('data', (c) => {
    out += c;
    if (out.includes('watching ')) markReady();
  });
  child.stderr!.on('data', (c) => (err += c));
  if (opts.stdin !== null) child.stdin!.end(opts.stdin ?? '');
  const timer = setTimeout(() => child.kill(), 60_000);
  const done = new Promise<number | null>((ok) => child.on('close', ok)).finally(() => {
    clearTimeout(timer);
    stub.close();
    markReady(); // a run that dies before `watching` must not hang its caller
  });
  const stop = (): Promise<void> => writeFile(stopFile, '');
  return {
    child,
    requests,
    ready,
    done,
    out: () => out,
    err: () => err,
    stop,
    end: () => stop().then(() => done),
  };
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hooks-ws-'));
  await writeFile(join(dir, 'a.txt'), 'hello\n');
  await writeFile(join(dir, 'b.txt'), 'world\n');
  return dir;
}
const userMessage = (req: any): string => req.messages[1].content;
const lastToolMessage = (req: any): string => req.messages.at(-1).content;
const readA = (dir: string): Promise<string> => readFile(join(dir, 'a.txt'), 'utf8');
const touch = (dir: string, name: string): Promise<void> =>
  writeFile(join(dir, name), `${name} ${Date.now()}\n`);
// The trigger ritual: wait for `watching`, make one external change, wait for n requests.
async function trigger(r: Run, dir: string, n: number, name = 't.txt'): Promise<void> {
  await r.ready;
  await touch(dir, name);
  await waitFor(() => r.requests.length >= n);
}
const read = { tool: 'read', args: JSON.stringify({ path: 'a.txt' }) };
const editA = {
  tool: 'edit',
  args: JSON.stringify({ path: 'a.txt', edits: [{ oldText: 'hello', newText: 'bye' }] }),
};

// R2: bad arguments exit 1 with usage, before any server or model traffic.
let dir = await workspace();
let r = await runHooks({ dir, script: [], positionals: [] });
assert.equal(await r.done, 1);
assert.match(r.err(), /usage/);
r = await runHooks({ dir, script: [], positionals: [dir, '   '] });
assert.equal(await r.done, 1);
assert.match(r.err(), /usage/);
r = await runHooks({ dir, script: [], env: { LLM_MODEL: '' } });
assert.equal(await r.done, 1);
assert.match(r.err(), /--model/);
assert.equal(r.requests.length, 0);

// R4: a server that cannot start ends the app with exit 1 and a message.
const brokenServer = join(scratch, 'broken-server.mjs');
await writeFile(brokenServer, 'process.exit(1);\n');
r = await runHooks({ dir, script: [], env: { FS_MCP_BIN: brokenServer } });
assert.equal(await r.done, 1);
assert.match(r.err(), /filesystem-mcp (failed to start|exited)/);

// R3, R5, R7, R21, R16: one burst of external changes → exactly one turn
// that names each change; SIGINT exits 0.
r = await runHooks({ dir, script: [{ text: 'done' }] });
await r.ready;
assert.match(r.out(), new RegExp(`watching .*${dir.slice(-8).replace(/\\/g, '\\\\')}`));
assert.equal(r.requests.length, 0, 'no turn before a change (R3)');
await writeFile(join(dir, 'a.txt'), 'changed\n');
await rm(join(dir, 'b.txt'));
await touch(dir, 'c.txt');
await waitFor(() => r.requests.length >= 1);
let req = r.requests[0];
assert.deepEqual(
  req.messages.map((m: any) => m.role),
  ['system', 'user'],
);
assert.match(userMessage(req), new RegExp(TASK));
assert.match(userMessage(req), /modified: a\.txt/);
assert.match(userMessage(req), /deleted: b\.txt/);
assert.match(userMessage(req), /created: c\.txt/);
await quiet(3);
assert.equal(r.requests.length, 1, 'exactly one turn per burst (R5)');
assert.equal(await r.end(), 0, `SIGINT exits 0 (R16)\n${r.err()}`);

// R6: writes inside the quiet period coalesce into one turn.
dir = await workspace();
r = await runHooks({ dir, script: [{ text: 'done' }] });
await r.ready;
for (const name of ['x1.txt', 'x2.txt', 'x3.txt']) {
  await touch(dir, name);
  await quiet(0.3);
}
await waitFor(() => r.requests.length >= 1);
await quiet(3);
assert.equal(r.requests.length, 1, 'burst → one turn (R6)');
for (const name of ['x1', 'x2', 'x3'])
  assert.match(userMessage(r.requests[0]), new RegExp(`created: ${name}\\.txt`));
await r.end();

// R8: churn inside ignored directories starts no turn; hidden dirs still count.
dir = await workspace();
await mkdir(join(dir, '.git'));
await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
r = await runHooks({ dir, script: [{ text: 'done' }] });
await r.ready;
await touch(dir, join('.git', 'index'));
await quiet(4);
assert.equal(r.requests.length, 0, '.git/ churn is invisible (R8)');
await mkdir(join(dir, '.github'));
await trigger(r, dir, 1, join('.github', 'ci.yml'));
assert.match(userMessage(r.requests[0]), /created: \.github\/ci\.yml/);
await r.end();

// R9, R12: with --yes the model's edit applies unprompted and does not
// trigger a second turn.
dir = await workspace();
r = await runHooks({ dir, script: [editA, { text: 'done' }], args: ['--yes'] });
await trigger(r, dir, 2);
assert.doesNotMatch(lastToolMessage(r.requests[1]), /^ERROR: /);
await quiet(4);
assert.equal(r.requests.length, 2, 'own write starts no turn (R9)');
assert.equal(await readA(dir), 'bye\n');
assert.doesNotMatch(r.out(), /apply\?/, 'no gate prompt under --yes (R12)');
await r.end();

// R9: a rename keeps the old mtime; it is still the model's own write.
dir = await workspace();
const moveA = {
  tool: 'move',
  args: JSON.stringify({ moves: [{ source: 'a.txt', destination: 'c.txt' }] }),
};
r = await runHooks({ dir, script: [moveA, { text: 'done' }], args: ['--yes'] });
await trigger(r, dir, 2);
assert.doesNotMatch(lastToolMessage(r.requests[1]), /^ERROR: /);
await quiet(4);
assert.equal(r.requests.length, 2, 'rename is an own write (R9)');
assert.equal(await readFile(join(dir, 'c.txt'), 'utf8'), 'hello\n');
await assert.rejects(readA(dir));
await r.end();

// R23: a scan the server stopped early is refused, not diffed; the baseline
// stays, so the app recovers once the workspace fits again.
dir = await mkdtemp(join(tmpdir(), 'hooks-ws-'));
await writeFile(join(dir, 'a.txt'), 'hello\n');
r = await runHooks({ dir, script: [{ text: 'done' }], env: { HOOKS_MAX_FILES: '2' } });
await r.ready;
await touch(dir, 'b.txt');
await touch(dir, 'c.txt');
await waitFor(() => /scan incomplete/.test(r.err()));
await quiet(4);
assert.equal(r.requests.length, 0, 'incomplete scan starts no turn (R23)');
await rm(join(dir, 'b.txt'));
await rm(join(dir, 'c.txt'));
await writeFile(join(dir, 'a.txt'), 'changed\n');
await waitFor(() => r.requests.length >= 1);
assert.match(userMessage(r.requests[0]), /modified: a\.txt/);
await r.end();

// R23: an oversized workspace at startup exits 1 with the cause.
dir = await workspace();
await touch(dir, 'c.txt');
r = await runHooks({ dir, script: [], env: { HOOKS_MAX_FILES: '2' } });
assert.equal(await r.done, 1);
assert.match(r.err(), /scan incomplete/);

// R10, R21: an external change during a turn gets its own turn afterwards,
// and that turn starts fresh.
dir = await workspace();
r = await runHooks({
  dir,
  script: [read, { text: 'done' }, { text: 'done' }],
  beforeReply: async (n) => {
    if (n !== 2) return;
    await touch(dir, 'd.txt');
    await quiet(2);
  },
});
await trigger(r, dir, 3);
await quiet(3);
assert.equal(r.requests.length, 3, 'mid-turn change → one more turn (R10)');
assert.equal(r.requests[2].messages.length, 2, 'turns are stateless (R21)');
assert.match(userMessage(r.requests[2]), /created: d\.txt/);
await r.end();

// R11: the gate. `why:` and EOF both refuse; the file stays.
dir = await workspace();
r = await runHooks({ dir, script: [editA], stdin: 'why: keep it\n' });
await trigger(r, dir, 2);
assert.equal(lastToolMessage(r.requests[1]), 'rejected by user: keep it');
assert.match(r.out(), /apply\? \[y\/N\/why\]/);
assert.equal(await readA(dir), 'hello\n');
await r.end();
r = await runHooks({ dir, script: [editA], stdin: '' });
await trigger(r, dir, 2, 't2.txt');
assert.equal(lastToolMessage(r.requests[1]), 'rejected by user');
assert.equal(await readA(dir), 'hello\n');
await r.end();

// R13: server questions are not covered by --yes; at EOF they are declined.
const outside = await workspace();
r = await runHooks({
  dir,
  script: [{ tool: 'stat', args: JSON.stringify({ path: join(outside, 'a.txt') }) }],
  args: ['--yes'],
  stdin: '',
});
await trigger(r, dir, 2, 't3.txt');
assert.match(lastToolMessage(r.requests[1]), /^ERROR: /);
await r.end();

// R14: a failing model ends the turn, not the process; the next change runs.
dir = await workspace();
r = await runHooks({ dir, script: [{ status: 500 }, { text: 'done' }] });
await trigger(r, dir, 1);
await waitFor(() => /LLM 500/.test(r.err()));
await trigger(r, dir, 2, 't2.txt');
assert.equal(await r.end(), 0);

// R15: malformed tool arguments come back as an ERROR result.
r = await runHooks({ dir, script: [{ tool: 'read', args: '{bad' }] });
await trigger(r, dir, 2, 't3.txt');
assert.match(lastToolMessage(r.requests[1]), /^ERROR: /);
await r.end();

// R16: SIGINT while a gate prompt is open exits 0 promptly, file untouched.
dir = await workspace();
r = await runHooks({ dir, script: [editA], stdin: null, env: { STOP_ON_STDOUT: 'apply?' } });
await trigger(r, dir, 1);
const gateStart = Date.now();
assert.equal(await r.done, 0, r.err());
assert.ok(Date.now() - gateStart < 5000, 'exits within 5 s of the gate prompt');
assert.equal(await readA(dir), 'hello\n');

// R17: the server dying mid-session ends the app with exit 1.
const killFile = join(scratch, 'kill-server');
const dyingServer = join(scratch, 'dying-server.mjs');
await writeFile(
  dyingServer,
  `import { existsSync } from 'node:fs';
setInterval(() => existsSync(${JSON.stringify(killFile)}) && process.exit(0), 100);
await import(${JSON.stringify(pathToFileURL(serverBin).href)});`,
);
r = await runHooks({ dir, script: [], env: { FS_MCP_BIN: dyingServer } });
await r.ready;
await writeFile(killFile, '');
assert.equal(await r.done, 1);
assert.match(r.err(), /filesystem-mcp exited/);

// R22: the round cap ends a turn that never stops calling tools.
dir = await workspace();
r = await runHooks({ dir, script: Array(30).fill(read) });
await trigger(r, dir, 25);
await quiet(3);
assert.equal(r.requests.length, 25, 'cap at 25 rounds (R22)');
assert.match(r.out(), /stopped after 25/);
await r.end();

await rm(scratch, { recursive: true, force: true });
console.log('check: ok');
