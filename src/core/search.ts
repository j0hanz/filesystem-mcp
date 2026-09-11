import { stat as fsStat, readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { RE2ExecArray } from '@adguard/re2-wasm';
import { RE2 } from '@adguard/re2-wasm';

import { StopReasonTracker } from './concurrency.js';
import { globEntries, type GlobEntry } from './glob.js';
import type { PathGuard } from './path.js';
import { escapeRegexLiteral } from './primitives.js';
import { getMaxTextFileSize } from './util.js';

interface SearchResult {
  file: string;
  line: number;
  /** 0-indexed column of the first occurrence on the line. */
  column: number;
  content: string;
  matchCount?: number;
}

export type Regex = RE2;
export interface RegexCompileOptions {
  caseSensitive?: boolean;
}

/** Occurrence-counting bound, so one pathological line cannot spin forever. */
const MAX_MATCHES_PER_LINE = 100_000;

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
export function compileRegex(pattern: string, options: RegexCompileOptions = {}): Regex {
  const flags = options.caseSensitive ? 'gu' : 'giu';
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
function codePointLength(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    if ((text.charCodeAt(i) & 0xfc00) === 0xd800 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      i++;
    }
    length++;
  }
  return length;
}

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
function findLineMatches(
  regex: Regex,
  line: string,
): { count: number; column: number } | undefined {
  let count = 0;
  let column = -1;
  for (const match of execMatches(regex, line)) {
    if (column === -1) column = match.start;
    count++;
    if (count >= MAX_MATCHES_PER_LINE) break;
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
    /**
     * `StoppedReason` narrowed to the stops these scans can produce: both call
     * only `hitMaxResults`/`hitAbort` (see concurrency.ts) — never
     * `hitMaxFiles`, which belongs to `replace_text`'s per-file cap.
     */
    stoppedReason?: 'maxResults' | 'timeout';
  };
}

export async function searchContent(
  directory: string,
  pattern: string,
  options: SearchContentOptions,
  pathGuard: PathGuard,
): Promise<SearchContentOutcome> {
  const regex = compileRegex(options.isRegex ? pattern || '' : escapeRegexLiteral(pattern || ''), {
    caseSensitive: Boolean(options.caseSensitive),
  });
  try {
    const matches: SearchResult[] = [];
    const maxResults = options.maxResults ?? 100;
    const maxFileSize = getMaxTextFileSize();

    const entries = globEntries({
      cwd: directory,
      pattern: options.filePattern ?? '**/*',
      includeHidden: Boolean(options.includeHidden),
      skipIgnored: Boolean(options.skipIgnored),
      ...(options.signal ? { signal: options.signal } : {}),
      maxDepth: options.maxDepth ?? 100,
      suppressErrors: true,
    });

    let filesScanned = 0;
    let filesMatched = 0;
    let matchingLines = 0;
    let skippedTooLarge = 0;
    const counters = { skippedInaccessible: 0, stoppedByAbort: false };

    for await (const entry of guardedEntries(entries, pathGuard, options.signal, counters)) {
      if (matches.length >= maxResults) break;

      // Skip oversized files before reading to avoid unbounded memory use. Count
      // them: "no matches" for a reason other than the pattern must be visible.
      try {
        const stats = await fsStat(entry.path);
        if (stats.size > maxFileSize) {
          skippedTooLarge++;
          continue;
        }
      } catch {
        counters.skippedInaccessible++;
        continue;
      }

      filesScanned++;

      try {
        const content = await readFile(entry.path, { encoding: 'utf-8', signal: options.signal });
        const lines = content.split('\n');
        let matchedFile = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line === undefined) continue;
          // One scan per line: findLineMatches resets lastIndex itself, so it
          // doubles as the "does this line match" test.
          const found = findLineMatches(regex, line);
          if (found) {
            matchedFile = true;
            matchingLines++;
            matches.push({
              file: entry.path,
              line: i + 1,
              column: found.column,
              content: line,
              matchCount: found.count,
            });
            if (matches.length >= maxResults) break;
          }
        }
        if (matchedFile) filesMatched++;
      } catch {
        // A read failure while the signal is aborted IS the abort, not an
        // unreadable file — stop rather than spend another iteration and then
        // report a cut-short scan as complete.
        if (options.signal?.aborted) {
          counters.stoppedByAbort = true;
          break;
        }
        // ignore read errors (e.g. binary files)
      }
    }

    const tracker = new StopReasonTracker();
    if (matches.length >= maxResults) tracker.hitMaxResults();
    if (counters.stoppedByAbort) tracker.hitAbort();
    // resolve() is StoppedReason | undefined, but this scan only records
    // maxResults/timeout stops (see the summary type's narrowing note).
    const stoppedReason = tracker.resolve() as 'maxResults' | 'timeout' | undefined;

    return {
      basePath: directory,
      matches,
      summary: {
        matchingLines,
        filesScanned,
        filesMatched,
        truncated: tracker.truncated,
        skippedInaccessible: counters.skippedInaccessible,
        skippedTooLarge,
        ...(stoppedReason ? { stoppedReason } : {}),
      },
    };
  } finally {
    freeRegex(regex);
  }
}

