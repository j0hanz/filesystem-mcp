# Plan 039: Eight comments describe code that exists, and the three ADRs point at the lines they mean

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: this plan is meant to run **last** of the
> 018–040 set, because every other plan shifts line numbers that the ADR
> anchors must point at. Run
> `git log --oneline 8c2a82cd..HEAD -- src docs/adr` and expect several
> commits; every anchor below is recomputed by grep at execution time, not
> copied from this file.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (comments and docs only)
- **Depends on**: every other plan in this batch (run last)
- **Category**: tech-debt / docs
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

Comments that cite symbols or SDK behavior that no longer exist send the
next reader hunting for ghosts. One of them (`server.ts`) gives a **false
reason** for a capability decision; anyone "simplifying" from it would break
modern subscriptions. ADR-002 is the dated removal checklist for the
legacy protocol paths; its line anchors have drifted, so an executor
following it would delete the wrong lines.

## Current state

Each site below was re-read at `8c2a82cd`. Line numbers will have moved by
the time this runs; locate each by the quoted text.

### A. `src/server.ts` (lines 78–84 at `8c2a82cd`)

```ts
// `resources.subscribe` stays advertised on both eras: the verb itself is
// 2025-only, but with enforceStrictCapabilities the SDK also gates outbound
// `notifications/resources/updated` — which the modern `subscriptions/listen`
// stream delivers — on this same capability bit. The one exception is a
```

**Wrong mechanism.** The strict-capability gate on outbound
`notifications/resources/updated` checks only that `_capabilities.resources`
exists (`node_modules/@modelcontextprotocol/server/dist/mcp-*.mjs`, the line
reading `if (!this._capabilities.resources) throw new SdkError(SdkErrorCode.CapabilityNotSupported, …notifying about resources…`).
The **real** reason to keep `subscribe: true` on the modern era is the listen
router: it honors a resource filter only when the bit is advertised — same
file, the line
`if (requested.resourceSubscriptions !== void 0 && … && allow(capabilities?.resources?.subscribe)) honored.resourceSubscriptions = …`.
The conclusion (keep it advertised) is right; the stated reason is not.

### B. `src/core/errors.ts` (lines 173–178)

```ts
// No `ZodError` branch, deliberately. Tool arguments are validated by
// `safeParse` inside the SDK's validator seam (tools/define.ts), which never
// throws — it hands back `z.prettifyError`'s string — and nothing in `src/`
// calls `.parse()`. …
```

`define.ts` no longer has a validator seam; it hands the zod schema to the
SDK (`grep -n "safeParse\|prettifyError" src/tools/define.ts` prints
nothing at `8c2a82cd`). The SDK validates and formats issues itself. The
conclusion (no ZodError branch needed) still holds.

### C. `src/core/schema.ts` (lines 10–12)

```ts
// No `id` on this or any other shared schema below: an `id` hoists the schema
// into `$defs` and leaves a `$ref` at every use site, which is exactly the wire
// weight `toDraft202012` (tools/define.ts) publishes without.
```

`toDraft202012` exists nowhere (`grep -rn toDraft202012 src` → only this
comment).

### D. `src/tools/list.ts` (lines 340–343)

```ts
// Not published: every field is a plainly-named scalar (`entryCount`,
// `totalFiles`, `nextCursor`) that one sample response teaches, and the
// schema costs 1599 chars of every session start. Publishing is reserved for
// the value-XOR-error union shape a sample cannot convey.
```

`define.ts:425` says "No `outputSchema`, ever." — no tool publishes one, so
there is no per-tool choice to explain.

### E. `src/transport/stdio.ts` (line 103)

```ts
 * Serve filesystem-mcp over stdio using modern protocol revision 2026-07-28.
```

The factory also serves the 2025 era on stdio (`legacy: 'serve'`, ADR-002).

### F. `src/core/sensitive.ts` (lines 4–6)

```ts
// shares only isAlpha / toPosixPath / IS_WINDOWS with the primitives in
// primitives.ts, not the allowed-directory assembly. path-completer.ts and
// glob.ts reach it through PathGuard.isSensitive, which delegates here.
```

