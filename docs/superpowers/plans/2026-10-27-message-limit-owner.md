# Message limit owner implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the stdio **Message limit** one owner, `src/core/outbound.ts`,
and stop `read` from offering a link that stdio's `resources/read` then
refuses. Over stdio with the defaults, `read {head: 1}` of a
10,300,000-byte text file today returns a `resourceUri` and a
`resource_link`, and reading that link fails with `-32602 TOO_LARGE`. Any
file whose raw size is in (10,223,616, 10,485,760] reproduces it.

**Architecture:** The limit is spread over four files today. `util.ts` holds
the constant and the measures, `file-uri.ts` guesses which files a write
tool may link, `resources.ts` refuses a resource read, and `define.ts`
refuses a tool result. Each spells the refusal for itself. `outbound.ts`
takes all of it. It answers three questions per transport
(`'stdio' | 'http' | undefined`): does this result fit, can this file be
linked, and what is the refusal. HTTP and an unset transport always fit
(ADR-003). The link rule is the enforcer's own pre-check, so a link is
offered exactly when `resources/read` would pass that check. `read` asks
the module before it links, through `ctx.transport`, which it never reads
today.

**Tech Stack:** TypeScript (Node ESM, `.ts` imports), Node built-in test
runner, `@modelcontextprotocol/server` (`ProtocolError`).

**Spec:** `docs/adr/006-message-limit-links-by-raw-size.md` and the
**Message limit** entry in `GLOSSARY.md`. Both come from the 2026-10-27
grilling of the outbound-limit candidate.

## Design

These decisions are settled. Do not reopen them.

**What moves into `outbound.ts`:**

| Today                                     | Where                          | In `outbound.ts`                         |
| :---------------------------------------- | :----------------------------- | :--------------------------------------- |
| `MAX_OUTBOUND_RESULT_BYTES`               | `src/core/util.ts:165-176`     | same name                                |
| `MAX_STDIO_REQUEST_ID_BYTES`              | `src/core/util.ts:178-182`     | same name                                |
| `jsonByteBound`                           | `src/core/util.ts:184-213`     | same name                                |
| `base64EncodedBytes`                      | `src/core/util.ts:215-222`     | same name                                |
| `jsonBytesOver`                           | `src/core/util.ts:224-233`     | same name                                |
| `overStdioRead`                           | `src/core/file-uri.ts:111-132` | replaced by `canLinkFile`                |
| `tooLargeForStdio`                        | `src/resources.ts:440-451`     | `refuseResourceRead`                     |
| the refusal text in `refuseOversized`     | `src/tools/define.ts:462-475`  | `refuseToolResult`                       |
| the size checks at `resources.ts:236-245` | `src/resources.ts`             | `readResultFloor` + `MAX_…` stay callers |

`util.ts` keeps no re-export. Every importer moves to `outbound.ts`.

**Link rule (`canLinkFile`), over stdio only:**

| What the caller knows                                | Linkable when                                      |
| :--------------------------------------------------- | :------------------------------------------------- |
| Written content, text kind                           | the exact `wrapRead` result fits (`jsonBytesOver`) |
| Written content or size only, non-text               | `base64EncodedBytes(size) <= MAX`                  |
| Size only, text kind (a read slice, `create` append) | `size <= MAX`                                      |

- The size-only text row replaces the 6x worst case at
  `file-uri.ts:123`. It is the enforcer's own pre-check at
  `resources.ts:237`.
- The non-text row drops the 64 KiB slack at `file-uri.ts:126`. It is the
  enforcer's own rule at `resources.ts:244`.
- `readResultFloor(size, binary)` is the one function behind both the
  enforcer's pre-checks and the size-only rows: `binary ? base64EncodedBytes(size) : size`.
- Known residual, accepted in ADR-006: a text file whose escapes or the
  result envelope push it over can still be linked and then refused by
  `wrapRead`. That needs more than ~5.1 MB of quotes or backslashes, or a
  raw size within a few hundred bytes of `MAX`. Mark it in `canLinkFile`
  with
  `// shortcut: size-only text links skip escaping and the envelope, so wrapRead can still refuse > ~5.1 MB of quotes/backslashes or a file a few hundred bytes under the limit; measure the file if clients hit it (ADR-006)`.

