import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHandler, InMemoryServerEventBus } from '@modelcontextprotocol/server';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { isNodeError } from '../src/core/errors.js';
import { PathGuard, resolveAllowedDirectoriesState } from '../src/core/path.js';
import { createWatcherRegistry } from '../src/core/watcher-registry.js';
import { createServer } from '../src/server.js';
import type { FilesystemServerContext } from '../src/server.js';
import { ALL_TOOLS } from '../src/tools/index.js';
import { startHttpServer } from '../src/transport.js';

/** Every registered tool's name - the inventory tests assert `tools/list` against. */
export const ALL_REGISTERED_TOOL_NAMES: readonly string[] = ALL_TOOLS.map((t) => t.name);

/** Create an isolated temp directory for a test. */
export async function createTestRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fsmcp-test-'));
}

/** Remove a test root directory. */
export async function cleanupTestRoot(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Create a symlink, skipping when Windows permissions do not allow it. */
export async function trySymlink(
  target: string,
  linkPath: string,
  skip: () => void,
  type: 'junction' | 'file' | undefined = 'junction',
): Promise<boolean> {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error: unknown) {
    if (
      process.platform === 'win32' &&
      isNodeError(error) &&
      (error.code === 'EPERM' || error.code === 'EACCES')
    ) {
      skip();
      return false;
    }
    throw error;
  }
}

/** Poll until `condition` holds or `timeoutMs` elapses; for debounced notifications. */
export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await setTimeout(20);
  }
}

/** Run `fn` with FS_ROOT_BOUNDARY set to `boundary`, restoring the prior value after. */
export async function withBoundary<T>(boundary: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env['FS_ROOT_BOUNDARY'];
  process.env['FS_ROOT_BOUNDARY'] = boundary;
  try {
    return await fn();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'FS_ROOT_BOUNDARY');
    else process.env['FS_ROOT_BOUNDARY'] = previous;
  }
}

/** Spreadable `readOnly` flag — the one owner of the `--read-only` gate in test setup. */
function readOnlyOpts(options: { readOnly?: boolean }): { readOnly?: true } {
  return options.readOnly ? { readOnly: true } : {};
}

/** A PathGuard initialized straight from `dirs` — no CLI/env recompute. */
export async function makeGuard(dirs: readonly string[]): Promise<PathGuard> {
  const guard = new PathGuard();
  guard.initialize(await resolveAllowedDirectoriesState(dirs));
  return guard;
}

/** Create an MCP server context pointed at the given allowed dirs. */
export async function createTestServer(
  allowedDirs: string[],
  options: { readOnly?: boolean } = {},
): Promise<FilesystemServerContext> {
  return createServer({
    cliAllowedDirs: allowedDirs,
    ...readOnlyOpts(options),
  });
}

export interface TestClientContext {
  client: Client;
  serverCtx: FilesystemServerContext;
  close: () => Promise<void>;
}

/** Create an in-memory client-server linked pair (zero-mocking direct pairing). */
export async function createTestClientPair(
  allowedDirs: string[],
  options: { readOnly?: boolean } = {},
): Promise<TestClientContext> {
  const serverCtx = await createTestServer(allowedDirs, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'test-harness', version: '1.0.0' }, { capabilities: {} });

  await Promise.all([client.connect(clientTransport), serverCtx.mcp.connect(serverTransport)]);

  return {
    client,
    serverCtx,
    close: async () => {
      await client.close();
      serverCtx.disposeRuntimeState();
      await serverCtx.mcp.close();
    },
  };
}

/**
 * Elicitation handler: returns the `ElicitResult` the client auto-fulfils an
 * `input_required` round-trip with. The SDK retries the original `tools/call`
 * carrying the returned `content` as `inputResponses`.
 */
export type ElicitHandler = (request: ElicitRequest) => Promise<ElicitResult> | ElicitResult;

/** An elicitation-capable modern-era client and its teardown. */
export interface ElicitationTestContext {
  client: Client;
  close: () => Promise<void>;
}

/**
 * A client/server pair pinned to the 2026-07-28 era, with form-mode
 * elicitation declared and `elicitHandler` registered for `elicitation/create`
 * so an `input_required` round-trip is auto-fulfilled on the modern in-band
 * wire (retry with `inputResponses` + byte-exact `requestState` echo).
 *
 * There is no in-memory serving entry — `InMemoryTransport.createLinkedPair()`
 * connects 2025-era instances only, which silently routed these flows through
 * the legacy shim — so this drives `createMcpHandler` through its fetch
 * function; the URL is never dialed. `legacy: 'reject'` plus the era assertion
 * below make a silent legacy fallback impossible. One `PathGuard` is shared
 * across the per-request instances, like the production HTTP leg, so an
 * accepted access grant survives the request that accepted it.
 */
