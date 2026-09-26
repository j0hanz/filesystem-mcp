# Plan: One owner builds a written file's metadata, and edit's dry run reports the right size

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `89b2a8f5` (v2.6.0), 2026-09-26.
> **Drift check (run first)**: `git diff --stat 89b2a8f5..HEAD -- src/core/file-uri.ts src/tools/edit.ts src/tools/patch.ts src/tools/create.ts src/tools/replace-text.ts __tests__/core-fs.test.ts __tests__/tools.test.ts CHANGELOG.md`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

Four write tools each assemble the metadata of the file they wrote by hand,
around [`buildWrittenFileMeta()`](../../../src/core/file-uri.ts#L102), whose
two leading parameters are both `string`. Commit `aa156291` (shipped in v2.6.0)
called it with `content` and `validPath` swapped in `edit`'s dry-run branch, so
`edit` with `dryRun: true` reports the byte size and line count of the *path
string* and a MIME type sniffed from the wrong argument. TypeScript cannot catch
the swap. Two more rules live outside the owner: `create`'s append branch
re-implements the "never advertise a URI the store cannot serve" rule, and the
"a dry run wrote nothing, so no URI and no link" rule lives in `edit` and
`replace_text` but not in `patch`, whose dry run still advertises a
`resourceUri` and a `resource_link` for a file it never wrote.

When this lands, `buildWrittenFileMeta` takes named fields (the swap cannot be
written again), one exported helper owns both advertising rules, and all four
tools route through it.

Requirements covered: none, this is a fix plus the architecture-audit finding
"written-file result has no owner" (audit of 2026-09-26, this session).

## Current state

- [`src/core/file-uri.ts`](../../../src/core/file-uri.ts) — module header says
  it owns "the post-write metadata block every write tool reports". The link
  builder [`file-uri.ts:65-76`](../../../src/core/file-uri.ts#L65-L76) is
  exported and called from two places: inside `buildWrittenFileMeta` and from
  `create.ts:263`. The type and the builder
  [`file-uri.ts:84-122`](../../../src/core/file-uri.ts#L84-L122):

  ```ts
  export interface WrittenFileMeta {
    size: number;
    lineCount: number;
    mimeType: string;
    kind: FileKind;
    resourceUri: string | undefined;
    resourceLink: ContentBlock | undefined;
  }
  // …
  export function buildWrittenFileMeta(
    validPath: string,
    content: string,
    resourceStore: ResourceStore | undefined,
  ): WrittenFileMeta {
    const size = Buffer.byteLength(content, 'utf-8');
    const mimeInfo = detectMimeFromContent(validPath, content);
    // An edit or patch can push a readable file past the text-size cap; the
    // store serves the URI via readRaw, which would reject it with TOO_LARGE.
    const servable = size <= getMaxTextFileSize();
    return {
      size,
      lineCount: countLines(content),
      mimeType: mimeInfo.mimeType,
      kind: mimeInfo.kind,
      resourceUri: servable ? buildFileResourceUri(validPath) : undefined,
      resourceLink:
        resourceStore && servable
          ? buildFileResourceLink(validPath, mimeInfo.mimeType, size)
          : undefined,
    };
  }
  ```

- **The bug** — [`edit.ts:413-429`](../../../src/tools/edit.ts#L413-L429),
  `handleEditFile`'s dry-run branch. Line 423 passes `(content, validPath)`:

  ```ts
    if (options.dryRun) {
      // … diff …
      // Nothing was written, so there is no updated content to point a
      // resourceUri or a resource_link at — the file on disk is still the one the
      // caller already has. No write, no link.
      const meta: WrittenFileMeta = {
        ...buildWrittenFileMeta(editResult.content, validPath, ctx.resourceStore),
        resourceUri: undefined,
        resourceLink: undefined,
      };
      return {
        file: buildEditFileValue(validPath, meta, new Date().toISOString(), editResult),
      };
    }
  ```

  Reproduced at `89b2a8f5` with a 4-line `.md` file: correct call →
  `{"size":24,"lineCount":4,"mimeType":"text/markdown"}`, swapped call →
  `{"size":9,"lineCount":1,"mimeType":"text/plain"}`.

- `edit`'s write branch [`edit.ts:457-458`](../../../src/tools/edit.ts#L457-L458)
  is correct: `buildWrittenFileMeta(validPath, editResult.content, ctx.resourceStore)`.
  The type `WrittenFileMeta` is also used at
  [`edit.ts:324`](../../../src/tools/edit.ts#L324) (`buildEditFileValue`), so
  its import on [`edit.ts:9`](../../../src/tools/edit.ts#L9) stays.

- `patch` — [`patch.ts:144-172`](../../../src/tools/patch.ts#L144-L172). It
  builds meta for dry run and write alike, so a dry run advertises
  `resourceUri` and pushes a `resource_link`:

  ```ts
      const meta = buildWrittenFileMeta(validPath, patched, ctx.resourceStore);
      return {
        structured: {
          // …
          ...(meta.resourceUri !== undefined ? { resourceUri: meta.resourceUri } : {}),
          ...(args.dryRun ? { diff: args.diff } : {}),
        },
        text: args.dryRun ? patched : summaryText,
        ...(meta.resourceLink !== undefined ? { resources: [meta.resourceLink] } : {}),
  ```

  Its output schema describes the field as "Resource URI pointing to the
  patched file content" ([`patch.ts:34`](../../../src/tools/patch.ts#L34)) —
  false on a dry run.

- `replace_text` — [`replace-text.ts:586-592`](../../../src/tools/replace-text.ts#L586-L592)
  applies the dry-run rule itself:

  ```ts
    // A dry run wrote nothing, so there is no updated file to link.
    const link =
      !args.dryRun && summary.primary
        ? buildWrittenFileMeta(summary.primary.path, summary.primary.content, ctx.resourceStore)
            .resourceLink
        : undefined;
  ```

- `create` — imports at [`create.ts:9-14`](../../../src/tools/create.ts#L9-L14):

  ```ts
  import {
    buildFileResourceLink,
    buildFileResourceUri,
    buildWrittenFileMeta,
    type WrittenFileMeta,
  } from '../core/file-uri.ts';
  ```

  The append branch re-implements the servable rule at
  [`create.ts:249-265`](../../../src/tools/create.ts#L249-L265):

  ```ts
          // The resource store serves this URI via readRaw, which rejects
          // files over the text-size cap with TOO_LARGE — never advertise a
          // link the store deterministically cannot serve. A failed stat
          // leaves the size unknown, so nothing is advertised either.
          const servable = stats !== undefined && stats.size <= getMaxTextFileSize();
          const size = stats?.size ?? 0;
          meta = {
            size,
            lineCount,
            mimeType,
            kind,
            resourceUri: servable ? buildFileResourceUri(appended.validPath) : undefined,
            resourceLink:
              servable && ctx.resourceStore
                ? buildFileResourceLink(appended.validPath, mimeType, size)
                : undefined,
          };
  ```

  The overwrite branch calls the builder correctly at
  [`create.ts:276`](../../../src/tools/create.ts#L276):
  `meta = buildWrittenFileMeta(written.validPath, content, ctx.resourceStore);`.
  `getMaxTextFileSize` stays imported in `create.ts` — it is still used by the
  input schema at [`create.ts:41`](../../../src/tools/create.ts#L41).

- The one direct unit test —
  [`core-fs.test.ts:425-437`](../../../__tests__/core-fs.test.ts#L425-L437)
  (`TC-FUNC-054`) calls the positional form twice.

- The dry-run integration test —
  [`tools.test.ts:2136-2156`](../../../__tests__/tools.test.ts#L2136-L2156)
  (`edit and replace_text put the preview diff and stop reason in the text`)
  runs `edit` with `dryRun: true` on a file containing `alpha\nbeta\n` with
  edits `alpha→ALPHA` (matches) and `gamma→x` (no match). It asserts only on
  the text block, which is why the swap passed CI.

- **How a test reads a tool's structured result**: a tool that authors its own
  text ships its structured result under `_meta`, not `structuredContent`
  ([`define.ts:206-222`](../../../src/tools/define.ts#L206-L222)). `edit`,
  `patch` and `replace_text` all author text. `edit`'s `_meta` is
  `{ results: [{ path, value?: EditFileValue, error? }], summary }`
  ([`edit.ts:559-563`](../../../src/tools/edit.ts#L559-L563)); `patch`'s
  `_meta` is the flat object built at `patch.ts:156-168`. Exemplar of a test
  reading `_meta`: [`tools.test.ts:2249-2253`](../../../__tests__/tools.test.ts#L2249-L2253).

- **Conventions** (from [`AGENTS.md`](../../../AGENTS.md) and the repo's lint
  config): relative imports end in `.ts`; `node:` protocol for built-ins; no
  `console` in `src`; `exactOptionalPropertyTypes` is on, so an optional field
  that may receive `undefined` is typed `?: T | undefined`. knip
  ([`knip.json`](../../../knip.json)) reports an export that nothing outside
  its own file imports — un-export it in the same change.

## Commands

| Purpose              | Command | Expected on success |
| -------------------- | ------- | ------------------- |
| Unit test (meta)     | `node --test --test-name-pattern="TC-FUNC-054" __tests__/core-fs.test.ts` | `ℹ fail 0`, `ℹ pass` ≥ 1 |
| Edit dry-run test    | `node --test --test-name-pattern="put the preview diff" __tests__/tools.test.ts` | `ℹ fail 0`, `ℹ pass` ≥ 1 |
| Patch tests          | `node --test --test-name-pattern="patch" __tests__/tools.test.ts` | `ℹ fail 0` |
| Type-check src       | `npm run build` | exit 0 |
| Type-check tests     | `npm run type-check:test` | exit 0 |
| Full gate            | `npm run check` | exit 0 (build, type-check, lint, prettier, knip, all tests) |

## Scope

**In scope** — the only files to modify:

- [`src/core/file-uri.ts`](../../../src/core/file-uri.ts)
- [`src/tools/edit.ts`](../../../src/tools/edit.ts)
- [`src/tools/patch.ts`](../../../src/tools/patch.ts)
- [`src/tools/create.ts`](../../../src/tools/create.ts)
- [`src/tools/replace-text.ts`](../../../src/tools/replace-text.ts)
- [`__tests__/core-fs.test.ts`](../../../__tests__/core-fs.test.ts)
- [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts)
- [`CHANGELOG.md`](../../../CHANGELOG.md)

**Files out of scope** — leave alone even though they look related:

- [`src/core/fs.ts`](../../../src/core/fs.ts) — folding the post-write `stat`
  into `GuardedFileSystem.writeFile` was considered and rejected: `replace_text`
  would pay one extra `stat` per file in a sweep, and a stat failure would
  surface as a write failure after the rename committed.
- The post-write `ctx.fs.stat(...)` calls in `edit.ts:457`, `patch.ts:152-154`
  and `create.ts:273` — whether they should run unwired from `ctx.signal` (as
  `create`'s append branch argues at `create.ts:215-222`) is a separate
  question; this plan does not change them.
- [`src/tools/delete.ts`](../../../src/tools/delete.ts),
  [`src/tools/move.ts`](../../../src/tools/move.ts) — they report no written
  content, so they do not use this metadata.
- `package.json`, `server.json`, `mcpb/manifest.json` — versions are bumped only
  by the Release workflow.

## Steps

Work on a new branch: `git switch -c fix/written-file-meta`. Do not push.

### 1. Pin and fix the edit dry-run swap (test first)

In [`tools.test.ts`](../../../__tests__/tools.test.ts), inside the test at
`tools.test.ts:2136`, directly after the line
`assert.match(editText, /^\+ALPHA$/mu);` (line 2151), add:

```ts
    // Dry-run metadata describes the would-be file, and advertises no URI for
    // content that was never written.
    const editValue = (
      edit._meta as { results: { value?: { size?: number; resourceUri?: string } }[] }
    ).results[0]?.value;
    assert.strictEqual(editValue?.size, 'ALPHA\nbeta\n'.length);
    assert.strictEqual(editValue?.resourceUri, undefined);
```

**Verify (red)**: `node --test --test-name-pattern="put the preview diff" __tests__/tools.test.ts`
→ `ℹ fail 1`, the failure an `AssertionError` on `size` (actual is the byte
length of the temp path, not `11`).

Then in [`edit.ts:423`](../../../src/tools/edit.ts#L423) swap the two
arguments back: `buildWrittenFileMeta(validPath, editResult.content, ctx.resourceStore)`.

**Verify (green)**: same command → `ℹ fail 0`.

Commit: `fix(edit): report the would-be file's size and MIME on a dry run`.

### 2. Give `buildWrittenFileMeta` named fields and one advertising rule

In [`file-uri.ts`](../../../src/core/file-uri.ts), replace
`buildWrittenFileMeta` (lines 98-122, doc comment included) with the two
functions below. Keep `WrittenFileMeta` unchanged.

```ts
/**
 * The URI and link a write tool may advertise for the file it wrote. None on a
 * dry run — nothing was written, so the file on disk is still the one the
 * caller already has. None when the size is unknown or over the text-size cap —
 * the store serves the URI via readRaw, which would reject it with TOO_LARGE.
 * No link without a store to link into.
 */
export function writtenFileLinks(
  validPath: string,
  mimeType: string,
  size: number | undefined,
  options: { resourceStore: ResourceStore | undefined; dryRun?: boolean | undefined },
): Pick<WrittenFileMeta, 'resourceUri' | 'resourceLink'> {
  if (options.dryRun || size === undefined || size > getMaxTextFileSize()) {
    return { resourceUri: undefined, resourceLink: undefined };
  }
  return {
    resourceUri: buildFileResourceUri(validPath),
    resourceLink: options.resourceStore
      ? buildFileResourceLink(validPath, mimeType, size)
      : undefined,
  };
}

/**
 * The block every write tool reports for the content it wrote (or, with
 * `dryRun`, would have written): size, line count, MIME, and whatever
 * {@link writtenFileLinks} allows it to advertise. Named fields, because
 * `validPath` and `content` are both strings and a positional swap type-checks.
 */
export function buildWrittenFileMeta(options: {
  validPath: string;
  content: string;
  resourceStore: ResourceStore | undefined;
  dryRun?: boolean | undefined;
}): WrittenFileMeta {
  const { validPath, content } = options;
  const size = Buffer.byteLength(content, 'utf-8');
  const { mimeType, kind } = detectMimeFromContent(validPath, content);
  return {
    size,
    lineCount: countLines(content),
    mimeType,
    kind,
    ...writtenFileLinks(validPath, mimeType, size, options),
  };
}
```

Then switch every caller to the object form. `npm run build` lists any caller
missed; the full list at `89b2a8f5` is these five sites:

1. [`edit.ts:419-429`](../../../src/tools/edit.ts#L419-L429) — the dry-run
   branch collapses; the spread-and-override goes away because `dryRun: true`
   now drops the URI and link:

   ```ts
       // Nothing was written, so there is no updated content to point a
       // resourceUri or a resource_link at; dryRun drops both.
       const meta = buildWrittenFileMeta({
         validPath,
         content: editResult.content,
         resourceStore: ctx.resourceStore,
         dryRun: true,
       });
       return {
         file: buildEditFileValue(validPath, meta, new Date().toISOString(), editResult),
       };
   ```

2. [`edit.ts:458`](../../../src/tools/edit.ts#L458) →
   `buildWrittenFileMeta({ validPath, content: editResult.content, resourceStore: ctx.resourceStore })`.
3. [`patch.ts:155`](../../../src/tools/patch.ts#L155) →
   `buildWrittenFileMeta({ validPath, content: patched, resourceStore: ctx.resourceStore })`.
   Do **not** pass `dryRun` yet — step 4 changes `patch`'s behavior test-first.
4. [`replace-text.ts:586-592`](../../../src/tools/replace-text.ts#L586-L592) →
   drop the comment and the `!args.dryRun &&` guard; the owner applies it:

   ```ts
     const link = summary.primary
       ? buildWrittenFileMeta({
           validPath: summary.primary.path,
           content: summary.primary.content,
           resourceStore: ctx.resourceStore,
           dryRun: args.dryRun,
         }).resourceLink
       : undefined;
   ```

5. [`create.ts:276`](../../../src/tools/create.ts#L276) →
   `meta = buildWrittenFileMeta({ validPath: written.validPath, content, resourceStore: ctx.resourceStore });`.

Update `TC-FUNC-054` at
[`core-fs.test.ts:425-437`](../../../__tests__/core-fs.test.ts#L425-L437) to the
object form, and extend it to pin the dry-run rule:

```ts
    it('TC-FUNC-054: buildWrittenFileMeta omits the URI over the text cap and on a dry run', () => {
      // An edit or patch can push a readable file past the text-size cap;
      // a resourceUri the store's readRaw would reject with TOO_LARGE must
      // never be advertised.
      const huge = 'x'.repeat(10 * 1024 * 1024 + 1);
      const meta = buildWrittenFileMeta({
        validPath: join(tmpDir, 'huge.txt'),
        content: huge,
        resourceStore: undefined,
      });
      assert.strictEqual(meta.size, huge.length);
      assert.strictEqual(meta.resourceUri, undefined);
      assert.strictEqual(meta.resourceLink, undefined);

      const small = buildWrittenFileMeta({
        validPath: join(tmpDir, 'small.txt'),
        content: 'hi',
        resourceStore: undefined,
      });
      assert.ok(small.resourceUri, 'under the cap the URI is advertised');

      // A dry run describes the would-be content but advertises nothing.
      const dry = buildWrittenFileMeta({
        validPath: join(tmpDir, 'small.txt'),
        content: 'hi',
        resourceStore: undefined,
        dryRun: true,
      });
      assert.strictEqual(dry.size, 2);
      assert.strictEqual(dry.resourceUri, undefined);
    });
```

**Verify**:
- `npm run build` → exit 0
- `npm run type-check:test` → exit 0
- `node --test --test-name-pattern="TC-FUNC-054" __tests__/core-fs.test.ts` → `ℹ fail 0`
- `node --test --test-name-pattern="put the preview diff|replace_text|edit" __tests__/tools.test.ts` → `ℹ fail 0`

Commit: `refactor(file-uri): name buildWrittenFileMeta's fields and own the dry-run rule`.

### 3. Route `create`'s append branch through the owner

In [`create.ts:249-265`](../../../src/tools/create.ts#L249-L265), replace the
four-line comment, the `servable` constant and the hand-built
`resourceUri`/`resourceLink` with the helper. `size` still defaults to `0` for
the reported field, but the helper receives the raw `stats?.size` so an
unknown size advertises nothing — the same behavior as today:

```ts
        // A failed stat leaves the size unknown, so nothing is advertised.
        meta = {
          size: stats?.size ?? 0,
          lineCount,
          mimeType,
          kind,
          ...writtenFileLinks(appended.validPath, mimeType, stats?.size, {
            resourceStore: ctx.resourceStore,
          }),
        };
```

In the import at [`create.ts:9-14`](../../../src/tools/create.ts#L9-L14),
remove `buildFileResourceLink` and `buildFileResourceUri`, and add
`writtenFileLinks`. Leave the `getMaxTextFileSize` import alone (still used at
`create.ts:41`).

`buildFileResourceLink` is now called only inside `file-uri.ts`: remove the
`export` keyword from its declaration at
[`file-uri.ts:65`](../../../src/core/file-uri.ts#L65) so knip stays clean.

**Verify**:
- `npm run build` → exit 0
- `node --test --test-name-pattern="create|append" __tests__/tools.test.ts __tests__/core-fs.test.ts` → `ℹ fail 0`
- `npx knip` → exit 0, no output naming `file-uri.ts`

Commit: `refactor(create): take append's link rule from writtenFileLinks`.

### 4. `patch` dry run advertises nothing (test first)

In [`tools.test.ts`](../../../__tests__/tools.test.ts), directly after the
`TC-FUNC-062` test that ends at line 1410, add:

```ts
  it('patch dryRun advertises no resourceUri or resource_link for the unwritten file', async () => {
    const f = join(tmpDir, 'patch_dry.txt');
    await writeFile(f, 'a\nb\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
    const dry = await harness.client.callTool({
      name: 'patch',
      arguments: { path: f, diff, dryRun: true },
    });
    assert.notStrictEqual(dry.isError, true);
    assert.strictEqual((dry._meta as { resourceUri?: string }).resourceUri, undefined);
    assert.ok(
      !(dry.content as { type: string }[]).some((block) => block.type === 'resource_link'),
      'a dry run links nothing',
    );
    assert.strictEqual(await readFile(f, 'utf-8'), 'a\nb\nc\n');

    const real = await harness.client.callTool({ name: 'patch', arguments: { path: f, diff } });
    assert.ok((real._meta as { resourceUri?: string }).resourceUri, 'a real write still links');
  });
```

**Verify (red)**: `node --test --test-name-pattern="patch dryRun advertises" __tests__/tools.test.ts`
→ `ℹ fail 1`, the failure on the `resourceUri` assertion.

Then at [`patch.ts:155`](../../../src/tools/patch.ts#L155) add
`dryRun: args.dryRun` to the `buildWrittenFileMeta({ … })` call from step 2.

**Verify (green)**:
- same command → `ℹ fail 0`
- `node --test --test-name-pattern="patch" __tests__/tools.test.ts` → `ℹ fail 0`

Commit: `fix(patch): advertise no resource URI or link on a dry run`.

### 5. Changelog and full gate

In [`CHANGELOG.md`](../../../CHANGELOG.md), insert above `## [2.6.0] - 2026-09-26`:

```markdown
## [Unreleased]

### Fixed

- **`edit` dry-run metadata.** A dry run reported the size, line count and
  MIME type of the file's path string instead of the would-be content.
  Regressed in 2.6.0.
- **`patch` dry run no longer links the file.** A dry run advertised a
  `resourceUri` and a `resource_link` for content it never wrote, matching
  neither `edit` nor `replace_text`.
```

**Verify**: `npm run check` → exit 0.

Commit: `docs(changelog): note edit and patch dry-run metadata fixes`.

## Done

Machine-checkable. All must hold:

- [ ] `npm run check` exits 0
- [ ] `node --test --test-name-pattern="put the preview diff|patch dryRun advertises|TC-FUNC-054" __tests__/tools.test.ts __tests__/core-fs.test.ts` exits 0 with `ℹ pass` ≥ 3
- [ ] `git grep -n "buildWrittenFileMeta(" -- src` shows only object-form calls (each followed by `{`) and the declaration
- [ ] `git grep -n "getMaxTextFileSize()" -- src/tools/create.ts` shows only line ~41 (the input schema)
- [ ] `git status` shows no modified files outside the in-scope list

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt.
- `npm run build` after step 2 names a `buildWrittenFileMeta` caller not in the
  five-site list — the site list drifted; reconcile it before editing further.
- Step 1's red run passes before the fix — the swap is already gone, and the
  plan's premise needs rechecking.
- Any existing test fails because it expects `patch` to return `resourceUri`
  or a `resource_link` on a dry run — that is a recorded behavior, not an
  oversight; do not change the test.
- A step's verification fails twice after one fix attempt.
- The fix appears to require an out-of-scope file.

## Notes

- **Review focus**: step 4 is the one user-visible behavior change beyond the
  bug fix — `patch` dry-run results lose `resourceUri` and the link block.
  Step 3 must keep append's "unknown size advertises nothing" behavior: the
  helper gets `stats?.size`, not the `?? 0` default.
- **Rejected move**: only swapping the arguments back at `edit.ts:423`. It
  fixes the symptom but leaves the positional two-string signature and the
  hand-built copies of the rules, so the next cleanup can swap them again.
- **Deferred**: whether post-write `stat` calls should be unwired from
  `ctx.signal` after the write commits (see Files out of scope).
