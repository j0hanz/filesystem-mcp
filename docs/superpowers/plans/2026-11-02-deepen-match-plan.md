# Deepen Match Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the **Match plan** module (`src/core/matcher.ts`) so it provides symmetrical, polymorphic matchers for both search and replacement (`LineMatcher` and `ReplacementMatcher`), hiding all RE2 compilation, embind handle lifecycle, multiline prefiltering, and wasm heap bounds behind the Match plan seam.

**Architecture:** Extend `src/core/matcher.ts` with `createLineMatcher`, which encapsulates whole-buffer prefiltering, case-folding bails (U+212A / U+017F), 4 MiB line limits, cooperative macrotask yielding, and dual-regex (`regex` and `prefilter`) wasm handle disposal. Refactor `src/core/search.ts` to consume `LineMatcher` via `forFile(buffer)` and `matchLine(line)`, catching `TOO_LARGE` errors. Finally, internalize low-level regex primitives (`compileRegex`, `freeRegex`, `execMatches`, `createYielder`, `MAX_MATCHES_PER_LINE`, `RE2_MAX_INPUT_BYTES`) so the module's public interface shrinks from 12 exports to 5.

**Tech Stack:** TypeScript 7 native compile (ADR-009), Node test runner (`node --test`), `@adguard/re2-wasm` (fixed 16 MB wasm heap with embind disposal), `GuardedFileSystem`.

**Spec:** The settled decisions from the 2026-11-02 architecture review and grilling session. Domain terms from `GLOSSARY.md` (**Match plan**, **Scan**, **Rewrite**).

## Global Constraints

- Pure architectural deepening: zero wire-visible behavior change; tool schemas and `__tests__/contract.test.ts` must not change.
- Strict tool boundary: callers must never handle raw RE2 embind handles or memory disposal; `LineMatcher.dispose()` and `ReplacementMatcher.dispose()` own wasm memory cleanup.
- Deliberate divergences preserved verbatim: `wholeWord` remains replace-only; too-large skips unread (search) vs `TOO_LARGE` fail (replace); whole-buffer multiline prefiltering is search-only; `maxResults` (search) vs `maxMatches` (replace).
- "The interface is the test surface": unit tests in `__tests__/matcher.test.ts` must test through `createLineMatcher` and `createReplacementMatcher` rather than shallow internal helpers.
- `npm run check` (static checks + tests) must pass at the end of every task.
- No version bumps — the Release workflow owns them.

## Review Focus

1. **Wasm heap exhaustion on long lines:** a single line past `RE2_MAX_INPUT_BYTES` (4 MiB) in regex mode must throw `FsError(ErrorCode.TOO_LARGE)`, which `searchContent` catches and reports as `skippedTooLarge` instead of triggering a fatal wasm OOM abort.
2. **Buffer-anchor regex prefilter bypassing:** a regex containing `\A`, `\z`, or `\Z` cannot soundly be prefiltered with multiline `m` flag; `testBuffer` must fall through and allow line-by-line scanning without false negatives.
3. **Carriage-return `$` boundary interaction:** a buffer containing `\r\n` and a pattern containing `$` cannot soundly use multiline prefilter because `$` in RE2 cannot see past `\r`; `testBuffer` must fall through to line scanning.
4. **Fold character fallback (U+212A / U+017F):** a case-insensitive literal needle (e.g. `'kelvin'`) on a file containing `\u212A` must fall back from native literal matching to RE2 in `forFile(buffer)` so occurrences of the Kelvin sign match.
5. **Deterministic wasm disposal on all search exits:** `LineMatcher.dispose()` must release embind handles for both primary `regex` and `prefilter` in `finally`, even when `scan` is aborted by `AbortSignal` or stopped early by `maxResults`.

---

### Task 1: Sharpen Domain Glossary in GLOSSARY.md

**Files:**

- Modify: `GLOSSARY.md:47-57`

**Interfaces:**

- Consumes: Current glossary definition of **Match plan**.
- Produces: Updated glossary definition explicitly naming `LineMatcher` and `ReplacementMatcher` as the symmetrical interfaces produced by the module.

- [x] **Step 1: Write the updated Match plan glossary definition in `GLOSSARY.md`**

Replace the **Match plan** entry with:

```markdown
**Match plan**:
What a text search or a replacement settles about its needle before any text
is read: which engine judges it — a native literal pass or the regex engine —
under the flags, and the per-text bails that hand judgment to the regex
engine (a fold character in the text; U+FFFD or a lone surrogate in the
needle). The module produces symmetrical, polymorphic matchers —
`LineMatcher` for line-oriented search and `ReplacementMatcher` for rewrites —
so a preview judges exactly what its replacement will touch.
_Avoid_: matcher selection, dispatch, engine choice, fast path
```

