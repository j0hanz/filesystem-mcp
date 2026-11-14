import { basename, posix } from 'node:path';

import * as z from 'zod/v4';

import { ErrorCode } from '../core/errors.ts';
import { formatByteSize, formatCount } from '../core/fmt.ts';
import { type EntryType, toPosixRelative } from '../core/path-utils.ts';
import type { PathGuard } from '../core/path.ts';
import { type ExcludedDirs, scan, type ScanScope, type StoppedReason } from '../core/scan.ts';
import {
  CursorSchema,
  defaultFalseBoolean,
  IncludeHidden,
  IncludeIgnored,
  mapOptionalPath,
  OptionalPath,
  PositiveInt,
} from '../core/schema.ts';
import { putJsonResource } from '../core/store.ts';
import {
  DEFAULT_TREE_ENTRIES,
  MAX_LIST_ENTRIES,
  MAX_TREE_DEPTH,
  PARALLEL_CONCURRENCY,
} from '../core/util.ts';
import { defineTool } from './define.ts';
import { pagedScan } from './paged-scan.ts';

interface CollectedEntry {
  name: string;
  relativePath: string; // POSIX
  parent: string;
  type: EntryType;
  size?: number;
}

interface RenderOptions {
  includeSizes: boolean;
  sortBy: 'name' | 'size';
}

interface CollectOptions extends RenderOptions {
  maxDepth: number;
  includeHidden: boolean;
  includeIgnored: boolean;
  signal: AbortSignal;
  pathGuard: PathGuard;
  onProgress: (progress: { current: number; total?: number }) => void;
}

export interface CollectResult {
  entries: CollectedEntry[];
  totalEntries: number;
  totalFiles: number;
  totalDirectories: number;
  totalBytes?: number;
  skippedInaccessible: number;
  stoppedReason?: StoppedReason;
  /** Directories at the depth limit, whose contents the walk did not reach. */
  unexpandedDirectories: number;
  ignoredDirs?: ExcludedDirs;
}

function parentOfRelative(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash === -1 ? '' : relativePath.slice(0, slash);
}

/** The entry's parent folder, relative like the entry; '' at the top level. */
function parentOf(entry: CollectedEntry): string {
  return entry.parent;
}

// Compare by parent directory first (depth-level grouping), then within the
// same parent: directories first, then by size (descending) or alphabetical.
function entryComparator(sortBy: 'name' | 'size') {
  return (a: CollectedEntry, b: CollectedEntry): number => {
    if (a.parent !== b.parent) return a.parent.localeCompare(b.parent);
    const rankDiff = Number(b.type === 'directory') - Number(a.type === 'directory');
    if (rankDiff !== 0) return rankDiff;
    if (sortBy === 'size') {
      const sizeDiff = (b.size ?? 0) - (a.size ?? 0);
      if (sizeDiff !== 0) return sizeDiff;
    }
    return a.name.localeCompare(b.name);
  };
}

