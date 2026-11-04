import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type * as z from 'zod/v4';

import { buildFileResourceUri } from '../src/core/file-uri.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import type { PathGuard } from '../src/core/path.ts';
import { READ } from '../src/tools/index.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  makeGuard,
  type TestClientContext,
  withEnv,
  writeTestFile,
} from './helpers.ts';
import { runToolBodyResult, type ToolBodyOptions } from './tool-harness.ts';

type ReadArgs = z.input<typeof READ.def.input>;
type ReadRow = Awaited<ReturnType<typeof read>>['structured']['results'][number];

const valueOf = (row: ReadRow | undefined) => (row && 'value' in row ? row.value : undefined);
const errorOf = (row: ReadRow | undefined) => (row && 'error' in row ? row.error : undefined);

async function read(args: ReadArgs, options: ToolBodyOptions) {
  return runToolBodyResult(READ, args, options);
}

/** Zod issues of a schema refusal the harness's parse step throws. */
const issuesOf = (err: unknown): { path?: readonly string[]; message?: string }[] =>
  (err as { issues?: { path?: readonly string[]; message?: string }[] }).issues ?? [];

// Payload assembly, driven through the tool body with no MCP pair. What the
// executor adds — _meta placement, the oversize refusal, the element cap —
// stays in tools.test.ts.
describe('read body', () => {
  let root: string;
  let guard: PathGuard;

  before(async () => {
    root = await createTestRoot();
    guard = await makeGuard([root]);
  });

  after(async () => {
    await cleanupTestRoot(root);
  });

  it('returns a single text file as the authored text', async () => {
    const file = join(root, 'hello.txt');
    await writeFile(file, 'Hello\nWorld\n');
    const result = await read({ path: file }, { guard });
    assert.strictEqual(result.isError, false);
    assert.ok(result.text?.includes('Hello\nWorld\n'));
  });

  it('accepts legal file names containing .. ; and backtick, refuses a .. segment', async () => {
    const cases = [
      'app/blog/[...slug]/page.tsx',
      'docs/v1..2.md',
      'semi;colon.txt',
      'back`tick.txt',
    ];
    for (const rel of cases) {
      const file = await writeTestFile(root, `legal-names/${rel}`, `content of ${rel}\n`);
      const result = await read({ path: file }, { guard });
      assert.strictEqual(result.isError, false, `${rel} must be readable`);
      assert.ok(result.text?.includes(`content of ${rel}`), rel);
    }

    // A whole ".." segment is still refused at the schema, before any fs access.
    // Built by string concatenation: `join` would collapse the `..` lexically.
    const traversal = `${root.replaceAll('\\', '/')}/legal-names/../legal-names/docs/v1..2.md`;
    await assert.rejects(
      () => read({ path: traversal }, { guard }),
      (err) => {
        const issues = issuesOf(err);
        return issues.length === 1 && (issues[0]?.message ?? '').includes('Directory traversal');
      },
      'a .. segment is one schema issue',
    );
  });

  it('returns an image as an image content block with base64 data', async () => {
    // Minimal 1x1 transparent PNG (known-good bytes).
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
        '890000000d49444154789c63f8cf00000001000100000005defb0a00000000' +
        '49454e44ae426082',
      'hex',
    );
    const file = join(root, 'pixel.png');
    await writeFile(file, pngBytes);

    const result = await read({ path: file }, { guard });
    assert.strictEqual(result.isError, false);

    const imageBlock = (result.resources ?? []).find((b) => b.type === 'image') as
      { data?: string; mimeType?: string } | undefined;
    assert.ok(imageBlock, 'expected an image content block');
    assert.strictEqual(imageBlock.mimeType, 'image/png');
    const data = imageBlock.data;
    assert.ok(typeof data === 'string');
    assert.strictEqual(Buffer.from(data, 'base64').equals(pngBytes), true);

    assert.strictEqual(valueOf(result.structured.results[0])?.kind, 'image');
  });

  it('refuses binary together with a line range', async () => {
    const file = await writeTestFile(root, 'binary-flag/range.txt', 'a\nb\n');
    for (const extra of [
      { head: 1 },
      { tail: 1 },
      { startLine: 1 },
      { startLine: 1, endLine: 2 },
    ]) {
      await assert.rejects(
        () => read({ path: file, binary: true, ...extra }, { guard }),
        (err) =>
          issuesOf(err).some((issue) => (issue.message ?? '').includes("Cannot use 'binary'")),
        JSON.stringify(extra),
      );
    }
  });

  it('without binary refuses a binary file and names the flag', async () => {
    const dir = join(root, 'binary-flag');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'hint.zip');
    await writeFile(file, Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]));
    const whole = await read({ path: file }, { guard });
    assert.strictEqual(whole.isError, true);
    assert.strictEqual(errorOf(whole.structured.results[0])?.code, 'BINARY_FILE');
    assert.match(whole.text ?? '', /^Binary file detected\. Pass binary: true/);

    const ranged = await read({ path: file, head: 1 }, { guard });
    assert.strictEqual(ranged.isError, true);
    assert.match(ranged.text ?? '', /no lines; read it whole with binary: true/);
  });

  it('with binary returns a PDF or zip as an embedded resource', async () => {
    const dir = join(root, 'binary-flag');
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
      const result = await read({ path: file, binary: true, includeHash: true }, { guard });
      assert.strictEqual(result.isError, false, c.name);
      assert.strictEqual(
        (result.resources ?? []).filter((b) => b.type === 'resource_link').length,
        0,
        c.name,
      );
      const block = (result.resources ?? []).find((b) => b.type === 'resource') as
        { resource?: { uri?: string; mimeType?: string; blob?: string } } | undefined;
      assert.ok(block?.resource, `${c.name}: expected an embedded resource`);
      assert.strictEqual(block.resource.uri, buildFileResourceUri(normalizePath(file)));
      assert.strictEqual(block.resource.mimeType, c.mimeType);
      assert.ok(Buffer.from(block.resource.blob ?? '', 'base64').equals(c.bytes), c.name);
      assert.match(result.text ?? '', /returned as an embedded resource block/);
      assert.match(result.text ?? '', /\/\/ sha256: [0-9a-f]{64}/);
      const value = valueOf(result.structured.results[0]);
      assert.strictEqual(value?.kind, c.kind);
      assert.strictEqual(value?.mimeType, c.mimeType);
      assert.strictEqual(value?.size, c.bytes.length);
      assert.strictEqual(value?.resourceUri, buildFileResourceUri(normalizePath(file)));
      assert.strictEqual(
        (value as Record<string, unknown> | undefined)?.['blobData'],
        undefined,
        'bytes never ride the structured metadata',
      );
    }
  });

  it('with binary leaves text, UTF-16, secret and oversize files as they were', async () => {
    const text = await writeTestFile(root, 'binary-flag/plain.txt', 'hello\n');
    const plain = await read({ path: text, binary: true }, { guard });
    assert.strictEqual(plain.isError, false);
    assert.strictEqual(plain.text, 'hello\n');
    assert.ok((plain.resources ?? []).some((b) => b.type === 'resource_link'));

    const utf16 = join(root, 'binary-flag/utf16.txt');
    await writeFile(
      utf16,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]),
    );
    const wide = await read({ path: utf16, binary: true }, { guard });
    assert.strictEqual(wide.isError, true);
    assert.match(errorOf(wide.structured.results[0])?.message ?? '', /UTF-16/);

    const secret = await writeTestFile(root, 'binary-flag/.env', 'SECRET=1');
    const denied = await read({ path: secret, binary: true }, { guard });
    assert.strictEqual(denied.isError, true);
    assert.ok(!(denied.resources ?? []).some((b) => b.type === 'resource'));

    const big = join(root, 'binary-flag/big.zip');
    await writeFile(big, Buffer.alloc(1024 * 1024 + 1));
    await withEnv({ FS_MAX_FILE_SIZE: String(1024 * 1024) }, async () => {
      const tooLarge = await read({ path: big, binary: true }, { guard });
      assert.strictEqual(tooLarge.isError, true);
      assert.strictEqual(errorOf(tooLarge.structured.results[0])?.code, 'TOO_LARGE');
    });
  });

  it('batch with binary mixes text and resources and charges base64 size', async () => {
    const text = await writeTestFile(root, 'binary-flag/mix/a.txt', 'x'.repeat(100 * 1024));
    const pdf = join(root, 'binary-flag/mix/doc.pdf');
    await writeFile(pdf, Buffer.from('%PDF-1.4\n', 'latin1'));
    const mixed = await read({ paths: [text, pdf], binary: true }, { guard });
    assert.strictEqual(mixed.isError, false);
    assert.deepStrictEqual(
      (mixed.resources ?? []).map((b) => b.type),
      ['resource_link', 'resource'],
    );
    assert.strictEqual(mixed.structured.summary.failed, 0);

    // 100 KiB + 400 KiB fits 512 KiB raw, but the zip ships as ~533 KiB of base64.
    const zip = join(root, 'binary-flag/mix/big.zip');
    await writeFile(zip, Buffer.alloc(400 * 1024));
    const budget = await read({ paths: [text, zip], binary: true }, { guard });
    const results = budget.structured.results;
    assert.strictEqual(errorOf(results[0]), undefined);
    assert.strictEqual(errorOf(results[1])?.code, 'TOO_LARGE');
    assert.match(errorOf(results[1])?.message ?? '', /maxTotalSize/);
  });

  it('batch slice of an svg is charged its raw size, not base64', async () => {
    // 400 KiB fits the 512 KiB budget raw; as base64 it would not. A slice is text.
    const svg = await writeTestFile(
      root,
      'binary-flag/large.svg',
      `<svg xmlns="http://www.w3.org/2000/svg">\n${'<g/>\n'.repeat(80 * 1024)}</svg>\n`,
    );
    const result = await read({ paths: [svg], head: 1 }, { guard });
    assert.strictEqual(result.isError, false);
    assert.strictEqual(errorOf(result.structured.results[0]), undefined);
    assert.match(result.text ?? '', /<svg xmlns/);
  });

  it('batch head slice of a file larger than maxTotalSize is charged its returned bytes', async () => {
    // 600 KiB is over the 512 KiB batch budget whole; head: 1 returns 2 bytes.
    const small = await writeTestFile(root, 'read-budget/small.txt', 'small\n');
    const big = await writeTestFile(root, 'read-budget/big.txt', 'x\n'.repeat(300 * 1024));
    const result = await read({ paths: [small, big], head: 1 }, { guard });
    assert.strictEqual(result.isError, false);
    assert.strictEqual(result.structured.summary.failed, 0);
    assert.strictEqual(errorOf(result.structured.results[1]), undefined);
    assert.match(result.text ?? '', /\/\/ .*small\.txt\nsmall/);
    assert.match(result.text ?? '', /\/\/ .*big\.txt\nx/);
  });

  it('batch slices over budget skip one slice without head/tail advice', async () => {
    // Each head: 1 returns one 300 KiB line; two of them pass 512 KiB.
    const line = 'y'.repeat(300 * 1024);
    const a = await writeTestFile(root, 'read-budget/a.txt', `${line}\nrest\n`);
    const b = await writeTestFile(root, 'read-budget/b.txt', `${line}\nrest\n`);
    const c = await writeTestFile(root, 'read-budget/c.txt', 'tiny\nrest\n');
    const result = await read({ paths: [a, b, c], head: 1 }, { guard });
    assert.strictEqual(result.isError, false);
    const errors = result.structured.results.map((r) => errorOf(r));
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
    assert.strictEqual(result.structured.summary.failed, 1);
  });

  it('reads a path outside the allowed root as ACCESS_DENIED (#TC-FUNC-007)', async () => {
    const outsideDir = await createTestRoot();
    const outsideFile = await writeTestFile(outsideDir, 'outside_test.txt', 'secret');
    try {
      const result = await read({ path: outsideFile }, { guard });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(errorOf(result.structured.results[0])?.code, 'ACCESS_DENIED');
      assert.ok(result.text, 'the single-path refusal names the problem');
    } finally {
      await cleanupTestRoot(outsideDir);
    }
  });

  it('reports a non-existent file as an error in per-path results (#TC-FUNC-015)', async () => {
    const missing = join(root, 'missing.txt');
    const result = await read({ path: missing }, { guard });
    assert.strictEqual(result.structured.summary.failed, 1);
    assert.strictEqual(errorOf(result.structured.results[0])?.code, 'NOT_FOUND');
  });

  it('refuses a UTF-16 file with a message that names the encoding', async () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('hello\nworld\n', 'utf16le'),
    ]);
    const file = join(root, 'utf16le.txt');
    await writeFile(file, utf16);

    for (const extra of [{}, { head: 1 }, { tail: 1 }, { startLine: 1, endLine: 1 }]) {
      const result = await read({ path: file, ...extra }, { guard });
      assert.strictEqual(result.isError, true, `mode ${JSON.stringify(extra)} must refuse`);
      const error = errorOf(result.structured.results[0]);
      assert.strictEqual(error?.code, 'INVALID_INPUT');
      assert.match(error?.message ?? '', /UTF-16/);
    }
  });

  it('resource_link and resourceUri name the same file', async () => {
    const file = join(root, 'uri_agreement.txt');
    await writeFile(file, 'content\n');

    // Request it by a path whose case differs from the resolved one. The link
    // used to be rebuilt from the *requested* path while resourceUri came from
    // the validated one, so the two disagreed and each keyed its own watcher.
    const result = await read(
      { path: file.replace(/^([a-z]):/iu, (_m, d: string) => `${d.toUpperCase()}:`) },
      { guard },
    );
    assert.strictEqual(result.isError, false);

    const resourceUri = valueOf(result.structured.results[0])?.resourceUri;
    const link = (result.resources ?? []).find((b) => b.type === 'resource_link') as
      { uri?: string } | undefined;
    assert.ok(resourceUri, 'read must expose a resourceUri');
    assert.strictEqual(link?.uri, resourceUri);
  });

  it("resource_link carries the file's mtime as lastModified", async () => {
    const file = join(root, 'stamped.txt');
    await writeFile(file, 'content\n');
    const { mtime } = await stat(file);
    const result = await read({ path: file }, { guard });
    const link = (result.resources ?? []).find((b) => b.type === 'resource_link') as
      { annotations?: { lastModified?: string } } | undefined;
    assert.strictEqual(link?.annotations?.lastModified, mtime.toISOString());
    assert.strictEqual(valueOf(result.structured.results[0])?.modified, mtime.toISOString());
  });

  it('a call where every path failed is reported as isError', async () => {
    const result = await read(
      { paths: [join(root, 'no_such_a.txt'), join(root, 'no_such_b.txt')] },
      { guard },
    );
    assert.strictEqual(result.isError, true, 'no path succeeded, so the call failed');
    assert.strictEqual(result.structured.summary.failed, 2);
  });

  it('a partly-failed batch is not isError', async () => {
    const ok = join(root, 'partial_ok.txt');
    await writeFile(ok, 'here\n');
    const result = await read({ paths: [ok, join(root, 'partial_missing.txt')] }, { guard });
    assert.strictEqual(result.isError, false, 'one path really was read');
    assert.strictEqual(result.structured.summary.failed, 1);
  });

  it('batch budget: one oversized file skips only itself, in full and ranged reads', async () => {
    const big = await writeTestFile(root, 'budget/big.txt', 'x'.repeat(600 * 1024) + '\nlast\n');
    const small = await writeTestFile(root, 'budget/small.txt', 'tiny\n');

    const ranged = await read({ paths: [big, small], head: 1 }, { guard });
    assert.strictEqual(ranged.isError, false, 'the batch is partly-failed, not wholly failed');
    assert.strictEqual(errorOf(ranged.structured.results[0])?.code, 'TOO_LARGE');
    assert.strictEqual(
      errorOf(ranged.structured.results[1]),
      undefined,
      'the small file must still be read even in a ranged batch',
    );

    const full = await read({ paths: [big, small] }, { guard });
    assert.strictEqual(full.isError, false, 'the small file must still be read');
    const results = full.structured.results;
    assert.strictEqual(errorOf(results[0])?.code, 'TOO_LARGE');
    assert.strictEqual(
      errorOf(results[1]),
      undefined,
      'the file after the oversized one must succeed',
    );
    assert.ok(full.text?.includes('tiny'));

    const alone = await read({ paths: [big] }, { guard });
    assert.strictEqual(alone.isError, true, 'a lone oversized file is still refused');

    const single = await read({ path: big, head: 1 }, { guard });
    assert.strictEqual(
      single.isError,
      false,
      'a single-path ranged read is the documented escape hatch',
    );
  });

  it('budget: a skipped file carries the TOO_LARGE suggestion', async () => {
    const big = await writeTestFile(root, 'budget2/big.txt', 'x'.repeat(600 * 1024) + '\nlast\n');
    const small = await writeTestFile(root, 'budget2/small.txt', 'tiny\n');
    const result = await read({ paths: [big, small] }, { guard });
    const error = errorOf(result.structured.results[0]);
    assert.strictEqual(error?.code, 'TOO_LARGE');
    assert.strictEqual(error?.suggestion, 'Use head/tail or line ranges to read partially.');
  });

  it('budget: duplicate paths keep one row per requested index, in order', async () => {
    const big = await writeTestFile(root, 'budget3/big.txt', 'x'.repeat(600 * 1024) + '\nlast\n');
    const small = await writeTestFile(root, 'budget3/small.txt', 'tiny\n');
    const result = await read({ paths: [big, small, small, big] }, { guard });
    const rows = result.structured.results;
    assert.strictEqual(rows.length, 4);
    assert.strictEqual(errorOf(rows[0])?.code, 'TOO_LARGE');
    assert.strictEqual(errorOf(rows[1]), undefined);
    assert.strictEqual(errorOf(rows[2]), undefined);
    assert.strictEqual(errorOf(rows[3])?.code, 'TOO_LARGE');
    assert.deepStrictEqual(
      rows.map((r) => r.path),
      [big, small, small, big],
    );
    assert.strictEqual(result.structured.summary.failed, 2);
  });

  it('trailer carries continuation and hash (#TC-FUNC-074)', async () => {
    const file = join(root, 'trailer.txt');
    const body = Array.from({ length: 30 }, (_v, i) => `line${String(i + 1)}`).join('\n');
    await writeFile(file, `${body}\n`);

    const head = await read({ path: file, head: 10, includeHash: true }, { guard });
    const headText = head.text ?? '';
    assert.match(
      headText,
      /^\/\/ more lines from 11\. Continue: read .*"startLine":11,"endLine":20\}$/m,
    );
    assert.match(headText, /^\/\/ sha256: [0-9a-f]{64}$/m);
    // The file's own lines survive ahead of the trailer, unaltered.
    assert.ok(headText.startsWith('line1\nline2\n'), headText.slice(0, 40));
    assert.ok(headText.indexOf('line10') < headText.indexOf('// more lines'));

    // A whole-file read is not truncated and was not asked for a hash.
    const full = await read({ path: file }, { guard });
    const fullText = full.text ?? '';
    assert.ok(!fullText.includes('// more lines'), 'a full read has no more lines');
    assert.ok(!fullText.includes('// sha256'), 'no hash unless includeHash');

    // tail has no args that read backwards, so it reports what it showed.
    const tail = await read({ path: file, tail: 10 }, { guard });
    const tailText = tail.text ?? '';
    assert.match(tailText, /^\/\/ more lines above: showing last 10 lines$/m);
    assert.ok(!tailText.includes('Continue:'), 'tail offers no continuation args');
  });

  it('a slice ending on the last line carries no trailer', async () => {
    const file = await writeTestFile(root, 'exact-end.txt', 'a\nb\nc\n');
    for (const args of [{ head: 3 }, { startLine: 2, endLine: 3 }, { startLine: 2, endLine: 99 }]) {
      const result = await read({ path: file, ...args }, { guard });
      assert.ok(!(result.text ?? '').includes('\n// '), JSON.stringify(args));
    }
  });

  it('continuations remain usable beyond line 100,000', async () => {
    const file = await writeTestFile(root, 'long-lines.txt', `${'x\n'.repeat(100000)}last\n`);
    const first = await read({ path: file, head: 100000 }, { guard });
    assert.strictEqual(first.isError, false);
    const continuation = valueOf(first.structured.results[0])?.continuation;
    assert.ok(continuation);
    assert.strictEqual(continuation.args.startLine, 100001);
    const next = await read(continuation.args, { guard });
    assert.strictEqual(next.isError, false);
    assert.strictEqual(next.text, 'last');
  });

  it('a continuation of a range ending at the endLine maximum stays within the schema', async () => {
    const limit = 1024 * 1024;
    await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
      // Twice the size limit, so the range read stops early with lines left.
      const file = await writeTestFile(root, 'max-end.txt', `${'z'.repeat(99)}\n`.repeat(20000));
      const first = await read({ path: file, startLine: 1, endLine: 2147483647 }, { guard });
      assert.strictEqual(first.isError, false);
      assert.match(first.text ?? '', /^\/\/ truncated: More lines remain from /m);
      const continuation = valueOf(first.structured.results[0])?.continuation;
      assert.ok(continuation);
      assert.strictEqual(continuation.args.endLine, 2147483647);
      const next = await read(continuation.args, { guard });
      assert.strictEqual(next.isError, false, next.text?.slice(0, 200));
    });
  });

  it('an endLine past the maximum is refused once, not once per bound', async () => {
    const file = await writeTestFile(root, 'past-max.txt', 'a\n');
    await assert.rejects(
      () => read({ path: file, startLine: 1, endLine: 2147483648 }, { guard }),
      (err) => {
        const issues = issuesOf(err).filter((issue) => issue.path?.[0] === 'endLine');
        return issues.length === 1 && (issues[0]?.message ?? '').includes('Too big');
      },
      'one endLine issue, not one per bound',
    );
  });
});

