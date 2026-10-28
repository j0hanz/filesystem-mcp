# TOO_LARGE help text implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The get-help prompt and `internal://instructions` give the right
`TOO_LARGE` remedy for both limits, and state both limits in MiB.

**Architecture:** One source, `buildSectionsRecord` in `src/instructions.ts`,
renders both surfaces. Two lines in it change. `enforced_limits` formats the
file size limit with the existing `formatByteSize` (`src/core/fmt.ts:61`),
which handles units and decimals, and it adds the stdio Message limit. The
`error_recovery` line for `TOO_LARGE` covers both limits. The TOO_LARGE
producers keep their own remedies.

**Tech Stack:** TypeScript, Node test runner, contract snapshot.

**Spec:** the **Message limit** entry in `GLOSSARY.md` and ADR-006, plus
decisions from the 2026-10-28 grilling: a two-case line, the stdio limit,
the MiB label, and correcting the ADR-003 citation.

## Global Constraints

- Interpolate every figure from code: `getMaxTextFileSize()` (`src/core/util.ts`) and `MAX_OUTBOUND_RESULT_BYTES` (`src/core/outbound.ts`). Hard-code none of them.
- The `TOO_LARGE` line, verbatim: `TOO_LARGE: Over the file size limit, use ${READ.name} with head/tail or startLine/endLine. Over the stdio message limit, request a smaller slice or page, or connect over HTTP; media and binary files need HTTP.`
- The `enforced_limits` line starts with: `enforced_limits: max file size ${formatByteSize(getMaxTextFileSize())} (also the combined content cap of one create call), stdio responses up to ${formatByteSize(MAX_OUTBOUND_RESULT_BYTES)} once JSON-encoded (HTTP has no such limit), …`. The rest of the line stays as it is.
- With no `FS_*` variables set, this renders `max file size 10 MiB` and `stdio responses up to 9.8 MiB`.
- Producer suggestions don't change: `readNamedText`, `ResourceStore`, `refuseOversized` and `read.oversizeRemedy` all keep theirs.

## Review Focus

1. **A non-integer `FS_MAX_FILE_SIZE`, such as 1.5 MiB:** it renders `1.5 MiB`, not `1 MB`. Task 1 tests this.
2. **The `--read-only` surface:** it carries the same new lines (CONTRACT-002, snapshot near `:1374`). Check the snapshot diff in Task 1.
3. **An HTTP client reading the help:** it isn't told to switch to HTTP for a file size refusal. The two cases are named separately.
4. **`prompts.test.ts:103`:** it compares get-help to `buildSectionsRecord`, so it stays consistent with no edit.
5. **An import cycle between `src/instructions.ts` and `src/core/outbound.ts` or `src/core/fmt.ts`:** `npm run check` (knip and tsc) would catch it.

---

### Task 1: Two-case TOO_LARGE advice and both limits in MiB

**Files:**

- Modify: `src/instructions.ts:47` (drop `maxFileMb`), `:69` (`enforced_limits`), `:79` (`TOO_LARGE`)
- Modify: `__tests__/contract.test.ts.snapshot` (regenerated)
- Modify: `docs/adr/006-message-limit-links-by-raw-size.md:51`, `src/core/outbound.ts:108`
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Fixed`)
- Test: `__tests__/resources.test.ts` (near `:78-95`)

**Interfaces:**

- Consumes: `formatByteSize(bytes: number): string` from `src/core/fmt.ts`, and `MAX_OUTBOUND_RESULT_BYTES` from `src/core/outbound.ts`.

- [ ] **Step 1: Write the failing tests** in `resources.test.ts`, reading `internal://instructions`:
  - `instructions name both TOO_LARGE limits`: the text matches `/TOO_LARGE: Over the file size limit, use read/` and `/Over the stdio message limit, .*connect over HTTP; media and binary files need HTTP\./`.
  - `instructions state limits in MiB`: the text matches `/max file size 10 MiB/` and `/stdio responses up to 9\.8 MiB once JSON-encoded \(HTTP has no such limit\)/`.
  - `enforced_limits renders a fractional file size limit`: under `withEnv({ FS_MAX_FILE_SIZE: String(1.5 * MIB) }, …)`, `buildSectionsRecord(false).constraints` matches `/max file size 1\.5 MiB/`. Call `buildSectionsRecord` directly: the resource may cache its text from before the env change.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `npm test -- --test-name-pattern="instructions"`
  Expected: FAIL, with the current text `max file size 10 MB` and the head/tail-only line.

- [ ] **Step 3: Implement the two lines** exactly as in Global Constraints.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `npm test -- --test-name-pattern="instructions|prompts|resources"`
  Expected: PASS.

- [ ] **Step 5: Regenerate the contract snapshot and read its diff**

  Run: `node --test --test-update-snapshots __tests__/contract.test.ts` with no `FS_*` set, then `git diff __tests__/contract.test.ts.snapshot`.
  Expected: only the `enforced_limits` and `TOO_LARGE` lines change, once in CONTRACT-001 and once in CONTRACT-002.

- [ ] **Step 6: Correct the citation and the CHANGELOG**
  - ADR-006 `:51` and `outbound.ts:108` say "(ADR-003)", but ADR-003 never states this limit. Replace the citation with the reason in `outbound.ts:12-14`: the SDK's fixed 10 MiB stdio read buffer, which HTTP doesn't have.
  - `CHANGELOG.md` `### Fixed`: `**get-help and `internal://instructions` give the right TOO_LARGE advice for the stdio message limit.** Before, they advised only head/tail, which can't return a media or binary file, and named the file size limit in MB.`

- [ ] **Step 7: Run the full check**

  Run: `npm run check`
  Expected: PASS.

- [ ] **Step 8: Commit**

  ```bash
  git add src/instructions.ts __tests__/resources.test.ts __tests__/contract.test.ts.snapshot docs/adr/006-message-limit-links-by-raw-size.md src/core/outbound.ts CHANGELOG.md
  git commit -m "fix(instructions): name both TOO_LARGE limits and state them in MiB"
  ```
