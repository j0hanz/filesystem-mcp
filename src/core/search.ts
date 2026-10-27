import { dirname } from 'node:path';

import type { RE2ExecArray } from '@adguard/re2-wasm';
import { RE2 } from '@adguard/re2-wasm';

import type { StoppedReason } from './concurrency.ts';
import { ErrorCode, FsError } from './errors.ts';
import { GuardedFileSystem } from './fs.ts';
import type { PathGuard } from './path.ts';
import type { ScanScope } from './scan.ts';
import { scan } from './scan.ts';
import { escapeRegExp, getMaxTextFileSize, MIB, PARALLEL_CONCURRENCY } from './util.ts';

/**
 * A fresh, flat copy of `s`. V8 keeps a substring of a long string as a slice
 * that references its parent, so a kept line would otherwise pin the whole
 * file's text for as long as the match list lives (60 s in the page store).
 */
const own = (s: string): string => Buffer.from(s, 'utf8').toString('utf8');

interface SearchResult {
  file: string;
  line: number;
  /** 0-indexed column of the first occurrence on the line. */
  column: number;
  content: string;
  matchCount: number;
  /** Up to `context` lines either side of the match; absent when context is 0. */
  before?: string[];
  after?: string[];
}

export type Regex = RE2;

/** Occurrence-counting bound, so one pathological line cannot spin forever. */
const MAX_MATCHES_PER_LINE = 100_000;

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

/** The chunk `FileHandle#readFile` reads in, and checks its signal between. */
const READ_CHUNK_BYTES = 512 * 1024;

/** One line's matches: how many, and where the first starts (UTF-16 units). */
interface LineHit {
  count: number;
  column: number;
}

/**
 * A literal needle matched in native code, as RE2 would match it. RE2 copies
 * its whole input into the wasm heap on every call, and for a literal that
 * copy is most of what a search costs: once per file to rule it out, then once
 * per line of every file it could not rule out.
 */
interface LiteralMatcher {
  /** True when this file holds a character RE2 folds onto one of the needle's letters. */
  needsRe2(buffer: Buffer): boolean;
  /** False only when the raw bytes cannot hold a match. */
  mayMatch(buffer: Buffer): boolean;
  matchLine(line: string): LineHit | undefined;
}

/** The only non-ASCII characters RE2's case folding maps onto ASCII letters. */
const KELVIN_SIGN_UTF8 = Buffer.from('\u212A', 'utf8'); // folds onto k
const LONG_S_UTF8 = Buffer.from('\u017F', 'utf8'); // folds onto s
const ASCII_UPPER_RE = /[A-Z]+/gu;

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
    ...(lower.includes('k') ? [KELVIN_SIGN_UTF8] : []),
    ...(lower.includes('s') ? [LONG_S_UTF8] : []),
  ];
  return {
    needsRe2: (buffer) => folds.some((fold) => buffer.includes(fold)),
    // Latin-1 decoding keeps one char per byte, and lowercasing it maps A-Z
    // onto a-z and every other byte onto a non-ASCII char, so an ASCII needle
    // is found exactly where the bytes spell it in either case.
    mayMatch: (buffer) => buffer.toString('latin1').toLowerCase().includes(lower),
    // ASCII letters only: String#toLowerCase turns U+0130 into two code units,
    // which shifts every later column and spells an `i` RE2 does not match.
    matchLine: (line) =>
      countOccurrences(
        line.replace(ASCII_UPPER_RE, (upper) => upper.toLowerCase()),
        lower,
      ),
  };
}

const BUFFER_ANCHOR_RE = /\\[AzZ]/u;
/** `(?i)`, `(?-m)`, `(?s:…)`: inline flags can undo the `m` the prefilter relies on. */
const INLINE_FLAGS_RE = /\(\?[a-zA-Z-]+[:)]/u;
const CR = 13;

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
 */
