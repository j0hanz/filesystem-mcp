# Plan 112: Seven documentation statements match what the server does

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- docs/client-guide.md docs/configuration.md CONTRIBUTING.md GLOSSARY.md docs/adr/002-legacy-protocol-paths-sunset.md docs/adr/004-agent-skills-extension.md docs/adr/005-one-scan-rule-for-every-walking-tool.md src/core/input-required.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live text before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

Each item below is a statement that is wrong today. Client authors and
contributors act on them: one tells a client that a declined `move` fails a
single pair when it cancels the whole call; one hides that over HTTP every
client shares one undo journal; one says an ADR change shipped that never
did. This plan changes words only. No behavior changes.

## Current state and the fix for each item

### 1. `docs/client-guide.md:469`: declining a `move`

Current text (lines 467-470):

```md
`{ action: 'accept', content: { <property>: <value> } }`, or with
`{ action: 'decline' }`. Declining fails that item with `CANCELLED`; for a
grant, the path then fails with `ACCESS_DENIED`. Accepting with `skip` is not
```

The code (`src/tools/move.ts:297-302`) throws on the first declined
destination, before any pair runs:

```ts
for (const { plan } of safe) {
  const verdict = confirmed.verdict(plan.destination);
  if (verdict !== 'proceed' && verdict !== 'skipped') {
    throw cancelled(op, plan, verdict);
  }
}
```

Replace the sentence `Declining fails that item with `CANCELLED`;` with:
`Declining fails that item with `CANCELLED`in`create`and`delete`; in `move` it cancels the whole call, and nothing is moved;`

### 2. `CONTRIBUTING.md:80`: the extra CI leg

Current: `... on Ubuntu, Windows and macOS, plus Ubuntu on Node 26, and all four are required.`

`.nvmrc` contains `26`, so the three default legs already run Node 26. The
extra leg is `node: '24'` (`.github/workflows/ci.yml:35-36`), the `engines`
floor. Replace `plus Ubuntu on Node 26` with
`plus Ubuntu on Node 24, the lowest supported version (the other legs use the `.nvmrc` pin)`.

### 3. Undo over HTTP is undocumented

`src/tools/undo.ts:124-131`:

```ts
// The HTTP journal is shared by every client of the endpoint, so "the last
// N calls" there are anyone's calls; only an undo id names your own.
if (ctx.transport === 'http' && (steps !== undefined || (id === undefined && !dryRun))) {
  throw new FsError(
    ErrorCode.INVALID_INPUT,
    'Over HTTP, pass the undo id from the tool result (or call undo with dryRun: true to list them).',
  );
}
```

In `docs/client-guide.md`, the HTTP bullet list (lines 137-146) has this
bullet:

```md
- The server is stateless per request, with no session ID. One server can
  serve many clients at once, and they share its allowed folders, including
  folders granted by any one of them.
```

Add a new bullet directly after it:

```md
- Clients also share one undo journal. `undo` therefore needs the undo `id`
  from the tool result; `steps` and a bare `undo` are refused with
  `INVALID_INPUT`. `undo` with `dryRun: true` lists every client's ids, and
  any client can revert another client's change.
```

In `docs/configuration.md`, the list that starts "The server enforces these
safety rules:" (line 310) has a bullet beginning "Without an API key, every
user and process on the machine can call it". Add directly after that bullet:

```md
- Every client of one HTTP server shares its undo journal: any client can
  list and revert another client's changes. Run one server per user when
  that matters.
```

### 4. `GLOSSARY.md`: "The session's record"

Current (Undo journal entry): `The session's record of undoable calls, newest last, and the one place an`

Replace `The session's record` with
`The record, per connection over stdio and per endpoint over HTTP,`.

### 5. `GLOSSARY.md`: Deletion and Creation contradict Confirmation

Confirmation says (correctly, matching `src/core/confirmation.ts:107-146`):
"an entry replaced while the prompt was open is asked about again, once. An
entry replaced after the approval, once writing has begun, is refused".

Deletion says: `directory requires Confirmation; an entry replaced while the prompt was open` /
`is refused, not deleted.`

Creation says: `of a file that would be replaced: an entry replaced while the prompt was` /
`open is refused, not overwritten, and one that appeared while it was open is` /
`refused too, not clobbered.`

Rewrite both so they defer to Confirmation:

- Deletion: `... requires Confirmation; an entry replaced while the prompt was open is asked about again, once (see Confirmation), and one replaced after the approval is refused, not deleted.`
- Creation: `... an entry replaced, or one that appeared, while the prompt was open is asked about again, once (see Confirmation); one replaced after the approval is refused, not overwritten.`

Re-wrap the paragraphs at the file's existing line width.

