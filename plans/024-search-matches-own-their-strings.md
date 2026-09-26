# Plan 024: Stored `search_text` matches no longer pin every matched file's full text in memory

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/search.ts`
> If the file changed, compare the "Current state" excerpt against the live
> code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none — but run **before** plan 025 (same function)
- **Category**: perf
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

`searchContent` reads each file, splits it into lines, and stores the matched
line (and up to 20 context lines) in the match list. V8 represents a substring
of a long string as a _sliced string_: a pointer into the parent plus offsets.
Keeping a 16-character line therefore keeps the whole file text alive.

The match list is what `paginate` snapshots for 60 seconds (up to 32
snapshots, `src/core/store.ts:240-241`), and the HTTP leg shares one store.
Measured: 200 short lines kept from 200 files of about 1 MB each held
**98.9 MB** of heap after GC; copying each kept line through a `Buffer` dropped
that to **0.4 MB**. With files up to 10 MiB and up to 10,000 matches per
search, one paginated search can hold hundreds of megabytes for a minute.

The fix is to copy each stored string once, at the point a match is recorded.
Only matches pay the copy.

## Current state

```ts
// src/core/search.ts:271-298
        const content = buffer.toString('utf-8');
        const lines = content.split(/\r?\n/u);
        // A trailing newline splits into a phantom empty last element; context
        // must not report it as a line the file has.
        const lineCount = content.endsWith('\n') ? lines.length - 1 : lines.length;
        let matchedFile = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line === undefined) continue;
          // One scan per line: findLineMatches resets lastIndex itself, so it
          // doubles as the "does this line match" test.
          const found = findLineMatches(regex, line);
          if (found) {
            matchedFile = true;
            matchingLines++;
            matches.push({
              file: entry.path,
              line: i + 1,
              column: found.column,
              content: line,
              matchCount: found.count,
              ...(context > 0
                ? {
                    before: lines.slice(Math.max(0, i - context), i),
                    after: lines.slice(i + 1, Math.min(lineCount, i + 1 + context)),
                  }
                : {}),
            });
```

## Commands you will need

| Purpose      | Command                                         | Expected on success |
| ------------ | ----------------------------------------------- | ------------------- |
| Static check | `npm run check:static`                          | exit 0              |
| All tests    | `npm test`                                      | all pass            |
| Search tests | `npm test -- --test-name-pattern="search_text"` | all pass            |
| Format       | `npx prettier --write src/core/search.ts`       | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/search.ts` — one helper and the `matches.push` call
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- The snapshot store's count/TTL bounds (`store.ts:228-233` documents them as
  deliberate).
- `search_text`'s output shape.
- Plan 025's loop-bound change (same lines; run it after this plan).

## Git workflow

- Branch: `advisor/024-search-matches-own-their-strings`.
- One commit: `perf(search): copy kept lines so a match does not retain the whole file`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Copy at the one place a line is kept

In `src/core/search.ts`, add near the top of the file (after the imports):

```ts
/**
 * A fresh, flat copy of `s`. V8 keeps a substring of a long string as a slice
 * that references its parent, so a kept line would otherwise pin the whole
 * file's text for as long as the match list lives (60 s in the page store).
 */
const own = (s: string): string => Buffer.from(s, 'utf8').toString('utf8');
```

Then change the `matches.push` call (lines 286–298) to:

```ts
matches.push({
  file: entry.path,
  line: i + 1,
  column: found.column,
  content: own(line),
  matchCount: found.count,
  ...(context > 0
    ? {
        before: lines.slice(Math.max(0, i - context), i).map(own),
        after: lines.slice(i + 1, Math.min(lineCount, i + 1 + context)).map(own),
      }
    : {}),
});
```

Run `npx prettier --write src/core/search.ts`.

**Verify**: `npm test -- --test-name-pattern="search_text"` → all pass.

### Step 2: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- No new test: string representation is not observable through the API, and
  a heap-size assertion is flaky across Node versions and GC timing. The
  comment on `own` carries the rationale.
- Existing: every `search_text` test (content, context, pagination) — output
  values are byte-identical after the copy.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -c "own(" src/core/search.ts` prints `3` or more (definition
      excluded: `content: own(line)`, two `.map(own)`)
- [ ] `git status` shows changes only in `src/core/search.ts` and
      `plans/README.md`
- [ ] `plans/README.md` status row for 024 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `matches.push` block no longer matches the excerpt (plan 025 may have
  landed first and changed the loop bound — that is fine; only the pushed
  object matters).
- Any `search_text` test fails after Step 1.

## Maintenance notes

- If `search_text` ever stores additional per-match strings (for example a
  whole-match capture), pass them through `own` too.
- The copy costs one allocation per kept line; at the 10,000-match cap with
  `context: 10` that is ≤ 210,000 small strings, well under a millisecond
  per thousand.
