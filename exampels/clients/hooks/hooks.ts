// hooks: an event-driven agent. filesystem-mcp watches the workspace and
// supplies the tools; any OpenAI-compatible chat endpoint runs the standing
// task each time something outside this process changes a file.
import { Client } from '@modelcontextprotocol/client';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type Msg = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
type Change = { kind: 'created' | 'modified' | 'deleted'; path: string; modified?: string };
type Snapshot = Map<string, string>; // workspace-relative path → modified (ISO)

const MAX_ROUNDS = 25;
const QUIET_MS = Number(process.env.HOOKS_QUIET_MS) || 1000;
const PROVIDERS: Record<string, { baseUrl: string; keyEnv?: string }> = {
  ollama: { baseUrl: 'http://localhost:11434/v1' },
  openai: { baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY' },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
  },
};
const USAGE = `usage: node hooks.ts <dir> <task> [--provider ${Object.keys(PROVIDERS).join('|')}] --model <id> [--yes]

  <task> runs through the model every time a file under <dir> changes, e.g.
    node hooks.ts . "keep the README's API section in sync with src/" --model qwen3
  --model (or LLM_MODEL) is required. --yes applies the model's file changes
  without asking. LLM_BASE_URL and LLM_API_KEY override the provider preset.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: 'string', default: 'ollama' },
    model: { type: 'string' },
    yes: { type: 'boolean', default: false },
  },
});
const [dirArg, task] = positionals;
const preset = PROVIDERS[values.provider];
const model = values.model || process.env.LLM_MODEL;
if (!dirArg || !task?.trim() || !preset || !model) {
  console.error(USAGE);
  process.exit(1);
}
const dir = resolve(dirArg);
const baseUrl = process.env.LLM_BASE_URL || preset.baseUrl;
const apiKey = process.env.LLM_API_KEY || (preset.keyEnv && process.env[preset.keyEnv]);

// Gate answers and the server's questions are read from stdin between events.
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdin.isTTY),
});
const lines = rl[Symbol.asyncIterator]();
let inputClosed = false;
rl.on('close', () => (inputClosed = true));

async function ask(prompt: string): Promise<string | null> {
  if (inputClosed) process.stdout.write(prompt);
  else {
    rl.setPrompt(prompt);
    rl.prompt();
  }
  const { value, done } = await lines.next();
  return done ? null : value;
}

const bin = process.env.FS_MCP_BIN;
const transport = new StdioClientTransport({
  command: bin ? process.execPath : 'npx',
  args: bin ? [resolve(bin), dir] : ['-y', '@j0hanz/filesystem-mcp', dir],
  cwd: dir, // relative tool paths resolve inside the workspace
  stderr: 'pipe',
});
let serverLog = '';
transport.stderr?.on('data', (chunk) => (serverLog = (serverLog + chunk).slice(-2048)));

const client = new Client(
  { name: 'hooks', version: '1.0.0' },
  {
    capabilities: { elicitation: { form: {} } },
    // The 2026-07-28 era carries subscriptions/listen and the server's confirmations.
    versionNegotiation: { mode: 'auto' },
  },
);

let current: AbortController | null = null; // the running turn, if any
let closing = false;
let timer: NodeJS.Timeout | null = null;
client.onclose = () => {
  if (closing) return;
  console.error('filesystem-mcp exited');
  process.exit(1);
};

// The server's own questions: access outside the root, overwrites, recursive
// deletes. Always asked on stdin; --yes covers only this app's gate.
client.setRequestHandler('elicitation/create', async (request) => {
  const params = request.params;
  if (params.mode === 'url') return { action: 'decline' };
  const fields = Object.entries(params.requestedSchema.properties);
  if (fields.length !== 1) return { action: 'decline' };
  const [key, field] = fields[0] as [string, { type?: string; enum?: string[] }];
  console.log(`server asks: ${params.message}`);
  if (field.type === 'boolean') {
    const answer = await ask('y/N ');
    return answer?.trim().toLowerCase() === 'y'
      ? { action: 'accept', content: { [key]: true } }
      : { action: 'decline' };
  }
  if (field.enum) {
    field.enum.forEach((option, n) => console.log(`  ${n + 1}) ${option}`));
    const picked = field.enum[Number(await ask('choice: ')) - 1];
    return picked ? { action: 'accept', content: { [key]: picked } } : { action: 'decline' };
  }
  return { action: 'decline' };
});

function toText(result: CallToolResult): string {
  const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  return result.isError ? `ERROR: ${text}` : text;
}

const toolsByName = new Map<string, Tool>();

// Returns null when the user approves, else the tool result to send the model.
async function gate(tool: Tool, args: Record<string, unknown>, signal: AbortSignal) {
  if ('dryRun' in (tool.inputSchema.properties ?? {})) {
    const dryRun = { name: tool.name, arguments: { ...args, dryRun: true } };
    const preview = toText((await client.callTool(dryRun, { signal })) as CallToolResult);
    if (preview.startsWith('ERROR: ')) return preview;
    console.log(preview);
  }
  const answer = (await ask('apply? [y/N/why] '))?.trim() ?? '';
  if (answer.toLowerCase() === 'y') return null;
  const why = /^why:\s*(.+)/i.exec(answer)?.[1];
  return why ? `rejected by user: ${why}` : 'rejected by user';
}

// This turn's own writes are not external changes: a path the destructive call
// named (or a directory it named), or an mtime within 2 s before the call to
// just after it — the slack covers filesystems that round timestamps.
const ownWindows: [number, number][] = [];
const ownPaths = new Set<string>();
const namePaths = (value: unknown): void => {
  if (typeof value === 'string')
    ownPaths.add(value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''));
  else if (value && typeof value === 'object') Object.values(value).forEach(namePaths);
};

async function runTool(call: ToolCall, signal: AbortSignal): Promise<string> {
  try {
    const args = JSON.parse(call.function.arguments || '{}');
    console.log(`· ${call.function.name} ${JSON.stringify(args).slice(0, 120)}`);
    const tool = toolsByName.get(call.function.name);
    const destructive = Boolean(tool?.annotations?.destructiveHint);
    if (tool && destructive && !values.yes) {
      const refusal = await gate(tool, args, signal);
      if (refusal !== null) return refusal;
    }
    const started = Date.now();
    const result = await client.callTool({ name: call.function.name, arguments: args }, { signal });
    if (destructive) {
      ownWindows.push([started - 2_100, Date.now() + 100]);
      namePaths(args);
    }
    return toText(result as CallToolResult);
  } catch (error) {
    if (signal.aborted) throw error;
    return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function chat(messages: Msg[], tools: unknown[], signal: AbortSignal): Promise<Msg> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages, tools }),
    signal,
  }).catch((error: Error) => {
    throw new Error(`LLM unreachable at ${baseUrl}: ${String(error.cause ?? error.message)}`);
  });
  if (!response.ok) {
    throw new Error(`LLM ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const body = (await response.json()) as { choices: { message: Msg }[] };
  return body.choices[0].message;
}

