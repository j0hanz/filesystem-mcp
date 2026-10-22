# Hunt 2026-10-22 — uncommitted working-tree changes on `feat/undo-tool` (undo tool), 15 files, 10334 lines

Verdict: `undo {"steps": N}` over HTTP reverts any caller's last N calls on the
endpoint-shared journal — the one guard the tool has exempts `steps`.

## Confirmed

- Major — [`src/tools/undo.ts:52`](../../../src/tools/undo.ts#L52) — the HTTP guard
  only rejects the bare form (`id === undefined && steps === undefined && !dryRun`),
  so `{"steps": N}` over HTTP reaches `journal.newest(N)` on the journal shared by
  every caller of the endpoint, while the published schema (line 21, snapshotted
  in `__tests__/contract.test.ts.snapshot:844`) says "Revert the last N calls
  (not over HTTP)". Trigger: HTTP client sends `undo {"steps": 1}`. Impact:
  cross-caller state reversal the id-required rule exists to prevent, plus
  contract drift. Ruled out: refuter traced every layer — the schema has
  "no refine or transport awareness", `newest(n)` is transport-blind
  (`src/core/undo.ts:93-96` `return [...this.#byId.values()].reverse().slice(0, n);`),
  http-policy.ts holds only binding/host/auth policy, and the only test is
  `__tests__/undo.test.ts:810` (`call(harness.client, 'undo', {})` — the both-absent
  case). Fix: add a `steps !== undefined` arm to the HTTP guard (or fix the
  description; the shared-journal design says reject).
- Major — [`src/core/undo.ts:178`](../../../src/core/undo.ts#L178) — `simulated` is
  per-entry, so a `steps: N` dry run previews each entry against current disk,
  ignoring what reverting the newer entries would change. Trigger: call1 deletes
  F, call2 re-creates F, then `undo {"steps": 2, "dryRun": true}` — dry run says
  SKIPPED, the real run restores. Impact: the "Preview which calls would restore"
  promise is only accurate for `steps: 1` / single ids. Ruled out: refuter traced
  the loop — `restoreEntry` is called once per entry with no state passed between
  iterations (`src/tools/undo.ts:83`), and the comment at `src/tools/undo.ts:76-78`
  ("once the later writes are gone") states the invariant the dry run cannot
  satisfy; the only parity test is single-entry (`__tests__/undo.test.ts:460`).
  Fix: thread one `simulated` map across the entries loop (pass it through opts
  or hoist the loop into `restoreEntry`).
- Major — [`src/core/fs.ts:391`](../../../src/core/fs.ts#L391) — writeFile onto an
  existing non-regular entry (FIFO, socket) records `{op: 'remove'}`, so undo
  deletes the replacement regular file, reports `restored: true`, and the original
  entry is gone. Trigger: `create` with `overwrite: true` onto a FIFO — reachable:
  PathGuard never stats entry type, `destExists` treats a FIFO as ordinary,
  overwrite:true skips every recheck (`src/tools/create.ts:157`, `:234-236`,
  `:246`), and the temp+rename commit replaces any entry type on POSIX.
  Impact: data loss with a false "restored" report; `appendFile` guards this with
  `assertFileStats` (`src/core/fs.ts:418`), writeFile does not. Ruled out: refuter
  checked every other writeFile caller — edit/patch/replace-text all route through
  `readFileWithStats` which throws NOT_FILE (`src/core/read.ts:528-530`), so
  create is the one unguarded path. Fix: in writeFile's capture, abandon when the
  existing entry is neither absent nor a regular file
  (`capture.abandon('cannot capture a non-regular file')`) — or push no remove
  record for that case.
- Minor — [`src/core/fs.ts:591`](../../../src/core/fs.ts#L591) — on Windows,
  `#snapshotTree` types a directory symlink/junction whose target is currently
  missing as `'file'`: the follow-stat (`fsStat`, line 18 import) rejects with
  ENOENT, `.catch(() => false)` fires, and restore calls
  `fs.symlink(record.target, record.path, 'file')` (`src/core/undo.ts:281`) —
  a file-flavored reparse point for what was a directory link. Trigger: Windows,
  delete a dir symlink whose target was removed first, then undo. Impact: link
  not restored as it was. Ruled out: refuter grepped all of `src/` for `junction`
  — no lstat-based or reparse-tag directory detection exists anywhere; tests only
  exercise `'file'` links to existing files. Fix: on win32, fall back to
  `'junction'` when the follow-stat fails (or abandon the capture for an
  ambiguous link).
- Minor — [`__tests__/undo.test.ts:187`](../../../__tests__/undo.test.ts#L187) —
  `t.skip()` inside the trySymlink callback does not stop the body (node:test
  docs: "Calling `skip()` does not terminate execution of the test function";
  runner source reports a post-skip assertion as failed, not skipped). Without
  symlink privilege the later `assert.ok(ops.includes('symlink'))` (line 200)
  fails the test the guard was written to skip. Ruled out: refuter confirmed
  `trySymlink` returns false without throwing (`__tests__/helpers.ts:71-72`)
  and the repo's own convention guards it — `__tests__/tools.test.ts:498-504`
  `if (!(await trySymlink(...))) { return; }`. Fix: same guard pattern here.
- Minor — [`__tests__/undo.test.ts:347`](../../../__tests__/undo.test.ts#L347) —
  same skip-without-return in 'a deleted tree comes back with bytes, mode,
  symlink and subdirectory': the body continues to `readlink` at :368 against a
  link never created — ENOENT fails the "skipped" test. Ruled out: same refuter
  trace; sibling correct pattern at `__tests__/tools.test.ts:3370-3371`. Fix:
  `if (!(await trySymlink(...))) return;`.
- Minor — [`__tests__/undo.test.ts:240`](../../../__tests__/undo.test.ts#L240) —
  'POSIX only: overwriting a 0o200 file succeeds and abandons' has no root guard:
  as root the 0o200 read succeeds, `cap.unavailable` stays undefined, and the
  assert at :251 fails (leaving the file 0o200, since the 0o644 chmod at :252
  never runs). Ruled out: refuter grepped `getuid` across `__tests__` — only
  `guards.test.ts:291` and `tools.test.ts:772` have guards, never undo.test.ts;
  no before/after hook gates on root. Fix: add the sibling's
  `if (process.getuid?.() === 0) return t.skip('root bypasses the 0200 mode bits');`
  (`__tests__/tools.test.ts:772`).
- Minor (dormant) — [`src/tools/define.ts:495`](../../../src/tools/define.ts#L495)
  — `#undoSuffix` can run twice for one call: success path mints the id at :495,
  and any throw in `buildSuccessResponse`/`refuseOversized`/`completeProgress`
  lands in the catch at :505 which mints again — duplicate journal entries and a
  broken call-order invariant (`src/core/undo.ts:48` "nothing ever re-inserts").
  Not reachable today: refuseOversized returns early for captured mutating calls
  (`if (!this.def.readOnlyHint && !dryRun) return;`), progressDone exists only on
  read-only tools, and no shipped tool emits non-serializable structured — the
  sole candidate thrower is `JSON.stringify` in buildSuccessResponse. Fix: memoize
  the mint (a `#undoId` field set once) or move the add out of the retry window.

## Suspected

None.

## Questions

- [`src/tools/undo.ts:21`](../../../src/tools/undo.ts#L21) — which side is
  intended for `steps` over HTTP: reject it like the bare form, or drop
  "(not over HTTP)" from the description and accept cross-caller revert? The
  shared-journal design says reject; either way the contract snapshot changes.

## Dismissed

- [`src/core/undo.ts:231`](../../../src/core/undo.ts#L231) — write-restore drops
  `record.mode` on the `expect !== null` branch. Killed: the restore write routes
  through GuardedFileSystem.writeFile, whose carry makes the option dead —
  `src/core/fs.ts:348` `const mode = existingMode ?? options.mode;` — and in that
  branch the file was just verified to exist, so `existingMode` is always defined;
  the spec table (`undo-tool.plan.md:159-160`) prescribes exactly this asymmetry.
- [`src/core/fs.ts:549`](../../../src/core/fs.ts#L549) — failed rm still journaled;
  undo reports `restored: true` for never-deleted directories. Killed: the
  pre-call push is the documented recovery design — `src/core/fs.ts:546-548`
  "// Undo capture: the tree snapshot is pushed BEFORE the raw call — a
  // recursive rm can fail halfway with files already gone." — and the
  done-if-directory branch is the specified idempotence (plan :163 "done if
  already a directory, else skip"). Residual nit: the record comment at
  `src/core/undo.ts:21` ("only if `path` is absent") understates it.
- [`src/core/undo.ts:315`](../../../src/core/undo.ts#L315) — rename restore
  `mkdir -p` resurrects deleted parents. Killed: the plan prescribes the exact
  step (:165 "`fs.mkdir(dirname(from), {recursive: true})`, then `fs.rename(to, from)`"),
  `dirname(record.from)` existed pre-call by construction, `mkdir {recursive}` is
  a no-op when the parent exists, and the throw path gets a result row plus a
  retryable record (`src/core/undo.ts:189-192` fail()).
- [`__tests__/tools.test.ts:789`](../../../__tests__/tools.test.ts#L789) — chmod
  restore not in finally. Killed: the suite `after` hook runs regardless of
  assertion failure (`__tests__/tools.test.ts:47-54`), cleanup is
  `rm(dir, { recursive: true, force: true })` (`__tests__/helpers.ts:51-53`),
  unlink needs only directory write, and the filename is unique in the file.
- [`__tests__/undo.test.ts:197`](../../../__tests__/undo.test.ts#L197) — post-order
  assertion gap. Killed: the restore test at :343 pins the order transitively — a
  pre-order snapshot makes `mkdir(tree)` replay first against an absent parent
  (options-less mkdir is non-recursive), so `:364` readFile and `:370`
  `remaining, []` fail in every readdir order.
- [`__tests__/undo.test.ts:460`](../../../__tests__/undo.test.ts#L460) — dry-run
  test name promises parity the code doesn't deliver. Killed: the spec defines
  the test with the carve-out (`undo-tool.plan.md:632-636` "the same per-path
  outcomes as the real restore, `rmdir` records excepted"), mirrored in code at
  `src/core/undo.ts:253` `if (dryRun) break; // emptiness depends on writes the
  dry run did not make`. Name trims the qualifier; wording nit only.
- [`__tests__/helpers.ts:357`](../../../__tests__/helpers.ts#L357) — `TEST_API_KEY`
  tell: synthetic example-pattern bearer key for the loopback test server only;
  not a real credential, no exposure.
- [`__tests__/tools.test.ts:380`](../../../__tests__/tools.test.ts#L380) — `token`
  tell: sentinel needle string planted in fixtures for redaction assertions;
  not a credential.

## Coverage

- Read fully: all 15 changed code files — `src/core/fs.ts`, `src/core/undo.ts`,
  `src/core/util.ts`, `src/core/errors.ts`, `src/tools/define.ts`,
  `src/tools/read.ts`, `src/tools/delete.ts`, `src/tools/undo.ts`,
  `src/tools/index.ts`, `src/transport/http.ts`, `src/server.ts`,
  `src/cli-help.ts`, `__tests__/tools.test.ts`, `__tests__/undo.test.ts`,
  `__tests__/helpers.ts` (12 src by reader A; 3 test files by reader B;
  `src/core/undo.ts` and `src/tools/undo.ts` also read by the hunter).
- Blast radius pulled in (contract windows only): `src/core/path.ts`,
  `src/core/read.ts`, `src/tools/create.ts`, `src/tools/move.ts`,
  `src/tools/edit.ts`, `src/tools/patch.ts`, `src/tools/replace-text.ts`,
  `src/tools/find-files.ts`, `src/tools/search-text.ts`, `src/tools/batch.ts`,
  `src/core/store.ts`, `src/core/watcher-registry.ts`,
  `src/transport/http-policy.ts`, `src/core/input-required.ts`.
  `src/core/file-uri.ts`, `src/resources.ts`, `src/cli.ts` checked via diff:
  `util.ts` changes are purely additive (`sha256Hex`, `getMaxUndoBytes`,
  `isMissing`), so those callers are unaffected.
- Not audited, and why: the 10 files the brief skipped as non-code or docs —
  `CHANGELOG.md`, `CONTRIBUTING.md`, `README.md`,
  `__tests__/contract.test.ts.snapshot`, `docs/client-guide.md`,
  `docs/configuration.md`, `mcpb/manifest.json`, and the three
  `docs/plan/2026-10-22-undo-tool/*.md` docs — prose and manifest text, not
  executable; `.claude/worktrees/**` entries in the blast-radius list excluded
  as worktree duplicates.
- Taken on trust: Node's Windows behavior of `fs.symlink` with an explicit
  `'file'` type on a directory target — traced from Node docs and reparse-tag
  semantics, not executed; node:test skip semantics verified by the refuter
  against the Node v24 docs and runner source.