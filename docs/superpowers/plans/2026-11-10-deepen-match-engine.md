# Deepen MatchEngine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen `MatchEngine` to accept `TextView` directly, encapsulate byte prefiltering and CRLF literal variants, and provide first-class `replace` execution, completing the ADR-013 architecture and eliminating dual-engine branching in callers.

**Architecture:** Internalize `prefilterBytes` inside `MatchEngine.mayMatch(bytes)` and internalize CRLF literal needle adaptation inside `MatchEngine.matches(view)` and `MatchEngine.replace(view)`. Callers in `search.ts` and `replace-text.ts` cross a single seam accepting `TextView`, with replacement string normalization and restored UTF-8 byte limits handled inside `engine.replace()`.

**Tech Stack:** TypeScript 7 (Node.js ES modules), `@adguard/re2-wasm`, Node built-in test runner (`node:test`).

**Spec:** Architectural Review Report (`C:\Users\PC\AppData\Local\Temp\architecture-review-20261110-204500.html`), [ADR-013](docs/adr/013-one-text-view-and-one-matching-engine.md), and [GLOSSARY.md](GLOSSARY.md) (Match plan & Text view).

## Global Constraints

- Preserve all existing matching semantics: literal vs RE2, case folding (Kelvin sign U+212A, long s U+017F), multi-line matching, wholeWord boundaries.
- No public export of `createLfEngine` or `replaceMatches`: callers and tests cross `MatchEngine`'s interface directly.
- The interface of `MatchEngine` must accept `TextView` for `matches` and `replace`, and raw `Buffer` for `mayMatch`.
- Output byte limit (`limits.maxBytes`) in `engine.replace` must be measured against `view.restore(content)` in UTF-8 bytes.
- Run tests via `node --test` or `npm test`; static check via `npm run check:static`.

## Review Focus

1. **All-CRLF file with literal `\r\n` needle in search**: `engine.matches(view)` on `view.crlf === true` must match the LF-normalized form without caller-side engine swapping.
2. **All-CRLF file with literal `\r\n` needle and `\r\n` replacement in `replace_text`**: replacement `\r\n` must be adapted to `\n` so `view.restore()` avoids `\r\r\n` doubling.
3. **Byte prefilter with leading UTF-8 BOM**: `engine.mayMatch(bytes)` must strip BOM bytes (EF BB BF) before checking literal bytes, while honoring `lineBreakFree` for CR presence.
4. **Replacement exceeding `maxBytes` on multi-byte restoration**: replacement that grows multi-byte characters must throw `outputTooLarge` measured on `view.restore(content)`.
5. **Repeated calls and memory safety**: `engine.dispose()` must release both the primary compiled regex and the internalized LF variant regex.

---

### Task 1: Internalize Byte Prefiltering and LF Variant in `MatchEngine.matches`

**Files:**

- Modify: `src/core/matcher.ts:335-375`
- Test: `__tests__/match-engine.test.ts`

**Interfaces:**

- Consumes: `TextView` and `prefilterBytes` from `src/core/text-view.ts`
- Produces:

  ```typescript
  export interface MatchEngine {
    readonly crossesLines: boolean;
    readonly lineBreakFree: boolean;
    compile(): void;
    mayMatch(bytes: Buffer): boolean;
    matches(
      view: TextView,
      options?: { signal?: AbortSignal; path?: string; maxPerLine?: number },
    ): AsyncGenerator<TextMatch, void>;
    dispose(): void;
  }
  ```

- [ ] **Step 1: Write failing tests in `__tests__/match-engine.test.ts`**

Add tests exercising `engine.mayMatch(buffer)` directly with raw bytes (with/without BOM, with/without CR), and `engine.matches(viewText(...))` with CRLF literal needles on CRLF views:

```typescript
it('engine.mayMatch accepts raw buffer and applies prefilterBytes internally', () => {
  const engine = createMatchEngine('needle', { isRegex: false, caseSensitive: true });
  const withBom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('needle in haystack'),
  ]);
  assert.equal(engine.mayMatch(withBom), true);
  assert.equal(engine.mayMatch(Buffer.from('other text')), false);
  engine.dispose();
});

it('engine.matches matches literal typed with CRLF in CRLF TextView without caller branching', async () => {
  const engine = createMatchEngine('one\r\ntwo', { isRegex: false, caseSensitive: true });
  const view = viewText('one\r\ntwo\r\nthree\r\n');
  const matches: string[] = [];
  for await (const m of engine.matches(view)) {
    matches.push(m.text);
  }
  assert.deepEqual(matches, ['one\ntwo']);
  engine.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="mayMatch accepts raw buffer|matches matches literal typed with CRLF" __tests__/match-engine.test.ts`
Expected: FAIL with compilation/type error or signature mismatch.

- [ ] **Step 3: Implement internal prefiltering and `TextView` matching in `src/core/matcher.ts`**