- [x] **Step 2: Verify GLOSSARY.md formatting**

Run: `git diff GLOSSARY.md`
Expected: Clean diff sharpening the definition without disturbing neighboring terms.

- [x] **Step 3: Commit**

```bash
git add GLOSSARY.md
git commit -m "docs(glossary): sharpen Match plan definition with LineMatcher and ReplacementMatcher"
```

---

### Task 2: Implement `createLineMatcher` in `src/core/matcher.ts`

**Files:**

- Modify: `src/core/matcher.ts`
- Test: `__tests__/matcher.test.ts`

**Interfaces:**

- Consumes: `planMatch`, `compileRegex`, `freeRegex`, `execMatches`, `createYielder`, `MAX_MATCHES_PER_LINE`, `RE2_MAX_INPUT_BYTES`, `ErrorCode`, `FsError`.
- Produces:

  ```ts
  export interface LineMatcherOptions {
    pattern: string;
    isRegex: boolean;
    caseSensitive: boolean;
    signal?: AbortSignal;
  }

  export interface FileLineMatcher {
    matchLine(line: string): Promise<LineHit | undefined>;
  }

  export interface LineMatcher {
    forFile(buffer: Buffer): FileLineMatcher | undefined;
    tick(): Promise<boolean>;
    dispose(): void;
  }

  export function createLineMatcher(args: LineMatcherOptions): LineMatcher;
  ```

- [x] **Step 1: Write failing tests in `__tests__/matcher.test.ts`**

Add a `describe('createLineMatcher')` test suite in `__tests__/matcher.test.ts`:

```ts
describe('createLineMatcher', () => {
  it('LINE-001: literal needle matches lines and yields column offset', async () => {
    const matcher = createLineMatcher({ pattern: 'hello', isRegex: false, caseSensitive: true });
    try {
      const fileMatcher = matcher.forFile(Buffer.from('hello world\nno match\nhello again hello'));
      assert.ok(fileMatcher);
      assert.deepStrictEqual(await fileMatcher.matchLine('hello world'), { count: 1, column: 0 });
      assert.strictEqual(await fileMatcher.matchLine('no match'), undefined);
      assert.deepStrictEqual(await fileMatcher.matchLine('hello again hello'), {
        count: 2,
        column: 0,
      });
    } finally {
      matcher.dispose();
    }
  });

  it('LINE-002: case-insensitive literal falls back to RE2 on Kelvin sign', async () => {
    const matcher = createLineMatcher({ pattern: 'kelvin', isRegex: false, caseSensitive: false });
    try {
      const kelvinBuffer = Buffer.from('temperature: \u212Aelvin', 'utf8');
      const fileMatcher = matcher.forFile(kelvinBuffer);
      assert.ok(fileMatcher);
      const hit = await fileMatcher.matchLine('temperature: \u212Aelvin');
      assert.ok(hit);
      assert.strictEqual(hit.count, 1);
    } finally {
      matcher.dispose();
    }
  });

  it('LINE-003: rules out non-matching buffers via prefilter', () => {
    const matcher = createLineMatcher({ pattern: 'xyz[0-9]+', isRegex: true, caseSensitive: true });
    try {
      const buffer = Buffer.from('abc def ghi');
      const fileMatcher = matcher.forFile(buffer);
      assert.strictEqual(fileMatcher, undefined);
    } finally {
      matcher.dispose();
    }
  });

  it('LINE-004: throws TOO_LARGE when regex line exceeds RE2_MAX_INPUT_BYTES', async () => {
    const matcher = createLineMatcher({ pattern: 'needle', isRegex: true, caseSensitive: true });
    try {
      const fileMatcher = matcher.forFile(Buffer.from('needle'));
      assert.ok(fileMatcher);
      const hugeLine = 'a'.repeat(RE2_MAX_INPUT_BYTES + 1);
      await assert.rejects(
        async () => fileMatcher.matchLine(hugeLine),
        (err: unknown) => isFsError(err) && err.code === ErrorCode.TOO_LARGE,
      );
    } finally {
      matcher.dispose();
    }
  });

  it('LINE-005: tick yields cooperative macrotask and observes abort signal', async () => {
    const controller = new AbortController();
    const matcher = createLineMatcher({
      pattern: 'a',
      isRegex: false,
      caseSensitive: true,
      signal: controller.signal,
    });
    try {
      assert.strictEqual(await matcher.tick(), false);
      controller.abort();
      assert.strictEqual(await matcher.tick(), true);
    } finally {
      matcher.dispose();
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="createLineMatcher" dist/__tests__/matcher.test.js` or `npm test -- --test-name-pattern="createLineMatcher"`
Expected: FAIL with `createLineMatcher is not defined`.

