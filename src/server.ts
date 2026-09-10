import type {
  Implementation,
  ServerCapabilities,
  ServerNotifier,
} from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';

import packageJson from '../package.json' with { type: 'json' };
import { requestStateCodec } from './core/input-required.js';
import { Logger } from './core/observability.js';
import { PageSnapshotStore } from './core/page-store.js';
import type { ServerOptions } from './core/path.js';
import { PathGuard } from './core/path.js';
import { ResourceStore } from './core/store.js';
import type { WatcherRegistry } from './core/watcher-registry.js';
import { INSTRUCTIONS_SUMMARY, INSTRUCTIONS_URI } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools/index.js';

// ═══════════════════════════════════════════════════════════════
// bootstrap
// ═══════════════════════════════════════════════════════════════

const {
  version: SERVER_VERSION,
  description: SERVER_DESCRIPTION,
  homepage: SERVER_HOMEPAGE,
} = packageJson;

export class FilesystemServerContext {
  public readonly mcp: McpServer;
  public readonly pathGuard: PathGuard;
  public readonly pages: PageSnapshotStore;
  /** False when the store is shared across instances and outlives this one. */
  private readonly ownsPages: boolean;
  private readonly resourceDisposable?: { dispose(): void } | undefined;
  private cleanedUp = false;

  constructor(
    mcp: McpServer,
    pathGuard: PathGuard,
    pages: PageSnapshotStore,
    ownsPages: boolean,
    resourceDisposable?: { dispose(): void },
  ) {
    this.mcp = mcp;
    this.pathGuard = pathGuard;
    this.pages = pages;
    this.ownsPages = ownsPages;
    this.resourceDisposable = resourceDisposable;
  }

  disposeRuntimeState(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    if (this.ownsPages) this.pages.clear();
    this.resourceDisposable?.dispose();
  }
}

