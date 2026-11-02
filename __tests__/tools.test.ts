import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildFileResourceUri } from '../src/core/file-uri.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { getMaxTextFileSize, MAX_TOOL_INPUT_ELEMENTS } from '../src/core/util.ts';
import { createRuntimeState, createServer } from '../src/server.ts';
import { MUTATING_TOOL_NAMES, registeredTools } from '../src/tools/index.ts';
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

  it('replace_text and resources/read refuse sensitive files', async () => {
    const token = 'example-sentinel-9f3c1e';
    const dir = join(tmpDir, 'boundary_walk');
    const envFile = await writeTestFile(tmpDir, 'boundary_walk/.env', `SECRET=${token}\n`);
    await writeTestFile(tmpDir, 'boundary_walk/vault.key/inner.txt', `note ${token}\n`);
    const plain = await writeTestFile(tmpDir, 'boundary_walk/plain.txt', `note ${token}\n`);

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
      assert.strictEqual(result.structuredContent, undefined);
      assert.strictEqual(failedSummary(result)?.summary?.failed, 0);
      // The executor appends the undo handle to the body's summary line.
      assert.match(firstTextBlock(result).text ?? '', /^edit: edit\.txt .* · undo \S+$/mu);

      const content = await readFile(file, 'utf-8');
      assert.strictEqual(content, 'modified content');
    }
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

  it('TC-FUNC-061: patch applies a unified diff', async () => {
    const f = join(tmpDir, 'patch_target.txt');
    await writeFile(f, 'a\nb\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
    const result = await harness.client.callTool({
      name: 'patch',
      arguments: { path: f, diff },
    });
    assert.notStrictEqual(result.isError, true);
    const uri = (result._meta as { resourceUri?: string }).resourceUri;
    assert.ok(uri, 'a real write links the file');
    assert.ok(
      (result.content as { type: string; uri?: string }[]).some(
        (block) => block.type === 'resource_link' && block.uri === uri,
      ),
    );
    assert.strictEqual(await readFile(f, 'utf-8'), 'X\nb\nc\n');
  });

  it('TC-FUNC-062: patch that does not apply returns isError', async () => {
    const f = join(tmpDir, 'patch_bad.txt');
    await writeFile(f, 'q\nb\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
    const result = await harness.client.callTool({ name: 'patch', arguments: { path: f, diff } });
    assert.strictEqual(result.isError, true);
    assert.match(firstTextBlock(result).text ?? '', /INVALID_INPUT.*did not apply cleanly/);
  });

  it('TC-FUNC-063: list sends text, metadata and its resource link over MCP', async () => {
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
    assert.strictEqual(r1.structuredContent, undefined);
    assert.match(firstTextBlock(r1).text ?? '', /showing 1-2 of 4 entries/);
    assert.ok(
      (r1.content as { type: string; uri?: string }[]).some(
        (block) => block.type === 'resource_link' && block.uri === s1.resourceUri,
      ),
    );
    const r2 = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2, cursor: s1.nextCursor },
    });
    const s2 = r2._meta as { nextCursor?: string; entryCount?: number; resourceUri?: string };
    assert.strictEqual(s2.entryCount, 2);
    assert.ok(!s2.nextCursor, 'second page is the last');
    assert.strictEqual(s2.resourceUri, undefined, 'later pages never carry the URI');
    const invalid = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2, includeHidden: true, cursor: s1.nextCursor },
    });
    assert.strictEqual(invalid.isError, true);
    assert.match(firstTextBlock(invalid).text ?? '', /INVALID_INPUT/);
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
    assert.strictEqual((result._meta as { totalMatches?: number }).totalMatches, 2);
    const content = await readFile(file, 'utf-8');
    assert.strictEqual(content, 'QUX bar QUX\n');
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

  it('TC-FUNC-014: find_files returns matched files via callTool', async () => {
    await writeTestFile(tmpDir, 'findme.txt', 'x');
    // The shared tmpDir holds more than find_files' default 100 results of *.txt.
    const result = await harness.client.callTool({
      name: 'find_files',
      arguments: { pattern: '**/findme.txt' },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structuredContent, undefined);
    assert.match(firstTextBlock(result).text ?? '', /findme\.txt/);
    const sc = result._meta as { results?: { path: string }[] };
    assert.ok(sc.results?.some((r) => r.path.endsWith('findme.txt')));
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
    assert.strictEqual(result.structuredContent, undefined);
    assert.match(firstTextBlock(result).text ?? '', /grep_dir\/target\.txt:2: NEEDLE_MARK here/);
    const structured = result._meta as {
      matches?: { line?: number; content?: string }[];
      totalMatches?: number;
    };
    assert.strictEqual(structured.totalMatches, 1);
    assert.strictEqual(structured.matches?.[0]?.line, 2);
    assert.ok(structured.matches?.[0]?.content?.includes('NEEDLE_MARK'));
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
  // Raised 2026-11-01 to 20900 full and 9900 read-only: list_roots names
  // readOnlyDirs (#162); measured 20849 / 9863.
  it('TOOL-SURFACE-002: tools/list stays within the session-start budget', async () => {
    const BUDGET_CHARS = 20_900;
    const BUDGET_CHARS_READ_ONLY = 9_900;

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

// High-severity regressions from the 2026-10 bug hunt (H2, H3); the edit and
// replace_text ones run at the body seam in their own files. Their own root:
// one of them symlinks the root into itself, which every other walk in this
// file would then see.
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
});
