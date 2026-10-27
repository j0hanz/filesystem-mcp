import assert from 'node:assert/strict';
import { access, lstat, mkdir, readdir, readFile, rename, rm, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';

import { normalizePath } from '../src/core/path-utils.ts';
import {
  cleanupTestRoot,
  createElicitationClientPair,
  createTestRoot,
  trySymlink,
  withBoundary,
  writeTestFile,
} from './helpers.ts';

/**
 * Recursively delete `paths`, answering each prompt by the basename of the
 * directory it names and running `duringPrompt` once while the prompt is open.
 */
async function deleteAnsweringByName(
  root: string,
  args: { paths: string[]; ignoreIfNotExists?: boolean },
  answers: Readonly<Record<string, 'delete' | 'skip'>>,
  duringPrompt: () => Promise<void>,
) {
  let prompts = 0;
  const pair = await createElicitationClientPair([root], async (request) => {
    if (prompts++ === 0) await duringPrompt();
    const named = basename(/"([^"]+)"/.exec(request.params.message)?.[1] ?? '');
    const choice = answers[named];
    assert.ok(choice, `unexpected prompt: ${request.params.message}`);
    return { action: 'accept', content: { choice } };
  });
  try {
    const result = await pair.client.callTool({
      name: 'delete',
      arguments: { ...args, recursive: true },
    });
    const meta = result._meta as {
      results: {
        path: string;
        value?: { deleted: boolean };
        error?: { code: string; message: string };
      }[];
      summary: { total: number; succeeded: number; failed: number };
    };
    return { result, prompts, meta };
  } finally {
    await pair.close();
  }
}

