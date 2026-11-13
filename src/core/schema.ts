import { matchesGlob, win32 } from 'node:path';

import * as z from 'zod/v4';

import { IS_WINDOWS, toPosixPath } from './path-utils.ts';
import { MAX_SEARCH_DEPTH } from './util.ts';

// ─── Glob syntax guard (ADR-016: schema owns it, glob.ts stays internal to Scan) ───

/**
 * More brace alternatives than this is not a file filter. fs.glob's matcher
 * dedupes its alternatives pairwise, synchronously: `{1..100000}` pins the
 * event loop for most of a minute, where 1024 costs tens of milliseconds.
 */
const MAX_BRACE_ALTERNATIVES = 1024;

/** Bound synchronous glob compilation when checking candidate traversal segments. */
const MAX_DOTDOT_CHECK_CHARS = 4096;

/**
 * fs.glob tests each name against a regex compiled from the segment,
 * synchronously. Every run of `*` and every extglob group (`?(`, `+(`, `@(`,
 * `!(`, `*(`) adds a degree of backtracking: on a 255-character name three cost
 * under 100 ms, four about 1 s, and five do not finish; a chain of `?(a|aa)`
 * groups grows the same way.
 */
const MAX_SEGMENT_WILDCARDS = 3;

/** Brace range bodies (`x..y`, `x..y..step`); `foldPatternCase` in glob.ts keeps them as written. */
// The range bodies fs.glob's brace expansion recognises, as it writes them.
export const NUMERIC_RANGE_RE = /^-?\d+\.\.-?\d+(?:\.\.-?\d+)?$/u;
export const ALPHA_RANGE_RE = /^[a-zA-Z]\.\.[a-zA-Z](?:\.\.-?\d+)?$/u;

/** The values a range body (`x..y`, `x..y..step`) expands to, or `undefined` past the cap. */
function rangeValues(body: string): string[] | undefined {
  const alpha = ALPHA_RANGE_RE.test(body);
  const [from = '', to = '', step = '1'] = body.split('..');
  const bound = (end: string): number => (alpha ? end.charCodeAt(0) : Number.parseInt(end, 10));
  const start = bound(from);
  const stop = bound(to);
  const stride = Math.max(Math.abs(Number.parseInt(step, 10)), 1);
  // Past 2^53 a step no longer moves the number (2^53 + 1 === 2^53), and past
  // Number.MAX_VALUE it reads as Infinity: either way the loop below would
  // never end. Refuse them like any other long range.
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stop)) return undefined;
  if (Math.floor(Math.abs(stop - start) / stride) >= MAX_BRACE_ALTERNATIVES) return undefined;
  const values: string[] = [];
  const direction = stop < start ? -1 : 1;
  for (let i = start; (stop - i) * direction >= 0; i += stride * direction) {
    // The engine drops a `\` a letter range passes through (`{Z..a}`), and
    // digits can never spell a root or a `..`, so their padding is moot.
    const char = String.fromCharCode(i);
    values.push(alpha ? (char === '\\' ? '' : char) : String(i));
  }
  return values;
}

interface BraceSet {
  pre: string;
  /** `undefined` when the set alone expands past the cap. */
  alternatives: string[] | undefined;
  post: string;
}

/**
 * The leftmost `{…}` that fs.glob would expand: a comma list or a range.
 * The expansion is textual, as fs.glob's is: a brace inside `[…]` still
 * counts (unlike SensitiveMatcher's own glob dialect in sensitive.ts).
 */
