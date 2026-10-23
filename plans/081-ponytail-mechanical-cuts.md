# Plan 081: Shared post-write stat and six micro-cuts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the seven zero-behavior-change cuts selected from the 2026-10-23 second-pass ponytail audit (one shared post-write stat helper plus six micro-cuts, ~-35 lines).

**Architecture:** Pure refactor, no new behavior. The only structural change is a shared `postWriteStat` in `src/tools/batch.ts`, the existing tools-layer helper module (`ToolCtx` already imported there), replacing three hand-copied stat/fallback blocks. Everything else is in-place simplification inside a single file each.

**Tech Stack:** TypeScript (NodeNext, `type: module`), Node built-in test runner, ESLint/Prettier/knip static gates.

**Spec:** 2026-10-23 second-pass ponytail audit, Tier A selection (user-confirmed). The seven findings, verbatim from the audit:

1. post-write mtime block hand-copied three times; one shared helper replaces it. [src/tools/patch.ts:150-160; src/tools/edit.ts:379-390; src/tools/create.ts:372-383]
2. `ResourceStoreOptions` interface with one optional field and one options-passing caller; positional ctor param replaces it. [src/core/store.ts:112-134; src/server.ts:170-180]
3. `ProgressSink` interface with zero importers and one impl; inline type replaces it. [src/tools/progress.ts:6-30]
4. `walkFailed`/`walkError` flag pair; one variable replaces them. [src/core/concurrency.ts:~176-215]
5. `CollectOptions.entryCap` on a module-private `collect` whose one caller passes `MAX_LIST_ENTRIES`; use the constant directly. [src/tools/list.ts:51,100,169-171,334]
6. `onError: () => undefined` no-op passes; delete them. [src/core/search.ts:~529,~652]
7. `resourceUpdateSink` closure that only delegates; `notifier.resourceUpdated.bind(notifier)` replaces it. [src/transport/http.ts:160-162,205]

## Global Constraints

- Zero behavior change: no tool, prompt, resource, annotation, or schema changes; `__tests__/contract.test.ts.snapshot` must not change.
- `npm run check` must end green (build, type-check:test, lint `--max-warnings=0`, prettier, knip, full test suite).
- Never edit version fields in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`.
- Branch `refactor/ponytail-tier-a-2026-10-23`, cut from current `main` (77b37076). One commit per task, sequential.
- Every commit message ends with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Tasks 1-7 share no files; any execution order works, but commit sequentially to avoid index contention.
- Machine is Windows; commands below run as written (POSIX-style flags work in the project shell).

## Review Focus

- Falsy walk error (`throw ''`): the `walkError` check must be `!== undefined`, never truthiness, because the old flag handled falsy errors. Pinned by Task 4's step shape; the walk suites in `npm run check` catch a regression.
- The `create` dry-run/preview branch must stay untouched: it reports pre-write stats (`EPOCH` fallback), never a post-write stat. Pinned by existing create tests in `__tests__/tools.test.ts` (Task 1 verify step).
- `forCall()` views must inherit `maxReadResultBytes`: stdio's read-result cap applies to call views too. Pinned by `__tests__/resources.test.ts` (Task 2 verify step).
- The options-object call `new ResourceStore(undefined, { maxReadResultBytes: 1500 })` in `resources.test.ts:315` must be rewritten or `type-check:test` fails; the compile gate is the test (Task 2).
- `patch` dry-run must keep the pre-write `stats.mtime` as `modified`, not a fresh `new Date()`; only the write path stats. Pinned by existing patch dry-run tests in `__tests__/tools.test.ts` (Task 1 verify step).

---

### Task 1: Shared post-write stat helper

**Files:**

- Modify: `src/tools/batch.ts` (add helper + `Stats` import)
- Modify: `src/tools/patch.ts:150-160`
- Modify: `src/tools/edit.ts:379-390`
- Modify: `src/tools/create.ts:372-383`

**Interfaces:**

- Consumes: `ToolCtx` (already imported in `batch.ts`), the `ctx.fs.stat` facade method.
- Produces: `export async function postWriteStat(ctx: ToolCtx, validPath: string): Promise<Stats | undefined>` (`Stats` from `node:fs`). Tasks 2-7 do not use it.

- [ ] **Step 1: Create branch**

```bash
git checkout -b refactor/ponytail-tier-a-2026-10-23
```

- [ ] **Step 2: Add helper to `src/tools/batch.ts`**

Add `import type { Stats } from 'node:fs';` to the imports, then next to the other exported helpers:

```ts
/** Post-write stat for advisory metadata: undefined when the stat fails
 * (concurrent delete, etc.), so callers fall back exactly as before. */
