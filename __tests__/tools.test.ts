import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setImmediate as setImmediatePromise, setTimeout as sleep } from 'node:timers/promises';

import { ErrorCode, FsError } from '../src/core/errors.ts';
import { buildFileResourceUri } from '../src/core/file-uri.ts';
import { formatByteSize } from '../src/core/fmt.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import { MAX_MATCH_LINE_CHARS, RE2_MAX_INPUT_BYTES, searchContent } from '../src/core/search.ts';
import {
  escapeRegExp,
  getMaxTextFileSize,
  MAX_LIST_ENTRIES,
  MAX_SEARCH_RESULTS,
  MAX_TOOL_INPUT_ELEMENTS,
} from '../src/core/util.ts';
import { createRuntimeState, createServer } from '../src/server.ts';
import { type FlexMatch, flexMatches } from '../src/tools/edit.ts';
import { keepFirstResults } from '../src/tools/find-files.ts';
import { MUTATING_TOOL_NAMES, registeredTools } from '../src/tools/index.ts';
import { listPageMetadata } from '../src/tools/list.ts';
import { ProgressSession } from '../src/tools/progress.ts';
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

  it('read refuses binary together with a line range', async () => {
    const file = await writeTestFile(tmpDir, 'binary-flag/range.txt', 'a\nb\n');
    for (const extra of [
      { head: 1 },
      { tail: 1 },
      { startLine: 1 },
      { startLine: 1, endLine: 2 },
    ]) {
      const result = await harness.client.callTool({
        name: 'read',
        arguments: { path: file, binary: true, ...extra },
      });
      assert.strictEqual(result.isError, true, JSON.stringify(extra));
      assert.match(firstTextBlock(result).text ?? '', /Cannot use 'binary'/);
    }
  });

  it('read without binary refuses a binary file and names the flag', async () => {
    const dir = join(tmpDir, 'binary-flag');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'hint.zip');
    await writeFile(file, Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]));
    const whole = await harness.client.callTool({ name: 'read', arguments: { path: file } });
    assert.strictEqual(whole.isError, true);
    assert.strictEqual(failedSummary(whole)?.results?.[0]?.error?.code, 'INVALID_INPUT');
    assert.match(firstTextBlock(whole).text ?? '', /^Binary file detected\. Pass binary: true/);

    const ranged = await harness.client.callTool({
      name: 'read',
      arguments: { path: file, head: 1 },
    });
    assert.strictEqual(ranged.isError, true);
    assert.match(firstTextBlock(ranged).text ?? '', /no lines; read it whole with binary: true/);
  });

  it('read with binary returns a PDF or zip as an embedded resource', async () => {
    const dir = join(tmpDir, 'binary-flag');
    await mkdir(dir, { recursive: true });
    const cases = [
      {
        name: 'doc.pdf',
        bytes: Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1'),
        mimeType: 'application/pdf',
        kind: 'pdf',
      },
      {
        name: 'a.zip',
        bytes: Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]),
        mimeType: 'application/zip',
        kind: 'binary',
      },
      // Refused by extension although its bytes are ASCII: still one resource.
      {
        name: 'notes.bin',
        bytes: Buffer.from('plain ascii\n'),
        mimeType: 'application/octet-stream',
        kind: 'binary',
      },
    ];
    for (const c of cases) {
      const file = join(dir, c.name);
      await writeFile(file, c.bytes);
      const result = await harness.client.callTool({
        name: 'read',
        arguments: { path: file, binary: true, includeHash: true },
      });
      assert.notStrictEqual(result.isError, true, c.name);
      const blocks = result.content as readonly {
        type: string;
        resource?: { uri?: string; mimeType?: string; blob?: string };
      }[];
      assert.strictEqual(blocks.filter((b) => b.type === 'resource_link').length, 0, c.name);
      const block = blocks.find((b) => b.type === 'resource');
      assert.ok(block?.resource, `${c.name}: expected an embedded resource`);
      assert.strictEqual(block.resource.uri, buildFileResourceUri(normalizePath(file)));
      assert.strictEqual(block.resource.mimeType, c.mimeType);
      assert.ok(Buffer.from(block.resource.blob ?? '', 'base64').equals(c.bytes), c.name);
      assert.match(firstTextBlock(result).text ?? '', /returned as an embedded resource block/);
      assert.match(firstTextBlock(result).text ?? '', /\/\/ sha256: [0-9a-f]{64}/);
      const value = (result._meta as { results?: { value?: Record<string, unknown> }[] })
        .results?.[0]?.value;
      assert.strictEqual(value?.['kind'], c.kind);
      assert.strictEqual(value?.['mimeType'], c.mimeType);
      assert.strictEqual(value?.['size'], c.bytes.length);
      assert.strictEqual(value?.['resourceUri'], buildFileResourceUri(normalizePath(file)));
      assert.strictEqual(value?.['blobData'], undefined, 'bytes never ride _meta');
    }
  });

  it('read with binary leaves text, UTF-16, secret and oversize files as they were', async () => {
    const text = await writeTestFile(tmpDir, 'binary-flag/plain.txt', 'hello\n');
    const plain = await harness.client.callTool({
      name: 'read',
      arguments: { path: text, binary: true },
    });
    assert.notStrictEqual(plain.isError, true);
    assert.strictEqual(firstTextBlock(plain).text, 'hello\n');
    assert.ok((plain.content as { type: string }[]).some((b) => b.type === 'resource_link'));

    const utf16 = join(tmpDir, 'binary-flag/utf16.txt');
    await writeFile(
      utf16,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]),
    );
    const wide = await harness.client.callTool({
      name: 'read',
      arguments: { path: utf16, binary: true },
    });
    assert.strictEqual(wide.isError, true);
    assert.match(failedSummary(wide)?.results?.[0]?.error?.message ?? '', /UTF-16/);

    const secret = await writeTestFile(tmpDir, 'binary-flag/.env', 'SECRET=1');
    const denied = await harness.client.callTool({
      name: 'read',
      arguments: { path: secret, binary: true },
    });
    assert.strictEqual(denied.isError, true);
    assert.ok(!(denied.content as { type: string }[]).some((b) => b.type === 'resource'));

    const big = join(tmpDir, 'binary-flag/big.zip');
    await writeFile(big, Buffer.alloc(1024 * 1024 + 1));
    await withEnv({ FS_MAX_FILE_SIZE: String(1024 * 1024) }, async () => {
      const tooLarge = await harness.client.callTool({
        name: 'read',
        arguments: { path: big, binary: true },
      });
      assert.strictEqual(tooLarge.isError, true);
      assert.strictEqual(failedSummary(tooLarge)?.results?.[0]?.error?.code, 'TOO_LARGE');
    });
  });

  it('batch read with binary mixes text and resources and charges base64 size', async () => {
    const text = await writeTestFile(tmpDir, 'binary-flag/mix/a.txt', 'x'.repeat(100 * 1024));
    const pdf = join(tmpDir, 'binary-flag/mix/doc.pdf');
    await writeFile(pdf, Buffer.from('%PDF-1.4\n', 'latin1'));
    const mixed = await harness.client.callTool({
      name: 'read',
      arguments: { paths: [text, pdf], binary: true },
    });
    assert.notStrictEqual(mixed.isError, true);
    const types = (mixed.content as { type: string }[]).map((b) => b.type);
    assert.deepStrictEqual(types, ['text', 'resource_link', 'resource']);
    assert.strictEqual(failedSummary(mixed)?.summary?.failed, 0);

    // 100 KiB + 400 KiB fits 512 KiB raw, but the zip ships as ~533 KiB of base64.
    const zip = join(tmpDir, 'binary-flag/mix/big.zip');
    await writeFile(zip, Buffer.alloc(400 * 1024));
    const budget = await harness.client.callTool({
      name: 'read',
      arguments: { paths: [text, zip], binary: true },
    });
    const results = failedSummary(budget)?.results;
    assert.strictEqual(results?.[0]?.error, undefined);
    assert.strictEqual(results?.[1]?.error?.code, 'TOO_LARGE');
    assert.match(results?.[1]?.error?.message ?? '', /maxTotalSize/);
  });

  it('batch slice of an svg is charged its raw size, not base64', async () => {
    // 400 KiB fits the 512 KiB budget raw; as base64 it would not. A slice is text.
    const svg = await writeTestFile(
      tmpDir,
      'binary-flag/large.svg',
      `<svg xmlns="http://www.w3.org/2000/svg">\n${'<g/>\n'.repeat(80 * 1024)}</svg>\n`,
    );
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { paths: [svg], head: 1 },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(failedSummary(result)?.results?.[0]?.error, undefined);
    assert.match(firstTextBlock(result).text ?? '', /<svg xmlns/);
  });

  it('batch head slice of a file larger than maxTotalSize is charged its returned bytes', async () => {
    // 600 KiB is over the 512 KiB batch budget whole; head: 1 returns 2 bytes.
    const small = await writeTestFile(tmpDir, 'read-budget/small.txt', 'small\n');
    const big = await writeTestFile(tmpDir, 'read-budget/big.txt', 'x\n'.repeat(300 * 1024));
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { paths: [small, big], head: 1 },
    });
    assert.notStrictEqual(result.isError, true);
    const meta = failedSummary(result);
    assert.strictEqual(meta?.summary?.failed, 0);
    assert.strictEqual(meta?.results?.[1]?.error, undefined);
    const text = firstTextBlock(result).text ?? '';
    assert.match(text, /\/\/ .*small\.txt\nsmall/);
    assert.match(text, /\/\/ .*big\.txt\nx/);
  });

  it('batch slices over budget skip one slice without head/tail advice', async () => {
    // Each head: 1 returns one 300 KiB line; two of them pass 512 KiB.
    const line = 'y'.repeat(300 * 1024);
    const a = await writeTestFile(tmpDir, 'read-budget/a.txt', `${line}\nrest\n`);
    const b = await writeTestFile(tmpDir, 'read-budget/b.txt', `${line}\nrest\n`);
    const c = await writeTestFile(tmpDir, 'read-budget/c.txt', 'tiny\nrest\n');
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { paths: [a, b, c], head: 1 },
    });
    assert.notStrictEqual(result.isError, true);
    const errors = (failedSummary(result)?.results ?? []).map((r) => r.error);
    assert.strictEqual(errors.length, 3);
    // Charged in completion order: either a or b is skipped, never both; c always fits.
    assert.strictEqual(errors[2], undefined);
    const skipped = errors.filter((e) => e !== undefined);
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0]?.code, 'TOO_LARGE');
    assert.match(skipped[0]?.message ?? '', /maxTotalSize \(524288 bytes\)/);
    assert.strictEqual(
      skipped[0]?.suggestion,
      'Read it on its own with path, or ask for fewer lines.',
    );
    assert.strictEqual(failedSummary(result)?.summary?.failed, 1);
  });

  it('TC-FUNC-007: Read path outside allowed root returns isError: true with ACCESS_DENIED', async () => {
    const outsideDir = await createTestRoot();
    const outsideFile = await writeTestFile(outsideDir, 'outside_test.txt', 'secret');
    try {
      const result = await harness.client.callTool({
        name: 'read',
        arguments: { path: outsideFile },
      });
      assert.strictEqual(result.isError, true);
      const firstBlock = firstTextBlock(result);
      assert.ok(firstBlock.text);
    } finally {
      await cleanupTestRoot(outsideDir);
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
    const token = 'example-sentinel-9f3c1e';
    const dir = join(tmpDir, 'boundary_walk');
    const envFile = await writeTestFile(tmpDir, 'boundary_walk/.env', `SECRET=${token}\n`);
    await writeTestFile(tmpDir, 'boundary_walk/vault.key/inner.txt', `note ${token}\n`);
    const plain = await writeTestFile(tmpDir, 'boundary_walk/plain.txt', `note ${token}\n`);

    const search = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, searchPattern: token, includeHidden: true },
    });
    const searchMeta = search._meta as {
      matches?: { file: string }[];
      skippedInaccessible?: number;
    };
    assert.deepStrictEqual(
      (searchMeta.matches ?? []).map((m) => m.file),
      ['boundary_walk/plain.txt'],
      'search_text must not match inside .env',
    );
    assert.strictEqual(searchMeta.skippedInaccessible, undefined);
    assert.doesNotMatch(firstTextBlock(search).text ?? '', /inaccessible|\.env/);

    const found = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: dir, pattern: '*.txt', includeHidden: true },
    });
    const foundMeta = found._meta as {
      results?: { path: string }[];
      skippedInaccessible?: number;
    };
    const paths = foundMeta.results?.map((r) => r.path) ?? [];
    assert.ok(paths.includes('boundary_walk/plain.txt'));
    assert.ok(
      !paths.some((path) => path.endsWith('.env')),
      `find_files must not list .env: ${paths.join(',')}`,
    );
    assert.ok(
      !paths.some((path) => path.includes('vault.key')),
      `find_files must not list inside a sensitive-named directory: ${paths.join(',')}`,
    );
    assert.strictEqual(foundMeta.skippedInaccessible, undefined);
    assert.doesNotMatch(firstTextBlock(found).text ?? '', /inaccessible|\.env/);

    // A literal pattern prefix names the sensitive directory directly, so the
    // glob never asks the walk filter about it; the yielded entries' own
    // ancestors must still hide the subtree.
    const prefixed = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: dir, pattern: 'vault.key/*.txt', includeHidden: true },
    });
    assert.deepStrictEqual(
      (prefixed._meta as { results?: { path: string }[] }).results ?? [],
      [],
      'find_files must not enter a sensitive-named directory through a literal pattern prefix',
    );

    const prefixedSearch = await harness.client.callTool({
      name: 'search_text',
      arguments: {
        path: dir,
        searchPattern: token,
        pattern: 'vault.key/*.txt',
        includeHidden: true,
      },
    });
    assert.deepStrictEqual(
      (prefixedSearch._meta as { matches?: { file: string }[] }).matches ?? [],
      [],
      'search_text must not match through a literal pattern prefix into a sensitive-named directory',
    );

    const listed = await harness.client.callTool({
      name: 'list',
      arguments: { path: dir, maxDepth: 2, includeHidden: true },
    });
    const names =
      (listed._meta as { entries?: { name: string }[] }).entries?.map((e) => e.name) ?? [];
    assert.deepStrictEqual(names, ['plain.txt']);
    assert.doesNotMatch(firstTextBlock(listed).text ?? '', /\.env|vault\.key|inner\.txt/);

    const replaced = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: token, replacement: 'REDACTED', includeHidden: true },
    });
    assert.notStrictEqual(replaced.isError, true);
    const replacedMeta = replaced._meta as { summary?: { failed?: number } };
    assert.strictEqual(replacedMeta.summary?.failed, 0);
    assert.doesNotMatch(firstTextBlock(replaced).text ?? '', /failed|\.env/);
    assert.strictEqual(
      await readFile(envFile, 'utf-8'),
      `SECRET=${token}\n`,
      '.env must be untouched',
    );
    assert.strictEqual(
      await readFile(join(dir, 'vault.key/inner.txt'), 'utf-8'),
      `note ${token}\n`,
      'a file under a sensitive-named directory must be untouched',
    );
    assert.strictEqual(await readFile(plain, 'utf-8'), 'note REDACTED\n');

    // A second replace_text that matches 0 files must still succeed cleanly, not fail on .env.
    const noMatchReplace = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: token, replacement: 'REDACTED', includeHidden: true },
    });
    assert.notStrictEqual(noMatchReplace.isError, true);

    await assert.rejects(
      harness.client.readResource({ uri: buildFileResourceUri(envFile) }),
      'resources/read of a sensitive file must be refused',
    );
  });

  it('a sensitive-named symlink directory never surfaces its subtree', async (t) => {
    const dir = join(tmpDir, 'sensitive_link_walk');
    await mkdir(join(dir, 'clean'), { recursive: true });
    await writeTestFile(dir, 'clean/deep.txt', 'note needle\n');
    // A junction works on Windows without developer mode; a dir symlink elsewhere.
    if (
      !(await trySymlink(join(dir, 'clean'), join(dir, 'alias.key'), () =>
        t.skip('symlink creation not permitted'),
      ))
    ) {
      return;
    }

    const found = await harness.client.callTool({
      name: 'find_files',
      arguments: { path: dir, pattern: '**/*.txt' },
    });
    const paths =
      (found._meta as { results?: { path: string }[] }).results?.map((r) => r.path) ?? [];
    assert.ok(
      !paths.some((path) => path.includes('alias.key')),
      `find_files must not follow a sensitive-named symlink: ${paths.join(',')}`,
    );

    const searched = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, searchPattern: 'needle' },
    });
    const files =
      (searched._meta as { matches?: { file: string }[] }).matches?.map((m) => m.file) ?? [];
    assert.ok(
      !files.some((file) => file.includes('alias.key')),
      `search_text must not match inside a sensitive-named symlink: ${files.join(',')}`,
    );

    const listed = await harness.client.callTool({
      name: 'list',
      arguments: { path: dir, maxDepth: 3 },
    });
    assert.doesNotMatch(
      firstTextBlock(listed).text ?? '',
      /alias\.key/,
      'list must not draw a sensitive-named symlink (its target appears under its own name)',
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

  it('create append reports the write time when the post-append stat fails', async (t) => {
    const file = await writeTestFile(tmpDir, 'append_stat_fails.txt', 'first\n');
    let appended = false;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
    const { appendFile, stat: statFile } = GuardedFileSystem.prototype;
    t.mock.method(
      GuardedFileSystem.prototype,
      'appendFile',
      async function (this: GuardedFileSystem, ...args: Parameters<typeof appendFile>) {
        const done = await appendFile.apply(this, args);
        appended = true;
        return done;
      },
    );
    t.mock.method(
      GuardedFileSystem.prototype,
      'stat',
      function (this: GuardedFileSystem, ...args: Parameters<typeof statFile>) {
        return appended ? Promise.reject(new Error('stat failed')) : statFile.apply(this, args);
      },
    );
    const before = Date.now();
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: file, content: 'second\n', append: true }] },
    });
    const after = Date.now();
    t.mock.restoreAll();

    assert.notStrictEqual(result.isError, true);
    const modified = (result.structuredContent as { files: { modified: string }[] }).files[0]
      ?.modified;
    const at = Date.parse(modified ?? '');
    assert.ok(at >= before && at <= after, modified);
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

  it('TC-FUNC-009q: a file that appears during the confirmation gap is asked about again', async () => {
    const gapFile = join(tmpDir, 'create_gap_appears.txt');
    let calls = 0;
    const eh = await createElicitationClientPair([tmpDir], async () => {
      calls += 1;
      // Someone else writes the not-yet-existing entry while the human is
      // looking at the prompt for the other one.
      if (calls === 1) await writeFile(gapFile, 'written during the gap\n');
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
      // One prompt per pending entry: existing, then existing and gapFile re-prompted together.
      assert.strictEqual(calls, 3, 'asked once, then asked again about both');
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(await readFile(gapFile, 'utf-8'), 'clobber\n');
      assert.strictEqual(await readFile(existing, 'utf-8'), 'new\n');
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
    if (process.getuid?.() === 0) return t.skip('root bypasses the 0222 mode bits');

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

  it('TC-FUNC-009s: create on an NTFS stream path is INVALID_INPUT, not a raw EINVAL', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('alternate data streams are an NTFS feature');
      return;
    }
    const target = join(tmpDir, 'ads-create.txt:hidden');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: target, content: 'secret' }] },
    });
    assert.strictEqual(result.isError, true);
    const failure = (
      result.structuredContent as { failures?: { error?: { code?: string; message?: string } }[] }
    ).failures?.[0];
    assert.strictEqual(failure?.error?.code, 'INVALID_INPUT');
    assert.match(failure?.error?.message ?? '', /NTFS alternate data streams are not supported/);
    assert.doesNotMatch(failure?.error?.message ?? '', /EINVAL|\.tmp/);
  });

  it('TC-FUNC-009t: move copy:true refuses an NTFS stream destination and writes nothing', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('alternate data streams are an NTFS feature');
      return;
    }
    const source = join(tmpDir, 'ads-src.txt');
    await writeFile(source, 'body');
    const before = await readdir(tmpDir);
    const result = await harness.client.callTool({
      name: 'move',
      arguments: {
        copy: true,
        moves: [{ source, destination: join(tmpDir, 'ads-dst.txt:hidden') }],
      },
    });
    assert.strictEqual(result.isError, true);
    const failure = (
      result._meta as { failures?: { error?: { code?: string; message?: string } }[] } | undefined
    )?.failures?.[0];
    assert.strictEqual(failure?.error?.code, 'INVALID_INPUT');
    assert.match(failure?.error?.message ?? '', /NTFS alternate data streams are not supported/);
    assert.deepStrictEqual(await readdir(tmpDir), before, 'no ads-dst.txt host file was created');
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

  it('TC-FUNC-010c: deleting an allowed root through an aliasing junction is refused', async (t) => {
    const top = await createTestRoot();
    const a = join(top, 'a');
    const b = join(a, 'b');
    try {
      await mkdir(b, { recursive: true });
      await writeFile(join(b, 'keep.txt'), 'keep');
      if (!(await trySymlink(a, join(a, 'j'), () => t.skip('symlink creation not permitted')))) {
        return;
      }
      const pair = await createTestClientPair([a, b]);
      try {
        const result = await pair.client.callTool({
          name: 'delete',
          arguments: { paths: [join(a, 'j', 'b')], recursive: true },
        });
        assert.strictEqual(result.isError, true);
        assert.match(firstTextBlock(result).text ?? '', /workspace root/i);
        await access(join(b, 'keep.txt'));
      } finally {
        await pair.close();
      }
    } finally {
      await cleanupTestRoot(top);
    }
  });

  it('a missing path under an out-of-root junction answers ACCESS_DENIED, not NOT_FOUND', async (t) => {
    const top = await createTestRoot();
    const root = join(top, 'root');
    const outside = join(top, 'outside');
    try {
      await mkdir(root);
      await mkdir(outside);
      if (
        !(await trySymlink(outside, join(root, 'out'), () =>
          t.skip('symlink creation not permitted'),
        ))
      ) {
        return;
      }
      const pair = await createTestClientPair([root]);
      try {
        const escaping = await pair.client.callTool({
          name: 'stat',
          arguments: { path: join(root, 'out', 'nope') },
        });
        const escapingText = firstTextBlock(escaping).text ?? '';
        assert.match(escapingText, /ACCESS_DENIED/);
        assert.doesNotMatch(escapingText, /NOT_FOUND/);

        const inside = await pair.client.callTool({
          name: 'stat',
          arguments: { path: join(root, 'nope') },
        });
        assert.match(firstTextBlock(inside).text ?? '', /NOT_FOUND/);

        const read = await pair.client.callTool({
          name: 'read',
          arguments: { path: join(root, 'out', 'nope') },
        });
        assert.strictEqual(read.isError, true);
        assert.doesNotMatch(firstTextBlock(read).text ?? '', /not found/i);
      } finally {
        await pair.close();
      }
    } finally {
      await cleanupTestRoot(top);
    }
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

  it('tools/call arguments over MAX_TOOL_INPUT_ELEMENTS are answered with a tool error before schema validation', async () => {
    // 1000 is `read`'s own schema cap; this payload is far past it, so only
    // the SDK's structural count can be the error that comes back.
    const paths = Array.from(
      { length: MAX_TOOL_INPUT_ELEMENTS + 1 },
      (_, i) => `${tmpDir}/never-${String(i)}.txt`,
    );
    const result = await harness.client.callTool({ name: 'read', arguments: { paths } });
    assert.strictEqual(result.isError, true);
    const text = (result.content as { type: string; text?: string }[])
      .map((c) => c.text ?? '')
      .join('\n');
    assert.match(
      text,
      new RegExp(`more than the maximum of ${String(MAX_TOOL_INPUT_ELEMENTS)} elements`),
    );
    assert.ok(!text.includes('Input validation error'), 'the cap must fire before the schema');
  });

  it('the largest schema-legal edit batch (5 files x 100 edits) is not refused by the element cap', async () => {
    // 2 top-level members + 5 files + 5x2 file members + 500 edits + 500x2
    // edit members = 1517 nodes. Must stay well under MAX_TOOL_INPUT_ELEMENTS;
    // if a schema cap is ever raised past the headroom, this test is the alarm.
    const files = await Promise.all(
      Array.from({ length: 5 }, async (_, f) => {
        const path = join(tmpDir, `cap-${String(f)}.txt`);
        await writeFile(path, 'unrelated content\n');
        return {
          path,
          edits: Array.from({ length: 100 }, (_, e) => ({
            oldText: `absent-${String(f)}-${String(e)}`,
            newText: '',
          })),
        };
      }),
    );
    // The tool may legitimately report unmatched oldText as an error; only the
    // element-cap message would mean the cap refused a schema-legal call.
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: { files, dryRun: true },
    });
    const text = (result.content as { type: string; text?: string }[])
      .map((c) => c.text ?? '')
      .join('\n');
    assert.notStrictEqual(result.isError, true, text.slice(0, 300));
    assert.ok(!/more than the maximum of \d+ elements/.test(text), text.slice(0, 300));
  });

  it('tools/list publishes slimmed schemas and preserves Zod runtime semantics', async () => {
    const pinHarness = await createTestClientPair([tmpDir]);
    try {
      const { tools } = await pinHarness.client.listTools();
      assert.ok(tools.length > 0);
      for (const tool of tools) {
        // The wire copy is the SDK's own conversion of the Zod schema: no $defs
        // and no $ref anywhere — clients whose converter cannot follow a $ref
        // fall back to serializing the arguments (issue #51).
        assert.strictEqual(
          (tool.inputSchema as { $defs?: unknown }).$defs,
          undefined,
          `${tool.name} must publish a dereferenced input schema without $defs`,
        );
        assert.ok(
          !JSON.stringify(tool.inputSchema).includes('"$ref"'),
          `${tool.name} must publish an input schema without $ref`,
        );
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

  it('edit reports a change it could not diff instead of "(no change)"', async () => {
    const lines = (prefix: string, n: number): string =>
      Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`).join('\n') + '\n';
    const before = lines('a', 20000);
    const after = lines('b', 20000);
    // A whole-file rewrite outruns DIFF_TIMEOUT_MS: the edit still applies, so the
    // summary must not claim "(no change)".
    const file = await writeTestFile(tmpDir, 'edit-diff-timeout.txt', before);
    const edits = [{ oldText: before, newText: after }];

    const preview = await harness.client.callTool({
      name: 'edit',
      arguments: { path: file, edits, dryRun: true },
    });
    assert.notStrictEqual(preview.isError, true);
    assert.strictEqual(
      firstTextBlock(preview).text ?? '',
      'edit: edit-diff-timeout.txt changed (too many lines to diff) [dry run]',
    );
    assert.strictEqual(await readFile(file, 'utf-8'), before);

    const applied = await harness.client.callTool({
      name: 'edit',
      arguments: { path: file, edits },
    });
    assert.notStrictEqual(applied.isError, true);
    assert.match(
      firstTextBlock(applied).text ?? '',
      /^edit: edit-diff-timeout\.txt changed \(too many lines to diff\) · undo \S+$/u,
    );
    assert.strictEqual(await readFile(file, 'utf-8'), after);

    // An identical replacement is still a true no-op in the summary.
    const same = await harness.client.callTool({
      name: 'edit',
      arguments: { path: file, edits: [{ oldText: 'b0\n', newText: 'b0\n' }] },
    });
    assert.notStrictEqual(same.isError, true);
    assert.match(firstTextBlock(same).text ?? '', /^edit: edit-diff-timeout\.txt \(no change\)/u);
  });

  it('edit refuses an empty or blank oldText with one message', async () => {
    const file = join(tmpDir, 'edit-blank-old.txt');
    await writeFile(file, 'original content');
    for (const oldText of ['', '   ']) {
      const result = await harness.client.callTool({
        name: 'edit',
        arguments: { path: file, edits: [{ oldText, newText: 'x' }] },
      });
      assert.strictEqual(result.isError, true, JSON.stringify(oldText));
      const text = firstTextBlock(result).text ?? '';
      assert.match(text, /oldText cannot be empty or whitespace-only/u);
      assert.doesNotMatch(text, /oldText required/u);
    }
    assert.strictEqual(await readFile(file, 'utf-8'), 'original content');
  });

  it('recovers arguments a client serialized and spread into indexed keys (issue #51)', async () => {
    const file = join(tmpDir, 'edit-split-args.txt');
    await writeFile(file, 'original content');
    const payload = { path: file, edits: [{ oldText: 'original', newText: 'modified' }] };
    // A string spread into an object is what such clients put on the wire:
    // { "0": "{", "1": "\"", … }.
    const spread = (text: string): Record<string, unknown> =>
      Object.fromEntries(text.split('').entries());
    const recovered = await harness.client.callTool({
      name: 'edit',
      arguments: spread(JSON.stringify(payload)),
    });
    assert.notStrictEqual(recovered.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'modified content');

    for (const encoded of ['abc', JSON.stringify(['not', 'an', 'object'])]) {
      const rejected = await harness.client.callTool({
        name: 'edit',
        arguments: spread(encoded),
      });
      assert.strictEqual(rejected.isError, true);
      const text = firstTextBlock(rejected).text ?? '';
      assert.match(
        text,
        new RegExp(`arrived as a ${String(encoded.length)}-character string`, 'u'),
      );
      assert.doesNotMatch(text, /Unrecognized keys/u);
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
    assert.strictEqual(await readFile(file, 'utf-8'), 'f() {\n    go();\n}\n');
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

  // The flexible match absorbs the file's indentation, so newText written at
  // oldText's indentation must be mapped back onto the file's own.
  it('edit with ignoreWhitespace re-indents newText to the matched lines', async () => {
    const spaces = await writeTestFile(
      tmpDir,
      'reindent/spaces.js',
      'function f() {\n    if (x) {\n        y();\n    }\n}\n',
    );
    const spaced = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: spaces,
        edits: [{ oldText: 'if (x) {\n  y();\n}', newText: 'if (x) {\n  z();\n}' }],
        ignoreWhitespace: true,
      },
    });
    assert.notStrictEqual(spaced.isError, true);
    assert.strictEqual(
      await readFile(spaces, 'utf-8'),
      'function f() {\n    if (x) {\n        z();\n    }\n}\n',
    );

    // The file's tabs are reused literally, and an inserted line takes the
    // indentation of the oldText line it is indented like.
    const tabs = await writeTestFile(tmpDir, 'reindent/tabs.js', '\tif (x) {\n\t\ty();\n\t}\n');
    const tabbed = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: tabs,
        edits: [{ oldText: 'if (x) {\n  y();\n}', newText: 'if (x) {\n  z();\n  w();\n}' }],
        ignoreWhitespace: true,
      },
    });
    assert.notStrictEqual(tabbed.isError, true);
    assert.strictEqual(await readFile(tabs, 'utf-8'), '\tif (x) {\n\t\tz();\n\t\tw();\n\t}\n');
  });

  // A timing guard, not a regression catcher: the old quadratic code was also fast at 2000 lines.
  it('edit with ignoreWhitespace re-indents a 2000-line block well inside the deadline', async () => {
    const body = Array.from({ length: 2_000 }, (_, i) => `    v${String(i)} = ${String(i)};`);
    const file = await writeTestFile(tmpDir, 'reindent/huge.js', `${body.join('\n')}\n`);
    const withExtra = [body[0], '    extra();', ...body.slice(1)];
    const started = Date.now();
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: body.join('\n'), newText: withExtra.join('\n') }],
        ignoreWhitespace: true,
      },
    });
    const elapsed = Date.now() - started;
    assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
    assert.ok(elapsed < 2000, `took ${String(elapsed)} ms`);
    assert.strictEqual(await readFile(file, 'utf-8'), `${withExtra.join('\n')}\n`);
  });

  it('edit with ignoreWhitespace applies a 5,000-line oldText (#157)', async () => {
    const body = `${Array.from({ length: 5_000 }, (_, i) => `    v${String(i)} = ${String(i)};`).join('\n')}\n`;
    const file = await writeTestFile(tmpDir, 'flex/big-old.js', body);
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: body.replaceAll('    ', '  '), newText: 'done();\n' }],
        ignoreWhitespace: true,
      },
    });
    assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
    assert.strictEqual(await readFile(file, 'utf-8'), 'done();\n');
  });

  it('edit with ignoreWhitespace edits a 9 MB file (#157)', async () => {
    const filler = '    filler_line_with_some_text = 12345;\n';
    const file = await writeTestFile(
      tmpDir,
      'flex/big-file.txt',
      `${filler.repeat(240_000)}    unique_marker();\n`,
    );
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'unique_marker();', newText: 'done();' }],
        ignoreWhitespace: true,
      },
    });
    assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
    assert.ok((await readFile(file, 'utf-8')).endsWith('    done();\n'));
  });

  it('edit with ignoreWhitespace stays fast on repetitive near-matches', async () => {
    // Sized for the coverage run, which slows the walk about eightfold.
    const file = await writeTestFile(tmpDir, 'flex/repetitive.txt', 'a\n'.repeat(20_000));
    const started = Date.now();
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        // Every line is a candidate walked 100 lines deep before it fails:
        // the walk is candidates × oldText, so this catches a walk that grows
        // with the file per candidate.
        edits: [{ oldText: `${'a\n'.repeat(100)}b`, newText: 'x' }],
        ignoreWhitespace: true,
        dryRun: true,
      },
    });
    const elapsed = Date.now() - started;
    // A dry run reports an unmatched edit without failing.
    assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
    assert.ok(elapsed < 2000, `took ${String(elapsed)} ms`);
  });

  it('edit with ignoreWhitespace matches an NBSP oldText against the same NBSP', async () => {
    const file = await writeTestFile(tmpDir, 'flex/nbsp.txt', 'a b\n');
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'a b', newText: 'ok' }],
        ignoreWhitespace: true,
      },
    });
    assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
    assert.strictEqual(await readFile(file, 'utf-8'), 'ok\n');
  });

  it('edit rejects an oldText holding an unpaired surrogate', async () => {
    for (const half of ['\ud83d', '\ude00']) {
      for (const ignoreWhitespace of [false, true]) {
        const file = await writeTestFile(tmpDir, 'flex/surrogate.txt', '😀\n');
        const result = await harness.client.callTool({
          name: 'edit',
          arguments: { path: file, edits: [{ oldText: half, newText: 'X' }], ignoreWhitespace },
        });
        const label = `${JSON.stringify(half)} ignoreWhitespace=${String(ignoreWhitespace)}`;
        assert.strictEqual(result.isError, true, label);
        assert.match(firstTextBlock(result).text ?? '', /unpaired surrogate/u, label);
        assert.strictEqual(await readFile(file, 'utf-8'), '😀\n', label);
      }
    }
  });

  it('edit with ignoreWhitespace keeps a file-leading BOM out of the indentation', async () => {
    const file = await writeTestFile(tmpDir, 'flex/bom.py', '﻿# header\npass\n');
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: ' # header\npass', newText: ' # header\n # inserted\npass' }],
        ignoreWhitespace: true,
      },
    });
    assert.notStrictEqual(result.isError, true, firstTextBlock(result).text);
    assert.strictEqual(await readFile(file, 'utf-8'), '﻿ # header\n # inserted\npass\n');
  });

  it('edit with ignoreWhitespace keeps the file indentation of a flattened oldText in a CRLF file', async () => {
    const file = await writeTestFile(
      tmpDir,
      'reindent/crlf.js',
      'function f() {\r\n    if (x) {\r\n        y();\r\n    }\r\n}\r\n',
    );
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'y();\n}', newText: 'w();\n}' }],
        ignoreWhitespace: true,
      },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(
      await readFile(file, 'utf-8'),
      'function f() {\r\n    if (x) {\r\n        w();\r\n    }\r\n}\r\n',
    );
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

  it('edit refuses path with edits and files in one call, writing nothing', async () => {
    const f = await writeTestFile(tmpDir, 'edit_both_forms.txt', 'one\n');
    const spec = [{ oldText: 'one', newText: 'two' }];
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: { path: f, edits: spec, files: [{ path: f, edits: spec }] },
    });
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /Provide exactly one of 'path' or 'files'/u);
    assert.strictEqual(await readFile(f, 'utf-8'), 'one\n');
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

  it('create counts the per-file size cap in UTF-8 bytes, not UTF-16 units', async () => {
    await withEnv({ FS_MAX_FILE_SIZE: String(1024 * 1024) }, async () => {
      const limit = getMaxTextFileSize();
      assert.strictEqual(limit, 1048576);
      // '€' is 1 UTF-16 unit but 3 UTF-8 bytes: 349526 units, 1048578 bytes.
      const over = '€'.repeat(Math.floor(limit / 3) + 1);
      assert.ok(over.length < limit);
      assert.strictEqual(Buffer.byteLength(over, 'utf8'), 1048578);
      const overPath = join(tmpDir, 'bytes-cap-over.txt');
      const refused = await harness.client.callTool({
        name: 'create',
        arguments: { files: [{ path: overPath, content: over }] },
      });
      assert.strictEqual(refused.isError, true);
      assert.match(
        firstTextBlock(refused).text ?? '',
        /Content exceeds maximum allowed text file size/u,
      );
      await assert.rejects(stat(overPath), { code: 'ENOENT' });

      // Exactly at the limit in bytes is accepted.
      const exact = '€'.repeat(Math.floor(limit / 3)) + 'x'.repeat(limit % 3);
      assert.strictEqual(Buffer.byteLength(exact, 'utf8'), limit);
      const exactPath = join(tmpDir, 'bytes-cap-exact.txt');
      const ok = await harness.client.callTool({
        name: 'create',
        arguments: { files: [{ path: exactPath, content: exact }] },
      });
      assert.notStrictEqual(ok.isError, true);
      assert.strictEqual((await stat(exactPath)).size, limit);
    });
  });

  it('create counts the combined batch cap in UTF-8 bytes', async () => {
    await withEnv({ FS_MAX_FILE_SIZE: String(1024 * 1024) }, async () => {
      const limit = getMaxTextFileSize();
      // Each entry is under the per-file cap. Together they are over it in bytes (1048584) but not in units (349528).
      const part = '€'.repeat(Math.ceil(limit / 6) + 1);
      const totalBytes = 2 * Buffer.byteLength(part, 'utf8');
      assert.ok(2 * part.length < limit);
      assert.strictEqual(totalBytes, 1048584);
      const result = await harness.client.callTool({
        name: 'create',
        arguments: {
          files: [
            { path: join(tmpDir, 'bytes-batch-a.txt'), content: part },
            { path: join(tmpDir, 'bytes-batch-b.txt'), content: part },
          ],
        },
      });
      assert.strictEqual(result.isError, true);
      assert.match(
        firstTextBlock(result).text ?? '',
        /combined content is 1048584 bytes; one create call carries at most 1048576 \(FS_MAX_FILE_SIZE\)\. Split the batch\./u,
      );
    });
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

  it('move with a nonexistent source fails NOT_FOUND naming the source', async () => {
    const src = join(tmpDir, 'move_missing_src.txt');
    const dst = join(tmpDir, 'move_missing_dst.txt');

    const result = await harness.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: src, destination: dst }] },
    });
    assert.strictEqual(result.isError, true);
    const meta = result._meta as {
      failures?: { error?: { code?: string; path?: string; suggestion?: string } }[];
    };
    assert.strictEqual(meta.failures?.length, 1);
    assert.strictEqual(meta.failures?.[0]?.error?.code, 'NOT_FOUND');
    assert.strictEqual(meta.failures?.[0]?.error?.path, src);
    assert.doesNotMatch(meta.failures?.[0]?.error?.suggestion ?? '', /list_roots/);
  });

  it('copy with a nonexistent source fails NOT_FOUND naming the source', async () => {
    const src = join(tmpDir, 'copy_missing_src.txt');
    const dst = join(tmpDir, 'copy_missing_dst.txt');

    const result = await harness.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: src, destination: dst }], copy: true },
    });
    assert.strictEqual(result.isError, true);
    const meta = result._meta as { failures?: { error?: { code?: string; path?: string } }[] };
    assert.strictEqual(meta.failures?.[0]?.error?.code, 'NOT_FOUND');
    assert.strictEqual(meta.failures?.[0]?.error?.path, src);
  });

  it('move of a dangling symlink still moves the link itself', async (t) => {
    const link = join(tmpDir, 'move_dangling_link');
    const dst = join(tmpDir, 'move_dangling_link_moved');
    const target = join(tmpDir, 'move_dangling_gone.txt');
    if (!(await trySymlink(target, link, () => t.skip('symlink creation not permitted'), 'file'))) {
      return;
    }

    const result = await harness.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: link, destination: dst }] },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual((await lstat(dst)).isSymbolicLink(), true);
    assert.strictEqual(await readlink(dst), target);
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
    const outsideDir = await createTestRoot();
    const outsideFile = await writeTestFile(outsideDir, 'outside_copy.txt', 'secret');
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
      await cleanupTestRoot(outsideDir);
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
    // The ResourceStore's list-changed hook is the channel every transport
    // routes resources/list_changed through.
    const state = createRuntimeState(
      { cliAllowedDirs: [rootDir] },
      {
        onResourcesChanged: () => {
          notified = true;
        },
      },
    );

    try {
      await withBoundary(parentDir, async () => {
        const serverCtx = await createServer({ cliAllowedDirs: [rootDir] }, { state });
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
      state.dispose();
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

  it('read continuations remain usable beyond line 100,000', async () => {
    const file = await writeTestFile(tmpDir, 'long-lines.txt', `${'x\n'.repeat(100000)}last\n`);
    const first = await harness.client.callTool({
      name: 'read',
      arguments: { path: file, head: 100000 },
    });
    assert.notStrictEqual(first.isError, true);
    const meta = first._meta as {
      results: {
        value: { continuation: { args: { path: string; startLine: number; endLine: number } } };
      }[];
    };
    const continuation = meta.results[0]?.value.continuation;
    assert.ok(continuation);
    assert.strictEqual(continuation.args.startLine, 100001);
    const next = await harness.client.callTool({ name: 'read', arguments: continuation.args });
    assert.notStrictEqual(next.isError, true);
    assert.strictEqual(firstTextBlock(next).text, 'last');
  });

  it('a continuation of a range ending at the endLine maximum stays within the schema', async () => {
    const limit = 1024 * 1024;
    await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
      // Twice the size limit, so the range read stops early with lines left.
      const file = await writeTestFile(tmpDir, 'max-end.txt', `${'z'.repeat(99)}\n`.repeat(20000));
      const first = await harness.client.callTool({
        name: 'read',
        arguments: { path: file, startLine: 1, endLine: 2147483647 },
      });
      assert.notStrictEqual(first.isError, true);
      const meta = first._meta as {
        results: {
          value: { continuation?: { args: { path: string; startLine: number; endLine: number } } };
        }[];
      };
      const continuation = meta.results[0]?.value.continuation;
      assert.ok(continuation);
      assert.strictEqual(continuation.args.endLine, 2147483647);
      const next = await harness.client.callTool({ name: 'read', arguments: continuation.args });
      assert.notStrictEqual(next.isError, true, firstTextBlock(next).text?.slice(0, 200));
    });
  });

  it('an endLine past the maximum is refused once, not once per bound', async () => {
    const file = await writeTestFile(tmpDir, 'past-max.txt', 'a\n');
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: file, startLine: 1, endLine: 2147483648 },
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(firstTextBlock(result).text?.match(/endLine: Too big/g)?.length, 1);
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

  it('patch refuses a zero-context hunk past the end of the file and writes nothing', async () => {
    const f = join(tmpDir, 'patch_past_end.txt');
    await writeFile(f, 'a\nb\n');
    for (const diff of [
      '--- f.txt\n+++ f.txt\n@@ -10,0 +11,1 @@\n+X\n',
      '--- f.txt\n+++ f.txt\n@@ -3,0 +4,1 @@\n+X\n',
    ]) {
      const result = await harness.client.callTool({ name: 'patch', arguments: { path: f, diff } });
      assert.strictEqual(result.isError, true);
      assert.match(firstTextBlock(result).text ?? '', /would duplicate or drop lines/u);
      assert.strictEqual(await readFile(f, 'utf-8'), 'a\nb\n');
    }
  });

  it("edit dryRun reports the file's own modified time", async () => {
    const file = await writeTestFile(tmpDir, 'edit_dry_mtime.txt', 'alpha\n');
    const old = new Date('2001-01-01T00:00:00Z');
    await utimes(file, old, old);
    const result = await harness.client.callTool({
      name: 'edit',
      arguments: { path: file, edits: [{ oldText: 'alpha', newText: 'ALPHA' }], dryRun: true },
    });
    assert.notStrictEqual(result.isError, true);
    const value = (result._meta as { results: { value?: { modified?: string } }[] }).results[0]
      ?.value;
    assert.strictEqual(value?.modified, '2001-01-01T00:00:00.000Z');
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

  it('list includeSizes shows sizes and a totals line (#99)', async () => {
    const sub = join(tmpDir, 'sizes_dir');
    await mkdir(join(sub, 'dir1'), { recursive: true });
    await writeFile(join(sub, 'a.txt'), '12345');
    await writeFile(join(sub, 'b.txt'), 'x'.repeat(1024));
    await writeFile(join(sub, 'c.txt'), 'x'.repeat(1536));

    const result = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, includeSizes: true },
    });
    const text = firstTextBlock(result).text ?? '';
    assert.match(text, /a\.txt \(5 B\)/);
    assert.match(text, /b\.txt \(1 KiB\)/);
    assert.match(text, /c\.txt \(1\.5 KiB\)/);
    assert.match(text, /dir1\/$/m);
    assert.match(text, /^\/\/ 3 files, 1 directory, 2\.5 KiB total$/m);

    const meta = result._meta as {
      totalFiles?: number;
      totalDirectories?: number;
      totalBytes?: number;
      entries?: { name: string; type: string; size?: number }[];
    };
    assert.strictEqual(meta.totalFiles, 3);
    assert.strictEqual(meta.totalDirectories, 1);
    assert.strictEqual(meta.totalBytes, 2565);
    const fileSizes = meta.entries
      ?.filter((e) => e.type === 'file')
      .map((e) => ({ name: e.name, size: e.size }));
    assert.deepStrictEqual(fileSizes, [
      { name: 'a.txt', size: 5 },
      { name: 'b.txt', size: 1024 },
      { name: 'c.txt', size: 1536 },
    ]);
    assert.strictEqual(formatByteSize(1024 * 1024 - 1), '1 MiB');
  });

  it('list includeSizes pluralizes directories in the totals line', async () => {
    const many = join(tmpDir, 'sizes_many_dirs');
    await mkdir(join(many, 'd1'), { recursive: true });
    await mkdir(join(many, 'd2'), { recursive: true });
    await writeFile(join(many, 'a.txt'), '12345');
    const manyText =
      firstTextBlock(
        await harness.client.callTool({
          name: 'list',
          arguments: { path: many, includeSizes: true },
        }),
      ).text ?? '';
    assert.match(manyText, /^\/\/ 1 file, 2 directories, 5 B total$/m);

    const flat = join(tmpDir, 'sizes_no_dirs');
    await mkdir(flat, { recursive: true });
    await writeFile(join(flat, 'a.txt'), '12345');
    const flatText =
      firstTextBlock(
        await harness.client.callTool({
          name: 'list',
          arguments: { path: flat, includeSizes: true },
        }),
      ).text ?? '';
    assert.match(flatText, /^\/\/ 1 file, 0 directories, 5 B total$/m);
  });

  it('list sortBy size orders files largest first within each directory (#99)', async () => {
    const sub = join(tmpDir, 'sort_dir');
    await mkdir(join(sub, 'mid'), { recursive: true });
    await writeFile(join(sub, 'big.txt'), 'x'.repeat(2000));
    await writeFile(join(sub, 'small.txt'), 'x'.repeat(10));
    await writeFile(join(sub, 'zero.txt'), '');
    await writeFile(join(sub, 'mid', 'mid.txt'), 'x'.repeat(100));

    const result = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxDepth: 2, includeSizes: true, sortBy: 'size' },
    });
    const text = firstTextBlock(result).text ?? '';
    assert.match(text, /mid\/\n│ {3}└── mid\.txt \(100 B\)/);
    assert.match(text, /big\.txt \(2 KiB\)[\s\S]*small\.txt \(10 B\)[\s\S]*zero\.txt \(0 B\)/);
  });

  it('list default output carries no sizes and no totals line (#99)', async () => {
    const sub = join(tmpDir, 'default_dir');
    await mkdir(join(sub, 'dir1'), { recursive: true });
    await writeFile(join(sub, 'a.txt'), '12345');

    const result = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub },
    });
    const text = firstTextBlock(result).text ?? '';
    assert.doesNotMatch(text, /\(\d/);
    assert.doesNotMatch(text, /\/\//);

    const meta = result._meta as {
      totalBytes?: number;
      entries?: { name: string; size?: number }[];
    };
    assert.strictEqual('totalBytes' in meta, false);
    assert.strictEqual(meta.entries?.[0]?.size, undefined);
  });

  it('list includeSizes leaves secret files out of the totals (#99)', async () => {
    const sub = join(tmpDir, 'secrets_dir');
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, '.env'), 'SECRET=1');
    await writeFile(join(sub, 'plain.txt'), 'x');

    const result = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, includeHidden: true, includeSizes: true },
    });
    const text = firstTextBlock(result).text ?? '';
    assert.doesNotMatch(text, /\.env/);

    const meta = result._meta as {
      totalFiles?: number;
      totalBytes?: number;
      entries?: { name: string }[];
    };
    assert.strictEqual(meta.totalFiles, 1);
    assert.strictEqual(meta.totalBytes, 1);
    assert.deepStrictEqual(
      meta.entries?.map((e) => e.name),
      ['plain.txt'],
    );
  });

  it('list includeSizes pages with sizes intact (#99)', async () => {
    const sub = join(tmpDir, 'pages_dir');
    await mkdir(sub, { recursive: true });
    for (let i = 0; i < 4; i++) {
      await writeFile(join(sub, `f${String(i)}.txt`), 'x'.repeat(i + 1));
    }

    const first = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2, includeSizes: true, sortBy: 'size' },
    });
    const m1 = first._meta as {
      totalBytes?: number;
      entryCount?: number;
      nextCursor?: string;
      entries?: { name: string; size?: number }[];
    };
    assert.strictEqual(m1.totalBytes, 10);
    assert.strictEqual(m1.entryCount, 2);
    assert.deepStrictEqual(
      m1.entries?.map((e) => e.name),
      ['f3.txt', 'f2.txt'],
    );
    assert.match(firstTextBlock(first).text ?? '', /f3\.txt \(4 B\)[\s\S]*f2\.txt \(3 B\)/);

    const second = await harness.client.callTool({
      name: 'list',
      arguments: {
        path: sub,
        maxEntries: 2,
        includeSizes: true,
        sortBy: 'size',
        cursor: m1.nextCursor,
      },
    });
    const m2 = second._meta as {
      totalBytes?: number;
      entries?: { name: string; size?: number }[];
    };
    assert.deepStrictEqual(
      m2.entries?.map((e) => e.name),
      ['f1.txt', 'f0.txt'],
    );
    assert.match(firstTextBlock(second).text ?? '', /f1\.txt \(2 B\)[\s\S]*f0\.txt \(1 B\)/);
    assert.strictEqual(m2.totalBytes, 10);

    const replay = await harness.client.callTool({
      name: 'list',
      arguments: {
        path: sub,
        maxEntries: 2,
        includeSizes: false,
        sortBy: 'size',
        cursor: m1.nextCursor,
      },
    });
    assert.strictEqual(replay.isError, true);
    assert.match(firstTextBlock(replay).text ?? '', /Invalid cursor/);
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
    assert.deepStrictEqual(paths, ['scoped_ignored/keep.txt']);

    const searched = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: sub, searchPattern: 'NEEDLE_G' },
    });
    const files =
      (searched._meta as { matches?: { file: string }[] }).matches?.map((m) => m.file) ?? [];
    assert.deepStrictEqual(files, ['scoped_ignored/keep.txt']);

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
    assert.deepStrictEqual(allPaths.sort(), ['scoped_ignored/drop.log', 'scoped_ignored/keep.txt']);
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

  it('TC-FUNC-063a: list returns a partial result after a timeout', async (t) => {
    t.mock.method(AbortSignal, 'timeout', () =>
      AbortSignal.abort(new DOMException('test timeout', 'TimeoutError')),
    );
    const result = await harness.client.callTool({
      name: 'list',
      arguments: { path: tmpDir, includeIgnored: true },
    });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual((result._meta as { stoppedReason?: string }).stoppedReason, 'timeout');
    assert.match(firstTextBlock(result).text ?? '', /scan stopped early: hit the time limit/);
  });

  it('list past its entry cap reports maxResults in its metadata', () => {
    const collected = {
      entries: [],
      totalEntries: MAX_LIST_ENTRIES + 1,
      totalFiles: MAX_LIST_ENTRIES + 1,
      totalDirectories: 0,
      skippedInaccessible: 0,
    };
    assert.strictEqual(listPageMetadata('root', collected).stoppedReason, 'maxResults');
    const timedOut = { ...collected, stoppedReason: 'timeout' as const };
    assert.strictEqual(listPageMetadata('root', timedOut).stoppedReason, 'timeout');
    const exact = { ...collected, totalEntries: MAX_LIST_ENTRIES };
    assert.strictEqual(listPageMetadata('root', exact).stoppedReason, undefined);
  });

  it('list reports a deadline that fires during a size stat', async (t) => {
    const dir = join(tmpDir, 'list_timeout_stat');
    await writeTestFile(dir, 'a.txt', 'x');
    const controller = new AbortController();
    t.mock.method(AbortSignal, 'timeout', () => controller.signal);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
    const realStat = GuardedFileSystem.prototype.stat;
    t.mock.method(
      GuardedFileSystem.prototype,
      'stat',
      async function (this: GuardedFileSystem, ...a: Parameters<typeof realStat>) {
        if (!a[0].endsWith('a.txt')) return realStat.apply(this, a);
        // Fire once list's abort race is armed, as a real stat would.
        await setImmediatePromise();
        const timeout = new DOMException('test timeout', 'TimeoutError');
        controller.abort(timeout);
        throw timeout;
      },
    );
    const result = await harness.client.callTool({
      name: 'list',
      arguments: { path: dir, includeSizes: true },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual((result._meta as { stoppedReason?: string }).stoppedReason, 'timeout');
  });

  it('a timed-out list externalizes a partial tree', async (t) => {
    const dir = join(tmpDir, 'list_timeout_partial');
    for (let i = 0; i < 20; i++) await writeTestFile(dir, `f${String(i)}.txt`, 'x');
    const controller = new AbortController();
    t.mock.method(AbortSignal, 'timeout', () => controller.signal);
    // A pre-aborted walk collects nothing, so the deadline fires on the third tick.
    let ticks = 0;
    t.mock.method(ProgressSession.prototype, 'set', () => {
      if (++ticks === 3) controller.abort(new DOMException('test timeout', 'TimeoutError'));
    });
    const result = await harness.client.callTool({
      name: 'list',
      arguments: { path: dir, maxEntries: 2 },
    });

    assert.notStrictEqual(result.isError, true);
    const meta = result._meta as { resourceUri?: string; stoppedReason?: string };
    assert.strictEqual(meta.stoppedReason, 'timeout');
    assert.ok(meta.resourceUri, 'a partial first page still carries the full-tree URI');
    const resource = await harness.client.readResource({ uri: meta.resourceUri });
    const first = resource.contents[0];
    const tree = JSON.parse(first && 'text' in first ? first.text : '{}') as {
      stoppedReason?: string;
      truncated?: boolean;
    };
    assert.strictEqual(tree.stoppedReason, 'timeout');
    assert.strictEqual(tree.truncated, true);
  });

  it('list counts an unreadable directory', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX directory permissions as non-root');
    }
    const dir = join(tmpDir, 'list_locked');
    const locked = join(dir, 'locked');
    await writeTestFile(dir, 'a.ts', 'x');
    await writeTestFile(dir, 'locked/x.ts', 'x');
    await chmod(locked, 0o000);
    try {
      const result = await harness.client.callTool({
        name: 'list',
        arguments: { path: dir, maxDepth: 3 },
      });
      const meta = result._meta as {
        entries?: { relativePath: string }[];
        skippedInaccessible?: number;
      };
      assert.strictEqual(meta.skippedInaccessible, 1);
      assert.ok(meta.entries?.some((e) => e.relativePath === 'locked'));
      assert.match(JSON.stringify(result.content), /1 inaccessible entry/);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('list does not probe a directory at the depth bound', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX directory permissions as non-root');
    }
    const dir = join(tmpDir, 'list_bound');
    const locked = join(dir, 'locked');
    await writeTestFile(dir, 'a.ts', 'x');
    await writeTestFile(dir, 'locked/x.ts', 'x');
    await chmod(locked, 0o000);
    try {
      const result = await harness.client.callTool({
        name: 'list',
        arguments: { path: dir, maxDepth: 1 },
      });
      const meta = result._meta as {
        entries?: { relativePath: string }[];
        skippedInaccessible?: number;
      };
      assert.strictEqual(meta.skippedInaccessible ?? 0, 0);
      assert.ok(meta.entries?.some((e) => e.relativePath === 'locked'));
      assert.doesNotMatch(JSON.stringify(result.content), /may be incomplete/);
    } finally {
      await chmod(locked, 0o755);
    }
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

  it('TC-FUNC-067b: a client without elicitation gets a tool error for a move onto an existing file', async () => {
    const eh = await createElicitationClientPair(
      [tmpDir],
      async () => {
        throw new Error('the server must not ask a client that cannot answer');
      },
      { noElicitation: true },
    );
    try {
      const src = await writeTestFile(tmpDir, 'move_no_elicit_src.txt', 'src\n');
      const dst = await writeTestFile(tmpDir, 'move_no_elicit_dst.txt', 'dst\n');
      const result = await eh.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dst }] },
      });
      assert.strictEqual(result.isError, true, 'must surface as a tool error');
      assert.match(firstTextBlock(result).text ?? '', /confirmation this client cannot show/i);
      assert.strictEqual(await readFile(src, 'utf-8'), 'src\n');
      assert.strictEqual(await readFile(dst, 'utf-8'), 'dst\n');
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

    // A case-insensitive literal search must keep the replacement verbatim.
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

  it('replace_text case-insensitive literal replaces 300 matches in a 3 MB file well inside the deadline', async () => {
    const line = `${'x'.repeat(9990)} Needle\n`;
    const file = await writeTestFile(tmpDir, 'ci_literal/big.txt', line.repeat(300));
    const started = Date.now();
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: file, searchPattern: 'NEEDLE', replacement: 'pin' },
    });
    const elapsed = Date.now() - started;
    assert.notStrictEqual(result.isError, true);
    const meta = result._meta as { totalMatches: number; stoppedReason?: string };
    assert.strictEqual(meta.stoppedReason, undefined);
    assert.strictEqual(meta.totalMatches, 300);
    assert.ok(elapsed < 2000, `took ${String(elapsed)} ms`);
    assert.strictEqual(await readFile(file, 'utf-8'), `${'x'.repeat(9990)} pin\n`.repeat(300));
  });

  it('replace_text case-insensitive literal rewrites exactly what the escaped RE2 regex rewrites', async () => {
    const KELVIN = String.fromCodePoint(0x212a); // RE2 folds it onto k
    const LONG_S = String.fromCodePoint(0x017f); // RE2 folds it onto s
    const DOTTED_I = String.fromCodePoint(0x0130); // RE2 does not fold it onto i
    const EMOJI = String.fromCodePoint(0x1f600);
    const cases: { content: string; needle: string; matches: number }[] = [
      { content: `x ${KELVIN}ey key KEY\n`, needle: 'key', matches: 3 },
      { content: `${LONG_S}tate STATE state\n`, needle: 'state', matches: 3 },
      { content: `${DOTTED_I}d id ID\n`, needle: 'id', matches: 2 },
      { content: `${EMOJI}${EMOJI} Needle needle\n`, needle: 'needle', matches: 2 },
      { content: 'aaaa aAaA\n', needle: 'aa', matches: 4 },
      { content: 'line one\r\nLINE two\r\n', needle: 'line', matches: 2 },
      { content: 'STRASSE straße Straße\n', needle: 'Straße', matches: 2 },
      { content: 'É e E é\n', needle: 'e', matches: 2 },
      { content: 'a.b*c axbbc A.B*C\n', needle: 'a.b*c', matches: 2 },
    ];
    for (const [i, c] of cases.entries()) {
      const literal = await writeTestFile(tmpDir, `ci_parity/lit${String(i)}.txt`, c.content);
      const regex = await writeTestFile(tmpDir, `ci_parity/re${String(i)}.txt`, c.content);
      // '<$&>' must land verbatim from a literal; '<$$&>' is the same text from a regex.
      const lit = await harness.client.callTool({
        name: 'replace_text',
        arguments: { path: literal, searchPattern: c.needle, replacement: '<$&>' },
      });
      await harness.client.callTool({
        name: 'replace_text',
        arguments: {
          path: regex,
          searchPattern: escapeRegExp(c.needle),
          replacement: '<$$&>',
          isRegex: true,
        },
      });
      const rewritten = await readFile(literal, 'utf-8');
      assert.strictEqual(rewritten, await readFile(regex, 'utf-8'), `case ${String(i)}`);
      assert.strictEqual(
        (lit._meta as { totalMatches: number }).totalMatches,
        c.matches,
        `case ${String(i)}: ${rewritten}`,
      );
    }
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

  it('replace_text transforms a hard-linked file once per run, dry run and live alike', async (t) => {
    const a = await writeTestFile(tmpDir, 'hardlink_once/a.txt', 'x\n');
    const b = join(dirname(a), 'b.txt');
    try {
      await link(a, b);
    } catch (error) {
      t.skip(`hard links not supported here: ${String(error)}`);
      return;
    }
    const totalMatches = async (dryRun: boolean) => {
      const result = await harness.client.callTool({
        name: 'replace_text',
        arguments: {
          path: dirname(a),
          searchPattern: 'x',
          replacement: 'xx',
          caseSensitive: true,
          dryRun,
        },
      });
      assert.notStrictEqual(result.isError, true, `dryRun=${String(dryRun)}`);
      return (result._meta as { totalMatches: number }).totalMatches;
    };
    assert.strictEqual(await totalMatches(true), 1, 'dry run counts the shared bytes once');
    assert.strictEqual(await totalMatches(false), 1, 'live run counts the shared bytes once');
    assert.strictEqual(await readFile(a, 'utf-8'), 'xx\n');
    assert.strictEqual(await readFile(b, 'utf-8'), 'xx\n');
  });

  it('replace_text converts LF literal text to CRLF in a CRLF file', async () => {
    const call = async (args: Record<string, unknown>) => {
      const result = await harness.client.callTool({ name: 'replace_text', arguments: args });
      assert.notStrictEqual(result.isError, true);
      return (result._meta as { totalMatches: number }).totalMatches;
    };

    // Case-sensitive literal: the Buffer matcher.
    const sensitive = await writeTestFile(
      tmpDir,
      'rt-crlf/sensitive.txt',
      'one\r\ntwo\r\nthree\r\n',
    );
    assert.strictEqual(
      await call({
        path: sensitive,
        searchPattern: 'one\ntwo',
        replacement: 'uno\ndos',
        caseSensitive: true,
      }),
      1,
    );
    assert.strictEqual(await readFile(sensitive, 'utf-8'), 'uno\r\ndos\r\nthree\r\n');

    // Default caseSensitive: false compiles an RE2 regex from the escaped literal.
    const insensitive = await writeTestFile(tmpDir, 'rt-crlf/insensitive.txt', 'One\r\nTwo\r\n');
    assert.strictEqual(
      await call({ path: insensitive, searchPattern: 'one\ntwo', replacement: 'x\ny' }),
      1,
    );
    assert.strictEqual(await readFile(insensitive, 'utf-8'), 'x\r\ny\r\n');

    // A leading newline must take the \r with it, not leave \r\r\n.
    const leading = await writeTestFile(tmpDir, 'rt-crlf/leading.txt', 'a\r\nb\r\n');
    assert.strictEqual(
      await call({ path: leading, searchPattern: '\nb', replacement: '\nc', caseSensitive: true }),
      1,
    );
    assert.strictEqual(await readFile(leading, 'utf-8'), 'a\r\nc\r\n');

    // A single-line pattern with a multi-line replacement keeps the file all-CRLF.
    const grow = await writeTestFile(tmpDir, 'rt-crlf/grow.txt', 'one\r\ntwo\r\n');
    assert.strictEqual(
      await call({
        path: grow,
        searchPattern: 'two',
        replacement: 'two\nhalf',
        caseSensitive: true,
      }),
      1,
    );
    assert.strictEqual(await readFile(grow, 'utf-8'), 'one\r\ntwo\r\nhalf\r\n');

    // Mixed endings have no one ending to convert to: nothing matches, file untouched.
    const mixed = await writeTestFile(tmpDir, 'rt-crlf/mixed/mixed.txt', 'mixed\r\nlf\n');
    await call({ path: mixed, searchPattern: 'mixed\nlf', replacement: 'x', caseSensitive: true });
    assert.strictEqual(await readFile(mixed, 'utf-8'), 'mixed\r\nlf\n');

    // isRegex is taken as written: \n does not match \r\n.
    const regex = await writeTestFile(tmpDir, 'rt-crlf/regex/regex.txt', 'one\r\ntwo\r\n');
    await call({ path: regex, searchPattern: 'one\\ntwo', replacement: 'x', isRegex: true });
    assert.strictEqual(await readFile(regex, 'utf-8'), 'one\r\ntwo\r\n');

    // One directory run picks the ending per file.
    const crlfFile = await writeTestFile(tmpDir, 'rt-crlf/dir/crlf.txt', 'p\r\nq\r\n');
    const lfFile = await writeTestFile(tmpDir, 'rt-crlf/dir/lf.txt', 'p\nq\n');
    assert.strictEqual(
      await call({ path: join(tmpDir, 'rt-crlf/dir'), searchPattern: 'p\nq', replacement: 'r\ns' }),
      2,
    );
    assert.strictEqual(await readFile(crlfFile, 'utf-8'), 'r\r\ns\r\n');
    assert.strictEqual(await readFile(lfFile, 'utf-8'), 'r\ns\n');
  });

  it('replace_text refuses a file over the text size limit with the shared TOO_LARGE wording', async () => {
    const limit = 1024 * 1024;
    await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
      const big = await writeTestFile(tmpDir, 'size_cap/big.txt', 'FIND\n' + 'x'.repeat(limit));
      const refused = await harness.client.callTool({
        name: 'replace_text',
        arguments: { path: big, searchPattern: 'FIND', replacement: 'FOUND' },
      });
      assert.strictEqual(refused.isError, true);
      assert.match(
        firstTextBlock(refused).text ?? '',
        /big\.txt: TOO_LARGE File exceeds size limit/,
      );
      assert.ok((await readFile(big, 'utf-8')).startsWith('FIND\n'), 'file must be untouched');
    });
  });

  it('replace_text counts walked files over the text size limit in skippedTooLarge', async () => {
    const limit = 1024 * 1024;
    await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
      const dir = join(tmpDir, 'size_cap_rows');
      const a = await writeTestFile(dir, 'a/big.txt', 'FIND\n' + 'x'.repeat(limit));
      const b = await writeTestFile(dir, 'b/big.txt', 'FIND\n' + 'x'.repeat(limit));
      const swept = await harness.client.callTool({
        name: 'replace_text',
        arguments: { path: dir, searchPattern: 'FIND', replacement: 'FOUND' },
      });
      assert.notStrictEqual(swept.isError, true);
      const meta = swept._meta as { summary: { failed: number }; skippedTooLarge?: number };
      assert.strictEqual(meta.skippedTooLarge, 2);
      assert.strictEqual(meta.summary.failed, 0);
      assert.match(firstTextBlock(swept).text ?? '', /2 too large skipped/);
      assert.ok((await readFile(a, 'utf-8')).startsWith('FIND\n'));
      assert.ok((await readFile(b, 'utf-8')).startsWith('FIND\n'));
    });
  });

  it('replace_text refuses a $` expansion that grows a file past the text size limit, dry run included', async () => {
    await withEnv({ FS_MAX_FILE_SIZE: String(1024 * 1024) }, async () => {
      // 2 KiB of 'a' with $` per match grows quadratically: about 2 MB uncapped, past the 1 MiB limit.
      // Small enough that each RE2 exec stays cheap under coverage instrumentation.
      const original = 'a'.repeat(2 * 1024);
      const file = await writeTestFile(tmpDir, 'out_cap/prefix.txt', original);
      for (const dryRun of [true, false]) {
        const refused = await harness.client.callTool({
          name: 'replace_text',
          arguments: { path: file, searchPattern: 'a', replacement: '$`', isRegex: true, dryRun },
        });
        assert.strictEqual(refused.isError, true, `dryRun=${String(dryRun)}`);
        const failure = failedSummary(refused)?.results?.[0]?.error;
        assert.strictEqual(failure?.code, 'TOO_LARGE');
        assert.strictEqual(
          failure?.message,
          'Replacement result exceeds the size limit (more than 1048576 bytes)',
        );
        assert.match(
          firstTextBlock(refused).text ?? '',
          /prefix\.txt: TOO_LARGE Replacement result exceeds/,
        );
        assert.strictEqual(await readFile(file, 'utf-8'), original, 'file must be untouched');
      }
    });
  });

  it('replace_text fails only the walked file whose literal replacement outgrows the limit', async () => {
    await withEnv({ FS_MAX_FILE_SIZE: String(1024 * 1024) }, async () => {
      const dir = join(tmpDir, 'out_cap_walk');
      // 1000 matches x 2000 chars = 2,000,000 bytes > 1 MiB.
      const blow = await writeTestFile(dir, 'blow.txt', 'x'.repeat(1000));
      const ok = await writeTestFile(dir, 'ok.txt', 'x\n');
      const swept = await harness.client.callTool({
        name: 'replace_text',
        arguments: {
          path: dir,
          searchPattern: 'x',
          replacement: 'y'.repeat(2000),
          caseSensitive: true,
        },
      });
      assert.notStrictEqual(swept.isError, true);
      const meta = swept._meta as { summary: { total: number; succeeded: number; failed: number } };
      assert.deepStrictEqual(meta.summary, { total: 2, succeeded: 1, failed: 1 });
      assert.strictEqual(
        failedSummary(swept)?.results?.find((r) => r.error)?.error?.code,
        'TOO_LARGE',
      );
      assert.strictEqual(await readFile(blow, 'utf-8'), 'x'.repeat(1000));
      assert.strictEqual(await readFile(ok, 'utf-8'), 'y'.repeat(2000) + '\n');
    });
  });

  it('replace_text caps the result in UTF-8 bytes, not UTF-16 units, and allows exactly the limit', async () => {
    const limit = 1024 * 1024;
    await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
      // '€' is 1 UTF-16 unit but 3 UTF-8 bytes: 349526 of them are 1048578 bytes.
      const over = await writeTestFile(tmpDir, 'out_cap_utf8/over.txt', 'a'.repeat(349526));
      const refused = await harness.client.callTool({
        name: 'replace_text',
        arguments: { path: over, searchPattern: 'a', replacement: '€', caseSensitive: true },
      });
      assert.strictEqual(refused.isError, true);
      assert.strictEqual(failedSummary(refused)?.results?.[0]?.error?.code, 'TOO_LARGE');
      assert.strictEqual(await readFile(over, 'utf-8'), 'a'.repeat(349526));

      // 349525 x '€' plus one 'b' is exactly 1048576 bytes: at the limit, not over it.
      const exact = await writeTestFile(tmpDir, 'out_cap_utf8/exact.txt', 'a'.repeat(349525) + 'b');
      const allowed = await harness.client.callTool({
        name: 'replace_text',
        arguments: { path: exact, searchPattern: 'a', replacement: '€', caseSensitive: true },
      });
      assert.notStrictEqual(allowed.isError, true);
      assert.strictEqual((await stat(exact)).size, limit);
    });
  });

  it('replace_text failure rows name same-named files by their full relative paths', async () => {
    const dir = join(tmpDir, 'regex_cap_rows');
    const body = 'x'.repeat(RE2_MAX_INPUT_BYTES + 1 - 5) + 'FIND\n';
    await writeTestFile(dir, 'a/big.txt', body);
    await writeTestFile(dir, 'b/big.txt', body);
    const swept = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: 'FIND', replacement: 'FOUND', isRegex: true },
    });
    assert.strictEqual(swept.isError, true);
    const text = firstTextBlock(swept).text ?? '';
    assert.match(text, /a\/big\.txt: TOO_LARGE/);
    assert.match(text, /b\/big\.txt: TOO_LARGE/);
  });

  it('replace_text counts a binary file without a match', async () => {
    const dir = join(tmpDir, 'binrep_nomatch');
    await writeTestFile(dir, 'text.txt', 'foo\n');
    await writeFile(join(dir, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02]));
    const swept = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: 'foo', replacement: 'bar' },
    });
    assert.strictEqual((swept._meta as { skippedBinary?: number }).skippedBinary, 1);
  });

  it('replace_text refuses a named binary file without a match', async () => {
    const blob = join(tmpDir, 'binrep_named/blob.bin');
    await mkdir(dirname(blob), { recursive: true });
    await writeFile(blob, Buffer.from([0x01, 0x00, 0x02]));
    const single = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: blob, searchPattern: 'zzz', replacement: 'bar' },
    });
    assert.strictEqual(single.isError, true);
    const r = single._meta as { results: { error?: { code: string } }[] };
    assert.strictEqual(r.results[0]?.error?.code, 'INVALID_INPUT');
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

  it('replace_text counts an unreadable directory', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX permissions as non-root');
    }
    const dir = join(tmpDir, 'replace_locked');
    const locked = join(dir, 'locked');
    await writeTestFile(dir, 'a.ts', 'needle');
    await writeTestFile(dir, 'locked/x.ts', 'needle');
    await chmod(locked, 0o000);
    try {
      const result = await harness.client.callTool({
        name: 'replace_text',
        arguments: { path: dir, searchPattern: 'needle', replacement: 'pin', dryRun: true },
      });
      const meta = result._meta as { skippedInaccessible?: number; summary: { failed: number } };
      assert.strictEqual(meta.skippedInaccessible, 1);
      assert.strictEqual(meta.summary.failed, 0);
      const text = firstTextBlock(result).text ?? '';
      assert.match(text, /1 inaccessible skipped/u);
      assert.doesNotMatch(text, /no files were searched/u);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('replace_text counts an EACCES file instead of failing it', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX permissions as non-root');
    }
    const dir = join(tmpDir, 'replace_eacces');
    await writeTestFile(dir, 'a.txt', 'needle');
    const b = await writeTestFile(dir, 'b.txt', 'needle');
    await chmod(b, 0o000);
    try {
      const result = await harness.client.callTool({
        name: 'replace_text',
        arguments: { path: dir, searchPattern: 'needle', replacement: 'pin', dryRun: true },
      });
      const meta = result._meta as { skippedInaccessible?: number; summary: { failed: number } };
      assert.strictEqual(meta.skippedInaccessible, 1);
      assert.strictEqual(meta.summary.failed, 0);
    } finally {
      await chmod(b, 0o644);
    }
  });

  it('replace_text results and diff follow walk order', async (t) => {
    const dir = join(tmpDir, 'replace_walk_order');
    for (let i = 0; i < 12; i++) {
      await writeTestFile(dir, `a${String(i).padStart(2, '0')}.txt`, 'needle\n');
    }
    // The walk follows the directory's own order, which only NTFS sorts.
    const first = (await readdir(dir))[0] ?? '';
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
    const realOpen = GuardedFileSystem.prototype.open;
    let opened = 0;
    let releaseFirst!: () => void;
    const othersOpened = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    t.mock.method(
      GuardedFileSystem.prototype,
      'open',
      async function (this: GuardedFileSystem, ...a: Parameters<typeof realOpen>) {
        if (basename(dirname(a[0])) === 'replace_walk_order') {
          // Three others: fewer than the smallest pool (4) and scan window (8),
          // which hold later files back until the first one settles.
          if (++opened === 4) releaseFirst();
          // The walk's first file finishes last.
          if (basename(a[0]) === first) await othersOpened;
        }
        return realOpen.apply(this, a);
      },
    );
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: 'needle', replacement: 'pin', dryRun: true },
    });
    const meta = result._meta as { results: { path: string }[]; diff?: string };
    assert.strictEqual(meta.results[0]?.path, `replace_walk_order/${first}`);
    assert.strictEqual(
      /^\+\+\+ ([^\t\n]+)/mu.exec(meta.diff ?? '')?.[1],
      `replace_walk_order/${first}`,
    );
  });

  it('replace_text interleaves changed and failure results in walk order', async (t) => {
    const dir = join(tmpDir, 'replace_mixed_walk_order');
    await writeTestFile(dir, 'a.txt', 'needle\n');
    await writeTestFile(dir, 'b.txt', 'needle\n');
    const order = await readdir(dir);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
    const realOpen = GuardedFileSystem.prototype.open;
    t.mock.method(
      GuardedFileSystem.prototype,
      'open',
      async function (this: GuardedFileSystem, ...a: Parameters<typeof realOpen>) {
        // By name: the guard lower-cases a Windows drive letter, so a joined path never matches.
        if (basename(dirname(a[0])) === 'replace_mixed_walk_order' && basename(a[0]) === order[0]) {
          throw new FsError(ErrorCode.TOO_LARGE, 'File exceeds size limit', a[0]);
        }
        return realOpen.apply(this, a);
      },
    );
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: 'needle', replacement: 'pin', dryRun: true },
    });
    const meta = result._meta as {
      results: { path: string; value?: { matches: number }; error?: { code: string } }[];
    };
    assert.deepStrictEqual(
      meta.results.map((r) => r.path),
      order.map((name) => `replace_mixed_walk_order/${name}`),
    );
    assert.strictEqual(meta.results[0]?.error?.code, 'TOO_LARGE');
    assert.strictEqual(meta.results[1]?.value?.matches, 1);
  });

  it('replace_text keeps the walk-first failure rows and holds no error past its entry', async (t) => {
    const dir = join(tmpDir, 'replace_failures');
    const count = 25;
    for (let i = 0; i < count; i++) {
      await writeTestFile(dir, `f${String(i).padStart(2, '0')}.txt`, 'needle\n');
    }
    // The walk follows the directory's own order, which only NTFS sorts.
    const order = (await readdir(dir)).map((name) => `replace_failures/${name}`);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
    const realOpen = GuardedFileSystem.prototype.open;
    let opened = 0;
    let releaseFirst!: () => void;
    const othersOpened = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    t.mock.method(
      GuardedFileSystem.prototype,
      'open',
      async function (this: GuardedFileSystem, ...a: Parameters<typeof realOpen>) {
        if (basename(dirname(a[0])) !== 'replace_failures') return realOpen.apply(this, a);
        // Three others: fewer than the smallest pool (4), so the walk's first file fails last.
        if (++opened === 4) releaseFirst();
        if (`replace_failures/${basename(a[0])}` === order[0]) await othersOpened;
        throw new FsError(ErrorCode.TOO_LARGE, 'File exceeds size limit', a[0]);
      },
    );
    // Whatever scan keeps until the walk ends goes through its results Map.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
    const realSet = Map.prototype.set;
    let heldErrors = 0;
    t.mock.method(
      Map.prototype,
      'set',
      function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
        if (typeof v === 'object' && v !== null && 'kind' in v && 'error' in v) heldErrors++;
        return realSet.call(this, k, v);
      },
    );
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: 'needle', replacement: 'pin', dryRun: true },
    });
    t.mock.restoreAll();
    assert.strictEqual(result.isError, true);
    const meta = result._meta as {
      results: { path: string; error?: { code: string } }[];
      summary: { total: number; succeeded: number; failed: number };
      resultsTruncated?: boolean;
    };
    assert.deepStrictEqual(
      meta.results.map((r) => r.path),
      order.slice(0, 20),
    );
    assert.ok(meta.results.every((r) => r.error?.code === 'TOO_LARGE'));
    assert.deepStrictEqual(meta.summary, { total: count, succeeded: 0, failed: count });
    assert.strictEqual(meta.resultsTruncated, true);
    assert.strictEqual(heldErrors, 0);
  });

  it('replace_text maxFiles ignores skipped entries', async () => {
    const dir = join(tmpDir, 'replace_max_files');
    await writeTestFile(dir, '.env', 'needle');
    await writeTestFile(dir, 'a.txt', 'needle');
    await writeTestFile(dir, 'b.txt', 'needle');
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: {
        path: dir,
        searchPattern: 'needle',
        replacement: 'pin',
        dryRun: true,
        includeHidden: true,
        maxFiles: 2,
      },
    });
    const meta = result._meta as { summary: { succeeded: number }; stoppedReason?: string };
    assert.strictEqual(meta.summary.succeeded, 2);
    assert.strictEqual(meta.stoppedReason, undefined);
  });

  it('replace_text maxFiles frees the slot of an EACCES file', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX permissions as non-root');
    }
    const dir = join(tmpDir, 'replace_max_files_eacces');
    await writeTestFile(dir, 'a.txt', 'needle');
    await writeTestFile(dir, 'b.txt', 'needle');
    // The walk follows readdir order: lock whichever file it visits first.
    const [lockedName = '', readableName = ''] = await readdir(dir);
    const locked = join(dir, lockedName);
    await chmod(locked, 0o000);
    try {
      const result = await harness.client.callTool({
        name: 'replace_text',
        arguments: { path: dir, searchPattern: 'needle', replacement: 'pin', maxFiles: 1 },
      });
      const meta = result._meta as { skippedInaccessible?: number; stoppedReason?: string };
      assert.strictEqual(meta.skippedInaccessible, 1);
      assert.strictEqual(meta.stoppedReason, undefined);
      assert.strictEqual(await readFile(join(dir, readableName), 'utf-8'), 'pin');
    } finally {
      await chmod(locked, 0o644);
    }
  });

  it('replace_text marks a diff cut by its budget', async () => {
    const dir = join(tmpDir, 'replace_diff_budget');
    // Each patch is just over 12 KiB, so the two together exceed the 20 KiB budget.
    const body = Array.from({ length: 300 }, (_, i) => `needle line ${String(i)} xxxxx`).join('\n');
    await writeTestFile(dir, 'a.txt', body);
    await writeTestFile(dir, 'b.txt', body);
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: 'needle', replacement: 'pin', dryRun: true },
    });
    const meta = result._meta as { diff?: string; diffTruncated?: boolean };
    assert.strictEqual(meta.diffTruncated, true);
    // The walk's first file keeps its diff; only NTFS sorts that to a.txt.
    const first = (await readdir(dir))[0];
    assert.deepStrictEqual(
      [...(meta.diff ?? '').matchAll(/^\+\+\+ ([^\t\n]+)/gmu)].map((m) => m[1]),
      [`replace_diff_budget/${first ?? ''}`],
    );
  });

  it('replace_text diff budget does not depend on completion order', async (t) => {
    // Patches of about 12 KiB, 12 KiB and 1 KiB in walk order: the second
    // never fits beside the first, and the third always does.
    const big = Array.from({ length: 300 }, (_, i) => `needle line ${String(i)} xxxxx`).join('\n');
    const setup = async (name: string): Promise<string[]> => {
      const dir = join(tmpDir, name);
      for (const file of ['a.txt', 'b.txt', 'c.txt']) await writeTestFile(dir, file, 'x');
      // The walk follows readdir order, which only NTFS sorts.
      const order = await readdir(dir);
      await writeTestFile(dir, order[0] ?? '', big);
      await writeTestFile(dir, order[1] ?? '', big);
      await writeTestFile(dir, order[2] ?? '', 'needle\n');
      return order;
    };
    const walkFirst = await setup('replace_budget_walk_first');
    const smallFirst = await setup('replace_budget_small_first');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
    const realOpen = GuardedFileSystem.prototype.open;
    t.mock.method(
      GuardedFileSystem.prototype,
      'open',
      async function (this: GuardedFileSystem, ...a: Parameters<typeof realOpen>) {
        const run = basename(dirname(a[0]));
        const name = basename(a[0]);
        // One run finishes in walk order, the other finishes the small third file first.
        if (run === 'replace_budget_walk_first' && name === walkFirst[2]) await sleep(100);
        if (run === 'replace_budget_small_first' && name !== smallFirst[2]) await sleep(100);
        return realOpen.apply(this, a);
      },
    );
    for (const [name, order] of [
      ['replace_budget_walk_first', walkFirst],
      ['replace_budget_small_first', smallFirst],
    ] as const) {
      const result = await harness.client.callTool({
        name: 'replace_text',
        arguments: {
          path: join(tmpDir, name),
          searchPattern: 'needle',
          replacement: 'pin',
          dryRun: true,
        },
      });
      const meta = result._meta as { diff?: string; diffTruncated?: boolean };
      assert.strictEqual(meta.diffTruncated, true, name);
      assert.deepStrictEqual(
        [...(meta.diff ?? '').matchAll(/^\+\+\+ ([^\t\n]+)/gmu)].map((m) => m[1]),
        [`${name}/${order[0] ?? ''}`, `${name}/${order[2] ?? ''}`],
        name,
      );
    }
  });

  it('replace_text keeps a patch a slower lower patch would leave room for', async (t) => {
    // Walk-order patches of about 10, 15 and 8 KiB: first-fit keeps the first
    // and third. Finishing the second, then the third, then the first must
    // not refuse the third against the second, which the first later displaces.
    const lines = (n: number): string =>
      Array.from({ length: n }, (_, i) => `needle line ${String(i)} xxxxx`).join('\n');
    const dir = join(tmpDir, 'replace_budget_displaced');
    for (const file of ['a.txt', 'b.txt', 'c.txt']) await writeTestFile(dir, file, 'x');
    // The walk follows readdir order, which only NTFS sorts.
    const order = await readdir(dir);
    await writeTestFile(dir, order[0] ?? '', lines(250));
    await writeTestFile(dir, order[1] ?? '', lines(375));
    await writeTestFile(dir, order[2] ?? '', lines(200));
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
    const realOpen = GuardedFileSystem.prototype.open;
    t.mock.method(
      GuardedFileSystem.prototype,
      'open',
      async function (this: GuardedFileSystem, ...a: Parameters<typeof realOpen>) {
        const name = basename(a[0]);
        if (name === order[0]) await sleep(200);
        if (name === order[2]) await sleep(100);
        return realOpen.apply(this, a);
      },
    );
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: 'needle', replacement: 'pin', dryRun: true },
    });
    const meta = result._meta as { diff?: string; diffTruncated?: boolean };
    assert.strictEqual(meta.diffTruncated, true);
    assert.deepStrictEqual(
      [...(meta.diff ?? '').matchAll(/^\+\+\+ ([^\t\n]+)/gmu)].map((m) => m[1]),
      [`replace_budget_displaced/${order[0] ?? ''}`, `replace_budget_displaced/${order[2] ?? ''}`],
    );
  });

  it('replace_text keeps the walk-first diffs that fit and skips the rest', async () => {
    const dir = join(tmpDir, 'replace_diff_prefix');
    // Each patch is about 5.6 KiB: three fit the 20 KiB budget, a fourth does not.
    const body = Array.from({ length: 130 }, (_, i) => `needle line ${String(i)} xxxxx`).join('\n');
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
      await writeTestFile(dir, name, body);
    }
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: 'needle', replacement: 'pin', dryRun: true },
    });
    const meta = result._meta as { diff?: string; diffTruncated?: boolean };
    assert.strictEqual(meta.diffTruncated, true);
    // fs.glob walks in readdir order.
    const walked = (await readdir(dir)).slice(0, 3).map((name) => `replace_diff_prefix/${name}`);
    assert.deepStrictEqual(
      [...(meta.diff ?? '').matchAll(/^\+\+\+ ([^\t\n]+)/gmu)].map((m) => m[1]),
      walked,
    );
  });

  it('replace_text drops a diff over the whole budget and keeps a small one', async () => {
    const dir = join(tmpDir, 'replace_diff_huge');
    // About 30 KiB of patch alone, past the 20 KiB budget.
    const huge = Array.from({ length: 700 }, (_, i) => `needle line ${String(i)} xxxxx`).join('\n');
    await writeTestFile(dir, 'huge.txt', huge);
    await writeTestFile(dir, 'small.txt', 'needle\n');
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: 'needle', replacement: 'pin', dryRun: true },
    });
    const meta = result._meta as { diff?: string; diffTruncated?: boolean };
    assert.strictEqual(meta.diffTruncated, true);
    assert.deepStrictEqual(
      [...(meta.diff ?? '').matchAll(/^\+\+\+ ([^\t\n]+)/gmu)].map((m) => m[1]),
      ['replace_diff_huge/small.txt'],
    );
  });

  it('replace_text on a named file stops at an explicit maxMatches mid-file', async () => {
    const file = await writeTestFile(tmpDir, 'replace_named_cap/a.txt', 'x x x x\n');
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: file, searchPattern: 'x', replacement: 'y', maxMatches: 2 },
    });
    const meta = result._meta as { totalMatches: number; stoppedReason?: string };
    assert.strictEqual(meta.totalMatches, 2);
    assert.strictEqual(meta.stoppedReason, 'maxMatches');
    assert.strictEqual(await readFile(file, 'utf8'), 'y y x x\n');
    assert.match(
      firstTextBlock(result).text ?? '',
      /hit the maxMatches limit; later matches were not replaced/u,
    );
    // The literal matcher honors the same cap.
    const literal = await writeTestFile(tmpDir, 'replace_named_cap/b.txt', 'x x x x\n');
    const capped = await harness.client.callTool({
      name: 'replace_text',
      arguments: {
        path: literal,
        searchPattern: 'x',
        replacement: 'y',
        caseSensitive: true,
        maxMatches: 3,
      },
    });
    assert.strictEqual((capped._meta as { totalMatches: number }).totalMatches, 3);
    assert.strictEqual(await readFile(literal, 'utf8'), 'y y y x\n');
  });

  it('replace_text on a named file with no maxMatches replaces past the default cap', async () => {
    const file = await writeTestFile(tmpDir, 'replace_named_nocap/a.txt', 'x '.repeat(150));
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: file, searchPattern: 'x', replacement: 'y', dryRun: true },
    });
    const meta = result._meta as { totalMatches: number; stoppedReason?: string };
    assert.strictEqual(meta.totalMatches, 150);
    assert.strictEqual(meta.stoppedReason, undefined);
  });

  it('replace_text maxMatches is a strict bound across files in flight', async () => {
    const dir = join(tmpDir, 'replace_strict_cap');
    // More files than REPLACE_CONCURRENCY (8), so the cap would be exceeded if files ran in parallel.
    for (let i = 0; i < 10; i++) await writeTestFile(dir, `${String(i)}.txt`, 'x\n');
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: dir, searchPattern: 'x', replacement: 'y', maxMatches: 3 },
    });
    const meta = result._meta as {
      totalMatches: number;
      stoppedReason?: string;
      summary: { succeeded: number };
    };
    assert.strictEqual(meta.totalMatches, 3);
    assert.strictEqual(meta.summary.succeeded, 3);
    assert.strictEqual(meta.stoppedReason, 'maxMatches');
    // Which three files are rewritten depends on readdir order, so only the count is pinned.
    let rewritten = 0;
    for (let i = 0; i < 10; i++) {
      if ((await readFile(join(dir, `${String(i)}.txt`), 'utf8')) === 'y\n') rewritten++;
    }
    assert.strictEqual(rewritten, 3);
  });

  it('replace_text maxMatches dry run previews exactly what the live run writes', async () => {
    const file = await writeTestFile(tmpDir, 'replace_preview_cap/a.txt', 'x x x x\n');
    const dry = await harness.client.callTool({
      name: 'replace_text',
      arguments: {
        path: file,
        searchPattern: 'x',
        replacement: 'y',
        dryRun: true,
        maxMatches: 2,
      },
    });
    assert.match(firstTextBlock(dry).text ?? '', /^\+y y x x$/mu);
    const live = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: file, searchPattern: 'x', replacement: 'y', maxMatches: 2 },
    });
    assert.strictEqual((dry._meta as { totalMatches: number }).totalMatches, 2);
    assert.strictEqual((live._meta as { totalMatches: number }).totalMatches, 2);
    assert.strictEqual(await readFile(file, 'utf8'), 'y y x x\n');
  });

  it('replace_text maxMatches on the regex path stops at the cap mid-file', async () => {
    const file = await writeTestFile(tmpDir, 'replace_regex_cap/a.txt', 'x x x x\n');
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: {
        path: file,
        searchPattern: 'x',
        replacement: 'y',
        isRegex: true,
        maxMatches: 2,
      },
    });
    assert.strictEqual((result._meta as { stoppedReason?: string }).stoppedReason, 'maxMatches');
    assert.strictEqual(await readFile(file, 'utf8'), 'y y x x\n');
  });

  it('replace_text does not report a cut for a named file refused as too large', async () => {
    const file = await writeTestFile(tmpDir, 'replace_cut_toolarge/a.txt', 'x'.repeat(1000));
    await withEnv({ FS_MAX_FILE_SIZE: String(1024 * 1024) }, async () => {
      const result = await harness.client.callTool({
        name: 'replace_text',
        arguments: {
          path: file,
          searchPattern: 'x',
          replacement: 'y'.repeat(2000),
          caseSensitive: true,
          maxMatches: 999,
        },
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(failedSummary(result)?.results?.[0]?.error?.code, 'TOO_LARGE');
      assert.strictEqual(await readFile(file, 'utf8'), 'x'.repeat(1000));
      assert.notStrictEqual(
        (result._meta as { stoppedReason?: string }).stoppedReason,
        'maxMatches',
      );
    });
  });

  it('replace_text does not report a cut when the UTF-8 size check refuses a capped file', async () => {
    // Two-byte replacement: the UTF-16 check passes at 999 matches, the UTF-8 check after the matcher does not.
    const file = await writeTestFile(tmpDir, 'replace_cut_utf8/a.txt', 'x'.repeat(1000));
    await withEnv({ FS_MAX_FILE_SIZE: String(1024 * 1024) }, async () => {
      const result = await harness.client.callTool({
        name: 'replace_text',
        arguments: {
          path: file,
          searchPattern: 'x',
          replacement: 'é'.repeat(1000),
          caseSensitive: true,
          maxMatches: 999,
        },
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(failedSummary(result)?.results?.[0]?.error?.code, 'TOO_LARGE');
      assert.strictEqual(await readFile(file, 'utf8'), 'x'.repeat(1000));
      assert.notStrictEqual(
        (result._meta as { stoppedReason?: string }).stoppedReason,
        'maxMatches',
      );
    });
  });

  it('replace_text maxResults still caps as a deprecated alias', async () => {
    // More files than replace_text dispatches at once, so the cap trips mid-sweep.
    for (let i = 0; i < 10; i++) {
      await writeTestFile(tmpDir, `replace_alias/${String(i)}.txt`, 'x\n');
    }
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: {
        path: join(tmpDir, 'replace_alias'),
        searchPattern: 'x',
        replacement: 'y',
        dryRun: true,
        maxResults: 1,
      },
    });
    const meta = result._meta as { totalMatches: number; stoppedReason?: string };
    assert.strictEqual(meta.stoppedReason, 'maxMatches');
    assert.strictEqual(meta.totalMatches, 1);
  });

  it('replace_text rejects maxMatches with maxResults', async () => {
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: {
        path: tmpDir,
        searchPattern: 'x',
        replacement: 'y',
        dryRun: true,
        maxMatches: 1,
        maxResults: 1,
      },
    });
    assert.strictEqual(result.isError, true);
    assert.match(
      firstTextBlock(result).text ?? '',
      /Cannot use both 'maxMatches' and 'maxResults'/u,
    );
  });

  it('replace_text publishes maxResults as deprecated', async () => {
    const { tools } = await harness.client.listTools();
    const props = tools.find((t) => t.name === 'replace_text')?.inputSchema.properties as {
      maxResults?: { deprecated?: boolean };
      maxMatches?: object;
    };
    assert.strictEqual(props.maxResults?.deprecated, true);
    assert.ok(props.maxMatches);
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
    // trips maxMatches=1 before the sweep ends.
    for (let i = 1; i < 10; i++) await writeTestFile(tmpDir, `preview/${String(i)}.txt`, 'alpha\n');
    const replace = await harness.client.callTool({
      name: 'replace_text',
      arguments: {
        path: join(tmpDir, 'preview'),
        searchPattern: 'alpha',
        replacement: 'ALPHA',
        dryRun: true,
        maxMatches: 1,
      },
    });
    const replaceText = firstTextBlock(replace).text ?? '';
    assert.match(replaceText, /^\+ALPHA$/mu);
    assert.ok(
      replaceText.includes('// scan stopped early: hit the maxMatches limit;'),
      replaceText,
    );
    assert.strictEqual((replace._meta as { stoppedReason?: string }).stoppedReason, 'maxMatches');
  });

  it('replace_text maxFiles stop keeps its reason', async () => {
    const dir = join(tmpDir, 'replace_max_files_stop');
    await writeTestFile(dir, 'a.txt', 'needle');
    await writeTestFile(dir, 'b.txt', 'needle');
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: {
        path: dir,
        searchPattern: 'needle',
        replacement: 'pin',
        dryRun: true,
        maxFiles: 1,
      },
    });
    assert.strictEqual((result._meta as { stoppedReason?: string }).stoppedReason, 'maxFiles');
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

  // RE2's \b is ASCII-only: it saw no boundary around "é"/"ü" and none at a
  // punctuation edge, so wholeWord matched inside words and skipped real ones.
  it('replace_text wholeWord treats non-ASCII letters and punctuation edges as word boundaries', async () => {
    const file = await writeTestFile(tmpDir, 'whole_word_unicode/a.txt', '');
    const cases = [
      {
        searchPattern: 'café',
        replacement: 'X',
        before: 'café cafés xcafé\n',
        after: 'X cafés xcafé\n',
        matches: 1,
      },
      {
        searchPattern: 'über',
        replacement: 'X',
        before: 'über Über xüber über_\n',
        after: 'X X xüber über_\n',
        matches: 2,
      },
      {
        searchPattern: '-x',
        replacement: 'Y',
        before: '-x a-x a -x\n',
        after: 'Y a-x a Y\n',
        matches: 2,
      },
      // Adjacent words share one separator: every one still matches.
      { searchPattern: 'a', replacement: 'b', before: 'a a a\n', after: 'b b b\n', matches: 3 },
      // A combining mark is part of the word it follows.
      { searchPattern: 'x', replacement: 'Y', before: 'x́ x\n', after: 'x́ Y\n', matches: 1 },
      // An astral non-letter is a boundary on either side.
      {
        searchPattern: 'über',
        replacement: 'X',
        before: '😀über über😀 ü\n',
        after: '😀X X😀 ü\n',
        matches: 2,
      },
    ];
    for (const c of cases) {
      await writeFile(file, c.before);
      const result = await harness.client.callTool({
        name: 'replace_text',
        arguments: {
          path: file,
          searchPattern: c.searchPattern,
          replacement: c.replacement,
          wholeWord: true,
        },
      });
      assert.notStrictEqual(result.isError, true, c.before);
      assert.strictEqual(await readFile(file, 'utf-8'), c.after, c.before);
      assert.strictEqual(
        (result._meta as { totalMatches: number }).totalMatches,
        c.matches,
        c.before,
      );
    }
  });

  it('replace_text wholeWord with isRegex keeps the caller capture groups numbered from 1', async () => {
    const file = await writeTestFile(tmpDir, 'whole_word_groups/a.txt', 'ab xab ab\n');
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: {
        path: file,
        searchPattern: '(a)(b)',
        replacement: '$2$1[$&]',
        isRegex: true,
        caseSensitive: true,
        wholeWord: true,
      },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'ba[ab] xab ba[ab]\n');
  });

  it('replace_text wholeWord lets the boundary pick the regex alternative', async () => {
    const file = await writeTestFile(tmpDir, 'whole_word_alt/a.txt', '');
    const cases = [
      // RE2 must not stop at the first alternative that the boundary rejects.
      { searchPattern: 'foo|foobar', before: 'foobar foo\n', after: 'X X\n', matches: 2 },
      { searchPattern: 'a+?', before: 'aaa b\n', after: 'X b\n', matches: 1 },
      // A match's trailing character is the next match's leading one.
      { searchPattern: 'aa', before: 'aaa aa\n', after: 'aaa X\n', matches: 1 },
      { searchPattern: 'a', before: 'a a a\n', after: 'X X X\n', matches: 3 },
    ];
    for (const c of cases) {
      await writeFile(file, c.before);
      const result = await harness.client.callTool({
        name: 'replace_text',
        arguments: {
          path: file,
          searchPattern: c.searchPattern,
          replacement: 'X',
          isRegex: true,
          caseSensitive: true,
          wholeWord: true,
        },
      });
      assert.notStrictEqual(result.isError, true, c.searchPattern);
      assert.strictEqual(await readFile(file, 'utf-8'), c.after, c.searchPattern);
      assert.strictEqual(
        (result._meta as { totalMatches: number }).totalMatches,
        c.matches,
        c.searchPattern,
      );
    }
  });

  it('replace_text wholeWord lets a needle trailing non-word char lead the next match', async () => {
    const file = await writeTestFile(tmpDir, 'whole_word_trail/a.txt', '');
    const cases = [
      // The needle's final '-' is the next match's leading boundary.
      { searchPattern: '-x-', before: '-x--x-\n', after: 'XX\n', matches: 2 },
      // A one-char needle at text start: no progress is possible, so it must terminate.
      { searchPattern: '-', before: '-\n', after: 'X\n', matches: 1 },
      // Known limit (see the shortcut in execMatches): a one-char needle at text start with
      // a following non-word char cannot resume onto its own start, so the second '-' is missed.
      { searchPattern: '-', before: '--\n', after: 'X-\n', matches: 1 },
      {
        searchPattern: '-',
        before: 'a - -- b\n',
        after: 'a X XX b\n',
        matches: 3,
      },
    ];
    for (const c of cases) {
      await writeFile(file, c.before);
      const result = await harness.client.callTool({
        name: 'replace_text',
        arguments: {
          path: file,
          searchPattern: c.searchPattern,
          replacement: 'X',
          caseSensitive: true,
          wholeWord: true,
        },
      });
      assert.notStrictEqual(result.isError, true, c.before);
      assert.strictEqual(await readFile(file, 'utf-8'), c.after, c.before);
      assert.strictEqual(
        (result._meta as { totalMatches: number }).totalMatches,
        c.matches,
        c.before,
      );
    }
  });

  it('replace_text wholeWord maxMatches stops mid-run with its reason', async () => {
    const file = await writeTestFile(tmpDir, 'whole_word_max/a.txt', 'aa a a\n');
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: {
        path: file,
        searchPattern: 'a',
        replacement: 'X',
        caseSensitive: true,
        wholeWord: true,
        maxMatches: 1,
      },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual((result._meta as { stoppedReason?: string }).stoppedReason, 'maxMatches');
    assert.strictEqual(await readFile(file, 'utf-8'), 'aa X a\n');
  });

  it('TC-FUNC-014: find_files returns matched files via callTool', async () => {
    await writeTestFile(tmpDir, 'findme.txt', 'x');
    // The shared tmpDir holds more than find_files' default 100 results of *.txt.
    const result = await harness.client.callTool({
      name: 'find_files',
      arguments: { pattern: '**/findme.txt' },
    });
    assert.notStrictEqual(result.isError, true);
    const sc = result._meta as { results?: { path: string }[] };
    assert.ok(sc.results?.some((r) => r.path.endsWith('findme.txt')));
  });

  it('find_files counts an unreadable directory', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX directory permissions as non-root');
    }
    const dir = join(tmpDir, 'find_locked');
    const locked = join(dir, 'locked');
    await writeTestFile(dir, 'a.ts', 'x');
    await writeTestFile(dir, 'locked/x.ts', 'x');
    await chmod(locked, 0o000);
    try {
      const result = await harness.client.callTool({
        name: 'find_files',
        arguments: { path: dir, pattern: '**/*.ts' },
      });
      const meta = result._meta as { results?: { path: string }[]; skippedInaccessible?: number };
      assert.strictEqual(meta.skippedInaccessible, 1);
      assert.match(JSON.stringify(result.content), /1 inaccessible entry/);
      assert.deepStrictEqual(
        meta.results?.map((r) => basename(r.path)),
        ['a.ts'],
      );
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('find_files keeps the first results in walk order past its cap', () => {
    const over = keepFirstResults(
      { results: ['a', 'b', 'c'], scanned: 3, skippedInaccessible: 0 },
      2,
    );
    assert.deepStrictEqual(over, { results: ['a', 'b'], stoppedReason: 'maxResults' });
    const timedOut = keepFirstResults(
      { results: ['a', 'b', 'c'], scanned: 3, skippedInaccessible: 0, stoppedReason: 'timeout' },
      2,
    );
    assert.strictEqual(timedOut.stoppedReason, 'timeout');
    const exact = keepFirstResults({ results: ['a', 'b'], scanned: 2, skippedInaccessible: 0 }, 2);
    assert.deepStrictEqual(exact, { results: ['a', 'b'] });
  });

  it('find_files filters by pattern', async () => {
    const dir = join(tmpDir, 'find_filter');
    await writeTestFile(dir, 'moduleA.ts', 'x');
    await writeTestFile(dir, 'notes.txt', 'x');
    await writeTestFile(dir, 'sub/moduleC.ts', 'x');
    await writeTestFile(dir, 'sub/readme.txt', 'x');
    const find = async (pattern: string) => {
      const result = await harness.client.callTool({
        name: 'find_files',
        arguments: { path: dir, pattern },
      });
      return (result._meta as { results: { path: string }[] }).results;
    };
    const ts = await find('**/*.ts');
    assert.strictEqual(ts.length, 2);
    assert.ok(ts.every((r) => r.path.endsWith('.ts')));
    const txt = await find('**/*.txt');
    assert.strictEqual(txt.length, 2);
    assert.ok(txt.every((r) => r.path.endsWith('.txt')));
  });

  it("find_files sortBy 'name' orders by basename, not full path", async () => {
    const dir = join(tmpDir, 'find_sort');
    await writeTestFile(dir, 'zzz/alpha.ts', '// a');
    await writeTestFile(dir, 'aaa/omega.ts', '// o');
    const names = async (sortBy?: 'name') => {
      const result = await harness.client.callTool({
        name: 'find_files',
        arguments: { path: dir, pattern: '**/*.ts', ...(sortBy ? { sortBy } : {}) },
      });
      return (result._meta as { results: { path: string }[] }).results.map((r) => basename(r.path));
    };
    assert.deepStrictEqual(await names('name'), ['alpha.ts', 'omega.ts']);
    assert.deepStrictEqual(await names(), ['omega.ts', 'alpha.ts']);
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
      ['find_pages/bravo.txt', 'find_pages/charlie.txt'],
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
      ['basename_glob/sub/deep.ts', 'basename_glob/sub/top.ts', 'basename_glob/top.ts'],
    );

    const searched = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, pattern: 'deep.ts', searchPattern: 'NEEDLE' },
    });
    assert.deepStrictEqual(
      (searched._meta as { matches?: { file: string }[] }).matches?.map((m) => m.file),
      ['basename_glob/sub/deep.ts'],
    );

    // Naming a file must still search that file alone, not its namesake below.
    const named = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: join(dir, 'top.ts'), searchPattern: 'NEEDLE' },
    });
    assert.deepStrictEqual(
      (named._meta as { matches?: { file: string }[] }).matches?.map((m) => m.file),
      ['basename_glob/top.ts'],
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

  it('stat on a directory does not read as empty or world-writable (#56)', async () => {
    const dir = join(tmpDir, 'stat-dir-56');
    await mkdir(dir);
    await writeFile(join(dir, 'a.txt'), 'hello');
    await writeFile(join(dir, 'b.txt'), 'world');

    const result = await harness.client.callTool({ name: 'stat', arguments: { path: dir } });
    assert.notStrictEqual(result.isError, true);
    const sc = result.structuredContent as Record<string, unknown> & {
      results?: { value?: Record<string, unknown> & { type?: string } }[];
    };
    // Result-row type counts next to a directory entry read as "0 files inside".
    assert.ok(!('fileCount' in sc), 'fileCount must not be emitted');
    assert.ok(!('dirCount' in sc), 'dirCount must not be emitted');

    const value = sc.results?.[0]?.value;
    assert.ok(value, 'stat must return a value');
    assert.strictEqual(value.type, 'directory');
    // libuv reports 0 for every directory on Windows; ext4 says 4096. Neither
    // describes the contents, so no number is better than a misleading one.
    assert.ok(!('size' in value), 'a directory must not report a size');

    if (process.platform === 'win32') {
      // libuv synthesizes mode 0666/0444 from FILE_ATTRIBUTE_READONLY alone,
      // so a POSIX triad would claim group/other access it never checked.
      assert.strictEqual(value['permissions'], undefined);
      assert.strictEqual(value['readOnly'], false);
    } else {
      assert.strictEqual(typeof value['permissions'], 'string');
      assert.strictEqual(value['readOnly'], undefined);
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

  it('stat batch gives a missing path its own NOT_FOUND entry and keeps the rest', async () => {
    const present = await writeTestFile(tmpDir, 'stat_batch_present.txt', 'x');
    const missing = join(tmpDir, 'stat_batch_missing.txt');
    const result = await harness.client.callTool({
      name: 'stat',
      arguments: { paths: [present, missing] },
    });
    assert.notStrictEqual(result.isError, true);
    const { results } = result.structuredContent as {
      results: { value?: { type: string }; error?: { code: string } }[];
    };
    assert.strictEqual(results[0]?.value?.type, 'file');
    assert.strictEqual(results[1]?.error?.code, 'NOT_FOUND');
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
      ['globby/[slug].tsx'],
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
    assert.strictEqual(firstTextBlock(result).text, 'explicit_scope/.hidden.log:1: NEEDLE_SCOPE');
    const matches = (result._meta as { matches: { file: string; line: number }[] }).matches;
    assert.deepStrictEqual(
      matches.map(({ file, line }) => ({ file, line })),
      [{ file: 'explicit_scope/.hidden.log', line: 1 }],
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
    assert.deepStrictEqual(paths, ['globby/docs/v1..2.md']);
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
      ['phantom_line/blank.txt:2'],
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

  it('a page cursor replays only for the query that minted it, whatever the page size', async () => {
    const dir = join(tmpDir, 'cursor_identity');
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeTestFile(dir, name, 'NEEDLE\n');
    }
    const cases: {
      name: string;
      base: Record<string, unknown>;
      pageSize: string;
      changed: Record<string, unknown>[];
    }[] = [
      {
        name: 'list',
        base: { path: dir, maxEntries: 1 },
        pageSize: 'maxEntries',
        changed: [
          { path: tmpDir },
          { maxDepth: 2 },
          { includeHidden: true },
          { includeIgnored: true },
        ],
      },
      {
        name: 'find_files',
        base: { path: dir, pattern: '*.txt', maxResults: 1 },
        pageSize: 'maxResults',
        changed: [
          { path: tmpDir },
          { pattern: '*' },
          { includeIgnored: true },
          { includeHidden: true },
          { sortBy: 'name' },
          { maxDepth: 2 },
        ],
      },
      {
        name: 'search_text',
        base: { path: dir, searchPattern: 'NEEDLE', maxResults: 1 },
        pageSize: 'maxResults',
        changed: [
          { path: tmpDir },
          { pattern: '*.txt' },
          { searchPattern: 'NEEDL' },
          { isRegex: true },
          { includeHidden: true },
          { includeIgnored: true },
          { caseSensitive: true },
          { maxDepth: 2 },
          { context: 1 },
        ],
      },
    ];

    for (const { name, base, pageSize, changed } of cases) {
      const first = await harness.client.callTool({ name, arguments: base });
      const cursor = (first._meta as { nextCursor?: string } | undefined)?.nextCursor;
      assert.ok(cursor, `${name} must page`);

      const resized = await harness.client.callTool({
        name,
        arguments: { ...base, [pageSize]: 10, cursor },
      });
      assert.notStrictEqual(resized.isError, true, `${name}: a new page size still replays`);

      for (const change of changed) {
        const replay = await harness.client.callTool({
          name,
          arguments: { ...base, ...change, cursor },
        });
        assert.strictEqual(replay.isError, true, `${name} ${JSON.stringify(change)}`);
        assert.match(firstTextBlock(replay).text ?? '', /Invalid cursor/);
      }
    }

    // An omitted path defaults to the root; spelling the root out (as the guard
    // stores it) is the same query.
    const rootPage = await harness.client.callTool({
      name: 'list',
      arguments: { maxDepth: 2, maxEntries: 1 },
    });
    const rootCursor = (rootPage._meta as { nextCursor?: string } | undefined)?.nextCursor;
    assert.ok(rootCursor, 'root list must page');
    const spelled = await harness.client.callTool({
      name: 'list',
      arguments: { path: normalizePath(tmpDir), maxDepth: 2, maxEntries: 1, cursor: rootCursor },
    });
    assert.notStrictEqual(spelled.isError, true, JSON.stringify(spelled));
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
        ['grep_context/a.txt', 2, ['import x'], ['const y']],
        ['grep_context/a.txt', 4, ['const y'], ['}']],
        ['grep_context/b.txt', 2, ['foo'], ['bar']],
      ],
    );
    assert.ok(
      (firstTextBlock(result).text ?? '').startsWith(
        [
          'grep_context/a.txt-1- import x',
          'grep_context/a.txt:2: NEEDLE one',
          'grep_context/a.txt-3- const y',
          'grep_context/a.txt:4: NEEDLE two',
          'grep_context/a.txt-5- }',
          '--',
          'grep_context/b.txt-1- foo',
          'grep_context/b.txt:2: NEEDLE',
          'grep_context/b.txt-3- bar',
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
      [
        'grep_context_adjacent/c.txt-1- x',
        'grep_context_adjacent/c.txt:2: NEEDLE a',
        'grep_context_adjacent/c.txt:3: NEEDLE b',
      ].join('\n'),
    );
  });

  it('search_text clips a multi-megabyte match line and its context lines', async () => {
    const dir = join(tmpDir, 'grep_clip_long_line');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'big.txt'),
      'ctx' +
        'c'.repeat(2_000_000) +
        '\n' +
        'x'.repeat(1_000_000) +
        'NEEDLE' +
        'x'.repeat(1_000_000) +
        '\n',
    );

    const result = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, searchPattern: 'NEEDLE', context: 1 },
    });
    assert.notStrictEqual(result.isError, true);
    assert.ok((firstTextBlock(result).text ?? '').length < 5000);
    const structured = result._meta as {
      matches?: { column: number; content: string; before?: string[] }[];
    };
    const match = structured.matches?.[0];
    assert.ok(match);
    assert.ok(match.content.includes('NEEDLE'));
    assert.ok(match.content.startsWith('…['));
    assert.ok(match.content.endsWith(' chars]'));
    assert.ok(match.content.length < MAX_MATCH_LINE_CHARS + 100);
    assert.strictEqual(match.column, 1_000_000);
    const before = match.before?.[0];
    assert.ok(before !== undefined && before.length < MAX_MATCH_LINE_CHARS + 100);
  });

  it('search_text counts an unreadable directory', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX directory permissions as non-root');
    }
    const dir = join(tmpDir, 'search_locked');
    const locked = join(dir, 'locked');
    await writeTestFile(dir, 'a.ts', 'needle');
    await writeTestFile(dir, 'locked/x.ts', 'needle');
    await chmod(locked, 0o000);
    try {
      const result = await harness.client.callTool({
        name: 'search_text',
        arguments: { path: dir, searchPattern: 'needle' },
      });
      const meta = result._meta as { skippedInaccessible?: number };
      assert.strictEqual(meta.skippedInaccessible, 1);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('search_text on a named unreadable file fails the call', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX directory permissions as non-root');
    }
    const dir = join(tmpDir, 'search_named_locked');
    const file = join(dir, 'b.txt');
    await writeTestFile(dir, 'b.txt', 'needle');
    await chmod(file, 0o000);
    try {
      const result = await harness.client.callTool({
        name: 'search_text',
        arguments: { path: file, searchPattern: 'needle' },
      });
      assert.strictEqual(result.isError, true);
    } finally {
      await chmod(file, 0o644);
    }
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
        ((r._meta as { matches?: { file: string; line: number; column: number }[] }).matches ?? [])
          // Paths are root-relative; this test is about matching, so compare names.
          .map((m) => `${m.file.replace(/^prefilter_semantics\//u, '')}:${m.line}:${m.column}`)
          .sort()
      );
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
      const a = await searchContent({ root }, 'CAP_HIT', { maxResults: 7 }, guard);
      const b = await searchContent({ root }, 'CAP_HIT', { maxResults: 7 }, guard);
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
      const r = await searchContent({ root }, 'CAP_ONE', { maxResults: 5 }, guard);
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
      assert.strictEqual(
        firstTextBlock(beside).text,
        `skipped_big/small.txt:1: BIGNEEDLE\n\n${skipLine}`,
      );
    });
  });

  it('search_text and replace_text explain a zero-match result in the text (#55)', async () => {
    // A regex sent without isRegex, or a glob that selects no files, read
    // exactly like a genuine miss: filesScanned lives only in `_meta`.
    const dir = join(tmpDir, 'zero_hint');
    await writeTestFile(tmpDir, 'zero_hint/a.ts', 'const TOKEN1 = 1;\nconst token2 = 2;\n');
    const regexLine =
      '// searchPattern was matched as literal text but looks like a regex; pass isRegex=true to match it as one.';
    const globLine =
      "// no files were searched: nothing under path matched pattern '**/*.py' after the hidden/ignored/maxDepth filters. pattern is a file-name glob; the text to find goes in searchPattern.";
    const text = async (name: string, args: Record<string, unknown>) =>
      firstTextBlock(await harness.client.callTool({ name, arguments: { path: dir, ...args } }))
        .text ?? '';
    const search = (args: Record<string, unknown>) => text('search_text', args);
    const replace = (args: Record<string, unknown>) =>
      text('replace_text', { replacement: 'X', dryRun: true, ...args });

    assert.strictEqual(
      await search({ searchPattern: 'TOKEN1|token2' }),
      `No matches for 'TOKEN1|token2'\n${regexLine}`,
    );
    assert.strictEqual(
      await search({ searchPattern: 'TOKEN1', pattern: '**/*.py' }),
      `No matches for 'TOKEN1'\n${globLine}`,
    );
    for (const literal of ['foo(', 'a.b', 'x || y', 'arr[0]', 'string | undefined', '|x| x']) {
      assert.strictEqual(await search({ searchPattern: literal }), `No matches for '${literal}'`);
    }
    assert.ok((await replace({ searchPattern: '\\d+' })).endsWith(`\n${regexLine}`));
    assert.ok(
      (await replace({ searchPattern: 'TOKEN1', pattern: '**/*.py' })).endsWith(`\n${globLine}`),
    );
    // Already a regex: a genuine miss gets no hint.
    assert.strictEqual(
      await replace({ searchPattern: '\\d{9}', isRegex: true }),
      "replace_text: '\\d{9}' [dry run] · 0 match(es) in 0 file(s)",
    );
    // A literal the needle hit inside a binary file: the skip, not a regex, explains the zero.
    await writeFile(join(dir, 'b.bin'), Buffer.from([0, 0x61, 0x7c, 0x62, 0]));
    assert.strictEqual(
      await replace({ searchPattern: 'a|b' }),
      "replace_text: 'a|b' [dry run] · 0 match(es) in 0 file(s) · 1 binary skipped",
    );
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
    assert.strictEqual(firstTextBlock(result).text, 'search_bin/text.txt:1: BINNEEDLE');
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
    // EditSpec carries no `id`, so it is inlined at both use sites (edits and
    // files[].edits) instead of hoisted behind a `$ref` (issue #51).
    // Sentinel is the opening of EditSpecSchema's `oldText` description in
    // src/tools/edit.ts — reword that description and this count must move with
    // it.
    assert.strictEqual(
      editInput.split('Exact literal text to locate').length - 1,
      2,
      "EditSpec's oldText description must be inlined at both use sites",
    );

    // OpenAI and Anthropic reject these top-level keys in function parameters,
    // so no tool may publish one. The path/paths, edits/files and line-range
    // rules are enforced by superRefine at call time instead.
    for (const tool of tools) {
      for (const key of ['oneOf', 'anyOf', 'allOf', 'not', 'dependentRequired']) {
        assert.ok(
          !(key in tool.inputSchema),
          `${tool.name}: top-level ${key} breaks OpenAI/Anthropic function calling`,
        );
      }
    }

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
    const mutating = new Set(['create', 'delete', 'edit', 'move', 'patch', 'replace_text', 'undo']);
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
  // Raised 2026-10-06 to 18620 full (read-only unchanged): `edit` inlines
  // EditSpec at both use sites instead of a `$ref`, which some clients cannot
  // follow (issue #51).
  // Raised 2026-10-15 to 19600 full / 9550 read-only: `list` gains opt-in
  // includeSizes and sortBy inputs (#99); measured 19219 / 9357.
  // Raised 2026-10-22 to 20550 full (read-only unchanged): undo tool (#111);
  // measured 19949 / 9357.
  // Raised 2026-10-23 to 9850 read-only (full unchanged): the list and diff
  // descriptions name their default skips and refusals, gaps the Glama TDQS
  // review flagged; measured 20397 / 9668.
  // Raised 2026-10-28 to 20750 full (read-only unchanged): replace_text
  // gains maxMatches beside the deprecated maxResults alias; measured 20673.
  it('TOOL-SURFACE-002: tools/list stays within the session-start budget', async () => {
    const BUDGET_CHARS = 20_750;
    const BUDGET_CHARS_READ_ONLY = 9_850;

    const full = await createTestClientPair([tmpDir]);
    try {
      const { tools } = await full.client.listTools();
      assert.strictEqual(tools.length, 14, 'tool count changed; update the budget deliberately');
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

  it('TOOL-SURFACE-003: no read-only tool description names a write tool', async () => {
    const full = await createTestClientPair([tmpDir]);
    let writeNames: string[];
    try {
      const { tools } = await full.client.listTools();
      writeNames = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    } finally {
      await full.close();
    }
    assert.ok(writeNames.length > 0);

    const ro = await createTestClientPair([tmpDir], { readOnly: true });
    try {
      const { tools } = await ro.client.listTools();
      for (const tool of tools) {
        for (const name of writeNames) {
          assert.doesNotMatch(
            tool.description ?? '',
            new RegExp(`\\b${name}\\b`, 'u'),
            `${tool.name} names the write tool ${name}, absent under --read-only`,
          );
        }
      }
    } finally {
      await ro.close();
    }
  });
});

// High-severity regressions from the 2026-10 bug hunt (H1-H3, H6). Their own
// root: two of them symlink the root into itself, which every other walk in
// this file would then see.
describe('High-severity bug-hunt regressions (tools)', () => {
  let tmpDir: string;
  let pair: TestClientContext;

  before(async () => {
    tmpDir = await createTestRoot();
    pair = await createTestClientPair([tmpDir]);
  });
  after(async () => {
    await pair.close();
    await cleanupTestRoot(tmpDir);
  });

  describe('H2: concurrent and aliased writes keep every change', () => {
    it('30 concurrent edit calls on one file all apply (no lost updates)', async () => {
      const file = join(tmpDir, 'counters.txt');
      const n = 30;
      await writeFile(
        file,
        Array.from({ length: n }, (_, i) => `slot ${String(i)} = 0`).join('\n') + '\n',
      );
      const calls = Array.from({ length: n }, (_, i) =>
        pair.client.callTool({
          name: 'edit',
          arguments: {
            path: file,
            edits: [{ oldText: `slot ${String(i)} = 0`, newText: `slot ${String(i)} = 1` }],
          },
        }),
      );
      const results = await Promise.all(calls);
      assert.ok(
        results.every((r) => r.isError !== true),
        'every concurrent edit should succeed',
      );
      const after = await readFile(file, 'utf-8');
      for (let i = 0; i < n; i++) {
        assert.ok(after.includes(`slot ${String(i)} = 1`), `slot ${String(i)} must be updated`);
      }
      assert.ok(!after.includes('= 0'), 'no slot should keep its original value');
    });

    it('aliased creates never overwrite a file that appeared after planning', async (t) => {
      const file = join(tmpDir, 'concurrent-create.txt');
      const alias = join(tmpDir, 'create-alias');
      if (!(await trySymlink(tmpDir, alias, () => t.skip('symlinks not permitted')))) return;
      const result = await pair.client.callTool({
        name: 'create',
        arguments: {
          files: [
            { path: file, content: 'first' },
            { path: join(alias, 'concurrent-create.txt'), content: 'second' },
          ],
        },
      });
      const structured = result.structuredContent as {
        files?: unknown[];
        failures?: { error: { code: string; message: string } }[];
      };
      assert.strictEqual(structured.files?.length, 1, JSON.stringify(result));
      assert.strictEqual(structured.failures?.length, 1);
      assert.strictEqual(structured.failures[0]?.error.code, 'CANCELLED');
      assert.match(structured.failures[0]?.error.message ?? '', /appeared after overwrite/);
      const contents = await readFile(file, 'utf-8');
      assert.ok(contents === 'first' || contents === 'second');
    });

    it('a batch naming one file through a symlinked parent applies both entries', async (t) => {
      const file = join(tmpDir, 'aliased.txt');
      await writeFile(file, 'AAA\nBBB\n');
      const alias = join(tmpDir, 'aliasdir');
      if (!(await trySymlink(tmpDir, alias, () => t.skip('symlinks not permitted')))) return;

      const result = await pair.client.callTool({
        name: 'edit',
        arguments: {
          files: [
            { path: file, edits: [{ oldText: 'AAA', newText: 'XXX' }] },
            { path: join(alias, 'aliased.txt'), edits: [{ oldText: 'BBB', newText: 'YYY' }] },
          ],
        },
      });
      assert.notStrictEqual(result.isError, true);
      const after = await readFile(file, 'utf-8');
      assert.ok(after.includes('XXX') && after.includes('YYY'), `both edits must land: ${after}`);
    });
  });

  describe('H3: an overlapping move batch is refused with no data loss', () => {
    it('a swap [A->B, B->A] is refused and both files survive', async () => {
      const a = join(tmpDir, 'swapA');
      const b = join(tmpDir, 'swapB');
      await writeFile(a, 'AAA\n');
      await writeFile(b, 'BBB\n');
      const result = await pair.client.callTool({
        name: 'move',
        arguments: {
          moves: [
            { source: a, destination: b },
            { source: b, destination: a },
          ],
        },
      });
      assert.strictEqual(result.isError, true, 'a doomed swap is a total failure');
      assert.strictEqual(await readFile(a, 'utf-8'), 'AAA\n');
      assert.strictEqual(await readFile(b, 'utf-8'), 'BBB\n');
    });

    it('a chain [B->C, A->B] is refused and no file is destroyed', async () => {
      const a = join(tmpDir, 'chainA');
      const b = join(tmpDir, 'chainB');
      const c = join(tmpDir, 'chainC');
      await writeFile(a, 'AAA\n');
      await writeFile(b, 'BBB\n');
      const result = await pair.client.callTool({
        name: 'move',
        arguments: {
          moves: [
            { source: b, destination: c },
            { source: a, destination: b },
          ],
        },
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(await readFile(a, 'utf-8'), 'AAA\n');
      assert.strictEqual(await readFile(b, 'utf-8'), 'BBB\n');
      await assert.rejects(readFile(c, 'utf-8'), 'C must never be created');
    });

    it('independent moves in one batch still run concurrently', async () => {
      const x = join(tmpDir, 'indX');
      const y = join(tmpDir, 'indY');
      await writeFile(x, 'X\n');
      await writeFile(y, 'Y\n');
      const result = await pair.client.callTool({
        name: 'move',
        arguments: {
          moves: [
            { source: x, destination: join(tmpDir, 'indX2') },
            { source: y, destination: join(tmpDir, 'indY2') },
          ],
        },
      });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(await readFile(join(tmpDir, 'indX2'), 'utf-8'), 'X\n');
      assert.strictEqual(await readFile(join(tmpDir, 'indY2'), 'utf-8'), 'Y\n');
    });
  });

  describe('H1: edit ignoreWhitespace is bounded on a dense match', () => {
    it(
      'a short oldText matching thousands of times fails ambiguous quickly',
      { timeout: 5000 },
      async () => {
        const file = join(tmpDir, 'dense.txt');
        await writeFile(file, 'a b\n'.repeat(20_000));
        const result = await pair.client.callTool({
          name: 'edit',
          arguments: {
            path: file,
            ignoreWhitespace: true,
            edits: [{ oldText: 'a b', newText: 'X' }],
          },
        });
        assert.strictEqual(result.isError, true, 'an ambiguous match is an error');
        assert.match(firstTextBlock(result).text ?? '', /matches at least \d+ places/i);

        const exact = await pair.client.callTool({
          name: 'edit',
          arguments: {
            path: file,
            edits: [{ oldText: 'a b', newText: 'X' }],
          },
        });
        assert.strictEqual(exact.isError, true, 'repeated exact matches are ambiguous too');
        assert.match(firstTextBlock(exact).text ?? '', /matches at least \d+ places/i);

        // Nothing should have been written.
        assert.strictEqual(await readFile(file, 'utf-8'), 'a b\n'.repeat(20_000));
      },
    );
  });

  describe('H1 + H6: core search is interruptible and guards over-long lines', () => {
    it('H6: a line past the RE2 input bound is reported skippedTooLarge, not a false empty, and later searches still work', async () => {
      const dir = join(tmpDir, 'oversized');
      // One line over the bound, ending in a match RE2 never gets to see.
      const bigLine = `${'a'.repeat(RE2_MAX_INPUT_BYTES + 1024)} NEEDLE`;
      await writeTestFile(dir, 'huge.txt', bigLine);
      await writeTestFile(dir, 'ok.txt', 'hello NEEDLE world\n');

      const outcome = await searchContent(
        { root: dir },
        'NEEDLE',
        { isRegex: true },
        pair.serverCtx.pathGuard,
      );
      assert.strictEqual(outcome.summary.skippedTooLarge, 1, 'the huge-line file is skipped');
      assert.strictEqual(outcome.matches.length, 1, 'the ordinary file is still searched');

      // The wasm module is still alive for a second search in the same process.
      const again = await searchContent(
        { root: dir },
        'NEEDLE',
        { isRegex: true },
        pair.serverCtx.pathGuard,
      );
      assert.strictEqual(again.matches.length, 1);

      // A literal is matched natively, so the long line holds no hazard and is searched.
      const literal = await searchContent(
        { root: dir },
        'NEEDLE',
        { isRegex: false },
        pair.serverCtx.pathGuard,
      );
      assert.strictEqual(literal.summary.skippedTooLarge, 0);
      assert.deepStrictEqual(literal.matches.map((m) => m.file).sort(), [
        join(dir, 'huge.txt'),
        join(dir, 'ok.txt'),
      ]);
    });

    it('H1: an aborted search over a dense-match line resolves as timeout, not a hang', async () => {
      const dir = join(tmpDir, 'dense-line');
      await writeTestFile(dir, 'line.txt', 'needle\n'.repeat(200_000));
      const controller = new AbortController();
      const search = searchContent(
        { root: dir },
        'needle',
        { isRegex: false, maxResults: 100_000, signal: controller.signal },
        pair.serverCtx.pathGuard,
      );
      setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), 50);
      const outcome = await search;
      assert.strictEqual(outcome.summary.stoppedReason, 'timeout');
      assert.ok(outcome.summary.truncated, 'an aborted scan is incomplete');
      assert.ok(outcome.summary.filesScanned > 0, 'the scan started before cancellation');
    });

    it(
      'H1: a live replace_text timeout never writes a partially spliced file',
      { timeout: 5000 },
      async (t) => {
        const file = join(tmpDir, 'dense-replace.txt');
        const original = 'a'.repeat(200_000) + '\n';
        await writeFile(file, original);
        t.mock.method(AbortSignal, 'timeout', () => {
          const controller = new AbortController();
          setTimeout(() => controller.abort(new DOMException('test timeout', 'TimeoutError')), 100);
          return controller.signal;
        });
        const result = await pair.client.callTool({
          name: 'replace_text',
          arguments: {
            path: file,
            searchPattern: 'a',
            replacement: 'b',
            isRegex: true,
            caseSensitive: true,
          },
        });
        const meta = result._meta as { stoppedReason?: string; summary: { failed: number } };
        assert.strictEqual(meta.stoppedReason, 'timeout');
        assert.strictEqual(meta.summary.failed, 0);
        assert.notStrictEqual(result.isError, true);
        assert.strictEqual(await readFile(file, 'utf-8'), original);
      },
    );

    for (const dryRun of [false, true]) {
      it(
        dryRun
          ? 'a dry replace_text timeout does not claim rewritten files'
          : 'a live replace_text timeout names the files it already rewrote',
        { timeout: 10000 },
        async (t) => {
          const dir = join(tmpDir, dryRun ? 'rt-timeout-dry' : 'rt-timeout-live');
          const names = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
          for (const n of names) await writeTestFile(dir, n, 'foo\n');
          const controller = new AbortController();
          t.mock.method(AbortSignal, 'timeout', () => controller.signal);
          // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
          const realWrite = GuardedFileSystem.prototype.writeFile;
          t.mock.method(
            GuardedFileSystem.prototype,
            'writeFile',
            async function (this: GuardedFileSystem, ...a: Parameters<typeof realWrite>) {
              const out = await realWrite.apply(this, a);
              controller.abort(new DOMException('test timeout', 'TimeoutError'));
              return out;
            },
          );
          if (dryRun) controller.abort(new DOMException('test timeout', 'TimeoutError'));
          const result = await pair.client.callTool({
            name: 'replace_text',
            arguments: { path: dir, searchPattern: 'foo', replacement: 'foobar', dryRun },
          });
          const text = (result.content as { type: string; text: string }[])
            .map((c) => c.text)
            .join('\n');
          const meta = result._meta as { stoppedReason?: string; summary: { failed: number } };
          assert.strictEqual(meta.stoppedReason, 'timeout');
          assert.strictEqual(meta.summary.failed, 0);
          assert.notStrictEqual(result.isError, true);
          let written = 0;
          for (const n of names) {
            if ((await readFile(join(dir, n), 'utf-8')) === 'foobar\n') written++;
          }
          if (dryRun) {
            assert.doesNotMatch(text, /already rewritten/u);
            assert.doesNotMatch(text, /A higher timeout/u);
            assert.strictEqual(text.match(/scan stopped early/gu)?.length, 1);
            assert.strictEqual(written, 0);
            return;
          }
          assert.match(text, /file\(s\) were already rewritten and stay changed/u);
          assert.ok(written >= 1 && written < 40, `written=${String(written)}`);
          assert.strictEqual(
            Number(/(\d+) file\(s\) were already rewritten/u.exec(text)?.[1]),
            written,
          );
        },
      );
    }
  });
});

// The pattern edit built before #157, kept as the oracle the regex-free
// matcher must agree with span for span. It runs on JS RegExp, whose
// leftmost-first semantics equal RE2's here: one re2-wasm compile per case
// made the test take seconds. Its horizontal class is widened from RE2's
// ASCII-only one to JS `\s` minus the newline and U+FEFF, as the matcher's is.
const H = '[\\t\\x0b\\f\\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]';

function newlineRunPattern(token: string, edge: { leading: boolean; trailing: boolean }): string {
  if (!edge.leading && !edge.trailing) return `(?:${H}*\\n)+${H}*`;
  const count = token.split('\n').length - 1;
  const lines = `(?:${H}*\\n){${String(count)}}`;
  return edge.trailing && token.endsWith('\n') ? lines : `${lines}${H}*`;
}

function oraclePattern(oldText: string): string {
  const tokens = oldText.split(/(\s+)/u);
  const last = tokens.length - 1;
  let pattern = '';
  for (const [i, token] of tokens.entries()) {
    if (i % 2 === 0) {
      pattern += escapeRegExp(token);
    } else if (token.includes('\n')) {
      pattern += newlineRunPattern(token, {
        leading: i === 1 && tokens[0] === '',
        trailing: i === last - 1 && tokens[last] === '',
      });
    } else if (/\w$/.test(tokens[i - 1] ?? '') && /^\w/.test(tokens[i + 1] ?? '')) {
      pattern += `${H}+`;
    } else {
      pattern += `${H}*`;
    }
  }
  return pattern;
}

const LIMIT = 6;

function oracle(content: string, oldText: string, from: number): FlexMatch[] {
  const found: FlexMatch[] = [];
  for (const match of content.slice(from).matchAll(new RegExp(oraclePattern(oldText), 'gu'))) {
    if (match[0].length === 0) continue;
    found.push({ start: from + match.index, length: match[0].length });
    if (found.length === LIMIT) break;
  }
  return found;
}

function take<T>(items: Iterable<T>, n: number): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (out.length === n) break;
    out.push(item);
  }
  return out;
}

const PIECES = [
  'a',
  'b',
  'ab',
  '(',
  ';',
  ' ',
  '  ',
  '\t',
  '\n',
  '\n\n',
  ' \n',
  '\r\n',
  ' ',
  '　',
  ' ',
  '😀',
];

function* generatedCases(
  count: number,
): Generator<{ content: string; oldText: string; from: number }> {
  // Seeded LCG, so a failing case reproduces from its printed inputs.
  let seed = 157;
  const next = (n: number): number => {
    // 32-bit integer math: a float product past 2^53 loses its low bits.
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    return (seed >>> 16) % n;
  };
  const pieces = (min: number, max: number): string[] =>
    Array.from({ length: min + next(max - min + 1) }, () => PIECES[next(PIECES.length)] ?? '');
  const spaces = PIECES.filter((piece) => /^\s+$/u.test(piece));
  let made = 0;
  while (made < count) {
    const parts = pieces(0, 40);
    const content = parts.join('');
    // Random text rarely matches anything, so most oldTexts are a slice of
    // the content with some whitespace runs swapped for others.
    const at = next(parts.length + 1);
    const slice = parts.slice(at, at + 1 + next(8));
    const oldText =
      next(4) === 0 || slice.length === 0
        ? pieces(1, 8).join('')
        : slice
            .map((piece) =>
              /^\s+$/u.test(piece) && next(2) === 0
                ? (spaces[next(spaces.length)] ?? piece)
                : piece,
            )
            .join('');
    if (!/\S/u.test(oldText)) continue;
    made += 1;
    const first = oracle(content, oldText, 0)[0];
    // edit resumes only on code-point boundaries; inside a surrogate pair RE2 offsets drift.
    const second = (content.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
    const froms = new Set([0, second, ...(first ? [first.start + first.length] : [])]);
    for (const from of froms) if (from <= content.length) yield { content, oldText, from };
  }
}

describe('flexMatches', () => {
  it('flexMatches equals the old flexible pattern on generated cases', () => {
    for (const { content, oldText, from } of generatedCases(3000)) {
      const got = take(flexMatches(content, oldText, from), LIMIT);
      assert.deepStrictEqual(
        got,
        oracle(content, oldText, from),
        JSON.stringify({ content, oldText, from }),
      );
    }
  });

  it('flexMatches applies a 5,000-line oldText', () => {
    const body = `${Array.from({ length: 5000 }, (_, i) => `    line_${String(i)} = value(${String(i)});`).join('\n')}\n`;
    assert.deepStrictEqual(
      [...flexMatches(body, body.replaceAll('    ', '  '))],
      [{ start: 0, length: body.length }],
    );
  });
});
