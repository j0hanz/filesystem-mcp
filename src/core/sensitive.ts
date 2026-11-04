// Sensitive-file denylist policy: the compiled pattern set, the path
// normalization that feeds it, and the NTFS alternate-data-stream stripping
// Windows needs. Split out of path.ts so the denylist has its own home — it
// shares only character-level primitives from path-utils.ts, not the
// allowed-directory assembly. path.ts and path-completer.ts reach it through
// PathGuard.isSensitive, which delegates here.
import { normalize, posix, sep } from 'node:path';

import { cli } from './config.ts';
import {
  CHAR_COLON,
  IS_WINDOWS,
  isAlpha,
  toPosixPath,
  trimTrailingDotsAndSpaces,
} from './path-utils.ts';
import { escapeRegExp, parseTrueEnvFlag } from './util.ts';

function normalizeForMatch(input: string): string {
  // Always lowercase for case-insensitive denylist matching on all platforms.
  // normalize() preserves the double leading slash of UNC paths
  // (//server/share/...) on Windows; collapse it to one so the compiled
  // patterns — which carry no leading slash — still match their segments.
  return toPosixPath(normalize(input)).toLowerCase().replace(/^\/+/u, '/');
}

/**
 * A normalized pattern or path in NFC, with every space separator read as
 * U+0020: the spelling the path guard folds names to (#101), so a pattern
 * also matches the other Unicode spellings of the names it covers.
 */
function foldForMatch(normalized: string): string {
  return normalized
    .normalize('NFC')
    .replace(/\p{Zs}/gu, ' ')
    .toLowerCase();
}

interface GlobSet {
  pathGlobs: readonly RegExp[];
  nameGlobs: readonly RegExp[];
}

/**
 * Every pattern twice: as typed, and folded. Each form is matched on its own
 * (see `isSensitive`), because folding can also lose a match: `cafe?.txt`
 * matches `cafe\u0301.txt` as typed, but not the composed `caf\u00e9.txt`.
 */
interface CompiledPatternSet {
  raw: GlobSet;
  folded: GlobSet;
  /** No pattern changes under folding: on a path folding leaves alone, `folded` matches as `raw` does. */
  foldInvariant: boolean;
}

// posix.matchesGlob runs with dot:false semantics and does not honor a dot
// option at all (verified on Node 24): '*' and '**' never match dot-leading
// path segments, so a deny of `secrets/**` silently let `secrets/.env`
// through — fail-open against exactly the hidden files this list exists to
// guard. Compile our own matcher instead. Supported metacharacters: '*'
// (any run within a segment), '**' (any run of whole segments), '?' (one
// char), '[...]' classes, and '{a,b}' alternation; everything else is
// literal, and dot-leading segments match like any other.

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

function globToRegExp(glob: string, fold: boolean): RegExp {
  const segments = glob.split('/');
  let source = '';
  // Literal text is folded here, by the same parse that finds the classes,
  // so a class is always left as typed and a range's endpoints never move
  // (folded, `[a-\u00a0]` would become the reversed `[a- ]` and fail to
  // compile). Runs break only at '*', '?', '/' and a class's brackets, ASCII
  // starters NFC never composes across, so folding run by run equals folding
  // the whole path. Each code unit is escaped on its own, as it always was.
  let text = '';
  const flushText = (): void => {
    const literal = fold ? foldForMatch(text) : text;
    for (let k = 0; k < literal.length; k++) source += escapeRegExp(literal.charAt(k));
    text = '';
  };
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
        flushText();
        while (segment[j + 1] === '*') j++;
        source += '[^/]*';
      } else if (char === '?') {
        flushText();
        source += '[^/]';
      } else if (char === '[') {
        // Same classEnd rule the scanners use: a ']' right after '[' (or
        // after the '!' negation) is a literal member, not the closer.
        const close = classEnd(segment, j);
        if (close !== -1) {
          flushText();
          // Pass the class through, flipping glob '!' negation to '^' and
          // escaping backslashes so no body can make new RegExp throw. A
          // leading ']' must be escaped or the 'u' flag parses '[]a]' as an
          // empty class followed by stray literals; a leading '^' is a
          // literal member (glob negation is '!' only), unescaped it would
          // negate the class and relieve more than the operator named.
          let body = segment.slice(j + 1, close).replace(/\\/gu, '\\\\');
          const negated = body.startsWith('!');
          if (negated) body = body.slice(1);
          if (body.startsWith(']') || body.startsWith('^')) body = `\\${body}`;
          source += `[${negated ? '^' : ''}${body}]`;
          j = close;
        } else {
          text += char;
        }
      } else {
        text += char;
      }
    }
    flushText();
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

function compilePatternGlobs(normalizedPattern: string): readonly string[] {
  // A leading '/' (POSIX-absolute) is rooted like a Windows drive path:
  // aliasing '/abs/secret' as '**/abs/secret' would also match
  // 'other/abs/secret', and on the allow side that is over-relief. The
  // drive-letter regex is safe on [a-z] because normalizeForMatch lowercased.
  const isRooted =
    normalizedPattern.startsWith('/') ||
    normalizedPattern.startsWith('**/') ||
    /^[a-z]:\//u.test(normalizedPattern);
  const withoutRoot = isRooted ? '' : normalizedPattern.replace(/^\/+/, '');
  return withoutRoot ? [normalizedPattern, `**/${withoutRoot}`] : [normalizedPattern];
}

function toPatternSet(patterns: readonly string[]): CompiledPatternSet {
  const deduped = Array.from(new Set(patterns.map((p) => p.trim()).filter((p) => p.length > 0)));
  const normalized = deduped.map(normalizeForMatch);
  const raw = compileGlobSet(normalized, false);
  const folded = compileGlobSet(normalized, true);
  const sources = (set: GlobSet): string =>
    JSON.stringify([set.pathGlobs, set.nameGlobs].map((globs) => globs.map((glob) => glob.source)));
  return { raw, folded, foldInvariant: sources(raw) === sources(folded) };
}

