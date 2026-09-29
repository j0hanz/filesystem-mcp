# Plan 045: `search_text` scans files concurrently and tests each file once before scanning its lines

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 4d751c94..HEAD -- src/core/search.ts __tests__/tools.test.ts CHANGELOG.md`
> Plan 043 is expected to have changed `src/core/search.ts` (it adds
> `SearchContentOptions.explicitFile` and a `singleEntry` generator). That is
> the only expected drift; compare the excerpts below against the live code
> and treat any other mismatch as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — the inner loop of a user-facing tool is restructured;
  match content, line numbers, columns and context must be byte-identical.
- **Depends on**: 043 (edits the same function; run 043 first)
- **Category**: perf
- **Planned at**: commit `4d751c94`, 2026-09-28

## Why this matters

`search_text` has a 5 s budget (`DEFAULT_SEARCH_TIMEOUT_MS`). A prior audit
measured 4.8 s on a warm 5k-file tree on Windows — one slow disk or a slightly
larger repository and every search answers `stoppedReason: "timeout"` with a
partial result. The loop pays three avoidable costs per file: it runs
**sequentially** (guard `realpath` → `stat` → `readFile`, each awaited before
the next file starts), it splits every file into lines, and it makes **one
RE2 call per line** across the JS/WASM boundary even when the file contains
no match at all — which is the common case. After this plan: files are read
with bounded concurrency (the same primitive `replace_text` already uses), and
each file is tested **once** against the whole buffer before any per-line work;
only files that can match are split and scanned. Output is unchanged and
deterministic.

## Current state

`src/core/search.ts` — the engine. Relevant pieces at `4d751c94`:

- `compileRegex(pattern, { caseSensitive })` (lines 61-74): flags are `'gu'`
  or `'giu'`; RE2 also accepts `'m'` (re2-wasm typings:
  `node_modules/@adguard/re2-wasm/build/src/re2.d.ts:27` — `constructor(pattern, flags?, maxMem?)`, `get multiline()`).
- `freeRegex(regex)` (lines 84-92): every compiled pattern **must** be freed in
  a `finally` (re2-wasm's 16 MB heap is never reclaimed otherwise).
- `RE2_MAX_INPUT_BYTES = 4 * MIB` (line 40): the largest input one RE2 call
  may scan.
- `findLineMatches(regex, line)` (lines 156-169): one `execMatches` pass per line.
- `searchContent(directory, pattern, options, pathGuard)` (lines 216-336). The
  loop body today (lines 250-322, abridged):

```ts
for await (const entry of guardedEntries(entries, pathGuard, options.signal, counters)) {
  if (matches.length >= maxResults) break;
  try {
    const stats = await fsStat(entry.path);
    if (stats.size > maxFileSize) {
      skippedTooLarge++;
      continue;
    }
  } catch {
    counters.skippedInaccessible++;
    continue;
  }
  filesScanned++;
  try {
    const buffer = await readFile(entry.path, { signal: options.signal });
    if (buffer.includes(0)) {
      skippedBinary++;
      continue;
    }
    const content = buffer.toString('utf-8');
    const lines = content.split(/\r?\n/u);
    const lineCount =
      content.length === 0 ? 0 : content.endsWith('\n') ? lines.length - 1 : lines.length;
    let matchedFile = false;
    for (let i = 0; i < lineCount; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const found = findLineMatches(regex, line);
      if (found) {
        matchedFile = true;
        matchingLines++;
        matches.push({
          file: entry.path,
          line: i + 1,
          column: found.column,
          content: own(line),
          matchCount: found.count,
          ...(context > 0
            ? {
                before: lines.slice(Math.max(0, i - context), i).map(own),
                after: lines.slice(i + 1, Math.min(lineCount, i + 1 + context)).map(own),
              }
            : {}),
        });
        if (matches.length >= maxResults) break;
      }
    }
    if (matchedFile) filesMatched++;
  } catch {
    if (options.signal?.aborted) {
      counters.stoppedByAbort = true;
      break;
    }
  }
}
const stoppedReason = resolveStopReason(matches.length >= maxResults, counters.stoppedByAbort);
```

- `guardedEntries(entries, pathGuard, signal, counters)` (lines 338-357)
  validates each entry with `pathGuard.validateExistingPath` (a `realpath`),
  counting failures in `counters.skippedInaccessible`, and sets
  `counters.stoppedByAbort` when the signal fires. It is shared with
  `searchFiles` — leave it in place for `searchFiles`.
- `own(s)` (line 17) copies a kept string so it does not pin the whole file.

`src/core/concurrency.ts:114-181` — `processEntriesConcurrently(entries, { signal, concurrency, maxEntries?, shouldStop?, onEntry, onError?, runEntry })`
returns `'timeout' | 'maxFiles' | 'maxResults' | undefined`. Exemplar use:
`src/tools/replace-text.ts:553-570`.

`src/core/util.ts`: `PARALLEL_CONCURRENCY` (line 104, 4–32 by CPU count),
`DEFAULT_SEARCH_TIMEOUT_MS = 5000` (124), `MAX_SEARCH_RESULTS = 10000` (131),
`escapeRegExp` (101).

The tool sorts results itself (`src/tools/search-text.ts:230`:
`payloads.sort((l, r) => l.file.localeCompare(r.file) || l.line - r.line)`),
so the engine's emission order is not part of the wire contract — but the
**set** of matches under the `maxResults` cap must stay deterministic.

Tests: `__tests__/tools.test.ts` `search_text` tests at lines ~2407-2740
(literal match, phantom last line, cursor stability, context rendering,
externalization, skipped-file reporting, binary skip); the boundary-walk test
at line 199. `search_text`'s text argument is `searchPattern`.

## Commands you will need

| Purpose            | Command                                                 | Expected on success |
| ------------------ | ------------------------------------------------------- | ------------------- |
| Build + typecheck  | `npm run build && npm run type-check:test`              | exit 0              |
| Targeted tests     | `npm test -- --test-name-pattern="search_text\|search"` | all pass            |
| Full check         | `npm run check`                                         | exit 0; 0 fail      |
| Benchmark (ad hoc) | see step 1                                              | numbers recorded    |

Baseline at planning time: 450 tests, 447 pass, 3 skips, 0 fail.

## Scope

**In scope**:

- `src/core/search.ts` — `compileRegex` option, `searchContent` body, one new helper
- `__tests__/tools.test.ts` — new tests
- `CHANGELOG.md` — `### Changed` bullet under `## [Unreleased]`
- `plans/README.md` — status row

