import { ErrorCode, FsError } from './errors.ts';
import { GuardedFileSystem } from './fs.ts';
import {
  createMatchEngine,
  isRe2Abort,
  type MatchEngine,
  MAX_MATCHES_PER_LINE,
  re2AbortError,
} from './matcher.ts';
import { Logger } from './observability.ts';
import type { PathGuard } from './path.ts';
import type { ExcludedDirs, ScanScope, StoppedReason } from './scan.ts';
import { readText, scan, ScanSkip, skipOf } from './scan.ts';
import { prefilterBytes, viewText } from './text-view.ts';
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
export function clipLine(line: string, column: number): string {
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
    excludedDirs?: ExcludedDirs;
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
  engine: MatchEngine;
  context: number;
  /** A file the client named: an overlong line refuses the call instead of skipping. */
  named: boolean;
}

/**
 * A RE2 abort is not the file being unreadable, which is what the Scan would
 * count a throw as. A named file fails the call with the reason; a walked file
 * counts as too large, and the log says what happened.
 */
async function scanFile(entryPath: string, scanCtx: ScanContext): Promise<FileScan | ScanSkip> {
  try {
    return await scanFileBody(entryPath, scanCtx);
  } catch (error) {
    if (!isRe2Abort(error)) throw error;
    if (scanCtx.named) throw re2AbortError(entryPath, error);
    Logger.warn(
      `Regex engine ran out of memory on ${entryPath}; regex search may keep failing until the server restarts.`,
    );
    // Only a named file's refusal reads the size, and that branch threw above.
    return new ScanSkip({ kind: 'tooLarge', size: 0 });
  }
}

async function scanFileBody(entryPath: string, scanCtx: ScanContext): Promise<FileScan | ScanSkip> {
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

  // The prefilter tests raw bytes, so it runs only where bytes and view text agree.
  const probe = prefilterBytes(buffer);
  if (probe !== undefined && !scanCtx.engine.mayMatch(probe)) return { matches: [] };
  // The Text view drops the BOM and, for an all-CRLF file, the CRs, so ^ and $ see lines.
  const content = viewText(buffer.toString('utf-8')).text;

  const matches: SearchResult[] = [];
  let lines: string[] | undefined;
  let lineCount = 0;
  // The line holding the current match: its 0-based index, start offset, and the next LF.
  let line = 0;
  let lineStart = 0;
  let nextLf = content.indexOf('\n');
  let hit: SearchResult | undefined;
  let cut = false;
  try {
    for await (const match of scanCtx.engine.matches(content, {
      ...(scanCtx.signal ? { signal: scanCtx.signal } : {}),
      path: entryPath,
      maxPerLine: MAX_MATCHES_PER_LINE,
    })) {
      while (nextLf !== -1 && nextLf < match.start) {
        line++;
        lineStart = nextLf + 1;
        nextLf = content.indexOf('\n', lineStart);
      }
      if (hit?.line === line + 1) {
        if (hit.matchCount < MAX_MATCHES_PER_LINE) hit.matchCount++;
        continue;
      }
      if (!lines) {
        lines = content.split(/\r?\n/u);
        // A trailing newline splits into a phantom empty last element, which is not a line.
        lineCount = content.endsWith('\n') ? lines.length - 1 : lines.length;
      }
      const text = lines[line] ?? '';
      const column = match.start - lineStart;
      hit = {
        file: entryPath,
        line: line + 1,
        column,
        content: own(clipLine(text, column)),
        matchCount: 1,
        ...(scanCtx.context > 0
          ? {
              before: lines
                .slice(Math.max(0, line - scanCtx.context), line)
                .map((l) => own(clipLine(l, 0))),
              after: lines
                .slice(line + 1, Math.min(lineCount, line + 1 + scanCtx.context))
                .map((l) => own(clipLine(l, 0))),
            }
          : {}),
      };
      matches.push(hit);
      // One past the cap, so searchContent can tell a file was cut by it.
      if (matches.length > scanCtx.maxResults) break;
    }
  } catch (error) {
    // The engine throws the signal's reason; scan cannot see the timeout, so report the cut.
    if (scanCtx.signal?.aborted) cut = true;
    else if (error instanceof FsError && error.code === ErrorCode.TOO_LARGE && !scanCtx.named) {
      return new ScanSkip({ kind: 'tooLarge', size: buffer.length });
    } else throw error;
  }
  return { matches, cut };
}

export async function searchContent(
  scope: ScanScope,
  pattern: string,
  options: SearchContentOptions,
  pathGuard: PathGuard,
): Promise<SearchContentOutcome> {
  const engine = createMatchEngine(pattern, {
    isRegex: Boolean(options.isRegex),
    caseSensitive: Boolean(options.caseSensitive),
  });
  try {
    // The engine compiles on first use; one empty line compiles it now, so an
    // invalid regex fails the request before any file is read.
    await engine.matches('\n').next();
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
      engine,
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
        ...(outcome.excludedDirs ? { excludedDirs: outcome.excludedDirs } : {}),
      },
    };
  } finally {
    engine.dispose();
  }
}
