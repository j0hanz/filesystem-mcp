import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import { localhostAllowedHostnames } from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';

import { createHash, timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ErrorCode, FsError } from '../core/errors.js';
import { Logger } from '../core/observability.js';
import { splitCsvList } from '../core/util.js';
import { jsonRpcError } from './shared.js';

const MAX_BEARER_TOKEN_LENGTH = 4096;

/**
 * JSON-RPC's server-defined error range. No SDK enum maps to "Unauthorized" or
 * "Rate limit exceeded", both of which this module refuses before any handler
 * has parsed a request.
 */
export const JSONRPC_SERVER_ERROR = -32000;

/**
 * The one way an HTTP refusal goes out — this module's pre-handler rejections
 * and `http.ts`'s route-level ones. The envelope itself is `jsonRpcError` in
 * `shared.ts`, so the stdio leg sends the same literal; this wrapper owns only
 * what HTTP adds on top.
 *
 * `headers` carries what a particular refusal owes the client on top of the
 * JSON content type — `WWW-Authenticate` on a 401, `Retry-After` on a 429.
 * Goes out through `res.json` so every refusal keeps the `charset=utf-8` and
 * `Content-Length` a hand-rolled `writeHead`/`end` pair drops.
 */
export function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
  id: string | number | null = null,
  headers: Record<string, string> = {},
): void {
  res
    .status(status)
    .set(headers)
    .json(jsonRpcError(code, message, id));
}

const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u;

/**
 * Pure HTTP auth and binding policy. Holds no state; all functions are
 * directly testable without spinning up a server.
 */
export function isLoopbackHttpHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === '127.0.0.1' ||
    normalizedHost === 'localhost' ||
    normalizedHost === '[::1]' ||
    normalizedHost === '::1'
  );
}

export function isAllowedLocalhostOrigin(origin: string): boolean {
  return LOCALHOST_ORIGIN_RE.test(origin);
}

/** A bind to every interface. Clients never send `Host: 0.0.0.0`, so this bind
 * cannot derive its allowed-host set from itself. */
function isWildcardHttpHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

