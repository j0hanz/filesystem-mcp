# Run: Restore the registrar boundary and remove two internal forwarding layers

Executing [arch-audit-seams.plan.md](arch-audit-seams.plan.md), started
2026-09-28 at `b2a6fac5`.

**Orientation:** the plan's drift command returned no changed paths. The
working tree contained only this effort's untracked planning artifacts;
there was no existing run log. Starting at Step 1.

**Confirmed seams before testing:** ESLint's `lintText` API with the repository
configuration (registrar restrictions and permitted controls); MCP edit/stat
calls in both public input modes; the guarded filesystem write method's
existing commit/cancellation assertions. There are no requirement IDs.

## Steps

- **1** 2026-09-28 - done. The prescribed narrow run first failed exactly
  the three `.ts` registrar cases (0 restrictions instead of 1), then passed
  all 45 selected tests including all 13 boundary cases after the regex fix.
  `npm run build && npm run type-check:test` exited 0.
- **2** 2026-09-28 - done. Both edit and stat input modes execute in their
  existing cases; edit content resets before each call. The prescribed
  narrow run passed 45 tests. `npm run build && npm run type-check:test`
  exited 0. Mixed append/overwrite characterization remains unchanged.
- **3** 2026-09-28 - done. The executor receives original string/file items;
  all four callers switched together without casts or compatibility wrappers.
  `npm run build && npm run type-check:test` exited 0. The prescribed
  tool/filesystem/concurrency run reported 150 tests: 148 passed, two existing
  platform skips, zero failures.
- **4** 2026-09-28 - done. The private atomic-write body moved into the
  existing method; the shared resolver and diagnostic text remain. The
  append comment now names the method. Types passed; the prescribed focused
  run again reported 148 passed, two existing platform skips, zero failures,
  including both before/after-rename cancellation cases.
- **5** 2026-09-28 - done. Scoped Prettier formatting completed. The exact
  deletion groups passed at **-34 lines** (batch plus characterization) and
  **-9 lines** (filesystem). `git diff --check` exited 0.
  `npm run check` passed all static gates and reported 450 tests:
  447 passed, three existing platform skips, zero failures.

## Done

- [x] All 13 boundary cases ran and passed; the three missing `.ts`
  restrictions were observed red before the fix.
- [x] Both public modes execute in the existing edit and stat cases; the
  prescribed narrow and full-suite commands passed them.
- [x] A Node assertion check confirmed original-item dispatch and absence of
  the old batch envelope type, normalizer, and optional override.
- [x] A TypeScript AST/body comparison against `b2a6fac5` confirmed the moved
  atomic-write body is identical apart from indentation and the explicit
  `this.pathGuard` substitution. The private declaration is absent; the
  only remaining helper-name occurrence is the preserved diagnostic prefix.
- [x] Both independent deletion groups passed after formatting: -34 and -9.
- [x] `npm run check` and `git diff --check` exited 0.
- [x] A parsed `git status --porcelain=v1 --untracked-files=all` inventory
  matched exactly the nine implementation files plus this effort's records.
- [x] No commits, pushes, dependency changes, version changes, or plan edits.

**Deviations:** none. The new regression also rejects ignored virtual
fixtures explicitly, as required by the plan's parser/fixture guard.

**Review points:** original item payloads must reach callbacks unchanged;
rename remains the write commit boundary. POSIX mode assertions remain
platform-skipped on Windows and require normal cross-platform CI.

## Reviews

- **Bug hunt:** [static report](arch-audit-seams.hunt.md) records zero
  confirmed and zero suspected defects; all nine changed files were read.
- **QC:** an independent reviewer read all nine files against `b2a6fac5`,
  checked all six structural standards, and approved with no blocking
  regressions or missed simplifications. Original item types remain intact,
  scheduling stays centralized, and the write operation stays in its owner.
- **Verify-specs:** not applicable; the plan cites no requirement IDs.
  No implementation-verification artifact was created.
