# Plan: Land the six architecture-audit findings

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `8bf08572`, 2026-09-10.
> **Drift check (run first)**:
> `git diff --stat 8bf08572..HEAD -- src/ __tests__/ README.md`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

An architecture audit of this repo produced six findings that clear its bar.
Four are ownership defects — a rule the domain has that no module owns, so it
is re-derived at three or four call sites and the copies have already drifted
apart. One is a user-visible output bug: a truncated `list` response reads as a
complete one. One is a class that exists to hold two fields only its own
`dispose` reads.

Concrete cost today: a `list` caller cannot tell page 2 of 5 from the whole
answer; a typo in `FS_MAX_FILE_SIZE` is silent at `--log-level=error` while the
same typo in `FS_ALLOW_SENSITIVE` prints; `list` walks and individually re-tests
every file under a gitignored directory that the three sibling tools prune at
walk time.

When this lands: one owner for each of those rules, one field fewer on two core
option types, one class fewer, and every tool findable by the name it answers
to on the wire.

Requirements covered: none — this is a set of fixes and refactors.

## Current state

Every excerpt below was re-opened at its cited line at `8bf08572`.

### The build

- `npm run check:static` exits 0 at `8bf08572`.
- `npm test` reports `tests 277 / pass 277 / fail 0`.
- Working tree is clean; branch is `main`.

### Step 1 — the server context class

