import { ErrorCode, FsError } from './errors.ts';
import { GuardedFileSystem } from './fs.ts';
import {
  compileRegex,
  createYielder,
  execMatches,
  freeRegex,
  type LineHit,
  type LiteralMatcher,
  MAX_MATCHES_PER_LINE,
  planMatch,
  RE2_MAX_INPUT_BYTES,
  type Regex,
} from './matcher.ts';
import type { PathGuard } from './path.ts';
import type { ScanScope, StoppedReason } from './scan.ts';
import { readText, scan, ScanSkip, skipOf } from './scan.ts';
import { PARALLEL_CONCURRENCY } from './util.ts';

/**
 * A fresh, flat copy of `s`. V8 keeps a substring of a long string as a slice
 * that references its parent, so a kept line would otherwise pin the whole
 * file's text for as long as the match list lives (60 s in the page store).
 */
const own = (s: string): string => Buffer.from(s, 'utf8').toString('utf8');

/** Longest line a result carries; a longer one is cut to a window around the match. */
export const MAX_MATCH_LINE_CHARS = 1000;
const MATCH_LEAD_CHARS = 200;

/**
 * `line` cut to a window that starts `MATCH_LEAD_CHARS` before `column`, with
 * each cut marked by the number of chars removed. A cut never splits a pair.
 */
function clipLine(line: string, column: number): string {
  if (line.length <= MAX_MATCH_LINE_CHARS) return line;
  let start = Math.max(0, column - MATCH_LEAD_CHARS);
  let end = Math.min(line.length, start + MAX_MATCH_LINE_CHARS);
  if (
    start > 0 &&
    isHighSurrogate(line.charCodeAt(start - 1)) &&
    isLowSurrogate(line.charCodeAt(start))
  )
    start--;
  if (
    end < line.length &&
    isHighSurrogate(line.charCodeAt(end - 1)) &&
    isLowSurrogate(line.charCodeAt(end))
  )
    end++;
  const head = start > 0 ? `…[${start} chars] ` : '';
  const tail = end < line.length ? ` […${line.length - end} chars]` : '';
  return head + line.slice(start, end) + tail;
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

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

const BUFFER_ANCHOR_RE = /\\[AzZ]/u;
/** `(?i)`, `(?-m)`, `(?s:…)`: inline flags can undo the `m` the prefilter relies on. */
const INLINE_FLAGS_RE = /\(\?[a-zA-Z-]+[:)]/u;
const CR = 13;

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
    /** Entries and directories the scan could not read. */
    skippedInaccessible: number;
    /** Files skipped unread because they exceed maxFileSize. */
    skippedTooLarge: number;
    /** Files skipped because read calls them binary, or a NUL byte follows their leading bytes. */
    skippedBinary: number;
    stoppedReason?: StoppedReason;
  };
}

interface FileScan {
  matches: SearchResult[];
  /** The signal stopped this file's lines short, so scan cannot see the timeout. */
  cut?: boolean;
}

interface ScanContext {
  fs: GuardedFileSystem;
  signal: AbortSignal | undefined;
  maxResults: number;
  regex: Regex;
  prefilter: Regex;
  /** Set for a literal needle it can match; RE2 then judges only the files it hands back. */
  literal: LiteralMatcher | undefined;
  source: string;
  context: number;
  /** A file the client named: an overlong line refuses the call instead of skipping. */
  named: boolean;
}

