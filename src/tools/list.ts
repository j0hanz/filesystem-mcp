import { basename, posix } from 'node:path';

import * as z from 'zod/v4';

import { processEntriesConcurrently, withAbort } from '../core/concurrency.ts';
import { pageQueryKey, paginate } from '../core/cursor.ts';
import { ErrorCode, normalizeUnknownError, rethrowIfAborted } from '../core/errors.ts';
import { formatByteSize, formatCount, pageTrailer } from '../core/fmt.ts';
import type { GuardedFileSystem } from '../core/fs.ts';
import { globEntries, type GlobEntry } from '../core/glob.ts';
import { type EntryType, resolveEntryType, toPosixRelative } from '../core/path-utils.ts';
import type { PathGuard } from '../core/path.ts';
import {
  CursorSchema,
  defaultFalseBoolean,
  IncludeHidden,
  IncludeIgnored,
  mapOptionalPath,
  OptionalPath,
  PositiveInt,
} from '../core/schema.ts';
import type { JsonResourceResult } from '../core/store.ts';
import { putJsonResource } from '../core/store.ts';
import {
  DEFAULT_TREE_ENTRIES,
  MAX_LIST_ENTRIES,
  MAX_TREE_DEPTH,
  PARALLEL_CONCURRENCY,
} from '../core/util.ts';
import { defineTool } from './define.ts';

interface CollectedEntry {
  name: string;
  relativePath: string; // POSIX
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
  fs: GuardedFileSystem;
  onProgress: (progress: { current: number; total?: number }) => void;
}

interface CollectResult {
  entries: CollectedEntry[];
  totalEntries: number;
  totalFiles: number;
  totalDirectories: number;
  totalBytes?: number;
}

/** The entry's parent folder, relative like the entry; '' at the top level. */
function parentOf(entry: CollectedEntry): string {
  const slash = entry.relativePath.lastIndexOf('/');
  return slash === -1 ? '' : entry.relativePath.slice(0, slash);
}

// Compare by parent directory first (depth-level grouping), then within the
// same parent: directories first, then by size (descending) or alphabetical.
function entryComparator(sortBy: 'name' | 'size') {
  return (a: CollectedEntry, b: CollectedEntry): number => {
    const parentA = parentOf(a);
    const parentB = parentOf(b);
    if (parentA !== parentB) return parentA.localeCompare(parentB);
    const rankDiff = Number(b.type === 'directory') - Number(a.type === 'directory');
    if (rankDiff !== 0) return rankDiff;
    if (sortBy === 'size') {
      const sizeDiff = (b.size ?? 0) - (a.size ?? 0);
      if (sizeDiff !== 0) return sizeDiff;
    }
    return a.name.localeCompare(b.name);
  };
}

