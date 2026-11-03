# Plan 082: Warn in the delete confirmation when a folder holds protected files

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5ebbd489..HEAD -- src/core/fs.ts src/tools/delete.ts __tests__/delete.test.ts SECURITY.md CHANGELOG.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `5ebbd489`, 2026-11-03

## Why this matters

Files on the sensitive-file policy, such as `.env` and private keys, are hidden
from listings, and deleting one directly is refused. A recursive delete of the
folder holding one removes it anyway, after a prompt that says only "and all its
contents?". Undo cannot help: the capture refuses any tree holding a protected
file, so nothing in that tree can be restored. The person approving cannot see
those files in any listing and is not told. Secrets are also among the hardest
files to recreate.

After this plan, the prompt says so before the person answers. The delete still
works when approved: this is a warning, not a new refusal.

## Current state

- `src/tools/delete.ts` — the `delete` tool. `planPath` plans each path without
  changing anything; `handleDelete` builds the confirmation message.
- `src/core/fs.ts` — `GuardedFileSystem`. `hasChildrenUnchecked` at line 1164 is
  the neighbouring probe.
- `src/core/undo.ts:370-373` — where the capture gives up, so undo is lost:

```ts
if (fs.pathGuard.isSensitive(validPath)) {
  capture.abandon('contains protected files');
  return;
}
```

`src/tools/delete.ts:77-81`, the signature:

```ts
async function planPath(
  inputPath: string,
  args: Pick<DeleteInput, 'recursive' | 'ignoreIfNotExists'>,
  fs: Pick<GuardedFileSystem, 'pathGuard' | 'lstat' | 'hasChildrenUnchecked'>,
): Promise<PlanResult> {
```

`src/tools/delete.ts:117-129`, the end of `planPath`:

```ts
const itemType = resolveEntryType(firstStats.stats);
let hasChildren = false;
if (args.recursive && itemType === 'directory') {
  try {
    hasChildren = await fs.hasChildrenUnchecked(validPath);
  } catch (error) {
    return { status: 'fail', failure: toDeleteFailure(inputPath, error) };
  }
}
return {
  status: 'plan',
  plan: { inputPath, validPath, itemType, firstStats, pending: hasChildren },
};
```

`src/tools/delete.ts:57-65`, the plan type:

```ts
/** A path's pre-checked plan: validated, statted, and flagged if it needs confirmation. */
interface DeletePlan {
  inputPath: string;
  validPath: string;
  itemType: FileType;
  firstStats: LstatResult;
  /** Recursive + non-empty directory: needs a round-trip confirmation. */
  pending: boolean;
}
```

`src/tools/delete.ts:227-232`, the caller:

```ts
const planned = await processInParallel(
  paths,
  (inputPath) => planPath(inputPath, args, ctx.fs),
  PARALLEL_CONCURRENCY,
  ctx.signal,
);
```

`src/tools/delete.ts:285-298`, the confirmation:

```ts
const confirmed = await confirm(
  ctx,
  'delete',
  'delete',
  plans.map(({ plan }) => ({
    path: plan.validPath,
    identity: identityOf(plan.firstStats.stats),
    required: plan.pending,
    message:
      plan.itemType === 'directory'
        ? `Delete "${plan.validPath}" and all its contents?`
        : `Delete "${plan.validPath}"?`,
  })),
);
```

Relevant rules and vocabulary:

- `src/core/fs.ts` `#relocationWalk` (lines 242-290) checks every entry under
  both the validated path and the client's spelling, because a deny rule can
  name either. The new walk does the same.
- `GLOSSARY.md`, **Confirmation**: "The round in which the client approves
  deleting or overwriting the entries a call would destroy." Use this word.
- `GLOSSARY.md`, **Scan**: "A sensitive entry is passed over without a trace."
  That rule governs walks on a client's behalf. See the note in Maintenance.
- `src/core/fs.ts:1186` `countEntries` already reads a directory and calls
  `pathGuard.isSensitive` per entry. Match its style.

Test facts, verified by probe on `5ebbd489`:

- A delete prompt's `choices` are `['delete', 'skip']`.
- `choose('delete')`, exported by `__tests__/tool-harness.ts`, answers it.
- After acceptance, a folder holding `.env` and `a.txt` is gone.

## Commands you will need

