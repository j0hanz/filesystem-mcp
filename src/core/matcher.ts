/**
 * The Match plan and the MatchEngine (see GLOSSARY.md): what a search or a
 * replacement settles about its needle before any text is read, and the one
 * engine that finds its matches in a Text view. One module owns the native
 * literal pass with its per-text RE2 bails and the RE2 plumbing; search_text
 * and replace_text drive the same engine, so a preview judges exactly what
 * its replacement will touch.
 */
import type { RE2ExecArray } from '@adguard/re2-wasm';
import { RE2 } from '@adguard/re2-wasm';

import { ErrorCode, FsError } from './errors.ts';
import { prefilterBytes, type TextView } from './text-view.ts';
import { escapeRegExp, MIB } from './util.ts';

export type Regex = RE2;
/** Occurrence-counting bound, so one pathological line cannot spin forever. */
export const MAX_MATCHES_PER_LINE = 100_000;
/**
 * re2-wasm copies the whole input on every exec, so draining a dense pattern is
 * O(matches x input) and fully synchronous: the loop pins and the tool's
 * AbortSignal.timeout (a timer) can never fire. The returned `tick` yields a
 * macrotask every ~10ms and reports whether `signal` has aborted.
 */
export function createYielder(signal: AbortSignal | undefined): () => Promise<boolean> {
  let last = Date.now();
  return async () => {
    if (Date.now() - last > 10) {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      last = Date.now();
    }
    return signal?.aborted ?? false;
  };
}
/**
 * Largest input one RE2 call may scan as a single string. The input is copied
 * into the same fixed 16 MB wasm heap as the patterns; about 10 MB of input
 * aborts the module. 4 MiB leaves room for the copy and the pattern set.
 */
export const RE2_MAX_INPUT_BYTES = 4 * MIB;
/**
 * A literal needle matched in native code, as RE2 would match it. RE2 copies
 * its whole input into the wasm heap on every call, and for a literal that
 * copy is most of what a search costs. The MatchEngine runs this native pass
 * once over the whole text, and RE2 only for a text `needsRe2` flags.
 */
interface LiteralMatcher {
  /** True when this file holds a character RE2 folds onto one of the needle's letters. */
  needsRe2(input: Buffer | string): boolean;
  /** False only when the raw bytes cannot hold a match. */
  mayMatch(buffer: Buffer): boolean;
  /** True when the needle holds no CR or LF, so a CRLF view cannot hide a match from `mayMatch`. */
  readonly lineBreakFree: boolean;
}
/** The only non-ASCII characters RE2's case folding maps onto ASCII letters. */
const KELVIN_SIGN = '\u212A'; // folds onto k
const LONG_S = '\u017F'; // folds onto s
const ASCII_UPPER_RE = /[A-Z]+/gu;
/** Folds A-Z only, so every UTF-16 offset in the result matches the input. */
function foldAsciiCase(text: string): string {
  // String#toLowerCase turns U+0130 into two code units, which shifts every
  // later column and spells an `i` RE2 does not match.
  return text.replace(ASCII_UPPER_RE, (upper) => upper.toLowerCase());
}
const LITERAL_PREFILTER_CHUNK_SIZE = 64 * 1024;

export function asciiBufferMayMatch(buffer: Buffer, lowerNeedle: string): boolean {
  if (
    buffer.length <= LITERAL_PREFILTER_CHUNK_SIZE ||
    lowerNeedle.length >= LITERAL_PREFILTER_CHUNK_SIZE
  ) {
    return buffer.toString('latin1').toLowerCase().includes(lowerNeedle);
  }
  const overlap = lowerNeedle.length - 1;
  const step = LITERAL_PREFILTER_CHUNK_SIZE - overlap;
  for (let offset = 0; offset < buffer.length; offset += step) {
    const end = Math.min(offset + LITERAL_PREFILTER_CHUNK_SIZE, buffer.length);
    const chunk = buffer.subarray(offset, end).toString('latin1').toLowerCase();
    if (chunk.includes(lowerNeedle)) return true;
    if (end === buffer.length) break;
  }
  return false;
}

