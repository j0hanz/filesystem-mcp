# Plan 050: Resource links and cached-result entries carry `lastModified` (and a result's expiry)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat fb51aee1..HEAD -- src/core/file-uri.ts src/core/read.ts src/core/store.ts src/resources.ts src/tools/read.ts src/tools/create.ts src/tools/edit.ts src/tools/patch.ts src/tools/replace-text.ts __tests__/core-fs.test.ts __tests__/tools.test.ts __tests__/resources.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW — additive optional fields on wire objects the SDK schema
  already allows; no existing field changes meaning.
- **Depends on**: none (independent of 048/049; touches different files)
- **Category**: dx
- **Planned at**: commit `fb51aee1`, 2026-09-29

## Why this matters

Every `resource_link` this server emits — after `read`, `create`, `edit`,
`patch`, `replace_text`, and for an externalized result — carries `size` and
`audience` but no `annotations.lastModified`, although the spec defines it
on `ResourceLink`/`Resource` and the write tools already compute the file's
mtime for their structured `modified` field. A client that cached a read
has no cheap freshness signal (the file template's `cacheHint` is 5 s, and a
non-subscriber gets no invalidation at all), and a host that renders links
shows a `filesystem-mcp://result/<uuid>` with no hint that it expires in
60 s. After this plan the mtime rides on every file link, and cached-result
links and `resources/list` entries state when they were created and when
they expire.

## Current state

- SDK schema (`node_modules/@modelcontextprotocol/core/dist/auth-*.d.mts:1962-1990`
  `ResourceLinkSchema`, `:1154-1180` `ResourceSchema`): both accept
  `description?: string`, `size?: number`, and
  `annotations?: { audience?, priority?, lastModified?: ISO datetime string }`.
- `src/core/file-uri.ts:48-62`:

```ts
export function buildFileResourceLinkFor(
  uri: string,
  name: string,
  mimeType: string,
  size: number,
): ContentBlock {
  return {
    type: 'resource_link',
    uri,
    name,
    mimeType,
    size,
    annotations: { audience: ['user', 'assistant'] },
  };
}
```

- `src/core/file-uri.ts:64-71` — `buildFileResourceLink(validPath, mimeType, size)` wraps it.
- `src/core/file-uri.ts:97-110` — `writtenFileLinks(validPath, mimeType, size, dryRun = false)`
  returns `{ resourceUri, resourceLink }` or both `undefined` on dry run /
  unknown size / over the text cap.
- `src/core/file-uri.ts:118-133` — `buildWrittenFileMeta({ validPath, content, dryRun? })`
  → `WrittenFileMeta` (`size, lineCount, mimeType, kind, resourceUri, resourceLink`).
- Write sites, each with an mtime in hand **before** the meta is built:
  - `src/tools/create.ts:225-232` (append branch): `...writtenFileLinks(appended.validPath, mimeType, stats?.size)` then `modified = (stats?.mtime ?? EPOCH).toISOString();`
  - `src/tools/create.ts:234-245` (write branch): `modified = fileStats.mtime.toISOString();` then `meta = buildWrittenFileMeta({ validPath: written.validPath, content })`.
  - `src/tools/edit.ts:419-426`: `const modified = options.dryRun ? new Date().toISOString() : (await ctx.fs.stat(filePath, …)).stats.mtime.toISOString();` then `buildWrittenFileMeta({ validPath, content: editResult.content, dryRun: options.dryRun })`.
  - `src/tools/patch.ts:137-144`: `const fileStats = args.dryRun ? stats : (await ctx.fs.stat(args.path, …)).stats;` then `buildWrittenFileMeta({ validPath, content: patched, dryRun: args.dryRun })`.
  - `src/tools/replace-text.ts:557-563`: `buildWrittenFileMeta({ validPath: summary.primary.path, content: summary.primary.content, dryRun: args.dryRun }).resourceLink` — no stat in hand; `ctx` (with `ctx.fs`, `ctx.signal`) is in scope (used at line 548).
