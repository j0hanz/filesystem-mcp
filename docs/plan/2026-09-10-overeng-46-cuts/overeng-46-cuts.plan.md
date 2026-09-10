# Plan: Apply the 46 verified over-engineering cuts — behavior-preserving, −677 lines net

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Line numbers in this plan are anchors, not coordinates.** The source of
> truth is the symbol name plus quoted text: re-grep before every edit. If the
> symbol is where the link says, proceed; if only the line number matches,
> re-grep for the symbol.
>
> After each step, run the Verify. If it fails on formatting only, run
> `npx prettier --write <changed files>` and re-Verify once. Never change code
> to satisfy a linter when the lint rule name is not one this plan names.
>
> **Written against** commit `1806f037`, 2026-09-10.
> **Drift check (run first)**: `git diff --stat 1806f037..HEAD`
> Expected: empty (tree is clean at the base commit). Any file it lists that
> this plan also touches must have its excerpt below re-checked against the
> live code before editing that file.

## Goal

Fourth cleanup pass on this repo. A 12-agent audit (each cut separately
adversarial-refuted, most by applying it in a throwaway worktree and running
the full gate) confirmed 46 over-engineering items: delegate-only wrappers,
single-caller helpers, hand-rolled stdlib, speculative parameters, dead public
surface. All are behavior-preserving deletions/simplifications totalling
−677 lines, with no new features, no dependency changes, and no changes to
input validation or security guards. Requirements covered: none, this is a
cut pass.

The test baseline at `1806f037` is **277 tests / 61 suites / 277 pass / 0
fail / 0 skipped** (24 files). Any drop below 277 pass is a regression.

## Current state

- `npm run check` (at `1806f037`) exits 0: build + type-check +
  type-check:test + eslint + prettier + knip, then 277 passing tests.
