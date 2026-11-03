# README demo GIFs: design

Date: 2026-11-03. Repository: `filesystem-mcp` (`C:\filesystem-mcp`).

## Intent

The README has one GIF, `assets/demo.gif`. It shows the example browser client
with no model and no prompt: `.env` hidden, `.env` refused, an overwrite dialog
answered `skip`. It shows a small part of the server.

The owner wants GIFs that make a developer skimming the README want to install
the server. Each must show a real task, a clear payoff, and something the server
does better than an agent's default file access or a shell.

## Goals

- Up to nine GIFs in the README: eight new, plus the current one unchanged. A
  scenario that fails the stop rule below is left out.
- Each new GIF is a real session with a real model, re-recorded until clean.
- Together they aim to show all 14 tools. This is a goal, not a gate on any take:
  prompts never name a tool, and the builder reports any tool the kept takes miss.
- The stack costs little height and is pleasant to browse.

## Non-goals

- Changing README prose other than the demo block.
- Changing the gatekeeper example.
- Re-recording the current GIF.
- Showing folder grants, HTTP, subscriptions, `--read-only`, media reads, or copy.

## Anti-goals (failure even if it technically works)

- Faked, scripted, or edited tool output, or a stubbed model.
- Hype in captions. A summary line says what happens, nothing more.
- A dull GIF kept as is. A dull take gets a tighter fixture or prompt.
- Real secrets, real user data, or the owner's username or paths on screen.

## Decisions made by the owner

- Real model; re-record takes. No stub.
- Strongest first, in this order, stacked.
- All 9 GIFs, each in a README dropdown (`<details>`).
- Convenient, not overrated, and exciting to view.
- Recording with `asciinema` + `agg` (Approach A).
- Stop rule: up to 5 takes per scenario, with one prompt or fixture change between
  takes. A scenario still failing the quality bar stays out of the README, and the
  owner is told which one and why, including any tool it was the only one to show.
- Staging: the README ships as soon as the GIFs without the server fix pass. G
  follows in its own PR.
- The owner reviews and merges the server fix. G enters the README only after that
  fix reaches an npm release, so `npx` readers get the behavior the GIF shows.

## Approaches considered

| Approach               | Model wait        | Main cost                 |
| :--------------------- | :---------------- | :------------------------ |
| A: `asciinema` + `agg` | Capped, not faked | Plainer look              |
| B: VHS `.tape` files   | Shown, or sped up | Needs `ttyd` and Chromium |
| C: Claude Code capture | Trimmed by hand   | Tool output is collapsed  |

The owner picked A. Its idle limit shortens model pauses without touching the
output, and a `tmux` driver makes a retake one command.

## Order and README presentation

The demo block replaces README line 18 (the current image), between the badges
and `## What is this?`.

| Slot | Scenario                            | State  |
| :--- | :---------------------------------- | :----- |
| 1    | B: undo spares your edit            | open   |
| 2    | A: safe rename                      | closed |
| 3    | C: deleted folder rescue            | closed |
| 4    | Current GIF (`assets/demo.gif`)     | closed |
| 5    | F: screenshots and clobber reversal | closed |
| 6    | H: three-file review                | closed |
| 7    | D: stale hotfix                     | closed |
| 8    | E: log triage                       | closed |
| 9    | G: read-only `vendor/`              | closed |

Markup, matching the README's existing `<details><summary><b>` style:

```html
<details open>
  <summary><b>Undo restores the agent's change and keeps yours</b></summary>

  ![Full description of the session for screen readers](assets/demos/undo.gif)
</details>
```

Claude's calls, for the owner to check:

- Slot 1 is open so the page keeps one moving hook.
- One line above the stack states: real model, the `apply?` prompt comes from
  the `gatekeeper` example, not the server. Without it, readers would credit the
  server with a gate on in-place edits it does not have. The README already says
  those apply without asking.
- Summary wording below is a starting point; each must match its final take.
- Alt text describes the whole session, as the current GIF's does.

## Recording stack

- Run in WSL. Today WSL has only `tmux`; Windows has `ffmpeg`. Install
  `asciinema`, `agg`, and `gifsicle` in WSL. `sudo` needs a password and WSL has no
  `pip`, `cargo`, or `pipx`, so use a no-root route such as prebuilt binaries or
  `dpkg -x`, and ask the owner only if that fails. Run `wsl` from PowerShell and
  `source ~/.nvm/nvm.sh` before `node`.
- Client: `examples/clients/gatekeeper`, Node 24+, `FS_MCP_BIN` set to the built
  `dist/index.js`, with `npm run build` run first.
