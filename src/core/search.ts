import { stat as fsStat, readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { RE2ExecArray } from '@adguard/re2-wasm';
import { RE2 } from '@adguard/re2-wasm';

import { processEntriesConcurrently, resolveStopReason } from './concurrency.ts';
import { globEntries, type GlobEntry } from './glob.ts';
import type { PathGuard } from './path.ts';
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
 * Largest input one RE2 call may scan as a single string. The input is copied
 * into the same fixed 16 MB wasm heap as the patterns; about 10 MB of input
 * aborts the module. 4 MiB leaves room for the copy and the pattern set.
 */
export const RE2_MAX_INPUT_BYTES = 4 * MIB;

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
    /**
     * `StoppedReason` narrowed to the stops these scans can produce: both
     * resolve the stop through `resolveStopReason` (concurrency.ts) — never
     * `maxFiles`, which belongs to `replace_text`'s per-file cap.
     */
    stoppedReason?: 'maxResults' | 'timeout';
  };
}

type FileScan =
  | { kind: 'inaccessible' }
  | { kind: 'tooLarge' }
  | { kind: 'binary' }
  | { kind: 'scanned'; matches: SearchResult[] };

interface ScanContext {
  pathGuard: PathGuard;
  signal: AbortSignal | undefined;
  maxFileSize: number;
  maxResults: number;
  regex: Regex;
  prefilter: Regex;
  source: string;
  context: number;
}

async function scanFile(entryPath: string, scanCtx: ScanContext): Promise<FileScan> {
  try {
    await scanCtx.pathGuard.validateExistingPath(entryPath);
  } catch {
    return { kind: 'inaccessible' };
  }

  try {
    const stats = await fsStat(entryPath);
    if (stats.size > scanCtx.maxFileSize) return { kind: 'tooLarge' };
  } catch {
    return { kind: 'inaccessible' };
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(entryPath, { signal: scanCtx.signal });
  } catch (error) {
    if (scanCtx.signal?.aborted) throw error;
    return { kind: 'inaccessible' };
  }

  // A NUL byte marks a binary file, as it does for `read` and `grep -I`.
  // Non-UTF-8 text is still searched: a lossy decode only affects the
  // bytes a pattern could not have matched anyway.
  if (buffer.includes(0)) return { kind: 'binary' };

  const content = buffer.toString('utf-8');
  if (canPrefilter(scanCtx.source, buffer)) {
    scanCtx.prefilter.lastIndex = 0;
    if (scanCtx.prefilter.exec(content) === null) return { kind: 'scanned', matches: [] };
  }

  const lines = content.split(/\r?\n/u);
  // A trailing newline splits into a phantom empty last element, and an
  // empty file splits into one empty element: neither is a line the
  // file has, for matching or for context.
  const lineCount =
    content.length === 0 ? 0 : content.endsWith('\n') ? lines.length - 1 : lines.length;
  const matches: SearchResult[] = [];
  for (let i = 0; i < lineCount; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    // One scan per line: the helper resets lastIndex itself, so it
    // doubles as the "does this line match" test.
    const found = findLineMatches(scanCtx.regex, line);
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
      if (matches.length >= scanCtx.maxResults) break;
    }
  }
  return { kind: 'scanned', matches };
}

