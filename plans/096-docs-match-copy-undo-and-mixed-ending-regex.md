# Plan 096: The docs say what the code does about copy undo and regex in mixed-ending files

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- GLOSSARY.md docs/client-guide.md docs/adr/013-one-text-view-and-one-matching-engine.md AGENTS.md docs/superpowers`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live files before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

Four documents state things the code no longer does. Client authors read
`docs/client-guide.md` to parse `undoUnavailable`, and agents read
`GLOSSARY.md` and the ADRs before changing code, so a wrong sentence there
produces wrong clients and wrong changes. This plan corrects the sentences and
removes two finished implementation plans that an agent could pick up and
redo. It changes no source code.

## Current state

### 1. Copy undo

Docs say a copy costs the whole call its undo.

`GLOSSARY.md:127-129`, in the **Capture** entry:

```markdown
records nothing further, and the mutation still runs. Each path a call changes
has its own capture, so abandoning one costs only that path's undo; a copy
abandons the whole call. A path's capture reports only once that path has, or
```

`docs/client-guide.md:311-313`:

```markdown
paths joined by `; `, up to 20 of them. `<path>` is the file name, or the full
path when another path in the call has the same name. A move names its
destination. A copy reports one reason with no path, and has no id.
```

The code (`src/core/fs.ts:1378-1393`) gives each copy its own capture, keyed
on the destination:

```ts
  async #copy(source: string, destination: string): Promise<void> {
    const validSource = await this.#guard('probe', source);
    const validDest = await this.#guard('write', destination);
    // Its own capture: a copy that cannot be undone must not cost its siblings their undo.
    await this.#forMutation(validDest, async (own) => {
      // Before the copy: which destination entries are new and which it replaces.
      const targets = own.recording ? await planCopyUndo(own, this, validSource, validDest) : [];
```

`CHANGELOG.md` `[Unreleased]` records the one remaining limit: "a copy whose
files total more than eight times the undo budget (256 MiB by default) no
longer gets an undo id".

### 2. Regex in a mixed-ending file

`GLOSSARY.md`, **Text view** entry, says "a file with mixed endings is shown
as written". That is true of the view. The matching engine adds a rule the
glossary and ADR-013 do not record: before a **regex** sees a mixed-ending
text, each CRLF is shown to it as LF. `src/core/matcher.ts:549-558`:

```ts
// RE2's $ cannot see past a CR, so a regex sees a mixed-ending text's CRLFs as LF,
// as line mode drops a line's CR. `lfs` holds each such LF's offset in `seen`.
const lfs: number[] = [];
let seen = text;
if (flags.isRegex && text.includes('\r\n')) {
  for (let at = text.indexOf('\r\n'); at !== -1; at = text.indexOf('\r\n', at + 2)) {
    lfs.push(at - lfs.length);
  }
  seen = text.replaceAll('\r\n', '\n');
}
```

Only `CHANGELOG.md` records it ("In a mixed-ending file, a regex sees each
`\r\n` as `\n` too, so `$` matches before it; a lone `\r` stays visible").
Consequence a reader needs: in a mixed-ending file the regex `\r\n` matches
nothing, and a literal needle `a\nb` does not match `a\r\nb` while the regex
`a\nb` does.

The **Match plan** glossary entry ends with:

```markdown
and enforces output size limits on restored content. A match may span a line
break in both; a search reports it on the line where it starts.
_Avoid_: matcher selection, dispatch, engine choice, fast path
```

ADR-013 (`docs/adr/013-one-text-view-and-one-matching-engine.md`) has two
addenda; the last heading is
`## Addendum: \`accept\` keeps a typed U+FEFF (2026-11-10)`.

### 3. Agent instructions

`CLAUDE.md` has this line in its Commands block; `AGENTS.md` does not:

```text
npm run tdqs         # score tool definitions on tdqs.dev into tdqs-report.md; needs TDQS_API_KEY, spends 1 of 30 daily calls
```

`AGENTS.md:8-14`:

```bash
npm run check        # full repository check (static + tests)
npm run fix          # format and lint-fix, then run the full check
npm run check:static # static checks only, no tests
npm test             # Node test runner; pass native flags after --
npm run test:coverage # tests + src coverage floor (CI enforces it on ubuntu)
```

### 4. Finished plans still in the tree