// Wire tier: the response the client receives. The body builds the blocks and
// the metadata; this pins the executor's placement of both (content blocks and
// `_meta`), which the body tier cannot see.
describe('read over the wire', () => {
  let root: string;
  let harness: TestClientContext;

  before(async () => {
    root = await createTestRoot();
    harness = await createTestClientPair([root]);
  });

  after(async () => {
    await harness.close();
    await cleanupTestRoot(root);
  });

  it('ships a PNG as an image block whose base64 decodes to the file', async () => {
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
        '890000000d49444154789c63f8cf00000001000100000005defb0a00000000' +
        '49454e44ae426082',
      'hex',
    );
    const file = join(root, 'wire-pixel.png');
    await writeFile(file, pngBytes);
    const result = await harness.client.callTool({ name: 'read', arguments: { path: file } });
    assert.notStrictEqual(result.isError, true);
    const imageBlock = (
      result.content as readonly { type: string; data?: string; mimeType?: string }[]
    ).find((b) => b.type === 'image');
    assert.ok(imageBlock, 'expected an image content block on the wire');
    assert.strictEqual(imageBlock.mimeType, 'image/png');
    assert.ok(typeof imageBlock.data === 'string');
    assert.strictEqual(Buffer.from(imageBlock.data, 'base64').equals(pngBytes), true);
    const structured = result._meta as { results?: { value?: { kind?: string } }[] } | undefined;
    assert.strictEqual(structured?.results?.[0]?.value?.kind, 'image');
  });

  it('ships a binary read as an embedded resource block, not a link', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]);
    const file = join(root, 'wire.zip');
    await writeFile(file, bytes);
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: file, binary: true },
    });
    assert.notStrictEqual(result.isError, true);
    const blocks = result.content as readonly {
      type: string;
      resource?: { uri?: string; mimeType?: string; blob?: string };
    }[];
    assert.strictEqual(blocks.filter((b) => b.type === 'resource_link').length, 0);
    const block = blocks.find((b) => b.type === 'resource');
    assert.ok(block?.resource, 'expected an embedded resource on the wire');
    assert.strictEqual(block.resource.mimeType, 'application/zip');
    assert.ok(Buffer.from(block.resource.blob ?? '', 'base64').equals(bytes));
    assert.strictEqual(block.resource.uri, buildFileResourceUri(normalizePath(file)));
    assert.ok(firstTextBlock(result).text?.includes('returned as an embedded resource block'));
  });
});
