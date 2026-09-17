// Pieces both transport legs share: the runtime config contract, the JSON-RPC
// error envelope, and the `subscriptions/listen` watcher-preparation ladder.
// stdio and HTTP gate the same message shape; only where the lease is released
// differs (connection close vs response close).
import { JSONRPC_VERSION, specTypeSchemas } from '@modelcontextprotocol/server';

import { formatUnknownErrorMessage } from '../core/errors.ts';
import type { PathGuard } from '../core/path.ts';
import {
  MAX_WATCHERS,
  type WatcherAttachResult,
  type WatcherRegistry,
} from '../core/watcher-registry.ts';

/**
 * Runtime inputs the CLI resolves once (flag, else the operator's env var) and
 * hands the transport. Separate from `ServerOptions` because that object is
 * `PathGuard`'s constructor argument: the filesystem guard has no use for a
 * bind address and no business holding a bearer secret.
 */
export interface RuntimeConfig {
  /** `--http-host` or `HTTP_HOST`. The HTTP bind defaults to loopback without it. */
  httpHost?: string;
  /** `--api-key` or `API_KEY`. Unset means open access (loopback dev mode). */
  apiKey?: string;
}

/**
 * True when `message` really is a `subscriptions/listen` request, not merely a
 * body carrying that method string. Both legs gate watcher attachment on this:
 * a malformed listen cannot succeed downstream, so creating and tearing down
 * `fs.watch` handles for it is pure waste — and on HTTP the teardown depended on
 * the response-close listener firing. Non-listen bodies fail it too, which is
 * the same answer `listenSubscriptionUris` gives them.
 */
export function isStructurallyValidListen(message: unknown): boolean {
  const result = specTypeSchemas.SubscriptionsListenRequest['~standard'].validate(message);
  return !('issues' in result);
}

/** The request id of a parsed JSON-RPC body, for error-envelope echo. */
export function jsonRpcRequestId(parsedBody: unknown): string | number | null {
  const id = (parsedBody as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/**
 * The one JSON-RPC error envelope both legs refuse in. HTTP wraps it in
 * `sendJsonRpcError` to add status and headers; stdio hands it straight to the
 * wire. A second hand-built literal is how the two drift apart.
 */
export function jsonRpcError<Id extends string | number | null>(
  code: number,
  message: string,
  id: Id,
): { jsonrpc: typeof JSONRPC_VERSION; id: Id; error: { code: number; message: string } } {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

/** The `resourceSubscriptions` URIs of a `subscriptions/listen` body, de-duplicated. */
export function listenSubscriptionUris(parsedBody: unknown): string[] {
  if (typeof parsedBody !== 'object' || parsedBody === null) return [];
  const body = parsedBody as {
    method?: unknown;
    params?: { notifications?: { resourceSubscriptions?: unknown } };
  };
  if (body.method !== 'subscriptions/listen') return [];
  const uris = body.params?.notifications?.resourceSubscriptions;
  if (!Array.isArray(uris)) return [];
  // De-duplicate: one attach must yield one ref-count, or the release below
  // decrements further than it incremented and tears down a live watcher.
  return [...new Set(uris.filter((uri): uri is string => typeof uri === 'string'))];
}

export type ListenPreparation =
  | { readonly ok: true; readonly acquiredUris: string[] }
  | { readonly ok: false; readonly message: string };

const WATCHER_FAILURE_REASONS = {
  'bad-uri': 'unsupported resource URI',
  capped: `watcher limit ${MAX_WATCHERS} reached`,
  'attach-failed': 'filesystem watcher could not be created',
  stale: 'subscription was cancelled during setup',
} as const;

function watcherFailureMessage(
  uri: string,
  result: Exclude<WatcherAttachResult, { ok: true }>,
): string {
  const why =
    result.reason === 'invalid-path'
      ? formatUnknownErrorMessage(result.error)
      : WATCHER_FAILURE_REASONS[result.reason];
  return `Cannot subscribe to ${uri}: ${why}`;
}

/**
 * Prepare every filesystem watcher named by a `subscriptions/listen` filter.
 * The batch is all-or-nothing: a failed URI releases each prior lease.
 */
export async function prepareListenWatchers(
  parsedBody: unknown,
  pathGuard: PathGuard,
  registry: WatcherRegistry,
  notify: (uri: string) => void,
): Promise<ListenPreparation> {
  const uris = listenSubscriptionUris(parsedBody);
  const acquired: string[] = [];
  for (const uri of uris) {
    const result = await registry.acquire(pathGuard, uri, notify);
    if (!result.ok) {
      for (const prior of acquired) registry.release(prior);
      return { ok: false, message: watcherFailureMessage(uri, result) };
    }
    acquired.push(uri);
  }
  return { ok: true, acquiredUris: acquired };
}