**Out of scope**:

- `guardedEntries` and `searchFiles` — unchanged (`find_files` is not in scope).
- `src/core/glob.ts` — the walk (plans 043/044 own it).
- `src/tools/search-text.ts` — the tool layer; its sort makes this plan possible and is not touched.
- `PathGuard` — the per-entry `realpath` stays (a cheaper guard is a separate, security-sensitive change).
- Reducing `stat` + `readFile` to one call.

## Git workflow

- Branch: `advisor/045-search-text-prefilter-and-concurrency`
- Commits e.g. `perf(search): test each file once before scanning lines`,
  `perf(search): read files with bounded concurrency`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Record a baseline number

Create a throwaway script **outside the repository** (e.g. in `os.tmpdir()`),
never committed, that builds 5,000 files × 200 lines with no matches under a
temp root and times `searchContent`:

```js
// bench-search.mjs — run with: node bench-search.mjs  (from the repo root, after `npm run build`)
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PathGuard } from './dist/core/path.js';
import { resolveAllowedDirectoriesState } from './dist/core/path.js';
import { searchContent } from './dist/core/search.js';

const root = await mkdtemp(join(tmpdir(), 'fsmcp-bench-'));
for (let d = 0; d < 50; d++) {
  await mkdir(join(root, `d${d}`));
  for (let f = 0; f < 100; f++) {
    await writeFile(
      join(root, `d${d}`, `f${f}.txt`),
      Array.from({ length: 200 }, (_, i) => `line ${i} lorem ipsum dolor`).join('\n') + '\n',
    );
  }
}
const guard = new PathGuard();
guard.initialize(await resolveAllowedDirectoriesState([root]));
for (const label of ['cold', 'warm', 'warm']) {
  const t0 = performance.now();
  const r = await searchContent(root, 'NEEDLE_NOT_PRESENT', { maxResults: 10000 }, guard);
  console.log(label, Math.round(performance.now() - t0), 'ms', r.summary.filesScanned, 'files');
}
await rm(root, { recursive: true, force: true });
```

