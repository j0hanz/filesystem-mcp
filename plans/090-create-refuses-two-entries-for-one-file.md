# Plan 090: `create` refuses a second entry that lands on a file another entry already writes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- src/tools/create.ts __tests__/create.test.ts CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

The `create` tool writes several files in one call, in parallel. Its input
schema refuses two entries for one file, but it can only compare how the paths
are _spelled_. Two entries that reach one file through a symlinked (or
junction) folder pass the schema. With `overwrite: true` on both, both writes
run, the last one wins, and **both rows report success with their own sizes**.
One entry's content is lost and nothing says so. The `move` and `delete` tools
already settle this after planning, by resolved path. `create` must do the
same.

## Current state

Files:

- `src/tools/create.ts`: the `create` tool. `handleCreate` plans every file,
  asks the Confirmation, then executes.
- `src/tools/move.ts`: exemplar: it fails a later entry that targets a
  destination an earlier entry already targets.
- `__tests__/create.test.ts`: tests; drives the tool body through
  `runToolBodyResult` (no MCP wire).
- `CHANGELOG.md`: user-visible fixes get one line under `## [Unreleased]` →
  `### Fixed`.

The schema rule that only compares spellings (`src/tools/create.ts:114-131`):

```ts
    // Entries write in parallel and each replaces its file whole, so two
    // entries for one path race: the last rename wins and the other's
    // content is lost while both report success. One entry per file, counting
    // the Unicode spellings the path guard resolves to one name (#101).
    for (const [index, file] of files.entries()) {
      const normFile = normalizePath(file.path);
      const first = files.findIndex((other) =>
        isEquivalentPath(normalizePath(other.path), normFile),
      );
```

Planning in `handleCreate` (`src/tools/create.ts:286-298`):

```ts
const { slots, planned } = await planIntoSlots<
  CreateFileItem,
  CreateFilePlanResult,
  CreateSlotValue
>(
  files,
  (file) => file.path,
  (file) => planFile(file, ctx),
  ctx.signal,
);
const plans = new Map(planned.map(({ index, value }) => [index, value.plan]));
```

Nothing between that line and the `confirm(...)` call compares
`plan.validPath` across entries.

A plan (`src/core/fs.ts:154-160`), for reference; do not change it:

```ts
export interface CreatePlan {
  readonly inputPath: string;
  readonly validPath: string;
  readonly kind: 'append' | 'overwrite' | 'clear' | 'pending';
  /** The sealed Landing identity; present iff kind is 'pending'. */
  readonly identity?: EntryIdentity;
}
```

- `validPath` is the **Landing**: the path with symlinks resolved. Two
  spellings of one file through a linked folder get the same `validPath`.
- `kind` meanings: `append` adds to the file; `overwrite` is
  `overwrite: true` given up front; `clear` means no file was there at plan
  time; `pending` means a file is there and the user must approve.

The exemplar in `src/tools/move.ts:164-187`:

```ts
  const seenDest = new Set<string>();
  const ready: IndexedPlan[] = [];
  for (const candidate of candidates) {
    // Unicode-folded too: two spellings of one missing name land on one file
    // once the first move creates it (#101).
    const destKey = unicodeMatchKey(candidate.plan.destination);
    if (seenDest.has(destKey)) {
      slots[candidate.index] = {
        status: 'failure',
        path: candidate.plan.request.source,
        error: pairFailure(
          candidate.plan.request,
          new FsError(
            ErrorCode.INVALID_INPUT,
            `${VERB[op]} cancelled: another entry in this batch already targets destination "${candidate.plan.request.destination}"`,
            candidate.plan.request.destination,
          ),
        ).error,
      };
      continue;
    }
```

Helpers that already exist in `src/tools/create.ts`:

```ts
function toCreateFailure(path: string, error: unknown): CreateFailure {
  return { path, error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, path) };
}
```

