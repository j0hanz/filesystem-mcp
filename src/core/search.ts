import type { StoppedReason } from './concurrency.ts';
import { ErrorCode, isFsError } from './errors.ts';
import { GuardedFileSystem } from './fs.ts';
import { createLineMatcher, type LineHit, type LineMatcher } from './matcher.ts';
import type { PathGuard } from './path.ts';
import type { ScanScope } from './scan.ts';
import { readText, scan } from './scan.ts';
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

type FileScan =
  | { kind: 'tooLarge' }
  | { kind: 'binary' }
  /** `cut`: the signal stopped this file's lines short, so scan cannot see the timeout. */
  | { kind: 'scanned'; matches: SearchResult[]; cut?: boolean };

interface ScanContext {
  fs: GuardedFileSystem;
  signal: AbortSignal | undefined;
  maxResults: number;
  matcher: LineMatcher;
  context: number;
}

async function scanFile(entryPath: string, scanCtx: ScanContext): Promise<FileScan> {
  // No catch: scan counts a failed entry as inaccessible, or fails the call for a named file.
  const verdict = await readText(scanCtx.fs, entryPath, scanCtx.signal);
  if (verdict.kind === 'tooLarge' || verdict.kind === 'binary') return { kind: verdict.kind };
  const buffer = verdict.bytes;
  // A NUL byte past the leading bytes still marks a binary file, as it does
  // for `grep -I`. Other non-UTF-8 text is still searched: a lossy decode
  // only affects the bytes a pattern could not have matched anyway.
  if (verdict.kind === 'undecodable' && buffer.includes(0)) return { kind: 'binary' };

  const fileMatcher = scanCtx.matcher.forFile(buffer);
  if (!fileMatcher) return { kind: 'scanned', matches: [] };

  const content = buffer.toString('utf-8');
  const lines = content.split(/\r?\n/u);
  // A trailing newline splits into a phantom empty last element, and an
  // empty file splits into one empty element: neither is a line the
  // file has, for matching or for context.
  const lineCount =
    content.length === 0 ? 0 : content.endsWith('\n') ? lines.length - 1 : lines.length;
  const matches: SearchResult[] = [];
  let cut = false;
  for (let i = 0; i < lineCount; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    // Yield between lines too: millions of short lines never yield per-match.
    if (await scanCtx.matcher.tick()) {
      cut = true;
      break;
    }
    let found: LineHit | undefined;
    try {
      found = await fileMatcher.matchLine(line);
    } catch (err) {
      if (isFsError(err) && err.code === ErrorCode.TOO_LARGE) {
        return { kind: 'tooLarge' };
      }
      throw err;
    }
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
  return { kind: 'scanned', matches, cut };
}

export async function searchContent(
  scope: ScanScope,
  pattern: string,
  options: SearchContentOptions,
  pathGuard: PathGuard,
): Promise<SearchContentOutcome> {
  const matcher = createLineMatcher({
    pattern,
    isRegex: Boolean(options.isRegex),
    caseSensitive: Boolean(options.caseSensitive),
    signal: options.signal,
  });
  try {
    const matches: SearchResult[] = [];
    const maxResults = options.maxResults ?? 100;
    const context = options.context ?? 0;
    let filesScanned = 0;
    let filesMatched = 0;
    let matchingLines = 0;
    let skippedTooLarge = 0;
    let skippedBinary = 0;
    let trimmed = false;
    let cut = false;
    const scanCtx: ScanContext = {
      fs: new GuardedFileSystem(pathGuard),
      signal: options.signal,
      maxResults,
      matcher,
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
          if (file.cut) cut = true;
          for (const match of file.matches) {
            if (matches.length >= maxResults) {
              trimmed = true;
              break;
            }
            matches.push(match);
            matchingLines++;
          }
          break;
      }
    }
    const { skippedInaccessible } = outcome;
    // scan stops on a refused entry only; matches cut here are the cap too. Abort beats it.
    const stoppedReason =
      outcome.stoppedReason ??
      (cut ? ('timeout' as const) : trimmed ? ('maxResults' as const) : undefined);

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
    matcher.dispose();
  }
}
