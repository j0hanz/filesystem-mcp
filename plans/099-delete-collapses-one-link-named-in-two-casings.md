# Plan 099: `delete` collapses one entry named twice in different letter case

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- src/tools/delete.ts __tests__/delete.test.ts CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

This finding was made by reading the code and has **not been reproduced**.
Step 1 is a test that decides whether the bug exists; if the test passes
before any fix, the plan ends there.

On Windows and default macOS the filesystem folds letter case, so `link` and
`LINK` name one entry. The `delete` tool collapses two paths that name one
entry only when their validated paths are the same string. For a symlink, the
validated path keeps the letter case the caller typed. So
`delete { paths: ['C:\\ws\\link', 'C:\\ws\\LINK'] }` is believed to plan two
deletions of one link, run them in parallel, and report one success and one
`NOT_FOUND` failure for an entry that was in fact deleted.

## Current state

Files:

- `src/tools/delete.ts`: the `delete` tool; `handleDelete` plans every path
  and collapses duplicates.
- `src/core/path.ts`: `validatePathForDelete` (not changed by this plan).
- `src/core/fs.ts`: exports `identityOf`, `sameIdentity`, `DeletePlan`.
- `__tests__/delete.test.ts`: tests.

The collapse (`src/tools/delete.ts:141-156`):

```ts
let plans: { plan: DeletePlan; index: number }[] = [];
const seenTargets = new Set<string>();

for (const { index, value: r } of planned) {
  const target = r.status === 'noop' ? r.deleted : r.plan.validPath;
  if (seenTargets.has(target)) {
    slots[index] = { status: 'omitted' };
    continue;
  }
  seenTargets.add(target);
  if (r.status === 'noop') {
    slots[index] = { status: 'settled', path: r.deleted, value: { deleted: true } };
  } else {
    plans.push({ plan: r.plan, index });
  }
}
```

Where the link keeps the typed case (`src/core/path.ts:1487-1492`):

```ts
    if (stats.isSymbolicLink()) {
      // Symlink: check link sensitivity but don't resolve target.
      // The parent check above ensures the link itself is in an allowed root.
      // Spelled through the validated real parent, so every path to one link
      // (an aliased parent, another Unicode spelling) names it the same way.
      const link = join(normalizedRealParent, basename(target));
```

`DeletePlan` (`src/core/fs.ts:162-171`):

```ts
export interface DeletePlan {
  readonly inputPath: string;
  readonly validPath: string;
  readonly itemType: FileType;
  readonly firstStats?: { stats: Stats; validPath: string } | undefined;
  readonly pending: boolean;
  readonly holdsProtected: boolean;
  readonly noop: boolean;
  readonly recursive: boolean;
```

Identity helpers (`src/core/fs.ts:1878-1903`), both exported:

```ts
export function identityOf(stats: Stats): EntryIdentity {
  return {
    itemType: resolveEntryType(stats),
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  };
}
```

```ts
export function sameIdentity(a: EntryIdentity, b: EntryIdentity): boolean {
```

`normalizeCaseForComparison` is already imported in `delete.ts` from
`../core/path-utils.ts`; it lower-cases ASCII letters only where the
filesystem folds case, and returns the value unchanged elsewhere.

**A decided behavior you must keep.** `__tests__/delete.test.ts` has the test
`'retains distinct on-disk case spellings as separate deletion targets without collapsing them'`.
It feeds two plans whose paths differ only in case and that carry **no**
`firstStats`, and expects both to run. A directory can be case-sensitive even
on Windows, so two names that fold alike can be two real entries. The fix
must therefore collapse only when the two plans also saw the **same entry
identity**.

Glossary: **Entry** (the directory entry a path names; a final symlink is the
link itself), **Deletion**.

## Commands you will need