function firstBraceSet(pattern: string): BraceSet | undefined {
  const open: { at: number; commas: number[] }[] = [];
  let first: { at: number; commas: number[]; close: number } | undefined;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '{') open.push({ at: i, commas: [] });
    else if (char === ',') open.at(-1)?.commas.push(i);
    else if (char === '}') {
      const set = open.pop();
      if (!set || (first && first.at < set.at)) continue;
      const body = pattern.slice(set.at + 1, i);
      if (set.commas.length > 0 || NUMERIC_RANGE_RE.test(body) || ALPHA_RANGE_RE.test(body)) {
        first = { ...set, close: i };
      }
    }
  }
  if (!first) return undefined;
  let alternatives: string[] | undefined;
  if (first.commas.length > 0) {
    alternatives = [];
    let start = first.at + 1;
    for (const end of [...first.commas, first.close]) {
      alternatives.push(pattern.slice(start, end));
      start = end + 1;
    }
  } else {
    alternatives = rangeValues(pattern.slice(first.at + 1, first.close));
  }
  return { pre: pattern.slice(0, first.at), alternatives, post: pattern.slice(first.close + 1) };
}

/** Every brace alternative of `pattern`, or `undefined` past the cap. */
function expandBraceSets(pattern: string, out: string[] = []): string[] | undefined {
  const set = firstBraceSet(pattern);
  if (!set) {
    out.push(pattern);
    return out.length > MAX_BRACE_ALTERNATIVES ? undefined : out;
  }
  if (!set.alternatives) return undefined;
  for (const alternative of set.alternatives) {
    if (!expandBraceSets(`${set.pre}${alternative}${set.post}`, out)) return undefined;
  }
  return out;
}

/** The characters minimatch can spell a literal `..` with: dots and one-character classes. */
const DOTDOT_SPELLING_RE = /^[.[\]-]+$/u;

/**
 * Whether the glob engine reads this brace-free segment as `..`. readdir never
 * yields `..`, so only a literal reaches it, and minimatch spells a literal dot
 * as `.`, `[.]` or `[.-.]`. Any other character (`*`, `?`, an extglob, a
 * letter) either makes the segment a pattern the walk never follows to `..`,
 * or puts that character in the name. Only the rest is worth asking the engine
 * about, so a long or exotic segment costs no compile; one the engine cannot
 * compile is refused.
 */
const isTraversalSegment = (segment: string): boolean => {
  try {
    return matchesGlob('..', segment);
  } catch {
    return true;
  }
};

/**
 * An alternative that starts at a root: `/x`, `//host/share`, `C:/x`, `C:x`,
 * on any host. On Windows fs.glob also reads a literal first segment ending in
 * `:` as a drive (`[C]:/x`); elsewhere that is an ordinary name (`logs:`).
 */
const isRooted = (alternative: string): boolean =>
  win32.parse(alternative).root !== '' ||
  (IS_WINDOWS && (alternative.split('/')[0] ?? '').endsWith(':'));

/**
 * Index of the `)` that closes the group opened at `open`, or -1. A `[...]`
 * class is skipped whole: a `)` or `|` inside one is a literal, not syntax.
 */
