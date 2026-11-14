# Plan 107: `list` says which cap it hit and that its totals are exact

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/tools/list.ts src/core/fmt.ts src/core/scan.ts __tests__/list.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

`list` keeps at most 20,000 entries but keeps walking, so its totals stay
exact. When a tree holds more than 20,000 visible entries, the text the model
reads says:

`// scan stopped early: hit the server's 10000-result scan cap, not your maxResults. The total is a lower bound. Narrow path or pattern to see the rest.`

Three things are wrong for `list`: the cap is 20,000, not 10,000; `list` has
no `maxResults` argument; and the scan did not stop early, so the total is
exact, not a lower bound. The model is told to distrust a correct count.

## Current state

`src/tools/list.ts:118-119` passes `keep` to the scan and no `capReason`:

```ts
      // The walk runs on past the kept entries, so the totals stay exact.
      keep: MAX_LIST_ENTRIES,
```

`src/core/scan.ts:158` and `:404-406`:

```ts
const capReason = options.capReason ?? 'maxResults';
// ...
const stoppedReason: StoppedReason | undefined = cut
  ? 'timeout'
  : (capped ?? (keep !== undefined && scanned > keep ? capReason : undefined));
```

So `list` gets `stoppedReason: 'maxResults'`. `list` is the only caller that
passes `keep` (`grep -rn "keep:" src` → `src/tools/list.ts:119` only).

`src/core/fmt.ts:115-120` holds the text:

```ts
const STOP_REASON_TEXT: Record<StoppedReason, string> = {
  maxResults: `hit the server's ${String(MAX_SEARCH_RESULTS)}-result scan cap, not your maxResults. ${NARROW}`,
  timeout: `hit the time limit, or the request was cancelled. ${NARROW}`,
  // ...
```

`pageTrailer` (`src/core/fmt.ts:192`) prints it:
`if (p.stoppedReason !== undefined) lines.push(stoppedEarlyLine(p.stoppedReason));`
and then prints `p.notes` (finished `//` lines a tool adds).

`src/tools/list.ts` builds the trailer (around line 401-407):

```ts
      trailer: (metadata) => ({
        total: metadata.totalEntries,
        noun: 'entries',
        stoppedReason: metadata.stoppedReason,
        skippedInaccessible: metadata.skippedInaccessible,
        notes: listNotes(metadata),
      }),
```

and `listNotes` (around line 351):

```ts
const listNotes = (metadata: ListPageMetadata): string[] => [
  ...depthNote(args.maxDepth, metadata.unexpandedDirectories),
  ...ignoredNote(metadata.ignoredDirs),
];
```

`structuredContent.stoppedReason` is part of the advertised output schema.
This plan does NOT change it: `'maxResults'` stays in the structured half.
Only the text line changes.

Test pattern: `__tests__/list.test.ts`, "reports and externalizes a partial
tree when a scan times out" (line 110), which asserts on `result.text` and
`result.structured.stoppedReason`.

## Commands you will need

| Purpose       | Command                                                       | Expected on success          |
| :------------ | :------------------------------------------------------------ | :--------------------------- |
| One test file | `node --test --test-timeout=60000 __tests__/list.test.ts`     | all pass                     |
| Contract      | `node --test --test-timeout=60000 __tests__/contract.test.ts` | all pass, snapshot unchanged |
| Full check    | `npm run check`                                               | exit 0                       |

## Scope

**In scope**:

- `src/tools/list.ts`
- `__tests__/list.test.ts`
- `CHANGELOG.md`, `plans/README.md`

**Out of scope**:

- `src/core/scan.ts` and `src/core/fmt.ts`: `find_files` and `search_text`
  rely on the shared text. Do not add a new `StoppedReason` value; that would
  change the output schema and the contract snapshot.
- The tool `description` string (it already says "At most 20,000 entries are kept").

## Git workflow

- Branch: `fix/list-entry-cap-text`
- One commit: `fix(list): name the 20,000-entry cap and say the totals are exact`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing test

A real 20,001-entry tree is slow to create. Check how `MAX_LIST_ENTRIES` is
defined (`grep -n "MAX_LIST_ENTRIES" src/core/util.ts`). If it is a plain
constant, the test must create the tree: make 201 directories of 100 empty
files each with `Promise.all` in chunks (about 20,100 entries plus 201
directories) under a fresh folder in the test root. If creating it takes more
than 20 seconds on your machine, see STOP conditions.

Add to `__tests__/list.test.ts`:

- Call `list({ path: dir, maxDepth: 2, maxEntries: 5 })` with the helper the
  other tests in the file use.
- Assert `result.structured.stoppedReason === 'maxResults'` (unchanged).
- Assert `result.structured.totalEntries` equals the exact number created.
- Assert `result.text` does NOT match `/10000-result scan cap/` and does NOT
  match `/lower bound/`.
- Assert `result.text` matches `/kept the first 20000 of \d+ entries; the totals are exact/`.

**Verify**: `node --test --test-timeout=120000 --test-name-pattern="20000" __tests__/list.test.ts`
→ FAILS on the text assertions.

### Step 2: Print a list-specific line

In `src/tools/list.ts`:

1. Add a note helper beside `depthNote`/`ignoredNote`:

```ts
/** The kept-entries cap: the walk ran on, so the totals are exact and only the listing is cut. */
function keptNote(metadata: ListPageMetadata): string[] {
  return metadata.stoppedReason === 'maxResults'
    ? [
        `// kept the first ${String(MAX_LIST_ENTRIES)} of ${String(metadata.totalEntries)} entries; the totals are exact. Lower maxDepth or list a subfolder to see the rest.`,
      ]
    : [];
}
```

2. Add `...keptNote(metadata),` as the first element of `listNotes`.

3. In `trailer`, pass the stop reason only when it is not the kept cap:

```ts
        stoppedReason: metadata.stoppedReason === 'maxResults' ? undefined : metadata.stoppedReason,
```

Leave `listPageMetadata`, `externalize` and the structured output untouched.

**Verify**: `node --test --test-timeout=120000 __tests__/list.test.ts` → all pass.

### Step 3: Contract, changelog, full check

**Verify**: `node --test --test-timeout=60000 __tests__/contract.test.ts` →
passes with no snapshot change (`git status` shows the `.snapshot` unmodified).

Under `## [Unreleased]` → `### Fixed` in `CHANGELOG.md`:

```md
- **list**: a tree of more than 20,000 entries now says `kept the first 20000 of N entries; the totals are exact`; before, the text named a 10,000-result cap and a `maxResults` argument `list` does not have, and called the exact total a lower bound.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- One new test (Step 1). Pattern: the timeout test at `__tests__/list.test.ts:110`.
- The existing timeout test must still show `scan stopped early: hit the time limit`.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `git diff --stat` shows no change to `__tests__/contract.test.ts.snapshot`, `src/core/scan.ts`, `src/core/fmt.ts`
- [ ] `plans/README.md` status row updated

## STOP conditions

- `list` is no longer the only caller passing `keep`.
- Building the 20,001-entry fixture takes more than 20 seconds. Report the
  timing; the reviewer will decide between a slower test and a test-only
  override of the cap.
- The stored full tree (`externalize`) is expected by an existing test to
  carry different text.

## Maintenance notes

- If a second tool ever uses `keep`, move `keptNote` into `src/core/fmt.ts`
  and give the case its own `StoppedReason` (a contract change, so plan it).