function originHostname(origin: string): string | undefined {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

/**
 * True if `origin` (a raw `Origin` request header) is allowed given the
 * env-derived `allowedHostnames` set (hostname-form, no scheme/port). Localhost
 * origins are always accepted via {@link isAllowedLocalhostOrigin}; a remote
 * origin is accepted iff its parsed hostname is in the set. Both the SDK app's
 * `allowedOrigins` and this OPTIONS-handler check consume hostname-form, so a
 * remote origin allowed via `FS_ALLOWED_ORIGINS` is reflected
 * end-to-end in `Access-Control-Allow-Origin`.
 */
export function isOriginAllowed(origin: string, allowedHostnames: readonly string[]): boolean {
  if (isAllowedLocalhostOrigin(origin)) return true;
  const host = originHostname(origin);
  return host !== undefined && allowedHostnames.includes(host);
}

export function validateBearerAuthorization(
  apiKey: string,
  authHeader: unknown,
): authHeader is string {
  const bearerPrefix = 'Bearer ';
  if (typeof authHeader !== 'string' || !authHeader.startsWith(bearerPrefix)) {
    return false;
  }
  const userKey = authHeader.slice(bearerPrefix.length).trim();
  const normalizedApiKey = apiKey.trim();
  if (userKey.length > MAX_BEARER_TOKEN_LENGTH || normalizedApiKey.length === 0) {
    return false;
  }

  // Pure: hash per call. createHash is negligible next to the timingSafeEqual
  // already done per request, and avoiding module-level cache state keeps this
  // testable without post-import env-mutation footguns.
  const expectedHash = createHash('sha256').update(normalizedApiKey).digest();
  const actualHash = createHash('sha256').update(userKey).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

function isSecureApiKey(key: string | undefined): boolean {
  return typeof key === 'string' && key.trim().length >= 16;
}

/**
 * Refuse to bind to a non-loopback host without an API key. Throws on
 * policy violation; returns silently when allowed.
 */
export function assertHttpBindingPolicy(host: string, apiKey: string | undefined): void {
  if (isLoopbackHttpHost(host)) {
    if (apiKey !== undefined && !isSecureApiKey(apiKey)) {
      throw new FsError(
        ErrorCode.PERMISSION_DENIED,
        'API_KEY is configured but is insecure (minimum 16 characters).',
      );
    }
    return;
  }
  if (isSecureApiKey(apiKey)) return;
  throw new FsError(
    ErrorCode.PERMISSION_DENIED,
    `Refusing to bind HTTP server to non-loopback host '${host}' without a secure API_KEY (minimum 16 characters).`,
  );
}

/**
 * The Host header values this bind accepts. `FS_ALLOWED_HOSTS` wins
 * when set; otherwise a loopback bind takes the whole localhost hostname set (a
 * client dialing http://localhost:<port> sends `Host: localhost`, which a bare
 * ['127.0.0.1'] list would 403), a wildcard bind takes none, and a concrete
 * non-loopback bind takes itself. An empty result means no Host validation is
 * mounted — only reachable under FS_ALLOW_UNRESTRICTED_HOSTS=1.
 */
export function resolveAllowedHosts(
  httpHost: string,
  allowedHostsEnv: string | undefined,
): string[] {
  const configured = splitCsvList(allowedHostsEnv);
  if (configured.length > 0) return configured;
  if (isLoopbackHttpHost(httpHost)) return localhostAllowedHostnames();
  if (isWildcardHttpHost(httpHost)) return [];
  return [httpHost];
}

/**
 * Express's `trust proxy` setting from `FS_TRUST_PROXY`. A
 * non-negative integer hop count parses to a number (Express counts hops from
 * the socket); anything else (a subnet name/expression, or a negative/
 * non-integer string) passes through unchanged for Express to interpret.
 * `undefined` means the env var was unset or empty — leave Express's default
 * (disabled) in place.
 */
export function resolveTrustProxySetting(value: string | undefined): number | string | undefined {
  if (!value) return undefined;
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 ? hops : value;
}

/**
 * Refuse to bind a wildcard host (`0.0.0.0` / `::`) without an explicit
 * `FS_ALLOWED_HOSTS` list. Clients never send `Host: 0.0.0.0`, so
 * defaulting the allowed-host set to the wildcard string would reject all real
 * traffic. Operators who accept the risk can set
 * `FS_ALLOW_UNRESTRICTED_HOSTS=1` to restore warn-and-bind.
 * Loopback and concrete non-loopback hosts are unaffected.
 */
export function assertHttpHostPolicy(
  host: string,
  allowedHosts: readonly string[],
  allowUnrestricted: boolean,
): void {
  if (isLoopbackHttpHost(host)) return;
  // concrete non-loopback: Host validated against the bind host.
  if (!isWildcardHttpHost(host)) return;
  if (allowUnrestricted) return;
  if (allowedHosts.length > 0) return;
  throw new FsError(
    ErrorCode.PERMISSION_DENIED,
    `Refusing to bind wildcard host '${host}' without FS_ALLOWED_HOSTS. Set it to the public hostname(s) clients send, or set FS_ALLOW_UNRESTRICTED_HOSTS=true to accept the risk.`,
  );
}

// ─── Protected-resource discovery (RFC 9728 / RFC 6750) ──────────────────────

/**
 * This server is a resource server with no authorization server: `API_KEY` is a
 * static secret the operator hands out of band, not an issued token. So the
 * metadata document deliberately omits `authorization_servers` — RFC 9728 §2
 * makes it optional, and its absence is the accurate statement that a token
 * cannot be obtained from an endpoint. `mcpAuthMetadataRouter` from
 * `@modelcontextprotocol/express` is the tool for the IdP-backed case: it
 * requires RFC 8414 authorization-server metadata, and inventing an issuer with
 * endpoints that answer nothing would send clients into a flow that cannot
 * complete. Adopt it if this ever moves to a real IdP.
 *
 * What discovery buys here: a client hitting 401 learns the resource identifier
 * and that the credential goes in the Authorization header, instead of a bare
 * challenge plus a 404 on the well-known path.
 */
export function protectedResourceUrl(
  req: Request,
  hostValidated: boolean,
  configured: string | undefined,
): URL | null {
  if (configured) {
    const parsed = URL.parse(configured);
    if (parsed) return parsed;
    Logger.warn(
      `[HTTP] Ignoring unparseable FS_PUBLIC_URL: ${configured}. Deriving the resource identifier from the Host header instead.`,
    );
  }
  // With no Host validator mounted (FS_ALLOW_UNRESTRICTED_HOSTS=1)
  // the Host header is attacker-controlled, and naming a resource from it would
  // publish an identifier the operator does not own. Answer with nothing instead.
  if (!hostValidated) return null;
  const host = req.headers.host ?? '127.0.0.1';
  return URL.parse(`${req.secure ? 'https' : 'http'}://${host}/mcp`);
}

/**
 * RFC 6750 §3: a request with no credentials gets a bare challenge, while one
 * that presented something invalid gets `error="invalid_token"`. Clients use
 * the difference to tell "you must authenticate" from "your token is wrong".
 */
function buildAuthChallenge(
  req: Request,
  hasCredentials: boolean,
  hostValidated: boolean,
  publicUrl: string | undefined,
): string {
  const resource = protectedResourceUrl(req, hostValidated, publicUrl);
  const params: string[] = [];
  if (resource) {
    params.push(`resource_metadata="${getOAuthProtectedResourceMetadataUrl(resource)}"`);
  }
  if (hasCredentials) {
    params.push('error="invalid_token"', 'error_description="Invalid or expired bearer token"');
  }
  // A bare `Bearer` is a complete challenge; avoid emitting a trailing space.
  return params.length > 0 ? `Bearer ${params.join(', ')}` : 'Bearer';
}

/**
 * Express middleware: when `apiKey` is set, require a matching bearer token.
 * No key set = open access (loopback dev mode). `apiKey` is captured once per
 * app setup (passed in from startHttpServer) so the middleware and
 * assertHttpBindingPolicy share one source of truth.
 *
 * `requireBearerAuth` + `verifyAccessToken` from `@modelcontextprotocol/express`
 * is the tool for verifier-backed tokens; this middleware stays hand-rolled
 * because the credential is a static operator key with no verifier, the 401 body
 * must stay a JSON-RPC envelope, and the RFC 6750 bare-vs-`invalid_token`
 * challenge split is implemented here. Adopt `requireBearerAuth` if this ever
 * verifies issued tokens.
 */
export function bearerAuthMiddleware(
  apiKey: string | undefined,
  hostValidated: boolean,
  publicUrl?: string,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!apiKey) {
      next();
      return;
    }
    const authHeader = req.headers.authorization;
    if (isSecureApiKey(apiKey) && validateBearerAuthorization(apiKey, authHeader)) {
      // Forward the validated caller to the SDK pipeline: toNodeHandler reads
      // req.auth and passes it as the handler's pass-through authInfo, which the
      // per-request factory receives on ctx.http.
      // `expiresAt` is deliberately omitted: a static API key has no expiry and
      // there is no `exp` claim or introspection response to read one from.
      // Populate it from the token if this ever moves to issued tokens.
      const presented = authHeader.slice('Bearer '.length).trim();
      (req as Request & { auth?: AuthInfo }).auth = {
        token: presented,
        clientId: 'api-key',
        scopes: [],
      };
      next();
      return;
    }
    sendJsonRpcError(res, 401, JSONRPC_SERVER_ERROR, 'Unauthorized', null, {
      'WWW-Authenticate': buildAuthChallenge(
        req,
        req.headers.authorization !== undefined,
        hostValidated,
        publicUrl,
      ),
    });
  };
}

