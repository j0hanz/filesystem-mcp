import * as z from 'zod/v4';

import { pageQueryKey, paginate } from '../core/cursor.ts';
import { formatCount, pageTrailer, truncateProgressPattern, zeroMatchHint } from '../core/fmt.ts';
import type { ResultPaths } from '../core/path.ts';
import { type ExcludedDirs, resolveScanScope, type StoppedReason } from '../core/scan.ts';
import {
  CursorSchema,
  defaultFalseBoolean,
  IncludeHidden,
  IncludeIgnored,
  mapOptionalPath,
  MaxDepth,
  nonBlankString,
  OptionalPath,
  SafeGlobPattern,
} from '../core/schema.ts';
import { searchContent } from '../core/search.ts';
import type { JsonResourceResult } from '../core/store.ts';
import { putJsonResource } from '../core/store.ts';
import { DEFAULT_SEARCH_CONTENT_RESULTS, MAX_SEARCH_RESULTS } from '../core/util.ts';
import { defineTool } from './define.ts';

// Type Definitions
type SearchResultValue = Awaited<ReturnType<typeof searchContent>>;
type SearchMatchPayload = SearchResultValue['matches'][number];
/** The engine's own summary, plus the root the match paths are relative to. */
type SearchContentPageMetadata = SearchResultValue['summary'] & {
  readonly root: string;
  /** Rides the snapshot: a cursor replay never reruns the scan. */
  readonly namedFile: boolean;
};

const GrepInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'File or directory to search (default: the only root). A named file is searched alone: pattern, maxDepth, and hidden/ignored filtering do not apply. Result paths are relative to the root, not to path.',
  ),
  pattern: SafeGlobPattern.optional().describe(
    'Glob limiting which files are searched: *.ts matches names at any depth, src/**/*.ts matches paths relative to path. Default: all files.',
  ),
  searchPattern: nonBlankString('searchPattern')
    .max(10000)
    .describe(
      'Text to find, literal unless isRegex is true. RE2 has no lookahead, lookbehind, or backreferences.',
    ),
  isRegex: defaultFalseBoolean('Treat searchPattern as an RE2 regex'),
  includeHidden: IncludeHidden,
  includeIgnored: IncludeIgnored,
  caseSensitive: defaultFalseBoolean(
    'Match case exactly. replace_text matches case by default, so pass true to preview what it will replace.',
  ),
  maxResults: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_CONTENT_RESULTS)
    .describe('Matching lines per page; context lines do not count. Later pages come via cursor.'),
  context: z
    .uint32()
    .max(10)
    .optional()
    .default(0)
    .describe('Lines shown before and after each match, like grep -C.'),
  maxDepth: MaxDepth,
  cursor: CursorSchema,
});

interface SearchOutput {
  /** The root `matches[].file` is relative to; a file that would not read back from it is absolute. */
  root: string;
  matches: SearchMatchPayload[];
  totalMatches?: number;
  filesMatched?: number;
  filesScanned?: number;
  skippedInaccessible?: number;
  skippedTooLarge?: number;
  skippedBinary?: number;
  excludedDirs?: ExcludedDirs;
  truncated?: boolean;
  stoppedReason?: StoppedReason;
  resourceUri?: string;
  nextCursor?: string;
}

function matchRow(m: SearchMatchPayload, namedFile: boolean): string {
  return `${namedFile ? '' : `${m.file}:`}${String(m.line)}: ${m.content}`;
}

/**
 * grep -C layout: `file-line- text` for a context line, `--` between groups
 * that are not adjacent. Every match's window lands in a per-file line map
 * where a match wins over context, so a line two windows share prints once,
 * and as a match when it is one. The maps iterate in line order without a
 * sort: matches arrive sorted, each window is contiguous, and setting an
 * existing key keeps its slot. Without context the rows are the bare match
 * lines, byte-identical to before the option existed. A named file prints its
 * path once, as a header, and its rows drop it.
 */
