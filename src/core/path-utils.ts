import { homedir, platform } from 'node:os';
import { delimiter, join, parse, relative, resolve, sep, win32 } from 'node:path';

// ─── Shared primitives (no intra-package imports; every core module may import this) ──

export type EntryType = 'file' | 'directory' | 'symlink' | 'other';

/** The three predicates both `Dirent` and `Stats` expose - all `resolveEntryType` needs. */
export interface DirentLike {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export function resolveEntryType(dirent: DirentLike): EntryType {
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}

const warnedSettings = new Set<string>();

/**
 * Warn once per (setting, value) that a configured value was rejected, and say
 * what was used instead. console.error, not Logger: this module stays
 * dependency-free to avoid import cycles, and a startup misconfiguration is
 * worth printing even when the operator asked for errors only.
 */
export function warnInvalidSetting(
  name: string,
  value: string,
  expected: string,
  fallback: string | number | boolean,
): void {
  const key = `${name}:${value}`;
  if (warnedSettings.has(key)) return;
  warnedSettings.add(key);
  console.error(
    `[warning] Invalid ${name} value: ${value} (must be ${expected}). Using default: ${String(fallback)}`,
  );
}

export function splitDirList(val: string | undefined): string[] {
  if (!val) return [];
  return val
    .split(delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// ─── Character-level path primitives ─────────────────────────────────────────

export const IS_WINDOWS = process.platform === 'win32';

export const isSlash = (code: number): boolean => code === 47 || code === 92;

export const isAlpha = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

export const toPosixPath = (value: string): string => value.replaceAll('\\', '/');

/** `path.relative` with forward slashes, so displayed paths match across platforms. */
export function toPosixRelative(from: string, to: string): string {
  return toPosixPath(relative(from, to));
}

// ─── Path normalization and containment ──────────────────────────────────────

export const CHAR_COLON = 58;
const HOMEDIR = homedir();

const RESERVED_DEVICE_NAMES = new Set<string>([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/**
 * Win32 strips trailing dots and spaces at the syscall boundary (a request for
 * `.env ` creates `.env`), so every name check must trim them first or it is
 * bypassed on Windows.
 */
export const trimTrailingDotsAndSpaces = (segment: string): string => segment.replace(/[. ]+$/, '');

function getReservedDeviceName(segment: string): string | undefined {
  const trimmed = trimTrailingDotsAndSpaces(segment);
  const withoutStream = trimmed.split(':')[0] ?? '';
  const baseName = (withoutStream.split('.')[0] ?? '').toUpperCase();
  return RESERVED_DEVICE_NAMES.has(baseName) ? baseName : undefined;
}

export function getReservedDeviceNameForPath(requestedPath: string): string | undefined {
  const segments = requestedPath.split(/[\\/]/u);
  for (const segment of segments) {
    const reserved = getReservedDeviceName(segment);
    if (reserved) {
      return reserved;
    }
  }
  return undefined;
}

export function isWindowsDriveRelativePath(requestedPath: string): boolean {
  // Check on all platforms so cross-platform clients cannot smuggle drive-relative
  // inputs (e.g. C:relative) to a POSIX-hosted server where path.resolve would
  // silently expand them relative to CWD. win32.parse is the platform-independent
  // binding, so this reads the same on a POSIX host.
  const { root } = win32.parse(requestedPath);
  return root.length === 2;
}

/**
 * True for a path that names a Windows drive: `C:\x`, `C:/x`, `C:`, and the
 * drive-relative `C:x`. Only Windows resolves one. On POSIX it is a relative
 * path, so `C:\x` would become a file of that name under the root.
 */
export const isWindowsDrivePath = (requestedPath: string): boolean =>
  /^[A-Za-z]:/u.test(win32.parse(requestedPath).root);

/**
 * True when a ':' follows the path's root, i.e. an NTFS alternate data stream
 * (`a.txt:s`, `a.txt::$DATA`). win32.parse keeps the drive colon of `C:\`,
 * `\\?\C:\` and `\\.\C:\` inside the root, so only stream colons are seen.
 */
export const hasAlternateDataStream = (requestedPath: string): boolean =>
  requestedPath.slice(win32.parse(requestedPath).root.length).includes(':');

/**
 * A drive path this host refuses before resolving it: drive-relative anywhere,
 * and any drive path where the host is not Windows.
 */
export const isUnresolvableDrivePath = (requestedPath: string): boolean =>
  IS_WINDOWS ? isWindowsDriveRelativePath(requestedPath) : isWindowsDrivePath(requestedPath);

export function expandHome(filepath: string): string {
  if (filepath === '~' || filepath.startsWith('~/') || filepath.startsWith('~\\')) {
    const rest = filepath.slice(1).replace(/^[/\\]+/, '');
    return rest ? join(HOMEDIR, rest) : HOMEDIR;
  }
  return filepath;
}

export function normalizePath(p: string): string {
  const resolved = resolve(expandHome(p));

  // On Windows only the drive letter is lowercased (e.g. "C:\Foo\Bar").
  // The rest of the path retains its original casing.
  // IMPORTANT: callers must use isSamePath / isPathInsideDirectory for all
  // equality and containment checks — never raw string equality — because
  // those helpers apply full case-folding before comparing.
  if (IS_WINDOWS && resolved.length >= 2 && resolved.charCodeAt(1) === CHAR_COLON) {
    return resolved.charAt(0).toLowerCase() + resolved.slice(1);
  }

  return resolved;
}

export const IS_CASE_INSENSITIVE_FS = IS_WINDOWS || platform() === 'darwin';

// ASCII only: JS folds U+212A/U+017F onto k/s, NTFS does not, so a full fold equates a sibling with the root.
function normalizeCaseForComparison(value: string): string {
  return IS_CASE_INSENSITIVE_FS ? value.replace(/[A-Z]/gu, (c) => c.toLowerCase()) : value;
}

function foldNameCase(value: string): string {
  return IS_CASE_INSENSITIVE_FS ? value.toLowerCase() : value;
}

export function isSamePath(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const leftResolved = normalizeCaseForComparison(resolve(left));
  const rightResolved = normalizeCaseForComparison(resolve(right));
  return leftResolved === rightResolved;
}

/**
 * What two names share when they differ only in Unicode form (NFC or NFD) or
 * in which space character they use (U+0020, U+00A0, U+202F, and every other
 * Zs), case-folded where the filesystem folds case. A model types back
 * `caf\u00e9` and `shot PM.png` for the `cafe\u0301` and `shot\u202fPM.png` a
 * listing showed it (#101).
 */
export function unicodeMatchKey(name: string): string {
  return foldNameCase(name.normalize('NFC').replace(/\p{Zs}/gu, ' '));
}

/**
 * True when two paths are one path once case (where the filesystem folds it)
 * and Unicode spelling are folded: the spellings the path guard resolves to
 * one entry when only one of them is on disk.
 */
export function isEquivalentPath(left: string, right: string): boolean {
  return (
    isSamePath(left, right) || unicodeMatchKey(resolve(left)) === unicodeMatchKey(resolve(right))
  );
}

/**
 * False for a name of printable ASCII with no space, which no other entry can
 * share a `unicodeMatchKey` with — except a name holding U+212A, U+037E or
 * U+1FEF, which NFC maps to ASCII; those stay unmatched. A missed lookup of
 * such a name skips the directory scan, so creating `new-file.ts` costs what
 * it did.
 */
export function mayHaveEquivalentSpelling(name: string): boolean {
  return /[^\x21-\x7e]/u.test(name);
}

/** `name` with each non-ASCII code unit as a `\uXXXX` escape, which a JSON string argument accepts. */
export function escapeNonAscii(name: string): string {
  // No `u` flag: each UTF-16 code unit, a surrogate included, gets its own escape.
  return name.replace(
    /[^\x20-\x7e]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function normalizeAllowedDirectory(dir: string): string {
  const trimmed = dir.trim();
  if (trimmed.length === 0) return '';

  const normalized = normalizePath(trimmed);
  const { root } = parse(normalized);

  // Keep filesystem roots as-is ("/", "c:\\", "\\\\server\\share\\").
  if (isSamePath(normalized, root)) {
    return root;
  }

  return normalized.length > 1 && normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized;
}

// `\` separates path segments only on Windows. On POSIX it is a filename
// character, so `/root\x` names a sibling of `/root`, not a child.
const isPathSeparator = (code: number): boolean => code === 47 || (IS_WINDOWS && code === 92);

export function isPathInsideDirectory(
  normalizedDirectory: string,
  normalizedCandidate: string,
): boolean {
  const root = normalizeCaseForComparison(normalizedDirectory);
  const candidate = normalizeCaseForComparison(normalizedCandidate);

  if (root === candidate) return true;
  if (!candidate.startsWith(root)) return false;

  if (isPathSeparator(root.charCodeAt(root.length - 1))) return true;
  return isPathSeparator(candidate.charCodeAt(root.length));
}

export function isPathWithinDirectories(
  normalizedPath: string,
  allowedDirs: readonly string[],
): boolean {
  return allowedDirs.some((dir) => isPathInsideDirectory(dir, normalizedPath));
}