export function* execMatches(regex: Regex, text: string): Generator<RegexMatch, undefined> {
  regex.lastIndex = 0;
  // Cursor into `text`, carried forward across matches: RE2 reports them in
  // ascending order, so the walk is O(text) in total rather than per match.
  let cursorCp = 0;
  let cursorU16 = 0;
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
    regex.lastIndex = match.index + (matched.length === 0 ? 1 : codePointLength(matched));
  }
}

/**
 * Find non-overlapping occurrences of a global regex in a single line, reporting
 * the first match's column alongside the count.
 */
async function findLineMatches(
  regex: Regex,
  line: string,
  tick: () => Promise<boolean>,
): Promise<LineHit | undefined> {
  let count = 0;
  let column = -1;
  // Awaiting mid-drain is safe with a shared regex: execMatches re-writes
  // lastIndex from its own match before every exec, with no await inside.
  for (const match of execMatches(regex, line)) {
    if (column === -1) column = match.start;
    count++;
    if (count >= MAX_MATCHES_PER_LINE || (await tick())) break;
  }
  return count > 0 ? { count, column } : undefined;
}

export interface SearchContentOptions {
  caseSensitive?: boolean;
  isRegex?: boolean;
  maxResults?: number;
  filePattern?: string;
  skipIgnored?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  /**
   * Search exactly this file (absolute, already guard-validated) instead of
   * walking `directory` with `filePattern`. Set when the caller named a file:
   * its name must not be interpreted as a glob.
   */
  explicitFile?: string;
  /** Lines of context to carry either side of each match; 0 (default) carries none. */
  context?: number;
  signal?: AbortSignal;
}

export interface SearchContentOutcome {
  basePath: string;
  matches: SearchResult[];
  summary: {
    /**
     * Matching *lines*, one per entry in `matches` — not pattern occurrences.
     * A line with three occurrences counts once here and reports 3 in its own
     * `SearchResult.matchCount`.
     */
    matchingLines: number;
    filesScanned: number;
    filesMatched: number;
    truncated: boolean;
    /** Files the guard rejected or that could not be stat'd. */
    skippedInaccessible: number;
    /** Files skipped unread because they exceed maxFileSize. */
    skippedTooLarge: number;
    /** Files skipped because they contain a NUL byte (binary). */
    skippedBinary: number;
    stoppedReason?: StoppedReason;
  };
}

type FileScan =
  { kind: 'tooLarge' } | { kind: 'binary' } | { kind: 'scanned'; matches: SearchResult[] };

interface ScanContext {
  fs: GuardedFileSystem;
  signal: AbortSignal | undefined;
  maxFileSize: number;
  maxResults: number;
  regex: Regex;
  prefilter: Regex;
  /** Set for a literal needle it can match; RE2 then judges only the files it hands back. */
  literal: LiteralMatcher | undefined;
  source: string;
  context: number;
}

