import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { pageQueryKey, paginate } from '../core/cursor.js';
import { ErrorCode } from '../core/errors.js';
import { pageTrailer } from '../core/fmt.js';
import type { EntryType } from '../core/glob.js';
import { globEntries } from '../core/glob.js';
import type { PathGuard } from '../core/path.js';
import { toPosixRelative } from '../core/path.js';
import { resolveEntryType } from '../core/primitives.js';
import {
  CursorSchema,
  FileType as FileTypeEnum,
  includeHiddenField,
  includeIgnoredField,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  PositiveInt,
} from '../core/schema.js';
import type { JsonResourceResult } from '../core/store.js';
import { putJsonResource } from '../core/store.js';
import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  DEFAULT_TREE_ENTRIES,
  MAX_LIST_ENTRIES,
  MAX_TREE_DEPTH,
} from '../core/util.js';
import { defineTool, type ToolCtx } from './define.js';

interface CollectedEntry {
  name: string;
  relativePath: string; // POSIX
  type: EntryType;
}

interface CollectOptions {
  maxDepth: number;
  includeHidden: boolean;
  includeIgnored: boolean;
  signal: AbortSignal;
  pathGuard: PathGuard;
  /** Upper bound on the stored, paginable entry array. */
  entryCap: number;
  onProgress?: (progress: { current: number; total?: number }) => void;
}

interface CollectResult {
  entries: CollectedEntry[];
  totalEntries: number;
  totalFiles: number;
  totalDirectories: number;
}

function entryTypeRank(type: EntryType): number {
  if (type === 'directory') return 0;
  return 1;
}

function compareEntries(a: CollectedEntry, b: CollectedEntry): number {
  // Compare by parent directory first (depth-level grouping)
  const slashA = a.relativePath.lastIndexOf('/');
  const slashB = b.relativePath.lastIndexOf('/');
  const parentA = slashA === -1 ? '' : a.relativePath.slice(0, slashA);
  const parentB = slashB === -1 ? '' : b.relativePath.slice(0, slashB);

  if (parentA !== parentB) return parentA.localeCompare(parentB);

  // Within same parent: dirs first, then alphabetical
  const rankDiff = entryTypeRank(a.type) - entryTypeRank(b.type);
  if (rankDiff !== 0) return rankDiff;
  return a.name.localeCompare(b.name);
}

async function collect(rootPath: string, options: CollectOptions): Promise<CollectResult> {
  const entries: CollectedEntry[] = [];
  let scanned = 0;
  let totalEntries = 0;
  let totalFiles = 0;
  let totalDirectories = 0;

  for await (const entry of globEntries({
    cwd: rootPath,
    pattern: '**/*',
    skipIgnored: !options.includeIgnored,
    signal: options.signal,
    includeHidden: options.includeHidden,
    baseNameMatch: false,
    // ListInputSchema.maxDepth is 1-based (1 = top-level only); the shared
    // globEntries primitive is now 0-based, so subtract one here. options.maxDepth
    // is guaranteed >= 1 by its PositiveInt schema, so this never underflows.
    maxDepth: options.maxDepth - 1,
    onlyFiles: false,
  })) {
    options.signal.throwIfAborted();
    scanned++;
    options.onProgress?.({ current: scanned });

    const entryType: EntryType = resolveEntryType(entry.dirent);
    const relPath = toPosixRelative(rootPath, entry.path);
    const name = basename(relPath);

    const accessible = await options.pathGuard.isEntryAccessible(entry.path);
    if (!accessible) continue;

    totalEntries++;
    if (entryType === 'directory') {
      totalDirectories++;
    } else {
      totalFiles++;
    }

    const collectedEntry: CollectedEntry = {
      name,
      relativePath: relPath,
      type: entryType,
    };

    if (entries.length < options.entryCap) {
      entries.push(collectedEntry);
    }
  }

  options.signal.throwIfAborted();
  entries.sort(compareEntries);

  return {
    entries,
    totalEntries,
    totalFiles,
    totalDirectories,
  };
}