// Change discovery goes through the server: the notification names only the
// directory, so the app diffs a find_files + stat snapshot against the last one.
// A listing the server could not complete (more pages, a stopped scan, an
// error) is refused outright: diffing it would report unreached files as deleted.
async function snapshot(): Promise<Snapshot> {
  const cap = Number(process.env.HOOKS_MAX_FILES) || 10000;
  const args = { pattern: '**/*', includeHidden: true, maxResults: cap };
  const found = (await client.callTool({ name: 'find_files', arguments: args })) as CallToolResult;
  const lines = toText(found).split('\n');
  const partial = lines.find((l) => /^(\/\/ showing|\/\/ scan stopped early|ERROR: )/.test(l));
  if (partial)
    throw new Error(`snapshot skipped, scan incomplete: ${partial.replace(/^\/\/ /, '')}`);
  const paths = lines.filter((l) => l && !l.startsWith('//'));
  const snap: Snapshot = new Map();
  for (let i = 0; i < paths.length; i += 1000) {
    const stat = { name: 'stat', arguments: { paths: paths.slice(i, i + 1000) } };
    const { results } = ((await client.callTool(stat)) as CallToolResult).structuredContent as {
      results: { path: string; value?: { modified: string } }[];
    };
    for (const entry of results) if (entry.value) snap.set(entry.path, entry.value.modified);
  }
  return snap;
}