| Purpose       | Command                                           | Expected on success |
| ------------- | ------------------------------------------------- | ------------------- |
| One test file | `node --test __tests__/delete.test.ts`            | all pass            |
| Full check    | `npm run check`                                   | exit 0              |
| Graph update  | `graphify update .` (project rule after any edit) | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/fs.ts`
- `src/tools/delete.ts`
- `__tests__/delete.test.ts`
- `SECURITY.md`
- `CHANGELOG.md` (the `[Unreleased]` section)
- `graphify-out/` (only what `graphify update .` rewrites)

**Out of scope** (do NOT touch, even though they look related):

- `src/core/confirmation.ts` and `src/core/input-required.ts` — the message is
  plain data to them, and the sealed state does not include it.
- `src/core/undo.ts` — the capture's refusal stays as it is.
- `validatePathForDelete` in `src/core/path.ts` — refusing such deletes outright
  is a different decision, and the operator did not choose it.
- `src/tools/move.ts` — a move keeps protected entries protected by its own walk.
- Tool descriptions and the contract snapshot. If either must change, see STOP.

## Git workflow

- Branch: `advisor/082-warn-before-deleting-protected-files`
- Commit per step, Conventional Commits, as in `git log`:
  `fix(search): keep the pattern hint beside a binary skip`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing tests

Add these to the `delete body` describe block in `__tests__/delete.test.ts`.
`del`, `root`, `nonEmptyDir`, `mkdir`, `writeFile`, `join`, `access` and `choose`
are already in scope there.

```ts
/** Deletes `dir` recursively, answering the prompt, and returns what it said. */
const promptFor = async (dir: string, choice: 'delete' | 'skip'): Promise<string> => {
  let message = '';
  await del(
    { paths: [dir], recursive: true },
    {
      confirm: (prompt) => {
        message = prompt.message;
        return choose(choice)();
      },
    },
  );
  return message;
};

it('warns in the confirmation when the folder holds a protected file', async () => {
  const dir = join(root, 'holds_env');
  await mkdir(join(dir, 'deep', 'er'), { recursive: true });
  await writeFile(join(dir, 'a.txt'), 'x');
  await writeFile(join(dir, 'deep', 'er', '.env'), 'X=1');

  const message = await promptFor(dir, 'delete');

  assert.match(message, /protected/);
  assert.match(message, /cannot be undone/);
  await assert.rejects(access(dir));
});

it('still honors skip after warning about a protected file', async () => {
  const dir = join(root, 'holds_env_skip');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.env'), 'X=1');

  const message = await promptFor(dir, 'skip');

  assert.match(message, /protected/);
  await access(join(dir, '.env'));
});

it('asks the plain question when the folder holds no protected file', async () => {
  const dir = await nonEmptyDir('holds_nothing');

  const message = await promptFor(dir, 'delete');

  // A regex, because the prompt names the normalized path, whose drive letter
  // can differ in case from `dir` on Windows.
  assert.match(message, /^Delete ".*holds_nothing" and all its contents\?$/);
});
```

**Verify**: `node --test --test-name-pattern="protected" __tests__/delete.test.ts`
→ the first two fail on `assert.match(message, /protected/)`. The third test's
name does match that filter and passes.

### Step 2: Add the walk to `GuardedFileSystem`

In `src/core/fs.ts`, add this method directly after `hasChildrenUnchecked`:

```ts
/**
 * True when a directory a delete would remove holds an entry the sensitive-file
 * policy protects, under its validated or requested spelling. Listings hide
 * such entries and a Capture refuses them, so the Confirmation must say so.
 * Links are not followed. A directory that cannot be read is passed over:
 * a recursive delete cannot empty it either, so nothing in it is lost.
 */