`unicodeMatchKey` is exported from `src/core/path-utils.ts:214`. `create.ts`
already imports `isEquivalentPath, isPathInsideDirectory, normalizePath` from
that module, and `ErrorCode, FsError, Problem` from `../core/errors.ts`.

**A decided behavior you must keep.** `__tests__/create.test.ts` has the test
`'asks once about two spellings of one file; the skip is honored'`: two
entries for one _existing_ file with no `overwrite` flag (both plans are
`pending`) ask **one** question, and a "skip" answer reports **both** as
skipped. The project glossary says: "Two items that name one entry ask one
question". So a later `pending` entry must NOT be failed by this plan.

Glossary terms to use in comments: **Landing** (where a write ends up, with a
final symlink followed), **Creation**, **Confirmation**. Do not write
"target" or "resolved target".

## Commands you will need

| Purpose          | Command                                                     | Expected on success |
| ---------------- | ----------------------------------------------------------- | ------------------- |
| Install          | `npm ci`                                                    | exit 0              |
| Build            | `npm run build`                                             | exit 0              |
| Type-check tests | `npm run type-check:test`                                   | exit 0              |
| Lint             | `npm run lint`                                              | exit 0, no warnings |
| Format           | `npx prettier --check .`                                    | exit 0              |
| One test file    | `node --test --test-timeout=60000 __tests__/create.test.ts` | `# fail 0`          |
| Full check       | `npm run check`                                             | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/tools/create.ts`
- `__tests__/create.test.ts`
- `__tests__/undo.test.ts`
- `CHANGELOG.md`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `src/core/fs.ts` (`planCreate`, `executeCreate`): the lifecycle is correct;
  the gap is in how the tool feeds it.
- `src/core/confirmation.ts`: one question for two `pending` entries is a
  recorded decision.
- The schema rule at `src/tools/create.ts:114-131`: keep it; it gives a
  whole-call error before any planning for the common case.
- The tool description or input schema text: changing either changes the
  contract snapshot.

## Git workflow

- Branch: `advisor/090-create-refuses-two-entries-for-one-file`
- One commit. Message style from `git log`:
  `fix(edit): refuse a change that grows a file past the size limit`. Use
  `fix(create): refuse a second entry that lands on a file another entry writes`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing tests

In `__tests__/create.test.ts`, directly after the test
`'asks once about two spellings of one file; the skip is honored'`, add two
tests. Copy that test's structure exactly (own root via `createTestRoot()`,
`trySymlink(own, alias, () => t.skip('symlinks not permitted'))`, a
`GuardedFileSystem` built with `makeGuard([own])`, cleanup in `finally`).

Test A, name `'two entries that land on one file through a linked folder: the second is refused'`:

- Write `alias-over.txt` with `'old\n'`.
- Call `create` with
  `files: [{ path: file, content: 'A\n', overwrite: true }, { path: join(alias, 'alias-over.txt'), content: 'B\n', overwrite: true }]`.
- Assert `result.structured.files.length === 1`.
- Assert `result.structured.failures?.length === 1`,
  `result.structured.failures[0].error.code === ErrorCode.INVALID_INPUT`, and
  the message matches `/another entry in this batch/`.
- Assert the file on disk is `'A\n'`.

Test B, name `'two entries for one new file through a linked folder: the second is refused'`:

- No file exists. Call `create` with two entries (no flags) for `new.txt`,
  one direct and one through `alias`, contents `'A\n'` and `'B\n'`.
- Assert one file row, one failure with `ErrorCode.INVALID_INPUT` matching
  `/another entry in this batch/`, and disk content `'A\n'`.

**Verify**: `node --test --test-timeout=60000 __tests__/create.test.ts` →
the two new tests FAIL (Test A: two file rows; Test B: the failure code is
not `INVALID_INPUT`). Every other test passes. On Windows without symlink
permission the new tests skip: see STOP conditions.

### Step 2: Fail the later entry after planning

In `src/tools/create.ts`:

1. Add `unicodeMatchKey` to the existing import from `../core/path-utils.ts`.
2. Directly after the line
   `const plans = new Map(planned.map(({ index, value }) => [index, value.plan]));`
   add:

```ts
// Two entries that land on one file (through a linked folder, say) race as
// two spellings do: the last write wins and both report success. The schema
// compares spellings only, so the Landings settle it here. A `pending` twin
// stays: the Confirmation asks once for both. Two appends both land.
const firstByLanding = new Map<string, CreatePlan>();
for (const index of [...plans.keys()].sort((a, b) => a - b)) {
  const plan = plans.get(index);
  if (!plan) continue;
  const key = unicodeMatchKey(plan.validPath);
  const first = firstByLanding.get(key);
  if (first === undefined) {
    firstByLanding.set(key, plan);
    continue;
  }
  if (plan.kind === 'pending' || (plan.kind === 'append' && first.kind === 'append')) continue;
  slots[index] = {
    status: 'failure',
    path: plan.inputPath,
    error: toCreateFailure(
      plan.inputPath,
      new FsError(
        ErrorCode.INVALID_INPUT,
        `create cancelled: another entry in this batch already writes "${first.inputPath}"`,
        plan.inputPath,
      ),
    ).error,
  };
  plans.delete(index);
}
```

The sort matters: `planned` is in completion order, and "first" must mean the
lower input index. Deleting from `plans` keeps the refused entry out of both
the Confirmation and the execute loop below.

**Verify**: `node --test --test-timeout=60000 __tests__/create.test.ts` →
`# fail 0`, including the two new tests and the existing
`'asks once about two spellings of one file; the skip is honored'`.

