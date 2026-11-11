# Plan 097: A capture group whose line endings cannot be placed is refused, not guessed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- src/core/matcher.ts __tests__/match-engine.test.ts CHANGELOG.md`
> Plan 093 is expected to have changed `src/core/matcher.ts` (a `declared`
> parameter on `expandDollarTokens`). Any other difference from the "Current
> state" excerpts is a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/093-named-group-that-took-no-part-expands-empty.md` (same function; land it first)
- **Category**: bug
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

In a file with mixed line endings (some CRLF, some bare LF), a regex is shown
each CRLF as LF, and the matched text and its capture groups get their CRs
back afterwards. The engine finds where a group sat by searching the match
for the group's text and taking the **first** place it occurs. When the same
text occurs earlier in the match with a different line ending, the group gets
the wrong one and `replace_text` writes it. Example: file `x\r\n\n`, regex
`x\n(\n)`, replacement `y$1`. The group is the bare LF, but the first `\n` in
the match is the CRLF, so the file becomes `y\r\n` where `y\n` is correct. The
dry run shows the same wrong bytes, so the preview does not catch it. The
regex engine (re2-wasm) reports no group offsets, so the position cannot be
recovered; the honest behavior is to refuse the replacement for that file.

## Current state

Files:

- `src/core/matcher.ts`: `createMatchEngine`: `matches` (a generator used by
  `search_text` and `replace_text`) and `replace`.
- `__tests__/match-engine.test.ts`: tests for both.

The match type (`src/core/matcher.ts:331-338`):

```ts
export interface TextMatch {
  /** UTF-16 offsets into the text given to `matches`. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly groups: (string | undefined)[];
  readonly named: Record<string, string> | undefined;
}
```

The mixed-ending branch inside `matches` (`src/core/matcher.ts:586-617`).
`seen` is the text with every CRLF shown as LF, `text` is the real text,
`match` is a match in `seen`, and `back(offset)` maps an offset in `seen` to
the offset in `text`:

```ts
            if (lfs.length === 0) {
              yield match;
              continue;
            }
            const start = back(match.start);
            const stop = back(match.end);
            const original = text.slice(start, stop);
            const crlfOnly = !/(?<!\r)\n/u.test(original);
            // A group is text from `seen`, so it gets back the CRs its span had in `text`.
            const restore = (group: string): string => {
              if (crlfOnly) return group.replaceAll('\n', '\r\n');
              // shortcut: a group repeated in its match maps to its first occurrence, whose CRs may differ.
              const at = match.text.indexOf(group);
              if (at === -1) return group;
              return text.slice(back(match.start + at), back(match.start + at + group.length));
            };
            yield {
              start,
              end: stop,
              text: original,
              groups: match.groups.map((group) =>
                group === undefined ? undefined : restore(group),
              ),
              named:
                match.named &&
                Object.fromEntries(
                  Object.entries(match.named).map(([name, value]) => [name, restore(value)]),
                ),
            };
```

The replace loop (`src/core/matcher.ts:680-696`):

```ts
        for await (const m of targetEngine.matches(view, {
          ...(signal ? { signal } : {}),
          ...(limits ? { path: limits.path } : {}),
        })) {
          if (matchCount === limits?.maxMatches) {
            more = true;
            break;
          }
          matchCount++;
          updated +=
            text.slice(cursor, m.start) +
            (expand
              ? expandDollarTokens(effectiveReplacement, m.text, m.groups, m.start, text, m.named)
              : effectiveReplacement);
```

(After plan 093 the `expandDollarTokens` call has a seventh argument,
`declared`. Keep it.)

The token pattern (`src/core/matcher.ts:384`):

