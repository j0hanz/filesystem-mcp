/**
 * The Match plan module (see GLOSSARY.md): what a search or a replacement
 * settles about its needle before any text is read. One module owns the
 * judgment — the native literal pass with its per-text RE2 bails, and the
 * RE2 plumbing — and search and replace both ask it, so a preview judges
 * exactly what its replacement will touch.
 */
import type { RE2ExecArray } from '@adguard/re2-wasm';
import { RE2 } from '@adguard/re2-wasm';

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
/** One line's matches: how many, and where the first starts (UTF-16 units). */
export interface LineHit {
  count: number;
  column: number;
}

/**
 * A literal needle matched in native code, as RE2 would match it. RE2 copies
 * its whole input into the wasm heap on every call, and for a literal that
 * copy is most of what a search costs: once per file to rule it out, then once
 * per line of every file it could not rule out.
 */
export interface LiteralMatcher {
  /** True when this file holds a character RE2 folds onto one of the needle's letters. */
  needsRe2(input: Buffer | string): boolean;
  /** False only when the raw bytes cannot hold a match. */
  mayMatch(buffer: Buffer): boolean;
  matchLine(line: string): LineHit | undefined;
}
/** The only non-ASCII characters RE2's case folding maps onto ASCII letters. */
const KELVIN_SIGN = '\u212A'; // folds onto k
const LONG_S = '\u017F'; // folds onto s
const ASCII_UPPER_RE = /[A-Z]+/gu;
/** Folds A-Z only, so every UTF-16 offset in the result matches the input. */
export function foldAsciiCase(text: string): string {
  // String#toLowerCase turns U+0130 into two code units, which shifts every
  // later column and spells an `i` RE2 does not match.
  return text.replace(ASCII_UPPER_RE, (upper) => upper.toLowerCase());
}
/** Non-overlapping occurrences, left to right, as a global RE2 exec walks them. */
function countOccurrences(line: string, needle: string): LineHit | undefined {
  const column = line.indexOf(needle);
  if (column === -1) return undefined;
  let count = 0;
  let at = column;
  while (at !== -1 && count < MAX_MATCHES_PER_LINE) {
    count++;
    at = line.indexOf(needle, at + needle.length);
  }
  return { count, column };
}
/** `undefined` when RE2 must judge the needle: these shortcuts are exact only for the needles they take. */
export function createLiteralMatcher(
  needle: string,
  caseSensitive: boolean,
): LiteralMatcher | undefined {
  // The file is decoded with U+FFFD for every invalid byte, and a lone
  // surrogate reaches RE2 as U+FFFD, so a needle holding either can match
  // decoded text that the raw bytes, or indexOf, do not.
  if (needle.includes('\uFFFD') || Buffer.from(needle, 'utf8').toString('utf8') !== needle) {
    return undefined;
  }
  if (caseSensitive) {
    const bytes = Buffer.from(needle, 'utf8');
    return {
      needsRe2: () => false,
      mayMatch: (buffer) => buffer.includes(bytes),
      matchLine: (line) => countOccurrences(line, needle),
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
    needsRe2: (input) => folds.some((fold) => input.includes(fold)),
    // Latin-1 decoding keeps one char per byte, and lowercasing it maps A-Z
    // onto a-z and every other byte onto a non-ASCII char, so an ASCII needle
    // is found exactly where the bytes spell it in either case.
    mayMatch: (buffer) => buffer.toString('latin1').toLowerCase().includes(lower),
    matchLine: (line) => countOccurrences(foldAsciiCase(line), lower),
  };
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
 * heap), so exhaustion is an emscripten `abort()` that kills regex search for
 * the rest of the process. Every caller MUST pass the result to
 * {@link freeRegex} when it is done with it.
 */
export function compileRegex(
  pattern: string,
  options: { caseSensitive?: boolean; multiline?: boolean } = {},
): Regex {
  const flags = `g${options.multiline ? 'm' : ''}${options.caseSensitive ? '' : 'i'}u`;
  try {
    return new RE2(pattern, flags);
  } catch (error) {
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

export interface RegexMatch {
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
 */
export function* execMatches(
  regex: Regex,
  text: string,
  keepLast = false,
  backUpOver?: RegExp,
): Generator<RegexMatch, undefined> {
  regex.lastIndex = 0;
  // Cursor into `text`, carried forward across matches: RE2 reports them in
  // ascending order, so the walk is O(text) in total rather than per match.
  let cursorCp = 0;
  let cursorU16 = 0;
  // Code-point offset the current search started from.
  let from = 0;
  let match: RE2ExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    while (cursorCp < match.index && cursorU16 < text.length) {
      const isPair =
        (text.charCodeAt(cursorU16) & 0xfc00) === 0xd800 &&
        (text.charCodeAt(cursorU16 + 1) & 0xfc00) === 0xdc00;
      cursorU16 += isPair ? 2 : 1;
      cursorCp++;
    }
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
    regex.lastIndex = next;
    from = next;
  }
}

// RE2's \b is ASCII-only, so wholeWord spells out the Unicode word class.
export const WORD_CLASS = String.raw`\p{L}\p{N}\p{M}_`;

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
