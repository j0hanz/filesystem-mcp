# README demo GIFs implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stack up to nine demo GIFs in README dropdowns, strongest first, with eight new ones recorded from real model sessions.

**Architecture:** One bash driver runs `examples/clients/gatekeeper` with a real model inside `tmux` under `asciinema`, then renders with `agg`. Each scenario is one bash file with a fixture, a script, and a check of disk and recording. The server fix and G ship separately from the first seven recordings.

**Tech Stack:** bash, `tmux`, `asciinema`, `agg`, `gifsicle`, `ffmpeg` (Windows, frame checks), Node 24, `gemini-flash-latest`.

**Spec:** `docs/superpowers/specs/2026-11-03-readme-demo-gifs-design.md`

## Global Constraints

- Real model, `--provider gemini --model gemini-flash-latest`. No stub, for recording or for testing the driver.
- Output is never edited. Only retakes and `--idle-time-limit 2` are allowed.
- Stop rule: up to 5 takes per scenario, one prompt or fixture change between takes. A scenario still failing stays out of the README and is reported to the owner, including any tool only it showed. A take lost to an API or rate-limit error does not count.
- Each new GIF: 30 s or less, payoff frame held about 3 s, terminal about 90 x 28, no wrapped diff lines, under 2 MB.
- A take counts if the payoff shows, even with a different valid tool order. Prompts never name a tool.
- Fixtures hold only generated fake data, at `/tmp/demo/my-app`. No username, real path, or `GEMINI_API_KEY` in any command line, `.cast`, or GIF.
- GIFs go in `assets/demos/<slug>.gif`. Scripts go in `scripts/demos/`. `.cast` files are not committed.
- Run WSL from PowerShell. `source ~/.nvm/nvm.sh` before `node` in WSL.
- `sudo` needs a password, and WSL has no `pip`, `cargo`, or `pipx`. Install without root; ask the owner only if that fails.
- Summary lines say what happens, with no hype, and match the kept take.
- Do not hand-edit versions. Do not change the gatekeeper example. Do not re-record `assets/demo.gif`.
- `main` is the current branch. Create the task's branch before the first commit. Merging needs the owner.

## Review Focus

1. **The model strays:** it rewrites `dist/`, `.env`, or `getUserById`. The take must fail its check even if it looks clean. Tasks 2-4 pin this per scenario.
2. **The key leaks into a recording.** `record.sh` must delete the cast and exit non-zero if the key's value appears in it. Task 1 tests this.
3. **An interrupted take poisons the next one.** A stale `tmux` session or fixture would carry undo history or edits over. Task 1 tests a second run after a killed run.
4. **The last frame is not the payoff.** `tmux` exit or detach text would replace it, and that frame is what readers see held. Task 1 checks the extracted last frame.
5. **A dry run diverges from a live call in the other direction.** The server fix must still preview normally outside read-only roots, and refuse through symlinks that resolve into one. Task 6 pins both.

---

### Task 1: Toolchain, driver, and the undo GIF

**Files:**

- Create: `scripts/demos/README.md`, `scripts/demos/install-tools.sh`, `scripts/demos/record.sh`, `scripts/demos/lib.sh`, `scripts/demos/scenarios/undo.sh`
- Create: `assets/demos/undo.gif`

**Interfaces:**

- Produces, run from PowerShell: `$env:WSLENV='GEMINI_API_KEY'; wsl bash /mnt/c/filesystem-mcp/scripts/demos/record.sh <slug>`. Exit 0 means the check passed and `assets/demos/<slug>.gif` was written.
- Produces: `scripts/demos/scenarios/<slug>.sh` defines `fixture()`, `script()`, and `check <cast-path>`.
- Produces, in `lib.sh`:
  - `demo_file <path> <content>`: writes under the fixture, creating parents.
  - `demo_turn <prompt> [choice]`: types the prompt, answers `y` at `apply?`, answers `[choice]` at `choice:`, and returns at the next `> ` prompt.
  - `demo_human <command>`: runs a visible shell command in a second pane.
  - `assert_file_has <path> <text>`, `assert_file_lacks <path> <text>`, `assert_cast_has <cast> <text>`: exit 1 with a message.

- [ ] **Step 1: Branch**

Run: `git switch -c docs/demo-gifs`
Expected: the untracked spec and this plan move with you.

- [ ] **Step 2: Write `install-tools.sh` and run it**

Install to `~/.local/bin` without root: `asciinema` and `agg` from their GitHub release binaries for x86_64 Linux, `gifsicle` by `apt-get download gifsicle` plus `dpkg -x`. Print each tool's version.

