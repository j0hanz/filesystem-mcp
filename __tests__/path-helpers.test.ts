import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { delimiter, join, parse, sep } from 'node:path';
import { describe, it } from 'node:test';

import {
  escapeNonAscii,
  expandHome,
  getReservedDeviceNameForPath,
  IS_CASE_INSENSITIVE_FS,
  isAlpha,
  isEquivalentPath,
  isPathInsideDirectory,
  isPathWithinDirectories,
  isSamePath,
  isSlash,
  isUncOrDevicePath,
  isUnresolvableDrivePath,
  isWindowsDrivePath,
  mayHaveEquivalentSpelling,
  normalizeAllowedDirectory,
  normalizePath,
  resolveEntryType,
  splitDirList,
  trimTrailingDotsAndSpaces,
  unicodeMatchKey,
  warnInvalidSetting,
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

  it('identifies CONIN$, CONOUT$, COM0, and LPT0 as reserved device names', () => {
    assert.strictEqual(getReservedDeviceNameForPath('C:/workspace/CONIN$'), 'CONIN$');
    assert.strictEqual(getReservedDeviceNameForPath('C:/workspace/conin$.txt'), 'CONIN$');
    assert.strictEqual(getReservedDeviceNameForPath('CONOUT$'), 'CONOUT$');
    assert.strictEqual(getReservedDeviceNameForPath('COM0'), 'COM0');
    assert.strictEqual(getReservedDeviceNameForPath('LPT0'), 'LPT0');
    assert.strictEqual(getReservedDeviceNameForPath('C:/workspace/valid_file.txt'), undefined);
  });

  it('resolveEntryType classifies dirent-like objects', () => {
    assert.strictEqual(
      resolveEntryType({
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      }),
      'directory',
    );
    assert.strictEqual(
      resolveEntryType({
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      }),
      'file',
    );
    assert.strictEqual(
      resolveEntryType({
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => true,
      }),
      'symlink',
    );
    assert.strictEqual(
      resolveEntryType({
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => false,
      }),
      'other',
    );
  });

  it('warnInvalidSetting prints once per setting:value pair', () => {
    const originalError = console.error;
    const calls: string[] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args.map(String).join(' '));
    };
    try {
      warnInvalidSetting('testSettingA', 'invalid1', 'valid1', 'defaultVal');
      assert.strictEqual(calls.length, 1);
      assert.match(calls[0] ?? '', /Invalid testSettingA value: invalid1/);
      assert.match(calls[0] ?? '', /Using default: defaultVal/);

      // Second call with same name:value is suppressed
      warnInvalidSetting('testSettingA', 'invalid1', 'valid1', 'defaultVal');
      assert.strictEqual(calls.length, 1);

      // Call with different value warns
      warnInvalidSetting('testSettingA', 'invalid2', 'valid1', 'defaultVal');
      assert.strictEqual(calls.length, 2);
    } finally {
      console.error = originalError;
    }
  });

  it('splitDirList splits delimiter-separated paths, trims, and discards empty segments', () => {
    assert.deepStrictEqual(splitDirList(undefined), []);
    assert.deepStrictEqual(splitDirList(''), []);
    assert.deepStrictEqual(splitDirList('   '), []);
    assert.deepStrictEqual(splitDirList(`  foo  ${delimiter}${delimiter} bar ${delimiter} `), [
      'foo',
      'bar',
    ]);
  });

  it('isSlash identifies forward slash and backslash char codes', () => {
    assert.strictEqual(isSlash(47), true); // '/'
    assert.strictEqual(isSlash(92), true); // '\\'
    assert.strictEqual(isSlash(65), false); // 'A'
    assert.strictEqual(isSlash(0), false);
  });

  it('isAlpha tests boundary ascii upper and lower case letters', () => {
    assert.strictEqual(isAlpha(64), false); // '@'
    assert.strictEqual(isAlpha(65), true); // 'A'
    assert.strictEqual(isAlpha(90), true); // 'Z'
    assert.strictEqual(isAlpha(91), false); // '['
    assert.strictEqual(isAlpha(96), false); // '`'
    assert.strictEqual(isAlpha(97), true); // 'a'
    assert.strictEqual(isAlpha(122), true); // 'z'
    assert.strictEqual(isAlpha(123), false); // '{'
    assert.strictEqual(isAlpha(48), false); // '0'
  });

  it('trimTrailingDotsAndSpaces trims multiple trailing dots and spaces', () => {
    assert.strictEqual(trimTrailingDotsAndSpaces('foo..'), 'foo');
    assert.strictEqual(trimTrailingDotsAndSpaces('foo  '), 'foo');
    assert.strictEqual(trimTrailingDotsAndSpaces('foo. . .'), 'foo');
    assert.strictEqual(trimTrailingDotsAndSpaces('foo'), 'foo');
  });

  it('isWindowsDrivePath requires drive letter at the root start', () => {
    assert.strictEqual(isWindowsDrivePath('\\\\?\\C:\\foo'), false);
    assert.strictEqual(isWindowsDrivePath('C:\\foo'), true);
  });

  it('isUncOrDevicePath matches UNC device prefix on Windows only', () => {
    const onWindows = process.platform === 'win32';
    assert.strictEqual(isUncOrDevicePath('\\\\server\\share'), onWindows);
    assert.strictEqual(isUncOrDevicePath('C:\\foo'), false);
    assert.strictEqual(isUncOrDevicePath('server\\\\'), false);
  });

  it('expandHome expands tilde paths and strips leading slashes after tilde', () => {
    const home = homedir();
    assert.strictEqual(expandHome('~'), home);
    assert.strictEqual(expandHome('~/'), home);
    assert.strictEqual(expandHome('~//'), home);
    assert.strictEqual(expandHome('~\\'), home);
    assert.strictEqual(expandHome('~\\\\'), home);
    assert.strictEqual(expandHome('~/foo'), join(home, 'foo'));
    assert.strictEqual(expandHome('~\\foo'), join(home, 'foo'));
    assert.strictEqual(expandHome('~//foo'), join(home, 'foo'));
    assert.strictEqual(expandHome('~\\\\foo'), join(home, 'foo'));
    assert.strictEqual(expandHome('relative/path'), 'relative/path');
  });

  it('normalizePath lowercases drive letter on Windows', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows drive lowercasing only runs on win32');
      return;
    }
    const res = normalizePath('C:\\TestDir');
    assert.strictEqual(res.charAt(0), 'c');
    assert.strictEqual(res.slice(1, 3), ':\\');
  });

  it('unicodeMatchKey folds ASCII case on case-insensitive filesystems', () => {
    if (IS_CASE_INSENSITIVE_FS) {
      assert.strictEqual(unicodeMatchKey('ABC'), 'abc');
      assert.strictEqual(unicodeMatchKey('FoO'), 'foo');
    } else {
      assert.strictEqual(unicodeMatchKey('ABC'), 'ABC');
    }
  });

  it('isEquivalentPath returns false for completely different paths', () => {
    assert.strictEqual(isEquivalentPath('/alpha/one', '/beta/two'), false);
    assert.strictEqual(isEquivalentPath('/foo/bar', '/foo/baz'), false);
  });

  it('normalizeAllowedDirectory trims whitespace and returns empty string for empty input', () => {
    assert.strictEqual(normalizeAllowedDirectory(''), '');
    assert.strictEqual(normalizeAllowedDirectory('   '), '');
    const expected = normalizePath('/some/dir');
    assert.strictEqual(normalizeAllowedDirectory('  /some/dir  '), expected);
  });
});
