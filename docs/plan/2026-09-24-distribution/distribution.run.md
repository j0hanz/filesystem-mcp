# Run: Fix stale listings and list filesystem-mcp on the live directories

Executing [`distribution.plan.md`](distribution.plan.md) against
[`publishers.md`](publishers.md). Started 2026-09-27 at `45c5bab7` (v2.6.1)
and continued 2026-09-28. Most submissions were done by the maintainer in
the browser; the rows record who acted.

- **1** 2026-09-27 — done. PR
  [j0hanz-marketplace#3](https://github.com/j0hanz/j0hanz-marketplace/pull/3)
  pins `.mcp.json` to `@j0hanz/filesystem-mcp@2.6.1`. The maintainer first
  closed it (10:31, preferring `@latest`), then reopened and merged it (10:37
  UTC). The pin is live on `main`.
- **2** 2026-09-27 — done. `mcp-publisher status --status deprecated
  --all-versions` on `io.github.j0hanz/filesystem-context` at 10:48 UTC.
  Verified: legacy entry `1.0.9 deprecated`, `io.github.j0hanz/filesystem-mcp
  2.6.1 active`. Deviation: the first attempt timed out during a registry
  outage, and the login token expired, so `login github` was run a second
  time.
- **3** 2026-09-27 — pending upstream. The maintainer had already opened
  [punkpeye#15135](https://github.com/punkpeye/awesome-mcp-servers/pull/15135)
  on 2026-09-25, and research missed it. Instead of a new PR, upstream
  `main` was merged into it (`41569c7f`, no force-push). The diff is one
  line in `README.md`, the Glama check passes, and the PR is `MERGEABLE`.
  Still open on 2026-09-28, waiting for a merge batch.
- **4** 2026-09-27 — submitted, pending review. Validation first blocked
  on `${CLAUDE_PROJECT_DIR}` in `.mcp.json`. Fixed by literal
  `--allow-cwd --root-boundary .` plus `icon.svg` in
  [#4](https://github.com/j0hanz/j0hanz-marketplace/pull/4), then listing
  links in [#5](https://github.com/j0hanz/j0hanz-marketplace/pull/5).
  Revalidated at `ed530ca`: 0 blocking, 2 policy holds
  (`LAUNCHER_PACKAGE_REVIEW`, `COMMAND_SCRIPT_NOT_FOLLOWED`). Submitted
  11:23 UTC. The push webhook's last delivery returned `200`.
- **5** 2026-09-27 — submitted, pending moderation. cursor.directory, as
  `j0hanz-filesystem-mcp`, at 11:26 UTC. On 2026-09-28 a search for
  `j0hanz` still found nothing.
- **6** 2026-09-28 — done, with a deviation. The old mcp.so entry was
  claimed and edited in place instead of submitting a new one plus a
  removal ticket. Its **Fetch tools** failed with `MCP error -32000:
  Connection closed (at main (…/dist/index.js:103:29))`. The cause: the
  mcp.so sandbox runs Node 22, and `RegExp.escape` exists only from Node
  24. This was reproduced in WSL with Node 22.20.0, and a config trick
  using `-p node-linux-x64@24` did not help in their sandbox. Fixed by
  [#40](https://github.com/j0hanz/filesystem-mcp/pull/40) (`escapeRegExp`
  fallback), released as **v2.6.2**. The release's `publish-mcp` job hit
  the npm 404 race and passed on `rerun --failed`. After the release,
  Fetch tools listed 13. The "About" line still renders the old text
  although the edit form shows the new one. A maintainer comment on the
  listing covers the rename.
- **7** 2026-09-28 — partly done.
  - **Cline:** issue
    [#550](https://github.com/cline/mcp-marketplace/issues/550) already
    existed and was edited in place: title, repo URL, 400×400 logo, 13
    tools. The "Installation Testing" boxes were left unticked until the
    server is tested in Cline.
  - **mcpservers.org:** submitted on the free plan, File System, with
    registry name `io.github.j0hanz/filesystem-mcp`. The site replied "Review
    within 2 weeks".
  - **MCP Market:** submitting returned "already listed". Three entries
    exist: `/server/filesystem-30` is current, while `/server/filesystem-context`
    and `/server/fs-context` are stale. Claiming them needs the
    maintainer's GitHub sign-in. Not done.
- **8** 2026-09-28 — this log.

## Beyond the plan

Added after the 2026-09-28 refresh of [`publishers.md`](publishers.md):

- **TensorBlock:** issue
  [#2760](https://github.com/TensorBlock/awesome-mcp-servers/issues/2760)
  was filed by the maintainer and labelled `ready-for-pr`. The draft PR
  [#2761](https://github.com/TensorBlock/awesome-mcp-servers/pull/2761) is
  open.
- **MCP.Directory:** the form was sent without an email. The confirmation
  screen was not captured, and on 2026-09-28 a search for `j0hanz` still
  showed "No servers found". Check again on 2026-09-29.
- **LobeHub:**
  - All 3 entries were claimed with `@lobehub/market-cli`.
    `j0hanz-filesystem-mcp` was updated from 1.19.1 to 2.6.2 from a
    manifest built by `plugin init --stdio` (13 tools, 3 resources, 1
    prompt). The manifest was kept outside the repo.
  - `j0hanz-filesystem-context-mcp-server` and `j0hanz-fs-context-mcp-server`
    were unpublished (`plugin republish` reverses it).
  - The public API is CDN-cached for up to 4 hours.
  - Login gotcha: the OAuth callback listened on `[::1]` while the browser
    called `127.0.0.1`. It worked with
    `NODE_OPTIONS=--dns-result-order=ipv4first`.

## Open

- [ ] MCP Market: claim `filesystem-context` and `fs-context`
  (maintainer).
- [ ] ModelScope: new entry through "创建MCP", and retire
  `@j0hanz/filesystem-context` (maintainer login).
- [ ] Cline #550: test in Cline, then tick both boxes (maintainer).
- [ ] mcp.so: the "About" line still shows the old text.
- [ ] Waiting on others: Claude directory review, cursor.directory,
  punkpeye #15135, TensorBlock #2761, mcpservers.org, MCP.Directory.
- [ ] Glama still shows v2.5.0 as inspected; no way to trigger a
  re-inspect was found.

## Done

- [x] Legacy registry entry `deprecated`, current entry `2.6.2 active`.
- [x] npm `latest`, GHCR, the MCP Registry and the `.mcpb` asset all at
  2.6.2.
- [x] mcp.so and LobeHub serve the current package and 13 tools.
- [x] `git status` shows only `docs/plan/2026-09-24-distribution/` as
  untracked. No version field was hand-edited.