const TEE = '├── ';
const ELBOW = '└── ';
const PIPE = '│   ';
const INDENT = '    ';

function renderMarkdown(rootName: string, entries: readonly CollectedEntry[]): string {
  if (entries.length === 0) return rootName;

  // Group entries by parent path
  const childrenOf = new Map<string, CollectedEntry[]>();
  for (const entry of entries) {
    const slash = entry.relativePath.lastIndexOf('/');
    const parentKey = slash === -1 ? '' : entry.relativePath.slice(0, slash);
    if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
    const children = childrenOf.get(parentKey);
    if (children) children.push(entry);
  }

  const lines: string[] = [rootName];

  function renderChildren(parentKey: string, prefix: string): void {
    const children = childrenOf.get(parentKey);
    if (!children) return;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child) continue;
      const isLast = i === children.length - 1;
      const connector = isLast ? ELBOW : TEE;
      lines.push(prefix + connector + child.name);

      const childKey = child.relativePath;
      const nextPrefix = prefix + (isLast ? INDENT : PIPE);
      renderChildren(childKey, nextPrefix);
    }
  }

  renderChildren('', '');
  return lines.join('\n');
}

const DEFAULT_LIST_DEPTH = 1;
const DEFAULT_LIST_ENTRIES = DEFAULT_TREE_ENTRIES;

const ListInputSchema = z.strictObject({
  path: OptionalPath.describe('Directory to list (default: first allowed root)'),
  maxDepth: PositiveInt.max(MAX_TREE_DEPTH)
    .default(DEFAULT_LIST_DEPTH)
    .describe(
      `Max directory depth to traverse (default: ${String(DEFAULT_LIST_DEPTH)} = top-level only; increase to recurse deeper)`,
    ),
  maxEntries: PositiveInt.max(MAX_LIST_ENTRIES)
    .default(DEFAULT_LIST_ENTRIES)
    .describe(
      `Page size (default: ${String(DEFAULT_LIST_ENTRIES)}). Continue with nextCursor; an incomplete first page also carries resourceUri for the whole list.`,
    ),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  cursor: CursorSchema,
});

const ListOutputSchema = z.strictObject({
  path: z.string().optional().describe('Resolved absolute path of the listed directory'),
  entries: z
    .array(
      z.strictObject({
        name: z.string().describe('Entry basename'),
        relativePath: z.string().describe('POSIX path relative to the listed directory'),
        type: FileTypeEnum.describe('Entry type: file, directory, symlink, or other'),
      }),
    )
    .describe('Inline directory entries sorted directories-first then alphabetically by name'),
  // No `markdown` field: the ASCII tree is the call's text content already, and
  // carrying it here too doubled every list response for a string the client
  // has in hand. The stored full-tree resource still holds its own copy — that
  // one is a *different* (uncapped) tree and is never sent inline.
  entryCount: NonNegInt.describe('Number of entries included in this response'),
  totalEntries: NonNegInt.describe('Total entries found before the maxEntries cap was applied'),
  totalFiles: NonNegInt.describe('Total number of files found'),
  totalDirectories: NonNegInt.describe('Total number of directories found'),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'URI to the full entry list in the resource store; first page only, whenever the response is ' +
        'incomplete — more pages follow, or the hard cap cut the listing. The stored list is itself ' +
        'bounded by that cap and marked truncated if exceeded.',
    ),
  nextCursor: NextCursorSchema,
});

interface ListPageMetadata {
  readonly path: string;
  readonly totalEntries: number;
  readonly totalFiles: number;
  readonly totalDirectories: number;
}

