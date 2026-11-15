import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';

import * as assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import type { FilesystemServerContext } from '../src/server.ts';
import { seedRootsFromClient } from '../src/transport/stdio.ts';
import { cleanupTestRoot, createTestRoot, createTestServer } from './helpers.ts';

describe('Client roots seeding (legacy era)', () => {
  let tmpDir: string;
  let serverCtx: FilesystemServerContext;
  let client: Client;

  before(async () => {
    tmpDir = await createTestRoot();
    await writeFile(join(tmpDir, 'a.txt'), 'hello');
    // No CLI allowed dirs: everything must come from the client's roots.
    serverCtx = await createTestServer([]);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'roots-test', version: '1.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler('roots/list', () => ({
      roots: [
        { uri: pathToFileURL(tmpDir).href, name: 'workspace' },
        // Unsafe root: must be refused by applyGrant's guards. (A non-file://
        // uri never reaches seeding — the SDK rejects the whole roots/list
        // result at the wire, so only file:// roots can arrive.)
        { uri: pathToFileURL(homedir()).href, name: 'home' },
      ],
    }));
    await Promise.all([client.connect(clientTransport), serverCtx.mcp.connect(serverTransport)]);
  });

  after(async () => {
    await client.close();
    await serverCtx.mcp.close();
    await cleanupTestRoot(tmpDir);
  });

  it('TC-ROOTS-001: grants declared file:// roots, refuses unsafe roots', async () => {
    const file = join(tmpDir, 'a.txt');
    // Before seeding: nothing allowed.
    await assert.rejects(serverCtx.pathGuard.validateExistingPath(file));

    const granted = await seedRootsFromClient(serverCtx);
    assert.equal(granted, 1);

    // The declared workspace root now validates; home was refused.
    await serverCtx.pathGuard.validateExistingPath(file);
    await assert.rejects(serverCtx.pathGuard.validateExistingPath(join(homedir(), '.gitconfig')));
  });

  it('TC-ROOTS-002: re-seeding is idempotent', async () => {
    // Every root already granted or refused: nothing new to add.
    const grants = (): number =>
      (serverCtx.pathGuard as unknown as { grantedDirectories: string[] }).grantedDirectories
        .length;
    const before = grants();
    for (let round = 0; round < 3; round++) {
      assert.equal(await seedRootsFromClient(serverCtx), 1);
    }
    assert.equal(grants(), before, 'a repeated grant adds no entry');
    assert.equal(serverCtx.pathGuard.getAllowedDirectories().length, 1);
  });

  it('TC-ROOTS-003: a tool call made during a seed waits for it', async () => {
    const late = await createTestRoot();
    try {
      await writeFile(join(late, 'b.txt'), 'late');
      let release!: () => void;
      serverCtx.pathGuard.holdUntil(new Promise<void>((resolve) => (release = resolve)));

      let answered = false;
      const call = client
        .callTool({ name: 'stat', arguments: { path: join(late, 'b.txt') } })
        .finally(() => (answered = true));
      await sleep(50);
      assert.strictEqual(answered, false, 'the call must wait for the hold');

      assert.strictEqual(await serverCtx.pathGuard.applyGrant(late, 'workspace'), true);
      release();
      const result = await call;
      assert.notStrictEqual(result.isError, true);
    } finally {
      await cleanupTestRoot(late);
    }
  });
});

describe('Client roots follow the latest roots/list (ADR-018)', () => {
  let a: string;
  let b: string;
  let c: string;
  let declared: string[];
  let failing: boolean;
  let serverCtx: FilesystemServerContext;
  let client: Client;

  const connect = async (startup: string[]): Promise<void> => {
    serverCtx = await createTestServer(startup);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'roots-test', version: '1.0.0' }, { capabilities: { roots: {} } });
    client.setRequestHandler('roots/list', () => {
      if (failing) throw new Error('roots/list failed');
      return { roots: declared.map((dir) => ({ uri: pathToFileURL(dir).href })) };
    });
    await Promise.all([client.connect(clientTransport), serverCtx.mcp.connect(serverTransport)]);
  };

  beforeEach(async () => {
    [a, b, c] = await Promise.all([createTestRoot(), createTestRoot(), createTestRoot()]);
    await Promise.all([a, b, c].map((dir) => writeFile(join(dir, 'f.txt'), 'x')));
    declared = [];
    failing = false;
    await connect([]);
  });

  afterEach(async () => {
    await client.close();
    await serverCtx.mcp.close();
    await Promise.all([a, b, c].map((dir) => cleanupTestRoot(dir)));
  });

  it('revokes a root the client no longer declares', async () => {
    declared = [a, b];
    assert.equal(await seedRootsFromClient(serverCtx), 2);
    declared = [a];
    assert.equal(await seedRootsFromClient(serverCtx), 1);
    await serverCtx.pathGuard.validateExistingPath(join(a, 'f.txt'));
    await assert.rejects(serverCtx.pathGuard.validateExistingPath(join(b, 'f.txt')));
  });

  it('revokes every declared root on an empty list, keeping user-approved grants', async () => {
    declared = [a];
    await seedRootsFromClient(serverCtx);
    assert.equal(await serverCtx.pathGuard.applyGrant(c), true);
    declared = [];
    assert.equal(await seedRootsFromClient(serverCtx), 0);
    await assert.rejects(serverCtx.pathGuard.validateExistingPath(join(a, 'f.txt')));
    await serverCtx.pathGuard.validateExistingPath(join(c, 'f.txt'));
  });

  it('keeps roots when roots/list fails', async () => {
    declared = [a];
    await seedRootsFromClient(serverCtx);
    failing = true;
    assert.equal(await seedRootsFromClient(serverCtx), 0);
    await serverCtx.pathGuard.validateExistingPath(join(a, 'f.txt'));
  });

  it('discards a stale answer', async () => {
    declared = [a];
    await seedRootsFromClient(serverCtx);
    declared = [];
    assert.equal(await seedRootsFromClient(serverCtx, () => false), 0);
    await serverCtx.pathGuard.validateExistingPath(join(a, 'f.txt'));
  });

  it('never revokes a startup root', async () => {
    await client.close();
    await serverCtx.mcp.close();
    await connect([a]);
    declared = [];
    await seedRootsFromClient(serverCtx);
    await serverCtx.pathGuard.validateExistingPath(join(a, 'f.txt'));
  });
});
