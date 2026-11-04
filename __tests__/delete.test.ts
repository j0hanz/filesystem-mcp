import assert from 'node:assert/strict';
import { access, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type * as z from 'zod/v4';

import { ErrorCode, FsError } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { IS_CASE_INSENSITIVE_FS } from '../src/core/path-utils.ts';
import { PathGuard } from '../src/core/path.ts';
import { UndoJournal } from '../src/core/undo.ts';
import { DELETE, nestedIndexes } from '../src/tools/delete.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  makeGuard,
  trySymlink,
  withEnv,
  writeTestFile,
} from './helpers.ts';
import { choose, runToolBodyResult, type ToolBodyOptions } from './tool-harness.ts';

type DeleteArgs = z.input<typeof DELETE.def.input>;
interface DeleteStructured {
  readonly results: readonly {
    path: string;
    value?: { deleted: boolean };
    error?: { code: string; message: string };
  }[];
  readonly summary: { total: number; succeeded: number; failed: number };
}
type DeleteRun = Awaited<ReturnType<typeof runToolBodyResult<typeof DELETE.def.input, object>>> & {
  readonly structured: DeleteStructured;
};

function only(result: DeleteRun): DeleteStructured['results'][number] {
  assert.strictEqual(result.structured.results.length, 1);
  const [entry] = result.structured.results;
  assert.ok(entry);
  return entry;
}