1. Import `TextView` and `prefilterBytes` in `src/core/matcher.ts`.
2. Inside `createMatchEngine`:
   - Internalize compilation of the LF variant when `!flags.isRegex && needle.includes('\r\n')`.
   - Update `mayMatch(bytes: Buffer): boolean`:
     ```typescript
     mayMatch(bytes: Buffer): boolean {
       if (!plan.literal) return true;
       const probe = prefilterBytes(bytes, lineBreakFree);
       return probe !== undefined && plan.literal.mayMatch(probe);
     }
     ```
   - Update `matches(view: TextView, options)`:
     If `view.crlf && lfVariant` exists, delegate walk to `lfVariant.matchesText(view.text, options)`. Otherwise run against `view.text`.
   - Update `dispose()` to dispose `lfVariant` if instantiated.
   - Delete `export function createLfEngine`.

- [ ] **Step 4: Update existing tests in `__tests__/match-engine.test.ts`**

Update calls in `__tests__/match-engine.test.ts` where `createLfEngine` was imported or where `matches` took a raw string: wrap test strings in `viewText(text)` and pass raw buffers to `mayMatch(bytes)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test __tests__/match-engine.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/matcher.ts __tests__/match-engine.test.ts
git commit -m "refactor(matcher): deepen MatchEngine with byte prefiltering and TextView matching"
```

---

### Task 2: Implement First-Class `replace` on `MatchEngine` and Remove `replaceMatches`

**Files:**

- Modify: `src/core/matcher.ts:550-650`
- Test: `__tests__/match-engine.test.ts`, `__tests__/matcher.test.ts`

**Interfaces:**

- Consumes: `TextView` from `src/core/text-view.ts`
- Produces:

  ```typescript
  export interface MatchEngine {
    // ... Task 1 methods ...
    replace(
      view: TextView,
      replacement: string,
      options?: {
        expand?: boolean;
        signal?: AbortSignal;
        limits?: ReplaceLimits;
      },
    ): Promise<{ content: string; matchCount: number; more: boolean }>;
  }
  ```

- [ ] **Step 1: Write failing tests in `__tests__/match-engine.test.ts`**

Add tests verifying `engine.replace`:

1. Adapts `\r\n` replacement to `\n` on `view.crlf === true` for literal needle.
2. Uses the internalized LF engine on `view.crlf === true`.
3. Throws `outputTooLarge` if `Buffer.byteLength(view.restore(content), 'utf8') > limits.maxBytes`.

```typescript
it('engine.replace adapts replacement CRLF to LF in CRLF view and restores clean CRLF', async () => {
  const engine = createMatchEngine('old\r\nline', { isRegex: false, caseSensitive: true });
  const view = viewText('header\r\nold\r\nline\r\nfooter\r\n');
  const { content, matchCount } = await engine.replace(view, 'new\r\nline');
  assert.equal(matchCount, 1);
  assert.equal(content, 'header\nnew\nline\nfooter\n');
  assert.equal(view.restore(content), 'header\r\nnew\r\nline\r\nfooter\r\n');
  engine.dispose();
});

it('engine.replace throws outputTooLarge when restored disk text exceeds maxBytes', async () => {
  const engine = createMatchEngine('a', { isRegex: false, caseSensitive: true });
  const view = viewText('aaa\r\n');
  await assert.rejects(
    () =>
      engine.replace(view, 'xxx', { limits: { maxMatches: 10, maxBytes: 5, path: 'test.txt' } }),
    (err: unknown) => err instanceof FsError && err.code === ErrorCode.TOO_LARGE,
  );
  engine.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="engine.replace adapts replacement|engine.replace throws outputTooLarge" __tests__/match-engine.test.ts`
Expected: FAIL with `engine.replace is not a function`.

- [ ] **Step 3: Implement `engine.replace` in `src/core/matcher.ts`**

1. Add `replace` to `MatchEngine` interface.
2. In `createMatchEngine`, implement `replace(view: TextView, replacement: string, options)`:
   - Determine target engine (`view.crlf && lfVariant ? lfVariant : primary`).
   - If `view.crlf && !flags.isRegex`, adapt replacement: `const effectiveReplacement = replacement.replaceAll('\r\n', '\n')`.
   - Run the replacement walk with `effectiveReplacement` over `view.text`.
   - If `options?.limits?.maxBytes !== undefined`:
     Check `if (Buffer.byteLength(view.restore(content), 'utf8') > options.limits.maxBytes) throw outputTooLarge(options.limits)`.
   - Return `{ content, matchCount, more }`.
3. Remove `export async function replaceMatches` from `src/core/matcher.ts`.

- [ ] **Step 4: Migrate tests in `__tests__/matcher.test.ts` and `__tests__/match-engine.test.ts`**

Replace calls to `replaceMatches(engine, text, replacement, options)` with `engine.replace(viewText(text), replacement, options)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test __tests__/match-engine.test.ts __tests__/matcher.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/matcher.ts __tests__/match-engine.test.ts __tests__/matcher.test.ts
git commit -m "feat(matcher): add replace method to MatchEngine and remove replaceMatches"
```

