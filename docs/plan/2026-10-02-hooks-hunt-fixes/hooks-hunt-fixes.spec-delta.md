# Spec delta: hooks — incomplete snapshots and own-write attribution

amends [`next-example-app.spec.md`](../2026-09-30-next-example-app/next-example-app.spec.md)
— raised by [`next-example-app.hunt.md`](../2026-09-30-next-example-app/next-example-app.hunt.md)
findings 1, 3, 4 and the qc note on `ownDeletes`.

## ADDED

- **R23** If the server's file listing is incomplete — it paginated (a
  `// showing … Next page` trailer), stopped its scan early (`// scan stopped
  early`), or returned an error — then the app shall start no turn, print a
  line containing `scan incomplete` and the server's trailer to stderr, and
  leave the baseline unchanged; if this happens while recording the startup
  baseline, the app shall print the same and exit with code 1.
  - Falsified by: a model request after an incomplete listing; or a startup on
    an oversized workspace that reaches `watching`.
  - Given a workspace one file under the page size, When two files are
    created, Then stderr contains `scan incomplete` and no model request is
    made within four quiet periods.
  - Given a workspace over the page size, When the app starts, Then the exit
    code is 1 and stderr contains `scan incomplete`.
  - Given the listing later completes (files removed) and a change occurs,
    Then a turn runs naming the change.
  - (Amended during run: the probe showed `maxResults` is the page size, so
    the server paginates rather than stops at it; the engine's own stop
    trailer appears only at its 10 000 cap or 5 s timeout. Both are refused.)

## MODIFIED

- **R18** was: "… at most 350 lines in `hooks.ts` …" — now: "… at most 400
  lines in `hooks.ts` as formatted by the repository's Prettier config,
  keeping `exampels/AGENTS.md`'s 250 as the target." Reason: the R23 refusal,
  the path-based own-write attribution and the pending-timer re-arm add 21
  lines of behavior the hunt required; the file is 367 after trimming. An
  example is read more than run, so comments are not cut to fit. Falsified
  by: `hooks.ts` over 400 lines, a second runtime dependency, a `tsx`/build
  step, or an `enum`.
- **R9** was: "The app shall not start a turn for changes made by its own tool
  calls." — now: "The app shall not start a turn for changes made by its own
  tool calls, including files it renamed or moved (whose modification time
  predates the call)." Reason: hunt finding 3 — `move` preserves mtime, so a
  time window alone misses renames. Falsified by: a `--yes` turn whose only
  tool call is a `move` being followed by a second turn with no external
  change.
  - Given `--yes`, When the model's only tool call is `move a.txt → c.txt`,
    Then no further model request is made within four quiet periods.

## Assumptions added

- `HOOKS_MAX_FILES` overrides the `find_files` result cap (default 10 000),
  for the check script only; undocumented for users, like `HOOKS_QUIET_MS`.
- Own-write attribution combines two signals: paths named in the destructive
  call's arguments (exact or as a directory prefix) and a time window around
  the call widened to 2.1 s before it, covering filesystems that round mtime
  to 2 s. Both are heuristics; the README's Limits names the residual case
  (an external change to the same path within the window).
