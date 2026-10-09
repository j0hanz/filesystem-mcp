# Plan 052: `tools/call` arguments are refused before validation when they carry more than 4096 elements

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8941498f..HEAD -- src/server.ts src/core/util.ts __tests__/tools.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW — one constructor option, off today; the cap sits ~2.7× above
  the largest schema-legal payload, so no legitimate call changes behaviour.
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `8941498f`, 2026-10-09

> **Correction (found during execution)**: the SDK's `tools/call` handler
> catches the `ProtocolError` thrown for an over-cap payload and returns it
> as a result with `isError: true`; `callTool` resolves, it does not reject
> with `-32602`. Wherever this plan says `-32602` or `assert.rejects` for the
> over-cap case, read "resolved `isError` result whose text matches
> `more than the maximum of 4096 elements`". Executed that way.

## Why this matters

Every tool schema caps its own arrays (`read`/`delete` 1000 paths, `move`
100 operations, `edit` 5 files × 100 edits), but a Zod `.max()` runs only
after Zod has walked the whole value. Until then the only bound on a
`tools/call` payload is the transport body limit —
`3 × FS_MAX_FILE_SIZE + 1 MiB`, 31 MiB by default (plan 048) — so a caller
can make the server JSON-parse and Zod-traverse tens of megabytes of
`[[[[…]]]]` or `{"a":{"a":…}}` per request before any schema says no.
`@modelcontextprotocol/server` 2.3.0 added `McpServerOptions.maxToolInputElements`:
a cheap count of array elements plus object members, done before schema
validation, answered with `-32602`. This plan turns it on at a value no
legitimate call can reach, so the gain is pure headroom removal: a hostile
payload is refused after counting at most 4097 nodes instead of after a full
parse.

## Current state

- `src/server.ts:95-130` — `serverConfig`, the second constructor argument of
  `McpServer`. It already sets `capabilities`, `enforceStrictCapabilities`,
  `cacheHints`, `requestState` and `debouncedNotificationMethods`; it does
  **not** set `maxToolInputElements`. Excerpt:

```ts
  const cacheScope: 'private' | 'public' = extraDeps?.apiKey ? 'private' : 'public';
  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
    capabilities,
    enforceStrictCapabilities: true,
    cacheHints: {
```

and, at `src/server.ts:144`:

```ts
const server = new McpServer(implementation, serverConfig);
```

- The SDK option (installed `@modelcontextprotocol/server` 2.3.1,
  `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts:3223-3230`):

```ts
type McpServerOptions = ServerOptions & {
  /**
   * Largest combined number of array elements and object members a single `tools/call` `arguments` payload may contain.
   * A number of at least 1; unset or `Infinity` means no limit.
   */
  maxToolInputElements?: number;
};
```

- Runtime behaviour (`node_modules/@modelcontextprotocol/server/dist/mcp-DIH4cS6P.mjs:1622-1645,1810-1811`):
  `toolInputElementCount(args, max)` walks `arguments` iteratively, counting
  every array element and every own object member, and stops as soon as the
  count exceeds `max`. `validateToolInput` then throws
  `ProtocolError(InvalidParams, "Invalid arguments for tool <name>: arguments contain more than the maximum of <max> elements")`
  **before** the schema runs. `resolveMaxToolInputElements` throws a
  `RangeError` for anything that is not a number ≥ 1 or `Infinity`.
- Largest schema-legal payloads today (what the cap must clear):
  - `edit` batch (`src/tools/edit.ts:44-70`: `MAX_MULTI_FILES = 5`,
    `MAX_EDITS_PER_FILE = 100`, each edit `{ oldText, newText }`):
    top-level members 2 (`files`, `dryRun`) + 5 file elements + 5 × 2 file
    members + 5 × 100 edit elements + 500 × 2 edit members = **1517**.
  - `read` / `delete` (`src/core/schema.ts:130,146`: `DEFAULT_MAX_BATCH = 1000`;
    `src/tools/delete.ts:34-36`): 1000 path elements + a handful of
    top-level members ≈ **1005**.
  - `move` (`src/tools/move.ts:50`, 100 items), `create`
    (`src/tools/create.ts:63-65`, 100 items): a few hundred.
- `src/core/util.ts:138-154` — the module that owns the other numeric limits
  (`READ_MANY_MAX_TOTAL_BYTES`, `MAX_LIST_ENTRIES`, `MAX_SEARCH_RESULTS`,
  …), each an exported `const` with a one-line comment. Put the new constant
  there, in the same style.
- `__tests__/tools.test.ts:31-47` — `describe('P0 Functional Tests - Tools (MCP Client)')`
  with a shared `harness = await createTestClientPair([tmpDir])`
  (in-memory client/server pair; `createTestClientPair` is in
  `__tests__/helpers.ts:164-184`). `:555-586` (`TC-FUNC-012`) is the exemplar
  for asserting that `callTool` rejects with `ProtocolErrorCode.InvalidParams`:

```ts
      await assert.rejects(
        async () => {
          await readOnlyHarness.client.callTool({ name: 'create', arguments: { … } });
        },
        (err: unknown) => {
          return (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code: ProtocolErrorCode }).code === ProtocolErrorCode.InvalidParams
          );
        },
      );
```

Conventions: TypeScript ESM with `.ts` import specifiers; Prettier
formatting; Node's built-in test runner (`node:test` + `node:assert/strict`).
The SDK option applies to the `McpServer` instance, so it covers stdio, the
modern HTTP leg and the legacy HTTP leg alike — all three construct through
`createServer`.

## Commands you will need

| Purpose      | Command                                   | Expected on success |
| ------------ | ----------------------------------------- | ------------------- |
| Build        | `npm run build`                           | exit 0              |
| Static check | `npm run check:static`                    | exit 0              |
| Tool tests   | `npm test -- __tests__/tools.test.ts`     | all pass            |
| Full check   | `npm run check`                           | exit 0; `fail 0`    |
| Format       | `npx prettier --write <files you edited>` | exit 0              |

Baseline at planning time: `npm test` → 567 tests, 564 pass, 3 skipped, 0 fail.

## Scope

**In scope** (the only files you should modify):

- `src/core/util.ts` — one exported constant
- `src/server.ts` — one option line plus comment
- `__tests__/tools.test.ts` — two new tests
- `plans/README.md` — status row

**Out of scope** (do NOT touch, even though they look related):

- The per-tool `.max()` caps in `src/core/schema.ts`, `src/tools/*.ts` —
  they are the user-facing limits with their own messages; this cap sits
  above them, it does not replace them.
- `src/transport/*` — the body limit (`getMaxInboundMessageBytes`) stays as
  is; this plan adds a second, structural bound, not a byte bound.
- `README.md`, `src/instructions.ts`, `--print-config` — the cap is
  unreachable by any schema-legal call, so it is not an operator-facing
  limit; the SDK error names the number if it ever fires.

## Git workflow