Run: `wsl bash /mnt/c/filesystem-mcp/scripts/demos/install-tools.sh`
Expected: three version lines. Record them in `scripts/demos/README.md`.

- [ ] **Step 3: Confirm gatekeeper runs in WSL from the Windows checkout**

Run `npm run build` on Windows, then in WSL run `examples/clients/gatekeeper/agent.ts` with `FS_MCP_BIN=/mnt/c/filesystem-mcp/dist/index.js` on an empty `/tmp/demo/my-app` and the task `Which folders can you access?`.
Expected: the model answers with `/tmp/demo/my-app`. If `node_modules` fails under Linux, install into a WSL-side copy under `/tmp/demo/.client` and use that in `record.sh`.

- [ ] **Step 4: Write `scenarios/undo.sh`, check first**

`fixture`: `src/a.ts` and `src/b.ts`, each `export const limit = 10;\nconst t = 1;\n`.

`script`:

1. `demo_turn "Remove the export const limit lines from everything in src."`
2. `demo_human "echo '// my fix' >> src/b.ts"`
3. `demo_turn "That was a mistake. Undo it."`

`check`:

```bash
assert_file_has src/a.ts 'export const limit'
assert_file_lacks src/b.ts 'export const limit'
assert_file_has src/b.ts '// my fix'
assert_cast_has "$1" 'SKIPPED'
```

- [ ] **Step 5: Write `lib.sh` and `record.sh`**

`record.sh <slug>` in order:

1. Kill any `demo` `tmux` session; delete `/tmp/demo/my-app`; run `fixture`.
2. Start a 90 x 28 `tmux` session with the status bar off, running gatekeeper on the fixture from inside its directory.
3. Run `asciinema rec --idle-time-limit 2` attached to the session, and `script` alongside it.
4. End the recording with the session still on screen, so no exit or detach text is captured.
5. Run `check`. If it fails, exit 1 and keep the cast at `/tmp/demo/casts/<slug>.cast`.
6. If the cast contains the value of `GEMINI_API_KEY`, delete it and exit 1 without printing the value.
7. Render with `agg --last-frame-duration 3`, shrink with `gifsicle -O3`, and write `assets/demos/<slug>.gif`.
8. Fail if the GIF is 2 MB or more. Print its size and duration.

A timeout in `demo_turn` (120 s) exits 3, marked as an API or stall failure that does not count as a take.

- [ ] **Step 6: Prove the Review Focus checks**

1. Set `GEMINI_API_KEY` to a value also echoed by a temporary `script`, and run: expect exit 1, no cast, no value printed. Remove the echo.
2. Kill `record.sh undo` mid-turn, then rerun: expect a clean take. The `SKIPPED` preview must list one undo step only.

- [ ] **Step 7: Record, up to 5 takes**

Run: `$env:WSLENV='GEMINI_API_KEY'; wsl bash /mnt/c/filesystem-mcp/scripts/demos/record.sh undo`
Expected: exit 0.

- [ ] **Step 8: Frame-check**

Run on Windows: `ffmpeg -v error -y -i assets/demos/undo.gif -vf "select='gt(scene,0.02)',scale=640:-1,tile=3x4" -vsync vfr -frames:v 1 <scratchpad>/undo-sheet.png`, and `ffprobe` for duration. Then read the sheet.
Expected: duration 30 s or less, `SKIPPED` readable, last frame shows the outcome rather than `tmux` text, no real path or username.

- [ ] **Step 9: Commit**

```bash
git add docs/superpowers/specs docs/superpowers/plans/2026-11-03-readme-demo-gifs.md scripts/demos assets/demos/undo.gif
git commit -m "docs: add demo recording driver and undo GIF"
```

### Task 2: Rename and rescue GIFs

**Files:**

- Create: `scripts/demos/scenarios/rename.sh`, `scripts/demos/scenarios/rescue.sh`
- Create: `assets/demos/rename.gif`, `assets/demos/rescue.gif`

**Interfaces:**

- Consumes: `record.sh <slug>` and `lib.sh` from Task 1.

- [ ] **Step 1: Write `rename.sh`**

`fixture`: `.gitignore` with `dist/`; `src/api.ts`, `src/users.ts`, `src/users.test.ts`, `docs/api.md` with 6 whole-word `getUser` uses and `getUserById` in `src/api.ts` and `src/users.ts`; `dist/bundle.js` and a fake `.env`, each containing `getUser`. No images or large files.

`script`: `demo_turn "Rename getUser to fetchUser across the repo, whole word only, so getUserById stays as it is."`

`check`:

