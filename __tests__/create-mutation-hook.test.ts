import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode, FsError } from '../src/core/errors.ts';
import { createServer } from '../src/server.ts';
import type { CreateMutation, CreateMutationHook } from '../src/tools/define.ts';
import { cleanupTestRoot, createTestRoot } from './helpers.ts';

interface CreateStructured {
  files?: { path: string }[];
  failures?: { path: string; error?: { code?: string; message?: string } }[];
}

/** In-memory client/server pair with a host-injected create mutation hook. */
async function createHookedClientPair(allowedDirs: string[], hook: CreateMutationHook) {
  const serverCtx = await createServer(
    { cliAllowedDirs: allowedDirs },
    { createMutationHook: hook },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-hook', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), serverCtx.mcp.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await serverCtx.mcp.close();
    },
  };
}

describe('create mutation hook (optional host-injected admission)', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await createTestRoot();
  });

  after(async () => {
    await cleanupTestRoot(tmpDir);
  });

  it('an allowing hook sees the exact mutation and the file is written', async () => {
    const seen: CreateMutation[] = [];
    const pair = await createHookedClientPair([tmpDir], (mutation) => {
      seen.push(mutation);
    });
    try {
      const file = join(tmpDir, 'hook-allow.txt');
      const result = await pair.client.callTool({
        name: 'create',
        arguments: { files: [{ path: file, content: 'admitted' }] },
      });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(await readFile(file, 'utf-8'), 'admitted');
      assert.deepStrictEqual(seen, [
        { tool: 'create', path: file, content: 'admitted', mode: 'write' },
      ]);
    } finally {
      await pair.close();
    }
  });

  it('append entries reach the hook as mode "append"', async () => {
    const seen: CreateMutation[] = [];
    const pair = await createHookedClientPair([tmpDir], (mutation) => {
      seen.push(mutation);
    });
    try {
      const file = join(tmpDir, 'hook-append.log');
      await writeFile(file, 'line1\n');
      const result = await pair.client.callTool({
        name: 'create',
        arguments: { files: [{ path: file, content: 'line2\n', append: true }] },
      });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(await readFile(file, 'utf-8'), 'line1\nline2\n');
      assert.strictEqual(seen[0]?.mode, 'append');
    } finally {
      await pair.close();
    }
  });

  it('a denying hook fails the entry with ACCESS_DENIED and nothing is written', async () => {
    const denied = join(tmpDir, 'hook-denied-dir', 'denied.txt');
    const allowed = join(tmpDir, 'hook-still-ok.txt');
    const pair = await createHookedClientPair([tmpDir], (mutation) => {
      if (mutation.path === denied) throw new Error('admission refused');
    });
    try {
      const result = await pair.client.callTool({
        name: 'create',
        arguments: {
          files: [
            { path: denied, content: 'never' },
            { path: allowed, content: 'written' },
          ],
        },
      });
      // One entry succeeded, so the call as a whole is not a total failure.
      assert.notStrictEqual(result.isError, true);
      const structured = result.structuredContent as CreateStructured;
      assert.strictEqual(structured.failures?.length, 1);
      assert.strictEqual(structured.failures[0]?.error?.code, ErrorCode.ACCESS_DENIED);
      assert.match(structured.failures[0]?.error?.message ?? '', /admission refused/);
      // Denied before the first mutation: neither the file nor its parent
      // directory exists.
      await assert.rejects(access(denied), 'denied file must not exist');
      await assert.rejects(access(join(tmpDir, 'hook-denied-dir')), 'parent dir must not exist');
      assert.strictEqual(await readFile(allowed, 'utf-8'), 'written');
    } finally {
      await pair.close();
    }
  });

  it('a hook throwing FsError keeps its code and an existing file is untouched', async () => {
    const file = join(tmpDir, 'hook-keep.txt');
    await writeFile(file, 'original');
    const pair = await createHookedClientPair([tmpDir], (mutation) => {
      throw new FsError(ErrorCode.CANCELLED, `admission expired for ${mutation.path}`);
    });
    try {
      const result = await pair.client.callTool({
        name: 'create',
        arguments: { files: [{ path: file, content: 'replaced', overwrite: true }] },
      });
      assert.strictEqual(result.isError, true);
      const structured = result.structuredContent as CreateStructured;
      assert.strictEqual(structured.failures?.[0]?.error?.code, ErrorCode.CANCELLED);
      assert.strictEqual(await readFile(file, 'utf-8'), 'original');
    } finally {
      await pair.close();
    }
  });

  it('without a hook, create behaves exactly as before', async () => {
    const serverCtx = await createServer({ cliAllowedDirs: [tmpDir] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-no-hook', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([client.connect(clientTransport), serverCtx.mcp.connect(serverTransport)]);
    try {
      const file = join(tmpDir, 'no-hook.txt');
      const result = await client.callTool({
        name: 'create',
        arguments: { files: [{ path: file, content: 'plain' }] },
      });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(await readFile(file, 'utf-8'), 'plain');
    } finally {
      await client.close();
      await serverCtx.mcp.close();
    }
  });
});
