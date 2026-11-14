# Plan 114: A network-facing HTTP server warns when access grants have no boundary

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/transport/http.ts src/transport/http-policy.ts docs/configuration.md SECURITY.md __tests__/http-policy.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (a warning and documentation; no behavior change)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

When a client names a folder outside the allowed roots, the server can ask
for an "access grant" and, once approved, adds the folder. Over stdio the
person at the client approves. Over HTTP the approval comes from whichever
client holds the API key. So on a network-facing server (Docker, or
`--http-host 0.0.0.0` with a key), a leaked key, or a client steered by a
prompt injection, can approve its own grants and widen the server's reach to
any folder that is not a home or system folder.

The only limit on grants is the root boundary (`--root-boundary` /
`FS_ROOT_BOUNDARY`), and it is optional. Today the server warns about this
only when there is no API key, and the docs recommend the boundary only for
that case. `SECURITY.md` promises that a new folder never opens "without the
user's confirmation" without saying who answers over HTTP.

This plan makes the risk visible: a startup warning for a non-loopback bind
with no boundary, and accurate docs. It does not change what grants are
allowed; that stronger option is recorded under "Maintenance notes" for the
maintainer to decide.

## Current state

`src/transport/http.ts:273-280`:

```ts
const httpHost = config.httpHost ?? '127.0.0.1';
const { apiKey } = config;
assertHttpBindingPolicy(httpHost, apiKey);
if (apiKey === undefined) {
  Logger.warn(
    '[HTTP] No API key set: any local user or process can call this server and approve its own access grants. Set FS_API_KEY, and use --root-boundary to limit grants.',
  );
}
```

`assertHttpBindingPolicy` guarantees that a non-loopback host has an API
key, so "non-loopback" implies "keyed".

`src/transport/http-policy.ts:56` exports
`isLoopbackHttpHost(host: string): boolean`. Check the import block at
`src/transport/http.ts:30-44` to see whether it is already imported from
`./http-policy.ts`.

`src/core/config.ts:178-180`:

```ts
export function getRootBoundary(): string | undefined {
  return cli.rootBoundary ?? process.env['FS_ROOT_BOUNDARY'];
}
```

`http.ts` already imports `parseEnvInt, parseTrueEnvFlag` from
`../core/config.ts`.

`docs/configuration.md:310-316`:

```md
The server enforces these safety rules:

- It listens on `127.0.0.1` unless you set `--http-host`.
- Without an API key, every user and process on the machine can call it and
  approve its own access grants. On a shared machine set `FS_API_KEY`, and
  `--root-boundary` to limit what a grant can add. The server logs a warning
  when it starts without a key.
```

`SECURITY.md:40-41`:

```md
- deleting a non-empty folder or opening a new folder never happens without
  the user's confirmation, and `create` and `move` only write over an
```

Test pattern, `__tests__/http-policy.test.ts:828-845`:

```ts
const KEYLESS_WARNING =
  '[warning] [HTTP] No API key set: any local user or process can call this server and approve its own access grants. Set FS_API_KEY, and use --root-boundary to limit grants.';

it('warns once at startup when HTTP runs without an API key', async (t) => {
  const dir = await createTestRoot();
  const lines: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const httpServer = await startHttpServer(0, { cliAllowedDirs: [dir] }, {});
  try {
    assert.strictEqual(lines.filter((line) => line === KEYLESS_WARNING).length, 1);
  } finally {
    await httpServer[Symbol.asyncDispose]();
    await cleanupTestRoot(dir);
  }
});
```

The same file has tests that start the server on a non-loopback host; find
one with `grep -n "httpHost" __tests__/http-policy.test.ts` and copy how it
passes `httpHost`, `apiKey` and any `FS_ALLOWED_HOSTS` environment it needs
(`withEnv` from `__tests__/helpers.ts`).

## Commands you will need

| Purpose    | Command                                                          | Expected on success |
| :--------- | :--------------------------------------------------------------- | :------------------ |
| Build      | `npm run build`                                                  | exit 0              |
| One file   | `node --test --test-timeout=60000 __tests__/http-policy.test.ts` | all pass            |
| Full check | `npm run check`                                                  | exit 0              |

## Scope