export async function createElicitationClientPair(
  allowedDirs: string[],
  elicitHandler: ElicitHandler,
  /**
   * `noElicitation` connects a client that declares no elicitation capability
   * and registers no handler — the shape every host without a confirmation UI
   * presents. Handlers that would ask for one must detect it and answer with a
   * tool error naming the way around it.
   */
  options: { noElicitation?: boolean } = {},
): Promise<ElicitationTestContext> {
  const sharedRegistry = createWatcherRegistry();
  const sharedPathGuard = new PathGuard({ cliAllowedDirs: allowedDirs });
  await sharedPathGuard.recomputeAllowedDirectories();

  const handler = createMcpHandler(
    async () => {
      const serverCtx = await createServer(
        { cliAllowedDirs: allowedDirs },
        { watcherRegistry: sharedRegistry, pathGuard: sharedPathGuard },
      );
      return serverCtx.mcp;
    },
    { legacy: 'reject' },
  );

  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });

  const client = new Client(
    { name: 'test-elicit', version: '1.0.0' },
    {
      versionNegotiation: { mode: 'auto' },
      capabilities: options.noElicitation ? {} : { elicitation: { form: {} } },
    },
  );
  if (!options.noElicitation) {
    client.setRequestHandler('elicitation/create', elicitHandler);
  }

  await client.connect(transport);
  assert.strictEqual(
    client.getProtocolEra(),
    'modern',
    'elicitation pair must negotiate the 2026-07-28 era — a legacy fallback would test the shim instead of the modern in-band input_required wire',
  );

  return {
    client,
    close: async () => {
      await client.close();
      await handler.close();
      sharedRegistry.destroy();
    },
  };
}

export interface TestHttpContext {
  client: Client;
  handler: ReturnType<typeof createMcpHandler>;
  close: () => Promise<void>;
}

/** Create an in-process HTTP client/handler harness via createMcpHandler's handler.fetch. */
export async function createTestHttpHarness(allowedDirs: string[]): Promise<TestHttpContext> {
  const bus = new InMemoryServerEventBus();
  const sharedRegistry = createWatcherRegistry();

  const notifier = {
    toolsChanged: () => {},
    promptsChanged: () => {},
    resourcesChanged: () => {},
    resourceUpdated: (uri: string) => {
      bus.publish({ kind: 'resource_updated', uri });
    },
  };
  const handler = createMcpHandler(
    async () => {
      const serverCtx = await createServer(
        { cliAllowedDirs: allowedDirs },
        { watcherRegistry: sharedRegistry, notifier },
      );
      return serverCtx.mcp;
    },
    { bus, legacy: 'reject' },
  );

  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });

  const client = new Client(
    { name: 'http-test-harness', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );

  await client.connect(transport);

  return {
    client,
    handler,
    close: async () => {
      await client.close();
      await handler.close();
      sharedRegistry.destroy();
    },
  };
}

export const TEST_API_KEY = 'x-test-key-0123456789';

export interface HttpTestContext {
  port: number;
  /** The `/mcp` endpoint of the booted server. */
  base: URL;
  /** Connect a bearer-authenticated client; `onElicit` opts it into form elicitation. */
  makeClient: (name: string, onElicit?: ElicitHandler) => Promise<Client>;
  close: () => Promise<void>;
}

/**
 * Boot a real HTTP server on an ephemeral port for one test file, with the env
 * it needs and every client it opens tracked for teardown.
 *
 * `extraEnv` adds to (or overrides) `HTTP_TEST_ENV` — e.g. `FS_ROOT_BOUNDARY` so
 * an access grant sticks, or a rate-limit cap. Every key touched is saved
 * before it is set and restored on `close`, so a var the process already
 * carried survives the test.
 */
