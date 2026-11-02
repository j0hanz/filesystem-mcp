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
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { ErrorCode, FsError } from '../src/core/errors.ts';
import { buildFileResourceUri } from '../src/core/file-uri.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { RE2_MAX_INPUT_BYTES } from '../src/core/matcher.ts';
import { escapeRegExp, getMaxTextFileSize, MAX_TOOL_INPUT_ELEMENTS } from '../src/core/util.ts';
import { createRuntimeState, createServer } from '../src/server.ts';
import { type FlexMatch, flexMatches } from '../src/tools/edit.ts';
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

  it("replace_text honors the allowed root's .gitignore below it", async () => {
    // tmpDir is the allowed root; the walk is scoped to a subdirectory.
    await writeFile(join(tmpDir, '.gitignore'), 'scoped_ignored/*.log\n');
    const sub = join(tmpDir, 'scoped_ignored');
    await writeTestFile(tmpDir, 'scoped_ignored/keep.txt', 'NEEDLE_G\n');
    const dropped = await writeTestFile(tmpDir, 'scoped_ignored/drop.log', 'NEEDLE_G\n');

    const replaced = await harness.client.callTool({
      name: 'replace_text',
      arguments: { path: sub, searchPattern: 'NEEDLE_G', replacement: 'X' },
    });
    assert.notStrictEqual(replaced.isError, true);
    assert.strictEqual(await readFile(dropped, 'utf-8'), 'NEEDLE_G\n', 'ignored file untouched');
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

  it('edit and patch refuse a non-UTF-8 file and leave its bytes intact', async () => {
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
      // A match at text start leads the next one (#158).
      { searchPattern: '-', before: '--\n', after: 'XX\n', matches: 2 },
      { searchPattern: '-', before: '---\n', after: 'XXX\n', matches: 3 },
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

  it('replace_text explains a zero-match result in the text (#55)', async () => {
    const dir = join(tmpDir, 'zero_hint');
    await writeTestFile(dir, 'a.ts', 'const TOKEN1 = 1;\nconst token2 = 2;\n');
    const regexLine =
      '// searchPattern was matched as literal text but looks like a regex; pass isRegex=true to match it as one.';
    const globLine =
      "// no files were searched: nothing under path matched pattern '**/*.py' after the hidden/ignored/maxDepth filters. pattern is a file-name glob; the text to find goes in searchPattern.";
    const replace = async (args: Record<string, unknown>) =>
      firstTextBlock(
        await harness.client.callTool({
          name: 'replace_text',
          arguments: { path: dir, replacement: 'X', dryRun: true, ...args },
        }),
      ).text ?? '';

    assert.ok((await replace({ searchPattern: '\\d+' })).endsWith(`\n${regexLine}`));
    assert.ok(
      (await replace({ searchPattern: 'TOKEN1', pattern: '**/*.py' })).endsWith(`\n${globLine}`),
    );
    assert.strictEqual(
      await replace({ searchPattern: '\\d{9}', isRegex: true }),
      "replace_text: '\\d{9}' [dry run] · 0 match(es) in 0 file(s)",
    );
    await writeFile(join(dir, 'b.bin'), Buffer.from([0, 0x61, 0x7c, 0x62, 0]));
    assert.strictEqual(
      await replace({ searchPattern: 'a|b' }),
      "replace_text: 'a|b' [dry run] · 0 match(es) in 0 file(s) · 1 binary skipped",
    );
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

  describe('H1: replace_text timeouts', () => {
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
