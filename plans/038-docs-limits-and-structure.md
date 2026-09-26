# Plan 038: The server instructions and README state the real limits, recovery steps and project layout

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/instructions.ts README.md __tests__/resources.test.ts`
> Plans 026 and 031 each change one other line of `src/instructions.ts`;
> that is expected. The lines quoted below must still match.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/031 (denylist wording lands first), plans/026 (pagination line)
- **Category**: docs
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

The text in `src/instructions.ts` reaches every session three ways (server
instructions, the `get-help` prompt, `internal://instructions`). Two of its
claims are wrong:

- "content search cap 500 matches": 500 is only the **default page size**
  (`DEFAULT_SEARCH_CONTENT_RESULTS`, `src/core/util.ts:89`). `search_text`
  accepts `maxResults` up to 10,000 and always scans to `MAX_SEARCH_RESULTS`
  (10,000, `util.ts:85`; `search-text.ts:305-307`).
- "TIMEOUT: Reduce scope, depth, or maxResults": for `find_files` and
  `search_text`, `maxResults` is the page size and does not shorten the scan
  (`find-files.ts:127,131`, `search-text.ts:295,307`), so lowering it cannot
  prevent a timeout. It is a scan cap only in `replace_text` (`replace-text.ts:552`).

README problems a contributor hits on the first read:

- `README.md:291` and `:302` say `src/transport.ts` "Owns stdio and Streamable
  HTTP setup". It is a six-line re-export; the code is in `src/transport/`.
- The tree at `README.md:277-289` omits `cli.ts`, `cli-help.ts`,
  `instructions.ts`, `transport.ts`, `mcpb/`, `scripts/`, `docs/`.
- `README.md:256` says `edit` is "max 5 per call". The limits are 5 **files**
  and 100 edits per file (`src/tools/edit.ts:51-52`).

## Current state

```ts
// src/instructions.ts:69
      `enforced_limits: max file size ${maxFileMb} MB, file search cap ${MAX_SEARCH_RESULTS} results, content search cap ${DEFAULT_SEARCH_CONTENT_RESULTS} matches.`,

// src/instructions.ts:80
      'TIMEOUT: Reduce scope, depth, or maxResults.',
```

`__tests__/resources.test.ts:70-75` asserts only section prefixes
(`enforced_limits:` among them) — see the `requiredSection(sections, 'constraints')`
block. `__tests__/prompts.test.ts` renders the same text through `get-help`.

```markdown
<!-- README.md:256 -->

| `edit` | Apply sequential literal string replacements to one or more files (max 5 per call). |
```

```markdown
<!-- README.md:277-302 -->

filesystem-mcp/
├── **tests**/ Test suites
├── src/
│ ├── core/ Path guarding, filesystem abstraction, concurrency, observability
│ ├── tools/ Tool definitions and registration
│ ├── index.ts Process entrypoint and transport selection
│ ├── server.ts Server factory and registrar composition
│ ├── transport/ stdio and Streamable HTTP transport setup
│ ├── prompts.ts Prompt definitions and registration
│ └── resources.ts Resource definitions and registration
└── Dockerfile Multi-stage alpine build, non-root user
```

Runtime composition flows from `src/index.ts` to `src/transport.ts`, then to
`src/server.ts`, the registrars, and finally `src/core/`. …

| `src/transport.ts` | Owns stdio and Streamable HTTP setup around the server factory |

````

`src/transport.ts` (6 lines) re-exports `startServer` from
`./transport/stdio.ts` and `startHttpServer` from `./transport/http.ts`;
`src/transport/shared.ts` holds the pieces both legs gate on;
`src/transport/http-policy.ts` holds the API-key/Origin/host/rate-limit
policy. Actual top-level entries at `8c2a82cd`: `__tests__/`, `assets/`,
`docs/` (`adr/`, `plan/`), `mcpb/manifest.json`, `plans/`, `scripts/`,
`src/`, `Dockerfile`, `server.json`, `.cursor-plugin/plugin.json`.

## Commands you will need

| Purpose       | Command                                                        | Expected on success |
| ------------- | -------------------------------------------------------------- | ------------------- |
| Static check  | `npm run check:static`                                         | exit 0              |
| Text tests    | `node --test __tests__/resources.test.ts __tests__/prompts.test.ts` | all pass       |
| Format        | `npx prettier --write README.md src/instructions.ts __tests__/resources.test.ts` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `src/instructions.ts` — lines 69 and 80
- `README.md` — line 256, the tree, the two `src/transport.ts` mentions
- `__tests__/resources.test.ts` — two assertions added
- `plans/README.md` (status row)

