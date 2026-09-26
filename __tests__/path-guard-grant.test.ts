import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ErrorCode } from '../src/core/errors.ts';
import { isSamePath } from '../src/core/path-utils.ts';
import { PathGuard } from '../src/core/path.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  fsErrorMatcher,
  makeGuard,
  trySymlink,
  writeTestFile,
} from './helpers.ts';

// Grant round-trip: precheckAccess → applyGrant → the guard's
// allowed-directory view. These pin the behavior so future regressions fail
// loudly. Real tmpdir paths; no stubbed realpath — the TOCTOU window is real.

const mkDir = async (created: string[], prefix: string): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  created.push(d);
  return d;
};

const containsPath = (dirs: readonly string[], target: string): boolean =>
  dirs.some((d) => isSamePath(d, target));

describe('PathGuard grant round-trip', () => {
  let root: string;
  let createdDirs: string[];
  let savedBoundary: string | undefined;

  beforeEach(async () => {
    root = await createTestRoot();
    createdDirs = [];
    savedBoundary = process.env['FS_ROOT_BOUNDARY'];
  });

  afterEach(async () => {
    if (savedBoundary === undefined) delete process.env['FS_ROOT_BOUNDARY'];
    else process.env['FS_ROOT_BOUNDARY'] = savedBoundary;
    for (const d of createdDirs) await cleanupTestRoot(d);
    if (root) await cleanupTestRoot(root);
  });

  it('TC-PG-001: precheckAccess returns [] for a path already inside an allowed root', async () => {
    const guard = await makeGuard([root]);
    const inside = join(root, 'file.txt');

    const grants = await guard.precheckAccess([inside]);

    assert.deepStrictEqual(grants, []);
  });

  it('TC-PG-002: within FS_ROOT_BOUNDARY, precheckAccess offers the ancestor and applyGrant extends access', async () => {
    const boundary = tmpdir();
    const outOfRoot = await mkDir(createdDirs, 'fsmcp-pg002-');
    process.env['FS_ROOT_BOUNDARY'] = boundary;

    const guard = new PathGuard({ cliAllowedDirs: [root] });
    await guard.recomputeAllowedDirectories();

    const grants = await guard.precheckAccess([outOfRoot]);
    assert.strictEqual(grants.length, 1, 'precheck should offer one grant dir');
    const grantDir = grants[0];
    assert.ok(grantDir, 'precheck should offer a grant dir');
    assert.ok(containsPath([grantDir], outOfRoot), 'offered dir should be the out-of-root target');

    const accepted = await guard.applyGrant(grantDir);
    assert.strictEqual(accepted, true, 'applyGrant should succeed within boundary');

    // After the grant the out-of-root path must resolve without ACCESS_DENIED.
    await assert.doesNotReject(
      guard.validateExistingPath(outOfRoot),
      'granted path should be accessible after applyGrant',
    );
  });

  it('TC-PG-003: outside FS_ROOT_BOUNDARY, precheckAccess offers nothing and applyGrant denies', async () => {
    // Boundary is the test root itself: any sibling tmpdir is outside it.
    process.env['FS_ROOT_BOUNDARY'] = root;
    const outOfRoot = await mkDir(createdDirs, 'fsmcp-pg003-');

    const guard = new PathGuard({ cliAllowedDirs: [root] });
    await guard.recomputeAllowedDirectories();
    const before = guard.getAllowedDirectories();

    const grants = await guard.precheckAccess([outOfRoot]);
    assert.deepStrictEqual(grants, [], 'precheck should not offer a dir outside the boundary');

    const accepted = await guard.applyGrant(outOfRoot);
    assert.strictEqual(accepted, false, 'applyGrant should refuse outside the boundary');

    const after = guard.getAllowedDirectories();
    assert.strictEqual(
      after.length,
      before.length,
      'allowed dirs must not grow when a grant is refused',
    );
    assert.ok(!containsPath(after, outOfRoot), 'refused grant must not appear in allowed dirs');
  });

  it('TC-PG-004: precheckAccess offers [] when the only existing ancestor is a bare filesystem root', async () => {
    const guard = await makeGuard([root]);
    // A path whose every intermediate segment is missing: walking up reaches
    // the filesystem root, which precheckAccess must never offer as a grant.
    const unique = `fsmcp_pg004_${Date.now()}`;
    const deepMissing = join(parse(root).root, unique, 'sub', 'leaf');

    const grants = await guard.precheckAccess([deepMissing]);

    assert.deepStrictEqual(grants, [], 'must never offer the whole filesystem root');
  });

  it('TC-PG-005: with configured allowed dirs and no FS_ROOT_BOUNDARY, an accepted grant lands', async () => {
    // Regression: the recompute used to filter granted dirs against the
    // baseline (cliAllowedDirs), which a granted dir is outside by definition.
    // applyGrant returned true and the allowed set never changed, so the whole
    // round-trip prompted the user and then did nothing.
    const outOfRoot = await mkDir(createdDirs, 'fsmcp-pg005-');

    delete process.env['FS_ROOT_BOUNDARY'];
    const guard = new PathGuard({ cliAllowedDirs: [root] });
    await guard.recomputeAllowedDirectories();

    const grants = await guard.precheckAccess([outOfRoot]);
    assert.strictEqual(grants.length, 1, 'precheck should offer the out-of-root dir (no boundary)');

    const grantDir = grants[0];
    assert.ok(grantDir, 'precheck should offer a grant dir');
    const accepted = await guard.applyGrant(grantDir);
    assert.strictEqual(accepted, true, 'applyGrant should accept within no boundary');

    const allowed = guard.getAllowedDirectories();
    assert.ok(
      containsPath(allowed, outOfRoot),
      `granted dir "${outOfRoot}" must be present; allowed = ${JSON.stringify(allowed)}`,
    );
    assert.ok(containsPath(allowed, root), 'the configured baseline root must survive the grant');
    await assert.doesNotReject(
      guard.validateExistingPath(outOfRoot),
      'granted path should be accessible after applyGrant',
    );
  });

  it('TC-PG-005b: a granted dir survives an unrelated later recompute', async () => {
    // The grant is session-lived (R8): anything that recomputes the allowed set
    // afterwards — another grant, a roots refresh — must not drop it.
    const first = await mkDir(createdDirs, 'fsmcp-pg005b1-');
    const second = await mkDir(createdDirs, 'fsmcp-pg005b2-');

    delete process.env['FS_ROOT_BOUNDARY'];
    const guard = new PathGuard({ cliAllowedDirs: [root] });
    await guard.recomputeAllowedDirectories();

    assert.strictEqual(await guard.applyGrant(first), true);
    assert.strictEqual(await guard.applyGrant(second), true);
    await guard.recomputeAllowedDirectories();

    const allowed = guard.getAllowedDirectories();
    assert.ok(containsPath(allowed, first), 'first grant must survive');
    assert.ok(containsPath(allowed, second), 'second grant must survive');
  });

  it('TC-PG-006: two concurrent applyGrant calls on different dirs both land', async () => {
    process.env['FS_ROOT_BOUNDARY'] = tmpdir();
    const dir1 = await mkDir(createdDirs, 'fsmcp-pg006a-');
    const dir2 = await mkDir(createdDirs, 'fsmcp-pg006b-');

    const guard = new PathGuard({ cliAllowedDirs: [root] });
    await guard.recomputeAllowedDirectories();

    const [r1, r2] = await Promise.all([guard.applyGrant(dir1), guard.applyGrant(dir2)]);
    assert.strictEqual(r1, true, 'first grant should succeed');
    assert.strictEqual(r2, true, 'second grant should succeed');

    const allowed = guard.getAllowedDirectories();
    assert.ok(containsPath(allowed, dir1), `dir1 (${dir1}) should be in allowed dirs`);
    assert.ok(containsPath(allowed, dir2), `dir2 (${dir2}) should be in allowed dirs`);
  });

  it('TC-PG-011: with no FS_ROOT_BOUNDARY, precheckAccess never offers and applyGrant never accepts an unsafe path', async () => {
    // No FS_ROOT_BOUNDARY: isWithinBoundary returns true for everything, so the
    // unsafe-path denylist is the only guard keeping a grant out of /etc,
    // C:\Windows, or the home directory. isUnsafeCwdPath flags the path used.
    delete process.env['FS_ROOT_BOUNDARY'];
    const unsafeDir = process.platform === 'win32' ? 'C:\\Windows' : '/etc';

    const guard = new PathGuard({ cliAllowedDirs: [root] });
    await guard.recomputeAllowedDirectories();

    const grants = await guard.precheckAccess([unsafeDir]);
    assert.deepStrictEqual(grants, [], 'must never offer an unsafe path as a grant');

    const accepted = await guard.applyGrant(unsafeDir);
    assert.strictEqual(accepted, false, 'applyGrant must refuse an unsafe path');

    const allowed = guard.getAllowedDirectories();
    assert.ok(!containsPath(allowed, unsafeDir), 'unsafe path must not appear in allowed dirs');
  });

  it('TC-PG-012: an unsafe path aliased behind a symlink is refused by both grant gates', async (t) => {
    // TC-PG-011 grants the unsafe path by its literal name. This grants a link
    // that merely *resolves* there: the denylist used to run on the lexical
    // string while expandAllowedDirectories pushed each root's realpath into the
    // allowed set, so the link went in under an innocuous name and dragged the
    // unsafe target with it — and the confirmation prompt showed the alias.
    delete process.env['FS_ROOT_BOUNDARY'];
    const unsafeDir = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    const holder = await mkDir(createdDirs, 'fsmcp-pg012-');
    const alias = join(holder, 'innocuous');
    if (!(await trySymlink(unsafeDir, alias, () => t.skip('symlink creation not permitted')))) {
      return;
    }

    const guard = new PathGuard({ cliAllowedDirs: [root] });
    await guard.recomputeAllowedDirectories();

    const grants = await guard.precheckAccess([join(alias, 'target.txt')]);
    assert.deepStrictEqual(grants, [], 'must never offer a link resolving to an unsafe path');

    const accepted = await guard.applyGrant(alias);
    assert.strictEqual(accepted, false, 'applyGrant must refuse a link to an unsafe path');

    const allowed = guard.getAllowedDirectories();
    assert.ok(!containsPath(allowed, alias), 'the alias must not appear in allowed dirs');
    assert.ok(
      !containsPath(allowed, unsafeDir),
      'the resolved unsafe path must not appear in allowed dirs',
    );
  });
});