- Read path:
  - `src/core/read.ts:67-78` — `ReadFileResult { path, content, totalLines?, readMode, head?, tail?, startLine?, endLine?, linesRead?, hasMoreLines? }`.
  - `src/core/read.ts:454-503` — `readByMode(handle, validPath, filePath, stats: Stats, spec, options)` builds the four `ReadFileResult` literals (`readMode: 'full' | 'head' | 'range' | 'tail'`). These are the only constructors (`grep -n "readMode:" src` → 4 hits, all here).
  - `src/tools/read.ts:88-100` — `ReadPerPathValue` (the structured per-path payload); `:244-268` `buildPerPathReadValue` fills it and sets `resourceUri`.
  - `src/tools/read.ts:437-446` — the link: `buildFileResourceLinkFor(v.resourceUri, basename(result.path), v.mimeType ?? 'application/octet-stream', Buffer.byteLength(v.content, 'utf8'))`.
- Result store:
  - `src/core/store.ts:91-98` — `ResourceEntry { uri, name, mimeType, size, expiresAt, text }`.
  - `src/core/store.ts:128-145` — `putText` builds the entry with `expiresAt: new Date(Date.now() + ENTRY_TTL_MS).toISOString()`.
  - `src/core/store.ts:170-203` — `putJsonResource` returns `{ entry: { uri, size, mimeType, expiresAt }, link: { type: 'resource_link', uri, name, mimeType, size, annotations: { audience: ['user'] } } }`.
  - `src/resources.ts:326-344` — the result template's `list()` pushes `{ uri, name, mimeType, size }` per entry.
- Tests pinning today's shapes: `__tests__/core-fs.test.ts:535-556`
  (`deepStrictEqual` on the link from `writtenFileLinks(path, 'text/plain', maxSize)` — no `lastModified`, so it stays valid when the parameter is optional),
  `__tests__/tools.test.ts:1005-1028` (read link `uri` equals `resourceUri`),
  `__tests__/resources.test.ts:186-205` (store `putText` fields).

Conventions: ISO-8601 strings via `Date#toISOString()` everywhere
(`stat.ts:58`, `create.ts:239`); optional fields are spread conditionally
(`...(x !== undefined ? { x } : {})`) because `exactOptionalPropertyTypes`
is on; Prettier formats; tests are `node:test` + `node:assert/strict`.

## Commands you will need

| Purpose         | Command                                                                      | Expected on success |
| --------------- | ---------------------------------------------------------------------------- | ------------------- |
| Build           | `npm run build`                                                              | exit 0              |
| Typecheck tests | `npm run type-check:test`                                                    | exit 0              |
| Lint            | `npm run lint`                                                               | exit 0              |
| Focused tests   | `npm test -- __tests__/core-fs.test.ts __tests__/resources.test.ts`          | all pass            |
| Tool tests      | `npm test -- --test-name-pattern="resource_link\|read\|create\|patch\|edit"` | all pass            |
| Full check      | `npm run check`                                                              | exit 0; `fail 0`    |

Baseline at planning time: 536 tests, 533 pass, 3 skipped, 0 fail.

## Scope

**In scope**:

- `src/core/file-uri.ts`, `src/core/read.ts`, `src/core/store.ts`, `src/resources.ts`
- `src/tools/read.ts`, `src/tools/create.ts`, `src/tools/edit.ts`, `src/tools/patch.ts`, `src/tools/replace-text.ts`
- `__tests__/core-fs.test.ts`, `__tests__/tools.test.ts`, `__tests__/resources.test.ts`
- `plans/README.md` — status row

**Out of scope**:

- `resources/read` contents (`TextResourceContents`) — the SDK schema has no
  `annotations` there; do not add one.
- The instructions resource and the file _template_ annotations
  (`src/resources.ts:146,192,324`) — static, no mtime.
- `src/tools/stat.ts`, `list.ts`, `find-files.ts` — they emit no file links.
- Changing `audience` or `priority` values anywhere.
- `TtlLru` internals in `store.ts`.