function groupClose(segment: string, open: number): number {
  let depth = 0;
  for (let i = open; i < segment.length; i++) {
    const c = segment[i];
    if (c === '[') {
      // A `]` first in the class (or after `!`/`^`) is literal, so search past it.
      const first = segment[i + 1] === '!' || segment[i + 1] === '^' ? i + 2 : i + 1;
      const end = segment.indexOf(']', first + 1);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Whether matching this brace-free segment can backtrack for seconds on one
 * long name. Two shapes do: a repeated group (`*(…)`, `+(…)`) whose body can
 * match more than one way (`|`, `*`, or a nested group), and more than
 * MAX_SEGMENT_WILDCARDS `*` runs and extglob groups together.
 */
function canBacktrack(segment: string): boolean {
  if (segment === '**') return false;
  let wildcards = (segment.match(/\*+/gu) ?? []).length;
  for (let i = segment.indexOf('('); i !== -1; i = segment.indexOf('(', i + 1)) {
    const opener = segment[i - 1];
    if (opener === undefined || !'*+?@!'.includes(opener)) continue;
    // Each group can match more than one way, so it adds a degree of
    // backtracking like a `*` run does (`*(` is already counted as one).
    if (opener !== '*') wildcards++;
    if (opener !== '*' && opener !== '+') continue;
    const close = groupClose(segment, i);
    // Classes are literals: only `|`, `*` or a group outside one can backtrack.
    const body = segment
      .slice(i + 1, close === -1 ? undefined : close)
      .replace(/\[[!^]?\]?[^\]]*\]/gu, '');
    if (/[|*(]/u.test(body)) return true;
  }
  return wildcards > MAX_SEGMENT_WILDCARDS;
}

export function isSafeGlobSyntax(pattern: string): boolean {
  if (!pattern || pattern.trim().length === 0) {
    return false;
  }
  // The walk sees the pattern with `\` as `/` (normalizePattern), so check
  // that form: `\etc\x` is `/etc/x` there, an absolute walk on any host.
  // Brace sets can build a root or a `..` from parts (`{/etc,x}`, `..{,x}`,
  // `.{Z..a}.`), so check every alternative, not the pattern as written.
  // globEntries still drops any match outside its cwd: this check is what
  // turns such a pattern into an error rather than a quietly narrower walk.
  const alternatives = expandBraceSets(toPosixPath(pattern));
  if (!alternatives) return false;
  const segments = new Set<string>();
  for (const alternative of alternatives) {
    if (isRooted(alternative)) return false;
    for (const segment of alternative.split('/')) segments.add(segment);
  }
  let dotdotCheckChars = 0;
  for (const segment of segments) {
    if (canBacktrack(segment)) return false;
    if (!segment.includes('.') || !DOTDOT_SPELLING_RE.test(segment)) continue;
    dotdotCheckChars += segment.length;
    if (dotdotCheckChars > MAX_DOTDOT_CHECK_CHARS || isTraversalSegment(segment)) return false;
  }
  return true;
}

// ─── Schemas ───

export const PositiveInt = z
  .int({ message: 'Must be integer' })
  .positive({ message: 'Must be > 0' });

const MAX_PATH_LENGTH = 4096;

const LINE_BREAK_RE = /[\n\r]/;

const isBlank = (val: string): boolean => val.trim().length === 0;

/**
 * Text that must carry non-blank content. `min(1)` stays so `minLength: 1`
 * still publishes on the wire; it aborts so an empty value reports one
 * message, not the same one twice.
 */
export function nonBlankString(label: string): z.ZodString {
  const message = `${label} cannot be empty or whitespace-only`;
  return z
    .string()
    .min(1, { message, abort: true })
    .refine((val) => !isBlank(val), { message });
}

function refineSafeText(
  label: string,
  specific: (val: string) => string | undefined,
): (val: string, ctx: z.RefinementCtx) => void {
  return (val, ctx) => {
    if (val.length === 0) return;
    const issue = isBlank(val)
      ? `${label} cannot be empty or whitespace-only`
      : val.includes('\0')
        ? `${label} cannot contain null bytes`
        : (specific(val) ??
          (LINE_BREAK_RE.test(val) ? `${label} cannot contain line breaks` : undefined));
    if (issue !== undefined) {
      ctx.addIssue({ code: 'custom', message: issue, fatal: true });
    }
  };
}

// Only a whole `..` segment is traversal. `..` inside a segment
// (`[...slug]`, `v1..2.md`) is a plain file name; PathGuard re-checks
// containment on the resolved path regardless.
const hasTraversalSegment = (val: string): boolean => val.split(/[\\/]/u).includes('..');

export const RequiredPath = z
  .string()
  .min(1, { message: 'Path required' })
  .max(MAX_PATH_LENGTH, { message: `Path too long (max ${MAX_PATH_LENGTH} chars)` })
  .superRefine(
    refineSafeText('Path', (val) =>
      hasTraversalSegment(val) ? 'Path cannot contain ".." segments' : undefined,
    ),
  )
  .describe('File or directory path inside an allowed workspace root.');

export const OptionalPath = RequiredPath.optional();

export const SafeGlobPattern = z
  .string()
  .min(1, { message: 'Pattern required' })
  .max(1000, { message: 'Max 1000 chars' })
  .superRefine(
    refineSafeText('Pattern', (val) =>
      isSafeGlobSyntax(val)
        ? undefined
        : `Invalid glob or unsafe path. Absolute paths and .. are not allowed. Limits: ${String(MAX_BRACE_ALTERNATIVES)} brace alternatives, ${String(MAX_DOTDOT_CHECK_CHARS)} traversal-check characters, and ${String(MAX_SEGMENT_WILDCARDS)} * runs and extglob groups combined per path segment. No |, * or nested group inside *(…) or +(…).`,
    ),
  )
  .describe('Relative glob pattern under the search root (e.g. "**/*.ts", "src/**/*.js").')
  .meta({ examples: ['**/*.ts', 'src/**/*.js', '**/*.{ts,tsx}'] });

/** The line-range args of a read; `validateReadRange` checks how they combine. */
export interface ReadRange {
  head?: number | undefined;
  tail?: number | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
}

export function validateReadRange(value: ReadRange, ctx: z.RefinementCtx): void {
  const hasHead = value.head !== undefined;
  const hasTail = value.tail !== undefined;
  const hasStart = value.startLine !== undefined;
  const hasEnd = value.endLine !== undefined;

  if (hasHead && (hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['head'],
      message:
        "Cannot use 'head' with 'startLine'/'endLine'. Use either 'head' alone or 'startLine'/'endLine' together.",
      input: value,
    });
  }
  if (hasTail && (hasHead || hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['tail'],
      message:
        "Cannot use 'tail' with 'head'/'startLine'/'endLine'. Use 'tail' alone, or 'startLine'/'endLine' without 'tail'.",
      input: value,
    });
  }
  if (hasEnd && !hasStart) {
    ctx.addIssue({
      code: 'custom',
      path: ['endLine'],
      message: "'endLine' requires 'startLine' to be set. Provide both together.",
      input: value,
    });
  }
  const effectiveStart = value.startLine ?? 1;
  if (value.endLine !== undefined && value.endLine < effectiveStart) {
    ctx.addIssue({
      code: 'custom',
      path: ['endLine'],
      message: "'endLine' must be >= 'startLine'",
      input: value,
    });
  }
}

