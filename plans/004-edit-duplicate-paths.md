# Plan 004: `edit` refuses a batch that names the same file twice

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7ee3d49f..HEAD -- src/tools/edit.ts __tests__/tools.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plans 002 and 005 also edit
> `src/tools/edit.ts`, but in `findEditMatches`/`applyEdits`, not in the input
> schema — a diff limited to those functions is expected and is not drift.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `7ee3d49f`, 2026-09-25

## Why this matters

`edit` batch mode takes `files: [{ path, edits }, …]` (up to 5) and processes
the entries **in parallel**: each one reads the file, applies its edits and
writes the file back on its own. If two entries name the same file, the last
write wins and the other entry's edits are lost — and both entries report
success. Reproduced: `files: [{path: f, edits:[alpha→A]}, {path: f, edits:[beta→B]}]`
on `"alpha\nbeta\n"` left `"alpha\nB\n"` while the summary said
`dup.txt +1 -1 · dup.txt +1 -1`. The sibling batch tools already guard this
(`move` rejects a second entry with the same destination; `delete`
de-duplicates). After this plan, `edit` rejects such a batch at input
validation, before any file is touched, and tells the caller to merge the
entries.

## Current state

- `src/tools/edit.ts` — the `edit` tool. `EditFileInputSchema` (lines 53-116)
  validates input with a `.superRefine` (lines 82-110) that already enforces
  "exactly one of `path`/`files`". The `run` function (line ~498) hands
  `files` to `runOverPaths` (`src/tools/batch.ts`), which runs entries
  concurrently via `processInParallel`.
- `src/core/path-utils.ts:177-184` — `isSamePath(left, right)`: resolves both
  and case-folds on Windows/macOS. Relative tool paths are resolved the same
  way by the guard (`normalizePath` → `path.resolve`), so `isSamePath` agrees
  with how the guard sees the paths.

`src/tools/edit.ts:82-110` (the existing refine — add the new check at its end):

```ts
  .superRefine((value, ctx) => {
    const hasPath = value.path !== undefined;
    const hasFiles = value.files !== undefined;
    if (hasPath === hasFiles) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: "Provide exactly one of 'path' or 'files'",
        input: value,
      });
    }
    if (hasPath && value.edits === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['edits'],
        message: "'edits' required when using 'path'",
        input: value,
      });
    }
    if (hasFiles && value.edits !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['edits'],
        message: "'edits' not allowed with 'files'; each file carries its own edits",
        input: value,
      });
    }
  })
```

The exemplar for the policy (fail the duplicate, keep the first) is `move`'s
guard at `src/tools/move.ts:279-303`:

```ts
// Two sources targeting the same destination in one batch would otherwise
// collapse to a single shared overwrite confirmation and let the second
// one silently clobber the first's freshly-written content. Fail closed:
// only the first plan per destination proceeds; later ones targeting the
// same destination are reported as a per-item failure.
const seenDest = new Set<string>();
```

A validation issue reaches the client as an error result whose text starts
with `Input validation error: Invalid arguments for tool edit:` followed by
`<path>: <message>` (observed for other refines in this repo).

## Commands you will need

| Purpose        | Command                                                                     | Expected on success |
| -------------- | --------------------------------------------------------------------------- | ------------------- |
| Install        | `npm ci`                                                                    | exit 0              |
| Typecheck      | `npm run type-check:test`                                                   | exit 0              |
| Filtered tests | `node --test --test-name-pattern="same file twice" __tests__/tools.test.ts` | pass                |
| All edit tests | `node --test --test-name-pattern="edit" __tests__/tools.test.ts`            | all pass            |
| Lint           | `npm run lint`                                                              | exit 0              |
| Format files   | `npx prettier --write <files>`                                              | exit 0              |
| Full gate      | `npm run check`                                                             | exit 0              |

## Scope

**In scope**:

- `src/tools/edit.ts` — the `EditFileInputSchema` `.superRefine` and one import.
- `__tests__/tools.test.ts`

**Out of scope**:

- `src/tools/batch.ts` — `runOverPaths` is shared by `read`, `stat`, and
  others where duplicate paths are harmless reads; do not add a generic
  duplicate check there.
