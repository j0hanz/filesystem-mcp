import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode } from '../src/core/errors.ts';
import { buildFileResourceUri } from '../src/core/file-uri.ts';
import { jsonByteBound, MAX_OUTBOUND_RESULT_BYTES } from '../src/core/outbound.ts';
import { MIB } from '../src/core/util.ts';
import { createRuntimeState, createServer } from '../src/server.ts';
import {
  cleanupTestRoot,
  createStdioClient,
  createTestHttpHarness,
  createTestRoot,
  firstTextBlock,
  withBoundary,
} from './helpers.ts';

describe('outbound result limits', { timeout: 60_000 }, () => {
  let root: string;
  let harness: Awaited<ReturnType<typeof createStdioClient>>;
  let longLines: string;
  let escapedLine: string;
  let smallEscapedLine: string;
  let recoveryFile: string;
  let diffA: string;
  let diffB: string;
  let resourceFile: string;
  let binaryFile: string;
  let quotedResourceFile: string;
  let overLimitFile: string;
  let cachedFile: string;
  let smallCachedFile: string;
  let pagedFile: string;
  let dryRunFile: string;
  let imageFile: string;
  let mediumFile: string;

  before(async () => {
    root = await createTestRoot();
    longLines = join(root, 'long-lines.txt');
    escapedLine = join(root, 'escaped-line.txt');
    smallEscapedLine = join(root, 'small-escaped-line.txt');
    recoveryFile = join(root, 'recovery.txt');
    diffA = join(root, 'diff-a.txt');
    diffB = join(root, 'diff-b.txt');
    resourceFile = join(root, 'resource.txt');
    binaryFile = join(root, 'resource.bin');
    quotedResourceFile = join(root, 'quoted-resource.txt');
    overLimitFile = join(root, 'over-limit.txt');
    cachedFile = join(root, 'cached.txt');
    smallCachedFile = join(root, 'small-cached.txt');
    pagedFile = join(root, 'paged.txt');
    dryRunFile = join(root, 'dry-run.txt');
    imageFile = join(root, 'large.png');
    mediumFile = join(root, 'medium.txt');
    await Promise.all([
      writeFile(longLines, `NEEDLE${'x'.repeat(3 * MIB - 6)}\n`.repeat(2)),
      writeFile(escapedLine, `NEEDLE${'"'.repeat(3 * MIB - 6)}\n`),
      writeFile(smallEscapedLine, `NEEDLE${'"'.repeat(MIB - 6)}\n`),
      writeFile(recoveryFile, 'connection survived\n'),
      writeFile(diffA, `${'a'.repeat(6 * MIB)}\n`),
      writeFile(diffB, `${'b'.repeat(6 * MIB)}\n`),
      writeFile(resourceFile, 'line\n'.repeat(Math.floor((9.9 * MIB) / 5))),
      writeFile(binaryFile, Buffer.alloc(8 * MIB)),
      writeFile(quotedResourceFile, '"'.repeat(6 * MIB)),
      // Past the default 10 MiB FS_MAX_FILE_SIZE the harness runs with.
      writeFile(overLimitFile, 'x'.repeat(11 * MIB)),
      writeFile(cachedFile, `NEEDLE${'"'.repeat(MIB)}\n`.repeat(3)),
      writeFile(smallCachedFile, 'NEEDLE\n'.repeat(3)),
      writeFile(pagedFile, `${`NEEDLE${'x'.repeat(3 * MIB - 6)}\n`.repeat(2)}NEEDLE\n`),
      writeFile(dryRunFile, `NEEDLE${'a'.repeat(6 * MIB)}\n`),
      writeFile(
        imageFile,
        Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8 * MIB)]),
      ),
      writeFile(mediumFile, `${'x'.repeat(99)}\n`.repeat(40_000)),
    ]);
    harness = await createStdioClient(root, { FS_ROOT_BOUNDARY: root });
  });

  after(async () => {
    try {
      await harness?.close();
    } finally {
      if (root) await cleanupTestRoot(root);
    }
  });

  async function assertRecovery(): Promise<void> {
    const read = await harness.client.callTool(
      { name: 'read', arguments: { path: recoveryFile } },
      { timeout: 5000 },
    );
    assert.notStrictEqual(read.isError, true);
    assert.strictEqual(firstTextBlock(read).text, 'connection survived\n');
  }

  /** `size`, when given, is the "N bytes" the refusal must report. */
  async function assertResourceTooLarge(uri: string, size?: RegExp): Promise<void> {
    await assert.rejects(
      harness.client.readResource({ uri }, { timeout: 5000 }),
      (error: unknown) => {
        assert.ok(ProtocolError.isInstance(error));
        assert.strictEqual(error.code, ProtocolErrorCode.InvalidParams);
        const data = error.data as { code?: string; suggestion?: string };
        assert.strictEqual(data.code, ErrorCode.TOO_LARGE);
        assert.match(data.suggestion ?? '', /HTTP/);
        assert.match(error.message, /stdio/);
        if (size) assert.match(error.message, size);
        assert.ok(error.message.length < 1024, 'the error must remain compact');
        return true;
      },
    );
    await assertRecovery();
  }

  it('refuses duplicated search output before stdio closes, and smaller pages work', async () => {
    const result = await harness.client.callTool(
      {
        name: 'search_text',
        arguments: { path: longLines, searchPattern: 'NEEDLE', maxResults: 2 },
      },
      { timeout: 5000 },
    );
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /TOO_LARGE.*stdio[^]*HTTP/);
    await assertRecovery();

    const page = await harness.client.callTool(
      {
        name: 'search_text',
        arguments: { path: longLines, searchPattern: 'NEEDLE', maxResults: 1 },
      },
      { timeout: 5000 },
    );
    assert.notStrictEqual(page.isError, true);
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') < MAX_OUTBOUND_RESULT_BYTES);
    const metadata = page._meta as { matches: unknown[]; nextCursor?: string };
    assert.strictEqual(metadata.matches.length, 1);
    assert.ok(metadata.nextCursor);
  });

  it('counts JSON escaping even for one match and permits smaller escaped content', async () => {
    const result = await harness.client.callTool(
      {
        name: 'search_text',
        arguments: { path: escapedLine, searchPattern: 'NEEDLE', maxResults: 1 },
      },
      { timeout: 5000 },
    );
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /TOO_LARGE/);
    await assertRecovery();

    const small = await harness.client.callTool(
      {
        name: 'search_text',
        arguments: { path: smallEscapedLine, searchPattern: 'NEEDLE', maxResults: 1 },
      },
      { timeout: 5000 },
    );
    assert.notStrictEqual(small.isError, true);
    const metadata = small._meta as { matches: { content: string }[] };
    assert.strictEqual(metadata.matches[0]?.content, `NEEDLE${'"'.repeat(MIB - 6)}`);
  });

  it('refuses oversized diffs without losing the connection', async () => {
    const result = await harness.client.callTool(
      { name: 'diff', arguments: { a: diffA, b: diffB } },
      { timeout: 5000 },
    );
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /TOO_LARGE.*stdio[^]*HTTP/);
    await assertRecovery();
  });

  it('refuses file resources expanded by JSON escaping or base64, and small reads still work', async () => {
    // Over the limit on disk: refused from its size before it is read.
    const { size } = await stat(resourceFile);
    assert.ok(size > MAX_OUTBOUND_RESULT_BYTES);
    await assertResourceTooLarge(
      buildFileResourceUri(resourceFile),
      new RegExp(`\\(at least ${String(size)} bytes`),
    );
    // Under it on disk, over it as base64: refused before it is encoded.
    await assertResourceTooLarge(
      buildFileResourceUri(binaryFile),
      new RegExp(`\\(at least ${String(4 * Math.ceil((8 * MIB) / 3))} bytes`),
    );
    // Under it on disk, over it once escaped: measured as encoded.
    await assertResourceTooLarge(
      buildFileResourceUri(quotedResourceFile),
      /\(\d+ bytes once JSON-encoded/,
    );
    const result = await harness.client.readResource(
      { uri: buildFileResourceUri(recoveryFile) },
      { timeout: 5000 },
    );
    const content = result.contents[0];
    assert.ok(content && 'text' in content);
    assert.strictEqual(content.text, 'connection survived\n');
  });

  it('a file resource past the size limit names that limit, not stdio', async () => {
    // HTTP refuses it too, so "connect over HTTP" would be no remedy.
    await assert.rejects(
      harness.client.readResource({ uri: buildFileResourceUri(overLimitFile) }, { timeout: 5000 }),
      (error: unknown) => {
        assert.ok(ProtocolError.isInstance(error));
        assert.strictEqual((error.data as { code?: string }).code, ErrorCode.TOO_LARGE);
        assert.match(error.message, /File exceeds size limit/);
        assert.doesNotMatch(error.message, /stdio/);
        return true;
      },
    );
  });

  it('withholds a cached-result link that stdio could never read back', async () => {
    // The full set stores as ~6 MiB, under the store's cap, but resources/read
    // re-encodes it as one JSON string, past the stdio limit.
    const page = await harness.client.callTool(
      {
        name: 'search_text',
        arguments: { path: cachedFile, searchPattern: 'NEEDLE', maxResults: 1 },
      },
      { timeout: 5000 },
    );
    assert.notStrictEqual(page.isError, true);
    assert.strictEqual(
      page.content.find((block) => block.type === 'resource_link'),
      undefined,
    );
    const metadata = page._meta as { nextCursor?: string; resourceUri?: string };
    assert.strictEqual(metadata.resourceUri, undefined);
    assert.ok(metadata.nextCursor);
    const next = await harness.client.callTool(
      {
        name: 'search_text',
        arguments: {
          path: cachedFile,
          searchPattern: 'NEEDLE',
          maxResults: 1,
          cursor: metadata.nextCursor,
        },
      },
      { timeout: 5000 },
    );
    assert.notStrictEqual(next.isError, true, 'the smaller search pages remain available');

    // A full set that fits keeps its link, and the link reads back over stdio.
    const small = await harness.client.callTool(
      {
        name: 'search_text',
        arguments: { path: smallCachedFile, searchPattern: 'NEEDLE', maxResults: 1 },
      },
      { timeout: 5000 },
    );
    const link = small.content.find((block) => block.type === 'resource_link');
    assert.ok(link);
    const cached = await harness.client.readResource({ uri: link.uri }, { timeout: 5000 });
    const content = cached.contents[0];
    assert.ok(content && 'text' in content);
    assert.strictEqual((JSON.parse(content.text) as { matches: unknown[] }).matches.length, 3);
  });

  it('a refused first page takes back the cached result it stored', async () => {
    // Bypass the client's list cache: the server hints a 30 s TTL for it.
    const listed = async (): Promise<string[]> =>
      (
        await harness.client.listResources(undefined, { timeout: 5000, cacheMode: 'bypass' })
      ).resources.map((resource) => resource.uri);
    const before = new Set(await listed());
    // Two 3 MiB matches overflow the page; the whole set (all three) fits
    // the store, so it is cached, with a snapshot, before the refusal.
    const result = await harness.client.callTool(
      {
        name: 'search_text',
        arguments: { path: pagedFile, searchPattern: 'NEEDLE', maxResults: 2 },
      },
      { timeout: 5000 },
    );
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /TOO_LARGE/);
    const added = (await listed()).filter((uri) => !before.has(uri));
    assert.deepStrictEqual(added, [], 'no cached result the client never got a link to');
    await assertRecovery();
  });

  it('a refused first page takes back its page snapshot too', async () => {
    // In memory, so the test holds the store; the guard keys on the transport
    // value, not the wire. Record what each call's view creates.
    const state = createRuntimeState(
      { cliAllowedDirs: [root] },
      { maxReadResultBytes: MAX_OUTBOUND_RESULT_BYTES },
    );
    const { pageStore } = state;
    const created: { snapshotId: string; queryKey: string }[] = [];
    const forCall = pageStore.forCall.bind(pageStore);
    pageStore.forCall = () => {
      const view = forCall();
      const create = view.create.bind(view);
      view.create = (params) => {
        const snapshotId = create(params);
        created.push({ snapshotId, queryKey: params.queryKey });
        return snapshotId;
      };
      return view;
    };
    await withBoundary(root, async () => {
      const serverCtx = await createServer(
        { cliAllowedDirs: [root] },
        { transport: 'stdio', state },
      );
      const client = new Client({ name: 'page-store-probe', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(clientTransport), serverCtx.mcp.connect(serverTransport)]);
      try {
        const result = await client.callTool({
          name: 'search_text',
          arguments: { path: pagedFile, searchPattern: 'NEEDLE', maxResults: 2 },
        });
        assert.strictEqual(result.isError, true);
        assert.match(firstTextBlock(result).text ?? '', /TOO_LARGE/);
        const [snapshot] = created;
        assert.ok(snapshot, 'the refused page had snapshotted its full set');
        assert.throws(
          () => pageStore.read(snapshot.snapshotId, snapshot.queryKey),
          /Invalid cursor/,
          'no snapshot behind a cursor the client never got',
        );
      } finally {
        await client.close();
        await serverCtx.mcp.close();
        state.dispose();
      }
    });
  });

  it('refuses an oversized dry-run preview, which wrote nothing, before stdio closes', async () => {
    // One 6 MiB line changes, so the preview diff carries it twice, in both
    // the text and the metadata.
    const result = await harness.client.callTool(
      {
        name: 'edit',
        arguments: {
          path: dryRunFile,
          edits: [{ oldText: 'NEEDLE', newText: 'needle' }],
          dryRun: true,
        },
      },
      { timeout: 5000 },
    );
    assert.strictEqual(result.isError, true);
    const text = firstTextBlock(result).text ?? '';
    assert.match(text, /TOO_LARGE.*stdio/);
    assert.match(text, /\nNothing was written\. Preview fewer files or a smaller file/);
    // The remedy replaces TOO_LARGE's default advice; a dry run has no head/tail.
    assert.doesNotMatch(text, /head\/tail/);
    assert.ok((await readFile(dryRunFile, 'utf8')).startsWith('NEEDLE'));
    await assertRecovery();
  });

  it('an edit over stdio links the file only when resources/read can serve it', async () => {
    const big = join(root, 'link-big.txt');
    const small = join(root, 'link-small.txt');
    await writeFile(big, 'HEAD\n' + 'line\n'.repeat(Math.floor((9.9 * MIB) / 5)));
    await writeFile(small, 'HEAD\nline\n');
    const edit = (path: string) =>
      harness.client.callTool(
        { name: 'edit', arguments: { path, edits: [{ oldText: 'HEAD', newText: 'HEAD2' }] } },
        { timeout: 5000 },
      );
    const bigResult = await edit(big);
    assert.ok(!bigResult.isError, firstTextBlock(bigResult).text);
    assert.ok(!bigResult.content.some((b) => b.type === 'resource_link'));
    const smallResult = await edit(small);
    assert.ok(!smallResult.isError);
    assert.ok(smallResult.content.some((b) => b.type === 'resource_link'));
  });

  it('read keeps its own remedies through the shared guard', async () => {
    const image = await harness.client.callTool(
      { name: 'read', arguments: { path: imageFile } },
      { timeout: 5000 },
    );
    assert.strictEqual(image.isError, true);
    const imageText = firstTextBlock(image).text ?? '';
    assert.match(imageText, /^TOO_LARGE: .*stdio message limit\)\.\nThis media file is too large/);
    assert.doesNotMatch(imageText, /head\/tail/);
    await assertRecovery();

    const text = await harness.client.callTool(
      { name: 'read', arguments: { path: resourceFile } },
      { timeout: 5000 },
    );
    assert.strictEqual(text.isError, true);
    assert.match(firstTextBlock(text).text ?? '', /TOO_LARGE[^]*head, tail, or startLine\/endLine/);
  });

  it('read with binary over stdio refuses an oversize resource with an HTTP remedy', async () => {
    const result = await harness.client.callTool(
      { name: 'read', arguments: { path: binaryFile, binary: true } },
      { timeout: 5000 },
    );
    assert.strictEqual(result.isError, true);
    const text = firstTextBlock(result).text ?? '';
    assert.match(text, /^TOO_LARGE: .*stdio message limit\)\.\nThis binary file is too large/);
    assert.doesNotMatch(text, /head, tail/);
    await assertRecovery();
  });

  it('returns a large result whose bound exceeds the limit but whose encoding does not', async () => {
    const result = await harness.client.callTool(
      { name: 'read', arguments: { path: mediumFile } },
      { timeout: 5000 },
    );
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(firstTextBlock(result).text, `${'x'.repeat(99)}\n`.repeat(40_000));
    assert.ok(jsonByteBound(result) > MAX_OUTBOUND_RESULT_BYTES, 'the exact measure decided');
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < MAX_OUTBOUND_RESULT_BYTES);
  });

  it('preserves oversized tool and resource results over HTTP', async () => {
    await withBoundary(root, async () => {
      const http = await createTestHttpHarness([root]);
      try {
        const result = await http.client.callTool(
          {
            name: 'search_text',
            arguments: { path: longLines, searchPattern: 'NEEDLE', maxResults: 2 },
          },
          { timeout: 5000 },
        );
        assert.notStrictEqual(result.isError, true);
        assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') > 10 * MIB);
        const metadata = result._meta as { matches: { content: string }[] };
        assert.strictEqual(metadata.matches.length, 2);
        assert.ok(metadata.matches.every((match) => match.content.length === 3 * MIB));

        const diff = await http.client.callTool(
          { name: 'diff', arguments: { a: diffA, b: diffB } },
          { timeout: 5000 },
        );
        assert.notStrictEqual(diff.isError, true);
        assert.ok(Buffer.byteLength(JSON.stringify(diff), 'utf8') > 10 * MIB);

        for (const path of [resourceFile, binaryFile]) {
          const resource = await http.client.readResource(
            { uri: buildFileResourceUri(path) },
            { timeout: 5000 },
          );
          assert.ok(Buffer.byteLength(JSON.stringify(resource), 'utf8') > 10 * MIB);
        }

        const page = await http.client.callTool(
          {
            name: 'search_text',
            arguments: { path: cachedFile, searchPattern: 'NEEDLE', maxResults: 1 },
          },
          { timeout: 5000 },
        );
        assert.notStrictEqual(page.isError, true);
        const link = page.content.find((block) => block.type === 'resource_link');
        assert.ok(link);
        const cached = await http.client.readResource({ uri: link.uri }, { timeout: 5000 });
        assert.ok(Buffer.byteLength(JSON.stringify(cached), 'utf8') > 10 * MIB);
      } finally {
        await http.close();
      }
    });
  });
});
