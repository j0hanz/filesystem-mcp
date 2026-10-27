import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ErrorCode } from '../src/core/errors.ts';
import { encodeFileUriPath, FILESYSTEM_FILE_URI_TEMPLATE } from '../src/core/file-uri.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { normalizePath } from '../src/core/path-utils.ts';
import type { PathGuard } from '../src/core/path.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  fsErrorMatcher,
  makeGuard,
  trySymlink,
  withEnv,
} from './helpers.ts';

// Issue #101. Names are built from escapes so the source file's own
// normalization cannot change what lands on disk.
const NFC_CAFE = 'caf\u00e9';
const NFD_CAFE = 'cafe\u0301';
const NBSP_NAME = 'a\u00a0b.txt';
const NNBSP_NAME = 'a\u202fb.txt';
const ASCII_NAME = 'a b.txt';
const NNBSP_SHOT = 'shot\u202fPM.txt';
const ASCII_SHOT = 'shot PM.txt';

/** A path as the guard returns it: on Windows its drive letter is lowercased. */
const guardPath = (...parts: string[]): string => normalizePath(join(...parts));

/**
 * True when this filesystem stores `NFD_CAFE` and `NFC_CAFE` as two names
 * (ext4, NTFS). APFS and HFS+ treat them as one, so the "on disk differs"
 * premise of the NFC/NFD cases does not hold there.
 */
async function isNormalizationSensitive(root: string): Promise<boolean> {
  const probe = join(root, 'norm-probe');
  await mkdir(probe);
  await writeFile(join(probe, NFD_CAFE), '');
  try {
    await readFile(join(probe, NFC_CAFE));
    return false;
  } catch {
    return true;
  }
}

