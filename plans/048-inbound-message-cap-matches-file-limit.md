# Plan 048: One inbound-message bound, derived from the file-size limit, on both transports

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat fb51aee1..HEAD -- src/core/util.ts src/transport/stdio.ts src/transport/http.ts src/tools/create.ts src/instructions.ts src/cli.ts src/cli-help.ts README.md __tests__/stdio.test.ts __tests__/http-server.test.ts __tests__/tools.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED — raises the HTTP body limit from 4 MiB to a derived bound
  (31 MiB by default) on an endpoint that may be network-exposed; the
  limiter and bearer auth already run before the body is parsed, and the
  keyless bind is loopback-only, so the exposure is bounded by design.
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `fb51aee1`, 2026-09-29

## Why this matters

`create` accepts up to `FS_MAX_FILE_SIZE` characters of content per file
(10 MiB by default, 100 MiB max) and the instructions resource tells the
model "max file size 10 MB". But the stdio wire is a bare
`new StdioServerTransport()` with the SDK's default 10 MB read buffer, and the
SDK's contract for an overflow is `onerror` **then `close()`** — the whole
connection ends. JSON escaping (a newline becomes two bytes), UTF-16
`.length` versus UTF-8 bytes, and a batch of several files all push a
schema-valid `create` past that buffer, so a client that does exactly what
the instructions allow loses its session with a bare "ReadBuffer exceeded"
on stderr. Over HTTP the same call is refused at 4 MiB with a JSON-RPC 413
that names no limit. After this plan one number — derived from the file
limit — bounds both transports, every schema-valid `create` fits it (the
other write tools' text inputs stay bounded only by the transport, as today,
but now hit a 413 or a log line that names the bound instead of a bare
overflow), the 413 and the stdio log line say what the bound is and how to
change it, and the instructions, README, `--help` and `--print-config`
report it.

## Current state

- `src/core/util.ts:6-7` — `const KIB = 1024; export const MIB = 1024 * KIB;`
- `src/core/util.ts:108-115`:

```ts
export function getMaxTextFileSize(): number {
  return parseIntSetting(
    'FS_MAX_FILE_SIZE',
    cli.maxFileSize ?? process.env['FS_MAX_FILE_SIZE'],
    10 * MIB,
    MIB,
    100 * MIB,
  );
}
```

- `src/transport/stdio.ts:181` — `const wire = new StdioServerTransport();`
- `src/transport/stdio.ts:232-238`:

```ts
const handle = serveStdio(factory, {
  legacy: 'serve',
  transport: wire,
  onerror: (error: unknown) => {
    Logger.error('[Stdio] serve error:', formatUnknownErrorMessage(error));
  },
});
```

- `src/transport/stdio.ts:206-213` (comment in `cleanupConnection`) already
  anticipates the failure: "a fatal read error (a ReadBuffer overflow) tears
  the connection down but leaves the handle referenced".
- SDK contract, `node_modules/@modelcontextprotocol/server/dist/stdio.d.mts:98-105`:
  `constructor(_stdin?, _stdout?, options?: { maxBufferSize?: number })` —
  "If a single message exceeds this size the transport will emit an error and
  close. Defaults to 10 MB." Runtime (`dist/stdio.mjs:45-53`): `_ondata`
  catches the `ReadBuffer exceeded maximum size of N bytes` throw, calls
  `this.onerror?.(error)` and `this.close()`.
- `src/transport/http.ts:10-17` imports `DEFAULT_MAX_REQUEST_BODY_SIZE` from
  `@modelcontextprotocol/server`.
- `src/transport/http.ts:60-79` — `errorHandlerMiddleware`:

```ts
if (err.status === 413) {
  sendJsonRpcError(res, 413, ProtocolErrorCode.InvalidRequest, 'Request body too large');
  return;
}
```

- `src/transport/http.ts:164-169`:

```ts
// The express parser limit derives from the SDK's own request-body
// bound, so it and the adapter/handler-core defaults
// (`DEFAULT_MAX_REQUEST_BODY_SIZE`, 4 MiB in 2.1.0) cannot drift apart.
// Mounted here, after CORS, the rate limiter and auth, so a refused
// request is answered without its body being read.
const parseJson = express.json({ limit: `${DEFAULT_MAX_REQUEST_BODY_SIZE}b` });
```

