# Plan: cut the 22 verified over-engineering residues left by the 2026-09-09 audit

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `f7e47a1d`, 2026-09-09.
> **Drift check (run first)**: `git diff --stat f7e47a1d..HEAD -- src/ __tests__/`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

The 2026-09-09 adversarial audit (72 agents, two refuters per finding, both
required to fail) confirmed 22 over-engineering residues that the three prior
cuts (8524d341, f7e47a1d, 6cedcca9) left behind: write-only state fields,
dead defensive branches, knobs every caller sets to the same constant, and
values recomputed that an earlier layer already computed and discarded. Each is
delete-only or thread-through — no new abstractions. Total ~150 lines removed,
no behavior change except one deliberate fix (step 2 propagates aborts instead
of silently dropping grant roots).

Requirements covered: none, this is a refactor. No wire-schema, CLI, or
config surface changes: every cut is internal-only (verified per finding).

## Current state

Baseline at `f7e47a1d`: `node scripts/tasks.mjs test` → `tests 277 · suites 61
· pass 277 · fail 0`. Working tree clean.

Conventions to match:

- Errors are the `Problem` shape in [`src/core/errors.ts`](../../../src/core/errors.ts) (`{code, message, path?, suggestion?}`); throw `FsError`, never plain `Error`, except `cli.ts` which predates the guard and throws plain `Error` at startup.
- Optional output fields use the conditional-spread idiom: `...(x !== undefined ? { x } : {})` — see [`search-content.ts:160-170`](../../../src/tools/search-content.ts#L160-L170).
- Compiled RE2 regexes own wasm memory and are always freed in a `finally` — see the exemplar at [`search-content.ts:326-332`](../../../src/tools/search-content.ts#L326-L332).
- Cuts are verified by grep as well as tests: `git grep -n "<symbol>" src/` returning empty is a done-condition.

Per-step excerpts are inlined in each step. The load-bearing cross-file facts:

- [`src/core/read.ts`](../../../src/core/read.ts) exports `ReadSpec` (line 77) consumed by exactly two producers: [`tools/read.ts:140-146`](../../../src/tools/read.ts#L140-L146) (`buildReadSpec`) and [`core/fs.ts:241-247`](../../../src/core/fs.ts#L241-L247) (`readEditableText`). Both pass `encoding: 'utf-8'`, `maxSize: getMaxTextFileSize()`, `skipBinary: true`. No test passes any of the three (grep of `__tests__` for `skipBinary|maxSize` → only an unrelated `transfer-encoding` header assert).
- [`src/core/path.ts:110-113`](../../../src/core/path.ts#L110-L113) defines `AllowedDirectoriesState {primary, expanded}`. `git grep -n "\.primary" src/ __tests__/` → one hit, the writer at [`path.ts:231`](../../../src/core/path.ts#L231). Every reader uses `.expanded` (lines 258, 360, 497, 516).
- [`src/tools/define.ts:426`](../../../src/tools/define.ts#L426) is the only `toToolCtx` caller; the SDK types its `ctx` parameter non-optional.

## Commands

| Purpose   | Command | Expected on success |
| --------- | ------- | ------------------- |
| Full check | `node scripts/tasks.mjs test` | exit 0, `pass 277 fail 0` |
| Static checks | `node scripts/tasks.mjs --quick` | exit 0 (build, both type-checks, eslint, prettier, knip) |

## Scope

**In scope** — the only files to modify:

- [`src/core/path.ts`](../../../src/core/path.ts) — steps 1–3
- [`src/core/read.ts`](../../../src/core/read.ts), [`src/core/fs.ts`](../../../src/core/fs.ts), [`src/tools/read.ts`](../../../src/tools/read.ts) — steps 4–5
- [`src/core/search.ts`](../../../src/core/search.ts), [`src/tools/search-content.ts`](../../../src/tools/search-content.ts), [`src/tools/search-files.ts`](../../../src/tools/search-files.ts) — steps 6–7
- [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts) — steps 8–9
- [`src/tools/define.ts`](../../../src/tools/define.ts), [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts), [`src/transport/http-policy.ts`](../../../src/transport/http-policy.ts) — steps 10–12
- [`src/tools/edit.ts`](../../../src/tools/edit.ts) — step 13
- [`src/tools/move.ts`](../../../src/tools/move.ts) — step 14
- [`src/cli.ts`](../../../src/cli.ts) — step 15
- [`src/index.ts`](../../../src/index.ts) — step 16
- [`src/prompts.ts`](../../../src/prompts.ts) — step 17
- [`src/core/sensitive.ts`](../../../src/core/sensitive.ts) — step 18
- [`src/core/path-completer.ts`](../../../src/core/path-completer.ts) — step 19
- [`src/core/input-required.ts`](../../../src/core/input-required.ts) — step 20
- [`src/core/store.ts`](../../../src/core/store.ts) — step 21
- [`src/core/errors.ts`](../../../src/core/errors.ts) — step 22
- [`__tests__/core-fs.test.ts`](../../../__tests__/core-fs.test.ts) — step 5 only

**Files out of scope** — leave alone even though they look related:

- [`src/core/concurrency.ts`](../../../src/core/concurrency.ts) — `StoppedReason` stays wide: `replace_text` genuinely emits `maxFiles` (it calls `hitMaxFiles` at line 148). Only the two scan summary types narrow (step 7).
- [`src/core/mime.ts`](../../../src/core/mime.ts) — step 8 deletes a *caller* of `detectMimeFromContent`, not the function (`readRaw` still uses it).
- [`src/core/primitives.ts`](../../../src/core/primitives.ts), [`src/core/path-utils.ts`](../../../src/core/path-utils.ts) — the path-guard satellites; audit confirmed all their exports have callers.
- [`src/resources.ts`](../../../src/resources.ts), [`src/transport/*`](../../../src/transport), [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts) — no cut touches them (the `http-policy.ts` touch in step 11 is one comment line only).
- [`__tests__/helpers.ts`](../../../__tests__/helpers.ts) — `guard.initialize(await resolveAllowedDirectoriesState(dirs))` at line 91 stays source-identical through step 1 (both sides of that call change shape together).

## Steps

### 1. Delete the write-only `AllowedDirectoriesState.primary`

[`path.ts:110-113`](../../../src/core/path.ts#L110-L113):

```ts
export interface AllowedDirectoriesState {
  primary: string[];
  expanded: string[];
}
```

`primary` is written at [`path.ts:231`](../../../src/core/path.ts#L231) and read by nothing. Changes, all in `path.ts`:

1. Delete the interface (lines 110-113).
2. [`resolveAllowedDirectoriesState` (path.ts:174-181)](../../../src/core/path.ts#L174-L181) returns the expanded list directly:
   ```ts
   export async function resolveAllowedDirectoriesState(
     dirs: readonly string[],
     signal?: AbortSignal,
   ): Promise<string[]> {
     const primary = normalizeAllowedDirectories(dirs);
     return expandAllowedDirectories(primary, signal);
   }
   ```
3. `initialize` ([path.ts:229-234](../../../src/core/path.ts#L229-L234)) becomes:
   ```ts
   initialize(expanded: readonly string[]): void {
     this.allowedDirectoriesState = normalizeAllowedDirectories(expanded);
   }
   ```
   The old re-normalization (`[...new Set(state.primary)]` + second `normalizeAllowedDirectories`) was redundant — the only producer already dedups (`normalizeAllowedDirectories` line 127, `expandAllowedDirectories` line 171).
4. The field ([path.ts:199](../../../src/core/path.ts#L199)) becomes `private allowedDirectoriesState: string[] | undefined;`, and the four `.expanded` reads (lines 258, 360, 497, 516) become plain reads of the array. Adjust the comment at line 272 that names `allowedDirectoriesState.expanded`.

`__tests__/helpers.ts:91` keeps compiling unchanged: it passes the new return type straight into the new parameter type.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "primary" src/core/path.ts` → no hits (the local `primaryDirs`/`primary` variables inside `expandAllowedDirectories`/`resolveAllowedDirectoriesState` may keep their names).

### 2. `filterRootsWithin`: plain `Promise.all`, aborts propagate

[`path.ts:88-102`](../../../src/core/path.ts#L88-L102) — the `allSettled` rejected-status warn branch is reachable only via an abort: `isRootWithin` (lines 52-74) swallows every error to a boolean except aborts, which it deliberately rethrows via `rethrowIfAborted`. The current branch then converts that rethrow back into a silent warn-and-drop. Replace lines 88-102 with:

```ts
const results = await Promise.all(
  normalizedRoots.map((root) => isRootWithin(root, normalizedBounds, label, signal)),
);

return normalizedRoots.filter((root, i) => results[i]);
```

**Behavior change, deliberate and the point of the cut**: a `ROOTS_TIMEOUT_MS` abort during the grant-boundary filter now rejects `recomputeAllowedDirectories` instead of silently dropping grant roots and proceeding. No test exercises the timeout-drop path (`git grep -n "ROOTS_TIMEOUT" __tests__/` → empty); the abort propagation matches what `rethrowIfAborted` inside `isRootWithin` already intends.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "allSettled" src/core/path.ts` → empty.

### 3. Make `PathGuard.options` private

[`path.ts:223-227`](../../../src/core/path.ts#L223-L227) — `readonly options: ServerOptions | undefined` has no external reader (`server.ts` reads its own constructor parameter, not `pathGuard.options`). Change to `private readonly options`.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0.

### 4. Delete the `ReadSpec` knobs `encoding`, `maxSize`, `skipBinary`

Every producer passes the same constants, so the knobs are constants in disguise. In [`src/core/read.ts`](../../../src/core/read.ts):

1. Delete `encoding`, `maxSize`, `skipBinary` from all four arms of `ReadSpec` ([lines 77-109](../../../src/core/read.ts#L77-L109)) — each arm keeps `kind` plus its own fields plus `signal?`.
2. `NormalizedBase` ([111-116](../../../src/core/read.ts#L111-L116)) shrinks to `{ maxSize: number; signal?: AbortSignal }`; `ReadContentOptions` ([124-128](../../../src/core/read.ts#L124-L128)) shrinks to `{ maxSize: number; signal?: AbortSignal }`.
3. `buildBaseOptions` ([151-162](../../../src/core/read.ts#L151-L162)) loses the `maxSize` validation branch and both option reads:
   ```ts
   function buildBaseOptions(spec: ReadSpec): NormalizedBase {
     return {
       maxSize: getMaxTextFileSize(),
       ...(spec.signal ? { signal: spec.signal } : {}),
     };
   }
   ```
   The old `Math.min(spec.maxSize ?? max, max)` collapsed to `max` because both producers pass exactly `max`.
4. Every `options.encoding` / `spec.encoding` read becomes the literal `'utf-8'` (lines 422, 465-469, 548, 643 — including the `readFullContent(handle, spec.encoding, ...)` call at 641-647: pass `'utf-8'`).
5. `readNormalized` ([718-720](../../../src/core/read.ts#L718-L720)): the `if (spec.skipBinary)` guard goes; `assertNotBinary` is called unconditionally.
6. `readFileWithStats`'s default at [line 732](../../../src/core/read.ts#L732) still works (`{ kind: 'full' }` needs no knobs).

Callers, same step:

- [`tools/read.ts:133-146`](../../../src/tools/read.ts#L133-L146): delete the `ReadSpecCommon` interface (lines 133-138) and build specs as `{ kind: 'head', lines: head, ...(signal ? { signal } : {}) }` etc. — `buildReadSpec` no longer needs the `getMaxTextFileSize` import; drop it if nothing else in the file uses it (grep first).
- [`core/fs.ts:241-247`](../../../src/core/fs.ts#L241-L247): the `readFileWithStats` spec shrinks to `{ kind: 'full', ...(options?.signal ? { signal: options.signal } : {}) }`. The explicit `TOO_LARGE` pre-check above it (lines 231-240) stays — it carries the tool-specific message.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "skipBinary" -- src/` → empty and `git grep -n "BufferEncoding" -- src/core/read.ts src/tools/read.ts` → empty. (`fs.ts:63/185` — the write path, live via [`patch.ts:130`](../../../src/tools/patch.ts#L130) — and the `readFullContent` parameter type at [read.ts:548](../../../src/core/read.ts#L548) are expected survivors, not failures.)

### 5. Delete `ReadFileResult.truncated`

No production consumer: the read tool never reads it ([`tools/read.ts`](../../../src/tools/read.ts) renders its `// truncated:` text from `continuation`/`hasMoreLines`), it is absent from the published read schema, and the two test asserts duplicate the adjacent `hasMoreLines` asserts.

In [`src/core/read.ts`](../../../src/core/read.ts):

1. Delete `truncated` from `PartialReadResult` ([line 132](../../../src/core/read.ts#L132)) and `ReadFileResult` ([line 140](../../../src/core/read.ts#L140)).
2. Follow `git grep -n "truncated" src/core/read.ts` and remove every remaining construction/destructure: the `readRange`-family return at [line 440](../../../src/core/read.ts#L440) (also delete the now write-only `stoppedByLimit` variable — its only other use was this field), the empty-tail return at 459, the line 540 return, the three destructures at 592, 616, 665 (drop `truncated` from the braces and from the result objects at 603, 627, 675), and `readFull`'s literal `truncated: false` at [line 652](../../../src/core/read.ts#L652).

In [`__tests__/core-fs.test.ts`](../../../__tests__/core-fs.test.ts): delete lines [45](../../../__tests__/core-fs.test.ts#L45) and [81](../../../__tests__/core-fs.test.ts#L81) (`assert.strictEqual(result.truncated, …)`). The `hasMoreLines` asserts on lines 46 and 82 already pin the same value.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "truncated" src/core/read.ts __tests__/core-fs.test.ts` → empty.

### 6. Thread the first-match column through `SearchResult`

[`search-content.ts:173-184`](../../../src/tools/search-content.ts#L173-L184) recomputes the column by re-running the regex (or a hand-rolled `indexOf`) on every matching line, but [`core/search.ts:84-94`](../../../src/core/search.ts#L84-L94) already ran that exact exec and dropped `match.index`.

1. [`core/search.ts:14-19`](../../../src/core/search.ts#L14-L19): add `column: number;` to the `SearchResult` interface.
2. Rename `countLineMatches` ([search.ts:80-94](../../../src/core/search.ts#L80-L94)) to `findLineMatches` and return both facts from the exec loop it already runs:
   ```ts
   function findLineMatches(regex: Regex, line: string): { count: number; column: number } | undefined {
     regex.lastIndex = 0;
     let count = 0;
     let column = -1;
     let match: RE2ExecArray | null;
     while ((match = regex.exec(line)) !== null) {
       if (column === -1) column = match.index;
       count++;
       if (match.index === regex.lastIndex) regex.lastIndex++; // advance past zero-length match
       if (count >= MAX_MATCHES_PER_LINE) break;
     }
     return count > 0 ? { count, column } : undefined;
   }
   ```
3. The call site ([search.ts:190-207](../../../src/core/search.ts#L190-L207)) becomes:
   ```ts
   const found = findLineMatches(regex, line);
   if (found) {
     matchedFile = true;
     matchingLines++;
     matches.push({ file: entry.path, line: i + 1, column: found.column, content: line, matchCount: found.count });
     if (matches.length >= maxResults) break;
   }
   ```
4. In [`search-content.ts`](../../../src/tools/search-content.ts): delete `findColumnOffset` (173-184), the `SearchContext` interface (57-61), the `context` construction (191-195), and the `matcher`/`args` parameters of `buildSortedPayloads` (186-190) — `args` fed only the deleted context. The payload (208-218) sets `column: match.column` unconditionally. The call at [line 329](../../../src/tools/search-content.ts#L329) becomes `buildSortedPayloads(result)`.

Units stay identical: `regex.exec().index` and `String.indexOf()` are both character indices on the same line. The output schema's optional `column` field can stay optional — every payload now supplies it, which is a widening, not a break.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "findColumnOffset\|SearchContext" src/` → empty.

### 7. Narrow the scan summary `stoppedReason` and delete the dead `maxFiles` guards

`searchContent` and `searchFiles` call only `tracker.hitMaxResults()` and `tracker.hitAbort()` ([search.ts:221-223, 320-322](../../../src/core/search.ts#L221-L223)) — never `hitMaxFiles` — a fact [`concurrency.ts:10-16`](../../../src/core/concurrency.ts#L10-L16) already documents. The `!== 'maxFiles'` filters are therefore unreachable branches.

1. [`core/search.ts`](../../../src/core/search.ts): both summary types ([line 126](../../../src/core/search.ts#L126) in `SearchContentOutcome`, [line 289](../../../src/core/search.ts#L289) in the `searchFiles` return) become `stoppedReason?: 'maxResults' | 'timeout';`.
2. Both `const stoppedReason = tracker.resolve();` sites ([224](../../../src/core/search.ts#L224), [323](../../../src/core/search.ts#L323)) need the narrow type; the tracker is typed wide, so assert the documented invariant at each:
   ```ts
   // StopReasonTracker.resolve() is StoppedReason | undefined, but both scans
   // only call hitMaxResults/hitAbort (see concurrency.ts) — never hitMaxFiles.
   const stoppedReason = tracker.resolve() as 'maxResults' | 'timeout' | undefined;
   ```
3. Delete the guard: [`search-content.ts:340-343`](../../../src/tools/search-content.ts#L340-L343) and [`search-files.ts:179-182`](../../../src/tools/search-files.ts#L179-L182) each become
   ```ts
   ...(result.summary.stoppedReason !== undefined ? { stoppedReason: result.summary.stoppedReason } : {}),
   ```

`concurrency.ts` is untouched: `StoppedReason` stays wide and `replace_text` keeps `maxFiles`.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "!== 'maxFiles'" src/` → empty.

### 8. `replace_text`: use the `mimeType` `readRaw` already returned

[`replace-in-files.ts:617-621`](../../../src/tools/replace-in-files.ts#L617-L621) re-derives the MIME through a lossy `Buffer.toString('utf-8')` round trip when [`core/fs.ts:251-271`](../../../src/core/fs.ts#L251-L271) `readRaw` already ran `detectMimeFromContent` on the raw bytes:

```ts
const { content: rawBuffer, mimeType } = await ctx.fs.readRaw(fullPath, {
  signal: ctx.signal,
});
const link = buildFileResourceLink(fullPath, mimeType, rawBuffer.length);
```

Delete the `detectMimeFromContent` call and its import ([line 22](../../../src/tools/replace-in-files.ts#L22)) — confirm `git grep -n "detectMimeFromContent" src/tools/replace-in-files.ts` shows only these two hits before deleting the import.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`.

### 9. `replace_text`: count during the replace pass, delete `count()`

[`buildReplacementPlan` (replace-in-files.ts:313-328)](../../../src/tools/replace-in-files.ts#L313-L328) scans every matching file twice — `count()` for the number, `replace()` for the content — when one pass yields both.

1. The [`ReplacementMatcher` interface (166-172)](../../../src/tools/replace-in-files.ts#L166-L172) loses `count` and its `replace` returns both:
   ```ts
   interface ReplacementMatcher {
     replace(content: string, replacement: string): { content: string; matchCount: number };
     testBuffer(buffer: Buffer): boolean;
     /** Releases any compiled pattern this matcher owns. Idempotent. */
     dispose(): void;
   }
   ```
2. Regex matcher ([215-265](../../../src/tools/replace-in-files.ts#L215-L265)): delete `count` (226-237); both branches of `replace` count in the callback they already run per match —
   ```ts
   replace(content: string, replacement: string): { content: string; matchCount: number } {
     regex.lastIndex = 0;
     let matchCount = 0;
     // Only isRegex=true opts into $1/$& substitution. A literal search reaches
     // this matcher too (case-insensitive and wholeWord both need a regex), and
     // there the replacement must be inserted verbatim.
     if (!expandReplacement) {
       const updated = content.replace(regex, () => {
         matchCount++;
         return replacement;
       });
       return { content: updated, matchCount };
     }
     const updated = content.replace(regex, (match: string, ...rest: unknown[]): string => {
       matchCount++;
       /* existing expandDollarTokens body unchanged */
     });
     return { content: updated, matchCount };
   }
   ```
   `String.replace` visits zero-length matches the same way the old `count()` loop did, so the numbers match.
3. Literal matcher ([268-292](../../../src/tools/replace-in-files.ts#L268-L292)): delete `count` (276-284); `replace` becomes
   ```ts
   replace(content: string, replacement: string): { content: string; matchCount: number } {
     let matchCount = 0;
     const updated = content.replaceAll(searchPattern, () => {
       matchCount++;
       return replacement;
     });
     return { content: updated, matchCount };
   }
   ```
4. `buildReplacementPlan` becomes a single-pass consumer; the zero-match `undefined` contract is kept:
   ```ts
   function buildReplacementPlan(
     content: string,
     replacement: string,
     matcher: ReplacementMatcher,
   ): ReplacementPlan | undefined {
     const { content: updatedContent, matchCount } = matcher.replace(content, replacement);
     if (matchCount === 0) return undefined;
     return { matchCount, originalContent: content, updatedContent };
   }
   ```

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "\.count(" src/tools/replace-in-files.ts` → empty.

### 10. `toToolCtx`: the `!ctx` fallback is dead

[`define.ts:143-155`](../../../src/tools/define.ts#L143-L155) fabricates a `ToolCtx` when `ctx` is undefined, but the SDK invokes tool handlers with a non-optional `ServerContext` and the single caller ([define.ts:426](../../../src/tools/define.ts#L426)) passes it through. Delete the `if (!ctx)` branch and type the parameter `ctx: ServerContext` (drop the `| undefined`).

**Verify**: `node scripts/tasks.mjs --quick` → exit 0.

### 11. Delete `ToolCtx.authInfo` (zero production readers)

Set at [`define.ts:46`](../../../src/tools/define.ts#L46) and [176](../../../src/tools/define.ts#L176); read only by the throwaway `auth_probe` test tool at [`tools.test.ts:301-302`](../../../__tests__/tools.test.ts#L301-L302).

1. Delete the field ([define.ts:46](../../../src/tools/define.ts#L46)) and the spread ([176](../../../src/tools/define.ts#L176)).
2. Delete the `auth_probe` test block in [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts) — the `defineTool({ name: 'auth_probe', … })` registration at ~lines 280-306 and the HTTP-client exercise that calls it (~310-345). Read the surrounding `describe` to find its natural boundaries; if the whole `describe` exists only for this probe, delete the `describe`.
3. Drop the `AuthInfo` import from `define.ts` if nothing else uses it (grep `AuthInfo` in the file first).
4. One comment line in [`http-policy.ts:287-288`](../../../src/transport/http-policy.ts#L287-L288) says tool handlers read the passthrough "as `ctx.http.authInfo`" — after this cut no tool does. Reword to describe only what still happens (the SDK copies `req.auth` into the per-request factory's context); no code change.

The SDK still hands `authInfo` on `ServerContext`, so re-adding a `ToolCtx` field later is a one-line spread.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "authInfo\|auth_probe" src/ __tests__/tools.test.ts` → only the `http-policy.ts` passthrough code and comment.

### 12. `resolveProgressCtx`: no try/catch around pure callbacks

[`define.ts:188-199`](../../../src/tools/define.ts#L188-L199) wraps every tool's `progress(args)` in try/catch + `Logger.warn`, but all 13 callbacks are total functions over Zod-validated args (string builders with `?? ''` fallbacks). Replace the body with:

```ts
function resolveProgressCtx<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
  args: z.infer<I>,
): ProgressCtx {
  if (!def.progress) return { label: def.title };
  return def.progress(args);
}
```

Keep the `Logger` import — `define.ts:265` still uses `Logger.emit`.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "progress threw" src/` → empty.

### 13. `edit.ts`: free the per-edit regex immediately, delete the per-call cache

[`edit.ts:341-368`](../../../src/tools/edit.ts#L341-L368) builds a `regexCache` Map per `applyEdits` call to dedupe compiles of at most 100 patterns (`MAX_EDITS_PER_FILE`) whose cache lifetime is one file's edit pass — a hit needs the same `oldText` twice in one edit list.

1. `findEditMatch` ([177-214](../../../src/tools/edit.ts#L177-L214)) drops its `regexCache` parameter (181) and owns the pattern's lifetime itself:
   ```ts
   const regex = compileRegex(pattern, { caseSensitive: true });
   try {
     regex.lastIndex = 0;
     const match = regex.exec(content);
     if (match === null) return undefined;
     const matched = match[0];
     if (matched === undefined || matched.length === 0) return undefined;
     return { startIndex: match.index, length: matched.length };
   } finally {
     freeRegex(regex);
   }
   ```
   Keep the existing comments about `lastIndex` and the RE2 group-0 typing.
2. `applyEdits`: delete the `regexCache` declaration (349), drop the 4th argument at the `findEditMatch` call (353), and delete the whole `try/finally` wrapper (351-368) — its `finally` only cleaned the cache — leaving the bare `for` loop.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "regexCache" src/` → empty.

### 14. `move.ts`: `buildSummary`'s `skipped` default is dead

[`move.ts:392`](../../../src/tools/move.ts#L392) — `skipped: readonly string[] = []`; the only caller ([move.ts:535](../../../src/tools/move.ts#L535)) always passes it. Delete ` = []` and make the parameter required.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0.

### 15. `cli.ts`: stop matching errors by message substring

[`cli.ts:51-75`](../../../src/cli.ts#L51-L75) — `validateDirectoryPath`'s catch re-throws the not-a-directory error by matching a substring of `assertDirectory`'s message, coupling two functions five lines apart. Replace both with a shape where the check cannot be swallowed:

```ts
async function validateDirectoryPath(inputPath: string, allowMissing = false): Promise<string> {
  const normalized = normalizePath(inputPath);
  let stats: Stats;
  try {
    stats = await stat(normalized);
  } catch (error) {
    // allowMissing suppresses only stat failures (a directory that may not
    // exist yet); it never suppresses "exists but is not a directory".
    if (allowMissing) return normalized;
    throw new Error(`Cannot access directory ${inputPath}: ${formatUnknownErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!stats.isDirectory()) {
    throw new Error(`${inputPath} is not a directory`);
  }
  return normalized;
}
```

Delete `assertDirectory` (51-54). Keep the `Stats` type import.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "is not a directory" src/cli.ts` → exactly one hit (the new throw).

### 16. `index.ts`: `shutdown()` outer catch and `keepForceExitTimer` are dead

[`index.ts:44-86`](../../../src/index.ts#L44-L86) — both awaited cleanups have their own try/catch that only logs, and nothing else in the `try` can throw, so the outer catch (79-80, `'shutdown_error'`) is unreachable and `keepForceExitTimer` is always `false` at the `finally`. Delete the flag (44), the assignment (78), and the outer catch; make the `finally` unconditional:

```ts
try {
  if (activeHttpServer) {
    /* existing inner try/catch, unchanged */
  }
  if (activeStdioHandle) {
    /* existing inner try/catch, unchanged */
  }
} finally {
  clearTimeout(timer);
}
```

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "keepForceExitTimer\|shutdown_error" src/` → empty.

### 17. `prompts.ts`: no error path around an unthrowable body

[`prompts.ts:68-96`](../../../src/prompts.ts#L68-L96) — the `get-help` handler does only `Object.hasOwn`, `toLowerCase`, and string joins on schema-validated args; the try/catch, `ProtocolError` re-wrap, and `Logger.error` around it are dead scaffolding.

1. Delete the `try`/`catch` wrapper (69, 85-95), keep the body verbatim.
2. Imports: line 7 keeps only `completable` (drop `ProtocolError`); delete line 11 entirely (`formatUnknownErrorMessage`, `fsErrorCode`, `hasErrorShape` — `grep` in the file confirms the catch was their only use). Keep the `Logger` import (line 74 still debugs).

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "ProtocolError\|hasErrorShape" src/prompts.ts` → empty.

### 18. `sensitive.ts`: fold `compilePatterns` into `toPatternSet`

[`sensitive.ts:20-81`](../../../src/core/sensitive.ts#L20-L81) — `CompiledPattern` exists only as the intermediate between `compilePatterns` (54-64) and `toPatternSet` (66-81), whose only caller is the `SensitiveMatcher` constructor ([line 164](../../../src/core/sensitive.ts#L164)). Merge into one function and delete the middle shape:

```ts
function toPatternSet(patterns: readonly string[]): CompiledPatternSet {
  const pathGlobs = new Set<string>();
  const nameGlobs = new Set<string>();
  const deduped = Array.from(new Set(patterns.map((p) => p.trim()).filter((p) => p.length > 0)));
  for (const pattern of deduped) {
    const normalized = normalizeForMatch(pattern);
    const matchesPath = normalized.includes('/');
    const target = matchesPath ? pathGlobs : nameGlobs;
    for (const glob of matchesPath ? compilePatternGlobs(normalized) : [normalized]) {
      target.add(glob);
    }
  }
  return { pathGlobs: [...pathGlobs], nameGlobs: [...nameGlobs] };
}
```

Delete `CompiledPattern` (20-23) and `compilePatterns` (54-64); the constructor becomes `this.patterns = toPatternSet(patterns);`.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "CompiledPattern\b\|compilePatterns" src/` → empty (`CompiledPatternSet` stays).

### 19. `path-completer.ts`: `getRootPrefix` re-implements `parseNamedRootInput`

[`path-completer.ts:105-109`](../../../src/core/path-completer.ts#L105-L109) duplicates the parsing that [`parseNamedRootInput` (42-50)](../../../src/core/path-completer.ts#L42-L50) already owns 60 lines above — verified equivalent for every input (empty, leading `/`, `a/b`). Replace the body of `findRootPrefixMatches` (111-117):

```ts
function findRootPrefixMatches(currentValue: string, allowed: readonly string[]): string[] {
  const rootPrefix = parseNamedRootInput(currentValue)?.rootName.toLowerCase() ?? '';
  if (!rootPrefix) return collectAllowedRoots(allowed, () => true);
  return collectAllowedRoots(allowed, (root) =>
    basename(root).toLowerCase().startsWith(rootPrefix),
  );
}
```

Delete `getRootPrefix` (105-109).

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "getRootPrefix" src/` → empty.

### 20. `input-required.ts`: the `defaultValue` chain is never exercised

`choiceInput`'s 4th parameter ([line 119](../../../src/core/input-required.ts#L119)), `PendingInput.defaultValue` ([line 59](../../../src/core/input-required.ts#L59)), and the `default` keyword spread in `buildInputRequired` ([line 176](../../../src/core/input-required.ts#L176)) are dead: both production call sites pass 3 arguments ([delete-file.ts:336-343](../../../src/tools/delete-file.ts#L336-L343), [move.ts:312-321](../../../src/tools/move.ts#L312-L321)) and no test passes a default. Delete all three plus the `A \`defaultValue\` preselects one option.` sentence in the doc comment (line 113). Re-add when a caller wants a preselected option.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "defaultValue" src/core/input-required.ts` → empty.

### 21. `store.ts`: `storedAt` is write-only

[`store.ts:14`](../../../src/core/store.ts#L14) — written in `putText` ([141](../../../src/core/store.ts#L141)), read by nothing (`expiresAt` is the only timestamp any consumer reads; `isExpired` parses it at line 25). Delete the interface field and the `storedAt: storedAt.toISOString(),` line. Keep the `storedAt` local at [line 135](../../../src/core/store.ts#L135) — `expiresAt` is computed from it.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0; `git grep -n "storedAt" src/ __tests__/` → only the local variable inside `putText` and its `expiresAt` use.

### 22. `errors.ts`: delete the caller-less `FsError.get path()`

[`errors.ts:321-323`](../../../src/core/errors.ts#L321-L323) — no code reads `.path` off an `FsError` instance; `formatDetailedError` and `Problem.fromUnknown` both read `error.problem.path`. First confirm: `git grep -nE "(err|error|e)\.path\b" src/ __tests__/` and eyeball that every hit is some other object's `path` property (not an `FsError` receiver). If any hit reads it off an `FsError`, STOP. Otherwise delete the getter (the sibling `get code()` at 317-319 stays — it has readers).

**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`; `git grep -n "get path" src/core/errors.ts` → empty.

## Done

All must hold:

- [ ] `node scripts/tasks.mjs --quick` → exit 0 (build, both type-checks, eslint, prettier, knip clean — knip confirms no import went stale)
- [ ] `node scripts/tasks.mjs test` → exit 0, `pass 277 fail 0`
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `git grep -n "skipBinary" -- src/` → empty and `git grep -n "BufferEncoding" -- src/core/read.ts src/tools/read.ts` → empty (step 4; `fs.ts:63/185` and `read.ts:548` are expected survivors)
- [ ] `git grep -n "regexCache\|auth_probe\|getRootPrefix\|findColumnOffset\|countLineMatches" src/` → empty (steps 6, 11, 13, 19)
- [ ] `git grep -n "keepForceExitTimer\|CompiledPattern\b\|defaultValue" src/core/ src/index.ts` → empty (steps 16, 18, 20)
- [ ] `git grep -n "truncated" src/core/read.ts __tests__/core-fs.test.ts` → empty (step 5)

## STOP

Stop and report if:

- The drift check flags any in-scope file and a [Current state](#current-state) excerpt no longer matches the live code.
- A step's verification fails twice after one fix attempt — a second failure means the step's assumption is wrong, not its implementation.
- The fix appears to require an out-of-scope file (notably: if step 7's narrow type cannot be expressed without touching `concurrency.ts`, or step 1 breaks `__tests__/helpers.ts:91` in a way that requires editing it).
- Step 2's abort propagation breaks any roots/grant test — that would mean a test does exercise the timeout-drop path (the audit found none; a failure says the audit was wrong).
- Step 22's pre-grep finds a genuine `FsError` receiver of `.path`.
- Step 4's knob deletion changes a published tool error message (e.g. a `maxSize` validation error a test asserts on).

## Notes

- What a reviewer should scrutinize: step 2 is the only behavior change (abort propagation at the grant-boundary filter); step 4 removes input validation on `maxSize` — but that input no longer exists, so the trust boundary does not move (the clamp to `getMaxTextFileSize()` is now structural). Step 6 changes `column` from sometimes-absent to always-present on `search_text` payloads — a strict widening of the wire output, but the schema field should stay optional so no release ties the schema to it.
- 11 further audit findings were adversarially refuted and are deliberately NOT in this plan: the read-batch pre-scan (it IS the documented `FS_MAX_READ_MANY_BYTES` enforcement), progress-tick cost when no `progressToken` (settled in the trim-dead-surface plan), progress double-monotonicity (spec-mandated), the adaptive rate-limit window (has a production caller), the case-sensitive literal matcher (raw-byte `indexOf` beats an RE2 compile), the HTTP watcher-slot pre-check (tested boundary behavior), `cli.ts` dedup (different case-folding semantics than the guard), `mime.ts` string branch (has a reachable caller), the hidden-glob fan-out (settled workaround for `fs.glob`), and `isUnsafeCwdPath`'s per-call Set rebuild (not an over-engineering cut). Do not re-add them.
- Rollback: every step is an independent commit-scale change; `git checkout -- <file>` per step, or `git revert` of the step's commit. No migrations, no deletions of user data, no production data touched.