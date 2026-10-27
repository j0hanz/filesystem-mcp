import assert from 'node:assert/strict';
import { chmod, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { ErrorCode } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import type { Change } from '../src/core/rewrite.ts';
import { rewriteEntry, rewriteFile } from '../src/core/rewrite.ts';
import { MIB } from '../src/core/util.ts';
import { cleanupTestRoot, createTestRoot, fsErrorMatcher, makeGuard, withEnv } from './helpers.ts';

const upper = (c: string): Change<number> => ({ content: c.toUpperCase(), result: 1, write: true });
const OLD = new Date('2001-01-01T00:00:00Z');

describe('Rewrite', () => {
  let root: string;
  let fs: GuardedFileSystem;
  let path: string;

  beforeEach(async () => {
    root = await createTestRoot();
    fs = new GuardedFileSystem(await makeGuard([root]));
    path = join(root, 'a.txt');
    await writeFile(path, 'hello\n');
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  /** Holds the file's write lock until the returned release is called. */
  const holdLock = (): { release: () => void; held: Promise<unknown> } => {
    const gate = Promise.withResolvers<undefined>();
    const held = fs.lockForWrite(path, () => gate.promise);
    return { release: () => gate.resolve(undefined), held };
  };

  it('dry run neither locks nor writes', async () => {
    const { release, held } = holdLock();
    try {
      const done = await rewriteFile({ fs, path, dryRun: true, tool: 'edit' }, upper);
      assert.equal(done.written, false);
      assert.equal(done.after, 'HELLO\n');
      assert.equal(await readFile(path, 'utf8'), 'hello\n');
    } finally {
      release();
      await held;
    }
  });

  it('real run waits for the write lock', async () => {
    const { release, held } = holdLock();
    let settled = false;
    const running = rewriteFile({ fs, path, dryRun: false, tool: 'edit' }, upper).finally(() => {
      settled = true;
    });
    await nextTurn();
    assert.equal(settled, false);
    release();
    await held;
    const done = await running;
    assert.equal(done.written, true);
    assert.equal(await readFile(path, 'utf8'), 'HELLO\n');
  });

  it('real run reports the written file', async () => {
    const done = await rewriteFile({ fs, path, dryRun: false, tool: 'edit' }, upper);
    const report = done.report();
    assert.equal(report.validPath, normalizePath(path));
    assert.equal(report.size, 6);
    assert.equal(report.lineCount, 1);
    assert.equal(report.mimeType, 'text/plain');
    assert.equal(report.kind, 'text');
    assert.equal(report.modified, (await stat(path)).mtime.toISOString());
    assert.equal(done.modified, report.modified);
  });

  it('dry run reports the current mtime', async () => {
    await utimes(path, OLD, OLD);
    const dry = await rewriteFile({ fs, path, dryRun: true, tool: 'edit' }, upper);
    assert.equal(dry.modified, '2001-01-01T00:00:00.000Z');
    assert.equal(dry.report().modified, '2001-01-01T00:00:00.000Z');

    const unchanged = await rewriteFile({ fs, path, dryRun: false, tool: 'edit' }, (c) => ({
      content: c,
      result: 0,
      write: false,
    }));
    assert.equal(unchanged.written, false);
    assert.equal(unchanged.modified, '2001-01-01T00:00:00.000Z');
    assert.equal((await stat(path)).mtime.toISOString(), '2001-01-01T00:00:00.000Z');
  });

  it('a failed post-write stat reports the write time', async (t) => {
    const original = fs.stat.bind(fs);
    let calls = 0;
    t.mock.method(fs, 'stat', (...args: Parameters<GuardedFileSystem['stat']>) =>
      ++calls === 1 ? original(...args) : Promise.reject(new Error('stat failed')),
    );
    const before = Date.now();
    const done = await rewriteFile({ fs, path, dryRun: false, tool: 'edit' }, upper);
    const after = Date.now();
    const modified = Date.parse(done.modified);
    assert.ok(modified >= before && modified <= after, done.modified);
    assert.equal(calls, 2);
  });

  it('a real write keeps the file mode', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return t.skip('needs POSIX permissions as non-root');
    }
    await chmod(path, 0o600);
    await rewriteFile({ fs, path, dryRun: false, tool: 'edit' }, upper);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  const nonText = async (): Promise<Record<string, string>> => {
    const files: Record<string, Buffer> = {
      'a.png': Buffer.from('plain text'),
      'bom.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]),
      'late.txt': Buffer.concat([Buffer.alloc(600, 'a'), Buffer.from([0xe9])]),
      'big.txt': Buffer.alloc(MIB + 1, 'a'),
    };
    const paths: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(files)) {
      paths[name] = join(root, name);
      await writeFile(paths[name], bytes);
    }
    return paths;
  };

  it('rewriteFile refuses a non-text file with today’s errors', async () => {
    const paths = await nonText();
    let ran = false;
    const spy = (c: string): Change<number> => {
      ran = true;
      return upper(c);
    };
    await withEnv({ FS_MAX_FILE_SIZE: String(MIB) }, async () => {
      const cases: [string, string, ErrorCode, RegExp][] = [
        ['a.png', 'edit', ErrorCode.INVALID_INPUT, /^Binary file detected\.$/],
        ['bom.txt', 'edit', ErrorCode.INVALID_INPUT, /^UTF-16 text file detected/],
        ['late.txt', 'edit', ErrorCode.INVALID_INPUT, /^Binary or non-UTF-8 file detected\.$/],
        ['big.txt', 'patch', ErrorCode.TOO_LARGE, /^File too large for patch/],
      ];
      for (const [name, tool, code, message] of cases) {
        const target = paths[name] ?? '';
        const before = await readFile(target);
        await assert.rejects(
          rewriteFile({ fs, path: target, dryRun: false, tool }, spy),
          fsErrorMatcher(code, message),
        );
        assert.deepEqual(await readFile(target), before, name);
      }
    });
    assert.equal(ran, false);
  });

  it('rewriteEntry returns the verdict without transforming', async () => {
    const paths = await nonText();
    let ran = false;
    const spy = (bytes: Buffer): Promise<Change<number>> => {
      ran = true;
      return Promise.resolve(upper(bytes.toString('utf8')));
    };
    await withEnv({ FS_MAX_FILE_SIZE: String(MIB) }, async () => {
      const kinds: Record<string, unknown> = {};
      for (const [name, target] of Object.entries(paths)) {
        kinds[name] = await rewriteEntry({ fs, path: target, dryRun: false }, spy);
      }
      assert.deepEqual(kinds, {
        'a.png': { kind: 'binary' },
        'bom.txt': { kind: 'binary' },
        'late.txt': { kind: 'undecodable' },
        'big.txt': { kind: 'tooLarge', size: MIB + 1 },
      });
    });
    assert.equal(ran, false);
  });

  it('rewriteEntry writes nothing when the transform declines', async () => {
    const done = await rewriteEntry({ fs, path, dryRun: false }, () => Promise.resolve(undefined));
    assert.equal(done, undefined);
    assert.equal(await readFile(path, 'utf8'), 'hello\n');
  });

  it('a transform that throws writes nothing', async () => {
    const failure = new Error('no');
    await assert.rejects(
      rewriteFile({ fs, path, dryRun: false, tool: 'edit' }, () => {
        throw failure;
      }),
      (error: unknown) => error === failure,
    );
    assert.equal(await readFile(path, 'utf8'), 'hello\n');
  });
});