export async function bootHttpTest(
  allowedDirs: string[],
  extraEnv: Record<string, string> = {},
): Promise<HttpTestContext> {
  const env = { ...extraEnv };
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }

  const httpServer = await startHttpServer(
    0,
    { cliAllowedDirs: allowedDirs },
    { apiKey: TEST_API_KEY },
  );
  const port = (httpServer.address() as AddressInfo).port;
  const base = new URL(`http://127.0.0.1:${port}/mcp`);
  const clients: Client[] = [];

  return {
    port,
    base,
    async makeClient(name, onElicit) {
      const transport = new StreamableHTTPClientTransport(base, {
        fetch: (url, init) => {
          const headers = new Headers(init?.headers);
          headers.set('Authorization', `Bearer ${TEST_API_KEY}`);
          return fetch(url, { ...init, headers });
        },
      });
      const client = new Client(
        { name, version: '1.0.0' },
        {
          versionNegotiation: { mode: 'auto' },
          ...(onElicit ? { capabilities: { elicitation: { form: {} } } } : {}),
        },
      );
      if (onElicit) client.setRequestHandler('elicitation/create', onElicit);
      await client.connect(transport);
      clients.push(client);
      return client;
    },
    close: async () => {
      // A test that closed its own client already is the normal case, not an
      // error — close is idempotent enough to swallow the second attempt.
      for (const client of clients) {
        await client.close().catch(() => {});
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      for (const [key, value] of saved) {
        // Reflect over `delete`: an empty string is not the same as unset here
        // (API_KEY='' would read as "auth configured"), so the key must go.
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    },
  };
}

export interface TestStdioContext {
  client: Client;
  close: () => Promise<void>;
}

/** The `node --import tsx src/index.ts` invocation every stdio entry point spawns. */
export function getStdioServerCommand(): string[] {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  return [process.execPath, '--import', 'tsx', join(repoRoot, 'src', 'index.ts')];
}

/**
 * Spawn the real stdio server (via tsx, no build step) and connect a client.
 * stdio has no in-process shortcut — the only honest coverage spawns a real
 * process, mirroring `node --import tsx src/index.ts <allowedDir>`.
 */
export async function createStdioClient(
  allowedDir: string,
  extraEnv: Record<string, string> = {},
): Promise<TestStdioContext> {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const [command, ...args] = getStdioServerCommand() as [string, ...string[]];
  const transport = new StdioClientTransport({
    command,
    args: [...args, allowedDir],
    cwd: repoRoot,
    env: { ...getDefaultEnvironment(), ...extraEnv },
  });
  const client = new Client(
    { name: 'stdio-test-harness', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await transport.close();
    },
  };
}

export interface RawStdioTestContext {
  readonly child: ChildProcessWithoutNullStreams;
  send: (message: JSONRPCMessage) => Promise<void>;
  sendMany: (messages: readonly JSONRPCMessage[]) => Promise<void>;
  nextMessage: () => Promise<JSONRPCMessage>;
  close: () => Promise<void>;
}

/** Spawn the stdio entry without an SDK client so malformed wire messages can be tested. */
export async function createRawStdioServer(
  allowedDir: string,
  extraEnv: Record<string, string> = {},
): Promise<RawStdioTestContext> {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const [command, ...args] = getStdioServerCommand() as [string, ...string[]];
  const child = spawn(command, [...args, allowedDir], {
    cwd: repoRoot,
    env: { ...getDefaultEnvironment(), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const lines = createInterface({ input: child.stdout });
  const queued: JSONRPCMessage[] = [];
  const waiters: ((message: JSONRPCMessage) => void)[] = [];

  lines.on('line', (line) => {
    const message = JSON.parse(line) as JSONRPCMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queued.push(message);
  });

  return {
    child,
    send: async (message) => {
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    sendMany: async (messages) => {
      await new Promise<void>((resolve, reject) => {
        const payload = messages.map((message) => JSON.stringify(message)).join('\n');
        child.stdin.write(`${payload}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    nextMessage: async () => {
      const message = queued.shift();
      if (message) return message;
      return new Promise<JSONRPCMessage>((resolve) => {
        waiters.push(resolve);
      });
    },
    close: async () => {
      lines.close();
      child.stdin.end();
      await closed;
    },
  };
}

/** Write a text file into the test root. */
export async function writeTestFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const fullPath = join(root, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
  return fullPath;
}

/** Generate a file with N lines. */
export async function writeNLineFile(
  root: string,
  name: string,
  lineCount: number,
): Promise<string> {
  const lines = Array.from({ length: lineCount }, (_, i) => `Line ${i + 1}`);
  return writeTestFile(root, name, lines.join('\n') + '\n');
}

/** First text content block of a tool result (assert its shape at one owner). */
export function firstTextBlock(result: { content: readonly unknown[] }): {
  type: string;
  text?: string;
} {
  return result.content[0] as { type: string; text?: string };
}

/** Structured per-path failure summary from a read/search tool result. */
export function failedSummary(result: { _meta?: unknown }):
  | {
      results?: { error?: { code?: string; message?: string } }[];
      summary?: { failed?: number };
    }
  | undefined {
  return result._meta as
    | {
        results?: { error?: { code?: string; message?: string } }[];
        summary?: { failed?: number };
      }
    | undefined;
}