- [x] **Step 3: Implement `createLineMatcher` in `src/core/matcher.ts`**

Move prefilter syntax constants from `src/core/search.ts` into `src/core/matcher.ts`:

```ts
const BUFFER_ANCHOR_RE = /\\[AzZ]/u;
const INLINE_FLAGS_RE = /\(\?[a-zA-Z-]+[:)]/u;
const CR = 13;

function canPrefilter(source: string, buffer: Buffer): boolean {
  if (buffer.length > RE2_MAX_INPUT_BYTES) return false;
  if (BUFFER_ANCHOR_RE.test(source)) return false;
  if (INLINE_FLAGS_RE.test(source)) return false;
  if (source.includes('$') && buffer.includes(CR)) return false;
  return true;
}
```

Implement `createLineMatcher`:

1. Call `planMatch(args.pattern, { isRegex: args.isRegex, caseSensitive: args.caseSensitive })`.
2. Compile primary `regex` and `prefilter` (`multiline: true`) in `try` block.
3. In `forFile(buffer)`:
   - If `plan.literal`:
     - If `!plan.literal.needsRe2(buffer)`:
       - If `!plan.literal.mayMatch(buffer)` return `undefined`.
       - Return `{ matchLine: (line) => Promise.resolve(plan.literal.matchLine(line)) }`.
   - If RE2 required:
     - If `canPrefilter(plan.source, buffer)`:
       - `prefilter.lastIndex = 0;`
       - If `prefilter.exec(buffer.toString('utf-8')) === null` return `undefined`.
     - Return `{ async matchLine(line) { if (Buffer.byteLength(line, 'utf8') > RE2_MAX_INPUT_BYTES) throw new FsError(ErrorCode.TOO_LARGE, 'Line exceeds RE2 input limit'); ... } }` using `execMatches(regex, line)` up to `MAX_MATCHES_PER_LINE` with macrotask yielding.
4. In `tick()`: call `yielder()`.
5. In `dispose()`: `freeRegex(prefilter); freeRegex(regex);`.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="createLineMatcher"`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/core/matcher.ts __tests__/matcher.test.ts
git commit -m "feat(matcher): implement createLineMatcher with prefiltering and wasm heap bounds"
```

---

### Task 3: Refactor `src/core/search.ts` to consume `createLineMatcher`

**Files:**

- Modify: `src/core/search.ts`
- Test: `__tests__/search.test.ts`

**Interfaces:**

- Consumes: `createLineMatcher`, `LineMatcher`, `FileLineMatcher`, `LineHit` from `src/core/matcher.ts`.
- Produces: `searchContent` calling `createLineMatcher` across the Match plan seam, with no raw regex compiling or prefilter heuristics in `search.ts`.

- [x] **Step 1: Write test for oversized line handling in `__tests__/search.test.ts`**

Add a test in `__tests__/search.test.ts` verifying that when a line exceeds 4 MiB during regex search, `searchContent` reports `summary.skippedTooLarge > 0` and does not crash:

```ts
it('SEARCH-TOO-LARGE: skips file with oversized line in regex mode', async () => {
  // Setup temp directory with one normal file and one file with a 4.5MB single line
  // Call searchContent with isRegex: true
  // Assert outcome.summary.skippedTooLarge === 1
});
```

- [x] **Step 2: Run test to verify existing behavior**

Run: `npm test -- --test-name-pattern="SEARCH-TOO-LARGE"`
Expected: PASS (pins baseline behavior).

- [x] **Step 3: Refactor `src/core/search.ts`**

1. Remove imports of `compileRegex`, `execMatches`, `freeRegex`, `type LiteralMatcher`, `MAX_MATCHES_PER_LINE`, `planMatch`, `RE2_MAX_INPUT_BYTES`, `type Regex`, `createYielder`.
2. Import `createLineMatcher`, `type LineMatcher`, `type FileLineMatcher`, `type LineHit` from `./matcher.ts`.
3. Import `isFsError`, `ErrorCode` from `./errors.ts`.
4. Delete `BUFFER_ANCHOR_RE`, `INLINE_FLAGS_RE`, `CR`, `canPrefilter`, and `findLineMatches`.
5. Update `ScanContext`:
   ```ts
   interface ScanContext {
     fs: GuardedFileSystem;
     signal: AbortSignal | undefined;
     maxResults: number;
     matcher: LineMatcher;
     context: number;
   }
   ```
