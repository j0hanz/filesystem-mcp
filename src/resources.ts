import type {
  CacheHint,
  CompleteResourceTemplateCallback,
  McpServer,
  ReadResourceResult,
  Resource,
  ResourceUpdatedNotificationParams,
  Role,
  ServerContext,
  ServerNotifier,
  SubscribeRequestParams,
  UnsubscribeRequestParams,
} from '@modelcontextprotocol/server';
import {
  checkResourceAllowed,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/server';

import type { FsError } from './core/errors.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  fsErrorCode,
  hasErrorShape,
  isFsError,
} from './core/errors.js';
import {
  decodeFileUriPath,
  encodeFileUriPath,
  extractPath,
  FILESYSTEM_FILE_URI_TEMPLATE,
} from './core/file-uri.js';
import { GuardedFileSystem } from './core/fs.js';
import { Logger } from './core/observability.js';
import { PathCompleter } from './core/path-completer.js';
import type { PathGuard } from './core/path.js';
import type { ResourceStore } from './core/store.js';
import {
  createWatcherRegistry,
  MAX_WATCHERS,
  type WatcherRegistry,
} from './core/watcher-registry.js';
import {
  buildSectionsRecord,
  INSTRUCTIONS_SUMMARY,
  INSTRUCTIONS_URI,
  renderSections,
} from './instructions.js';

// ═══════════════════════════════════════════════════════════════
// shared
// ═══════════════════════════════════════════════════════════════

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  pathGuard: PathGuard;
  /** Mirrors the `--read-only` gate so the instructions match the tools actually registered. */
  readOnly: boolean;
  /**
   * Shared file-watcher registry for the modern (per-request) HTTP leg. When set,
   * the resource uses this handler-scoped registry instead of creating its own
   * per-server one, so file-change watchers persist across requests and publish
   * to the shared ServerEventBus. Omitted (per-server registry) on legacy/stdio.
   */
  watcherRegistry?: WatcherRegistry;
  /** Modern-leg typed notification publisher. */
  notifier?: ServerNotifier;
  /** The protocol era this instance serves; omitted where the caller does not know. */
  era?: 'legacy' | 'modern';
  /**
   * Scope for shared-content cache hints. 'private' when the endpoint is
   * API-key gated, mirroring the list hints in server.ts — a shared cache must
   * not store an authenticated response body. Defaults to 'public'.
   */
  cacheScope?: 'public' | 'private';
}

type ResourceRegistrarDeps = Omit<ResourceRegistrationOptions, 'pathGuard' | 'readOnly'> & {
  readonly server: McpServer;
  readonly pathGuard: PathGuard;
  readonly readOnly?: boolean;
};

/**
 * A filesystem failure that reads as not-found on the resource wire, for both
 * `resources/read` and `resources/subscribe`. ACCESS_DENIED folds in
 * deliberately: masking whether an out-of-root or denylisted path exists is the
 * security-correct answer, and the `FsError` message still carries the real
 * cause to the client.
 */
function isNotFoundish(error: unknown): error is FsError {
  return (
    isFsError(error) &&
    (error.code === ErrorCode.NOT_FOUND || error.code === ErrorCode.ACCESS_DENIED)
  );
}

// ═══════════════════════════════════════════════════════════════
// contract
// ═══════════════════════════════════════════════════════════════

interface BaseResourceContract {
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  cacheHint?: CacheHint;
  annotations?: {
    audience?: Role[];
    priority?: number;
  };
  readonly read: (
    uri: URL,
    variables: Record<string, string | string[]>,
    ctx: ServerContext,
  ) => Promise<ReadResourceResult> | ReadResourceResult;
  readonly subscribe?: (
    uri: string,
    notify: (uri: string) => void,
  ) => Promise<boolean | undefined> | boolean | undefined;
  readonly unsubscribe?: (uri: string) => void;
  readonly destroy?: () => void;
  readonly list?: (
    ctx: ServerContext,
  ) => Promise<{ resources: Resource[] }> | { resources: Resource[] };
}