export function defaultFalseBoolean(description: string): z.ZodDefault<z.ZodBoolean> {
  return z.boolean().default(false).describe(description);
}

export const IncludeHidden = defaultFalseBoolean('Include hidden items (starting with .)');
export const IncludeIgnored = defaultFalseBoolean(
  'Include ignored items (node_modules, .git, etc).',
);
export const MaxDepth = z
  .uint32()
  .min(0)
  .max(MAX_SEARCH_DEPTH)
  .optional()
  .describe('Max directory depth. 0 scans only the base directory. Omit for no limit.');

const DEFAULT_MAX_BATCH = 1000;

export type SingleOrBatchShape<TExtra extends z.ZodRawShape> = TExtra & {
  path: z.ZodOptional<typeof RequiredPath>;
  paths: z.ZodOptional<z.ZodArray<typeof RequiredPath>>;
};

export function singleOrBatchPathsInput<TExtra extends z.ZodRawShape>(
  extra: TExtra,
): z.ZodObject<SingleOrBatchShape<TExtra>> {
  const shape: z.ZodRawShape = {
    ...extra,
    path: RequiredPath.optional().describe('Single file path; mutually exclusive with paths'),
    paths: z
      .array(RequiredPath)
      .min(1)
      .max(DEFAULT_MAX_BATCH)
      .optional()
      .describe(
        `Array of file paths for batch mode (max ${String(DEFAULT_MAX_BATCH)}); mutually exclusive with path`,
      ),
  };

  const base = z.strictObject(shape).superRefine((value, ctx) => {
    const hasPath = value['path'] !== undefined;
    const hasPaths = value['paths'] !== undefined;

    if (!hasPath && !hasPaths) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: "Either 'path' or 'paths' must be provided",
        input: value,
      });
      return;
    }
    if (hasPath && hasPaths) {
      ctx.addIssue({
        code: 'custom',
        path: ['paths'],
        message: "Cannot use both 'path' and 'paths'",
        input: value,
      });
    }
  });

  // No top-level oneOf on the wire: OpenAI and Anthropic reject top-level
  // oneOf/anyOf/allOf in function parameters. The superRefine enforces
  // "exactly one of path/paths" at call time.
  return base as z.ZodObject<SingleOrBatchShape<TExtra>>;
}