## Git workflow

- Branch: `advisor/050-resource-link-last-modified`
- Commit e.g. `feat(links): carry lastModified on resource links and result entries`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: The link builders accept an mtime

In `src/core/file-uri.ts`:

```ts
export function buildFileResourceLinkFor(
  uri: string,
  name: string,
  mimeType: string,
  size: number,
  /** ISO-8601 mtime of the file the link names, when the caller has one. */
  lastModified?: string,
): ContentBlock {
  return {
    type: 'resource_link',
    uri,
    name,
    mimeType,
    size,
    annotations: {
      audience: ['user', 'assistant'],
      ...(lastModified !== undefined ? { lastModified } : {}),
    },
  };
}

function buildFileResourceLink(
  validPath: string,
  mimeType: string,
  size: number,
  lastModified?: string,
): ContentBlock {
  return buildFileResourceLinkFor(
    buildFileResourceUri(validPath),
    basename(validPath),
    mimeType,
    size,
    lastModified,
  );
}
```

`writtenFileLinks` gains a fifth parameter `lastModified?: string` forwarded
to `buildFileResourceLink`; `buildWrittenFileMeta`'s options gain
`lastModified?: string | undefined`, forwarded as the fifth argument. Update
the doc comment of `writtenFileLinks` with one sentence: "`lastModified` is
the post-write mtime when the caller stat'd the file; a link without it is
still valid."

**Verify**: `npm run build && npm test -- __tests__/core-fs.test.ts` → exit 0,
all pass (existing link assertions still hold — the field is absent when not
passed).

### Step 2: Write tools pass the mtime they already have

- `src/tools/create.ts:228`: `...writtenFileLinks(appended.validPath, mimeType, stats?.size, false, stats?.mtime.toISOString()),`
- `src/tools/create.ts:240-243`: `meta = buildWrittenFileMeta({ validPath: written.validPath, content, lastModified: modified });`
- `src/tools/edit.ts:422-426`: add `lastModified: modified,` (on a dry run
  `writtenFileLinks` returns no link, so the preview timestamp never reaches
  the wire).
- `src/tools/patch.ts:140-144`: add `lastModified: fileStats.mtime.toISOString(),`.
- `src/tools/replace-text.ts:557-563`: stat the primary file before building
  the link; a failed stat degrades to a link without the field:

```ts
let primaryModified: string | undefined;
if (summary.primary && !args.dryRun) {
  try {
    primaryModified = (
      await ctx.fs.stat(summary.primary.path, { signal: ctx.signal })
    ).stats.mtime.toISOString();
  } catch {
    /* result metadata only; the write already succeeded */
  }
}
const link = summary.primary
  ? buildWrittenFileMeta({
      validPath: summary.primary.path,
      content: summary.primary.content,
      dryRun: args.dryRun,
      lastModified: primaryModified,
    }).resourceLink
  : undefined;
```

Check that the enclosing function is `async` and has `ctx` typed with
`fs` and `signal` (it logs through `ctx.log?.` at line 548, so `ctx` is a
`ToolCtx`).

**Verify**: `npm run build && npm run lint` → exit 0;
`npm test -- --test-name-pattern="create|edit|patch|replace_text"` → all pass.

### Step 3: `read` carries the mtime from the stat it already did

1. `src/core/read.ts:67-78`: add `modified: string;` to `ReadFileResult`
   (required — every constructor has `stats`).
2. `src/core/read.ts:454-503` (`readByMode`): add
   `modified: stats.mtime.toISOString(),` to each of the four returned
   literals.
3. `src/tools/read.ts:88-100`: add `modified?: string;` to `ReadPerPathValue`
   with the comment `/** ISO-8601 mtime at read time; also rides the resource_link. */`.
4. `src/tools/read.ts:255-268` (`buildPerPathReadValue`): add
   `modified: result.modified,` next to `resourceUri`.
5. `src/tools/read.ts:441-446`: pass `v.modified` as the fifth argument to
   `buildFileResourceLinkFor`.