/** A resource with a fixed, enumerable URI (e.g. internal://instructions). */
interface StaticResourceContract extends BaseResourceContract {
  uri: string;
  uriTemplate?: never;
  complete?: never;
}

/** A resource identified by a URI template (FILESYSTEM_FILE_URI_TEMPLATE). */
interface TemplateResourceContract extends BaseResourceContract {
  uriTemplate: string;
  uri?: never;
  complete?: { path: CompleteResourceTemplateCallback };
}

type ResourceContract = StaticResourceContract | TemplateResourceContract;

// ═══════════════════════════════════════════════════════════════
// instructions
// ═══════════════════════════════════════════════════════════════

function createInstructionsResource(options: ResourceRegistrationOptions): ResourceContract {
  const text = renderSections(buildSectionsRecord(options.readOnly));
  return {
    name: 'filesystem-mcp-instructions',
    title: 'Server Instructions',
    description: INSTRUCTIONS_SUMMARY,
    mimeType: 'text/markdown',
    uri: INSTRUCTIONS_URI,
    annotations: { audience: ['assistant'], priority: 0.8 },
    cacheHint: { cacheScope: options.cacheScope ?? 'public', ttlMs: 300_000 },
    read(uri) {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text,
          },
        ],
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// filesystem
// ═══════════════════════════════════════════════════════════════

function createFilesystemResource(options: ResourceRegistrationOptions): ResourceContract {
  const completer = new PathCompleter(options.pathGuard);
  const registry = options.watcherRegistry ?? createWatcherRegistry();
  // Only the per-server (legacy/stdio) registry is owned by this resource and
  // destroyed on dispose; the shared modern-leg registry is owned by the host
  // and torn down at server shutdown.
  const ownsRegistry = options.watcherRegistry === undefined;
  // The URIs this connection holds a `resources/subscribe` lease for. The wire
  // verb is per-URI and idempotent — a second subscribe is the same
  // subscription, and one unsubscribe ends it — but the registry ref-counts
  // leases (the HTTP listen leg needs that). Without this set a double
  // subscribe took two leases that one unsubscribe could not release, and an
  // unsubscribe for a URI never subscribed released a lease this connection
  // never took, dropping a watcher some other holder still wanted.
  const leasedUris = new Set<string>();
  // Subscribes mid-acquire, keyed by URI. Two concurrent subscribes for the
  // same URI must share one acquire: both passing the `leasedUris` check
  // before either finished took two registry leases that the single set entry
  // could release only once — on the shared modern registry that orphan lease
  // pinned a watcher until process shutdown.
  const inflight = new Map<string, Promise<boolean | undefined>>();

  return {
    name: 'filesystem-mcp-file',
    title: 'Workspace File',
    description: 'Read a file from the workspace. Subscribe to get updates when the file changes.',
    uriTemplate: FILESYSTEM_FILE_URI_TEMPLATE,
    annotations: { audience: ['assistant'], priority: 0.8 },
    // Without this the SDK falls back to its conservative `{ ttlMs: 0,
    // cacheScope: 'private' }`, making every file read uncacheable — and this
    // is the one resource with a live invalidation channel, so TTL and the
    // watcher compose exactly as the spec's caching section describes. The TTL
    // stays short because a non-subscriber gets no invalidation signal at all.
    cacheHint: { cacheScope: options.cacheScope ?? 'public', ttlMs: 5_000 },

    // No `list`: the template registers with `list: undefined` — readable but
    // not enumerable. Listing each allowed root as a concrete resource
    // duplicated the template and grew resources/list linearly with roots;
    // `list_roots` owns root discovery.

    async read(uri, _variables, _ctx: ServerContext) {
      // Decode via extractPath — the same decoder resources/subscribe uses — so
      // both consumers are symmetric with buildFileResourceUri's encoding. The
      // {+path} template variable arrives still percent-encoded, so validating
      // it directly would treat "c%3A/proj/a.ts" as a literal relative path;
      // no fallback to it here, or the two branches would validate different
      // strings. extractPath only fails past the template match on undecodable
      // percent-encoding, which is the caller's malformed URI.
      const rawPath = extractPath(uri.href);
      if (rawPath === undefined) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'Malformed file URI: path is not valid percent-encoding',
        );
      }
      await options.pathGuard.validateExistingPath(rawPath);
      const fs = new GuardedFileSystem(options.pathGuard);
      const readResult = await fs.readRaw(rawPath);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: readResult.mimeType || 'application/octet-stream',
            ...(readResult.isBinary
              ? { blob: readResult.content.toString('base64') }
              : { text: readResult.content.toString('utf-8') }),
          },
        ],
      };
    },

    complete: {
      // Both ends speak the `{+path}` form (see encodeFileUriPath), not raw OS
      // paths: the partial arriving here is whatever this returned last, so the
      // decode mirrors the encode. An undecodable partial is matched as typed.
      path: async (value) => {
        const suggestions = await completer.suggest(decodeFileUriPath(value) ?? value);
        return suggestions.map(encodeFileUriPath);
      },
    },

    subscribe(uri, notify) {
      // Already subscribed on this connection: the watcher is live and the sink
      // is registered, so this is a no-op success rather than a second lease.
      if (leasedUris.has(uri)) return undefined;
      // A subscribe for this URI is mid-acquire: share its outcome instead of
      // taking a second lease the lease set cannot represent.
      const pending = inflight.get(uri);
      if (pending) return pending;

      const acquire = async (): Promise<boolean | undefined> => {
        const result = await registry.acquire(options.pathGuard, uri, notify, {
          markSubscribe: true,
        });
        if (result.ok) {
          leasedUris.add(uri);
          return undefined;
        }

        if (result.reason === 'bad-uri') {
          throw new ResourceNotFoundError(uri, `Cannot subscribe: not a filesystem URI`);
        }
        if (result.reason === 'invalid-path') {
          const err = result.error;
          if (isNotFoundish(err)) {
            throw new ResourceNotFoundError(uri, `Cannot subscribe to ${uri}: ${err.message}`);
          }
          Logger.warn(
            `Unexpected error validating path for watcher ${uri}: ${formatUnknownErrorMessage(err)}`,
          );
          throw err;
        }
        // Unsubscribed (or the registry destroyed) mid-await: the caller already
        // asked for this to stop, so there is nothing to reject.
        if (result.reason === 'stale') return undefined;
        // capped / attach-failed: `false` tells the handler to reject, since
        // undefined would report success with no watcher attached.
        return false;
      };

      const promise = acquire().finally(() => inflight.delete(uri));
      inflight.set(uri, promise);
      return promise;
    },

    unsubscribe(uri) {
      // Only release a lease this connection actually took.
      if (!leasedUris.delete(uri)) return;
      registry.release(uri);
    },

    destroy() {
      // Release what this connection still holds before the registry goes: on
      // the shared (modern) registry nothing else would ever end these leases.
      for (const uri of leasedUris) registry.release(uri);
      leasedUris.clear();
      if (ownsRegistry) registry.destroy();
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// result
// ═══════════════════════════════════════════════════════════════

function createResultResource(options: ResourceRegistrationOptions): ResourceContract {
  return {
    name: 'filesystem-mcp-result',
    title: 'Cached Tool Result',
    description:
      'Ephemeral cached tool output. Listed via resources/list; entries expire after the cache TTL.',
    mimeType: 'application/json',
    uriTemplate: 'filesystem-mcp://result/{id}',
    annotations: { audience: ['assistant'], priority: 0.3 },
    cacheHint: { cacheScope: 'private', ttlMs: 60_000 },
    list() {
      const store = options.resourceStore;
      const uris = store.keys(); // prunes expired first
      const resources: Resource[] = [];
      for (const uri of uris) {
        try {
          const entry = store.getEntry(uri);
          resources.push({
            uri: entry.uri,
            name: entry.name,
            mimeType: entry.mimeType,
            size: entry.size,
          });
        } catch (err) {
          // An entry may expire between keys() and getEntry; skip it.
          if (isFsError(err) && err.code === ErrorCode.NOT_FOUND) continue;
          throw err;
        }
      }
      // Recent-first: keys() returns insertion order, so the newest is last.
      resources.reverse();
      return { resources };
    },
    read(uri, variables) {
      const { id } = variables;
      if (typeof id !== 'string' || id.length === 0) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'Malformed result URI: missing {id}. Use the exact resourceUri returned by the tool.',
        );
      }

      let entry;
      try {
        entry = options.resourceStore.getEntry(uri.toString());
      } catch (err) {
        if (isFsError(err) && err.code === ErrorCode.NOT_FOUND) {
          throw new ResourceNotFoundError(
            uri.toString(),
            'Cached result not found or expired. Re-run the tool to regenerate.',
          );
        }
        throw err;
      }
      return {
        contents: [{ uri: entry.uri, mimeType: entry.mimeType, text: entry.text }],
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// export contracts
// ═══════════════════════════════════════════════════════════════

export function getResourceContracts(options: ResourceRegistrationOptions): ResourceContract[] {
  return [
    createInstructionsResource(options),
    createResultResource(options),
    createFilesystemResource(options),
  ];
}

// ═══════════════════════════════════════════════════════════════
// registrar
// ═══════════════════════════════════════════════════════════════

function wrapRead(contract: ResourceContract) {
  return async (uri: URL, variables: Record<string, string | string[]>, ctx: ServerContext) => {
    try {
      return await contract.read(uri, variables, ctx);
    } catch (error) {
      if (hasErrorShape(error, 'ProtocolError')) throw error;
      // A missing or out-of-root path is a not-found, not a malformed request.
      // The SDK puts ResourceNotFoundError on the wire as -32602 with
      // `data.uri`, which is what clients match on; -32002 is the older code
      // they also accept, and this SDK never emits it.
      if (isNotFoundish(error)) {
        throw new ResourceNotFoundError(uri.toString(), error.message);
      }
      // A remaining FsError (NOT_FILE, TOO_LARGE, ...) traces to the
      // caller-supplied URI; anything else is a server-side failure and must
      // not be blamed on the request.
      const msg = isFsError(error) ? error.message : formatUnknownErrorMessage(error);
      throw new ProtocolError(fsErrorCode(error), msg);
    }
  };
}

export function registerResources(deps: ResourceRegistrarDeps): { dispose(): void } {
  const server = deps.server;
  const resourceContracts = getResourceContracts({ ...deps, readOnly: deps.readOnly ?? false });

  for (const contract of resourceContracts) {
    const config = {
      ...(contract.title !== undefined ? { title: contract.title } : {}),
      ...(contract.description !== undefined ? { description: contract.description } : {}),
      ...(contract.mimeType !== undefined ? { mimeType: contract.mimeType } : {}),
      ...(contract.annotations !== undefined ? { annotations: contract.annotations } : {}),
      ...(contract.cacheHint !== undefined ? { cacheHint: contract.cacheHint } : {}),
    };

    if (contract.uriTemplate) {
      const template = new ResourceTemplate(contract.uriTemplate, {
        list: contract.list,
        ...(contract.complete ? { complete: contract.complete } : {}),
      });

      server.registerResource(contract.name, template, config, wrapRead(contract));
    } else if (contract.uri) {
      server.registerResource(contract.name, contract.uri, config, (uri: URL, ctx: ServerContext) =>
        wrapRead(contract)(uri, {}, ctx),
      );
    }
  }

  // `resources/subscribe`/`unsubscribe` are 2025-era-only verbs; a modern
  // server answers `-32601 Method not found` for them, so registering these
  // handlers on a modern-era instance would dispatch to code no request can
  // reach.
  if (deps.era !== 'modern') {
    server.server.assertCanSetRequestHandler('resources/subscribe');
    server.server.assertCanSetRequestHandler('resources/unsubscribe');

    // One stable callback for the whole registrar, NOT one per subscribe. The
    // registry holds these in a Set keyed by identity, so a fresh closure per
    // request made a second `resources/subscribe` for the same URI register a
    // second sink: one file change then sent N notifications, and `unsubscribe`
    // (which only ends a lease) removed none of them. Subscribe is per-URI on
    // the wire, so the sink must be too — this makes it idempotent.
    const notifyUpdated = (updatedUri: string): void => {
      if (deps.notifier) {
        deps.notifier.resourceUpdated(updatedUri);
        return;
      }
      const updatePayload: ResourceUpdatedNotificationParams = { uri: updatedUri };
      // A failed notify means the connection went away; nothing to recover.
      void server.server.sendResourceUpdated(updatePayload).catch((err: unknown) => {
        Logger.debug('resource update not delivered', {
          uri: updatedUri,
          error: formatUnknownErrorMessage(err),
        });
      });
    };

    server.server.setRequestHandler(
      'resources/subscribe',
      async (req: { params: SubscribeRequestParams }) => {
        const requestedResource = resourceUrlFromServerUrl(req.params.uri);
        let foundMatch = false;
        // A resource that exists but has no watcher (the instructions text, a
        // cached result) is NOT a not-found: reporting it as one told clients a
        // URI they can list and read does not exist. Track the two cases apart.
        let knownButNotSubscribable = false;
        for (const contract of resourceContracts) {
          const configured = contract.uri ?? contract.uriTemplate.split('{')[0];
          if (!contract.subscribe) {
            if (
              configured &&
              checkResourceAllowed({ requestedResource, configuredResource: configured })
            ) {
              knownButNotSubscribable = true;
            }
            continue;
          }
          if (!configured) continue;
          if (
            checkResourceAllowed({
              requestedResource,
              configuredResource: configured,
            })
          ) {
            foundMatch = true;
            const subscribeResult = await contract.subscribe(
              requestedResource.toString(),
              notifyUpdated,
            );
            if (subscribeResult === false) {
              // InternalError for want of anything better: ProtocolErrorCode
              // has no resource-limit member, and the message already names
              // the actionable cause.
              throw new ProtocolError(
                ProtocolErrorCode.InternalError,
                `Subscription rejected: no watcher attached (watcher limit ${MAX_WATCHERS} reached, or fs.watch failed to start).`,
              );
            }
            break;
          }
        }
        if (!foundMatch) {
          if (knownButNotSubscribable) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              `Resource ${requestedResource.toString()} does not support subscriptions; only ${FILESYSTEM_FILE_URI_TEMPLATE} does. Read it again for the current contents.`,
            );
          }
          throw new ResourceNotFoundError(
            requestedResource.toString(),
            `Resource not found: ${requestedResource.toString()}`,
          );
        }
        return {};
      },
    );

    server.server.setRequestHandler(
      'resources/unsubscribe',
      (req: { params: UnsubscribeRequestParams }) => {
        // Route by URI prefix, mirroring the subscribe handler: a broadcast
        // to every contract works while only one is subscribable, but hands a
        // second subscribable contract someone else's URI the day it appears.
        const requestedResource = resourceUrlFromServerUrl(req.params.uri);
        for (const contract of resourceContracts) {
          if (!contract.unsubscribe) continue;
          const configured = contract.uri ?? contract.uriTemplate.split('{')[0];
          if (!configured) continue;
          if (checkResourceAllowed({ requestedResource, configuredResource: configured })) {
            contract.unsubscribe(requestedResource.toString());
          }
        }
        return {};
      },
    );
  }

  return {
    dispose(): void {
      for (const contract of resourceContracts) {
        if (contract.destroy) {
          contract.destroy();
        }
      }
    },
  };
}
