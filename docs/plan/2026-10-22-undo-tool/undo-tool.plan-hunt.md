Status: dead steps

# Plan hunt: Every file-changing tool call can be reverted with a new `undo` tool

Hunted [`undo-tool.plan.md`](undo-tool.plan.md) at `797a7deb`, 2026-10-22.

## Confirmed

- **Step 3.1**, convention violated: the `UndoCapture` sketch uses a
  parameter property, `constructor(readonly maxBytes: number) {}`. Evidence:
  [`tsconfig.json:17`](../../../tsconfig.json#L17) sets
  `"erasableSyntaxOnly": true`, and no file in `src` uses
  `constructor(readonly …)`.
- **Header, Drift check**, wrong expected output: the plan file can never
  appear under the pathspecs. Evidence: running the command at HEAD
  `797a7deb` printed 0 lines, and the plan is untracked
  (`?? docs/plan/2026-10-22-undo-tool/`).
- **Step 3.6 and Design (rename)**, design defect: the hook ignores the
  spelling-only branch. In a case-only rename on a case-insensitive
  filesystem, `validNew` names the source entry itself. Evidence:
  [`fs.ts:218-224`](../../../src/core/fs.ts#L218-L224) has
  `if (sameEntry || validOld === validNew) { validNew = respellSpellingOnlyTarget(...)`.
  The restore check "`from` absent" then always fails.
- **Steps 3.3, 3.4 and 3.7**, design defect: nothing covers a failed capture
  read. A file the server can overwrite but not read would turn a working
  mutation into an error. The `existed` probe also treats non-ENOENT stat
  errors as "new file". Evidence: [`fs.ts:250-254`](../../../src/core/fs.ts#L250-L254)
  logs and swallows non-ENOENT stat errors.
- **Step 3.9, Step 3.10 (e) and Step 4.4 (c)**, convention violated: the
  symlink fixtures skip `trySymlink`, and the record carries no link type, so
  on Windows a junction cannot be restored without the symlink privilege.
  Evidence: [`__tests__/helpers.ts:55-76`](../../../__tests__/helpers.ts#L55-L76)
  shows that `trySymlink` defaults to `'junction'` and skips on EPERM.
- **Step 3.3 and Restore (mode)**, design defect: the mode passed at creation
  is masked by the umask, and the chmod runs only when `existingMode` is set.
  Evidence: [`fs.ts:261-270`](../../../src/core/fs.ts#L261-L270), "the chmod
  below still restores bits the umask masked off at creation" /
  `if (existingMode !== undefined) { await fsChmod(...) }`. `mkdir{mode}` has
  the same problem, and `GuardedFileSystem` has no chmod.
- **Step 4.2 and Restore ("path absent", "ENOENT counts as done")**,
  invented API behaviour: guarded probes throw
  `FsError(NOT_FOUND, 'Parent directory not found')` rather than ENOENT, and
  `isNotFoundErrno` misses it. Evidence:
  [`path.ts:1126-1134`](../../../src/core/path.ts#L1126-L1134) and
  [`fs.ts:669`](../../../src/core/fs.ts#L669), which already treats both as
  missing.
- **Step 4.2 (hashing the current bytes)**, missing API: no whole-file
  reader is named, and every reader on `GuardedFileSystem` refuses files over
  `getMaxTextFileSize()` (10 MiB), while the undo budget is 32 MiB. Evidence:
  [`fs.ts:487-490`](../../../src/core/fs.ts#L487-L490).
- **Step 4.3**, convention and cycle: importing a type from `src/tools` into
  `src/core` would be the first core-to-tools edge, and it closes a cycle
  `core/undo → tools/batch → tools/define → core/fs → core/undo`. The lint gate
  that the step relies on does not exist. Evidence:
  [`eslint.config.mjs:150-160`](../../../eslint.config.mjs#L150-L160) bans
  only `server.ts` imports from tools.
- **Done, 4th checkbox**, self-contradiction: Step 3.8 adds the phrase
  `'copies cannot be undone'` to `src/core/fs.ts`, so
  `git grep -n "cannot be undone" -- src mcpb` can never print nothing.
- **Step 6.1 and Step 6.4 (e)**, invented API behaviour: a schema `.refine` or
  regex failure is rejected by the SDK before the handler runs. Its error text
  carries no `INVALID_INPUT`. Evidence:
  `node_modules/@modelcontextprotocol/server/dist/mcp-DIH4cS6P.mjs:1780-1815`,
  `Input validation error: Invalid arguments for tool ${toolName}`.
- **Step 6 and Scope (tools.test.ts)**, missed breakage: the annotations test
  hardcodes the mutating set. Evidence:
  [`tools.test.ts:4157`](../../../__tests__/tools.test.ts#L4157),
  `const mutating = new Set(['create', 'delete', 'edit', 'move', 'patch', 'replace_text']);`.
- **STOP, 4th bullet**, unobservable: no step runs a case through
  `createStdioClient`, so the symptom that the bullet names never happens.
- **Step 7.5 (README)**, stale line reference: the cache sentence is at
  `README.md:394-395`, not `:392-393`.
- **Done, last checkbox**, wrong gate: `docs/plan/2026-10-22-undo-tool/` is
  untracked and not in scope, so `git status --short` always lists it.

## Suspected

none

## Coverage

Five hunters covered: the header and Steps 1-2, Step 3, Step 4, Step 5, and
Step 6 plus Step 7, Done and STOP. Nineteen candidates went to blind
general-purpose refuters. Two were killed:

- No format step for `src`: the repo's `npm run fix` is the one allowed fix.
- `list()` not pruning: the tool never calls `list()`.

One hunter returned no candidates. Read-only commands ran, including the
drift check. No command that modifies files ran.

## Revision 2026-10-22

Every Confirmed finding is fixed in the plan:

- parameter property replaced;
- drift expected output is empty;
- spelling-only rename row added, and the restore `rename` condition widened;
- capture reads abandon on error;
- symlink `type` added, and fixtures go through `trySymlink`;
- `writeFile` chmods `existingMode ?? options.mode`, and directory mode is
  a recorded cut;
- `isMissing` helper added;
- streaming `hashFile` added;
- the core result type is now `UndoFileResult`, with no tools import;
- the Done grep is narrowed, and the cp reason is reworded;
- no schema refine, so the rule is checked in `run`;
- `undo` added to the `mutating` set;
- stdio case (k) added;
- README lines corrected;
- the plan directory is in scope.

The plan needs a second hunt.

## Hunt 2026-10-22 (round 2)

Status: dead steps

Hunted the revised plan at `797a7deb`. 12 candidates went to blind refuters:
10 confirmed, 1 suspected, 1 killed.

### Confirmed

- **Tool surface / Step 6.2 (dryRun listing)**: a bare `dryRun` resolves to
  `newest(1)`, which contradicts "lists every live entry", and `list()`
  does not prune.
- **Step 3.9, Record shapes (symlink type)**: `'junction'` was set on every
  platform, so a relative POSIX directory link would come back absolute.
- **Step 3.5 (mkdir)**: `options?.recursive` does not compile on
  `Mode | MakeDirectoryOptions` (`@types/node/fs/promises.d.ts:708`).
- **Steps 4.3 and 4 Verify, Done (core→tools grep)**: `git grep` skips the
  untracked new `src/core/undo.ts`, so the gate cannot fail. This was
  reported twice.
- **Restore, the hashFile sketch**: the stream iterator yields `any`, which
  `no-unsafe-argument` rejects in `src`. The precedent is `chunk as Buffer` at
  `src/core/read.ts:111`.
- **Step 4.2 (dryRun outcomes)**: later checks depend on earlier writes
  (`remove` before `rmdir`, `rename` before `write{expect: null}`), so a
  check-only dry run gets a different answer from the real undo.
- **Step 5.3 (suffix placement)**: `replace_text` with `returnDiff` ends its
  text with a unified diff (`replace-text.ts:684`), and the suffix would land
  after it.
- **Step 7.5 (client-guide)**: the per-tool table at `:261-275` and the
  `_meta` list are not updated.

### Suspected

- **Step 3.5 (mkdir return value)**: on Windows, `fsMkdir` returns a
  `\?\C:\…` namespaced path. Settles it: run
  `node -e "require('fs').promises.mkdir(require('path').join(require('os').tmpdir(),'x'+Date.now(),'a'),{recursive:true}).then(console.log)"`
  on win32. Removed from the design either way: Step 3.5 now walks parents
  with `lstat` instead of reading the return value.

### Revision

All are fixed in the plan:

- bare dryRun → `journal.list()` (prunes);
- `'junction'` is win32 only;
- mkdir walks parents and reads no options;
- the grep uses `--untracked`;
- `chunk as Buffer`;
- dry run uses a `simulated` exists-map and leaves out `rmdir`;
- the suffix goes at the end of the first line;
- client-guide table row and `_meta` sentence added.
