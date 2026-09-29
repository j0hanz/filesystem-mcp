# Plan 051: `--print-config` reports the protocol revisions and SDK version the binary serves

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat fb51aee1..HEAD -- src/cli.ts src/core/config.ts __tests__/cli.test.ts README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. If plan 048 has landed, `limits`
> already has a second field — leave it and add `protocol` beside it.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW — additive JSON fields in a diagnostic command.
- **Depends on**: none (048 also edits `src/cli.ts:246`; if both are in
  flight, land 048 first to avoid a trivial merge conflict on that line)
- **Category**: dx
- **Planned at**: commit `fb51aee1`, 2026-09-29

## Why this matters

This server serves two protocol eras — the 2026-07-28 per-request envelope
and the 2025 `initialize` handshake — and the two ADRs that govern them
(`docs/adr/002-legacy-protocol-paths-sunset.md`,
`docs/adr/003-http-serves-2025-era-clients-statelessly.md`) exist because
era mismatches are the recurring support question ("my client gets an
unsupported-protocol-version error"). Today `--print-config` reports roots,
tools, limits and policy but not which revisions the installed SDK offers or
which SDK version is pinned, so an operator diagnosing a negotiation failure
has to attach a client or read `package-lock.json`. Two fields answer both
questions in one command, from the same constants the SDK negotiates with.

## Current state

- `src/cli.ts:1-18` — imports; nothing from `@modelcontextprotocol/server`
  and no `package.json` import. (`src/cli-help.ts:3` and `src/server.ts:8`
  both do `import packageJson from '../package.json' with { type: 'json' };`
  — the pattern to copy.)
- `src/cli.ts:235-259` — `printConfig` builds and prints:

```ts
  const config = {
    transport:
      options.port !== undefined
        ? `http://${options.httpHost ?? '127.0.0.1'}:${String(options.port)}`
        : 'stdio',
    readOnly: options.readOnly,
    allowedRoots,
    tools,
    apiKey: options.apiKey ? '***' : null,
    limits: { maxFileSizeBytes: getMaxTextFileSize() },
    // Everything that can produce ACCESS_DENIED, read through the same
    // sources the guard and the matcher use (flag beats env).
    policy: {
      ...
    },
  };

  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