describe('Mutation regressions', () => {
  it('delete binds its own identity after an access-grant round', async () => {
    const root = await createTestRoot();
    try {
      await withBoundary(root, async () => {
        const allowed = join(root, 'allowed');
        const dir = join(allowed, 'target');
        await writeTestFile(root, 'allowed/target/child.txt', 'original');
        const outside = await writeTestFile(root, 'outside/file.txt', 'outside');
        let prompts = 0;
        const pair = await createElicitationClientPair([allowed], async () => {
          prompts++;
          return prompts === 1
            ? { action: 'accept', content: { confirm: true } }
            : { action: 'accept', content: { choice: 'delete' } };
        });
        try {
          const result = await pair.client.callTool({
            name: 'delete',
            arguments: { paths: [dir, outside], recursive: true },
          });
          assert.strictEqual(prompts, 2);
          assert.notStrictEqual(result.isError, true, JSON.stringify(result));
          await assert.rejects(access(dir), { code: 'ENOENT' });
          await assert.rejects(access(outside), { code: 'ENOENT' });
        } finally {
          await pair.close();
        }
      });
    } finally {
      await cleanupTestRoot(root);
    }
  });

  for (const replacement of ['empty directory', 'nonempty directory', 'file']) {
    for (const choice of ['skip', 'delete'] as const) {
      for (const batch of [false, true]) {
        it(`delete ${choice} preserves a replacement ${replacement}${batch ? ' alongside an unrelated file' : ''}`, async () => {
          const root = await createTestRoot();
          let pair: Awaited<ReturnType<typeof createElicitationClientPair>> | undefined;
          try {
            const dir = join(root, 'target');
            const original = join(root, 'original');
            await writeTestFile(root, 'target/child.txt', 'original');
            const unrelated = await writeTestFile(root, 'unrelated.txt', 'unrelated');
            let prompts = 0;
            pair = await createElicitationClientPair([root], async () => {
              prompts++;
              if (prompts === 1) {
                await rename(dir, original);
                if (replacement === 'file') {
                  await writeTestFile(root, 'target', 'replacement');
                } else {
                  await mkdir(dir);
                  if (replacement === 'nonempty directory') {
                    await writeTestFile(root, 'target/child.txt', 'replacement');
                  }
                }
              }
              return { action: 'accept', content: { choice } };
            });
            const result = await pair.client.callTool({
              name: 'delete',
              arguments: { paths: batch ? [unrelated, dir] : [dir], recursive: true },
            });
            // The replacement is asked about again; the answer then applies to it.
            assert.strictEqual(prompts, 2);
            const meta = result._meta as {
              results: {
                path: string;
                value?: { deleted: boolean };
                error?: { code: string; message: string };
              }[];
              summary: { total: number; succeeded: number; failed: number };
            };
            assert.deepStrictEqual(meta.summary, {
              total: batch ? 2 : 1,
              succeeded: batch ? 2 : 1,
              failed: 0,
            });
            assert.notStrictEqual(result.isError, true);
            const target = meta.results.find((entry) => entry.path === normalizePath(dir));
            assert.ok(target);
            assert.deepStrictEqual(target.value, { deleted: choice === 'delete' });
            assert.strictEqual(await readFile(join(original, 'child.txt'), 'utf8'), 'original');
            if (choice === 'delete') {
              await assert.rejects(access(dir), { code: 'ENOENT' });
            } else if (replacement === 'file') {
              assert.strictEqual(await readFile(dir, 'utf8'), 'replacement');
            } else if (replacement === 'nonempty directory') {
              assert.strictEqual(await readFile(join(dir, 'child.txt'), 'utf8'), 'replacement');
            } else {
              assert.deepStrictEqual(await readdir(dir), []);
            }
            if (batch) await assert.rejects(access(unrelated), { code: 'ENOENT' });
            else assert.strictEqual(await readFile(unrelated, 'utf8'), 'unrelated');
          } finally {
            await pair?.close();
            await cleanupTestRoot(root);
          }
        });
      }
    }
  }

  for (const change of ['remove pending directory', 'add pending directory']) {
    it(`delete re-plans when confirmation paths change: ${change}`, async () => {
      const root = await createTestRoot();
      let pair: Awaited<ReturnType<typeof createElicitationClientPair>> | undefined;
      try {
        const dir = join(root, 'target');
        const other = join(root, 'other');
        await writeTestFile(root, 'target/child.txt', 'original');
        await mkdir(other);
        const unrelated = await writeTestFile(root, 'unrelated.txt', 'unrelated');
        let prompts = 0;
        pair = await createElicitationClientPair([root], async () => {
          prompts++;
          if (prompts === 1) {
            if (change === 'remove pending directory') await rename(dir, join(root, 'original'));
            else await writeTestFile(root, 'other/child.txt', 'new pending');
          }
          return { action: 'accept', content: { choice: 'delete' } };
        });
        const result = await pair.client.callTool({
          name: 'delete',
          arguments: {
            paths: [dir, other, unrelated],
            recursive: true,
            ignoreIfNotExists: true,
          },
        });
        assert.notStrictEqual(result.isError, true, JSON.stringify(result));
        await assert.rejects(access(other), { code: 'ENOENT' });
        await assert.rejects(access(unrelated), { code: 'ENOENT' });
        if (change === 'remove pending directory') {
          assert.strictEqual(prompts, 1);
          assert.strictEqual(
            await readFile(join(root, 'original', 'child.txt'), 'utf8'),
            'original',
          );
        } else {
          // One prompt per pending entry: target, then target and other re-prompted together.
          assert.strictEqual(prompts, 3);
          await assert.rejects(access(dir), { code: 'ENOENT' });
        }
      } finally {
        await pair?.close();
        await cleanupTestRoot(root);
      }
    });
  }

  for (const emptyDuringPrompt of [false, true]) {
    for (const choice of ['skip', 'delete'] as const) {
      it(`delete honors ${choice} when the directory ${emptyDuringPrompt ? 'becomes empty' : 'stays nonempty'} during confirmation`, async () => {
        const root = await createTestRoot();
        let pair: Awaited<ReturnType<typeof createElicitationClientPair>> | undefined;
        try {
          const dir = join(root, 'target');
          const child = await writeTestFile(root, 'target/child.txt', 'keep');
          let prompts = 0;
          pair = await createElicitationClientPair([root], async () => {
            prompts++;
            if (emptyDuringPrompt) await rm(child);
            return { action: 'accept', content: { choice } };
          });
          const result = await pair.client.callTool({
            name: 'delete',
            arguments: { paths: [dir], recursive: true },
          });
          assert.strictEqual(prompts, 1);
          assert.notStrictEqual(result.isError, true, JSON.stringify(result));
          const meta = result._meta as {
            results: { value: { deleted: boolean } }[];
            summary: { total: number; succeeded: number; failed: number };
          };
          assert.deepStrictEqual(meta.summary, { total: 1, succeeded: 1, failed: 0 });
          assert.strictEqual(meta.results[0]?.value.deleted, choice === 'delete');
          if (choice === 'delete') {
            await assert.rejects(access(dir), { code: 'ENOENT' });
          } else {
            await access(dir);
            assert.deepStrictEqual(await readdir(dir), emptyDuringPrompt ? [] : ['child.txt']);
            if (!emptyDuringPrompt) assert.strictEqual(await readFile(child, 'utf8'), 'keep');
          }
        } finally {
          await pair?.close();
          await cleanupTestRoot(root);
        }
      });
    }
  }

  it('delete asks again about a symlink that replaced a confirmed directory and removes only the link', async (t) => {
    const root = await createTestRoot();
    try {
      const d1 = join(root, 'd1');
      const d2 = join(root, 'd2');
      await writeTestFile(root, 'd1/x', '1');
      await writeTestFile(root, 'd2/x', '2');
      await writeTestFile(root, 'kept/x', 'link target');
      // Staged before the call, so a host that cannot create symlinks skips
      // here rather than inside the prompt.
      const staged = join(root, 'staged');
      if (!(await trySymlink(join(root, 'kept'), staged, () => t.skip('symlinks not permitted')))) {
        return;
      }
      const { result, prompts, meta } = await deleteAnsweringByName(
        root,
        { paths: [d1, d2] },
        { d1: 'delete', d2: 'delete' },
        async () => {
          await rm(d2, { recursive: true });
          await rename(staged, d2);
        },
      );
      // Two prompts for d1 and d2, then both again: the swapped d2 re-prompts the set.
      assert.strictEqual(prompts, 4);
      assert.notStrictEqual(result.isError, true, JSON.stringify(result));
      assert.deepStrictEqual(meta.summary, { total: 2, succeeded: 2, failed: 0 });
      assert.deepStrictEqual(meta.results[0], {
        path: normalizePath(d1),
        value: { deleted: true },
      });
      assert.deepStrictEqual(meta.results[1]?.value, { deleted: true });
      await assert.rejects(access(d1), { code: 'ENOENT' });
      await assert.rejects(lstat(d2), { code: 'ENOENT' });
      assert.strictEqual(await readFile(join(root, 'kept', 'x'), 'utf8'), 'link target');
    } finally {
      await cleanupTestRoot(root);
    }
  });

  it('delete re-plans a retry whose confirmed directory matches no request entry', async (t) => {
    const root = await createTestRoot();
    try {
      await writeTestFile(root, 'real/d2/x', 'confirmed');
      await writeTestFile(root, 'other/d2', 'never confirmed');
      const link = join(root, 'link');
      if (!(await trySymlink(join(root, 'real'), link, () => t.skip('symlinks not permitted')))) {
        return;
      }
      // Repointing the parent leaves the confirmed directory in place while
      // the requested path now names a file nothing asked about.
      const { result, prompts } = await deleteAnsweringByName(
        root,
        { paths: [join(link, 'd2')] },
        { d2: 'delete' },
        async () => {
          await rm(link);
          await symlink(join(root, 'other'), link, 'junction');
        },
      );
      // The confirmed directory left the plan; the file the path now names
      // needs no confirmation, exactly as on a fresh call.
      assert.strictEqual(prompts, 1);
      assert.notStrictEqual(result.isError, true, JSON.stringify(result));
      assert.strictEqual(await readFile(join(root, 'real', 'd2', 'x'), 'utf8'), 'confirmed');
      await assert.rejects(access(join(root, 'other', 'd2')), { code: 'ENOENT' });
    } finally {
      await cleanupTestRoot(root);
    }
  });

  for (const copy of [false, true]) {
    for (const aliased of [false, true]) {
      it(`${copy ? 'copy' : 'move'} rejects overlapping ${aliased ? 'alias-resolved' : 'direct'} destination subtrees before mutation`, async (t) => {
        const root = await createTestRoot();
        let pair: Awaited<ReturnType<typeof createElicitationClientPair>> | undefined;
        try {
          const a = join(root, 'a');
          const b = join(root, 'b');
          const out = join(root, 'out');
          await writeTestFile(root, 'a/sub/x', 'A');
          await writeTestFile(root, 'b/x', 'B');
          await mkdir(out);
          const alias = join(root, 'alias');
          if (aliased && !(await trySymlink(out, alias, () => t.skip('symlinks not permitted')))) {
            return;
          }
          let prompts = 0;
          pair = await createElicitationClientPair([root], async () => {
            prompts++;
            return { action: 'accept', content: { choice: 'overwrite' } };
          });
          const result = await pair.client.callTool({
            name: 'move',
            arguments: {
              copy,
              overwrite: copy,
              moves: [
                { source: a, destination: out },
                { source: b, destination: join(aliased ? alias : out, 'sub') },
              ],
            },
          });
          assert.strictEqual(result.isError, true, JSON.stringify(result));
          const meta = result._meta as {
            moves: unknown[];
            failures: { error: { code: string; message: string } }[];
          };
          assert.strictEqual(meta.moves.length, 0);
          assert.strictEqual(meta.failures.length, 2);
          for (const failure of meta.failures) {
            assert.strictEqual(failure.error.code, 'INVALID_INPUT');
            assert.match(failure.error.message, /overlaps another entry/);
          }
          assert.strictEqual(prompts, 0, 'reject the overlap before asking to overwrite');
          assert.deepStrictEqual(await readdir(out), [], 'do not create destination children');
          assert.strictEqual(await readFile(join(a, 'sub', 'x'), 'utf8'), 'A');
          assert.strictEqual(await readFile(join(b, 'x'), 'utf8'), 'B');
        } finally {
          await pair?.close();
          await cleanupTestRoot(root);
        }
      });
    }
  }

  it('copies to non-overlapping sibling destinations both succeed', async () => {
    const root = await createTestRoot();
    let pair: Awaited<ReturnType<typeof createElicitationClientPair>> | undefined;
    try {
      await writeTestFile(root, 'a/x', 'A');
      await writeTestFile(root, 'b/x', 'B');
      pair = await createElicitationClientPair([root], async () => {
        assert.fail('new destinations need no confirmation');
      });
      const result = await pair.client.callTool({
        name: 'move',
        arguments: {
          copy: true,
          moves: [
            { source: join(root, 'a'), destination: join(root, 'out', 'one') },
            { source: join(root, 'b'), destination: join(root, 'out', 'two') },
          ],
        },
      });
      assert.notStrictEqual(result.isError, true, JSON.stringify(result));
      const meta = result._meta as { moves: unknown[]; failures?: unknown[] };
      assert.strictEqual(meta.moves.length, 2);
      assert.strictEqual(meta.failures, undefined);
      for (const [source, destination, content] of [
        ['a', 'one', 'A'],
        ['b', 'two', 'B'],
      ] as const) {
        assert.strictEqual(await readFile(join(root, source, 'x'), 'utf8'), content);
        assert.strictEqual(await readFile(join(root, 'out', destination, 'x'), 'utf8'), content);
      }
    } finally {
      await pair?.close();
      await cleanupTestRoot(root);
    }
  });
});