**Refusal texts stay byte for byte:**

- Tool surface: `FsError(TOO_LARGE, "<tool> result too large to return (<n> bytes once JSON-encoded, over the <MAX>-byte stdio message limit).", undefined, undefined, remedy)`.
- Resource surface: `ProtocolError(InvalidParams, "Resource result too large to return ([at least ]<n> bytes once JSON-encoded, over the <MAX>-byte stdio message limit). Read smaller slices/pages with tools, or connect over HTTP.", { code: 'TOO_LARGE', suggestion })`.

**Interfaces (`src/core/outbound.ts`):**

```ts
export type Transport = 'stdio' | 'http' | undefined;

export const MAX_OUTBOUND_RESULT_BYTES: number; // 10 MiB - 256 KiB, unchanged
export const MAX_STDIO_REQUEST_ID_BYTES: number; // 1 KiB, unchanged
export function jsonByteBound(value: unknown): number;
export function jsonBytesOver(value: unknown, limit: number): number | undefined;
export function base64EncodedBytes(size: number): number;

/** The least a file of `size` bytes costs in a resources/read result. */
export function readResultFloor(size: number, binary: boolean): number;

/** The encoded size when `value` is over the Message limit on `transport`, else undefined. */
export function bytesOverMessageLimit(transport: Transport, value: unknown): number | undefined;

export interface LinkCandidate {
  readonly validPath: string;
  readonly mimeType: string;
  readonly size: number;
  readonly kind: FileKind;
  /** Only when the caller wrote it; a read slice is not the file. */
  readonly content?: string | undefined;
}
export function canLinkFile(transport: Transport, file: LinkCandidate): boolean;

export function refuseToolResult(toolName: string, bytes: number, remedy: string): FsError;
export function refuseResourceRead(bytes: number, atLeast?: boolean): ProtocolError;
```

## Global Constraints

- `npm run check` passes after every task's commit.
- `__tests__/contract.test.ts.snapshot` stays unchanged. Never run
  `--test-update-snapshots` for this work. If `contract.test.ts` fails, stop
  and report; do not update the snapshot.
- Out of scope: the TOO_LARGE wording in the instructions and `get-help`
  text, `create`'s confirm-then-lock swap gap, ADR-005's `maxMatches`, and
  the Rewrite module (a separate PR).
- Keep every existing MCP-level test. Flip only the assertions this change
  moves, and say which in the commit body.
- `ResourceStore` (`src/core/store.ts:184`) keeps its own
  `maxReadResultBytes` cap. It only changes its import of `jsonBytesOver`.
- Do not touch the versions in `package.json`, `server.json`,
  `mcpb/manifest.json`, `.codex-plugin/plugin.json` or
  `.cursor-plugin/plugin.json`.
- Work on branch `refactor/message-limit-owner`.

## Review Focus

1. **Every link `read` offers over stdio passes the enforcer's pre-check.**
   Covered by Task 3's stdio regression and the `canLinkFile` edges at
   `MAX` and `MAX + 1`.
2. **The refusal texts did not move.** Covered by Task 2's exact-text tests
   and the existing `assertResourceTooLarge` cases in
   `outbound-regressions.test.ts`.
3. **The binary `read` sites.** `read.ts:313` and `:342` now ask
   `canLinkFile`, so a file too large for base64 over stdio gets no
   `resourceUri`, and the embedded `resource` block at `read.ts:434` needs
   that URI. This is unreachable: the tool result carries the same base64,
   so `refuseOversized` refuses it with TOO_LARGE first. Confirm with the
   existing large-image and binary tests in `outbound-regressions.test.ts`.
4. **HTTP and the in-memory pair are untouched.** `canLinkFile` and
   `bytesOverMessageLimit` answer "fits" for `'http'` and `undefined`.

---

### Task 1: Move the measures into `outbound.ts`

A pure move. No behavior changes.

**Files:**

