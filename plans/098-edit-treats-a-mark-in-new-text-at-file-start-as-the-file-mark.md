# Plan 098: `edit` treats a leading U+FEFF in `newText` placed at the start of a marked file as the file's mark

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- src/tools/edit.ts __tests__/edit.test.ts CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: MED (changes what one input writes; pinned tests sit next to it)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

A file can start with a byte-order mark (BOM, U+FEFF). The server hides it
from tools and puts it back on write. When a client's `edit` replaces text at
the very start of such a file and its `newText` itself begins with U+FEFF
(copied from the file), the server keeps that character as content **and**
restores the file's mark: the file ends up with two. The `patch` tool already
drops the typed mark in this position, so the two tools disagree on the same
intent. The project glossary says the tool that places the text decides: "only
the tool that places the text rules it the file's mark, where the text sits at
the start of the file".

## Current state

Files:

- `src/tools/edit.ts`: the `edit` tool; `applyEdits` matches `oldText` and
  splices `newText`.
- `src/core/text-view.ts`: the Text view (`accept`, `unmark`, `restore`).
- `__tests__/edit.test.ts`: tests.

The matching block (`src/tools/edit.ts:557-571`):

```ts
// A leading U+FEFF is matched as typed first. Only when that misses, and the
// stripped form matches at the start of the file, is it the copied file BOM.
const typed = view.accept(edit.oldText);
const bare = view.unmark(typed);
let oldText = typed;
let newText = view.accept(edit.newText);
let found = await findEditMatches(newContent, typed, ignoreWhitespace, tick, signal);
if (found.count === 0 && bare !== typed) {
  const stripped = await findEditMatches(newContent, bare, ignoreWhitespace, tick, signal);
  if (stripped.first?.startIndex === 0) {
    found = stripped;
    oldText = bare;
    newText = view.unmark(newText);
  }
}
```

`newText` is unmarked only on the fallback path, that is only when `oldText`
itself began with U+FEFF. With `oldText: 'foo'` and `newText: '﻿bar'` on
the file `﻿foo\n`, the typed `oldText` matches at index 0, the fallback
does not run, and the disk gets `﻿﻿bar\n`.

`found.first` has the shape `{ startIndex: number; length: number }`
(`src/tools/edit.ts:408-409`).

`view.unmark` (`src/core/text-view.ts`):

```ts
    unmark(text) {
      return bom && text.startsWith(BOM) ? text.slice(1) : text;
    },
```

It is a no-op when the file has no mark, so a client can still add a mark to
an unmarked file.

Pinned behavior that must NOT change (`__tests__/edit.test.ts`,
`'a U+FEFF inside a BOM file matches as typed, and newText keeps its own'`):

```ts
const kept = await edit({ path: file, edits: [{ oldText: 'done', newText: '﻿done' }] });
assert.notStrictEqual(kept.isError, true);
assert.strictEqual(await readFile(file, 'utf-8'), '﻿first\n﻿done\n');
```

There `done` is on line 2 (not index 0), so the typed U+FEFF is content and
stays.

Glossary (**Text view**): "Text a client typed keeps a leading U+FEFF as
content; only the tool that places the text rules it the file's mark, where
the text sits at the start of the file."

## Commands you will need

| Purpose          | Command                                                   | Expected on success |
| ---------------- | --------------------------------------------------------- | ------------------- |
| Install          | `npm ci`                                                  | exit 0              |
| Type-check tests | `npm run type-check:test`                                 | exit 0              |
| Lint             | `npm run lint`                                            | exit 0, no warnings |
| Edit tests       | `node --test --test-timeout=60000 __tests__/edit.test.ts` | `# fail 0`          |
| Full check       | `npm run check`                                           | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/tools/edit.ts`
- `__tests__/edit.test.ts`
- `CHANGELOG.md`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `src/core/text-view.ts` and `src/tools/patch.ts`.
- The ambiguity rule: `oldText: '﻿foo'` on a file where the bare `foo`
  matches twice is refused as ambiguous. That was considered and left as is
  (the bare text does match twice).
- The `edit` tool description and schema.

## Git workflow

- Branch: `advisor/098-edit-file-mark-in-new-text`
- One commit: `fix(edit): read a U+FEFF leading newText at the file start as the file's mark`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Failing test