describe('delete body', () => {
  let root: string;
  let fs: GuardedFileSystem;

  before(async () => {
    root = await createTestRoot();
    fs = new GuardedFileSystem(await makeGuard([root]));
  });

  after(async () => {
    await cleanupTestRoot(root);
  });

  const del = async (
    args: DeleteArgs,
    options: Partial<ToolBodyOptions> = {},
  ): Promise<DeleteRun> => runToolBodyResult(DELETE, args, { fs, ...options });

  /** A recursive delete of a non-empty directory is what asks for approval. */
  const nonEmptyDir = async (name: string): Promise<string> => {
    const dir = join(root, name);
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', 'f.txt'), 'x');
    return dir;
  };

  it('names at most 3 failed paths, with code and reason, in a partial batch', async () => {
    const good = await writeTestFile(root, 'del_partial_ok.txt', 'x');
    const missing = ['a', 'b', 'c', 'd'].map((n) => join(root, `del_partial_${n}.txt`));
    const result = await del({ paths: [good, ...missing] });

    assert.strictEqual(result.structured.summary.failed, 4);
    const [head, ...reasons] = (result.text ?? '').split('\n');
    assert.match(head ?? '', /\(1\/5 ok\)$/);
    assert.deepStrictEqual(
      reasons,
      result.structured.results
        .filter((r) => r.error)
        .slice(0, 3)
        .map((r) => `// ${r.path}: ${r.error?.code ?? ''} ${r.error?.message ?? ''}`),
    );
  });

  it('refuses a workspace root, naming the root rather than the parent', async () => {
    // The parent of a root is out-of-root by construction, so the containment
    // check used to answer "Outside allowed directories" for the one directory
    // list_roots reports as allowed.
    const result = await del({ paths: [root], recursive: true });

    assert.strictEqual(result.isError, true);
    assert.match(result.text ?? '', /workspace root/i);
    await access(root);
  });

  it('refuses an allowed root reached through an aliasing junction', async (t) => {
    const top = await createTestRoot();
    const a = join(top, 'a');
    const b = join(a, 'b');
    try {
      await mkdir(b, { recursive: true });
      await writeFile(join(b, 'keep.txt'), 'keep');
      if (!(await trySymlink(a, join(a, 'j'), () => t.skip('symlink creation not permitted')))) {
        return;
      }
      const result = await del(
        { paths: [join(a, 'j', 'b')], recursive: true },
        { fs: new GuardedFileSystem(await makeGuard([a, b])) },
      );
      assert.strictEqual(result.isError, true);
      assert.match(result.text ?? '', /workspace root/i);
      await access(join(b, 'keep.txt'));
    } finally {
      await cleanupTestRoot(top);
    }
  });

  it('refuses a directory that holds another allowed root, and spares its neighbours', async () => {
    const top = await createTestRoot();
    const a = join(top, 'a');
    const sub = join(a, 'sub');
    const b = join(sub, 'proj');
    try {
      await mkdir(b, { recursive: true });
      await mkdir(join(a, 'other'));
      await writeFile(join(b, 'keep.txt'), 'keep');
      await writeFile(join(sub, 'beside.txt'), 'x');
      const guard = await makeGuard([a, b]);
      const result = await del(
        { paths: [sub], recursive: true },
        { fs: new GuardedFileSystem(guard) },
      );
      assert.strictEqual(result.isError, true);
      assert.match(result.text ?? '', /Allowed root inside/);
      await access(join(b, 'keep.txt'));

      // A copy leaves its source in place, so it may still read the parent.
      await guard.validatePathForDelete(sub, { allowReadOnly: true });
      // The check covers only directories that hold the root.
      await guard.validatePathForDelete(join(sub, 'beside.txt'));
      await guard.validatePathForDelete(join(a, 'other'));
    } finally {
      await cleanupTestRoot(top);
    }
  });

  describe('a nested root under an aliased parent', () => {
    // With /alias -> /real and roots /alias and /alias/sub/proj, a target resolves
    // to /real/sub, and a root that does not resolve is spelled nowhere under it.
    const aliasedTree = async (
      top: string,
      t: { skip: (message: string) => void },
    ): Promise<{ real: string; alias: string } | undefined> => {
      const real = join(top, 'real');
      const alias = join(top, 'alias');
      await mkdir(join(real, 'sub'), { recursive: true });
      await writeFile(join(real, 'sub', 'beside.txt'), 'x');
      await mkdir(join(real, 'other'));
      const linked = await trySymlink(real, alias, () => t.skip('symlink creation not permitted'));
      return linked ? { real, alias } : undefined;
    };
    const guardFor = async (roots: string[]): Promise<PathGuard> => {
      const guard = new PathGuard({ cliAllowedDirs: roots });
      await withEnv({ FS_ALLOW_MISSING_ROOTS: '1' }, () => guard.recomputeAllowedDirectories());
      return guard;
    };

    it('refuses the parent of a missing root', async (t) => {
      const top = await createTestRoot();
      try {
        const tree = await aliasedTree(top, t);
        if (!tree) return;
        const guard = await guardFor([tree.alias, join(tree.alias, 'sub', 'proj')]);
        const result = await del(
          { paths: [join(tree.alias, 'sub')], recursive: true },
          { fs: new GuardedFileSystem(guard) },
        );
        assert.strictEqual(result.isError, true);
        assert.match(result.text ?? '', /Allowed root inside/);
        await access(join(tree.real, 'sub', 'beside.txt'));

        await guard.validatePathForDelete(join(tree.alias, 'sub', 'beside.txt'));
        await guard.validatePathForDelete(join(tree.alias, 'other'));
      } finally {
        await cleanupTestRoot(top);
      }
    });

    it('refuses the parent of a symlink root, and the link by its real spelling', async (t) => {
      const top = await createTestRoot();
      try {
        const tree = await aliasedTree(top, t);
        if (!tree) return;
        const elsewhere = join(top, 'elsewhere');
        await mkdir(elsewhere);
        const link = join(tree.real, 'sub', 'proj');
        if (!(await trySymlink(elsewhere, link, () => t.skip('symlink creation not permitted')))) {
          return;
        }
        const guard = await guardFor([tree.alias, join(tree.alias, 'sub', 'proj')]);
        const fs = new GuardedFileSystem(guard);

        const parent = await del({ paths: [join(tree.alias, 'sub')], recursive: true }, { fs });
        assert.strictEqual(parent.isError, true);
        assert.match(parent.text ?? '', /Allowed root inside/);

        const self = await del({ paths: [link] }, { fs });
        assert.strictEqual(self.isError, true);
        assert.match(self.text ?? '', /workspace root/i);
        assert.ok((await lstat(link)).isSymbolicLink());

        // A copy leaves its source in place, so it may still read both.
        await guard.validatePathForDelete(join(tree.alias, 'sub'), { allowReadOnly: true });
        await guard.validatePathForDelete(link, { allowReadOnly: true });
      } finally {
        await cleanupTestRoot(top);
      }
    });
  });

  it('leaves the directory in place when the user picks Skip', async () => {
    const dir = await nonEmptyDir('del_skip_dir');
    const asked: string[] = [];
    const result = await del(
      { paths: [dir], recursive: true },
      {
        confirm: (prompt) => {
          asked.push(prompt.message);
          assert.deepStrictEqual(prompt.choices, ['delete', 'skip']);
          return { action: 'accept', content: { choice: 'skip' } };
        },
      },
    );

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(asked.length, 1);
    assert.match(asked[0] ?? '', /^Delete ".*del_skip_dir" and all its contents\?$/);
    assert.strictEqual(result.structured.summary.failed, 0);
    // Skip is a successful outcome with `deleted: false`, not a failure.
    assert.strictEqual(only(result).path.toLowerCase(), dir.toLowerCase());
    assert.deepStrictEqual(only(result).value, { deleted: false });
    assert.match(result.text ?? '', /SKIPPED/);
    await access(dir);
  });

  it('removes the directory once the delete is approved', async () => {
    const dir = await nonEmptyDir('del_choice_dir');
    const result = await del({ paths: [dir], recursive: true }, { confirm: choose('delete') });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.rounds, 1);
    assert.strictEqual(result.structured.summary.failed, 0);
    assert.strictEqual(only(result).path.toLowerCase(), dir.toLowerCase());
    assert.deepStrictEqual(only(result).value, { deleted: true });
    await assert.rejects(access(dir));
  });

  it('deletes nothing until answered, then runs the non-pending paths alongside', async () => {
    const dir = await nonEmptyDir('del_atomic_dir');
    const plain = await writeTestFile(root, 'del_atomic_plain.txt', 'x');
    const result = await del(
      { paths: [plain, dir], recursive: true },
      {
        confirm: async (prompt) => {
          // R14: the round is atomic, so the plain file waits for the answer too.
          await access(plain);
          assert.match(prompt.message, /del_atomic_dir/);
          return { action: 'accept', content: { choice: 'delete' } };
        },
      },
    );

    assert.notStrictEqual(result.isError, true);
    assert.deepStrictEqual(
      result.structured.results.map((r) => r.value?.deleted),
      [true, true],
      'results keep the caller order',
    );
    await assert.rejects(access(plain));
    await assert.rejects(access(dir));
  });

  /** Deletes `dir` recursively, answering the prompt, and returns what it said. */
  const promptFor = async (dir: string, choice: 'delete' | 'skip'): Promise<string> => {
    let message = '';
    await del(
      { paths: [dir], recursive: true },
      {
        confirm: (prompt) => {
          message = prompt.message;
          return choose(choice)();
        },
      },
    );
    return message;
  };

  it('warns in the confirmation when the folder holds a protected file', async () => {
    const dir = join(root, 'holds_env');
    await mkdir(join(dir, 'deep', 'er'), { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'x');
    await writeFile(join(dir, 'deep', 'er', '.env'), 'X=1');

    const message = await promptFor(dir, 'delete');

    assert.match(message, /protected/);
    assert.match(message, /cannot be undone/);
    await assert.rejects(access(dir));
  });

  it('still honors skip after warning about a protected file', async () => {
    const dir = join(root, 'holds_env_skip');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.env'), 'X=1');

    const message = await promptFor(dir, 'skip');

    assert.match(message, /protected/);
    await access(join(dir, '.env'));
  });

  it('asks the plain question when the folder holds no protected file', async () => {
    const dir = await nonEmptyDir('holds_nothing');

    const message = await promptFor(dir, 'delete');

    // A regex, because the prompt names the normalized path, whose drive letter
    // can differ in case from `dir` on Windows.
    assert.match(message, /^Delete ".*holds_nothing" and all its contents\?$/);
  });

  it('reports an abort during the protected-file walk as cancelled, not unknown', async () => {
    const dir = join(root, 'holds_env_abort');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.env'), 'X=1');
    const controller = new AbortController();
    class AbortingFs extends GuardedFileSystem {
      override holdsProtectedEntry(v: string, r: string, s?: AbortSignal): Promise<boolean> {
        controller.abort();
        return super.holdsProtectedEntry(v, r, s);
      }
    }
    const aborting = new AbortingFs(await makeGuard([root]));
    let asked = false;

    const result = await del(
      { paths: [dir], recursive: true },
      {
        fs: aborting,
        signal: controller.signal,
        confirm: () => {
          asked = true;
          return choose('delete')();
        },
      },
    );

    assert.strictEqual(asked, false);
    assert.strictEqual(only(result).error?.code, ErrorCode.CANCELLED);
    await access(join(dir, '.env'));
  });

  it('a cancel during the undo snapshot deletes nothing and offers no undo', async () => {
    const tree = join(root, 'cancelled_tree');
    await mkdir(tree);
    await writeFile(join(tree, 'a.txt'), 'a');
    const controller = new AbortController();
    const capture = new UndoJournal().beginCapture();
    class CancelsDuringSnapshot extends GuardedFileSystem {
      override async readSaved(path: string): Promise<Buffer> {
        controller.abort();
        return super.readSaved(path);
      }
    }

    const result = await del(
      { paths: [tree], recursive: true },
      {
        fs: new CancelsDuringSnapshot(await makeGuard([root]), capture),
        signal: controller.signal,
        confirm: choose('delete'),
      },
    );

    assert.strictEqual(result.isError, true);
    assert.strictEqual(only(result).error?.code, ErrorCode.CANCELLED);
    await access(join(tree, 'a.txt'));
    assert.strictEqual(capture.records.length, 0, 'no undo id for a delete that never ran');
    assert.strictEqual(capture.unavailableReason(), undefined);
    capture.release();
  });

  it('a cancel on one path keeps the undo of a sibling already deleted', async () => {
    const treeA = join(root, 'sibling_tree_a');
    const treeB = join(root, 'sibling_tree_b');
    for (const tree of [treeA, treeB]) {
      await mkdir(tree);
      await writeFile(join(tree, 'a.txt'), 'a');
    }
    const controller = new AbortController();
    const capture = new UndoJournal().beginCapture();
    const gone = async (path: string): Promise<boolean> =>
      access(path).then(
        () => false,
        () => true,
      );
    class CancelsOnB extends GuardedFileSystem {
      override async readSaved(path: string): Promise<Buffer> {
        if (path.includes('sibling_tree_b')) {
          while (!(await gone(treeA))) await sleep(5);
          controller.abort();
        }
        return super.readSaved(path);
      }
    }

    const result = await del(
      { paths: [treeA, treeB], recursive: true },
      {
        fs: new CancelsOnB(await makeGuard([root]), capture),
        signal: controller.signal,
        confirm: choose('delete'),
      },
    );

    assert.strictEqual(result.structured.results[0]?.value?.deleted, true);
    assert.strictEqual(result.structured.results[1]?.error?.code, ErrorCode.CANCELLED);
    await access(join(treeB, 'a.txt'));
    assert.strictEqual(capture.unavailableReason(), undefined);
    const paths = capture.records.map((record) => ('path' in record ? record.path : ''));
    assert.strictEqual(paths.length, 2, 'the folder and the file of tree A');
    assert.ok(paths.every((path) => path.includes('sibling_tree_a')));
    capture.release();
  });

  it('dropping records under a path gives their budget back', () => {
    const capture = new UndoJournal(2000).beginCapture();
    const fill = (): void => {
      capture.push(
        ...['x', 'y', 'z'].map((name) => ({
          op: 'rmdir' as const,
          path: join(root, 'dropped', name),
        })),
      );
    };
    fill();
    capture.dropUnder(join(root, 'dropped'));
    assert.strictEqual(capture.records.length, 0);
    fill();
    assert.strictEqual(capture.unavailableReason(), undefined, 'the second fill still fits');
    assert.strictEqual(capture.records.length, 3);
    capture.release();
  });

  it('rejects when an abort lands during the protected-file walk', async () => {
    const dir = join(root, 'walk_abort');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'x');
    const controller = new AbortController();

    const pending = fs.holdsProtectedEntry(dir, dir, controller.signal);
    controller.abort();

    await assert.rejects(pending, { name: 'AbortError' });
  });

  it('refuses a directory the protected-file walk cannot read', async () => {
    const file = join(root, 'walk_not_a_dir.txt');
    await writeFile(file, 'x');

    await assert.rejects(fs.holdsProtectedEntry(file, file), {
      code: ErrorCode.ACCESS_DENIED,
    });
  });

  it('treats an entry that vanished before the walk as holding nothing', async () => {
    const gone = join(root, 'never_existed');

    assert.strictEqual(await fs.holdsProtectedEntry(gone, gone), false);
  });

  it('refuses before any prompt when the protected-file walk fails', async () => {
    const dir = await nonEmptyDir('walk_fails');
    class FailingFs extends GuardedFileSystem {
      override holdsProtectedEntry(v: string): Promise<boolean> {
        return Promise.reject(new FsError(ErrorCode.ACCESS_DENIED, 'x', v));
      }
    }
    const failing = new FailingFs(await makeGuard([root]));
    let asked = false;

    const result = await del(
      { paths: [dir], recursive: true },
      {
        fs: failing,
        confirm: () => {
          asked = true;
          return choose('delete')();
        },
      },
    );

    assert.strictEqual(asked, false);
    assert.strictEqual(only(result).error?.code, ErrorCode.ACCESS_DENIED);
    await access(dir);
  });

  it('reports a declined delete as CANCELLED and keeps the directory', async () => {
    const dir = await nonEmptyDir('del_declined_dir');
    const result = await del(
      { paths: [dir], recursive: true },
      { confirm: () => ({ action: 'decline' }) },
    );

    assert.strictEqual(result.isError, true);
    const error = result.structured.results[0]?.error;
    assert.strictEqual(error?.code, 'CANCELLED');
    assert.match(error?.message ?? '', /declined by the user/);
    assert.match(result.text ?? '', /FAILED — Delete cancelled/);
    await access(join(dir, 'sub', 'f.txt'));
  });
});

describe('nestedIndexes', () => {
  const root = resolve('nested-root');
  const p = (...names: string[]) => names.map((n) => resolve(root, n));

  it('a parent and its child', () => {
    assert.deepEqual(nestedIndexes(p('a', 'a/b')), new Set([0, 1]));
  });
  it('a deep descendant', () => {
    assert.deepEqual(nestedIndexes(p('a', 'x', 'a/b/c/d')), new Set([0, 2]));
  });
  it('a shared name prefix is no nesting', () => {
    assert.equal(nestedIndexes(p('a', 'ab')).size, 0);
  });
  it('case-folded where the filesystem folds', { skip: !IS_CASE_INSENSITIVE_FS }, () => {
    assert.deepEqual(nestedIndexes(p('A', 'a/b')), new Set([0, 1]));
  });
  it('1,000 siblings', () => {
    assert.equal(nestedIndexes(p(...Array.from({ length: 1000 }, (_, i) => `d${i}`))).size, 0);
  });
});
