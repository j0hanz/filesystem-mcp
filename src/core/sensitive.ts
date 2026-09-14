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
  // normalize() preserves the double leading slash of UNC paths
  // (//server/share/...) on Windows; collapse it to one so the compiled
  // patterns — which carry no leading slash — still match their segments.
  return toPosixPath(normalize(input)).toLowerCase().replace(/^\/+/u, '/');
}

interface CompiledPatternSet {
  pathGlobs: readonly RegExp[];
  nameGlobs: readonly RegExp[];
}

// posix.matchesGlob runs with dot:false semantics and does not honor a dot
// option at all (verified on Node 24): '*' and '**' never match dot-leading
// path segments, so a deny of `secrets/**` silently let `secrets/.env`
// through — fail-open against exactly the hidden files this list exists to
// guard. Compile our own matcher instead. Supported metacharacters: '*'
// (any run within a segment), '**' (any run of whole segments), '?' (one
// char), '[...]' classes, and '{a,b}' alternation; everything else is
// literal, and dot-leading segments match like any other.
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Character classes can carry '{', '}' and ',' as members, so every scanner
// below must skip a class's interior. classEnd returns the index of the ']'
// closing the class opened at openIdx, or -1 when unclosed (then '[' is a
// literal, matching globToRegExp's fallback). A ']' right after '[' or the
// '!' negation is a literal member, per glob syntax.
function classEnd(glob: string, openIdx: number): number {
  let i = openIdx + 1;
  if (glob[i] === '!') i++;
  if (glob[i] === ']') i++;
  while (i < glob.length && glob[i] !== ']') i++;
  return i < glob.length ? i : -1;
}

function expandBraces(glob: string): string[] {
  // First '{' outside any [...] class.
  let open = -1;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? '';
    if (char === '[') {
      const end = classEnd(glob, i);
      if (end !== -1) i = end;
    } else if (char === '{') {
      open = i;
      break;
    }
  }
  if (open === -1) return [glob];
  // Pair the outer '{' with ITS matching '}' — indexOf would grab the inner
  // group's closer and produce garbage like 'data/x}/secret'. Then split the
  // body on depth-0 commas so nested groups stay intact for the recursion.
  let depth = 0;
  let close = -1;
  for (let i = open; i < glob.length; i++) {
    const char = glob[i] ?? '';
    if (char === '[') {
      const end = classEnd(glob, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [glob];
  const prefix = glob.slice(0, open);
  const suffix = glob.slice(close + 1);
  const body = glob.slice(open + 1, close);
  const parts: string[] = [];
  let start = 0;
  depth = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? '';
    if (char === '[') {
      const end = classEnd(body, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.flatMap((part) => expandBraces(`${prefix}${part}${suffix}`));
}

function globToRegExp(glob: string): RegExp {
  const segments = glob.split('/');
  let source = '';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? '';
    const last = i === segments.length - 1;
    if (segment === '**') {
      source += last ? '(?:.*)?' : '(?:[^/]+/)*';
      continue;
    }
    for (let j = 0; j < segment.length; j++) {
      const char = segment[j] ?? '';
      if (char === '*') {
        while (segment[j + 1] === '*') j++;
        source += '[^/]*';
      } else if (char === '?') {
        source += '[^/]';
      } else if (char === '[') {
        // Same classEnd rule the scanners use: a ']' right after '[' (or
        // after the '!' negation) is a literal member, not the closer.
        const close = classEnd(segment, j);
        if (close !== -1) {
          // Pass the class through, flipping glob '!' negation to '^' and
          // escaping backslashes so no body can make new RegExp throw. A
          // leading ']' must be escaped too or the 'u' flag parses '[]a]'
          // as an empty class followed by stray literals.
          let body = segment.slice(j + 1, close).replace(/\\/gu, '\\\\');
          const negated = body.startsWith('!');
          if (negated) body = body.slice(1);
          if (body.startsWith(']')) body = `\\${body}`;
          source += `[${negated ? '^' : ''}${body}]`;
          j = close;
        } else {
          source += escapeRegExp(char);
        }
      } else {
        source += escapeRegExp(char);
      }
    }
    if (!last) source += '/';
  }
  // Candidates are absolute paths but patterns carry no leading '/', so the
  // anchor optionally eats the root slash — `**/` then reaches from any
  // parent, exactly as matchesGlob's globstar did. '$' is strict in
  // JavaScript (it matches end-of-input only, unlike PCRE's, which also
  // matches before a final newline), so an exact-name pattern can never
  // match a '.env\n' lookalike. The 's' flag makes the terminal-`**` `.`
  // match newlines too: filenames can contain them, and a deny ending in
  // '/**' must not fail open on 'secrets/plan\nnotes'.
  return new RegExp(`^/?${source}$`, 'su');
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

  // A leading '/' (POSIX-absolute) is rooted like a Windows drive path:
  // aliasing '/abs/secret' as '**/abs/secret' would also match
  // 'other/abs/secret', and on the allow side that is over-relief.
  const isRooted =
    normalizedPattern.startsWith('/') ||
    normalizedPattern.startsWith('**/') ||
    isWindowsAbsolutePosixPath(normalizedPattern);
  if (!isRooted) {
    const withoutRoot = normalizedPattern.replace(/^\/+/, '');
    if (withoutRoot) {
      globs.add(`**/${withoutRoot}`);
    }
  }

  return Array.from(globs);
}

function toPatternSet(patterns: readonly string[]): CompiledPatternSet {
  const pathGlobs = new Set<RegExp>();
  const nameGlobs = new Set<RegExp>();

  const deduped = Array.from(new Set(patterns.map((p) => p.trim()).filter((p) => p.length > 0)));
  for (const pattern of deduped) {
    const normalized = normalizeForMatch(pattern);
    const matchesPath = normalized.includes('/');
    const target = matchesPath ? pathGlobs : nameGlobs;
    const globs = matchesPath ? compilePatternGlobs(normalized) : [normalized];
    for (const glob of globs) {
      for (const expanded of expandBraces(glob)) {
        target.add(globToRegExp(expanded));
      }
    }
  }

  return {
    pathGlobs: [...pathGlobs],
    nameGlobs: [...nameGlobs],
  };
}

function matchesAnyGlob(globs: readonly RegExp[], candidate: string): boolean {
  if (globs.length === 0) return false;

  for (const glob of globs) {
    if (glob.test(candidate)) return true;
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

// Split an env pattern list on commas and newlines at brace depth 0 only and
// outside any [...] class, so documented syntax like '*.{pem,key}' or
// 'x[1,2].env' survives as one pattern instead of tearing apart.
function splitPatternList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i] ?? '';
    if (char === '[') {
      const end = classEnd(value, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    if (char === '{') depth++;
    else if (char === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === ',' || char === '\n')) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((t) => t.trim()).filter((t) => t.length > 0);
}

function buildDenyTiers(): DenyTiers {
  const allowSensitive =
    cli.allowSensitive ?? parseTrueEnvFlag(process.env['FS_ALLOW_SENSITIVE'], 'FS_ALLOW_SENSITIVE');
  const envDenylist = process.env['FS_DENYLIST']
    ? splitPatternList(process.env['FS_DENYLIST'])
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
  const envAllowlist = process.env['FS_ALLOWLIST']
    ? splitPatternList(process.env['FS_ALLOWLIST'])
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