async holdsProtectedEntry(
  validPath: string,
  requestedPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const pending = [''];
  for (let rel = pending.pop(); rel !== undefined; rel = pending.pop()) {
    signal?.throwIfAborted();
    let dirents: Dirent[];
    try {
      dirents = await fsReaddir(join(validPath, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const name = join(rel, dirent.name);
      if (
        this.pathGuard.isSensitive(join(validPath, name)) ||
        this.pathGuard.isSensitive(join(requestedPath, name))
      ) {
        return true;
      }
      if (dirent.isDirectory()) pending.push(name);
    }
  }
  return false;
}
```

`Dirent`, `fsReaddir` and `join` are already imported in that file.

**Verify**: `npm run build` → exit 0.

### Step 3: Use it in the delete plan

In `src/tools/delete.ts`:

1. Add this field to `DeletePlan`, after `pending`:

   ```ts
   /** Pending, and holds an entry the sensitive-file policy protects. */
   holdsProtected: boolean;
   ```

2. Change `planPath`'s `fs` type and add a `signal` parameter:

   ```ts
   fs: Pick<GuardedFileSystem, 'pathGuard' | 'lstat' | 'hasChildrenUnchecked' | 'holdsProtectedEntry'>,
   signal?: AbortSignal,
   ```

3. Replace the final `return` of `planPath` with:

   ```ts
   // Only a pending directory needs the walk: nothing else is deleted with contents.
   const holdsProtected =
     hasChildren && (await fs.holdsProtectedEntry(validPath, inputPath, signal));
   return {
     status: 'plan',
     plan: { inputPath, validPath, itemType, firstStats, pending: hasChildren, holdsProtected },
   };
   ```

4. Pass the signal at the call site:

   ```ts
   (inputPath) => planPath(inputPath, args, ctx.fs, ctx.signal),
   ```

5. Add this helper above `handleDelete`:

   ```ts
   /** What the Confirmation asks. A person cannot see protected files in any listing, so it names them. */
   function deletePrompt(plan: DeletePlan): string {
     if (plan.itemType !== 'directory') return `Delete "${plan.validPath}"?`;
     const question = `Delete "${plan.validPath}" and all its contents?`;
     return plan.holdsProtected
       ? `${question} It holds files protected by the sensitive-file policy, which listings hide, so this delete cannot be undone.`
       : question;
   }
   ```

6. In the `confirm(...)` call, replace the `message:` value with
   `message: deletePrompt(plan),`.

**Verify**: `node --test __tests__/delete.test.ts` → all pass.

### Step 4: Document it

In `SECURITY.md`, under `## What this does not protect against`, add this bullet
after **In-place edits.**:

```markdown
- **Protected files inside a folder you delete.** A recursive delete removes
  everything in the folder, including files on the secret-file list, which
  listings hide. The confirmation says when a folder holds any, and such a
  delete cannot be undone.
```

In `CHANGELOG.md` under `## [Unreleased]`, add a `### Fixed` heading if there is
none, placed after `### Changed`, with this bullet:

```markdown
- **A recursive delete says when it would remove protected files.** A folder holding a file on the secret-file list asked only "and all its contents?", though listings hide those files and the delete cannot be undone. The confirmation now says both. The delete still proceeds when approved.
```

**Verify**: `npx prettier --check SECURITY.md CHANGELOG.md` → exit 0.

### Step 5: Full check

Run `npm run check`, then `graphify update .`.

**Verify**: `npm run check` → exit 0. The contract snapshot test passes without
updating the snapshot.

## Test plan

Three tests in `__tests__/delete.test.ts`, given above, modelled on that file's
existing `choose` usage:

| Case                             | Expected                           |
| :------------------------------- | :--------------------------------- |
| `.env` two levels down, accepted | Prompt warns; folder removed       |
| `.env` at top level, skipped     | Prompt warns; file still present   |
| No protected file, accepted      | Prompt is exactly the old question |

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `node --test __tests__/delete.test.ts` exits 0, including 3 new tests
- [ ] `grep -n "holdsProtectedEntry" src/core/fs.ts src/tools/delete.ts` shows the method and its call
- [ ] `git diff --stat 5ebbd489..HEAD -- __tests__/contract.test.ts.snapshot` shows no change
- [ ] `git status` shows only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- An existing test asserts the old prompt text for a folder holding a protected
  file, which would mean someone pinned this behaviour on purpose.
- The contract snapshot changes.
- The walk seems to need the read-only directory rules or a new validation. It
  should not: `planPath` has already validated the path.
- Large trees make the suite noticeably slower. Report the numbers rather than
  adding a cap, since a capped walk could miss the file it exists to find.

## Maintenance notes

- **Maintainer decision to review:** `GLOSSARY.md` says a Scan passes a sensitive
  entry "without a trace", and this prompt reveals that one exists somewhere in a
  folder. It names no file and appears only on an explicit recursive delete. The
  result's `not undoable: contains protected files` already reveals the same fact
  after the delete. If that trade-off is rejected, drop this plan rather than
  weakening the warning.
- **Cost:** the walk reads each directory of a pending folder once per round.
  `snapshotTree` then walks the same tree and reads every file during the delete,
  so the delete already costs much more.
- **Deferred:** refusing such deletes unless an explicit flag is passed. That is
  stricter, but it would break existing callers, so it is a release decision.
- **Reviewers should check** that the walk does not follow links, and that the
  warning appears in the reprompt round too: `planPath` runs again on each retry.