async function scanFile(entryPath: string, scanCtx: ScanContext): Promise<FileScan> {
  let buffer: Buffer;
  // No catch: scan counts a failed entry as inaccessible, or fails the call for a named file.
  {
    // open() validates, refuses a swapped final symlink (O_NOFOLLOW) and
    // re-checks the descriptor's real path (H4), so these bytes are the
    // validated file's, not whatever the name points at by now.
    await using handle = await scanCtx.fs.open(entryPath);
    const { size } = await handle.stat();
    if (size > scanCtx.maxFileSize) return { kind: 'tooLarge' };
    // Read the size fstat reported: handle.readFile would fstat again and then
    // read once more to find EOF, two extra round trips on every file a walk
    // touches. A file that grows meanwhile is searched as it was at the fstat.
    // A size of 0 is also what procfs and other virtual files report while
    // holding text, so those still read to EOF.
    if (size === 0) {
      buffer = await handle.readFile({ signal: scanCtx.signal });
      if (buffer.length > scanCtx.maxFileSize) return { kind: 'tooLarge' };
    } else {
      buffer = Buffer.allocUnsafe(size);
      let filled = 0;
      while (filled < size) {
        // In readFile's own chunks, with its check of the signal before each,
        // so a deadline on a slow filesystem lands as soon as it did there.
        scanCtx.signal?.throwIfAborted();
        const length = Math.min(size - filled, READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, filled, length, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      buffer = buffer.subarray(0, filled);
    }
  }

  // A NUL byte marks a binary file, as it does for `read` and `grep -I`.
  // Non-UTF-8 text is still searched: a lossy decode only affects the
  // bytes a pattern could not have matched anyway.
  if (buffer.includes(0)) return { kind: 'binary' };

  const literal = scanCtx.literal?.needsRe2(buffer) ? undefined : scanCtx.literal;
  if (literal && !literal.mayMatch(buffer)) return { kind: 'scanned', matches: [] };
  const content = buffer.toString('utf-8');
  if (!literal && canPrefilter(scanCtx.source, buffer)) {
    scanCtx.prefilter.lastIndex = 0;
    if (scanCtx.prefilter.exec(content) === null) return { kind: 'scanned', matches: [] };
  }

  const lines = content.split(/\r?\n/u);
  // A trailing newline splits into a phantom empty last element, and an
  // empty file splits into one empty element: neither is a line the
  // file has, for matching or for context.
  const lineCount =
    content.length === 0 ? 0 : content.endsWith('\n') ? lines.length - 1 : lines.length;
  // A single line past RE2_MAX_INPUT_BYTES OOMs the wasm module for the rest of
  // the process; report the file tooLarge instead. Only a buffer over the bound
  // can hold such a line, so ordinary files skip the per-line measure, and a
  // literal match never hands a line to RE2.
  const checkLineSize = !literal && buffer.length > RE2_MAX_INPUT_BYTES;
  const matches: SearchResult[] = [];
  const tick = createYielder(scanCtx.signal);
  for (let i = 0; i < lineCount; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (checkLineSize && Buffer.byteLength(line, 'utf8') > RE2_MAX_INPUT_BYTES) {
      return { kind: 'tooLarge' };
    }
    // Yield between lines too: millions of short lines never yield per-match.
    if (await tick()) break;
    // One scan per line: the helper resets lastIndex itself, so it
    // doubles as the "does this line match" test.
    const found = literal
      ? literal.matchLine(line)
      : await findLineMatches(scanCtx.regex, line, tick);
    if (found) {
      matches.push({
        file: entryPath,
        line: i + 1,
        column: found.column,
        content: own(line),
        matchCount: found.count,
        ...(scanCtx.context > 0
          ? {
              before: lines.slice(Math.max(0, i - scanCtx.context), i).map(own),
              after: lines.slice(i + 1, Math.min(lineCount, i + 1 + scanCtx.context)).map(own),
            }
          : {}),
      });
      // One past the cap, so a file with more matches than it weighs past it.
      if (matches.length > scanCtx.maxResults) break;
    }
  }
  return { kind: 'scanned', matches };
}

export async function searchContent(
  scope: ScanScope,
  pattern: string,
  options: Omit<SearchContentOptions, 'explicitFile'>,
  pathGuard: PathGuard,
): Promise<SearchContentOutcome> {
  const source = options.isRegex ? pattern || '' : escapeRegExp(pattern || '');
  // Compiles live inside the try so a failing second compile does not leak the
  // first's wasm memory; freeRegex is null-safe.
  let regex: Regex | undefined;
  let prefilter: Regex | undefined;
  try {
    regex = compileRegex(source, {
      caseSensitive: Boolean(options.caseSensitive),
    });
    // Whole-buffer test: `m` makes ^/$ line-relative so a per-line hit is always a
    // buffer hit (the converse can be false — a false positive just falls through
    // to the per-line scan). \A/\z/\Z are buffer-relative even under `m`, inline
    // flag groups can undo `m`, and $ cannot see past a \r, so those inputs skip
    // the prefilter (see canPrefilter).
    prefilter = compileRegex(source, {
      caseSensitive: Boolean(options.caseSensitive),
      multiline: true,
    });
    const matches: SearchResult[] = [];
    const maxResults = options.maxResults ?? 100;
    const maxFileSize = getMaxTextFileSize();
    const context = options.context ?? 0;
    let filesScanned = 0;
    let filesMatched = 0;
    let matchingLines = 0;
    let skippedTooLarge = 0;
    let skippedBinary = 0;
    const scanCtx: ScanContext = {
      fs: new GuardedFileSystem(pathGuard),
      signal: options.signal,
      maxFileSize,
      maxResults,
      regex,
      prefilter,
      literal: options.isRegex
        ? undefined
        : createLiteralMatcher(pattern, Boolean(options.caseSensitive)),
      source,
      context,
    };
    const outcome = await scan<FileScan>(
      scope,
      {
        pathGuard,
        pattern: options.filePattern ?? '**/*',
        // Same rule as replace_text, so a search with the same glob previews the
        // files a replace would touch: a slash-free glob matches at any depth.
        baseNameMatch: true,
        includeHidden: Boolean(options.includeHidden),
        includeIgnored: !options.skipIgnored,
        onlyFiles: true,
        ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
        concurrency: PARALLEL_CONCURRENCY,
        cap: maxResults,
        weigh: (s) => (s.kind === 'scanned' ? s.matches.length : 0),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (entry) => scanFile(entry.path, scanCtx),
    );

    for (const file of outcome.results) {
      switch (file.kind) {
        case 'tooLarge':
          skippedTooLarge++;
          break;
        case 'binary':
          filesScanned++;
          skippedBinary++;
          break;
        case 'scanned':
          filesScanned++;
          if (file.matches.length > 0) filesMatched++;
          for (const match of file.matches) {
            if (matches.length >= maxResults) break;
            matches.push(match);
            matchingLines++;
          }
          break;
      }
    }
    const { skippedInaccessible, stoppedReason } = outcome;

    return {
      basePath: scope.root,
      matches,
      summary: {
        matchingLines,
        filesScanned,
        filesMatched,
        truncated: stoppedReason !== undefined,
        skippedInaccessible,
        skippedTooLarge,
        skippedBinary,
        ...(stoppedReason ? { stoppedReason } : {}),
      },
    };
  } finally {
    freeRegex(prefilter);
    freeRegex(regex);
  }
}

/** Whether one whole-buffer RE2 test is a sound "cannot match" check for this file. */
function canPrefilter(source: string, buffer: Buffer): boolean {
  if (buffer.length > RE2_MAX_INPUT_BYTES) return false;
  if (BUFFER_ANCHOR_RE.test(source)) return false;
  if (INLINE_FLAGS_RE.test(source)) return false;
  if (source.includes('$') && buffer.includes(CR)) return false;
  return true;
}

/** Explicit files bypass glob filtering; their parent is the directory walked. */
export async function resolveSearchScope(
  path: string | undefined,
  fs: GuardedFileSystem,
  signal?: AbortSignal,
): Promise<{ basePath: string; explicitFile?: string }> {
  const requested = fs.pathGuard.resolvePathOrRoot(path);
  // One resolution, one stat: validateExistingDirectory would redo both.
  const { stats, validPath: resolved } = await fs.stat(requested, { signal });
  if (!stats.isFile()) {
    if (!stats.isDirectory()) {
      throw new FsError(ErrorCode.NOT_DIRECTORY, 'Not a directory', requested);
    }
    return { basePath: resolved };
  }
  return {
    basePath: dirname(resolved),
    // The name is NOT turned into a glob: `[slug].tsx` would read as a
    // character class. searchContent scans exactly this file instead, and
    // hidden/ignored filtering is moot for a file the caller named.
    explicitFile: resolved,
  };
}
