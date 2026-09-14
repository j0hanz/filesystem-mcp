// Sensitive-file denylist policy: the compiled pattern set, the path
// normalization that feeds it, and the NTFS alternate-data-stream stripping
// Windows needs. Split out of path.ts so the denylist has its own home — it
// shares only isAlpha / toPosixPath / IS_WINDOWS with the primitives in
// primitives.ts, not the allowed-directory assembly. path-completer.ts and
// glob.ts reach it through PathGuard.isSensitive, which delegates here.
import { normalize, posix, sep } from 'node:path';

import { cli } from './config.js';
import { IS_WINDOWS, isAlpha, parseTrueEnvFlag, toPosixPath } from './primitives.js';

const CHAR_COLON = 58;
const CHAR_FORWARD_SLASH = 47;

function normalizeForMatch(input: string): string {
  // Always lowercase for case-insensitive denylist matching on all platforms.
  return toPosixPath(normalize(input)).toLowerCase();
}

interface CompiledPatternSet {
  pathGlobs: readonly string[];
  nameGlobs: readonly string[];
}

function isWindowsAbsolutePosixPath(normalizedPattern: string): boolean {
  return (
    normalizedPattern.length >= 3 &&
    normalizedPattern.charCodeAt(1) === CHAR_COLON &&
    normalizedPattern.charCodeAt(2) === CHAR_FORWARD_SLASH &&
    isAlpha(normalizedPattern.charCodeAt(0))
  );
}

function compilePatternGlobs(normalizedPattern: string): readonly string[] {
  const globs = new Set<string>([normalizedPattern]);

  const isRooted =
    normalizedPattern.startsWith('**/') || isWindowsAbsolutePosixPath(normalizedPattern);
  if (!isRooted) {
    const withoutRoot = normalizedPattern.replace(/^\/+/, '');
    if (withoutRoot) {
      globs.add(`**/${withoutRoot}`);
    }
  }

  return Array.from(globs);
}

function toPatternSet(patterns: readonly string[]): CompiledPatternSet {
  const pathGlobs = new Set<string>();
  const nameGlobs = new Set<string>();

  const deduped = Array.from(new Set(patterns.map((p) => p.trim()).filter((p) => p.length > 0)));
  for (const pattern of deduped) {
    const normalized = normalizeForMatch(pattern);
    const matchesPath = normalized.includes('/');
    const target = matchesPath ? pathGlobs : nameGlobs;
    for (const glob of matchesPath ? compilePatternGlobs(normalized) : [normalized]) {
      target.add(glob);
    }
  }

  return {
    pathGlobs: [...pathGlobs],
    nameGlobs: [...nameGlobs],
  };
}

function matchesAnyGlob(globs: readonly string[], candidate: string): boolean {
  if (globs.length === 0) return false;

  for (const glob of globs) {
    if (posix.matchesGlob(candidate, glob)) return true;
  }

  return false;
}

// Strip NTFS alternate-data-stream suffixes (the ":stream" after a segment)
// before denylist matching, so `.env:secret` is caught as `.env`. Preserves the
// drive-letter colon in the first segment of an absolute path. Also trims
// trailing dots/spaces: Win32 strips them at the syscall boundary (a request
// to create `.env ` actually creates `.env`), so without trimming them here the
// exact-name patterns (`.env`, `.npmrc`) are bypassed on Windows. Mirrors the
// precedent in getReservedDeviceName (path.ts) which trims for the same reason.
function stripAlternateDataStreams(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  const stripped = parts.map((segment, i) => {
    if (
      i === 0 &&
      segment.length === 2 &&
      isAlpha(segment.charCodeAt(0)) &&
      segment.charCodeAt(1) === CHAR_COLON
    ) {
      return segment;
    }
    const colonIdx = segment.indexOf(':');
    const withoutStream = colonIdx !== -1 ? segment.slice(0, colonIdx) : segment;
    // Win32 strips trailing dots and spaces at the syscall boundary, so a
    // request for ".env " creates ".env". Strip them before denylist matching
    // or the exact-name patterns (".env", ".npmrc") are bypassed on Windows.
    return trimTrailingDotsAndSpaces(withoutStream);
  });
  return stripped.join(sep);
}

