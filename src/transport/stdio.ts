// stdio hosting: the pinned-instance factory, legacy roots seeding, and the
// gated transport that attaches listen-filter watchers before the SDK sees the
// message.
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { isJSONRPCNotification, ProtocolErrorCode } from '@modelcontextprotocol/server';
import {
  serveStdio,
  type StdioServerHandle,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';

import { fileURLToPath } from 'node:url';

import { formatUnknownErrorMessage, normalizeUnknownError } from '../core/errors.ts';
import { Logger, voidSend } from '../core/observability.ts';
import type { ServerOptions } from '../core/path.ts';
import {
  getMaxInboundMessageBytes,
  MAX_OUTBOUND_RESULT_BYTES,
  MAX_STDIO_REQUEST_ID_BYTES,
} from '../core/util.ts';
import type { FilesystemServerContext } from '../server.ts';
import { createRuntimeState, createServer } from '../server.ts';
import type { RuntimeConfig } from './shared.ts';
import {
  jsonRpcError,
  jsonRpcRequestId,
  listenSubscriptionUris,
  prepareListenWatchers,
} from './shared.ts';

interface StdioListenState {
  acquiredUris: string[];
  cancelled: boolean;
  delivered: boolean;
}

// Read through a function, not `state.cancelled` directly: a cancellation lands
// between the checks, and control-flow narrowing from the first one would
// otherwise make the second read a compile-time constant.
function isListenCancelled(state: StdioListenState): boolean {
  return state.cancelled;
}

/**
 * The client-chosen string a request would have echoed into a frame of its
 * own, when it encodes past the envelope reserve: the ID into its response, or
 * `_meta.progressToken` into every progress notification. `undefined` when
 * both fit, or for anything that is not a request.
 */
function oversizedEcho(message: unknown): 'request ID' | 'progress token' | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const request = message as {
    method?: unknown;
    id?: unknown;
    params?: { _meta?: { progressToken?: unknown } };
  };
  if (request.method === undefined || request.id === undefined) return undefined;
  const tooLong = (value: unknown): boolean =>
    typeof value === 'string' &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_STDIO_REQUEST_ID_BYTES;
  if (tooLong(request.id)) return 'request ID';
  if (tooLong(request.params?._meta?.progressToken)) return 'progress token';
  return undefined;
}

function cancelledRequestId(message: unknown): string | number | null {
  if (typeof message !== 'object' || message === null) return null;
  const notification = message as {
    method?: unknown;
    params?: { requestId?: unknown };
  };
  if (notification.method !== 'notifications/cancelled') return null;
  if (!isJSONRPCNotification(message)) return null;
  const requestId = notification.params?.requestId;
  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : null;
}

/**
 * Seed the guard's allowed roots from the client's declared workspace roots.
 * Legacy-era only: push-style `roots/list` is deprecated (SEP-2577) and throws
 * on a 2026-07-28 connection, where clients pass paths as tool arguments and
 * the access-grant round-trip covers out-of-root paths instead. Every root
 * still passes `applyGrant`'s boundary and unsafe-path guards, so a client
 * cannot root-declare its way into $HOME or past FS_ROOT_BOUNDARY — a refused
 * root is skipped and its paths fail closed at validateAccess like any other.
 * sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.
 */
export async function seedRootsFromClient(ctx: FilesystemServerContext): Promise<number> {
  let roots: readonly { uri: string }[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- legacy-era-only; the modern era never reaches the hooks that call this.
    ({ roots } = await ctx.mcp.server.listRoots());
  } catch (err: unknown) {
    // Client without the roots capability (strict-capabilities throw), or the
    // request failed — either way there is nothing to seed.
    Logger.debug('[Stdio] roots/list unavailable', { error: formatUnknownErrorMessage(err) });
    return 0;
  }
  let granted = 0;
  for (const root of roots) {
    let dir: string;
    try {
      dir = fileURLToPath(root.uri);
    } catch {
      continue; // not a file:// root
    }
    try {
      if (await ctx.pathGuard.applyGrant(dir, 'workspace')) granted += 1;
      else Logger.debug('[Stdio] client root refused by grant policy', { dir });
    } catch (err: unknown) {
      Logger.debug('[Stdio] client root grant failed', {
        dir,
        error: formatUnknownErrorMessage(err),
      });
    }
  }
  // No list-changed notification follows a grant. Allowed roots were once listed
  // as concrete resources, and are not any more: the file template's `list()`
  // returns nothing and the other two lists never read the roots at all (see
  // resources.ts). Notifying bought the client a re-fetch of an unchanged list.
  if (granted > 0) {
    Logger.info(`[Stdio] allowed ${granted} client-declared workspace root(s)`);
  }
  return granted;
}