[`src/server.ts:31-60`](../../../src/server.ts#L31-L60) — the whole class:

```ts
export class FilesystemServerContext {
  public readonly mcp: McpServer;
  public readonly pathGuard: PathGuard;
  public readonly pages: PageSnapshotStore;
  /** False when the store is shared across instances and outlives this one. */
  private readonly ownsPages: boolean;
  private readonly resourceDisposable?: { dispose(): void } | undefined;
  private cleanedUp = false;

  constructor(
    mcp: McpServer,
    pathGuard: PathGuard,
    pages: PageSnapshotStore,
    ownsPages: boolean,
    resourceDisposable?: { dispose(): void },
  ) {
    this.mcp = mcp;
    this.pathGuard = pathGuard;
    this.pages = pages;
    this.ownsPages = ownsPages;
    this.resourceDisposable = resourceDisposable;
  }

  disposeRuntimeState(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    if (this.ownsPages) this.pages.clear();
    this.resourceDisposable?.dispose();
  }
}
```

[`src/server.ts:191-201`](../../../src/server.ts#L191-L201) — its only construction
site:

```ts
  const resourceDisposable = registerResources(deps);
  registerPrompts(deps);
  registerTools(deps);

  return new FilesystemServerContext(
    server,
    pathGuard,
    pageStore,
    extraDeps?.pageStore === undefined,
    resourceDisposable,
  );
```

`.pages` has no reader anywhere outside the class — `grep -rn '\.pages\b' src
__tests__` returns only `server.ts:49` and `server.ts:57`. External readers use
`.mcp`, `.pathGuard`, and `.disposeRuntimeState()` only.

[`src/resources.ts:425`](../../../src/resources.ts#L425) declares
`registerResources` as returning `{ dispose(): void }` — **non-nullable**. This
is load-bearing for step 1: see its STOP note.

### Step 2 — the invalid-setting warning, written three times

[`src/core/util.ts:9-25`](../../../src/core/util.ts#L9-L25):

```ts
const loggedWarns = new Set<string>();

function logInvalidEnvValue(
  envVar: string,
  value: string,
  expected: string,
  defaultValue: number | boolean,
): void {
  const key = `${envVar}:${value}:${expected}`;
  if (loggedWarns.has(key)) {
    return;
  }
  loggedWarns.add(key);
  Logger.warn(
    `Invalid ${envVar} value: ${value} (must be ${expected}). Using default: ${String(defaultValue)}`,
  );
}
```

Its only caller is [`util.ts:57`](../../../src/core/util.ts#L57), inside
`parseIntSetting`. `Logger` is imported at
[`util.ts:4`](../../../src/core/util.ts#L4) and used at
[`util.ts:22`](../../../src/core/util.ts#L22) **and nowhere else in the file**.

[`src/core/primitives.ts:26,37-46`](../../../src/core/primitives.ts#L37-L46):

```ts
const warnedFlagValues = new Set<string>();
// ...
  if (name && trimmed !== '' && trimmed !== 'false' && trimmed !== '0') {
    const key = `${name}:${trimmed}`;
    if (!warnedFlagValues.has(key)) {
      warnedFlagValues.add(key);
      // console.error, not Logger: this module stays dependency-free to avoid
      // import cycles (same precedent as parseLogLevel in observability.ts).
      console.error(
        `[warning] Invalid ${name} value: ${value} (must be "true" or "1"). Using default: false`,
      );
    }
  }
```

[`src/core/observability.ts:27-30`](../../../src/core/observability.ts#L27-L30):

```ts
  console.error(
    `[warning] Invalid FS_LOG_LEVEL value: ${raw} (must be ${LEVEL_ORDER.join('|')}). Using default: info`,
  );
  return 'info';
```

The file header at
[`primitives.ts:3-6`](../../../src/core/primitives.ts#L3-L6) is the record that
picks the destination:

> `Minimal shared primitives with no intra-package dependencies.`
> `Kept separate to avoid import cycles between observability.ts and util.ts.`

`primitives.ts` imports only `node:path`, so a call into it from
`observability.ts` creates no cycle.

The three disagree on **behavior**, not only on code. `Logger.warn` routes
through [`observability.ts:59-63`](../../../src/core/observability.ts#L59-L63)
and is gated by `isLevelEnabled`, so `util.ts`'s copy is suppressed at
`--log-level=error`; the other two write to stderr unconditionally.

`Logger.warn` prepends `[warning] ` itself
([`observability.ts:61-62`](../../../src/core/observability.ts#L61-L62)), which
is why the other two type that prefix by hand. Moving `util.ts`'s copy to
`console.error` therefore leaves its emitted text byte-identical.

[`src/core/config.ts:36`](../../../src/core/config.ts#L36) — needed by the new
test: `export const cli: CliOverrides = {}`, written once by `cli.ts` at
startup, so `cli.logLevel` is `undefined` under `node --test` and
`getLogLevel()` falls through to `process.env['FS_LOG_LEVEL']`.

### Step 3 — `includeIgnored` translated in four tools

The flag's schema has an owner —
[`src/core/schema.ts:193`](../../../src/core/schema.ts#L193),
`includeIgnoredField()`. Its meaning does not. Every call site passes the same
pair, and `excludePatterns` never carries a value other than
`DEFAULT_EXCLUDE_PATTERNS` or `[]`:

- [`search-content.ts:193,198`](../../../src/tools/search-content.ts#L193-L198)
- [`replace-in-files.ts:503,505`](../../../src/tools/replace-in-files.ts#L503-L505)
- [`search-files.ts:147,152`](../../../src/tools/search-files.ts#L147-L152)
- [`list.ts:92`](../../../src/tools/list.ts#L92) — passes `excludePatterns` but
  **never** `respectGitignore`

[`src/core/glob.ts:194-203`](../../../src/core/glob.ts#L194-L203):

```ts
export interface GlobEntriesOptions {
  cwd: string;
  pattern: string;
  excludePatterns?: readonly string[];
  includeHidden?: boolean;
  baseNameMatch?: boolean;
  maxDepth?: number;
  onlyFiles?: boolean;
  suppressErrors?: boolean;
  respectGitignore?: boolean;
}
```

[`glob.ts:306`](../../../src/core/glob.ts#L306) inside `normalizeGlobOptions`:

```ts
    exclude: (options.excludePatterns ?? []).map(toPosixPath),
```

[`glob.ts:409-414`](../../../src/core/glob.ts#L409-L414) inside `globEntries`:

```ts
  let gitignoreMatcher: GitignoreManager | null = null;
  if (options.respectGitignore) {
    gitignoreMatcher = await loadRootGitignore(options.cwd);
  }
```

`createExcludeFilter` ([`glob.ts:344-374`](../../../src/core/glob.ts#L344-L374))
is handed to Node's `fsGlob` as its `exclude` callback
([`glob.ts:398`](../../../src/core/glob.ts#L398)), so it filters **at walk time
and prunes ignored directories**.

`list` does the same predicate in the wrong position — after enumeration:

[`list.ts:79-81`](../../../src/tools/list.ts#L79-L81):

```ts
  const gitignoreMatcher = options.includeIgnored
    ? null
    : await loadRootGitignore(rootPath, options.signal);
```

[`list.ts:110-112`](../../../src/tools/list.ts#L110-L112):

```ts
    if (gitignoreMatcher?.isIgnored(relPath, isDir)) {
      continue;
    }
```

> **This is the one real behavior change in step 3.** Children of a gitignored
> directory are never enumerated on the glob path, but are walked and
> individually re-tested on `list`'s path. Git semantics say a path under an
> ignored directory cannot be re-included, so the two agree on the final set —
> but only a test proves it here.

[`src/core/search.ts:169-176`](../../../src/core/search.ts#L169-L176) and
[`search.ts:343`](../../../src/core/search.ts#L343) carry the same pair; the
latter as a **positional** parameter:

```ts
export async function searchFiles(
  directory: string,
  pattern: string,
  excludePatterns: string[],
  options: { /* ... respectGitignore?: boolean; ... */ },
  pathGuard: PathGuard,
)
```

Its four test call sites pass `[]` for that positional —
[`core-fs.test.ts:203`](../../../__tests__/core-fs.test.ts#L203),
[`:207`](../../../__tests__/core-fs.test.ts#L207),
[`:217`](../../../__tests__/core-fs.test.ts#L217),
[`:223`](../../../__tests__/core-fs.test.ts#L223):

```ts
      const tsResults = await searchFiles(searchDir, '**/*.ts', [], {}, ctx.pathGuard);
```

After this step `DEFAULT_EXCLUDE_PATTERNS`
([`glob.ts:425`](../../../src/core/glob.ts#L425)) and `loadRootGitignore`
([`glob.ts:172`](../../../src/core/glob.ts#L172)) lose every caller outside
`glob.ts`.

### Step 4 — `list` hand-rolls its trailer

[`src/core/fmt.ts:114-116`](../../../src/core/fmt.ts#L114-L116) — the stated
invariant on the owner:

```ts
  const lines: string[] = [];
  // Position is owed on every page of a split set, including the last one —
  // which has no cursor and would otherwise read as the whole answer.
  if (p.offset > 0 || p.total > p.shown) {
```

`pageTrailer` prefixes its own `\n\n`
([`fmt.ts:132`](../../../src/core/fmt.ts#L132)) and emits nothing at all for a
complete single page.

[`list.ts:358-375`](../../../src/tools/list.ts#L358-L375) — the hand-rolled
version, which emits a line only when `nextCursor` or `resourceUri` exists:

```ts
    const { structured, markdown, link } = await handleList(args, ctx);
    // ...
    const trailer: string[] = [];
    if (structured.nextCursor !== undefined) {
      trailer.push(`nextCursor: ${structured.nextCursor}`);
    }
    if (structured.resourceUri !== undefined) {
      trailer.push(
        `${String(structured.entryCount)} of ${String(structured.totalEntries)} entries shown; full tree at ${structured.resourceUri}`,
      );
    }
    return {
      structured,
      text: trailer.length > 0 ? `${markdown}\n\n${trailer.join('\n')}` : markdown,
      ...(link ? { resources: [link] } : {}),
    };
```

`nextCursor` is `undefined` on the last page
([`cursor.ts:27-30`](../../../src/core/cursor.ts#L27-L30)) and `resourceUri` is
first-page-only ([`cursor.ts:81-85`](../../../src/core/cursor.ts#L81-L85)), so
the last page of a split listing ships a bare tree.

The two sibling paged tools do it right, and both are the exemplar to imitate —
[`search-files.ts:228-238`](../../../src/tools/search-files.ts#L228-L238):

```ts
    const text =
      body +
      pageTrailer({
        offset,
        shown: structured.results.length,
        total,
        noun: 'files',
        tool: 'find_files',
        nextCursor: structured.nextCursor,
        stoppedReason: structured.stoppedReason,
      });
```

They get `offset` by returning it from their handler —
[`search-files.ts:191`](../../../src/tools/search-files.ts#L191),
`offset: paged.offset`. `paginate` supplies it
([`cursor.ts:48-55`](../../../src/core/cursor.ts#L48-L55)); `handleList`
receives `paged` and currently throws `offset` away
([`list.ts:325-329`](../../../src/tools/list.ts#L325-L329)).

> `list.ts` does **not** import `../core/fmt.js` today. Its import block ends at
> [`list.ts:31`](../../../src/tools/list.ts#L31). Add a new import line; do not
> look for an existing one to extend.

[`__tests__/tools.test.ts:734-756`](../../../__tests__/tools.test.ts#L734-L756)
— TC-FUNC-075 pins the **old** format and therefore breaks:

```ts
    const match = /^nextCursor: (\S+)$/m.exec(firstText);
    assert.ok(match, `first page text should carry a nextCursor line: ${firstText}`);
    const cursor = match[1];
    // ...
    assert.ok(!/^nextCursor: /m.test(secondText), 'last page advertises no next page');
```

[`__tests__/tools.test.ts:1457-1458`](../../../__tests__/tools.test.ts#L1457-L1458)
is the shape to mirror — the executable record of the same rule for
`search_text`:

```ts
    assert.match(lastText, /^\/\/ showing 9-9 of 9 matches\.$/m);
    assert.doesNotMatch(lastText, /Next page/);
```

[`src/instructions.ts:71`](../../../src/instructions.ts#L71) ships a claim to
the model that this step makes false:

```
'pagination: nextCursor appears in the text (list) or _meta (find_files, search_text) and is backed by a snapshot on the same ~60s clock. ...'
```

Nothing in `__tests__` asserts on the string `full tree at` or
`entries shown` — verified by grep, only `list.ts:368` matches.

### Step 5 — three names per tool

The wire name is the contract: documented in backticks at
[`README.md:214-241`](../../../README.md#L214-L241) and called by name in the
tests. Seven of thirteen tools disagree with it in their filename, their export
constant, or both:

| Wire name (contract) | File today             | Constant today             |
| :------------------- | :--------------------- | :------------------------- |
| `search_text`        | `search-content.ts`    | `SEARCH_CONTENT`           |
| `find_files`         | `search-files.ts`      | `SEARCH_FILES`             |
| `replace_text`       | `replace-in-files.ts`  | `SEARCH_AND_REPLACE`       |
| `list_roots`         | `roots.ts`             | `LIST_ALLOWED_DIRECTORIES` |
| `delete`             | `delete-file.ts`       | `DELETE_FILE`              |
| `stat`               | `stat.ts` (matches)    | `GET_FILE_INFO`            |
| `read`               | `read.ts` (matches)    | `READ_FILE`                |

[`src/tools/index.ts:6-19`](../../../src/tools/index.ts#L6-L19) is the only
module that imports these files, and
[`src/instructions.ts:6-14`](../../../src/instructions.ts#L6-L14) is the only
other module that imports the constants. Verified: no test imports any of these
files by path.

`src/tools/index.ts` re-exports six of the seven for `instructions.ts`
([`index.ts:51`](../../../src/tools/index.ts#L51)), under a comment stating that
this module is the one owner of the inventory.

### Step 6 — the README structure table

[`README.md:257-286`](../../../README.md#L257-L286). Two rows describe a repo
that no longer exists:

```text
├── scripts/          Build and task utilities
```

`ls scripts` → `No such file or directory`. The directory was deleted; its 67
commits are all in the past.

```text
| `src/tools/batch.ts`  | Batch helpers (runOverPaths, normalizeBatchItems)              |
```

[`batch.ts:20`](../../../src/tools/batch.ts#L20) declares
`normalizeBatchItems` as a **private** function. The file's exports are
`PerPathResult`, `BatchResult`, `runOverPaths`, `isTotalFailure`
([`batch.ts:6,8,33,98`](../../../src/tools/batch.ts#L6-L98)).

The rest of that section is correct and must not be touched — in particular the
declared gradient at [`README.md:274-276`](../../../README.md#L274-L276)
("Runtime composition flows from `src/index.ts` to `src/transport.ts`, then to
`src/server.ts`, the registrars, and finally `src/core/`") matches the code.

### Conventions to match

- **Error/format helpers live in `core/`, tools call them.** Exemplar:
  [`search-files.ts:228-238`](../../../src/tools/search-files.ts#L228-L238)
  calling `pageTrailer`.
- **`console.error` only, never `console.log`.** Enforced by
  [`eslint.config.mjs:90`](../../../eslint.config.mjs#L90):
  `'no-console': ['error', { allow: ['error'] }]`.
- **Registrars must not import `server.ts`.**
  [`eslint.config.mjs` block `project/registrar-boundaries`](../../../eslint.config.mjs#L160-L177)
  — applies to `src/prompts.ts`, `src/resources.ts`, `src/tools/**/*.ts`. No
  step here adds such an import; do not introduce one.
- **`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on**
  ([`tsconfig.json`](../../../tsconfig.json)). Optional fields are spread
  conditionally (`...(x ? { x } : {})`), never assigned `undefined`.
- **Comments explain *why*, not *what*.** Match the density of the file you are
  editing; do not add narration to a line that reads plainly.

## Commands

| Purpose      | Command                | Expected on success                     |
| ------------ | ---------------------- | --------------------------------------- |
| Drift check  | `git diff --stat 8bf08572..HEAD -- src/ __tests__/ README.md` | no output at start of run |
| Static check | `npm run check:static`  | exit 0 — build, both typechecks, eslint, prettier, knip all clean |
| Tests        | `npm test`              | exit 0, `pass 277` at start, `fail 0` always |
| Format + fix | `npm run fix`           | exit 0; runs prettier and eslint --fix, then the full check |

`npm run check:static` takes roughly 40s; `npm test` roughly 15s.

## Scope

**In scope** — the only files to modify:

- [`src/server.ts`](../../../src/server.ts) — step 1
- [`src/core/primitives.ts`](../../../src/core/primitives.ts) — step 2
- [`src/core/util.ts`](../../../src/core/util.ts) — step 2
- [`src/core/observability.ts`](../../../src/core/observability.ts) — step 2
- [`src/core/glob.ts`](../../../src/core/glob.ts) — step 3
- [`src/core/search.ts`](../../../src/core/search.ts) — step 3
- [`src/tools/list.ts`](../../../src/tools/list.ts) — steps 3 and 4
- [`src/tools/search-content.ts`](../../../src/tools/search-content.ts) — steps 3 and 5
- [`src/tools/search-files.ts`](../../../src/tools/search-files.ts) — steps 3 and 5
- [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts) — steps 3 and 5
- [`src/tools/roots.ts`](../../../src/tools/roots.ts) — step 5
- [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts) — step 5
- [`src/tools/read.ts`](../../../src/tools/read.ts) — step 5
- [`src/tools/stat.ts`](../../../src/tools/stat.ts) — step 5
- [`src/tools/index.ts`](../../../src/tools/index.ts) — step 5
- [`src/instructions.ts`](../../../src/instructions.ts) — steps 4 and 5
- [`__tests__/core-fs.test.ts`](../../../__tests__/core-fs.test.ts) — steps 2 and 3
- [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts) — steps 3 and 4
- [`README.md`](../../../README.md) — step 6

**Files out of scope** — leave alone even though they look related:

- [`src/core/fmt.ts`](../../../src/core/fmt.ts) — `pageTrailer` is the owner
  step 4 routes `list` *to*. Editing it would change the two tools that already
  call it correctly.
- [`src/core/cursor.ts`](../../../src/core/cursor.ts) — already supplies
  `offset`; step 4 consumes what exists.
- [`src/core/schema.ts`](../../../src/core/schema.ts) — `includeIgnoredField()`
  is the flag's owner and is correct. Step 3 fixes its *translation*, not the
  field.
- [`src/transport/stdio.ts`](../../../src/transport/stdio.ts),
  [`src/transport/http.ts`](../../../src/transport/http.ts) — they consume
  `FilesystemServerContext` as a type only. `import type` binds identically to
  an interface, so step 1 must not need to touch them. If it does, that is a
  STOP.
- [`src/tools/create.ts`](../../../src/tools/create.ts),
  [`edit.ts`](../../../src/tools/edit.ts),
  [`move.ts`](../../../src/tools/move.ts),
  [`patch.ts`](../../../src/tools/patch.ts),
  [`diff.ts`](../../../src/tools/diff.ts) — their filenames already match their
  wire names and they do not walk files. Nothing here touches them.
- [`package.json`](../../../package.json),
  [`server.json`](../../../server.json) — versions are bumped only by the
  Release workflow. Never hand-edit either.
- `docs/plan/**` — effort records.

## Steps

### 1. Replace `FilesystemServerContext` with an interface

In [`src/server.ts`](../../../src/server.ts) only.

Delete the class at [`server.ts:31-60`](../../../src/server.ts#L31-L60) and put
in its place the interface it already is to every consumer:

```ts
export interface FilesystemServerContext {
  readonly mcp: McpServer;
  readonly pathGuard: PathGuard;
  disposeRuntimeState(): void;
}
```

`pages` leaves the surface — it has no reader.

Replace the `new FilesystemServerContext(...)` return at
[`server.ts:195-201`](../../../src/server.ts#L195-L201) with an object literal
whose `disposeRuntimeState` closes over the locals already in scope:

```ts
  // False when the store is shared across instances and outlives this one.
  const ownsPages = extraDeps?.pageStore === undefined;
  let cleanedUp = false;
  return {
    mcp: server,
    pathGuard,
    disposeRuntimeState() {
      if (cleanedUp) return;
      cleanedUp = true;
      if (ownsPages) pageStore.clear();
      resourceDisposable.dispose();
    },
  };
```

> Write `resourceDisposable.dispose()`, **not** `resourceDisposable?.dispose()`.
> `registerResources` is declared non-nullable at
> [`resources.ts:425`](../../../src/resources.ts#L425), so the optional chain
> becomes an unnecessary condition and
> `@typescript-eslint/no-unnecessary-condition` rejects it. The optional 5th
> constructor parameter dies with the class.

**Verify**: `npm run check:static && npm test` → exit 0, `pass 277`, `fail 0`.

### 2. Give the invalid-setting warning one owner

Add to [`src/core/primitives.ts`](../../../src/core/primitives.ts), replacing
the private `warnedFlagValues` block, an exported generalization. Carry the
existing `console.error, not Logger` comment
([`primitives.ts:41-42`](../../../src/core/primitives.ts#L41-L42)) onto it:

```ts
const warnedSettings = new Set<string>();

/**
 * Warn once per (setting, value) that a configured value was rejected, and say
 * what was used instead. console.error, not Logger: this module stays
 * dependency-free to avoid import cycles, and a startup misconfiguration is
 * worth printing even when the operator asked for errors only.
 */
export function warnInvalidSetting(
  name: string,
  value: string,
  expected: string,
  fallback: string | number | boolean,
): void {
  const key = `${name}:${value}`;
  if (warnedSettings.has(key)) return;
  warnedSettings.add(key);
  console.error(
    `[warning] Invalid ${name} value: ${value} (must be ${expected}). Using default: ${String(fallback)}`,
  );
}
```

Point the three copies at it, each keeping its emitted text byte-identical:

- [`primitives.ts:37-46`](../../../src/core/primitives.ts#L37-L46) inside
  `parseTrueEnvFlag` → `warnInvalidSetting(name, value, '"true" or "1"', false);`
- [`util.ts:57`](../../../src/core/util.ts#L57) →
  `warnInvalidSetting(name, value, `${String(min)}-${String(max)}`, defaultValue);`
  then delete `loggedWarns` ([`util.ts:9`](../../../src/core/util.ts#L9)),
  delete `logInvalidEnvValue`
  ([`util.ts:11-25`](../../../src/core/util.ts#L11-L25)), and delete the now-dead
  `import { Logger } from './observability.js';`
  ([`util.ts:4`](../../../src/core/util.ts#L4)) — its only use was line 22.
- [`observability.ts:27-30`](../../../src/core/observability.ts#L27-L30) →
  `warnInvalidSetting('FS_LOG_LEVEL', raw, LEVEL_ORDER.join('|'), 'info');`

**Keep** `cachedRaw` / `cachedLevel`
([`observability.ts:36-37,47-50`](../../../src/core/observability.ts#L36-L50)).
That is the log-level memo `getLogLevel()` depends on, not a warn-dedupe store —
its own JSDoc says so. It survives this step untouched.

> This step is a **deliberate behavior change**, not a pure refactor:
> `FS_MAX_FILE_SIZE`, `FS_MAX_READ_MANY_BYTES`, `FS_SEARCH_TIMEOUT_MS`,
> `FS_MAX_WATCHERS`, `FS_MAX_REQUEST_BYTES`, `FS_RATE_LIMIT_RPM` and
> `FS_KEEPALIVE_TIMEOUT_MS` typo warnings stop being suppressible by
> `--log-level=error`, matching what `FS_ALLOW_SENSITIVE` and `FS_LOG_LEVEL`
> already do.

Nothing asserts on these strings today, so leave the check behind. Add to
[`__tests__/core-fs.test.ts`](../../../__tests__/core-fs.test.ts) one test that
sets `process.env['FS_LOG_LEVEL'] = 'error'` and a bad
`process.env['FS_MAX_READ_MANY_BYTES']`, stubs `console.error` to collect calls,
calls `getDefaultReadManyMaxTotalSize()` twice, and asserts:

- the returned value is the documented default,
- exactly **one** `[warning] Invalid FS_MAX_READ_MANY_BYTES` line was collected
  across the two calls (once per setting, not per call),
- the line reached stderr despite `FS_LOG_LEVEL=error`.

Restore both env vars and `console.error` in the test's own cleanup.
[`config.ts:36`](../../../src/core/config.ts#L36) guarantees `cli.logLevel` is
unset under `node --test`, so the env var is what `getLogLevel()` reads.

**Verify**: `npm run check:static && npm test` → exit 0, `pass 278`, `fail 0`.

### 3. Delete `excludePatterns`; rename `respectGitignore` to `skipIgnored`

One flag now selects both `DEFAULT_EXCLUDE_PATTERNS` and the `.gitignore` walk.
`excludePatterns` never carries a custom value at any of its five call sites, so
it is deleted rather than kept. The rename is not cosmetic: a flag named
`respectGitignore` that also drops `node_modules` is the quiet lie that breeds
the next ownership defect.

Default polarity is unchanged throughout — flag absent still means "walk
everything" — so every existing test keeps its current semantics.

In [`src/core/glob.ts`](../../../src/core/glob.ts):

1. [`:196`](../../../src/core/glob.ts#L196) delete `excludePatterns?: readonly string[];`
2. [`:202`](../../../src/core/glob.ts#L202) rename `respectGitignore?: boolean;` → `skipIgnored?: boolean;`
3. [`:306`](../../../src/core/glob.ts#L306) derive the excludes from the flag:
   `exclude: options.skipIgnored ? DEFAULT_EXCLUDE_PATTERNS.map(toPosixPath) : [],`
4. [`:411`](../../../src/core/glob.ts#L411) `if (options.respectGitignore)` → `if (options.skipIgnored)`

In [`src/core/search.ts`](../../../src/core/search.ts):

5. [`:174-175`](../../../src/core/search.ts#L174-L175) delete `excludePatterns?: string[];`, rename `respectGitignore` → `skipIgnored`
6. [`:224-226`](../../../src/core/search.ts#L224-L226) drop the `excludePatterns` line; `skipIgnored: Boolean(options.skipIgnored),`
7. [`:343`](../../../src/core/search.ts#L343) delete the `excludePatterns: string[],` **positional parameter** of `searchFiles`
8. [`:348`](../../../src/core/search.ts#L348) rename the option; [`:369-371`](../../../src/core/search.ts#L369-L371) drop `excludePatterns`, pass `skipIgnored`

In the four tools — each collapses to one line, `skipIgnored: !args.includeIgnored`:

9. [`search-content.ts:193,198`](../../../src/tools/search-content.ts#L193-L198)
10. [`replace-in-files.ts:503,505`](../../../src/tools/replace-in-files.ts#L503-L505)
11. [`search-files.ts:147,152`](../../../src/tools/search-files.ts#L147-L152) —
    also drop the `excludePatterns` argument from the `searchFiles(...)` call at
    [`:156-162`](../../../src/tools/search-files.ts#L156-L162), and note that
    `Parameters<typeof searchFiles>[3]` at
    [`:148`](../../../src/tools/search-files.ts#L148) becomes
    `Parameters<typeof searchFiles>[2]`
12. [`list.ts:79-81`](../../../src/tools/list.ts#L79-L81) delete
    `gitignoreMatcher`; [`:92`](../../../src/tools/list.ts#L92) replace
    `excludePatterns` with `skipIgnored: !options.includeIgnored`;
    [`:110-112`](../../../src/tools/list.ts#L110-L112) delete the
    `isIgnored` / `continue` block; [`:10`](../../../src/tools/list.ts#L10)
    reduce the import to `import { globEntries } from '../core/glob.js';`

Then drop the four `[]` positionals in
[`core-fs.test.ts:203,207,217,223`](../../../__tests__/core-fs.test.ts#L203-L223).

> If `knip` now reports `DEFAULT_EXCLUDE_PATTERNS`
> ([`glob.ts:425`](../../../src/core/glob.ts#L425)) or `loadRootGitignore`
> ([`glob.ts:172`](../../../src/core/glob.ts#L172)) as unused exports — both lose
> their last caller outside `glob.ts` in this step — drop the `export` keyword
> from each. Do not delete them; `glob.ts` still uses both internally.

`list` is the one tool whose observable behavior moves here, so pin it. Add to
[`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts), beside the other
`list` cases, a test that creates a directory holding `.gitignore` with
`ignored/`, a file `ignored/deep/buried.txt`, and a file `kept.txt`, then calls
`list` with default flags and asserts:

- `kept.txt` appears,
- neither `ignored` nor `buried.txt` appears — the children of an ignored
  directory stay out, not just the directory itself,
- calling again with `includeIgnored: true` returns all three.

**Verify**: `npm run check:static && npm test` → exit 0, `pass 279`, `fail 0`.

### 4. Route `list` through `pageTrailer`

In [`src/tools/list.ts`](../../../src/tools/list.ts):

1. Add a new import line — `list.ts` has no `../core/fmt.js` import today:
   `import { pageTrailer } from '../core/fmt.js';`
2. [`:264-268`](../../../src/tools/list.ts#L264-L268) add `offset: number;` to
   `handleList`'s return type.
3. [`:325-329`](../../../src/tools/list.ts#L325-L329) add `offset: paged.offset,`
   to its return object.
4. [`:358-375`](../../../src/tools/list.ts#L358-L375) replace the hand-rolled
   trailer with:

```ts
    const { structured, markdown, offset, link } = await handleList(args, ctx);
    const text =
      markdown +
      pageTrailer({
        offset,
        shown: structured.entryCount,
        total: structured.totalEntries,
        noun: 'entries',
        tool: 'list',
        nextCursor: structured.nextCursor,
      }) +
      (structured.resourceUri !== undefined ? `\nfull tree at ${structured.resourceUri}` : '');
    return {
      structured,
      text,
      ...(link ? { resources: [link] } : {}),
    };
```

Do not pass `stoppedReason` — `list` has none. The first-page
`full tree at <uri>` line stays as its truncation signal; the counts that used
to precede it are now in the position line, so they are dropped from it.

5. Fix the claim this makes false at
   [`instructions.ts:71`](../../../src/instructions.ts#L71). All three paged
   tools now carry the cursor in the trailer text *and* in `_meta`, so the
   `the text (list) or _meta (find_files, search_text)` split is no longer true.
   Replace that whole array element with exactly this string — do not paraphrase
   it, the assertion in item 5b matches on it:

```ts
      'pagination: nextCursor appears in the result text and in _meta, backed by a snapshot on the same ~60s clock. Page through promptly; if a cursor is rejected, start again without one. resourceUri appears on the first page only.',
```

   Only the first sentence changes; the rest of the element is byte-identical to
   what is there today.

5b. Gate that edit. Nothing in the suite reads this line — the tests that touch
   `buildSectionsRecord` compare its output to itself, and TC-FUNC-055's
   constraints walk stops one key short of it. Extend that walk: in
   [`__tests__/resources.test.ts`](../../../__tests__/resources.test.ts), after
   [`:64`](../../../__tests__/resources.test.ts#L64)
   (`assert.match(constraints, /ephemeral_results:/);`) add

```ts
      assert.match(constraints, /pagination: nextCursor appears in the result text and in _meta,/);
```

   This is the only check in the plan that fails on an unedited, wrongly-edited,
   or paraphrased line 71. It is a new assertion inside an existing test, so the
   test count does not change.

6. TC-FUNC-075
   ([`tools.test.ts:734-756`](../../../__tests__/tools.test.ts#L734-L756))
   **breaks** — it extracts the cursor with `/^nextCursor: (\S+)$/m` and asserts
   that pattern's absence on the last page. Rewrite it against the new format,
   mirroring the `search_text` case at
   [`tools.test.ts:1457-1458`](../../../__tests__/tools.test.ts#L1457-L1458):

   - extract with `/^\/\/ showing 1-2 of 4 entries\. Next page: list \{"cursor":"([^"]+)"\}$/m`
   - keep the existing assertion that the extracted cursor equals
     `_meta.nextCursor`
   - replace the absence assertion at
     [`:755`](../../../__tests__/tools.test.ts#L755) with the positive pair:
     `assert.match(secondText, /^\/\/ showing 3-4 of 4 entries\.$/m)` and
     `assert.doesNotMatch(secondText, /Next page/)`

**Verify**: `npm run check:static && npm test` → exit 0, `pass 279`, `fail 0`.

### 5. Rename each tool's file and constant to its wire name

Five file renames — use `git mv` so history follows:

```
git mv src/tools/search-content.ts src/tools/search-text.ts
git mv src/tools/search-files.ts src/tools/find-files.ts
git mv src/tools/replace-in-files.ts src/tools/replace-text.ts
git mv src/tools/roots.ts src/tools/list-roots.ts
git mv src/tools/delete-file.ts src/tools/delete.ts
```

Seven constant renames, in the file that declares each and at every use:

| Constant today             | Becomes      | Declared in                 |
| :------------------------- | :----------- | :-------------------------- |
| `SEARCH_CONTENT`           | `SEARCH_TEXT`| `src/tools/search-text.ts`  |
| `SEARCH_FILES`             | `FIND_FILES` | `src/tools/find-files.ts`   |
| `SEARCH_AND_REPLACE`       | `REPLACE_TEXT` | `src/tools/replace-text.ts` |
| `LIST_ALLOWED_DIRECTORIES` | `LIST_ROOTS` | `src/tools/list-roots.ts`   |
| `DELETE_FILE`              | `DELETE`     | `src/tools/delete.ts`       |
| `GET_FILE_INFO`            | `STAT`       | `src/tools/stat.ts`         |
| `READ_FILE`                | `READ`       | `src/tools/read.ts`         |

`stat.ts` and `read.ts` keep their filenames — those already match the wire name.

The only two modules to update are
[`src/tools/index.ts`](../../../src/tools/index.ts) (its imports at
[`:6-19`](../../../src/tools/index.ts#L6-L19), the `ALL_TOOLS` array at
[`:21-35`](../../../src/tools/index.ts#L21-L35), and the re-export at
[`:51`](../../../src/tools/index.ts#L51)) and
[`src/instructions.ts`](../../../src/instructions.ts) (its import at
[`:6-14`](../../../src/instructions.ts#L6-L14) and the constant uses through
`buildToolsOverview` and `buildSectionsRecord`).

**Change no `name:` string.** The wire names are the contract and are already
correct; this step moves the filenames and constants onto them, never the
reverse. `git diff` must show zero changes to any line matching `name: '`.

Sort order matters to lint: `@trivago/prettier-plugin-sort-imports` orders the
import block, so run `npm run fix` rather than hand-sorting.

**Verify**: `npm run fix` → exit 0. Then
`git diff --stat 8bf08572..HEAD -- src/tools/ | grep -c 'name:'` → `0`, and
`npm test` → `pass 279`, `fail 0`.

### 6. Correct the README structure table

In [`README.md`](../../../README.md) only.

1. Delete the `scripts/` line from the tree block at
   [`README.md:259-272`](../../../README.md#L259-L272) — the directory does not
   exist.
2. In the path table at
   [`README.md:278-285`](../../../README.md#L278-L285), change the
   `src/tools/batch.ts` row's description from
   `Batch helpers (runOverPaths, normalizeBatchItems)` to name only the actual
   exports: `runOverPaths` and `isTotalFailure`.

Leave the rest of the section alone — the declared gradient at
[`README.md:274-276`](../../../README.md#L274-L276) is correct.

**Verify**: `npm run check:static` → exit 0 (prettier checks Markdown), and
`grep -c 'scripts/' README.md` → `0`.

## Done

All must hold:

- [ ] `npm run check:static` exits 0
- [ ] `npm test` exits 0 with `fail 0` and `pass 279` — 277 baseline plus the
      invalid-setting warning test (step 2) and the gitignored-children test
      (step 3)
- [ ] `grep -rn 'excludePatterns\|respectGitignore' src` returns nothing
- [ ] `grep -rn 'FilesystemServerContext' src` shows only the interface
      declaration in `server.ts` and `import type` lines
- [ ] `grep -rn 'SEARCH_CONTENT\|SEARCH_FILES\|SEARCH_AND_REPLACE\|LIST_ALLOWED_DIRECTORIES\|DELETE_FILE\|GET_FILE_INFO\|READ_FILE' src`
      returns nothing
- [ ] `git diff 8bf08572..HEAD -- src/tools/ | grep "name: '"` returns nothing —
      no wire name changed
- [ ] `grep -c 'the text (list) or _meta' src/instructions.ts` returns `0`, and
      `grep -c 'nextCursor appears in the result text and in _meta' src/instructions.ts`
      returns `1` — the pagination claim was corrected, not merely touched
- [ ] `git status` shows no files outside the in-scope list

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt.
- A step's verification fails twice after one fix attempt — a second failure
  means the step's assumption is wrong, not its implementation.
- The fix appears to require an out-of-scope file.
- **Step 1**: removing the class forces an edit to
  [`src/transport/stdio.ts`](../../../src/transport/stdio.ts) or
  [`src/transport/http.ts`](../../../src/transport/http.ts). They bind the name
  with `import type`, which resolves to an interface identically; a required
  edit there means something reads `.pages` or constructs the class, and the
  grep behind this plan missed it.
- **Step 2**: any existing test starts failing on a log line. That would mean a
  suite depends on `util.ts`'s warning being suppressed at `error` level — the
  exact behavior this step changes — and the change needs the user's call, not
  a workaround.
- **Step 3**: the new `list` test shows a gitignored directory's children still
  present, or a previously-listed entry disappearing. Walk-time pruning is
  assumed equivalent to post-filtering because git forbids re-including a path
  under an ignored directory. If the sets differ, that assumption is false and
  the step is wrong, not the test.
- **Step 5**: any `name:` string differs from `8bf08572`. A changed wire name is
  a breaking protocol change and the opposite of this step's intent.

## Notes

- **Review focus.** Step 3 is the one with real behavioral risk and the widest
  blast radius; step 2 changes observable output deliberately. Steps 1, 4, 5 and
  6 are mechanical once their gates pass.
- **Step 1 is independently verified.** The move was executed during the audit:
  `check:static` clean, 277/277 pass. If it fails here, drift is the first
  suspect — run the drift check.
- **Order is load-bearing between steps 3 and 4.** Step 3 changes which entries
  `list` returns, and therefore the totals step 4's new trailer prints. Doing 4
  first means writing assertions against counts that step 3 then invalidates.
- **Step 5 goes last on purpose.** It renames files that steps 3 and 4 edit;
  running it earlier rewrites every later diff's paths for no gain.
- **Deliberately deferred.** Fourteen further audit candidates were dropped at
  the audit's bar — mostly moves whose product was a new shared module, plus
  everything in `src/transport/` (30 commits in twelve months earns no
  restructure). They are not in this plan and should not be smuggled in.
- **Rollback.** No migrations, no data, no deletions beyond source. `git revert`
  the step's commit, or `git checkout 8bf08572 -- <path>` for a single file.
  Commit per step so this stays true.