Check `resolveAllowedDirectoriesState` is exported from `dist/core/path.js`
(it is imported by `__tests__/helpers.ts:143-147` from `../src/core/path.ts`).
Record the warm number.

**Verify**: the script prints three lines; `filesScanned` is `5000`.

### Step 2: Characterization tests before touching the loop

In `__tests__/tools.test.ts`, after `'search_text context: a match beats context on a shared line and stops at the last line'` (line ~2530), add tests that pin the exact semantics the restructure must preserve:

```ts
it('search_text: anchors, word boundaries and CRLF behave per line (prefilter must not change them)', async () => {
  const dir = join(tmpDir, 'prefilter_semantics');
  await writeTestFile(tmpDir, 'prefilter_semantics/lf.txt', 'x\nimport a\n  import b\nfoo$bar\n');
  await writeTestFile(tmpDir, 'prefilter_semantics/crlf.txt', 'alpha\r\nbeta end\r\ngamma\r\n');

  const run = async (searchPattern: string, isRegex: boolean, caseSensitive = true) => {
    const r = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, searchPattern, isRegex, caseSensitive },
    });
    return (
      (r._meta as { matches?: { file: string; line: number; column: number }[] }).matches ?? []
    )
      .map((m) => `${m.file}:${m.line}:${m.column}`)
      .sort();
  };

  assert.deepStrictEqual(await run('^import', true), ['lf.txt:2:0']);
  assert.deepStrictEqual(
    await run('end$', true),
    ['crlf.txt:2:5'],
    'CRLF: $ matches before the stripped \\r',
  );
  assert.deepStrictEqual(await run('\\bimport\\b', true), ['lf.txt:2:0', 'lf.txt:3:2']);
  assert.deepStrictEqual(await run('IMPORT', false, false), ['lf.txt:2:0', 'lf.txt:3:2']);
  assert.deepStrictEqual(await run('foo$bar', false), ['lf.txt:4:0'], 'literal $ is escaped');
  assert.deepStrictEqual(await run('\\Aimport', true), ['lf.txt:2:0'], '\\A is start of each line');
});

it('search_text: the match set under maxResults is deterministic across runs', async () => {
  const dir = join(tmpDir, 'determinism');
  for (let i = 0; i < 40; i++) {
    await writeTestFile(
      tmpDir,
      `determinism/f${String(i).padStart(2, '0')}.txt`,
      'DET_HIT\nDET_HIT\nDET_HIT\n',
    );
  }
  const once = async () => {
    const r = await harness.client.callTool({
      name: 'search_text',
      arguments: { path: dir, searchPattern: 'DET_HIT', maxResults: 25 },
    });
    const meta = r._meta as { matches?: { file: string; line: number }[]; nextCursor?: string };
    return {
      first: (meta.matches ?? []).map((m) => `${m.file}:${m.line}`),
      cursor: meta.nextCursor,
    };
  };
  const a = await once();
  const b = await once();
  assert.deepStrictEqual(a.first, b.first);
  assert.strictEqual(a.first.length, 25);
});
```

(`maxResults` is the tool's page size; the engine collects up to
`MAX_SEARCH_RESULTS`. The second test therefore pins page stability; the
engine-level cap is pinned in step 4.)

