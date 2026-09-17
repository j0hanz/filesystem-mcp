import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';

import * as assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
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
    serverCtx.disposeRuntimeState();
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
    const granted = await seedRootsFromClient(serverCtx);
    assert.equal(granted, 1); // applyGrant is a dedup no-op but still reports true
    const dirs = serverCtx.pathGuard.getAllowedDirectories();
    assert.equal(dirs.length, 1);
  });
});
