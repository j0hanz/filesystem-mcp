import assert from 'node:assert/strict';
import { parse, sep } from 'node:path';
import { describe, it } from 'node:test';

import {
  isPathInsideDirectory,
  isPathWithinDirectories,
  isSamePath,
  normalizePath,
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
});