/**
 * `ToolDef.mapPaths` for a {@link singleOrBatchPathsInput} shape
 * (`{ path?, paths?, files?[{path}] }`). The schema's superRefine lets exactly
 * one of the three through; each present one is mapped.
 */
export function mapSingleOrBatchPaths<
  T extends {
    path?: string | undefined;
    paths?: string[] | undefined;
    files?: readonly { path: string }[] | undefined;
  },
>(args: T, fn: (path: string) => string): T {
  return {
    ...args,
    ...(args.path !== undefined ? { path: fn(args.path) } : {}),
    ...(args.paths !== undefined ? { paths: args.paths.map(fn) } : {}),
    ...(args.files !== undefined
      ? { files: args.files.map((file) => ({ ...file, path: fn(file.path) })) }
      : {}),
  };
}

/** `ToolDef.mapPaths` for a tool whose one `path` is optional (omitted = the root). */
export function mapOptionalPath<T extends { path?: string | undefined }>(
  args: T,
  fn: (path: string) => string,
): T {
  return args.path === undefined ? args : { ...args, path: fn(args.path) };
}

// ponytail: charset regex, not z.base64url() — the SDK's AJV warns on the
// unknown `base64url` format; the server's own decode (cursor.ts) is the real
// validation, so loosening the client-facing schema to the alphabet is safe.
// Revisit if the SDK's AJV registers `base64url`: z.base64url() then fits.
const base64urlCursor = z.string().regex(/^[A-Za-z0-9_-]+$/);

// Ships once per paginated tool — wording is budgeted (TOOL-SURFACE-002).
export const CursorSchema = base64urlCursor
  .optional()
  .describe(
    'Opaque pagination cursor. Pass it unchanged for the next page. Pages come from one snapshot ' +
      'taken on the first call. It expires after ~60s; if rejected, retry without a cursor.',
  );

/**
 * Reassembles tool arguments that a client JSON-serialized and then spread
 * into an object: `{ path }` arrives as `{ "0": "{", "1": "\"", … }`, one key
 * per UTF-16 code unit. Returns `undefined` for anything else. Integer keys
 * enumerate first in ascending order, so matching each key to its position
 * also proves the keys are exactly `"0"…"n-1"` with nothing else alongside.
 */
function joinSplitString(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  let text = '';
  for (const [index, [key, char]] of entries.entries()) {
    if (key !== String(index) || typeof char !== 'string' || char.length !== 1) return undefined;
    text += char;
  }
  return text;
}

/**
 * Wraps a tool's input schema so a stringified-then-spread payload (see
 * {@link joinSplitString}) is parsed back into the object it encodes, and one
 * that does not encode an object fails with a message naming the cause rather
 * than `Unrecognized keys: "0", "1", …`. The published JSON Schema is the
 * wrapped schema's own: a preprocess step converts to its output side.
 */
export function withSplitArgsRecovery<T extends z.ZodType>(schema: T): z.ZodPreprocess<T> {
  return z.preprocess((value, ctx) => {
    const text = joinSplitString(value);
    if (text === undefined) return value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
    ctx.addIssue({
      code: 'custom',
      message:
        `arguments must be a JSON object, but arrived as a ${String(text.length)}-character ` +
        'string split into indexed keys. The client serialized the payload. Send the arguments as an object.',
      input: value,
    });
    return z.NEVER;
  }, schema);
}