- Branch: `advisor/052-max-tool-input-elements`
- One commit, e.g. `feat(server): cap tools/call arguments at 4096 elements before validation`
  (repo style: conventional commits, see `git log --oneline -10`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Give the cap one owner

In `src/core/util.ts`, after the `MAX_SEARCH_RESULTS` / `DEFAULT_SEARCH_*`
block (around line 154), add:

```ts
/**
 * Upper bound on array elements plus object members in one `tools/call`
 * `arguments` payload, counted by the SDK before any schema runs
 * (`McpServerOptions.maxToolInputElements`). Must clear the largest
 * schema-legal call: an `edit` batch of 5 files × 100 edits is 1517 nodes
 * and a 1000-path `read`/`delete` is ~1005, so 4096 is ~2.7× headroom.
 * Raise it in the same change that raises any of those schema caps.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 4096;
```

**Verify**: `npm run build` → exit 0.

### Step 2: Pass it to `McpServer`

In `src/server.ts`:

1. Extend the existing `./core/util.ts` import if there is one, else add
   `import { MAX_TOOL_INPUT_ELEMENTS } from './core/util.ts';` beside the
   other `./core/…` imports (Prettier/ESLint order them; `npm run lint`
   tells you if the position is wrong).
2. In `serverConfig`, directly after `enforceStrictCapabilities: true,`,
   add:

```ts
    // Structural bound on tools/call arguments, checked before Zod walks the
    // value: the body limit is bytes (31 MiB by default), and every per-tool
    // `.max()` runs only after a full traversal. No schema-legal call comes
    // near this (see MAX_TOOL_INPUT_ELEMENTS); a payload over it is answered
    // -32602 after counting at most 4097 nodes.
    maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
```

**Verify**: `npm run build && npm run lint` → exit 0. Then
`npm test -- __tests__/tools.test.ts` → all pass (nothing legitimate changed).

### Step 3: Tests

In `__tests__/tools.test.ts`, inside the top-level
`describe('P0 Functional Tests - Tools (MCP Client)')`, directly after the
`TC-FUNC-012` test (ends at line 586), add two tests. Add
`MAX_TOOL_INPUT_ELEMENTS` to the existing import from `'../src/core/util.ts'`
(line 12).

```ts
it('tools/call arguments over MAX_TOOL_INPUT_ELEMENTS are refused before schema validation', async () => {
  // 1000 is `read`'s own schema cap; this payload is far past it, so only
  // the SDK's structural count can be the error that comes back.
  const paths = Array.from(
    { length: MAX_TOOL_INPUT_ELEMENTS + 1 },
    (_, i) => `${tmpDir}/never-${String(i)}.txt`,
  );
  await assert.rejects(
    async () => {
      await harness.client.callTool({ name: 'read', arguments: { paths } });
    },
    (err: unknown) => {
      assert.ok(typeof err === 'object' && err !== null && 'code' in err && 'message' in err);
      const { code, message } = err as { code: ProtocolErrorCode; message: string };
      assert.strictEqual(code, ProtocolErrorCode.InvalidParams);
      assert.match(
        message,
        new RegExp(`more than the maximum of ${String(MAX_TOOL_INPUT_ELEMENTS)} elements`),
        'the structural cap, not the read schema, must be what refuses this',
      );
      return true;
    },
  );
});

it('the largest schema-legal edit batch (5 files x 100 edits) is not refused by the element cap', async () => {
  // 2 top-level members + 5 files + 5x2 file members + 500 edits + 500x2
  // edit members = 1517 nodes. Must stay well under MAX_TOOL_INPUT_ELEMENTS;
  // if a schema cap is ever raised past the headroom, this test is the alarm.
  const files = await Promise.all(
    Array.from({ length: 5 }, async (_, f) => {
      const path = join(tmpDir, `cap-${String(f)}.txt`);
      await writeFile(path, 'unrelated content\n');
      return {
        path,
        edits: Array.from({ length: 100 }, (_, e) => ({
          oldText: `absent-${String(f)}-${String(e)}`,
          newText: '',
        })),
      };
    }),
  );
  // Resolves (a tool-level error about unmatched oldText is fine); the cap
  // would instead reject the call with a -32602 ProtocolError.
  const result = await harness.client.callTool({
    name: 'edit',
    arguments: { files, dryRun: true },
  });
  assert.ok(result, 'callTool must resolve, not reject');
});
```

`join` and `writeFile` are already imported at the top of the file
(lines 5-7). Run `npx prettier --write __tests__/tools.test.ts`.

**Verify**: `npm test -- __tests__/tools.test.ts` → all pass, 2 more than
before this plan.

**Mutation check (do not commit)**: temporarily change the value in
`src/core/util.ts` to `1500`; the second test must now fail with
`more than the maximum of 1500 elements`. Restore `4096`.

### Step 4: Full check

`npx prettier --write src/core/util.ts src/server.ts __tests__/tools.test.ts`
then `npm run check`.

**Verify**: `npm run check` → exit 0, `fail 0`, ≥ 566 pass (564 + 2).

## Test plan

- Over-cap `read` → `-32602` with the SDK's "more than the maximum of 4096
  elements" message (proves the option is live and fires before the schema).
- Maximum legal `edit` batch resolves (proves no legitimate call regresses,
  and alarms if a schema cap later outgrows the headroom).
- Pattern: `TC-FUNC-012` in `__tests__/tools.test.ts:555-586`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run check` exits 0; ≥ 566 pass, 0 fail
- [ ] `Select-String -Path src\server.ts -Pattern "maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS"` → exactly one hit (POSIX: `grep -n "maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS" src/server.ts`)
- [ ] `Select-String -Path src\core\util.ts -Pattern "export const MAX_TOOL_INPUT_ELEMENTS = 4096;"` → exactly one hit
- [ ] The mutation check in step 3 was observed to fail and the value restored
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `maxToolInputElements` is not declared in
  `node_modules/@modelcontextprotocol/server/dist/createMcpHandler-D4NN8WsG.d.mts`
  (grep for it) — the installed SDK is not 2.3.x.
- `npm run build` reports that `maxToolInputElements` is not assignable to
  the `serverConfig` type — the constructor type alias changed; report rather
  than widening the type.
- After step 2, any **existing** test in `__tests__/tools.test.ts`,
  `__tests__/stdio.test.ts` or `__tests__/http-server.test.ts` fails with a
  message containing "more than the maximum of" — a legitimate fixture is
  larger than this plan's count; report the test name and the payload shape
  instead of raising the number.
- The over-cap test's rejection message mentions the `read` schema
  ("Input validation error", "Max 1000") instead of the element cap — the SDK
  ran the schema first; the option is not taking effect.

## Maintenance notes

- `MAX_TOOL_INPUT_ELEMENTS` must be revisited whenever `MAX_MULTI_FILES`,
  `MAX_EDITS_PER_FILE` (`src/tools/edit.ts`), `DEFAULT_MAX_BATCH`
  (`src/core/schema.ts`) or a `.max()` on a `move`/`create` array is raised;
  the second test fails loudly if the headroom is consumed.
- Reviewers: confirm the option is on the `McpServer` constructor options,
  not on `Server` — only `McpServer` reads it.
- Deferred: surfacing the cap in `--print-config` / README. It is not an
  operator-tunable limit and no legal call can hit it.