function diff(before: Snapshot, after: Snapshot): Change[] {
  const changes: Change[] = [];
  for (const [path, modified] of after) {
    const previous = before.get(path);
    if (previous === undefined) changes.push({ kind: 'created', path, modified });
    else if (previous !== modified) changes.push({ kind: 'modified', path, modified });
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push({ kind: 'deleted', path });
  return changes;
}

const isOwn = (change: Change): boolean => {
  for (const p of ownPaths) if (change.path === p || change.path.startsWith(`${p}/`)) return true;
  if (change.kind === 'deleted') return false;
  const at = Date.parse(change.modified ?? '');
  return ownWindows.some(([from, to]) => at >= from && at <= to);
};

let system = '';
let openaiTools: unknown[] = [];
let baseline: Snapshot = new Map();
let running = false;
let pending = false; // a quiet period ended while a turn was running

// One conversation: system prompt + the standing task with the change list.
// Ctrl+C aborts it and the abort propagates; other failures end the turn here.
async function converse(changes: Change[]): Promise<void> {
  ownWindows.length = 0;
  ownPaths.clear();
  const controller = new AbortController();
  current = controller;
  const list = changes.map((c) => `- ${c.kind}: ${c.path}`).join('\n');
  console.log(`\nchanged:\n${list}`);
  const user = `${task}\n\nChanged since the last turn (paths relative to ${dir}):\n${list}`;
  const messages: Msg[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const reply = await chat(messages, openaiTools, controller.signal);
      messages.push(reply); // verbatim: providers reject tool replies without it
      if (!reply.tool_calls?.length) return console.log(reply.content ?? '');
      for (const call of reply.tool_calls) {
        controller.signal.throwIfAborted();
        const content = await runTool(call, controller.signal);
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
    console.log(`(stopped after ${MAX_ROUNDS} tool rounds)`);
  } catch (error) {
    if (controller.signal.aborted) throw error;
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    current = null;
  }
}

async function onQuiet(): Promise<void> {
  timer = null;
  if (closing) return;
  if (running) {
    pending = true;
    return;
  }
  running = true;
  try {
    const now = await snapshot();
    let changes = diff(baseline, now);
    baseline = now;
    while (changes.length > 0) {
      await converse(changes);
      // What moved during the turn, minus this turn's own writes, is the next turn.
      const after = await snapshot();
      changes = diff(baseline, after).filter((c) => !isOwn(c));
      baseline = after;
    }
  } catch (error) {
    if (!closing) console.error(error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
    if (pending) {
      pending = false;
      schedule();
    }
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void onQuiet(), QUIET_MS);
}

try {
  await client.connect(transport).catch((error) => {
    throw new Error(`filesystem-mcp failed to start: ${String(error)}\n${serverLog}`);
  });
  const { tools } = await client.listTools();
  for (const tool of tools) toolsByName.set(tool.name, tool);
  openaiTools = tools.map((tool) => {
    // OpenAI and Anthropic reject top-level combinators; the server still validates.
    const { oneOf, anyOf, allOf, not, ...parameters } = tool.inputSchema as Record<string, unknown>;
    const fn = { name: tool.name, description: tool.description ?? '', parameters };
    return { type: 'function', function: fn };
  });
  const { contents } = await client.readResource({ uri: 'internal://instructions' });
  system = `${contents.map((c) => ('text' in c ? c.text : '')).join('\n')}\n\nWorkspace root: ${dir}`;

  baseline = await snapshot();
  const posix = encodeURIComponent(dir.replace(/\\/g, '/')).replace(/%2F/gi, '/');
  client.setNotificationHandler('notifications/resources/updated', () => schedule());
  const subscription = await client.listen({
    resourceSubscriptions: [`filesystem-mcp://file/${posix}`],
  });
  console.log(`watching ${dir}`);

  // Ctrl+C: abort the running turn, close the server, exit 0.
  const interrupt = (): void => {
    if (closing) return;
    closing = true;
    current?.abort();
    if (timer) clearTimeout(timer);
    void Promise.allSettled([subscription.close(), client.close()]).then(() => process.exit(0));
  };
  rl.on('SIGINT', interrupt); // terminal (raw mode)
  process.on('SIGINT', interrupt); // piped input
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  closing = true;
  await client.close().catch(() => {});
  process.exit(1);
}
