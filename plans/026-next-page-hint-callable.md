# Plan 026: The "Next page" trailer prints a call the model can send verbatim

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/fmt.ts src/tools/list.ts src/tools/find-files.ts src/tools/search-text.ts src/instructions.ts __tests__/tools.test.ts __tests__/resources.test.ts`
> Other plans add tests to `tools.test.ts`; the three trailer regexes quoted
> below must still be present.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

Every paged tool ends its text with a trailer such as
`// showing 1-50 of 400 matches. Next page: search_text {"cursor":"…"}`. A
cursor only replays under the **original arguments**: the snapshot key is
built from them (`list.ts:263-269`, `find-files.ts:112-120`,
`search-text.ts:277-288`) and a mismatch is rejected as an invalid cursor
(`store.ts:258`); `searchPattern` and `pattern` are also required by the
schemas. A model that follows the hint literally always fails: `list` answers
"Invalid cursor" once the first call had a `path`, and `search_text` answers a
schema error. The tests never notice because they always resend the original
arguments (`tools.test.ts:1377,2321`). Reproduced both failures.

After this plan the trailer prints the original arguments merged with the
cursor, so the printed call is the call to make.

## Current state

```ts
// src/core/fmt.ts:106-128
export function pageTrailer(p: {
  offset: number;
  shown: number;
  total: number;
  noun: string;
  tool: string;
  nextCursor?: string | undefined;
  stoppedReason?: string | undefined;
  skippedTooLarge?: number | undefined;
  skippedInaccessible?: number | undefined;
}): string {
  const lines: string[] = [];
  // Position is owed on every page of a split set, including the last one —
  // which has no cursor and would otherwise read as the whole answer.
  if (p.offset > 0 || p.total > p.shown) {
    const next =
      p.nextCursor === undefined
        ? ''
        : ` Next page: ${p.tool} ${JSON.stringify({ cursor: p.nextCursor })}`;
    lines.push(
      `// showing ${String(p.offset + 1)}-${String(p.offset + p.shown)} of ${String(p.total)} ${p.noun}.${next}`,
    );
  }