- `src/transport/http.ts:311-347` — `createMcpHandler(factory, { legacy: 'stateless', onerror })`
  and `toNodeHandler(modernHandler, { onerror })`. Both accept
  `maxRequestBodySize?: number` (server `dist/createMcpHandler-*.d.mts:3966-3975`;
  node `dist/index.d.mts` `ToNodeHandlerOptions`). The HTTP leg always hands the
  SDK a `parsedBody` (`http.ts:182-187`), so these knobs are defensive only —
  the express parser limit is the one that bites.
- `src/tools/create.ts:33-40` — per-item cap:

```ts
content: z.string().refine((val) => val.length <= getMaxTextFileSize(), {
  message: 'Content exceeds maximum allowed text file size',
});
```

- `src/tools/create.ts:60-83` — `CreateInputSchema` is `z.strictObject({ files: z.array(...).min(1).max(100) }).superRefine(...)`
  with one duplicate-path check; there is no combined-content cap.
- `src/instructions.ts:47` — `const maxFileMb = Math.floor(getMaxTextFileSize() / 1024 / 1024);`
- `src/instructions.ts:69`:

```ts
      `enforced_limits: max file size ${maxFileMb} MB, file search cap ${MAX_SEARCH_RESULTS} results, content search scans up to ${MAX_SEARCH_RESULTS} matches, paged by maxResults (default ${DEFAULT_SEARCH_CONTENT_RESULTS}).`,
```

- `src/cli.ts:246` — `limits: { maxFileSizeBytes: getMaxTextFileSize() },`
- `src/cli-help.ts:48-49` — `--max-file-size <bytes>` desc:
  `'Maximum file size for reads in bytes (env: FS_MAX_FILE_SIZE)'`;
  `src/cli-help.ts:80` — `{ flags: 'FS_MAX_FILE_SIZE', desc: 'Maximum file size for reads in bytes' }`.
- `README.md:423` and `README.md:447` — the `--max-file-size` / `FS_MAX_FILE_SIZE`
  rows both read "Maximum file size for reads in bytes".
- Tests that pin today's numbers:
  - `__tests__/stdio.test.ts:3` imports `STDIO_DEFAULT_MAX_BUFFER_SIZE` from
    the SDK; `STDIO-014` (`stdio.test.ts:235-296`) writes
    `Buffer.alloc(STDIO_DEFAULT_MAX_BUFFER_SIZE + 1, 'x')` and asserts stderr
    matches `/ReadBuffer exceeded maximum size/` and the child exits `[0, null]`.
  - `__tests__/http-server.test.ts:275-288` — test "5." posts
    `'x'.repeat(5 * 1024 * 1024)` and expects 413 with a JSON-RPC error body.
  - `__tests__/resources.test.ts:78` — `assert.match(constraints, /enforced_limits:/)`.
- Harness facts: `createRawStdioServer(allowedDir, extraEnv)` (`__tests__/helpers.ts:460`)
  and `createStdioClient(allowedDir, extraEnv, cliFlags, entry)` (`:429`)
  spawn `src/index.ts` with `extraEnv`; `bootHttpTest(allowedDirs, extraEnv)`
  (`:357`) sets `process.env` before `startHttpServer`, so `FS_MAX_FILE_SIZE`
  set there governs the express limit computed at boot.

Conventions: comments explain _why_, not _what_; env-derived numbers are read
through one function in `core/util.ts`; Prettier formats everything
(`npx prettier --write <file>` before committing); tests are `node:test` +
`node:assert/strict` with IDs like `STDIO-014`.

## Commands you will need

| Purpose         | Command                                     | Expected on success      |
| --------------- | ------------------------------------------- | ------------------------ |
| Build           | `npm run build`                             | exit 0                   |
| Typecheck tests | `npm run type-check:test`                   | exit 0                   |
| Lint            | `npm run lint`                              | exit 0                   |
| Static check    | `npm run check:static`                      | exit 0 (build+lint+knip) |
| stdio tests     | `npm test -- __tests__/stdio.test.ts`       | all pass                 |
| HTTP tests      | `npm test -- __tests__/http-server.test.ts` | all pass                 |
| Tools tests     | `npm test -- --test-name-pattern="create"`  | all pass                 |
| Full check      | `npm run check`                             | exit 0; `fail 0`         |

Baseline at planning time: 536 tests, 533 pass, 3 skipped, 0 fail.

## Scope

**In scope**:

- `src/core/util.ts` — add `getMaxInboundMessageBytes()`
- `src/transport/stdio.ts` — buffer bound + overflow hint
- `src/transport/http.ts` — body limit, 413 wording, SDK knobs
- `src/tools/create.ts` — combined-content refine
- `src/instructions.ts` — one sentence
- `src/cli.ts` — one field under `limits`
- `src/cli-help.ts` — two description strings
- `README.md` — two table rows
- `__tests__/stdio.test.ts`, `__tests__/http-server.test.ts`,
  `__tests__/tools.test.ts` — updated/new tests
- `plans/README.md` — status row

**Out of scope**:

- `src/tools/edit.ts`, `patch.ts`, `replace-text.ts` — their text inputs
  (`edits[].oldText/newText`, `diff`) have no size cap today and gain none
  here: the invariant this plan establishes is scoped to `create`, whose
  content is the only input the instructions size for the model. Do not add
  caps to these tools in this plan.
- `src/core/read.ts`, `src/core/fs.ts` — the _read_ cap (`getMaxTextFileSize`)
  is unchanged.
- `src/transport/http-policy.ts` — auth, rate limit and CORS are untouched.
- Any new env var or CLI flag. The bound is derived, not configured.
- The SDK's default (`STDIO_DEFAULT_MAX_BUFFER_SIZE`) itself.

## Git workflow

- Branch: `advisor/048-inbound-message-cap`
- Commits (conventional): e.g. `fix(transport): derive the inbound message bound from FS_MAX_FILE_SIZE`,
  `test(stdio): overflow test uses the derived bound`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: The one bound

In `src/core/util.ts`, directly after `getMaxTextFileSize`, add:

```ts
/**
 * Upper bound, in bytes, on one inbound JSON-RPC message on either transport.
 * Derived from the file-size limit so that a schema-valid `create` — whose
 * combined content is capped at getMaxTextFileSize() (create.ts) in UTF-16
 * units — still fits after JSON encoding. Per unit the schema counted, the
 * wire carries at most three bytes for well-formed text: a BMP character is
 * up to three UTF-8 bytes, an escaped ASCII character (newline, quote,
 * backslash, tab) is two, a surrogate pair is four bytes for two units. Hence
 * 3× the content, plus 1 MiB for the envelope, paths and sibling arguments.
 * Not covered, deliberately: C0 control characters and lone surrogates
 * (JSON-escaped to six bytes each) — the read tools already refuse such
 * content as binary, and a caller sending it only loses its own connection.
 * Past this bound HTTP answers 413 and stdio closes the connection (the
 * SDK's ReadBuffer contract), so it is also the number the instructions
 * resource and --print-config report.
 */
export function getMaxInboundMessageBytes(): number {
  return 3 * getMaxTextFileSize() + MIB;
}
```

**Verify**: `npm run build` → exit 0.

### Step 2: stdio — size the buffer and explain an overflow

In `src/transport/stdio.ts`:

1. Import `getMaxInboundMessageBytes` from `'../core/util.ts'` (keep the
   Prettier import order: it sorts `../core/*` imports alphabetically by
   path, so `util.ts` goes after `path.ts`/`watcher-registry.ts` as the
   plugin dictates — run Prettier and accept its order).
2. Replace line 181:

```ts
// Sized from the same limit the write tools enforce: an overflow is fatal
// to the connection (the SDK's ReadBuffer contract), so a schema-valid
// create must always fit. See getMaxInboundMessageBytes.
const wire = new StdioServerTransport(process.stdin, process.stdout, {
  maxBufferSize: getMaxInboundMessageBytes(),
});
```

3. Replace the `onerror` callback at lines 235-237 with:

```ts
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
```

**Verify**: `npm run build && npm run lint` → exit 0.

### Step 3: HTTP — same bound, named in the 413

In `src/transport/http.ts`:

1. Remove `DEFAULT_MAX_REQUEST_BODY_SIZE` from the `@modelcontextprotocol/server`
   import (lines 10-17). Add `getMaxInboundMessageBytes` to the existing
   `'../core/util.ts'` import (line 30 currently imports `parseEnvInt`).
2. In `errorHandlerMiddleware` (line 70) change the 413 branch to:

```ts
if (err.status === 413) {
  sendJsonRpcError(
    res,
    413,
    ProtocolErrorCode.InvalidRequest,
    `Request body too large: the limit is ${String(getMaxInboundMessageBytes())} bytes (3 × FS_MAX_FILE_SIZE + 1 MiB). Split the write into smaller calls.`,
  );
  return;
}
```

3. Replace the comment and `parseJson` at lines 164-169 with:

```ts
// One bound for both transports, derived from the write tools' own limit
// (getMaxInboundMessageBytes): a create the schema accepts must not be
// refused here. Mounted after CORS, the rate limiter and auth, so a refused
// request is answered without its body being read. The SDK's handler and
// adapter get the same number below so their internal defaults (4 MiB)
// cannot disagree with this parser, although both only read a body when no
// parsedBody is supplied — which this route never does.
const parseJson = express.json({ limit: `${String(getMaxInboundMessageBytes())}b` });
```

4. In `startHttpServer`, add `const maxRequestBodySize = getMaxInboundMessageBytes();`
   before `createMcpHandler` (line 311), and pass it:
   - `createMcpHandler(..., { legacy: 'stateless', maxRequestBodySize, onerror })`
   - `toNodeHandler(modernHandler, { maxRequestBodySize, onerror })`

**Verify**: `npm run check:static` → exit 0 (knip must not report
`DEFAULT_MAX_REQUEST_BODY_SIZE` as unused — you removed the import — and
ESLint must be clean).

### Step 4: `create` — cap the combined content

In `src/tools/create.ts`, inside the existing `superRefine` at line 68, add a
second check **after** the duplicate loop:

```ts
// One call's content is what one inbound message carries; the transports
// size their message bound from this same limit (getMaxInboundMessageBytes),
// so a batch that passes here always fits on the wire. Counted in the same
// UTF-16 units as the per-file refine above.
const total = value.files.reduce((sum, file) => sum + file.content.length, 0);
const limit = getMaxTextFileSize();
if (total > limit) {
  ctx.addIssue({
    code: 'custom',
    path: ['files'],
    message: `combined content is ${String(total)} characters; one create call carries at most ${String(limit)} (FS_MAX_FILE_SIZE). Split the batch.`,
    input: value,
  });
}
```

Update the `files` `.describe(...)` (line 66) to end with
`'; combined content is capped at the file-size limit'`.

**Verify**: `npm run build && npm test -- --test-name-pattern="create"` →
all pass (no existing test batches more than the limit).

### Step 5: Say it where the model and operator read it

1. `src/instructions.ts:69` — change the sentence start to:
   `` `enforced_limits: max file size ${maxFileMb} MB (also the combined content cap of one create call), file search cap ...` `` — keep the rest verbatim.
2. `src/cli.ts:246` — `limits: { maxFileSizeBytes: getMaxTextFileSize(), maxInboundMessageBytes: getMaxInboundMessageBytes() },`
   (import `getMaxInboundMessageBytes` alongside `getMaxTextFileSize` on line 17).
3. `README.md:423` — replace the description cell with:
   `Maximum file size for reads and the combined content of one create call, in bytes (env: FS_MAX_FILE_SIZE). Each transport accepts one message of up to 3 × this + 1 MiB`
   (keep the backticks around `FS_MAX_FILE_SIZE` as the row does today).
4. `README.md:447` — replace the description cell with:
   `Maximum file size for reads and for one create call's combined content, in bytes (mirrors --max-file-size). Also sizes the per-message wire limit: 3 × this + 1 MiB.`
   (backticks around `--max-file-size`).
5. `src/cli-help.ts:49` — desc becomes
   `'Maximum file size for reads and for one create call, in bytes; the per-message wire limit is 3 × this + 1 MiB (env: FS_MAX_FILE_SIZE)'`;
   `src/cli-help.ts:80` — desc becomes
   `'Maximum file size for reads and for one create call, in bytes; sizes the wire limit (3 × this + 1 MiB)'`.
   If `__tests__/cli.test.ts` or a help snapshot asserts on the old wording,
   update that assertion to the new text.
6. Run `npx prettier --write README.md src/instructions.ts src/cli.ts src/cli-help.ts`
   — the README tables are column-aligned and Prettier re-pads them.

**Verify**: `npm run check:static` → exit 0;
`node src/index.ts --print-config .` (Node ≥ 24 strips the types; this is
how the tests spawn the CLI too) → JSON whose `limits.maxInboundMessageBytes`
is `32505856` (31 MiB) with `FS_MAX_FILE_SIZE` unset.

### Step 6: Tests — pin the bound on both transports

**`__tests__/stdio.test.ts`**

1. Replace the `STDIO_DEFAULT_MAX_BUFFER_SIZE` import (line 3) with
   `import { ProtocolErrorCode } from '@modelcontextprotocol/server';` and add
   `import { MIB } from '../src/core/util.ts';`.
