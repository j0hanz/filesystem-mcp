// HTTP hosting: express app assembly, security middleware wiring, the modern
// per-request server factory, and listen-filter watcher gating on POST /mcp.
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpHttpHandler, ServerNotifier } from '@modelcontextprotocol/server';
import {
  createMcpHandler,
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  isJsonContentType,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';

import type { Server } from 'node:http';
import { createServer as createHttpServer } from 'node:http';

import type { Express, NextFunction, Request, Response } from 'express';

import { formatUnknownErrorMessage } from '../core/errors.js';
import { Logger } from '../core/observability.js';
import { PageSnapshotStore } from '../core/page-store.js';
import { PathGuard } from '../core/path.js';
import type { ServerOptions } from '../core/path.js';
import { parseTrueEnvFlag } from '../core/primitives.js';
import { ResourceStore } from '../core/store.js';
import { MIB, parseEnvInt } from '../core/util.js';
import {
  createWatcherRegistry,
  MAX_WATCHERS,
  type WatcherRegistry,
} from '../core/watcher-registry.js';
import { createServer } from '../server.js';
import {
  assertHttpBindingPolicy,
  assertHttpHostPolicy,
  bearerAuthMiddleware,
  computeAllowedOriginHostnames,
  corsMiddleware,
  createRateLimiter,
  JSONRPC_SERVER_ERROR,
  protectedResourceUrl,
  resolveAllowedHosts,
  resolveTrustProxySetting,
  sendJsonRpcError,
} from './http-policy.js';
import type { RuntimeConfig } from './shared.js';
import {
  isStructurallyValidListen,
  jsonRpcRequestId,
  listenSubscriptionUris,
  prepareListenWatchers,
} from './shared.js';

const MAX_REQUEST_BODY_BYTES = parseEnvInt('FS_MAX_REQUEST_BYTES', 4 * MIB, 1024, 256 * MIB);

/** Body-parser rejections and anything else that reaches the end of the chain. */
function errorHandlerMiddleware(
  err: Error & { status?: number },
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err.status === 413) {
    sendJsonRpcError(res, 413, ProtocolErrorCode.InvalidRequest, 'Request body too large');
    return;
  }
  if (err.status === 400) {
    sendJsonRpcError(res, 400, ProtocolErrorCode.ParseError, 'Invalid JSON in request body');
    return;
  }
  Logger.error('[HTTP] Unhandled middleware error:', formatUnknownErrorMessage(err));
  sendJsonRpcError(res, 500, ProtocolErrorCode.InternalError, 'Internal Server Error');
}

