# Trust-proxy address implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close GHSA-f423-gwmw-6wwh: forged `X-Forwarded-For` values must not get fresh rate-limit buckets.

**Architecture:** `FS_TRUST_PROXY` stops accepting a hop count. A hop count trusts `X-Forwarded-For` from whatever peer connects, so a client that reaches the server directly can forge its IP. Requiring the proxy's address (IP, CIDR, or an Express name such as `loopback`) means Express reads the header only when the socket peer is that proxy. The limiter in `createRateLimiter` keeps keying on `req.ip`; only the trust setting changes.

**Tech Stack:** TypeScript, Express 5.3 (`trust proxy`), Node built-in test runner.

**Spec:** GHSA-f423-gwmw-6wwh (private advisory) and the confirmation below.

## Confirmed behaviour on v2.19.0 (`fc8856dc`)

Reproduced against `dist/index.js` with `FS_RATE_LIMIT_RPM=10`, 12 POSTs each carrying a distinct `X-Forwarded-For`:

| `FS_TRUST_PROXY` | Setup                      | Result         |
| :--------------- | :------------------------- | :------------- |
| unset            | direct client              | limited        |
| `1`              | direct, no proxy (the PoC) | **bypassed**   |
| `loopback`       | direct loopback client     | **bypassed**   |
| `1`              | behind 1 appending proxy   | limited        |
| `2`              | behind 1 proxy             | **bypassed**   |
| `true`           | any                        | startup throws |

The advisory's claim that `true` trusts every hop is wrong for this version: Express rejects the string `"true"` as an invalid IP. The `loopback` row stays bypassable after this fix; it is the operator naming loopback as the proxy, and only a local process can connect from loopback.

## Global Constraints

- Breaking config change, chosen by the maintainer: a hop count fails startup. It ships in a patch release because it is the security fix.
- Do not hand-edit versions in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`.
- Work happens in the private fork `j0hanz/filesystem-mcp-ghsa-f423-gwmw-6wwh`, branch `advisory-fix-1`. Nothing about the advisory goes to the public repo before it is published.
- Error copy, exact: `FS_TRUST_PROXY no longer accepts a hop count or true/false ('<value>'): a hop count trusts X-Forwarded-For from any client that connects. Set it to your proxy's address instead, for example FS_TRUST_PROXY=loopback or FS_TRUST_PROXY=10.0.0.5. Unset it if no proxy sits in front.`

## Review Focus

1. `FS_TRUST_PROXY=' 1 '` (padded) must be rejected like `1`; `Number(' 1 ')` is `1`.
2. `FS_TRUST_PROXY=0` used to mean "trust nothing"; it must now fail with the message that says to unset it, not silently pass.
3. `true`, `TRUE`, `false` must fail with the same clear message, not Express's `invalid IP address`.
4. IPv6 and CIDR values (`::1`, `10.0.0.0/8`, `loopback, 10.0.0.5`) must pass through unchanged.
5. A forged header from a peer that is not the named proxy must land in the peer's own bucket (the PoC, end to end).

---

### Task 1: Reject hop counts in `FS_TRUST_PROXY`

**Files:**

- Modify: `src/transport/http-policy.ts:158-170` (`resolveTrustProxySetting` and its doc comment)
- Modify: `src/cli-help.ts:91` (help text)
- Modify: `docs/configuration.md:250` (table row)
- Modify: `CHANGELOG.md` (add `## [Unreleased]` above `## [2.19.0]`)
- Test: `__tests__/http-policy.test.ts:749-757`
- Test: `__tests__/http-server.test.ts:644-657`

**Interfaces:**

- Produces: `resolveTrustProxySetting(value: string | undefined): string | undefined`. It returns the trimmed value, or `undefined` when unset or blank. It throws `FsError(ErrorCode.INVALID_INPUT, <Global Constraints copy>)` when the trimmed value is a finite number or matches `/^(true|false)$/i`. The caller at `src/transport/http.ts:119` stays as is. The throw happens inside `startHttpServer` before `listen`, the same path `assertHttpBindingPolicy` errors take.

- [ ] **Step 1: Replace the unit test at `__tests__/http-policy.test.ts:749`**

