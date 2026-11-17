import type {
  Implementation,
  ServerCapabilities,
  ServerNotifier,
} from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';

import packageJson from '../package.json' with { type: 'json' };
import { formatUnknownErrorMessage } from './core/errors.ts';
import { requestStateCodec } from './core/input-required.ts';
import { Logger, voidSend } from './core/observability.ts';
import { MAX_OUTBOUND_RESULT_BYTES } from './core/outbound.ts';
import type { ServerOptions } from './core/path.ts';
import { PathGuard } from './core/path.ts';
import { PageSnapshotStore, ResourceStore } from './core/store.ts';
import { UndoJournal } from './core/undo.ts';
import { MAX_TOOL_INPUT_ELEMENTS } from './core/util.ts';
import { createWatcherRegistry, type WatcherRegistry } from './core/watcher-registry.ts';
import { INSTRUCTIONS_SUMMARY, INSTRUCTIONS_URI } from './instructions.ts';
import { registerPrompts } from './prompts.ts';
import { registerResources } from './resources.ts';
import { registerTools } from './tools/index.ts';

// ═══════════════════════════════════════════════════════════════
// bootstrap
// ═══════════════════════════════════════════════════════════════

const {
  version: SERVER_VERSION,
  description: SERVER_DESCRIPTION,
  homepage: SERVER_HOMEPAGE,
} = packageJson;

export interface FilesystemServerContext {
  readonly mcp: McpServer;
  readonly pathGuard: PathGuard;
  disposeRuntimeState(): void;
}

/** The state that outlives one `McpServer` instance: an endpoint's or a connection's. */
export interface RuntimeState {
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore;
  readonly pageStore: PageSnapshotStore;
  readonly undoJournal: UndoJournal;
  readonly watcherRegistry: WatcherRegistry;
  /** Cleans up every owned part; never throws, and retries only failed parts on later calls. */
  dispose(): void;
}

interface OwnedCleanup {
  readonly label: string;
  readonly run: () => void;
  done: boolean;
}

/** Window that folds a burst of ResourceStore list-changed signals into one. */
export const RESOURCES_CHANGED_DEBOUNCE_MS = 100;

export function createRuntimeState(
  options: ServerOptions = {},
  hooks: {
    /** ResourceStore list-changed callback; read the live server lazily. */
    onResourcesChanged?: () => void;
    /** ResourceStore read cap; stdio passes MAX_OUTBOUND_RESULT_BYTES. */
    maxReadResultBytes?: number | undefined;
  } = {},
): RuntimeState {
  const watcherRegistry = createWatcherRegistry();
  const pageStore = new PageSnapshotStore();
  const undoJournal = new UndoJournal();
  let disposed = false;
  let changedTimer: NodeJS.Timeout | undefined;
  // Trailing edge: the first change arms the timer, later ones ride on it.
  // The modern HTTP leg has no SDK-side coalescing, so do it here.
  const onChanged = hooks.onResourcesChanged;
  const resourceStore = new ResourceStore(
    onChanged &&
      (() => {
        if (changedTimer || disposed) return;
        changedTimer = setTimeout(() => {
          changedTimer = undefined;
          if (!disposed) onChanged();
        }, RESOURCES_CHANGED_DEBOUNCE_MS).unref();
      }),
    hooks.maxReadResultBytes,
  );
  // Closures read the live method at call time.
  const cleanups: OwnedCleanup[] = [
    {
      label: 'change timer',
      run: () => {
        clearTimeout(changedTimer);
        changedTimer = undefined;
      },
      done: false,
    },
    {
      label: 'watcher registry',
      run: () => {
        watcherRegistry.destroy();
      },
      done: false,
    },
    {
      label: 'page store',
      run: () => {
        pageStore.clear();
      },
      done: false,
    },
    {
      label: 'undo journal',
      run: () => {
        undoJournal.clear();
      },
      done: false,
    },
    {
      label: 'resource store',
      run: () => {
        resourceStore.clear();
      },
      done: false,
    },
  ];
  return {
    pathGuard: new PathGuard(options),
    resourceStore,
    pageStore,
    undoJournal,
    watcherRegistry,
    dispose() {
      // First call stops notifications even if a cleanup below fails.
      disposed = true;
      for (const cleanup of cleanups) {
        if (cleanup.done) continue;
        try {
          cleanup.run();
          cleanup.done = true;
        } catch (error) {
          Logger.error(
            `[Runtime] ${cleanup.label} cleanup failed:`,
            formatUnknownErrorMessage(error),
          );
        }
      }
    },
  };
}

