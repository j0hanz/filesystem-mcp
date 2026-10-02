import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { access, chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildFileResourceUri } from '../src/core/file-uri.ts';
import { RE2_MAX_INPUT_BYTES, searchContent } from '../src/core/search.ts';
import { getMaxTextFileSize, MAX_SEARCH_RESULTS } from '../src/core/util.ts';
import { createServer } from '../src/server.ts';
import { MUTATING_TOOL_NAMES, registeredTools } from '../src/tools/index.ts';
import {
  ALL_REGISTERED_TOOL_NAMES,
  bootHttpTest,
  cleanupTestRoot,
  createElicitationClientPair,
  createTestClientPair,
  createTestRoot,
  failedSummary,
  firstTextBlock,
  makeGuard,
  type TestClientContext,
  trySymlink,
  withBoundary,
  withEnv,
  writeTestFile,
} from './helpers.ts';

describe('P0 Functional Tests - Tools (MCP Client)', () => {
  let tmpDir: string;
  let harness: TestClientContext;

  before(async () => {
    tmpDir = await createTestRoot();
    harness = await createTestClientPair([tmpDir]);
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
    if (tmpDir) {
      await cleanupTestRoot(tmpDir);
    }
  });

  it('TC-FUNC-001: Read single text file via MCP tool call', async () => {
    const file = join(tmpDir, 'hello.txt');
    await writeFile(file, 'Hello\nWorld\n');

    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: file },
    });
    assert.notStrictEqual(result.isError, true);
    const firstBlock = firstTextBlock(result);
    assert.strictEqual(firstBlock.type, 'text');
    assert.ok(firstBlock.text?.includes('Hello\nWorld\n'));
  });

  it('read accepts legal file names containing .. ; and backtick, refuses a .. segment', async () => {
    const cases = [
      'app/blog/[...slug]/page.tsx',
      'docs/v1..2.md',
      'semi;colon.txt',
      'back`tick.txt',
    ];
    for (const rel of cases) {
      const file = await writeTestFile(tmpDir, `legal-names/${rel}`, `content of ${rel}\n`);
      const result = await harness.client.callTool({ name: 'read', arguments: { path: file } });
      assert.notStrictEqual(result.isError, true, `${rel} must be readable`);
      assert.ok(firstTextBlock(result).text?.includes(`content of ${rel}`), rel);
    }

    // A whole ".." segment is still refused at the schema, before any fs access.
    // Built by string concatenation: `join` would collapse the `..` lexically.
    const traversal = `${tmpDir.replaceAll('\\', '/')}/legal-names/../legal-names/docs/v1..2.md`;
    const refused = await harness.client.callTool({
      name: 'read',
      arguments: { path: traversal },
    });
    assert.strictEqual(refused.isError, true);
    assert.match(firstTextBlock(refused).text ?? '', /Directory traversal/);
  });

  it('TC-FUNC-002: Read image file returns an image content block with base64 data', async () => {
    // Minimal 1x1 transparent PNG (known-good bytes).
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
        '890000000d49444154789c63f8cf00000001000100000005defb0a00000000' +
        '49454e44ae426082',
      'hex',
    );
    const file = join(tmpDir, 'pixel.png');
    await writeFile(file, pngBytes);

    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: file },
    });
    assert.notStrictEqual(result.isError, true);

    const imageBlock = (
      result.content as readonly { type: string; data?: string; mimeType?: string }[]
    ).find((b) => b.type === 'image');
    assert.ok(imageBlock, 'expected an image content block');
    assert.strictEqual(imageBlock.mimeType, 'image/png');
    assert.ok(imageBlock.data, 'image block must carry base64 data');
    const data = imageBlock.data;
    assert.ok(typeof data === 'string');
    assert.strictEqual(Buffer.from(data, 'base64').equals(pngBytes), true);

    const structured = result._meta as { results?: { value?: { kind?: string } }[] } | undefined;
    assert.strictEqual(structured?.results?.[0]?.value?.kind, 'image');
  });

  it('TC-FUNC-007: Read path outside allowed root returns isError: true with ACCESS_DENIED', async () => {
    const outsideFile = join(tmpdir(), 'outside_test.txt');
    await writeFile(outsideFile, 'secret');
    try {
      const result = await harness.client.callTool({
        name: 'read',
        arguments: { path: outsideFile },
      });
      assert.strictEqual(result.isError, true);
      const firstBlock = firstTextBlock(result);
      assert.ok(firstBlock.text);
    } finally {
      await rm(outsideFile, { force: true });
    }
  });

  it('TC-FUNC-009: Create single file via MCP tool call', async () => {
    const file = join(tmpDir, 'new.txt');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: file, content: 'new content' }] },
    });
    assert.notStrictEqual(result.isError, true);

    const content = await readFile(file, 'utf-8');
    assert.strictEqual(content, 'new content');
  });

  // An out-of-root path the access-grant pre-check refuses to even offer
  // (isUnsafeCwdPath), so the call reaches the plain ACCESS_DENIED envelope
  // instead of the "this client cannot show a confirmation" one. A grantable
  // out-of-root path (anything under tmpdir) would test the other branch.
  const UNGRANTABLE_DIR = process.platform === 'win32' ? 'C:\\Windows' : '/etc';

  it('TC-FUNC-009b: create reports isError when every requested file was denied', async () => {
    // Regression: create publishes {files, failures} with no `summary`, so the
    // total-failure check keyed on `summary` never fired and a fully-denied
    // write returned a success envelope.
    const outside = join(UNGRANTABLE_DIR, 'fsmcp_create_denied.txt');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: outside, content: 'nope' }] },
    });

    assert.strictEqual(result.isError, true);
    await assert.rejects(access(outside), 'the denied file must not exist');
  });

  it('TC-FUNC-009c: create stays a success when only some files were denied', async () => {
    const ok = join(tmpDir, 'partial.txt');
    const outside = join(UNGRANTABLE_DIR, 'fsmcp_create_partial.txt');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: {
        files: [
          { path: ok, content: 'written' },
          { path: outside, content: 'nope' },
        ],
      },
    });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(ok, 'utf-8'), 'written');
    await assert.rejects(access(outside), 'the denied file must not exist');
  });

  it('TC-FUNC-009j: create with append:true on a sensitive file is denied', async () => {
    const envPath = join(tmpDir, '.env');
    await writeTestFile(tmpDir, '.env', 'SECRET=1\n');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: envPath, content: 'LEAKED=1\n', append: true }] },
    });

    assert.strictEqual(result.isError, true);
    const structured = result.structuredContent as { failures?: { error?: { code?: string } }[] };
    assert.strictEqual(structured.failures?.[0]?.error?.code, 'ACCESS_DENIED');
    assert.strictEqual(await readFile(envPath, 'utf-8'), 'SECRET=1\n');
  });

  it('sensitive files never surface through search_text, find_files, list, replace_text or resources/read', async () => {
    const token = 'SENTINEL_ENV_9f3c1e';
    const dir = join(tmpDir, 'boundary_walk');
    const envFile = await writeTestFile(tmpDir, 'boundary_walk/.env', `SECRET=${token}\n`);
    const plain = await writeTestFile(tmpDir, 'boundary_walk/plain.txt', `note ${token}\n`);

    const search = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, searchPattern: token, includeHidden: true },
    });
    const matches = (search._meta as { matches?: { file: string }[] }).matches ?? [];
    assert.deepStrictEqual(
      matches.map((m) => m.file),
      ['plain.txt'],
      'search_text must not match inside .env',
    );

    const found = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: dir, pattern: '**/*', includeHidden: true },
    });
    const paths =
      (found._meta as { results?: { path: string }[] }).results?.map((r) => r.path) ?? [];
    assert.ok(paths.includes('plain.txt'));
    assert.ok(!paths.includes('.env'), `find_files must not list .env: ${paths.join(',')}`);

    const listed = await harness.client.callTool({
      name: 'list',
      arguments: { path: dir, includeHidden: true },
    });
    const names =
      (listed._meta as { entries?: { name: string }[] }).entries?.map((e) => e.name) ?? [];
    assert.ok(names.includes('plain.txt'));
    assert.ok(!names.includes('.env'), `list must not show .env: ${names.join(',')}`);

    const replaced = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: token, replacement: 'REDACTED', includeHidden: true },
    });
    assert.notStrictEqual(replaced.isError, true);
    assert.strictEqual(
      await readFile(envFile, 'utf-8'),
      `SECRET=${token}\n`,
      '.env must be untouched',
    );
    assert.strictEqual(await readFile(plain, 'utf-8'), 'note REDACTED\n');

    await assert.rejects(
      harness.client.readResource({ uri: buildFileResourceUri(envFile) }),
      'resources/read of a sensitive file must be refused',
    );
  });

  it('TC-FUNC-009e: create with append:true appends to an existing file', async () => {
    const file = await writeTestFile(tmpDir, 'append_target.txt', 'first\n');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: file, content: 'second\n', append: true }] },
    });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'first\nsecond\n');
  });

  it('TC-FUNC-009f: create with append:true creates a missing file', async () => {
    const file = join(tmpDir, 'append_new.txt');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: file, content: 'born from append\n', append: true }] },
    });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'born from append\n');
  });

  it('TC-FUNC-009g: append result reports whole-file size and line count', async () => {
    // Seed 2 lines, append an unterminated third: result must describe the
    // file on disk (5 bytes, 3 lines), not the appended chunk (1 byte, 1 line).
    const file = await writeTestFile(tmpDir, 'append_meta.txt', 'a\nb\n');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: file, content: 'c', append: true }] },
    });

    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as {
      files?: { size?: number; lineCount?: number; modified?: string }[];
    };
    const entry = structured.files?.[0];
    assert.strictEqual(entry?.size, 5);
    assert.strictEqual(entry?.lineCount, 3);
    assert.match(entry?.modified ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });

  it('TC-FUNC-009h: create batch mixes append and overwrite entries', async () => {
    const appendFile = await writeTestFile(tmpDir, 'batch_append.txt', 'keep\n');
    const overwriteFile = await writeTestFile(tmpDir, 'batch_overwrite.txt', 'discard\n');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: {
        files: [
          { path: appendFile, content: 'kept\n', append: true },
          { path: overwriteFile, content: 'replaced\n', overwrite: true },
        ],
      },
    });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(appendFile, 'utf-8'), 'keep\nkept\n');
    assert.strictEqual(await readFile(overwriteFile, 'utf-8'), 'replaced\n');
  });

  it('TC-FUNC-009m: create onto an existing file asks first; Skip leaves it untouched', async () => {
    const asked: string[] = [];
    const eh = await createElicitationClientPair([tmpDir], async (req) => {
      asked.push(req.params.message);
      return { action: 'accept' as const, content: { choice: 'skip' } };
    });
    try {
      const existing = await writeTestFile(tmpDir, 'create_skip_existing.txt', 'keep me\n');
      const fresh = join(tmpDir, 'create_skip_fresh.txt');
      const result = await eh.client.callTool({
        name: 'create',
        arguments: {
          files: [
            { path: existing, content: 'clobber\n' },
            { path: fresh, content: 'brand new\n' },
          ],
        },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result.structuredContent as { files?: { path: string }[]; skipped?: string[] };
      assert.strictEqual(s.files?.length, 1, 'only the fresh file is written');
      assert.ok(s.skipped?.includes(existing), 'the existing file is reported as skipped');
      assert.strictEqual(asked.length, 1, 'exactly one prompt, for the existing file only');
      assert.match(asked[0] ?? '', /already exists/i);
      assert.strictEqual(await readFile(existing, 'utf-8'), 'keep me\n');
      assert.strictEqual(await readFile(fresh, 'utf-8'), 'brand new\n');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-009n: create overwrite via choice round-trip replaces the file', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'overwrite' },
    }));
    try {
      const existing = await writeTestFile(tmpDir, 'create_ow_existing.txt', 'old\n');
      const result = await eh.client.callTool({
        name: 'create',
        arguments: { files: [{ path: existing, content: 'new\n' }] },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result.structuredContent as { files?: { path: string }[]; skipped?: string[] };
      assert.strictEqual(s.files?.length, 1);
      assert.strictEqual(s.skipped, undefined);
      assert.strictEqual(await readFile(existing, 'utf-8'), 'new\n');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-009o: overwrite: true replaces an existing file without asking', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => {
      throw new Error('overwrite: true must not prompt');
    });
    try {
      const existing = await writeTestFile(tmpDir, 'create_ow_flag.txt', 'old\n');
      const result = await eh.client.callTool({
        name: 'create',
        arguments: { files: [{ path: existing, content: 'new\n', overwrite: true }] },
      });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(await readFile(existing, 'utf-8'), 'new\n');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-009p: a client without elicitation gets a tool error naming overwrite: true', async () => {
    const eh = await createElicitationClientPair(
      [tmpDir],
      async () => {
        throw new Error('the server must not ask a client that cannot answer');
      },
      { noElicitation: true },
    );
    try {
      const existing = await writeTestFile(tmpDir, 'create_no_elicit.txt', 'keep me\n');
      const result = await eh.client.callTool({
        name: 'create',
        arguments: { files: [{ path: existing, content: 'clobber\n' }] },
      });
      assert.strictEqual(result.isError, true, 'must surface as a tool error');
      const text = (result.content as { type: string; text?: string }[])
        .map((block) => block.text ?? '')
        .join('\n');
      assert.match(text, /confirmation this client cannot show/i);
      assert.match(text, /overwrite/i);
      assert.strictEqual(await readFile(existing, 'utf-8'), 'keep me\n');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-009q: a file that appears during the confirmation gap is not overwritten', async () => {
    const gapFile = join(tmpDir, 'create_gap_appears.txt');
    const eh = await createElicitationClientPair([tmpDir], async () => {
      // Someone else writes the not-yet-existing entry while the human is
      // looking at the prompt for the other one.
      await writeFile(gapFile, 'written during the gap\n');
      return { action: 'accept' as const, content: { choice: 'overwrite' } };
    });
    try {
      const existing = await writeTestFile(tmpDir, 'create_gap_existing.txt', 'old\n');
      const result = await eh.client.callTool({
        name: 'create',
        arguments: {
          files: [
            { path: existing, content: 'new\n' },
            { path: gapFile, content: 'clobber\n' },
          ],
        },
      });
      assert.strictEqual(result.isError, true, 'fails closed');
      assert.strictEqual(await readFile(gapFile, 'utf-8'), 'written during the gap\n');
      assert.strictEqual(await readFile(existing, 'utf-8'), 'old\n', 'nothing written');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-009r: a declined overwrite is reported as declined by the user', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'decline' as const,
    }));
    try {
      const existing = await writeTestFile(tmpDir, 'create_ow_declined.txt', 'old\n');
      const result = await eh.client.callTool({
        name: 'create',
        arguments: { files: [{ path: existing, content: 'new\n' }] },
      });
      assert.strictEqual(result.isError, true, 'one file, one refusal: a total failure');
      const s = result.structuredContent as {
        failures?: { path: string; error: { code: string; message: string } }[];
      };
      assert.strictEqual(s.failures?.length, 1);
      assert.strictEqual(s.failures?.[0]?.error.code, 'CANCELLED');
      assert.match(s.failures?.[0]?.error.message ?? '', /declined by the user/);
      assert.strictEqual(await readFile(existing, 'utf-8'), 'old\n');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-009i: append succeeds on a file larger than max-file-size', async () => {
    // A >10 MiB file cannot pass through read/edit (TOO_LARGE), but appending
    // one line must still work — the bytes never enter model context.
    const oversize = 11 * 1024 * 1024;
    const file = join(tmpDir, 'append_oversize.log');
    await writeFile(file, Buffer.alloc(oversize, 0x61));
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: file, content: 'x\n', append: true }] },
    });

    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as {
      files?: { size?: number; resourceUri?: string }[];
    };
    const entry = structured.files?.[0];
    assert.strictEqual(entry?.size, oversize + 2);
    // The store serves resourceUri via readRaw, which rejects over-cap files
    // with TOO_LARGE — an unservable link must not be advertised at all.
    assert.strictEqual(entry?.resourceUri, undefined);
    const content = await readFile(file, 'utf-8');
    assert.ok(content.endsWith('x\n'));
  });

  it('TC-FUNC-009l: an append whose metadata reads fail still reports success', async (t) => {
    // A POSIX write-only (0222) file appends fine but cannot be opened 'r',
    // so the sample/line-count reads throw: the append is the commit point
    // and a reported failure would invite a retry that appends twice.
    if (process.platform === 'win32') return t.skip('POSIX-only 0222 append target');

    const file = join(tmpDir, 'append_write_only.txt');
    await writeFile(file, 'seed\n');
    await chmod(file, 0o222);
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: file, content: 'tail\n', append: true }] },
    });

    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as { files?: { lineCount?: number }[] };
    assert.strictEqual(
      structured.files?.[0]?.lineCount,
      0,
      'unreadable metadata degrades to lineCount 0, not a failed append',
    );
    await chmod(file, 0o644);
    assert.strictEqual(await readFile(file, 'utf-8'), 'seed\ntail\n');
  });

  it('TC-FUNC-009k: append result MIME comes from the resulting file, not the appended chunk', async () => {
    // Seed an extensionless binary file, append text: the result must still
    // report binary — text appended to a binary file does not make it text.
    const file = join(tmpDir, 'append_binary_seed');
    await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: file, content: 'plain text tail', append: true }] },
    });

    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as {
      files?: { kind?: string; mimeType?: string; size?: number }[];
    };
    const entry = structured.files?.[0];
    assert.strictEqual(entry?.kind, 'binary');
    assert.strictEqual(entry?.mimeType, 'application/octet-stream');
    assert.strictEqual(entry?.size, 4 + 'plain text tail'.length);
  });

  it('TC-FUNC-009d: move reports isError when every requested move was denied', async () => {
    const source = join(tmpDir, 'movable.txt');
    await writeFile(source, 'body');
    const result = await harness.client.callTool({
      name: 'move',
      arguments: {
        moves: [{ source, destination: join(UNGRANTABLE_DIR, 'fsmcp_move_denied.txt') }],
        copy: true,
      },
    });

    assert.strictEqual(result.isError, true);
  });

  it('TC-FUNC-010b: deleting a workspace root names the root, not the parent', async () => {
    // The parent of a root is out-of-root by construction, so the containment
    // check used to answer "Outside allowed directories" for the one directory
    // list_roots reports as allowed.
    const result = await harness.client.callTool({
      name: 'delete',
      arguments: { paths: [tmpDir], recursive: true },
    });

    assert.strictEqual(result.isError, true);
    const text = firstTextBlock(result).text ?? '';
    assert.match(text, /workspace root/i);
    await access(tmpDir);
  });

  it('TC-FUNC-012: --read-only suppresses mutating tools on client.listTools()', async () => {
    const readOnlyHarness = await createTestClientPair([tmpDir], { readOnly: true });
    try {
      const toolsResult = await readOnlyHarness.client.listTools();
      assert.strictEqual(toolsResult.tools.length, registeredTools(true).length);
      for (const tool of toolsResult.tools) {
        assert(!MUTATING_TOOL_NAMES.has(tool.name));
      }

      // Calling a mutating tool on read-only server should reject with -32602
      await assert.rejects(
        async () => {
          await readOnlyHarness.client.callTool({
            name: 'create',
            arguments: { files: [{ path: join(tmpDir, 'fail.txt'), content: 'fail' }] },
          });
        },
        (err: unknown) => {
          return (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code: ProtocolErrorCode }).code === ProtocolErrorCode.InvalidParams
          );
        },
      );
    } finally {
      await readOnlyHarness.close();
    }

    const allTools = registeredTools(false);
    assert.strictEqual(allTools.length, ALL_REGISTERED_TOOL_NAMES.length);
  });

  it('tools/list publishes slimmed schemas and preserves Zod runtime semantics', async () => {
    const pinHarness = await createTestClientPair([tmpDir]);
    try {
      const { tools } = await pinHarness.client.listTools();
      assert.ok(tools.length > 0);
      for (const tool of tools) {
        // The wire copy is the SDK's own conversion of the Zod schema: no $defs
        // except where a subschema is deliberately hoisted.
        // `edit` is the deliberate exception: EditSpec is used at two sites in
        // one document, so it carries an `id` and is hoisted (see below).
        if (tool.name !== 'edit') {
          assert.strictEqual(
            (tool.inputSchema as { $defs?: unknown }).$defs,
            undefined,
            `${tool.name} must publish a dereferenced input schema without $defs`,
          );
        }
      }

      // Zod defaults still reach the handler: edit applies with dryRun's
      // default (false), so the file on disk actually changes.
      const file = await writeTestFile(tmpDir, 'schema-defaults.txt', 'before body');
      const defaulted = await pinHarness.client.callTool({
        name: 'edit',
        arguments: { path: file, edits: [{ oldText: 'before body', newText: 'after body' }] },
      });
      assert.notStrictEqual(defaulted.isError, true);
      const edited = await readFile(file, 'utf-8');
      assert.strictEqual(edited, 'after body', 'Zod defaults must reach the tool handler');

      // Zod validation still runs with its error messages.
      const invalid = await pinHarness.client.callTool({
        name: 'read',
        arguments: { path: file, head: 0 },
      });
      assert.strictEqual(invalid.isError, true);
      const errorText = firstTextBlock(invalid).text ?? '';
      assert.match(errorText, /head/u);
    } finally {
      await pinHarness.close();
    }
  });

  it('TC-FUNC-013: Edit via MCP tool call', async () => {
    const file = join(tmpDir, 'edit.txt');
    const edits = [{ oldText: 'original', newText: 'modified' }];
    for (const args of [{ path: file, edits }, { files: [{ path: file, edits }] }]) {
      await writeFile(file, 'original content');
      const result = await harness.client.callTool({ name: 'edit', arguments: args });
      assert.notStrictEqual(result.isError, true);

      const content = await readFile(file, 'utf-8');
      assert.strictEqual(content, 'modified content');
    }
  });

  // An oldText that occurs more than once used to edit the first occurrence and
  // report success, so the wrong block changed silently.
  it('edit rejects an oldText that matches more than once, dry run included', async () => {
    const original = 'a\nfoo\nb\nfoo\nc\nfoo\n';
    const file = await writeTestFile(tmpDir, 'ambiguous/literal.txt', original);

    for (const dryRun of [false, true]) {
      const result = await harness.client.callTool({
        name: 'edit',
        arguments: { path: file, edits: [{ oldText: 'foo', newText: 'bar' }], dryRun },
      });
      assert.strictEqual(result.isError, true, `dryRun=${String(dryRun)}`);
      const error = failedSummary(result)?.results?.[0]?.error;
      assert.strictEqual(error?.code, 'INVALID_INPUT');
      assert.match(error?.message ?? '', /3 places \(lines 2, 4, 6\)/u);
      assert.strictEqual(await readFile(file, 'utf-8'), original);
    }
  });

  it('edit counts overlapping occurrences of oldText as ambiguous', async () => {
    const file = await writeTestFile(tmpDir, 'ambiguous/overlap.txt', 'ababab\n');
    for (const ignoreWhitespace of [false, true]) {
      const result = await harness.client.callTool({
        name: 'edit',
        arguments: { path: file, edits: [{ oldText: 'abab', newText: 'X' }], ignoreWhitespace },
      });
      assert.strictEqual(result.isError, true, `ignoreWhitespace=${String(ignoreWhitespace)}`);
      assert.match(
        failedSummary(result)?.results?.[0]?.error?.message ?? '',
        /2 places \(line 1\)/u,
      );
      assert.strictEqual(await readFile(file, 'utf-8'), 'ababab\n');
    }
  });

  // Leading whitespace in the flexible pattern matches from any column of the
  // indentation, which is the same occurrence, not a second one.
  it('edit with ignoreWhitespace applies a unique indented oldText', async () => {
    const file = await writeTestFile(tmpDir, 'ambiguous/indented.txt', 'f() {\n    run();\n}\n');
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: '  run();', newText: '  go();' }],
        ignoreWhitespace: true,
      },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'f() {\n  go();\n}\n');
  });

  it('edit with ignoreWhitespace keeps the blank line and indentation after a trailing newline', async () => {
    const file = await writeTestFile(
      tmpDir,
      'ambiguous/trailing-edge.py',
      'def f():\n    x = 1\n\n    y = 2\n',
    );
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: '    x = 1\n', newText: '    x = 3\n' }],
        ignoreWhitespace: true,
      },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'def f():\n    x = 3\n\n    y = 2\n');
  });

  it('edit with ignoreWhitespace keeps the blank lines before a leading newline', async () => {
    const file = await writeTestFile(tmpDir, 'ambiguous/leading-edge.txt', 'a\n\n\n    y = 2\n');
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: '\n    y = 2', newText: '\n    y = 3' }],
        ignoreWhitespace: true,
      },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'a\n\n\n    y = 3\n');
  });

  it('edit names the ambiguous edit and flags lines shifted by earlier edits', async () => {
    const original = 'x\nfoo\nfoo\n';
    const file = await writeTestFile(tmpDir, 'ambiguous/index.txt', original);

    const shifted = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [
          { oldText: 'x\n', newText: 'y\nz\n' },
          { oldText: 'foo', newText: 'bar' },
        ],
      },
    });
    assert.match(
      failedSummary(shifted)?.results?.[0]?.error?.message ?? '',
      /^edits\[1\]: oldText matches 2 places after earlier edits \(lines 3, 4\)/u,
    );

    // An earlier edit that matched nothing changed nothing, so the lines are the file's own.
    const unshifted = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [
          { oldText: 'missing', newText: 'y' },
          { oldText: 'foo', newText: 'bar' },
        ],
      },
    });
    assert.match(
      failedSummary(unshifted)?.results?.[0]?.error?.message ?? '',
      /^edits\[1\]: oldText matches 2 places \(lines 2, 3\)/u,
    );
    assert.strictEqual(await readFile(file, 'utf-8'), original);
  });

  it('edit lists at most five matched lines', async () => {
    const file = await writeTestFile(tmpDir, 'ambiguous/many.txt', 'foo\n'.repeat(6));
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: { path: file, edits: [{ oldText: 'foo', newText: 'bar' }] },
    });
    assert.match(
      failedSummary(result)?.results?.[0]?.error?.message ?? '',
      /6 places \(lines 1, 2, 3, 4, 5, \.\.\.\)/u,
    );
  });

  it('edit with ignoreWhitespace rejects an oldText that matches more than once', async () => {
    const original = 'if (x) {\n  run();\n}\nif (x) {\n    run();\n}\n';
    const file = await writeTestFile(tmpDir, 'ambiguous/whitespace.txt', original);
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'if (x) {\nrun();', newText: 'if (y) {\nrun();' }],
        ignoreWhitespace: true,
      },
    });
    assert.strictEqual(result.isError, true);
    assert.match(
      failedSummary(result)?.results?.[0]?.error?.message ?? '',
      /2 places \(lines 1, 4\)/u,
    );
    assert.strictEqual(await readFile(file, 'utf-8'), original);
  });

  it('edit converts LF edit text to CRLF in a CRLF file', async () => {
    const literalFile = await writeTestFile(tmpDir, 'crlf/literal.txt', 'one\r\ntwo\r\nthree\r\n');
    const literalResult = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: literalFile,
        edits: [{ oldText: 'one\ntwo', newText: 'uno\ndos' }],
      },
    });
    assert.notStrictEqual(literalResult.isError, true);
    assert.strictEqual(await readFile(literalFile, 'utf-8'), 'uno\r\ndos\r\nthree\r\n');

    const blankLineFile = await writeTestFile(tmpDir, 'crlf/blank-line.txt', 'a\r\n\r\nb\r\n');
    const blankLineResult = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: blankLineFile,
        edits: [{ oldText: 'a\n\nb', newText: 'c\n\nd' }],
        ignoreWhitespace: true,
      },
    });
    assert.notStrictEqual(blankLineResult.isError, true);
    assert.strictEqual(await readFile(blankLineFile, 'utf-8'), 'c\r\n\r\nd\r\n');

    const mixedFile = await writeTestFile(tmpDir, 'crlf/mixed.txt', 'mixed\r\nlf\n');
    const mixedResult = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: mixedFile,
        edits: [{ oldText: 'mixed\nlf', newText: 'x' }],
      },
    });
    assert.strictEqual(mixedResult.isError, true);
    assert.strictEqual(await readFile(mixedFile, 'utf-8'), 'mixed\r\nlf\n');
  });

  it('edit refuses a batch that names the same file twice', async () => {
    const original = 'alpha\nbeta\n';
    const file = await writeTestFile(tmpDir, 'dup-batch/dup.txt', original);
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        files: [
          { path: file, edits: [{ oldText: 'alpha', newText: 'A' }] },
          { path: file, edits: [{ oldText: 'beta', newText: 'B' }] },
        ],
      },
    });
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /duplicate of files\[0\]\.path/u);
    assert.strictEqual(await readFile(file, 'utf-8'), original);

    if (process.platform === 'win32' || process.platform === 'darwin') {
      const upper = join(dirname(file), 'DUP.TXT');
      const caseResult = await harness.client.callTool({
        name: 'edit',
        arguments: {
          files: [
            { path: file, edits: [{ oldText: 'alpha', newText: 'A' }] },
            { path: upper, edits: [{ oldText: 'beta', newText: 'B' }] },
          ],
        },
      });
      assert.strictEqual(caseResult.isError, true);
      assert.match(firstTextBlock(caseResult).text ?? '', /duplicate of files\[0\]\.path/u);
      assert.strictEqual(await readFile(file, 'utf-8'), original);
    }
  });

  it('create refuses a batch whose combined content exceeds the file limit', async () => {
    const limit = getMaxTextFileSize();
    const half = 'x'.repeat(Math.ceil(limit / 2) + 1);
    const result = await harness.client.callTool({
      name: 'create',
      arguments: {
        files: [
          { path: join(tmpDir, 'batch-a.txt'), content: half },
          { path: join(tmpDir, 'batch-b.txt'), content: half },
        ],
      },
    });
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /combined content .* Split the batch/);
  });

  it('create refuses a batch that names the same file twice', async () => {
    const file = join(tmpDir, 'dup-create', 'dup.txt');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: {
        files: [
          { path: file, content: 'AAAA' },
          { path: file, content: 'BBBB' },
        ],
      },
    });
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /duplicate of files\[0\]\.path/u);
    await assert.rejects(access(file), 'nothing may be written when the batch is refused');

    if (process.platform === 'win32' || process.platform === 'darwin') {
      const caseResult = await harness.client.callTool({
        name: 'create',
        arguments: {
          files: [
            { path: file, content: 'AAAA' },
            { path: join(tmpDir, 'dup-create', 'DUP.TXT'), content: 'BBBB' },
          ],
        },
      });
      assert.strictEqual(caseResult.isError, true);
      assert.match(firstTextBlock(caseResult).text ?? '', /duplicate of files\[0\]\.path/u);
    }
  });

  it('TC-FUNC-015: Read non-existent file returns error in per-path results', async () => {
    const missing = join(tmpDir, 'missing.txt');
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: missing },
    });
    const structured = failedSummary(result);
    assert.strictEqual(structured?.summary?.failed, 1);
    assert.strictEqual(structured?.results?.[0]?.error?.code, 'NOT_FOUND');
  });

  it('read refuses a UTF-16 file with a message that names the encoding', async () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('hello\nworld\n', 'utf16le'),
    ]);
    const file = join(tmpDir, 'utf16le.txt');
    await writeFile(file, utf16);

    for (const extra of [{}, { head: 1 }, { tail: 1 }, { startLine: 1, endLine: 1 }]) {
      const result = await harness.client.callTool({
        name: 'read',
        arguments: { path: file, ...extra },
      });
      assert.strictEqual(result.isError, true, `mode ${JSON.stringify(extra)} must refuse`);
      const error = failedSummary(result)?.results?.[0]?.error;
      assert.strictEqual(error?.code, 'INVALID_INPUT');
      assert.match(error?.message ?? '', /UTF-16/);
    }
  });

  it('TC-FUNC-017: Delete file via MCP tool call', async () => {
    const file = join(tmpDir, 'delete.txt');
    await writeFile(file, 'to delete');

    const result = await harness.client.callTool({
      name: 'delete',
      arguments: { paths: [file] },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result._meta as
      | {
          results?: { path?: string; value?: { deleted?: boolean } }[];
          summary?: { failed?: number };
        }
      | undefined;
    assert.strictEqual(structured?.summary?.failed, 0);
    assert.strictEqual(structured?.results?.[0]?.value?.deleted, true);

    const readRes = await harness.client.callTool({
      name: 'read',
      arguments: { path: file },
    });
    const readStructured = failedSummary(readRes);
    assert.strictEqual(readStructured?.summary?.failed, 1);
    assert.strictEqual(readStructured?.results?.[0]?.error?.code, 'NOT_FOUND');
  });

  it('TC-FUNC-021: Move/rename via MCP tool call', async () => {
    const file = join(tmpDir, 'old.txt');
    const newFile = join(tmpDir, 'new_name.txt');
    await writeFile(file, 'move me');

    const result = await harness.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: file, destination: newFile }] },
    });
    assert.notStrictEqual(result.isError, true);

    const oldRead = await harness.client.callTool({
      name: 'read',
      arguments: { path: file },
    });
    const oldStructured = failedSummary(oldRead);
    assert.strictEqual(oldStructured?.summary?.failed, 1);

    const newRead = await harness.client.callTool({
      name: 'read',
      arguments: { path: newFile },
    });
    assert.notStrictEqual(newRead.isError, true);
    const block = firstTextBlock(newRead);
    assert.ok(block.text?.includes('move me'));
  });

  it('move performs a case-only rename on a case-insensitive filesystem', async (t) => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      t.skip('case-only rename is only special on a case-insensitive filesystem');
      return;
    }
    const dir = join(tmpDir, 'case_rename');
    const lower = await writeTestFile(tmpDir, 'case_rename/foo.txt', 'same bytes\n');
    const upper = join(dir, 'Foo.txt');

    const result = await harness.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: lower, destination: upper }] },
    });
    assert.notStrictEqual(result.isError, true);
    const moves = (result._meta as { moves?: { to: string }[] }).moves ?? [];
    assert.strictEqual(moves.length, 1, 'a case-only rename is real work, not a no-op');
    assert.deepStrictEqual(await readdir(dir), ['Foo.txt']);
    assert.strictEqual(await readFile(upper, 'utf-8'), 'same bytes\n');
  });

  it("read's resource_link and resourceUri name the same file", async () => {
    const file = join(tmpDir, 'uri_agreement.txt');
    await writeFile(file, 'content\n');

    // Request it by a path whose case differs from the resolved one. The link
    // used to be rebuilt from the *requested* path while resourceUri came from
    // the validated one, so the two disagreed and each keyed its own watcher.
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: file.replace(/^([a-z]):/iu, (_m, d: string) => `${d.toUpperCase()}:`) },
    });
    assert.notStrictEqual(result.isError, true);

    const structured = result._meta as {
      results?: { value?: { resourceUri?: string } }[];
    };
    const resourceUri = structured.results?.[0]?.value?.resourceUri;
    const link = (result.content as { type: string; uri?: string }[]).find(
      (c) => c.type === 'resource_link',
    );
    assert.ok(resourceUri, 'read must expose a resourceUri');
    assert.strictEqual(link?.uri, resourceUri);
  });

  it("read's resource_link carries the file's mtime as lastModified", async () => {
    const file = join(tmpDir, 'stamped.txt');
    await writeFile(file, 'content\n');
    const { mtime } = await stat(file);
    const result = await harness.client.callTool({ name: 'read', arguments: { path: file } });
    const link = (
      result.content as { type: string; annotations?: { lastModified?: string } }[]
    ).find((c) => c.type === 'resource_link');
    assert.strictEqual(link?.annotations?.lastModified, mtime.toISOString());
    const structured = result._meta as { results?: { value?: { modified?: string } }[] };
    assert.strictEqual(structured.results?.[0]?.value?.modified, mtime.toISOString());
  });

  it("create's resource_link lastModified equals the structured modified", async () => {
    const file = join(tmpDir, 'created-stamped.txt');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: file, content: 'hello\n' }] },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as { files: { modified: string }[] };
    const link = (
      result.content as { type: string; annotations?: { lastModified?: string } }[]
    ).find((c) => c.type === 'resource_link');
    assert.ok(structured.files[0]?.modified);
    assert.strictEqual(link?.annotations?.lastModified, structured.files[0]?.modified);
  });

  it('a call where every path failed is reported as isError', async () => {
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { paths: [join(tmpDir, 'no_such_a.txt'), join(tmpDir, 'no_such_b.txt')] },
    });
    assert.strictEqual(result.isError, true, 'no path succeeded, so the call failed');
    assert.strictEqual(failedSummary(result)?.summary?.failed, 2);
  });

  it('a partly-failed batch is not isError', async () => {
    const ok = join(tmpDir, 'partial_ok.txt');
    await writeFile(ok, 'here\n');

    const result = await harness.client.callTool({
      name: 'read',
      arguments: { paths: [ok, join(tmpDir, 'partial_missing.txt')] },
    });
    assert.notStrictEqual(result.isError, true, 'one path really was read');
    assert.strictEqual(failedSummary(result)?.summary?.failed, 1);
  });

  it('batch read budget: one oversized file skips only itself, in full and ranged reads', async () => {
    const big = await writeTestFile(tmpDir, 'budget/big.txt', 'x'.repeat(600 * 1024) + '\nlast\n');
    const small = await writeTestFile(tmpDir, 'budget/small.txt', 'tiny\n');

    const ranged = await harness.client.callTool({
      name: 'read',
      arguments: { paths: [big, small], head: 1 },
    });
    assert.notStrictEqual(ranged.isError, true, 'the batch is partly-failed, not wholly failed');
    assert.strictEqual(failedSummary(ranged)?.results?.[0]?.error?.code, 'TOO_LARGE');
    assert.strictEqual(
      failedSummary(ranged)?.results?.[1]?.error,
      undefined,
      'the small file must still be read even in a ranged batch',
    );

    const full = await harness.client.callTool({
      name: 'read',
      arguments: { paths: [big, small] },
    });
    assert.notStrictEqual(full.isError, true, 'the small file must still be read');
    const results = failedSummary(full)?.results ?? [];
    assert.strictEqual(results[0]?.error?.code, 'TOO_LARGE');
    assert.strictEqual(
      results[1]?.error,
      undefined,
      'the file after the oversized one must succeed',
    );
    assert.ok(firstTextBlock(full).text?.includes('tiny'));

    const alone = await harness.client.callTool({ name: 'read', arguments: { paths: [big] } });
    assert.strictEqual(alone.isError, true, 'a lone oversized file is still refused');

    const single = await harness.client.callTool({
      name: 'read',
      arguments: { path: big, head: 1 },
    });
    assert.notStrictEqual(
      single.isError,
      true,
      'a single-path ranged read is the documented escape hatch',
    );
  });

  it('read budget: a skipped file carries the TOO_LARGE suggestion', async () => {
    const big = await writeTestFile(tmpDir, 'budget2/big.txt', 'x'.repeat(600 * 1024) + '\nlast\n');
    const small = await writeTestFile(tmpDir, 'budget2/small.txt', 'tiny\n');

    const result = await harness.client.callTool({
      name: 'read',
      arguments: { paths: [big, small] },
    });
    const error = failedSummary(result)?.results?.[0]?.error;
    assert.strictEqual(error?.code, 'TOO_LARGE');
    assert.strictEqual(error?.suggestion, 'Use head/tail or line ranges to read partially.');
  });

  it('read budget: duplicate paths keep one row per requested index, in order', async () => {
    const big = await writeTestFile(tmpDir, 'budget3/big.txt', 'x'.repeat(600 * 1024) + '\nlast\n');
    const small = await writeTestFile(tmpDir, 'budget3/small.txt', 'tiny\n');

    const result = await harness.client.callTool({
      name: 'read',
      arguments: { paths: [big, small, small, big] },
    });
    const summary = failedSummary(result);
    const rows = summary?.results ?? [];
    assert.strictEqual(rows.length, 4);
    assert.strictEqual(rows[0]?.error?.code, 'TOO_LARGE');
    assert.strictEqual(rows[1]?.error, undefined);
    assert.strictEqual(rows[2]?.error, undefined);
    assert.strictEqual(rows[3]?.error?.code, 'TOO_LARGE');
    assert.deepStrictEqual(
      rows.map((r) => (r as { path?: string }).path),
      [big, small, small, big],
    );
    assert.strictEqual(summary?.summary?.failed, 2);
  });

  it('TC-FUNC-052: List roots via MCP tool call', async () => {
    const result = await harness.client.callTool({ name: 'list_roots' });
    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as { roots?: string[]; hint?: string } | undefined;
    assert.ok((structured?.roots?.length ?? 0) > 0, 'Should have at least one allowed directory');
    assert.strictEqual(structured?.hint, undefined, 'a configured server pays for no hint');
  });

  it('TC-FUNC-052b: list_roots with no roots says how to configure them', async () => {
    // An empty `roots` reports the problem; without this the caller learns
    // nothing about the fix, and the elicitation route out is in no description.
    const bare = await createTestClientPair([]);
    try {
      const result = await bare.client.callTool({ name: 'list_roots' });
      assert.notStrictEqual(result.isError, true);
      const structured = result.structuredContent as { roots?: string[]; hint?: string };
      assert.deepStrictEqual(structured.roots, []);
      assert.match(structured.hint ?? '', /FS_ALLOWED_DIRS/);
      assert.match(structured.hint ?? '', /--allow-cwd/);
      assert.match(structured.hint ?? '', /approve the requested grant/);
    } finally {
      await bare.close();
    }
  });

  it('TC-FUNC-053: Copy with overwrite: true succeeds when destination exists', async () => {
    const src = join(tmpDir, 'copy_ow_src.txt');
    const dst = join(tmpDir, 'copy_ow_dst.txt');
    await writeFile(src, 'new source');
    await writeFile(dst, 'existing dst');

    const result = await harness.client.callTool({
      name: 'move',
      arguments: {
        moves: [{ source: src, destination: dst }],
        copy: true,
        overwrite: true,
      },
    });
    assert.notStrictEqual(result.isError, true);
    const dstContent = await readFile(dst, 'utf-8');
    assert.strictEqual(dstContent, 'new source');
  });

  it('TC-FUNC-054: Copy single file via MCP tool call', async () => {
    const src = join(tmpDir, 'copy_src.txt');
    const dst = join(tmpDir, 'copy_dst.txt');
    await writeFile(src, 'copy content');

    const result = await harness.client.callTool({
      name: 'move',
      arguments: {
        moves: [{ source: src, destination: dst }],
        copy: true,
      },
    });
    assert.notStrictEqual(result.isError, true);

    const srcContent = await readFile(src, 'utf-8');
    const dstContent = await readFile(dst, 'utf-8');
    assert.strictEqual(srcContent, 'copy content');
    assert.strictEqual(dstContent, 'copy content');
  });

  it('TC-FUNC-055: Copy recursive directory via MCP tool call', async () => {
    const srcDir = join(tmpDir, 'copy_src_dir');
    const dstDir = join(tmpDir, 'copy_dst_dir');
    await mkdir(join(srcDir, 'sub'), { recursive: true });
    await writeFile(join(srcDir, 'file1.txt'), 'file1');
    await writeFile(join(srcDir, 'sub', 'file2.txt'), 'file2');

    const result = await harness.client.callTool({
      name: 'move',
      arguments: {
        moves: [{ source: srcDir, destination: dstDir }],
        copy: true,
      },
    });
    assert.notStrictEqual(result.isError, true);

    const dst1 = await readFile(join(dstDir, 'file1.txt'), 'utf-8');
    const dst2 = await readFile(join(dstDir, 'sub', 'file2.txt'), 'utf-8');
    assert.strictEqual(dst1, 'file1');
    assert.strictEqual(dst2, 'file2');
  });

  it('TC-FUNC-056: Copy out-of-root source returns isError: true with ACCESS_DENIED', async () => {
    const outsideFile = join(tmpdir(), 'outside_copy.txt');
    await writeFile(outsideFile, 'secret');
    try {
      const result = await harness.client.callTool({
        name: 'move',
        arguments: {
          moves: [{ source: outsideFile, destination: join(tmpDir, 'stolen.txt') }],
          copy: true,
        },
      });
      assert.strictEqual(result.isError, true);
    } finally {
      await rm(outsideFile, { force: true });
    }
  });

  it('move and copy both refuse a destination inside the source directory', async () => {
    // `planTransfer` runs ONE containment guard for both ops. Move used to
    // build its own `source + sep` prefix test, which never matched a bare
    // filesystem root; the shared `isPathInsideDirectory` does. Pin both ops so
    // the stricter semantics stay deliberate — a directory moved or copied into
    // its own subtree recurses into itself.
    const srcDir = join(tmpDir, 'selfnest_src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'f.txt'), 'x');
    const inside = join(srcDir, 'nested', 'target');

    for (const copy of [false, true]) {
      const label = `copy=${String(copy)}`;
      const result = await harness.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: srcDir, destination: inside }], copy },
      });
      assert.strictEqual(result.isError, true, `${label} must be refused`);
      const { failures = [] } = result._meta as {
        failures?: { error: { code: string; message: string } }[];
      };
      assert.strictEqual(failures.length, 1, `${label} reports one failure`);
      assert.strictEqual(failures[0]?.error.code, 'INVALID_INPUT', label);
      assert.match(failures[0]?.error.message ?? '', /own subdirectory/, label);
      await assert.rejects(access(inside), `${label} created nothing`);
    }
  });

  it('move and copy refuse a directory whose tree contains a path-denied file', async (t) => {
    // `secrets/**` is path-based: it denies secrets/x.txt but not public/x.txt,
    // so moving the directory used to carry the file out of the rule.
    await withEnv({ FS_DENYLIST: 'secrets/**,linked-secrets/**' }, async () => {
      const root = await createTestRoot();
      const own = await createTestClientPair([root]);
      try {
        const secret = await writeTestFile(root, 'secrets/inner/x.txt', 'top secret\n');
        const plainDir = join(root, 'plain');
        await writeTestFile(root, 'plain/ok.txt', 'ok\n');

        for (const copy of [false, true]) {
          const label = `copy=${String(copy)}`;
          const result = await own.client.callTool({
            name: 'move',
            arguments: {
              moves: [{ source: join(root, 'secrets'), destination: join(root, 'public') }],
              copy,
            },
          });
          assert.strictEqual(result.isError, true, `${label} must be refused`);
          const { failures = [] } = result._meta as {
            failures?: { error: { code: string; message: string } }[];
          };
          assert.strictEqual(failures[0]?.error.code, 'ACCESS_DENIED', label);
          assert.match(failures[0]?.error.message ?? '', /protected/i, label);
          await assert.rejects(access(join(root, 'public')), `${label} created nothing`);
          assert.strictEqual(
            await readFile(secret, 'utf-8'),
            'top secret\n',
            `${label} left the source`,
          );
        }

        const linkedTarget = join(root, 'linked-target');
        await writeTestFile(root, 'linked-target/inner/x.txt', 'via symlink\n');
        const linkedSource = join(root, 'linked-secrets');
        if (
          await trySymlink(linkedTarget, linkedSource, () =>
            t.diagnostic('symlink not permitted; symlinked directory coverage skipped'),
          )
        ) {
          const copyResult = await own.client.callTool({
            name: 'move',
            arguments: {
              moves: [{ source: linkedSource, destination: join(root, 'public-link') }],
              copy: true,
            },
          });
          assert.strictEqual(copyResult.isError, true, 'symlink copy must be refused');
          const { failures = [] } = copyResult._meta as {
            failures?: { error: { code: string; message: string } }[];
          };
          assert.strictEqual(failures[0]?.error.code, 'ACCESS_DENIED', 'symlink copy');
          assert.match(failures[0]?.error.message ?? '', /protected/i, 'symlink copy');
          await assert.rejects(access(join(root, 'public-link')), 'symlink copy created nothing');
          assert.strictEqual(
            await readFile(join(linkedSource, 'inner/x.txt'), 'utf-8'),
            'via symlink\n',
            'symlink copy left the source',
          );

          const moveResult = await own.client.callTool({
            name: 'move',
            arguments: {
              moves: [{ source: linkedSource, destination: join(root, 'public-link') }],
            },
          });
          assert.notStrictEqual(moveResult.isError, true, 'symlink move must succeed');
          await access(join(root, 'public-link'));
          assert.strictEqual(
            await readFile(join(linkedTarget, 'inner/x.txt'), 'utf-8'),
            'via symlink\n',
            'symlink move left the linked target intact',
          );
        }

        const credentialsDir = join(root, 'credentials-dir');
        const credentials = await writeTestFile(root, 'credentials-dir/credentials', 'key\n');
        for (const copy of [false, true]) {
          const label = `destination copy=${String(copy)}`;
          const result = await own.client.callTool({
            name: 'move',
            arguments: {
              moves: [{ source: credentialsDir, destination: join(root, '.aws') }],
              copy,
            },
          });
          assert.strictEqual(result.isError, true, `${label} must be refused`);
          const { failures = [] } = result._meta as {
            failures?: { error: { code: string; message: string } }[];
          };
          assert.strictEqual(failures[0]?.error.code, 'ACCESS_DENIED', label);
          assert.match(failures[0]?.error.message ?? '', /protected/i, label);
          await assert.rejects(access(join(root, '.aws')), `${label} created nothing`);
          assert.strictEqual(
            await readFile(credentials, 'utf-8'),
            'key\n',
            `${label} left the source`,
          );
        }

        const proj = join(root, 'proj');
        await writeTestFile(root, 'proj/.env', 'SECRET=1\n');
        await writeTestFile(root, 'proj/app.ts', 'x\n');
        const envMove = await own.client.callTool({
          name: 'move',
          arguments: { moves: [{ source: proj, destination: join(root, 'proj-moved') }] },
        });
        assert.notStrictEqual(envMove.isError, true);
        assert.strictEqual(await readFile(join(root, 'proj-moved', 'app.ts'), 'utf-8'), 'x\n');
        await access(join(root, 'proj-moved', '.env'));
        const envRead = await own.client.callTool({
          name: 'read',
          arguments: { path: join(root, 'proj-moved', '.env') },
        });
        assert.strictEqual(envRead.isError, true);

        // A clean tree still moves: the pre-walk must not refuse everything.
        const moved = await own.client.callTool({
          name: 'move',
          arguments: { moves: [{ source: plainDir, destination: join(root, 'moved') }] },
        });
        assert.notStrictEqual(moved.isError, true);
        assert.strictEqual(await readFile(join(root, 'moved', 'ok.txt'), 'utf-8'), 'ok\n');
      } finally {
        await own.close();
        await cleanupTestRoot(root);
      }
    });
  });

  // idempotentHint is gone from the declarations (production never read it); pin
  // that it stays off the wire too — it costs every client tokens without
  // changing what any tool does.
  it('TC-FUNC-058b: list does not publish idempotentHint on the wire', async () => {
    const { tools } = await harness.client.listTools();
    const listTool = tools.find((t) => t.name === 'list');
    assert.ok(listTool, 'list must be registered');
    assert.strictEqual(listTool.annotations?.idempotentHint, undefined);
  });

  // A grant widens the allowed roots, and no resource list reads them: the
  // instructions resource has a fixed URI, the result template lists the
  // ResourceStore, and the file template lists nothing. Notifying here only
  // bought the client a re-fetch of a list that could not have changed.
  it('TC-FUNC-059: an access grant sends no resources/list_changed', async () => {
    const parentDir = await createTestRoot();
    const rootDir = join(parentDir, 'root');
    const outsideDir = join(parentDir, 'outside');
    await mkdir(rootDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, 'file.txt');
    await writeFile(outsideFile, 'test content');

    let notified = false;
    const notifier = {
      toolsChanged: () => {},
      promptsChanged: () => {},
      resourcesChanged: () => {
        notified = true;
      },
      resourceUpdated: () => {},
    };

    try {
      await withBoundary(parentDir, async () => {
        const serverCtx = await createServer({ cliAllowedDirs: [rootDir] }, { notifier });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client(
          { name: 'test-harness', version: '1.0.0' },
          { capabilities: { elicitation: {} } },
        );
        client.setRequestHandler('elicitation/create', async () => {
          return {
            action: 'accept',
            content: { confirm: true },
          };
        });
        await Promise.all([
          client.connect(clientTransport),
          serverCtx.mcp.connect(serverTransport),
        ]);

        try {
          assert.strictEqual(notified, false);
          const result = await client.callTool({
            name: 'read',
            arguments: { path: outsideFile },
          });
          assert.notStrictEqual(result.isError, true);
          assert.strictEqual(
            notified,
            false,
            'a grant must not announce a resource list that cannot have changed',
          );
        } finally {
          await client.close();
          await serverCtx.mcp.close();
        }
      });
    } finally {
      await cleanupTestRoot(parentDir);
    }
  });

  it('TC-FUNC-073: text tools ship metadata under _meta, data tools under structuredContent', async () => {
    const file = join(tmpDir, 'meta_split.txt');
    await writeFile(file, 'one\ntwo\n');

    // read authors its own text (the file), so its metadata moves to _meta —
    // a client that keys on structuredContent would otherwise hide the bytes.
    const readRes = await harness.client.callTool({ name: 'read', arguments: { path: file } });
    assert.notStrictEqual(readRes.isError, true);
    assert.strictEqual(readRes.structuredContent, undefined);
    const readMeta = readRes._meta as { summary?: { succeeded?: number } };
    assert.strictEqual(readMeta.summary?.succeeded, 1);

    // stat authors no text, so the JSON *is* its model-facing view and stays
    // where a programmatic client already looks for it.
    const statRes = await harness.client.callTool({ name: 'stat', arguments: { path: file } });
    assert.notStrictEqual(statRes.isError, true);
    assert.strictEqual(statRes._meta, undefined);
    const statStructured = statRes.structuredContent as { summary?: { succeeded?: number } };
    assert.strictEqual(statStructured.summary?.succeeded, 1);
  });

  it('TC-FUNC-074: read trailer carries continuation and hash', async () => {
    const file = join(tmpDir, 'trailer.txt');
    const body = Array.from({ length: 30 }, (_v, i) => `line${String(i + 1)}`).join('\n');
    await writeFile(file, `${body}\n`);

    const head = await harness.client.callTool({
      name: 'read',
      arguments: { path: file, head: 10, includeHash: true },
    });
    const headText = firstTextBlock(head).text ?? '';
    assert.match(headText, /^\/\/ truncated: .*"startLine":11,"endLine":20\}$/m);
    assert.match(headText, /^\/\/ sha256: [0-9a-f]{64}$/m);
    // The file's own lines survive ahead of the trailer, unaltered.
    assert.ok(headText.startsWith('line1\nline2\n'), headText.slice(0, 40));
    assert.ok(headText.indexOf('line10') < headText.indexOf('// truncated'));

    // A whole-file read is not truncated and was not asked for a hash.
    const full = await harness.client.callTool({ name: 'read', arguments: { path: file } });
    const fullText = firstTextBlock(full).text ?? '';
    assert.ok(!fullText.includes('// truncated'), 'a full read is not truncated');
    assert.ok(!fullText.includes('// sha256'), 'no hash unless includeHash');

    // tail has no args that read backwards, so it reports what it showed.
    const tail = await harness.client.callTool({
      name: 'read',
      arguments: { path: file, tail: 10 },
    });
    const tailText = firstTextBlock(tail).text ?? '';
    assert.match(tailText, /^\/\/ truncated: showing last 10 lines$/m);
    assert.ok(!tailText.includes('Continue:'), 'tail offers no continuation args');
  });

  it('TC-FUNC-060: diff two files returns a unified diff', async () => {
    const a = join(tmpDir, 'diff_a.txt');
    const b = join(tmpDir, 'diff_b.txt');
    await writeFile(a, 'x\ny\nz\n');
    await writeFile(b, 'x\nY\nz\n');
    const result = await harness.client.callTool({
      name: 'diff',
      arguments: { a, b },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result._meta as {
      linesAdded?: number;
      linesRemoved?: number;
    };
    assert.strictEqual(structured.linesAdded, 1);
    assert.strictEqual(structured.linesRemoved, 1);
    // The diff itself rides the text content block, not _meta.
    const diffText = (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    assert.ok(diffText.includes('-y') && diffText.includes('+Y'));
  });

  it('diff reports "too large" instead of freezing on files that share no lines', async () => {
    const many = (p: string): string =>
      Array.from({ length: 8000 }, (_, i) => `${p}${String(i)}`).join('\n') + '\n';
    const a = await writeTestFile(tmpDir, 'diff_huge/a.txt', many('a'));
    const b = await writeTestFile(tmpDir, 'diff_huge/b.txt', many('b'));
    const started = Date.now();
    const result = await harness.client.callTool({ name: 'diff', arguments: { a, b } });
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /Diff not computed/);
    assert.ok(Date.now() - started < 5000, 'the call must return within the tool timeout');
  });

  it('TC-FUNC-061: patch applies a unified diff', async () => {
    const f = join(tmpDir, 'patch_target.txt');
    await writeFile(f, 'a\nb\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
    const result = await harness.client.callTool({
      name: 'patch',
      arguments: { path: f, diff },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(f, 'utf-8'), 'X\nb\nc\n');
  });

  it('TC-FUNC-062: patch that does not apply returns isError', async () => {
    const f = join(tmpDir, 'patch_bad.txt');
    await writeFile(f, 'q\nb\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
    const result = await harness.client.callTool({ name: 'patch', arguments: { path: f, diff } });
    assert.strictEqual(result.isError, true);
  });

  it('patch dryRun advertises no resourceUri or resource_link for the unwritten file', async () => {
    const f = join(tmpDir, 'patch_dry.txt');
    await writeFile(f, 'a\nb\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
    const dry = await harness.client.callTool({
      name: 'patch',
      arguments: { path: f, diff, dryRun: true },
    });
    assert.notStrictEqual(dry.isError, true);
    assert.strictEqual((dry._meta as { resourceUri?: string }).resourceUri, undefined);
    assert.ok(
      !(dry.content as { type: string }[]).some((block) => block.type === 'resource_link'),
      'a dry run links nothing',
    );
    assert.strictEqual(await readFile(f, 'utf-8'), 'a\nb\nc\n');

    const real = await harness.client.callTool({ name: 'patch', arguments: { path: f, diff } });
    assert.ok((real._meta as { resourceUri?: string }).resourceUri, 'a real write still links');
  });

  it('patch rejects out-of-order hunks instead of duplicating text', async () => {
    const f = join(tmpDir, 'patch_order.txt');
    const original = 'abcdefghijklmnopqrst'.split('').join('\n') + '\n';
    await writeFile(f, original);
    const swapped = '--- f.txt\n+++ f.txt\n@@ -5,1 +5,1 @@\n-e\n+E\n@@ -1,1 +1,1 @@\n-a\n+A\n';
    for (const dryRun of [true, false]) {
      const result = await harness.client.callTool({
        name: 'patch',
        arguments: { path: f, diff: swapped, dryRun },
      });
      assert.strictEqual(result.isError, true, `dryRun=${String(dryRun)}`);
      assert.match(firstTextBlock(result).text ?? '', /INVALID_INPUT.*file order/);
    }
    assert.strictEqual(await readFile(f, 'utf-8'), original);

    // Same hunks in order, both headers off by +2: offset tolerance still applies.
    const offset = '--- f.txt\n+++ f.txt\n@@ -3,1 +3,1 @@\n-a\n+A\n@@ -7,1 +7,1 @@\n-e\n+E\n';
    const ok = await harness.client.callTool({
      name: 'patch',
      arguments: { path: f, diff: offset },
    });
    assert.notStrictEqual(ok.isError, true);
    assert.strictEqual(await readFile(f, 'utf-8'), original.replace('a', 'A').replace('e', 'E'));

    // Hand-written headers can be wrong by different amounts, even descending,
    // while the hunks themselves are in order; jsdiff places those correctly.
    await writeFile(f, original);
    const misnumbered = '--- f.txt\n+++ f.txt\n@@ -9,1 +9,1 @@\n-a\n+A\n@@ -3,1 +3,1 @@\n-e\n+E\n';
    const guessed = await harness.client.callTool({
      name: 'patch',
      arguments: { path: f, diff: misnumbered },
    });
    assert.notStrictEqual(guessed.isError, true, firstTextBlock(guessed).text);
    assert.strictEqual(await readFile(f, 'utf-8'), original.replace('a', 'A').replace('e', 'E'));

    // A later hunk whose header points back to text that also appears earlier
    // must land after the previous hunk, not on that earlier copy.
    const repeated = join(tmpDir, 'patch_repeat.txt');
    await writeFile(repeated, 'x\n1\n2\n3\nx\n5\n');
    const back = '--- f\n+++ f\n@@ -2,1 +2,1 @@\n-1\n+ONE\n@@ -1,1 +1,1 @@\n-x\n+X\n';
    const landed = await harness.client.callTool({
      name: 'patch',
      arguments: { path: repeated, diff: back },
    });
    assert.notStrictEqual(landed.isError, true, firstTextBlock(landed).text);
    assert.strictEqual(await readFile(repeated, 'utf-8'), 'x\nONE\n2\n3\nX\n5\n');
  });

  it('TC-FUNC-063: list paginates entries via nextCursor', async () => {
    const sub = join(tmpDir, 'page_dir');
    await mkdir(sub, { recursive: true });
    for (let i = 0; i < 4; i++) await writeFile(join(sub, `f${i}.txt`), 'x');
    const r1 = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2 },
    });
    const s1 = r1._meta as {
      nextCursor?: string;
      entryCount?: number;
      resourceUri?: string;
    };
    assert.strictEqual(s1.entryCount, 2);
    assert.ok(s1.nextCursor, 'first page should yield a nextCursor');
    assert.ok(s1.resourceUri, 'an incomplete first page carries the URI of the full entry list');
    const r2 = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2, cursor: s1.nextCursor },
    });
    const s2 = r2._meta as { nextCursor?: string; entryCount?: number; resourceUri?: string };
    assert.strictEqual(s2.entryCount, 2);
    assert.ok(!s2.nextCursor, 'second page is the last');
    assert.strictEqual(s2.resourceUri, undefined, 'later pages never carry the URI');
  });

  it('TC-FUNC-063c: a later list page draws its entries under their ancestors', async () => {
    const sub = join(tmpDir, 'tree_page_dir');
    for (const dir of ['a', 'b']) {
      await mkdir(join(sub, dir), { recursive: true });
      for (let i = 0; i < 3; i++) await writeFile(join(sub, dir, `${dir}${String(i)}.txt`), 'x');
    }
    const first = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxDepth: 2, maxEntries: 4 },
    });
    // `b/` holds nothing on this page; the slash still says it is a directory.
    assert.match(
      firstTextBlock(first).text ?? '',
      /^tree_page_dir\n├── a\/\n│ {3}├── a0\.txt\n│ {3}└── a1\.txt\n└── b\/\n\n\/\/ showing 1-4 of 8/,
    );
    const second = await harness.client.callTool({
      name: 'list',
      arguments: {
        path: sub,
        maxDepth: 2,
        maxEntries: 4,
        cursor: (first._meta as { nextCursor?: string }).nextCursor,
      },
    });
    // `a/` and `b/` sat on page one; without them as context this page's
    // entries have no path back to the root and the tree renders empty.
    assert.match(
      firstTextBlock(second).text ?? '',
      /^tree_page_dir\n├── a\/\n│ {3}└── a2\.txt\n└── b\/\n {4}├── b0\.txt\n {4}├── b1\.txt\n {4}└── b2\.txt\n\n\/\/ showing 5-8 of 8/,
    );
  });

  it('TC-FUNC-075b: list prunes an ignored directory and everything under it', async () => {
    const sub = join(tmpDir, 'gitignore_walk_dir');
    // Nested one level on purpose: fs.glob's function `exclude` drops a
    // rejected entry at the top level but not below it, so a top-level fixture
    // passes even when the walk leaks the ignored directory itself.
    await mkdir(join(sub, 'a', 'skipme', 'deep'), { recursive: true });
    await writeFile(join(sub, '.gitignore'), 'skipme/\n');
    await writeFile(join(sub, 'kept.txt'), 'k');
    await writeFile(join(sub, 'a', 'skipme', 'deep', 'buried.txt'), 'b');

    // maxDepth must reach the nested file: the tool's default is 1, top-level only.
    const pruned = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxDepth: 4 },
    });
    const prunedText = firstTextBlock(pruned).text ?? '';
    assert.match(prunedText, /kept\.txt/);
    // The directory AND its children stay out: the walk prunes, it does not
    // enumerate then filter, so `buried.txt` is never visited.
    assert.doesNotMatch(prunedText, /skipme/);
    assert.doesNotMatch(prunedText, /buried\.txt/);

    const all = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxDepth: 4, includeIgnored: true },
    });
    const allText = firstTextBlock(all).text ?? '';
    assert.match(allText, /kept\.txt/);
    assert.match(allText, /buried\.txt/);
  });

  it('TC-FUNC-075c: find_files drops a gitignored file below the top level', async () => {
    const sub = join(tmpDir, 'gitignore_file_dir');
    await mkdir(join(sub, 'nested'), { recursive: true });
    await writeFile(join(sub, '.gitignore'), '*.log\n');
    await writeFile(join(sub, 'nested', 'keep.txt'), 'k');
    await writeFile(join(sub, 'nested', 'drop.log'), 'd');

    const result = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: sub, pattern: '**/*' },
    });
    const text = firstTextBlock(result).text ?? '';
    assert.match(text, /keep\.txt/);
    // A nested match the exclude predicate rejects must not survive the walk.
    assert.doesNotMatch(text, /drop\.log/);
  });

  it("find_files, search_text, list and replace_text honor the allowed root's .gitignore below it", async () => {
    // tmpDir is the allowed root; the walk is scoped to a subdirectory.
    await writeFile(join(tmpDir, '.gitignore'), 'scoped_ignored/*.log\n');
    const sub = join(tmpDir, 'scoped_ignored');
    await writeTestFile(tmpDir, 'scoped_ignored/keep.txt', 'NEEDLE_G\n');
    const dropped = await writeTestFile(tmpDir, 'scoped_ignored/drop.log', 'NEEDLE_G\n');

    const found = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: sub, pattern: '**/*' },
    });
    const paths =
      (found._meta as { results?: { path: string }[] }).results?.map((r) => r.path) ?? [];
    assert.deepStrictEqual(paths, ['keep.txt']);

    const searched = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: sub, searchPattern: 'NEEDLE_G' },
    });
    const files =
      (searched._meta as { matches?: { file: string }[] }).matches?.map((m) => m.file) ?? [];
    assert.deepStrictEqual(files, ['keep.txt']);

    const listed = await harness.client.callTool({ name: 'list', arguments: { path: sub } });
    const names =
      (listed._meta as { entries?: { name: string }[] }).entries?.map((e) => e.name) ?? [];
    assert.deepStrictEqual(names, ['keep.txt']);

    const replaced = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: sub, searchPattern: 'NEEDLE_G', replacement: 'X' },
    });
    assert.notStrictEqual(replaced.isError, true);
    assert.strictEqual(await readFile(dropped, 'utf-8'), 'NEEDLE_G\n', 'ignored file untouched');

    // includeIgnored lifts it, as before.
    const all = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: sub, pattern: '**/*', includeIgnored: true },
    });
    const allPaths =
      (all._meta as { results?: { path: string }[] }).results?.map((r) => r.path) ?? [];
    assert.deepStrictEqual(allPaths.sort(), ['drop.log', 'keep.txt']);
  });

  it('TC-FUNC-075: list text carries nextCursor', async () => {
    const sub = join(tmpDir, 'cursor_text_dir');
    await mkdir(sub, { recursive: true });
    for (let i = 0; i < 4; i++) await writeFile(join(sub, `g${String(i)}.txt`), 'x');

    const first = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2 },
    });
    const firstText = firstTextBlock(first).text ?? '';
    const match =
      /^\/\/ showing 1-2 of 4 entries\. Next page: list (\{.*"cursor":"([^"]+)".*\})$/m.exec(
        firstText,
      );
    assert.ok(match, `first page text should carry its position and cursor: ${firstText}`);
    const cursor = match[2];
    // The model passes back verbatim what it read, so the two must agree.
    assert.strictEqual(cursor, (first._meta as { nextCursor?: string }).nextCursor);

    // The printed call must be sendable as-is.
    const printed = JSON.parse(match[1] ?? '{}') as Record<string, unknown>;
    const literal = await harness.client.callTool({ name: 'list', arguments: printed });
    assert.notStrictEqual(literal.isError, true, 'the trailer must print a callable request');

    const second = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2, cursor },
    });
    const secondText = firstTextBlock(second).text ?? '';
    // The last page carries no cursor and still owes its position, or a
    // two-row tail reads as the whole answer.
    assert.match(secondText, /^\/\/ showing 3-4 of 4 entries\.$/m);
    assert.doesNotMatch(secondText, /Next page/);
  });

  it('TC-FUNC-063b: list pages are stable and query-bound', async () => {
    const sub = join(tmpDir, 'stable_page_dir');
    await mkdir(sub, { recursive: true });
    for (const name of ['bravo.txt', 'charlie.txt']) {
      await writeFile(join(sub, name), 'x');
    }
    const first = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 1 },
    });
    const firstStructured = first._meta as {
      entries?: { name: string }[];
      nextCursor?: string;
    };
    const cursor = firstStructured.nextCursor;
    assert.ok(cursor);

    await rm(sub, { recursive: true, force: true });
    const second = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 10, cursor },
    });
    assert.notStrictEqual(second.isError, true);
    const secondStructured = second._meta as { entries?: { name: string }[] };
    assert.deepStrictEqual(
      [...(firstStructured.entries ?? []), ...(secondStructured.entries ?? [])].map(
        (entry) => entry.name,
      ),
      ['bravo.txt', 'charlie.txt'],
      'page two must read the first-page snapshot after the directory is removed',
    );

    const replay = await harness.client.callTool({
      name: 'list',
      arguments: { path: tmpDir, maxEntries: 10, cursor },
    });
    assert.strictEqual(replay.isError, true);
    assert.match(firstTextBlock(replay).text ?? '', /INVALID_INPUT/);
  });

  it('TC-FUNC-063a: list does not return a successful partial result after abort', async (t) => {
    t.mock.method(AbortSignal, 'timeout', () =>
      AbortSignal.abort(new DOMException('test timeout', 'TimeoutError')),
    );
    const result = await harness.client.callTool({
      name: 'list',
      arguments: { path: tmpDir, includeIgnored: true },
    });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent, undefined);
  });

  it('TC-LOG-001: Tool execution logs to stderr', async (t) => {
    const file = join(tmpDir, 'log-test.txt');
    await writeFile(file, 'initial line\n');
    const lines: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: { path: file, edits: [{ oldText: 'initial', newText: 'updated' }] },
    });
    assert.notStrictEqual(result.isError, true);
    assert.ok(
      lines.some((l) => /^\[\w+\] \[req [^\]]+\] \[edit\] edit:/.test(l)),
      'stderr should carry the edit log line tagged with its request id',
    );
  });

  it('TC-FUNC-064: copy skip via choice round-trip leaves dst untouched', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'skip' },
    }));
    try {
      const src = join(tmpDir, 'choice_skip_src.txt');
      const dst = join(tmpDir, 'choice_skip_dst.txt');
      await writeFile(src, 'new source');
      await writeFile(dst, 'existing dst');
      const result = await eh.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dst }], copy: true },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result._meta as { moves?: unknown[]; skipped?: string[] };
      assert.strictEqual(s.moves?.length, 0);
      assert.ok(s.skipped?.includes(dst));
      assert.strictEqual(await readFile(dst, 'utf-8'), 'existing dst');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-065: copy overwrite via choice round-trip replaces dst', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'overwrite' },
    }));
    try {
      const src = join(tmpDir, 'choice_ow_src.txt');
      const dst = join(tmpDir, 'choice_ow_dst.txt');
      await writeFile(src, 'new source');
      await writeFile(dst, 'existing dst');
      const result = await eh.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dst }], copy: true },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result._meta as { moves?: unknown[]; skipped?: string[] };
      assert.strictEqual(s.moves?.length, 1);
      assert.strictEqual(s.skipped, undefined);
      assert.strictEqual(await readFile(dst, 'utf-8'), 'new source');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-066: move skip via choice round-trip leaves src and dst intact', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'skip' },
    }));
    try {
      const src = join(tmpDir, 'move_skip_src.txt');
      const dst = join(tmpDir, 'move_skip_dst.txt');
      await writeFile(src, 'move me');
      await writeFile(dst, 'dst stays');
      const result = await eh.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dst }] },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result._meta as { moves?: unknown[]; skipped?: string[] };
      assert.strictEqual(s.moves?.length, 0);
      assert.ok(s.skipped?.includes(dst));
      assert.strictEqual(await readFile(src, 'utf-8'), 'move me');
      assert.strictEqual(await readFile(dst, 'utf-8'), 'dst stays');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-067: move overwrite via choice round-trip replaces dst', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'overwrite' },
    }));
    try {
      const src = join(tmpDir, 'move_ow_src.txt');
      const dst = join(tmpDir, 'move_ow_dst.txt');
      await writeFile(src, 'move me');
      await writeFile(dst, 'dst old');
      const result = await eh.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dst }] },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result._meta as { moves?: unknown[]; skipped?: string[] };
      assert.strictEqual(s.moves?.length, 1);
      assert.strictEqual(s.skipped, undefined);
      assert.strictEqual(await readFile(dst, 'utf-8'), 'move me');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-068: delete skip via choice round-trip leaves dir in place', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'skip' },
    }));
    try {
      const dir = join(tmpDir, 'del_skip_dir');
      await mkdir(join(dir, 'sub'), { recursive: true });
      await writeFile(join(dir, 'sub', 'f.txt'), 'x');
      const result = await eh.client.callTool({
        name: 'delete',
        arguments: { paths: [dir], recursive: true },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result._meta as {
        results?: { path?: string; value?: { deleted?: boolean }; error?: unknown }[];
        summary?: { failed?: number };
      };
      assert.strictEqual(s.summary?.failed, 0);
      // Skip is a successful outcome with `deleted: false`, not a failure.
      assert.ok(
        s.results?.some(
          (r) => r.path?.toLowerCase() === dir.toLowerCase() && r.value?.deleted === false,
        ),
      );
      await access(dir); // still exists
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-069: delete via choice round-trip removes the dir', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'delete' },
    }));
    try {
      const dir = join(tmpDir, 'del_choice_dir');
      await mkdir(join(dir, 'sub'), { recursive: true });
      await writeFile(join(dir, 'sub', 'f.txt'), 'x');
      const result = await eh.client.callTool({
        name: 'delete',
        arguments: { paths: [dir], recursive: true },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result._meta as {
        results?: { path?: string; value?: { deleted?: boolean } }[];
        summary?: { failed?: number };
      };
      assert.strictEqual(s.summary?.failed, 0);
      assert.strictEqual(s.results?.[0]?.path?.toLowerCase(), dir.toLowerCase());
      assert.strictEqual(s.results?.[0]?.value?.deleted, true);
      await assert.rejects(() => access(dir));
    } finally {
      await eh.close();
    }
  });

  // Without this guard the SDK rejects the whole call with `-32021`
  // MissingRequiredClientCapability — a protocol error the model never sees, on
  // a tool whose description promised only that recursive=true was needed.
  it('TC-FUNC-069b: a client without elicitation gets a tool error, not a protocol error', async () => {
    const eh = await createElicitationClientPair(
      [tmpDir],
      async () => {
        throw new Error('the server must not ask a client that cannot answer');
      },
      { noElicitation: true },
    );
    try {
      const dir = join(tmpDir, 'del_no_elicit_dir');
      await mkdir(join(dir, 'sub'), { recursive: true });
      await writeFile(join(dir, 'sub', 'f.txt'), 'x');

      const result = await eh.client.callTool({
        name: 'delete',
        arguments: { paths: [dir], recursive: true },
      });

      assert.strictEqual(result.isError, true, 'must surface as a tool error');
      const text = (result.content as { type: string; text?: string }[])
        .map((block) => block.text ?? '')
        .join('\n');
      assert.match(text, /confirmation this client cannot show/i);
      assert.match(text, /individually|elicitation capability/i);
      // R7/R14: the refusal must not have deleted anything on the way out.
      await access(join(dir, 'sub', 'f.txt'));
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-070: multi-select grant accepts a subset of dirs (#14)', async () => {
    const parentDir = await createTestRoot();
    const rootDir = join(parentDir, 'root');
    const outsideA = join(parentDir, 'outsideA');
    const outsideB = join(parentDir, 'outsideB');
    await mkdir(rootDir, { recursive: true });
    await mkdir(outsideA, { recursive: true });
    await mkdir(outsideB, { recursive: true });
    const srcA = join(outsideA, 'a.txt');
    const srcB = join(outsideB, 'b.txt');
    await writeFile(srcA, 'A content');
    await writeFile(srcB, 'B content');

    try {
      await withBoundary(parentDir, async () => {
        // Two out-of-root source dirs => one multi-select grant round. Accept
        // only the FIRST offered dir (a subset of one); the other stays denied.
        const eh = await createElicitationClientPair([rootDir], async (req: unknown) => {
          const env = req as { params?: { requestedSchema?: unknown } };
          const schema = env.params?.requestedSchema as
            { properties?: { choice?: { items?: { enum?: string[] } } } } | undefined;
          const offered = schema?.properties?.choice?.items?.enum ?? [];
          const first = offered[0];
          return {
            action: 'accept' as const,
            content: { choice: first ? [first] : [] },
          };
        });
        try {
          const result = await eh.client.callTool({
            name: 'move',
            arguments: {
              moves: [
                { source: srcA, destination: join(rootDir, 'a_copy.txt') },
                { source: srcB, destination: join(rootDir, 'b_copy.txt') },
              ],
              copy: true,
            },
          });
          assert.notStrictEqual(result.isError, true);
          const s = result._meta as {
            moves?: { from?: string; to?: string }[];
            failures?: { source?: string; error?: { code?: string } }[];
          };
          // The accepted dir's copy succeeded; the declined dir's failed closed.
          assert.strictEqual(s.moves?.length, 1, 'exactly one copy (the accepted dir) succeeds');
          assert.strictEqual(s.failures?.length, 1, 'exactly one failure (the declined dir)');
          assert.strictEqual(s.failures?.[0]?.error?.code, 'ACCESS_DENIED');
        } finally {
          await eh.close();
        }
      });
    } finally {
      await cleanupTestRoot(parentDir);
    }
  });

  it('TC-FUNC-071: multi-select grant ignores a non-offered dir (consent scope)', async () => {
    const parentDir = await createTestRoot();
    const rootDir = join(parentDir, 'root');
    const outsideA = join(parentDir, 'outsideA');
    const outsideB = join(parentDir, 'outsideB');
    const secretDir = join(parentDir, 'secret'); // within boundary, never offered
    await mkdir(rootDir, { recursive: true });
    await mkdir(outsideA, { recursive: true });
    await mkdir(outsideB, { recursive: true });
    await mkdir(secretDir, { recursive: true });
    const srcA = join(outsideA, 'a.txt');
    const srcB = join(outsideB, 'b.txt');
    await writeFile(srcA, 'A content');
    await writeFile(srcB, 'B content');
    await writeFile(join(secretDir, 'secret.txt'), 'secret');

    try {
      await withBoundary(parentDir, async () => {
        // Malicious client: accept the offered outsideA AND a non-offered
        // secretDir. Only outsideA/outsideB were in precheckAccess's grantDirs
        // (two dirs => multi-select branch); secretDir must be filtered out and
        // stay ungranted.
        const eh = await createElicitationClientPair([rootDir], async () => ({
          action: 'accept' as const,
          content: { choice: [outsideA, secretDir] },
        }));
        try {
          const result = await eh.client.callTool({
            name: 'move',
            arguments: {
              moves: [
                { source: srcA, destination: join(rootDir, 'a_copy.txt') },
                { source: srcB, destination: join(rootDir, 'b_copy.txt') },
              ],
              copy: true,
            },
          });
          assert.notStrictEqual(result.isError, true);
          const s = result._meta as { moves?: unknown[] };
          assert.strictEqual(s.moves?.length, 1, 'offered accepted dir is granted');

          // secretDir was never offered -> not granted -> read fails ACCESS_DENIED.
          const readRes = await eh.client.callTool({
            name: 'read',
            arguments: { path: join(secretDir, 'secret.txt') },
          });
          const rs = readRes._meta as {
            results?: { error?: { code?: string } }[];
            summary?: { failed?: number };
          };
          assert.strictEqual(rs.summary?.failed, 1);
          assert.strictEqual(rs.results?.[0]?.error?.code, 'ACCESS_DENIED');
        } finally {
          await eh.close();
        }
      });
    } finally {
      await cleanupTestRoot(parentDir);
    }
  });

  it('TC-FUNC-013r: replace_text replaces all occurrences across globbed files', async () => {
    const file = await writeTestFile(tmpDir, 'sub/rep.txt', 'foo bar foo\n');
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: tmpDir, pattern: '**/*.txt', searchPattern: 'foo', replacement: 'QUX' },
    });
    assert.notStrictEqual(result.isError, true);
    const content = await readFile(file, 'utf-8');
    assert.strictEqual(content, 'QUX bar QUX\n');
  });

  it('replace_text expands $ tokens exactly like String.prototype.replace', async () => {
    const twelve = '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)';
    const cases: { input: string; pattern: string; replacement: string }[] = [
      { input: 'xaby', pattern: '(a)(b)', replacement: '[$1|$2]' },
      { input: 'xaby', pattern: '(a)(b)', replacement: '<$&>' },
      { input: 'xaby', pattern: '(a)(b)', replacement: '{$`}' },
      { input: 'xaby', pattern: '(a)(b)', replacement: "{$'}" },
      { input: 'xaby', pattern: '(a)(b)', replacement: '$$1' },
      { input: 'xaby', pattern: '(a)', replacement: '$12' },
      { input: 'xaby', pattern: '(a)', replacement: '$0' },
      { input: 'xaby', pattern: '(a)', replacement: '$100' },
      { input: 'xaby', pattern: '(a)', replacement: 'end$' },
      { input: 'xaby', pattern: '(a)', replacement: '$3' },
      { input: 'abcdefghijkl', pattern: twelve, replacement: '$12' },
      { input: '\u{1F600}ab', pattern: '(a)', replacement: '$`' },
    ];
    for (const [i, c] of cases.entries()) {
      const file = await writeTestFile(tmpDir, `dollar/case${String(i)}.txt`, c.input);
      const result = await harness.client.callTool({
        name: 'replace_text',
        arguments: {
          path: file,
          searchPattern: c.pattern,
          replacement: c.replacement,
          isRegex: true,
        },
      });
      assert.notStrictEqual(result.isError, true, `case ${String(i)} errored`);
      const expected = c.input.replace(new RegExp(c.pattern, 'g'), c.replacement);
      assert.strictEqual(
        await readFile(file, 'utf-8'),
        expected,
        `case ${String(i)}: ${c.replacement}`,
      );
    }

    // A literal search reaches the regex matcher when it is case-insensitive,
    // and there the replacement must stay verbatim.
    const literal = await writeTestFile(tmpDir, 'dollar/literal.txt', 'Alpha alpha');
    await harness.client.callTool({
      name: 'replace_text',
      arguments: {
        path: literal,
        searchPattern: 'ALPHA',
        replacement: '$1',
        caseSensitive: false,
      },
    });
    assert.strictEqual(await readFile(literal, 'utf-8'), '$1 $1');
  });

  it('replace_text regex mode on a file past the RE2 input cap fails that file with TOO_LARGE', async () => {
    const size = RE2_MAX_INPUT_BYTES + 1;
    const big = await writeTestFile(tmpDir, 'regex_cap/big.txt', 'x'.repeat(size - 5) + 'FIND\n');
    const asRegex = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: big, searchPattern: 'FIND', replacement: 'FOUND', isRegex: true },
    });
    assert.strictEqual(asRegex.isError, true);
    const failure = failedSummary(asRegex)?.results?.[0]?.error;
    assert.strictEqual(failure?.code, 'TOO_LARGE');
    assert.match(failure?.message ?? '', /regex/i);
    assert.ok((await readFile(big, 'utf-8')).endsWith('FIND\n'), 'file must be untouched');

    const literal = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: big, searchPattern: 'FIND', replacement: 'FOUND', caseSensitive: true },
    });
    assert.notStrictEqual(literal.isError, true, 'the literal matcher has no input cap');
    assert.ok((await readFile(big, 'utf-8')).endsWith('FOUND\n'));
  });

  // Decoding these as UTF-8 and writing the result back swaps every invalid
  // byte for U+FFFD, corrupting the file even though the match itself is ASCII.
  it('replace_text leaves binary and non-UTF-8 files untouched', async () => {
    const dir = join(tmpDir, 'binrep');
    const text = await writeTestFile(dir, 'text.txt', 'foo\n');
    // Valid UTF-8 with a NUL, so each file trips one half of the guard.
    const blob = Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x01]);
    const latin1 = Buffer.from('café foo\n', 'latin1');
    await writeFile(join(dir, 'blob.bin'), blob);
    await writeFile(join(dir, 'latin1.txt'), latin1);

    const swept = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: 'foo', replacement: 'bar' },
    });
    assert.notStrictEqual(swept.isError, true);
    const s = swept._meta as { summary: { failed: number }; skippedBinary?: number };
    assert.strictEqual(s.summary.failed, 0);
    assert.strictEqual(s.skippedBinary, 2);
    assert.match(firstTextBlock(swept).text ?? '', /2 binary skipped/);
    assert.strictEqual(await readFile(text, 'utf-8'), 'bar\n');
    assert.deepStrictEqual(await readFile(join(dir, 'blob.bin')), blob);
    assert.deepStrictEqual(await readFile(join(dir, 'latin1.txt')), latin1);

    // Named explicitly, the file is the whole request: refuse it, don't skip.
    const single = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: join(dir, 'blob.bin'), searchPattern: 'foo', replacement: 'bar' },
    });
    assert.strictEqual(single.isError, true);
    const r = single._meta as { results: { error?: { code: string } }[] };
    assert.strictEqual(r.results[0]?.error?.code, 'INVALID_INPUT');
    assert.match(firstTextBlock(single).text ?? '', /blob.bin: INVALID_INPUT Binary/);
    assert.deepStrictEqual(await readFile(join(dir, 'blob.bin')), blob);
  });

  it('edit, patch and diff refuse a non-UTF-8 file and leave its bytes intact', async () => {
    const dir = join(tmpDir, 'nonutf8');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'late.txt');
    // First 512 bytes are plain ASCII; the bad byte (0xe9) lands past the binary probe.
    const bytes = Buffer.concat([
      Buffer.from('a'.repeat(600) + '\nhello\n'),
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    ]);
    await writeFile(path, bytes);

    const edited = await harness.client.callTool({
      name: 'edit',
      arguments: { path, edits: [{ oldText: 'hello', newText: 'bye' }] },
    });
    assert.strictEqual(edited.isError, true);
    assert.strictEqual(failedSummary(edited)?.results?.[0]?.error?.code, 'INVALID_INPUT');
    assert.deepStrictEqual(await readFile(path), bytes);

    // Line 1 is the 600 `a`s, line 2 is `hello`; this hunk would apply cleanly to
    // a UTF-8 file, so a refusal here can only come from the new strict-UTF-8 check.
    const patched = await harness.client.callTool({
      name: 'patch',
      arguments: { path, diff: '--- f\n+++ f\n@@ -2,1 +2,1 @@\n-hello\n+bye\n' },
    });
    assert.strictEqual(patched.isError, true);
    assert.deepStrictEqual(await readFile(path), bytes);

    const diffed = await harness.client.callTool({
      name: 'diff',
      arguments: { a: path, b: path },
    });
    assert.strictEqual(diffed.isError, true);
  });

  // Both tools author their own text, so the structured half ships under
  // `_meta`, which a client like Claude Code never shows the model. The dry-run
  // diff, the unmatched oldText, and replace_text's stop reason lived only there.
  it('edit and replace_text put the preview diff and stop reason in the text', async () => {
    const file = await writeTestFile(tmpDir, 'preview/0.txt', 'alpha\nbeta\n');
    const edit = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        dryRun: true,
        edits: [
          { oldText: 'alpha', newText: 'ALPHA' },
          { oldText: 'gamma', newText: 'x' },
        ],
      },
    });
    const editText = firstTextBlock(edit).text ?? '';
    assert.ok(editText.includes('NO MATCH "gamma"'), editText);
    assert.match(editText, /^\+ALPHA$/mu);
    // Dry-run metadata describes the would-be file, and advertises no URI for
    // content that was never written.
    const editValue = (
      edit._meta as { results: { value?: { size?: number; resourceUri?: string } }[] }
    ).results[0]?.value;
    assert.strictEqual(editValue?.size, 'ALPHA\nbeta\n'.length);
    assert.strictEqual(editValue?.resourceUri, undefined);
    // A real edit fails the file instead, and must still say which oldText missed.
    const applied = await harness.client.callTool({
      name: 'edit',
      arguments: { path: file, edits: [{ oldText: 'gamma', newText: 'x' }] },
    });
    assert.match(firstTextBlock(applied).text ?? '', /no match for oldText "gamma"/);

    // More files than replace_text dispatches at once, so a finished file
    // trips maxResults=1 before the sweep ends.
    for (let i = 1; i < 10; i++) await writeTestFile(tmpDir, `preview/${String(i)}.txt`, 'alpha\n');
    const replace = await harness.client.callTool({
      name: 'replace_text',
      arguments: {
        path: join(tmpDir, 'preview'),
        searchPattern: 'alpha',
        replacement: 'ALPHA',
        dryRun: true,
        maxResults: 1,
      },
    });
    const replaceText = firstTextBlock(replace).text ?? '';
    assert.match(replaceText, /^\+ALPHA$/mu);
    assert.ok(
      replaceText.includes('// scan stopped early: hit the maxResults limit;'),
      replaceText,
    );
  });

  // RE2 reports offsets in code points; JS strings index in UTF-16 code units,
  // so every astral character earlier in the file used to shift the splice by
  // one and cut into surrounding text.
  it('replace_text and edit splice correctly past astral characters', async () => {
    const prefix = '# T\n\n> 🟢 a 🔺 b 📅 c\n\n';
    const file = await writeTestFile(
      tmpDir,
      'emoji/rep.md',
      `${prefix}Line with ALPHA and more.\n`,
    );

    for (const args of [
      { caseSensitive: false, isRegex: false },
      { caseSensitive: true, isRegex: false },
      { caseSensitive: true, isRegex: true },
      { caseSensitive: false, isRegex: false, wholeWord: true },
    ]) {
      await writeFile(file, `${prefix}Line with ALPHA and more.\n`);
      const result = await harness.client.callTool({
        name: 'replace_text',
        arguments: { path: file, searchPattern: 'ALPHA', replacement: 'BETA', ...args },
      });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(
        await readFile(file, 'utf-8'),
        `${prefix}Line with BETA and more.\n`,
        `replace_text with ${JSON.stringify(args)}`,
      );
    }

    await writeFile(file, `${prefix}Line with ALPHA and more.\n`);
    const edited = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'with ALPHA and', newText: 'with BETA and' }],
        ignoreWhitespace: true,
      },
    });
    assert.notStrictEqual(edited.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), `${prefix}Line with BETA and more.\n`);

    // The reported column is a UTF-16 offset into the line, as `indexOf` gives.
    const searched = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: join(tmpDir, 'emoji'), searchPattern: 'BETA' },
    });
    const sc = searched._meta as { matches?: { column: number }[] };
    assert.strictEqual(sc.matches?.[0]?.column, 'Line with '.length);
  });

  it('TC-FUNC-014: find_files returns matched files via callTool', async () => {
    await writeTestFile(tmpDir, 'findme.txt', 'x');
    const result = await harness.client.callTool({
      name: 'find_files',
      arguments: { pattern: '**/*.txt' },
    });
    assert.notStrictEqual(result.isError, true);
    const sc = result._meta as { results?: { path: string }[] };
    assert.ok(sc.results?.some((r) => r.path.endsWith('findme.txt')));
  });

  it('find_files pages are stable and reject cursor pattern replay', async () => {
    const dir = join(tmpDir, 'find_pages');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bravo.txt'), 'x');
    await writeFile(join(dir, 'charlie.txt'), 'x');
    const first = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: dir, pattern: '*.txt', maxResults: 1 },
    });
    const firstStructured = first._meta as {
      results?: { path: string }[];
      nextCursor?: string;
      resourceUri?: string;
    };
    const cursor = firstStructured.nextCursor;
    assert.ok(cursor);
    // The overflow entry is minted by this call and runs on ResourceStore's own
    // clock, not the page snapshot's.
    assert.ok(firstStructured.resourceUri, 'page one carries the overflow URI');

    await rm(dir, { recursive: true, force: true });
    const second = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: dir, pattern: '*.txt', maxResults: 10, cursor },
    });
    assert.notStrictEqual(second.isError, true);
    const secondStructured = second._meta as {
      results?: { path: string }[];
      resourceUri?: string;
    };
    assert.deepStrictEqual(
      [...(firstStructured.results ?? []), ...(secondStructured.results ?? [])].map(
        (entry) => entry.path,
      ),
      ['bravo.txt', 'charlie.txt'],
    );
    assert.strictEqual(
      secondStructured.resourceUri,
      undefined,
      'later pages must not replay a URI that expires on a different clock',
    );

    const replay = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: dir, pattern: '*.md', maxResults: 10, cursor },
    });
    assert.strictEqual(replay.isError, true);
    assert.match(firstTextBlock(replay).text ?? '', /INVALID_INPUT/);
  });

  it('find_files and search_text match a slash-free glob at any depth, as replace_text does', async () => {
    const dir = join(tmpDir, 'basename_glob');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'top.ts'), 'NEEDLE\n');
    await writeFile(join(dir, 'sub', 'deep.ts'), 'NEEDLE\n');
    await writeFile(join(dir, 'sub', 'top.ts'), 'NEEDLE\n');

    const found = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: dir, pattern: '*.ts' },
    });
    assert.deepStrictEqual(
      (found._meta as { results?: { path: string }[] }).results?.map((r) => r.path),
      ['sub/deep.ts', 'sub/top.ts', 'top.ts'],
    );

    const searched = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, pattern: 'deep.ts', searchPattern: 'NEEDLE' },
    });
    assert.deepStrictEqual(
      (searched._meta as { matches?: { file: string }[] }).matches?.map((m) => m.file),
      ['sub/deep.ts'],
    );

    // Naming a file must still search that file alone, not its namesake below.
    const named = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: join(dir, 'top.ts'), searchPattern: 'NEEDLE' },
    });
    assert.deepStrictEqual(
      (named._meta as { matches?: { file: string }[] }).matches?.map((m) => m.file),
      ['top.ts'],
    );
  });

  it('TC-FUNC-015s: stat returns file metadata via callTool', async () => {
    const file = await writeTestFile(tmpDir, 'statme.txt', 'hello');
    for (const args of [{ path: file }, { paths: [file] }]) {
      const result = await harness.client.callTool({ name: 'stat', arguments: args });
      assert.notStrictEqual(result.isError, true);
      const sc = result.structuredContent as {
        results?: { value?: { type?: string; size?: number } }[];
      };
      const value = sc.results?.[0]?.value;
      assert.ok(value, 'stat must return a value');
      assert.strictEqual(value.type, 'file');
      assert.ok(typeof value.size === 'number' && value.size > 0);
    }
  });

  it('stat reports an own symlink and its target', async (t) => {
    const target = await writeTestFile(tmpDir, 'stat-link-target.txt', 'target');
    const linkPath = join(tmpDir, 'stat-link.txt');
    if (!(await trySymlink(target, linkPath, () => t.skip('symlink not permitted'), 'file')))
      return;

    const result = await harness.client.callTool({
      name: 'stat',
      arguments: { path: linkPath },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as {
      results?: { value?: { type?: string; symlinkTarget?: string } }[];
    };
    const value = structured.results?.[0]?.value;
    assert.ok(value, 'stat must return a value');
    assert.strictEqual(value.type, 'symlink');
    assert.strictEqual(value.symlinkTarget, target);
  });

  it('stat reports a regular file under a symlinked parent as a file', async (t) => {
    const targetDir = join(tmpDir, 'stat-real-parent');
    await mkdir(targetDir);
    await writeFile(join(targetDir, 'child.txt'), 'child');
    const linkDir = join(tmpDir, 'stat-linked-parent');
    if (!(await trySymlink(targetDir, linkDir, () => t.skip('symlink not permitted')))) return;

    const result = await harness.client.callTool({
      name: 'stat',
      arguments: { path: join(linkDir, 'child.txt') },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as {
      results?: { value?: { type?: string; symlinkTarget?: string } }[];
    };
    const value = structured.results?.[0]?.value;
    assert.ok(value, 'stat must return a value');
    assert.strictEqual(value.type, 'file');
    assert.strictEqual(value.symlinkTarget, undefined);
  });

  it('TC-FUNC-072: search_text finds a literal match via callTool', async () => {
    const dir = join(tmpDir, 'grep_dir');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'target.txt'), 'line one\nNEEDLE_MARK here\nline three\n');
    const result = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, searchPattern: 'NEEDLE_MARK' },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result._meta as {
      matches?: { line?: number; content?: string }[];
      totalMatches?: number;
    };
    assert.strictEqual(structured.totalMatches, 1);
    assert.strictEqual(structured.matches?.[0]?.line, 2);
    assert.ok(structured.matches?.[0]?.content?.includes('NEEDLE_MARK'));
  });

  it('search_text on a file whose name has glob metacharacters searches that file', async () => {
    const target = await writeTestFile(tmpDir, 'globby/[slug].tsx', 'export const NEEDLE_A = 1;\n');
    // A same-directory decoy that the character class `[slug]` would match.
    await writeTestFile(tmpDir, 'globby/s.tsx', 'export const NEEDLE_A = 2;\n');

    const result = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: target, searchPattern: 'NEEDLE_A' },
    });
    assert.notStrictEqual(result.isError, true);
    const matches = (result._meta as { matches?: { file: string; line: number }[] }).matches ?? [];
    assert.deepStrictEqual(
      matches.map((m) => m.file),
      ['[slug].tsx'],
      'exactly the named file, not the decoy',
    );
  });

  it('search_text on an explicit file ignores glob, hidden, and ignored filters', async () => {
    const target = await writeTestFile(tmpDir, 'explicit_scope/.hidden.log', 'NEEDLE_SCOPE\n');
    await writeTestFile(tmpDir, 'explicit_scope/.gitignore', '*.log\n');
    await writeTestFile(tmpDir, 'explicit_scope/nested/.hidden.log', 'NEEDLE_SCOPE\n');

    const result = await harness.client.callTool({
      name: 'search_text',
      arguments: {
        path: target,
        searchPattern: 'NEEDLE_SCOPE',
        pattern: '**/*.ts',
        includeHidden: false,
        includeIgnored: false,
      },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(firstTextBlock(result).text, '.hidden.log:1: NEEDLE_SCOPE');
    const matches = (result._meta as { matches: { file: string; line: number }[] }).matches;
    assert.deepStrictEqual(
      matches.map(({ file, line }) => ({ file, line })),
      [{ file: '.hidden.log', line: 1 }],
    );
  });

  it('find_files accepts a literal file name containing .. inside a segment', async () => {
    // `[...slug]` stays a character class (as in any glob), so the accepted
    // pattern that is also *useful* is a literal name with `..` inside it.
    await writeTestFile(tmpDir, 'globby/docs/v1..2.md', 'x\n');
    const result = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: join(tmpDir, 'globby'), pattern: 'docs/v1..2.md' },
    });
    assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
    const paths =
      (result._meta as { results?: { path: string }[] }).results?.map((r) => r.path) ?? [];
    assert.deepStrictEqual(paths, ['docs/v1..2.md']);
  });

  it('search_text: an empty-line pattern sees no phantom line after a trailing newline', async () => {
    const dir = join(tmpDir, 'phantom_line');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'trailing.txt'), 'alpha\nbeta\n');
    await writeFile(join(dir, 'blank.txt'), 'alpha\n\nbeta\n');
    await writeFile(join(dir, 'empty.txt'), '');

    const result = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, searchPattern: '^$', isRegex: true },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result._meta as {
      matches?: { file: string; line: number }[];
      totalMatches?: number;
    };
    assert.deepStrictEqual(
      structured.matches?.map((m) => `${m.file}:${String(m.line)}`),
      ['blank.txt:2'],
    );
    assert.strictEqual(structured.totalMatches, 1);
  });

  it('search_text pages are stable and reject cursor query replay', async () => {
    const file = await writeTestFile(tmpDir, 'search_pages.txt', 'NEEDLE bravo\nNEEDLE charlie\n');
    const first = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 1 },
    });
    const firstStructured = first._meta as {
      matches?: { content: string }[];
      nextCursor?: string;
    };
    const cursor = firstStructured.nextCursor;
    assert.ok(cursor);

    await rm(file, { force: true });
    const second = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 10, cursor },
    });
    assert.notStrictEqual(second.isError, true);
    const secondStructured = second._meta as { matches?: { content: string }[] };
    assert.deepStrictEqual(
      [...(firstStructured.matches ?? []), ...(secondStructured.matches ?? [])].map(
        (match) => match.content,
      ),
      ['NEEDLE bravo', 'NEEDLE charlie'],
    );

    const replay = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'different query', maxResults: 10, cursor },
    });
    assert.strictEqual(replay.isError, true);
    assert.match(firstTextBlock(replay).text ?? '', /INVALID_INPUT/);
  });

  it('search_text context returns surrounding lines and renders them grep-style once', async () => {
    const dir = join(tmpDir, 'grep_context');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'import x\nNEEDLE one\nconst y\nNEEDLE two\n}\nfiller\n');
    await writeFile(join(dir, 'b.txt'), 'foo\nNEEDLE\nbar\n');

    const result = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, searchPattern: 'NEEDLE', context: 1 },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result._meta as {
      matches?: { file: string; line: number; before?: string[]; after?: string[] }[];
    };
    assert.deepStrictEqual(
      structured.matches?.map((m) => [m.file, m.line, m.before, m.after]),
      [
        ['a.txt', 2, ['import x'], ['const y']],
        ['a.txt', 4, ['const y'], ['}']],
        ['b.txt', 2, ['foo'], ['bar']],
      ],
    );
    assert.ok(
      (firstTextBlock(result).text ?? '').startsWith(
        [
          'a.txt-1- import x',
          'a.txt:2: NEEDLE one',
          'a.txt-3- const y',
          'a.txt:4: NEEDLE two',
          'a.txt-5- }',
          '--',
          'b.txt-1- foo',
          'b.txt:2: NEEDLE',
          'b.txt-3- bar',
        ].join('\n'),
      ),
      firstTextBlock(result).text,
    );

    const plain = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, searchPattern: 'NEEDLE' },
    });
    const plainStructured = plain._meta as { matches?: Record<string, unknown>[] };
    assert.ok(plainStructured.matches?.every((m) => !('before' in m) && !('after' in m)));
  });

  it('search_text context: a match beats context on a shared line and stops at the last line', async () => {
    const dir = join(tmpDir, 'grep_context_adjacent');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'c.txt'), 'x\nNEEDLE a\nNEEDLE b\n');

    const result = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, searchPattern: 'NEEDLE', context: 1 },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result._meta as {
      matches?: { line: number; before?: string[]; after?: string[] }[];
    };
    assert.deepStrictEqual(
      structured.matches?.map((m) => [m.line, m.before, m.after]),
      [
        [2, ['x'], ['NEEDLE b']],
        [3, ['NEEDLE a'], []],
      ],
    );
    assert.strictEqual(
      firstTextBlock(result).text,
      ['c.txt-1- x', 'c.txt:2: NEEDLE a', 'c.txt:3: NEEDLE b'].join('\n'),
    );
  });

  it('search_text: anchors, word boundaries and CRLF behave per line (prefilter must not change them)', async () => {
    const dir = join(tmpDir, 'prefilter_semantics');
    await writeTestFile(tmpDir, 'prefilter_semantics/lf.txt', 'x\nimport a\n  import b\nfoo$bar\n');
    await writeTestFile(tmpDir, 'prefilter_semantics/crlf.txt', 'alpha\r\nbeta end\r\ngamma\r\n');

    const run = async (searchPattern: string, isRegex: boolean, caseSensitive = true) => {
      const r = await harness.client.callTool({
        name: 'search_text',
        arguments: { path: dir, searchPattern, isRegex, caseSensitive },
      });
      return (
        (r._meta as { matches?: { file: string; line: number; column: number }[] }).matches ?? []
      )
        .map((m) => `${m.file}:${m.line}:${m.column}`)
        .sort();
    };

    assert.deepStrictEqual(await run('^import', true), ['lf.txt:2:0']);
    assert.deepStrictEqual(
      await run('end$', true),
      ['crlf.txt:2:5'],
      'CRLF: $ matches before the stripped \r',
    );
    assert.deepStrictEqual(await run(String.raw`\bimport\b`, true), ['lf.txt:2:0', 'lf.txt:3:2']);
    assert.deepStrictEqual(await run('IMPORT', false, false), ['lf.txt:2:0', 'lf.txt:3:2']);
    assert.deepStrictEqual(await run('foo$bar', false), ['lf.txt:4:0'], 'literal $ is escaped');
    assert.deepStrictEqual(
      await run(String.raw`\Aimport`, true),
      ['lf.txt:2:0'],
      String.raw`\A is start of each line`,
    );
    assert.deepStrictEqual(
      await run('(?-m)^import', true),
      ['lf.txt:2:0'],
      'an inline flag group cannot turn ^ into a buffer anchor',
    );
    assert.deepStrictEqual(await run('(?i)IMPORT', true), ['lf.txt:2:0', 'lf.txt:3:2']);
  });

  it('search_text: the match set under maxResults is deterministic across runs', async () => {
    const dir = join(tmpDir, 'determinism');
    for (let i = 0; i < 40; i++) {
      await writeTestFile(
        tmpDir,
        `determinism/f${String(i).padStart(2, '0')}.txt`,
        'DET_HIT\nDET_HIT\nDET_HIT\n',
      );
    }
    const once = async () => {
      const r = await harness.client.callTool({
        name: 'search_text',
        arguments: { path: dir, searchPattern: 'DET_HIT', maxResults: 25 },
      });
      const meta = r._meta as { matches?: { file: string; line: number }[]; nextCursor?: string };
      return {
        first: (meta.matches ?? []).map((m) => `${m.file}:${m.line}`),
        cursor: meta.nextCursor,
      };
    };
    const a = await once();
    const b = await once();
    assert.deepStrictEqual(a.first, b.first);
    assert.strictEqual(a.first.length, 25);
  });

  it('searchContent under its own cap keeps the first matches in walk order', async () => {
    const root = await createTestRoot();
    try {
      for (let i = 0; i < 30; i++) {
        await writeTestFile(root, `w${String(i).padStart(2, '0')}.txt`, 'CAP_HIT\nCAP_HIT\n');
      }
      const guard = await makeGuard([root]);
      const a = await searchContent(root, 'CAP_HIT', { maxResults: 7 }, guard);
      const b = await searchContent(root, 'CAP_HIT', { maxResults: 7 }, guard);
      const key = (r: typeof a) => r.matches.map((m) => `${basename(m.file)}:${m.line}`);
      assert.deepStrictEqual(key(a), key(b));
      assert.strictEqual(a.matches.length, 7);
      assert.strictEqual(a.summary.stoppedReason, 'maxResults');
      assert.strictEqual(a.summary.truncated, true);
    } finally {
      await cleanupTestRoot(root);
    }
  });

  it('searchContent never collects more matches from one file than its cap', async () => {
    const root = await createTestRoot();
    try {
      // One file with far more matching lines than the cap: the scan must not
      // materialize them all before the cap is applied.
      await writeTestFile(
        root,
        'many.txt',
        Array.from({ length: 5000 }, () => 'CAP_ONE').join('\n') + '\n',
      );
      const guard = await makeGuard([root]);
      const r = await searchContent(root, 'CAP_ONE', { maxResults: 5 }, guard);
      assert.strictEqual(r.matches.length, 5);
      assert.strictEqual(r.summary.matchingLines, 5);
      assert.strictEqual(r.summary.filesMatched, 1);
      assert.strictEqual(r.summary.stoppedReason, 'maxResults');
    } finally {
      await cleanupTestRoot(root);
    }
  });

  it('search_text rejects a cursor minted under a different context', async () => {
    const file = await writeTestFile(tmpDir, 'search_ctx_cursor.txt', 'NEEDLE a\nNEEDLE b\n');
    const first = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 1 },
    });
    const cursor = (first._meta as { nextCursor?: string }).nextCursor;
    assert.ok(cursor);

    const replay = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 1, context: 1, cursor },
    });
    assert.strictEqual(replay.isError, true);
    assert.match(firstTextBlock(replay).text ?? '', /INVALID_INPUT/);
  });

  it('search_text externalizes the full match list on the first page only', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `NEEDLE line ${String(i)}`);
    const file = await writeTestFile(tmpDir, 'search_first_page.txt', `${lines.join('\n')}\n`);
    const first = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 60 },
    });
    const firstStructured = first._meta as {
      matches?: unknown[];
      nextCursor?: string;
      resourceUri?: string;
      truncated?: boolean;
    };
    assert.strictEqual(firstStructured.matches?.length, 60, 'maxResults is the page size');
    assert.ok(firstStructured.nextCursor, 'more matches remain');
    assert.ok(firstStructured.resourceUri, 'an incomplete first page carries the full-list URI');
    assert.strictEqual(
      firstStructured.truncated,
      undefined,
      'paging is not truncation: the engine hit no cap',
    );

    const second = await harness.client.callTool({
      name: 'search_text',
      arguments: {
        path: file,
        searchPattern: 'NEEDLE',
        maxResults: 60,
        cursor: firstStructured.nextCursor,
      },
    });
    assert.notStrictEqual(second.isError, true);
    const secondStructured = second._meta as { matches?: unknown[]; resourceUri?: string };
    assert.strictEqual(secondStructured.matches?.length, 60);
    assert.strictEqual(
      secondStructured.resourceUri,
      undefined,
      'a continuation page must not mint a new resource',
    );
  });

  it('the page trailer tracks position across pages and both search tools', async () => {
    // `_meta` reaches no client, so a page that hides matches has to say so in
    // the text or the caller reads a capped list as the whole answer.
    const lines = Array.from({ length: 9 }, (_, i) => `NEEDLE line ${String(i)}`);
    const file = await writeTestFile(tmpDir, 'trailer/hits.txt', `${lines.join('\n')}\n`);
    const first = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 4 },
    });
    assert.match(
      firstTextBlock(first).text ?? '',
      /^\/\/ showing 1-4 of 9 matches\. Next page: search_text \{.*"searchPattern":"NEEDLE".*"cursor":"/m,
    );

    const cursor = (first._meta as { nextCursor?: string }).nextCursor;
    assert.ok(cursor);
    const second = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 4, cursor },
    });
    // The whole point: page 2 must not repeat page 1's counter.
    assert.match(firstTextBlock(second).text ?? '', /^\/\/ showing 5-8 of 9 matches\./m);

    // The last page carries no cursor and still owes its position, or a
    // one-row tail reads as the whole answer.
    const lastCursor = (second._meta as { nextCursor?: string }).nextCursor;
    assert.ok(lastCursor);
    const last = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 4, cursor: lastCursor },
    });
    const lastText = firstTextBlock(last).text ?? '';
    assert.match(lastText, /^\/\/ showing 9-9 of 9 matches\.$/m);
    assert.doesNotMatch(lastText, /Next page/);

    const complete = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'NEEDLE', maxResults: 50 },
    });
    assert.doesNotMatch(
      firstTextBlock(complete).text ?? '',
      /Next page/,
      'a complete set gets no trailer',
    );

    // Own subdirectory with two files of its own: pointing at the shared tmpDir
    // would borrow whatever earlier tests left there and pass for the wrong
    // reason when this test runs alone.
    await writeTestFile(tmpDir, 'trailer_files/a.txt', 'a');
    await writeTestFile(tmpDir, 'trailer_files/b.txt', 'b');
    const files = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: join(tmpDir, 'trailer_files'), pattern: '**/*', maxResults: 1 },
    });
    assert.match(
      firstTextBlock(files).text ?? '',
      /^\/\/ showing 1-1 of 2 files\. Next page: find_files \{.*"pattern":"\*\*\/\*".*"cursor":"/m,
    );
  });

  it('search_text says so in the text when the engine cut the scan', async () => {
    // One line over the hard result cap makes the engine stop, so totalMatches
    // is a floor rather than the real count.
    const lines = Array.from({ length: MAX_SEARCH_RESULTS + 1 }, (_, i) => `CAPPED ${String(i)}`);
    const file = await writeTestFile(tmpDir, 'capped/hits.txt', `${lines.join('\n')}\n`);
    const result = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: 'CAPPED', maxResults: 5 },
    });
    const text = firstTextBlock(result).text ?? '';
    assert.ok(text.includes(`// showing 1-5 of ${String(MAX_SEARCH_RESULTS)} matches.`), text);
    assert.ok(
      text.includes(
        `// scan stopped early: hit the server's ${String(MAX_SEARCH_RESULTS)}-result scan cap, not your maxResults.`,
      ),
      text,
    );
    assert.strictEqual(
      (result._meta as { truncated?: boolean }).truncated,
      true,
      'the engine reports its own stop state',
    );
  });

  it('search_text names the files it skipped in the text, with or without matches', async () => {
    // A lone match in a file over the size cap read as "No matches": the skip
    // count lived only in `_meta`, which no client shows the model.
    const limit = 1024 * 1024;
    await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
      const dir = join(tmpDir, 'skipped_big');
      await writeTestFile(tmpDir, 'skipped_big/big.txt', `BIGNEEDLE\n${'a'.repeat(limit)}`);
      const skipLine = '// skipped 1 file over the text size limit; results may be incomplete.';
      const alone = await harness.client.callTool({
        name: 'search_text',
        arguments: { path: dir, searchPattern: 'BIGNEEDLE' },
      });
      assert.strictEqual(firstTextBlock(alone).text, `No matches for 'BIGNEEDLE'\n\n${skipLine}`);

      await writeTestFile(tmpDir, 'skipped_big/small.txt', 'BIGNEEDLE\n');
      const beside = await harness.client.callTool({
        name: 'search_text',
        arguments: { path: dir, searchPattern: 'BIGNEEDLE' },
      });
      assert.strictEqual(firstTextBlock(beside).text, `small.txt:1: BIGNEEDLE\n\n${skipLine}`);
    });
  });

  it('search_text skips binary files and reports the count', async () => {
    await writeTestFile(tmpDir, 'search_bin/text.txt', 'BINNEEDLE\n');
    await writeFile(
      join(tmpDir, 'search_bin', 'blob.bin'),
      Buffer.from([0x00, ...Buffer.from('BINNEEDLE'), 0x00]),
    );
    const result = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: join(tmpDir, 'search_bin'), searchPattern: 'BINNEEDLE' },
    });
    assert.strictEqual(firstTextBlock(result).text, 'text.txt:1: BINNEEDLE');
    assert.strictEqual((result._meta as { filesScanned?: number }).filesScanned, 2);
    assert.strictEqual((result._meta as { skippedBinary?: number }).skippedBinary, 1);
  });

  it('HTTP pagination survives the per-request server factory', async () => {
    const root = await createTestRoot();
    const http = await bootHttpTest([root]);
    try {
      await writeTestFile(root, 'http-pages/bravo.txt', 'x');
      await writeTestFile(root, 'http-pages/charlie.txt', 'x');
      const client = await http.makeClient('http-pagination');
      const first = await client.callTool({
        name: 'list',
        arguments: { path: join(root, 'http-pages'), maxEntries: 1 },
      });
      const firstStructured = first._meta as { nextCursor?: string };
      const cursor = firstStructured.nextCursor;
      assert.ok(cursor);

      const second = await client.callTool({
        name: 'list',
        arguments: { path: join(root, 'http-pages'), maxEntries: 10, cursor },
      });
      assert.notStrictEqual(second.isError, true);
      const secondStructured = second._meta as { entries?: { name: string }[] };
      assert.deepStrictEqual(
        secondStructured.entries?.map((entry) => entry.name),
        ['charlie.txt'],
      );
    } finally {
      await http.close();
      await cleanupTestRoot(root);
    }
  });

  it('TOOL-SURFACE-001: published schemas carry no dead keywords or phantom fields', async () => {
    const { tools } = await harness.client.listTools();
    // Scoped to input schemas: `suggestion` is a legitimate output property on
    // PerFileError, but never a schema keyword.
    const inputSchemas = JSON.stringify(tools.map((t) => t.inputSchema));

    assert.ok(
      !inputSchemas.includes('suggestion'),
      'the non-standard suggestion keyword must not reach the wire',
    );

    for (const tool of tools) {
      assert.strictEqual(
        tool.annotations?.title,
        undefined,
        `${tool.name} must not duplicate its title into annotations`,
      );
    }

    // No tool publishes an outputSchema any more. Publishing one obliges the
    // result to carry structuredContent, and every tool that used to publish
    // (read, edit, delete, replace_text) authors its own text and now ships its
    // metadata under _meta instead — the two are mutually exclusive.
    for (const tool of tools) {
      assert.strictEqual(
        tool.outputSchema,
        undefined,
        `${tool.name} must not publish an outputSchema`,
      );
    }

    for (const name of ['read', 'stat']) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} must be registered`);
      const properties = tool.inputSchema.properties ?? {};
      assert.ok(
        !Object.keys(properties).includes('files'),
        `${name} must not declare a files property`,
      );
      assert.ok(
        !JSON.stringify(tool.inputSchema).includes('and files'),
        `${name} must not advertise a files param it does not accept`,
      );
    }

    const edit = tools.find((t) => t.name === 'edit');
    assert.ok(edit);
    const editInput = JSON.stringify(edit.inputSchema);
    // EditSpec is the one subschema with an `id`, so it is hoisted into `$defs`
    // and referenced from both use sites (edits and files[].edits) rather than
    // inlined twice.
    assert.strictEqual(
      editInput.split('"$ref"').length - 1,
      2,
      'edit must reference the hoisted EditSpec at both use sites',
    );
    assert.ok(
      (edit.inputSchema as { $defs?: Record<string, unknown> }).$defs?.['EditSpec'],
      'edit must publish EditSpec in $defs',
    );
    // Sentinel is the opening of EditSpecSchema's `oldText` description in
    // src/tools/edit.ts — reword that description and this count must move with
    // it. Hoisted, it appears once.
    assert.strictEqual(
      editInput.split('Exact literal text to locate').length - 1,
      1,
      "EditSpec's oldText description must appear only in the hoisted $defs entry",
    );

    // `oneOf` (not `anyOf`): `{path, paths}` matches two branches and so fails,
    // mirroring the superRefine in singleOrBatchPathsInput. `edit`'s single-file
    // branch additionally requires `edits`, so `{ path }` alone fails the wire
    // schema the same way it fails the runtime gate — it used to pass the first
    // and fail the second, which the model had no way to anticipate.
    const modeBranches = (name: string, branches: string[][]) => {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} must be registered`);
      assert.deepStrictEqual(
        (tool.inputSchema as { oneOf?: unknown }).oneOf,
        branches.map((required) => ({ required })),
        `${name} must advertise its input modes as oneOf`,
      );
    };
    modeBranches('read', [['path'], ['paths']]);
    modeBranches('stat', [['path'], ['paths']]);
    modeBranches('edit', [['path', 'edits'], ['files']]);

    // `read`'s line-mode exclusivity is published too, not just enforced in
    // validateReadRange: `{ path, head, tail }` must fail the advertised schema.
    const readTool = tools.find((t) => t.name === 'read');
    assert.ok(readTool, 'read must be registered');
    const readSchema = readTool.inputSchema as {
      not?: { anyOf?: { required: string[] }[] };
      dependentRequired?: Record<string, string[]>;
    };
    assert.strictEqual(
      readSchema.not,
      undefined,
      'read no longer publishes the line-param exclusivity as a not/anyOf block',
    );
    assert.deepStrictEqual(
      readSchema.dependentRequired,
      { endLine: ['startLine'] },
      'read must advertise that endLine needs startLine',
    );

    // The rule moved off the wire, so it is proven at the layer that enforces
    // it: validateReadRange rejects the pair by name and that reaches the client
    // as a tool error.
    const conflictFile = await writeTestFile(tmpDir, 'line-conflict.txt', 'a\nb\nc');
    const conflict = await harness.client.callTool({
      name: 'read',
      arguments: { path: conflictFile, head: 1, tail: 1 },
    });
    assert.strictEqual(conflict.isError, true);
    const conflictText = firstTextBlock(conflict).text;
    assert.ok(conflictText);
    assert.match(conflictText, /head|tail/i);
  });

  it('every tool publishes exactly its read-only or mutating annotations', async () => {
    const { tools } = await harness.client.listTools();
    const mutating = new Set(['create', 'delete', 'edit', 'move', 'patch', 'replace_text']);
    for (const tool of tools) {
      const readOnlyHint = !mutating.has(tool.name);
      assert.deepStrictEqual(
        tool.annotations,
        {
          readOnlyHint,
          openWorldHint: false,
          ...(readOnlyHint ? {} : { destructiveHint: true }),
        },
        tool.name,
      );
    }
  });

  // The session-start cost a client pays before its first tool call. Lower this
  // ceiling when a change removes weight; never raise it without a recorded
  // reason. History before this baseline (the 528760ea start at 41410 / 20862,
  // and the output-schema add-backs) no longer applies: since f9199c80 no tool
  // publishes an output schema. Baseline measured 2026-10-02, after the arch
  // audit follow-ups: 18154 full / 8950 read-only. Each ceiling sits about 2%
  // above its measurement, so a regression of a few hundred characters fails.
  it('TOOL-SURFACE-002: tools/list stays within the session-start budget', async () => {
    const BUDGET_CHARS = 18_500;
    const BUDGET_CHARS_READ_ONLY = 9_150;

    const full = await createTestClientPair([tmpDir]);
    try {
      const { tools } = await full.client.listTools();
      assert.strictEqual(tools.length, 13, 'tool count changed; update the budget deliberately');
      const size = JSON.stringify(tools).length;
      assert.ok(
        size <= BUDGET_CHARS,
        `tools/list is ${String(size)} chars, over the ${String(BUDGET_CHARS)} budget`,
      );
    } finally {
      await full.close();
    }

    const ro = await createTestClientPair([tmpDir], { readOnly: true });
    try {
      const { tools } = await ro.client.listTools();
      const size = JSON.stringify(tools).length;
      assert.ok(
        size <= BUDGET_CHARS_READ_ONLY,
        `read-only tools/list is ${String(size)} chars, over the ${String(BUDGET_CHARS_READ_ONLY)} budget`,
      );
    } finally {
      await ro.close();
    }
  });
});