function compileGlobSet(normalizedPatterns: readonly string[], fold: boolean): GlobSet {
  const pathGlobs = new Set<RegExp>();
  const nameGlobs = new Set<RegExp>();

  for (const normalized of normalizedPatterns) {
    const matchesPath = normalized.includes('/');
    const target = matchesPath ? pathGlobs : nameGlobs;
    const globs = matchesPath ? compilePatternGlobs(normalized) : [normalized];
    for (const glob of globs) {
      for (const expanded of expandBraces(glob)) {
        target.add(globToRegExp(expanded, fold));
      }
    }
  }

  return {
    pathGlobs: [...pathGlobs],
    nameGlobs: [...nameGlobs],
  };
}

function matchesAnyGlob(globs: readonly RegExp[], candidate: string): boolean {
  return globs.some((glob) => glob.test(candidate));
}

// Strip NTFS alternate-data-stream suffixes (the ":stream" after a segment)
// before denylist matching, so `.env:secret` is caught as `.env`. Preserves the
// drive-letter colon in the first segment of an absolute path. Also trims
// trailing dots/spaces (see trimTrailingDotsAndSpaces in path-utils.ts), the
// same trim getReservedDeviceName applies.
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
    return trimTrailingDotsAndSpaces(withoutStream);
  });
  return stripped.join(sep);
}

const DEFAULT_SENSITIVE_PATTERNS = [
  '.env',
  '.env.*',
  '.envrc',
  '.htpasswd',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.pgpass',
  '.ssh/**',
  '.gnupg/**',
  '.aws/**',
  '.kube/**',
  '.vault-token',
  '.terraform.d/credentials*',
  '.cargo/credentials*',
  '.docker/config.json',
  '.dockercfg',
  '.s3cfg',
  'application_default_credentials.json',
  '.mcpregistry_*_token',
  '.git/config',
  '.git/modules/**/config',
  '.yarnrc.yml',
  '.config/gh/hosts.yml',
  '.azure/**',
  '.config/gcloud/**',
  '*.tfstate',
  '*.tfstate.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.crt',
  '*.cer',
  '*.ppk',
  '*.jks',
  '*.keystore',
  '*.p8',
  '*id_rsa*',
  '*id_dsa*',
  '*id_ecdsa*',
  '*id_ed25519*',
] as const;

// Built-ins and operator-supplied deny entries live in separate tiers because
// they answer to different relief switches: an allow entry (FS_ALLOWLIST /
// --allow) can lift a built-in hit, but never an explicit deny.

// Split an env pattern list on commas and newlines at brace depth 0 only and
// outside any [...] class, so documented syntax like '*.{pem,key}' or
// 'x[1,2].env' survives as one pattern instead of tearing apart.
function splitPatternList(value: string): string[] {
  const naive = (): string[] =>
    value
      .split(/,|\n/u)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let unbalanced = false;
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
    else if (char === '}') {
      if (depth === 0) unbalanced = true;
      else depth--;
    } else if (depth === 0 && (char === ',' || char === '\n')) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  // An unbalanced brace would swallow every separator behind it into one
  // bogus literal pattern and silently drop the real entries — '{bad,
  // secrets/**' must not lose 'secrets/**'. A typo'd brace costs the brace
  // pattern only: fall back to the naive split.
  if (unbalanced || depth !== 0) return naive();
  parts.push(value.slice(start));
  return parts.map((t) => t.trim()).filter((t) => t.length > 0);
}

function buildDenyTiers(): { builtin: readonly string[]; operator: readonly string[] } {
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

/** The three pattern tiers as configured, for `--print-config`. Read-only view; the matcher compiles its own. */
export function describeSensitivePolicy(): {
  allowSensitive: boolean;
  builtinDeny: readonly string[];
  operatorDeny: readonly string[];
  allow: readonly string[];
} {
  const tiers = buildDenyTiers();
  return {
    allowSensitive: tiers.builtin.length === 0,
    builtinDeny: tiers.builtin,
    operatorDeny: tiers.operator,
    allow: buildAllowPatterns(),
  };
}

const EMPTY_PATTERN_SET: CompiledPatternSet = toPatternSet([]);

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
    const rawPath = normalizeForMatch(pathToCheck);
    const foldedPath = foldForMatch(rawPath);
    const rawName = posix.basename(rawPath);
    const foldedName = posix.basename(foldedPath);
    const inForm = (globs: GlobSet, path: string, name: string): boolean =>
      matchesAnyGlob(globs.pathGlobs, path) || matchesAnyGlob(globs.nameGlobs, name);
    // Each form on its own: the raw form keeps every match a pattern had
    // before folding, and the folded form adds the other Unicode spellings.
    const hits = (set: CompiledPatternSet): { raw: boolean; folded: boolean } => {
      const raw = inForm(set.raw, rawPath, rawName);
      const folded =
        set.foldInvariant && foldedPath === rawPath
          ? raw
          : inForm(set.folded, foldedPath, foldedName);
      return { raw, folded };
    };

    // Explicit deny entries (FS_DENYLIST/--deny) always apply.
    const operator = hits(this.operator);
    if (operator.raw || operator.folded) return true;
    const builtin = hits(this.builtin);
    if (!builtin.raw && !builtin.folded) return false;
    // A built-in hit is lifted only by an allow entry that matches the same
    // normalized candidate as typed — a pattern that matches nothing relieves
    // nothing. Folding never widens what --allow relieves, and never revokes
    // a spelling it already relieved.
    return !inForm(this.allow.raw, rawPath, rawName);
  }
}