**In scope**:

- `src/transport/http.ts` (one added warning)
- `__tests__/http-policy.test.ts` (two tests)
- `docs/configuration.md`, `SECURITY.md` (wording)
- `CHANGELOG.md`, `plans/README.md`

**Out of scope**:

- `src/core/path.ts`: grant rules stay as they are.
- Refusing grants or defaulting the boundary. That changes behavior for
  remote clients and needs the maintainer's decision.
- `assertHttpBindingPolicy`.

## Git workflow

- Branch: `fix/http-warn-unbounded-grants`
- One commit: `fix(http): warn when a network bind has no root boundary for grants`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Failing tests

In `__tests__/http-policy.test.ts`, next to the keyless-warning tests, add:

- **Warns.** Start the server on a non-loopback host with an API key and no
  boundary (make sure `FS_ROOT_BOUNDARY` is unset for the test with
  `withEnv`). Assert exactly one logged line contains
  `no root boundary`.
- **Does not warn with a boundary.** Same, with `FS_ROOT_BOUNDARY` set to the
  test root. Assert no line contains `no root boundary`.
- Extend the existing loopback tests' expectations: add to the test
  `does not warn about a missing key when one is set` an assertion that no
  line contains `no root boundary` (loopback bind).

**Verify**: `node --test --test-timeout=60000 --test-name-pattern="boundary" __tests__/http-policy.test.ts`
→ the "Warns" test FAILS.

### Step 2: Add the warning

In `src/transport/http.ts`, extend the block shown in "Current state":

```ts
if (apiKey === undefined) {
  Logger.warn(/* unchanged */);
} else if (!isLoopbackHttpHost(httpHost) && getRootBoundary() === undefined) {
  Logger.warn(
    '[HTTP] Listening beyond loopback with no root boundary: any client holding the API key can approve its own access grants and add folders. Set --root-boundary to limit grants.',
  );
}
```

Import `getRootBoundary` from `../core/config.ts` (add it to the existing
import) and `isLoopbackHttpHost` from `./http-policy.ts` if not already
imported. Keep the import specifiers sorted (Prettier sorts them; run
`npx prettier --write src/transport/http.ts`).

**Verify**: `node --test --test-timeout=60000 __tests__/http-policy.test.ts` → all pass.

### Step 3: Docs

In `docs/configuration.md`, after the "Without an API key" bullet shown
above, add:

```md
- With an API key, the client that holds the key answers access-grant
  prompts itself. When the server listens beyond `127.0.0.1`, set
  `--root-boundary` so a leaked key cannot add folders outside it. The
  server logs a warning when it starts without one.
```

In `SECURITY.md`, after the bullet list that ends with
`- no input can crash or hang the server.`, add one paragraph:

```md
Over HTTP, "the user's confirmation" is given by the client that sent the
request: the server cannot tell a person from a program. Whoever holds the
API key can approve its own access grants, so a network-facing server should
set `--root-boundary`.
```

**Verify**: `npx prettier --check docs/configuration.md SECURITY.md` → exit 0.

### Step 4: Changelog and full check

Under `## [Unreleased]`, add an `### Added` heading if missing and:

```md
- **HTTP**: the server logs a warning when it listens beyond loopback with no root boundary, since a client holding the API key can then approve its own access grants.
```

**Verify**: `npm run check` → exit 0.

## Test plan

Two new tests and one extended assertion, modeled on
`warns once at startup when HTTP runs without an API key`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "no root boundary" src/transport/http.ts` prints one line
- [ ] `git diff --stat` lists only in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

- No existing test starts the server on a non-loopback host, and you cannot
  make `startHttpServer` accept one in a test without changing source.
- `assertHttpBindingPolicy` allows a non-loopback host without a key (then
  the `else if` misses a case; report it).
- The contract snapshot changes.

## Maintenance notes

- **Decision left to the maintainer**: on a non-loopback bind, either refuse
  access grants unless a boundary is set, or default the boundary to the
  configured roots. Both close the hole and both can break remote clients
  that rely on grants today. If chosen, the change belongs in `PathGuard`
  with an ADR; this warning then becomes an error message.
- The warning text is matched by a test; keep the phrase `no root boundary`.