If `npm run type-check:test` reports a test constructing a `ReadFileResult`
literal without `modified`, add `modified: new Date(0).toISOString()` to that
literal — do not make the field optional.

**Verify**: `npm run build && npm run type-check:test` → exit 0;
`npm test -- --test-name-pattern="read"` → all pass.

### Step 4: Cached results say when they were made and when they expire

In `src/core/store.ts`:

1. `ResourceEntry` gains `createdAt: string;` (ISO). In `putText` set
   `createdAt: new Date(now).toISOString()` where `const now = Date.now();`
   is hoisted so `expiresAt` uses the same instant:
   `expiresAt: new Date(now + ENTRY_TTL_MS).toISOString()`.
2. In `putJsonResource`, the returned `link` becomes:

```ts
    link: {
      type: 'resource_link',
      uri: entry.uri,
      name: entry.name,
      description: `Cached tool result; expires ${entry.expiresAt}`,
      mimeType: entry.mimeType,
      size: entry.size,
      annotations: { audience: ['user'], lastModified: entry.createdAt },
    },
```

In `src/resources.ts:333-338` (the result template's `list()`), push:

```ts
resources.push({
  uri: entry.uri,
  name: entry.name,
  description: `Cached tool result; expires ${entry.expiresAt}`,
  mimeType: entry.mimeType,
  size: entry.size,
  annotations: { audience: ['assistant'], priority: 0.3, lastModified: entry.createdAt },
});
```

(The template-level `annotations` at line 324 stay; per-entry annotations
are what a client sees in `resources/list`.)

**Verify**: `npm run build && npm test -- __tests__/resources.test.ts` → all pass.

### Step 5: Tests

**`__tests__/core-fs.test.ts`** — in the "written file links preserve…" test
(line 535) add after the first `deepStrictEqual`:

```ts
const stamped = writtenFileLinks(path, 'text/plain', 10, false, '2026-01-02T03:04:05.000Z');
assert.deepStrictEqual(
  (stamped.resourceLink as { annotations?: { lastModified?: string } }).annotations,
  { audience: ['user', 'assistant'], lastModified: '2026-01-02T03:04:05.000Z' },
);
```

**`__tests__/tools.test.ts`** — next to the "read's resource_link and
resourceUri name the same file" test (line 1005) add:

```ts
it("read's resource_link carries the file's mtime as lastModified", async () => {
  const file = join(tmpDir, 'stamped.txt');
  await writeFile(file, 'content\n');
  const { mtime } = await stat(file);
  const result = await harness.client.callTool({ name: 'read', arguments: { path: file } });
  const link = (result.content as { type: string; annotations?: { lastModified?: string } }[]).find(
    (c) => c.type === 'resource_link',
  );
  assert.strictEqual(link?.annotations?.lastModified, mtime.toISOString());
  const structured = result._meta as { results?: { value?: { modified?: string } }[] };
  assert.strictEqual(structured.results?.[0]?.value?.modified, mtime.toISOString());
});

it("create's resource_link lastModified equals the structured modified", async () => {
  const file = join(tmpDir, 'created-stamped.txt');
  const result = await harness.client.callTool({
    name: 'create',
    arguments: { files: [{ path: file, content: 'hello\n' }] },
  });
  assert.notStrictEqual(result.isError, true);
  const structured = result.structuredContent as { files: { modified: string }[] };
  const link = (result.content as { type: string; annotations?: { lastModified?: string } }[]).find(
    (c) => c.type === 'resource_link',
  );
  assert.ok(structured.files[0]?.modified);
  assert.strictEqual(link?.annotations?.lastModified, structured.files[0]?.modified);
});
```

(`stat` goes into the existing `'node:fs/promises'` import at
`tools.test.ts:5`; `writeFile` is already there.)

**`__tests__/resources.test.ts`** — in `TC-FUNC-058` (line 186) add
`assert.ok(!Number.isNaN(Date.parse(entry.createdAt)));` and
`assert.ok(Date.parse(entry.expiresAt) > Date.parse(entry.createdAt));`. In
the `MCP Client Resource Operations` describe (line 556) add a test that
externalizes a result and lists it:

```ts
it('a cached result lists with its expiry and creation time', async () => {
  await writeTestFile(tmpDir, 'pages/one.txt', 'x');
  await writeTestFile(tmpDir, 'pages/two.txt', 'x');
  const listed = await harness.client.callTool({
    name: 'list',
    arguments: { path: join(tmpDir, 'pages'), maxEntries: 1 },
  });
  const { resourceUri } = listed._meta as { resourceUri?: string };
  assert.ok(resourceUri, 'an incomplete first page externalizes the full list');
  const { resources } = await harness.client.listResources();
  const entry = resources.find((r) => r.uri === resourceUri);
  assert.ok(entry);
  assert.match(entry.description ?? '', /expires \d{4}-\d{2}-\d{2}T/);
  assert.ok(entry.annotations?.lastModified);
});
```

Adapt the harness variable name and imports to what that describe already
uses (it calls `harness.client.listResources()` at line 575).

**Verify**: `npm test -- __tests__/core-fs.test.ts __tests__/resources.test.ts` and
`npm test -- --test-name-pattern="lastModified|expiry"` → all pass;
`npm run check` → exit 0, `fail 0`, ≥ 540 pass.

## Test plan

- Unit: `writtenFileLinks` with and without `lastModified` (core-fs);
  `ResourceEntry.createdAt` ordering (resources).
- Integration: `read` link `lastModified` equals the file's mtime and the
  structured `modified`; `create` link equals structured `modified`;
  `resources/list` entry for an externalized result carries `description`
  with the expiry and `annotations.lastModified`.
- Pattern: `tools.test.ts:1005-1028`, `resources.test.ts:186-205, 574-590`.

## Done criteria

Search commands are given for PowerShell (the repo's declared shell has no
`grep`); on POSIX substitute `grep -n`.

- [ ] `npm run check` exits 0; ≥ 540 pass, 0 fail
- [ ] `Select-String -Path src\core\file-uri.ts,src\core\store.ts,src\resources.ts,src\tools\read.ts -Pattern "lastModified" | Group-Object Path` → hits in all four
- [ ] `(Select-String -Path src\core\read.ts -Pattern "modified: stats.mtime.toISOString\(\)").Count` → 4
- [ ] Every `buildWrittenFileMeta({` call in `src/tools/{create,edit,patch,replace-text}.ts` passes `lastModified` (`Select-String -Path src\tools\*.ts -Pattern "buildWrittenFileMeta\(\{" -Context 0,4`)
- [ ] TOOL-SURFACE-002 (tools/list budget) still passes — this plan adds nothing to `tools/list`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The SDK's `ContentBlock` type rejects `annotations.lastModified` or
  `description` on a `resource_link` at compile time — the installed schema
  differs from the one cited in "Current state".
- `ReadFileResult` is constructed somewhere
  `Select-String -Path src\**\*.ts,__tests__\*.ts -Pattern "readMode:"` did
  not show (a fifth site) — report it rather than making `modified` optional.
- Adding `createdAt` breaks a `deepStrictEqual` on a whole `ResourceEntry`
  in a test not listed here — report which.
- A Windows CI run shows `read`'s `lastModified` differing from
  `fs.stat().mtime` by a rounding step — report the two values; do not
  loosen to a tolerance without knowing the source.

## Maintenance notes

- `lastModified` is advisory and post-write: under a concurrent writer it may
  reflect that writer's mtime (the same caveat `edit.ts:415-418` already
  states for `modified`). Reviewers should not expect it to prove content
  identity — `contentHash` on `read` does that.
- If a future plan adds a directory-listing resource, its entries should
  reuse the same `annotations.lastModified` convention.
- Deferred: `size` on `read`'s link is the UTF-8 length of the _returned_
  content, not the file size (pre-existing); a ranged read's link therefore
  understates the file. Out of scope here.