```bash
assert_file_has src/users.ts 'fetchUser'
assert_file_has src/users.ts 'getUserById'
assert_file_has src/api.ts 'getUserById'
assert_file_has dist/bundle.js 'getUser'
assert_file_lacks dist/bundle.js 'fetchUser'
assert_file_has .env 'getUser'
assert_file_lacks .env 'fetchUser'
assert_cast_has "$1" 'fetchUser'
```

- [ ] **Step 2: Write `rescue.sh`**

`fixture`: `.gitignore` with `seed-data/`; `seed-data/users.csv`, `seed-data/nested/orders.csv` with fake rows.

`script`: `demo_turn "Delete seed-data, it's stale." 1`, then `demo_turn "Wait, that was my only copy. Bring it back."`. The `1` picks `delete` in the server dialog.

`check`:

```bash
assert_file_has seed-data/users.csv 'id'
assert_file_has seed-data/nested/orders.csv 'id'
assert_cast_has "$1" 'all its contents'
```

- [ ] **Step 3: Record and frame-check both, up to 5 takes each**

Use Task 1 Steps 7-8. Expected for `rename`: the diff names 4 files and shows no `dist/` or `.env`. Expected for `rescue`: the server dialog and the restored paths are readable.

- [ ] **Step 4: Commit**

```bash
git add scripts/demos/scenarios/rename.sh scripts/demos/scenarios/rescue.sh assets/demos/rename.gif assets/demos/rescue.gif
git commit -m "docs: add rename and rescue demo GIFs"
```

### Task 3: Tidy and review GIFs

**Files:**

- Create: `scripts/demos/scenarios/tidy.sh`, `scripts/demos/scenarios/review.sh`
- Create: `assets/demos/tidy.gif`, `assets/demos/review.gif`

**Interfaces:**

- Consumes: `record.sh <slug>` and `lib.sh` from Task 1.

- [ ] **Step 1: Write `tidy.sh`**

`fixture`: `screenshots/{one,two,three}.png` each holding `new`; `archive/2025/two.png` holding `old`.

`script`: `demo_turn "Move the screenshots into archive/2025 and show me the result." 1`, then `demo_turn "Undo that."`. The `1` picks `overwrite`.

`check`:

```bash
assert_file_has screenshots/one.png 'new'
assert_file_has screenshots/two.png 'new'
assert_file_has screenshots/three.png 'new'
assert_file_has archive/2025/two.png 'old'
assert_cast_has "$1" 'already exists'
```

- [ ] **Step 2: Write `review.sh`**

`fixture`: `src/client.ts`, `src/server.ts`, `src/types.ts`, each short and needing a different edit for a `retries` option; `CHANGELOG.md` with one line.

`script`: `demo_turn "Add a retries option to src/client.ts, src/server.ts and src/types.ts. Put the default in a new src/defaults.ts and add a line to CHANGELOG.md."`

`check`:

```bash
assert_file_has src/client.ts 'retries'
assert_file_has src/server.ts 'retries'
assert_file_has src/types.ts 'retries'
assert_file_has src/defaults.ts 'retries'
assert_file_has CHANGELOG.md 'retries'
assert_cast_has "$1" 'dry run'
```

A take that edits the three files in separate calls passes the check but fails the payoff. Reject it at the frame check.

- [ ] **Step 3: Record and frame-check both, up to 5 takes each**

Use Task 1 Steps 7-8. Expected for `review`: one preview shows all three files.

- [ ] **Step 4: Commit**

```bash
git add scripts/demos/scenarios/tidy.sh scripts/demos/scenarios/review.sh assets/demos/tidy.gif assets/demos/review.gif
git commit -m "docs: add tidy and review demo GIFs"
```

### Task 4: Hotfix and triage GIFs

**Files:**

- Create: `scripts/demos/scenarios/hotfix.sh`, `scripts/demos/scenarios/triage.sh`
- Create: `assets/demos/hotfix.gif`, `assets/demos/triage.gif`

**Interfaces:**

- Consumes: `record.sh <slug>` and `lib.sh` from Task 1.

- [ ] **Step 1: Write `hotfix.sh`**

`fixture`: a short `src/http.ts` with `get` and `post`; identical `src/http.orig.ts`; `hotfix.patch` with two hunks, the first fitting, the second expecting `fetch(url, { method: "POST", body })` where the file has `body, keepalive: true`. Both hunks change `cache` to `"no-store"`.

`script`: `demo_turn "Apply hotfix.patch to src/http.ts. If it doesn't apply cleanly, leave the file alone and tell me why."`, then `demo_turn "Fix the stale hunk, apply it, and diff the result against src/http.orig.ts."`.