| Purpose          | Command                                                     | Expected on success |
| ---------------- | ----------------------------------------------------------- | ------------------- |
| Install          | `npm ci`                                                    | exit 0              |
| Type-check tests | `npm run type-check:test`                                   | exit 0              |
| Lint             | `npm run lint`                                              | exit 0, no warnings |
| Delete tests     | `node --test --test-timeout=60000 __tests__/delete.test.ts` | `# fail 0`          |
| Full check       | `npm run check`                                             | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/tools/delete.ts`
- `__tests__/delete.test.ts`
- `CHANGELOG.md`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `src/core/path.ts`: changing what `validatePathForDelete` returns affects
  every caller and the mutation-triage notes.
- `nestedIndexes` in `delete.ts`.
- `src/core/fs.ts`.

## Git workflow

- Branch: `advisor/099-delete-collapses-one-link-named-in-two-casings`
- One commit: `fix(delete): collapse one entry named in two letter cases`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: The deciding test

In `__tests__/delete.test.ts`, directly after the test
`'retains distinct on-disk case spellings as separate deletion targets without collapsing them'`,
add (use the file's existing `del` helper and `root`; `trySymlink`,
`writeTestFile`, `IS_CASE_INSENSITIVE_FS` are already imported):

```ts
it(
  'one link named in two letter cases is deleted once and reported once',
  { skip: !IS_CASE_INSENSITIVE_FS },
  async (t) => {
    const target = await writeTestFile(root, 'case-link-target.txt', 'x\n');
    const link = join(root, 'case-link');
    if (!(await trySymlink(target, link, () => t.skip('symlinks not permitted'), 'file'))) return;

    const result = await del({ paths: [link, join(root, 'CASE-LINK')] });

    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structured.summary.failed, 0);
    assert.strictEqual(result.structured.results.length, 1);
    await assert.rejects(lstat(link));
  },
);
```

**Verify**: `node --test --test-timeout=60000 __tests__/delete.test.ts`.

- If the new test FAILS (a failed row, or two rows): the bug is real. Go to
  Step 2.
- If it PASSES: the bug does not reproduce. Keep the test, skip Step 2, skip
  the changelog line, and set this plan's row in `plans/README.md` to
  `REJECTED: did not reproduce; test kept as a guard`.
- If it SKIPS (Linux, or no symlink permission): see STOP conditions.

### Step 2: Collapse plans that saw one entry

In `src/tools/delete.ts`:

1. Add `identityOf` and `sameIdentity` to the existing import from
   `../core/fs.ts`.
2. Replace the loop shown in "Current state" with:

```ts
let plans: { plan: DeletePlan; index: number }[] = [];
const seenTargets = new Set<string>();
// A link keeps the letter case it was typed in, so one link named twice
// plans twice where the filesystem folds case. Collapse those only when both
// plans saw one Entry: two names that fold alike can be two entries.
const sawSameEntry = (plan: DeletePlan): boolean => {
  const stats = plan.firstStats?.stats;
  if (stats === undefined) return false;
  const folded = normalizeCaseForComparison(plan.validPath);
  return plans.some(
    ({ plan: earlier }) =>
      earlier.firstStats !== undefined &&
      normalizeCaseForComparison(earlier.validPath) === folded &&
      sameIdentity(identityOf(earlier.firstStats.stats), identityOf(stats)),
  );
};

for (const { index, value: r } of planned) {
  const target = r.status === 'noop' ? r.deleted : r.plan.validPath;
  if (seenTargets.has(target) || (r.status !== 'noop' && sawSameEntry(r.plan))) {
    slots[index] = { status: 'omitted' };
    continue;
  }
  seenTargets.add(target);
  if (r.status === 'noop') {
    slots[index] = { status: 'settled', path: r.deleted, value: { deleted: true } };
  } else {
    plans.push({ plan: r.plan, index });
  }
}
```

**Verify**: `node --test --test-timeout=60000 __tests__/delete.test.ts` →
`# fail 0`, including
`'retains distinct on-disk case spellings as separate deletion targets without collapsing them'`.

### Step 3: Changelog and full check

In `CHANGELOG.md`, under `## [Unreleased]` → `### Fixed`, append:

```markdown
- **delete**: one symbolic link named twice in different letter case (on Windows and macOS) is now deleted once and reported once; before, the second name reported a not-found failure.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- One new test in `__tests__/delete.test.ts`, gated on
  `IS_CASE_INSENSITIVE_FS`, modeled on the tests around it.
- The existing "retains distinct on-disk case spellings" test is the guard
  against over-collapsing.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "deleted once and reported once" __tests__/delete.test.ts` returns 1 match
- [ ] Either `grep -c "sawSameEntry" src/tools/delete.ts` returns at least 2, or the README row says `REJECTED: did not reproduce`
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The new test SKIPS on your machine. This plan needs Windows or macOS with
  symlink permission; report that it is unverified and leave the row `TODO`.
- After Step 2 the new test still fails. Add a temporary log of
  `r.plan.firstStats` for both plans: if `firstStats` is `undefined` for a
  link, the identity is not available at plan time and this approach does not
  work. Remove the log, revert Step 2, report.
- The existing "retains distinct on-disk case spellings" test fails.
- The code at the cited lines does not match the excerpts.

## Maintenance notes

- `sameIdentity` compares `dev`, `ino`, `birthtimeMs` and the entry type as
  JavaScript numbers; NTFS file ids can round, but both conditions (folded
  path AND identity) must hold, so a false collapse needs two different
  entries with one folded path and one rounded identity.
- The comparison is quadratic in the number of paths in one call; calls are
  small (an earlier audit measured 1000 paths at 1.3 s for the nested check).
- If `validatePathForDelete` is ever changed to return the on-disk spelling
  of a link, this collapse becomes dead code and can go.