async function collect(scope: ScanScope, options: CollectOptions): Promise<CollectResult> {
  const rootPath = scope.root;
  const entries: CollectedEntry[] = [];
  const wantSizes = options.includeSizes || options.sortBy === 'size';
  let totalEntries = 0;
  let totalFiles = 0;
  let totalDirectories = 0;
  let totalBytes = 0;
  let unexpandedDirectories = 0;
  const comparator = entryComparator(options.sortBy);
  const keepBest = (): void => {
    entries.sort(comparator);
    if (entries.length > MAX_LIST_ENTRIES) entries.length = MAX_LIST_ENTRIES;
  };

  // onEntry keeps the totals and the top-K buffer itself, so scan stores nothing.
  const outcome = await scan<never>(
    scope,
    {
      pathGuard: options.pathGuard,
      pattern: '**/*',
      baseNameMatch: false,
      includeHidden: options.includeHidden,
      includeIgnored: options.includeIgnored,
      onlyFiles: false,
      // ListInputSchema.maxDepth is 1-based (1 = top-level only); scan is
      // 0-based. options.maxDepth is >= 1 by its PositiveInt schema.
      maxDepth: options.maxDepth - 1,
      concurrency: PARALLEL_CONCURRENCY,
      // The walk runs on past the kept entries, so the totals stay exact.
      keep: MAX_LIST_ENTRIES,
      signal: options.signal,
      includeSizes: wantSizes,
      onScanned: (n) => {
        options.onProgress({ current: n });
      },
    },
    ({ path: entryPath, type: entryType, size }) => {
      const relPath = toPosixRelative(rootPath, entryPath);
      const name = basename(relPath);

      totalEntries++;
      if (entryType === 'directory') {
        totalDirectories++;
        if (relPath.split('/').length === options.maxDepth) unexpandedDirectories++;
      } else if (entryType === 'file') {
        totalFiles++;
        if (size !== undefined) totalBytes += size;
      }

      entries.push({
        name,
        relativePath: relPath,
        parent: parentOfRelative(relPath),
        type: entryType,
        ...(size !== undefined ? { size } : {}),
      });
      // Keep at most the best MAX_LIST_ENTRIES: prune whenever the buffer doubles,
      // so memory stays O(MAX_LIST_ENTRIES) and the sorts O(n log MAX_LIST_ENTRIES) overall.
      if (entries.length >= MAX_LIST_ENTRIES * 2) keepBest();
      return Promise.resolve(undefined);
    },
  );

  keepBest();

  return {
    entries,
    totalEntries,
    totalFiles,
    totalDirectories,
    ...(wantSizes ? { totalBytes } : {}),
    skippedInaccessible: outcome.skippedInaccessible,
    ...(outcome.stoppedReason ? { stoppedReason: outcome.stoppedReason } : {}),
    unexpandedDirectories,
    ...(outcome.ignoredDirs ? { ignoredDirs: outcome.ignoredDirs } : {}),
  };
}

const TEE = '├── ';
const ELBOW = '└── ';
const PIPE = '│   ';
const INDENT = '    ';

/**
 * The tree's first line names the listed folder the way the caller passes it
 * back: `src/core`, not `core`, which would name `<root>/core`. A root keeps
 * its own name.
 */
function treeHeader(pathGuard: PathGuard, dir: string): string {
  const paths = pathGuard.resultPaths(dir);
  return paths.atRoot ? basename(paths.root) : paths.show(dir);
}

function renderMarkdown(
  rootName: string,
  page: readonly CollectedEntry[],
  opts: RenderOptions,
): string {
  if (page.length === 0) return rootName;

  // The tree is drawn down from the root, but a later page (or a capped set)
  // can hold entries whose ancestors sat elsewhere; those would never be drawn.
  // Re-draw each missing ancestor as context so every entry stays locatable.
  const present = new Set(page.map((entry) => entry.relativePath));
  const entries = [...page];
  for (const entry of page) {
    for (
      let dir = posix.dirname(entry.relativePath);
      dir !== '.' && !present.has(dir);
      dir = posix.dirname(dir)
    ) {
      present.add(dir);
      entries.push({
        name: posix.basename(dir),
        relativePath: dir,
        parent: parentOfRelative(dir),
        type: 'directory',
      });
    }
  }
  entries.sort(entryComparator(opts.sortBy));
  const childrenOf = Map.groupBy(entries, parentOf);

  const lines: string[] = [rootName];

  function renderChildren(parentKey: string, prefix: string): void {
    const children = childrenOf.get(parentKey) ?? [];
    for (const [i, child] of children.entries()) {
      const isLast = i === children.length - 1;
      const sizeText =
        opts.includeSizes && child.size !== undefined ? ` (${formatByteSize(child.size)})` : '';
      lines.push(
        prefix +
          (isLast ? ELBOW : TEE) +
          child.name +
          (child.type === 'directory' ? '/' : '') +
          sizeText,
      );
      renderChildren(child.relativePath, prefix + (isLast ? INDENT : PIPE));
    }
  }

  renderChildren('', '');
  return lines.join('\n');
}

/** The `//` line `includeSizes` appends: counts and bytes over the whole collected set. */
function summaryLine(metadata: ListPageMetadata, totalBytes: number): string {
  return `\n\n// ${formatCount(metadata.totalFiles, 'file')}, ${formatCount(
    metadata.totalDirectories,
    'directory',
    'directories',
  )}, ${formatByteSize(totalBytes)} total`;
}