const trimTrailingDotsAndSpaces = (segment: string): string => segment.replace(/[. ]+$/, '');

const DEFAULT_SENSITIVE_PATTERNS = [
  '.env',
  '.env.*',
  '.npmrc',
  '.pypirc',
  '.aws/credentials',
  '.aws/config',
  '.mcpregistry_*_token',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.crt',
  '*.cer',
  '*id_rsa*',
  '*id_dsa*',
] as const;

// Built-ins and operator-supplied deny entries live in separate tiers because
// they answer to different relief switches: an allow entry (FS_ALLOWLIST /
// --allow) can lift a built-in hit, but never an explicit deny.
interface DenyTiers {
  builtin: readonly string[];
  operator: readonly string[];
}

function buildDenyTiers(): DenyTiers {
  const allowSensitive =
    cli.allowSensitive ?? parseTrueEnvFlag(process.env['FS_ALLOW_SENSITIVE'], 'FS_ALLOW_SENSITIVE');
  const envValue = process.env['FS_DENYLIST'];
  const envDenylist = envValue
    ? envValue
        .split(/[,\n]/u)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];
  const flagDenylist = cli.denyPatterns ?? [];
  // FS_ALLOW_SENSITIVE suppresses built-ins only; deny entries (env and --deny)
  // always apply. Set-dedupe so a pattern in both sources matches once.
  return {
    builtin: allowSensitive ? [] : DEFAULT_SENSITIVE_PATTERNS,
    operator: [...new Set([...envDenylist, ...flagDenylist])],
  };
}

function buildAllowPatterns(): readonly string[] {
  const envValue = process.env['FS_ALLOWLIST'];
  const envAllowlist = envValue
    ? envValue
        .split(/[,\n]/u)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];
  const flagAllowlist = cli.allowPatterns ?? [];
  return [...new Set([...envAllowlist, ...flagAllowlist])];
}

const EMPTY_PATTERN_SET: CompiledPatternSet = { pathGlobs: [], nameGlobs: [] };

export class SensitiveMatcher {
  private readonly builtin: CompiledPatternSet;
  private readonly operator: CompiledPatternSet;
  private readonly allow: CompiledPatternSet;

  // An explicit pattern list (tests, custom guards) is one relievable tier;
  // the default construction splits built-ins from operator-supplied
  // FS_DENYLIST/--deny entries, which allow entries can never lift.
  constructor(patterns?: readonly string[], allow?: readonly string[]) {
    if (patterns !== undefined || allow !== undefined) {
      this.builtin = toPatternSet(patterns ?? []);
      this.operator = EMPTY_PATTERN_SET;
      this.allow = toPatternSet(allow ?? []);
    } else {
      const tiers = buildDenyTiers();
      this.builtin = toPatternSet(tiers.builtin);
      this.operator = toPatternSet(tiers.operator);
      this.allow = toPatternSet(buildAllowPatterns());
    }
  }

  isSensitive(filePath: string): boolean {
    const pathToCheck = IS_WINDOWS ? stripAlternateDataStreams(filePath) : filePath;
    const normalizedPath = normalizeForMatch(pathToCheck);
    const name = posix.basename(normalizedPath);
    const matches = (set: CompiledPatternSet): boolean =>
      matchesAnyGlob(set.pathGlobs, normalizedPath) || matchesAnyGlob(set.nameGlobs, name);

    // Explicit deny entries (FS_DENYLIST/--deny) always apply.
    if (matches(this.operator)) return true;
    if (!matches(this.builtin)) return false;
    // A built-in hit is lifted only by an allow entry that matches the same
    // normalized candidate — a pattern that matches nothing relieves nothing.
    return !matches(this.allow);
  }
}