function listOutput(
  entries: readonly CollectedEntry[],
  metadata: ListPageMetadata,
  nextCursor: string | undefined,
  resourceUri: string | undefined,
): z.infer<typeof ListOutputSchema> {
  return {
    path: metadata.path,
    entries: [...entries],
    entryCount: entries.length,
    totalEntries: metadata.totalEntries,
    totalFiles: metadata.totalFiles,
    totalDirectories: metadata.totalDirectories,
    ...(resourceUri !== undefined ? { resourceUri } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

async function handleList(
  args: z.infer<typeof ListInputSchema>,
  ctx: ToolCtx,
): Promise<{
  structured: z.infer<typeof ListOutputSchema>;
  markdown: string;
  offset: number;
  link?: ContentBlock;
}> {
  const path = args.path;
  const resolvedPath = ctx.fs.pathGuard.resolvePathOrRoot(path);
  const queryKey = pageQueryKey({
    method: 'list',
    path: resolvedPath,
    maxDepth: args.maxDepth,
    includeHidden: args.includeHidden,
    includeIgnored: args.includeIgnored,
  });
  const { resourceStore } = ctx;

  const paged = await paginate<CollectedEntry, ListPageMetadata, JsonResourceResult>({
    store: ctx.pageStore,
    queryKey,
    cursor: args.cursor,
    pageSize: args.maxEntries,
    produce: async () => {
      const validDir = await ctx.fs.pathGuard.validateExistingDirectory(resolvedPath);
      const result = await collect(validDir, {
        maxDepth: args.maxDepth,
        includeHidden: args.includeHidden,
        includeIgnored: args.includeIgnored,
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(DEFAULT_SEARCH_TIMEOUT_MS)]),
        pathGuard: ctx.fs.pathGuard,
        entryCap: MAX_LIST_ENTRIES,
        ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
      });
      return {
        items: result.entries,
        metadata: {
          path: validDir,
          totalEntries: result.totalEntries,
          totalFiles: result.totalFiles,
          totalDirectories: result.totalDirectories,
        },
        truncated: result.totalEntries > result.entries.length,
      };
    },
    externalize: resourceStore
      ? (entries, metadata) => {
          const name = basename(metadata.path);
          // The stored tree is the whole collected set — itself bounded by the
          // hard cap, and marked when the cap cut it.
          const fullOutput = {
            entries,
            markdown: renderMarkdown(name, entries),
            totalEntries: metadata.totalEntries,
            totalFiles: metadata.totalFiles,
            totalDirectories: metadata.totalDirectories,
            ...(metadata.totalEntries > entries.length ? { truncated: true } : {}),
          };
          return putJsonResource(resourceStore, `${name} tree`, fullOutput);
        }
      : undefined,
  });

  return {
    structured: listOutput(paged.page, paged.metadata, paged.nextCursor, paged.resource?.entry.uri),
    markdown: renderMarkdown(basename(paged.metadata.path), [...paged.page]),
    offset: paged.offset,
    ...(paged.resource ? { link: paged.resource.link } : {}),
  };
}

export const LIST = defineTool({
  name: 'list',
  title: 'List',
  description:
    'List sorted directory entries and an ASCII tree. maxDepth=1 is top-level. ' +
    'maxEntries sets page size; continue with nextCursor. An incomplete first page also carries resourceUri for the whole list.',
  input: ListInputSchema,
  output: ListOutputSchema,
  // Not published: every field is a plainly-named scalar (`entryCount`,
  // `totalFiles`, `nextCursor`) that one sample response teaches, and the
  // schema costs 1599 chars of every session start. Publishing is reserved for
  // the value-XOR-error union shape a sample cannot convey.
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.NOT_DIRECTORY,
  progress: (args) => ({
    label: 'List',
    subject: args.path ? basename(args.path) : '.',
  }),
  accessPaths: (args) => (args.path ? [args.path] : []),
  run: async (args, ctx) => {
    const { structured, markdown, offset, link } = await handleList(args, ctx);
    // The tree is what the model reads, so position and the full-list URI ride
    // the text too — paging needs no second lookup. `pageTrailer` is the one
    // owner of that line, and it owes it on the last page as much as the first.
    const text =
      markdown +
      pageTrailer({
        offset,
        shown: structured.entryCount,
        total: structured.totalEntries,
        noun: 'entries',
        tool: 'list',
        nextCursor: structured.nextCursor,
      }) +
      (structured.resourceUri !== undefined ? `\nfull tree at ${structured.resourceUri}` : '');
    return {
      structured,
      text,
      ...(link ? { resources: [link] } : {}),
    };
  },
});