- Create: `src/core/outbound.ts`. Move `src/core/util.ts:165-233`
  (`MAX_OUTBOUND_RESULT_BYTES`, `MAX_STDIO_REQUEST_ID_BYTES`,
  `jsonByteBound`, `base64EncodedBytes`, `jsonBytesOver`) with their doc
  comments. Import `MIB` from `util.ts` and declare a local
  `const KIB = 1024`, as `file-uri.ts:16` does.
- Modify the importers, with no re-export left in `util.ts`:
  - `src/core/file-uri.ts:9-14`
  - `src/core/store.ts:6`
  - `src/resources.ts:35-40`
  - `src/server.ts:15`
  - `src/tools/define.ts:40`
  - `src/tools/read.ts:29-36`
  - `src/transport/stdio.ts:17-21`
  - `__tests__/core-fs.test.ts:36`
  - `__tests__/outbound-regressions.test.ts:11`
  - `__tests__/stdio.test.ts:14`
- Move: `__tests__/outbound-regressions.test.ts:478-523`
  (`describe('encoded result size bound')`) to `__tests__/outbound.test.ts`
  (new), unchanged.

- [ ] **Step 1: Move the test first.** Create `__tests__/outbound.test.ts`
      with the moved `describe`, importing from `../src/core/outbound.ts`.
- [ ] **Step 2: Run.** `npm test -- --test-name-pattern="encoded result size bound"`.
      Expected: FAIL, module not found.
- [ ] **Step 3: Move the code** and update every importer listed above.
      Check with `grep -rn "MAX_OUTBOUND_RESULT_BYTES\|MAX_STDIO_REQUEST_ID_BYTES\|jsonByteBound\|jsonBytesOver\|base64EncodedBytes" src __tests__`
      that nothing still imports them from `util.ts`.
- [ ] **Step 4: Run.** The filtered run passes, and so does
      `npm run check:static` (knip must not report a stale export).
- [ ] **Step 5: Commit.**
      `refactor(core): move the Message limit measures into outbound.ts`

### Task 2: One owner for "does it fit" and the refusals

Still no visible change: both surfaces keep their texts.

**Files:**

- Modify: `src/core/outbound.ts`. Add `Transport`, `readResultFloor`,
  `bytesOverMessageLimit`, `refuseToolResult` and `refuseResourceRead`
  (§ Design).
- Modify: `src/tools/define.ts:452-476` (`refuseOversized`).
  - Replace the `transport !== 'stdio'` return and the `jsonBytesOver` call
    with `bytesOverMessageLimit(this.toolCtx.transport, response)`.
  - Keep the read-only/dry-run gate, the two `discard()` calls and the
    remedy choice as they are.
  - Throw `refuseToolResult(this.def.name, encodedBytes, remedy)`.
- Modify: `src/resources.ts`.
  - Delete `tooLargeForStdio` (`:440-451`); call `refuseResourceRead`.
  - `:237` becomes `readResultFloor(stats.size, false) > MAX_OUTBOUND_RESULT_BYTES`,
    keeping the `<= getMaxTextFileSize()` half.
  - `:243-244` becomes `readResultFloor(readResult.content.length, true)`.
  - `wrapRead` (`:457-460`) uses `bytesOverMessageLimit(transport, result)`.
- Test: `__tests__/outbound.test.ts`

- [ ] **Step 1: Write failing tests** in `outbound.test.ts`.
  - `bytesOverMessageLimit fits on http and unset transport`: a value of
    `{ text: 'x'.repeat(MAX_OUTBOUND_RESULT_BYTES) }` is `undefined` for
    `'http'` and `undefined`, and its exact encoded size for `'stdio'`.
  - `bytesOverMessageLimit edge`: build a string so that
    `JSON.stringify(value)` is exactly `MAX` bytes; it fits on stdio. One
    more byte returns `MAX + 1`.
  - `readResultFloor`: `(MAX, false) === MAX`; `(3, true) === 4`;
    `(4, true) === 8`.
  - `refuseToolResult text`: `refuseToolResult('read', 123, 'R')` is an
    `FsError` with code `TOO_LARGE`, message
    `read result too large to return (123 bytes once JSON-encoded, over the 10223616-byte stdio message limit).`,
    and suggestion `R`.
  - `refuseResourceRead text`: `refuseResourceRead(5, true)` is a
    `ProtocolError` with code `InvalidParams`, a message that starts with
    `Resource result too large to return (at least 5 bytes`, and
    `data` deep-equal to
    `{ code: 'TOO_LARGE', suggestion: 'Read smaller slices/pages with tools, or connect over HTTP.' }`.
    Without `atLeast`, the message has no `at least`.