**Verify**: `npm test -- --test-name-pattern="prefilter must not change\|deterministic across runs"`
→ both pass on the unmodified code (they are characterization tests). If
`\Aimport` does not return `lf.txt:2:0` today, drop that one assertion and
note it in the run log — do not adjust the engine to make it pass.

### Step 3: Whole-buffer prefilter

1. Extend `compileRegex`'s options to `{ caseSensitive?: boolean; multiline?: boolean }`
   and build the flags as
   `` `g${options.multiline ? 'm' : ''}${options.caseSensitive ? '' : 'i'}u` `` (RE2 accepts `m`).
2. In `searchContent`, compile a second regex for the whole-buffer test right
   after the existing one and free it in the same `finally`:

```ts
  const source = options.isRegex ? pattern || '' : escapeRegExp(pattern || '');
  const regex = compileRegex(source, { caseSensitive: Boolean(options.caseSensitive) });
  // Whole-buffer test: `m` makes ^/$ line-relative so a per-line hit is always a
  // buffer hit (the converse can be false — a false positive just falls through
  // to the per-line scan). \A/\z/\Z are buffer-relative even under `m`, and $
  // cannot see past a \r, so those inputs skip the prefilter (see canPrefilter).
  const prefilter = compileRegex(source, { caseSensitive: Boolean(options.caseSensitive), multiline: true });
  try {
    ...
  } finally {
    freeRegex(prefilter);
    freeRegex(regex);
  }
```

3. Add a module-private predicate and use it before splitting lines:

```ts
const BUFFER_ANCHOR_RE = /\\[AzZ]/u;
const CR = 13;

/** Whether one whole-buffer RE2 test is a sound "cannot match" check for this file. */
function canPrefilter(source: string, buffer: Buffer): boolean {
  if (buffer.length > RE2_MAX_INPUT_BYTES) return false;
  if (BUFFER_ANCHOR_RE.test(source)) return false;
  if (source.includes('$') && buffer.includes(CR)) return false;
  return true;
}
```

and in the scan, after the NUL check and before `content.split`:

```ts
const content = buffer.toString('utf-8');
if (canPrefilter(source, buffer)) {
  prefilter.lastIndex = 0;
  if (prefilter.exec(content) === null) continue; // no line can match
}
```

(`continue` here must still count the file in `filesScanned` — it was read
and scanned; it simply matched nothing.)

**Verify**: `npm run build && npm run type-check:test` → exit 0;
`npm test -- --test-name-pattern="search_text\|search"` → all pass, including
step 2's semantics test. Re-run the step-1 benchmark: the warm time drops
(expect roughly 2–4× on the no-match fixture; record the number).

### Step 4: Bounded-concurrency file scanning

Restructure the loop so each file's scan is one async unit dispatched by
`processEntriesConcurrently`, with results assembled **in walk order**:

1. Extract the per-file body into a module-private
   `scanFile(path, ctx)` that returns a discriminated result:

```ts
type FileScan =
  | { kind: 'inaccessible' }
  | { kind: 'tooLarge' }
  | { kind: 'binary' }
  | { kind: 'scanned'; matches: SearchResult[] };
```

It performs, in order: `pathGuard.validateExistingPath(path)` (catch →
`inaccessible`), `fsStat` size check (→ `tooLarge`, or `inaccessible` on
error), `readFile` (on error: if `signal.aborted` rethrow, else
`inaccessible`), NUL check (→ `binary`), prefilter, then the existing
per-line loop collecting into a local `matches` array (no cap inside a
file: the cap is applied once, below). 2. Replace `for await (const entry of guardedEntries(...))` with:

```ts
const perFile = new Map<number, FileScan>();
let dispatched = 0;
let collected = 0;
const stopped = await processEntriesConcurrently(entries, {
  signal: options.signal,
  concurrency: PARALLEL_CONCURRENCY,
  shouldStop: () => collected >= maxResults,
  onEntry: () => {
    dispatched++;
  },
  onError: () => {
    /* scanFile reports through its result; a throw here is an abort */
  },
  runEntry: async (entryPath) => {
    const index = dispatched - 1; // onEntry ran just before runEntry for this entry
    const scan = await scanFile(entryPath, scanCtx);
    perFile.set(index, scan);
    if (scan.kind === 'scanned') collected += scan.matches.length;
  },
});
```