export async function createServer(
  options: ServerOptions = {},
  extraDeps?: {
    /** Shared file-watcher registry for the modern (per-request) HTTP leg. */
    watcherRegistry?: WatcherRegistry;
    /** Modern-leg typed notification publisher. */
    notifier?: ServerNotifier;
    /**
     * Guard to use instead of constructing one. The HTTP leg builds a single
     * guard for the whole endpoint and passes it to every per-request instance,
     * so an accepted access grant survives the request that accepted it (R8) and
     * the listen-watcher path validates against the same allowed set. Omitted on
     * stdio, where the instance is pinned for the connection and owns its guard.
     */
    pathGuard?: PathGuard;
    /**
     * Store to use instead of constructing one. The HTTP modern leg shares one
     * store across every per-request instance, so a result a tool externalized
     * in one POST survives to the follow-up resources/read. Omitted on stdio,
     * where the pinned instance owns its store for the connection.
     */
    resourceStore?: ResourceStore;
    /**
     * Pagination snapshots shared by every modern HTTP request. Omitted on
     * stdio, where the connection-owned context clears its store on close.
     */
    pageStore?: PageSnapshotStore;
    /** The protocol era this instance serves; omitted where the caller does not know. */
    era?: 'legacy' | 'modern';
    /**
     * The resolved HTTP credential, from `--api-key` or `API_KEY`. Lives here
     * rather than on `ServerOptions` because that object is `PathGuard`'s
     * constructor argument and is exposed on its public `options` field — a
     * bearer secret has no business being reachable from a tool handler.
     */
    apiKey?: string;
  },
): Promise<FilesystemServerContext> {
  // `resources.subscribe` stays advertised on both eras: the verb itself is
  // 2025-only, but with enforceStrictCapabilities the SDK also gates outbound
  // `notifications/resources/updated` — which the modern `subscriptions/listen`
  // stream delivers — on this same capability bit.
  const capabilities = {
    resources: { subscribe: true, listChanged: true },
    tools: {},
    prompts: {},
    completions: {},
  } satisfies ServerCapabilities;

  const cacheScope: 'private' | 'public' = extraDeps?.apiKey ? 'private' : 'public';
  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
    capabilities,
    enforceStrictCapabilities: true,
    cacheHints: {
      'tools/list': { ttlMs: 3_600_000, cacheScope },
      'prompts/list': { ttlMs: 3_600_000, cacheScope },
      // Always private, never `cacheScope`: this list enumerates the
      // ResourceStore, so its entries are one caller's externalized tool output
      // — the same entries whose own read hint is `private` (resources.ts). The
      // other four lists are the same for every caller and follow the key, and
      // they are built from frozen module-level arrays that cannot change at
      // runtime, so an hour is honest: a shorter hint only buys the client a
      // re-fetch of bytes that cannot have differed, at the cost of the prompt
      // cache stability the spec asks deterministic ordering to preserve.
      'resources/list': { ttlMs: 30_000, cacheScope: 'private' },
      'resources/templates/list': { ttlMs: 3_600_000, cacheScope },
      'server/discover': { ttlMs: 3_600_000, cacheScope },
    },
    // Multi-round-trip `requestState` integrity (protocol revision 2026-07-28):
    // the codec verifies the HMAC on every retried round before the handler
    // runs, so a tampered or expired state is rejected as `-32602` rather than
    // trusted. The decoded `PendingState` reaches handlers via
    // `ctx.mcpReq.requestState<T>()`.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    requestState: { verify: requestStateCodec.verify },
  };

  serverConfig.instructions =
    `${INSTRUCTIONS_SUMMARY} ` +
    `For full guidance, read ${INSTRUCTIONS_URI} or run the get-help prompt.`;

  const implementation: Implementation = {
    name: 'filesystem-mcp',
    title: 'Filesystem MCP',
    version: SERVER_VERSION,
    ...(SERVER_DESCRIPTION ? { description: SERVER_DESCRIPTION } : {}),
    ...(SERVER_HOMEPAGE ? { websiteUrl: SERVER_HOMEPAGE } : {}),
  };
  const server = new McpServer(implementation, serverConfig);
  server.server.fallbackNotificationHandler = (notification) => {
    Logger.debug('Unhandled client notification', { method: notification.method });
    return Promise.resolve();
  };

  // A failed send means the connection went away; nothing to recover.
  const resourceStore =
    extraDeps?.resourceStore ??
    new ResourceStore(() => {
      if (extraDeps?.notifier) {
        extraDeps.notifier.resourcesChanged();
        return;
      }
      void server.server.sendResourceListChanged().catch((error: unknown) => {
        Logger.debug('resource list_changed not delivered', { error: String(error) });
      });
    });
  const pageStore = extraDeps?.pageStore ?? new PageSnapshotStore();

  const pathGuard = extraDeps?.pathGuard ?? new PathGuard(options);
  // Recompute once per guard, keyed on the guard's own state rather than on
  // whether it was injected — an injected-but-uninitialized guard would
  // otherwise deny every path. Not unconditional: the HTTP leg shares one guard
  // across a fresh instance per request, and a repeat recompute would both redo
  // the root resolution per request and race a concurrent `applyGrant`, which
  // commits under a mutation lock this call does not take.
  if (!pathGuard.isInitialized()) await pathGuard.recomputeAllowedDirectories();

  const deps = {
    server,
    pathGuard,
    pageStore,
    resourceStore,
    cacheScope,
    ...(options.readOnly ? { readOnly: true } : {}),
    ...(extraDeps?.watcherRegistry ? { watcherRegistry: extraDeps.watcherRegistry } : {}),
    ...(extraDeps?.notifier ? { notifier: extraDeps.notifier } : {}),
    ...(extraDeps?.era ? { era: extraDeps.era } : {}),
  };

  const resourceDisposable = registerResources(deps);
  registerPrompts(deps);
  registerTools(deps);

  return new FilesystemServerContext(
    server,
    pathGuard,
    pageStore,
    extraDeps?.pageStore === undefined,
    resourceDisposable,
  );
}