2. In `STDIO-014` (line 235): spawn with the smallest legal file limit so the
   overflow payload stays small —
   `const harness = await createRawStdioServer(root, { FS_MAX_FILE_SIZE: String(MIB) });`
   — and write past the derived bound:

```ts
// 3 × FS_MAX_FILE_SIZE + 1 MiB is the bound stdio.ts derives; one byte over.
harness.child.stdin.write(Buffer.alloc(4 * MIB + 1, 'x'));
```

After the existing `assert.match(stderr, /ReadBuffer exceeded maximum size/)`
add `assert.match(stderr, /exceeded 4194304 bytes .*Split the write/);`. 3. Add a new test in the `Stdio Transport (real subprocess)` describe (it has
`harness` from `createStdioClient(tmpDir)`, default limits):

```ts
it('STDIO-017: a create at the advertised file limit fits one stdio message', async () => {
  // 10 MiB of short lines: every "\n" doubles under JSON escaping, so the
  // wire message is ~1.2× the content and over the SDK's default 10 MB
  // buffer — the case the derived bound exists for.
  const content = 'line\n'.repeat((10 * MIB) / 5);
  const target = join(tmpDir, 'at-limit.txt');
  const result = await harness.client.callTool({
    name: 'create',
    arguments: { files: [{ path: target, content }] },
  });
  assert.notStrictEqual(result.isError, true, JSON.stringify(result.content));
  const stats = await stat(target);
  assert.strictEqual(stats.size, content.length);
});
```

(import `stat` from `'node:fs/promises'` next to the existing `writeFile`
import). Before this plan, this call killed the connection: the client
would reject with a closed-transport error.

**`__tests__/http-server.test.ts`**

4. Test "5." (line 275): import `getMaxInboundMessageBytes` from
   `'../src/core/util.ts'` and change the body to
   `'x'.repeat(getMaxInboundMessageBytes() + 1)` with the comment
   `// one byte over the derived bound (3 × FS_MAX_FILE_SIZE + 1 MiB)`. After
   the existing assertions add
   `assert.match(String((body.error as { message?: string }).message), /Split the write/);`
   (widen the `body` cast to `{ error?: { code?: number; message?: string } }`).
5. Add a new describe at the end of the file:

```ts
describe('the request body limit follows FS_MAX_FILE_SIZE', () => {
  let tmpDir: string;
  let http: HttpTestContext;

  before(async () => {
    tmpDir = await createTestRoot();
    http = await bootHttpTest([tmpDir], { FS_MAX_FILE_SIZE: String(MIB) });
  });
  after(async () => {
    await http.close();
    await cleanupTestRoot(tmpDir);
  });

  it('refuses a body over 3 × the file limit + 1 MiB with the bound in the message', async () => {
    const r = await fetch(http.base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${TEST_API_KEY}` },
      body: 'x'.repeat(4 * MIB + 1),
    });
    assert.strictEqual(r.status, 413);
    const body = (await r.json()) as { error?: { message?: string } };
    assert.match(body.error?.message ?? '', /4194304 bytes/);
  });

  it('accepts a create whose content is at the file limit', async () => {
    const client = await http.makeClient('at-limit');
    try {
      const content = 'line\n'.repeat(MIB / 5);
      const result = await client.callTool({
        name: 'create',
        arguments: { files: [{ path: join(tmpDir, 'at-limit.txt'), content }] },
      });
      assert.notStrictEqual(result.isError, true, JSON.stringify(result.content));
    } finally {
      await client.close();
    }
  });
});
```

Import `MIB` from `'../src/core/util.ts'`, and `before`/`after` from
`'node:test'` if the file only imports `beforeEach`/`afterEach` today.
Check how the file spells the bearer header in test "5." and match it.

**`__tests__/tools.test.ts`**

6. Next to the existing `create` tests, add:

```ts
it('create refuses a batch whose combined content exceeds the file limit', async () => {
  const limit = getMaxTextFileSize();
  const half = 'x'.repeat(Math.ceil(limit / 2) + 1);
  const result = await harness.client.callTool({
    name: 'create',
    arguments: {
      files: [
        { path: join(tmpDir, 'batch-a.txt'), content: half },
        { path: join(tmpDir, 'batch-b.txt'), content: half },
      ],
    },
  });
  assert.strictEqual(result.isError, true);
  assert.match(firstTextBlock(result).text ?? '', /combined content .* Split the batch/);
});
```

(`tools.test.ts:12` imports `MAX_SEARCH_RESULTS` from `'../src/core/util.ts'`
— add `getMaxTextFileSize` to that import.)

**Verify**:
`npm test -- __tests__/stdio.test.ts` → all pass incl. STDIO-014 and STDIO-017;
`npm test -- __tests__/http-server.test.ts` → all pass incl. the two new ones;
`npm test -- --test-name-pattern="create"` → all pass.

### Step 7: Prove STDIO-017 is live

Temporarily revert the `wire` change from step 2 (back to
`new StdioServerTransport()`), run
`npm test -- --test-name-pattern="STDIO-017" __tests__/stdio.test.ts`
(pattern **before** the file — `node --test` treats a trailing pattern as
a second file argument and runs everything) → **fails** (the client's
transport closes; the call rejects). Restore step 2.

**Verify**: the failure was observed; then `npm run check` → exit 0, `fail 0`,
≥ 537 pass.

## Test plan

- `STDIO-014` (updated) pins the derived bound end-to-end at the smallest
  legal `FS_MAX_FILE_SIZE` and the new hint line.
- `STDIO-017` (new) pins the invariant this plan exists for: a `create` at the
  advertised file limit, newline-heavy, completes over stdio.
- HTTP test "5." (updated) posts one byte over the default bound; two new HTTP
  tests pin the bound at `FS_MAX_FILE_SIZE = 1 MiB` (413 message names
  `4194304`) and that an at-limit create succeeds.
- `tools.test.ts` (new) pins the combined-content refine and its message.
- Pattern: `stdio.test.ts` STDIO-014 (raw child), `http-server.test.ts`
  "5." (raw fetch), `tools.test.ts` create tests (client harness).

## Done criteria

Search commands are given for PowerShell (the repo's declared shell has no
`grep`); on POSIX substitute `grep -rn`.

- [ ] `npm run check` exits 0; ≥ 537 pass, 0 fail
- [ ] `Select-String -Path src\*,src\**\*,__tests__\* -Pattern "DEFAULT_MAX_REQUEST_BODY_SIZE|STDIO_DEFAULT_MAX_BUFFER_SIZE"` returns nothing
- [ ] `Select-String -Path src\transport\stdio.ts -Pattern "maxBufferSize: getMaxInboundMessageBytes\(\)"` → exactly one line
- [ ] `(Select-String -Path src\transport\http.ts -Pattern "getMaxInboundMessageBytes\(\)").Count` ≥ 3 (parser limit, 413 text, SDK knobs)
- [ ] `--print-config` JSON has `limits.maxInboundMessageBytes` = `32505856` with `FS_MAX_FILE_SIZE` unset
- [ ] `README.md` rows 423 and 447, `src/cli-help.ts:49,80` and `src/instructions.ts:69` mention the combined-content cap; `npx prettier --check .` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `StdioServerTransport`'s constructor no longer accepts `{ maxBufferSize }`
  (check `node_modules/@modelcontextprotocol/server/dist/stdio.d.mts`) — the
  SDK contract this plan leans on changed.
- STDIO-017 still fails after step 2 with a closed-transport error — the
  inflation factor is larger than assumed; report the wire size you measured
  (`Buffer.byteLength(JSON.stringify(request))`) rather than raising the
  multiplier blind.
- Test "5." in `http-server.test.ts` returns a status other than 413 after
  step 3 (e.g. 400 from `toNodeHandler` reading the stream) — the parse order
  plan 013 established has drifted.
- `knip` or ESLint reports something you did not touch.
- The Windows CI job fails STDIO-014 on the exit-code assertion `[0, null]`
  — that is the pre-existing shape of the test; report, do not loosen.

## Maintenance notes

- `getMaxInboundMessageBytes` is the single owner of the bound. Any new tool
  that accepts large text (a multi-file `patch`, say) must either cap its
  input at `getMaxTextFileSize()` or revisit the 3× factor — the comment on
  the function states the assumption.
- Reviewer focus: the 413 text and the stdio hint both name
  `3 × FS_MAX_FILE_SIZE + 1 MiB`; if the formula changes, both strings and
  the README rows change with it.
- Deferred: the HTTP 413 remains a JSON-RPC error rather than an `isError`
  tool result — the body is refused before the SDK parses it, so there is no
  tool to answer. A per-item `create` refine already gives the model a tool
  error for the cases the schema can see.
