# Confirmation owner implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the overwrite/delete Confirmation one owner, and close the four
gaps it hides: move and create overwrite a destination swapped while the
prompt was open, and move, create and delete fail a whole batch when a pending
entry vanishes.

**Architecture:** A new in-process module `src/core/confirmation.ts` takes the
items a call would destroy (path, identity, whether the tool's own rule needs
approval, prompt text), seals paths and identities into the request state, and
returns one verdict per path. It owns keep-pending, vanish, swap/appear
re-prompt (once) and the dropped-answer reissue. `input-required.ts` keeps the
codec, `buildInputRequired`, the answer readers and `pendingRoundTrip` (now
used by the access grant only). `delete`, `move`/`copy` and `create` supply
items and act on verdicts.

**Tech Stack:** TypeScript (Node, ESM `.ts` imports), `@modelcontextprotocol/server`,
Zod v4, Node built-in test runner.

**Spec:** the design settled in the 2026-10-27 grilling session, recorded in
§ Design below; the term is defined in `GLOSSARY.md` under **Confirmation**.
Candidate 1 of the 2026-10-27 architecture review.

## Design

Settled decisions; do not re-open them.

| Case (entry was pending in the sealed state)                         | Behavior                                                                  |
| :------------------------------------------------------------------- | :------------------------------------------------------------------------ |
| Unchanged                                                            | Read the answer as today                                                  |
| Vanished                                                             | No approval needed; the tool's own per-item result applies; rest proceeds |
| Swapped (identity differs)                                           | Re-prompt the whole pending set, once                                     |
| Appeared (pending now, not sealed)                                   | Re-prompt the whole pending set, once                                     |
| Swapped or appeared again after the re-prompt                        | Verdict `'changed'`, item refused with `CANCELLED`                        |
| Pending in sealed state, no longer needs approval by the tool's rule | Stays pending (keep-pending)                                              |
| Sealed state of the old shape (no `identities`)                      | Treated as no state: fresh round                                          |
| Sealed state of another op (e.g. `grant`)                            | Treated as no state: fresh round                                          |

- Identity = `itemType`, `dev`, `ino`, `birthtimeMs`. Delete identifies the
  entry (`lstat`); overwrite identifies the landing (`stat`).
- Scope: `delete`, `move`, `copy`, `create`. The access grant
  (`define.ts` `precheckGrant`) stays on `pendingRoundTrip`, unchanged.