`check`:

```bash
assert_file_has src/http.ts 'no-store'
assert_file_has src/http.ts 'keepalive: true'
assert_file_lacks src/http.orig.ts 'no-store'
assert_cast_has "$1" 'no-store'
```

Reject at the frame check any take whose first answer does not say the patch failed and the file was left alone. Gatekeeper hides the refusal, so the model's sentence is the payoff. Captions never claim an edge over `git apply`. Any caption mentioning `patch` CLI `.rej` behavior needs that behavior run first.

- [ ] **Step 2: Write `triage.sh`**

`fixture`: `logs/server.log` of about 14 MB of fake `INFO` lines, generated, ending with `ERROR db pool exhausted: timeout after 30000ms`; `src/pool.ts` with `throw new Error("db pool exhausted")` on line 3.

`script`: `demo_turn "The server crashed last night. Find the log, tell me why without reading the whole thing, and point me at the code."`

`check`:

```bash
assert_cast_has "$1" 'pool.ts'
assert_cast_has "$1" 'tail'
assert_file_has src/pool.ts 'pool exhausted'
```

The payoff needs the model's answer to state the log's size or token estimate. If it does not, tune the prompt, for example by adding `Tell me how big the log was.`. This is the scenario most likely to hit the stop rule.

- [ ] **Step 3: Record and frame-check both, up to 5 takes each**

Use Task 1 Steps 7-8.

- [ ] **Step 4: Commit**

```bash
git add scripts/demos/scenarios/hotfix.sh scripts/demos/scenarios/triage.sh assets/demos/hotfix.gif assets/demos/triage.gif
git commit -m "docs: add hotfix and triage demo GIFs"
```

### Task 5: README demo block and first PR

**Files:**

- Modify: `README.md:18`
- Modify: `scripts/demos/README.md`

**Interfaces:**

- Consumes: the GIFs from Tasks 1-4 that passed, and `assets/demo.gif`.

- [ ] **Step 1: Replace `README.md:18` with the demo block**

One line first: `Real sessions with a real model. The apply? prompt comes from the example gatekeeper client, not the server.`

Then one `<details>` per kept GIF, in this order, leaving out any dropped by the stop rule. Slot 1 is `<details open>`. Use `<summary><b>...</b></summary>` and keep a blank line around each image, as the README's install dropdowns do.

| Slot | File                      | Starting summary                                                             |
| :--- | :------------------------ | :--------------------------------------------------------------------------- |
| 1    | `assets/demos/undo.gif`   | Undo restores the agent's change and keeps yours                             |
| 2    | `assets/demos/rename.gif` | Rename across a repo, reviewed as one diff, with dist/ and .env untouched    |
| 3    | `assets/demos/rescue.gif` | Bring back a deleted folder that git can't restore                           |
| 4    | `assets/demo.gif`         | Secret files stay hidden, and overwrites wait for your OK                    |
| 5    | `assets/demos/tidy.gif`   | Move files into an archive, then undo a move that overwrote one              |
| 6    | `assets/demos/review.gif` | Review different edits to three files as one diff before anything is written |
| 7    | `assets/demos/hotfix.gif` | A patch that no longer fits changes nothing                                  |
| 8    | `assets/demos/triage.gif` | Find a crash in a 14 MB log without reading it                               |

Each summary and alt text must describe the kept take. Slot 4 keeps its existing alt text. G is added in Task 7.

- [ ] **Step 2: Report coverage and page weight**

Add to the PR body: which of the 14 tools the kept takes show, any missing, any scenario dropped and why, and the summed GIF size. `list_roots` waits for G.

- [ ] **Step 3: Run the repository check**

Run: `npm run check`
Expected: passes. Run `graphify update .`.

- [ ] **Step 4: View the rendered README on the pushed branch**

Open the branch's README on GitHub after pushing. Expected: slot 1 open and playing, the others closed, every GIF plays when opened.

- [ ] **Step 5: Commit and open the PR, with the owner's go-ahead**

```bash
git add README.md scripts/demos/README.md
git commit -m "docs: show the server's strongest moments in README demos"
```

### Task 6: Dry runs refuse read-only roots

Independent of Tasks 1-5. Branch `fix/read-only-dry-run` from `main`.

**Files:**

- Modify: `src/core/rewrite.ts:83-86`
- Modify: `CHANGELOG.md` (`[Unreleased]`)
- Test: `__tests__/read-only-roots.test.ts`, in `describe('read-only roots over the MCP surface')`

**Interfaces:**

- Produces: `edit`, `patch`, and `replace_text` with `dryRun: true` behave as their live calls do under a read-only root.