- `src/tools/move.ts`, `src/tools/delete.ts` — already guarded.
- The published JSON schema `.meta({ oneOf: … })` — JSON Schema cannot express
  "unique by resolved path"; leave it.

## Git workflow

- Branch: `advisor/004-edit-duplicate-paths` from `main`.
- One commit, e.g. `fix(edit): reject a batch that names one file twice`, body
  says why. If you are an AI agent, end with a `Co-Authored-By:` trailer naming
  your model, as recent commits do.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing test

In `__tests__/tools.test.ts`, near the other `edit` tests (after
`edit lists at most five matched lines`, around line 660), add
`edit refuses a batch that names the same file twice`:

```ts
it('edit refuses a batch that names the same file twice', async () => {
  const original = 'alpha\nbeta\n';
  const file = await writeTestFile(tmpDir, 'dup-batch/dup.txt', original);
  const result = await harness.client.callTool({
    name: 'edit',
    arguments: {
      files: [
        { path: file, edits: [{ oldText: 'alpha', newText: 'A' }] },
        { path: file, edits: [{ oldText: 'beta', newText: 'B' }] },
      ],
    },
  });
  assert.strictEqual(result.isError, true);
  assert.match(firstTextBlock(result).text ?? '', /duplicate of files\[0\]\.path/u);
  assert.strictEqual(await readFile(file, 'utf-8'), original);
});
```

**Verify**: `node --test --test-name-pattern="same file twice" __tests__/tools.test.ts`
→ **fails** (today `isError` is not true and the file changes).

### Step 2: Add the duplicate check to the refine

In `src/tools/edit.ts`:

1. Add `import { isSamePath } from '../core/path-utils.ts';` in the relative
   imports group (Prettier sorts it).
2. At the end of the `.superRefine` callback (after the third `if`), add:

```ts
// Batch entries run in parallel and each rewrites its file whole, so two
// entries for one file race: the last write wins and the other's edits are
// lost while both report success. One entry per file.
const files = value.files ?? [];
for (const [index, file] of files.entries()) {
  const first = files.findIndex((other) => isSamePath(other.path, file.path));
  if (first < index) {
    ctx.addIssue({
      code: 'custom',
      path: ['files', index, 'path'],
      message: `duplicate of files[${String(first)}].path; put every edit for one file in a single entry`,
      input: value,
    });
  }
}
```

(`files` has at most 5 entries, so the quadratic scan is fine.)

**Verify**: `node --test --test-name-pattern="same file twice" __tests__/tools.test.ts` → pass.

### Step 3: Confirm nothing else changed and run the gate

`npx prettier --write src/tools/edit.ts __tests__/tools.test.ts`

**Verify**:

- `node --test --test-name-pattern="edit" __tests__/tools.test.ts` → all pass.
- `npm run check` → exit 0.

## Test plan

- New: two entries with the identical path → `isError`, message names
  `files[0]`, file untouched.
- Optional second assertion in the same test (add it): on Windows or macOS
  only (`process.platform === 'win32' || process.platform === 'darwin'`), the
  same batch with the second path upper-cased in its basename is also
  refused; skip the assertion elsewhere, since Linux paths are case-sensitive.
- Existing: every `edit` test, especially batch ones, stays green.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `node --test --test-name-pattern="same file twice" __tests__/tools.test.ts` → 1 pass
- [ ] `grep -n "isSamePath" src/tools/edit.ts` → import + 1 use
- [ ] `git status` shows only `src/tools/edit.ts` and `__tests__/tools.test.ts` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The validation error text does not contain the issue message (the test's
  regex fails although the call is refused) — report the actual text instead
  of loosening the check.
- An existing test sends a batch with a repeated path and expects success.
- The fix seems to require touching `batch.ts` or another tool.

## Maintenance notes

- `isSamePath` is lexical: two different spellings that reach the same file
  through a symlink are not caught. That is the same ceiling `move`'s
  `seenDest` has; closing it would need resolving every path before
  validation, which the guard does later per entry.
- If `MAX_MULTI_FILES` is raised far above 5, replace the `findIndex` scan
  with a `Map` keyed by `normalizeCaseForComparison(resolve(path))`.
- An alternative design — merging the entries' edit lists — was rejected:
  their relative order would be a guess, and the error is one retry away.