- The change between the retry's plan and the syscall keeps its existing
  per-item errors (`delete` "item type changed", `move` "was created during
  confirmation", `create` "appeared after overwrite confirmation").
- Identities live only in the sealed request state, never in server memory
  (ADR-003).

## Global Constraints

- `npm run check` passes.
- `__tests__/contract.test.ts.snapshot` is unchanged; never run
  `--test-update-snapshots` for this work. No tool description changes.
- Sealed field names, verbatim: `identities`, `reprompted`.
- `'changed'` refusal texts, verbatim:
  - delete: `Delete cancelled: "${path}" was replaced again while the prompt was open.`
  - move/copy: `${VERB[op]} cancelled: destination "${destination}" was replaced again while the prompt was open.`
  - create: `create cancelled: "${path}" was replaced again while the prompt was open.`
- `confirmation does not match the requested paths` remains reachable only
  through `pendingRoundTrip` (grant).
- Do not touch the versions in `package.json`, `server.json`,
  `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`.

## Review Focus

1. **Answer keys after a vanish.** Keys are `confirm_${i}` over the sealed
   sorted list. When a sealed item vanishes, a verdict must be read by its
   index in the _sealed_ list, not the shrunk current list, or answers shift
   onto the wrong file. Task 3 table rows `vanish-first` and `vanish-last`.
2. **Retry with different arguments** (the old R9 case: confirm X, retry with
   Y). Y must be asked about, never executed unasked. Task 3 row
   `foreign-path`.
3. **A writer that keeps replacing the destination** must not stall the call:
   at most two prompts, then `'changed'`. Task 1 `move swapped twice`.
4. **A destination whose stat is refused** (not "not found") must yield a
   stable identity across rounds so it is confirmed once, not re-prompted
   forever. Task 2 `destIdentity refused` and Task 3 row `unknown-identity`.
5. **A dropped (wrapped) answer combined with a swap.** The reissue keeps the
   original identities; the swap then re-prompts. Task 4 rewrite of
   `a reissued delete confirmation refuses a replacement`.

---

### Task 0: branch and plan commit

- [ ] **Step 1:** `git switch -c refactor/confirmation-owner`
- [ ] **Step 2:** commit this plan and the `GLOSSARY.md` **Confirmation** entry
      (already in the working tree).

```bash
git add docs/superpowers/plans/2026-10-27-confirmation-owner.md GLOSSARY.md
git commit -m "docs(plan): add the confirmation owner plan and a glossary term"
```

### Task 1: red tool-level tests for the gaps

**Files:**

- Create: `__tests__/confirmation-gaps.test.ts`

**Interfaces:**

- Consumes: `createElicitationClientPair`, `createTestRoot`,
  `cleanupTestRoot`, `writeTestFile` from `__tests__/helpers.ts`. The four
  reproductions in `.claude/worktrees/wf_8523afd9-0a4-{2,3,4,5}/__tests__/`
  show the driving pattern (mutate inside the elicitation handler on the
  first prompt only).
- Produces: nothing later tasks import.

- [ ] **Step 1: Write the tests.** One `describe('Confirmation gaps')`. Each
      test mutates only when `prompts === 1` unless stated.

| Test name                                                       | Setup / handler                                                                                                       | Assertions                                                                                                                                   |
| :-------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------- |
| `move re-prompts for a destination swapped during confirmation` | `dest.txt`=`ORIGINAL`; first prompt: `rm` + write `SWAPPED`; answer `overwrite`                                       | `prompts === 2`; not `isError`; `dest.txt` = `SOURCE`                                                                                        |
| `move swapped twice refuses that destination`                   | swap on prompts 1 and 2; answer `overwrite`                                                                           | `prompts === 2`; `isError`; text matches `/replaced again while the prompt was open/`; `dest.txt` = second swap content; source still exists |
| `move proceeds when a pending destination vanishes`             | `destA`,`destB` exist; first prompt: `rm destB`; answer `overwrite`                                                   | `prompts === 1`; not `isError`; `destA` = `A`; `destB` = `B`                                                                                 |
| `copy re-prompts for a destination swapped during confirmation` | as move, `copy: true`                                                                                                 | `prompts === 2`; `dest.txt` = `SOURCE`                                                                                                       |
| `create re-prompts for a file swapped during confirmation`      | `dst.txt` exists; swap on first prompt; answer `overwrite`                                                            | `prompts === 2`; `dst.txt` = new content                                                                                                     |
| `create proceeds when a pending file vanishes`                  | `a.txt`,`b.txt` exist; first prompt: `rm b.txt`                                                                       | `prompts === 1`; not `isError`; both files hold the new content                                                                              |
| `delete proceeds when a pending directory vanishes`             | `target/child.txt`, `other/child.txt`; first prompt: rename `target` away; `ignoreIfNotExists: true`; answer `delete` | `prompts === 1`; not `isError`; `other` gone; renamed dir's `child.txt` = `original`                                                         |

- [ ] **Step 2: Run to see them fail.**

Run: `npm test -- --test-name-pattern="Confirmation gaps"`
Expected: 7 failing tests (swap ones overwrite with 1 prompt; vanish ones
report `confirmation does not match the requested paths`).

- [ ] **Step 3: Commit (red).**

```bash
git add __tests__/confirmation-gaps.test.ts
git commit -m "test: pin the confirmation swap and vanish gaps for move, copy, create, delete"
```

### Task 2: identity primitives in `fs.ts`

**Files:**

- Modify: `src/core/fs.ts:857-875` (`destExists`)
- Test: `__tests__/core-fs.test.ts` (next to `STAT-FD-006`, `STAT-FD-010`)

**Interfaces:**

- Produces (all exported from `src/core/fs.ts`):
  - `interface EntryIdentity { readonly itemType: FileType; readonly dev: number; readonly ino: number; readonly birthtimeMs: number }`
  - `function identityOf(stats: Stats): EntryIdentity` (`itemType` via `resolveEntryType`)
  - `function sameIdentity(a: EntryIdentity, b: EntryIdentity): boolean`: all four fields `===`
  - `const UNKNOWN_IDENTITY: EntryIdentity = { itemType: 'other', dev: 0, ino: 0, birthtimeMs: 0 }`
  - `function destIdentity(fs: Pick<GuardedFileSystem, 'stat'>, path: string, label: string): Promise<EntryIdentity | undefined>`
    : `undefined` where `destExists` returned `false`; `UNKNOWN_IDENTITY` where
    it logged and returned `true`; otherwise `identityOf(stats)`.
  - `destExists` keeps its signature and becomes
    `(await destIdentity(fs, path, label)) !== undefined`.

- [ ] **Step 1: Write the failing tests.**
  - `STAT-FD-011: destIdentity names the landing of an existing file`:
    `destIdentity(fs, file)` deep-equals `identityOf((await stat(file)))`
    for a real file; `itemType === 'file'`.
  - `STAT-FD-012: destIdentity refused returns UNKNOWN_IDENTITY`: reuse the
    `refusingFs` from `STAT-FD-006`; result `deepStrictEqual(UNKNOWN_IDENTITY)`.
  - `STAT-FD-013: sameIdentity compares itemType too`: same `dev/ino/birthtimeMs`,
    `itemType` `file` vs `directory` → `false`.
- [ ] **Step 2:** `npm test -- --test-name-pattern="STAT-FD-01[123]"` → FAIL (not exported).
- [ ] **Step 3:** Implement the names above in `src/core/fs.ts`.
- [ ] **Step 4:** `npm test -- --test-name-pattern="STAT-FD"` → PASS (006 and 010 unchanged).
- [ ] **Step 5: Commit.**

```bash
git add src/core/fs.ts __tests__/core-fs.test.ts
git commit -m "feat(fs): name an entry's identity and a destination's identity"
```

### Task 3: the Confirmation module

**Files:**

- Create: `src/core/confirmation.ts`
- Modify: `src/core/input-required.ts:39-65` (state types), `:189-197`
  (`buildInputRequired` mint), `:201-221` (`pendingRoundTrip` opts and doc),
  `:258` (`assertCanElicit` → exported), `:398-413` (`readPendingVerdict` removed)
- Test: Create `__tests__/confirmation.test.ts`; Modify
  `__tests__/input-required.test.ts:203-232` (rename to `identities`)

**Interfaces:**

- Consumes: `EntryIdentity`, `sameIdentity` (Task 2).
- Produces, in `src/core/input-required.ts`:
  - `interface SealedIdentity extends EntryIdentity { readonly path: string }`
    replaces `PendingDeleteIdentity`.
  - `PendingState` gains `identities?: readonly SealedIdentity[]` and
    `reprompted?: true` (sealed, like `reissued`); `deleteIdentities` is gone.
    `buildInputRequired` mints both when present.
  - `PendingRoundTripOpts` loses `deleteIdentities`.
  - `export function assertCanElicit(op: PendingOp, capabilities: ClientCapabilities | undefined): void`
- Produces, in `src/core/confirmation.ts`:
  - `type ConfirmOp = 'delete' | 'move' | 'copy' | 'create'`
  - `interface ConfirmItem { readonly path: string; readonly identity: EntryIdentity; readonly required: boolean; readonly message: string }`
  - `type Verdict = 'proceed' | 'skipped' | 'changed' | { readonly refused: string }`
  - `interface Confirmed { verdict(path: string): Verdict }`: a path not
    pending (or not among the items) answers `'proceed'`.
  - `function confirm(ctx: PendingCtx, op: ConfirmOp, acceptChoice: 'delete' | 'overwrite', items: readonly ConfirmItem[]): Promise<InputRequiredResult | Confirmed>`
    : callers discriminate with `isInputRequiredResult`.

Algorithm (the signature does not determine it):

```text
sealed  = state where state.op === op && state.identities !== undefined, else none
pending = items where required || sealed lists item.path      (keep-pending)
          sorted by path
if pending is empty                        -> Confirmed, all 'proceed'
if no sealed                               -> assertCanElicit; mint round
                                              {op, paths, identities}
changed = pending items not in sealed, or whose identity differs from sealed
if changed nonempty and !sealed.reprompted -> mint round {op, paths, identities,
                                              reprompted: true}
if !sealed.reissued and a dropped key belongs to a pending item
                                           -> mint {...sealed, reissued: true}
verdict(item in changed)   = 'changed'
verdict(other pending item)= read choice at confirmKey(sealed.paths.indexOf(path)):
                             acceptChoice -> 'proceed', 'skip' -> 'skipped',
                             else { refused: describeRefusal(ctx, key) }
```

Every minted round offers `choices: [acceptChoice, 'skip']`, keys
`confirmKey(i)` over the sorted pending list, `message` from the item.

- [ ] **Step 1: Write the failing table test** in `__tests__/confirmation.test.ts`.
      Drive rounds in-process: call `confirm` with a `PendingCtx` built on the
      existing `bindContext()` pattern from `input-required.test.ts`; decode a
      returned round with `requestStateCodec.verify(result.requestState, bindContext())`
      and feed it back as `requestState: () => state` with `inputResponses`.
      Identities are literals (`{ itemType: 'file', dev: 1, ino: N, birthtimeMs: 1 }`).

| Row                    | Round 2 input                                                               | Expected                                                                        |
| :--------------------- | :-------------------------------------------------------------------------- | :------------------------------------------------------------------------------ |
| `nothing-required`     | no state, items all `required: false`                                       | `Confirmed`; every verdict `'proceed'`                                          |
| `first-round`          | no state, `b`,`a` required                                                  | input_required; sealed `paths` `['a','b']`, `identities` match, no `reprompted` |
| `accepted`             | sealed `[a]`, same identity, `confirm_0` accept `overwrite`                 | `a` → `'proceed'`                                                               |
| `skipped` / `declined` | `confirm_0` `skip` / `decline`                                              | `'skipped'` / `{ refused: 'declined by the user' }`                             |
| `vanish-first`         | sealed `[a,b]`; items `[b]`; `confirm_0`=`skip`, `confirm_1`=`overwrite`    | `b` → `'proceed'`                                                               |
| `vanish-last`          | sealed `[a,b]`; items `[a]`; `confirm_0`=`skip`, `confirm_1`=`overwrite`    | `a` → `'skipped'`                                                               |
| `vanish-all`           | sealed `[a]`; items `[]`                                                    | `Confirmed`                                                                     |
| `swap`                 | sealed `[a]` ino 1; item `a` ino 2                                          | input_required; `reprompted: true`; sealed ino 2                                |
| `appear`               | sealed `[a]`; items `a`,`b` required                                        | input_required; `reprompted: true`; paths `['a','b']`                           |
| `foreign-path`         | sealed `[a]`; items `[b]`                                                   | input_required (never `'proceed'` for `b`)                                      |
| `swap-after-reprompt`  | sealed `[a,b]` `reprompted`; `a` ino changed; both answered accept          | `a` → `'changed'`, `b` → `'proceed'`                                            |
| `keep-pending`         | sealed `[a]`; item `a` `required: false`, same identity; `confirm_0`=`skip` | `a` → `'skipped'`                                                               |
| `old-shape`            | state `{op:'delete', paths:['a']}` without `identities`                     | input_required, no `reprompted`                                                 |
| `foreign-op`           | state `{op:'grant', ...}`                                                   | input_required                                                                  |
| `dropped-answer`       | sealed `[a]`, `droppedInputResponseKeys: ['confirm_0']`                     | input_required with `reissued: true` and the sealed identities                  |
| `unknown-identity`     | sealed `[a]` with `UNKNOWN_IDENTITY`; item `a` same; accept                 | `'proceed'`                                                                     |

- [ ] **Step 2:** `node --test __tests__/confirmation.test.ts` → fails: the
      module does not exist.
- [ ] **Step 3:** Implement `src/core/confirmation.ts` and the
      `input-required.ts` changes above. Rename `deleteIdentities` →
      `identities` in `input-required.test.ts:203-232` (types and assertions only).
      `readPendingVerdict` leaves `input-required.ts`; its logic is
      `confirmation.ts`'s private reader.
- [ ] **Step 4:** `node --test __tests__/confirmation.test.ts` → PASS. Run
      only this file: the tools still import removed names until Task 4, so any
      test that boots a server fails to load.
- [ ] **Step 5: Commit** together with Task 4 (the tree does not type-check
      between them). Do not commit here.

### Task 4: wire `delete`, `move`/`copy`, `create`

**Files:**

- Modify: `src/tools/delete.ts:20-41` (imports, local `sameIdentity` removed),
  `:169-259` (`finalizeDeletion`, `executePlan`), `:279-369` (`handleDelete`:
  `previouslyPendingPaths`, keep-pending line and `pendingRoundTrip` replaced)
- Modify: `src/tools/move.ts:18-21` (imports), `:161-175` (`planTransfer`),
  `:185-217` (`executeTransfer`), `:364-397` (`runTransfers`)
- Modify: `src/tools/create.ts:16-17` (imports), `:143-184` (phase 1 and
  round), `:206-218` (verdict)
- Modify tests whose pinned behavior changes:
  - `__tests__/guards.test.ts:35` GUARD-001 → retitle `GUARD-001: a destination
that appears during confirmation is asked about again`; handler writes
    `destB` on the first prompt only; assert `calls === 2`, not `isError`,
    `destA` = `A`, `destB` = `B`.
  - `__tests__/mutation-regressions.test.ts:162` loop → retitle
    `delete re-plans when confirmation paths change: ${change}`.
    `remove pending directory`: not `isError`; `other` and `unrelated` gone;
    `original/child.txt` = `original`. `add pending directory`: handler acts
    on prompt 1 only; `prompts === 2`; all three paths gone.
  - `__tests__/mutation-regressions.test.ts:91` loop → handler swaps on
    prompt 1 only; `prompts === 2`; `skip` keeps the replacement and reports
    `{ deleted: false }`; `delete` removes the replacement (it was
    re-confirmed); `original/child.txt` = `original` in both.
  - `__tests__/input-required.test.ts:620` loop → each of `legacy`, `empty`,
    `wrong path` answers `resultType === 'input_required'`; `dir` still exists.
  - `__tests__/input-required.test.ts:673` `replace` branch → third call
    answers `resultType === 'input_required'`; replacement intact.

**Interfaces:**

- Consumes: `confirm`, `Confirmed`, `Verdict`, `ConfirmItem` (Task 3);
  `identityOf`, `sameIdentity`, `destIdentity`, `destExists`,
  `EntryIdentity` (Task 2).
- Produces: nothing new.

Wiring rules:

- **delete:** items = every plan, `{ path: validPath, identity:
identityOf(firstStats.stats), required: plan.pending, message: \`Delete
  "${p}" and all its contents?\` }`; call `confirm`whenever`plans.length > 0`.
`executePlan`takes`Confirmed`and switches on`verdict(validPath)`.
`finalizeDeletion`compares`sameIdentity(identityOf(first), identityOf(current))`and keeps its`'other'` exemption and message.
- **move/copy:** `TransferPlan` gains `destIdentity: EntryIdentity | undefined`
  from `destIdentity(fs, validDest, op)` (skipped for a respelling);
  `destExistedOriginally = destIdentity !== undefined`. Items = `overwrite ?
[] : safe` plans with a `destIdentity`, `required: plan.pending`, existing
  message text. `executeTransfer` takes `Confirmed`.
- **create:** phase 1 keeps `{ validPath, identity }` per requested path
  (from `destIdentity`); items deduplicated by `validPath`, `required: true`.
  Replace the comment at `:147-148` with one line: a file that appears
  between rounds is asked about again on the retry.
- `'changed'` maps to `FsError(ErrorCode.CANCELLED, <text from Global
Constraints>)` in each tool.

- [ ] **Step 1:** Rewrite the five pinned tests above.
- [ ] **Step 2:** Wire the three tools.
- [ ] **Step 3:** `npm test -- --test-name-pattern="Confirmation|GUARD|mutation|input-required|delete|move|create"`
      → PASS, including all of Task 1.
- [ ] **Step 4:** `grep -rn "readPendingVerdict\|deleteIdentities\|PendingDeleteIdentity\|previouslyPendingPaths" src __tests__` → no hits.
- [ ] **Step 5: Commit Tasks 3 and 4.**

```bash
git add src/core/confirmation.ts src/core/input-required.ts src/tools/delete.ts src/tools/move.ts src/tools/create.ts __tests__/confirmation.test.ts __tests__/input-required.test.ts __tests__/guards.test.ts __tests__/mutation-regressions.test.ts
git commit -m "refactor(core): give the overwrite/delete Confirmation one owner"
```

### Task 5: changelog and full check

**Files:**

- Modify: `CHANGELOG.md` (new `## [Unreleased]` above `## [2.11.0]`)

- [ ] **Step 1:** Add under `### Security`:
  - `move`, `copy` and `create` ask again when an existing destination is
    replaced while the overwrite prompt is open, instead of overwriting the
    replacement; a second replacement refuses that entry.
  - `delete` asks again for a replaced directory instead of failing it.

  Under `### Fixed`:
  - A pending entry that disappears while the prompt is open no longer fails
    the whole `move`, `copy`, `create` or `delete` call; that entry gets its
    own result and the rest proceeds.
  - A destination or directory that becomes pending while the prompt is open
    is asked about again instead of failing the whole call.

- [ ] **Step 2:** `npm run build && npm run check` → exit 0; contract snapshot
      unchanged (`git status` shows no `.snapshot` diff).
- [ ] **Step 3: Commit.**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): note confirmation re-prompts and vanished entries"
```
