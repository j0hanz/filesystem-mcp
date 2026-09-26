import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { basename, join, parse, sep } from 'node:path';
import { describe, it } from 'node:test';

import {
  isPathInsideDirectory,
  isPathWithinDirectories,
  isSamePath,
  normalizePath,
  respellCaseOnlyTarget,
} from '../src/core/path-utils.ts';
import { normalizeAllowedDirectories } from '../src/core/path.ts';

// Pure lexical containment primitives — no fs. These pin the off-by-one
// boundary (prefix `/foo` must NOT match `/fooboar`) and the trailing-slash
// root branch that PathGuard containment depends on.

describe('PathGuard containment helpers', () => {
  it('TC-PH-001: isPathInsideDirectory true for direct child', () => {
    assert.strictEqual(isPathInsideDirectory('/foo', '/foo/bar'), true);
  });

  it('TC-PH-002: isPathInsideDirectory false for prefix-collision sibling', () => {
    // The off-by-one guard: `/fooboar` must NOT be treated as inside `/foo`.
    assert.strictEqual(isPathInsideDirectory('/foo', '/fooboar'), false);
  });

  it('TC-PH-003: isPathInsideDirectory true when root is filesystem root', () => {
    assert.strictEqual(isPathInsideDirectory('/', '/anything'), true);
  });

  it('TC-PH-004: isPathInsideDirectory true with trailing-slash root', () => {
    assert.strictEqual(isPathInsideDirectory('/foo/', '/foo/bar'), true);
  });

  it('TC-PH-005: isPathWithinDirectories membership and non-membership', () => {
    assert.strictEqual(isPathWithinDirectories('/foo/bar', ['/other']), false);
    assert.strictEqual(isPathWithinDirectories('/foo/bar', ['/foo']), true);
  });

  it('TC-PH-007: backslash after the root is a separator only on Windows', () => {
    // On POSIX `\` is a filename character: `/foo\bar` is a sibling of `/foo`.
    assert.strictEqual(isPathInsideDirectory('/foo', '/foo\\bar'), process.platform === 'win32');
  });

  it('TC-PH-008: Windows-shaped paths nest with either separator on Windows', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows path shapes only resolve on win32');
      return;
    }
    assert.strictEqual(isPathInsideDirectory('c:\\foo', 'c:\\foo\\bar'), true);
    assert.strictEqual(isPathInsideDirectory('c:\\foo', 'c:\\foo/bar'), true);
    assert.strictEqual(isPathInsideDirectory('c:\\foo', 'c:\\foobar'), false);
  });

  it('TC-PH-006: normalizeAllowedDirectories dedups, strips trailing separators, preserves root', () => {
    const fsRoot = parse(normalizePath('/')).root;
    const result = normalizeAllowedDirectories(['/foo/', '/foo', '/']);

    // Dedup: '/foo/' and '/foo' collapse to one entry; plus the filesystem root.
    assert.strictEqual(result.length, 2);

    // The filesystem root is preserved.
    assert.ok(
      result.some((d) => isSamePath(d, fsRoot)),
      'filesystem root must be preserved',
    );

    // No non-root entry carries a trailing separator.
    for (const dir of result) {
      if (isSamePath(dir, fsRoot)) continue;
      assert.ok(!dir.endsWith(sep), `non-root entry "${dir}" must not end with a path separator`);
    }

    // The '/foo' entry (deduped from both '/foo/' and '/foo') is present.
    assert.ok(result.some((d) => isSamePath(d, normalizePath('/foo'))));
  });

  it('TC-PH-009: respellCaseOnlyTarget re-spells a case-only match on a case-insensitive filesystem', (t) => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      t.skip('case-only re-spelling only applies on a case-insensitive filesystem');
      return;
    }
    const resolvedTarget = join(tmpdir(), 'foo.txt');
    const result = respellCaseOnlyTarget('x/Foo.txt', resolvedTarget);
    assert.strictEqual(basename(result), 'Foo.txt');
  });

  it('TC-PH-010: respellCaseOnlyTarget leaves an unrelated basename unchanged', () => {
    assert.strictEqual(respellCaseOnlyTarget('x/bar.txt', '/a/foo.txt'), '/a/foo.txt');
  });

  it('TC-PH-011: respellCaseOnlyTarget leaves an identical basename unchanged', () => {
    assert.strictEqual(respellCaseOnlyTarget('x/foo.txt', '/a/foo.txt'), '/a/foo.txt');
  });
});