/** `undefined` when RE2 must judge the needle: these shortcuts are exact only for the needles they take. */
function createLiteralMatcher(needle: string, caseSensitive: boolean): LiteralMatcher | undefined {
  // The file is decoded with U+FFFD for every invalid byte, and a lone
  // surrogate reaches RE2 as U+FFFD, so a needle holding either can match
  // decoded text that the raw bytes, or indexOf, do not.
  if (needle.includes('\uFFFD') || Buffer.from(needle, 'utf8').toString('utf8') !== needle) {
    return undefined;
  }
  const lineBreakFree = !/[\r\n]/u.test(needle);
  if (caseSensitive) {
    const bytes = Buffer.from(needle, 'utf8');
    return {
      lineBreakFree,
      needsRe2: () => false,
      mayMatch: (buffer) => buffer.includes(bytes),
    };
  }
  // Every non-ASCII character takes more than one UTF-8 byte per UTF-16 unit.
  if (Buffer.byteLength(needle, 'utf8') !== needle.length) return undefined;
  const lower = needle.toLowerCase();
  const folds = [
    ...(lower.includes('k') ? [KELVIN_SIGN] : []),
    ...(lower.includes('s') ? [LONG_S] : []),
  ];
  return {
    lineBreakFree,
    needsRe2: (input) => folds.some((fold) => input.includes(fold)),
    // Latin-1 decoding keeps one char per byte, and lowercasing it maps A-Z
    // onto a-z and every other byte onto a non-ASCII char, so an ASCII needle
    // is found exactly where the bytes spell it in either case.
    mayMatch: (buffer) => asciiBufferMayMatch(buffer, lower),
  };
}

/** True for the abort re2-wasm raises when its fixed heap is exhausted. */
export function isRe2Abort(error: unknown): boolean {
  return (
    error instanceof Error && error.name === 'RuntimeError' && error.message.startsWith('Aborted(')
  );
}

/** The refusal a heap-exhausting call gets. An abort leaks heap, so it warns about what follows. */
export function re2AbortError(path: string | undefined, cause: unknown): FsError {
  return new FsError(
    ErrorCode.TOO_LARGE,
    'The regex engine ran out of its fixed 16 MB of memory. Regex search can keep failing on smaller inputs until the server restarts.',
    path,
    cause,
    'Restart the server.',
  );
}

/**
 * Compile a pattern on RE2 rather than on V8's irregexp.
 *
 * Patterns arrive from the MCP client, so a backtracking engine would let one
 * request pin the event loop with no way out: an abort signal cannot preempt a
 * synchronous `exec`, and on stdio that wedges the whole server. RE2 matches in
 * time linear in the input and cannot backtrack at all, so the hazard is gone
 * rather than bounded.
 *
 * RE2 rejects the constructs the tool schema documents as unsupported —
 * lookahead, lookbehind, backreferences — with its own {@link SyntaxError},
 * which the tool layer turns into a normal tool error. It always matches in
 * Unicode mode and requires the `u` flag to say so.
 *
 * Every compiled pattern owns memory in re2-wasm's fixed 16 MB heap, which
 * `ALLOW_MEMORY_GROWTH` is off for. re2-wasm never frees it and a
 * FinalizationRegistry does not keep up (V8 sees no pressure from the wasm
 * heap), so exhaustion is an emscripten `abort()`. An abort leaks heap: each one
 * shrinks the largest input the engine can take, until regex search fails on
 * small files too. Only a restart restores it. Every caller MUST pass the
 * result to {@link freeRegex} when it is done with it.
 */
export function compileRegex(
  pattern: string,
  options: { caseSensitive?: boolean; multiline?: boolean } = {},
): Regex {
  const flags = `g${options.multiline ? 'm' : ''}${options.caseSensitive ? '' : 'i'}u`;
  try {
    return new RE2(pattern, flags);
  } catch (error) {
    if (isRe2Abort(error)) throw re2AbortError(undefined, error);
    if (!(error instanceof SyntaxError)) throw error;
    throw new SyntaxError(
      `${error.message} — lookahead, lookbehind, and backreferences are not supported.`,
      { cause: error },
    );
  }
}

/**
 * Release a compiled pattern's wasm memory. re2-wasm exposes no disposal of its
 * own, so this reaches the embind handle it holds privately; a version that
 * renames the field degrades to the pre-existing leak rather than throwing.
 * Idempotent — a second call on an already-freed handle is swallowed. Using a
 * {@link Regex} after freeing it is undefined behaviour in the wasm heap, so
 * free only in a `finally` that owns the compile.
 */
