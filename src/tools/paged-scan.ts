import type { ContentBlock } from '@modelcontextprotocol/server';

import { pageQueryKey, paginate, type ProducedPage } from '../core/cursor.ts';
import { pageTrailer } from '../core/fmt.ts';
import type { GuardedFileSystem } from '../core/fs.ts';
import type { ResultPaths } from '../core/path.ts';
import { resolveScanScope, type ScanScope } from '../core/scan.ts';
import type { JsonResourceResult } from '../core/store.ts';
import type { ToolCtx } from './define.ts';

/** The trailer facts only the tool knows: its totals, skips, stop reason and notes. */
export type PagedScanMeta = Omit<
  Parameters<typeof pageTrailer>[0],
  'offset' | 'shown' | 'tool' | 'nextCursor' | 'nextArgs'
>;

interface PagedArgs {
  readonly path?: string | undefined;
  readonly cursor?: string | undefined;
  readonly maxResults?: number | undefined;
  readonly maxEntries?: number | undefined;
}

/** What a paged scanning tool renders: the page, its place in the set, and the shared trailer. */
export interface PagedScanView<T, M> {
  readonly page: readonly T[];
  readonly metadata: M;
  readonly offset: number;
  readonly trailer: string;
  readonly nextCursor: string | undefined;
  readonly resourceUri: string | undefined;
}

/**
 * The paging lifecycle `list`, `find_files` and `search_text` share (ADR-016):
 * resolve the path once, key the snapshot by it, and only on a cache miss
 * resolve the Scan scope and run the tool's Scan. An incomplete first page
 * stores the whole set as a JSON resource. The result carries `nextCursor`,
 * `resourceUri` and the resource link without each tool repeating them.
 */
export async function pagedScan<T, M, S extends object>(options: {
  readonly tool: string;
  readonly args: PagedArgs;
  readonly ctx: Pick<ToolCtx, 'fs' | 'signal' | 'pageStore'>;
  /** The argument that sizes a page; it and `cursor` stay out of the snapshot key. */
  readonly pageSizeField?: 'maxResults' | 'maxEntries';
  /** Whether `path` may name one file instead of a directory. */
  readonly allowFile?: boolean;
  /**
   * Whether resolving the scope races the deadline. Off by default: a deadline
   * that already fired must reach the Scan and come back as a partial result.
   */
  readonly scopeSignal?: boolean;
  readonly produce: (scan: {
    readonly scope: ScanScope;
    readonly paths: ResultPaths;
    readonly fs: GuardedFileSystem;
  }) => Promise<ProducedPage<T, M>>;
  readonly externalize: (items: readonly T[], metadata: M) => JsonResourceResult;
  readonly trailer: (metadata: M, page: readonly T[]) => PagedScanMeta;
  readonly render: (view: PagedScanView<T, M>) => { structured: S; text: string };
}): Promise<{
  structured: S & { nextCursor?: string; resourceUri?: string };
  text: string;
  resources: ContentBlock[];
}> {
  const { tool, args, ctx, pageSizeField = 'maxResults' } = options;
  const pageSize = args[pageSizeField];
  if (pageSize === undefined) throw new TypeError(`${tool}: ${pageSizeField} has no value`);
  const resolvedPath = ctx.fs.pathGuard.resolvePathOrRoot(args.path);
  const paged = await paginate<T, M, JsonResourceResult>({
    store: ctx.pageStore,
    queryKey: pageQueryKey(tool, { ...args, path: resolvedPath }, ['cursor', pageSizeField]),
    cursor: args.cursor,
    pageSize,
    produce: async () => {
      const scope = await resolveScanScope(resolvedPath, ctx.fs, {
        allowFile: options.allowFile ?? false,
        ...(options.scopeSignal ? { signal: ctx.signal } : {}),
      });
      // Relative to the root, not to scope.root: `a.ts` from a search of
      // `src` would name `<root>/a.ts` when passed back.
      const paths = ctx.fs.pathGuard.resultPaths(scope.root);
      return await options.produce({ scope, paths, fs: ctx.fs });
    },
    externalize: options.externalize,
  });

  const resourceUri = paged.resource?.entry.uri;
  const trailer = pageTrailer({
    offset: paged.offset,
    shown: paged.page.length,
    tool,
    nextCursor: paged.nextCursor,
    nextArgs: args as Record<string, unknown>,
    ...options.trailer(paged.metadata, paged.page),
  });
  const { structured, text } = options.render({
    page: paged.page,
    metadata: paged.metadata,
    offset: paged.offset,
    trailer,
    nextCursor: paged.nextCursor,
    resourceUri,
  });
  return {
    structured: {
      ...structured,
      ...(resourceUri !== undefined ? { resourceUri } : {}),
      ...(paged.nextCursor !== undefined ? { nextCursor: paged.nextCursor } : {}),
    },
    text,
    resources: paged.resource ? [paged.resource.link] : [],
  };
}
