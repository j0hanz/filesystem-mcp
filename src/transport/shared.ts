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
  /** `--http-host` or `FS_HTTP_HOST`. The HTTP bind defaults to loopback without it. */
  httpHost?: string;
  /** `--api-key` or `FS_API_KEY`. Unset means open access (loopback dev mode). */
  apiKey?: string;
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

/**
 * The de-duplicated `resourceSubscriptions` URIs of a structurally valid
 * `subscriptions/listen` request — `[]` when it names none — or `undefined` for
 * anything else, including a listen the schema rejects. Both legs gate watcher
 * attachment on this: a malformed listen cannot succeed downstream, so creating
 * and tearing down `fs.watch` handles for it is pure waste — and on HTTP the
 * teardown depended on the response-close listener firing.
 *
 * The method check runs first because every inbound stdio message passes
 * through here; only a listen pays for the schema parse.
 */
export function listenSubscriptionUris(message: unknown): string[] | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  if ((message as { method?: unknown }).method !== 'subscriptions/listen') return undefined;
  const result = specTypeSchemas.SubscriptionsListenRequest['~standard'].validate(message);
  if (result instanceof Promise || result.issues !== undefined) return undefined;
  // De-duplicate: one attach must yield one ref-count, or the release below
  // decrements further than it incremented and tears down a live watcher.
  return [...new Set(result.value.params.notifications.resourceSubscriptions ?? [])];
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
  uris: readonly string[],
  pathGuard: PathGuard,
  registry: WatcherRegistry,
  notify: (uri: string) => void,
): Promise<ListenPreparation> {
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
