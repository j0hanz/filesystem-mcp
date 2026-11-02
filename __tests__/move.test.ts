import assert from 'node:assert/strict';
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type * as z from 'zod/v4';

import { GuardedFileSystem } from '../src/core/fs.ts';
import { MOVE } from '../src/tools/move.ts';
import { READ } from '../src/tools/read.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  makeGuard,
  trySymlink,
  withEnv,
  writeTestFile,
} from './helpers.ts';
import { choose, runToolBodyResult, type ToolBodyOptions } from './tool-harness.ts';

type MoveArgs = z.input<typeof MOVE.def.input>;
interface MoveStructured {
  readonly moves: readonly { from: string; to: string }[];
  readonly failures?: readonly {
    source: string;
    destination: string;
    error: { code: string; message: string; path?: string; suggestion?: string };
  }[];
  readonly skipped?: readonly string[];
}
type MoveRun = Awaited<ReturnType<typeof runToolBodyResult<typeof MOVE.def.input, object>>> & {
  readonly structured: MoveStructured;
};

describe('move body', () => {
  let root: string;
  let outside: string;
  let fs: GuardedFileSystem;

  before(async () => {
    root = await createTestRoot();
    outside = await createTestRoot();
    fs = new GuardedFileSystem(await makeGuard([root]));
  });

  after(async () => {
    await cleanupTestRoot(root);
    await cleanupTestRoot(outside);
  });

  const move = async (args: MoveArgs, options: Partial<ToolBodyOptions> = {}): Promise<MoveRun> =>
    runToolBodyResult(MOVE, args, { fs, ...options });

  it('is a total failure when every requested copy was denied', async () => {
    const source = await writeTestFile(root, 'movable.txt', 'body');
    const result = await move({
      moves: [{ source, destination: join(outside, 'move_denied.txt') }],
      copy: true,
    });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structured.failures?.[0]?.error.code, 'ACCESS_DENIED');
  });

  it('refuses an NTFS stream destination for a copy and writes nothing', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('alternate data streams are an NTFS feature');
      return;
    }
    const source = await writeTestFile(root, 'ads/ads-src.txt', 'body');
    const before = await readdir(join(root, 'ads'));
    const result = await move({
      copy: true,
      moves: [{ source, destination: join(root, 'ads', 'ads-dst.txt:hidden') }],
    });
    assert.strictEqual(result.isError, true);
    const failure = result.structured.failures?.[0];
    assert.strictEqual(failure?.error.code, 'INVALID_INPUT');
    assert.match(failure?.error.message ?? '', /NTFS alternate data streams are not supported/);
    assert.deepStrictEqual(await readdir(join(root, 'ads')), before, 'no host file was created');
  });

  it('performs a case-only rename (a Respelling) on a case-insensitive filesystem', async (t) => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      t.skip('case-only rename is only special on a case-insensitive filesystem');
      return;
    }
    const dir = join(root, 'case_rename');
    const lower = await writeTestFile(root, 'case_rename/foo.txt', 'same bytes\n');
    const upper = join(dir, 'Foo.txt');

    const result = await move({ moves: [{ source: lower, destination: upper }] });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structured.moves.length, 1, 'a Respelling is real work, not a no-op');
    assert.deepStrictEqual(await readdir(dir), ['Foo.txt']);
    assert.strictEqual(await readFile(upper, 'utf-8'), 'same bytes\n');
  });

  it('skips a Self-move without prompting, failing, or touching the file', async () => {
    const file = await writeTestFile(root, 'self_move.txt', 'stay\n');
    for (const copy of [false, true]) {
      const result = await move(
        { moves: [{ source: file, destination: file }], copy },
        {
          confirm: () => {
            throw new Error('a Self-move must not prompt');
          },
        },
      );
      assert.notStrictEqual(result.isError, true);
      assert.deepStrictEqual(result.structured.moves, []);
      assert.strictEqual(result.structured.failures, undefined);
      assert.strictEqual(result.text, `${copy ? 'copy' : 'move'}: nothing`);
      assert.strictEqual(await readFile(file, 'utf-8'), 'stay\n');
    }
  });

  it('copies over an existing destination without asking under overwrite: true', async () => {
    const src = await writeTestFile(root, 'copy_ow_src.txt', 'new source');
    const dst = await writeTestFile(root, 'copy_ow_dst.txt', 'existing dst');

    const result = await move(
      { moves: [{ source: src, destination: dst }], copy: true, overwrite: true },
      {
        confirm: () => {
          throw new Error('overwrite: true must not prompt');
        },
      },
    );
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(dst, 'utf-8'), 'new source');
  });

  it('copies a single file and leaves the source in place', async () => {
    const src = await writeTestFile(root, 'copy_src.txt', 'copy content');
    const dst = join(root, 'copy_dst.txt');

    const result = await move({ moves: [{ source: src, destination: dst }], copy: true });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(src, 'utf-8'), 'copy content');
    assert.strictEqual(await readFile(dst, 'utf-8'), 'copy content');
  });

  it('fails NOT_FOUND naming the source when it does not exist', async () => {
    for (const copy of [false, true]) {
      const src = join(root, `missing_src_${String(copy)}.txt`);
      const dst = join(root, `missing_dst_${String(copy)}.txt`);
      const result = await move({ moves: [{ source: src, destination: dst }], copy });

      assert.strictEqual(result.isError, true);
      const failures = result.structured.failures ?? [];
      assert.strictEqual(failures.length, 1);
      assert.strictEqual(failures[0]?.error.code, 'NOT_FOUND');
      assert.strictEqual(failures[0]?.error.path, src);
      assert.doesNotMatch(failures[0]?.error.suggestion ?? '', /list_roots/);
    }
  });

  it('moves a dangling symlink as the link itself', async (t) => {
    const link = join(root, 'move_dangling_link');
    const dst = join(root, 'move_dangling_link_moved');
    const target = join(root, 'move_dangling_gone.txt');
    if (!(await trySymlink(target, link, () => t.skip('symlink creation not permitted'), 'file'))) {
      return;
    }

    const result = await move({ moves: [{ source: link, destination: dst }] });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual((await lstat(dst)).isSymbolicLink(), true);
    assert.strictEqual(await readlink(dst), target);
  });

  it('copies a directory recursively', async () => {
    const srcDir = join(root, 'copy_src_dir');
    const dstDir = join(root, 'copy_dst_dir');
    await writeTestFile(root, 'copy_src_dir/file1.txt', 'file1');
    await writeTestFile(root, 'copy_src_dir/sub/file2.txt', 'file2');

    const result = await move({ moves: [{ source: srcDir, destination: dstDir }], copy: true });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(join(dstDir, 'file1.txt'), 'utf-8'), 'file1');
    assert.strictEqual(await readFile(join(dstDir, 'sub', 'file2.txt'), 'utf-8'), 'file2');
  });

  it('refuses to copy an out-of-root source', async () => {
    const outsideFile = await writeTestFile(outside, 'outside_copy.txt', 'secret');
    const stolen = join(root, 'stolen.txt');
    const result = await move({
      moves: [{ source: outsideFile, destination: stolen }],
      copy: true,
    });
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.structured.failures?.[0]?.error.code, 'ACCESS_DENIED');
    await assert.rejects(access(stolen));
  });

  it('refuses, for move and copy alike, a destination inside the source directory', async () => {
    // `planTransfer` runs ONE containment guard for both ops; a directory moved
    // or copied into its own subtree recurses into itself.
    const srcDir = join(root, 'selfnest_src');
    await writeTestFile(root, 'selfnest_src/f.txt', 'x');
    const inside = join(srcDir, 'nested', 'target');

    for (const copy of [false, true]) {
      const label = `copy=${String(copy)}`;
      const result = await move({ moves: [{ source: srcDir, destination: inside }], copy });
      assert.strictEqual(result.isError, true, `${label} must be refused`);
      const failures = result.structured.failures ?? [];
      assert.strictEqual(failures.length, 1, `${label} reports one failure`);
      assert.strictEqual(failures[0]?.error.code, 'INVALID_INPUT', label);
      assert.match(failures[0]?.error.message ?? '', /own subdirectory/, label);
      await assert.rejects(access(inside), `${label} created nothing`);
    }
  });

  it('refuses a directory whose tree contains a path-denied file', async (t) => {
    // `secrets/**` is path-based: it denies secrets/x.txt but not public/x.txt,
    // so moving the directory used to carry the file out of the rule.
    await withEnv({ FS_DENYLIST: 'secrets/**,linked-secrets/**' }, async () => {
      const own = await createTestRoot();
      try {
        const ownFs = new GuardedFileSystem(await makeGuard([own]));
        const run = (args: MoveArgs) => move(args, { fs: ownFs });
        const failureOf = (result: MoveRun) => result.structured.failures?.[0]?.error;
        const secret = await writeTestFile(own, 'secrets/inner/x.txt', 'top secret\n');
        const plainDir = join(own, 'plain');
        await writeTestFile(own, 'plain/ok.txt', 'ok\n');

        for (const copy of [false, true]) {
          const label = `copy=${String(copy)}`;
          const result = await run({
            moves: [{ source: join(own, 'secrets'), destination: join(own, 'public') }],
            copy,
          });
          assert.strictEqual(result.isError, true, `${label} must be refused`);
          assert.strictEqual(failureOf(result)?.code, 'ACCESS_DENIED', label);
          assert.match(failureOf(result)?.message ?? '', /protected/i, label);
          await assert.rejects(access(join(own, 'public')), `${label} created nothing`);
          assert.strictEqual(await readFile(secret, 'utf-8'), 'top secret\n', label);
        }

        const linkedTarget = join(own, 'linked-target');
        await writeTestFile(own, 'linked-target/inner/x.txt', 'via symlink\n');
        const linkedSource = join(own, 'linked-secrets');
        if (
          await trySymlink(linkedTarget, linkedSource, () =>
            t.diagnostic('symlink not permitted; symlinked directory coverage skipped'),
          )
        ) {
          const copied = await run({
            moves: [{ source: linkedSource, destination: join(own, 'public-link') }],
            copy: true,
          });
          assert.strictEqual(copied.isError, true, 'symlink copy must be refused');
          assert.strictEqual(failureOf(copied)?.code, 'ACCESS_DENIED', 'symlink copy');
          assert.match(failureOf(copied)?.message ?? '', /protected/i, 'symlink copy');
          await assert.rejects(access(join(own, 'public-link')), 'symlink copy created nothing');
          assert.strictEqual(
            await readFile(join(linkedSource, 'inner/x.txt'), 'utf-8'),
            'via symlink\n',
          );

          const moved = await run({
            moves: [{ source: linkedSource, destination: join(own, 'public-link') }],
          });
          assert.notStrictEqual(moved.isError, true, 'symlink move must succeed');
          await access(join(own, 'public-link'));
          assert.strictEqual(
            await readFile(join(linkedTarget, 'inner/x.txt'), 'utf-8'),
            'via symlink\n',
            'symlink move left the linked target intact',
          );
        }

        const credentialsDir = join(own, 'credentials-dir');
        const credentials = await writeTestFile(own, 'credentials-dir/credentials', 'key\n');
        for (const copy of [false, true]) {
          const label = `destination copy=${String(copy)}`;
          const result = await run({
            moves: [{ source: credentialsDir, destination: join(own, '.aws') }],
            copy,
          });
          assert.strictEqual(result.isError, true, `${label} must be refused`);
          assert.strictEqual(failureOf(result)?.code, 'ACCESS_DENIED', label);
          assert.match(failureOf(result)?.message ?? '', /protected/i, label);
          await assert.rejects(access(join(own, '.aws')), `${label} created nothing`);
          assert.strictEqual(await readFile(credentials, 'utf-8'), 'key\n', label);
        }

        const proj = join(own, 'proj');
        await writeTestFile(own, 'proj/.env', 'SECRET=1\n');
        await writeTestFile(own, 'proj/app.ts', 'x\n');
        const envMove = await run({
          moves: [{ source: proj, destination: join(own, 'proj-moved') }],
        });
        assert.notStrictEqual(envMove.isError, true);
        assert.strictEqual(await readFile(join(own, 'proj-moved', 'app.ts'), 'utf-8'), 'x\n');
        await access(join(own, 'proj-moved', '.env'));
        const envRead = await runToolBodyResult(
          READ,
          { path: join(own, 'proj-moved', '.env') },
          { fs: ownFs },
        );
        assert.strictEqual(envRead.isError, true);

        // A clean tree still moves: the pre-walk must not refuse everything.
        const clean = await run({ moves: [{ source: plainDir, destination: join(own, 'moved') }] });
        assert.notStrictEqual(clean.isError, true);
        assert.strictEqual(await readFile(join(own, 'moved', 'ok.txt'), 'utf-8'), 'ok\n');
      } finally {
        await cleanupTestRoot(own);
      }
    });
  });

  describe('overwrite Confirmation', () => {
    for (const copy of [false, true]) {
      const op = copy ? 'copy' : 'move';

      it(`${op}: Skip leaves source and destination intact`, async () => {
        const src = await writeTestFile(root, `${op}_skip_src.txt`, 'new source');
        const dst = await writeTestFile(root, `${op}_skip_dst.txt`, 'existing dst');
        const asked: string[] = [];
        const result = await move(
          { moves: [{ source: src, destination: dst }], copy },
          {
            confirm: (prompt) => {
              asked.push(prompt.message);
              assert.deepStrictEqual(prompt.choices, ['overwrite', 'skip']);
              return { action: 'accept', content: { choice: 'skip' } };
            },
          },
        );
        assert.notStrictEqual(result.isError, true);
        assert.strictEqual(asked.length, 1);
        assert.match(asked[0] ?? '', /already exists/);
        assert.strictEqual(result.structured.moves.length, 0);
        assert.ok(result.structured.skipped?.includes(dst));
        assert.match(result.text ?? '', /SKIPPED/);
        assert.strictEqual(await readFile(src, 'utf-8'), 'new source');
        assert.strictEqual(await readFile(dst, 'utf-8'), 'existing dst');
      });

      it(`${op}: an approved overwrite replaces the destination`, async () => {
        const src = await writeTestFile(root, `${op}_ow_src.txt`, 'new source');
        const dst = await writeTestFile(root, `${op}_ow_dst.txt`, 'existing dst');
        const result = await move(
          { moves: [{ source: src, destination: dst }], copy },
          { confirm: choose('overwrite') },
        );
        assert.notStrictEqual(result.isError, true);
        assert.strictEqual(result.rounds, 1);
        assert.strictEqual(result.structured.moves.length, 1);
        assert.strictEqual(result.structured.skipped, undefined);
        assert.strictEqual(await readFile(dst, 'utf-8'), 'new source');
        if (copy) assert.strictEqual(await readFile(src, 'utf-8'), 'new source');
        else await assert.rejects(access(src));
      });

      it(`${op}: a declined overwrite is CANCELLED and changes nothing`, async () => {
        const src = await writeTestFile(root, `${op}_decline_src.txt`, 'new source');
        const dst = await writeTestFile(root, `${op}_decline_dst.txt`, 'existing dst');
        // A refused pair cancels the call; the executor answers it as a tool error.
        await assert.rejects(
          move(
            { moves: [{ source: src, destination: dst }], copy },
            { confirm: () => ({ action: 'decline' }) },
          ),
          { code: 'CANCELLED', message: /overwrite of .* was declined by the user/ },
        );
        assert.strictEqual(await readFile(src, 'utf-8'), 'new source');
        assert.strictEqual(await readFile(dst, 'utf-8'), 'existing dst');
      });
    }

    it('cancels a destination replaced again while the prompt was open', async () => {
      const src = await writeTestFile(root, 'replaced_src.txt', 'new source');
      const dst = await writeTestFile(root, 'replaced_dst.txt', 'v1');
      let calls = 0;
      const run = move(
        { moves: [{ source: src, destination: dst }] },
        {
          confirm: async () => {
            calls += 1;
            // Swapped once before each answer: the reprompt shows the new entry,
            // and a second swap after it is refused rather than overwritten.
            await mkdir(join(root, 'swap'), { recursive: true });
            const swapped = join(root, 'swap', `v${String(calls)}`);
            await writeFile(swapped, `v${String(calls + 1)}`);
            await rename(swapped, dst);
            return { action: 'accept', content: { choice: 'overwrite' } };
          },
        },
      );
      await assert.rejects(run, {
        code: 'CANCELLED',
        message: /replaced again while the prompt was open/,
      });
      assert.strictEqual(calls, 2, 'asked, then asked again about the swapped entry');
      assert.strictEqual(await readFile(src, 'utf-8'), 'new source');
    });
  });

  // H3 (2026-10 bug hunt): an overlapping move batch is refused with no data loss.
  describe('overlapping batches', () => {
    it('refuses a swap [A->B, B->A] and both files survive', async () => {
      const a = await writeTestFile(root, 'swapA', 'AAA\n');
      const b = await writeTestFile(root, 'swapB', 'BBB\n');
      const result = await move({
        moves: [
          { source: a, destination: b },
          { source: b, destination: a },
        ],
      });
      assert.strictEqual(result.isError, true, 'a doomed swap is a total failure');
      assert.strictEqual(await readFile(a, 'utf-8'), 'AAA\n');
      assert.strictEqual(await readFile(b, 'utf-8'), 'BBB\n');
    });

    it('refuses a chain [B->C, A->B] and destroys no file', async () => {
      const a = await writeTestFile(root, 'chainA', 'AAA\n');
      const b = await writeTestFile(root, 'chainB', 'BBB\n');
      const c = join(root, 'chainC');
      const result = await move({
        moves: [
          { source: b, destination: c },
          { source: a, destination: b },
        ],
      });
      assert.strictEqual(result.isError, true);
      assert.strictEqual(await readFile(a, 'utf-8'), 'AAA\n');
      assert.strictEqual(await readFile(b, 'utf-8'), 'BBB\n');
      await assert.rejects(readFile(c, 'utf-8'), 'C must never be created');
    });

    it('still runs independent moves in one batch', async () => {
      const x = await writeTestFile(root, 'indX', 'X\n');
      const y = await writeTestFile(root, 'indY', 'Y\n');
      const result = await move({
        moves: [
          { source: x, destination: join(root, 'indX2') },
          { source: y, destination: join(root, 'indY2') },
        ],
      });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(await readFile(join(root, 'indX2'), 'utf-8'), 'X\n');
      assert.strictEqual(await readFile(join(root, 'indY2'), 'utf-8'), 'Y\n');
    });
  });
});
