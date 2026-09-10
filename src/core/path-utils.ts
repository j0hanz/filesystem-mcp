import { homedir, platform } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';

import { IS_WINDOWS, isAlpha, isSlash } from './primitives.js';

const CHAR_COLON = 58;
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

function getReservedDeviceName(segment: string): string | undefined {
  const trimmed = segment.replace(/[. ]+$/, '');
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
  // silently expand them relative to CWD.
  if (requestedPath.length < 2) {
    return false;
  }
  if (requestedPath.charCodeAt(1) !== CHAR_COLON) {
    return false;
  }
  if (!isAlpha(requestedPath.charCodeAt(0))) {
    return false;
  }

  if (requestedPath.length === 2) {
    return true;
  }
  return !isSlash(requestedPath.charCodeAt(2));
}

function expandHome(filepath: string): string {
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

const IS_CASE_INSENSITIVE_FS = IS_WINDOWS || platform() === 'darwin';

export function normalizeCaseForComparison(value: string): string {
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

export function isPathInsideDirectory(
  normalizedDirectory: string,
  normalizedCandidate: string,
): boolean {
  const root = normalizeCaseForComparison(normalizedDirectory);
  const candidate = normalizeCaseForComparison(normalizedCandidate);

  if (root === candidate) return true;
  if (!candidate.startsWith(root)) return false;

  if (isSlash(root.charCodeAt(root.length - 1))) return true;
  return isSlash(candidate.charCodeAt(root.length));
}

export function isPathWithinDirectories(
  normalizedPath: string,
  allowedDirs: readonly string[],
): boolean {
  return allowedDirs.some((dir) => isPathInsideDirectory(dir, normalizedPath));
}
