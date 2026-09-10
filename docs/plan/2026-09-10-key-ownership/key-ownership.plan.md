# Plan: Own the round-trip and pagination key rules in one module each

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, step, and evidence.
>
> **Written against** commit `cb60e0dd`, 2026-09-10. Revised same day after
> plan-hunt: steps merged so no Verify ever sees an unused export (knip gates
> `check:static`), gates given exact expected outputs, import shapes shown
> prettier-wrapped.
> **Drift check (run first)**:
> `git diff --stat cb60e0dd..HEAD -- src/core/input-required.ts src/core/cursor.ts src/tools/delete-file.ts src/tools/move.ts src/tools/define.ts src/tools/list.ts src/tools/search-files.ts src/tools/search-content.ts`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> `git status` should be clean before starting. A mismatch is a [STOP](#stop).

## Goal

Two domain rules each live in one module instead of being re-written at every
call site. The destructive-confirmation key convention `confirm_${index into
the sorted pending set}` is hand-written at 6 literal sites across 3 files — a
format change at one site makes the reader at another return `undefined`,
which callers report as `CANCELLED` with no error, in the destructive tools.
The pagination cache-key rule (`JSON.stringify` of a flat object naming the
`method` plus the query's identifying fields) is hand-written at 3 tool sites
while [`cursor.ts`](../../../src/core/cursor.ts) treats the key as an opaque
string; two past keying changes (`79088052`, `1b18601c`) had to touch every
paginated tool together. This lands the single owner for each rule and
switches every site to it, byte-for-byte identical output.

Requirements covered: none, this is a refactor. No behavior change: produced
keys are identical to the literals they replace. No CHANGELOG entry.

## Current state

Confirmation-key rule, six literal sites across three files:

- [`src/core/input-required.ts`](../../../src/core/input-required.ts) — the
  half-owner. It mints and verifies the round-trip
  ([`pendingRoundTrip`](../../../src/core/input-required.ts#L259-L282)), builds
  the inputs ([`buildInputRequired`](../../../src/core/input-required.ts#L145-L192)),
  and reads acceptances ([`readAcceptedConfirm`](../../../src/core/input-required.ts#L299-L304),
  [`readAcceptedChoice`](../../../src/core/input-required.ts#L319-L324)) — but
  the key strings are constructed by callers on both sides. Exemplars of the
  JSDoc-on-every-export convention to match:
  [`buildInputRequired`](../../../src/core/input-required.ts#L140-L145) and
  [`readAcceptedConfirm`](../../../src/core/input-required.ts#L292-L299).
- [`src/tools/delete-file.ts:270`](../../../src/tools/delete-file.ts#L270) —
  read side:

  ```ts
  const key = `confirm_${pendingSorted.indexOf(plan.validPath)}`;
  ```

  and [`:337-347`](../../../src/tools/delete-file.ts#L337-L347) — build side:

  ```ts
  buildInputs: (ps) =>
    ps.map((p, i) =>
      choiceInput(
        `confirm_${i}`,
        `Permanently delete "${p}" and all its contents? This cannot be undone.`,
  ```

  Import line at [`:19`](../../../src/tools/delete-file.ts#L19):

  ```ts
  import { choiceInput, pendingRoundTrip, readAcceptedChoice } from '../core/input-required.js';
  ```

- [`src/tools/move.ts:176`](../../../src/tools/move.ts#L176) — read side:

  ```ts
  const key = `confirm_${pendingSorted.indexOf(plan.validDest)}`;
  ```

  and [`:312-324`](../../../src/tools/move.ts#L312-L324) — build side:

  ```ts
  buildInputs: (dests) =>
    dests.map((dest, i) =>
      choiceInput(
        `confirm_${i}`,
  ```

  Import line at [`:20`](../../../src/tools/move.ts#L20), same shape as
  delete-file's. `runTransfers` serves both `move` and `copy`, so these two
  sites cover both tools.
- [`src/tools/define.ts:317-320`](../../../src/tools/define.ts#L317-L320) —
  grant build side (single-dir case):

  ```ts
  : dirs.map((dir, i) => ({
      key: `confirm_${i}`,
      message: `Grant filesystem access to "${dir}"?`,
    })),
  ```

  [`:336`](../../../src/tools/define.ts#L336) — a comment naming the literal:

  ```ts
  // `confirm_${i}` for `grantDirs[i]`, so the isSamePath filter is a no-op
  ```

  and [`:340-341`](../../../src/tools/define.ts#L340-L341) — grant read side:

  ```ts
  : grantDirs.filter((_dir, i) =>
      readAcceptedConfirm(this.toolCtx.inputResponses, `confirm_${i}`),
    );
  ```

  Import block at [`:29-34`](../../../src/tools/define.ts#L29-L34) pulls
  `multiSelectInput, pendingRoundTrip, readAcceptedConfirm, readAcceptedMultiChoice`
  from `'../core/input-required.js'` — add `confirmKey` alphabetically first.

Pagination cache-key rule, three tool sites, owner opaque:

- [`src/core/cursor.ts:74-86`](../../../src/core/cursor.ts#L74-L86) —
  `paginate` takes `queryKey: string` and passes it through to
  `store.read(decoded.snapshotId, params.queryKey)` without ever parsing it.
  Exemplar of the export style to match:
  [`paginate`](../../../src/core/cursor.ts#L62-L81).
- [`src/tools/list.ts:243-251`](../../../src/tools/list.ts#L243-L251), called
  once at [`:281`](../../../src/tools/list.ts#L281):

  ```ts
  function listQueryKey(args: z.infer<typeof ListInputSchema>, path: string): string {
    return JSON.stringify({
      method: 'list',
      path,
      maxDepth: args.maxDepth,
      includeHidden: args.includeHidden,
      includeIgnored: args.includeIgnored,
    });
  }
  ```

- [`src/tools/search-files.ts:101-114`](../../../src/tools/search-files.ts#L101-L114),
  called once at [`:144`](../../../src/tools/search-files.ts#L144): same shape,
  `method: 'find_files'`, fields `pattern`, `includeIgnored`, `includeHidden`,
  `sortBy`, `maxDepth`.
- [`src/tools/search-content.ts:235-247`](../../../src/tools/search-content.ts#L235-L247),
  called once at [`:259`](../../../src/tools/search-content.ts#L259): same
  shape, `method: 'search_text'`, fields `pattern`, `searchPattern`,
  `isRegex`, `includeHidden`, `includeIgnored`, `caseSensitive`, `maxDepth`.
- All three tools already import `paginate` from `'../core/cursor.js'`
  ([`list.ts:7`](../../../src/tools/list.ts#L7),
  [`search-files.ts:4`](../../../src/tools/search-files.ts#L4),
  [`search-content.ts:7`](../../../src/tools/search-content.ts#L7)) — each
  gains `pageQueryKey` on the same line (it stays under print width).

Tooling facts the gates depend on:

- [`package.json:35`](../../../package.json#L35): `check:static` = build,
  type-check, type-check:test, eslint, `prettier --check .`, **knip**. Two
  consequences: (a) a new export with zero importers fails knip's
  default unused-export rule — the export and its importers must land in the
  same step; (b) prettier formatting is part of every gate — write the
  wrapped import shapes shown in the steps, or run `npm run fix` before the
  Verify.
- [`​.prettierrc`](../../../.prettierrc) pins `printWidth: 100`. A four-name
  import from `'../core/input-required.js'` measures 106 chars on one line —
  prettier requires it wrapped (shape shown in step 1). A two-name import from
  `'../core/cursor.js'` fits on one line (shape shown in step 2).
- Baseline grep counts, verified against `cb60e0dd`: `grep -rn 'confirm_' src`
  shows 7 hits (the 6 key sites + the define.ts:336 comment).
  `grep -rn 'JSON.stringify' src/tools` shows 5 hits — the three `*QueryKey`
  builders plus `define.ts:187` and `read.ts:329`, which are unrelated to keys
  (structured-content text rendering; continuation hint) and must survive.
  `grep -rEn 'function [a-zA-Z]*QueryKey' src/tools` shows 3 hits, the local
  builders.

## Commands

| Purpose    | Command            | Expected on success |
| ---------- | ------------------ | ------------------- |
| Static     | `npm run check:static` | exit 0, no errors |
| Full check | `npm run check`    | exit 0, all tests pass |

## Scope

**In scope** — the only files to modify:

- [`src/core/input-required.ts`](../../../src/core/input-required.ts)
- [`src/core/cursor.ts`](../../../src/core/cursor.ts)
- [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts)
- [`src/tools/move.ts`](../../../src/tools/move.ts)
- [`src/tools/define.ts`](../../../src/tools/define.ts)
- [`src/tools/list.ts`](../../../src/tools/list.ts)
- [`src/tools/search-files.ts`](../../../src/tools/search-files.ts)
- [`src/tools/search-content.ts`](../../../src/tools/search-content.ts)

**Files out of scope** — leave alone even though they look related:

- [`__tests__/input-required.test.ts`](../../../__tests__/input-required.test.ts) —
  builds `confirm_${idx}` literals as an *independent* check of the wire
  convention, the way a client would; keeping the literal there is the point.
- [`__tests__/page-store.test.ts`](../../../__tests__/page-store.test.ts) —
  tests the key's opacity contract with its own literal keys.
- [`src/core/page-store.ts`](../../../src/core/page-store.ts) — stores and
  validates the key as an opaque string; the rule moving into `cursor.ts`
  changes nothing for it.
- [`src/tools/batch.ts`](../../../src/tools/batch.ts) and every other file
  named by the 2026-09-10 architecture audit — the other ten findings are
  separate efforts; do not piggyback.

## Steps

Each step lands an export and every importer of it together, so knip never
sees an unused export and each Verify gates a complete, self-consistent tree.

### 1. Add `confirmKey` and switch all six sites

In [`src/core/input-required.ts`](../../../src/core/input-required.ts), place
this export immediately above the `readAcceptedConfirm` JSDoc block
([`:292`](../../../src/core/input-required.ts#L292)), matching the file's
JSDoc-on-every-export convention:

```ts
/**
 * Round-trip key for `pendingSorted[index]` — the single home of the
 * `confirm_${i}` convention. The build side mints it with the map index; the
 * read side re-derives it from the same sorted pending set the requestState
 * binds (R9), so a format change lands here once instead of at six call
 * sites.
 */
export function confirmKey(index: number): string {
  return `confirm_${index}`;
}
```

Then switch every site in the same step:

- [`delete-file.ts:19`](../../../src/tools/delete-file.ts#L19) — the four-name
  import exceeds `printWidth: 100`, so it must land wrapped exactly:

  ```ts
  import {
    choiceInput,
    confirmKey,
    pendingRoundTrip,
    readAcceptedChoice,
  } from '../core/input-required.js';
  ```

- [`delete-file.ts:270`](../../../src/tools/delete-file.ts#L270):

  ```ts
  const key = confirmKey(pendingSorted.indexOf(plan.validPath));
  ```

- [`delete-file.ts:340`](../../../src/tools/delete-file.ts#L340):
  `choiceInput(confirmKey(i), ...)`.
- [`move.ts:20`](../../../src/tools/move.ts#L20): same wrapped import shape
  as delete-file's.
- [`move.ts:176`](../../../src/tools/move.ts#L176):

  ```ts
  const key = confirmKey(pendingSorted.indexOf(plan.validDest));
  ```

- [`move.ts:315`](../../../src/tools/move.ts#L315): `choiceInput(confirmKey(i), ...)`.
- [`define.ts:29-34`](../../../src/tools/define.ts#L29-L34): add `confirmKey`
  first inside the existing multi-line import block (alphabetical order puts
  it ahead of `multiSelectInput`).
- [`define.ts:318`](../../../src/tools/define.ts#L318): `key: confirmKey(i),`.
- [`define.ts:336`](../../../src/tools/define.ts#L336): the comment names the
  literal — update it to match:
  ``// `confirmKey(i)` for `grantDirs[i]`, so the isSamePath filter is a no-op``.
- [`define.ts:341`](../../../src/tools/define.ts#L341):
  `readAcceptedConfirm(this.toolCtx.inputResponses, confirmKey(i))`.

**Verify**: `npm run check:static` → exit 0 (if only `prettier --check`
fails, run `npm run fix`, then re-run — that is the one permitted fix
iteration), and `grep -rn 'confirm_' src` → exactly one hit: the template
literal inside `src/core/input-required.ts`. Any other hit is a missed site,
or a STOP if it is not a key construction.

### 2. Add `pageQueryKey` and switch the three paginated tools

In [`src/core/cursor.ts`](../../../src/core/cursor.ts), place this export
immediately above the `paginate` JSDoc block
([`:62`](../../../src/core/cursor.ts#L62)), matching its export style:

```ts
/**
 * The single home of the pagination cache-key rule: `JSON.stringify` of a
 * flat object whose `method` names the tool and whose remaining fields
 * identify the query. The literal's field order fixes key stability;
 * `method` keeps tool key spaces disjoint. Byte-identical to the three
 * hand-written tool builders it replaces.
 */
export function pageQueryKey(
  query: { readonly method: string; readonly path: string } & Record<string, unknown>,
): string {
  return JSON.stringify(query);
}
```

Each tool has exactly one call site. In the same step, delete the local
`*QueryKey` function and inline the owned builder at its call site,
preserving the exact field lists and order from
[Current state](#current-state) — the field order is the key — and add
`pageQueryKey` to the `'../core/cursor.js'` import line, which stays under
print width:

```ts
import { paginate, pageQueryKey } from '../core/cursor.js';
```

- [`list.ts:281`](../../../src/tools/list.ts#L281), after deleting
  `listQueryKey` ([`:243-251`](../../../src/tools/list.ts#L243-L251)):

  ```ts
  const queryKey = pageQueryKey({
    method: 'list',
    path: resolvedPath,
    maxDepth: args.maxDepth,
    includeHidden: args.includeHidden,
    includeIgnored: args.includeIgnored,
  });
  ```

- [`search-files.ts:144`](../../../src/tools/search-files.ts#L144), after
  deleting `searchFilesQueryKey`
  ([`:101-114`](../../../src/tools/search-files.ts#L101-L114)): same shape,
  fields in this order — `method: 'find_files'`, `path: requestedBasePath`,
  `pattern: args.pattern`, `includeIgnored: args.includeIgnored`,
  `includeHidden: args.includeHidden`, `sortBy: args.sortBy`,
  `maxDepth: args.maxDepth`.
- [`search-content.ts:259`](../../../src/tools/search-content.ts#L259), after
  deleting `searchContentQueryKey`
  ([`:235-247`](../../../src/tools/search-content.ts#L235-L247)): same shape,
  fields in this order — `method: 'search_text'`, `path: requestedPath`,
  `pattern: args.pattern`, `searchPattern: args.searchPattern`,
  `isRegex: args.isRegex`, `includeHidden: args.includeHidden`,
  `includeIgnored: args.includeIgnored`, `caseSensitive: args.caseSensitive`,
  `maxDepth: args.maxDepth`.

**Verify**: `npm run check:static` → exit 0 (same one `npm run fix`
iteration permitted on a formatting-only failure), and
`grep -rEn 'function [a-zA-Z]*QueryKey' src/tools` → no output (zero hits),
and `grep -rn 'JSON.stringify' src/tools` → exactly two hits:
`define.ts` (structured-content text rendering, was line 187) and `read.ts`
(continuation hint, was line 329). Any other hit is a missed key site.

### 3. Full check

**Verify**: `npm run check` → exit 0, all tests pass. The confirmation
round-trip suites ([`__tests__/input-required.test.ts`](../../../__tests__/input-required.test.ts),
delete/move coverage in [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts))
and the pagination suites
([`__tests__/page-store.test.ts`](../../../__tests__/page-store.test.ts),
[`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts)) must pass
unmodified — they are the byte-identity proof.

## Done

Machine-checkable. All must hold:

- [ ] `npm run check:static` exits 0
- [ ] `npm run check` exits 0 with zero modified tests
- [ ] `grep -rn 'confirm_' src` shows exactly one hit, in `src/core/input-required.ts`
- [ ] `grep -rEn 'function [a-zA-Z]*QueryKey' src/tools` shows no output
- [ ] `grep -rn 'JSON.stringify' src/tools` shows exactly two hits (define.ts, read.ts)
- [ ] `git status` shows no files outside the in-scope list

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt.
- A step's verification fails twice after one fix attempt — a second failure
  means the step's assumption is wrong, not its implementation. (The one
  `npm run fix` iteration named in steps 1 and 2 does not count against this
  budget.)
- The fix appears to require an out-of-scope file.
- Any confirmation round-trip or pagination test fails after the switch — the
  replacement keys are byte-identical by construction, so a test failure means
  a key changed shape. Report which test and the key it expected; do not
  adjust the test to match a new key.
- A field list or field order in a local `*QueryKey` builder differs from the
  Current state excerpt — the order is the key, and a difference means the
  file drifted from `cb60e0dd` beyond what the drift check flagged.
- Knip reports the new export as unused after a step that adds its importers —
  that means an importer edit did not land, not that knip should be silenced.

## Notes

- For the reviewer: the whole change is behavior-neutral key plumbing; the
  only judgment calls are placement (both exports sit directly above the
  flow they serve, matching each file's JSDoc convention) and the decision to
  inline at the single call site rather than keep three one-caller wrapper
  functions — that deletion is the point of the move.
- Keys must remain byte-identical: a client can hold a live page cursor or an
  in-flight `input_required` round-trip across a server redeploy of this
  change. `PageSnapshotStore` is in-memory, so cross-process key drift cannot
  bite, but the HTTP leg serves a single long-lived process — same-binary
  upgrades are the case byte-identity preserves for free.
- Deliberately deferred: the other ten architecture-audit findings
  (OperationSummary, resource-notify trio, warn-once trio, glob abort
  predicate, test fixtures, list-splitter trio, progress-subject lambda,
  `fs.ts` re-exports, root-dedupe divergence, the gravity-well swap) — each is
  its own effort; none share a file dependency with this one that would
  justify bundling.
- Revision history: first draft had six steps adding each export before its
  importers; plan-hunt killed those gates (knip flags the intermediate
  unused-export state, and two greps had wrong expected counts). See
  [`key-ownership.plan-hunt.md`](key-ownership.plan-hunt.md).
- No rollback commands needed: pure code refactor, `git revert` of the
  landing commit restores the literals.