### Step 3: Changelog

In `CHANGELOG.md`, under `## [Unreleased]` → `### Fixed`, add one line at the
end of that list:

```markdown
- **create**: two entries that reach one file through a linked folder no longer both report success while one content is lost; the first is written and the later entry fails with "another entry in this batch already writes".
```

**Verify**: `npx prettier --check CHANGELOG.md` → exit 0.

### Step 4: Full check

**Verify**: `npm run check` → exit 0.

## Test plan

- Two new tests in `__tests__/create.test.ts` (Step 1), modeled on
  `'asks once about two spellings of one file; the skip is honored'`.
- The existing skip test must keep passing unchanged: it is the regression
  guard for the `pending` exemption.
- Verification: `node --test --test-timeout=60000 __tests__/create.test.ts` →
  all pass.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "another entry in this batch already writes" src/tools/create.ts` returns 1 match
- [ ] `grep -c "through a linked folder" __tests__/create.test.ts` returns at least 2
- [ ] `git status --short` lists only `src/tools/create.ts`, `__tests__/create.test.ts`, `__tests__/undo.test.ts`, `CHANGELOG.md`, `plans/README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts.
- The new tests SKIP on your machine (Windows without symlink permission).
  Report that the fix is unverified locally; do not mark the plan DONE.
- Test A passes before Step 2. The bug then does not reproduce and the premise
  of this plan is wrong.
- After Step 2 the existing test
  `'asks once about two spellings of one file; the skip is honored'` fails.
- The two spellings turn out to have different `plan.validPath` values (add a
  temporary `console.error` to check if Test A still fails after Step 2).
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Hard links to one file are NOT covered: two hard-link names have different
  Landings. That is the separate, known "write-lock keys are not canonical"
  backlog item.
- A `pending` entry behind an `overwrite: true` twin still runs: after
  approval its identity re-check fails with "was replaced after the overwrite
  was approved". That is fail-closed and was left alone to keep the
  Confirmation behavior unchanged.
- `__tests__/undo.test.ts:3690` ('a create that reaches one file through a link does not delete it on undo') used two entries for one file in `create` to set up an undo test. With `create` now refusing the second entry, `undo.test.ts:3690` pre-creates the file before the `create` call instead of passing duplicate entries in the batch.
- Reviewer: confirm the refused entry never reaches `confirm(...)`.
