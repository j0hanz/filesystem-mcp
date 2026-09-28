# Plan: Restore the registrar boundary and remove two internal forwarding layers

> **Executor rules**: work the steps in order, from the repository root. Run
> every Verify command and confirm its expected result before moving on.
> On any [STOP](#stop) condition, stop and report the condition, step, and
> evidence. This plan authorizes implementation, not commits, pushes, or a release.
>
> **Written against** commit `b2a6fac5`, 2026-09-28.
> **Drift check (run first)**:
> `git diff --stat b2a6fac5..HEAD -- eslint.config.mjs __tests__\registrar-boundaries.test.ts __tests__\tools.test.ts src\tools\batch.ts src\tools\create.ts src\tools\edit.ts src\tools\read.ts src\tools\stat.ts src\core\fs.ts`
> Compare [Current state](#current-state) with every flagged file. Also run
> `git status --short`: the commit-range check does not include uncommitted
> changes. Do not overwrite work from another effort.

## Goal

Address all three findings from the architecture audit of 2026-09-28.
The registrar import restriction currently misses TypeScript source imports;
the batch adapter discards payload types that four callers reconstruct; and
the guarded write method forwards to a private helper used nowhere else.
Restore the existing boundary and delete the two redundant translations,
without changing MCP schemas, results, filesystem behavior, or public exports.
Requirements covered: none, this is one enforcement fix and two
behavior-preserving refactors.

## Current state

### Registrar enforcement

The declared gradient in
[`README.md:310-312`](../../../README.md#L310-L312) ends with:

> Each registrar owns the narrow dependency contract it consumes.

The rule at
[`eslint.config.mjs:149-166`](../../../eslint.config.mjs#L149-L166)
already targets the three registrar surfaces but only matches JavaScript
extensions:

```js
name: 'project/registrar-boundaries',
files: ['src/prompts.ts', 'src/resources.ts', 'src/tools/**/*.ts'],
// Within no-restricted-imports.patterns:
{
  regex: '^(?:\\.\\.?/)+server\\.js$',
  message: 'Registrars own local dependency contracts; do not import server.ts.',
}
```

The existing Node builtin restrictions in this rule must remain intact.
The current source graph has no prohibited registrar-to-factory import: this
fix restores enforcement, rather than removing an existing inverted edge.
An in-memory ESLint probe accepted the prohibited TypeScript imports while
rejecting their JavaScript counterparts.

The new regression will use existing files as virtual lint contexts, never
write fixture imports into them:
[`read.ts`](../../../src/tools/read.ts),
[`prompts.ts`](../../../src/prompts.ts),
[`resources.ts`](../../../src/resources.ts), and the permitted
[`http.ts:36`](../../../src/transport/http.ts#L36) factory import.
[`errors.ts`](../../../src/core/errors.ts) supplies permitted core-import
controls. ESLint is already a development dependency in
[`package.json`](../../../package.json); no dependency installation or
configuration expansion is needed.

### Batch translation and its four callers

[`batch.ts:13-35`](../../../src/tools/batch.ts#L13-L35):

```ts
type BatchInput<TOverride> =
  { path: string } | { paths: string[] } | { files: ({ path: string } & TOverride)[] };

function normalizeBatchItems<TOverride>(
  args: BatchInput<TOverride>,
): { path: string; override?: TOverride }[] {
  if ('path' in args) return [{ path: args.path }];
  if ('paths' in args) return args.paths.map((path) => ({ path }));
  if ('files' in args)
    return args.files.map(({ path, ...rest }) => ({
      path,
      override: rest as TOverride,
    }));
  return [];
}

export async function runOverPaths<TOverride, TPerPath>(
  args: BatchInput<TOverride>,
  ctx: ToolCtx,
  defaultErrorCode: ErrorCode,
  perPath: (item: { path: string; override?: TOverride }, ctx: ToolCtx) => Promise<TPerPath>,
): Promise<BatchResult<TPerPath>> {
  const items = normalizeBatchItems(args);
```

Keep the executor below that translation, including its empty-input error,
input-index result slots, error conversion, progress, concurrency, signal,
summary calculation, and
[`isTotalFailure`](../../../src/tools/batch.ts#L88-L93).

All four production callsites were searched; there are no direct test callers.

| Caller | Current excerpt | Required adaptation |
| :-- | :-- | :-- |
| [`create.ts:172-176`](../../../src/tools/create.ts#L172-L176) | `>({ files: args.files }, ctx, ErrorCode.UNKNOWN, async ({ path, override }) => {` followed by `const content = override?.content ?? '';` | Pass the original file entries and destructure their required content. |
| [`edit.ts:528-540`](../../../src/tools/edit.ts#L528-L540) | `const sharedEdits = args.edits ?? [];` and `handleEditFile(path, override?.edits ?? sharedEdits, options, ctx)` | Construct one complete item for single-file mode; preserve complete batch entries. |
| [`read.ts:423-435`](../../../src/tools/read.ts#L423-L435) | `const batchInput = { paths: survivors };` and `({ path }) => readOnePath(path, args, ctx, known.get(path))` | Pass the existing string array. |
| [`stat.ts:172-179`](../../../src/tools/stat.ts#L172-L179) | `const batchInput = args.path !== undefined ? { path: args.path } : { paths: args.paths ?? [] };` | Select a string array at the caller. |

The read caller's zero-survivor branch at
[`read.ts:425-435`](../../../src/tools/read.ts#L425-L435) is load-bearing:
budget rejection can remove every item, and the executor intentionally rejects
an empty array. Do not route that branch into the executor.

The mutation flags in
[`create.ts:127-170`](../../../src/tools/create.ts#L127-L170) still decide
confirmation before mutation; the append branch is selected at
[`create.ts:205`](../../../src/tools/create.ts#L205).
Changing the batch parameter is not permission to change either phase.

### Atomic-write forwarding

The private
[`atomicWriteFile`](../../../src/core/fs.ts#L69-L130) has exactly one caller,
[`GuardedFileSystem.writeFile`](../../../src/core/fs.ts#L223-L229):

```ts
async writeFile(
  filePath: string,
  content: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<{ validPath: string }> {
  return atomicWriteFile(filePath, content, this.pathGuard, options);
}
```

The helper's opening currently reads:

```ts
const { signal } = options;
const validPath = await resolveForWrite(pathGuard, filePath);
```

Its final cancellation point at
[`fs.ts:117-118`](../../../src/core/fs.ts#L117-L118) must remain before,
not around or after, the rename:

```ts
signal?.throwIfAborted();
await fsRename(tempPath, validPath);
```

[`resolveForWrite`](../../../src/core/fs.ts#L50-L67) is shared by overwrite
and append; it stays a helper.
The append comment at
[`fs.ts:231-236`](../../../src/core/fs.ts#L231-L236) names the private helper
and must be updated after its removal.

### Existing characterization and conventions

- Node's test runner and strict assertions: imitate
  [`concurrency.test.ts:1-49`](../../../__tests__/concurrency.test.ts#L1-L49).
  It pins the difference between an abort after all work completes and an
  abort that prevents work from starting.
- Expand the existing edit and stat examples at
  [`tools.test.ts:635-652`](../../../__tests__/tools.test.ts#L635-L652) and
  [`tools.test.ts:2355-2369`](../../../__tests__/tools.test.ts#L2355-L2369).
  The mixed append/overwrite case at
  [`tools.test.ts:293-309`](../../../__tests__/tools.test.ts#L293-L309)
  already distinguishes payload-bearing items in one batch.
- Preserve the overwrite assertions at
  [`core-fs.test.ts:188-208`](../../../__tests__/core-fs.test.ts#L188-L208)
  and the before/after-rename abort assertions at
  [`core-fs.test.ts:348-399`](../../../__tests__/core-fs.test.ts#L348-L399).
- Source imports use `.ts` extensions and `node:` builtins; imitate
  [`batch.ts:1-4`](../../../src/tools/batch.ts#L1-L4).
  Formatting is defined by [`.prettierrc`](../../../.prettierrc).
  Strict optional-property and indexed-access checks remain enabled in
  [`tsconfig.json`](../../../tsconfig.json); do not introduce casts to
  conceal an item-type mismatch. Tests use
  [`tsconfig.test.json`](../../../tsconfig.test.json).
- The prior
  [written-file metadata decision](../2026-09-26-written-file-meta/written-file-meta.plan.md#scope)
  rejected folding post-write stat into the write method: a replacement sweep
  would pay extra I/O, and a failure after commit could be reported as a failed
  write. That remains prohibited here.

## Commands

Commands run from the repository root; path-bearing commands below use
PowerShell spelling. Node v24.15.0 and npm 12.0.2 were used for recon.

| Purpose | Command | Expected on success |
| :-- | :-- | :-- |
| Source and test types | `npm run build && npm run type-check:test` | Exit 0, no diagnostics. |
| Boundary and input-mode gate | `node --test --test-name-pattern="registrar import boundaries\|TC-FUNC-013\|TC-FUNC-015s"` | Exit 0. After Step 1, all 13 boundary cases execute and pass, alongside the existing matching tool cases. |
| Focused regressions | `node --test __tests__\tools.test.ts __tests__\core-fs.test.ts __tests__\concurrency.test.ts` | Exit 0, no failures. |
| Full gate | `npm run check` | Exit 0: build, test types, lint, formatting, unused-code analysis, and all tests. |
| Patch whitespace | `git diff --check` | Exit 0, no output. |
| Working-tree inventory | `git status --short` | Only implementation scope and this effort's artifacts appear. |

The table's escaped pipes are Markdown table escapes: the actual test-name
pattern contains ordinary `|` characters, not `\|`.

**Recon results:** all listed commands were exercised before implementation.
The focused regression command reported 150 tests, 148 passed, two
platform skips; the full gate reported 437 tests, 434 passed, three skips.
The narrow command currently has no boundary cases because the new file does
not yet exist; it does run the existing named tool cases. Its future 13-case
requirement is not a claim that an absent regression was already run.
Separately, 26 baseline/repaired ESLint checks exercised the planned matching
rule and controls in memory. The exact five-file batch rewrite was
type-checked in memory against source and tests with no diagnostics and no
repository edits.

## Scope

**In scope** — nine implementation files:

- Modify [`eslint.config.mjs`](../../../eslint.config.mjs).
- Create [`__tests__/registrar-boundaries.test.ts`](../../../__tests__/registrar-boundaries.test.ts)
  (the only intentionally nonexistent implementation link at this baseline).
- Modify [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts).
- Modify [`src/tools/batch.ts`](../../../src/tools/batch.ts).
- Modify [`src/tools/create.ts`](../../../src/tools/create.ts).
- Modify [`src/tools/edit.ts`](../../../src/tools/edit.ts).
- Modify [`src/tools/read.ts`](../../../src/tools/read.ts).
- Modify [`src/tools/stat.ts`](../../../src/tools/stat.ts).
- Modify [`src/core/fs.ts`](../../../src/core/fs.ts).

Plan, hunt, and execution records belong in [this effort directory](./),
not the unrelated plugin effort.

**Files out of scope** — leave alone even though they look related:

- [`src/core/concurrency.ts`](../../../src/core/concurrency.ts) and
  [`__tests__/concurrency.test.ts`](../../../__tests__/concurrency.test.ts):
  the scheduler and its completion/abort semantics are not being redesigned.
- [`src/core/errors.ts`](../../../src/core/errors.ts) and
  [`src/tools/define.ts`](../../../src/tools/define.ts): preserve error
  conversion, tool-context contracts, and registration behavior.
- [`src/core/file-uri.ts`](../../../src/core/file-uri.ts),
  [`src/tools/patch.ts`](../../../src/tools/patch.ts), and
  [`src/tools/replace-text.ts`](../../../src/tools/replace-text.ts):
  metadata ownership and post-write stat decisions stay unchanged; the
  filesystem method signature used by these callers does not change.
- [`__tests__/core-fs.test.ts`](../../../__tests__/core-fs.test.ts):
  existing green characterization already covers the one-file body move.
- [`src/server.ts`](../../../src/server.ts),
  [`src/prompts.ts`](../../../src/prompts.ts),
  [`src/resources.ts`](../../../src/resources.ts), and
  [`src/transport/http.ts`](../../../src/transport/http.ts):
  virtual lint contexts, not files to inject test imports into.
- [`README.md`](../../../README.md): the declared architecture remains true;
  restore its enforcement rather than rewrite the boundary.
- [`package.json`](../../../package.json),
  [`server.json`](../../../server.json), and
  [`mcpb/manifest.json`](../../../mcpb/manifest.json):
  no dependencies, public exports, engines, or versions change.
  [AGENTS.md](../../../AGENTS.md) assigns version changes to the Release workflow.

## Steps

### 1. Pin and restore the existing registrar boundary

Use a red/green cycle for this enforcement change.

Create the
[new boundary test](../../../__tests__/registrar-boundaries.test.ts)
using `ESLint` from `eslint`, strict Node assertions, and a
`describe('registrar import boundaries', ...)` suite.
Resolve the repository root with `fileURLToPath(new URL('..', import.meta.url))`
and pass it as `cwd` to one `new ESLint(...)` instance.
Use `join(...)` for the virtual fixture paths so the test works on both CI
platforms. No files are created by the tests.

Use this helper shape inside the suite:

```ts
async function restrictedImports(filePath: string, specifier: string) {
  const [result] = await eslint.lintText(
    `import * as dependency from '${specifier}';\nvoid dependency;\n`,
    { filePath },
  );
  assert.ok(result, 'the virtual fixture must be linted');
  assert.strictEqual(result.fatalErrorCount, 0);
  return result.messages.filter((message) => message.ruleId === 'no-restricted-imports');
}
```

Make **13 separately named cases**, generated by loops where convenient:

| Virtual context | Specifier | Expected restriction count | Cases |
| :-- | :-- | :-- | --: |
| [`read.ts`](../../../src/tools/read.ts) | `../server.ts`, `../server.js` | 1 each | 2 |
| [`prompts.ts`](../../../src/prompts.ts) | `./server.ts`, `./server.js` | 1 each | 2 |
| [`resources.ts`](../../../src/resources.ts) | `./server.ts`, `./server.js` | 1 each | 2 |
| Same three registrars | `../core/errors.ts` for the tool, `./core/errors.ts` for the two root modules | 0 each | 3 |
| Same three registrars | `path` | 1 each; retain the Node builtin restriction | 3 |
| [`http.ts`](../../../src/transport/http.ts) | `../server.ts` | 0; transport may import the factory | 1 |

Do not weaken the assertions to accept an ignored file or parser failure.

**Verify (red):**
`node --test --test-name-pattern="registrar import boundaries|TC-FUNC-013|TC-FUNC-015s"`
must exit nonzero with exactly the three `.ts` registrar cases failing:
actual restriction count 0, expected 1. Existing named tool cases and the
other boundary controls must not fail.

Then change only the pattern in
[`eslint.config.mjs:159`](../../../eslint.config.mjs#L159):

```js
regex: '^(?:\\.\\.?/)+server\\.[jt]s$',
```

Leave the rule's file globs, builtin restrictions, severity, and message
unchanged. This is not a resolver-aware import-boundary redesign.

**Verify (green):**
`node --test --test-name-pattern="registrar import boundaries|TC-FUNC-013|TC-FUNC-015s"`
exits 0, including all 13 named boundary cases.
`npm run build && npm run type-check:test` exits 0.

### 2. Characterize both public input modes before changing the executor

Modify only the two existing cases in
[`tools.test.ts`](../../../__tests__/tools.test.ts):

- In [the edit case](../../../__tests__/tools.test.ts#L635-L652), define the
  edit array once and iterate over `{ path: file, edits }` and
  `{ files: [{ path: file, edits }] }`. Reset the file to `original content`
  **inside** the loop before each call; both calls must succeed and leave
  `modified content`. Retain the case name.
- In [the stat case](../../../__tests__/tools.test.ts#L2355-L2369), iterate
  over `{ path: file }` and `{ paths: [file] }`; retain the existing success,
  file-type, and positive-size assertions for each. Retain the case name.

This is green characterization of existing behavior, not a schema change.
Keep the [mixed mutation case](../../../__tests__/tools.test.ts#L293-L309)
unchanged: it already checks that one item's append flag does not affect
another item's overwrite.

**Verify:**
`node --test --test-name-pattern="registrar import boundaries|TC-FUNC-013|TC-FUNC-015s"`
exits 0 after both modes execute inside each changed case.
`npm run build && npm run type-check:test` exits 0.

### 3. Pass original items through the existing batch executor

Make the helper and all four caller edits as **one coordinated change**,
then run the gates. No compatibility overload, alternate helper, new
module, or temporarily duplicated scheduler is needed.

In [`batch.ts`](../../../src/tools/batch.ts), delete
[`BatchInput` and `normalizeBatchItems`](../../../src/tools/batch.ts#L13-L27).
The target signature of
[`runOverPaths`](../../../src/tools/batch.ts#L29-L34) is:

```ts
export async function runOverPaths<TItem extends string | { path: string }, TPerPath>(
  items: readonly TItem[],
  ctx: ToolCtx,
  defaultErrorCode: ErrorCode,
  perPath: (item: TItem, ctx: ToolCtx) => Promise<TPerPath>,
): Promise<BatchResult<TPerPath>> {
```

Remove the normalization assignment. Inside the existing scheduler callback,
immediately before its `try`, add:

```ts
const path = typeof item === 'string' ? item : item.path;
```

Continue calling `perPath(item, ctx)`: pass the **original item**, not an
object created by spreading or removing fields. Use the extracted path in
the success envelope, failure envelope, and
[`Problem.fromUnknown`](../../../src/core/errors.ts#L47) call.
Leave everything else in the executor unchanged, including its existing
empty-input error code and message.

Switch the callers:

1. [`create.ts:172-176`](../../../src/tools/create.ts#L172-L176):
   replace the first explicit generic argument with
   `z.infer<typeof CreateFileItemSchema>`; retain the second result-union
   argument. Pass `args.files`, destructure `{ path, content, append }`,
   remove the content fallback, and replace `override?.append` with `append`.
   Do not touch preflight confirmation or either mutation/metadata branch.
2. [`edit.ts:528-540`](../../../src/tools/edit.ts#L528-L540):
   replace the shared-edits and envelope variables with:

   ```ts
   const items =
     args.path !== undefined
       ? [{ path: args.path, edits: args.edits ?? [] }]
       : (args.files ?? []);
   ```

   Let both generics infer:

   ```ts
   const batch = await runOverPaths(items, ctx, ErrorCode.UNKNOWN, ({ path, edits }) =>
     handleEditFile(path, edits, options, ctx),
   );
   ```

3. [`read.ts:423-435`](../../../src/tools/read.ts#L423-L435):
   delete the envelope variable, retain the zero-survivor bypass, pass
   `survivors`, remove the explicit generic arguments, and change the
   callback to `(path) => readOnePath(path, args, ctx, known.get(path))`.
   Do not change budgets, ordering reconstruction, or resource links.
4. [`stat.ts:172-179`](../../../src/tools/stat.ts#L172-L179):
   use `const paths = args.path !== undefined ? [args.path] : (args.paths ?? []);`,
   pass that array, let generics infer, and change the callback parameter
   from `({ path })` to `(path)`. Leave result counting and projections alone.

**Verify:** `npm run build && npm run type-check:test` exits 0 without casts
or new non-null assertions.
`node --test __tests__\tools.test.ts __tests__\core-fs.test.ts __tests__\concurrency.test.ts`
exits 0. No previously passing test may be weakened or removed.

### 4. Put atomic overwrite implementation behind its existing public method

First confirm the preceding focused gate is green. In
[`fs.ts`](../../../src/core/fs.ts), move the body of
[`atomicWriteFile`](../../../src/core/fs.ts#L69-L130) into
[`GuardedFileSystem.writeFile`](../../../src/core/fs.ts#L223-L229).
Replace the helper body's free guard parameter with `this.pathGuard`.
Delete the now-unused private helper and preserve the method signature.

Apart from indentation and that guard expression, preserve the body:
temporary-name generation, mode lookup, exclusive temporary creation,
chmod, abort checks, rename, cleanup, return value, and diagnostic strings.
In particular, keep the warning's `atomicWriteFile:` prefix despite removing
the function; changing log text is not part of this refactor.

Update the [append comment](../../../src/core/fs.ts#L231-L236) to refer to
the `writeFile` temp-and-rename operation instead of the deleted helper.
Keep [`resolveForWrite`](../../../src/core/fs.ts#L50-L67) shared; do not
inline it or add post-write stat/metadata work.

**Verify:** `npm run build && npm run type-check:test` exits 0.
`node --test __tests__\tools.test.ts __tests__\core-fs.test.ts __tests__\concurrency.test.ts`
exits 0, including the two before/after-commit abort cases. Existing
platform-specific skips may remain; do not remove their assertions.

### 5. Close the scope, deletion, and repository gates

Inspect the diff against the recorded baseline. The batch change must delete
more lines than it adds across its five production files plus its modified
test file; the filesystem body move must also be net-deleting. The boundary
regression is intentionally excluded from that deletion budget: it restores
an existing declared rule.

This PowerShell gate accounts for committed and uncommitted tracked edits:

```powershell
$batch = @(
  'src\tools\batch.ts', 'src\tools\create.ts', 'src\tools\edit.ts',
  'src\tools\read.ts', 'src\tools\stat.ts', '__tests__\tools.test.ts'
)
foreach ($paths in @(@($batch), @('src\core\fs.ts'))) {
  $net = 0
  foreach ($row in @(git diff --numstat b2a6fac5 -- $paths)) {
    $columns = $row -split "`t"
    $net += [int]$columns[0] - [int]$columns[1]
  }
  if ($net -ge 0) { throw "Expected net deletion for $($paths -join ', '); got $net" }
  Write-Output "Net lines: $net"
}
```

At the unchanged baseline this gate correctly rejects net zero; after the
two refactors it must print two negative numbers and exit successfully.
Do not delete unrelated code or assertions to force this gate green.

**Verify:** run the deletion gate above, then `git diff --check` and
`npm run check`; all exit 0.
`git status --short` must list no implementation files outside
[Scope](#scope). Do not stage, commit, push, or bump a version.

## Done

- [ ] All 13 boundary cases exist and pass; they include the three forbidden
  `.ts` imports, three `.js` counterparts, three permitted core imports,
  three restricted bare builtins, and one permitted transport/factory import.
- [ ] Both input modes execute in the existing edit and stat cases.
- [ ] The batch executor accepts original items; its old envelope type,
  normalizer, and optional override layer are gone.
- [ ] The atomic-write helper declaration and forwarding call are gone; only
  the intentionally preserved diagnostic prefix may still name it.
- [ ] Both deletion groups pass the Step 5 gate independently.
- [ ] `npm run check` and `git diff --check` exit 0.
- [ ] Only the nine implementation files and this effort's records changed.

## STOP

Stop and report if:

- A flagged baseline location differs from its [Current state](#current-state)
  excerpt, or pre-existing work overlaps the implementation scope.
- A step's verification fails twice after one fix attempt.
- The change requires an out-of-scope implementation file, new dependency,
  public schema change, or public export change.
- The red boundary run fails through a parser error, ignored fixture, or a
  count other than the three known missing `.ts` restrictions.
- A batch caller exists beyond the four mapped here, or preserving its types
  appears to require a cast, compatibility envelope, or payload fallback.
- The atomic helper has gained another caller; inlining would then duplicate
  an implementation rather than remove a private hop.
- Cancellation, permission handling, append behavior, confirmation,
  resource metadata, result ordering, or total/partial-failure semantics
  change to make a refactor pass.
- Either deletion group is nonnegative after formatting and characterization.
- A previously passing test becomes skipped or weakened.

## Notes

- The most important batch review point is that required per-item content and
  edits reach the callback unchanged; concurrency still belongs to
  [`processInParallel`](../../../src/core/concurrency.ts#L32-L97).
- The most important write review point is that rename remains the commit
  boundary: no abort race may turn a committed write into a reported failure.
- Windows cannot prove POSIX mode semantics. Preserve the existing POSIX
  assertions and require the normal cross-platform CI before merging.
- General path canonicalization in import restrictions, broader package
  boundaries, legacy removal, and metadata redesign are deliberately deferred.
- This plan has more than two steps and spans lint, tool execution, and
  filesystem internals. Route it through plan-hunt before run-plan; do not
  treat the recon probes as implementation completion.
