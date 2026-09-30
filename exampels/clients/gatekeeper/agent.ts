// gatekeeper: a terminal coding agent. filesystem-mcp provides the workspace
// tools; any OpenAI-compatible chat endpoint provides the model.
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
type OpenAITool = {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
};

const MAX_ROUNDS = 25;
const PROVIDERS: Record<string, { baseUrl: string; keyEnv?: string }> = {
  ollama: { baseUrl: 'http://localhost:11434/v1' },
  openai: { baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY' },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
  },
};
const USAGE = `usage: node agent.ts <dir> [task] [--provider ${Object.keys(PROVIDERS).join('|')}] --model <id>

  --model (or LLM_MODEL) is required, e.g.
    --provider ollama --model qwen3
    --provider gemini --model gemini-flash-latest
    --provider anthropic --model claude-sonnet-5-5
  LLM_BASE_URL and LLM_API_KEY override the provider preset.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { provider: { type: 'string', default: 'ollama' }, model: { type: 'string' } },
});
const [dirArg, task] = positionals;
const preset = PROVIDERS[values.provider];
const model = values.model || process.env.LLM_MODEL;
if (!dirArg || !preset || !model) {
  console.error(USAGE);
  process.exit(1);
}
const dir = resolve(dirArg);
const baseUrl = process.env.LLM_BASE_URL || preset.baseUrl;
const apiKey = process.env.LLM_API_KEY || (preset.keyEnv && process.env[preset.keyEnv]);

// One shared line iterator: it buffers piped lines that arrive before a prompt
// is asked, where rl.question() would drop them.
// In a terminal, raw mode turns Ctrl+C into a keypress: no SIGINT reaches the
// server, which shares our process group on POSIX.
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: Boolean(process.stdin.isTTY),
});
const lines = rl[Symbol.asyncIterator]();
let inputClosed = false;
rl.on('close', () => (inputClosed = true));

async function ask(prompt: string): Promise<string | null> {
  if (inputClosed) {
    process.stdout.write(prompt); // lines may still be buffered after EOF
  } else {
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
  stderr: 'pipe', // keep server logs out of the REPL
});
let serverLog = '';
transport.stderr?.on('data', (chunk) => (serverLog = (serverLog + chunk).slice(-2048)));

const client = new Client(
  { name: 'gatekeeper', version: '1.0.0' },
  {
    capabilities: { elicitation: { form: {} } },
    // The 2026-07-28 era carries the server's confirmations (input_required).
    versionNegotiation: { mode: 'auto' },
  },
);

let current: AbortController | null = null; // the running turn, if any
let closing = false;
// A server that dies mid-session ends it; carrying on would leave no tools.
client.onclose = () => {
  if (closing) return;
  console.error('filesystem-mcp exited');
  process.exitCode = 1;
  current?.abort();
  rl.close();
};

// The server's own questions: access outside the root, overwrites, recursive
// deletes. Its forms are one boolean `confirm` or one enum `choice`.
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
  return { action: 'decline' }; // e.g. a multi-select grant
});

function withoutCombinators(schema: Tool['inputSchema']): Record<string, unknown> {
  const { oneOf, anyOf, allOf, not, ...rest } = schema as Record<string, unknown>;
  return rest;
}

function toText(result: CallToolResult): string {
  const text = result.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
  return result.isError ? `ERROR: ${text}` : text;
}

// Filled from listTools(); annotations and schemas drive the gate.
const toolsByName = new Map<string, Tool>();

// Returns null when the user approves, else the tool result to send the model.
async function gate(
  tool: Tool,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string | null> {
  if ('dryRun' in (tool.inputSchema.properties ?? {})) {
    const preview = toText(
      (await client.callTool(
        { name: tool.name, arguments: { ...args, dryRun: true } },
        { signal },
      )) as CallToolResult,
    );
    if (preview.startsWith('ERROR: ')) return preview; // nothing sane to approve
    console.log(preview);
  } else if (Array.isArray(args.files)) {
    const files = args.files as { path?: string; content?: string }[];
    const summary = files.map((f) => `${f.path} (${f.content?.split('\n').length ?? 0} lines)`);
    console.log(`${tool.name} ${summary.join(', ')}`);
  } else {
    console.log(`${tool.name} ${JSON.stringify(args).slice(0, 120)}`);
  }
  // ponytail: no stale-preview check between dry run and apply; exact-match
  // edit fails instead of corrupting, and the model sees that error.
  const answer = (await ask('apply? [y/N/why] '))?.trim() ?? '';
  if (answer.toLowerCase() === 'y') return null;
  const why = /^why:\s*(.+)/i.exec(answer)?.[1];
  return why ? `rejected by user: ${why}` : 'rejected by user';
}

async function runTool(call: ToolCall, signal: AbortSignal): Promise<string> {
  try {
    const args = JSON.parse(call.function.arguments || '{}');
    console.log(`· ${call.function.name} ${JSON.stringify(args).slice(0, 120)}`);
    const tool = toolsByName.get(call.function.name);
    if (tool?.annotations?.destructiveHint) {
      const refusal = await gate(tool, args, signal);
      if (refusal !== null) return refusal;
    }
    const result = await client.callTool({ name: call.function.name, arguments: args }, { signal });
    return toText(result as CallToolResult);
  } catch (error) {
    if (signal.aborted) throw error; // Ctrl+C ends the turn, not just this call
    return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function chat(messages: Msg[], tools: OpenAITool[], signal: AbortSignal): Promise<Msg> {
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

try {
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`filesystem-mcp failed to start: ${String(error)}\n${serverLog}`);
  }
  const { tools } = await client.listTools();
  for (const tool of tools) toolsByName.set(tool.name, tool);
  const openaiTools: OpenAITool[] = tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      // OpenAI and Anthropic reject top-level combinators; the server still
      // validates the arguments.
      parameters: withoutCombinators(tool.inputSchema),
    },
  }));
  const { contents } = await client.readResource({ uri: 'internal://instructions' });
  const instructions = contents.map((c) => ('text' in c ? c.text : '')).join('\n');
  const messages: Msg[] = [
    { role: 'system', content: `${instructions}\n\nWorkspace root: ${dir}` },
  ];

  // Ctrl+C aborts the running turn; at the prompt it ends the session.
  const interrupt = (): void => (current ? current.abort() : rl.close());
  rl.on('SIGINT', interrupt); // terminal (raw mode)
  process.on('SIGINT', interrupt); // piped input

  const turn = async (input: string, controller: AbortController): Promise<void> => {
    messages.push({ role: 'user', content: input });
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const reply = await chat(messages, openaiTools, controller.signal);
      messages.push(reply); // verbatim: providers reject tool replies without it
      if (!reply.tool_calls?.length) {
        console.log(reply.content ?? '');
        return;
      }
      for (const call of reply.tool_calls) {
        controller.signal.throwIfAborted(); // no gate prompts after Ctrl+C
        const content = await runTool(call, controller.signal);
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
    console.log(`(stopped after ${MAX_ROUNDS} tool rounds)`);
  };

  for (let line = task ?? (await ask('> ')); line !== null; line = await ask('> ')) {
    if (!line.trim()) continue;
    const start = messages.length;
    current = new AbortController();
    try {
      await turn(line, current);
    } catch (error) {
      if (!current.signal.aborted) throw error;
      messages.length = start; // drop the half-finished turn so history stays valid
      console.log('(interrupted)');
    } finally {
      current = null;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  closing = true;
  rl.close();
  await client.close();
}