export async function searchContent(
  directory: string,
  pattern: string,
  options: SearchContentOptions,
  pathGuard: PathGuard,
): Promise<SearchContentOutcome> {
  const source = options.isRegex ? pattern || '' : escapeRegExp(pattern || '');
  const regex = compileRegex(source, {
    caseSensitive: Boolean(options.caseSensitive),
  });
  // Whole-buffer test: `m` makes ^/$ line-relative so a per-line hit is always a
  // buffer hit (the converse can be false — a false positive just falls through
  // to the per-line scan). \A/\z/\Z are buffer-relative even under `m`, inline
  // flag groups can undo `m`, and $ cannot see past a \r, so those inputs skip
  // the prefilter (see canPrefilter).
  const prefilter = compileRegex(source, {
    caseSensitive: Boolean(options.caseSensitive),
    multiline: true,
  });
  try {
    const matches: SearchResult[] = [];
    const maxResults = options.maxResults ?? 100;
    const maxFileSize = getMaxTextFileSize();
    const context = options.context ?? 0;
    const ceiling = pathGuard.allowedRootContaining(directory);

    const entries = options.explicitFile
      ? [{ path: options.explicitFile }]
      : globEntries({
          cwd: directory,
          pattern: options.filePattern ?? '**/*',
          // Same rule as replace_text, so a search with the same glob previews the
          // files a replace would touch: a slash-free glob matches at any depth.
          baseNameMatch: true,
          includeHidden: Boolean(options.includeHidden),
          skipIgnored: Boolean(options.skipIgnored),
          ...(ceiling !== undefined ? { ignoreCeiling: ceiling } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          maxDepth: options.maxDepth ?? 100,
          suppressErrors: true,
        });

    let filesScanned = 0;
    let filesMatched = 0;
    let matchingLines = 0;
    let skippedTooLarge = 0;
    let skippedBinary = 0;
    const scanCtx: ScanContext = {
      pathGuard,
      signal: options.signal,
      maxFileSize,
      maxResults,
      regex,
      prefilter,
      source,
      context,
    };
    const perFile = new Map<number, FileScan>();
    let dispatched = 0;
    let collected = 0;
    const stopped = await processEntriesConcurrently(entries, {
      signal: options.signal,
      concurrency: PARALLEL_CONCURRENCY,
      shouldStop: () => collected >= maxResults,
      onEntry: () => {
        dispatched++;
      },
      onError: () => undefined,
      runEntry: async (entryPath) => {
        const index = dispatched - 1;
        const scan = await scanFile(entryPath, scanCtx);
        perFile.set(index, scan);
        if (scan.kind === 'scanned') collected += scan.matches.length;
      },
    });

    let skippedInaccessible = 0;
    for (let i = 0; i < dispatched; i++) {
      const scan = perFile.get(i);
      if (!scan) continue;
      switch (scan.kind) {
        case 'inaccessible':
          skippedInaccessible++;
          break;
        case 'tooLarge':
          skippedTooLarge++;
          break;
        case 'binary':
          filesScanned++;
          skippedBinary++;
          break;
        case 'scanned':
          filesScanned++;
          if (scan.matches.length > 0) filesMatched++;
          for (const match of scan.matches) {
            if (matches.length >= maxResults) break;
            matches.push(match);
            matchingLines++;
          }
          break;
      }
    }

    const stoppedReason = resolveStopReason(
      matches.length >= maxResults,
      stopped === 'timeout' || Boolean(options.signal?.aborted),
    );

    return {
      basePath: directory,
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
    /** Narrowed like SearchContentOutcome's — scans never `maxFiles`. */
    stoppedReason?: 'maxResults' | 'timeout';
  };
}> {
  const maxResults = options.maxResults ?? 100;
  const ceiling = pathGuard.allowedRootContaining(directory);
  const entries = globEntries({
    cwd: directory,
    pattern,
    baseNameMatch: true,
    includeHidden: Boolean(options.includeHidden),
    skipIgnored: Boolean(options.skipIgnored),
    ...(ceiling !== undefined ? { ignoreCeiling: ceiling } : {}),
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

  // Same precedence as above: the result cap wins over a same-iteration abort.
  const stoppedReason = resolveStopReason(results.length >= maxResults, counters.stoppedByAbort);

  return {
    basePath: directory,
    results,
    summary: {
      matched: results.length,
      filesScanned,
      truncated: stoppedReason !== undefined,
      skippedInaccessible: counters.skippedInaccessible,
      ...(stoppedReason ? { stoppedReason } : {}),
    },
  };
}