The primitives live in `path-utils.ts`; `glob.ts` does not call
`isSensitive` (`grep -n isSensitive src/core/glob.ts` → nothing; callers are
`path.ts` and `path-completer.ts`).

### G. `src/core/config.ts` (line 32–33)

```ts
/** `--deny` entries (merged with DENYLIST by the reader) */
```

The env var is `FS_DENYLIST` (commit `82bda9ea` fixed the other unprefixed
names and missed this one).

### H. `Dockerfile` (line 7)

```dockerfile
# --ignore-scripts avoids triggering `prepare` (build) before source is copied
```

`package.json` has no `prepare` script.

### I. ADR anchors (`docs/adr/*.md`)

The three ADRs cite `file:line` anchors as markdown links of the form
`[`glob.ts:202`](../../src/core/glob.ts#L202)`. Symbols to re-anchor (the
executor greps each and writes the current line):

| ADR | Cited                            | Locate by                                                                      |
| --- | -------------------------------- | ------------------------------------------------------------------------------ |
| 001 | `schema.ts:193`                  | `grep -n "IncludeIgnored" src/core/schema.ts` (the `export const`)             |
| 001 | `glob.ts:202`                    | `grep -n "skipIgnored" src/core/glob.ts` (the option declaration)              |
| 001 | `glob.ts:308`                    | `grep -n "DEFAULT_EXCLUDED_NAMES" src/core/glob.ts` (the definition)           |
| 001 | `glob.ts:417`                    | `grep -n "GitignoreManager.load(options.cwd" src/core/glob.ts`                 |
| 001 | `glob.ts:348-352`, `glob.ts:404` | `grep -n "createWalkFilter" src/core/glob.ts` — see note                       |
| 002 | `stdio.ts:63`                    | `grep -n "seedRootsFromClient" src/transport/stdio.ts` (definition)            |
| 002 | `resources.ts:452-559`           | `grep -n "sunset(SEP-2577)" src/resources.ts` (first and last hit)             |
| 002 | `define.ts:159-162`              | `grep -n "getClientCapabilities" src/tools/define.ts`                          |
| 002 | `README.md:294`                  | `grep -n "Legacy MCP connections may additionally seed roots" README.md`       |
| 002 | `instructions.ts:67`             | `grep -n "legacy_roots" src/instructions.ts`                                   |
| 003 | `http.ts:312` (cited twice)      | `grep -n "legacy: 'stateless'" src/transport/http.ts`                          |
| 003 | "per session/IP" (line 124)      | `grep -n "req.ip" src/transport/http-policy.ts` — the limiter keys per IP only |

ADR-001 note: its "second cost" paragraph (lines 62–73) describes an
array-vs-predicate divergence in `createExcludeFilter` that no longer exists —
`createWalkFilter` always returns a predicate (the ADR's own 2026-09-26
amendment says so). Do **not** delete the paragraph (ADRs are a record);
prefix it with `**Resolved 2026-09-26:**` and point at `createWalkFilter`.

## Commands you will need