function setupExpressApp(
  httpHost: string,
  apiKey: string | undefined,
  allowedHosts: string[],
  modernNodeHandler: (req: Request, res: Response, parsedBody?: unknown) => Promise<void>,
  sharedPathGuard: PathGuard,
  sharedRegistry: WatcherRegistry,
  notifier: ServerNotifier,
): Express {
  const allowedOriginHostnames = computeAllowedOriginHostnames(process.env['FS_ALLOWED_ORIGINS']);
  // Read once here and passed down, like every other env-derived policy input:
  // http-policy holds no state and reads no env of its own.
  const publicUrl = process.env['FS_PUBLIC_URL'];

  const app = createMcpExpressApp({
    host: httpHost,
    jsonLimit: `${MAX_REQUEST_BODY_BYTES}b`,
    ...(allowedHosts.length > 0 ? { allowedHosts: [...allowedHosts] } : {}),
    ...(allowedOriginHostnames.length > 0 ? { allowedOrigins: [...allowedOriginHostnames] } : {}),
  });

  const trustProxy = resolveTrustProxySetting(process.env['FS_TRUST_PROXY']);
  if (trustProxy !== undefined) {
    app.set('trust proxy', trustProxy);
  }

  if (allowedHosts.length === 0) {
    Logger.warn(
      '[HTTP] FS_ALLOW_UNRESTRICTED_HOSTS is set: binding globally without Host validation.',
    );
  }

  app.use('/mcp', corsMiddleware(allowedOriginHostnames));

  // Unconditional: the spec's rate-limit MUST is not scoped to authenticated
  // binds. A keyless bind is loopback-only, so the cap is looser, not absent.
  const rpm = parseEnvInt('FS_RATE_LIMIT_RPM', apiKey ? 120 : 6_000, 1, 100_000);
  app.use('/mcp', createRateLimiter(rpm));

  if (apiKey && allowedHosts.length > 0) {
    const metadataHandler = (req: Request, res: Response): void => {
      const resource = protectedResourceUrl(req, true, publicUrl);
      if (!resource) {
        // Unreachable for the unrestricted case (the gate above excludes it),
        // but defend a FS_PUBLIC_URL parse failure with a bodyless
        // 404 — a generic OAuth client cannot parse a JSON-RPC error envelope.
        res.status(404).end();
        return;
      }
      res.header('Access-Control-Allow-Origin', '*');
      res.status(200).json({
        resource: resource.href,
        bearer_methods_supported: ['header'],
        resource_name: 'filesystem-mcp',
      });
    };
    app.get(
      ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
      metadataHandler,
    );
  }

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
    });
  });

  app.use('/mcp', bearerAuthMiddleware(apiKey, allowedHosts.length > 0, publicUrl));

  const resourceUpdateSink = (uri: string): void => {
    notifier.resourceUpdated(uri);
  };

  app.post('/mcp', (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      if (!isJsonContentType(req.headers['content-type'])) {
        sendJsonRpcError(
          res,
          415,
          JSONRPC_SERVER_ERROR,
          'Unsupported Media Type: Content-Type must be application/json',
        );
        return;
      }
      const parsedBody = req.body as unknown;
      if (parsedBody === undefined) {
        // Undefined tells the Node adapter to read the raw stream without our parser's limit.
        sendJsonRpcError(res, 400, ProtocolErrorCode.ParseError, 'Invalid JSON in request body');
        return;
      }
      // Only a structurally valid listen gets watchers, mirroring the stdio
      // gate. A malformed one cannot succeed downstream, so attaching handles
      // for it only gives the response-close release something to undo — and
      // everything that is not a listen takes no watchers either way.
      if (!isStructurallyValidListen(parsedBody)) {
        await modernNodeHandler(req, res, parsedBody);
        return;
      }

      // Reject an over-cap listen before the ack so the client does not believe
      // every requested URI is watched when the watcher budget is exhausted.
      // The per-URI `capped` failure below would also reject, but only after
      // creating and tearing down every watcher up to the cap.
      const requestedUris = listenSubscriptionUris(parsedBody);
      // Only URIs without a live watcher consume a slot; a re-listen to an
      // already-watched URI just retains another lease.
      const newUris = requestedUris.filter((uri) => !sharedRegistry.hasWatcher(uri));
      const available = MAX_WATCHERS - sharedRegistry.size();
      if (newUris.length > available) {
        sendJsonRpcError(
          res,
          400,
          ProtocolErrorCode.InvalidParams,
          `subscriptions/listen names ${newUris.length} not-yet-watched URIs but only ${available} watcher slots remain (cap ${MAX_WATCHERS}). Reduce the resourceSubscriptions list.`,
          jsonRpcRequestId(parsedBody),
        );
        return;
      }

      const prepared = await prepareListenWatchers(
        parsedBody,
        sharedPathGuard,
        sharedRegistry,
        resourceUpdateSink,
      );
      if (!prepared.ok) {
        sendJsonRpcError(
          res,
          400,
          ProtocolErrorCode.InvalidParams,
          prepared.message,
          jsonRpcRequestId(parsedBody),
        );
        return;
      }

      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        for (const uri of prepared.acquiredUris) sharedRegistry.release(uri);
      };
      if (prepared.acquiredUris.length > 0) {
        // The attach loop awaits per-URI path validation, so the client can be
        // gone by the time it returns. `close` fires once: a listener attached
        // after it would never run and every lease this batch took would leak
        // until process shutdown.
        if (res.closed || res.destroyed || res.writableEnded) release();
        else res.once('close', release);
      }

      try {
        await modernNodeHandler(req, res, parsedBody);
      } catch (error) {
        release();
        throw error;
      }
    })().catch(next);
  });

  // Answer non-POST here rather than handing it to `modernNodeHandler`. The
  // SDK's own 405 is byte-identical to this one, but it omits the `Allow`
  // header RFC 9110 §15.5.6 requires and routes every routine GET probe through
  // the handler's `onerror` — which this server logs at error level.
  app.all('/mcp', (_req: Request, res: Response) => {
    sendJsonRpcError(res, 405, JSONRPC_SERVER_ERROR, 'Method not allowed.', null, {
      Allow: 'POST, OPTIONS',
    });
  });

  app.use(errorHandlerMiddleware);

  return app;
}