export function freeRegex(regex: Regex | undefined): void {
  const handle = (regex as unknown as { wrapper?: { delete?: () => void } } | undefined)?.wrapper;
  try {
    handle?.delete?.();
  } catch {
    // already deleted, or a re2-wasm build without embind disposal
  }
}

interface RegexMatch {
  /** The matched text. */
  text: string;
  /** Capture groups, 1-indexed in the pattern, 0-indexed here. */
  groups: (string | undefined)[];
  /** Named capture groups, when the pattern declares any. */
  named: Record<string, string> | undefined;
  /** Start offset in UTF-16 code units — usable with `String.prototype.slice`. */
  start: number;
  /** End offset in UTF-16 code units. */
  end: number;
}

/** Code-point length of `text`, i.e. its UTF-16 length minus its surrogate pairs. */
const codePointLength = (text: string): number =>
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code points are the intended unit (re2-wasm offsets count code points); grapheme segmentation would change the count, not preserve it.
  [...text].length;
/**
 * Iterate a global pattern's non-overlapping matches with offsets JS can use.
 *
 * re2-wasm reports `index` and `lastIndex` in **code points**, while every JS
 * string operation indexes in UTF-16 code units. The two agree only until the
 * first astral character (most emoji), past which every offset is short by one
 * per surrogate pair — slicing on the raw index cuts into the middle of
 * neighbouring text. Its `lastIndex` bookkeeping is worse still: it adds the
 * match's UTF-16 length to a code-point index, so an astral character inside a
 * match can skip the next one. This is the single place that corrects both; no
 * caller should read `match.index` or `regex.lastIndex` directly.
 *
 * Zero-length matches (e.g. `a*`) advance by one code point so they cannot loop
 * forever. The regex is global and shared across calls, so `lastIndex` is reset
 * on entry.
 *
 * With `keepLast`, the final capture group is a lookahead-like tail: its text is
 * not consumed, so the next search starts at its first code point. When the
 * consumed text ends in a character `backUpOver` (a `$`-anchored pattern)
 * matches, the next search starts on that character instead, so it can lead the
 * next match. A resume point never moves back to or before the current search start.
 *
 * `skipTo`, read after each yield, may give a UTF-16 offset to resume from
 * instead, never before the match's end; past the text's end, the walk stops.
 */
function* execMatches(
  regex: Regex,
  text: string,
  keepLast = false,
  backUpOver?: RegExp,
  skipTo?: () => number | undefined,
): Generator<RegexMatch, undefined> {
  regex.lastIndex = 0;
  // Cursor into `text`, carried forward across matches: RE2 reports them in
  // ascending order, so the walk is O(text) in total rather than per match.
  let cursorCp = 0;
  let cursorU16 = 0;
  const advance = (): void => {
    const isPair =
      (text.charCodeAt(cursorU16) & 0xfc00) === 0xd800 &&
      (text.charCodeAt(cursorU16 + 1) & 0xfc00) === 0xdc00;
    cursorU16 += isPair ? 2 : 1;
    cursorCp++;
  };
  // Code-point offset the current search started from.
  let from = 0;
  let match: RE2ExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    while (cursorCp < match.index && cursorU16 < text.length) advance();
    const matched = match[0] ?? '';
    const start = cursorU16;
    yield {
      text: matched,
      groups: match.slice(1),
      named: match.groups,
      start,
      end: start + matched.length,
    };
    // Own the advance rather than trusting the wrapper's mixed-unit arithmetic.
    const tail = keepLast && match.length > 1 ? (match[match.length - 1] ?? '') : '';
    const consumed = matched.slice(0, matched.length - tail.length);
    const step = codePointLength(matched) - codePointLength(tail);
    let next = match.index + (step > 0 ? step : 1);
    // Backing up onto the search start would find the same match again.
    if (keepLast && backUpOver && consumed !== '' && backUpOver.test(consumed) && next - 1 > from) {
      next -= 1;
    }
    const skip = skipTo?.();
    if (skip !== undefined) {
      if (skip > text.length) return;
      while (cursorU16 < skip) advance();
      if (cursorCp > next) next = cursorCp;
    }
    regex.lastIndex = next;
    from = next;
  }
}