- `scripts/tasks.mjs` (87 lines) is a pure-delegation wrapper over npm
  scripts, invoked by [`AGENTS.md`](../../../AGENTS.md) (`:6-18`),
  [`CONTRIBUTING.md`](../../../CONTRIBUTING.md) (`:21`, `:25`, `:32`, `:35`,
  `:40`, `:44`, `:47`) and
  [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml#L26).
- [`package.json`](../../../package.json) scripts (verified anchors):
  `:30` `start`, `:34` `format:check`, `:37` `knip`, `:38` `check:static`
  (inlines `prettier --check .` and `knip` verbatim), `:40` `test` (a glob
  form), `:43` `tasks`. `check:static` runs knip, so an export losing its
  last caller fails the build — cut #46 and #44 are paired edits for
  exactly this reason.
- **Lint climate** (verified): `tseslint.configs.strictTypeChecked` applies
  to `src/**` in [`eslint.config.mjs`](../../../eslint.config.mjs#L52).
  `no-unnecessary-condition` IS live for `src/**` (off only for
  `testFiles`, `eslint.config.mjs:202`); `no-confusing-void-expression` is
  off only in tests (`:197`). TypeScript sets `noPropertyAccessFromIndexSignature`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
  ([`tsconfig.json`](../../../tsconfig.json)); tests are type-checked
  ([`tsconfig.test.json`](../../../tsconfig.test.json)). Prettier
  `printWidth: 100`.
- package.json `exports` exposes only `./transport` + `./package.json` —
  no core/src symbol is public API.
- `processInParallel` ([`src/core/concurrency.ts`](../../../src/core/concurrency.ts))
  returns `{ index, value }[]` sorted by index — index-addressed result
  reassembly is safe wherever it walked a dense input array.
- Bare `node --test --import tsx` discovers the same 24 test files as the
  current glob script (verified: 277/61/277 both ways).

## Commands

| Purpose              | Command           | Expected on success                          |
| -------------------- | ------------------ | -------------------------------------------- |
| Full gate            | `npm run check`    | exit 0; test tail reads `pass 277`, `fail 0` |
| Static only          | `npm run check:static` | exit 0                                   |
| Tests only           | `npm test`        | exit 0; `pass 277`, `fail 0`                  |
| Format changed files | `npx prettier --write <files>` | exit 0, re-Verify                |

`npm run check` is the per-step Verify. It is the only gate; there is no
task runner after step 1 (that is the point of cut #1).

## Scope

**In scope** — the only files to modify or delete:

- [`scripts/tasks.mjs`](../../../scripts/tasks.mjs) (delete)
- [`package.json`](../../../package.json) — scripts only; **never the `version` field**
- [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)
- [`AGENTS.md`](../../../AGENTS.md), [`CONTRIBUTING.md`](../../../CONTRIBUTING.md), [`README.md`](../../../README.md)
- [`docker-compose.yml`](../../../docker-compose.yml) (delete), [`.dockerignore`](../../../.dockerignore)
- [`eslint.config.mjs`](../../../eslint.config.mjs), [`tsconfig.json`](../../../tsconfig.json), [`tsconfig.test.json`](../../../tsconfig.test.json)
- [`src/core/schema.ts`](../../../src/core/schema.ts), [`src/core/fs.ts`](../../../src/core/fs.ts)
- [`src/tools/stat.ts`](../../../src/tools/stat.ts)
- [`src/core/read.ts`](../../../src/core/read.ts), [`src/tools/read.ts`](../../../src/tools/read.ts)
- [`src/tools/search-content.ts`](../../../src/tools/search-content.ts), [`src/core/search.ts`](../../../src/core/search.ts)
- [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts), [`src/core/concurrency.ts`](../../../src/core/concurrency.ts)
- [`src/core/path-utils.ts`](../../../src/core/path-utils.ts), [`src/tools/move.ts`](../../../src/tools/move.ts)
- [`src/core/glob.ts`](../../../src/core/glob.ts), [`src/tools/list.ts`](../../../src/tools/list.ts)
- [`src/core/path-completer.ts`](../../../src/core/path-completer.ts), [`src/core/path.ts`](../../../src/core/path.ts)
- [`src/core/store.ts`](../../../src/core/store.ts), [`src/core/cursor.ts`](../../../src/core/cursor.ts)
- [`src/core/fmt.ts`](../../../src/core/fmt.ts), [`src/tools/progress.ts`](../../../src/tools/progress.ts), [`src/core/input-required.ts`](../../../src/core/input-required.ts)
- [`src/transport/http.ts`](../../../src/transport/http.ts), [`src/transport/http-policy.ts`](../../../src/transport/http-policy.ts)
- [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts), [`src/tools/define.ts`](../../../src/tools/define.ts)
- [`src/resources.ts`](../../../src/resources.ts)
- [`src/index.ts`](../../../src/index.ts), [`src/cli.ts`](../../../src/cli.ts), [`src/prompts.ts`](../../../src/prompts.ts), [`src/server.ts`](../../../src/server.ts)
- [`__tests__/helpers.ts`](../../../__tests__/helpers.ts)
- [`__tests__/inspector-fixtures.ts`](../../../__tests__/inspector-fixtures.ts) (delete)
- [`__tests__/inspector-http.test.ts`](../../../__tests__/inspector-http.test.ts), [`__tests__/inspector-config.test.ts`](../../../__tests__/inspector-config.test.ts)
- [`__tests__/http-policy.test.ts`](../../../__tests__/http-policy.test.ts), [`__tests__/core-fs.test.ts`](../../../__tests__/core-fs.test.ts), [`__tests__/resources.test.ts`](../../../__tests__/resources.test.ts)

**Out of scope** — leave alone even though they look related:

- [`src/transport.ts`](../../../src/transport.ts) — the published `./transport` export; not a dead barrel.
- `package.json` / `server.json` `version` fields — bumped only by the Release workflow.
- The five adversarially-refuted findings (do NOT re-attempt; each died with a repro):
  the literal-matcher fast path in `src/tools/replace-in-files.ts:259`
  (`createCaseSensitiveLiteralMatcher` — deliberate raw-byte `indexOf` prefilter),
  `createPatch` for [`src/core/diff.ts`](../../../src/core/diff.ts)
  (cut ADDS ~7 lines under prettier), the `return []` / empty-throw guards in
  [`src/tools/batch.ts`](../../../src/tools/batch.ts) (compiler-mandated under
  `noImplicitReturns`; last fail-loud guard), the dual elicitation shapes in
  `src/tools/define.ts:320-364` (single-dir boolean is what 2025-era clients
  render), and `within()` in [`__tests__/stdio.test.ts`](../../../__tests__/stdio.test.ts)
  (node:test `timeout` never unwinds a suspended async fn — cleanup would leak).
- The two stashes on the stale `dev` branch — predating this effort, unrelated.
- `move.ts` / `delete-file.ts` recursion — already uses `fs.cp`/`fs.rm`; nothing to do.

## Steps

### 1. Command surface: delete the task runner (cuts #1 + #40)

First step on purpose — every later Verify runs `npm run check`.

1. Delete [`scripts/tasks.mjs`](../../../scripts/tasks.mjs) (the whole file).
2. [`package.json`](../../../package.json):
   - `:40` `"test"` becomes `"node --test --import tsx"` (drop the glob; default discovery is verified identical).
   - Remove the `:43` `"tasks"` script.
   - Add `"fix": "npm run format && npm run lint:fix && npm run check"` directly
     after the `"check:static"` entry. (No placement is enforced — the scripts
     block is not alphabetical today and prettier does not order it, so this
     names one.)
   - Remove the three orphaned scripts — `:30` `"start"`, `:34` `"format:check"`, `:37` `"knip"`. `check:static` (`:38`) already inlines `prettier --check .` and `knip` verbatim; leave that inlined form.
3. [`.github/workflows/ci.yml:26`](../../../.github/workflows/ci.yml#L26): `node scripts/tasks.mjs` → `npm run check`.
4. Rewrite the Commands section of [`AGENTS.md`](../../../AGENTS.md) (`:6-18`) to:

   ```markdown
   ## Commands

   ```bash
   npm run check        # full repository check (static + tests)
   npm run fix          # format and lint-fix, then run the full check
   npm run check:static # static checks only, no tests
   npm test             # Node test runner; pass native flags after --
   ```

   Tests run on Node's built-in test runner; `npm test --
   --test-name-pattern="resources"` filters like the old wrapper did.

   ```

   Keep the surrounding sections (title/intro, Releases) byte-identical.
5. [`CONTRIBUTING.md`](../../../CONTRIBUTING.md):

   - `:21` intro sentence → `Tests run on Node's built-in test runner:`
   - `:25` code line → `npm test`
   - `:32` checklist item → `Tests pass locally (`npm run check`)`
   - `:35` → `Code follows the project's style guide (run`npm run fix`)`
   - `:40` → `Check formatting and apply auto-fixes:`
   - `:44` → `npm run fix`
   - `:47` → `npm run check:static`
6. [`README.md`](../../../README.md) — same command-surface rewrite (its
   `node scripts/tasks.mjs` rows are why the step-16 reference check cannot
   pass without this):
   - Scripts table rows (`:425-428`) become
     `npm run check` / `npm run fix` / `npm run check:static` / `npm test` for
     the Full check / Auto-fix + check / Static only / Tests only rows —
     descriptions unchanged. (Prettier checks markdown; if the table's column
     alignment is off, `npx prettier --write README.md` reflows it — run the
     step's Verify after.)
   - Contributing step `:447` becomes
     `4. Run`npm run check`to confirm tests, types, lint, formatting, and knip all pass.`

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 2. Config residue: drop the dead `filesystem-tests` path (cut #45)

1. [`eslint.config.mjs:8`](../../../eslint.config.mjs#L8): `const testFiles = ['__tests__/**/*.ts'];` (drop the `'filesystem-tests/**/*.ts'` element).
2. [`tsconfig.test.json:8`](../../../tsconfig.test.json#L8): `"include": ["src/**/*", "__tests__/**/*.ts"],`.
3. [`tsconfig.json:40`](../../../tsconfig.json#L40): `"exclude": ["dist", "node_modules", "__tests__"]`.

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 3. fmt / un-export pass (cuts #25 + #26 + #44)

**Cut #25** — [`src/core/fmt.ts`](../../../src/core/fmt.ts):

1. Delete `isColorEnabled` (`:139-141`), `type Style` (`:148`), and `tint` with its doc comment (`:150-153`), plus trailing blank lines. `styleText` is already imported at `:2`.
2. In `cliFmt` (`:155-163`) rename each `tint(` call to `styleText(` — arguments unchanged, including the array form `styleText(['cyan', 'bold'], t)`.

**Cut #26** — delete `timedSignal`:

1. [`src/core/concurrency.ts`](../../../src/core/concurrency.ts): delete the 9-line doc-comment-plus-function block (`:209-218` by anchor — grep `timedSignal`) and its separating blank line. Reword the dangling comment at `:99` (`// A deadline (timedSignal) hit during the run...`) to cite `AbortSignal.timeout` instead.
2. [`src/core/path.ts:6`](../../../src/core/path.ts#L6): import shrinks to `import { withAbort } from './concurrency.js';`; its `timedSignal` caller (grep `timedSignal` in path.ts, `:834` by anchor, inside the roots recompute) becomes `AbortSignal.any([ctx.signal, AbortSignal.timeout(ROOTS_TIMEOUT_MS)])` — read the current call: it passes `undefined` as base, so the correct inline is just `AbortSignal.timeout(ROOTS_TIMEOUT_MS)` **if** the base arg is a literal `undefined` there; use `AbortSignal.any([...])` only if a live signal is passed. Match what the call site actually passes.
3. [`src/tools/list.ts:7`](../../../src/tools/list.ts#L7): delete the `import { timedSignal } ...` line; the call at [`list.ts:306`](../../../src/tools/list.ts#L306) becomes `signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(DEFAULT_SEARCH_TIMEOUT_MS)]),` (this caller passes `ctx.signal`, a non-optional `AbortSignal`).

**Cut #44** — delete only the `export` keyword (the types stay file-local) on five declarations:

- `ParallelResult` ([`src/core/concurrency.ts:47`](../../../src/core/concurrency.ts#L47))
- `Phase` ([`src/core/fmt.ts:16`](../../../src/core/fmt.ts#L16))
- `ProgressEvent` ([`src/tools/progress.ts:11`](../../../src/tools/progress.ts#L11))
- `PendingInput` ([`src/core/input-required.ts:48`](../../../src/core/input-required.ts#L48))
- `PendingRoundTripOpts` ([`src/core/input-required.ts:208`](../../../src/core/input-required.ts#L208))

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`. Knip passing here proves the five types have no external importers.

### 4. schema.ts: one refine factory for Path and Pattern (cut #2)

In [`src/core/schema.ts`](../../../src/core/schema.ts), the two 37-line hand-written
`superRefine` bodies on `PathBase` (`:54-90` by anchor) and `SafeGlobPattern`
(`:100-136` by anchor) share three of four checks byte-identical apart from
the noun "Path"/"Pattern".

1. Insert this factory immediately after `isBlank` (`:48` by anchor):

   ```ts
   function refineSafeText(
     label: string,
     specific: (val: string) => string | undefined,
   ): (val: string, ctx: z.RefinementCtx) => void {
     return (val, ctx) => {
       if (val.length === 0) return;
       const issue = isBlank(val)
         ? `${label} cannot be empty or whitespace-only`
         : val.includes('\0')
           ? `${label} cannot contain null bytes`
           : specific(val) ??
             (SHELL_METACHAR_RE.test(val)
               ? `${label} contains prohibited characters (newlines or shell metacharacters)`
               : undefined);
       if (issue !== undefined) {
         ctx.addIssue({ code: 'custom', message: issue, fatal: true });
       }
     };
   }
   ```

   The blank/null/specific/metachar order and `fatal: true` match both
   originals (first-fail-wins). If any message string above differs from the
   live text, the live text wins — copy it.
2. `PathBase`'s `superRefine` argument becomes
   `refineSafeText('Path', (val) => (val.includes('..') ? 'Directory traversal sequences ("..") are forbidden' : undefined))`
   — preserving the live traversal message verbatim.
3. `SafeGlobPattern`'s becomes
   `refineSafeText('Pattern', (val) => (isSafeGlobSyntax(val) ? undefined : 'Invalid glob or unsafe path (absolute/.. forbidden)'))`
   — preserving the live invalid-glob message verbatim.

Do NOT use a `return fail(...)` form — `no-confusing-void-expression` is
live for `src/**` and it does not lint.

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 5. stat/fs: one FileInfo type (cuts #4 + #28)

All in [`src/tools/stat.ts`](../../../src/tools/stat.ts) except the last item:

1. Add after the import block: `type FileInfo = z.infer<typeof FileInfoSchema>;`
2. [`stat.ts:8`](../../../src/tools/stat.ts#L8): `import type { GuardedFileSystem, Stats } from '../core/fs.js';` (drop `FileInfo`).
3. `buildFileInfoResult` (`:59-82`): keep return type `FileInfo` (now the inferred type); the three timestamp fields become
   `created: stats.birthtime.toISOString(),` / `modified: stats.mtime.toISOString(),` / `accessed: stats.atime.toISOString(),`.
4. Delete `interface FileInfoOptions` (`:101-105`) and retype its function (`:107`):

   ```ts
   async function getFileInfo(
     filePath: string,
     { signal, fs, log }: Pick<ToolCtx, 'fs' | 'signal' | 'log'>,
   ): Promise<FileInfo> {
     signal.throwIfAborted();
   ```

   Then `await fs.statDetailed(filePath, { signal });` and
   `({ stats } = await fs.lstat(requestedPath, { signal })` (keep the
   destructure parens). The `getSymlinkTarget` call keeps passing
   `signal, log` positionally.
5. Sole call site (`:219-224`) collapses to `async ({ path }) => getFileInfo(path, ctx),`.
6. Delete `toStatPerPathPayload` entirely (`:165-187`); `:229` becomes
   `const perPathPayload = batch.results;` — `PerPathResult<FileInfo>` now
   structurally satisfies `StatPerPathSchema` because the value fields are
   the same shape the schema declares.
7. Delete `export interface FileInfo` from
   [`src/core/fs.ts:44-57`](../../../src/core/fs.ts#L44-L57). Verified: no other
   importers or in-file uses.

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 6. read: drop re-validation and the pre-filter pass (cuts #6 + #19 + #10)

**Cut #6** — [`src/core/read.ts`](../../../src/core/read.ts) re-validates what
zod already rejected at the tool boundary (the range fields are
`z.int32().min(1).max(100000)` in [`src/tools/read.ts:40-46`](../../../src/tools/read.ts#L40-L46), applied at `:48-53`):

1. Delete `assertPositiveIntegerOption` (`:17-24` by anchor) and `normalizeRangeSpec` (`:120-140`).
2. The `head`/`tail` arm (`:149` by anchor): drop the assert line, keep `return { ...base, kind: spec.kind, lines: spec.lines };`.
3. The `range` arm (`:152` by anchor) becomes the inlined build:

   ```ts
   case 'range':
     return {
       ...base,
       kind: 'range',
       start: spec.start,
       ...(spec.end !== undefined ? { end: spec.end } : {}),
     };
   ```

**Cut #19** — [`src/tools/read.ts`](../../../src/tools/read.ts):

1. `buildReadContinuation` (`:152-177` by anchor — the anonymous structural
   param type is a strict subset of `ReadFileResult`, already imported at
   `:13`): signature becomes

   ```ts
   function buildReadContinuation(
     result: ReadFileResult,
     requestedPath: string,
   ): z.infer<typeof ContinuationSchema> | undefined {
   ```

   Body unchanged except the `args` line becomes
   `args: { path: requestedPath, startLine: nextStart, endLine: nextEnd },`.
2. The caller in `buildPerPathReadValue` (`:297-307` by anchor) collapses to
   `buildReadContinuation(result, options.requestedPath)` inside the existing
   `hasMoreLines && readMode !== 'tail'` ternary — the four conditional
   spreads rebuilding `result` go away.

**Cut #10** — delete `preFilterByBudget` (`:263-290` by anchor) and build the
TOO_LARGE results directly in `collectFileBudget`:

1. Return type (`:203` by anchor): `skippedBudget: Set<number>;` →
   `skippedResults: Map<number, PerPathResult<PerPathReadValue>>;` plus a new
   `survivors: string[];`.
2. Replace the budget loop (the `let total = 0; const skippedBudget = new Set<number>();`
   loop) with — preserving the stat'd-only rule and its comment:

   ```ts
   let total = 0;
   const skippedResults = new Map<number, PerPathResult<PerPathReadValue>>();
   const survivors: string[] = [];
   let overflowed = false;
   for (let i = 0; i < filePaths.length; i += 1) {
     const path = filePaths[i];
     if (path === undefined) continue;
     const size = byIndex.get(i);
     if (overflowed) {
       // Only files that were actually stat'd get the TOO_LARGE result; a
       // failed stat falls through to survivors so its read surfaces the
       // real error — not a misleading TOO_LARGE.
       if (size !== undefined) {
         skippedResults.set(i, {
           path,
           error: {
             code: ErrorCode.TOO_LARGE,
             message: `Skipped: combined estimated read would exceed maxTotalSize (${String(maxTotalSize)} bytes)`,
             path,
           },
         });
       } else {
         survivors.push(path);
       }
       continue;
     }
     if (size === undefined) {
       survivors.push(path);
       continue;
     }
     if (total + size > maxTotalSize) {
       overflowed = true;
       skippedResults.set(i, {
         path,
         error: {
           code: ErrorCode.TOO_LARGE,
           message: `Skipped: combined estimated read would exceed maxTotalSize (${String(maxTotalSize)} bytes)`,
           path,
         },
       });
       continue;
     }
     total += size;
     survivors.push(path);
   }

   return { skippedResults, survivors, known };
   ```

3. In `run()` (`:445-452` by anchor): `skippedResults = budget.skippedResults; survivors = budget.survivors;` replacing the `preFilterByBudget` block (`known = budget.known;` stays).

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 7. search: delete the double compile and a dead knob (cuts #5 + #42)

**Cut #5** — [`src/tools/search-content.ts`](../../../src/tools/search-content.ts):

1. Delete the `escapeRegexLiteral` import (`:13` by anchor; its only use is inside the helper being deleted).
2. Type import line (`:27` by anchor) → `import type { SearchContentOptions } from '../core/search.js';` (drop the `Regex`-named type import if separate — keep what remains used).
3. Value import line (`:28` by anchor) → `import { searchContent } from '../core/search.js';` (drop `compileRegex`, `freeRegex` — both stay exported for `edit.ts` / `replace-in-files.ts`, so knip stays clean).
4. Delete `createSearchMatcher` (`:205-213` by anchor).
5. In `produce()`: delete the `const regexMatcher = createSearchMatcher(scoped);` line, the two justification comments that follow it, the `regexMatcher,` argument to `searchContent(...)`, and the try/finally wrapper around it — the call becomes `const items = buildSortedPayloads(result);` style direct assignment (searchContent frees its own regex; that is internal to
   [`src/core/search.ts`](../../../src/core/search.ts)).
6. In [`src/core/search.ts`](../../../src/core/search.ts): drop the `precompiled` parameter from `searchContent`'s signature (`:218` by anchor) and the `precompiled ?? compileRegex(...)` line (`:220-224`), leaving the plain `compileRegex(...)` call; drop the now-stale doc sentences at `:208-212`.

**Cut #42** — [`src/core/search.ts`](../../../src/core/search.ts):

1. Delete `maxFileSize?: number;` from `SearchContentOptions` (`:178` by anchor).
2. The line `const maxFileSize = options.maxFileSize ?? getMaxTextFileSize();` (verified at `:228` at HEAD) becomes `const maxFileSize = getMaxTextFileSize();`. Keep the `getMaxTextFileSize` import, the const name, and the size check downstream.

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 8. replace/move/path-utils: single-caller helpers and a dedup (cuts #16 + #36 + #46)

**Cut #16** — [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts):

1. Delete `buildReplacementPlan` (`:299-315` by anchor, function plus trailing blank).
2. Sole call (`:372` by anchor) inlines to:

   ```ts
   const originalContent = buffer.toString('utf-8');
   const { content: updatedContent, matchCount } = matcher.replace(
     originalContent,
     replacement,
   );
   return matchCount === 0
     ? undefined
     : { matchCount, originalContent, updatedContent };
   ```

   Adjust the returned object's field names to exactly what the caller of
   `buildReplacementPlan` reads today (the live call site's destructure names
   the fields; keep those).

**Cut #36** — same file (`:511-530` by anchor):

1. Keep the comment lines about single-file targets bypassing the glob.
2. Replace the annotated ternary (the `singleFileEntry` async-generator IIFE,
   its `// eslint-disable-next-line @typescript-eslint/require-await`
   directive, and the `: AsyncIterable<{ path: string }>` annotation) with
   `const entries = singleFile ? [{ path: singleFile }] : globEntries({ ...the unchanged options object... });`
3. Widen [`src/core/concurrency.ts:119`](../../../src/core/concurrency.ts#L119) to
   `entries: AsyncIterable<{ path: string }> | Iterable<{ path: string }>` —
   the `for await` consumer at `:140` resolves over the union.

**Cut #46** — three edits, all or none (knip runs in the gate):

1. [`src/core/path-utils.ts:97`](../../../src/core/path-utils.ts#L97): add `export` to `function normalizeCaseForComparison`.
2. [`src/core/path-utils.ts:95`](../../../src/core/path-utils.ts#L95): REMOVE `export` from `IS_CASE_INSENSITIVE_FS` (mandatory — knip flags it once move.ts drops it).
3. [`src/tools/move.ts:21`](../../../src/tools/move.ts#L21) import becomes
   `import { isPathInsideDirectory, isSamePath, normalizeCaseForComparison } from '../core/path-utils.js';`
   and the duplicate-destination key at `:278-280` becomes
   `const destKey = normalizeCaseForComparison(candidate.validDest);`.

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 9. glob / path-completer (cuts #8 + #15 + #20 + #34 + #41)

**Cut #8**:

1. [`src/core/glob.ts`](../../../src/core/glob.ts): delete `isIgnoredByGitignore` (`:183-193` by anchor, function plus trailing blank). KEEP the `relative` import — still used at `:361` and `:386`.
2. [`src/tools/list.ts:11-16`](../../../src/tools/list.ts#L11-L16): collapse the import block to
   `import { DEFAULT_EXCLUDE_PATTERNS, globEntries, loadRootGitignore } from '../core/glob.js';`
3. [`src/tools/list.ts:116-123`](../../../src/tools/list.ts#L116-L123): replace the `isIgnoredByGitignore(...)` call with
   `if (gitignoreMatcher && gitignoreMatcher.isIgnored(relPath, isDir)) { continue; }`
   reusing `relPath` from `:113` and `isDir` from `:112` — safe because
   `GitignoreManager.isIgnored` normalizes via `toPosixPath` internally and
   guards `''`/`'.'`.

**Cut #15** — [`src/core/path-completer.ts`](../../../src/core/path-completer.ts), two shrinks:

1. Replace the `sortCompletionMatches` + `mergeCompletionMatches` pair (`:127-146`, verified live) with:

   ```ts
   function mergeCompletionMatches(
     dirMatches: readonly string[],
     rootMatches: readonly string[],
   ): string[] {
     const isDir = (v: string): boolean => v.endsWith(sep);
     return [...new Set([...dirMatches, ...rootMatches])].sort(
       (left, right) => Number(isDir(right)) - Number(isDir(left)) || left.localeCompare(right),
     );
   }
   ```

   The sole call site (`:255` by anchor) already passes two positional args —
   only the signature changes.
2. `collectAllowedRoots` (`:94-103`, verified live) body becomes
   `return allowed.filter(predicate).map(withDirectorySeparator);`.

**Cut #20** — [`src/core/glob.ts`](../../../src/core/glob.ts):

1. Delete `getRelativeDepth` (`:332-344` by anchor, incl. trailing blank).
2. The sole call site (`:361-362` by anchor) becomes
   `const rel = relative(cwd, absolutePath);` then
   `if (rel.split(/[/\\]/u).length - 1 > maxDepth) return;` (keep the `/u` flag for file consistency).

**Cut #34** — [`src/core/glob.ts`](../../../src/core/glob.ts): delete
`type GlobMatch = string | GlobDirentLike` (`:216` by anchor) and the
unreachable string branches in `createExcludeFilter` (Node always hands the
callback a Dirent — `processGlobPattern` hardcodes `withFileTypes: true`):

1. Retype `createExcludeFilter`'s return to `((match: GlobDirentLike) => boolean) | readonly string[]` and its callback param to `GlobDirentLike`.
2. Delete the `typeof match === 'string'` branches (`:383-384` and `:392` by anchor; the latter collapses to `const isDir = match.isDirectory();`).
3. `processGlobPattern`: retype the `excludeFunc` param (`:413`), the iterable declaration `let iterable: AsyncIterable<GlobDirentLike>;` (`:416`), the `:422` cast, and drop the `as GlobDirentLike` cast at `:430`.

**Cut #41** — [`src/core/glob.ts`](../../../src/core/glob.ts): delete the two
lines highest-first (avoid renumbering): `respectGitignore: options.respectGitignore ?? false,` inside the `normalized` literal in `normalizeGlobOptions` (`:322` by anchor), then `respectGitignore: boolean;` on `interface NormalizedGlob` (`:224` by anchor). LEAVE the public `respectGitignore?: boolean` on `GlobEntriesOptions` (`:213`) and the live switch `if (options.respectGitignore)` (`:442`).

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 10. path.ts helpers (cuts #14 + #33 + #35)

**Cut #14** — replace `expandAllowedDirectories` plus
`resolveAllowedDirectoriesState` (`:135-165`, verified live) with one function:

```ts
export async function resolveAllowedDirectoriesState(
  dirs: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const primary = normalizeAllowedDirectories(dirs);
  const reals = await Promise.all(primary.map((dir) => resolveRealPath(dir, signal)));
  return [
    ...new Set(
      primary.flatMap((dir, i) => {
        const real = reals[i];
        return real && !isSamePath(real, dir) ? [dir, real] : [dir];
      }),
    ),
  ];
}
```

(`normalizeAllowedDirectories` returns a dense array — no empty-entry guard
is lost. `isSamePath` stays in use.)

**Cut #33** — grep `isFilesystemRoot` and `isUnsafeGrantTarget` in
[`src/core/path.ts`](../../../src/core/path.ts):

1. Delete the private `isFilesystemRoot` method with its doc comment (`:282-285` by anchor; sits immediately above the `isUnsafeGrantTarget` doc block).
2. In `isUnsafeGrantTarget`, the `isRefused` lambda that ORs `isFilesystemRoot(p)` with `isUnsafeCwdPath(p)` goes away: the `||`-left operand can never be the deciding term. The two checks become
   `if (isUnsafeCwdPath(normalized)) return true;` and
   `return !isSamePath(resolved, normalized) && isUnsafeCwdPath(resolved);`
   (`:299` / `:306` by anchor — match the live locals' names).

**Cut #35**:

1. Delete `label: string,` from `isRootWithin` (`:56` by anchor) and `filterRootsWithin` (`:79`).
2. The warn inside `isRootWithin` (`:68`) becomes the plain string
   `Logger.warn('grantBoundary: realpath failed unexpectedly', {`.
3. The map call (`:89`) drops the argument: `normalizedRoots.map((root) => isRootWithin(root, normalizedBounds, signal))`.
4. Delete the empty-input early return at `:84-86` (`if (...length === 0) return [];`) — the fall-through already returns `[]`.

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 11. store / cursor (cuts #24 + #29)

**Cut #24** — [`src/core/store.ts`](../../../src/core/store.ts) (`:71-97` by anchor):

1. `pruneExpiredEntries` becomes a single loop calling `removeEntry`, size-compare return:

   ```ts
   private pruneExpiredEntries(now = Date.now()): boolean {
     const before = this.byUri.size;
     for (const entry of this.byUri.values()) {
       if (isExpired(entry, now)) this.removeEntry(entry.uri);
     }
     return this.byUri.size !== before;
   }
   ```

   (Keep the actual predicate/helper names the live body uses — `isExpired`
   and `removeEntry` are the verified ones.)
2. `enforceLimits` becomes a single loop:

   ```ts
   private enforceLimits(): void {
     while (
       this.byUri.size > 0 &&
       (this.byUri.size > MAX_ENTRIES || this._totalBytes > MAX_TOTAL_BYTES)
     ) {
       this.evictOldest();
     }
   }
   ```

3. Delete the `Logger` import (`:6`) if — after the 5-line invariant
   `Logger.error` branch inside `enforceLimits` is gone — no other `Logger`
   use remains in the file (grep to confirm before removing).

**Cut #29** — [`src/core/cursor.ts:87-109`](../../../src/core/cursor.ts#L87):
the first-page branch of `paginate` re-types its locals five times. Destructure
once; the `produced` object already structurally satisfies what `pageResult`
reads. Replace the block with:

```ts
const produced = await params.produce();
const { items, metadata } = produced;
const incomplete = items.length > params.pageSize || produced.truncated;
const first: Page<T, M> =
  items.length <= params.pageSize
    ? { page: items, metadata, nextCursor: undefined, offset: 0 }
    : pageResult(
        params.store.create({
          queryKey: params.queryKey,
          items,
          metadata,
        }),
        0,
        params.pageSize,
        { items, metadata },
      );
```

Keep the surrounding logic (cursor decode, `incomplete` use) exactly as-is;
only the hand-rebuilt literal and repeated re-typing collapse. If the live
block's `pageResult` call carries different argument shapes, preserve the
live shapes and only collapse the destructuring.

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 12. transport: HTTP factory, CORS collapse, teardown (cuts #7 + #11 + #23)

**Cut #7** — [`src/transport/http.ts`](../../../src/transport/http.ts):

1. Delete `makeHttpModernFactory` (`:83-110`, verified live).
2. At the sole call (`:328-337`, verified live) pass the body verbatim as the
   anonymous first argument to `createMcpHandler`, reading
   `options`/`sharedRegistry`/`sharedPathGuard`/`sharedStore`/`sharedPageStore`/`apiKey`
   from the enclosing `startHttpServer` closure, with
   `notifier: modernHandler.notify` replacing the `getNotifier()` indirection
   (the same deferred closure-read the `sharedStore` constructor callback at
   `:313` already uses):

   ```ts
   const modernHandler: McpHttpHandler = createMcpHandler(
     async ({ era }) => {
       const c = await createServer(options, {
         watcherRegistry: sharedRegistry,
         notifier: modernHandler.notify,
         pathGuard: sharedPathGuard,
         resourceStore: sharedStore,
         pageStore: sharedPageStore,
         era,
         ...(apiKey !== undefined ? { apiKey } : {}),
       });
       const previousOnClose = c.mcp.server.onclose;
       c.mcp.server.onclose = () => {
         previousOnClose?.();
         c.disposeRuntimeState();
       };
       return c.mcp;
     },
     {
       legacy: 'reject',
       onerror: (error: Error) => {
         Logger.error('[HTTP] modern leg error:', formatUnknownErrorMessage(error));
       },
     },
   );
   ```

3. Remove `McpServerFactory` from the type import at `:7` (`ServerNotifier`
   stays — used at `:119` and `:354`).

**Cut #23** — same file: the teardown trio is written twice with log strings
differing only in suffix. Replace the close override (`:374-391`, verified
live) and fold the `listen` `onError` body (`:394-402`) onto one helper:

```ts
const teardown = (): Promise<void> => {
  sharedRegistry.destroy();
  sharedPageStore.clear();
  return modernHandler.close().catch((err: unknown) => {
    Logger.error('[HTTP] Error closing handler:', formatUnknownErrorMessage(err));
  });
};
const originalClose = httpServer.close.bind(httpServer);
httpServer.close = function (callback?: (error?: Error) => void) {
  void teardown().then(() => {
    originalClose(callback);
  });
  return httpServer;
};
```

and the `onError` handler becomes:

```ts
const onError = (err: Error) => {
  void teardown();
  reject(err);
};
```

(The two former log suffixes merge into the one string above — one teardown,
one message.)

**Cut #11** — [`src/transport/http-policy.ts:328-380`](../../../src/transport/http-policy.ts#L328):
collapse `reflectAllowedOrigin` + `corsOriginMiddleware` + `corsPreflightHandler`
into one exported middleware (merge the doc comments — the reflection rationale
and the SEP-2243 header note both stay):

```ts
/** Mounted at the `/mcp` prefix: every response — not just the OPTIONS preflight —
 * carries `Access-Control-Allow-Origin` for an allowed Origin, and the preflight
 * answers only the exact endpoint. Mounted at a prefix, Express rewrites `req.url`
 * to the remainder, so `req.path` is mount-relative: `/` means `/mcp` and `/mcp/`
 * — exactly what the old exact-path `app.options('/mcp')` route matched — while
 * `/sub` stays a subpath and falls through to the same 404 it gets today, not a
 * phantom preflight. The allow-list carries the SEP-2243 standard headers
 * (`mcp-protocol-version`, `mcp-method`, `mcp-name`): SDK clients send all three
 * on every modern request POST and `createMcpHandler` requires them (400 /
 * -32020), so omitting them here would fail every browser preflight. */
export function corsMiddleware(allowedOriginHostnames: readonly string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin, allowedOriginHostnames)) {
      res.header('Access-Control-Allow-Origin', origin);
      // Key the response by Origin so a CDN/proxy caching one origin's response
      // cannot replay it for a different origin (cache-poison).
      res.header('Vary', 'Origin');
    }
    if (req.method !== 'OPTIONS' || req.path !== '/') {
      next();
      return;
    }
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, mcp-protocol-version, mcp-method, mcp-name',
    );
    res.status(204).end();
  };
}
```

(Header values copied from the live `corsPreflightHandler`, verified at HEAD.
The `req.path !== '/'` guard is load-bearing: without it, mounting the preflight
on `app.use('/mcp', ...)` prefix-matches, and an `OPTIONS /mcp/foo` that today
falls through to the default 404 would get a 204 — a silent behavior change.
Express mount semantics verified against the installed express: mounted at
`/mcp`, requests to `/mcp` and `/mcp/` both yield `req.path === '/'`; `/mcp/foo`
yields `req.path === '/foo'`.)

Then in [`src/transport/http.ts:144-145`](../../../src/transport/http.ts#L144-L145)
replace BOTH mounts — `app.options('/mcp', corsPreflightHandler(...))` and
`app.use('/mcp', corsOriginMiddleware(...))` — with the single
`app.use('/mcp', corsMiddleware(allowedOriginHostnames));` (the OPTIONS
intercept now happens inside the middleware, still ahead of the rate limiter),
and in the same file's import block (`:41-42`) replace the `corsOriginMiddleware,`
and `corsPreflightHandler,` entries with one `corsMiddleware,` — the old names
no longer exist, so leaving them fails type-check (TS2305) and the new
identifier stays unresolved.

Test rewrite — [`__tests__/http-policy.test.ts`](../../../__tests__/http-policy.test.ts):

1. `:14` import: `corsPreflightHandler` → `corsMiddleware`.
2. `createMockRequest` (`:85-100`) options type gains `method?: string;` and
   `path?: string;`; the returned object gains `method: options.method,` and
   `path: options.path,`.
3. TC-SEC-031 (`:403-464`, verified live): construct via
   `corsMiddleware(['app.example.com'])`, rename the `it` title's
   `corsPreflightHandler` → `corsMiddleware`, and add `method: 'OPTIONS', path: '/'`
   to all four `createMockRequest` calls. Existing assertions unchanged.
   Then extend the same `it` (do NOT add a new test — the 277 count must hold)
   with the subpath case the guard exists for, after the existing case 4:

   ```ts
   // 5. OPTIONS on a subpath falls through — the preflight stays on the exact
   // endpoint; no phantom 204. Origin reflection still happens, same as the
   // live corsOriginMiddleware mount.
   const reqSubpath = createMockRequest({
     method: 'OPTIONS',
     path: '/sub',
     headers: { origin: 'http://localhost:3000' },
   });
   const resSubpath = createMockResponse();
   let subpathNext = false;
   handler(reqSubpath, resSubpath, () => {
     subpathNext = true;
   });
   assert.strictEqual(subpathNext, true);
   assert.strictEqual(resSubpath.ended, false);
   assert.strictEqual(resSubpath.statusCode, undefined);
   assert.strictEqual(resSubpath.headers['access-control-allow-methods'], undefined);
   assert.strictEqual(
     resSubpath.headers['access-control-allow-origin'],
     'http://localhost:3000',
   );
   ```

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 13. tools/resources: delete-file reassembly, define.ts plumbing, resource completion (cuts #9 + #12 + #13 + #17)

**Cut #9** — [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts),
index-addressed reassembly (all anchors verified live):

1. Phase 1 (`:305-316`) becomes:

   ```ts
   const out = new Array<DeletePerPathResult | undefined>(paths.length).fill(undefined);
   const plans: { plan: DeletePlan; index: number }[] = [];
   for (const { index, value: r } of planned.results) {
     if (r.status === 'fail') out[index] = { path: r.failure.path, error: r.failure.error };
     else if (r.status === 'noop') out[index] = { path: r.item.path, value: { deleted: true } };
     else plans.push({ plan: r.plan, index });
   }
   for (const { index, error } of planned.errors) {
     out[index] = {
       path: paths[index] ?? '(unknown)',
       error: { code: ErrorCode.UNKNOWN, message: error.message },
     };
   }
   ```

2. `pendingSorted` (`:323`) becomes
   `const pendingSorted = [...new Set(plans.filter((p) => p.plan.pending).map((p) => p.plan.validPath))].sort();`
3. Phase 2 executor (`:350-355`): the input array is now the wrapper objects, so the callback becomes `({ plan }) => executePlan(plan, args, ctx, pendingSorted)`.
4. Phase 2 result collection (`:357-381`): delete the `byPath` Map, the
   `record` closure, both early-staging loops, and the `planByRequested`
   fallback. The executed loops write by original index:

   ```ts
   for (const { index, value: r } of executed.results) {
     const slot = plans[index]?.index;
     if (slot === undefined) continue;
     if ('skipped' in r) {
       out[slot] = { path: r.path, value: { deleted: false } };
     } else if ('failure' in r) {
       out[slot] = { path: r.failure.path, error: r.failure.error };
     } else if (r.item.path) {
       out[slot] = { path: r.item.path, value: { deleted: true } };
     }
   }
   for (const { index, error } of executed.errors) {
     const slot = plans[index]?.index;
     if (slot === undefined) continue;
     out[slot] = {
       path: paths[slot] ?? '(unknown)',
       error: { code: ErrorCode.UNKNOWN, message: error.message },
     };
   }
   ```

5. Final assembly (`:383-396`) becomes:

   ```ts
   const results: DeletePerPathResult[] = paths.map((requested, i) => {
     const entry = out[i];
     return (
       entry ?? {
         path: requested,
         error: { code: ErrorCode.UNKNOWN, message: 'Unknown delete failure' },
       }
     );
   });
   ```

6. Keep the duplicate-paths comment at `:293-294` and the pending-set comment
   at `:318-322`. `DeletedItem`/`DeleteFailure` types STAY (other users at
   `:124-125`, `:214`, `:268`).

**Cut #12** — [`src/tools/define.ts`](../../../src/tools/define.ts) (anchors verified live):

1. Delete `#progressClosed = false;` (`:221`) and the `if (this.#progressClosed) return;` guard in `#tick` (`:256`) — ProgressSession already drops post-terminal work.
2. Delete `#closeWithDone` (`:265-269`) and `#closeWithFail` (`:271-275`).
3. `completeProgress` (`:281-286`) ends with
   `this.#progressSession.complete(plainMessage('done', doneCtx)); await this.#flushProgress();`
   (keep the `doneCtx` build verbatim).
4. `failProgress` (`:288-291`) becomes
   `const message = plainMessage('fail', { ...this.#progressCtx, error: errMsg }); this.#progressSession.fail(error, message); await this.#flushProgress();`
   (rest of the method unchanged). Keep `#flushProgress` (`:277-279`).
5. `execute()` (`:372-400`): delete the `runTool` arrow, hoist the
   try/catch/finally body directly into `execute()` (dedent one level; drop
   `return runTool();`).

**Cut #13** — same file:

1. Constructor (`:229-230` verified live) becomes:

   ```ts
   this.signal = def.timeoutMs
     ? AbortSignal.any([ctx.signal, AbortSignal.timeout(def.timeoutMs)])
     : ctx.signal;
   this.#progressCtx = def.progress ? def.progress(parsedArgs) : { label: def.title };
   ```

   Delete `resolveProgressCtx` (`:176-181`) and `composeSignal` (`:183-186`).
2. Delete `createServerToolHandler` (`:403-409`); its call at `:517` inlines:

   ```ts
   register(deps: ToolDeps): RegisteredTool {
     return deps.server.registerTool(
       def.name,
       toolDefShape,
       async (args, ctx) =>
         new ToolExecutor<I, O>(def.name, toToolCtx(ctx, deps), def, args).execute(),
     );
   },
   ```

3. Replace `const tool: DefinedTool = { ... }; return tool;` (`:512-521`) with a direct `return { name: def.name, annotations: def.annotations, register(...) {...} };`.

**Cut #17** — [`src/resources.ts`](../../../src/resources.ts) (anchors verified live):

1. `TemplateResourceContract.complete` (`:143-147`) becomes
   `complete?: { path: CompleteResourceTemplateCallback };` — NOT a
   `Record<string, ...>` (the test seam below breaks under
   `noPropertyAccessFromIndexSignature` + `noUncheckedIndexedAccess`).
   Add `CompleteResourceTemplateCallback` to the `@modelcontextprotocol/server`
   type import block (`:1-12`); drop `UriTemplate` from the value import (`:13-21`).
2. The contract's `complete` method (`:256-263`) becomes:

   ```ts
   complete: {
     // Both ends speak the `{+path}` form (see encodeFileUriPath), not raw OS
     // paths: the partial arriving here is whatever this returned last, so the
     // decode mirrors the encode. An undecodable partial is matched as typed.
     path: async (value) => {
       const suggestions = await completer.suggest(decodeFileUriPath(value) ?? value);
       return suggestions.map(encodeFileUriPath);
     },
   },
   ```

3. `registerResources` (`:441-457`): drop the `Object.fromEntries(new UriTemplate(...).variableNames.map(...))` fan-out — the template literal becomes

   ```ts
   const template = new ResourceTemplate(contract.uriTemplate, {
     list: contract.list,
     ...(contract.complete ? { complete: contract.complete } : {}),
   });
   ```

4. Test claimer — [`__tests__/resources.test.ts:657`](../../../__tests__/resources.test.ts#L657) becomes
   `const suggestions = await fileContract.complete.path(encodeFileUriPath(join(root, 'has#')));`
   (the `:653` assert stays).

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 14. entry points: index / cli / prompts / server (cuts #18 + #22 + #27 + #32 + #37 + #38 + #39 + #43)

**Cut #18** — [`src/index.ts`](../../../src/index.ts) (`:83-101` verified live):
`main()`'s 8 bare `let` bindings and per-field copies collapse to one typed
`let` plus a destructure after the catch (every catch path returns or
throws, so definite-assignment holds):

```ts
async function main(): Promise<void> {
  let parsed: Awaited<ReturnType<typeof parseArgs>>;
  try {
    parsed = await parseArgs();
  } catch (error: unknown) {
    // lines 102-111 unchanged (the CliExitError branch and rethrow)
  }
  const { allowedDirs, allowCwd, port, readOnly, printConfig, json, httpHost, apiKey } = parsed;
```

Then delete `:114` (`const apiKey = cliApiKey;`) and both spreads become
`...(apiKey !== undefined ? { apiKey } : {})` — at the `runPrintConfig` call
(`:122`) and the `runtimeConfig` literal (`:143`).

**Cut #39**:

1. [`src/cli.ts:23-31`](../../../src/cli.ts#L23) (verified live):

   ```ts
   export class CliExitError extends Error {
     constructor(message: string) {
       super(message);
       this.name = 'CliExitError';
     }
   }
   ```

2. Strip the trailing `, 1` from every construction — verified live at
   `cli.ts:35`, `cli.ts:42` (a standalone `1,` line inside the wrapped
   `isWindowsDriveRelativePath` throw — delete the line, the call collapses),
   `cli.ts:47`, `cli.ts:104`, `cli.ts:202`, `cli.ts:220`. Grep
   `CliExitError(` for any others; strip all.
3. [`src/index.ts:107`](../../../src/index.ts#L107): `process.exitCode = error.exitCode;` → `process.exitCode = 1;` (lands with cut #18 in the same edit).

**Cut #27** — [`src/index.ts:56-79`](../../../src/index.ts#L56) (verified live),
the `shutdown()` try body:

```ts
  try {
    try {
      await activeHttpServer?.[Symbol.asyncDispose]();
    } catch (error: unknown) {
      logRuntimeFailure('shutdown_http_error', 'process', 'shutdown', error);
    }
    try {
      await activeStdioHandle?.close();
    } catch (error: unknown) {
      logRuntimeFailure('shutdown_mcp_error', 'process', 'shutdown', error);
    }
  } finally {
    clearTimeout(timer);
  }
```

(`Symbol.asyncDispose` takes NO arguments; the outer try/finally with
`clearTimeout` is preserved.)

**Cut #32** — [`src/cli.ts:158`](../../../src/cli.ts#L158): delete
`const vals = parsed.values as Record<string, unknown>;`, keep the 6-line
comment (`:159-163`) verbatim, and rebuild the block typed (verified live
`CLI_PARSER_CONFIG` at `:109-131`; the old `typeof`/`as` guards must go —
`no-unnecessary-condition` is live for `src/**`):

```ts
const v = parsed.values;
const httpHost = v['http-host'] ?? process.env['FS_HTTP_HOST'];
const apiKey = v['api-key'] ?? process.env['FS_API_KEY'];
if (v['log-level'] !== undefined) cli.logLevel = v['log-level'];
if (v['max-file-size'] !== undefined) cli.maxFileSize = v['max-file-size'];
if (v['root-boundary'] !== undefined) cli.rootBoundary = v['root-boundary'];
if (v['allow-sensitive']) cli.allowSensitive = true;
if (v['walk-cwd']) cli.allowCwdWalk = true;
if (v['allow-missing-roots']) cli.allowMissingRoots = true;
if (v['deny'] !== undefined) {
  const denyPatterns = [...new Set(v['deny'].map((entry) => entry.trim()).filter(Boolean))];
  if (denyPatterns.length > 0) cli.denyPatterns = denyPatterns;
}

const allowCwd =
  v['allow-cwd'] ||
  v['walk-cwd'] ||
  parseTrueEnvFlag(process.env['FS_ALLOW_CWD_WALK'], 'FS_ALLOW_CWD_WALK');
const readOnly = v['read-only'] || v['safe'];
const printConfig = v['print-config'];
const json = v['json'];
const port = parsePortOption(v['port'] ?? process.env['FS_PORT']);
const allowMissingRoots =
  v['allow-missing-roots'] ||
  parseTrueEnvFlag(process.env['FS_ALLOW_MISSING_ROOTS'], 'FS_ALLOW_MISSING_ROOTS'];
```

(last line closes with `);` — `parseTrueEnvFlag(process.env['FS_ALLOW_MISSING_ROOTS'], 'FS_ALLOW_MISSING_ROOTS')`.)

**Cut #22** — [`src/prompts.ts`](../../../src/prompts.ts) (verified live):

1. Delete `topicArg` (`:23-37`) and `userText` (`:39-46`); inline both at
   their single call sites. The `argsSchema` entry (`:61-64`) becomes:

   ```ts
   topic: completable(
     // No content validation beyond non-empty: the handler resolves a topic by
     // `Object.hasOwn` against a frozen record, so anything unrecognized already
     // falls through to the not-found reply without reaching an interpreter.
     z
       .string()
       .min(1, { message: 'Topic required' })
       .describe(
         `Section key to filter instructions (one of: ${topics.join(', ')}); omit to return all instructions.`,
       ),
     (value) => {
       const lower = value.toLowerCase();
       return lower ? topics.filter((t) => t.startsWith(lower)) : [...topics];
     },
   ).optional(),
   ```

2. The `messages` entry (`:81`) becomes:

   ```ts
   messages: [
     {
       role: 'user',
       content: { type: 'text', text, annotations: { audience: ['assistant'], priority: 1 } },
     },
   ],
   ```

3. Drop `PromptMessage` and `TextContent` from the type import (`:1-6` →
   `import type { GetPromptResult, McpServer } from '@modelcontextprotocol/server';`).
   Delete the `// --- Helpers ---` section header if the section is now empty.

**Cut #37** — [`src/prompts.ts`](../../../src/prompts.ts): delete the
3-line `if (topic && !section) { Logger.debug('get-help: unknown topic requested', { topic }); }`
block (verified live at `:71-73`) and the `Logger` import (`:11`) — the
not-found reply already reports the topic and the valid set.

**Cut #38** — [`src/server.ts`](../../../src/server.ts) (verified live):
delete `public readonly resources: ResourceStore;` (`:37`), the
`resources: ResourceStore,` constructor param (`:47`), the
`this.resources = resources;` assignment (`:55`), and the `resourceStore,`
argument at the single construction (`:205`) — `ownsPages` and
`resourceDisposable` slide up as the 4th/5th args there. The local
`resourceStore` (`:163`) STAYS (it feeds `deps`).

**Cut #43** — same file: delete the
`import { GuardedFileSystem } from './core/fs.js';` line (`:9`),
`public readonly fs: GuardedFileSystem;` (`:35`), and
`this.fs = new GuardedFileSystem(pathGuard);` (verified live at `:53` —
`:51` is `this.mcp = mcp;`, `:56` is `this.ownsPages = ownsPages;`).
Test half — [`__tests__/core-fs.test.ts`](../../../__tests__/core-fs.test.ts):
add `import { GuardedFileSystem } from '../src/core/fs.js';`, add
`let fs: GuardedFileSystem;` beside the `ctx` declaration (`:20`), add
`fs = new GuardedFileSystem(ctx.pathGuard);` after the `createTestServer`
call in `before` (`:24`), and replace every `ctx.fs.` read with `fs.`
(`ctx` stays — `after` uses `ctx.disposeRuntimeState()` and `ctx.mcp.close()`).

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 15. Tests-only: inspector fixtures + mock response (cuts #3 + #21 + #30)

**Cut #3** — delete [`__tests__/inspector-fixtures.ts`](../../../__tests__/inspector-fixtures.ts) (52 lines; both exports' behavior already covered by `bootHttpTest` in helpers).

[`__tests__/inspector-http.test.ts`](../../../__tests__/inspector-http.test.ts) (verified live):

1. Drop the `node:http` and `node:net` type imports (`:2-3`), the local
   `TEST_API_KEY` const (`:17`), and the fixtures import (`:7`).
2. Add `import { bootHttpTest, TEST_API_KEY, type HttpTestContext } from './helpers.js';`
   (multi-line import shape, prettier sorts it).
3. `let server: Server;` (`:15`) → `let http: HttpTestContext;`; `let serverUrl: string;` STAYS but is now assigned `http.base.href`.
4. `before` (`:19-26`): after `createTestRoot()`,
   `http = await bootHttpTest([tmpDir]); serverUrl = http.base.href;`
   (drop the `startInspectorHttp` call and port arithmetic).
5. `after` (`:28-33`): `if (http) { await http.close(); }` replaces the
   server.close promise; keep `cleanupTestRoot(tmpDir)`.

[`__tests__/inspector-config.test.ts`](../../../__tests__/inspector-config.test.ts) (verified live):

1. Drop the fixtures import (`:8`); add
   `import { writeFile } from 'node:fs/promises';` (first import position).
2. Replace the `createInspectorConfigFile` call (`:28-33`) with the direct write
   (same JSON, `null, 2` spacing, `'utf-8'`):

   ```ts
   await writeFile(
     configFile,
     JSON.stringify(
       {
         mcpServers: {
           [SERVER_NAME]: {
             command: process.execPath,
             args: ['--import', 'tsx', srcIndex, tmpDir],
             protocolEra: 'modern',
             roots: [{ uri: rootUri, name: 'dynamic-root' }],
           },
         },
       },
       null,
       2,
     ),
     'utf-8',
   );
   ```

   The `repoRoot`/`srcIndex`/`rootUri` locals above it stay.

**Cut #21** — [`__tests__/http-policy.test.ts`](../../../__tests__/http-policy.test.ts) (verified live):

1. Delete the `writeHead(...)` declaration (`:35`) and narrow the next line to `end(): MockResponse;` (`:36`).
2. Delete the 9-line `writeHead` implementation (`:65-73`) and replace the `end(chunk?: string)` implementation (`:74-80`) with `end() { this.ended = true; return this; }`.

**Cut #30** — [`__tests__/helpers.ts`](../../../__tests__/helpers.ts) (verified live):

1. `createElicitationClientPair`'s options type (`:171`) becomes
   `{ noElicitation?: boolean } = {}` (keep the `noElicitation` doc comment
   at `:165-170`; drop `readOnly?: boolean`); both `...readOnlyOpts(options)`
   spreads inside it (`:174`, `:180`) go away. The `readOnlyOpts` helper
   itself (`:84-86`) STAYS — `createTestServer` at `:102` still uses it.
2. `createTestHttpHarness` signature (`:227-230`) becomes the one-line
   `export async function createTestHttpHarness(allowedDirs: string[]): Promise<TestHttpContext> {`
   and its `createServer` call (`:242-257`) becomes:

   ```ts
   const handler = createMcpHandler(
     async () => {
       const serverCtx = await createServer(
         { cliAllowedDirs: allowedDirs },
         { watcherRegistry: sharedRegistry, notifier },
       );
       return serverCtx.mcp;
     },
     { bus, legacy: 'reject' },
   );
   ```

**Verify**: `npm run check` → exit 0, `pass 277`, `fail 0`.

### 16. Docker residue + final full gate (cut #31 + gate)

1. Delete [`docker-compose.yml`](../../../docker-compose.yml) (7 lines).
2. Delete its dangling entry in [`.dockerignore:29`](../../../.dockerignore#L29).
   Nothing references it (CI and release build straight off the Dockerfile;
   README and `server.json` document the real `docker run` invocation).
3. Confirm nothing live references `tasks.mjs`:
   `git grep -n "tasks.mjs" -- ':!docs'` → no hits.
   (`git grep` searches tracked files only, so the untracked plan dir and
   scratch files never match; `:!docs` skips the archived plan history under
   `docs/plan/`, which quotes the old command deliberately. Verified at HEAD:
   every tracked hit outside `docs/` is a file step 1 rewrites — ci.yml,
   AGENTS.md, CONTRIBUTING.md, README.md, package.json — plus
   `scripts/tasks.mjs` itself, deleted in step 1.)
4. Final gate: `npm run check` → exit 0, `pass 277`, `fail 0`, and
   `git status` shows only files from the in-scope list.

## Done

All must hold:

- [ ] `npm run check` exits 0 with `pass 277` and `fail 0`
- [ ] `npm test` alone exits 0, `pass 277`
- [ ] `git grep -n "tasks.mjs" -- ':!docs'` returns nothing
- [ ] `git status` shows no files outside the in-scope list
- [ ] `git diff --stat` shows a net line deletion (expected ≈ −677, ±40 for prettier reflow)
- [ ] `package.json` `"version"` and `server.json` `"version"` are byte-identical to `1806f037`

## STOP

Stop and report if:

- A linked symbol/quoted text does not exist where its anchor says (grep the
  symbol first; only a missing symbol stops the run).
- A step's `npm run check` fails twice after one fix attempt — the step's
  assumption is wrong, not its implementation.
- Any fix requires a file outside the in-scope list.
- The test count drops below 277 pass, or any previously-passing test starts
  failing — a "simplification" that changes observable behavior is wrong by
  definition; restore and report.
- Knip flags an unused export that this plan did not pair with an un-export
  (#46, #44) — do not paper over it by re-adding callers.
- Any edit would remove input validation, a security guard, or error handling
  that prevents data loss (the audit's refusers protected these on purpose).

## Notes

- What a reviewer should scrutinize: step 12's OPTIONS interception moving
  inside one middleware (must still fire before the rate limiter, and the
  `req.path === '/'` guard must keep it endpoint-exact — `OPTIONS /mcp/sub`
  must keep falling through to the 404 it gets today), step 13's
  index-addressed delete reassembly (output order must match input order
  exactly), and step 14's `parsed` definite-assignment (the catch must end in
  return/throw on every path).
- Two known handoff errata, already corrected in this plan: cut #39's throw
  sites are at `cli.ts:202/:220` (not 195/213), and cut #43's assignment is at
  `server.ts:53` (not 51).
- Nothing deferred. Rollback: `git checkout -- .` per step, or
  `git reset --hard 1806f037` for the whole effort (no migrations, no data).
