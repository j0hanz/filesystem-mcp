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
    --provider anthropic --model claude-sonnet-5-5
  LLM_BASE_URL and LLM_API_KEY override the provider preset.`;

// --- CLI -------------------------------------------------------------------

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

// --- Terminal input --------------------------------------------------------

// One shared line iterator: it buffers piped lines that arrive before a prompt
// is asked, where rl.question() would drop them.
const rl = createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator]();

async function ask(prompt: string): Promise<string | null> {
  process.stdout.write(prompt);
  const { value, done } = await lines.next();
  return done ? null : value;
}

// --- MCP client --------------------------------------------------------------

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
    return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// --- LLM ---------------------------------------------------------------------

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

// --- Session -----------------------------------------------------------------

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
      parameters: tool.inputSchema,
    },
  }));
  const { contents } = await client.readResource({ uri: 'internal://instructions' });
  const instructions = contents.map((c) => ('text' in c ? c.text : '')).join('\n');
  const messages: Msg[] = [
    { role: 'system', content: `${instructions}\n\nWorkspace root: ${dir}` },
  ];

  // Ctrl+C aborts the running turn; at the prompt it ends the session.
  let current: AbortController | null = null;
  process.on('SIGINT', () => (current ? current.abort() : rl.close()));

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
  rl.close();
  await client.close();
}