/**
 * Serve filesystem-mcp over stdio: the 2026-07-28 revision, plus the 2025 era for legacy clients (ADR-002).
 *
 * The SDK's `StdioListenRouter` acknowledges `subscriptions/listen` and routes
 * the pinned instance's outbound change notifications onto the matching
 * streams, but it exposes no listen-filter hook, so nothing attaches the
 * filesystem watcher that would produce those notifications. `serveStdio`'s
 * `transport` option is the seam: it installs its own `onmessage` synchronously
 * and only then starts the wire, so wrapping that callback afterwards gives the
 * same view of the inbound `resourceSubscriptions` filter the HTTP leg reads off
 * `req.body`. The watcher's notify sink calls `sendResourceUpdated` on the
 * pinned instance, which the router then delivers to the listening stream.
 *
 * Watcher leases are tracked by listen request ID and released on cancellation,
 * rejection, graceful completion, or connection close.
 *
 * `_config` is unused: an API key has no meaning on stdio. The parameter keeps
 * the `./transport` export's signature.
 */
export function startServer(options: ServerOptions, _config?: RuntimeConfig): StdioServerHandle {
  let closed = false;
  let activeCtx: FilesystemServerContext | undefined;
  // One state for the connection, outliving any instance built for it. The
  // store reads `activeCtx` when it fires, like `sink` below, so it never pins
  // a disposed instance. The guard and the registry (shared with the resource
  // contract so a `resources/subscribe` and a `subscriptions/listen` naming the
  // same URI reuse one watcher) are also used outside the instance.
  const runtime = createRuntimeState(options, {
    onResourcesChanged: () => {
      voidSend(activeCtx?.mcp.server.sendResourceListChanged(), '[Stdio] resource list_changed');
    },
    // A tool hands out no result-store link that this connection's resources/read refuses.
    maxReadResultBytes: MAX_OUTBOUND_RESULT_BYTES,
  });
  const { pathGuard, watcherRegistry: registry } = runtime;
  let pathGuardReady: Promise<void> | undefined;
  const ensurePathGuard = (): Promise<void> => {
    pathGuardReady ??= pathGuard.recomputeAllowedDirectories();
    return pathGuardReady;
  };
  const factory: McpServerFactory = async ({ era }) => {
    await ensurePathGuard();
    const c = await createServer(options, {
      state: runtime,
      era,
      transport: 'stdio',
    });
    if (closed) {
      // The connection went away while this instance was being built.
      // `cleanupConnection` already ran and its `closed` guard makes every later
      // call a no-op, so publishing `c` would strand it: nothing would dispose
      // it. Return it unactivated — the wire is gone, so nothing serves it.
      c.disposeRuntimeState();
      return c.mcp;
    }
    activeCtx = c;
    // sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.
    if (era === 'legacy') {
      // Fires when the client's `notifications/initialized` lands. Safe to own:
      // the SDK's only touchpoint is its own initialized handler reading it.
      c.mcp.server.oninitialized = () => {
        void seedRootsFromClient(c);
      };
      // Re-list and grant anything new. Grants are session-additive (R8): a
      // root the client withdrew is not revoked mid-session.
      c.mcp.server.setNotificationHandler('notifications/roots/list_changed', () => {
        void seedRootsFromClient(c);
      });
    }
    return c.mcp;
  };

  // One sink for the whole connection. `addCallback` de-duplicates by function
  // identity, so re-using this closure makes a repeat `subscriptions/listen` on
  // an already-watched URI a no-op; a fresh closure per listen would instead
  // stack a callback every time, double-notifying and growing an
  // `activeCallbacks` set that MAX_WATCHERS does not bound (it caps watchers,
  // not callbacks). Reads `activeCtx` when it fires rather than capturing it, so
  // it never pins a disposed instance.
  const sink = (uri: string): void => {
    voidSend(activeCtx?.mcp.server.sendResourceUpdated({ uri }), '[Stdio] resource update', {
      uri,
    });
  };

  // Sized from the same limit the write tools enforce: an overflow is fatal
  // to the connection (the SDK's ReadBuffer contract), so a schema-valid
  // create must always fit. See getMaxInboundMessageBytes.
  const wire = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: getMaxInboundMessageBytes(),
  });
  const listens = new Map<string | number, StdioListenState>();

  // Deleting the entry is what makes this idempotent: a second call for the
  // same id finds nothing to release.
  const releaseListen = (id: string | number): void => {
    const state = listens.get(id);
    if (!state) return;
    listens.delete(id);
    for (const uri of state.acquiredUris) registry.release(uri);
  };

  const cleanupConnection = (): void => {
    if (closed) return;
    closed = true;
    for (const state of listens.values()) state.cancelled = true;
    listens.clear();
    runtime.dispose();
    const ctx = activeCtx;
    activeCtx = undefined;
    // Both steps below are guarded separately, and for the same reason: this
    // also runs from `wire.onclose`, where a throw is an uncaught exception on
    // the stdin close event rather than a rejected close(). One shared catch
    // would let a failed disposal skip the unref and strand the process.
    try {
      ctx?.disposeRuntimeState();
    } catch {
      /* idempotent — disposeRuntimeState guards cleanedUp */
    }
    try {
      // The SDK's transport close pauses stdin only when no other 'data'
      // listener is left, so a fatal read error (a ReadBuffer overflow) tears
      // the connection down but leaves the handle referenced and this process
      // alive with nothing left to serve. Unref rather than pause: a listener
      // the SDK still owns keeps receiving data, the loop just stops being held
      // open for it.
      process.stdin.unref();
    } catch {
      /* a file-backed stdin is an `fs.ReadStream`, which has no `unref` */
    }
  };

  const send = wire.send.bind(wire);
  wire.send = async (message) => {
    if ('id' in message && ('result' in message || 'error' in message)) {
      const id = message.id;
      if (id !== undefined) releaseListen(id);
    }
    await send(message);
  };

  const handle = serveStdio(factory, {
    legacy: 'serve',
    transport: wire,
    onerror: (error: unknown) => {
      const message = formatUnknownErrorMessage(error);
      // The SDK's own text names a byte count and nothing else; say what
      // the operator can do about it. The connection is already closing.
      if (message.includes('ReadBuffer exceeded maximum size')) {
        Logger.error(
          `[Stdio] an inbound message exceeded ${String(getMaxInboundMessageBytes())} bytes (3 × FS_MAX_FILE_SIZE + 1 MiB); the connection is closed. Split the write into smaller calls or raise FS_MAX_FILE_SIZE.`,
        );
      }
      Logger.error('[Stdio] serve error:', message);
    },
  });
  const onclose = wire.onclose;
  wire.onclose = () => {
    try {
      cleanupConnection();
    } finally {
      onclose?.();
    }
  };

  // Wrap the callback `serveStdio` just installed. Listen requests are admitted
  // in order so two requests naming the same URI cannot race the registry's
  // ref-count. Cancellation is serialized with pending admission by request ID:
  // a pending request is suppressed and releases after preparation, while an
  // active request releases before the SDK closes its stream.
  //
  // serveStdio installs its onmessage synchronously and only then starts the
  // wire; this wrapper is only correct because of that ordering. Assert it
  // rather than degrade to a silent no-op if a future SDK release changes it.
  const deliver = wire.onmessage;
  if (!deliver) {
    throw new Error(
      'serveStdio did not install a synchronous onmessage handler; the subscriptions/listen watcher gate cannot attach. This is an SDK contract change, not a configuration error.',
    );
  }
  let gated = Promise.resolve();
  wire.onmessage = (message) => {
    const oversized = oversizedEcho(message);
    if (oversized !== undefined) {
      // Never echo an oversized ID: it could overflow even a compact error. A
      // short ID with an oversized progress token is answered under that ID.
      // Reject before dispatch so no write, subscription or progress frame
      // can take effect.
      const shorter = oversized === 'request ID' ? 'ID' : 'token';
      const id = oversized === 'progress token' && 'id' in message ? message.id : undefined;
      void wire
        .send(
          jsonRpcError(
            ProtocolErrorCode.InvalidRequest,
            `Stdio ${oversized} exceeds ${String(MAX_STDIO_REQUEST_ID_BYTES)} JSON-encoded bytes. Use a shorter ${shorter}.`,
            id,
          ),
        )
        .catch((error: unknown) => {
          wire.onerror?.(normalizeUnknownError(error));
        });
      return;
    }
    const cancelId = cancelledRequestId(message);
    if (cancelId !== null) {
      const state = listens.get(cancelId);
      if (!state) {
        deliver(message);
        return;
      }
      state.cancelled = true;
      if (state.delivered) {
        releaseListen(cancelId);
        deliver(message);
      }
      return;
    }

    // A malformed listen, or one naming no resources, needs no watcher and
    // goes straight to the SDK, which answers it.
    const subscriptionUris = listenSubscriptionUris(message);
    if (subscriptionUris === undefined || subscriptionUris.length === 0) {
      deliver(message);
      return;
    }
    const id = jsonRpcRequestId(message);
    if (id === null || listens.has(id)) {
      deliver(message);
      return;
    }
    const state: StdioListenState = {
      acquiredUris: [],
      cancelled: false,
      delivered: false,
    };
    listens.set(id, state);
    gated = gated
      .then(async () => {
        if (isListenCancelled(state)) {
          listens.delete(id);
          return;
        }
        await ensurePathGuard();
        const prepared = await prepareListenWatchers(subscriptionUris, pathGuard, registry, sink);
        if (!prepared.ok) {
          listens.delete(id);
          await wire.send(jsonRpcError(ProtocolErrorCode.InvalidParams, prepared.message, id));
          return;
        }
        state.acquiredUris = prepared.acquiredUris;
        if (isListenCancelled(state)) {
          releaseListen(id);
          return;
        }
        state.delivered = true;
        deliver(message);
      })
      .catch(async (error: unknown) => {
        releaseListen(id);
        const failure = normalizeUnknownError(error);
        wire.onerror?.(failure);
        // The gate swallowed the message, so nothing downstream will answer it.
        // Without this the client waits out its whole request timeout.
        await wire
          .send(jsonRpcError(ProtocolErrorCode.InternalError, failure.message, id))
          .catch(() => {
            /* the wire is gone; onerror above already reported it */
          });
      });
  };

  return {
    close: async () => {
      try {
        cleanupConnection();
      } finally {
        await handle.close();
      }
    },
  };
}