/** The kept-entries cap: the walk ran on, so the totals are exact and only the listing is cut. */
function keptNote(metadata: ListPageMetadata): string[] {
  return metadata.stoppedReason === 'maxResults'
    ? [
        `// kept the first ${String(MAX_LIST_ENTRIES)} of ${String(metadata.totalEntries)} entries; the totals are exact. Lower maxDepth or list a subfolder to see the rest.`,
      ]
    : [];
}

const DEFAULT_LIST_DEPTH = 1;

/** A raised maxDepth reads as the whole tree, so say what it stopped short of. */
function depthNote(maxDepth: number, unexpanded: number): string[] {
  if (maxDepth <= DEFAULT_LIST_DEPTH || unexpanded === 0) return [];
  return [
    `// depth limit ${String(maxDepth)}: contents of ${formatCount(unexpanded, 'directory', 'directories')} not listed or counted; raise maxDepth or list one directly.`,
  ];
}

function ignoredNote(ignored: ExcludedDirs | undefined): string[] {
  if (!ignored) return [];
  const rest = ignored.total - ignored.first.length;
  const more = rest > 0 ? `, +${String(rest)} more` : '';
  return [
    `// hid ${formatCount(ignored.total, 'ignored folder')} (${ignored.first.join(', ')}${more}); pass includeIgnored: true to list ${ignored.total === 1 ? 'it' : 'them'}.`,
  ];
}

const ListInputSchema = z.strictObject({
  path: OptionalPath.describe(
    'Directory to list (default: the only root; required with several roots)',
  ),
  maxDepth: PositiveInt.max(MAX_TREE_DEPTH)
    .default(DEFAULT_LIST_DEPTH)
    .describe(
      'Levels to walk; 1 = direct children. Directories at the limit are shown, not expanded.',
    ),
  maxEntries: PositiveInt.max(MAX_LIST_ENTRIES)
    .default(DEFAULT_TREE_ENTRIES)
    .describe('Entries per page; changing it keeps a cursor valid'),
  includeHidden: IncludeHidden,
  includeIgnored: IncludeIgnored.describe(
    'Include .gitignore matches and build and tool folders (node_modules, .git, dist, build, out, tmp, coverage)',
  ),
  includeSizes: defaultFalseBoolean(
    'Show file sizes and a totals line in the tree (stats every file, slower on big trees)',
  ),
  sortBy: z
    .enum(['name', 'size'])
    .optional()
    .default('name')
    .describe(
      'Order within each directory, after directories (size: largest file first; sizes appear only with includeSizes)',
    ),
  cursor: CursorSchema,
});

interface ListPageMetadata {
  readonly path: string;
  readonly totalEntries: number;
  readonly totalFiles: number;
  readonly totalDirectories: number;
  readonly totalBytes?: number;
  readonly skippedInaccessible?: number;
  readonly stoppedReason?: StoppedReason;
  readonly unexpandedDirectories: number;
  readonly ignoredDirs?: ExcludedDirs;
}

function listPageMetadata(path: string, result: CollectResult): ListPageMetadata {
  const { stoppedReason } = result;
  return {
    path,
    totalEntries: result.totalEntries,
    totalFiles: result.totalFiles,
    totalDirectories: result.totalDirectories,
    ...(result.totalBytes !== undefined ? { totalBytes: result.totalBytes } : {}),
    ...(result.skippedInaccessible > 0 ? { skippedInaccessible: result.skippedInaccessible } : {}),
    ...(stoppedReason ? { stoppedReason } : {}),
    unexpandedDirectories: result.unexpandedDirectories,
    ...(result.ignoredDirs ? { ignoredDirs: result.ignoredDirs } : {}),
  };
}

type ListOutput = ListPageMetadata & {
  entries: CollectedEntry[];
  entryCount: number;
  resourceUri?: string;
  nextCursor?: string;
};

