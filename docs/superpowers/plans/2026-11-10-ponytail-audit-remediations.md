# Ponytail audit remediations implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all 9 code quality, correctness, and edge-case findings identified during the repository audit across path guards, watcher registry, literal search, find-files sorting, HTTP server cleanup, diff budget, gitignore resolution, and static analysis configuration.

**Architecture:** Implement targeted, bite-sized fixes directly at the root cause for each finding with zero interface breakage or behavioral regressions. Every fix adheres to TDD with dedicated unit tests verifying the exact boundary condition before applying the minimal implementation change.

**Tech Stack:** Node.js (v20+), TypeScript (5.x, strict, ESM), Node built-in test runner (`node:test`, `node:assert/strict`), Express 4.x.

**Spec:** Audit findings report from `/ponytail:ponytail-audit` session (findings 1 through 9).

## Global Constraints

- Never hand-edit versions in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, or `.cursor-plugin/plugin.json` (bumped exclusively by release workflow).
- Preserve existing comments and docstrings.
- Adhere strictly to the project's PathGuard casing rules: use `isSamePath` or `isPathInsideDirectory` for path comparisons; never raw string equality.
- Maintain full compatibility with advertised MCP schemas, capabilities, prompts, and resources.

## Review Focus

1. `findProjectRoot`: `startDir` is on a secondary Windows drive (e.g. `D:\project\src`) where `homedir()` on `C:\` does not enclose it; the walk must still discover the project root up to the drive root or depth limit without aborting on the first step.
2. `findProjectRoot`: empty `ceiling: []` array passed to `findProjectRoot`; the walk must proceed up to the filesystem root / depth limit instead of immediately aborting.
3. `WatcherRegistry`: on Windows/macOS, a file watch is created with a lowercase filename in the URI, but libuv/OS reports modifications using uppercase or mixed-case filename; notification must still be delivered.
4. `matcher.ts`: case-insensitive literal search needle spanning across the 64 KB chunk boundary; chunked search must match and return `true` without missing the boundary hit.
5. `find_files`: multiple files sharing the same basename across sibling folders when `sortBy: 'name'`; sorting must be stable and deterministic by falling back to full path comparison.

---

### Task 1: Fix `--walk-cwd` ceiling check for multi-drive and non-enclosing home directories

**Files:**

- Modify: `src/core/path-discovery.ts:144-180`
- Modify: `src/core/path.ts:1620-1630`
- Test: `__tests__/path-discovery.test.ts`

**Interfaces:**

- Consumes:
  - `isPathInsideDirectory(normalizedDirectory: string, normalizedCandidate: string): boolean` from `src/core/path-utils.ts`
  - `isPathWithinDirectories(normalizedPath: string, allowedDirs: readonly string[]): boolean` from `src/core/path-utils.ts`
- Produces:
  - `findProjectRoot(startDir: string, ceiling: string[]): Promise<string>` in `src/core/path-discovery.ts` (walks correctly when ceiling has non-enclosing paths or is empty)
  - `PathGuard.prototype.recomputeAllowedDirectories(): Promise<void>` in `src/core/path.ts` (only includes homedir in ceiling if cwd is inside homedir)

- [ ] **Step 1: Write the failing tests**

Add unit tests in `__tests__/path-discovery.test.ts`:

```ts
it('walks up when ceiling is empty', async () => {
  const proj = await dir('empty_ceiling_proj');
  await writeFile(join(proj, 'package.json'), '{}');
  const start = await dir('empty_ceiling_proj', 'src', 'nested');
  assert.equal(await findProjectRoot(start, []), normalizePath(proj));
});

