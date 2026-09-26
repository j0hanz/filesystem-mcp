# Run: One owner builds a written file's metadata, and edit's dry run reports the right size

Executing [`written-file-meta.plan.md`](written-file-meta.plan.md), started 2026-09-26 at `89b2a8f5`.

- **0** 2026-09-26 — drift check empty. Known deviation carried from
  [`written-file-meta.plan-hunt.md`](written-file-meta.plan-hunt.md): Current
  state cites `patch.ts:34`, text is at
  [`patch.ts:33`](../../../src/tools/patch.ts#L33); `patch.ts` not flagged by
  drift, so no STOP.
- **1** 2026-09-26 — done. Red: `actual: 62, expected: 11`. Green:
  `node --test --test-name-pattern="put the preview diff" __tests__/tools.test.ts`
  → pass 1, fail 0. Commit `76ffa0c6`.
- **2** 2026-09-26 — done. `npm run build` → exit 0; `npm run type-check:test`
  → exit 0; `TC-FUNC-054` → pass 1; edit/replace_text pattern → pass 19,
  fail 0. Commit `a91d0548`.
- **3** 2026-09-26 — done. `npm run build` → exit 0; `create|append` → pass
  21, fail 0; `npx knip` → exit 0. Deviation: `prettier --check` flagged
  `create.ts` and `file-uri.ts` after the edits (re-wrapping only);
  `prettier --write` on those two files, no logic change. Commit `e247cc52`.
- **4** 2026-09-26 — done. Red: `resourceUri` was
  `filesystem-mcp://file/…/patch_dry.txt`. Green: `patch dryRun advertises`
  → pass 1; `patch` pattern → pass 5, fail 0. Commit `2fcabde6`.
- **5** 2026-09-26 — done. `npm run check` → exit 0 (433 tests: 430 pass,
  3 skipped, 0 fail). Commit `9e29d0ca`.

## Done

- [x] `npm run check` → exit 0.
- [x] `put the preview diff|patch dryRun advertises|TC-FUNC-054` → pass 4,
  fail 0.
- [x] `git grep -n "buildWrittenFileMeta(" -- src` → declaration at
  `file-uri.ts:124` plus five object-form calls (`create.ts:264`,
  `edit.ts:421`, `edit.ts:458`, `patch.ts:155`, `replace-text.ts:588`).
- [x] `git grep -n "getMaxTextFileSize()" -- src/tools/create.ts` → only
  `create.ts:36` (input schema; plan said ~41, line shifted by the import
  change).
- [x] `git status` → only `docs/plan/2026-09-26-written-file-meta/`
  untracked; no modified file outside the in-scope list.

Source delta: `src` +76 −56 (net +20). The object-form calls wrap to 4–5
lines each and the two new doc comments add lines, so the refactor is not a
net line deletion in `src`, although it removes the duplicated rules.

## Review fixes

- 2026-09-26 — applied the bug-hunt Confirmed finding and both qc blocking
  items in one commit, `6a50bc9e`:
  `WrittenFileMeta` field docs point at `writtenFileLinks`; `patch` and `edit`
  output schemas say `resourceUri` is omitted on dryRun or over the cap
  (`edit`'s old text claimed "omitted when no edit matched", which the code
  never did); `edit` builds metadata once with `dryRun: options.dryRun`.
  `npm run check` → exit 0 (433 tests: 430 pass, 3 skipped, 0 fail). `src`
  delta against `89b2a8f5` now +106 −92 (net +14).
