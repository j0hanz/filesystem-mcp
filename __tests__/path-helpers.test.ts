import assert from 'node:assert/strict';
import { parse, sep } from 'node:path';
import { describe, it } from 'node:test';

import {
  escapeNonAscii,
  IS_CASE_INSENSITIVE_FS,
  isPathInsideDirectory,
  isPathWithinDirectories,
  isSamePath,
  isUnresolvableDrivePath,
  isWindowsDrivePath,
  mayHaveEquivalentSpelling,
  normalizePath,
  unicodeMatchKey,
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

  it('TC-PH-012: a drive path is unresolvable off Windows, and only drive-relative on it', () => {
    const onWindows = process.platform === 'win32';
    for (const [path, isDrive, refused] of [
      ['C:\\Users\\x', true, !onWindows],
      ['c:/Users/x', true, !onWindows],
      ['C:', true, true],
      ['C:foo', true, true],
      ['logs:x', false, false],
      ['1:/x', false, false],
      ['/srv/C:/x', false, false],
      ['\\\\server\\share\\x', false, false],
    ] as const) {
      assert.strictEqual(isWindowsDrivePath(path), isDrive, path);
      assert.strictEqual(isUnresolvableDrivePath(path), refused, path);
    }
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

  it('TC-PH-013: unicodeMatchKey folds NFC/NFD and every space separator, not tabs', () => {
    assert.strictEqual(unicodeMatchKey('cafe\u0301'), unicodeMatchKey('caf\u00e9'));
    assert.strictEqual(unicodeMatchKey('shot\u202fPM'), unicodeMatchKey('shot PM'));
    assert.strictEqual(unicodeMatchKey('a\u00a0b'), unicodeMatchKey('a b'));
    assert.notStrictEqual(unicodeMatchKey('a\tb'), unicodeMatchKey('a b'));
  });

  it('TC-PH-015: mayHaveEquivalentSpelling is false only for printable ASCII without a space', () => {
    assert.strictEqual(mayHaveEquivalentSpelling('new-file.ts'), false);
    assert.strictEqual(mayHaveEquivalentSpelling('a b.txt'), true);
    assert.strictEqual(mayHaveEquivalentSpelling('caf\u00e9'), true);
  });

  it('TC-PH-016: escapeNonAscii writes each non-ASCII UTF-16 unit as a JSON escape', () => {
    assert.strictEqual(escapeNonAscii('a\u00a0b'), 'a\\u00a0b');
    assert.strictEqual(escapeNonAscii('x\u{1f600}'), 'x\\ud83d\\ude00');
  });

  it('TC-PH-020: a Kelvin sign is not the letter k for containment', (t) => {
    if (!IS_CASE_INSENSITIVE_FS) {
      t.skip('case folding applies on a case-insensitive filesystem');
      return;
    }
    const root = normalizePath('C:/x/kroot');
    assert.strictEqual(
      isPathInsideDirectory(root, normalizePath('C:/x/\u212Aroot/secret.txt')),
      false,
    );
    assert.strictEqual(isSamePath('C:/x/\u212Aroot', 'C:/x/kroot'), false);
    assert.strictEqual(isPathInsideDirectory(root, normalizePath('C:/x/\u017Froot/s')), false); // long s
    assert.strictEqual(isPathInsideDirectory(root, normalizePath('C:/X/KROOT/a.txt')), true); // ASCII still folds
  });
});
