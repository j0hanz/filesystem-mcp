# Diff generation counts design

## Goal

Return generated line counts with patch text so callers no longer parse formatted patches to recover information already present in `StructuredPatch`.

## Decisions

- Export `GeneratedPatch` with `text`, `linesAdded`, and `linesRemoved` properties.
- Change both `twoFilesPatch` and `unifiedPatch` to return `GeneratedPatch | undefined`.
- Count added and removed lines from `StructuredPatch.hunks` after inline or worker generation and before formatting.
- Keep `undefined` for timeout, worker failure, and worker queue saturation.
- Remove the exported `diffStatsFromPatch` function.
- Update `diff`, `edit`, `patch`, and `diff-budget` to consume the new result. `diff-budget` uses only `text`.
- Keep patch formatting, header quoting, timeout behavior, and every advertised MCP result unchanged.
- Test counts through generation. Remove direct parser tests and keep existing tool wiring coverage.

## Test scenarios

- A normal edit returns two added lines and one removed line.
- Content lines beginning with `--` or `++` count as content, never as file headers.
- Hostile file names remain quoted, cannot forge headers, and still return one addition and one removal.
- Identical files return zero counts and header-only text.
- A worker diff returns 600 additions and 600 removals.
- Deadline and queue-saturation cases keep returning `undefined`.

## Out of scope

- Changes to `diff-worker.ts`; it already returns `StructuredPatch`.
- Scan settlement and DiffBudget prefix tracking.
- New dependencies, glossary terms, ADRs, or MCP contract changes.