---

### Task 3: Refactor `searchContent` to Use the Deepened `MatchEngine` Seam

**Files:**

- Modify: `src/core/search.ts:60-260`
- Test: `__tests__/search-text.test.ts`, `__tests__/search.test.ts`

**Interfaces:**

- Consumes: `engine.mayMatch(bytes)`, `engine.matches(view, options)` from `MatchEngine`
- Produces: Cleaned `searchContent` with no dual-engine management

- [ ] **Step 1: Write verification test in `__tests__/search.test.ts`**

Ensure `searchContent` matches CRLF literal patterns in all-CRLF files across line breaks without error:

```typescript
it('searchContent matches literal CRLF pattern in CRLF files through one engine', async () => {
  // Existing test coverage in search.test.ts and search-text.test.ts; verify current suite passes before edit
});
```

- [ ] **Step 2: Run existing search tests**

Run: `npm test -- --test-name-pattern="search"`
Expected: PASS (or fail once Task 1 signature changes took place; now we align `search.ts`).

- [ ] **Step 3: Refactor `src/core/search.ts`**

1. In `src/core/search.ts`:
   - Remove `createLfEngine` from imports.
   - Remove `prefilterBytes` from imports.
   - Remove `lf: MatchEngine | undefined` from `ScanContext`.
2. In `scanFileBody`:
   - Replace `const probe = prefilterBytes(...); if (probe !== undefined && !scanCtx.engine.mayMatch(probe)) ...` with:
     `if (!scanCtx.engine.mayMatch(buffer)) return { matches: [] };`
   - Remove `const engine = view.crlf && scanCtx.lf ? scanCtx.lf : scanCtx.engine;`
   - Call `scanCtx.engine.matches(view, { ... })` directly with `view`.
3. In `searchContent`:
   - Remove `const lf = createLfEngine(pattern, flags);` and `scanCtx.lf`.

- [ ] **Step 4: Run search tests to verify they pass**

Run: `npm test -- --test-name-pattern="search"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/search.ts
git commit -m "refactor(search): drive search_text through deepened MatchEngine seam"
```

---

### Task 4: Refactor `replace_text` to Use the Deepened `MatchEngine` Seam

**Files:**

- Modify: `src/tools/replace-text.ts:40-300`
- Test: `__tests__/replace-text.test.ts`

**Interfaces:**

- Consumes: `engine.mayMatch(bytes)`, `engine.replace(view, replacement, options)` from `MatchEngine`
- Produces: Cleaned `replace_text` with no `createLfVariant` or manual byte-size checks

- [ ] **Step 1: Inspect `src/tools/replace-text.ts` call site**

Examine `processEntry` in `src/tools/replace-text.ts`:
Currently calls `prefilterBytes`, `createLfVariant`, `ctx.lf`, `replaceMatches`, and manual `Buffer.byteLength(view.restore(content), 'utf8') > limits.maxBytes`.

- [ ] **Step 2: Refactor `processEntry` and delete `createLfVariant` in `src/tools/replace-text.ts`**

1. Remove unused imports: `createLfEngine`, `outputTooLarge`, `replaceMatches`, `prefilterBytes`.
2. In `ReplaceContext`:
   - Remove `lf?: { engine: MatchEngine; replacement: string }`.
3. In `processEntry`:
   - Replace prefiltering with `if (!engine.mayMatch(bytes)) return undefined;`.
   - Call `engine.replace(view, replacement, { expand, ...(signal ? { signal } : {}), limits })`.
   - Remove manual `Buffer.byteLength(view.restore(content), 'utf8') > limits.maxBytes` check (handled inside `engine.replace`).
4. Delete `function createLfVariant`.

- [ ] **Step 3: Run replace_text tests to verify they pass**

Run: `npm test -- --test-name-pattern="replace_text"`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tools/replace-text.ts
git commit -m "refactor(replace_text): drive replace_text through deepened MatchEngine seam"
```

---

### Task 5: Full Verification, Documentation, and Contract Check

**Files:**

- Modify: `docs/adr/013-one-text-view-and-one-matching-engine.md` (add addendum/status note)
- Test: Full repository check

**Interfaces:**

- Consumes: All updated modules
- Produces: Clean `npm run check` and up-to-date ADR record

- [ ] **Step 1: Add Addendum to ADR-013 in `docs/adr/013-one-text-view-and-one-matching-engine.md`**

Add brief addendum recording that `MatchEngine` was deepened to accept `TextView` directly, internalizing `prefilterBytes`, CRLF literal variants, and replacement execution, removing caller-side dual-engine branching.

- [ ] **Step 2: Run full check**

Run: `npm run check`
Expected: PASS (lint, typecheck, contract tests, full test suite pass cleanly with 0 errors).

- [ ] **Step 3: Commit**

```bash
git add docs/adr/013-one-text-view-and-one-matching-engine.md
git commit -m "docs(adr): record MatchEngine deepening addendum in ADR-013"
```
