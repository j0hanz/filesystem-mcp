# Plan 018: Path inputs accept every legal file name; only a `..` segment is refused

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/schema.ts __tests__/tools.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

Every tool that takes a path (`read`, `edit`, `patch`, `create`, `move`,
`delete`, `stat`, `diff`, and the `path` argument of `list`, `find_files`,
`search_text`, `replace_text`) validates it with the shared `RequiredPath`
schema. That schema refuses any string that contains `..` _anywhere_, and any
string containing `;`, `|` or a backtick. None of those characters is special
to this server: no path ever reaches a shell, and root containment is enforced
separately by `PathGuard` after the path is resolved.

The cost is real in web repositories: catch-all route files such as
`app/blog/[...slug]/page.tsx`, `pages/[...all].vue` and
`src/routes/[...rest]/+page.svelte` contain `..` inside a segment. `list` shows
them, but `read` and `edit` answer `Directory traversal sequences ("..") are
forbidden`. Files like `docs/v1..2.md` or `a;b.txt` are refused the same way.
The advisor reproduced every case with `RequiredPath.safeParse`.

After this plan, a `..` is refused only when it is a whole path segment
(`../x`, `a/../b`), and `;`, `|`, backtick are ordinary characters. Newline,
carriage return and NUL stay refused.

## Current state

- `src/core/schema.ts` — shared zod input schemas. The path refinement lives
  at lines 42–79.
- `src/core/path.ts` — `PathGuard.validateAccess` (lines 440–471) normalizes
  the requested path with `normalizePath` (which resolves `..`) and then
  checks containment with `isPathWithinDirectories`; an escaping path throws
  `ACCESS_DENIED`. This is the real traversal guard and is **not** changed.
- `src/core/glob.ts` lines 20–30 — `isSafeGlobSyntax` has its own whole-string
  `..` check for glob _patterns_. Out of scope (see below).

```ts
// src/core/schema.ts:42-79
const MAX_PATH_LENGTH = 4096;

const SHELL_METACHAR_RE = /[\n\r;|`]/;

export const isBlank = (val: string): boolean => val.trim().length === 0;

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
        : (specific(val) ??
          (SHELL_METACHAR_RE.test(val)
            ? `${label} contains prohibited characters (newlines or shell metacharacters)`
            : undefined));
    if (issue !== undefined) {
      ctx.addIssue({ code: 'custom', message: issue, fatal: true });
    }
  };
}

export const RequiredPath = z
  .string()
  .min(1, { message: 'Path required' })
  .max(MAX_PATH_LENGTH, { message: `Path too long (max ${MAX_PATH_LENGTH} chars)` })
  .superRefine(
    refineSafeText('Path', (val) =>
      val.includes('..') ? 'Directory traversal sequences ("..") are forbidden' : undefined,
    ),
  )
  .describe('File or directory path inside an allowed workspace root.');
