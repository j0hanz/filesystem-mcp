# Hunt: cut the 22 verified over-engineering residues left by the 2026-09-09 audit

Hunted [`overeng-residue-2.run.md`](overeng-residue-2.run.md) on 2026-09-09, against the uncommitted working tree (base `f7e47a1d`). Scope: 22 changed files, ~9,900 lines.

## Confirmed

None.

## Suspected

None.

## Tells settled

- [`path.ts:226-233`](../../../src/core/path.ts#L226-L233) — brief flagged `UNAWAITED const result = this.#mutex.then(fn, fn)`. Dismissed: `runExclusive` returns `result`, which every caller awaits (`applyGrant` at [`path.ts:395`](../../../src/core/path.ts#L395)); the `this.#mutex` reassignment is the lock-chain tail, deliberately `then(noop, noop)` so the chain never rejects and the next holder always runs. Pattern pre-dates this refactor (steps 1-3 touched `expandAllowedDirectories` and `options`, not `runExclusive`).
- [`replace-in-files.ts:67`](../../../src/tools/replace-in-files.ts#L67), [`replace-in-files.ts:74`](../../../src/tools/replace-in-files.ts#L74), [`search-content.ts:84`](../../../src/tools/search-content.ts#L84) — brief flagged three `.meta({ examples: [...] })` MARKERs. Dismissed: Zod `.examples()` on schema literals, documenting sample inputs for the client; pre-existing, untouched by steps 8-9 (which changed matcher plumbing, not schemas).
- [`__tests__/tools.test.ts:1349`](../../../__tests__/tools.test.ts#L1349) — asserts `truncated === undefined` on a paged search while `__tests__/tools.test.ts:1452` asserts `truncated === true` at the engine cap. Checked deliberately against step 5 (which cut `truncated` from the **read** path only, gate scoped to `core/read.ts` + `core-fs.test.ts`): the search paths keep their own `truncated`, and the two asserts describe different states (paging vs. engine cap). Not a residue of this refactor.

## Why the hunt came back empty

The change is 22 verified deletions of unreachable code — every cut was gated by a grep proving no caller remained, and the suite (276 pass, 0 fail) exercises every surviving contract. Nothing was rewritten, only removed; no signature that survived lost a field, and no behavior that survived lost a branch.

## Coverage

Read in full during this hunt: [`src/core/path.ts`](../../../src/core/path.ts), [`src/cli.ts`](../../../src/cli.ts), [`src/prompts.ts`](../../../src/prompts.ts), [`src/core/store.ts`](../../../src/core/store.ts), [`src/core/input-required.ts`](../../../src/core/input-required.ts), [`src/core/errors.ts`](../../../src/core/errors.ts), [`src/core/path-completer.ts`](../../../src/core/path-completer.ts), [`src/core/read.ts`](../../../src/core/read.ts), [`src/core/search.ts`](../../../src/core/search.ts), [`src/core/fs.ts`](../../../src/core/fs.ts), [`src/core/sensitive.ts`](../../../src/core/sensitive.ts), [`src/tools/read.ts`](../../../src/tools/read.ts), [`src/tools/search-content.ts`](../../../src/tools/search-content.ts), [`src/tools/search-files.ts`](../../../src/tools/search-files.ts), [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts), [`src/tools/define.ts`](../../../src/tools/define.ts), [`src/tools/edit.ts`](../../../src/tools/edit.ts), [`src/tools/move.ts`](../../../src/tools/move.ts), [`src/index.ts`](../../../src/index.ts), [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts), [`__tests__/core-fs.test.ts`](../../../__tests__/core-fs.test.ts).

Read earlier in the same effort (unchanged since, full content in context): [`src/transport/http-policy.ts`](../../../src/transport/http-policy.ts) — comment-only change, low attack surface, judged on that read.

Blast radius pulled in but not audited end to end (read only far enough to judge the changed contract): callers of `readFile`/`readEditableText` in [`src/core/fs.ts`](../../../src/core/fs.ts) and the tool layer; `FsError` readers via `error.code` (kept, `get path()` removal pre-checked against every `.path` receiver); `ResourceStore.putText`/`putJsonResource` callers; `toToolCtx` call sites in the tool registry.

Third-party behavior taken on trust: the SDK's `safeParse` never throwing (contract documented at [`src/core/errors.ts:241-246`](../../../src/core/errors.ts#L241-L246)); Zod `.meta()`/`.examples()` not affecting runtime validation; Node `fs/promises` error shapes (`ENOENT`/`EACCES`/`ELOOP`) matching `SKIPPABLE_ERRNOS`.

Security pass: applied to the attack-surface files in scope — `path.ts` (grant round-trip, boundary checks), `path-completer.ts` (untrusted completion input), `input-required.ts` (HMAC-sealed request state), `errors.ts` (error classification), `prompts.ts` (client-supplied topic arg, `Object.hasOwn`-gated). No injection, traversal, secret-exposure, or fail-open path introduced by the deletions; the deleted code was defensive residue, never a guard.