export async function createServer(
  options: ServerOptions = {},
  extraDeps?: {
    /**
     * State shared across instances. The HTTP leg builds one for the whole
     * endpoint and stdio one per connection, so an accepted access grant
     * survives the request that accepted it (R8), an externalized result
     * survives to the follow-up resources/read, and the listen-watcher path
     * validates against the same allowed set. Omitted, the instance builds its
     * own and disposes it on close.
     */
    state?: RuntimeState;
    /** Modern-leg typed notification publisher. */
    notifier?: ServerNotifier;
    /** The protocol era this instance serves; omitted where the caller does not know. */
    era?: 'legacy' | 'modern';
    /**
     * Only `stdio` has the SDK's fixed 10 MiB ReadBuffer, so only there are
     * results capped: any tool call that changed nothing, any resource read,
     * and a result-store entry by the size of its read (define.ts,
     * resources.ts, store.ts).
     */
    transport?: 'stdio' | 'http';
    /**
     * `private` when the HTTP host requires a bearer key, so a shared cache
     * never serves one tenant's listing to another. Default `public`.
     */
    cacheScope?: 'private' | 'public';
  },
): Promise<FilesystemServerContext> {
  // Only `resources` is declared: `McpServer` advertises `tools` and `prompts`
  // (with `listChanged: true`) and `completions` from the registrations below,
  // but never infers `subscribe`.
  //
  // `resources.subscribe` stays advertised on both eras: the verb itself is
  // 2025-only, but the SDK's listen router honors a `subscriptions/listen`
  // resource filter only while this bit is advertised (dist: `allow(
  // capabilities?.resources?.subscribe)` on `resourceSubscriptions`). The
  // strict-capability gate on outbound `notifications/resources/updated`
  // checks only that `resources` exists. The one exception is a
  // legacy instance on the HTTP leg (era 'legacy' with a notifier): it serves
  // one request, registers no subscribe handler (resources.ts, same
  // predicate) and sends no notification of any kind — there is no stream to
  // send it on — so neither `subscribe` nor `listChanged` is advertised.
  // sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.
  const legacyHttp = extraDeps?.era === 'legacy' && extraDeps.notifier !== undefined;
  const capabilities = {
    resources: { subscribe: !legacyHttp, listChanged: !legacyHttp },
  } satisfies ServerCapabilities;

  const cacheScope = extraDeps?.cacheScope ?? 'public';
  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
    capabilities,
    enforceStrictCapabilities: true,
    // Structural bound on tools/call arguments, checked before Zod walks the
    // value: the body limit is bytes (31 MiB by default), and every per-tool
    // `.max()` runs only after a full traversal. No schema-legal call comes
    // near this (see MAX_TOOL_INPUT_ELEMENTS); a payload over it is answered
    // with a tool error after counting at most 4097 nodes.
    maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
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
    // The ResourceStore fires list-changed on every externalization and on
    // every expiry prune (store.ts), so parallel tools/call on one
    // connection can send the same notification several times in one tick;
    // each copy makes the client refetch an unchanged list. The SDK
    // coalesces same-tick duplicates for methods listed here.
    debouncedNotificationMethods: ['notifications/resources/list_changed'],
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

  // False when the state is shared across instances and outlives this one.
  const ownsState = extraDeps?.state === undefined;
  const state =
    extraDeps?.state ??
    createRuntimeState(options, {
      onResourcesChanged: () => {
        voidSend(server.server.sendResourceListChanged(), 'resource list_changed');
      },
      // A tool hands out no result-store link that this connection's resources/read refuses; file links are gated in writtenFileLinks.
      maxReadResultBytes: extraDeps?.transport === 'stdio' ? MAX_OUTBOUND_RESULT_BYTES : undefined,
    });
  const { pathGuard, pageStore, undoJournal, resourceStore, watcherRegistry } = state;
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
    undoJournal,
    resourceStore,
    cacheScope,
    readOnly: options.readOnly ?? false,
    watcherRegistry,
    ...(extraDeps?.notifier ? { notifier: extraDeps.notifier } : {}),
    ...(extraDeps?.era ? { era: extraDeps.era } : {}),
    ...(extraDeps?.transport ? { transport: extraDeps.transport } : {}),
  };

  const resourceDisposable = registerResources(deps);
  registerPrompts(deps);
  registerTools(deps);

  let cleanedUp = false;
  const context: FilesystemServerContext = {
    mcp: server,
    pathGuard,
    disposeRuntimeState() {
      if (cleanedUp) return;
      cleanedUp = true;
      resourceDisposable.dispose();
      if (ownsState) state.dispose();
    },
  };
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    previousOnClose?.();
    context.disposeRuntimeState();
  };
  return context;
}