```

`refineSafeText` is also used by `SafeGlobPattern` (line 81–91), so the
`SHELL_METACHAR_RE` change below affects glob patterns too — that is intended
(a glob containing `;` is equally harmless).

No existing test sends a literal `..` through the schema: `TC-SEC-005`
(`__tests__/security.test.ts:41`) and `STDIO-CLI-002` build the path with
`join(...)`, which resolves `..` lexically before the string is sent.

Test conventions: `__tests__/tools.test.ts` uses one shared root `tmpDir` and
an in-memory client `harness` (`createTestClientPair`). A tool call is
`harness.client.callTool({ name, arguments })`; `firstTextBlock(result).text`
is the text block; `writeTestFile(tmpDir, 'rel/path', content)` creates a file
and returns its absolute path. Copy the shape of `TC-FUNC-001` (line 47).

## Commands you will need

| Purpose        | Command                                                           | Expected on success |
| -------------- | ----------------------------------------------------------------- | ------------------- |
| Static check   | `npm run check:static`                                            | exit 0              |
| All tests      | `npm test`                                                        | all pass            |
| One test file  | `node --test __tests__/tools.test.ts`                             | all pass            |
| Filter by name | `npm test -- --test-name-pattern="legal file names"`              | passes              |
| Format         | `npx prettier --write src/core/schema.ts __tests__/tools.test.ts` | exit 0              |

`npm run check:static` = build + `tsc -p tsconfig.test.json` + eslint
(`--max-warnings=0`) + `prettier --check .` + knip.

## Scope

**In scope** (the only files you should modify):

- `src/core/schema.ts` — the regex constant, its message, and the
  `RequiredPath` refinement
- `__tests__/tools.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/core/glob.ts` `isSafeGlobSyntax` — glob patterns keep the whole-string
  `..` rule; the comment there explains that `{a,..}` and `[..]` forms make a
  segment rule unsafe for patterns. A glob like `**/[...slug]/**` therefore
  stays refused; that is a separate, smaller finding.
- `src/core/path.ts` — containment is correct and untouched.
- `OptionalPath`, `SafeGlobPattern` definitions — they reuse the changed
  helper and need no edit.

## Git workflow

- Branch: `advisor/018-path-schema-legal-names` from `main`.
- One commit, conventional style matching the log, for example
  `fix(schema): refuse only a ".." segment; allow ; | and backtick in paths`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Regression test (it must fail now)

In `__tests__/tools.test.ts`, directly after `TC-FUNC-001` (ends at line 59),
add:

```ts
it('read accepts legal file names containing .. ; and backtick, refuses a .. segment', async () => {
  const cases = ['app/blog/[...slug]/page.tsx', 'docs/v1..2.md', 'semi;colon.txt', 'back`tick.txt'];
  for (const rel of cases) {
    const file = await writeTestFile(tmpDir, `legal-names/${rel}`, `content of ${rel}\n`);
    const result = await harness.client.callTool({ name: 'read', arguments: { path: file } });
    assert.notStrictEqual(result.isError, true, `${rel} must be readable`);
    assert.ok(firstTextBlock(result).text?.includes(`content of ${rel}`), rel);
  }

  // A whole ".." segment is still refused at the schema, before any fs access.
  // Built by string concatenation: `join` would collapse the `..` lexically.
  const traversal = `${tmpDir.replaceAll('\\', '/')}/legal-names/../legal-names/docs/v1..2.md`;
  const refused = await harness.client.callTool({
    name: 'read',
    arguments: { path: traversal },
  });
  assert.strictEqual(refused.isError, true);
  assert.match(firstTextBlock(refused).text ?? '', /Directory traversal/);
});
```

`writeTestFile` and `firstTextBlock` are already imported in this file.

**Verify**: `npm test -- --test-name-pattern="legal file names"` → **fails**:
the first `read` returns `isError: true` with the traversal message. If it
passes, STOP.

### Step 2: Fix the schema

In `src/core/schema.ts`:

1. Replace line 44 with:

   ```ts
   const LINE_BREAK_RE = /[\n\r]/;
   ```

2. In `refineSafeText`, replace the `SHELL_METACHAR_RE.test(val)` branch
   (lines 59–61) with:

   ```ts
   (LINE_BREAK_RE.test(val)
     ? `${label} cannot contain line breaks`
     : undefined));
   ```

3. Add, directly above `export const RequiredPath`:

   ```ts
   // Only a whole `..` segment is traversal. `..` inside a segment
   // (`[...slug]`, `v1..2.md`) is a plain file name; PathGuard re-checks
   // containment on the resolved path regardless.
   const hasTraversalSegment = (val: string): boolean => val.split(/[\\/]/u).includes('..');
   ```

4. Change the `RequiredPath` refinement to:

   ```ts
   refineSafeText('Path', (val) =>
     hasTraversalSegment(val) ? 'Directory traversal sequences ("..") are forbidden' : undefined,
   ),
   ```

5. Run `npx prettier --write src/core/schema.ts __tests__/tools.test.ts`.

**Verify**:

- `npm test -- --test-name-pattern="legal file names"` → passes.
- `grep -n "SHELL_METACHAR_RE\|val.includes('..')" src/core/schema.ts` → no
  output.

### Step 3: Full gate

**Verify**: `npm run check` → exit 0. Every existing test must still pass; in
particular `TC-SEC-005`, `STDIO-CLI-002` and every `find_files` /
`search_text` pattern test.

## Test plan

- New test (Step 1) covers: `[...slug]` route file, `v1..2.md`, `;` and
  backtick names readable; a literal `..` segment refused with the traversal
  message. `|` is not tested because it is illegal in Windows file names.
- Existing tests that must keep passing unchanged: `TC-SEC-005` (guard-level
  traversal), `STDIO-CLI-002`, all `SafeGlobPattern` consumers.
- Verification: `npm test` → all pass, including the new one.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] The new test exists and passes
- [ ] `grep -n "SHELL_METACHAR_RE" src/core/schema.ts` prints nothing
- [ ] `grep -n "hasTraversalSegment" src/core/schema.ts` prints the
      definition and the one use
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 018 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `src/core/schema.ts:42-79` no longer matches the
  excerpt.
- The regression test passes before Step 2.
- After Step 2, any `search_text` / `find_files` / `replace_text` test fails —
  that would mean a glob-pattern test relied on the `;|`` rejection; report
which, do not change `isSafeGlobSyntax`.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- `hasTraversalSegment` treats both `/` and `\` as separators on every
  platform. That is stricter than the runtime rule (backslash separates only
  on Windows, plan 003) and deliberately so: a POSIX file literally named
  `..\x` is not worth a platform branch here.
- Reviewer focus: the only traversal guard that matters is
  `PathGuard.validateAccess`; this schema check is defense in depth and must
  never be the sole barrier.
- Deferred: `isSafeGlobSyntax` still rejects `..` anywhere in a glob, so
  `**/[...slug]/**` patterns are refused. Fixing that needs bracket-aware
  parsing; open a separate finding if a user hits it.