async function collect(rootPath: string, options: CollectOptions): Promise<CollectResult> {
  const entries: CollectedEntry[] = [];
  const wantSizes = options.includeSizes || options.sortBy === 'size';
  let scanned = 0;
  let totalEntries = 0;
  let totalFiles = 0;
  let totalDirectories = 0;
  let totalBytes = 0;
  let fatalError: Error | undefined;
  const { pathGuard } = options.fs;
  const ceiling = pathGuard.allowedRootContaining(rootPath);
  const comparator = entryComparator(options.sortBy);
  const keepBest = (): void => {
    entries.sort(comparator);
    if (entries.length > MAX_LIST_ENTRIES) entries.length = MAX_LIST_ENTRIES;
  };

  await processEntriesConcurrently<GlobEntry>(
    globEntries({
      cwd: rootPath,
      pattern: '**/*',
      skipIgnored: !options.includeIgnored,
      ...(ceiling !== undefined ? { ignoreCeiling: ceiling } : {}),
      signal: options.signal,
      pathGuard,
      includeHidden: options.includeHidden,
      // ListInputSchema.maxDepth is 1-based (1 = top-level only); the shared
      // globEntries primitive is now 0-based, so subtract one here. options.maxDepth
      // is guaranteed >= 1 by its PositiveInt schema, so this never underflows.
      maxDepth: options.maxDepth - 1,
      onlyFiles: false,
    }),
    {
      signal: options.signal,
      concurrency: PARALLEL_CONCURRENCY,
      onEntry: () => {
        scanned++;
        options.onProgress({ current: scanned });
      },
      onError: (_entryPath, err) => {
        fatalError ??= normalizeUnknownError(err);
      },
      runEntry: async (_entryPath, entry) => {
        const entryType: EntryType = resolveEntryType(entry.dirent);
        const relPath = toPosixRelative(rootPath, entry.path);
        const name = basename(relPath);
        // A sensitive-named directory never reaches the walk (globEntries
        // prunes it via pathGuard), so no ancestor re-check is needed here.

        const accessible = await pathGuard.isEntryAccessible(entry.path);
        if (!accessible) return;

        let size: number | undefined;
        if (wantSizes && entryType === 'file') {
          try {
            // Race the abort from the first await: the guarded stat validates the
            // path before statting, and that validation is not abort-aware, so
            // the race must wrap the whole call.
            const statted = await withAbort(
              options.fs.stat(entry.path, { signal: options.signal }),
              options.signal,
            );
            size = statted.stats.size;
          } catch (error) {
            rethrowIfAborted(error);
            // A file can vanish between the walk and the stat; it keeps its place, without a size.
          }
        }

        totalEntries++;
        if (entryType === 'directory') {
          totalDirectories++;
        } else if (entryType === 'file') {
          totalFiles++;
          if (size !== undefined) totalBytes += size;
        }

        entries.push({
          name,
          relativePath: relPath,
          type: entryType,
          ...(size !== undefined ? { size } : {}),
        });
        // Keep at most the best MAX_LIST_ENTRIES: prune whenever the buffer doubles,
        // so memory stays O(MAX_LIST_ENTRIES) and the sorts O(n log MAX_LIST_ENTRIES) overall.
        if (entries.length >= MAX_LIST_ENTRIES * 2) keepBest();
      },
    },
  );

  if (fatalError !== undefined) throw fatalError;
  options.signal.throwIfAborted();
  keepBest();

  return {
    entries,
    totalEntries,
    totalFiles,
    totalDirectories,
    ...(wantSizes ? { totalBytes } : {}),
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
      entries.push({ name: posix.basename(dir), relativePath: dir, type: 'directory' });
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
  )}, ${formatByteSize(totalBytes)} total`;
}

const DEFAULT_LIST_DEPTH = 1;

const ListInputSchema = z.strictObject({
  path: OptionalPath.describe('Directory to list (default: first allowed root)'),
  maxDepth: PositiveInt.max(MAX_TREE_DEPTH)
    .default(DEFAULT_LIST_DEPTH)
    .describe(
      `Max directory depth to traverse (default: ${String(DEFAULT_LIST_DEPTH)} = top-level only; increase to recurse deeper)`,
    ),
  maxEntries: PositiveInt.max(MAX_LIST_ENTRIES)
    .default(DEFAULT_TREE_ENTRIES)
    .describe(
      `Page size (default: ${String(DEFAULT_TREE_ENTRIES)}). Continue with nextCursor; an incomplete first page also carries resourceUri for the whole list.`,
    ),
  includeHidden: IncludeHidden,
  includeIgnored: IncludeIgnored,
  includeSizes: defaultFalseBoolean(
    'Show file sizes in the tree and a totals line of counts and bytes',
  ),
  sortBy: z
    .enum(['name', 'size'])
    .optional()
    .default('name')
    .describe('Order within each directory: name (default) or size (largest first)'),
  cursor: CursorSchema,
});

interface ListPageMetadata {
  readonly path: string;
  readonly totalEntries: number;
  readonly totalFiles: number;
  readonly totalDirectories: number;
  readonly totalBytes?: number;
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
    "List a directory's files and subdirectories as a tree of names, like ls or tree, one level deep unless maxDepth is raised. " +
    'Hidden entries are skipped unless includeHidden is set, and ignored ones ' +
    '(.gitignore matches, node_modules, dist, build, out, tmp) unless includeIgnored is set. ' +
    'includeSizes adds sizes and a total; stat returns dates; find_files searches by name pattern.',
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
    const resolvedPath = ctx.fs.pathGuard.resolvePathOrRoot(args.path);
    const renderOpts: RenderOptions = { includeSizes: args.includeSizes, sortBy: args.sortBy };
    const paged = await paginate<CollectedEntry, ListPageMetadata, JsonResourceResult>({
      store: ctx.pageStore,
      queryKey: pageQueryKey('list', { ...args, path: resolvedPath }, ['cursor', 'maxEntries']),
      cursor: args.cursor,
      pageSize: args.maxEntries,
      produce: async () => {
        const validDir = await ctx.fs.pathGuard.validateExistingDirectory(resolvedPath);
        const result = await collect(validDir, {
          ...renderOpts,
          maxDepth: args.maxDepth,
          includeHidden: args.includeHidden,
          includeIgnored: args.includeIgnored,
          signal: ctx.signal,
          fs: ctx.fs,
          onProgress: ctx.onProgress,
        });
        return {
          items: result.entries,
          metadata: {
            path: validDir,
            totalEntries: result.totalEntries,
            totalFiles: result.totalFiles,
            totalDirectories: result.totalDirectories,
            ...(result.totalBytes !== undefined ? { totalBytes: result.totalBytes } : {}),
          },
          truncated: result.totalEntries > result.entries.length,
        };
      },
      externalize: (entries, metadata) => {
        const name = basename(metadata.path);
        // The stored tree is the whole collected set, bounded by the hard cap.
        const fullOutput = {
          entries,
          markdown: renderMarkdown(
            treeHeader(ctx.fs.pathGuard, metadata.path),
            entries,
            renderOpts,
          ),
          totalEntries: metadata.totalEntries,
          totalFiles: metadata.totalFiles,
          totalDirectories: metadata.totalDirectories,
          ...(metadata.totalBytes !== undefined ? { totalBytes: metadata.totalBytes } : {}),
          ...(metadata.totalEntries > entries.length ? { truncated: true } : {}),
        };
        return putJsonResource(ctx.resourceStore, `${name} tree`, fullOutput);
      },
    });

    const structured: ListOutput = {
      ...paged.metadata,
      entries: [...paged.page],
      entryCount: paged.page.length,
      ...(paged.resource ? { resourceUri: paged.resource.entry.uri } : {}),
      ...(paged.nextCursor !== undefined ? { nextCursor: paged.nextCursor } : {}),
    };
    // The tree is what the model reads, so position and the full-list URI ride
    // the text too — paging needs no second lookup. `pageTrailer` is the one
    // owner of that line, and it owes it on the last page as much as the first.
    const sizesLine =
      paged.metadata.totalBytes !== undefined && args.includeSizes
        ? summaryLine(paged.metadata, paged.metadata.totalBytes)
        : '';
    const trailer = pageTrailer({
      offset: paged.offset,
      shown: structured.entryCount,
      total: structured.totalEntries,
      noun: 'entries',
      tool: 'list',
      nextCursor: structured.nextCursor,
      nextArgs: args,
      ...(structured.totalEntries > MAX_LIST_ENTRIES ? { stoppedReason: 'maxResults' } : {}),
    });
    const text =
      renderMarkdown(
        treeHeader(ctx.fs.pathGuard, paged.metadata.path),
        [...paged.page],
        renderOpts,
      ) +
      sizesLine +
      (sizesLine && trailer ? trailer.slice(1) : trailer) +
      (structured.resourceUri !== undefined ? `\nfull tree at ${structured.resourceUri}` : '');
    return {
      structured,
      text,
      ...(paged.resource ? { resources: [paged.resource.link] } : {}),
    };
  },
});