- [ ] **Step 1: Write the failing tests**

Using the block's `pair`, with `rw/` writable and `ro/` read-only and the same content in `ro/x.txt` and `rw/x.txt`:

- `RO-DRY-001`: `edit` on `ro/x.txt` with `dryRun: true` gives `isError: true` and text containing `Read-only root:`.
- `RO-DRY-002`: `patch` on `ro/x.txt` with a fitting diff and `dryRun: true` gives `isError: true` and text containing `Read-only root:`.
- `RO-DRY-003`: `replace_text` over the whole root with `dryRun: true` has no `ro/x.txt` in its diff, shows `rw/x.txt`, and text contains `1 inaccessible entry`. It gives the same `totalMatches` as the same live call on a fresh copy.
- `RO-DRY-004`: `edit` on `rw/x.txt` with `dryRun: true` still returns its diff and leaves the file unchanged.
- `RO-DRY-005`: `edit` with `dryRun: true` on a symlink in `rw/` that resolves into `ro/` is refused with `Read-only root:`; skip via `trySymlink` when not permitted.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -- --test-name-pattern="RO-DRY"`
Expected: 001, 002, 003, and 005 FAIL; 004 passes.

- [ ] **Step 3: Change `locked` in `src/core/rewrite.ts`**

On a dry run, `await request.fs.pathGuard.validatePathForWrite(request.path)` before `body()`, still taking no lock. Keep the one-line comment true: a dry run takes no lock but answers the same refusals as a write.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test -- --test-name-pattern="RO-DRY"`
Expected: PASS.

- [ ] **Step 5: Add the changelog entry under `[Unreleased]`**

Under `### Fixed` (create it if absent): `**Dry runs refuse read-only roots.** edit, patch and replace_text with dryRun previewed changes that the live call refuses under --read-only-root. They now answer the same refusal.`

- [ ] **Step 6: Run the full check**

Run: `npm run check`
Expected: passes, with no change to the `__tests__/contract.test.ts` snapshot. Run `graphify update .`.

- [ ] **Step 7: Commit and open the PR for the owner to review and merge**

```bash
git add src/core/rewrite.ts __tests__/read-only-roots.test.ts CHANGELOG.md
git commit -m "fix: refuse dry runs under read-only roots"
```

### Task 7: Vendor GIF, after the release

**Blocked** until Task 6 is merged and on npm through the Release workflow, which the owner runs. Branch from `main` after Task 5 merges.

**Files:**

- Create: `scripts/demos/vendor-server.mjs`, `scripts/demos/scenarios/vendor.sh`
- Create: `assets/demos/vendor.gif`
- Modify: `README.md` (slot 9 of the demo block)

**Interfaces:**

- Consumes: `record.sh <slug>` and `lib.sh` from Task 1.
- Produces: `vendor-server.mjs` sets `process.env.FS_READ_ONLY_DIRS` to `/tmp/demo/my-app/vendor`, then imports the released package's `dist/index.js` installed under `/tmp/demo/.released`. `vendor.sh` exports `FS_MCP_BIN` to it.

- [ ] **Step 1: Confirm the wrapper works**

Install the released version under `/tmp/demo/.released`, then run gatekeeper with the wrapper and the task `Which folders can you access, and which are read-only?`.
Expected: the answer names `vendor` as read-only. If the wrapper fails, report to the owner before changing gatekeeper.

- [ ] **Step 2: Write `vendor.sh`**

`fixture`: `vendor/lib.js` and `src/x.ts`, each with `export const retries = 1;`.

`script`: `demo_turn "Set retries to 3 everywhere in this repo, including vendor/lib.js."`

`check`:

```bash
assert_file_has src/x.ts 'retries = 3'
assert_file_has vendor/lib.js 'retries = 1'
assert_cast_has "$1" 'vendor'
```

Reject at the frame check any take whose answer does not say `vendor/lib.js` was refused, or that previews a `vendor/` diff.

- [ ] **Step 3: Record and frame-check, up to 5 takes**

Use Task 1 Steps 7-8.

- [ ] **Step 4: Add slot 9 to the README**

Summary: `Mark a folder read-only and the agent can't change it`. Report `list_roots` coverage in the PR body, since G may not call it.

- [ ] **Step 5: Run the repository check**

Run: `npm run check`
Expected: passes.

- [ ] **Step 6: Commit and open the PR, with the owner's go-ahead**

```bash
git add scripts/demos/vendor-server.mjs scripts/demos/scenarios/vendor.sh assets/demos/vendor.gif README.md
git commit -m "docs: show read-only folders in a README demo"
```
