import {
  createMcpHandler,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MODERN_PROTOCOL_REVISION } from '../src/core/config.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import { createServer } from '../src/server.ts';
import { cleanupTestRoot, createTestRoot, modernClientMeta } from './helpers.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function runCli(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runNode([join(repoRoot, 'src', 'index.ts'), ...args], env);
}

function runNode(
  nodeArgs: readonly string[],
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
    const child = spawn(process.execPath, nodeArgs, {
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

  it('--tool-timeout and FS_TOOL_TIMEOUT_MS set the per-call deadline in --print-config', async () => {
    const deadlineMs = async (
      args: readonly string[],
      env: Record<string, string | undefined> = {},
    ): Promise<number> => {
      const { code, stdout, stderr } = await runCli(['--print-config', ...args, root], env);
      assert.strictEqual(code, 0, stderr);
      return (JSON.parse(stdout) as { limits: { toolTimeoutMs: number } }).limits.toolTimeoutMs;
    };
    assert.strictEqual(await deadlineMs([]), 5000);
    assert.strictEqual(await deadlineMs(['--tool-timeout', '20000']), 20000);
    assert.strictEqual(await deadlineMs([], { FS_TOOL_TIMEOUT_MS: '15000' }), 15000);
    assert.strictEqual(
      await deadlineMs(['--tool-timeout', '20000'], { FS_TOOL_TIMEOUT_MS: '15000' }),
      20000,
    );
    assert.strictEqual(await deadlineMs([], { FS_TOOL_TIMEOUT_MS: '50' }), 5000);
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
              _meta: modernClientMeta('cli-test'),
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

  it(
    'a positional Windows drive path exits 1 on a POSIX host instead of resolving under the cwd',
    { skip: process.platform === 'win32' && 'a drive path is native on Windows' },
    async () => {
      for (const path of ['C:\\proj', 'C:/proj']) {
        const { code, stderr } = await runCli(['--print-config', path]);
        assert.strictEqual(code, 1, `${path} must fail`);
        assert.match(stderr, /Windows-style path received on a POSIX host/);
      }
    },
  );

  it('--port outside 1-65535 exits 1 with a message naming the flag', async () => {
    for (const port of ['0', '70000', 'abc']) {
      const { code, stderr } = await runCli(['--port', port, root]);
      assert.strictEqual(code, 1, `--port ${port} must fail`);
      assert.match(stderr, /--port \/ FS_PORT must be an integer between 1 and 65535/);
    }
  });

  it('FS_READ_ONLY turns on read-only mode like --read-only', async () => {
    const printed = async (args: string[], env?: Record<string, string>) => {
      const { code, stdout, stderr } = await runCli(['--print-config', ...args, root], env);
      assert.strictEqual(code, 0, stderr);
      return JSON.parse(stdout) as { readOnly: boolean; tools: string[] };
    };

    const on = await printed([], { FS_READ_ONLY: 'true' });
    assert.strictEqual(on.readOnly, true);
    assert.ok(!on.tools.includes('create'));
    assert.ok(on.tools.includes('read'));

    assert.strictEqual((await printed([], { FS_READ_ONLY: '1' })).readOnly, true);

    const off = await printed([], { FS_READ_ONLY: '0' });
    assert.strictEqual(off.readOnly, false);
    assert.ok(off.tools.includes('create'));

    assert.strictEqual((await printed(['--read-only'])).readOnly, true);
  });

  it('CLI-RO-001: --read-only-root repeats and normalizes', async () => {
    const a = join(root, 'refs');
    const b = join(root, 'archive');
    await mkdir(a);
    await mkdir(b);
    const { code, stdout, stderr } = await runCli([
      '--print-config',
      '--read-only-root',
      a,
      '--read-only-root',
      b,
      root,
    ]);
    assert.strictEqual(code, 0, stderr);
    const config = JSON.parse(stdout) as { readOnlyDirs: string[] };
    assert.deepStrictEqual(config.readOnlyDirs, [normalizePath(a), normalizePath(b)]);
  });

  it('CLI-RO-002: readOnlyDirs is empty without the flag', async () => {
    const { code, stdout, stderr } = await runCli(['--print-config', root]);
    assert.strictEqual(code, 0, stderr);
    const config = JSON.parse(stdout) as { readOnlyDirs: string[] };
    assert.deepStrictEqual(config.readOnlyDirs, []);
  });

  describe('--read-only-roots', () => {
    const printConfig = async (
      ...args: string[]
    ): Promise<{ readOnlyDirs: string[]; allowedRoots: string[] }> => {
      const { code, stdout, stderr } = await runCli(['--print-config', root, ...args]);
      assert.strictEqual(code, 0, stderr);
      return JSON.parse(stdout) as { readOnlyDirs: string[]; allowedRoots: string[] };
    };

    const folders = async (...names: string[]): Promise<string[]> => {
      const paths = names.map((name) => join(root, name));
      await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
      return paths;
    };

    it('CLI-ROS-001: every folder after --read-only-roots is read-only', async () => {
      const [a = '', b = ''] = await folders('ros1a', 'ros1b');
      const config = await printConfig('--read-only-roots', a, b);
      assert.deepStrictEqual(config.readOnlyDirs, [normalizePath(a), normalizePath(b)]);
      assert.ok(!config.allowedRoots.includes(normalizePath(a)));
      assert.ok(!config.allowedRoots.includes(normalizePath(b)));
    });

    it('CLI-ROS-002: an unfilled placeholder adds nothing', async () => {
      const config = await printConfig('--read-only-roots', '${user_config.read_only_dirs}');
      assert.deepStrictEqual(config.readOnlyDirs, []);
    });

    it('CLI-ROS-003: folders from the flag and from FS_READ_ONLY_DIRS both apply', async () => {
      const [a = '', b = ''] = await folders('ros3a', 'ros3b');
      const { code, stdout, stderr } = await runCli(
        ['--print-config', root, '--read-only-roots', a],
        { FS_READ_ONLY_DIRS: b },
      );
      assert.strictEqual(code, 0, stderr);
      const config = JSON.parse(stdout) as { readOnlyDirs: string[] };
      assert.deepStrictEqual(config.readOnlyDirs, [normalizePath(a), normalizePath(b)]);
    });

    it('CLI-ROS-004: a folder name holding the separator stays whole', async () => {
      const [folder = ''] = await folders(`ros4x${delimiter}y`);
      const config = await printConfig('--read-only-roots', folder);
      assert.deepStrictEqual(config.readOnlyDirs, [normalizePath(folder)]);
    });

    it('CLI-ROS-005: a missing folder still starts and stays listed', async () => {
      const gone = join(root, 'ros5gone');
      const config = await printConfig('--read-only-roots', gone);
      assert.ok(config.readOnlyDirs.includes(normalizePath(gone)));
    });

    it('CLI-ROS-006: an option after the list is refused, not taken as a folder', async () => {
      const [folder = ''] = await folders('ros6');
      const { code, stderr } = await runCli([
        '--print-config',
        root,
        '--read-only-roots',
        folder,
        '--deny',
        'secret/**',
      ]);
      assert.notStrictEqual(code, 0);
      assert.match(stderr, /--read-only-roots must come last/);
    });

    it('CLI-ROS-007: a missing folder holding the separator keeps its whole name', async () => {
      const gone = join(root, `ros7gone${delimiter}back`);
      const config = await printConfig('--read-only-roots', gone);
      assert.deepStrictEqual(config.readOnlyDirs, [normalizePath(gone)]);
    });

    it('CLI-ROS-008: a list is not split, even when no such folder exists', async () => {
      const [a = '', b = ''] = await folders('ros8a', 'ros8b');
      const joined = [a, b].join(delimiter);
      const config = await printConfig('--read-only-roots', joined);
      assert.deepStrictEqual(config.readOnlyDirs, [normalizePath(joined)]);
    });

    it('CLI-ROS-009: a leading flag survives a node -e launch', async () => {
      const entry = pathToFileURL(join(repoRoot, 'src', 'index.ts')).href;
      const { code, stdout, stderr } = await runNode([
        '-e',
        `import(${JSON.stringify(entry)})`,
        '--',
        '--read-only',
        '--print-config',
        root,
      ]);
      assert.strictEqual(code, 0, stderr);
      const config = JSON.parse(stdout) as { readOnly: boolean };
      assert.strictEqual(config.readOnly, true);
    });
  });

  it('CLI-RO-003: --read-only and --read-only-root combine', async () => {
    const refs = join(root, 'refs');
    await mkdir(refs, { recursive: true });
    const { code, stdout, stderr } = await runCli([
      '--print-config',
      '--read-only',
      '--read-only-root',
      refs,
      root,
    ]);
    assert.strictEqual(code, 0, stderr);
    const config = JSON.parse(stdout) as { readOnly: boolean; readOnlyDirs: string[] };
    assert.strictEqual(config.readOnly, true);
    assert.deepStrictEqual(config.readOnlyDirs, [normalizePath(refs)]);
  });

  it('CLI-RO-004: --read-only-root needs an existing dir unless --allow-missing-roots', async () => {
    const missing = join(root, 'no-such-dir');
    const refused = await runCli(['--print-config', '--read-only-root', missing, root]);
    assert.strictEqual(refused.code, 1);
    assert.match(refused.stderr, /no-such-dir/u);

    const allowed = await runCli([
      '--print-config',
      '--allow-missing-roots',
      '--read-only-root',
      missing,
      root,
    ]);
    assert.strictEqual(allowed.code, 0, allowed.stderr);
    const config = JSON.parse(allowed.stdout) as { readOnlyDirs: string[] };
    assert.deepStrictEqual(config.readOnlyDirs, [normalizePath(missing)]);
  });

  it('CLI-RO-005: FS_READ_ONLY_DIRS feeds readOnlyDirs too', async () => {
    const refs = join(root, 'refs');
    await mkdir(refs, { recursive: true });
    const { code, stdout, stderr } = await runCli(['--print-config', root], {
      FS_READ_ONLY_DIRS: refs,
    });
    assert.strictEqual(code, 0, stderr);
    const config = JSON.parse(stdout) as { readOnlyDirs: string[] };
    assert.deepStrictEqual(config.readOnlyDirs, [normalizePath(refs)]);
  });

  it('CLI-RO-006: rejects a drive-relative --read-only-root value', async () => {
    const { code, stderr } = await runCli(['--print-config', '--read-only-root', 'C:refs', root]);
    assert.strictEqual(code, 1);
    assert.match(stderr, /drive-relative|Windows-style/u);
  });

  it(
    'CLI-RO-007: rejects edge whitespace in --read-only-root before normalization',
    { skip: process.platform === 'win32' },
    async () => {
      const refs = join(root, 'refs ');
      await mkdir(refs);
      const { code, stderr } = await runCli(['--print-config', '--read-only-root', refs, root]);
      assert.strictEqual(code, 1);
      assert.match(stderr, /leading or trailing whitespace/u);
    },
  );
});
