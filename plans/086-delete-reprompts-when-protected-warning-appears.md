# Plan 086: A recursive delete asks again when protected files appear while its prompt is open

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat d799cc5e..HEAD -- src/core/confirmation.ts src/core/input-required.ts src/tools/delete.ts __tests__/delete.test.ts`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (at most one extra prompt per call)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d799cc5e`, 2026-11-10

## Why this matters

A recursive delete of a non-empty directory asks the person to confirm. When
the directory holds files the sensitive-file policy protects (for example
`.env`), the prompt adds a warning: listings hide those files, and the delete
cannot be undone. The confirmation is sealed against the directory's identity
only. Adding a file inside a directory does not change the directory's
identity, so if a protected file lands in it while the prompt is open, the
retry deletes it under an approval that never showed the warning, and with no
undo. That is exactly the case the warning exists for.

After this plan, a confirmation whose warning appeared since the prompt was
shown is asked once more, with the warning.

## Current state

Files:

- `src/core/confirmation.ts` (140 lines): the Confirmation of delete, move,
  copy and create. Seals each pending entry's identity; the retry re-plans and
  compares.
- `src/core/input-required.ts`: defines the sealed state (`PendingState`,
  `SealedIdentity`) and mints it.
- `src/tools/delete.ts`: builds the delete prompt and the confirm items.
- `__tests__/delete.test.ts`: delete tests through `runToolBodyResult`.

`src/core/confirmation.ts:22-29`:

```ts
/** One entry the call would destroy, as planned this round. */
export interface ConfirmItem {
  readonly path: string;
  readonly identity: EntryIdentity;
  /** Whether the tool's own rule asks for approval this round. */
  readonly required: boolean;
  readonly message: string;
}
```

`src/core/confirmation.ts:67-73`, where a round is sealed:

```ts
  const freshRound = (reprompted: boolean) =>
    ask(
      {
        op,
        paths: pending.map((item) => item.path),
        identities: pending.map((item) => ({ path: item.path, ...item.identity })),
        ...(reprompted ? { reprompted: true as const } : {}),
```

`src/core/confirmation.ts:90-104`, where the retry decides what changed:

```ts
const changed = new Set(
  pending
    .filter((item) => {
      const shown = identities.find((entry) => entry.path === item.path);
      return (
        !sealed.paths.includes(item.path) ||
        shown === undefined ||
        !sameIdentity(shown, item.identity)
      );
    })
    .map((item) => item.path),
);
// No capability gate here: the client already answered an elicitation in
// this call, so it can answer the reprompt too.
if (changed.size > 0 && sealed.reprompted !== true) return freshRound(true);
```

`src/core/input-required.ts:41-44`:

```ts
/** The entry a confirmation round showed the client for one sealed path. */
interface SealedIdentity extends EntryIdentity {
  readonly path: string;
}
```

`src/core/input-required.ts:224-231` mints the state and passes `identities`
through whole, so an extra optional field on a sealed identity survives the
round trip:

```ts
  const requestState = await requestStateCodec.mint(
    {
      op: pending.op,
      paths: [...pending.paths].sort(),
      ...(pending.identities ? { identities: pending.identities } : {}),
```

`src/tools/delete.ts:131-138`:

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

`src/tools/delete.ts:212-222`:

```ts
const confirmed = await confirm(
  ctx,
  'delete',
  'delete',
  plans.map(({ plan }) => ({
    path: plan.validPath,
    identity: plan.firstStats ? identityOf(plan.firstStats.stats) : UNKNOWN_IDENTITY,
    required: plan.pending,
    message: deletePrompt(plan),
  })),
);
```

Every round re-plans: `handleDelete` calls `fs.planDelete` for each path
before `confirm`, and `planDelete` recomputes `holdsProtected`
(`src/core/fs.ts:723-727`). So on the retry, `plan.holdsProtected` already
reflects the directory as it is now.

Test helpers in `__tests__/delete.test.ts`:

- `del(args, options)` (line 58) runs the tool. `options.confirm` is a fake
  client: `confirm: (prompt, round) => answer`. `prompt.message` is the prompt
  text; `round` is 1 for the first prompt, 2 for a re-prompt.
- `choose('delete')()` returns the accepting answer (see its use at line 353).
- `nonEmptyDir(name)` (line 64) makes `<root>/<name>/sub/f.txt`.
- Existing warning tests are at lines 360-382; use them as the pattern.

Vocabulary (from `GLOSSARY.md`): the approval round is a **Confirmation**.
Use that word in comments.

Commit messages are Conventional Commits, for example
`fix(tools/create): dedupe overwrite confirmations by resolved path`.

## Commands you will need

| Purpose       | Command                                                                | Expected on success |
| :------------ | :--------------------------------------------------------------------- | :------------------ |
| Install       | `npm ci`                                                               | exit 0              |
| Delete tests  | `node --test --test-timeout=60000 __tests__/delete.test.ts`            | all pass            |
| Confirm tests | `node --test --test-timeout=60000 __tests__/confirmation-gaps.test.ts` | all pass            |
| Full check    | `npm run check`                                                        | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/confirmation.ts`
- `src/core/input-required.ts` (the `SealedIdentity` interface only)
- `src/tools/delete.ts` (the confirm item at lines 216-221 only)
- `__tests__/delete.test.ts`
- `CHANGELOG.md` (one bullet under `## [Unreleased]` then `### Fixed`)
- `plans/README.md` (your status row)