// RE2's \b is ASCII-only, so wholeWord spells out the Unicode word class.
const WORD_CLASS = String.raw`\p{L}\p{N}\p{M}_`;

/** The settled judgment: the literal pass a needle allows, and its RE2 source. */
export interface MatchPlan {
  /** Native literal pass; undefined when RE2 must judge the needle itself. */
  readonly literal: LiteralMatcher | undefined;
  /** RE2 source: the needle as given, escaped when literal, wrapped for wholeWord when asked. */
  readonly source: string;
}

export function planMatch(
  needle: string,
  flags: { isRegex: boolean; caseSensitive: boolean; wholeWord?: boolean },
): MatchPlan {
  const literal = flags.isRegex ? undefined : createLiteralMatcher(needle, flags.caseSensitive);
  const pattern = flags.isRegex ? needle : escapeRegExp(needle);
  // The trailing boundary is part of the pattern, so RE2 picks the alternative that passes it.
  const source = flags.wholeWord ? `([^${WORD_CLASS}])(?:${pattern})([^${WORD_CLASS}]|$)` : pattern;
  return { literal, source };
}

/** `(?i)`, `(?-m)`, `(?s:…)`: inline flags can change what `.`, `^` and `$` match. */
const INLINE_FLAGS_RE = /\(\?[a-zA-Z-]+[:)]/u;
// A backslash escape other than these may name a line break (\n, \s, \W, \x0a, \012, ...).
const UNSAFE_ESCAPE_RE = /\\(?![dwbBSt]|[^a-zA-Z0-9])/u;

/** False only when no match of the regex `source` can hold a line break. */
function regexCrossesLines(source: string): boolean {
  return (
    // A raw control char (\n, \r, or a range start like [<U+0001>-~]), or a range from
    // \t or \b (backspace in a class): the only range starts low enough to span U+000A.
    // eslint-disable-next-line no-control-regex -- a control character is exactly what is looked for
    /[\u0000-\u001f]|\\[tb]-/u.test(source) ||
    source.includes('[^') ||
    source.includes('[:') ||
    INLINE_FLAGS_RE.test(source) ||
    UNSAFE_ESCAPE_RE.test(source)
  );
}

export interface TextMatch {
  /** UTF-16 offsets into the text given to `matches`. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly groups: (string | undefined)[];
  readonly named: Record<string, string> | undefined;
  /** Groups whose line endings cannot be determined in a mixed-ending file. */
  readonly ambiguousGroups?: ReadonlySet<string | number>;
}

export interface MatchEngine {
  /** Whether the needle may match a line break. */
  readonly crossesLines: boolean;
  /** Compiles a regex plan now, so an invalid pattern throws before any text is read. No-op for a literal. */
  compile(): void;
  /** Pass to `prefilterBytes` as `crSafe`: a CR in the bytes cannot hide a match from `mayMatch`. */
  readonly lineBreakFree: boolean;
  /** False only when these bytes cannot hold a match. Handles BOM and line breaks internally. */
  mayMatch(bytes: Buffer): boolean;
  /**
   * Every match in view text, left to right, never overlapping. Yields to the
   * event loop and throws the signal's reason on abort. Throws TOO_LARGE by
   * the 4 MiB rule; `path` labels that error. After `maxPerLine` matches start
   * on one line, the walk skips to the next line.
   */
  matches(
    view: TextView | string,
    options?: { signal?: AbortSignal; path?: string; maxPerLine?: number },
  ): AsyncGenerator<TextMatch, void>;
  /**
   * Splice every match in view text, so a replacement touches exactly what a
   * search reports. Normalizes literal replacement CRLFs for CRLF views, and
   * verifies limits on restored output bytes.
   */
  replace(
    view: TextView | string,
    replacement: string,
    options?: {
      expand?: boolean;
      signal?: AbortSignal;
      limits?: ReplaceLimits;
    },
  ): Promise<{ content: string; matchCount: number; more: boolean }>;
  /** Releases every compiled pattern. Idempotent. */
  dispose(): void;
}

