import { Client, type McpSubscription } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildFileResourceUri } from '../src/core/file-uri.ts';
import {
  bootHttpTest,
  cleanupTestRoot,
  createTestRoot,
  type HttpTestContext,
  waitForResourceUpdate,
  writeTestFile,
} from './helpers.ts';

// The modern HTTP leg builds a fresh McpServer per request. With a per-instance
// PathGuard, an accepted access grant died with the request that accepted it
// (re-prompting on every later call), and the listen-watcher path validated
// against a second, boot-time guard that never saw a grant at all. Both are
// fixed by one guard per endpoint; these two cases fail if that regresses.

describe('HTTP shared PathGuard (grant persistence + watcher visibility)', () => {
  let rootDir: string;
  let outDir: string;
  let outFile: string;
  let http: HttpTestContext;
  let client: Client;
  let subscription: McpSubscription | undefined;
  let elicitCount = 0;

  before(async () => {
    rootDir = await createTestRoot();
    outDir = await mkdtemp(join(tmpdir(), 'fsmcp-shared-guard-'));
    outFile = await writeTestFile(outDir, 'granted.txt', 'initial');

    // Without a boundary an applied grant is filtered back out on recompute
    // (see TC-PG-005), so the grant must be inside one to actually stick.
    http = await bootHttpTest([rootDir], { FS_ROOT_BOUNDARY: tmpdir() });
    client = await http.makeClient('http-shared-guard', () => {
      elicitCount += 1;
      return { action: 'accept' as const, content: { confirm: true } };
    });
  });

  after(async () => {
    await subscription?.close().catch(() => {});
    await http.close();
    await cleanupTestRoot(outDir);
    await cleanupTestRoot(rootDir);
  });

  it('an accepted grant survives the request that accepted it (one prompt, not two)', async () => {
    const first = await client.callTool({ name: 'read', arguments: { path: outFile } });
    assert.notStrictEqual(first.isError, true, 'granted read must succeed');
    assert.strictEqual(elicitCount, 1, 'the first call must prompt for the grant exactly once');

    const second = await client.callTool({ name: 'read', arguments: { path: outFile } });
    assert.notStrictEqual(second.isError, true, 'second read must succeed without a new grant');
    assert.strictEqual(
      elicitCount,
      1,
      'the grant must persist across requests — a second prompt means the guard was rebuilt',
    );
  });

  it('the listen-watcher path sees the grant applied by an earlier request', async () => {
    const uri = buildFileResourceUri(outFile);

    subscription = await client.listen({ resourceSubscriptions: [uri] });
    await writeFile(outFile, 'changed');

    // No update means prepareListenWatchers validated against a guard
    // without the grant.
    await waitForResourceUpdate(client, uri);
  });
});