`onEntry` is called synchronously before `runEntry` for the same entry
(see `concurrency.ts:160-170`), so capturing `dispatched - 1` at the top of
`runEntry` is the entry's walk index. Import `PARALLEL_CONCURRENCY` from
`./util.ts` (already imported: `escapeRegExp, getMaxTextFileSize, MIB` —
add it to that import). 3. Assemble in walk order and apply the cap once:

```ts
for (let i = 0; i < dispatched; i++) {
  const scan = perFile.get(i);
  if (!scan) continue; // never settled: only possible after an abort
  switch (scan.kind) {
    case 'inaccessible':
      skippedInaccessible++;
      break;
    case 'tooLarge':
      skippedTooLarge++;
      break;
    case 'binary':
      skippedBinary++;
      break;
    case 'scanned':
      filesScanned++;
      if (scan.matches.length > 0) filesMatched++;
      for (const m of scan.matches) {
        if (matches.length >= maxResults) break;
        matches.push(m);
        matchingLines++;
      }
  }
}
const stoppedReason = resolveStopReason(
  matches.length >= maxResults,
  stopped === 'timeout' || Boolean(options.signal?.aborted),
);
```

`resolveStopReason(hitCap, aborted)` (`concurrency.ts:20-25`) returns
`'maxResults'` when `hitCap`, else `'timeout'` when `aborted`, else
`undefined` — the same precedence the old loop used (`matches.length >= maxResults` first). Keep exactly that call shape. 4. Keep `truncated: stoppedReason !== undefined` and the rest of the summary
as they are. `matches` for a `scanned` file are already `own()`-copied
inside `scanFile`.

Note on `filesScanned`/`filesMatched`: up to `PARALLEL_CONCURRENCY - 1` files
past the cap may be scanned and counted (inherent to concurrent dispatch, as
`replace_text` already accepts). The **match set** is deterministic because
assembly is in walk order and the cap is applied after assembly.

Note on sharing one `regex`/`prefilter` across concurrent `scanFile` calls:
this is safe because the only `await`s in `scanFile` happen **before** any
RE2 use (guard, stat, read); the prefilter test and the per-line loop are
synchronous and run to completion without yielding, and both `execMatches`
and the prefilter reset `lastIndex` on entry. Do not introduce an `await`
between the prefilter and the end of the per-line loop.

**Verify**: `npm run build && npm run type-check:test && npm run lint` → exit
0; `npm test -- --test-name-pattern="search_text\|search\|sensitive files never surface"`
→ all pass (including externalization, cursor-stability, skipped-file and
binary tests, whose counts must be unchanged for their fixtures). Re-run the
benchmark and record the warm number; expect a further drop on a multi-core
runner.

### Step 5: Engine-level cap determinism test

Add to `__tests__/tools.test.ts` next to step 2's tests — this one drives the
engine directly (import `searchContent` from `../src/core/search.ts` and
`makeGuard` from `./helpers.ts`; both are already used or importable there):

```ts
it('searchContent under its own cap keeps the first matches in walk order', async () => {
  const root = await createTestRoot();
  try {
    for (let i = 0; i < 30; i++) {
      await writeTestFile(root, `w${String(i).padStart(2, '0')}.txt`, 'CAP_HIT\nCAP_HIT\n');
    }
    const guard = await makeGuard([root]);
    const a = await searchContent(root, 'CAP_HIT', { maxResults: 7 }, guard);
    const b = await searchContent(root, 'CAP_HIT', { maxResults: 7 }, guard);
    const key = (r: typeof a) => r.matches.map((m) => `${basename(m.file)}:${m.line}`);
    assert.deepStrictEqual(key(a), key(b));
    assert.strictEqual(a.matches.length, 7);
    assert.strictEqual(a.summary.stoppedReason, 'maxResults');
    assert.strictEqual(a.summary.truncated, true);
  } finally {
    await cleanupTestRoot(root);
  }
});
```