export async function startHttpServer(
  port: number,
  options: ServerOptions,
  config: RuntimeConfig = {},
): Promise<Server> {
  const httpHost = config.httpHost ?? '127.0.0.1';
  const { apiKey } = config;
  assertHttpBindingPolicy(httpHost, apiKey);
  const allowedHosts = resolveAllowedHosts(httpHost, process.env['FS_ALLOWED_HOSTS']);
  assertHttpHostPolicy(
    httpHost,
    allowedHosts,
    parseTrueEnvFlag(process.env['FS_ALLOW_UNRESTRICTED_HOSTS'], 'FS_ALLOW_UNRESTRICTED_HOSTS'),
  );

  const sharedRegistry = createWatcherRegistry();
  // One store for the whole endpoint, same lifetime and same one-credential
  // trust argument as the shared guard below: a result a tool externalized in
  // one POST must survive to the follow-up resources/read, and the modern leg
  // builds a fresh McpServer per request so a per-request store would discard
  // it immediately.
  // Fires only from a tool call, which is long after `modernHandler` below is
  // constructed, so reading it from the closure is safe.
  const sharedStore = new ResourceStore(() => {
    modernHandler.notify.resourcesChanged();
  });
  const sharedPageStore = new PageSnapshotStore();
  // One guard for the whole endpoint. The modern leg builds a fresh McpServer
  // per request, so a per-instance guard would discard every accepted access
  // grant the moment the request ended — re-prompting on each subsequent call
  // and leaving the listen-watcher path validating against a stale allowed set.
  // Grant scope is therefore the endpoint, not the connection: with API_KEY set
  // every caller presents the same key (one auth context by construction), and
  // without it the bind is loopback-only. Split into per-auth-context guards if
  // this ever serves more than one credential.
  const sharedPathGuard = new PathGuard(options);
  await sharedPathGuard.recomputeAllowedDirectories();

  const modernHandler: McpHttpHandler = createMcpHandler(
    async ({ era }) => {
      const c = await createServer(options, {
        watcherRegistry: sharedRegistry,
        notifier: modernHandler.notify,
        pathGuard: sharedPathGuard,
        resourceStore: sharedStore,
        pageStore: sharedPageStore,
        era,
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
      const previousOnClose = c.mcp.server.onclose;
      c.mcp.server.onclose = () => {
        previousOnClose?.();
        c.disposeRuntimeState();
      };
      return c.mcp;
    },
    {
      legacy: 'reject',
      onerror: (error: Error) => {
        Logger.error('[HTTP] modern leg error:', formatUnknownErrorMessage(error));
      },
    },
  );
  const modernNodeHandler = toNodeHandler(modernHandler);

  const app = setupExpressApp(
    httpHost,
    apiKey,
    allowedHosts,
    modernNodeHandler,
    sharedPathGuard,
    sharedRegistry,
    modernHandler.notify,
  );

  const httpServer = createHttpServer(app);
  // Must exceed the idle timeout of any proxy in front of this server, or the
  // proxy reuses connections the server already closed (intermittent 502s).
  const keepAliveMs = parseEnvInt('FS_KEEPALIVE_TIMEOUT_MS', 5_000, 1_000, 600_000);
  httpServer.keepAliveTimeout = keepAliveMs;
  httpServer.headersTimeout = keepAliveMs + 5_000;
  httpServer.requestTimeout = DEFAULT_REQUEST_TIMEOUT_MSEC;

  const onHttpServerError = (error: Error): void => {
    Logger.error('[HTTP] runtime server error', {
      host: httpHost,
      port,
      error: formatUnknownErrorMessage(error),
    });
  };
  httpServer.on('error', onHttpServerError);

  const teardown = (): Promise<void> => {
    sharedRegistry.destroy();
    sharedPageStore.clear();
    return modernHandler.close().catch((err: unknown) => {
      Logger.error('[HTTP] Error closing handler:', formatUnknownErrorMessage(err));
    });
  };
  const originalClose = httpServer.close.bind(httpServer);
  httpServer.close = function (callback?: (error?: Error) => void) {
    void teardown().then(() => {
      originalClose(callback);
    });
    return httpServer;
  };

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      void teardown();
      reject(err);
    };
    httpServer.once('error', onError);

    httpServer.listen(port, httpHost, () => {
      httpServer.removeListener('error', onError);
      Logger.info(`[HTTP] Server listening on http://${httpHost}:${port}`);
      resolve(httpServer);
    });
  });
}
