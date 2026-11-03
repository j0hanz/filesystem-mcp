/**
 * The Match plan module (see GLOSSARY.md): what a search or a replacement
 * settles about its needle before any text is read. One module owns the
 * judgment — the native literal pass with its per-text RE2 bails, and the
 * RE2 plumbing — and search and replace both ask it, so a preview judges
 * exactly what its replacement will touch.
 */
import type { RE2ExecArray } from '@adguard/re2-wasm';
import { RE2 } from '@adguard/re2-wasm';

import { ErrorCode, FsError } from './errors.ts';
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
function foldAsciiCase(text: string): string {
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
function createLiteralMatcher(needle: string, caseSensitive: boolean): LiteralMatcher | undefined {
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
export interface ReplacementMatcher {
  /**
   * Yields periodically and throws on abort: a partial splice must never be written.
   * Throws TOO_LARGE once the result is known to exceed `limits.maxBytes` UTF-8 bytes.
   */
  replace(
    content: string,
    replacement: string,
    signal: AbortSignal | undefined,
    limits: ReplaceLimits,
  ): Promise<{ content: string; matchCount: number; more: boolean }>;
  testBuffer(buffer: Buffer): boolean;
  /** Releases any compiled pattern this matcher owns. Idempotent. */
  dispose(): void;
}
const DOLLAR_TOKEN = /\$(\$|&|`|'|<([^>]*)>|\d{1,2})/g;

// Matches a consumed text that ends in a non-word char: its last char may lead the next match.
const ENDS_NON_WORD = new RegExp(`[^${WORD_CLASS}]$`, 'u');
// wholeWord scans behind this non-word char instead of a `^` lead: an empty lead
// cannot be backed up onto, so a match right after one at text start was missed (#158).
const TEXT_START = '\n';

export interface ReplaceLimits {
  maxMatches: number;
  maxBytes: number;
  path: string;
}

const OUTPUT_TOO_LARGE_SUGGESTION =
  "Narrow searchPattern or shorten the replacement; $` and $' insert the whole text before/after each match.";

export function outputTooLarge(limits: ReplaceLimits, cause?: unknown): FsError {
  return new FsError(
    ErrorCode.TOO_LARGE,
    `Replacement result exceeds the size limit (more than ${String(limits.maxBytes)} bytes)`,
    limits.path,
    cause,
    OUTPUT_TOO_LARGE_SUGGESTION,
  );
}
/**
 * Expand `$`-substitutions in a replacement template the way `RegExp` does.
 *
 * We cannot hand the template to RE2's own string replacer: it throws
 * `Invalid replacement string` on any `$` not followed by a substitution it
 * recognises (so a replacement of `$100` or a trailing `$` fails outright,
 * where `RegExp` inserts the `$` literally), and it renders an out-of-range
 * `$5` as `$4`. The matcher splices matches itself, so this is the single owner
 * of the syntax.
 */
function expandDollarTokens(
  template: string,
  match: string,
  groups: (string | undefined)[],
  offset: number,
  input: string,
  named: Record<string, string> | undefined,
): string {
  return template.replace(DOLLAR_TOKEN, (token: string, kind: string, name?: string) => {
    if (kind === '$') return '$';
    if (kind === '&') return match;
    if (kind === '`') return input.slice(0, offset);
    if (kind === "'") return input.slice(offset + match.length);
    if (name !== undefined) {
      if (named && Object.hasOwn(named, name)) return named[name] ?? '';
      return token;
    }
    // `$12` prefers group 12, then falls back to group 1 followed by a literal
    // `2`, and stays literal when neither exists — RegExp's own precedence.
    const two = Number.parseInt(kind, 10);
    if (kind.length === 2 && two >= 1 && two <= groups.length) return groups[two - 1] ?? '';
    const one = Number.parseInt(kind.slice(0, 1), 10);
    if (one >= 1 && one <= groups.length) {
      return (groups[one - 1] ?? '') + (kind.length === 2 ? kind.slice(1) : '');
    }
    return token;
  });
}
export function createRegexReplacementMatcher(
  regex: Regex,
  expandReplacement: boolean,
  wholeWord: boolean,
): ReplacementMatcher {
  return {
    testBuffer(buffer: Buffer): boolean {
      if (buffer.length > RE2_MAX_INPUT_BYTES) {
        throw new FsError(
          ErrorCode.TOO_LARGE,
          `File too large for a regex replace (${String(buffer.length)} > ${String(RE2_MAX_INPUT_BYTES)} bytes). Regex mode is used for isRegex, wholeWord, or a case-insensitive search for non-ASCII text (or a file holding U+212A or U+017F); pass caseSensitive: true with a literal searchPattern, or split the file.`,
        );
      }
      // The regex is global and shared across every file in the batch, so a
      // previous file's match would otherwise start this scan mid-string.
      regex.lastIndex = 0;
      const text = buffer.toString('utf-8');
      return regex.test(wholeWord ? TEXT_START + text : text);
    },
    async replace(content, replacement, signal, limits) {
      // Splicing by hand rather than through `String.replace(regex, …)`: RE2's
      // own replacer indexes the JS string with the code-point offsets it
      // reports, which lands the replacement short by one per astral character
      // (most emoji) earlier in the file. execMatches reports UTF-16 offsets.
      let matchCount = 0;
      let more = false;
      let updated = '';
      let cursor = 0;
      const tick = createYielder(signal);
      try {
        // wholeWord's lead and trailing groups are boundary characters: the lead is
        // spliced around, and the trailing one is left for the next match to use.
        // The scanned text starts with TEXT_START, so offsets shift back by one.
        const scanned = wholeWord ? TEXT_START + content : content;
        for (const found of execMatches(regex, scanned, wholeWord, ENDS_NON_WORD)) {
          const lead = wholeWord ? (found.groups[0] ?? '') : '';
          const trail = wholeWord ? (found.groups[found.groups.length - 1] ?? '') : '';
          const match = wholeWord
            ? {
                ...found,
                start: found.start + lead.length - TEXT_START.length,
                end: found.end - trail.length - TEXT_START.length,
                text: found.text.slice(lead.length, found.text.length - trail.length),
                groups: found.groups.slice(1, -1),
              }
            : found;
          // The resume point never precedes the previous needle end; guard the splice against it.
          if (match.start < cursor) continue;
          if (matchCount === limits.maxMatches) {
            more = true;
            break;
          }
          matchCount++;
          // Only isRegex=true opts into $1/$& substitution. A literal search
          // reaches this matcher too (wholeWord, or a case-insensitive needle
          // RE2 must judge), and there the replacement must be inserted verbatim.
          updated +=
            content.slice(cursor, match.start) +
            (expandReplacement
              ? expandDollarTokens(
                  replacement,
                  match.text,
                  match.groups,
                  match.start,
                  content,
                  match.named,
                )
              : replacement);
          // `updated` only grows, and each UTF-16 unit is at least one UTF-8 byte.
          if (updated.length > limits.maxBytes) throw outputTooLarge(limits);
          cursor = match.end;
          if (await tick()) signal?.throwIfAborted();
        }
      } catch (error) {
        // V8 throws RangeError once one expansion overruns its maximum string length.
        if (error instanceof RangeError) throw outputTooLarge(limits, error);
        throw error;
      }
      return { content: updated + content.slice(cursor), matchCount, more };
    },
    dispose(): void {
      freeRegex(regex);
    },
  };
}
/** An ASCII needle matched case-insensitively in native code, as RE2 would match it; `fallback` judges the files RE2 must. */
export function createCaseInsensitiveLiteralMatcher(
  searchPattern: string,
  literal: LiteralMatcher,
  fallback: ReplacementMatcher,
): ReplacementMatcher {
  const lower = searchPattern.toLowerCase();
  return {
    testBuffer(buffer) {
      return literal.needsRe2(buffer) ? fallback.testBuffer(buffer) : literal.mayMatch(buffer);
    },
    // One native O(n) pass, like the case-sensitive matcher; nothing to yield for.
    replace(content, replacement, signal, limits) {
      if (literal.needsRe2(content)) return fallback.replace(content, replacement, signal, limits);
      // foldAsciiCase keeps every UTF-16 offset, so a hit in `folded` splices `content`.
      const folded = foldAsciiCase(content);
      let matchCount = 0;
      let more = false;
      let updated = '';
      let cursor = 0;
      let size = content.length;
      const delta = replacement.length - lower.length;
      for (let at = folded.indexOf(lower); at !== -1; at = folded.indexOf(lower, cursor)) {
        if (matchCount === limits.maxMatches) {
          more = true;
          break;
        }
        updated += content.slice(cursor, at) + replacement;
        cursor = at + lower.length;
        matchCount++;
        size += delta;
        if (size > limits.maxBytes) throw outputTooLarge(limits);
      }
      return Promise.resolve({ content: updated + content.slice(cursor), matchCount, more });
    },
    dispose(): void {
      fallback.dispose();
    },
  };
}
export function createCaseSensitiveLiteralMatcher(
  searchPattern: string,
): ReplacementMatcher | undefined {
  // Same bail as createLiteralMatcher (core/search.ts): a needle containing
  // U+FFFD or a lone surrogate is judged over decoded text by RE2 — raw-byte
  // indexOf would claim a file the replace pass cannot transform.
  if (searchPattern.includes('�') || Buffer.from(searchPattern).toString() !== searchPattern) {
    return undefined;
  }
  const searchBuffer = Buffer.from(searchPattern, 'utf8');

  return {
    testBuffer(buffer: Buffer): boolean {
      return buffer.indexOf(searchBuffer) !== -1;
    },
    // One native O(n) pass; nothing to yield for.
    replace(content, replacement, _signal, limits) {
      let matchCount = 0;
      let more = false;
      // Each match is searchPattern long, so the result's UTF-16 length moves by a fixed delta.
      let size = content.length;
      const delta = replacement.length - searchPattern.length;
      const updated = content.replaceAll(searchPattern, (match) => {
        // Past the cap, the match is kept as it was.
        if (matchCount === limits.maxMatches) {
          more = true;
          return match;
        }
        matchCount++;
        size += delta;
        if (size > limits.maxBytes) throw outputTooLarge(limits);
        return replacement;
      });
      return Promise.resolve({ content: updated, matchCount, more });
    },
    dispose(): void {
      // no compiled pattern to release
    },
  };
}
export function createReplacementMatcher(args: {
  searchPattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}): ReplacementMatcher {
  const plan = planMatch(args.searchPattern, {
    isRegex: args.isRegex,
    caseSensitive: args.caseSensitive,
    wholeWord: args.wholeWord,
  });
  if (!args.isRegex && !args.wholeWord && args.caseSensitive) {
    // undefined means the bail handed this needle to the RE2 path below.
    const fast = createCaseSensitiveLiteralMatcher(args.searchPattern);
    if (fast) return fast;
  }
  const regex = compileRegex(plan.source, { caseSensitive: args.caseSensitive });
  const matcher = createRegexReplacementMatcher(regex, args.isRegex, args.wholeWord);
  // A case-insensitive literal is matched natively unless RE2 must judge the needle.
  return !args.isRegex && !args.wholeWord && plan.literal
    ? createCaseInsensitiveLiteralMatcher(args.searchPattern, plan.literal, matcher)
    : matcher;
}