```ts
const DOLLAR_TOKEN = /\$(\$|&|`|'|<([^>]*)>|\d{1,2})/g;
```

`search_text` does not read `groups` or `named` (verified:
`grep -n "\.groups\|\.named" src/core/search.ts src/tools/*.ts` shows no use),
so only `replace` can be harmed by a wrong group.

Error convention: `new FsError(code, message, path?, cause?, suggestion?)`
from `./errors.ts`; `FsError` and `ErrorCode` are already imported in
`matcher.ts`. `limits?.path` is the file path when the caller gave one.

An existing test that must keep passing
(`__tests__/match-engine.test.ts`, `'a group over a mixed-ending CRLF keeps its CR'`):

```ts
const text = 'foo\r\nbar\nfoo\r\n';
assert.equal(await rep('(?i)(o\\nb)', text, '[$1]', re), 'fo[o\r\nb]ar\nfoo\r\n');
assert.equal(await rep('(?i)(?P<x>o\\nb)', text, '[$<x>]', re), 'fo[o\r\nb]ar\nfoo\r\n');
// The match holds a CRLF and a bare LF: each group keeps exactly its own CRs.
assert.equal(await rep('(?i)(a\\nb)(\\nc)', 'a\r\nb\nc\n', '[$1|$2]', re), '[a\r\nb|\nc]\n');
```

`rep` and `re` are helpers defined near the top of that test file; read them
before writing tests.

Glossary terms: **Text view**, **Match plan**, **Rewrite**. Comment
convention for a known limit: `// shortcut: <the limit>, <when to upgrade>`.

## Commands you will need

| Purpose          | Command                                                           | Expected on success |
| ---------------- | ----------------------------------------------------------------- | ------------------- |
| Install          | `npm ci`                                                          | exit 0              |
| Build            | `npm run build`                                                   | exit 0              |
| Type-check tests | `npm run type-check:test`                                         | exit 0              |
| Lint             | `npm run lint`                                                    | exit 0, no warnings |
| Engine tests     | `node --test --test-timeout=60000 __tests__/match-engine.test.ts` | `# fail 0`          |
| Replace tests    | `node --test --test-timeout=60000 __tests__/replace-text.test.ts` | `# fail 0`          |
| Full check       | `npm run check`                                                   | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/matcher.ts`
- `__tests__/match-engine.test.ts`
- `CHANGELOG.md`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `src/core/search.ts`, `src/tools/search-text.ts`: a search must keep
  returning such matches. Do not throw from `matches`.
- `src/tools/replace-text.ts`: its description is in the contract snapshot.
- `src/core/text-view.ts`.
- Recovering true group offsets (a second regex pass, patching re2-wasm): a
  larger design; not this plan.

## Git workflow

- Branch: `advisor/097-mixed-ending-capture-refuses-instead-of-guessing`
- One commit: `fix(matcher): refuse a capture whose line endings cannot be placed`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Failing tests

In `__tests__/match-engine.test.ts`, directly after the test
`'a group over a mixed-ending CRLF keeps its CR'`, add a test named
`'a group whose text recurs in its match with another ending is refused'`:

```ts
// The group is the bare LF, but the first LF in the match is the CRLF.
await assert.rejects(rep('x\\n(\\n)', 'x\r\n\n', 'y$1', re), (error: unknown) =>
  /line ending/i.test((error as Error).message),
);
await assert.rejects(rep('x\\n(\\n)', 'x\n\r\n', '$1', re), (error: unknown) =>
  /line ending/i.test((error as Error).message),
);
// No group token in the replacement: nothing to place, so it proceeds.
assert.equal(await rep('x\\n(\\n)', 'x\r\n\n', 'y', re), 'y');
// The text recurs, but every occurrence has the same ending: not ambiguous.
assert.equal(await rep('a(\\n)(\\n)', 'a\n\nb\r\nc', '[$1$2]', re), '[\n\n]b\r\nc');
```

Adapt the call form to the real `rep` helper signature.

**Verify**: `node --test --test-timeout=60000 __tests__/match-engine.test.ts`
→ the new test FAILS at the first `assert.rejects` (the call resolves with
`'y\r\n'`).

### Step 2: Mark an ambiguous match

In `src/core/matcher.ts`:

1. Add to `TextMatch`:

```ts
  /** A group's text recurs in the match with different line endings, so its CRs are a guess. */
  readonly ambiguousGroups?: true;