async function* guardedEntries(
  entries: AsyncIterable<GlobEntry>,
  pathGuard: PathGuard,
  signal: AbortSignal | undefined,
  counters: { skippedInaccessible: number; stoppedByAbort: boolean },
): AsyncGenerator<GlobEntry> {
  // The signal carries both client cancellation and the tool's search timeout,
  // so an abort means "return what we have, marked incomplete" rather than
  // throw — but it must never be reported as a finished scan.
  for await (const entry of entries) {
    if (signal?.aborted) {
      counters.stoppedByAbort = true;
      return;
    }
    try {
      await pathGuard.validateExistingPath(entry.path);
    } catch {
      counters.skippedInaccessible++;
      continue;
    }
    yield entry;
  }
}

export async function searchFiles(
  directory: string,
  pattern: string,
  options: {
    maxResults?: number;
    includeHidden?: boolean;
    sortBy?: 'name' | 'path';
    skipIgnored?: boolean;
    maxDepth?: number;
    signal?: AbortSignal;
  },
  pathGuard: PathGuard,
): Promise<{
  basePath: string;
  results: { path: string }[];
  summary: {
    matched: number;
    filesScanned: number;
    truncated: boolean;
    skippedInaccessible: number;
    /** Narrowed like SearchContentOutcome's — scans never hit `hitMaxFiles`. */
    stoppedReason?: 'maxResults' | 'timeout';
  };
}> {
  const maxResults = options.maxResults ?? 100;
  const entries = globEntries({
    cwd: directory,
    pattern,
    includeHidden: Boolean(options.includeHidden),
    skipIgnored: Boolean(options.skipIgnored),
    ...(options.signal ? { signal: options.signal } : {}),
    maxDepth: options.maxDepth ?? 100,
    suppressErrors: true,
  });
  const results: { path: string }[] = [];
  let filesScanned = 0;
  const counters = { skippedInaccessible: 0, stoppedByAbort: false };

  for await (const entry of guardedEntries(entries, pathGuard, options.signal, counters)) {
    if (results.length >= maxResults) break;
    filesScanned++;
    results.push({ path: entry.path });
  }

  // Sorting — only name / path are supported; size / modified were removed
  // (the glob never collected stats, so they were always undefined).
  if (options.sortBy === 'name') {
    results.sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
  } else {
    results.sort((a, b) => a.path.localeCompare(b.path));
  }

  const tracker = new StopReasonTracker();
  if (results.length >= maxResults) tracker.hitMaxResults();
  if (counters.stoppedByAbort) tracker.hitAbort();
  // resolve() is StoppedReason | undefined, but this scan only records
  // maxResults/timeout stops (see the summary type's narrowing note).
  const stoppedReason = tracker.resolve() as 'maxResults' | 'timeout' | undefined;

  return {
    basePath: directory,
    results,
    summary: {
      matched: results.length,
      filesScanned,
      truncated: tracker.truncated,
      skippedInaccessible: counters.skippedInaccessible,
      ...(stoppedReason ? { stoppedReason } : {}),
    },
  };
}