async function scanFile(entryPath: string, scanCtx: ScanContext): Promise<FileScan | ScanSkip> {
  // No catch: scan counts a failed entry as inaccessible, or fails the call for a named file.
  const verdict = await readText(scanCtx.fs, entryPath, scanCtx.signal);
  if (verdict.kind === 'tooLarge' || verdict.kind === 'binary') return skipOf(verdict);
  const buffer = verdict.bytes;
  // A NUL byte past the leading bytes still marks a binary file, as it does
  // for `grep -I`. Other non-UTF-8 text is still searched: a lossy decode
  // only affects the bytes a pattern could not have matched anyway.
  if (verdict.kind === 'undecodable' && buffer.includes(0)) {
    return new ScanSkip({ kind: 'binary', utf16: false });
  }

  const literal = scanCtx.literal?.needsRe2(buffer) ? undefined : scanCtx.literal;
  if (literal && !literal.mayMatch(buffer)) return { matches: [] };
  const content = buffer.toString('utf-8');
  if (!literal && canPrefilter(scanCtx.source, buffer)) {
    scanCtx.prefilter.lastIndex = 0;
    if (scanCtx.prefilter.exec(content) === null) return { matches: [] };
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
  const yielder = createYielder(scanCtx.signal);
  let cut = false;
  const tick = async (): Promise<boolean> => (cut ||= await yielder());
  for (let i = 0; i < lineCount; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (checkLineSize && Buffer.byteLength(line, 'utf8') > RE2_MAX_INPUT_BYTES) {
      if (scanCtx.named) {
        // "File too large" would be false: the file fits, one line of it does not.
        throw new FsError(
          ErrorCode.TOO_LARGE,
          'A line in this file is too long for a regex search. Regex mode is used for isRegex or a case-insensitive search for non-ASCII text (or a file holding U+212A or U+017F); pass caseSensitive: true with a literal searchPattern.',
          entryPath,
        );
      }
      return new ScanSkip({ kind: 'tooLarge', size: buffer.length });
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
        content: own(clipLine(line, found.column)),
        matchCount: found.count,
        ...(scanCtx.context > 0
          ? {
              before: lines
                .slice(Math.max(0, i - scanCtx.context), i)
                .map((l) => own(clipLine(l, 0))),
              after: lines
                .slice(i + 1, Math.min(lineCount, i + 1 + scanCtx.context))
                .map((l) => own(clipLine(l, 0))),
            }
          : {}),
      });
      // One past the cap, so searchContent can tell a file was cut by it.
      if (matches.length > scanCtx.maxResults) break;
    }
  }
  return { matches, cut };
}

export async function searchContent(
  scope: ScanScope,
  pattern: string,
  options: SearchContentOptions,
  pathGuard: PathGuard,
): Promise<SearchContentOutcome> {
  const plan = planMatch(pattern, {
    isRegex: Boolean(options.isRegex),
    caseSensitive: Boolean(options.caseSensitive),
  });
  const source = plan.source;
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
    const context = options.context ?? 0;
    let filesMatched = 0;
    let matchingLines = 0;
    let trimmed = false;
    let cut = false;
    const scanCtx: ScanContext = {
      fs: new GuardedFileSystem(pathGuard),
      signal: options.signal,
      maxResults,
      regex,
      prefilter,
      literal: plan.literal,
      source,
      context,
      named: scope.explicitFile !== undefined,
    };
    const outcome = await scan<FileScan>(
      scope,
      {
        pathGuard,
        tool: 'search_text',
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
        weigh: (s) => s.matches.length,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (entry) => scanFile(entry.path, scanCtx),
    );

    for (const file of outcome.results) {
      if (file.matches.length > 0) filesMatched++;
      if (file.cut) cut = true;
      for (const match of file.matches) {
        if (matches.length >= maxResults) {
          trimmed = true;
          break;
        }
        matches.push(match);
        matchingLines++;
      }
    }
    const { skippedInaccessible, skippedTooLarge, skippedBinary } = outcome;
    // scan stops on a refused entry only; matches cut here are the cap too. Abort beats it.
    const stoppedReason =
      outcome.stoppedReason ??
      (cut ? ('timeout' as const) : trimmed ? ('maxResults' as const) : undefined);

    return {
      basePath: scope.root,
      matches,
      summary: {
        matchingLines,
        filesScanned: outcome.scanned,
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