**Out of scope**: the Configuration reference table (verified in sync with
`src/core/config.ts` and `cli-help.ts` during the audit); `CHANGELOG.md`;
`CONTRIBUTING.md`; ADR anchors (plan 039); `src/prompts.ts`.

## Git workflow

- Branch: `advisor/038-docs-limits-and-structure`.
- One commit: `docs: state the real search limits, TIMEOUT recovery and project layout`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pin the corrected text (tests fail first)

In `__tests__/resources.test.ts`, after the line
`assert.match(constraints, /enforced_limits:/);` add:

```ts
      assert.match(constraints, /content search scans up to 10000 matches, paged by maxResults \(default 500\)/);
````

and after the `error_recovery` prefix assertions (the block that follows
"Verify error recovery content"), add:

```ts
assert.match(
  recovery,
  /TIMEOUT: Narrow path or pattern, or lower maxDepth; maxResults only sizes a page\./,
);
```

(Use whatever variable name that block already binds for the recovery
section; if it only checks the section exists, bind it the same way
`constraints` is bound.)

**Verify**: `node --test __tests__/resources.test.ts` → the two new
assertions **fail**.

### Step 2: Instructions

In `src/instructions.ts`:

- Line 69 → `` `enforced_limits: max file size ${maxFileMb} MB, file search cap ${MAX_SEARCH_RESULTS} results, content search scans up to ${MAX_SEARCH_RESULTS} matches, paged by maxResults (default ${DEFAULT_SEARCH_CONTENT_RESULTS}).`, ``
- Line 80 → `'TIMEOUT: Narrow path or pattern, or lower maxDepth; maxResults only sizes a page.',`

**Verify**: `node --test __tests__/resources.test.ts __tests__/prompts.test.ts`
→ all pass.

### Step 3: README

1. Line 256: replace `(max 5 per call)` with
   `(up to 5 files per call, 100 edits per file)`.
2. Replace the tree block (lines 277–289) with:

   ```text
   filesystem-mcp/
   ├── __tests__/          Test suites (node --test) and shared helpers
   ├── docs/adr/           Architecture decision records
   ├── mcpb/manifest.json  Claude Desktop extension manifest
   ├── scripts/            Release-path scripts (MCPB pack, Smithery publish)
   ├── src/
   │   ├── core/           Path guarding, filesystem facade, search, stores, watchers
   │   ├── tools/          One file per tool, plus define.ts (registration) and batch.ts
   │   ├── transport/      stdio.ts, http.ts, http-policy.ts (auth, Origin, rate limit), shared.ts
   │   ├── cli.ts          Argument parsing and --print-config
   │   ├── cli-help.ts     --help / --version text
   │   ├── index.ts        Process entrypoint, shutdown, transport selection
   │   ├── instructions.ts Server instructions sent to every client
   │   ├── prompts.ts      Prompt definitions and registration
   │   ├── resources.ts    Resource definitions, subscriptions, completion
   │   ├── server.ts       Server factory and registrar composition
   │   └── transport.ts    Facade re-exporting startServer / startHttpServer
   └── Dockerfile          Multi-stage alpine build, non-root user
   ```

3. The sentence "Runtime composition flows from `src/index.ts` to
   `src/transport.ts`, then to …" → replace `src/transport.ts` with
   `src/transport/` (stdio or HTTP).
4. Table row for `src/transport.ts` → `| `src/transport/`    | stdio (`stdio.ts`), Streamable HTTP (`http.ts`), HTTP policy (`http-policy.ts`) |`.

Run `npx prettier --write README.md src/instructions.ts __tests__/resources.test.ts`
(prettier re-aligns the markdown tables).

**Verify**: `grep -n "src/transport.ts" README.md` → only the tree line that
describes the facade; `grep -n "max 5 per call" README.md` → nothing.

### Step 4: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- Two new assertions in `resources.test.ts` pin the corrected limit and
  TIMEOUT sentences.
- Existing: every prefix assertion in `resources.test.ts` and
  `prompts.test.ts`.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "content search cap" src/instructions.ts` prints nothing
- [ ] `grep -n "Reduce scope, depth, or maxResults" src/instructions.ts` prints nothing
- [ ] `grep -c "src/transport.ts" README.md` prints `1` (the facade line in the tree)
- [ ] `grep -n "100 edits per file" README.md` prints one line
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 038 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `resources.test.ts` binds the recovery section under a name you cannot
  find — report the surrounding lines rather than restructuring the test.
- The README tree contains entries added after `8c2a82cd` that this plan's
  replacement would drop — merge them in, and note it.

## Maintenance notes

- `enforced_limits` now interpolates `MAX_SEARCH_RESULTS` twice; if the
  scan cap and the file-search cap ever diverge, split the constants first.
- The README tree is hand-maintained; a new top-level directory needs a
  line here.