export const LIST = defineTool<typeof ListInputSchema, ListOutput>({
  name: 'list',
  title: 'List',
  description:
    'List a directory inside the roots as a name tree, walking up to maxDepth levels. Use when you need to see what a folder holds. ' +
    'Do not use it to find files by name or glob; use `find_files` instead, `read` or `search_text` for contents, `stat` for one path. ' +
    'Skips hidden entries, .gitignore matches, and build and tool folders unless includeHidden or includeIgnored is set, naming the ignore-rule folders it hid. ' +
    'Folders at maxDepth are shown, but their contents are not listed or counted. ' +
    'At most 20,000 entries are kept. ' +
    'A timeout returns a partial result with stoppedReason. ' +
    'Errors: NOT_DIRECTORY for a file, ACCESS_DENIED outside the roots. ' +
    'Returns tree text, entries[{name, relativePath, type, size?}], totalEntries/Files/Directories, unexpandedDirectories, skippedInaccessible, and when cut nextCursor and resourceUri (about 60 s).',
  input: ListInputSchema,
  readOnlyHint: true,
  deadline: true,
  defaultErrorCode: ErrorCode.NOT_DIRECTORY,
  progress: (args) => ({
    label: 'List',
    subject: args.path ? basename(args.path) : '.',
  }),
  mapPaths: mapOptionalPath,
  run: async (args, ctx) => {
    const renderOpts: RenderOptions = { includeSizes: args.includeSizes, sortBy: args.sortBy };
    const listNotes = (metadata: ListPageMetadata): string[] => [
      ...keptNote(metadata),
      ...depthNote(args.maxDepth, metadata.unexpandedDirectories),
      ...ignoredNote(metadata.ignoredDirs),
    ];
    return await pagedScan({
      tool: 'list',
      args,
      ctx,
      pageSizeField: 'maxEntries',
      produce: async ({ scope }) => {
        const result = await collect(scope, {
          ...renderOpts,
          maxDepth: args.maxDepth,
          includeHidden: args.includeHidden,
          includeIgnored: args.includeIgnored,
          signal: ctx.signal,
          pathGuard: ctx.fs.pathGuard,
          onProgress: ctx.onProgress,
        });
        return {
          items: result.entries,
          metadata: listPageMetadata(scope.root, result),
          truncated:
            result.totalEntries > result.entries.length || result.stoppedReason !== undefined,
        };
      },
      externalize: (entries: readonly CollectedEntry[], metadata: ListPageMetadata) => {
        const name = basename(metadata.path);
        const notes = listNotes(metadata);
        // The stored tree is the whole collected set, bounded by the hard cap.
        const fullOutput = {
          entries,
          markdown:
            renderMarkdown(treeHeader(ctx.fs.pathGuard, metadata.path), entries, renderOpts) +
            (notes.length > 0 ? `\n\n${notes.join('\n')}` : ''),
          totalEntries: metadata.totalEntries,
          totalFiles: metadata.totalFiles,
          totalDirectories: metadata.totalDirectories,
          ...(metadata.totalBytes !== undefined ? { totalBytes: metadata.totalBytes } : {}),
          ...(metadata.skippedInaccessible !== undefined
            ? { skippedInaccessible: metadata.skippedInaccessible }
            : {}),
          ...(metadata.stoppedReason ? { stoppedReason: metadata.stoppedReason } : {}),
          unexpandedDirectories: metadata.unexpandedDirectories,
          ...(metadata.ignoredDirs ? { ignoredDirs: metadata.ignoredDirs } : {}),
          ...(metadata.totalEntries > entries.length || metadata.stoppedReason !== undefined
            ? { truncated: true }
            : {}),
        };
        return putJsonResource(ctx.resourceStore, `${name} tree`, fullOutput);
      },
      trailer: (metadata) => ({
        total: metadata.totalEntries,
        noun: 'entries',
        stoppedReason: metadata.stoppedReason === 'maxResults' ? undefined : metadata.stoppedReason,
        skippedInaccessible: metadata.skippedInaccessible,
        notes: listNotes(metadata),
      }),
      // The tree is what the model reads, so position and the full-list URI ride
      // the text too — paging needs no second lookup. `pageTrailer` is the one
      // owner of that line, and it owes it on the last page as much as the first.
      render: ({ page, metadata, trailer, resourceUri }) => {
        const sizesLine =
          metadata.totalBytes !== undefined && args.includeSizes
            ? summaryLine(metadata, metadata.totalBytes)
            : '';
        const structured: ListOutput = {
          ...metadata,
          entries: [...page],
          entryCount: page.length,
        };
        const text =
          renderMarkdown(treeHeader(ctx.fs.pathGuard, metadata.path), [...page], renderOpts) +
          sizesLine +
          (sizesLine && trailer ? trailer.slice(1) : trailer) +
          (resourceUri !== undefined ? `\nfull tree at ${resourceUri}` : '');
        return { structured, text };
      },
    });
  },
});
