# Diagnose: search_text / replace_text silent literal miss (#55)

Issue: <https://github.com/j0hanz/filesystem-mcp/issues/55>

## Repro

At `f0809921` (v2.7.2), in-memory client from `__tests__/helpers.ts`, one file
`src/a.ts` holding `const TOKEN1 = 1;` and `const token2 = 22;`:

| Call                                                     | Text the model sees                                              | `_meta.filesScanned` |
| :------------------------------------------------------- | :--------------------------------------------------------------- | :------------------- |
| `search_text {searchPattern:'TOKEN1\|token2'}`           | `No matches for 'TOKEN1\|token2'`                                | 1                    |
| same + `isRegex:true`                                    | 2 match rows                                                     | 1                    |
| `search_text {pattern:'**/*.py', searchPattern:'TOKEN1'}` | `No matches for 'TOKEN1'`                                        | 0                    |
| `replace_text` dry run `'TOKEN1\|token2'`                | `replace_text: 'TOKEN1\|token2' [dry run] · 0 match(es) in 0 file(s)` | 1               |
| `replace_text` dry run, `pattern:'**/*.py'`              | same shape                                                       | 0                    |

Reproduces on every run. The regression test below is the falsifying check:
it fails at HEAD (`fail 1`) and passes with the fix.

## Pinned cause

Two states produce text identical to a genuine content miss:

1. `src/tools/search-text.ts:305` and `src/tools/replace-text.ts:600-607`:
   a zero-match result prints no reason. `isRegex` defaults to `false`, so a
   regex-shaped needle is escaped (`src/core/search.ts:319`) and matched
   literally. The distinguishing facts (`isRegex`, `filesScanned`) are only in
   `_meta`, which clients do not show the model.
2. `filesScanned === 0` (glob selected nothing, often the needle pasted into
   `pattern`) prints the same `No matches` text as a scanned miss.

Priming: the `searchPattern` examples (`search-text.ts:54`,
`replace-text.ts:58`) show two bare regexes with no `isRegex` flag.

## Fix options (prototyped in worktrees and reviewed by a skeptic agent)

| Variant                       | Fixes model text | tools/list full / ro | Wire break | Verdict                                       |
| :---------------------------- | :--------------- | :------------------- | :--------- | :-------------------------------------------- |
| Issue A+B+C as written        | yes              | 18907 / 9104         | no         | broad trigger, 46 chars ro headroom left      |
| Minimal B+C + examples fix    | yes              | 18508 / 8894         | no         | **recommended**                               |
| `literal` XOR `regex` schema  | no               | 18411 / 8843         | yes        | refuted: still silent, breaks paging hint     |

Baseline: 18620 / 8950 against budgets 19000 / 9150 (TOOL-SURFACE-002).

Why the XOR schema fails: a model that picks `literal` for `TOKEN1|token2`
still gets the silent miss. The glob case is unchanged. `pageTrailer`
prints the post-transform args as the `Next page:` call, so the new strict
schema rejects that call. 27 of 198 tests break.

## Recommended fix

One `//` hint line on a zero-match result, from one helper `zeroMatchHint()`
in `src/core/fmt.ts`, called from both tools:

- `filesScanned === 0`: `// no files were searched: nothing under path
  matched pattern '<glob>' after the hidden/ignored/maxDepth filters. pattern
  is a file-name glob; the text to find goes in searchPattern.` (No-glob
  variant names the filters only.)
- literal mode and the needle looks like a regex: `// searchPattern was
  matched as literal text but looks like a regex; pass isRegex=true to match
  it as one.`
- No hint on an incomplete scan (stopped early, files too large/inaccessible,
  replace_text failures or binary skips). The existing line explains it
  better, and "nothing was searched" next to a timeout would be false.

Trigger: `/(?<=[^\s|])\|(?=[^\s|])|\\[dDwWsSbB]|\.[*+]/`. It catches
`a|b`, `\d+`, and `.*`. It skips `||`, the union `string | undefined`, the
closure `|x| x`, `foo(`, `a.b`, and `arr[0]`. Known false positives are
Windows paths (`src\db`), LaTeX, and `java.util.*`. These cost one extra
line on a zero-match result only.

Also delete the regex-shaped `examples` metadata from `searchPattern` on both
tools. Match behavior and the schema shape do not change.

Not taken: the issue's description rewrites (A). They leave only 46 chars of
read-only budget, and they act at listing time, not when the mistake shows.
A short `isRegex` wording tweak fits in the freed budget if wanted.

## Evidence

- Prototype worktree: `.claude/worktrees/wf_8f2f54b9-472-2` (uncommitted).
- `node --test __tests__/tools.test.ts`: 125 tests, 124 pass, 0 fail,
  1 skipped. Full `npm test` (agent-run): 566, 563 pass, 0 fail.
  `npm run check:static`: exit 0.
- New test `search_text and replace_text explain a zero-match result in the
  text (#55)`: fails at HEAD, passes with the fix.

## Handoff

- write-plan: cause above, repro = the #55 test as the success gate.
- write-qa: regression-worthy. The test pins the exact text, including the
  no-hint literals, so a trigger widening is caught.