```ts
it('resolveTrustProxySetting passes proxy addresses and rejects hop counts', () => {
  assert.strictEqual(resolveTrustProxySetting('loopback'), 'loopback');
  assert.strictEqual(resolveTrustProxySetting('10.0.0.0/8'), '10.0.0.0/8');
  assert.strictEqual(resolveTrustProxySetting('::1'), '::1');
  assert.strictEqual(resolveTrustProxySetting(' loopback, 10.0.0.5 '), 'loopback, 10.0.0.5');
  assert.strictEqual(resolveTrustProxySetting(''), undefined);
  assert.strictEqual(resolveTrustProxySetting('   '), undefined);
  assert.strictEqual(resolveTrustProxySetting(undefined), undefined);
  for (const bad of ['0', '1', '2', ' 1 ', 'true', 'TRUE', 'false']) {
    assert.throws(
      () => resolveTrustProxySetting(bad),
      fsErrorMatcher(ErrorCode.INVALID_INPUT, /no longer accepts a hop count/),
      bad,
    );
  }
});
```

- [ ] **Step 2: Change the e2e tests at `__tests__/http-server.test.ts:644`**

Rename `'FS_TRUST_PROXY gives each forwarded client its own limit'` to `'FS_TRUST_PROXY naming the peer gives each forwarded client its own limit'`. Change its env to `FS_TRUST_PROXY: 'loopback'`, because the test client on `127.0.0.1` plays the proxy. Keep its assertions.

Add the PoC as a regression test after it:

```ts
it('FS_TRUST_PROXY ignores a forged header from a peer that is not the proxy', async () => {
  http = await bootHttpTest([root], { FS_RATE_LIMIT_RPM: '1', FS_TRUST_PROXY: '10.9.9.9' });
  const statuses = await forwardedStatuses();
  assert.strictEqual(statuses[1], 429, `statuses: ${statuses.join(',')}`);
});
```

Do not add an e2e test for the startup rejection. `bootHttpTest` restores env only in `close()`, so a rejected boot would leak `FS_TRUST_PROXY` into later tests. The unit test covers the throw.

- [ ] **Step 3: Run both test files and check they fail**

Run: `npm test -- __tests__/http-policy.test.ts __tests__/http-server.test.ts`
Expected: the unit test fails (`'1'` returns `1`, no throw). The new e2e test passes already; it pins behaviour that hop counts used to break.

- [ ] **Step 4: Implement `resolveTrustProxySetting` in `src/transport/http-policy.ts`**

Trim; blank returns `undefined`. Throw when `Number.isFinite(Number(trimmed))` or `/^(true|false)$/i` matches; otherwise return the trimmed string. Rewrite the doc comment to say why hop counts are refused, and cite GHSA-f423-gwmw-6wwh.

- [ ] **Step 5: Update the operator text**

- `src/cli-help.ts:91`: `'Express trust-proxy setting: the reverse proxy\'s IP, CIDR or name such as loopback; no hop counts (unset = ignore X-Forwarded-*)'`
- `docs/configuration.md:250`: say it is the address of the reverse proxy in front (IP, CIDR, comma list, or `loopback`/`linklocal`/`uniquelocal`); hop counts are refused at startup because they trust any client that connects; unset means `X-Forwarded-*` is ignored.
- `CHANGELOG.md`: `## [Unreleased]` with `### Security`. Entry: **`FS_TRUST_PROXY` no longer accepts a hop count** (GHSA-f423-gwmw-6wwh). A hop count let a client that reached the server directly forge `X-Forwarded-For` and skip the per-IP rate limit. Replace `FS_TRUST_PROXY=1` with your proxy's address, such as `loopback`; the server now refuses to start with a hop count.

- [ ] **Step 6: Run the targeted tests, then the full check**

Run: `npm test -- __tests__/http-policy.test.ts __tests__/http-server.test.ts`
Expected: PASS.
Run: `npm run check`
Expected: PASS. If `__tests__/contract.test.ts` fails on help text, regenerate per `CLAUDE.md` with no `FS_*` set, and commit the `.snapshot` diff.

- [ ] **Step 7: Re-run the PoC against the new build**

Run: `npm run build`, then the reporter's PoC loop with `FS_TRUST_PROXY=1`.
Expected: the server refuses to start with the Global Constraints message. With `FS_TRUST_PROXY=10.9.9.9`, distinct forged headers hit `429` after the cap.

- [ ] **Step 8: Commit and push**

```bash
git add src/transport/http-policy.ts src/cli-help.ts docs/configuration.md CHANGELOG.md __tests__/http-policy.test.ts __tests__/http-server.test.ts
git commit -m "fix(http): refuse FS_TRUST_PROXY hop counts (GHSA-f423-gwmw-6wwh)"
git push -u origin advisory-fix-1
```