/**
 * Env-derived CORS origins (hostname-form, no scheme/port — matches the SDK
 * app's `allowedOrigins` consumer). Defaults to the SDK's loopback hostname set
 * so loopback browser clients keep working; operators set
 * `FS_ALLOWED_ORIGINS` to allow remote clients on non-loopback
 * binds. An empty value reads as unset, matching how parseAllowedHostsEnv
 * treats an all-empty list. The same set is consulted by corsPreflightHandler
 * so a remote origin is reflected end-to-end in Access-Control-Allow-Origin.
 */
export function computeAllowedOriginHostnames(originsEnv: string | undefined): string[] {
  // Truthiness, not list length: an all-blank value (" , ") is a configured but
  // empty allow-list — deny every remote origin — while an unset or "" value
  // falls back to the loopback defaults.
  return originsEnv ? splitCsvList(originsEnv) : localhostAllowedHostnames();
}

/**
 * Reflect a present Origin on the response if it is allowed — localhost, or
 * in the env-derived `FS_ALLOWED_ORIGINS` set — and avoid
 * emitting a wildcard fallback. Shared by the OPTIONS preflight and the real
 * POST response: `createMcpExpressApp`'s `allowedOrigins` only gates which
 * Origins are accepted, it never sets `Access-Control-Allow-Origin` on the
 * actual response, so without this a browser client would pass preflight and
 * then have the POST response body blocked by CORS.
 */
