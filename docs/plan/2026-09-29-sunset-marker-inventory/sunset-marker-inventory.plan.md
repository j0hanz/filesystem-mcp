# Plan: Make the `sunset(SEP-2577)` grep enumerate every legacy-only site

> **Executor rules**: work the steps in order, from the repository root. Run
> every Verify command and confirm its expected result before moving on. On
> any [STOP](#stop) condition, stop and report the condition, the step, and
> the evidence. This plan authorizes implementation, not commits, pushes, or
> a release.
>
> **Written against** commit `38e8b88e`, 2026-09-29.
> **Drift check (run first)**:
> `git diff --stat 38e8b88e..HEAD -- src/server.ts src/transport/stdio.ts docs/adr/002-legacy-protocol-paths-sunset.md`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it
> flags. Also run `git status --short`: the commit-range check does not see
> uncommitted changes. A mismatch is a [STOP](#stop) condition.

## Goal

ADR-002 promises that `grep -rn "sunset(SEP-2577)" src` "enumerates exactly
what the removal touches". Today the grep returns three sites, but two more
branches exist only to serve a 2025-era connection and carry no marker: the
capability gate in `src/server.ts` and the `era === 'legacy'` hook wiring in
`src/transport/stdio.ts`. A sunset removal driven by the grep would ship with
a permanently-true `resources: { subscribe: !legacyHttp, ... }` left behind
in the repository's highest-churn source file. When this lands, the grep
returns five sites and the ADR's removal inventory names them all, plus the
`era` plumbing the removal also retires. Comments and one record only; no
runtime behaviour changes. Requirements covered: none, this is a record fix
(architecture audit of 2026-09-29, finding 1).

## Current state

### The record's claim

[`002-legacy-protocol-paths-sunset.md:55-56`](../../adr/002-legacy-protocol-paths-sunset.md#L55-L56):

```markdown
Each site carries the comment marker `sunset(SEP-2577)` so
`grep -rn "sunset(SEP-2577)" src` enumerates exactly what the removal touches.
```

[`002-legacy-protocol-paths-sunset.md:69-73`](../../adr/002-legacy-protocol-paths-sunset.md#L69-L73)
is the inventory bullet the amendment extends:

```markdown
- The removal will delete roughly 45 lines from `src/transport/stdio.ts`
  (`seedRootsFromClient` and its call site), roughly 110 lines from
  `src/resources.ts` (the subscribe/unsubscribe handlers and their registry),
  and roughly 4 lines from `src/tools/define.ts` (the fallback expression and
  its disable comment).
```

### What the grep returns today

`git grep -n "sunset(SEP-2577)" -- src` prints exactly these three lines:

```text
src/resources.ts:490:  // sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.
src/tools/define.ts:176:    // sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.
src/transport/stdio.ts:61: * sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.
```

The marker text is identical at all three sites. New markers must reuse it
verbatim:
`sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.`

### Unmarked site 1 — the capability gate

[`server.ts:78-91`](../../../src/server.ts#L78-L91), inside `createServer`:

```ts
  // `resources.subscribe` stays advertised on both eras: the verb itself is
  // 2025-only, but the SDK's listen router honors a `subscriptions/listen`
  // resource filter only while this bit is advertised (dist: `allow(
  // capabilities?.resources?.subscribe)` on `resourceSubscriptions`). The
  // strict-capability gate on outbound `notifications/resources/updated`
  // checks only that `resources` exists. The one exception is a
  // legacy instance on the HTTP leg (era 'legacy' with a notifier): it serves
  // one request, registers no subscribe handler (resources.ts, same
  // predicate) and sends no notification of any kind — there is no stream to
  // send it on — so neither `subscribe` nor `listChanged` is advertised.
  const legacyHttp = extraDeps?.era === 'legacy' && extraDeps.notifier !== undefined;
  const capabilities = {
    resources: { subscribe: !legacyHttp, listChanged: !legacyHttp },
  } satisfies ServerCapabilities;
```

The comment block ends at line 87; line 88 is the `const legacyHttp`
declaration. The same predicate is spelled a second time at
[`resources.ts:491`](../../../src/resources.ts#L491), and that copy is the
one that carries the marker (line 490 above it).

### Unmarked site 2 — the legacy hook wiring

[`stdio.ts:147-158`](../../../src/transport/stdio.ts#L147-L158), inside the
`factory` closure of `startServer`:

```ts
    if (era === 'legacy') {
      // Fires when the client's `notifications/initialized` lands. Safe to own:
      // the SDK's only touchpoint is its own initialized handler reading it.
      c.mcp.server.oninitialized = () => {
        void seedRootsFromClient(c);
      };
      // Re-list and grant anything new. Grants are session-additive (R8): a
      // root the client withdrew is not revoked mid-session.
      c.mcp.server.setNotificationHandler('notifications/roots/list_changed', () => {
        void seedRootsFromClient(c);
      });
    }
```

Line 146 immediately above is `    activeCtx = c;`. The marked site at
[`stdio.ts:61`](../../../src/transport/stdio.ts#L61) is the doc comment on
`seedRootsFromClient`, 86 lines earlier; the ADR counts "its call site" in
the removal estimate but the grep never lands on it.

### The `era` plumbing the removal also retires

Every line below exists only to carry the era discriminator to the five
sites. None is marked; the amendment lists them so the removal does not leave
an always-`'modern'` field threaded through six files.

| File                                                            | Lines                                                                                                  |
| :-------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| [`server.ts`](../../../src/server.ts)                           | [`63-64`](../../../src/server.ts#L63-L64) (option), [`181`](../../../src/server.ts#L181) (forward)     |
| [`resources.ts`](../../../src/resources.ts)                     | [`65-66`](../../../src/resources.ts#L65-L66) (deps field)                                              |
| [`tools/index.ts`](../../../src/tools/index.ts)                 | [`58`](../../../src/tools/index.ts#L58) (deps field), [`67`](../../../src/tools/index.ts#L67) (forward) |
| [`tools/define.ts`](../../../src/tools/define.ts)               | [`91`](../../../src/tools/define.ts#L91) (deps field), [`152`](../../../src/tools/define.ts#L152) (Pick) |
| [`transport/http.ts`](../../../src/transport/http.ts)           | [`312`](../../../src/transport/http.ts#L312) (factory arg), [`319`](../../../src/transport/http.ts#L319) (forward) |
| [`transport/stdio.ts`](../../../src/transport/stdio.ts)         | [`130`](../../../src/transport/stdio.ts#L130) (factory arg), [`135`](../../../src/transport/stdio.ts#L135) (forward) |

### Conventions to match

- **Marker placement**: a `//` line comment as the last line of the comment
  block directly above the gated statement, exactly as at
  [`resources.ts:490-491`](../../../src/resources.ts#L490-L491).
- **ADR amendment**: a dated bold lead-in bullet appended under
  `## Consequences`, as in ADR-001 at
  [`001-one-skipignored-flag-owns-both-exclusion-rules.md:55`](../../adr/001-one-skipignored-flag-owns-both-exclusion-rules.md#L55)
  (`- **Amended 2026-09-28:** ...`).
- **Prose width**: ADRs wrap at roughly 78 columns by hand; Prettier does not
  rewrap markdown prose but does check the file, so keep list indentation at
  two spaces.
- **Version fields**: never edit `package.json`, `server.json`, or
  `mcpb/manifest.json` (AGENTS.md); this plan touches none.

## Commands

| Purpose                 | Command                                                                              | Expected on success                                              |
| :---------------------- | :----------------------------------------------------------------------------------- | :--------------------------------------------------------------- |
| Marker inventory        | `git grep -n "sunset(SEP-2577)" -- src`                                              | one line per marked site (3 before, 5 after)                     |
| Lint the two source files | `npx eslint src/server.ts src/transport/stdio.ts --max-warnings=0`                 | exit 0, no output                                                |
| Format check            | `npx prettier --check docs/adr src/server.ts src/transport/stdio.ts`                 | `All matched files use Prettier code style!`, exit 0             |
| Full static gate        | `npm run check:static`                                                               | exit 0 (build, test typecheck, lint, prettier, knip all pass)    |

Both narrow commands were run at `38e8b88e` before any edit and exited 0.

## Scope

**In scope** — the only files to modify:

- [`src/server.ts`](../../../src/server.ts) — one comment line
- [`src/transport/stdio.ts`](../../../src/transport/stdio.ts) — one comment line
- [`docs/adr/002-legacy-protocol-paths-sunset.md`](../../adr/002-legacy-protocol-paths-sunset.md) — one amendment bullet

**Files out of scope** — leave alone even though they look related:

- [`src/resources.ts`](../../../src/resources.ts) — already marked at line
  490; the duplicated `legacyHttp` predicate stays duplicated (see Notes).
- [`src/tools/define.ts`](../../../src/tools/define.ts) — already marked at
  line 176.
- [`src/tools/index.ts`](../../../src/tools/index.ts),
  [`src/transport/http.ts`](../../../src/transport/http.ts) — carry `era`
  plumbing only; the ADR amendment inventories them, the marker does not go
  on plumbing.
- [`docs/adr/003-http-serves-2025-era-clients-statelessly.md`](../../adr/003-http-serves-2025-era-clients-statelessly.md)
  — names the `server.ts` gate but owns the HTTP posture, not the sunset
  inventory; a stale `'reject'` in its Context is historical narrative, not
  drift.
- [`README.md`](../../../README.md), [`src/instructions.ts`](../../../src/instructions.ts)
  — already listed in ADR-002's Consequences; unchanged by this plan.
- `__tests__/` — no test greps the marker; adding one would pin a comment.

## Steps

### 1. Mark the capability gate in `server.ts`

In [`server.ts`](../../../src/server.ts), insert one line between line 87
(`  // send it on — so neither \`subscribe\` nor \`listChanged\` is advertised.`)
and line 88 (`  const legacyHttp = ...`), indented two spaces to match the
block:

```ts
  // sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.
```

Change nothing else in the file.

**Verify**: `git grep -n "sunset(SEP-2577)" -- src` → 4 lines, one of them
`src/server.ts:88:  // sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.`

### 2. Mark the legacy hook wiring in `stdio.ts`

In [`stdio.ts`](../../../src/transport/stdio.ts), insert one line between
line 146 (`    activeCtx = c;`) and line 147 (`    if (era === 'legacy') {`),
indented four spaces to match the block:

```ts
    // sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.
```

Change nothing else in the file.

**Verify**: `git grep -n "sunset(SEP-2577)" -- src` → 5 lines, including
`src/transport/stdio.ts:61` (unchanged) and
`src/transport/stdio.ts:147:    // sunset(SEP-2577): removal trigger in docs/adr/002-legacy-protocol-paths-sunset.md.`

### 3. Lint and format the two source edits

**Verify**: `npx eslint src/server.ts src/transport/stdio.ts --max-warnings=0`
→ exit 0, no output; then
`npx prettier --check src/server.ts src/transport/stdio.ts` → exit 0.

### 4. Amend ADR-002's removal inventory

In [`002-legacy-protocol-paths-sunset.md`](../../adr/002-legacy-protocol-paths-sunset.md),
append one bullet at the end of `## Consequences` (after the bullet that
begins `- This record must be revisited`, currently lines 81-83). Target
shape — reproduce the facts, wording may be tightened:

```markdown
- **Amended 2026-09-29:** the marker grep returns five sites, not three. Two
  legacy-only branches landed without it: the capability gate in
  `src/server.ts` (`legacyHttp` and the `resources: { subscribe, listChanged }`
  pair it drives, roughly 7 lines) and the `era === 'legacy'` block in
  `src/transport/stdio.ts` that wires `oninitialized` and
  `notifications/roots/list_changed` to `seedRootsFromClient` (roughly 12
  lines). Both now carry the marker. The removal also retires the `era`
  discriminator that exists only to reach these sites: the `era?` option
  and its forward in `src/server.ts`, the `era` field on the registrar deps
  in `src/resources.ts`, `src/tools/index.ts` and `src/tools/define.ts`, and
  the `({ era })` factory argument and its forward in `src/transport/http.ts`
  and `src/transport/stdio.ts` (roughly 10 lines across six files). The
  `legacyHttp` predicate is deliberately spelled twice (`server.ts`,
  `resources.ts`) rather than passed through `deps`: adding a field to
  plumbing this record schedules for deletion would be a new seam in code
  meant to be temporary.
```

Do not edit the Decision section; its sentence about the grep becomes true
again once Steps 1-2 land.

**Verify**: `npx prettier --check docs/adr` → exit 0; and
`git grep -c "Amended 2026-09-29" -- docs/adr/002-legacy-protocol-paths-sunset.md`
→ `docs/adr/002-legacy-protocol-paths-sunset.md:1`.

### 5. Run the full static gate

**Verify**: `npm run check:static` → exit 0. Then `git status --short` →
exactly three modified paths (` M src/server.ts`,
` M src/transport/stdio.ts`,
` M docs/adr/002-legacy-protocol-paths-sunset.md`) plus this effort's
untracked `docs/plan/2026-09-29-sunset-marker-inventory/` directory.

## Done

Machine-checkable. All must hold:

- [ ] `git grep -n "sunset(SEP-2577)" -- src` prints exactly 5 lines:
      `src/resources.ts:490`, `src/server.ts:88`, `src/tools/define.ts:176`,
      `src/transport/stdio.ts:61`, `src/transport/stdio.ts:147`
- [ ] `git diff --stat 38e8b88e..HEAD -- src` (or `git diff --stat -- src`
      before commit) shows `+1` and `-0` for each of the two source files
- [ ] `npm run check:static` exits 0
- [ ] `git status --short` shows no modified tracked file outside the three
      in-scope paths
- [ ] `npm test` was **not** required: no behaviour changed, no test was added
      or touched (`git diff --stat -- __tests__` is empty)

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt — in particular if `server.ts:88` is no longer
  `const legacyHttp = ...` or `stdio.ts:147` is no longer
  `if (era === 'legacy') {`.
- `git grep -n "sunset(SEP-2577)" -- src` returns anything other than the
  three listed lines before Step 1 begins — someone else has moved the
  inventory and this plan's counts are wrong.
- A step's verification fails twice after one fix attempt.
- The fix appears to require an out-of-scope file — most likely a Prettier
  or ESLint complaint that points at a file this plan did not touch, which
  would mean the baseline was already red.
- The `legacyHttp` predicate in `server.ts` and `resources.ts` no longer
  read identically (`era === 'legacy' && notifier !== undefined`) — the ADR
  amendment's "deliberately spelled twice" sentence would then be false.

## Notes

- **Reviewer focus**: the marker string must be byte-identical to the three
  existing ones (the ADR's grep is the contract). Check that Step 1's line
  sits *inside* the existing comment block, not after the `const`.
- **Deliberately deferred**: collapsing the duplicated `legacyHttp` predicate
  by passing it through `deps`. Rejected in the audit because it adds a field
  to plumbing ADR-002 schedules for deletion; recorded in the amendment so it
  is not reopened.
- **Deliberately deferred**: ADR-003's Context still narrates the pre-change
  `legacy: 'reject'` state at its line 11. That is historical framing for a
  decision that then flipped it, not a claim about the present; leave it.
- **Rollback**: `git checkout -- src/server.ts src/transport/stdio.ts docs/adr/002-legacy-protocol-paths-sunset.md`.