describe('Unicode-equivalent path lookup (#101)', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTestRoot();
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  describe('PathGuard', () => {
    let guard: PathGuard;

    beforeEach(async () => {
      guard = await makeGuard([root]);
    });

    it('reads through an NFC spelling of an NFD directory', async (t) => {
      if (!(await isNormalizationSensitive(root))) {
        t.skip('filesystem is normalization-insensitive');
        return;
      }
      await mkdir(join(root, NFD_CAFE));
      await writeFile(join(root, NFD_CAFE, 'a.txt'), 'nfd');
      const resolved = await guard.validateExistingPath(join(root, NFC_CAFE, 'a.txt'));
      assert.strictEqual(resolved, guardPath(root, NFD_CAFE, 'a.txt'));
    });

    it('reads a U+202F name the request spells with U+0020', async () => {
      await writeFile(join(root, NNBSP_SHOT), 'shot');
      const resolved = await guard.validateExistingPath(join(root, ASCII_SHOT));
      assert.strictEqual(resolved, guardPath(root, NNBSP_SHOT));
    });

    it('reports the on-disk spelling, not a symlink', async () => {
      await writeFile(join(root, NNBSP_SHOT), 'shot');
      const details = await guard.validateExistingPathDetailed(join(root, ASCII_SHOT));
      assert.deepStrictEqual(details, {
        requestedPath: guardPath(root, NNBSP_SHOT),
        resolvedPath: guardPath(root, NNBSP_SHOT),
        isSymlink: false,
      });
    });

    /** A file source's views, as the move tool derives them. */
    const sourceViews = async (path: string): Promise<{ entry: string; landing: string }> => ({
      entry: await guard.validatePathForDelete(path),
      landing: await guard.validateExistingPath(path),
    });

    it('TC-PH-009: a case-only destination is a respelling on a case-insensitive filesystem', async (t) => {
      if (process.platform !== 'win32' && process.platform !== 'darwin') {
        t.skip('case-only re-spelling only applies on a case-insensitive filesystem');
        return;
      }
      await writeFile(join(root, 'foo.txt'), 'foo');
      const resolved = await guard.resolveTransferDestination(
        join(root, 'Foo.txt'),
        await sourceViews(join(root, 'foo.txt')),
      );
      assert.deepStrictEqual(resolved, {
        destination: guardPath(root, 'Foo.txt'),
        kind: 'respelling',
      });
    });

    it('TC-PH-010: an unrelated destination is distinct and keeps its name', async () => {
      await writeFile(join(root, 'foo.txt'), 'foo');
      const resolved = await guard.resolveTransferDestination(
        join(root, 'bar.txt'),
        await sourceViews(join(root, 'foo.txt')),
      );
      assert.deepStrictEqual(resolved, {
        destination: guardPath(root, 'bar.txt'),
        kind: 'distinct',
      });
    });

    it('TC-PH-011: the source itself, spelled the same, is a self-move', async () => {
      await writeFile(join(root, 'foo.txt'), 'foo');
      const resolved = await guard.resolveTransferDestination(
        join(root, 'foo.txt'),
        await sourceViews(join(root, 'foo.txt')),
      );
      assert.deepStrictEqual(resolved, { destination: guardPath(root, 'foo.txt'), kind: 'self' });
    });

    it('TC-PH-014: a Unicode-only destination is a respelling under the requested name', async () => {
      await writeFile(join(root, NBSP_NAME), 'nbsp');
      const resolved = await guard.resolveTransferDestination(
        join(root, ASCII_NAME),
        await sourceViews(join(root, NBSP_NAME)),
      );
      assert.deepStrictEqual(resolved, {
        destination: guardPath(root, ASCII_NAME),
        kind: 'respelling',
      });
    });

    it('a link onto its own target is a self-move', async (t) => {
      await writeFile(join(root, 'target.txt'), 'target');
      if (
        !(await trySymlink(
          join(root, 'target.txt'),
          join(root, 'lnk'),
          () => t.skip('symlink not permitted'),
          'file',
        ))
      ) {
        return;
      }
      const resolved = await guard.resolveTransferDestination(
        join(root, 'target.txt'),
        await sourceViews(join(root, 'lnk')),
      );
      assert.strictEqual(resolved.kind, 'self');
      // Onto itself, spelled the same, a link is a self-move too: its landing
      // is the target, so only the entry comparison catches it.
      assert.deepStrictEqual(
        await guard.resolveTransferDestination(
          join(root, 'lnk'),
          await sourceViews(join(root, 'lnk')),
        ),
        { destination: guardPath(root, 'lnk'), kind: 'self' },
      );
    });

    it('a lock key names a link as the link, and a path with no parent by its landing', async (t) => {
      await writeFile(join(root, 'target.txt'), 'target');
      if (
        !(await trySymlink(
          join(root, 'target.txt'),
          join(root, 'lnk'),
          () => t.skip('symlink not permitted'),
          'file',
        ))
      ) {
        return;
      }
      assert.strictEqual(await guard.entryLockKey(join(root, 'lnk')), guardPath(root, 'lnk'));
      assert.strictEqual(
        await guard.entryLockKey(join(root, 'gone', 'x.txt')),
        guardPath(root, 'gone', 'x.txt'),
      );
    });

    it('prefers the exact spelling when both are on disk', async () => {
      await writeFile(join(root, ASCII_NAME), 'space');
      await writeFile(join(root, NBSP_NAME), 'nbsp');
      assert.strictEqual(
        await guard.validateExistingPath(join(root, ASCII_NAME)),
        guardPath(root, ASCII_NAME),
      );
      assert.strictEqual(
        await guard.validateExistingPath(join(root, NBSP_NAME)),
        guardPath(root, NBSP_NAME),
      );
    });

    it('refuses a name that matches two entries and neither exactly', async () => {
      await writeFile(join(root, NBSP_NAME), 'nbsp');
      await writeFile(join(root, NNBSP_NAME), 'nnbsp');
      await assert.rejects(
        guard.validateExistingPath(join(root, ASCII_NAME)),
        fsErrorMatcher(ErrorCode.INVALID_INPUT, /Ambiguous Unicode path component.*\\u00a0/),
      );
      await assert.rejects(
        guard.validatePathForWrite(join(root, ASCII_NAME)),
        fsErrorMatcher(ErrorCode.INVALID_INPUT, /Ambiguous Unicode path component/),
      );
    });

    it('keeps NOT_FOUND when nothing matches', async () => {
      await assert.rejects(
        guard.validateExistingPath(join(root, 'no such file.txt')),
        fsErrorMatcher(ErrorCode.NOT_FOUND),
      );
    });

    it('never matches a component of the root itself', async () => {
      const top = await createTestRoot();
      try {
        await mkdir(join(top, 'my\u00a0root'));
        await writeFile(join(top, 'my\u00a0root', 'a.txt'), 'x');
        const narrow = await makeGuard([join(top, 'my root')]);
        await assert.rejects(
          narrow.validateExistingPath(join(top, 'my root', 'a.txt')),
          fsErrorMatcher(ErrorCode.ACCESS_DENIED),
        );
      } finally {
        await cleanupTestRoot(top);
      }
    });

    it('refuses a symlink reached by equivalence that escapes the root', async (t) => {
      const outside = await createTestRoot();
      try {
        await writeFile(join(outside, 'secret.txt'), 'outside');
        if (
          !(await trySymlink(outside, join(root, 'out\u00a0link'), () =>
            t.skip('symlink not permitted'),
          ))
        ) {
          return;
        }
        await assert.rejects(
          guard.validateExistingPath(join(root, 'out link', 'secret.txt')),
          fsErrorMatcher(ErrorCode.ACCESS_DENIED),
        );
        await assert.rejects(
          guard.validatePathForWrite(join(root, 'out link', 'new.txt')),
          fsErrorMatcher(ErrorCode.ACCESS_DENIED),
        );
        assert.deepStrictEqual(await readdir(outside), ['secret.txt']);
      } finally {
        await cleanupTestRoot(outside);
      }
    });

    it('applies the denylist to the on-disk spelling', async () => {
      await writeFile(join(root, 'secret\u202fnotes.txt'), 'secret');
      const denying = await withEnv({ FS_DENYLIST: 'secret\u202fnotes.txt' }, () =>
        makeGuard([root]),
      );
      await assert.rejects(
        denying.validateExistingPath(join(root, 'secret notes.txt')),
        fsErrorMatcher(ErrorCode.ACCESS_DENIED, /denylist/),
      );
      await assert.rejects(
        denying.validatePathForWrite(join(root, 'secret notes.txt')),
        fsErrorMatcher(ErrorCode.ACCESS_DENIED, /denylist/),
      );
      await assert.rejects(
        denying.validatePathForDelete(join(root, 'secret notes.txt')),
        fsErrorMatcher(ErrorCode.ACCESS_DENIED, /denylist/),
      );
    });

    it('never lists denylisted names in an ambiguity error', async () => {
      // A class is matched as typed, so this pattern covers both stored names
      // but not the requested U+0020 spelling.
      await writeFile(join(root, NBSP_NAME), 'nbsp');
      await writeFile(join(root, NNBSP_NAME), 'nnbsp');
      const denying = await withEnv({ FS_DENYLIST: 'a[\u00a0\u202f]b.txt' }, () =>
        makeGuard([root]),
      );
      assert.strictEqual(denying.isSensitive(join(root, ASCII_NAME)), false);
      await assert.rejects(denying.validateExistingPath(join(root, ASCII_NAME)), (error) => {
        fsErrorMatcher(ErrorCode.ACCESS_DENIED, /denylist/)(error);
        assert.doesNotMatch((error as Error).message, /\\u00a0|\\u202f|\u00a0|\u202f/);
        return true;
      });
    });

    it('an operator pattern denies every Unicode spelling of its name', async (t) => {
      if (!(await isNormalizationSensitive(root))) {
        t.skip('filesystem is normalization-insensitive');
        return;
      }
      await writeFile(join(root, `${NFD_CAFE}.txt`), 'nfd');
      await writeFile(join(root, NBSP_NAME), 'nbsp');
      const denying = await withEnv({ FS_DENYLIST: `${NFC_CAFE}.txt,${ASCII_NAME}` }, () =>
        makeGuard([root]),
      );
      for (const onDisk of [`${NFD_CAFE}.txt`, NBSP_NAME]) {
        for (const validate of [
          (path: string) => denying.validateExistingPath(path),
          (path: string) => denying.validatePathForWrite(path),
          (path: string) => denying.validatePathForDelete(path),
        ]) {
          await assert.rejects(
            validate(join(root, onDisk)),
            fsErrorMatcher(ErrorCode.ACCESS_DENIED, /denylist/),
          );
        }
      }
    });

    it('never reveals entries the denylist hides', async (t) => {
      await mkdir(join(root, 'secrets'));
      await writeFile(join(root, 'secrets', NBSP_NAME), 's1');
      await writeFile(join(root, 'secrets', NNBSP_NAME), 's2');
      await mkdir(join(root, 'vault.key'));
      await writeFile(join(root, 'vault.key', NBSP_NAME), 'k1');
      await writeFile(join(root, 'vault.key', NNBSP_NAME), 'k2');
      // A directory whose own name is denylisted is never scanned: its
      // entries would show in the ambiguity error.
      await assert.rejects(
        guard.validateExistingPath(join(root, 'vault.key', ASCII_NAME)),
        fsErrorMatcher(ErrorCode.NOT_FOUND),
      );
      if (
        !(await trySymlink(join(root, 'secrets'), join(root, 'alias'), () =>
          t.skip('symlink not permitted'),
        ))
      ) {
        return;
      }
      // Through an alias the typed path is not denylisted, but where it
      // resolves is: refused as the exact spelling is, naming nothing inside.
      const denying = await withEnv({ FS_DENYLIST: 'secrets/**' }, () => makeGuard([root]));
      for (const validate of [
        (path: string) => denying.validateExistingPath(path),
        (path: string) => denying.validatePathForWrite(path),
        (path: string) => denying.validatePathForDelete(path),
      ]) {
        await assert.rejects(validate(join(root, 'alias', ASCII_NAME)), (error: unknown) => {
          fsErrorMatcher(ErrorCode.ACCESS_DENIED, /denylist/)(error);
          assert.doesNotMatch(String(error), /secrets|\\u00a0|\\u202f/u);
          return true;
        });
      }
    });

    it('writes into the existing NFD directory, not a new NFC sibling', async (t) => {
      if (!(await isNormalizationSensitive(root))) {
        t.skip('filesystem is normalization-insensitive');
        return;
      }
      await mkdir(join(root, NFD_CAFE));
      const target = await guard.validatePathForWrite(join(root, NFC_CAFE, 'new.txt'));
      assert.strictEqual(target, guardPath(root, NFD_CAFE, 'new.txt'));
    });

    it('a write to a U+0020 spelling lands on the existing U+202F file', async () => {
      await writeFile(join(root, NNBSP_SHOT), 'shot');
      const target = await guard.validatePathForWrite(join(root, ASCII_SHOT));
      assert.strictEqual(target, guardPath(root, NNBSP_SHOT));
    });

    it('deletes through an equivalent spelling', async () => {
      await writeFile(join(root, NNBSP_SHOT), 'shot');
      const target = await guard.validatePathForDelete(join(root, ASCII_SHOT));
      assert.strictEqual(target, guardPath(root, NNBSP_SHOT));
    });

    it('a write through a link to a missing name lands on its equivalent spelling', async (t) => {
      await writeFile(join(root, NBSP_NAME), 'nbsp');
      const alias = join(root, 'alias');
      if (!(await trySymlink(join(root, ASCII_NAME), alias, () => t.skip('no symlinks'), 'file'))) {
        return;
      }
      const target = await guard.validatePathForWrite(alias);
      assert.strictEqual(target, guardPath(root, NBSP_NAME));
    });

    it('a write respells both a parent and the missing target its link names', async (t) => {
      const parent = 'parent\u00a0dir';
      await mkdir(join(root, parent));
      await writeFile(join(root, NBSP_NAME), 'nbsp');
      const link = join(root, parent, 'alias');
      if (!(await trySymlink(join('..', ASCII_NAME), link, () => t.skip('no symlinks'), 'file'))) {
        return;
      }
      const target = await guard.validatePathForWrite(join(root, 'parent dir', 'alias'));
      assert.strictEqual(target, guardPath(root, NBSP_NAME));
    });
  });

  describe('through the tools', () => {
    it('read, create and move resolve the equivalent spelling', async () => {
      await writeFile(join(root, NNBSP_SHOT), 'shot');
      const pair = await createTestClientPair([root]);
      try {
        const read = await pair.client.callTool({
          name: 'read',
          arguments: { path: join(root, ASCII_SHOT) },
        });
        assert.notStrictEqual(read.isError, true, firstTextBlock(read).text);
        assert.match(firstTextBlock(read).text ?? '', /shot/);

        const create = await pair.client.callTool({
          name: 'create',
          arguments: {
            files: [{ path: join(root, ASCII_SHOT), content: 'again', overwrite: true }],
          },
        });
        assert.notStrictEqual(create.isError, true, firstTextBlock(create).text);
        assert.deepStrictEqual(await readdir(root), [NNBSP_SHOT]);
        assert.strictEqual(await readFile(join(root, NNBSP_SHOT), 'utf8'), 'again');

        const move = await pair.client.callTool({
          name: 'move',
          arguments: {
            moves: [{ source: join(root, ASCII_SHOT), destination: join(root, 'b.txt') }],
          },
        });
        assert.notStrictEqual(move.isError, true, firstTextBlock(move).text);
        assert.deepStrictEqual(await readdir(root), ['b.txt']);
      } finally {
        await pair.close();
      }
    });

    it('create without overwrite asks before replacing the equivalent file', async () => {
      await writeFile(join(root, NNBSP_SHOT), 'shot');
      const pair = await createTestClientPair([root]);
      try {
        const create = await pair.client.callTool({
          name: 'create',
          arguments: { files: [{ path: join(root, ASCII_SHOT), content: 'again' }] },
        });
        assert.strictEqual(create.isError, true);
        assert.match(firstTextBlock(create).text ?? '', /overwrite: true/);
        assert.deepStrictEqual(await readdir(root), [NNBSP_SHOT]);
        assert.strictEqual(await readFile(join(root, NNBSP_SHOT), 'utf8'), 'shot');
      } finally {
        await pair.close();
      }
    });

    it('create refuses a batch naming one file by two Unicode spellings', async () => {
      await writeFile(join(root, NBSP_NAME), 'orig');
      const pair = await createTestClientPair([root]);
      try {
        const create = await pair.client.callTool({
          name: 'create',
          arguments: {
            files: [
              { path: join(root, ASCII_NAME), content: 'one', overwrite: true },
              { path: join(root, NBSP_NAME), content: 'two', overwrite: true },
            ],
          },
        });
        assert.strictEqual(create.isError, true);
        assert.match(firstTextBlock(create).text ?? '', /duplicate of files\[0\]\.path/u);
        assert.strictEqual(await readFile(join(root, NBSP_NAME), 'utf8'), 'orig');
      } finally {
        await pair.close();
      }
    });

    it('a symlink moved onto a Unicode variant of its own target is left alone', async (t) => {
      await writeFile(join(root, NBSP_NAME), 'target');
      if (
        !(await trySymlink(
          join(root, NBSP_NAME),
          join(root, 'lnk'),
          () => t.skip('symlink not permitted'),
          'file',
        ))
      ) {
        return;
      }
      const pair = await createTestClientPair([root]);
      try {
        await pair.client.callTool({
          name: 'move',
          arguments: {
            moves: [{ source: join(root, 'lnk'), destination: join(root, ASCII_NAME) }],
          },
        });
        assert.strictEqual((await lstat(join(root, NBSP_NAME))).isSymbolicLink(), false);
        assert.strictEqual(await readFile(join(root, NBSP_NAME), 'utf8'), 'target');
        assert.strictEqual((await lstat(join(root, 'lnk'))).isSymbolicLink(), true);
      } finally {
        await pair.close();
      }
    });

    it('a symlink renamed to another Unicode spelling of its own name is renamed', async (t) => {
      await writeFile(join(root, 'target.txt'), 'target');
      if (
        !(await trySymlink(
          join(root, 'target.txt'),
          join(root, NBSP_NAME),
          () => t.skip('symlink not permitted'),
          'file',
        ))
      ) {
        return;
      }
      const pair = await createTestClientPair([root]);
      try {
        const move = await pair.client.callTool({
          name: 'move',
          arguments: {
            moves: [{ source: join(root, NBSP_NAME), destination: join(root, ASCII_NAME) }],
          },
        });
        assert.notStrictEqual(move.isError, true, firstTextBlock(move).text);
        assert.deepStrictEqual((await readdir(root)).sort(), [ASCII_NAME, 'target.txt']);
        assert.strictEqual((await lstat(join(root, ASCII_NAME))).isSymbolicLink(), true);
        assert.strictEqual(await readFile(join(root, 'target.txt'), 'utf8'), 'target');
      } finally {
        await pair.close();
      }
    });

    it('a link renamed through an aliased parent is renamed, by move and by rename', async (t) => {
      for (const via of ['move', 'rename'] as const) {
        const top = await createTestRoot();
        try {
          await mkdir(join(top, 'real'));
          await writeFile(join(top, 'real', 'target.txt'), 'target');
          if (
            !(await trySymlink(
              join(top, 'real', 'target.txt'),
              join(top, 'real', NBSP_NAME),
              () => t.skip('symlink not permitted'),
              'file',
            )) ||
            !(await trySymlink(join(top, 'real'), join(top, 'alias'), () =>
              t.skip('symlink not permitted'),
            ))
          ) {
            return;
          }
          const source = join(top, 'alias', NBSP_NAME);
          const destination = join(top, 'real', ASCII_NAME);
          const aliased = await makeGuard([top]);
          // One link, two paths to it: the guard names it one way.
          assert.strictEqual(
            await aliased.validatePathForDelete(source),
            await aliased.validatePathForDelete(destination),
          );
          if (via === 'move') {
            const pair = await createTestClientPair([top]);
            try {
              const move = await pair.client.callTool({
                name: 'move',
                arguments: { moves: [{ source, destination }] },
              });
              assert.notStrictEqual(move.isError, true, firstTextBlock(move).text);
            } finally {
              await pair.close();
            }
          } else {
            await new GuardedFileSystem(aliased).rename(source, destination);
          }
          assert.deepStrictEqual((await readdir(join(top, 'real'))).sort(), [
            ASCII_NAME,
            'target.txt',
          ]);
          assert.strictEqual((await lstat(join(top, 'real', ASCII_NAME))).isSymbolicLink(), true);
          assert.strictEqual(await readFile(join(top, 'real', 'target.txt'), 'utf8'), 'target');
        } finally {
          await cleanupTestRoot(top);
        }
      }
    });

    it('a batch moving two files onto two spellings of one name refuses the second', async () => {
      await writeFile(join(root, 'x.txt'), 'x');
      await writeFile(join(root, 'y.txt'), 'y');
      const pair = await createTestClientPair([root]);
      try {
        const move = await pair.client.callTool({
          name: 'move',
          arguments: {
            moves: [
              { source: join(root, 'x.txt'), destination: join(root, ASCII_NAME) },
              { source: join(root, 'y.txt'), destination: join(root, NBSP_NAME) },
            ],
          },
        });
        assert.match(firstTextBlock(move).text ?? '', /1 failed/u);
        assert.match(JSON.stringify(move), /already targets destination/u);
        assert.deepStrictEqual((await readdir(root)).sort(), [ASCII_NAME, 'y.txt']);
        assert.strictEqual(await readFile(join(root, ASCII_NAME), 'utf8'), 'x');
        assert.strictEqual(await readFile(join(root, 'y.txt'), 'utf8'), 'y');
      } finally {
        await pair.close();
      }
    });

    it('a directory re-spelled out of an allow rule keeps its protected entries', async (t) => {
      if (!(await isNormalizationSensitive(root))) {
        t.skip('filesystem is normalization-insensitive');
        return;
      }
      await mkdir(join(root, NFD_CAFE));
      await writeFile(join(root, NFD_CAFE, '.env'), 'secret');
      // `.env` is denied under the NFD spelling and allowed under the NFC one.
      const pair = await withEnv({ FS_ALLOWLIST: `${NFC_CAFE}/.env` }, () =>
        createTestClientPair([root]),
      );
      try {
        const move = await pair.client.callTool({
          name: 'move',
          arguments: {
            moves: [{ source: join(root, NFD_CAFE), destination: join(root, NFC_CAFE) }],
          },
        });
        assert.match(JSON.stringify(move), /protected entries/u);
        assert.deepStrictEqual(await readdir(join(root, NFD_CAFE)), ['.env']);
      } finally {
        await pair.close();
      }
    });

    it('a link renamed from a differently cased spelling is renamed', async (t) => {
      if (process.platform !== 'win32' && process.platform !== 'darwin') {
        t.skip('case folding applies on a case-insensitive filesystem');
        return;
      }
      await writeFile(join(root, 'target.txt'), 'target');
      if (
        !(await trySymlink(
          join(root, 'target.txt'),
          join(root, NBSP_NAME),
          () => t.skip('symlink not permitted'),
          'file',
        ))
      ) {
        return;
      }
      await new GuardedFileSystem(await makeGuard([root])).rename(
        join(root, NBSP_NAME.toUpperCase()),
        join(root, ASCII_NAME),
      );
      assert.deepStrictEqual((await readdir(root)).sort(), [ASCII_NAME, 'target.txt']);
      assert.strictEqual((await lstat(join(root, ASCII_NAME))).isSymbolicLink(), true);
      assert.strictEqual(await readFile(join(root, 'target.txt'), 'utf8'), 'target');
    });

    it('rename onto a separate link to the source changes nothing', async (t) => {
      // The link's name is a Unicode variant of the file's, so a respelling
      // would rename the file over the link.
      await writeFile(join(root, NBSP_NAME), 'target');
      if (
        !(await trySymlink(
          join(root, NBSP_NAME),
          join(root, ASCII_NAME),
          () => t.skip('symlink not permitted'),
          'file',
        ))
      ) {
        return;
      }
      await new GuardedFileSystem(await makeGuard([root])).rename(
        join(root, NBSP_NAME),
        join(root, ASCII_NAME),
      );
      assert.strictEqual((await lstat(join(root, NBSP_NAME))).isSymbolicLink(), false);
      assert.strictEqual(await readFile(join(root, NBSP_NAME), 'utf8'), 'target');
      assert.strictEqual((await lstat(join(root, ASCII_NAME))).isSymbolicLink(), true);
    });

    it('rename of a link onto its own target changes nothing', async (t) => {
      await writeFile(join(root, 'target.txt'), 'target');
      if (
        !(await trySymlink(
          join(root, 'target.txt'),
          join(root, 'lnk'),
          () => t.skip('symlink not permitted'),
          'file',
        ))
      ) {
        return;
      }
      await new GuardedFileSystem(await makeGuard([root])).rename(
        join(root, 'lnk'),
        join(root, 'target.txt'),
      );
      assert.strictEqual((await lstat(join(root, 'target.txt'))).isSymbolicLink(), false);
      assert.strictEqual(await readFile(join(root, 'target.txt'), 'utf8'), 'target');
      assert.strictEqual((await lstat(join(root, 'lnk'))).isSymbolicLink(), true);
    });

    it('path completion lists a directory typed in another Unicode spelling', async (t) => {
      if (!(await isNormalizationSensitive(root))) {
        t.skip('filesystem is normalization-insensitive');
        return;
      }
      await mkdir(join(root, NFD_CAFE));
      await writeFile(join(root, NFD_CAFE, 'inner.txt'), 'x');
      const pair = await createTestClientPair([root]);
      try {
        const result = await pair.client.complete({
          ref: { type: 'ref/resource', uri: FILESYSTEM_FILE_URI_TEMPLATE },
          argument: { name: 'path', value: encodeFileUriPath(`${join(root, NFC_CAFE)}${sep}`) },
        });
        const { values } = result.completion;
        assert.ok(
          values.some((value) => value.endsWith('inner.txt')),
          JSON.stringify(values),
        );
      } finally {
        await pair.close();
      }
    });

    it('a move onto a separate lookalike file is not a rename in place', async () => {
      await writeFile(join(root, NBSP_NAME), 'nbsp');
      await writeFile(join(root, NNBSP_NAME), 'nnbsp');
      const pair = await createTestClientPair([root]);
      try {
        await pair.client.callTool({
          name: 'move',
          arguments: {
            moves: [{ source: join(root, NBSP_NAME), destination: join(root, NNBSP_NAME) }],
          },
        });
        assert.strictEqual(await readFile(join(root, NBSP_NAME), 'utf8'), 'nbsp');
        assert.strictEqual(await readFile(join(root, NNBSP_NAME), 'utf8'), 'nnbsp');
      } finally {
        await pair.close();
      }
    });

    it('a move that only changes the normalization form still renames', async (t) => {
      if (!(await isNormalizationSensitive(root))) {
        t.skip('filesystem is normalization-insensitive');
        return;
      }
      await writeFile(join(root, `${NFD_CAFE}.txt`), 'x');
      const pair = await createTestClientPair([root]);
      try {
        const move = await pair.client.callTool({
          name: 'move',
          arguments: {
            moves: [
              {
                source: join(root, `${NFD_CAFE}.txt`),
                destination: join(root, `${NFC_CAFE}.txt`),
              },
            ],
          },
        });
        assert.notStrictEqual(move.isError, true, firstTextBlock(move).text);
        const names = (await readdir(root)).filter((name) => name.endsWith('.txt'));
        assert.deepStrictEqual(names, [`${NFC_CAFE}.txt`]);
      } finally {
        await pair.close();
      }
    });

    it('delete and edit keep two existing files whose names fold alike apart', async () => {
      await writeFile(join(root, ASCII_NAME), 'space');
      await writeFile(join(root, NBSP_NAME), 'nbsp');
      const pair = await createTestClientPair([root]);
      try {
        const edit = await pair.client.callTool({
          name: 'edit',
          arguments: {
            files: [
              { path: join(root, ASCII_NAME), edits: [{ oldText: 'space', newText: 'S' }] },
              { path: join(root, NBSP_NAME), edits: [{ oldText: 'nbsp', newText: 'N' }] },
            ],
          },
        });
        assert.notStrictEqual(edit.isError, true, firstTextBlock(edit).text);
        assert.strictEqual(await readFile(join(root, ASCII_NAME), 'utf8'), 'S');
        assert.strictEqual(await readFile(join(root, NBSP_NAME), 'utf8'), 'N');

        const del = await pair.client.callTool({
          name: 'delete',
          arguments: { paths: [join(root, ASCII_NAME), join(root, NBSP_NAME)] },
        });
        assert.notStrictEqual(del.isError, true, firstTextBlock(del).text);
        assert.deepStrictEqual(await readdir(root), []);
      } finally {
        await pair.close();
      }
    });

    it('move runs two existing files whose names fold alike to unrelated places', async () => {
      await writeFile(join(root, ASCII_NAME), 'space');
      await writeFile(join(root, NBSP_NAME), 'nbsp');
      const pair = await createTestClientPair([root]);
      try {
        const move = await pair.client.callTool({
          name: 'move',
          arguments: {
            moves: [
              { source: join(root, ASCII_NAME), destination: join(root, 'x.txt') },
              { source: join(root, NBSP_NAME), destination: join(root, 'y.txt') },
            ],
          },
        });
        assert.notStrictEqual(move.isError, true, firstTextBlock(move).text);
        assert.deepStrictEqual((await readdir(root)).sort(), ['x.txt', 'y.txt']);
      } finally {
        await pair.close();
      }
    });

    it('edit applies, and delete collapses, two spellings of one file', async () => {
      await writeFile(join(root, NBSP_NAME), 'one two');
      const pair = await createTestClientPair([root]);
      try {
        const edit = await pair.client.callTool({
          name: 'edit',
          arguments: {
            files: [
              { path: join(root, ASCII_NAME), edits: [{ oldText: 'one', newText: 'A' }] },
              { path: join(root, NBSP_NAME), edits: [{ oldText: 'two', newText: 'B' }] },
            ],
          },
        });
        assert.notStrictEqual(edit.isError, true, firstTextBlock(edit).text);
        assert.strictEqual(await readFile(join(root, NBSP_NAME), 'utf8'), 'A B');

        const del = await pair.client.callTool({
          name: 'delete',
          arguments: { paths: [join(root, ASCII_NAME), join(root, NBSP_NAME)] },
        });
        assert.notStrictEqual(del.isError, true, firstTextBlock(del).text);
        const summary = (del._meta as { summary: { total: number; failed: number } }).summary;
        assert.deepStrictEqual([summary.total, summary.failed], [1, 0]);
        assert.deepStrictEqual(await readdir(root), []);
      } finally {
        await pair.close();
      }
    });
  });
});