function renderRows(
  matches: readonly SearchMatchPayload[],
  withContext: boolean,
  namedFile: boolean,
): string[] {
  const [first] = matches;
  const header = namedFile && first ? [`// ${first.file}`] : [];
  if (!withContext) return [...header, ...matches.map((m) => matchRow(m, namedFile))];
  const byFile = new Map<string, Map<number, string>>();
  for (const m of matches) {
    const lines = byFile.get(m.file) ?? new Map<number, string>();
    byFile.set(m.file, lines);
    const setContext = (n: number, text: string): void => {
      if (!lines.has(n)) lines.set(n, `${namedFile ? '' : `${m.file}-`}${String(n)}- ${text}`);
    };
    const before = m.before ?? [];
    before.forEach((text, k) => {
      setContext(m.line - before.length + k, text);
    });
    lines.set(m.line, matchRow(m, namedFile));
    (m.after ?? []).forEach((text, k) => {
      setContext(m.line + 1 + k, text);
    });
  }
  const rows: string[] = [];
  for (const lines of byFile.values()) {
    let prev: number | undefined;
    for (const [n, row] of lines) {
      if (prev === undefined ? rows.length > 0 : n > prev + 1) rows.push('--');
      rows.push(row);
      prev = n;
    }
  }
  return [...header, ...rows];
}

function buildSearchMatchDetail(totalMatches: number, filesMatched: number): string {
  const matchDetail = formatCount(totalMatches, 'match', 'matches');
  if (filesMatched <= 0) return matchDetail;
  return `${matchDetail} · ${formatCount(filesMatched, 'file', 'files')}`;
}