describe('Pending confirmation outcomes', () => {
  const tools = [
    {
      name: 'create',
      accept: 'overwrite',
      args: (root: string) => ({ files: [{ path: join(root, 'dst.txt'), content: 'new' }] }),
      refused: /create cancelled: overwrite of .*dst\.txt.* was (declined|dismissed) by the user/,
      applied: async (root: string) => (await readFile(join(root, 'dst.txt'), 'utf8')) === 'new',
    },
    {
      name: 'move',
      accept: 'overwrite',
      args: (root: string) => ({
        moves: [{ source: join(root, 'src.txt'), destination: join(root, 'dst.txt') }],
      }),
      refused: /Move cancelled: overwrite of .*dst\.txt.* was (declined|dismissed) by the user/,
      applied: async (root: string) => (await readFile(join(root, 'dst.txt'), 'utf8')) === 'src',
    },
    {
      name: 'move',
      accept: 'overwrite',
      args: (root: string) => ({
        moves: [{ source: join(root, 'src.txt'), destination: join(root, 'dst.txt') }],
        copy: true,
      }),
      refused: /Copy cancelled: overwrite of .*dst\.txt.* was (declined|dismissed) by the user/,
      applied: async (root: string) => (await readFile(join(root, 'dst.txt'), 'utf8')) === 'src',
    },
    {
      name: 'delete',
      accept: 'delete',
      args: (root: string) => ({ paths: [join(root, 'dir')], recursive: true }),
      refused: /Delete cancelled: confirmation was (declined|dismissed) by the user/,
      applied: async (root: string) =>
        access(join(root, 'dir')).then(
          () => false,
          () => true,
        ),
    },
  ] as const;
  const answers = [
    {
      label: 'accept',
      response: (accept: string) => ({ action: 'accept', content: { choice: accept } }) as const,
    },
    { label: 'skip', response: () => ({ action: 'accept', content: { choice: 'skip' } }) as const },
    { label: 'decline', response: () => ({ action: 'decline' }) as const },
    { label: 'cancel', response: () => ({ action: 'cancel' }) as const },
  ] as const;

  for (const tool of tools) {
    const toolLabel = 'copy' in tool.args('') ? 'copy' : tool.name;
    for (const answer of answers) {
      it(`${toolLabel}: ${answer.label} maps to its outcome`, async () => {
        const root = await createTestRoot();
        try {
          await writeTestFile(root, 'src.txt', 'src');
          await writeTestFile(root, 'dst.txt', 'dst');
          await writeTestFile(root, 'dir/child.txt', 'child');
          const pair = await createElicitationClientPair([root], async () =>
            answer.response(tool.accept),
          );
          try {
            const result = await pair.client.callTool({
              name: tool.name,
              arguments: tool.args(root),
            });
            const text = JSON.stringify(result);
            if (answer.label === 'accept') {
              assert.notStrictEqual(result.isError, true, text);
              assert.ok(await tool.applied(root), 'accepted change must apply');
            } else if (answer.label === 'skip') {
              assert.notStrictEqual(result.isError, true, text);
              assert.ok(!(await tool.applied(root)), 'skipped change must not apply');
            } else {
              assert.match(text, tool.refused);
              assert.ok(!(await tool.applied(root)), 'refused change must not apply');
            }
          } finally {
            await pair.close();
          }
        } finally {
          await cleanupTestRoot(root);
        }
      });
    }
  }
});