```

Call sites (each inside the tool's `run(args, ctx)`, where `args` is the
parsed input with defaults applied):

- `src/tools/list.ts:362-369` — `pageTrailer({ offset, shown: structured.entryCount, total: structured.totalEntries, noun: 'entries', tool: 'list', nextCursor: structured.nextCursor })`
- `src/tools/find-files.ts:193-202` — `tool: 'find_files'`, `nextCursor: structured.nextCursor`
- `src/tools/search-text.ts:373-383` — `tool: 'search_text'`, `nextCursor: structured.nextCursor`

Tests that pin the trailer text (`__tests__/tools.test.ts`):

```ts
// :1370
const match = /^\/\/ showing 1-2 of 4 entries\. Next page: list \{"cursor":"([^"]+)"\}$/m.exec(firstText);
// :2308
/^\/\/ showing 1-4 of 9 matches\. Next page: search_text \{"cursor":"/m,
// :2353
/^\/\/ showing 1-1 of 2 files\. Next page: find_files \{"cursor":"/m,
```

`src/instructions.ts:71` tells models:
`pagination: nextCursor appears in the result text and in _meta, backed by a snapshot on the same ~60s clock. Page through promptly; if a cursor is rejected, start again without one. resourceUri appears on the first page only.`
`__tests__/resources.test.ts:74` asserts that line starts with
`pagination: nextCursor appears in the result text and in _meta,` — keep that
prefix.

## Commands you will need

| Purpose       | Command                                                                                       | Expected on success |
| ------------- | --------------------------------------------------------------------------------------------- | ------------------- |
| Static check  | `npm run check:static`                                                                        | exit 0              |
| All tests     | `npm test`                                                                                    | all pass            |
| Trailer tests | `npm test -- --test-name-pattern="page trailer\|paginates entries"`                           | all pass            |
| Format        | `npx prettier --write src/core/fmt.ts src/tools/ src/instructions.ts __tests__/tools.test.ts` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/fmt.ts` — `pageTrailer`
- `src/tools/list.ts`, `src/tools/find-files.ts`, `src/tools/search-text.ts` —
  the `pageTrailer(...)` argument object
- `src/instructions.ts` — the `pagination:` line
- `__tests__/tools.test.ts` — the three regexes plus one assertion
- `plans/README.md` (status row)

**Out of scope**: the snapshot key rules and cursor encoding; `_meta.nextCursor`
(unchanged; clients that read the structured cursor are unaffected).

## Git workflow

- Branch: `advisor/026-next-page-hint-callable`.
- One commit: `fix(fmt): print the full next-page call, not a bare cursor`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Tighten the tests first (they must fail now)

In `__tests__/tools.test.ts`:

1. Line 1370: change the regex to
   `/^\/\/ showing 1-2 of 4 entries\. Next page: list (\{.*"cursor":"([^"]+)".*\})$/m` and
   the cursor read to `const cursor = match[2];`. Then, right after the
   `assert.strictEqual(cursor, …nextCursor)` line, add:

   ```ts
   // The printed call must be sendable as-is.
   const printed = JSON.parse(match[1] ?? '{}') as Record<string, unknown>;
   const literal = await harness.client.callTool({ name: 'list', arguments: printed });
   assert.notStrictEqual(literal.isError, true, 'the trailer must print a callable request');
   ```

2. Line 2308: change to
   `/^\/\/ showing 1-4 of 9 matches\. Next page: search_text \{.*"searchPattern":"NEEDLE".*"cursor":"/m`.
3. Line 2353: change to
   `/^\/\/ showing 1-1 of 2 files\. Next page: find_files \{.*"pattern":"\*\*\/\*".*"cursor":"/m`.

**Verify**: `npm test -- --test-name-pattern="paginates entries|page trailer"`
→ **fails** on all three. If any passes, STOP.

### Step 2: `pageTrailer` prints the merged call

In `src/core/fmt.ts`:

1. Add to the parameter type, after `nextCursor`:

   ```ts
   /** The call's own arguments; printed merged with the cursor so the hint is sendable as-is. */
   nextArgs?: Record<string, unknown> | undefined;
   ```

2. Replace the `next` computation with:

   ```ts
   const next =
     p.nextCursor === undefined
       ? ''
       : ` Next page: ${p.tool} ${JSON.stringify({ ...p.nextArgs, cursor: p.nextCursor })}`;
   ```

   (`JSON.stringify` drops `undefined` values, so optional args that were not
   given do not appear.)

### Step 3: Pass the arguments at the three call sites

Add `nextArgs: args,` to each `pageTrailer({ … })` object in
`src/tools/list.ts`, `src/tools/find-files.ts`, `src/tools/search-text.ts`.
`args` is the `run` parameter in all three; its type is a zod-inferred object,
assignable to `Record<string, unknown>`.

### Step 4: Instructions

In `src/instructions.ts:71`, change the sentence
`Page through promptly; if a cursor is rejected, start again without one.` to
`Send the printed Next page call as-is (the original arguments plus cursor); if a cursor is rejected, start again without one.`
Keep everything before `Page through` unchanged.

Run `npx prettier --write src/core/fmt.ts src/tools/list.ts src/tools/find-files.ts src/tools/search-text.ts src/instructions.ts __tests__/tools.test.ts`.

**Verify**: `npm test -- --test-name-pattern="paginates entries|page trailer"`
→ all pass; `node --test __tests__/resources.test.ts` → all pass (prefix
assertion intact).

### Step 5: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- Modified tests assert the trailer carries the original arguments and, for
  `list`, that the printed JSON can be sent back verbatim and succeeds.
- Existing: all pagination tests continue to pass the original arguments.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "nextArgs" src/core/fmt.ts src/tools/list.ts src/tools/find-files.ts src/tools/search-text.ts` prints 5 lines (type, use, three call sites)
- [ ] `grep -n "Send the printed Next page call" src/instructions.ts` prints one line
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 026 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any Step 1 test still passes before Step 2.
- `nextArgs: args` fails to type-check at a call site (report the error; do
  not cast with `as`).
- The `resources.test.ts` prefix assertion fails after Step 4.

## Maintenance notes

- The trailer now echoes user input (paths, patterns) into the text block.
  Paths are already in the response; no new information is exposed.
- If a tool ever gains an argument that must not be resent (a one-shot
  token), strip it from `nextArgs` at that call site.