function searchContentOutput(
  matches: readonly SearchMatchPayload[],
  metadata: SearchContentPageMetadata,
  nextCursor: string | undefined,
  resourceUri: string | undefined,
): SearchOutput {
  return {
    root: metadata.root,
    matches: [...matches],
    totalMatches: metadata.matchingLines,
    filesScanned: metadata.filesScanned,
    ...(metadata.filesMatched ? { filesMatched: metadata.filesMatched } : {}),
    ...(metadata.truncated ? { truncated: true } : {}),
    ...(metadata.stoppedReason !== undefined ? { stoppedReason: metadata.stoppedReason } : {}),
    ...(metadata.skippedInaccessible ? { skippedInaccessible: metadata.skippedInaccessible } : {}),
    ...(metadata.skippedTooLarge ? { skippedTooLarge: metadata.skippedTooLarge } : {}),
    ...(metadata.skippedBinary ? { skippedBinary: metadata.skippedBinary } : {}),
    ...(metadata.excludedDirs ? { excludedDirs: metadata.excludedDirs } : {}),
    ...(resourceUri !== undefined ? { resourceUri } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function buildSortedPayloads(result: SearchResultValue, paths: ResultPaths): SearchMatchPayload[] {
  const relativeByFile = new Map<string, string>();

  const getRelativeFile = (file: string): string => {
    const cached = relativeByFile.get(file);
    if (cached !== undefined) return cached;

    const rel = paths.show(file);
    relativeByFile.set(file, rel);
    return rel;
  };

  const payloads = result.matches.map((match): SearchMatchPayload => ({
    file: getRelativeFile(match.file),
    line: match.line,
    column: match.column,
    content: match.content,
    matchCount: match.matchCount,
    ...(match.before !== undefined ? { before: match.before } : {}),
    ...(match.after !== undefined ? { after: match.after } : {}),
  }));

  payloads.sort((l, r) => l.file.localeCompare(r.file) || l.line - r.line);
  return payloads;
}

export const SEARCH_TEXT = defineTool<typeof GrepInputSchema, SearchOutput>({
  name: 'search_text',
  title: 'Search Content',
  description:
    'Search file contents under the roots for literal text or an RE2 regex. Use when you need the files and lines that contain some text. ' +
    'Do not use it to find files by name; use `find_files` instead. ' +
    'A regex may span lines; the hit is on its first line. ' +
    'Skips hidden entries, .gitignore matches, and build folders unless includeHidden or includeIgnored. ' +
    'Lines over 1000 chars are clipped around the match. ' +
    'Stops early at 10000 matching lines or the timeout, setting stoppedReason. ' +
    'Returns root, `file:line: text` rows (a named file prints its path once), matches with column and context, totals, skip counts, nextCursor (expires after about 60 s), and resourceUri for a multi-page or stopped first page.',
  input: GrepInputSchema,
  readOnlyHint: true,
  deadline: true,
  progress: (args) => ({
    label: 'Search',
    subject: truncateProgressPattern(args.searchPattern),
  }),
  progressDone: (_args, result) => ({
    detail: buildSearchMatchDetail(result.totalMatches ?? 0, result.filesMatched ?? 0),
  }),
  mapPaths: mapOptionalPath,
  run: async (args, ctx) => {
    const requestedPath = ctx.fs.pathGuard.resolvePathOrRoot(args.path);
    const paged = await paginate<SearchMatchPayload, SearchContentPageMetadata, JsonResourceResult>(
      {
        store: ctx.pageStore,
        queryKey: pageQueryKey('search_text', { ...args, path: requestedPath }, [
          'cursor',
          'maxResults',
        ]),
        cursor: args.cursor,
        pageSize: args.maxResults,
        produce: async () => {
          const scope = await resolveScanScope(args.path, ctx.fs, {
            signal: ctx.signal,
            allowFile: true,
          });

          const result = await searchContent(
            scope,
            args.searchPattern,
            {
              includeHidden: args.includeHidden,
              filePattern: args.pattern ?? '**/*',
              caseSensitive: args.caseSensitive,
              isRegex: args.isRegex,
              maxResults: MAX_SEARCH_RESULTS,
              skipIgnored: !args.includeIgnored,
              context: args.context,
              ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
              signal: ctx.signal,
            },
            ctx.fs.pathGuard,
          );

          // Relative to the root, not to scope.root: `a.ts` from a search of
          // `src` would name `<root>/a.ts` when passed back.
          const paths = ctx.fs.pathGuard.resultPaths(scope.root);
          return {
            items: buildSortedPayloads(result, paths),
            metadata: {
              ...result.summary,
              root: paths.root,
              namedFile: scope.explicitFile !== undefined,
            },
            truncated: result.summary.truncated,
          };
        },
        externalize: (matches, metadata) =>
          putJsonResource(ctx.resourceStore, `'${args.searchPattern}' matches`, {
            ...searchContentOutput(matches, metadata, undefined, undefined),
          }),
      },
    );

    const structured = searchContentOutput(
      paged.page,
      paged.metadata,
      paged.nextCursor,
      paged.resource?.entry.uri,
    );
    const rows = renderRows(structured.matches, args.context > 0, paged.metadata.namedFile);
    const body =
      rows.length > 0
        ? rows.join('\n')
        : [
            `No matches for '${args.searchPattern}'`,
            zeroMatchHint({
              ...args,
              filesScanned: structured.filesScanned ?? 0,
              // Most trees hold a binary file, so one only explains the zero when
              // no text file was searched at all.
              incomplete:
                Boolean(
                  structured.stoppedReason ??
                  structured.skippedTooLarge ??
                  structured.skippedInaccessible ??
                  structured.excludedDirs,
                ) ||
                (structured.skippedBinary !== undefined &&
                  structured.skippedBinary === structured.filesScanned),
            }),
          ]
            .filter(Boolean)
            .join('\n');
    // A page that holds every match is the one case the pager's trailer does
    // not total, so the count line appears there and only there.
    const countLine =
      paged.metadata.matchingLines > 0 &&
      paged.offset === 0 &&
      structured.matches.length === paged.metadata.matchingLines
        ? `\n\n// ${buildSearchMatchDetail(paged.metadata.matchingLines, paged.metadata.filesMatched)}`
        : '';
    const text =
      body +
      countLine +
      pageTrailer({
        offset: paged.offset,
        shown: structured.matches.length,
        total: paged.metadata.matchingLines,
        noun: 'matches',
        tool: 'search_text',
        nextCursor: structured.nextCursor,
        nextArgs: args,
        stoppedReason: structured.stoppedReason,
        skippedTooLarge: structured.skippedTooLarge,
        skippedBinary: structured.skippedBinary,
        skippedInaccessible: structured.skippedInaccessible,
        excludedDirs: structured.excludedDirs,
      });
    return { structured, text, resources: paged.resource ? [paged.resource.link] : [] };
  },
});