```

2. In the mixed-ending branch, replace `restore` and the `yield` with:

```ts
            let ambiguous = false;
            // A group is text from `seen`, so it gets back the CRs its span had in `text`.
            // re2-wasm gives no group offsets, so the span is found by the group's text.
            const restore = (group: string): string => {
              if (crlfOnly) return group.replaceAll('\n', '\r\n');
              // No line break in the group: no CR was hidden inside it.
              if (!group.includes('\n')) return group;
              const spans = new Set<string>();
              for (
                let at = match.text.indexOf(group);
                at !== -1;
                at = match.text.indexOf(group, at + 1)
              ) {
                spans.add(
                  text.slice(back(match.start + at), back(match.start + at + group.length)),
                );
              }
              // The same text sits in the match with different endings: which one the group
              // held cannot be told. `replace` refuses to expand it.
              if (spans.size > 1) ambiguous = true;
              const [first] = spans;
              return first ?? group;
            };
            const groups = match.groups.map((group) =>
              group === undefined ? undefined : restore(group),
            );
            const named =
              match.named &&
              Object.fromEntries(
                Object.entries(match.named).map(([name, value]) => [name, restore(value)]),
              );
            yield {
              start,
              end: stop,
              text: original,
              groups,
              named,
              ...(ambiguous ? { ambiguousGroups: true as const } : {}),
            };
```

`groups` and `named` must be computed before the object literal so
`ambiguous` is settled when it is read.

**Verify**: `npm run build` → exit 0.

### Step 3: Refuse in `replace`

In the `replace` method, before the `for await` loop, add:

```ts
// `$1`, `$12` or `$<name>` in the replacement: it reads a capture group.
const readsGroups =
  expand &&
  Array.from(effectiveReplacement.matchAll(DOLLAR_TOKEN)).some((token) =>
    /^(?:\d|<)/.test(token[1] ?? ''),
  );
```

Inside the loop, directly after `matchCount++;`, add:

```ts
if (readsGroups && m.ambiguousGroups) {
  throw new FsError(
    ErrorCode.INVALID_INPUT,
    'A capture group holds a line break whose line ending cannot be told apart in this mixed-ending file.',
    limits?.path,
    undefined,
    'Nothing was written. Normalise the file to one line ending first, or write the line break in the replacement instead of capturing it.',
  );
}
```

**Verify**: `node --test --test-timeout=60000 __tests__/match-engine.test.ts`
→ `# fail 0`. Then
`node --test --test-timeout=60000 __tests__/replace-text.test.ts` → `# fail 0`.

### Step 4: Changelog and full check

In `CHANGELOG.md`, under `## [Unreleased]` → `### Fixed`, append:

```markdown
- **replace_text**: in a file with mixed line endings, a replacement that reads a capture group holding a line break is now refused when that group's line ending cannot be told (the same text sits in the match with both endings); before, the first ending in the match was written.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- One new test with four assertions in `__tests__/match-engine.test.ts`
  (Step 1): two refusals, one replacement with no group token, one recurrence
  with equal endings.
- The existing `'a group over a mixed-ending CRLF keeps its CR'` test must
  pass unchanged.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -c "ambiguousGroups" src/core/matcher.ts` returns at least 3
- [ ] `grep -n "maps to its first occurrence" src/core/matcher.ts` returns no matches (the old `shortcut:` comment is gone)
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 093 has not landed (`grep -c "declared" src/core/matcher.ts` returns 0).
- The mixed-ending branch does not match the excerpt apart from plan 093's
  change.
- The first `assert.rejects` in Step 1 passes before Step 2 (the bug does not
  reproduce).
- The existing `'a group over a mixed-ending CRLF keeps its CR'` test fails
  after Step 2. In its third assertion the group `\nc` contains text that does
  not recur, so it must not be marked ambiguous.
- `exactOptionalPropertyTypes` rejects the `ambiguousGroups` field in a place
  this plan did not name.
- The contract snapshot test fails.

## Maintenance notes

- This trades a silent wrong write for a refusal. If users hit the refusal, a
  real fix needs group offsets from the regex engine.
- `search_text` still receives the guessed group text, which it does not use.
  If a future search feature shows groups, it must check `ambiguousGroups`.
- Reviewer: check `DOLLAR_TOKEN` is used through `matchAll` (it is a global
  regex; `matchAll` clones it, so `lastIndex` is not shared).