- [ ] **Step 2: Run.** `npm test -- --test-name-pattern="bytesOverMessageLimit|readResultFloor|refuse"`.
      Expected: FAIL, not exported.
- [ ] **Step 3: Implement** the module functions, then switch `define.ts`
      and `resources.ts` to them.
- [ ] **Step 4: Run.** The filtered run passes, and so do
      `npm test -- --test-name-pattern="outbound result limits"` and
      `npm test -- --test-name-pattern="resources"`.
- [ ] **Step 5: Commit.** `refactor(core): give the Message limit one owner`

### Task 3: `read` links only what stdio can read back

**Files:**

- Test first: `__tests__/outbound-regressions.test.ts`, in
  `describe('outbound result limits')`.
- Modify: `src/core/outbound.ts`. Add `LinkCandidate` and `canLinkFile`
  (§ Design), with the `shortcut:` comment.
- Modify: `src/core/file-uri.ts`.
  - Delete `overStdioRead` (`:111-132`) and the local `KIB` (`:16`).
  - `writtenFileLinks` (`:146-167`) keeps the dry-run, unknown-size and
    `getMaxTextFileSize()` gates, then asks
    `canLinkFile(transport, { validPath, mimeType, size, kind, content })`.
  - Its last parameter becomes
    `file?: { kind: FileKind; content?: string }`. With no `file`, it is
    text with unknown content. Update its doc comment (`:134-145`): no
    worst-case escape any more.
  - `buildWrittenFileMeta` (`:175-200`) passes `{ content, kind }` as today.
- Modify: `src/tools/read.ts`.
  - `buildPerPathReadValue` (`:238-268`) takes `transport: Transport`. At
    `:249`, `canLink` keeps the `getMaxTextFileSize()` gate and adds
    `canLinkFile(transport, { validPath: result.path, mimeType: mimeInfo.mimeType, size, kind: 'text' })`,
    where `size` is `result.fileSize ?? Buffer.byteLength(result.content, 'utf8')`.
    No `content`: a slice is not the file.
  - `readBinaryResource` (`:313`) and the media branch of `readOnePath`
    (`:342`) set `resourceUri` only when
    `canLinkFile(ctx.transport, { validPath: raw.validPath, mimeType, size, kind })`.
    See Review Focus item 3.
  - Pass `ctx.transport` from every `buildPerPathReadValue` caller. The
    `resource_link` push at `:451-464` already skips a value without
    `resourceUri`, so it needs no change.
- Modify: `__tests__/core-fs.test.ts:750-790`. Move the stdio edge cases to
  `__tests__/outbound.test.ts` as `canLinkFile` tests and flip what the
  rule moves:
  - `a binary written file at the base64 edge gets no stdio link` (`:750`):
    `3 * Math.floor(MAX / 4)` now links (its base64 is exactly `MAX`).
    Rename it `binary links up to the exact base64 limit`, and add
    `MAX + 1` base64 bytes as the refused side.
  - `written file links stop at the encoded stdio read size on stdio only`
    (`:765`): unchanged in meaning. Keep it as a `writtenFileLinks`
    wiring test in `core-fs.test.ts`.
  - `written file links without content assume the worst escape on stdio`
    (`:781`): `2 * MIB` now links. Rename it
    `written file links without content use the raw size on stdio`, and
    assert `MAX` links and `MAX + 1` does not.
- Test: `__tests__/outbound.test.ts`