(`basename` from `node:path` — add to the test file's import if absent.)

**Verify**: `npm test -- --test-name-pattern="walk order"` → passes 5 times
in a row: `for ($i=0; $i -lt 5; $i++) { npm test -- --test-name-pattern="walk order" }` (PowerShell) — 0 failures.

### Step 6: Record and full check

`CHANGELOG.md`, `## [Unreleased]` → `### Changed`: `**\`search_text\` is faster on large trees.** Files are read with bounded concurrency and each file is tested once as a whole before its lines are scanned, so a search over thousands of non-matching files no longer approaches the 5 s limit. Results are unchanged; \`filesScanned\` may count a few files past the result cap.`

**Verify**: `npm run check` → exit 0, `fail 0`. Delete the benchmark script.

## Test plan

- New: per-line semantics characterization (anchors, `\b`, CRLF `$`, literal
  `$`, case-insensitive); page-level determinism; engine-level cap
  determinism (5 consecutive runs).
- Pattern: existing `search_text` tests around `tools.test.ts:2407-2740`; the
  engine-direct style follows `makeGuard` use in `path-guard-grant.test.ts`.
- Existing tests that must stay green with identical counts: `'search_text names the files it skipped'`, `'search_text skips binary files and reports the count'`, `'search_text externalizes the full match list on the first page only'`, `'search_text pages are stable and reject cursor query replay'`, and the boundary walk at `tools.test.ts:199` (sensitive files still never read — the guard call moved into `scanFile` but is still per file).

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -c "findLineMatches" src/core/search.ts` is unchanged from before (the per-line scan still exists, now behind the prefilter)
- [ ] `grep -n "processEntriesConcurrently" src/core/search.ts` → import + 1 use
- [ ] `grep -c "freeRegex(" src/core/search.ts` increased by exactly 1 (the prefilter is freed)
- [ ] The three new tests pass; the cap-determinism test passes 5/5
- [ ] Benchmark: warm time after step 4 ≤ 50% of the step-1 baseline on the same machine (record both numbers in the commit message or run log)
- [ ] `grep -rn "guardedEntries" src/core/search.ts` → still defined and still used by `searchFiles`
- [ ] CHANGELOG updated; `npx prettier --check .` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `new RE2(source, 'gmu')` throws for a pattern the `'gu'` compile accepts — `m` support differs from the typings; report and stop (the prefilter cannot be built).
- Step 2's semantics test fails **after** step 3 on any assertion — the prefilter has a false negative; report the pattern and file, do not weaken the assertion.
- Any existing `search_text` test's reported `filesScanned`/`skipped*` count changes for a fixture smaller than `PARALLEL_CONCURRENCY` files — that indicates a counting bug, not the accepted overrun.
- The benchmark after step 4 is not faster than after step 3 on a machine with ≥ 4 cores — report the numbers; do not add more concurrency.
- Plan 043's `explicitFile` / `singleEntry` branch is absent from `searchContent` — 043 has not landed; stop, since this plan's excerpts assume it.

## Maintenance notes

- `canPrefilter` is the correctness boundary: every new regex construct that
  behaves differently against a buffer than against a line (today: `\A`, `\z`,
  `\Z`, and `$` next to `\r`) must be added there. A reviewer should read it
  against RE2's syntax page before approving.
- Finding #2 from the audit — one `realpath` + one `stat` + one `read` per
  file — is untouched here. If the next measurement still shows syscall
  dominance, the safe next step is to let `scanFile` reuse the `stat` it
  already takes for the size check (it does) and to look at the guard's
  `realpath` only with a security review.
- `search_text`'s tool layer sorts by `file` then `line`; if that sort is
  ever removed, the engine's walk-order assembly becomes the wire order —
  keep the assembly deterministic either way.