**Out of scope** (do NOT touch):

- `src/core/fs.ts`: `planDelete`, `executeDelete`, `holdsProtectedEntry`,
  `EntryIdentity` and `sameIdentity` stay as they are. The warning is not part
  of an entry's identity.
- The confirm items in `src/tools/move.ts` and `src/tools/create.ts`: they
  have no warning, and the new field is optional.
- `deletePrompt`: its text does not change.

## Git workflow

- Branch: `advisor/086-delete-reprompts-on-protected-warning` from `main`.
- One commit, for example
  `fix(delete): ask again when protected files appear during the Confirmation`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the failing test

In `__tests__/delete.test.ts`, after the test
`'still honors skip after warning about a protected file'`, add:

`it('asks again, with the warning, when a protected file appears while the prompt is open', …)`

1. `const dir = await nonEmptyDir('late_env');`
2. Collect the prompt messages in an array.
3. Call `del({ paths: [dir], recursive: true }, { confirm })` where `confirm`
   pushes `prompt.message`, and on round 1 first runs
   `await writeFile(join(dir, '.env'), 'X=1')`, then returns
   `choose('delete')()`.
4. Assert: two messages were collected; the first does NOT match
   `/protected/`; the second matches `/protected/` and `/cannot be undone/`;
   the result is not an error; `access(dir)` rejects (the delete ran after the
   second approval).

Also add
`it('does not ask again when the protected file is gone by the retry', …)`:
the directory starts with `.env` inside, the round 1 `confirm` removes it
(`rm(join(dir, '.env'))`), and the test asserts exactly one prompt and a
deleted directory. Make the directory with `nonEmptyDir` first so it stays
non-empty after the removal.

**Verify**: `node --test --test-timeout=60000 __tests__/delete.test.ts` → the
first new test FAILS (one prompt instead of two); the second passes; all
others pass.

### Step 2: Seal whether the warning was shown

`src/core/input-required.ts`, `SealedIdentity`:

```ts
interface SealedIdentity extends EntryIdentity {
  readonly path: string;
  /** The round's prompt carried the tool's warning for this entry. */
  readonly warned?: true;
}
```

`src/core/confirmation.ts`, `ConfirmItem`, add after `message`:

```ts
  /** The message carries a warning the client must see before approving. */
  readonly warned?: boolean;
```

`src/core/confirmation.ts`, in `freshRound`, seal it:

```ts
        identities: pending.map((item) => ({
          path: item.path,
          ...item.identity,
          ...(item.warned ? { warned: true as const } : {}),
        })),
```

`src/core/confirmation.ts`, in the `changed` filter, add one condition:

```ts
return (
  !sealed.paths.includes(item.path) ||
  shown === undefined ||
  !sameIdentity(shown, item.identity) ||
  // A warning that appeared since the prompt was never approved.
  (item.warned === true && shown.warned !== true)
);
```

`src/tools/delete.ts`, in the confirm item, add after `message`:

```ts
      warned: plan.holdsProtected,
```

**Verify**: `node --test --test-timeout=60000 __tests__/delete.test.ts` → all
pass, including both new tests. Then
`node --test --test-timeout=60000 __tests__/confirmation-gaps.test.ts` → all
pass.

### Step 3: Changelog and full check

In `CHANGELOG.md`, under `## [Unreleased]` then `### Fixed`, add:

```md
- **delete**: a recursive delete asks once more, with the protected-files warning, when such a file appears in the folder while the first prompt is open.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- Two new tests in `__tests__/delete.test.ts`: the regression (warning appears
  after round 1, so a second prompt carries it) and the non-regression (a
  warning that disappears does not cost a second prompt).
- Pattern: the warning tests at `__tests__/delete.test.ts:360-382`.
- Verification: `npm run check` → exit 0.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "warned" src/core/confirmation.ts src/core/input-required.ts src/tools/delete.ts` shows matches in all three files
- [ ] Both new tests exist and pass
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code.
- After step 2 the first new test still sees one prompt. That would mean the
  sealed state drops unknown fields when it is read back; report where, and do
  not change the codec.
- The test harness's `confirm` callback does not receive a round number, or
  refuses a second round.
- Any test in `__tests__/confirmation-gaps.test.ts`, `__tests__/move.test.ts`
  or `__tests__/create.test.ts` starts failing.

## Maintenance notes

- A state minted by an older server version has no `warned`, so a retry
  against a directory that holds protected files is asked once more. That is
  the safe direction.
- The warning flips at most one extra round: `reprompted` is sealed and stops
  a loop. If the second round's approval is followed by yet another change,
  the existing `changed` verdict cancels that path.
- Other tools can adopt `warned` if their prompt gains a warning. Until then
  the field stays unset for them.