In `__tests__/edit.test.ts`, directly after the test
`'a U+FEFF inside a BOM file matches as typed, and newText keeps its own'`,
add:

```ts
it('newText placed at the start of a BOM file gives up its own leading mark', async () => {
  const file = await writeTestFile(root, 'bom/start-new.txt', '﻿foo\n');
  const result = await edit({ path: file, edits: [{ oldText: 'foo', newText: '﻿bar' }] });
  assert.notStrictEqual(result.isError, true);
  assert.strictEqual(await readFile(file, 'utf-8'), '﻿bar\n');
});
```

**Verify**: `node --test --test-timeout=60000 __tests__/edit.test.ts` → the
new test FAILS (actual `'﻿﻿bar\n'`).

### Step 2: Unmark `newText` wherever the match starts at index 0

In `src/tools/edit.ts`, change the block shown in "Current state" to:

```ts
// A leading U+FEFF is matched as typed first. Only when that misses, and the
// stripped form matches at the start of the file, is it the copied file BOM.
const typed = view.accept(edit.oldText);
const bare = view.unmark(typed);
let oldText = typed;
let newText = view.accept(edit.newText);
let found = await findEditMatches(newContent, typed, ignoreWhitespace, tick, signal);
if (found.count === 0 && bare !== typed) {
  const stripped = await findEditMatches(newContent, bare, ignoreWhitespace, tick, signal);
  if (stripped.first?.startIndex === 0) {
    found = stripped;
    oldText = bare;
  }
}
// Text placed at the start of a marked file: a leading U+FEFF in it is the
// file's mark, which the write restores, not a second one (GLOSSARY, Text view).
if (found.first?.startIndex === 0) newText = view.unmark(newText);
```

The only changes: the `newText = view.unmark(newText);` line moves out of the
fallback, and the new `if` follows the block.

**Verify**: `node --test --test-timeout=60000 __tests__/edit.test.ts` →
`# fail 0`, including these existing tests:
`'a U+FEFF inside a BOM file matches as typed, and newText keeps its own'`,
`'a marked all-CRLF file matches oldText typed with the mark and CRLF'`,
`'a BOM-led oldText that matches only deeper in a BOM file is unmatched'`.

### Step 3: Changelog and full check

In `CHANGELOG.md`, under `## [Unreleased]` → `### Fixed`, append:

```markdown
- **edit**: `newText` that begins with U+FEFF and replaces text at the very start of a file with a byte-order mark no longer leaves two marks in the file; `patch` already behaved this way.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- One new test in `__tests__/edit.test.ts` (Step 1), modeled on the BOM tests
  around it.
- The three existing BOM tests named in Step 2 are the regression guards.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -c "view.unmark(newText)" src/tools/edit.ts` returns 1
- [ ] `grep -n "gives up its own leading mark" __tests__/edit.test.ts` returns 1 match
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The block at `src/tools/edit.ts:557-571` does not match the excerpt.
- The new test passes before Step 2.
- Any existing BOM test fails after Step 2. Do not edit an existing test to
  make it pass; report which one and its actual output.
- A multi-edit call is affected: `newContent` is the running content across
  edits, and index 0 means the start of the file for every edit. If the code
  shows otherwise, stop.

## Maintenance notes

- On a file with no mark, `unmark` is a no-op: a client can still add a BOM by
  writing U+FEFF at the start. That is unchanged.
- ADR-013's second addendum describes when `edit` calls `unmark`; after this
  change it calls it whenever the edit lands at index 0. A one-line ADR
  addendum is a reasonable follow-up for the maintainer.
- Reviewer: check the dry-run diff shows one mark, not two.
