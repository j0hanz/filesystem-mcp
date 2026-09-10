import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import type { Request, Response } from 'express';

import { ErrorCode, isFsError } from '../src/core/errors.js';
import { splitCsvList } from '../src/core/util.js';
import {
  assertHttpBindingPolicy,
  assertHttpHostPolicy,
  bearerAuthMiddleware,
  computeAllowedOriginHostnames,
  corsMiddleware,
  createRateLimiter,
  isAllowedLocalhostOrigin,
  isLoopbackHttpHost,
  isOriginAllowed,
  resolveAllowedHosts,
  resolveTrustProxySetting,
  validateBearerAuthorization,
} from '../src/transport/http-policy.js';
import { startHttpServer } from '../src/transport/http.js';
import { cleanupTestRoot, createTestRoot } from './helpers.js';

interface MockResponse {
  statusCode?: number;
  headers: Record<string, string>;
  body?: string;
  ended: boolean;
  header(name: string, value: string): MockResponse;
  set(headers: Record<string, string>): MockResponse;
  status(code: number): MockResponse;
  json(body: unknown): MockResponse;
  end(): MockResponse;
}

function createMockResponse(): Response & MockResponse {
  const res: MockResponse = {
    headers: {},
    ended: false,
    header(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    set(headers: Record<string, string>) {
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v;
      }
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    // Express sets the JSON content type and serializes; the mock records what
    // the assertions read back, so `res.body` stays the JSON string either way.
    json(body: unknown) {
      this.headers['content-type'] = 'application/json; charset=utf-8';
      this.body = JSON.stringify(body);
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return res as unknown as Response & MockResponse;
}

function createMockRequest(
  options: {
    headers?: Record<string, string | undefined>;
    ip?: string;
    remoteAddress?: string;
    method?: string;
    path?: string;
  } = {},
): Request {
  const headers = options.headers ?? {};
  return {
    headers,
    ip: options.ip,
    socket: {
      remoteAddress: options.remoteAddress ?? options.ip ?? '127.0.0.1',
    },
    method: options.method,
    path: options.path,
  } as unknown as Request;
}

describe('HTTP Policy & Security', () => {
  describe('validateBearerAuthorization (TC-SEC-021 - TC-SEC-024)', () => {
    const validKey = 'super-secret-api-key-123456';

    it('TC-SEC-021: Validates correct Bearer authorization token', () => {
      const isValid = validateBearerAuthorization(validKey, `Bearer ${validKey}`);
      assert.strictEqual(isValid, true, 'Matching Bearer token should be accepted');

      // Key with whitespace trimming
      assert.strictEqual(
        validateBearerAuthorization(`  ${validKey}  `, `Bearer ${validKey}`),
        true,
        'API key with surrounding whitespace should be trimmed and accepted',
      );
      assert.strictEqual(
        validateBearerAuthorization(validKey, `Bearer   ${validKey}   `),
        true,
        'Auth header token with whitespace should be trimmed and accepted',
      );
    });

    it('TC-SEC-022: Rejects wrong Bearer authorization token', () => {
      assert.strictEqual(
        validateBearerAuthorization(validKey, 'Bearer wrong-key-here-123456'),
        false,
        'Incorrect Bearer token should be rejected',
      );
      assert.strictEqual(
        validateBearerAuthorization(validKey, `Bearer ${validKey.slice(0, -1)}`),
        false,
        'Partially matching Bearer token should be rejected',
      );
    });

    it('TC-SEC-023: Rejects missing or non-string authorization headers', () => {
      assert.strictEqual(validateBearerAuthorization(validKey, undefined), false);
      assert.strictEqual(validateBearerAuthorization(validKey, null), false);
      assert.strictEqual(validateBearerAuthorization(validKey, 12345), false);
      assert.strictEqual(validateBearerAuthorization(validKey, {}), false);
      assert.strictEqual(validateBearerAuthorization(validKey, ''), false);
    });

    it('TC-SEC-024: Rejects invalid auth schemes, empty keys, and oversized tokens', () => {
      assert.strictEqual(
        validateBearerAuthorization(validKey, `Basic ${validKey}`),
        false,
        'Basic scheme should be rejected',
      );
      assert.strictEqual(
        validateBearerAuthorization(validKey, `bearer ${validKey}`),
        false,
        'Lowercase bearer should be rejected',
      );
      assert.strictEqual(
        validateBearerAuthorization(validKey, `Token ${validKey}`),
        false,
        'Token scheme should be rejected',
      );
      assert.strictEqual(
        validateBearerAuthorization(validKey, 'Bearer'),
        false,
        'Bearer without token should be rejected',
      );
      assert.strictEqual(
        validateBearerAuthorization(validKey, 'Bearer   '),
        false,
        'Bearer with only spaces should be rejected',
      );
      assert.strictEqual(
        validateBearerAuthorization('', `Bearer ${validKey}`),
        false,
        'Empty configured API key should reject all tokens',
      );
      assert.strictEqual(
        validateBearerAuthorization('   ', `Bearer ${validKey}`),
        false,
        'Whitespace-only configured API key should reject all tokens',
      );

      const oversizedToken = `Bearer ${'a'.repeat(4097)}`;
      assert.strictEqual(
        validateBearerAuthorization(validKey, oversizedToken),
        false,
        'Token exceeding maximum length (4096 chars) should be rejected',
      );
    });
  });

  describe('bearerAuthMiddleware (TC-SEC-038 - TC-SEC-040)', () => {
    const secureKey = 'secure-key-16-characters-long';

    it('TC-SEC-038: calls next() when no API key is configured', () => {
      const mw = bearerAuthMiddleware(undefined, false);
      const req = createMockRequest();
      const res = createMockResponse();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.strictEqual(nextCalled, true);
      assert.strictEqual(res.statusCode, undefined);
    });

    it('TC-SEC-039: calls next() for a matching Bearer token, 401 otherwise', () => {
      const mw = bearerAuthMiddleware(secureKey, false);

      // Matching bearer -> next()
      const okReq = createMockRequest({ headers: { authorization: `Bearer ${secureKey}` } });
      const okRes = createMockResponse();
      let okNext = false;
      mw(okReq, okRes, () => {
        okNext = true;
      });
      assert.strictEqual(okNext, true);
      assert.strictEqual(okRes.statusCode, undefined);
      // okReq is `as unknown as Request`; read auth back the same way.
      const auth = (okReq as unknown as { auth?: { clientId: string; scopes: string[] } }).auth;
      assert.ok(auth, 'matching bearer must attach req.auth for toNodeHandler to forward');
      assert.strictEqual(auth.clientId, 'api-key');
      assert.deepStrictEqual(auth.scopes, []);

      // Wrong bearer -> 401 JSON-RPC error
      const badReq = createMockRequest({
        headers: { authorization: 'Bearer wrong-key-here-123456' },
      });
      const badRes = createMockResponse();
      let badNext = false;
      mw(badReq, badRes, () => {
        badNext = true;
      });
      assert.strictEqual(badNext, false);
      assert.strictEqual(badRes.statusCode, 401);
      // `res.json` adds the charset; every refusal this server sends carries it.
      assert.strictEqual(badRes.headers['content-type'], 'application/json; charset=utf-8');
      assert.ok(badRes.headers['www-authenticate'], 'WWW-Authenticate header should be present');
      const body = JSON.parse(badRes.body ?? '{}');
      assert.strictEqual(body.jsonrpc, '2.0');
      assert.strictEqual(body.error.code, -32000);
    });

    it('TC-SEC-040: returns 401 when the Authorization header is missing', () => {
      const mw = bearerAuthMiddleware(secureKey, false);
      const req = createMockRequest({ headers: {} });
      const res = createMockResponse();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.strictEqual(nextCalled, false);
      assert.strictEqual(res.statusCode, 401);
      assert.ok(res.headers['www-authenticate']);
    });
  });

  describe('assertHttpBindingPolicy (TC-SEC-025 - TC-SEC-027)', () => {
    const secureKey = 'secure-key-16-characters-long';
    const shortKey = 'short-key';

    it('TC-SEC-025: Loopback binding is allowed without key or with secure key', () => {
      assert.doesNotThrow(() => {
        assertHttpBindingPolicy('127.0.0.1', undefined);
      }, 'Loopback 127.0.0.1 allowed without key');

      assert.doesNotThrow(() => {
        assertHttpBindingPolicy('localhost', undefined);
      }, 'Loopback localhost allowed without key');

      assert.doesNotThrow(() => {
        assertHttpBindingPolicy('[::1]', undefined);
      }, 'Loopback [::1] allowed without key');

      assert.doesNotThrow(() => {
        assertHttpBindingPolicy('127.0.0.1', secureKey);
      }, 'Loopback allowed with secure key');
    });

    it('TC-SEC-026: Non-loopback binding is rejected without key, allowed with secure key', () => {
      assert.throws(
        () => assertHttpBindingPolicy('0.0.0.0', undefined),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.PERMISSION_DENIED);
          assert.match(err.message, /Refusing to bind HTTP server to non-loopback host/);
          return true;
        },
        '0.0.0.0 without key should throw PERMISSION_DENIED',
      );

      assert.throws(
        () => assertHttpBindingPolicy('192.168.1.100', undefined),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.PERMISSION_DENIED);
          return true;
        },
        'Private IP without key should throw PERMISSION_DENIED',
      );

      assert.throws(
        () => assertHttpBindingPolicy('example.com', undefined),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.PERMISSION_DENIED);
          return true;
        },
        'Domain host without key should throw PERMISSION_DENIED',
      );

      assert.doesNotThrow(() => {
        assertHttpBindingPolicy('0.0.0.0', secureKey);
      }, '0.0.0.0 with secure key should be allowed');

      assert.doesNotThrow(() => {
        assertHttpBindingPolicy('192.168.1.100', secureKey);
      }, '192.168.1.100 with secure key should be allowed');
    });

    it('TC-SEC-027: Rejects short API key (<16 chars) on both loopback and non-loopback hosts', () => {
      assert.throws(
        () => assertHttpBindingPolicy('127.0.0.1', shortKey),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.PERMISSION_DENIED);
          assert.match(err.message, /insecure/);
          return true;
        },
        'Loopback with insecure key should throw PERMISSION_DENIED',
      );

      assert.throws(
        () => assertHttpBindingPolicy('0.0.0.0', shortKey),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.PERMISSION_DENIED);
          return true;
        },
        'Non-loopback with insecure key should throw PERMISSION_DENIED',
      );

      assert.throws(
        () => assertHttpBindingPolicy('localhost', '123456789012345'), // 15 characters
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.PERMISSION_DENIED);
          return true;
        },
        '15-character key should be rejected as insecure',
      );
    });
  });

  describe('CORS and Origin Policy (TC-SEC-028 - TC-SEC-031)', () => {
    it('TC-SEC-028: isAllowedLocalhostOrigin validates localhost origins and rejects external/spoofed origins', () => {
      assert.strictEqual(isAllowedLocalhostOrigin('http://localhost'), true);
      assert.strictEqual(isAllowedLocalhostOrigin('http://localhost:3000'), true);
      assert.strictEqual(isAllowedLocalhostOrigin('https://127.0.0.1:8080'), true);
      assert.strictEqual(isAllowedLocalhostOrigin('http://[::1]:5173'), true);
      assert.strictEqual(isAllowedLocalhostOrigin('https://localhost'), true);

      assert.strictEqual(isAllowedLocalhostOrigin('http://localhost.attacker.com'), false);
      assert.strictEqual(isAllowedLocalhostOrigin('http://127.0.0.1.attacker.com'), false);
      assert.strictEqual(isAllowedLocalhostOrigin('http://evil.com'), false);
      assert.strictEqual(isAllowedLocalhostOrigin('http://evil.com/localhost'), false);
      assert.strictEqual(isAllowedLocalhostOrigin('file:///etc/passwd'), false);
      assert.strictEqual(isAllowedLocalhostOrigin('null'), false);
      assert.strictEqual(isAllowedLocalhostOrigin(''), false);
    });

    it('TC-SEC-029: computeAllowedOriginHostnames parses env list or defaults to localhost hostnames', () => {
      const parsed = computeAllowedOriginHostnames('app.example.com, dashboard.internal');
      assert.deepStrictEqual(parsed, ['app.example.com', 'dashboard.internal']);

      const trimmed = computeAllowedOriginHostnames('  app.example.com  ,   ');
      assert.deepStrictEqual(trimmed, ['app.example.com']);

      const defaults = computeAllowedOriginHostnames(undefined);
      assert.deepStrictEqual(defaults, ['localhost', '127.0.0.1', '[::1]']);

      const emptyDefaults = computeAllowedOriginHostnames('');
      assert.deepStrictEqual(emptyDefaults, ['localhost', '127.0.0.1', '[::1]']);

      const spaceDefaults = computeAllowedOriginHostnames(' , ');
      assert.deepStrictEqual(spaceDefaults, []);
    });

    it('TC-SEC-030: isOriginAllowed allows localhost origins unconditionally and remote origins if in allowed list', () => {
      assert.strictEqual(isOriginAllowed('http://localhost:3000', []), true);
      assert.strictEqual(isOriginAllowed('http://127.0.0.1:8080', ['app.example.com']), true);
      assert.strictEqual(isOriginAllowed('http://[::1]:5000', []), true);

      assert.strictEqual(isOriginAllowed('https://app.example.com', ['app.example.com']), true);
      assert.strictEqual(
        isOriginAllowed('https://app.example.com:8443', ['app.example.com']),
        true,
      );

      assert.strictEqual(isOriginAllowed('https://attacker.com', ['app.example.com']), false);
      assert.strictEqual(isOriginAllowed('https://attacker.com', []), false);
      assert.strictEqual(isOriginAllowed('not-a-valid-url', ['app.example.com']), false);
    });

    it('TC-SEC-031: corsMiddleware responds to OPTIONS requests with appropriate CORS headers', () => {
      const handler = corsMiddleware(['app.example.com']);

      // 1. Allowed localhost origin
      const reqLocalhost = createMockRequest({
        method: 'OPTIONS',
        path: '/',
        headers: { origin: 'http://localhost:3000' },
      });
      const resLocalhost = createMockResponse();
      handler(reqLocalhost, resLocalhost, () => {});

      assert.strictEqual(resLocalhost.statusCode, 204);
      assert.strictEqual(resLocalhost.ended, true);
      assert.strictEqual(
        resLocalhost.headers['access-control-allow-origin'],
        'http://localhost:3000',
      );
      assert.strictEqual(resLocalhost.headers['vary'], 'Origin');
      assert.strictEqual(resLocalhost.headers['access-control-allow-methods'], 'POST, OPTIONS');
      // Pins the SEP-2243 standard headers (mcp-protocol-version, mcp-method,
      // mcp-name): the SDK sends all three on every modern request POST and
      // createMcpHandler requires them, so a stale allow-list breaks every
      // browser client. mcp-session-id must NOT reappear (2025-era only).
      assert.strictEqual(
        resLocalhost.headers['access-control-allow-headers'],
        'Content-Type, Authorization, mcp-protocol-version, mcp-method, mcp-name',
      );

      // 2. Allowed remote origin
      const reqRemote = createMockRequest({
        method: 'OPTIONS',
        path: '/',
        headers: { origin: 'https://app.example.com' },
      });
      const resRemote = createMockResponse();
      handler(reqRemote, resRemote, () => {});

      assert.strictEqual(resRemote.statusCode, 204);
      assert.strictEqual(
        resRemote.headers['access-control-allow-origin'],
        'https://app.example.com',
      );
      assert.strictEqual(resRemote.headers['vary'], 'Origin');

      // 3. Disallowed origin
      const reqDisallowed = createMockRequest({
        method: 'OPTIONS',
        path: '/',
        headers: { origin: 'https://attacker.com' },
      });
      const resDisallowed = createMockResponse();
      handler(reqDisallowed, resDisallowed, () => {});

      assert.strictEqual(resDisallowed.statusCode, 204);
      assert.strictEqual(resDisallowed.headers['access-control-allow-origin'], undefined);
      assert.strictEqual(resDisallowed.headers['vary'], undefined);
      assert.strictEqual(resDisallowed.headers['access-control-allow-methods'], 'POST, OPTIONS');

      // 4. Missing origin header
      const reqNoOrigin = createMockRequest({ method: 'OPTIONS', path: '/', headers: {} });
      const resNoOrigin = createMockResponse();
      handler(reqNoOrigin, resNoOrigin, () => {});

      assert.strictEqual(resNoOrigin.statusCode, 204);
      assert.strictEqual(resNoOrigin.headers['access-control-allow-origin'], undefined);
      assert.strictEqual(resNoOrigin.headers['vary'], undefined);

      // 5. OPTIONS on a subpath falls through — the preflight stays on the exact
      // endpoint; no phantom 204. Origin reflection still happens, same as the
      // live corsMiddleware mount.
      const reqSubpath = createMockRequest({
        method: 'OPTIONS',
        path: '/sub',
        headers: { origin: 'http://localhost:3000' },
      });
      const resSubpath = createMockResponse();
      let subpathNext = false;
      handler(reqSubpath, resSubpath, () => {
        subpathNext = true;
      });
      assert.strictEqual(subpathNext, true);
      assert.strictEqual(resSubpath.ended, false);
      assert.strictEqual(resSubpath.statusCode, undefined);
      assert.strictEqual(resSubpath.headers['access-control-allow-methods'], undefined);
      assert.strictEqual(
        resSubpath.headers['access-control-allow-origin'],
        'http://localhost:3000',
      );
    });
  });

  describe('Host Resolution & Policy (TC-SEC-032 - TC-SEC-034)', () => {
    it('TC-SEC-032: resolveAllowedHosts derives host list from env or bind host', () => {
      // Env configuration takes precedence
      assert.deepStrictEqual(
        resolveAllowedHosts('127.0.0.1', 'mcp.example.com, internal.example.com'),
        ['mcp.example.com', 'internal.example.com'],
      );

      // Loopback host with unset/empty env defaults to localhostAllowedHostnames
      assert.deepStrictEqual(resolveAllowedHosts('127.0.0.1', undefined), [
        'localhost',
        '127.0.0.1',
        '[::1]',
      ]);
      assert.deepStrictEqual(resolveAllowedHosts('localhost', ''), [
        'localhost',
        '127.0.0.1',
        '[::1]',
      ]);
      assert.deepStrictEqual(resolveAllowedHosts('[::1]', undefined), [
        'localhost',
        '127.0.0.1',
        '[::1]',
      ]);

      // Wildcard host with unset env returns empty array
      assert.deepStrictEqual(resolveAllowedHosts('0.0.0.0', undefined), []);
      assert.deepStrictEqual(resolveAllowedHosts('::', undefined), []);

      // Concrete non-loopback host returns itself
      assert.deepStrictEqual(resolveAllowedHosts('192.168.1.100', undefined), ['192.168.1.100']);
      assert.deepStrictEqual(resolveAllowedHosts('custom.domain.net', undefined), [
        'custom.domain.net',
      ]);
    });

    it('TC-SEC-033: assertHttpHostPolicy permits loopback, concrete hosts, wildcard with allowedHosts, or unrestricted flag', () => {
      // Loopback hosts
      assert.doesNotThrow(() => assertHttpHostPolicy('127.0.0.1', [], false));
      assert.doesNotThrow(() => assertHttpHostPolicy('localhost', [], false));
      assert.doesNotThrow(() => assertHttpHostPolicy('[::1]', [], false));

      // Concrete non-loopback host
      assert.doesNotThrow(() => assertHttpHostPolicy('192.168.1.50', [], false));

      // Wildcard host with allowedHosts configured
      assert.doesNotThrow(() => assertHttpHostPolicy('0.0.0.0', ['mcp.example.com'], false));
      assert.doesNotThrow(() => assertHttpHostPolicy('::', ['mcp.example.com'], false));

      // Wildcard host with allowUnrestricted = true
      assert.doesNotThrow(() => assertHttpHostPolicy('0.0.0.0', [], true));
      assert.doesNotThrow(() => assertHttpHostPolicy('::', [], true));
    });

    it('TC-SEC-034: assertHttpHostPolicy rejects wildcard host without allowedHosts and allowUnrestricted=false', () => {
      assert.throws(
        () => assertHttpHostPolicy('0.0.0.0', [], false),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.PERMISSION_DENIED);
          assert.match(err.message, /Refusing to bind wildcard host '0\.0\.0\.0'/);
          return true;
        },
        '0.0.0.0 without allowedHosts should throw PERMISSION_DENIED',
      );

      assert.throws(
        () => assertHttpHostPolicy('::', [], false),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.PERMISSION_DENIED);
          assert.match(err.message, /Refusing to bind wildcard host '::'/);
          return true;
        },
        ':: without allowedHosts should throw PERMISSION_DENIED',
      );
    });
  });

  describe('createRateLimiter (TC-SEC-035 - TC-SEC-037)', () => {
    it('TC-SEC-035: Allows up to N requests within rate limit window', () => {
      const maxRequests = 3;
      const limiter = createRateLimiter(maxRequests);
      const req = createMockRequest({ ip: '10.0.0.1' });

      for (let i = 1; i <= maxRequests; i++) {
        const res = createMockResponse();
        let nextCalled = false;

        limiter(req, res, () => {
          nextCalled = true;
        });

        assert.strictEqual(nextCalled, true, `Request ${i} should be allowed`);
        assert.strictEqual(res.statusCode, undefined);
        assert.strictEqual(res.ended, false);
      }
    });

    it('TC-SEC-036: Returns 429 when rate limit is exceeded', () => {
      const maxRequests = 2;
      const limiter = createRateLimiter(maxRequests);
      const req = createMockRequest({ ip: '10.0.0.2' });

      // First 2 requests pass
      for (let i = 0; i < maxRequests; i++) {
        const res = createMockResponse();
        let nextCalled = false;
        limiter(req, res, () => {
          nextCalled = true;
        });
        assert.strictEqual(nextCalled, true);
      }

      // 3rd request should be blocked with 429
      const blockedRes = createMockResponse();
      let nextCalled = false;
      limiter(req, blockedRes, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, false, 'next() should not be called when rate limited');
      assert.strictEqual(blockedRes.statusCode, 429, 'Status code should be 429');
      assert.strictEqual(
        blockedRes.headers['content-type'],
        'application/json; charset=utf-8',
        'Content-Type should be application/json',
      );
      assert.ok(blockedRes.headers['retry-after'], 'Retry-After header should be present');
      assert.ok(
        Number(blockedRes.headers['retry-after']) >= 1,
        'Retry-After should be at least 1 second',
      );

      assert.ok(blockedRes.body, 'Response body should be defined');
      const parsedBody = JSON.parse(blockedRes.body);
      assert.strictEqual(parsedBody.jsonrpc, '2.0');
      assert.strictEqual(parsedBody.id, null);
      assert.strictEqual(parsedBody.error.code, -32000);
      assert.strictEqual(parsedBody.error.message, 'Rate limit exceeded');
    });

    it('TC-SEC-037: Tracks rate limits independently per client IP', () => {
      const maxRequests = 1;
      const limiter = createRateLimiter(maxRequests);

      const reqA = createMockRequest({ ip: '192.168.1.10' });
      const reqB = createMockRequest({ ip: '192.168.1.20' });

      // Client A - request 1 (allowed)
      const resA1 = createMockResponse();
      let nextA1 = false;
      limiter(reqA, resA1, () => {
        nextA1 = true;
      });
      assert.strictEqual(nextA1, true);

      // Client A - request 2 (rate limited)
      const resA2 = createMockResponse();
      let nextA2 = false;
      limiter(reqA, resA2, () => {
        nextA2 = true;
      });
      assert.strictEqual(nextA2, false);
      assert.strictEqual(resA2.statusCode, 429);

      // Client B - request 1 (allowed despite Client A being rate limited)
      const resB1 = createMockResponse();
      let nextB1 = false;
      limiter(reqB, resB1, () => {
        nextB1 = true;
      });
      assert.strictEqual(nextB1, true, 'Client B should not be affected by Client A');
      assert.strictEqual(resB1.statusCode, undefined);

      // Client B - request 2 (rate limited)
      const resB2 = createMockResponse();
      let nextB2 = false;
      limiter(reqB, resB2, () => {
        nextB2 = true;
      });
      assert.strictEqual(nextB2, false);
      assert.strictEqual(resB2.statusCode, 429);
    });
  });

  describe('Utility functions (isLoopbackHttpHost, splitCsvList, resolveTrustProxySetting)', () => {
    it('isLoopbackHttpHost identifies loopback hosts correctly', () => {
      assert.strictEqual(isLoopbackHttpHost('127.0.0.1'), true);
      assert.strictEqual(isLoopbackHttpHost('localhost'), true);
      assert.strictEqual(isLoopbackHttpHost('[::1]'), true);
      assert.strictEqual(isLoopbackHttpHost('::1'), true);
      assert.strictEqual(isLoopbackHttpHost('  LOCALHOST  '), true);
      assert.strictEqual(isLoopbackHttpHost('0.0.0.0'), false);
      assert.strictEqual(isLoopbackHttpHost('::'), false);
      assert.strictEqual(isLoopbackHttpHost('192.168.1.1'), false);
    });

    it('splitCsvList trims and filters empty items', () => {
      assert.deepStrictEqual(splitCsvList('host1, host2, host3'), ['host1', 'host2', 'host3']);
      assert.deepStrictEqual(splitCsvList('host1, , host2'), ['host1', 'host2']);
      assert.deepStrictEqual(splitCsvList(''), []);
      assert.deepStrictEqual(splitCsvList(undefined), []);
      assert.deepStrictEqual(splitCsvList(' , '), []);
    });

    it('resolveTrustProxySetting parses integer hops or passes through string expressions', () => {
      assert.strictEqual(resolveTrustProxySetting('1'), 1);
      assert.strictEqual(resolveTrustProxySetting('2'), 2);
      assert.strictEqual(resolveTrustProxySetting('0'), 0);
      assert.strictEqual(resolveTrustProxySetting('loopback'), 'loopback');
      assert.strictEqual(resolveTrustProxySetting('10.0.0.0/8'), '10.0.0.0/8');
      assert.strictEqual(resolveTrustProxySetting(''), undefined);
      assert.strictEqual(resolveTrustProxySetting(undefined), undefined);
    });
  });
});

describe('keyless bind rate limiting', () => {
  // The spec's "rate limit tool invocations" MUST is not scoped to
  // authenticated binds. A keyless bind is loopback-only, so its cap is looser
  // than the authenticated 120/min — but it exists.
  it('TC-SEC-036b: a keyless server still mounts the rate limiter', async () => {
    const saved = process.env['FS_RATE_LIMIT_RPM'];
    process.env['FS_RATE_LIMIT_RPM'] = '2';
    const dir = await createTestRoot();
    const httpServer = await startHttpServer(0, { cliAllowedDirs: [dir] }, {});
    const port = (httpServer.address() as AddressInfo).port;
    const post = async (): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      await res.text();
      return res.status;
    };
    try {
      await post();
      await post();
      assert.strictEqual(await post(), 429, 'the third request must be rate limited');
    } finally {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await cleanupTestRoot(dir);
      if (saved === undefined) Reflect.deleteProperty(process.env, 'FS_RATE_LIMIT_RPM');
      else process.env['FS_RATE_LIMIT_RPM'] = saved;
    }
  });
});