function reflectAllowedOrigin(
  req: Request,
  res: Response,
  allowedOriginHostnames: readonly string[],
): void {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin, allowedOriginHostnames)) {
    res.header('Access-Control-Allow-Origin', origin);
    // Key the response by Origin so a CDN/proxy caching one origin's response
    // cannot replay it for a different origin (cache-poison).
    res.header('Vary', 'Origin');
  }
}

/** Mounted ahead of the `/mcp` handlers so every response — not just the
 * OPTIONS preflight — carries `Access-Control-Allow-Origin` for an allowed
 * Origin. */
export function corsOriginMiddleware(allowedOriginHostnames: readonly string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    reflectAllowedOrigin(req, res, allowedOriginHostnames);
    next();
  };
}

/**
 * OPTIONS preflight for `/mcp`. The allow-list carries the SEP-2243 standard
 * headers (`mcp-protocol-version`, `mcp-method`, `mcp-name`): SDK clients send
 * all three on every modern request POST and `createMcpHandler` requires them
 * (400 / -32020), so omitting them here would fail every browser preflight —
 * and the HTTP leg is modern-only, so there is no legacy path to fall back to.
 * `mcp-session-id` is deliberately absent: it is 2025-era only and this
 * endpoint rejects legacy traffic.
 */
export function corsPreflightHandler(allowedOriginHostnames: readonly string[]): RequestHandler {
  return (req: Request, res: Response): void => {
    reflectAllowedOrigin(req, res, allowedOriginHostnames);
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, mcp-protocol-version, mcp-method, mcp-name',
    );
    res.status(204).end();
  };
}

// ─── Rate limiting (public bind only) ────────────────────────────────────────

interface RateBucket {
  windowStart: number;
  count: number;
}

// Fixed 60s window; never tuned, so it is a constant rather than config plumbing.
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Fixed-window per-client-IP rate limiter.
 */
export function createRateLimiter(max: number): RequestHandler {
  const buckets = new Map<string, RateBucket>();
  const sweep = setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
    for (const [ip, bucket] of buckets) {
      if (bucket.windowStart < cutoff) buckets.delete(ip);
    }
  }, RATE_LIMIT_WINDOW_MS);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
      bucket = { windowStart: now, count: 0 };
      buckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= max) {
      next();
      return;
    }
    const retryAfterSec = Math.max(
      1,
      Math.ceil((bucket.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000),
    );
    sendJsonRpcError(res, 429, JSONRPC_SERVER_ERROR, 'Rate limit exceeded', null, {
      'Retry-After': String(retryAfterSec),
    });
  };
}
