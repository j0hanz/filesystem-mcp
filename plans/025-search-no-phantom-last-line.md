# Plan 025: `search_text` never reports a match on the phantom line after a trailing newline

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/search.ts __tests__/tools.test.ts`
> Plan 024 changes the `matches.push` object in the same loop; that is
> expected. The loop header and `lineCount` line quoted below must still match.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/024 (same loop; run after it)
- **Category**: bug
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

`content.split(/\r?\n/)` on a file that ends in a newline yields one extra
empty element. The code already computes `lineCount` to exclude it for
context windows, but the match loop still runs over `lines.length`. Any
pattern that can match an empty string — `^$`, `^\s*$`, `x*` — reports one
extra match on "line N+1" of every file ending in a newline, and an empty file
yields a match on line 1. Reproduced: `^$` on `alpha\nbeta\n` returns
`[{"line":3,"content":""}]`; `grep -c '^$'` on the same file prints 0.

## Current state

```ts
// src/core/search.ts:271-279
        const content = buffer.toString('utf-8');
        const lines = content.split(/\r?\n/u);
        // A trailing newline splits into a phantom empty last element; context
        // must not report it as a line the file has.
        const lineCount = content.endsWith('\n') ? lines.length - 1 : lines.length;
        let matchedFile = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line === undefined) continue;
```

Test conventions: `__tests__/tools.test.ts`, `TC-FUNC-072` (line 2113) calls
`search_text` with `{ path: dir, searchPattern }` and reads
`result._meta as { matches?: { line?: number; content?: string }[]; totalMatches?: number }`.

## Commands you will need

| Purpose        | Command                                                           | Expected on success |
| -------------- | ----------------------------------------------------------------- | ------------------- |
| Static check   | `npm run check:static`                                            | exit 0              |
| All tests      | `npm test`                                                        | all pass            |
| Filter by name | `npm test -- --test-name-pattern="phantom"`                       | passes              |
| Format         | `npx prettier --write src/core/search.ts __tests__/tools.test.ts` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/search.ts` — `lineCount` and the loop bound
- `__tests__/tools.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope**: `replace_text` (whole-string matching, no line split);
the context-window slices (already correct).

## Git workflow

- Branch: `advisor/025-search-no-phantom-last-line`.
- One commit: `fix(search_text): do not match the empty line after a trailing newline`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Regression test (it must fail now)

In `__tests__/tools.test.ts`, directly after `TC-FUNC-072`, add:

```ts
it('search_text: an empty-line pattern sees no phantom line after a trailing newline', async () => {
  const dir = join(tmpDir, 'phantom_line');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'trailing.txt'), 'alpha\nbeta\n');
  await writeFile(join(dir, 'blank.txt'), 'alpha\n\nbeta\n');
  await writeFile(join(dir, 'empty.txt'), '');

  const result = await harness.client.callTool({
    name: 'search_text',
    arguments: { path: dir, searchPattern: '^$', isRegex: true },
  });
  assert.notStrictEqual(result.isError, true);
  const structured = result._meta as {
    matches?: { file: string; line: number }[];
    totalMatches?: number;
  };
  assert.deepStrictEqual(
    structured.matches?.map((m) => `${m.file}:${String(m.line)}`),
    ['blank.txt:2'],
  );
  assert.strictEqual(structured.totalMatches, 1);
});
```

`mkdir`, `writeFile`, `join` are already imported.

**Verify**: `npm test -- --test-name-pattern="phantom"` → **fails** (three
matches reported: `trailing.txt:3`, `blank.txt:2`, `blank.txt:4`, and
`empty.txt:1`). If it passes, STOP.

### Step 2: Bound the loop by real lines

In `src/core/search.ts`, replace lines 273–277 with:

```ts
        // A trailing newline splits into a phantom empty last element, and an
        // empty file splits into one empty element: neither is a line the
        // file has, for matching or for context.
        const lineCount =
          content.length === 0 ? 0 : content.endsWith('\n') ? lines.length - 1 : lines.length;
        let matchedFile = false;
        for (let i = 0; i < lineCount; i++) {
```

Run `npx prettier --write src/core/search.ts __tests__/tools.test.ts`.

**Verify**: `npm test -- --test-name-pattern="phantom"` → passes.

### Step 3: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- New test: `^$` over a trailing-newline file (0 matches), a file with one
  blank line (1 match at line 2), and an empty file (0 matches).
- Existing: all `search_text` context tests, in particular
  `'search_text context: a match beats context on a shared line and stops at the last line'`.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "i < lineCount" src/core/search.ts` prints one line
- [ ] The new test exists and passes
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 025 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The regression test passes before Step 2.
- Any existing context test changes outcome after Step 2 (context slices
  already used `lineCount`; they should not move).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- `lineCount` is now the single definition of "lines the file has" for both
  matching and context. Keep it that way.