export async function postWriteStat(ctx: ToolCtx, validPath: string): Promise<Stats | undefined> {
  try {
    return (await ctx.fs.stat(validPath)).stats;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 3: Rewrite the three call sites**

`src/tools/patch.ts`: replace the `modified` block (keep the advisory-mtime comment above it):

```ts
let modified = stats.mtime.toISOString();
if (!args.dryRun) {
  modified = ((await postWriteStat(ctx, validPath))?.mtime ?? new Date()).toISOString();
}
```

(Import `postWriteStat` from `'./batch.ts'`; add the import line if patch.ts has none.)

`src/tools/edit.ts`: replace the `modified` block. The fallback keeps the already-computed `nowIso`, matching the old empty catch:

```ts
let modified = new Date().toISOString();
if (!options.dryRun) {
  modified = (await postWriteStat(ctx, validPath))?.mtime.toISOString() ?? modified;
}
```

`src/tools/create.ts`: replace the declare + try/catch inside the non-dry-run branch:

```ts
const nowIso = new Date().toISOString();
const fileStats = await postWriteStat(ctx, written.validPath);
```

The `created`/`modified` lines below it stay unchanged. Drop any now-unused `Stats` import lint flags in these files.

- [ ] **Step 4: Verify**

Run: `npm run check:static`
Expected: PASS (no type/lint/knip errors)

Run: `npm test -- __tests__/mutation-regressions.test.ts __tests__/tools.test.ts`
Expected: PASS (these suites pin written-file `modified` values, including dry-run paths)

- [ ] **Step 5: Commit**

```bash
git add src/tools/batch.ts src/tools/patch.ts src/tools/edit.ts src/tools/create.ts
git commit -m "refactor: share one post-write stat helper across patch, edit, create"
```

### Task 2: ResourceStore positional param

**Files:**

- Modify: `src/core/store.ts:112-144,190`
- Modify: `src/server.ts:170-180`
- Modify: `__tests__/resources.test.ts:315`

**Interfaces:**

- Produces: `constructor(onListChanged?: () => void, maxReadResultBytes?: number)` with the same semantics; `maxReadResultBytes === undefined` still means "no cap".
- Consumes: nothing from other tasks.

- [ ] **Step 1: Collapse the interface in `src/core/store.ts`**

Delete the `ResourceStoreOptions` interface block with its doc comment (lines 112-121). Then:

- line 130: `readonly #options: ResourceStoreOptions;` → `readonly #maxReadResultBytes: number | undefined;`
- constructor: `constructor(onListChanged?: () => void, options: ResourceStoreOptions = {})` with `this.#options = options;` → `constructor(onListChanged?: () => void, maxReadResultBytes?: number)` with `this.#maxReadResultBytes = maxReadResultBytes;`
- `forCall()`: `new ResourceStore(this.#onListChanged, this.#options)` → `new ResourceStore(this.#onListChanged, this.#maxReadResultBytes)`
- line 190: `const { maxReadResultBytes } = this.#options;` → `const maxReadResultBytes = this.#maxReadResultBytes;`

- [ ] **Step 2: Update the two object-passing callers**

`src/server.ts` (keep the inline comment about stdio read-gating):

```ts
new ResourceStore(
  () => {
    /* unchanged body */
  },
  extraDeps?.transport === 'stdio' ? MAX_OUTBOUND_RESULT_BYTES : undefined,
);
```

`__tests__/resources.test.ts:315`: `new ResourceStore(undefined, { maxReadResultBytes: 1500 })` → `new ResourceStore(undefined, 1500)`.

- [ ] **Step 3: Verify**

Run: `npm run check:static`
Expected: PASS. `type-check:test` is the test here; a missed caller fails the build.

Run: `npm test -- __tests__/resources.test.ts __tests__/page-store.test.ts`
Expected: PASS (store cap behavior, `forCall` views, discard flows)

- [ ] **Step 4: Commit**

```bash
git add src/core/store.ts src/server.ts __tests__/resources.test.ts
git commit -m "refactor: collapse ResourceStoreOptions to a positional maxReadResultBytes param"
```

### Task 3: ProgressSink type inline

**Files:**

- Modify: `src/tools/progress.ts:6-11,16,30`

**Interfaces:**

- Produces: none; type-only change. `ProgressSessionOptions['sink']` becomes the sink type. Zero importers existed.

- [ ] **Step 1: Apply the edit**

Delete the `ProgressSink` interface with its doc comment (lines 6-11). Then:

- `sink?: ProgressSink;` → `sink?: { toolName: string; token: string | number; notify: (n: Notification) => Promise<void> };` (keep the doc comment above the field)
- `readonly #sink: ProgressSink | undefined;` → `readonly #sink: ProgressSessionOptions['sink'];`

- [ ] **Step 2: Verify**

Run: `npm run check:static`
Expected: PASS

Run: `npm test -- __tests__/progress.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/progress.ts
git commit -m "refactor: inline ProgressSink type into ProgressSessionOptions"
```

### Task 4: Merge walkFailed into walkError

**Files:**

- Modify: `src/core/concurrency.ts` (~176-215, the `processEntriesConcurrently` walk catch)

**Interfaces:** none; private simplification.

- [ ] **Step 1: Apply the edit**

Replace the declaration pair (`let walkFailed = false;` + `let walkError;`) with `let walkError: unknown;` (if `tsc` complains about use-before-assignment, write `let walkError: unknown = undefined;`). In the catch block drop the `walkFailed = true;` line and keep `walkError = error;`. Replace the throw:

```ts
if (walkError !== undefined) throw walkError;
```

`!== undefined`, not truthiness: a falsy thrown error must still propagate, and the old flag did.

- [ ] **Step 2: Verify**

Run: `npm run check:static`
Expected: PASS

Run: `npm test -- __tests__/concurrency.test.ts`
Expected: PASS (walk stop-reason and error propagation paths)

- [ ] **Step 3: Commit**

```bash
git add src/core/concurrency.ts
git commit -m "refactor: merge walkFailed flag into walkError in processEntriesConcurrently"
```

### Task 5: entryCap to MAX_LIST_ENTRIES

**Files:**

- Modify: `src/tools/list.ts:51,100,169-171,334`

**Interfaces:** none; `collect` is module-private.

- [ ] **Step 1: Apply the edit**

- Delete `entryCap: number;` with its doc comment from `CollectOptions` (line 51).
- `keepBest`: `if (entries.length > options.entryCap) entries.length = options.entryCap;` → `if (entries.length > MAX_LIST_ENTRIES) entries.length = MAX_LIST_ENTRIES;`
- Prune site: `if (entries.length >= options.entryCap * 2) keepBest();` → `if (entries.length >= MAX_LIST_ENTRIES * 2) keepBest();` and reword the comment above it from `entryCap` to `MAX_LIST_ENTRIES` (keep the O(...) claims).
- Delete `entryCap: MAX_LIST_ENTRIES,` from the `collect` call (line 334).

`MAX_LIST_ENTRIES` is already imported (line 26).

- [ ] **Step 2: Verify**

Run: `npm run check:static`
Expected: PASS

Run: `npm test -- __tests__/tools.test.ts`
Expected: PASS (list truncation and `stoppedReason: 'maxResults'` paths)

- [ ] **Step 3: Commit**

```bash
git add src/tools/list.ts
git commit -m "refactor: use MAX_LIST_ENTRIES directly inside collect"
```

### Task 6: Drop no-op onError passes

**Files:**

- Modify: `src/core/search.ts` (~529, ~652)

**Interfaces:** none; `onError` stays optional on `processEntriesConcurrently`.

- [ ] **Step 1: Apply the edit**

Delete the `onError: () => undefined,` line at both `processEntriesConcurrently` call sites in `search.ts` (the prefilter walk ~line 529 and the concurrent-read walk ~line 652).

- [ ] **Step 2: Verify**

Run: `npm run check:static`
Expected: PASS

Run: `npm test -- __tests__/search-literal.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/core/search.ts
git commit -m "refactor: drop no-op onError passes in search walks"
```

### Task 7: Bind resourceUpdated at the call site

**Files:**

- Modify: `src/transport/http.ts:160-162,205`

**Interfaces:** none.

- [ ] **Step 1: Apply the edit**

Delete the `resourceUpdateSink` closure (lines 160-162). At line 205 pass `notifier.resourceUpdated.bind(notifier)` in its place (`notifier` is in scope; `.bind` preserves `this`).

- [ ] **Step 2: Verify**

Run: `npm run check:static`
Expected: PASS

Run: `npm test -- __tests__/http-server.test.ts __tests__/resources-subscribe.test.ts`
Expected: PASS (subscribe notification wiring on the HTTP leg)

- [ ] **Step 3: Commit**

```bash
git add src/transport/http.ts
git commit -m "refactor: bind notifier.resourceUpdated directly at the listen call site"
```

### Task 8: Full gate and plan index row

**Files:**

- Modify: `plans/README.md` (add row for plan 081)

- [ ] **Step 1: Run the full gate**

Run: `npm run check`
Expected: PASS end to end: build, types, lint, prettier, knip, all tests. This is the branch's real gate; do not skip.

- [ ] **Step 2: Add the plan index row**

Append a row for plan 081 to the table in `plans/README.md`, matching the shape of the existing rows (plans 077-080 are the nearest pattern): plan number, title, one-line scope, date 2026-10-23, source "2026-10-23 second-pass ponytail audit (Tier A)".

- [ ] **Step 3: Commit**

```bash
git add plans/README.md
git commit -m "docs: index plan 081"
```
