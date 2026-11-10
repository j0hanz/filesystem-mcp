# ADR-013: One Text view for every text tool, one matching engine for search and replace

**Status**: accepted, 2026-11-10
**Deciders**: j0hanz, in the grilling of the Match plan candidate from that day's architecture review

## Context

Four tools judge the text of a file: `search_text`, `replace_text`, `edit`
and `patch`. Each one prepared that text itself, and the rules were fixed one
tool at a time:

- **Byte-order mark.** Search strips a leading BOM
  ([`search.ts`](../../src/core/search.ts), `scanFileBody`). `edit` leaves
  U+FEFF out of its whitespace class so the mark is not copied as indentation
  ([`edit.ts`](../../src/tools/edit.ts)). `replace_text` strips and restores
  it only on the plan 089 branch. `patch` does nothing about it.
- **Line endings.** `edit` and `replace_text` convert an LF needle to CRLF
  for an all-CRLF file (`usesCrlf` and `toCrlf` in
  [`util.ts`](../../src/core/util.ts)); `replace_text` builds a second
  matcher for it and skips a regex. Search splits on `\r?\n`. `patch` strips
  a trailing `\r` from diff lines.
- **Line model.** Search matches one line at a time; `replace_text` matches
  the whole text with the `m` flag
  ([`matcher.ts`](../../src/core/matcher.ts), `createReplacementMatcher`).
  So a regex can match across a line break in a replacement but never in the
  search that previews it, and `$` matches before `\r\n` in a search but not
  in a replacement (the search prefilter already skips that case, in
  `canPrefilter`).
- **Size.** The regex engine takes at most 4 MiB of input
  (`RE2_MAX_INPUT_BYTES`). A regex replacement refuses a file over it; a
  regex search refuses only a line over it.

The glossary promised that "a preview judges exactly what its replacement
will touch". The Match plan settled the needle for both tools, but not the
text, and not the matching.

## Decision

Two modules, named in `GLOSSARY.md`.

**The Text view** serves all four tools. It hides a leading BOM and shows an
all-CRLF file with LF endings; a file with mixed endings is shown as written,
as before. A write through the view restores both. Search and the Rewrite
read through it, so a transform never sees a BOM or converts a needle.
Decoding and the binary and undecodable verdicts stay with the Scan
(ADR-005).

- The Rewrite reports `before` and `after` as the text on disk, so a diff, a
  returned patch and undo stay true to the bytes written.
- `patch` puts the diff's lines through the same view as the file, so a diff
  made from on-disk text and a diff made from viewed text both apply.

**One matching engine** serves `search_text` and `replace_text`, behind the
Match plan.

- A regex may match across a line break in both tools. `search_text` reports
  such a match on the line where it starts, in today's hit shape: no new
  field, counted once on that line.
- A pattern that cannot cross a line is given to the regex engine one line at
  a time, so the 4 MiB limit applies to a line. Only a pattern that can cross
  a line is matched against the whole text and pays the limit on the file.
  Regex `replace_text` therefore gains files over 4 MiB that it refused.

Delivery is four changes, each with the suite green: merge plan 089; the Text
view under the Rewrite; search reads through the view; the one engine.

## Considered options

- **Stop at plan 089.** Fixes the one BOM bug and leaves four preparations
  and two line models; rejected.
- **Text view for search and replace only.** The two Match plan users; leaves
  `edit` and `patch` with their own BOM and CRLF rules; rejected.
- **The view owns decoding too** (bytes in, bytes out). Overlaps the Scan's
  undecodable rule (ADR-005); rejected.
- **LF inside for every file**, restoring each line's ending. Needs per-line
  ending tracking and a rule for lines a replacement adds; rejected in favour
  of today's all-CRLF rule.
- **Whole-text matching with the 4 MiB limit on the file.** Simplest engine,
  but regex search would refuse files it searches today; rejected.
- **No regex match across a line in either tool.** No file limit for regex,
  but `replace_text` loses cross-line regex; rejected as breaking.
- **Two line models behind a flag.** Keeps the preview gap; rejected.

## Consequences

- `search_text` output changes: a regex that can match across a line break
  now reports hits it did not, and a search with such a pattern refuses a
  file over 4 MiB where it searched it before. The contract snapshot and the
  tool description change with the engine.
- `replace_text` with a regex `$` now matches at the end of a line in a CRLF
  file, as search does.
- `usesCrlf` and `toCrlf` leave `edit` and `replace_text`. `replace_text`
  keeps a second matcher only for a literal needle the client typed with
  `\r\n`, which is matched as `\n` in an all-CRLF file.
- A regex that spells `\r` no longer matches an all-CRLF file in
  `replace_text`, as it never did in `search_text`: the view has no `\r`
  there. The client writes `\n`.
- A line is what search calls a line. In `replace_text`, `^` and `$` no
  longer match the empty position after a final newline, or an empty file:
  `^` → `x` on `a\nb\n` gave `xa\nxb\nx` and now gives `xa\nxb\n`.
- Tests move to the two interfaces: a Text view round-trip suite, and a
  parity suite that holds a search and a replacement to the same matches.
  Each tool keeps one BOM and one CRLF test through the harness as a wiring
  pin. `createRegexReplacementMatcher`, `createCaseInsensitiveLiteralMatcher`
  and `createCaseSensitiveLiteralMatcher` stop being exported.
- How the engine decides that a pattern cannot cross a line is not settled
  here. It must be conservative: when unsure, the pattern is treated as one
  that can.

## Addendum: Deepening of MatchEngine (2026-11-10)

Following the initial implementation of the Text view and MatchEngine,
`MatchEngine` was deepened to directly accept `TextView` alongside `string`,
internalizing several responsibilities previously scattered across callers:

1. **Raw byte prefiltering (`engine.mayMatch(bytes: Buffer): boolean`)**:
   Prefiltering logic was unified inside the engine. The engine determines
   whether raw bytes need prefiltering, handles BOM offset adjustment,
   CR-safety checks (avoiding false negative skips on CRLF files), and runs
   Boyer-Moore-Horspool literal byte prefiltering before any text is decoded or
   opened as a view.
2. **Internalized CRLF literal variant switching**:
   Callers no longer assemble or dispose secondary `lf` engine instances for
   literal needles containing `\r\n`. When `matches(view)` or `replace(view)`
   encounters an all-CRLF file (`view.crlf === true`), `MatchEngine`
   automatically delegates to an internal lazily-instantiated LF-normalized
   variant.
3. **Internalized replacement execution and bounds checking**:
   `engine.replace(view, replacement, options)` directly executes splicing and
   expansion over the `TextView`, validating UTF-8 output byte limits
   (`outputTooLarge`) before returning.
4. **Caller simplification**:
   Both `search_text` and `replace_text` interact through a clean, uniform
   surface: `engine.mayMatch(bytes)` to pre-screen raw files,
   `engine.matches(view, onMatch)` to scan hits, and
   `engine.replace(view, replacement, options)` to perform atomic rewrites.
