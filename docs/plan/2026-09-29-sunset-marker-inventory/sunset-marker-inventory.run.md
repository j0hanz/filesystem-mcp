# Run: Make the `sunset(SEP-2577)` grep enumerate every legacy-only site

Executing [sunset-marker-inventory.plan.md](sunset-marker-inventory.plan.md),
started 2026-09-29 at `38e8b88e`.

**Orientation:** the drift command returned no changed paths; `git status`
showed only this effort's untracked directory. The pre-step marker grep
returned exactly the three lines the plan lists. Starting at Step 1.

## Steps

- **1** 2026-09-29 - done. One comment line inserted inside the existing
  block above `const legacyHttp`. Grep returned 4 lines including
  `src/server.ts:88`.
- **2** 2026-09-29 - done. One comment line inserted between `activeCtx = c;`
  and `if (era === 'legacy') {`. Grep returned 5 lines including
  `src/transport/stdio.ts:61` (unchanged) and `src/transport/stdio.ts:147`.
- **3** 2026-09-29 - done. `eslint` on both files exited 0 with no output;
  `prettier --check` on both reported clean.
- **4** 2026-09-29 - done. Amendment bullet appended after the
  "must be revisited" bullet; wording matches the plan's target shape.
  `prettier --check docs/adr` clean; `git grep -c "Amended 2026-09-29"`
  returned 1.
- **5** 2026-09-29 - done. `npm run check:static` exited 0 (build, test
  typecheck, lint, prettier, knip). `git status --short` shows exactly the
  three in-scope modified paths plus this effort's untracked directory.

## Done

- [x] `git grep -n "sunset(SEP-2577)" -- src` prints exactly 5 lines:
      `resources.ts:490`, `server.ts:88`, `define.ts:176`, `stdio.ts:61`,
      `stdio.ts:147`.
- [x] `git diff --stat -- src` shows `1 +` for each of the two source files,
      no deletions.
- [x] `npm run check:static` exits 0.
- [x] No modified tracked file outside the three in-scope paths.
- [x] `git diff --stat -- __tests__` is empty; `npm test` not required.

**Deviations:** none.

**Review points:** marker string is byte-identical to the three pre-existing
sites; the `server.ts` marker sits inside the comment block, not after the
`const`. The `legacyHttp` predicate still reads identically in `server.ts:88`
and `resources.ts:491`, so the amendment's "deliberately spelled twice"
sentence holds.

**Not done by this run:** commits, pushes, version changes, plan edits.