### 6. ADRs

- `docs/adr/005-one-scan-rule-for-every-walking-tool.md:68` says
  `` `maxDepth` is 0-based with a maximum of 100 everywhere; ``. `list` never
  changed: `src/tools/list.ts:268-272` is
  `PositiveInt.max(MAX_TREE_DEPTH)` ("1 = direct children") and
  `MAX_TREE_DEPTH = 50` (`src/core/util.ts:106`). Do not edit the Decision
  text. Append a section at the end of the file:

```md
## Amendment, 2026-11-14

`list` did not take the shared `maxDepth`. Its input is still 1-based
(`1` = direct children) with a maximum of 50, and `src/tools/list.ts`
converts it for the scan. The other walking tools are 0-based with a maximum
of 100 as decided. Changing `list` is a breaking input change and is not
scheduled.
```

- `docs/adr/002-legacy-protocol-paths-sunset.md:93-94` points at
  ``[`src/instructions.ts:67`](../../src/instructions.ts#L67)``; the
  `legacy_roots` line is now at line 65. Replace the link with plain text:
  `` `src/instructions.ts` (search for `legacy_roots`) ``.
- `docs/adr/004-agent-skills-extension.md:3` reads
  `**Status**: proposed, 2026-10-27`, while its Decision is a no-go with a
  revisit trigger. Change to `**Status**: accepted (no-go), 2026-10-27`.

### 7. `src/core/input-required.ts:115-116`: dead pointer in a comment

```ts
 * 32-byte key is generated at boot when the env var is unset or too short. A
 * per-process key is correct for stdio and the single-node HTTP leg (decision
 * record 11). A server restart invalidates in-flight tokens; the client
```

"decision record 11" refers to a deleted document; `docs/adr/011` is about
Deletion. Remove the parenthesis so the sentence reads
`... correct for stdio and the single-node HTTP leg. A server restart ...`
and re-wrap the comment. Comment only; no code change.

## Commands you will need

| Purpose    | Command                                                                            | Expected on success |
| :--------- | :--------------------------------------------------------------------------------- | :------------------ |
| Format     | `npx prettier --write docs CONTRIBUTING.md GLOSSARY.md src/core/input-required.ts` | exit 0              |
| Full check | `npm run check`                                                                    | exit 0              |

## Scope

**In scope**: the eight files named in the drift check, plus `plans/README.md`.

**Out of scope**:

- `README.md` (its tool table is checked by tests and stays as is).
- `mcpb/manifest.json`, `server.json` (contract-tested).
- Any code other than the one comment.
- `docs/adr/010-per-root-read-only.md` ("session-scoped" there is historical
  context; leave it).

## Git workflow

- Branch: `docs/match-shipped-behavior`
- One commit: `docs: match the client guide, glossary and ADRs to shipped behavior`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

Apply items 1 to 7 in order, one file at a time. After each file:

**Verify**: `npx prettier --check <that file>` → exit 0 (run the `--write`
command from the table first if it fails).

After all seven:

**Verify** (each must print at least one line):

```bash
grep -n "cancels the whole call" docs/client-guide.md
grep -n "Node 24, the lowest supported" CONTRIBUTING.md
grep -n "share one undo journal" docs/client-guide.md
grep -n "shares its undo journal" docs/configuration.md
grep -n "per endpoint over HTTP" GLOSSARY.md
grep -n "Amendment, 2026-11-14" docs/adr/005-one-scan-rule-for-every-walking-tool.md
grep -n "accepted (no-go)" docs/adr/004-agent-skills-extension.md
```

**Verify** (each must print nothing):

```bash
grep -n "decision record 11" -r src
grep -n "instructions.ts:67" docs/adr/002-legacy-protocol-paths-sunset.md
grep -n "plus Ubuntu on Node 26" CONTRIBUTING.md
```

**Verify**: `npm run check` → exit 0.

## Test plan

Documentation only; the greps above are the checks. `npm run check` proves
the comment edit compiles and everything is formatted.

## Done criteria

- [ ] All ten greps behave as stated
- [ ] `npm run check` exits 0
- [ ] `git diff --stat` lists only in-scope files; `src/core/input-required.ts` shows comment lines only
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any quoted "Current" text is not found verbatim.
- `src/tools/move.ts`, `src/tools/undo.ts` or `src/tools/list.ts` no longer
  behaves as the excerpts show (then the doc may be right and the plan wrong).

## Maintenance notes

- If `list` is ever moved to the shared 0-based `maxDepth`, delete the
  ADR-005 amendment in the same change.
- If the HTTP leg gets per-credential state (see the comment at
  `src/transport/http.ts:290-299`), the undo bullets need rewriting.
