# Plan 028: `create` refuses a batch that names the same file twice

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/tools/create.ts src/tools/edit.ts __tests__/tools.test.ts`
> If `create.ts` changed, compare the "Current state" excerpts against the
> live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

`create` writes its batch entries in parallel through `runOverPaths`. With
two entries for one path, the last atomic rename wins, **both** report
success, and one entry's content is silently lost — which one depends on
timing. Reproduced: two entries, disk holds only the second one's bytes,
summary says two created. `append: true` and an overwrite for the same path
interleave the same way.

`edit` already refuses exactly this shape (plan 004, `src/tools/edit.ts:112-126`)
with a `superRefine` that compares paths via `isSamePath`. This plan copies
that rule onto `create`'s input schema.

## Current state

```ts
// src/tools/create.ts:74-80
const CreateInputSchema = z.strictObject({
  files: z
    .array(CreateFileItemSchema)
    .min(1)
    .max(100)
    .describe('List of files to create (max 100); each entry requires path and content'),
});
```

`create.ts` does not import `isSamePath` today; its `path-utils` imports are
absent (imports at lines 1–32 cover `file-uri`, `fs`, `input-required`,
`mime`, `schema`, `util`, `batch`, `define`).

The rule to copy:

```ts
// src/tools/edit.ts:112-126 (inside a .superRefine((value, ctx) => { ... }))
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

Existing test to mirror: `'edit refuses a batch that names the same file twice'`
(`__tests__/tools.test.ts:760-791`) — asserts `isError`, matches
`/duplicate of files\[0\]\.path/u`, and on win32/darwin also checks a
case-variant spelling.

## Commands you will need

| Purpose        | Command                                                            | Expected on success |
| -------------- | ------------------------------------------------------------------ | ------------------- |
| Static check   | `npm run check:static`                                             | exit 0              |
| All tests      | `npm test`                                                         | all pass            |
| Filter by name | `npm test -- --test-name-pattern="create refuses a batch"`         | passes              |
| Format         | `npx prettier --write src/tools/create.ts __tests__/tools.test.ts` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/tools/create.ts` — `CreateInputSchema` and one import
- `__tests__/tools.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope**: `runOverPaths` (batch.ts) — the rule belongs at the schema
so the wire error names the entry; `move`'s duplicate-destination check
(already present, `move.ts:245-247` comment).

## Git workflow

- Branch: `advisor/028-create-rejects-duplicate-paths`.
- One commit: `fix(create): reject a batch that names one file twice`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Regression test (it must fail now)

In `__tests__/tools.test.ts`, directly after `'edit refuses a batch that names the same file twice'`
(ends line 791), add:

```ts
it('create refuses a batch that names the same file twice', async () => {
  const file = join(tmpDir, 'dup-create', 'dup.txt');
  const result = await harness.client.callTool({
    name: 'create',
    arguments: {
      files: [
        { path: file, content: 'AAAA' },
        { path: file, content: 'BBBB' },
      ],
    },
  });
  assert.strictEqual(result.isError, true);
  assert.match(firstTextBlock(result).text ?? '', /duplicate of files\[0\]\.path/u);
  await assert.rejects(access(file), 'nothing may be written when the batch is refused');

  if (process.platform === 'win32' || process.platform === 'darwin') {
    const caseResult = await harness.client.callTool({
      name: 'create',
      arguments: {
        files: [
          { path: file, content: 'AAAA' },
          { path: join(tmpDir, 'dup-create', 'DUP.TXT'), content: 'BBBB' },
        ],
      },
    });
    assert.strictEqual(caseResult.isError, true);
    assert.match(firstTextBlock(caseResult).text ?? '', /duplicate of files\[0\]\.path/u);
  }
});
```

`access` and `join` are already imported in this file.

**Verify**: `npm test -- --test-name-pattern="create refuses a batch"` →
**fails** (`isError` is not true; both entries succeed). If it passes, STOP.

### Step 2: Copy the rule onto the schema

In `src/tools/create.ts`:

1. Add `import { isSamePath } from '../core/path-utils.ts';` (keep the import
   block sorted; prettier's import plugin will order it).
2. Replace lines 74–80 with:

   ```ts
   const CreateInputSchema = z
     .strictObject({
       files: z
         .array(CreateFileItemSchema)
         .min(1)
         .max(100)
         .describe('List of files to create (max 100); each entry requires path and content'),
     })
     .superRefine((value, ctx) => {
       // Entries write in parallel and each replaces its file whole, so two
       // entries for one path race: the last rename wins and the other's
       // content is lost while both report success. One entry per file.
       for (const [index, file] of value.files.entries()) {
         const first = value.files.findIndex((other) => isSamePath(other.path, file.path));
         if (first < index) {
           ctx.addIssue({
             code: 'custom',
             path: ['files', index, 'path'],
             message: `duplicate of files[${String(first)}].path; one entry per file`,
             input: value,
           });
         }
       }
     });
   ```

Run `npx prettier --write src/tools/create.ts __tests__/tools.test.ts`.

**Verify**: `npm test -- --test-name-pattern="create refuses a batch"` →
passes; `npm test -- --test-name-pattern="TC-FUNC-009"` → all pass.

### Step 3: Full gate

**Verify**: `npm run check` → exit 0. If `TOOL-SURFACE-001`
("published schemas carry no dead keywords or phantom fields") fails, the
`superRefine` leaked into the JSON schema — see STOP conditions.

## Test plan

- New test: same path twice → `isError` with the duplicate message and no file
  written; on case-insensitive platforms, a case-variant spelling too.
- Existing: every `create` test (`TC-FUNC-009*`), the overwrite-confirmation
  tests, `TOOL-SURFACE-001/002`.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -n "isSamePath" src/tools/create.ts` prints the import and one use
- [ ] The new test exists and passes
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 028 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The regression test passes before Step 2.
- `TOOL-SURFACE-001` or `-002` fails after Step 2 (schema size or shape
  changed on the wire) — `edit` uses the same construct without issue, so
  report the diff rather than adjusting the surface test.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- `edit`, `create` and (by its own route) `move` now all refuse duplicate
  targets. If a fourth batch tool that writes whole files is added, it needs
  the same refinement; consider lifting it into `schema.ts` at that point,
  not before.
