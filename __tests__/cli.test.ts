import {
  createMcpHandler,
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MODERN_PROTOCOL_REVISION } from '../src/core/config.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import { createServer } from '../src/server.ts';
import { cleanupTestRoot, createTestRoot } from './helpers.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function runCli(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Reviewer note: a parent shell's own FS_* vars would otherwise leak into
    // the spawned CLI and change the policy it reports; omit them when
    // rebuilding the child env (setting to undefined is not enough for
    // spawn), then apply this test's own overrides on top.
    const childEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('FS_')) childEnv[k] = v;
    }
    Object.assign(childEnv, env);
    const child = spawn(process.execPath, [join(repoRoot, 'src', 'index.ts'), ...args], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('CLI (real subprocess)', () => {
  let root: string;
  before(async () => {
    root = await createTestRoot();
  });
  after(async () => {
    await cleanupTestRoot(root);
  });

  it('--print-config masks the API key and reports the access policy', async () => {
    const key = 'cli-test-dummy-key-0123456789';
    const { code, stdout, stderr } = await runCli(
      ['--print-config', '--api-key', key, '--deny', 'secrets/**', '--root-boundary', root, root],
      { FS_ALLOWLIST: 'secrets/README.md' },
    );
    assert.strictEqual(code, 0, stderr);
    assert.ok(!stdout.includes(key) && !stderr.includes(key), 'the key must never be printed');
    const config = JSON.parse(stdout) as {
      apiKey: string | null;
      policy: {
        allowSensitive: boolean;
        builtinDeny: string[];
        operatorDeny: string[];
        allow: string[];
        rootBoundary: string | null;
        allowMissingRoots: boolean;
      };
    };
    assert.strictEqual(config.apiKey, '***');
    assert.strictEqual(config.policy.allowSensitive, false);
    assert.ok(config.policy.builtinDeny.includes('.env'));
    assert.deepStrictEqual(config.policy.operatorDeny, ['secrets/**']);
    assert.deepStrictEqual(config.policy.allow, ['secrets/README.md']);
    assert.strictEqual(config.policy.rootBoundary, root);
    assert.strictEqual(config.policy.allowMissingRoots, false);
  });

  it('--allow-sensitive empties the built-in deny tier in --print-config', async () => {
    const { code, stdout } = await runCli(['--print-config', '--allow-sensitive', root]);
    assert.strictEqual(code, 0);
    const config = JSON.parse(stdout) as {
      policy: { allowSensitive: boolean; builtinDeny: string[] };
    };
    assert.strictEqual(config.policy.allowSensitive, true);
    assert.deepStrictEqual(config.policy.builtinDeny, []);
  });

  it('--print-config reports both protocol eras and the pinned SDK versions', async () => {
    const { code, stdout, stderr } = await runCli(['--print-config', root]);
    assert.strictEqual(code, 0, stderr);
    const config = JSON.parse(stdout) as {
      protocol: {
        modern: string;
        legacy: { latest: string; supported: string[] };
        sdk: { server: string; node: string; express: string };
      };
    };
    assert.strictEqual(config.protocol.modern, MODERN_PROTOCOL_REVISION);
    assert.strictEqual(config.protocol.legacy.latest, LATEST_PROTOCOL_VERSION);
    assert.deepStrictEqual(config.protocol.legacy.supported, SUPPORTED_PROTOCOL_VERSIONS);
    const pinned = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    assert.strictEqual(
      config.protocol.sdk.server,
      pinned.dependencies['@modelcontextprotocol/server'],
    );
    assert.match(config.protocol.sdk.server, /^\d+\.\d+\.\d+$/, 'the pin must be exact');
  });

  it('MODERN_PROTOCOL_REVISION is the revision the SDK actually serves', async () => {
    // The SDK exports no constant for it, so pin the literal to behaviour: a
    // server/discover probe stamped with it must be answered with a result.
    const tmp = await createTestRoot();
    const handler = createMcpHandler(
      async ({ era }) => (await createServer({ cliAllowedDirs: [tmp] }, { era })).mcp,
      { legacy: 'reject' },
    );
    try {
      const res = await handler.fetch(
        new Request('http://test.local/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            // The modern binding's standard headers; the entry refuses a
            // 2026-07-28 request without them (no Mcp-Name for discover).
            'mcp-protocol-version': MODERN_PROTOCOL_REVISION,
            'mcp-method': 'server/discover',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'server/discover',
            params: {
              _meta: {
                [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_REVISION,
                'io.modelcontextprotocol/clientCapabilities': {},
                'io.modelcontextprotocol/clientInfo': { name: 'cli-test', version: '1.0.0' },
              },
            },
          }),
        }),
      );
      const text = await res.text(); // read once; a Response body is single-use
      assert.strictEqual(res.status, 200, text);
      const json = res.headers.get('content-type')?.includes('text/event-stream')
        ? (
            text
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .at(-1) ?? ''
          ).slice(5)
        : text;
      const body = JSON.parse(json) as { result?: unknown; error?: unknown };
      assert.ok(body.result, JSON.stringify(body));
    } finally {
      await handler.close();
      await cleanupTestRoot(tmp);
    }
  });

  // Plugin hosts pass `${NAME}` args through unexpanded when they don't know
  // the variable (Antigravity CLI always; Copilot CLI when PWD is unset).
  it('a positional ${NAME} placeholder resolves from the environment', async () => {
    const { code, stdout, stderr } = await runCli(
      ['--print-config', '${FS_TEST_PLACEHOLDER_ROOT}'],
      {
        FS_TEST_PLACEHOLDER_ROOT: root,
      },
    );
    assert.strictEqual(code, 0, stderr);
    const config = JSON.parse(stdout) as { allowedRoots: string[] };
    assert.deepStrictEqual(config.allowedRoots, [normalizePath(root)]);
  });

  it('a positional ${NAME} placeholder for an unset variable is dropped, not treated as a path', async () => {
    const { code, stdout, stderr } = await runCli([
      '--print-config',
      '${FS_TEST_PLACEHOLDER_UNSET}',
    ]);
    assert.strictEqual(code, 0, stderr);
    const config = JSON.parse(stdout) as { allowedRoots: string[] };
    assert.deepStrictEqual(config.allowedRoots, []);
  });

  it('--port outside 1-65535 exits 1 with a message naming the flag', async () => {
    for (const port of ['0', '70000', 'abc']) {
      const { code, stderr } = await runCli(['--port', port, root]);
      assert.strictEqual(code, 1, `--port ${port} must fail`);
      assert.match(stderr, /--port \/ FS_PORT must be an integer between 1 and 65535/);
    }
  });
});