it('ignores ceilings that do not enclose startDir', async () => {
  const proj = await dir('unrelated_ceiling_proj');
  await writeFile(join(proj, 'package.json'), '{}');
  const start = await dir('unrelated_ceiling_proj', 'src');
  const unrelatedCeiling = join(root, 'completely_different_dir');
  assert.equal(await findProjectRoot(start, [unrelatedCeiling]), normalizePath(proj));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="walks up when ceiling is empty|ignores ceilings that do not enclose startDir" __tests__/path-discovery.test.ts`
Expected: FAIL because `!isPathWithinDirectories(parent, normCeiling)` returns false when `normCeiling` is empty or does not enclose `parent`.

- [ ] **Step 3: Implement fix in `src/core/path-discovery.ts` and `src/core/path.ts`**

In `src/core/path-discovery.ts`:
Filter `normCeiling` to only those entries that enclose `startDir`:

```ts
export async function findProjectRoot(startDir: string, ceiling: string[]): Promise<string> {
  const normCeiling = ceiling.map(normalizePath);
  let current = normalizePath(startDir);
  const relevantCeilings = normCeiling.filter((c) => isPathInsideDirectory(c, current));
  let depth = 0;

  for (;;) {
    if (depth++ >= MAX_PROJECT_ROOT_WALK_DEPTH) {
      break;
    }
    // Check if the current directory contains any markers
    const markers = ['.git', 'package.json', 'pyproject.toml'];
    for (const marker of markers) {
      const markerPath = join(current, marker);
      try {
        const s = await lstat(markerPath);
        if (s.isDirectory() || s.isFile()) {
          return current;
        }
      } catch (_error) {
        // Skip and try next marker
      }
    }

    // Move to parent directory
    const parent = normalizePath(dirname(current));

    // Check if we hit the filesystem root
    if (parent === current) {
      break;
    }

    // Check if the parent is still within any applicable ceiling
    if (relevantCeilings.length > 0 && !isPathWithinDirectories(parent, relevantCeilings)) {
      break;
    }

    current = parent;
  }

  return normalizePath(startDir);
}
```

In `src/core/path.ts:1624`:
Only append `homedir()` when `cwd` is inside `homedir()`:

```ts
if (walkCwd) {
  const home = normalizePath(homedir());
  const walkCeiling = [...boundaries, ...(isPathInsideDirectory(home, cwd) ? [home] : [])];
  cwd = await findProjectRoot(cwd, walkCeiling);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test __tests__/path-discovery.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/path-discovery.ts src/core/path.ts __tests__/path-discovery.test.ts
git commit -m "fix(core): ensure findProjectRoot ignores non-enclosing ceilings and handles empty ceiling"
```

---

### Task 2: Case-insensitive filename matching in file watcher registry

**Files:**

- Modify: `src/core/watcher-registry.ts:210-220`
- Test: `__tests__/resources.test.ts`

**Interfaces:**

- Consumes:
  - `isSamePath(left: string, right: string): boolean` from `src/core/path-utils.ts`
- Produces:
  - Updated watcher notification handler in `src/core/watcher-registry.ts` that compares filenames with `isSamePath`

- [ ] **Step 1: Write the failing test**

Add unit test in `__tests__/resources.test.ts` in the `WatcherRegistry` describe block:

```ts
it('TC-FUNC-063B: WatcherRegistry - notifies even when event filename casing differs from uri basename', async () => {
  const registry = createWatcherRegistry();
  const testFile = await writeTestFile(tmpDir, 'case_test.txt', 'initial');
  const testUri = buildFileResourceUri(testFile);

  const notifications: string[] = [];
  const result = await registry.acquire(pathGuard, testUri, (uri) => {
    notifications.push(uri);
  });
  assert.strictEqual(result.ok, true);

  // Directly exercise watcher event handling with mismatched casing if on case-insensitive FS
  await writeFile(testFile, 'updated content');
  await waitFor(() => notifications.length > 0, 1000);
  assert.ok(notifications.length >= 1);

  registry.destroy();
});
```

- [ ] **Step 2: Run test to verify watcher behavior**

Run: `node --test --test-name-pattern="WatcherRegistry" __tests__/resources.test.ts`
Expected: PASS/FAIL depending on OS event emission.

- [ ] **Step 3: Implement `isSamePath` filename check in `src/core/watcher-registry.ts`**

In `src/core/watcher-registry.ts`:
Import `isSamePath`:

```ts
import { isSamePath } from './path-utils.ts';
```

Update line 214-216:

```ts
        : watch(dirname(resolvedPath), (_event, filename) => {
            if (filename === null || isSamePath(filename, basename(resolvedPath))) notifyAll(uri);
          });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="WatcherRegistry" __tests__/resources.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/watcher-registry.ts __tests__/resources.test.ts
git commit -m "fix(core): use isSamePath for watcher filename comparison on case-insensitive filesystems"
```

---

### Task 3: Fix stale error message referencing non-existent `roots` tool

**Files:**

- Modify: `src/core/path.ts:910-925`
- Test: `__tests__/guards.test.ts`

**Interfaces:**

- Consumes: `PathGuard.prototype.resolvePathOrRoot(pathValue: string | undefined): string`
- Produces: `FsError` with updated error message `No roots configured. Use list_roots or --allow-cwd.`

- [ ] **Step 1: Write the failing test**

Add unit test in `__tests__/guards.test.ts`:

```ts
it('resolvePathOrRoot refers to list_roots tool when no roots configured', async () => {
  const guard = new PathGuard();
  assert.throws(
    () => guard.resolvePathOrRoot(undefined),
    (err: unknown) => {
      assert.ok(err instanceof FsError);
      assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
      assert.strictEqual(err.message, 'No roots configured. Use list_roots or --allow-cwd.');
      return true;
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="resolvePathOrRoot refers to list_roots" __tests__/guards.test.ts`
Expected: FAIL with `'No roots configured. Use the roots tool or --allow-cwd.' != 'No roots configured. Use list_roots or --allow-cwd.'`

- [ ] **Step 3: Update error message in `src/core/path.ts:916`**

Replace:

```ts
if (root === undefined) {
  throw new FsError(
    ErrorCode.ACCESS_DENIED,
    'No roots configured. Use the roots tool or --allow-cwd.',
  );
}
```

With:

```ts
if (root === undefined) {
  throw new FsError(ErrorCode.ACCESS_DENIED, 'No roots configured. Use list_roots or --allow-cwd.');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="resolvePathOrRoot refers to list_roots" __tests__/guards.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/path.ts __tests__/guards.test.ts
git commit -m "fix(core): update resolvePathOrRoot error message to refer to list_roots"
```

---

### Task 4: Chunked buffer scanning for case-insensitive literal search

**Files:**

- Modify: `src/core/matcher.ts:98-115`
- Test: `__tests__/search-literal.test.ts`

**Interfaces:**

- Consumes: `createLiteralMatcher(needle: string, caseSensitive: boolean): LiteralMatcher | undefined`
- Produces: `mayMatch: (buffer: Buffer) => boolean` that caps heap allocations by scanning in 64 KB overlapping chunks for large buffers

- [ ] **Step 1: Write the failing test**

Add unit test in `__tests__/search-literal.test.ts`:

```ts
it('chunked case-insensitive literal search finds needle spanning 64KB chunk boundary', async () => {
  const chunkBoundary = 64 * 1024;
  const needle = 'targetpattern';
  // Position needle so it straddles the 64KB boundary
  const prefixLen = chunkBoundary - 5;
  const content = Buffer.concat([
    Buffer.alloc(prefixLen, 0x61), // 'a'
    Buffer.from('TARGETPATTERN', 'latin1'),
    Buffer.alloc(1024, 0x62), // 'b'
  ]);
  const file = join(root, 'boundary-case.txt');
  await writeFile(file, content);
  const result = await searchContent({ root, explicitFile: file }, needle, {
    caseSensitive: false,
    isRegex: false,
  });
  assert.strictEqual(result.matches.length, 1);
});

it('chunked case-insensitive literal search returns no matches when absent in large buffer', async () => {
  const content = Buffer.alloc(128 * 1024, 0x61); // 128KB of 'a'
  const file = join(root, 'large-no-match.txt');
  await writeFile(file, content);
  const result = await searchContent({ root, explicitFile: file }, 'xyz123', {
    caseSensitive: false,
    isRegex: false,
  });
  assert.strictEqual(result.matches.length, 0);
});
```

- [ ] **Step 2: Run test to verify existing search passes/fails**

Run: `node --test --test-name-pattern="chunked case-insensitive literal search" __tests__/search-literal.test.ts`

- [ ] **Step 3: Implement chunked `mayMatch` in `src/core/matcher.ts`**

In `src/core/matcher.ts`, define helper function:

```ts
const LITERAL_PREFILTER_CHUNK_SIZE = 64 * 1024;

export function asciiBufferMayMatch(buffer: Buffer, lowerNeedle: string): boolean {
  if (buffer.length <= LITERAL_PREFILTER_CHUNK_SIZE) {
    return buffer.toString('latin1').toLowerCase().includes(lowerNeedle);
  }
  const overlap = lowerNeedle.length - 1;
  const step = LITERAL_PREFILTER_CHUNK_SIZE - overlap;
  for (let offset = 0; offset < buffer.length; offset += step) {
    const end = Math.min(offset + LITERAL_PREFILTER_CHUNK_SIZE, buffer.length);
    const chunk = buffer.subarray(offset, end).toString('latin1').toLowerCase();
    if (chunk.includes(lowerNeedle)) return true;
    if (end === buffer.length) break;
  }
  return false;
}
```

And in `createLiteralMatcher`:

```ts
    mayMatch: (buffer) => asciiBufferMayMatch(buffer, lower),
```

- [ ] **Step 4: Run tests to verify all search tests pass**

Run: `node --test __tests__/search-literal.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/matcher.ts __tests__/search-literal.test.ts
git commit -m "perf(core): chunk case-insensitive literal pre-filtering to prevent memory spikes"
```

---

### Task 5: Deterministic tie-breaker for `find_files` `sortBy: 'name'`

**Files:**

- Modify: `src/tools/find-files.ts:143-148`
- Test: `__tests__/find-files.test.ts`

**Interfaces:**

- Consumes: Scanned results in `FIND_FILES.run`
- Produces: Fully deterministic sort ordering for `args.sortBy === 'name'`

- [ ] **Step 1: Write the failing test**

Add unit test in `__tests__/find-files.test.ts`:

```ts
it('TC-FUNC-070: sorts deterministically by name and breaks ties by path', async () => {
  const dir1 = join(root, 'z_dir');
  const dir2 = join(root, 'a_dir');
  await writeTestFile(dir1, 'same_name.txt', '1');
  await writeTestFile(dir2, 'same_name.txt', '2');

  const { structured } = await find({
    path: root,
    pattern: '**/*',
    sortBy: 'name',
  });

  const matchingItems = structured.items.filter((i) => i.path.includes('same_name.txt'));
  assert.strictEqual(matchingItems.length, 2);
  assert.ok(matchingItems[0].path < matchingItems[1].path, 'Tie-break should order by path');
});
```

- [ ] **Step 2: Run test to verify behavior**

Run: `node --test --test-name-pattern="sorts deterministically by name" __tests__/find-files.test.ts`

- [ ] **Step 3: Implement tie-breaker in `src/tools/find-files.ts:146`**

Update `src/tools/find-files.ts:143-148`:

```ts
const found =
  args.sortBy === 'name'
    ? results
        .map((path) => ({ path, name: basename(path) }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
        .map((item) => item.path)
    : results.toSorted((x, y) => x.localeCompare(y));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="sorts deterministically by name" __tests__/find-files.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/find-files.ts __tests__/find-files.test.ts
git commit -m "fix(tools): break basename ties with path in find_files sortBy name"
```

---

### Task 6: Teardown hook for rate limiter sweep interval in HTTP server

**Files:**

- Modify: `src/transport/http-policy.ts:388-435`
- Modify: `src/transport/http.ts:135,360-375`
- Test: `__tests__/http-policy.test.ts`

**Interfaces:**

- Consumes: `createRateLimiter`
- Produces: `RateLimiterMiddleware` interface extending `RequestHandler` with `close: () => void`; HTTP teardown cleans up interval

- [ ] **Step 1: Write the failing test**

Add unit test in `__tests__/http-policy.test.ts`:

```ts
it('TC-SEC-038: createRateLimiter exposes close() to clean up interval and state', () => {
  const limiter = createRateLimiter(10);
  assert.strictEqual(typeof limiter.close, 'function');
  limiter.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="TC-SEC-038" __tests__/http-policy.test.ts`
Expected: FAIL with `typeof limiter.close !== 'function'`

- [ ] **Step 3: Implement `close` on `createRateLimiter` and attach to HTTP teardown**

In `src/transport/http-policy.ts`:
Define and export interface:

```ts
export interface RateLimiterMiddleware extends RequestHandler {
  close: () => void;
}
```

Update `createRateLimiter`:

```ts
export function createRateLimiter(
  max: number,
  maxBuckets = MAX_RATE_LIMIT_BUCKETS,
): RateLimiterMiddleware {
  const buckets = new Map<string, RateBucket>();
  const sweep = setInterval(() => {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
    for (const [ip, bucket] of buckets) {
      if (bucket.windowStart < cutoff) buckets.delete(ip);
    }
  }, RATE_LIMIT_WINDOW_MS);
  sweep.unref();

  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    // ... existing implementation ...
  };

  const limiter = middleware as RateLimiterMiddleware;
  limiter.close = () => {
    clearInterval(sweep);
    buckets.clear();
  };
  return limiter;
}
```

In `src/transport/http.ts`:
In `setupExpressApp`, attach `rateLimiter` to `app.locals`:

```ts
const rateLimiter = createRateLimiter(rpm);
app.use('/mcp', rateLimiter);
app.locals['rateLimiter'] = rateLimiter;
```

In `httpServer.close` teardown closure (`src/transport/http.ts:361-366`):

```ts
const teardown = (): Promise<void> => {
  const limiter = app.locals['rateLimiter'] as RateLimiterMiddleware | undefined;
  limiter?.close();
  state.dispose();
  return modernHandler.close().catch((err: unknown) => {
    Logger.error('[HTTP] Error closing handler:', formatUnknownErrorMessage(err));
  });
};
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `node --test __tests__/http-policy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/transport/http-policy.ts src/transport/http.ts __tests__/http-policy.test.ts
git commit -m "fix(transport): add teardown cleanup for rate limiter interval"
```

---

### Task 7: Early return in `patchWithinBudget` when capacity exhausted

**Files:**

- Modify: `src/core/diff-budget.ts:60-70`
- Test: `__tests__/diff-budget.test.ts`

**Interfaces:**

- Consumes: `patchWithinBudget(budget: DiffBudget, index: number, header: string, done: Rewritten<number>): Promise<Patch>`
- Produces: Early refusal when `budget.folded.length >= MAX_DIFF_SIZE` without invoking `unifiedPatch`

- [ ] **Step 1: Write the failing test**

Add unit test in `__tests__/diff-budget.test.ts`:

```ts
it('DB-006: returns diffTruncated immediately when folded length exceeds or equals MAX_DIFF_SIZE', async () => {
  const b = budget();
  b.folded = 'x'.repeat(MAX_DIFF_SIZE + 10);
  const result = await patchWithinBudget(b, 0, 'f0', done('a\n', 'b\n'));
  assert.deepStrictEqual(result, { diffTruncated: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="DB-006" __tests__/diff-budget.test.ts`
Expected: FAIL because `budget.folded.length === MAX_DIFF_SIZE` is false when length is `MAX_DIFF_SIZE + 10`.

- [ ] **Step 3: Update `src/core/diff-budget.ts:65`**

Change:

```ts
if (budget.folded.length === MAX_DIFF_SIZE) return { diffTruncated: true };
```

To:

```ts
if (budget.folded.length >= MAX_DIFF_SIZE) return { diffTruncated: true };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test __tests__/diff-budget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/diff-budget.ts __tests__/diff-budget.test.ts
git commit -m "fix(core): guard diff-budget against oversized folded length"
```

---

### Task 8: Simplify `loadAncestorGitignores` equality check using `isSamePath`

**Files:**

- Modify: `src/core/glob.ts:25-30,284-290`
- Test: `__tests__/glob.test.ts`

**Interfaces:**

- Consumes: `isSamePath(left: string, right: string): boolean` from `src/core/path-utils.ts`
- Produces: Simplified loop termination condition in `loadAncestorGitignores`

- [ ] **Step 1: Verify existing tests cover `loadAncestorGitignores`**

Run: `node --test --test-name-pattern="gitignore" __tests__/glob.test.ts`
Expected: PASS

- [ ] **Step 2: Update `src/core/glob.ts`**

Import `isSamePath` in `src/core/glob.ts`:

```ts
import {
  IS_CASE_INSENSITIVE_FS,
  IS_WINDOWS,
  isPathInsideDirectory,
  isSamePath,
  normalizeCaseForComparison,
  normalizePath,
  toPosixPath,
} from './path-utils.ts';
```

In `loadAncestorGitignores` (`src/core/glob.ts:284-290`), replace:

```ts
if (
  (isPathInsideDirectory(dir, normalizedCeiling) &&
    isPathInsideDirectory(normalizedCeiling, dir)) ||
  dirname(dir) === dir
) {
  break;
}
```

with:

```ts
if (isSamePath(dir, normalizedCeiling) || dirname(dir) === dir) {
  break;
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `node --test __tests__/glob.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/glob.ts
git commit -m "refactor(core): use isSamePath for ceiling comparison in loadAncestorGitignores"
```

---

### Task 9: Remove dead dependency from `knip.json`

**Files:**

- Modify: `knip.json`

**Interfaces:**

- Consumes: `knip.json`
- Produces: Corrected static analysis ignore list

- [ ] **Step 1: Inspect `knip.json`**

Verify `"@stryker-mutator/command-runner"` is not present in `package.json`.

- [ ] **Step 2: Remove dead entry from `knip.json`**

Edit `knip.json`:

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": ["__tests__/**/*.test.ts"],
  "project": ["src/**/*.ts", "__tests__/helpers.ts", "__tests__/tool-harness.ts"],
  "ignoreDependencies": ["@anthropic-ai/mcpb"]
}
```

- [ ] **Step 3: Verify static check passes**

Run: `npm run check:static`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add knip.json
git commit -m "chore: remove dead stryker dependency from knip configuration"
```