The maintainer deletes finished implementation plans (commit `45057add`,
"docs: remove finished implementation plans", because "code searches and the
knowledge graph returned them ahead of the source"). These four files describe
work merged in PR #284 (commits `07afb662` and `e3122f57`):

- `docs/superpowers/plans/2026-11-11-delete-problem-errors.md`
- `docs/superpowers/plans/2026-11-11-diff-generation-counts.md`
- `docs/superpowers/specs/2026-11-11-delete-problem-errors-design.md`
- `docs/superpowers/specs/2026-11-11-diff-generation-counts-design.md`

Writing convention for these docs: plain sentences, no em dashes, wrap at 80
columns in `GLOSSARY.md` and the ADRs. All Markdown is Prettier-checked.

## Commands you will need

| Purpose      | Command                       | Expected on success |
| ------------ | ----------------------------- | ------------------- |
| Install      | `npm ci`                      | exit 0              |
| Format check | `npx prettier --check .`      | exit 0              |
| Format fix   | `npx prettier --write <file>` | file rewritten      |
| Full check   | `npm run check`               | exit 0              |

## Scope

**In scope** (the only files you should modify or delete):

- `GLOSSARY.md`
- `docs/client-guide.md`
- `docs/adr/013-one-text-view-and-one-matching-engine.md`
- `AGENTS.md`
- the four `docs/superpowers/` files listed above (delete)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- Any file under `src/` or `__tests__/`. In particular do not change the
  `replace_text` tool description in `src/tools/replace-text.ts`: it is in the
  contract snapshot and has a character budget.
- `CLAUDE.md`, `CLAUDE.local.md`.
- `docs/superpowers/specs/2026-11-03-readme-demo-gifs-design.md` and
  `docs/superpowers/specs/2026-11-09-tdqs-low-score-descriptions-design.md`:
  not verified as finished.
- The decision text of any ADR. Add an addendum; do not rewrite history.
- `CHANGELOG.md`: nothing user-visible changes.

## Git workflow

- Branch: `advisor/096-docs-match-copy-undo-and-mixed-ending-regex`
- Two commits. Message style from `git log`:
  `docs(glossary): say two items for one entry ask one question`. Use
  `docs: say a copy has its own capture and a regex sees mixed CRLF as LF` and
  `docs: remove finished implementation plans`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the two plans are finished

Run:

```bash
git log --oneline -3 -- src/tools/delete.ts src/core/diff.ts
grep -rn "diffStatsFromPatch" src
```

**Verify**: the log lists `07afb662` and `e3122f57`, and the grep prints
nothing. If either fails, skip Step 5 and report it.

### Step 2: Glossary and client guide, copy undo

In `GLOSSARY.md`, **Capture** entry, replace
`has its own capture, so abandoning one costs only that path's undo; a copy`
`abandons the whole call.` with text that reads (re-wrap to 80 columns):

```markdown
has its own capture, so abandoning one costs only that path's undo; a copy
has one capture for its destination, abandoned when the copy fails part-way
or its files total more than eight times the undo budget.
```

In `docs/client-guide.md`, replace the sentence
`A copy reports one reason with no path, and has no id.` with:

```markdown
A copy names its destination too, and can carry an id.
```

**Verify**: `grep -n "abandons the whole call" GLOSSARY.md` → no matches;
`grep -n "has no id" docs/client-guide.md` → no matches.

### Step 3: Glossary and ADR-013, regex in a mixed-ending file

In `GLOSSARY.md`, **Match plan** entry, insert before the `_Avoid_` line
(joined to the paragraph, re-wrapped):

```markdown
In a text with mixed endings a regex sees each CRLF as LF, so `$` matches
before it and `\r\n` matches nothing; a literal needle sees that text as
written.
```

At the end of `docs/adr/013-one-text-view-and-one-matching-engine.md`, append:

```markdown
## Addendum: a regex sees a mixed-ending text's CRLF as LF (2026-11-11)

The Decision says a file with mixed endings "is shown as written". That
holds for the Text view. The matching engine adds one rule on top: before a
regex judges a mixed-ending text, each CRLF is shown to it as LF, because
RE2's `$` cannot see past a CR, and a matched span and its groups get their
CRs back afterwards (`createMatchEngine` in
[`matcher.ts`](../../src/core/matcher.ts)). A lone CR stays visible. So in
such a file the regex `\r\n` matches nothing, and the regex `a\nb` matches
`a\r\nb` while the literal needle `a\nb` does not. This was recorded only in
`CHANGELOG.md` until now.
```

**Verify**: `grep -c "sees each CRLF as LF" GLOSSARY.md` → `1`;
`grep -c "^## Addendum" docs/adr/013-one-text-view-and-one-matching-engine.md` → `3`.

### Step 4: AGENTS.md

In `AGENTS.md`, add the `npm run tdqs` line (copied exactly from `CLAUDE.md`)
as the last line of the Commands code block, after the
`npm run test:coverage` line.

**Verify**: `grep -c "npm run tdqs" AGENTS.md` → `1`.

### Step 5: Delete the finished plans and their specs

```bash
git rm docs/superpowers/plans/2026-11-11-delete-problem-errors.md docs/superpowers/plans/2026-11-11-diff-generation-counts.md docs/superpowers/specs/2026-11-11-delete-problem-errors-design.md docs/superpowers/specs/2026-11-11-diff-generation-counts-design.md
```

**Verify**: `git ls-files docs/superpowers | grep 2026-11-11` → no output.
Then `grep -rn "2026-11-11-delete-problem-errors\|2026-11-11-diff-generation-counts" --include="*.md" . --exclude-dir=node_modules --exclude-dir=plans`
→ no output (no document links to a deleted file).

### Step 6: Format and full check

Run `npx prettier --write GLOSSARY.md docs/client-guide.md docs/adr/013-one-text-view-and-one-matching-engine.md AGENTS.md`.

**Verify**: `npm run check` → exit 0.

## Test plan

No tests: documentation only. `npm run check` covers Prettier and proves no
source moved.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -c "abandons the whole call" GLOSSARY.md` returns 0
- [ ] `grep -c "has no id" docs/client-guide.md` returns 0
- [ ] `grep -c "npm run tdqs" AGENTS.md` returns 1
- [ ] `git diff --stat ab54a253..HEAD -- src __tests__` prints nothing for this branch's commits
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A quoted sentence is not in the file as shown.
- Step 1's check fails (the plans may not be finished).
- Step 5's second grep finds a link to a deleted file. Report the linking
  file; do not edit files outside the scope list.
- `__tests__/undo.test.ts` contains a test asserting that a copy reports a
  reason with no path (`grep -n "copy" __tests__/undo.test.ts | grep -i "no path"`).
  The docs would then be right and the premise wrong.

## Maintenance notes

- Two related leads were left out because they were not verified: ADR-004
  still says "proposed" although its decision reads as a no-go, and
  `docs/superpowers/specs/2026-11-09-tdqs-low-score-descriptions-design.md`
  may be finished.
- `CLAUDE.md` lacks the Architecture section `AGENTS.md` has. Making one file
  the source and the other a pointer is a maintainer choice.
- If plan 097 lands, its refusal message is the natural place to point at the
  mixed-ending rule.