```

- SDK constants (installed 2.2.0), exported from `@modelcontextprotocol/server`
  (`node_modules/@modelcontextprotocol/server/dist/index.d.mts`):
  `LATEST_PROTOCOL_VERSION` = `"2025-11-25"` and `SUPPORTED_PROTOCOL_VERSIONS` =
  `["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]`
  (verified with `node -e "import('@modelcontextprotocol/server').then(m => console.log(m.LATEST_PROTOCOL_VERSION, m.SUPPORTED_PROTOCOL_VERSIONS))"`).
  **These describe the 2025-era `initialize` handshake only.** The
  2026-07-28 per-request revision is `FIRST_MODERN_PROTOCOL_VERSION` /
  `MODERN_WIRE_REVISION` in `dist/src-*.mjs:567,4185` — **not exported**. The
  repo already spells the literal in `__tests__/stdio.test.ts:28`
  (`'io.modelcontextprotocol/protocolVersion': '2026-07-28'`), ADR-002/003
  and many comments; the SDK's `PROTOCOL_VERSION_META_KEY`
  (`"io.modelcontextprotocol/protocolVersion"`) **is** exported.
- `package.json:66-69` — exact pins: `"@modelcontextprotocol/express": "2.0.1"`,
  `"@modelcontextprotocol/node": "2.1.0"`, `"@modelcontextprotocol/server": "2.2.0"`.
  The pins are exact by policy (`plans/README.md`, "Dependabot: would fight
  the deliberate exact pins"), so the manifest value **is** the installed
  version. The server package exports no `./package.json` subpath, so its
  own manifest cannot be imported; read this repo's pin instead.
- `__tests__/cli.test.ts:11-38` — `runCli(args, env)` spawns `src/index.ts`
  with `FS_*` stripped; `:49-75` parses `--print-config` JSON and asserts on
  `apiKey` and `policy`.
- `README.md:425` — the `--print-config` row: "Print the active configuration as JSON and exit".

Conventions: `cli.ts` is plain-Node argument handling; the JSON shape is
consumed by humans and by `cli.test.ts`; Prettier formats.

## Commands you will need

| Purpose      | Command                              | Expected on success           |
| ------------ | ------------------------------------ | ----------------------------- |
| Build        | `npm run build`                      | exit 0                        |
| Static check | `npm run check:static`               | exit 0                        |
| CLI tests    | `npm test -- __tests__/cli.test.ts`  | all pass                      |
| Manual       | `node src/index.ts --print-config .` | JSON with a `protocol` object |
| Full check   | `npm run check`                      | exit 0; `fail 0`              |

Baseline at planning time: 536 tests, 533 pass, 3 skipped, 0 fail.

## Scope

**In scope**:

- `src/core/config.ts` (one exported constant)
- `src/cli.ts`
- `__tests__/cli.test.ts`
- `README.md` (one table cell)
- `plans/README.md` — status row

**Out of scope**:

- `src/cli-help.ts` — `--version` prints this package's version and stays
  that way; do not add SDK output to it.
- `src/server.ts` — the `Implementation` block is unchanged.
- Any new flag or env var.

## Git workflow

- Branch: `advisor/051-print-config-protocol`
- Commit e.g. `feat(cli): print-config reports protocol revisions and SDK pin`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: One home for the modern revision literal

The SDK exports no constant for `2026-07-28`, so give the literal one owner
in `src/core/config.ts` (the module that already holds CLI-derived
constants; check its exports and add at the end):

```ts
/**
 * The per-request-envelope protocol revision this server serves next to the
 * 2025 `initialize` handshake. The SDK keeps its own copy internal
 * (`FIRST_MODERN_PROTOCOL_VERSION`), so this is asserted against SDK
 * behaviour in `cli.test.ts` rather than imported.
 */
export const MODERN_PROTOCOL_REVISION = '2026-07-28';
```

**Verify**: `npm run build` → exit 0.

### Step 2: Add the `protocol` block

In `src/cli.ts`:

1. Add imports (Prettier orders them; the JSON import goes where
   `cli-help.ts:3` has it):

```ts
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';

import packageJson from '../package.json' with { type: 'json' };
import { cli, MODERN_PROTOCOL_REVISION } from './core/config.ts';
```

2. In `printConfig`, after the `limits` line add:

```ts
    // What the binary negotiates with, so an era mismatch ("unsupported
    // protocol version") can be diagnosed without attaching a client. The
    // legacy list is the SDK's own; the modern revision has no SDK export.
    // The pins are exact (package.json), so the manifest value is the
    // installed one.
    protocol: {
      modern: MODERN_PROTOCOL_REVISION,
      legacy: { latest: LATEST_PROTOCOL_VERSION, supported: SUPPORTED_PROTOCOL_VERSIONS },
      sdk: {
        server: packageJson.dependencies['@modelcontextprotocol/server'],
        node: packageJson.dependencies['@modelcontextprotocol/node'],
        express: packageJson.dependencies['@modelcontextprotocol/express'],
      },
    },
```

If TypeScript narrows `packageJson.dependencies` to a literal object type and
complains about indexing, use dot access on the known keys via a typed
alias: `const deps: Record<string, string> = packageJson.dependencies;`.

**Verify**: `npm run build && npm run lint` → exit 0;
`node src/index.ts --print-config .` → the JSON contains
`"protocol": { "modern": "2026-07-28", "legacy": { "latest": "2025-11-25", "supported": [ "2025-11-25", ... ] }, "sdk": { "server": "2.2.0", "node": "2.1.0", "express": "2.0.1" } }`.

### Step 3: Test

In `__tests__/cli.test.ts`, after the "--allow-sensitive …" test (line 77) add:

```ts
it('--print-config reports both protocol eras and the pinned SDK versions', async () => {
  const { code, stdout, stderr } = await runCli(['--print-config', root]);
  assert.strictEqual(code, 0, stderr);
  const config = JSON.parse(stdout) as {
    protocol: {
      modern: string;
      legacy: { latest: string; supported: string[] };
      sdk: { server: string; node: string; express: string };
    };
  };
  assert.strictEqual(config.protocol.modern, MODERN_PROTOCOL_REVISION);
  assert.strictEqual(config.protocol.legacy.latest, LATEST_PROTOCOL_VERSION);
  assert.deepStrictEqual(config.protocol.legacy.supported, SUPPORTED_PROTOCOL_VERSIONS);
  const pinned = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8')) as {
    dependencies: Record<string, string>;
  };
  assert.strictEqual(
    config.protocol.sdk.server,
    pinned.dependencies['@modelcontextprotocol/server'],
  );
  assert.match(config.protocol.sdk.server, /^\d+\.\d+\.\d+$/, 'the pin must be exact');
});

it('MODERN_PROTOCOL_REVISION is the revision the SDK actually serves', async () => {
  // The SDK exports no constant for it, so pin the literal to behaviour: a
  // server/discover probe stamped with it must be answered with a result.
  const tmp = await createTestRoot();
  const handler = createMcpHandler(
    async ({ era }) => (await createServer({ cliAllowedDirs: [tmp] }, { era })).mcp,
    { legacy: 'reject' },
  );
  try {
    const res = await handler.fetch(
      new Request('http://test.local/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          // The modern binding's standard headers; the entry refuses a
          // 2026-07-28 request without them (no Mcp-Name for discover).
          'mcp-protocol-version': MODERN_PROTOCOL_REVISION,
          'mcp-method': 'server/discover',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
          params: {
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_REVISION,
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': { name: 'cli-test', version: '1.0.0' },
            },
          },
        }),
      }),
    );
    const text = await res.text(); // read once; a Response body is single-use
    assert.strictEqual(res.status, 200, text);
    const json = res.headers.get('content-type')?.includes('text/event-stream')
      ? (
          text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .at(-1) ?? ''
        ).slice(5)
      : text;
    const body = JSON.parse(json) as { result?: unknown; error?: unknown };
    assert.ok(body.result, JSON.stringify(body));
  } finally {
    await handler.close();
    await cleanupTestRoot(tmp);
  }
});
```

Imports: `LATEST_PROTOCOL_VERSION, PROTOCOL_VERSION_META_KEY, SUPPORTED_PROTOCOL_VERSIONS, createMcpHandler`
from `'@modelcontextprotocol/server'`; `readFile` from `'node:fs/promises'`;
`MODERN_PROTOCOL_REVISION` from `'../src/core/config.ts'`; `createServer`
from `'../src/server.ts'`. The SSE branch mirrors the stdio equivalent of
this probe (`__tests__/stdio.test.ts:42-50`) for the JSON-body case.
With `legacy: 'reject'`, a wrong literal is answered with the
unsupported-protocol-version **error**, so this test fails loudly if the
SDK ever moves the modern revision.

**Verify**: `npm test -- __tests__/cli.test.ts` → all pass, 2 new.

### Step 4: README and full check

`README.md:425` — change the description cell to
`Print the active configuration as JSON (roots, tools, limits, policy, supported protocol revisions, SDK pins) and exit`.
Run `npx prettier --write README.md src/cli.ts __tests__/cli.test.ts`.

**Verify**: `npm run check` → exit 0, `fail 0`, ≥ 538 pass.

## Test plan

- One subprocess test asserting the new block equals the SDK legacy
  constants, the repo's modern literal and the pin in `package.json`; one
  in-process probe proving the modern literal is the revision the SDK
  serves. Pattern: the existing `--print-config` tests in
  `cli.test.ts:49-85` and the raw discover in `stdio.test.ts:42-50`.

## Done criteria

- [ ] `npm run check` exits 0; ≥ 538 pass, 0 fail
- [ ] `node src/index.ts --print-config .` prints a `protocol` object with `modern`, `legacy.{latest,supported}`, `sdk.{server,node,express}`
- [ ] `Select-String -Path src\*.ts,src\**\*.ts -Pattern "'2026-07-28'"` → exactly one hit, in `src/core/config.ts` (there are none today; prose mentions in comments are unquoted). On POSIX: `grep -rn "'2026-07-28'" src/`.
- [ ] `README.md:425` updated; `npx prettier --check .` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `SUPPORTED_PROTOCOL_VERSIONS`, `LATEST_PROTOCOL_VERSION` or
  `PROTOCOL_VERSION_META_KEY` is not exported from `@modelcontextprotocol/server`
  (check `node_modules/@modelcontextprotocol/server/dist/index.d.mts`).
- The behavioural probe in step 3 is answered with an unsupported-version
  error for `'2026-07-28'` — the SDK moved the modern revision; report the
  `supported` list in the error `data` rather than editing the literal blind.
- `SUPPORTED_PROTOCOL_VERSIONS` **does** contain `'2026-07-28'` — the SDK
  unified the lists; then `modern` is redundant and the plan's shape should
  be revisited, not shipped as written.
- `package.json` pins are no longer exact (a `^` or `~` appears on an
  `@modelcontextprotocol/*` dependency) — the "manifest value is the
  installed one" assumption is gone; report rather than reading
  `node_modules` at runtime.
- `knip` flags the `package.json` import in `cli.ts` — report; `server.ts`
  and `cli-help.ts` do the same import today, so a new flag means the knip
  config changed.

## Maintenance notes

- Plan 047-style SDK bumps change `sdk.*` automatically (they edit
  `package.json`); nothing here needs touching on a bump — but re-run
  `cli.test.ts` after one: the probe test is what notices a moved modern
  revision. If a later SDK exports `FIRST_MODERN_PROTOCOL_VERSION`, replace
  the literal in `config.ts` with a re-export of it.
- When ADR-002's sunset removes the 2025 paths, `legacy.supported` will
  still list what the SDK offers — the CLI reports the SDK, not this
  server's policy. Add a `served` field then rather than filtering.
