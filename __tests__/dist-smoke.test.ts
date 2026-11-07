import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALL_REGISTERED_TOOL_NAMES,
  cleanupTestRoot,
  createStdioClient,
  createTestRoot,
  firstTextBlock,
  writeTestFile,
} from './helpers.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const distEntry = join(repoRoot, 'dist', 'index.js');

/**
 * `npm run check` builds before it tests, so `dist/` is always fresh there
 * (local and CI). A bare `npm test` may run without a build: skip rather than
 * fail, and say why. A stale `dist/` is not detected — `npm run check` is the
 * authoritative run for this file.
 */
async function distIsBuilt(): Promise<boolean> {
  try {
    await access(distEntry);
    return true;
  } catch {
    return false;
  }
}

function runDist(
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const childEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('FS_')) childEnv[k] = v;
    }
    const child = spawn(process.execPath, [distEntry, ...args], {
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

describe('Built artifact (dist/index.js, the npm bin)', () => {
  let tmpDir: string;
  let built = false;

  before(async () => {
    tmpDir = await createTestRoot();
    built = await distIsBuilt();
  });

  after(async () => {
    await cleanupTestRoot(tmpDir);
  });

  it('DIST-001: dist/index.js starts with the node shebang', async (t) => {
    if (!built) return t.skip('dist/ is not built; run `npm run build` (npm run check does)');
    const firstLine = (await readFile(distEntry, 'utf-8')).split('\n', 1)[0];
    assert.strictEqual(firstLine, '#!/usr/bin/env node');
  });

  it('DIST-002: --version prints the package version and exits 0', async (t) => {
    if (!built) return t.skip('dist/ is not built');
    const { version } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8')) as {
      version: string;
    };
    const { code, stdout, stderr } = await runDist(['--version']);
    assert.strictEqual(code, 0, stderr);
    assert.ok(stdout.includes(version), `stdout should contain ${version}: ${stdout}`);
  });

  it('DIST-003: serves the full tool list and reads a file over stdio', async (t) => {
    if (!built) return t.skip('dist/ is not built');
    const file = await writeTestFile(tmpDir, 'dist-smoke.txt', 'built artifact\n');
    const harness = await createStdioClient(tmpDir, {}, [], 'dist');
    try {
      const { tools } = await harness.client.listTools();
      assert.deepStrictEqual(
        tools.map((tool) => tool.name).sort(),
        [...ALL_REGISTERED_TOOL_NAMES].sort(),
      );
      const result = await harness.client.callTool({ name: 'read', arguments: { path: file } });
      assert.notStrictEqual(result.isError, true);
      assert.ok(firstTextBlock(result).text?.includes('built artifact'));
    } finally {
      await harness.close();
    }
  });

  it('DIST-005: a diff big enough for the worker loads it from dist/', async (t) => {
    if (!built) return t.skip('dist/ is not built');
    // Over the inline threshold: a missing dist/core/diff-worker.js would answer TOO_LARGE.
    const body = (tag: string) =>
      Array.from({ length: 600 }, (_, i) => `${tag}${String(i)}`).join('\n') + '\n';
    const a = await writeTestFile(tmpDir, 'dist-diff-a.txt', body('a'));
    const b = await writeTestFile(tmpDir, 'dist-diff-b.txt', body('b'));
    const harness = await createStdioClient(tmpDir, {}, [], 'dist');
    try {
      const result = await harness.client.callTool({ name: 'diff', arguments: { a, b } });
      assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
      const meta = result._meta as { linesAdded?: number; linesRemoved?: number };
      assert.strictEqual(meta.linesAdded, 600);
      assert.strictEqual(meta.linesRemoved, 600);
    } finally {
      await harness.close();
    }
  });

  it('DIST-004: the public ./transport export resolves and exposes both starters', async (t) => {
    if (!built) return t.skip('dist/ is not built');
    // A self-reference resolves through package.json `exports`, so this fails
    // if the `./transport` entry is missing or points at the wrong file. Kept
    // in a variable so tsc does not resolve it at type-check time.
    const specifier = '@j0hanz/filesystem-mcp/transport';
    const mod = (await import(specifier)) as Record<string, unknown>;
    assert.strictEqual(typeof mod['startServer'], 'function');
    assert.strictEqual(typeof mod['startHttpServer'], 'function');
    await access(join(repoRoot, 'dist', 'transport.d.ts'));
  });
});