describe('Write/Delete PathGuard', () => {
  let root: string;
  let guard: PathGuard;

  beforeEach(async () => {
    root = await createTestRoot();
    guard = await makeGuard([root]);
  });

  afterEach(async () => {
    if (root) await cleanupTestRoot(root);
  });

  it('TC-PG-007: validatePathForWrite denies when an ancestor symlink escapes the root', async (t) => {
    const linkPath = join(root, 'escape_link');
    const outsideTarget = tmpdir();
    if (!(await trySymlink(outsideTarget, linkPath, () => t.skip('symlink not permitted')))) return;

    const through = join(linkPath, 'newfile.txt');

    await assert.rejects(
      guard.validatePathForWrite(through),
      fsErrorMatcher(ErrorCode.ACCESS_DENIED),
      'should deny writing through a symlink that escapes the root',
    );
  });

  it('TC-PG-008: validatePathForWrite denies a sensitive target reached through an in-root symlink', async (t) => {
    const envPath = await writeTestFile(root, '.env', 'SECRET=1');
    const linkPath = join(root, 'link');
    // File symlink: 'file' type (junctions are directory-only on Win32 and
    // autodetect has been observed to create a broken dir-symlink to a file).
    if (!(await trySymlink(envPath, linkPath, () => t.skip('symlink not permitted'), 'file')))
      return;

    await assert.rejects(
      guard.validatePathForWrite(linkPath),
      fsErrorMatcher(ErrorCode.ACCESS_DENIED),
      'should deny writing through a symlink that resolves to a sensitive file',
    );
  });

  it('TC-PG-009: validatePathForDelete permits deleting an in-root symlink whose target is outside the root', async (t) => {
    const linkPath = join(root, 'escape_link');
    const outsideTarget = tmpdir();
    if (!(await trySymlink(outsideTarget, linkPath, () => t.skip('symlink not permitted')))) return;

    // Deleting the link itself is safe even though its target escapes.
    await assert.doesNotReject(
      guard.validatePathForDelete(linkPath),
      'should allow deleting a symlink regardless of its target',
    );
  });

  it('TC-PG-010: validatePathForDelete denies deleting a non-symlink whose realpath escapes the root', async (t) => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'fsmcp-pg010-'));
    const linkPath = join(root, 'escape_link');
    if (!(await trySymlink(outsideDir, linkPath, () => t.skip('symlink not permitted')))) return;
    // A real (non-symlink) file living under the symlinked ancestor. The
    // parent directory's realpath resolves through the symlink to outside
    // the root, so the delete is denied (the realpath escapes the root).
    await writeTestFile(outsideDir, 'target.txt', 'data');
    const through = join(linkPath, 'target.txt');
    try {
      await assert.rejects(
        guard.validatePathForDelete(through),
        fsErrorMatcher(ErrorCode.ACCESS_DENIED),
        'should deny deleting a non-symlink whose realpath escapes the root',
      );
    } finally {
      await cleanupTestRoot(outsideDir);
    }
  });
});
