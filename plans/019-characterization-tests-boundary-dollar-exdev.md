# Plan 019: Pin the sensitive-file boundary end to end, `replace_text` `$`-expansion, and `move`'s EXDEV fallback

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/tools/move.ts src/tools/replace-text.ts src/core/search.ts __tests__/tools.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none — but run this plan **before** plans 020 and 021, which
  change `src/tools/replace-text.ts`
- **Category**: tests
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

Three pieces of behavior that the server's safety story depends on have no
test that would fail if they broke:

1. **Sensitive-file denial on the walking tools.** `security.test.ts` proves
   `PathGuard` refuses `.env`, `*.pem` and `*id_rsa*`, but only by calling the
   guard directly. `search_text`, `find_files`, `list` and `replace_text` rely
   on `guardedEntries` (`src/core/search.ts:338-360`) swallowing that denial
   per entry, and on `replace_text` opening files through the guarded
   filesystem. A refactor of the walk could start returning `.env` contents
   with every test green. Today the behavior is correct (verified during the
   audit): with `includeHidden: true` all four tools skip `app/.env`.
2. **`$`-expansion in `replace_text`.** `expandDollarTokens`
   (`src/tools/replace-text.ts:183-210`) is a hand-written copy of
   `String.prototype.replace`'s template rules (`$1`, `$&`, `` $` ``, `$'`,
   `$$`, `$<name>`, the `$12` precedence). Coverage shows lines 192–208 never
   run under `npm test`. This code mutates files.
3. **`move`'s cross-device fallback.** `performRenameWithFallback`
   (`src/tools/move.ts:416-464`) copies then deletes on `EXDEV`, and has a
   dedicated error for "copy succeeded but delete failed". Lines 425–463 have
   never executed in CI (a temp dir cannot produce EXDEV).

Plans 020 and 021 edit `replace-text.ts`; these tests are their safety net.

## Current state

### Sensitive boundary

```ts
// src/core/search.ts:338-360
async function* guardedEntries(
  entries: AsyncIterable<GlobEntry>,
  pathGuard: PathGuard,
  signal: AbortSignal | undefined,
  counters: { skippedInaccessible: number; stoppedByAbort: boolean },
): AsyncGenerator<GlobEntry> {
  for await (const entry of entries) {
    if (signal?.aborted) {
      counters.stoppedByAbort = true;
      return;
    }
    try {
      await pathGuard.validateExistingPath(entry.path);
    } catch {
      counters.skippedInaccessible++;
      continue;
    }
    yield entry;
  }
}
```

Result shapes (from `result._meta`, the structured half):

- `search_text`: `{ matches: { file, line, content, ... }[], totalMatches }`
  where `file` is relative to the searched directory
  (`src/tools/search-text.ts:87,216`).
- `find_files`: `{ results: { path }[] }` with `path` relative to the searched
  directory (`src/tools/find-files.ts:140`).
- `list`: `{ entries: { name, ... }[] }` (`__tests__/stdio.test.ts:152` reads
  it this way).
- `replace_text`: `{ results, summary, totalMatches }`.
- `resources/read` of a denied file rejects (the resource layer maps
  `ACCESS_DENIED` to not-found — `src/resources.ts`, `isNotFoundish`).

The only tool-level sensitive test today is `TC-FUNC-009j`
(`__tests__/tools.test.ts:158`, `create` with `append` on `.env`).

### `$`-expansion

```ts
// src/tools/replace-text.ts:171-210
const DOLLAR_TOKEN = /\$(\$|&|`|'|<([^>]*)>|\d{1,2})/g;

function expandDollarTokens(
  template: string,
  match: string,
  groups: (string | undefined)[],
  offset: number,
  input: string,
  named: Record<string, string> | undefined,
): string {
  return template.replace(DOLLAR_TOKEN, (token: string, kind: string, name?: string) => {
    if (kind === '$') return '$';
    if (kind === '&') return match;
    if (kind === '`') return input.slice(0, offset);
    if (kind === "'") return input.slice(offset + match.length);
    if (name !== undefined) {
      if (named && Object.hasOwn(named, name)) return named[name] ?? '';
      return token;
    }
    // `$12` prefers group 12, then falls back to group 1 followed by a literal
    // `2`, and stays literal when neither exists — RegExp's own precedence.
    const two = Number.parseInt(kind, 10);
    if (kind.length === 2 && two >= 1 && two <= groups.length) return groups[two - 1] ?? '';
    const one = Number.parseInt(kind.slice(0, 1), 10);
    if (one >= 1 && one <= groups.length) {
      return (groups[one - 1] ?? '') + (kind.length === 2 ? kind.slice(1) : '');
    }
    return token;
  });
}
```

Expansion runs only when `isRegex: true` (`replace-text.ts:233-247`). The
regex matcher is also used for `caseSensitive: false` and `wholeWord`, and
there the replacement is inserted verbatim. The function is module-private;
test it through the tool. Existing pattern: `TC-FUNC-013r`
(`__tests__/tools.test.ts:1779`) calls `replace_text` with
`{ path, searchPattern, replacement, ... }` and reads the file back.

### EXDEV fallback

```ts
// src/tools/move.ts:416-431 (function is module-private today)
async function performRenameWithFallback(
  validSource: string,
  validDest: string,
  fsOps: Pick<GuardedFileSystem, 'rename' | 'cp' | 'rm'>,
  originalSource: string,
): Promise<void> {
  try {
    await fsOps.rename(validSource, validDest);
  } catch (error: unknown) {
    rethrowIfAborted(error);

    if (!isNodeError(error) || error.code !== 'EXDEV') {
      throw error;
    }
    // EXDEV: copy then remove ... (lines 431-463)
```

On the copy-succeeded-then-rm-failed path it throws an `FsError` whose message
contains `copy succeeded but source removal failed (destination holds a copy)`.
`fsOps` is already an injectable seam, so a plain object with three async
functions is a complete fake — no mocking library.

Test conventions: `node:test` + `node:assert/strict`; helpers in
`__tests__/helpers.ts` (`createTestRoot`, `cleanupTestRoot`,
`createTestClientPair`, `writeTestFile`, `firstTextBlock`, `fsErrorMatcher`,
`trySymlink`). knip's entry set is `__tests__/**/*.test.ts`, so a symbol
exported from `src/` and imported only by a test is **not** reported unused.

## Commands you will need

| Purpose        | Command                                                   | Expected on success |
| -------------- | --------------------------------------------------------- | ------------------- |
| Static check   | `npm run check:static`                                    | exit 0              |
| All tests      | `npm test`                                                | all pass            |
| Tools file     | `node --test __tests__/tools.test.ts`                     | all pass            |
| EXDEV file     | `node --test __tests__/move-exdev.test.ts`                | all pass            |
| Filter by name | `npm test -- --test-name-pattern="sensitive files never"` | passes              |
| Format         | `npx prettier --write __tests__/ src/tools/move.ts`       | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `__tests__/tools.test.ts` — two new tests (boundary, `$`-expansion)
- `__tests__/move-exdev.test.ts` — new file
- `src/tools/move.ts` — add `export` to `performRenameWithFallback` (one
  word; no logic change)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- Any behavior change in `replace-text.ts`, `search.ts`, `move.ts` — these are
  characterization tests. If a test reveals a bug, STOP and report it.
- `__tests__/security.test.ts` — guard-level tests stay as they are.

## Git workflow

- Branch: `advisor/019-characterization-tests` from `main`.
- One commit per test group is fine, e.g.
  `test(tools): pin sensitive-file denial across the walking tools`,
  `test(replace_text): pin $-expansion against the RegExp oracle`,
  `test(move): pin the EXDEV copy-then-remove fallback`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Sensitive-file boundary through every walking tool

In `__tests__/tools.test.ts`, directly after `TC-FUNC-009j` (the `create` on
`.env` test that starts at line 158), add:

```ts
it('sensitive files never surface through search_text, find_files, list, replace_text or resources/read', async () => {
  const token = 'SENTINEL_ENV_9f3c1e';
  const dir = join(tmpDir, 'boundary_walk');
  const envFile = await writeTestFile(tmpDir, 'boundary_walk/.env', `SECRET=${token}\n`);
  const plain = await writeTestFile(tmpDir, 'boundary_walk/plain.txt', `note ${token}\n`);

  const search = await harness.client.callTool({
    name: 'search_text',
    arguments: { path: dir, searchPattern: token, includeHidden: true },
  });
  const matches = (search._meta as { matches?: { file: string }[] }).matches ?? [];
  assert.deepStrictEqual(
    matches.map((m) => m.file),
    ['plain.txt'],
    'search_text must not match inside .env',
  );

  const found = await harness.client.callTool({
    name: 'find_files',
    arguments: { path: dir, pattern: '**/*', includeHidden: true },
  });
  const paths = (found._meta as { results?: { path: string }[] }).results?.map((r) => r.path) ?? [];
  assert.ok(paths.includes('plain.txt'));
  assert.ok(!paths.includes('.env'), `find_files must not list .env: ${paths.join(',')}`);

  const listed = await harness.client.callTool({
    name: 'list',
    arguments: { path: dir, includeHidden: true },
  });
  const names =
    (listed._meta as { entries?: { name: string }[] }).entries?.map((e) => e.name) ?? [];
  assert.ok(names.includes('plain.txt'));
  assert.ok(!names.includes('.env'), `list must not show .env: ${names.join(',')}`);

  const replaced = await harness.client.callTool({
    name: 'replace_text',
    arguments: { path: dir, searchPattern: token, replacement: 'REDACTED', includeHidden: true },
  });
  assert.notStrictEqual(replaced.isError, true);
  assert.strictEqual(
    await readFile(envFile, 'utf-8'),
    `SECRET=${token}\n`,
    '.env must be untouched',
  );
  assert.strictEqual(await readFile(plain, 'utf-8'), 'note REDACTED\n');

  await assert.rejects(
    harness.client.readResource({ uri: buildFileResourceUri(envFile) }),
    'resources/read of a sensitive file must be refused',
  );
});
```

Add `import { buildFileResourceUri } from '../src/core/file-uri.ts';` to the
imports (keep the import block sorted; `npx prettier --write` sorts it).
`readFile` and `join` are already imported.

**Verify**: `npm test -- --test-name-pattern="sensitive files never"` → passes
(this is a characterization test; the behavior is already correct). If any
assertion fails, STOP — it is a bug, not a test problem.

### Step 2: `$`-expansion table test

In `__tests__/tools.test.ts`, directly after `TC-FUNC-013r` (line 1779–1790),
add:

```ts
it('replace_text expands $ tokens exactly like String.prototype.replace', async () => {
  const twelve = '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)';
  const cases: { input: string; pattern: string; replacement: string }[] = [
    { input: 'xaby', pattern: '(a)(b)', replacement: '[$1|$2]' },
    { input: 'xaby', pattern: '(a)(b)', replacement: '<$&>' },
    { input: 'xaby', pattern: '(a)(b)', replacement: '{$`}' },
    { input: 'xaby', pattern: '(a)(b)', replacement: "{$'}" },
    { input: 'xaby', pattern: '(a)(b)', replacement: '$$1' },
    { input: 'xaby', pattern: '(a)', replacement: '$12' },
    { input: 'xaby', pattern: '(a)', replacement: '$0' },
    { input: 'xaby', pattern: '(a)', replacement: '$100' },
    { input: 'xaby', pattern: '(a)', replacement: 'end$' },
    { input: 'xaby', pattern: '(a)', replacement: '$3' },
    { input: 'abcdefghijkl', pattern: twelve, replacement: '$12' },
    { input: '\u{1F600}ab', pattern: '(a)', replacement: '$`' },
  ];
  for (const [i, c] of cases.entries()) {
    const file = await writeTestFile(tmpDir, `dollar/case${String(i)}.txt`, c.input);
    const result = await harness.client.callTool({
      name: 'replace_text',
      arguments: {
        path: file,
        searchPattern: c.pattern,
        replacement: c.replacement,
        isRegex: true,
      },
    });
    assert.notStrictEqual(result.isError, true, `case ${String(i)} errored`);
    const expected = c.input.replace(new RegExp(c.pattern, 'g'), c.replacement);
    assert.strictEqual(
      await readFile(file, 'utf-8'),
      expected,
      `case ${String(i)}: ${c.replacement}`,
    );
  }

  // A literal search reaches the regex matcher when it is case-insensitive,
  // and there the replacement must stay verbatim.
  const literal = await writeTestFile(tmpDir, 'dollar/literal.txt', 'Alpha alpha');
  await harness.client.callTool({
    name: 'replace_text',
    arguments: { path: literal, searchPattern: 'ALPHA', replacement: '$1', caseSensitive: false },
  });
  assert.strictEqual(await readFile(literal, 'utf-8'), '$1 $1');
});
```

**Verify**: `npm test -- --test-name-pattern="expands \\$ tokens"` → passes.
If one case fails, STOP and report the case index and both strings.

### Step 3: Export the EXDEV seam

In `src/tools/move.ts` line 416, change
`async function performRenameWithFallback(` to
`export async function performRenameWithFallback(`. Nothing else.

**Verify**: `npm run build` → exit 0.

### Step 4: EXDEV fallback unit test

Create `__tests__/move-exdev.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.ts';
import type { GuardedFileSystem } from '../src/core/fs.ts';
import { performRenameWithFallback } from '../src/tools/move.ts';

type FsOps = Pick<GuardedFileSystem, 'rename' | 'cp' | 'rm'>;

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: fake`), { code });

function fakeOps(behavior: {
  rename?: () => Promise<void>;
  cp?: () => Promise<void>;
  rm?: () => Promise<void>;
}): { ops: FsOps; calls: string[] } {
  const calls: string[] = [];
  const ops = {
    rename: async () => {
      calls.push('rename');
      await (behavior.rename ?? (() => Promise.resolve()))();
    },
    cp: async () => {
      calls.push('cp');
      await (behavior.cp ?? (() => Promise.resolve()))();
    },
    rm: async () => {
      calls.push('rm');
      await (behavior.rm ?? (() => Promise.resolve()))();
    },
  } as unknown as FsOps;
  return { ops, calls };
}

describe('performRenameWithFallback (EXDEV)', () => {
  it('a plain rename never copies', async () => {
    const { ops, calls } = fakeOps({});
    await performRenameWithFallback('/src', '/dst', ops, 'src');
    assert.deepStrictEqual(calls, ['rename']);
  });

  it('EXDEV falls back to copy then remove', async () => {
    const { ops, calls } = fakeOps({ rename: () => Promise.reject(errno('EXDEV')) });
    await performRenameWithFallback('/src', '/dst', ops, 'src');
    assert.deepStrictEqual(calls, ['rename', 'cp', 'rm']);
  });

  it('a non-EXDEV rename error is rethrown untouched', async () => {
    const { ops, calls } = fakeOps({ rename: () => Promise.reject(errno('EACCES')) });
    await assert.rejects(
      performRenameWithFallback('/src', '/dst', ops, 'src'),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'EACCES',
    );
    assert.deepStrictEqual(calls, ['rename']);
  });

  it('a failed copy rethrows the copy error and never removes the source', async () => {
    const { ops, calls } = fakeOps({
      rename: () => Promise.reject(errno('EXDEV')),
      cp: () => Promise.reject(errno('ENOSPC')),
    });
    await assert.rejects(
      performRenameWithFallback('/src', '/dst', ops, 'src'),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOSPC',
    );
    assert.deepStrictEqual(calls, ['rename', 'cp']);
  });

  it('copy ok but remove failed says the destination holds a copy', async () => {
    const { ops } = fakeOps({
      rename: () => Promise.reject(errno('EXDEV')),
      rm: () => Promise.reject(errno('EPERM')),
    });
    await assert.rejects(performRenameWithFallback('/src', '/dst', ops, 'src'), (err: unknown) => {
      assert.ok(isFsError(err));
      assert.notStrictEqual(err.code, ErrorCode.CANCELLED);
      assert.match(
        err.message,
        /copy succeeded but source removal failed \(destination holds a copy\)/,
      );
      return true;
    });
  });
});
```

Run `npx prettier --write __tests__/move-exdev.test.ts __tests__/tools.test.ts`.

**Verify**: `node --test __tests__/move-exdev.test.ts` → 5 pass.

### Step 5: Full gate

**Verify**: `npm run check` → exit 0 (knip must not report
`performRenameWithFallback` — the test import counts as a use).

## Test plan

- Step 1: one end-to-end test, five assertions (search_text, find_files, list,
  replace_text, resources/read).
- Step 2: twelve `$` cases compared against `String.prototype.replace`, plus
  one literal case-insensitive case that must stay verbatim.
- Step 4: five unit cases for the EXDEV seam using a hand-written fake.
- Verification: `npm test` → all pass, 3 new `it` blocks in `tools.test.ts`
  region plus 5 in the new file.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `node --test __tests__/move-exdev.test.ts` reports 5 pass
- [ ] `npm test -- --test-name-pattern="sensitive files never"` passes
- [ ] `npm test -- --test-name-pattern="expands"` passes
- [ ] `grep -n "^export async function performRenameWithFallback" src/tools/move.ts` prints one line
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 019 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any Step 1 assertion fails — that is a security bug, report it with the
  tool name and the observed output.
- Any Step 2 case fails — report the case index, expected and actual file
  contents; do not edit `expandDollarTokens`.
- RE2 rejects one of the Step 2 patterns (an `isError` result mentioning the
  pattern) — report which; the twelve-group pattern is the likely one.
- knip reports `performRenameWithFallback` as unused after Step 5.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Plans 020 and 021 change `replace-text.ts`; run this file's tests first
  after either lands.
- The Step 2 oracle is `String.prototype.replace` with a JS `RegExp`; keep the
  patterns to syntax RE2 and JS share (no lookaround, no backreferences) or the
  oracle diverges for reasons unrelated to `$` handling.
- Named groups (`$<name>`) are not covered: RE2's named-group syntax support in
  `@adguard/re2-wasm` was not verified. Add a case once confirmed.