const LINE_TOO_LONG =
  'A line in this file is too long for the regex engine. It is used for isRegex, wholeWord, or a case-insensitive search for non-ASCII text (or a file holding U+212A or U+017F); pass caseSensitive: true with a literal searchPattern and no wholeWord.';

/** Whether `text` is over RE2's input bound; a UTF-16 unit is at most 3 UTF-8 bytes, so most texts skip the measure. */
const overRe2Bound = (text: string): boolean =>
  text.length * 3 > RE2_MAX_INPUT_BYTES && Buffer.byteLength(text, 'utf8') > RE2_MAX_INPUT_BYTES;

const DOLLAR_TOKEN = /\$(\$|&|`|'|<([^>]*)>|\d{1,2})/g;

export interface ReplaceLimits {
  maxMatches: number;
  maxBytes: number;
  path: string;
}

const OUTPUT_TOO_LARGE_SUGGESTION =
  "Narrow searchPattern or shorten the replacement; $` and $' insert the whole text before/after each match.";

function outputTooLarge(limits: ReplaceLimits, cause?: unknown): FsError {
  return new FsError(
    ErrorCode.TOO_LARGE,
    `Replacement result exceeds the size limit (more than ${String(limits.maxBytes)} bytes)`,
    limits.path,
    cause,
    OUTPUT_TOO_LARGE_SUGGESTION,
  );
}

function expandDollarTokens(
  template: string,
  match: string,
  groups: (string | undefined)[],
  offset: number,
  input: string,
  named: Record<string, string> | undefined,
  declared: ReadonlySet<string>,
): string {
  return template.replace(DOLLAR_TOKEN, (token: string, kind: string, name?: string) => {
    if (kind === '$') return '$';
    if (kind === '&') return match;
    if (kind === '`') return input.slice(0, offset);
    if (kind === "'") return input.slice(offset + match.length);
    if (name !== undefined) {
      if (named && Object.hasOwn(named, name)) return named[name] ?? '';
      return declared.has(name) ? '' : token;
    }
    const two = Number.parseInt(kind, 10);
    if (kind.length === 2 && two >= 1 && two <= groups.length) return groups[two - 1] ?? '';
    const one = Number.parseInt(kind.slice(0, 1), 10);
    if (one >= 1 && one <= groups.length) {
      return (groups[one - 1] ?? '') + (kind.length === 2 ? kind.slice(1) : '');
    }
    return token;
  });
}

function readsAmbiguousGroup(
  template: string,
  ambiguous: ReadonlySet<string | number>,
  groupsLength: number,
): boolean {
  for (const m of template.matchAll(DOLLAR_TOKEN)) {
    const kind = m[1] ?? '';
    const name = m[2];
    if (name !== undefined) {
      if (ambiguous.has(name)) return true;
      continue;
    }
    const two = Number.parseInt(kind, 10);
    if (kind.length === 2 && two >= 1 && two <= groupsLength && ambiguous.has(two)) {
      return true;
    }
    const one = Number.parseInt(kind.slice(0, 1), 10);
    if (one >= 1 && one <= groupsLength && ambiguous.has(one)) {
      return true;
    }
  }
  return false;
}

const NAMED_GROUP_PREFIX = /^\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/;

/**
 * Extract named capture group declarations from a regex source string.
 * Ignores escaped parentheses and capture lookalikes inside character classes.
 */
function extractDeclaredNamedGroups(source: string): Set<string> {
  const names = new Set<string>();
  let inClass = false;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      i++;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i++;
      continue;
    }
    if (ch === '(') {
      const rest = source.slice(i);
      const m = NAMED_GROUP_PREFIX.exec(rest);
      if (m?.[1]) {
        names.add(m[1]);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return names;
}

export function createMatchEngine(
  needle: string,
  flags: { isRegex: boolean; caseSensitive: boolean; wholeWord?: boolean },
): MatchEngine {
  const plan = planMatch(needle, flags);
  // The names the pattern declares. re2-wasm reports only the named groups
  // that took part in a match, so `$<name>` needs this to expand an idle one
  // to nothing, as `$1` does.
  const declared: ReadonlySet<string> = flags.isRegex
    ? extractDeclaredNamedGroups(plan.source)
    : new Set<string>();
  const wholeWord = Boolean(flags.wholeWord);
  const crossesLines = flags.isRegex ? regexCrossesLines(needle) : needle.includes('\n');
  const lineBreakFree = plan.literal?.lineBreakFree ?? true;
  const lfVariant: MatchEngine | undefined =
    !flags.isRegex && needle.includes('\r\n')
      ? createMatchEngine(needle.replaceAll('\r\n', '\n'), flags)
      : undefined;
  // planMatch only gives a case-insensitive literal plan for an ASCII needle.
  const folded = flags.caseSensitive ? needle : needle.toLowerCase();
  let regex: Regex | undefined;
  /** Line mode's whole-text "cannot match" test, compiled with `m`. */
  let prefilter: Regex | undefined;

  const compiled = (): Regex =>
    (regex ??= compileRegex(plan.source, {
      caseSensitive: flags.caseSensitive,
      // wholeWord scans behind a TEXT_START newline, so ^ must match after it.
      multiline: crossesLines || wholeWord,
    }));

  /** RE2's matches in `input`, which starts at `offset` in the whole text. `skipTo` is in whole-text offsets. */
  function* regexMatches(
    input: string,
    offset: number,
    skipTo?: () => number | undefined,
  ): Generator<TextMatch, undefined> {
    const re = compiled();
    // Into scanned offsets: wholeWord's TEXT_START shifts them by one, but it resumes a
    // char early so the boundary before the target can lead the next match.
    const skip =
      skipTo &&
      (() => {
        const at = skipTo();
        return at === undefined ? undefined : at - offset;
      });
    if (!wholeWord) {
      for (const found of execMatches(re, input, false, undefined, skip)) {
        yield { ...found, start: found.start + offset, end: found.end + offset };
      }
      return;
    }
    // wholeWord's lead and trail groups are boundary characters, trimmed from the match.
    // The scanned text starts with TEXT_START, so offsets shift back by one.
    for (const found of execMatches(re, TEXT_START + input, true, ENDS_NON_WORD, skip)) {
      const lead = found.groups[0] ?? '';
      const trail = found.groups[found.groups.length - 1] ?? '';
      const start = found.start + lead.length - TEXT_START.length + offset;
      yield {
        start,
        end: found.end - trail.length - TEXT_START.length + offset,
        text: found.text.slice(lead.length, found.text.length - trail.length),
        groups: found.groups.slice(1, -1),
        named: found.named,
      };
    }
  }

  /** Native indexOf over the whole text; foldAsciiCase keeps every UTF-16 offset. */
  function* literalMatches(text: string, maxPerLine: number): Generator<TextMatch, undefined> {
    const haystack = flags.caseSensitive ? text : foldAsciiCase(text);
    // The LF ending the line the current match starts on, and the matches started there.
    let lineEnd = -1;
    let onLine = 0;
    for (let at = haystack.indexOf(folded); at !== -1;) {
      if (at > lineEnd) {
        lineEnd = haystack.indexOf('\n', at);
        if (lineEnd === -1) lineEnd = haystack.length;
        onLine = 0;
      }
      const end = at + folded.length;
      yield { start: at, end, text: text.slice(at, end), groups: [], named: undefined };
      const next = end > at ? end : end + 1;
      at = haystack.indexOf(folded, ++onLine >= maxPerLine ? Math.max(next, lineEnd + 1) : next);
    }
  }

  async function* matches(
    input: TextView | string,
    options: { signal?: AbortSignal; path?: string; maxPerLine?: number } = {},
  ): AsyncGenerator<TextMatch, void> {
    if (typeof input !== 'string' && input.crlf && lfVariant) {
      yield* lfVariant.matches(input, options);
      return;
    }
    const text = typeof input === 'string' ? input : input.text;
    const { signal, path, maxPerLine = Infinity } = options;
    const tick = createYielder(signal);
    let cursor = 0;
    // Awaiting mid-walk is safe with the shared regex: execMatches re-writes
    // lastIndex from its own match before every exec.
    async function* checked(found: Iterable<TextMatch>): AsyncGenerator<TextMatch, void> {
      for (const match of found) {
        if (await tick()) signal?.throwIfAborted();
        // The resume point never precedes the previous match end; guard against it.
        if (match.start < cursor) continue;
        cursor = match.end;
        yield match;
      }
    }

    if (plan.literal && !wholeWord && !plan.literal.needsRe2(text)) {
      yield* checked(literalMatches(text, maxPerLine));
      return;
    }
    if (crossesLines) {
      if (overRe2Bound(text)) {
        throw new FsError(
          ErrorCode.TOO_LARGE,
          `File too large for a pattern that can match across lines (${String(Buffer.byteLength(text, 'utf8'))} > ${String(RE2_MAX_INPUT_BYTES)} bytes). Use a pattern that stays on one line, or pass caseSensitive: true with a literal searchPattern.`,
          path,
        );
      }
      // RE2's $ cannot see past a CR, so a regex sees a mixed-ending text's CRLFs as LF,
      // as line mode drops a line's CR. `lfs` holds each such LF's offset in `seen`.
      const lfs: number[] = [];
      let seen = text;
      if (flags.isRegex && text.includes('\r\n')) {
        for (let at = text.indexOf('\r\n'); at !== -1; at = text.indexOf('\r\n', at + 2)) {
          lfs.push(at - lfs.length);
        }
        seen = text.replaceAll('\r\n', '\n');
      }
      /** An offset in `seen` as an offset in `text`: each dropped CR before it adds one. */
      const back = (at: number): number => {
        let lo = 0;
        let hi = lfs.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if ((lfs[mid] ?? at) < at) lo = mid + 1;
          else hi = mid;
        }
        return at + lo;
      };
      // A final newline does not start a line, so nothing matches after it.
      const end = seen === '' || seen.endsWith('\n') ? seen.length : -1;
      // The LF ending the line the current match starts on, the matches started there,
      // and, once they reach maxPerLine, the next line's start for RE2 to resume from.
      let lineEnd = -1;
      let onLine = 0;
      let skipTo: number | undefined;
      yield* checked(
        (function* () {
          for (const match of regexMatches(seen, 0, () => skipTo)) {
            if (match.start === end) return;
            if (match.start > lineEnd) {
              lineEnd = seen.indexOf('\n', match.start);
              if (lineEnd === -1) lineEnd = seen.length;
              onLine = 0;
            }
            skipTo = ++onLine >= maxPerLine ? lineEnd + 1 : undefined;
            if (lfs.length === 0) {
              yield match;
              continue;
            }
            const start = back(match.start);
            const stop = back(match.end);
            const original = text.slice(start, stop);
            const crlfOnly = !/(?<!\r)\n/u.test(original);
            const ambiguous = new Set<string | number>();
            // A group is text from `seen`, so it gets back the CRs its span had in `text`.
            // re2-wasm gives no group offsets, so the span is found by the group's text.
            const restore = (group: string, key: string | number): string => {
              if (crlfOnly) return group.replaceAll('\n', '\r\n');
              // No line break in the group: no CR was hidden inside it.
              if (!group.includes('\n')) return group;
              const spans = new Set<string>();
              for (
                let at = match.text.indexOf(group);
                at !== -1;
                at = match.text.indexOf(group, at + 1)
              ) {
                spans.add(
                  text.slice(back(match.start + at), back(match.start + at + group.length)),
                );
                if (spans.size > 1) break;
              }
              // The same text sits in the match with different endings: which one the group
              // held cannot be told. `replace` refuses to expand it if referenced.
              if (spans.size > 1) ambiguous.add(key);
              const [first] = spans;
              return first ?? group;
            };
            const groups = match.groups.map((group, i) =>
              group === undefined ? undefined : restore(group, i + 1),
            );
            const named =
              match.named &&
              Object.fromEntries(
                Object.entries(match.named).map(([name, value]) => [name, restore(value, name)]),
              );
            yield {
              start,
              end: stop,
              text: original,
              groups,
              named,
              ...(ambiguous.size > 0 ? { ambiguousGroups: ambiguous } : {}),
            };
          }
        })(),
      );
      return;
    }
    // One whole-text test rules out most texts far faster than a call per line. With `m`,
    // ^ and $ stay line-relative, but $ cannot see past a kept CR, so such a text skips it.
    if (!wholeWord && !overRe2Bound(text) && !(plan.source.includes('$') && text.includes('\r'))) {
      prefilter ??= compileRegex(plan.source, {
        caseSensitive: flags.caseSensitive,
        multiline: true,
      });
      prefilter.lastIndex = 0;
      if (prefilter.exec(text) === null) return;
    }
    const lines = text.split('\n');
    // A final newline splits into a phantom empty last element, which is not a line.
    if (text.endsWith('\n') || text === '') lines.pop();
    let offset = 0;
    for (const raw of lines) {
      // Yield between lines too: millions of short lines never yield per-match.
      if (await tick()) signal?.throwIfAborted();
      // A regex loses the CR of a CRLF ending, as text mode does; a literal and a lone CR keep it.
      const crlf = flags.isRegex && raw.endsWith('\r') && text[offset + raw.length] === '\n';
      const line = crlf ? raw.slice(0, -1) : raw;
      if (overRe2Bound(line)) throw new FsError(ErrorCode.TOO_LARGE, LINE_TOO_LONG, path);
      let onLine = 0;
      // Leaving the loop closes the line's walk, so no further exec runs on it.
      for await (const match of checked(regexMatches(line, offset))) {
        yield match;
        if (++onLine >= maxPerLine) break;
      }
      offset += raw.length + 1;
    }
  }

  return {
    crossesLines,
    lineBreakFree,
    compile() {
      if (!plan.literal) compiled();
    },
    mayMatch(bytes) {
      if (!plan.literal) return true;
      const probe = prefilterBytes(bytes, lineBreakFree);
      if (probe === undefined) return true;
      return plan.literal.needsRe2(probe) || plan.literal.mayMatch(probe);
    },
    matches,
    async replace(view, replacement, options = {}) {
      const isView = typeof view !== 'string';
      const text = isView ? view.text : view;
      const isCrlf = isView && view.crlf;
      const effectiveReplacement =
        isCrlf && !flags.isRegex ? replacement.replaceAll('\r\n', '\n') : replacement;
      const targetEngine = isCrlf && lfVariant ? lfVariant : this;
      const expand = Boolean(options.expand);
      const signal = options.signal;
      const limits = options.limits;
      let matchCount = 0;
      let more = false;
      let updated = '';
      let cursor = 0;
      try {
        for await (const m of targetEngine.matches(view, {
          ...(signal ? { signal } : {}),
          ...(limits ? { path: limits.path } : {}),
        })) {
          if (matchCount === limits?.maxMatches) {
            more = true;
            break;
          }
          matchCount++;
          if (
            expand &&
            m.ambiguousGroups &&
            readsAmbiguousGroup(effectiveReplacement, m.ambiguousGroups, m.groups.length)
          ) {
            throw new FsError(
              ErrorCode.INVALID_INPUT,
              'A capture group holds a line break whose line ending cannot be told apart in this mixed-ending file.',
              limits?.path,
              undefined,
              'Nothing was written. Normalise the file to one line ending first, or write the line break in the replacement instead of capturing it.',
            );
          }
          updated +=
            text.slice(cursor, m.start) +
            (expand
              ? expandDollarTokens(
                  effectiveReplacement,
                  m.text,
                  m.groups,
                  m.start,
                  text,
                  m.named,
                  declared,
                )
              : effectiveReplacement);
          if (limits && updated.length > limits.maxBytes) throw outputTooLarge(limits);
          cursor = m.end;
        }
      } catch (error) {
        if (error instanceof RangeError && limits) throw outputTooLarge(limits, error);
        throw error;
      }
      const finalContent = updated + text.slice(cursor);
      if (limits) {
        const diskBytes = isView
          ? Buffer.byteLength(view.restore(finalContent), 'utf8')
          : Buffer.byteLength(finalContent, 'utf8');
        if (diskBytes > limits.maxBytes) {
          throw outputTooLarge(limits);
        }
      }
      return { content: finalContent, matchCount, more };
    },
    dispose() {
      freeRegex(regex);
      freeRegex(prefilter);
      regex = undefined;
      prefilter = undefined;
      lfVariant?.dispose();
    },
  };
}

// Matches a consumed text that ends in a non-word char: its last char may lead the next match.
const ENDS_NON_WORD = new RegExp(`[^${WORD_CLASS}]$`, 'u');
// wholeWord scans behind this non-word char instead of a `^` lead: an empty lead
// cannot be backed up onto, so a match right after one at text start was missed (#158).
const TEXT_START = '\n';