| Purpose      | Command                                        | Expected on success |
| ------------ | ---------------------------------------------- | ------------------- |
| Static check | `npm run check:static`                         | exit 0              |
| Anchor check | see Step 3                                     | every link resolves |
| Format       | `npx prettier --write src docs/adr Dockerfile` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/server.ts`, `src/core/errors.ts`, `src/core/schema.ts`,
  `src/tools/list.ts`, `src/transport/stdio.ts`, `src/core/sensitive.ts`,
  `src/core/config.ts`, `Dockerfile` — **comments only**
- `docs/adr/001-*.md`, `docs/adr/002-*.md`, `docs/adr/003-*.md`
- `plans/README.md` (status row)

**Out of scope**: any code change; any ADR **decision** text; `README.md`
body (plan 038).

## Git workflow

- Branch: `advisor/039-stale-comments-and-adr-anchors`.
- Two commits: `docs(src): correct eight comments that cite removed symbols or the wrong SDK gate`
  and `docs(adr): re-anchor ADR-001..003 to current lines`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Comments

Replace the quoted text at each site:

- **A** `server.ts`: replace the four quoted lines with

  ```ts
  // `resources.subscribe` stays advertised on both eras: the verb itself is
  // 2025-only, but the SDK's listen router honors a `subscriptions/listen`
  // resource filter only while this bit is advertised (dist: `allow(
  // capabilities?.resources?.subscribe)` on `resourceSubscriptions`). The
  // strict-capability gate on outbound `notifications/resources/updated`
  // checks only that `resources` exists. The one exception is a
  ```

  (keep the rest of the paragraph about the legacy HTTP instance.)

- **B** `errors.ts`: replace the quoted lines with

  ```ts
  // No `ZodError` branch, deliberately. Tool arguments are validated by the
  // SDK from the zod schema `defineTool` hands it (tools/define.ts); the SDK
  // formats issues itself and never throws a ZodError into a handler, and
  // nothing in `src/` calls `.parse()`. …
  ```

- **C** `schema.ts`: replace `` which is exactly the wire weight `toDraft202012` (tools/define.ts) publishes without.``
  with ` which is exactly the wire weight the published JSON schema (tools/define.ts) leaves out.`
- **D** `list.ts`: replace the four quoted lines with
  `// No outputSchema, like every tool here (define.ts): one sample response teaches these scalar fields, and the schema would cost ~1.6 KB of every session start.`
- **E** `stdio.ts`: `Serve filesystem-mcp over stdio using modern protocol revision 2026-07-28.`
  → `Serve filesystem-mcp over stdio: the 2026-07-28 revision, plus the 2025 era for legacy clients (ADR-002).`
- **F** `sensitive.ts`: `primitives.ts` → `path-utils.ts`; `path-completer.ts and glob.ts reach it` → `path.ts and path-completer.ts reach it`.
- **G** `config.ts`: `merged with DENYLIST` → `merged with FS_DENYLIST`.
- **H** `Dockerfile`: replace the line with
  `# --ignore-scripts: no lifecycle script here needs to run, and none should while node_modules is untrusted input`.

**Verify**: `grep -rn "toDraft202012\|primitives.ts\|with DENYLIST\|triggering \`prepare\`" src Dockerfile`→ nothing;`npm run check:static` → exit 0.

### Step 2: ADR anchors

For each row of the table in section I: run the grep, take the current line
number(s), and edit the markdown link text **and** the `#L…` fragment to
match. For ranges, use the first and last line of the construct. Apply the
ADR-001 "Resolved" prefix and the ADR-003 "per session/IP" → "per IP" change.

### Step 3: Anchor check

Run, from the repo root:

```bash
grep -oE '\]\(\.\./\.\./[^)#]+#L[0-9]+' docs/adr/*.md | sed 's/](\.\.\/\.\.\///; s/#L/ /' | while read -r f l; do
  sed -n "${l}p" "$f" | grep -q . || echo "EMPTY LINE: $f:$l"
done
```

→ prints nothing (every anchored line exists and is non-empty). Then
spot-check by eye that each anchored line contains the symbol the ADR names.

Run `npx prettier --write src docs/adr`.

### Step 4: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- No tests: comments and docs only. `npm run check` (prettier, eslint's
  comment rules) is the gate.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] The Step 1 grep prints nothing
- [ ] `grep -n "resourceSubscriptions" src/server.ts` prints the corrected comment
- [ ] `grep -n "per IP" docs/adr/003-*.md` prints one line; `grep -n "session/IP" docs/adr/003-*.md` prints nothing
- [ ] `grep -n "Resolved 2026-09-26" docs/adr/001-*.md` prints one line
- [ ] The Step 3 anchor check prints nothing
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 039 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any quoted comment is no longer present (a prior plan rewrote it) — skip
  that site and say so.
- The SDK dist no longer contains the `allow(capabilities?.resources?.subscribe)`
  line (SDK upgraded) — report; the server.ts comment then needs a fresh
  reading, not this plan's text.
- An ADR symbol from the table no longer exists in the code.

## Maintenance notes

- ADR anchors drift with every edit; prefer citing a symbol name next to the
  line link so the next re-anchoring is a grep, as the table above does.
- This plan should be re-run (Step 2–3 only) after any future batch that
  touches `glob.ts`, `resources.ts`, `define.ts` or `http.ts`.