6. In `scanFile`:
   - Replace literal and prefilter gating with:
     ```ts
     const fileMatcher = scanCtx.matcher.forFile(buffer);
     if (!fileMatcher) return { kind: 'scanned', matches: [] };
     ```
   - In line loop:
     ```ts
     if (await scanCtx.matcher.tick()) break;
     let found: LineHit | undefined;
     try {
       found = await fileMatcher.matchLine(line);
     } catch (err) {
       if (isFsError(err) && err.code === ErrorCode.TOO_LARGE) {
         return { kind: 'tooLarge' };
       }
       throw err;
     }
     ```
7. In `searchContent`:
   ```ts
   const matcher = createLineMatcher({
     pattern,
     isRegex: Boolean(options.isRegex),
     caseSensitive: Boolean(options.caseSensitive),
     signal: options.signal,
   });
   try {
     const scanCtx: ScanContext = {
       fs: new GuardedFileSystem(pathGuard),
       signal: options.signal,
       maxResults,
       matcher,
       context,
     };
     // scan(...)
   } finally {
     matcher.dispose();
   }
   ```

- [x] **Step 4: Run full search test suite**

Run: `npm test -- __tests__/search.test.ts`
Expected: PASS (all tests pass).

- [x] **Step 5: Commit**

```bash
git add src/core/search.ts __tests__/search.test.ts
git commit -m "refactor(search): delegate line matching and prefiltering to LineMatcher"
```

---

### Task 4: Internalize low-level primitives in `matcher.ts` and refactor tests

**Files:**

- Modify: `src/core/matcher.ts`
- Modify: `__tests__/matcher.test.ts`

**Interfaces:**

- Consumes: `createLineMatcher`, `createReplacementMatcher`, `planMatch`.
- Produces: `src/core/matcher.ts` with only high-level matcher factories and domain types exported.

- [x] **Step 1: Refactor `__tests__/matcher.test.ts` to test through public interfaces**

Update test cases `RE2-001` through `RE2-009` in `__tests__/matcher.test.ts`:

- Replace direct `compileRegex` + `execMatches` loops with `createLineMatcher` or `createReplacementMatcher`.
- Example for surrogate pairs and astral characters (emoji):
  ```ts
  it('RE2-001: tracks UTF-16 code units across astral emoji characters', async () => {
    const matcher = createLineMatcher({ pattern: 'target', isRegex: true, caseSensitive: true });
    try {
      const fileMatcher = matcher.forFile(Buffer.from('😀 target'));
      assert.ok(fileMatcher);
      const hit = await fileMatcher.matchLine('😀 target');
      assert.ok(hit);
      // '😀' takes 2 UTF-16 code units, space takes 1, target starts at column 3
      assert.strictEqual(hit.column, 3);
    } finally {
      matcher.dispose();
    }
  });
  ```
- Remove `compileRegex`, `freeRegex`, `execMatches`, `createYielder`, `MAX_MATCHES_PER_LINE`, and `RE2_MAX_INPUT_BYTES` imports from all test files.

- [x] **Step 2: Remove exports from internal primitives in `src/core/matcher.ts`**

Change:

- `export type Regex = RE2;` -> `type Regex = RE2;`
- `export const MAX_MATCHES_PER_LINE = ...` -> `const MAX_MATCHES_PER_LINE = ...`
- `export function createYielder(...)` -> `function createYielder(...)`
- `export const RE2_MAX_INPUT_BYTES = ...` -> `const RE2_MAX_INPUT_BYTES = ...`
- `export function compileRegex(...)` -> `function compileRegex(...)`
- `export function freeRegex(...)` -> `function freeRegex(...)`
- `export interface RegexMatch ...` -> `interface RegexMatch ...`
- `export function* execMatches(...)` -> `function* execMatches(...)`

Check remaining exports: `planMatch`, `createReplacementMatcher`, `createLineMatcher`, `outputTooLarge`, `MatchPlan`, `ReplacementMatcher`, `ReplaceLimits`, `LineMatcher`, `FileLineMatcher`, `LineMatcherOptions`, `LineHit`.

- [x] **Step 3: Run static checks, lint, and full test suite**

Run: `npm run check`
Expected: Static checks pass, lint passes, all test suites pass, smoke tests pass.

- [x] **Step 4: Verify MCP contract snapshot**

Run: `npm test -- __tests__/contract.test.ts`
Expected: PASS (0 contract snapshot diff).

- [x] **Step 5: Commit**

```bash
git add src/core/matcher.ts __tests__/matcher.test.ts
git commit -m "refactor(matcher): internalize regex compilation and iteration primitives"
```