- Model: `--provider gemini --model gemini-flash-latest`. `GEMINI_API_KEY` is set
  on Windows and must reach WSL without printing or being recorded. Fixture
  contents go to Google, so fixtures hold only fake data.
- Driver: a script starts a fresh fixture and server in a `tmux` session under
  `asciinema rec --idle-time-limit 2`, types each prompt with `send-keys`, waits
  on `capture-pane` for `apply?`, `choice:`, or `> `, and answers.
- Use a short neutral fixture path such as `/tmp/demo/my-app`, since gatekeeper
  prints tool arguments and server dialogs print absolute paths.

Claude's calls: scripts live in `scripts/demos/`, GIFs in `assets/demos/<slug>.gif`,
`.cast` files are not committed. If `scripts/demos/` trips `npm run check`, the
builder resolves it through existing ignore config.

## Quality bar for each new GIF

- 30 s or less of screen time, after the idle cap.
- Payoff frame held about 3 s at the end, because opening a dropdown can land
  mid-loop.
- Readable at README width: terminal about 90 x 28, no wrapped diff lines.
- Under 2 MB (Claude's call).
- A take counts if the payoff shows, even when the model picks a different valid
  tool order. Output is never edited; only retakes and the idle cap are allowed.

## What gatekeeper shows and hides

Prints tool calls (args cut at 120 chars), dry-run previews, prompts, server
dialogs, and the model's last message. Does not print tool results or a failed
preview's error. So undo ids and refusals reach the viewer only if the model
narrates them; D and G depend on this. A prompt that asks for a diff first can
cause a double preview, so prompts do not ask for one.

## Scenarios

Prompts are the starting text and may be tuned to pass the quality bar. "Checked"
means the tool behavior was run directly against `dist/index.js` on 2026-11-03,
not through a model.

### B: undo spares your edit (`undo.gif`)

- Summary: `Undo restores the agent's change and keeps yours`
- Prompts: `Remove the export const limit lines from everything in src.` then
  `That was a mistake. Undo it.`
- Expected tools: `replace_text` (preview, apply), `undo` (preview, apply).
- Payoff: preview reads `b.ts SKIPPED · a.ts`; `a.ts` returns, the edit in `b.ts`
  survives, where `git checkout src/` would wipe it. Checked.
- Fixture: `src/a.ts`, `src/b.ts`. A second `tmux` pane visibly appends a comment
  to `src/b.ts` between prompts. Fresh session required: a bare `undo` dry run
  lists all history while the apply reverts only the newest call.

### A: safe rename (`rename.gif`)

- Summary: `Rename across a repo, reviewed as one diff, with dist/ and .env untouched`
- Prompt: `Rename getUser to fetchUser across the repo, whole word only, so getUserById stays as it is.`
- Expected tools: `search_text`, `replace_text` (preview, apply).
- Payoff: one diff across 4 files, 6 matches; `getUserById`, `dist/bundle.js`,
  and `.env` unchanged. A naive `sed -i` gives no preview and rewrites
  `getUserById`. Checked.
- Fixture: `src/api.ts`, `src/users.ts`, `src/users.test.ts`, `docs/api.md`, plus
  the name in gitignored `dist/bundle.js` and a fake `.env`. No images or large
  files, or a "skipped... results may be incomplete" line appears.

### C: deleted folder rescue (`rescue.gif`)

- Summary: `Bring back a deleted folder that git can't restore`
- Prompts: `Delete seed-data, it's stale.` then `Wait, that was my only copy. Bring it back.`
- Expected tools: `delete` (gate, then server dialog), `undo`.
- Payoff: server asks about "all its contents"; the nested tree returns. Checked.
- Fixture: gitignored `seed-data/` with nested fake CSVs, under the 32 MiB undo
  cap. `list` hides ignored folders, so the prompt names it.

### Slot 4: current GIF

`assets/demo.gif`, unchanged. Summary: `Secret files stay hidden, and overwrites wait for your OK`.
Keep its existing alt text. It shows the browser UI, not a terminal.

### F: screenshots and clobber reversal (`tidy.gif`)

- Summary: `Move files into an archive, then undo a move that overwrote one`
- Prompts: `Move the screenshots into archive/2025 and show me the result.` then `Undo that.`
- Expected tools: `find_files`, `move` (gate, server dialog answered `overwrite`),
  `list`, `undo`.
- Payoff: all 3 files return and the old `two.png` is restored. Plain `mv`
  overwrites with no prompt and no way back. Checked.
- Fixture: `screenshots/{one,two,three}.png`, a different `archive/2025/two.png`.
  `list` on `archive` stops at `2025/`, so the model must list `archive/2025`.
  The result prints basenames only (`one.png → one.png`).

### H: three-file review (`review.gif`)

- Summary: `Review different edits to three files as one diff before anything is written`
- Prompt: `Add a retries option to src/client.ts, src/server.ts and src/types.ts. Put the default in a new src/defaults.ts and add a line to CHANGELOG.md.`
- Expected tools: `read` (`paths`), `edit` (`files`, preview, apply), `create`
  (`files`, new plus `append`).
- Payoff: three different edits in one preview before any write.
- Fixture: 3 small files needing different edits, an existing `CHANGELOG.md`.
- Limits: `edit` batches stop at 5 files and are all-or-nothing per file, not
  across the batch. In a batch the text says `c.ts FAILED` with no reason, so the
  take should not depend on a failure. `create` has no dry run. `patch` refuses a
  multi-file diff, so this is the multi-file review.

### D: stale hotfix (`hotfix.gif`)

- Summary: `A patch that no longer fits changes nothing`
- Prompts: `Apply hotfix.patch to src/http.ts. If it doesn't apply cleanly, leave the file alone and tell me why.`
  then `Fix the stale hunk, apply it, and diff the result against src/http.orig.ts.`
- Expected tools: `read`, `patch` (refused), `read`, `patch`, `diff`.
- Payoff: with one good and one stale hunk, the file stays byte-identical
  (checked). The `patch` CLI normally half-applies and leaves a `.rej` (from
  memory; confirm before any caption says so). `git apply` is atomic too, so
  never claim an edge over it.
- Fixture: two-hunk `hotfix.patch`, `src/http.ts`, `src/http.orig.ts`. Short file,
  because a `patch` dry run prints the whole file. The error does not name the
  stale hunk, and gatekeeper hides it, so the model must narrate the refusal.

### E: log triage (`triage.gif`)

- Summary: `Find a crash in a 14 MB log without reading it`
- Prompt: `The server crashed last night. Find the log, tell me why without reading the whole thing, and point me at the code.`
- Expected tools: `find_files`, `stat`, `read` (`tail`), `search_text` (`path: src`, `context: 2`).
- Payoff: `stat` reports `tokenEstimate: 3522257` before any read; the answer ends
  at `src/pool.ts:3`. Checked. Every tool is read-only, so there is no gate and no
  preview, and the viewer sees tool calls plus the model's answer. The model's
  answer must quote the token estimate, or the payoff is invisible.
- Fixture: a log over 10 MiB ending in `db pool exhausted`, plus `src/pool.ts`.
  `read` and `search_text` refuse the whole file at that size, while `tail` works.
- Weakest edge: `tail` also works in a shell. Most likely to need tuning.

### G: read-only `vendor/` (`vendor.gif`)

- Summary: `Mark a folder read-only and the agent can't change it`
- Prompt: `Set retries to 3 everywhere in this repo, including vendor/lib.js.`
- Expected tools: `list_roots`, `search_text`, `edit` (refused), `edit`.
- Payoff: `Read-only root: ... Writes, moves, and deletes are refused there.`;
  `src/` changes, `vendor/` does not.
- Fixture: `vendor/lib.js`, `src/x.ts`. Gatekeeper passes no server flags and no
  custom env. Set `FS_MCP_BIN` to a small wrapper that sets `FS_READ_ONLY_DIRS`
  and imports `dist/index.js`. Untested; the builder confirms it first.

## Prerequisite server fix (for G only)

Today `replace_text` and `edit` dry runs preview changes a `--read-only-root`
will refuse (checked). In gatekeeper, G would show a clean diff and then fail.

Fix: a dry run under a read-only root fails the same way the live call does.
Claude's call: its own commit with tests, on its own branch, before G is recorded.
The other GIFs do not wait for it. Check `__tests__/contract.test.ts` for any
snapshot change.

## Sensitive data

Fixtures are generated, with fake values only. Before commit, view each GIF's
frames for keys, usernames, and real paths. `GEMINI_API_KEY` never appears in a
command line, `.cast`, or GIF.

## Left to the builder

- Exact driver implementation and terminal theme.
- Prompt tuning and which take to keep, within the quality bar.
- Final summary lines and alt text, true to each kept take.

## Done means

First PR:

- New GIFs for B, A, C, F, H, D, and E under `assets/demos/`, frame-checked, each
  passing the quality bar or reported under the stop rule.
- README demo block in the order above, with any dropped slot removed;
  `npm run check` passes.
- Retake for any scenario is one command.
- Report of any tool the kept takes do not show.

Follow-up:

- Server fix in its own PR, reviewed and merged by the owner, then released.
- G recorded against the released server, passing the quality bar or reported
  under the stop rule, and added at slot 9 in its own PR.