- [ ] **Step 1: Write the stdio regression.** In the `before` of
      `describe('outbound result limits')`, add `nearLimitFile`
      (`near-limit.txt`): 10,300,000 bytes of 99-byte lines plus newlines,
      truncated to that exact size. Then add:
  - `read of a slice links nothing stdio would refuse`: call `read` with
    `{ path: nearLimitFile, head: 1 }`. Assert no `isError`,
    `(_meta as { resourceUri?: string }).resourceUri === undefined`, and no
    `resource_link` block in `content`.
  - `create append over stdio links a 2 MiB text file`: append `'x
'`
    to a 2 MiB text file. Assert a `resource_link` block in `content`.
    Today none comes back: 6x of 2 MiB is over the limit.
- [ ] **Step 2: Run them and watch them fail.**
      `npm test -- --test-name-pattern="read of a slice links nothing|create append over stdio"`.
      Expected: FAIL. The read has a `resourceUri`; the append has no
      `resource_link`. Do not go on until both fail.
- [ ] **Step 3: Write failing `canLinkFile` tests** in `outbound.test.ts`:
  - `canLinkFile always links on http and unset transport`, for a
    100 MiB text file.
  - `size-only text links up to the limit`: `size: MAX` links,
    `MAX + 1` does not, over stdio.
  - `binary links up to the exact base64 limit`: `3 * (MAX / 4)` links,
    `3 * (MAX / 4) + 1` does not. (`MAX` is divisible by 4.)
  - `written text is measured exactly`: `content` of
    `'"'.repeat(6 * MIB)` does not link though its size does; `content`
    of `'x'.repeat(MAX - 64 * KIB)` links; `'x'.repeat(MAX)` does not,
    because the URI and MIME fields push it over.
- [ ] **Step 4: Run.** `npm test -- --test-name-pattern="canLinkFile|links"`.
      Expected: FAIL.
- [ ] **Step 5: Implement** the changes listed above.
- [ ] **Step 6: Run.** All these pass:
  - `npm test -- --test-name-pattern="read of a slice links nothing|create append over stdio"`
  - `npm test -- --test-name-pattern="canLinkFile|links"`
  - `npm test -- --test-name-pattern="outbound result limits"`
  - `npm test -- --test-name-pattern="resource_link"`
- [ ] **Step 7: Commit.**
      `fix(read): link only a file stdio's resources/read will serve`.
      Name the flipped `core-fs.test.ts` assertions in the body.

### Task 4: `create` append tells the link rule its kind, then the CHANGELOG

**Files:**

- Modify: `src/tools/create.ts:358-365`. Pass `{ kind }` as the new last
  argument of `writtenFileLinks`. After Task 3, an append with no kind is
  held to the text rule, so a binary file whose base64 is over the limit
  still gets a link.
- Modify: `CHANGELOG.md` `## [Unreleased]`, in the repo voice (a bold
  claim, then "Before, …"):
  - Under `### Fixed`: **`read` over stdio no longer offers a link that
    `resources/read` refuses.** Before, a slice of a text file just under
    the 10 MiB file size limit came back with a `resourceUri` and a
    `resource_link` that failed with `TOO_LARGE`.
  - Under `### Changed`: **Write tools over stdio link every file stdio can
    read back.** Before, `create` with `append` linked only text files under
    about 1.7 MB, and a binary file got no link in the last 64 KiB under the
    limit.
- Test: `__tests__/outbound-regressions.test.ts`

- [ ] **Step 1: Write a failing test.**
      `create append over stdio links no binary file base64 overflows`:
      append `'x'` to an 8 MiB file of zero bytes (`Buffer.alloc(8 * MIB)`),
      which sniffs as binary. Its raw size is under the limit and its
      base64 is over it. Assert no `resource_link` block in `content`.
- [ ] **Step 2: Run.** `npm test -- --test-name-pattern="create append over stdio"`.
      Expected: FAIL on the new test, with a `resource_link` present.
- [ ] **Step 3: Implement** the `create.ts` change and the CHANGELOG
      entries.
- [ ] **Step 4: Run.** `npm run check` passes. Then run
      `git diff --stat main -- __tests__/contract.test.ts.snapshot`; it must
      print nothing.
- [ ] **Step 5: Commit.**
      `fix(create): hold an appended binary file to the base64 link rule`
