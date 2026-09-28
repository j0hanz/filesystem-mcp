# MCP publishers: where filesystem-mcp is listed and where it should be

Refreshed 2026-09-28 against v2.6.1 (npm `latest`, published
2026-09-26T21:28Z). The first pass was dated 2026-09-27. Research and report
only: nothing was submitted, no PRs were opened, and no version fields were
edited.

Each publisher passed a validity check on 2026-09-28, beyond "the URL loads":

- **Product status.** No retirement notice from the owner, and no domain that
  has stopped resolving.
- **Repository status.** The repo is not archived and was pushed recently.
- **Throughput.** New submissions were actually accepted recently, where that
  can be measured.

## Changed since the 2026-09-27 pass

- **Done:** the legacy registry entry `io.github.j0hanz/filesystem-context`
  now has status `deprecated` (changed 2026-09-27T10:48Z, message "Renamed:
  use io.github.j0hanz/filesystem-mcp").
- **Done:** the plugin in `j0hanz/j0hanz-marketplace` has pinned its npx
  launcher to `@j0hanz/filesystem-mcp@2.6.1` and passes directory validation
  (PRs #3, #4, #5, all merged 2026-09-27).
- **Submitted:** Claude plugin directory, 2026-09-27 11:23 UTC, with the push
  webhook active (last delivery `200`). Pending review with two policy holds.
- **Submitted:** cursor.directory, 2026-09-27 11:26 UTC, as
  `j0hanz-filesystem-mcp`. Not public yet: a search for `j0hanz` on
  2026-09-28 found nothing.
- **Already in flight, missed last time:** punkpeye PR
  [#15135](https://github.com/punkpeye/awesome-mcp-servers/pull/15135) (opened
  2026-09-25) already rewrites the stale awesome-list line. Upstream `main` was
  merged into it on 2026-09-27. Its checks pass and it is mergeable.
- **Already in flight, missed last time:** Cline issue
  [#550](https://github.com/cline/mcp-marketplace/issues/550) (opened
  2025-12-12) is still open. It points at the old repo URL and carries a
  1024×1024 logo, where the form asks for 400×400.
- **Newly found listing:** ModelScope's MCP 广场 holds a stale
  `@j0hanz/filesystem-context` entry.
- **Newly found gaps:** TensorBlock awesome-mcp-servers, MCP.Directory, and
  the Kilo marketplace.
- **Newly retired:** Continue Hub, Roo Code, and mcp-get. mcpm.sh has
  stalled.

## What listings ask for, and what this repo already has

| Field | Value | Source in repo |
| :-- | :-- | :-- |
| Name | `@j0hanz/filesystem-mcp`; registry name `io.github.j0hanz/filesystem-mcp` | `package.json` (`mcpName`), `server.json` |
| Description | "Secure filesystem MCP server for reading, writing, searching, diffing, and patching files." | `server.json`, `package.json`, `mcpb/manifest.json` |
| Transports | stdio by default; Streamable HTTP with `--port` | `README.md` |
| Install | `npx -y @j0hanz/filesystem-mcp <dir>`; `ghcr.io/j0hanz/filesystem-mcp`; `.mcpb` | `server.json` `packages` (npm + OCI), `README.md` |
| Tools | 13: list_roots, list, find_files, stat, search_text, diff, read, create, edit, move, delete, replace_text, patch | `mcpb/manifest.json` |
| License | MIT | `LICENSE` |
| Logo | `assets/logo.png`, 400×400 PNG | `assets/logo.png` |
| Privacy policy | README `#privacy-policy` | `README.md`, `mcpb/manifest.json` |
| Glama claim | `maintainers: ["j0hanz"]` | `glama.json` |

The Release workflow (`.github/workflows/release.yml`) publishes these on
every release:

- **npm**, with provenance (`npm publish --provenance`).
- **GHCR** image.
- **Official MCP Registry**, through the pinned `mcp-publisher` with
  `login github-oidc`.
- **`.mcpb` bundle**, attached to the GitHub release.
- **Smithery**, in the MCPB job.

The Claude Code plugin wrapper lives outside this repo, in
`j0hanz/j0hanz-marketplace` under `plugins/filesystem-mcp`.

**Rename debt.** The repo was renamed from `filesystem-context-mcp-server`,
and the old URL redirects. The old npm names were:

- `@j0hanz/filesystem-context-mcp`, which now returns 404 on npm.
- `@j0hanz/fs-context-mcp`, which is deprecated.

Most stale rows below come from the rename.

## 1. Current listings

"Auto" means the directory indexed the server without a submission from you.

| Place | URL (visited 2026-09-28) | Version shown | Stale or incomplete | How it's fed |
| :-- | :-- | :-- | :-- | :-- |
| npm | https://www.npmjs.com/package/@j0hanz/filesystem-mcp | 2.6.1 | Current. 4,188 downloads 2026-08-28 to 2026-09-26 ([api](https://api.npmjs.org/downloads/point/last-month/@j0hanz/filesystem-mcp)) | Release workflow |
| Official MCP Registry | https://registry.modelcontextprotocol.io/v0/servers?search=io.github.j0hanz/filesystem-mcp&version=latest | 2.6.1, `active` | Current | Release workflow |
| Official MCP Registry (legacy) | https://registry.modelcontextprotocol.io/v0/servers?search=io.github.j0hanz/filesystem-context&version=latest | 1.0.9, `deprecated` | Fixed 2026-09-27 | Manual, 2025-12 |
| GHCR | https://github.com/j0hanz/filesystem-mcp/pkgs/container/filesystem-mcp | 2.6.1 | Current | Release workflow |
| GitHub release (`.mcpb`) | https://github.com/j0hanz/filesystem-mcp/releases/tag/v2.6.1 | 2.6.1 | Current | Release workflow |
| Smithery | https://smithery.ai/server/j0hanz/filesystem-mcp ([data](https://registry.smithery.ai/servers/j0hanz%2Ffilesystem-mcp)) | Not shown | Current description, 13 tools; `verified: false` | Release workflow |
| Glama | https://glama.ai/mcp/servers/j0hanz/filesystem-mcp | v2.5.0, inspected 2026-09-24 | **Two releases behind.** v2.6.0 and v2.6.1 not yet inspected | Auto from GitHub, plus `glama.json` |
| LobeHub | https://lobehub.com/mcp/j0hanz-filesystem-mcp ([data](https://market.lobehub.com/api/v1/plugins/j0hanz-filesystem-mcp)) | 1.19.1 (npm artifact pinned to 1.14.0) | **Stale.** 18 old tools (for example `roots`); validated 2026-04-18; `isClaimed: false`; 139 installs. Synced 2026-09-28, but the version did not move | Auto |
| LobeHub (duplicate) | https://lobehub.com/mcp/j0hanz-filesystem-context-mcp-server | 1.4.0 | **Unpublished 2026-09-28** (claimed; `plugin republish` reverses it). Was broken: Old repo; npm package does not exist; 4 installs | Auto |
| LobeHub (duplicate) | https://lobehub.com/mcp/j0hanz-fs-context-mcp-server | 2.7.6 | **Unpublished 2026-09-28** (claimed; `plugin republish` reverses it). Was stale: Deprecated `@j0hanz/fs-context-mcp`; 5 installs | Auto |
| PulseMCP | https://www.pulsemcp.com/servers/filesystem-context | None; "released" Dec 12, 2025 | **Stale.** Package field now shows `io.github.j0hanz/filesystem-mcp`, but title "Filesystem Context" and "read-only" description remain. 1.2k visitors this week, 6.4k total | Auto from the official registry; edits paused |
| mcp.so | https://mcp.so/servers/filesystem-context-mcp-server | None | **Fixed 2026-09-28** by claiming and editing the entry: name "Filesystem MCP", `@j0hanz/filesystem-mcp@latest` config, 13 fetched tools, new tags and overview. Still stale: the "About" line says "Read-only…", and the slug keeps the old name | Submitted 2025; claimed and edited 2026-09-28 |
| ModelScope MCP 广场 | https://www.modelscope.cn/mcp ([API](https://www.modelscope.cn/openapi/v1/mcp/servers/@j0hanz/filesystem-context)) | `@j0hanz/filesystem-context-mcp@1.0.9` | **Broken install.** Same 404 package; old repo; "Read-only"; 59 views; `is_verified: false`. No entry for the current name | Auto; version matches the legacy registry entry |
| awesome-mcp-servers (punkpeye) | https://github.com/punkpeye/awesome-mcp-servers (README line 2001) | None | **Stale, fix pending.** Old repo link and "Read-only" text. PR #15135 replaces it | Old PR #1540 |
| Cline marketplace | https://github.com/cline/mcp-marketplace/issues/550 | None | **Not listed; stale submission open.** Old repo URL; 1024×1024 logo; no comments in 9.5 months | Your issue |
| Own Claude Code marketplace | https://github.com/j0hanz/j0hanz-marketplace (`plugins/filesystem-mcp`) | 2.6.1, pinned | Current | You maintain it |

## 2. Gaps, ranked by reach ÷ effort

Reach is **H**, **M**, or **L**. Star counts come from the GitHub API on
2026-09-28. Directories' own traffic claims are marked "self-reported".

Effort grades:

- **S**: one form, issue, comment, or CLI call, with no change in this repo.
- **M**: needs a new file here, or a cross-repo change.
- **L**: blocked, or needs a new build artifact.

The Throughput column shows whether the publisher is accepting new
third-party servers now.

| # | Publisher | Listed? | Submission method | Requirements and gates | Files to change here | Reach signal | Throughput | R / E | Source URL |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | Claude plugin directory (claude.ai, Cowork, Claude Code) | **Submitted** 2026-09-27, pending review. Not live yet: 0 of 314 entries in `anthropics/claude-plugins-official` match | Portal https://claude.ai/directory/manage, choose "Plugin bundle", path `plugins/filesystem-mcp` | Blocking items are met: exact pin, README of 40+ words, license. **Always held** for "Runs a pinned npx or uvx package". A name of generic words may be held for "Name may be confused with an existing listing" | None (the marketplace repo is already done) | claude-plugins-official 37.1k stars | Active: catalog pushed 2026-09-25 | H / S (wait) | https://claude.com/docs/plugins/pre-submission-checklist |
| 2 | awesome-mcp-servers (punkpeye) | Stale entry; PR #15135 open | PR (already open) | `check-submission` passes; labels `has-glama`, `valid-name`; mergeable | None | 95.6k stars | High: about 940 PRs merged 2026-08-29 to 2026-09-27, in batches; the last batch was 2026-09-23; 2,487 PRs open | H / S (wait) | https://github.com/punkpeye/awesome-mcp-servers/pull/15135 |
| 3 | mcp.so | **Done.** The old entry was claimed and edited in place instead of submitting a new one | **Claim** on the listing, then edit the fields. **Fetch tools** runs the Config in a Node 22 sandbox, which needed the 2.6.2 fix for `RegExp.escape` | Author claim through GitHub sign-in | None | 266K MAU (self-reported) | Active: entries "Added in 4 hours", "Added yesterday" | Done | https://mcp.so/servers/filesystem-context-mcp-server |
| 4 | cursor.directory | **Submitted** 2026-09-27 as `j0hanz-filesystem-mcp`; not public yet (search for `j0hanz` finds nothing). Slug `filesystem-mcp` is the reference server | Web form https://cursor.directory/plugins/new, signed in with GitHub | Cursor staff call it "the recommended place to publish for most plugins right now" | None; README already has an Add to Cursor deeplink | "89.1k+ developers" (self-reported) | Active | M / S (wait) | https://cursor.directory/plugins/filesystem-mcp, https://forum.cursor.com/t/cursor-marketplace-submission/170458 |
| 5 | TensorBlock awesome-mcp-servers and MCP Index | **Submitted** 2026-09-28 as issue #2760 (`ready-for-pr`) | Issue form `add-mcp-server.yml` (auto-drafts a PR), or a PR to `docs/filesystems.md` | Clear category plus metadata; claim a profile with `claim-profile.yml` | None | 868 stars; hosted index API | **High:** 921 PRs merged since 2026-07-01; 5 open | M / S | https://github.com/TensorBlock/awesome-mcp-servers |
| 6 | LobeHub: claim and update the stale entries | **Done** 2026-09-28: all 3 claimed; main entry updated to 2.6.2 | `npx -y @lobehub/market-cli login`, `github connect`, `plugin claim j0hanz-filesystem-mcp`, `plugin update` | Repo ownership through GitHub connect; `lhm.plugin.json` with owner-declared `identifier`, `name`, `version`; Node 22+; interactive browser login | **Add** `lhm.plugin.json` at the repo root. Its `version` would need to track releases | lobe-chat 82.9k stars; 139 installs on the main entry | Same-day (self-reported by submitmap) | M / M | https://lobehub.com/publish-mcp/skill.md |
| 7 | MCP.Directory | No: search for `j0hanz` finds "No servers found" | Web form https://mcp.directory/submit: repo URL, optional npm name | Reviewed "within 24 hours". Claim an existing entry by email to hello@mcp.directory | None | Claims "largest curated directory" (self-reported); no independent signal | Unverified | L / S | https://mcp.directory/submit |
| 8 | ModelScope MCP 广场: new entry and old one fixed | Old, broken entry only | "创建MCP" (Create MCP) on the page; needs a ModelScope login | Form not visible without login | None | 12,526 servers; top entries have 100M+ views | Active listing count | M / S | https://www.modelscope.cn/mcp |
| 9 | Cline marketplace: refresh issue #550 | Stale submission | Edit your own issue: new repo URL and a 400×400 logo | Tested in Cline; reviewed on "adoption and GitHub metrics" | None. Optional: `llms-install.md` | cline/cline 69k stars | **Low:** 47 of 926 issues since 2026-06-01 closed as completed | H reach, low odds / S | https://github.com/cline/mcp-marketplace |
| 10 | mcpservers.org (wong2 list) | **Submitted** 2026-09-28 (free plan, File System, with the registry name). The site says "Review within 2 weeks" and approval arrives by email | Web form https://mcpservers.org/submit; free, or $39 | wong2 README: "We do not accept PRs" | None | wong2 list 4.3k stars | Unverified; wong2 repo last pushed 2026-07-13 | M / S | https://github.com/wong2/awesome-mcp-servers |
| 11 | MCP Market (mcpmarket.com) | **Yes, ×3.** The site's search missed them; submitting returned "already listed". Current entry: [/server/filesystem-30](https://mcpmarket.com/server/filesystem-30). Stale, read-only: [/server/filesystem-context](https://mcpmarket.com/server/filesystem-context) and [/server/fs-context](https://mcpmarket.com/server/fs-context). Each page offers "Claim this listing" to the repo owner | Web form `/submit` | Not documented | None | No independent signal | Unverified | L / S | https://mcpmarket.com/search?q=j0hanz |
| 12 | Kilo marketplace | No. `mcps/filesystem` is the reference server | PR adding `mcps/<id>/MCP.yaml` (id, name, description, author, url, category, npx content, parameters) | Contributions "through pull requests only" | None here | Kilo 27.4k stars; marketplace repo 183 stars | **Low:** 6 PRs merged since 2026-07-01, 1 of them a third-party MCP; 156 open | M reach, low odds / S | https://github.com/Kilo-Org/kilo-marketplace |
| 13 | ToolHive catalog (Stacklok) | No | PR adding `registries/toolhive/servers/<name>/server.json` | Upstream schema, container package, `_meta` | None; reuse `server.json`'s OCI block | stacklok/toolhive 2.2k stars | **Slow:** 2 new servers merged since 2026-06-01 | L / S | https://github.com/stacklok/toolhive-catalog |
| 14 | Docker MCP Catalog | No: only `filesystem` and `rust-mcp-filesystem` | PR to `docker/mcp-registry` with `server.yaml` and `tools.json` | Docker team review | None; the existing `Dockerfile` builds | Docker Desktop base; repo 562 stars | **Stalled:** last new server merged 2026-04-30 | M reach, low odds / M | https://github.com/docker/mcp-registry |
| 15 | GitHub MCP Registry (VS Code `@mcp`) | No: `api.mcp.github.com` search for `j0hanz` returns `total: 0` | No public path; curated | Blocked | None | VS Code base | Curated only | H / L | https://api.mcp.github.com/oss/v0.1/servers?search=j0hanz |

### Retired, closed, or stalled

None of these needs a submission.

| Publisher | Status | Source URL |
| :-- | :-- | :-- |
| Continue Hub | **Retired.** `hub.continue.dev` returns NXDOMAIN and `continue.dev/hub` returns 404. Reports say Cursor acquired Continue and shut the Hub after 2026-07-15 | https://www.bodegaone.ai/blog/cursor-acquires-continue-dev (secondary); DNS check 2026-09-28 |
| Roo Code marketplace | **Archived** repo; last push 2026-05-15 | https://github.com/RooCodeInc/Roo-Code |
| mcp-get | **Archived**: "mcp-get is no longer maintained" | https://github.com/michaellatman/mcp-get |
| mcpm.sh registry | **Stalled:** 0 PRs merged since 2026-07-01 | https://github.com/pathintegral-institute/mcpm.sh |
| Gemini CLI extension gallery | **Retired** for individual accounts on 2026-06-18; replaced by Antigravity | https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ |
| Antigravity MCP Store | Curated; no way to submit | https://antigravity.google/docs/mcp |
| PulseMCP | Paused: "not accepting new MCP server or client submissions right now… not making changes to existing listings"; ingests the official registry when it resumes | https://www.pulsemcp.com/submit |
| Zed | Deprecating MCP extensions in favour of the official registry (done) | https://zed.dev/docs/extensions/mcp-extensions |
| Devin Desktop (formerly Windsurf) | "Cascade does not have an MCP Marketplace" | https://docs.devin.ai/desktop/cascade/mcp |
| Claude Desktop extension directory | "No longer accepts MCPB submissions"; use gap row 1 | https://claude.com/docs/connectors/building/mcpb |
| goose extensions directory | "New directory submissions are no longer accepted" | https://github.com/aaif-goose/goose |
| LM Studio | No directory; deeplink only | https://lmstudio.ai/docs/app/mcp |
| Cursor first-party marketplace | Curated; use cursor.directory (gap row 4) | https://forum.cursor.com/t/cursor-marketplace-submission/170458 |
| appcypher/awesome-mcp-servers | **Archived** | https://github.com/appcypher/awesome-mcp-servers |

### Auto-indexers fed by artifacts you already publish

One upstream fix can refresh several listings downstream.

| Artifact | Feeds | Implication |
| :-- | :-- | :-- |
| Official MCP Registry entry | PulseMCP (confirmed: its package field already follows the new name); ModelScope (inferred: its config matches legacy entry 1.0.9); MCP.Directory ("auto-discovery from the official MCP Registry", but it does not list the server); Zed (planned); GitHub/VS Code (promised, not live) | The 2026-09-27 deprecation is the upstream fix. PulseMCP's title and description will not change until its edits resume. ModelScope and MCP.Directory have not re-ingested since then |
| GitHub repo and README | Glama (re-inspects releases; two behind); LobeHub (crawls, but the version stays frozen at 1.19.1 while unclaimed) | LobeHub will not refresh by itself. Claiming it (gap row 6) is the only lever found |
| `.mcpb` and release workflow | Smithery | Current. No gap |

## 3. Top 5 next actions

Each action fits one sitting. The order follows reach ÷ effort, discounted
by throughput, and skips work that is already done or in flight.

1. **Finish the mcp.so entry (about 2 min).** Plan Task 6 is mostly done
   (claimed and fixed 2026-09-28). Replace the "About" line with the
   canonical description, and delete the stray instruction text at the top
   of the FAQ field.
2. **TensorBlock: submitted.** Issue
   [#2760](https://github.com/TensorBlock/awesome-mcp-servers/issues/2760)
   was filed 2026-09-28 and labelled `ready-for-pr`. The draft-PR workflow
   is queued. Recent submissions closed within 30 min to 1 day.
3. **LobeHub: done 2026-09-28.** All three entries are claimed.
   `j0hanz-filesystem-mcp` was updated from 1.19.1 to 2.6.2, with 13 tools,
   3 resources and 1 prompt, generated by `plugin init --stdio` from the
   live server. The public API is CDN-cached (`max-age=14400`), so the page
   lags by up to 4 hours. `lhm.plugin.json` stays out of the repo: it is
   regenerated with `plugin init` when the tools change, so no fourth
   version field is added.
   - **Login gotcha:** on this machine the CLI's OAuth callback listens on
     `[::1]` while the browser calls `127.0.0.1`. Run the login with
     `NODE_OPTIONS=--dns-result-order=ipv4first`.
   - The crawler-owned `artifacts.npm.version` (1.14.0) is not settable
     from the manifest.

4. **Cline #550: refreshed 2026-09-28.** New title, repo URL, 400×400 logo
   (raw `assets/logo.png`) and 13 tools. The two "Installation Testing"
   boxes were left unticked until the server is tested in Cline.
5. **MCP.Directory: form sent 2026-09-28**, with the repo URL, npm package
   and canonical description, and no email. The confirmation screen was not
   captured. Review is "within 24 hours", so check
   https://mcp.directory/servers?q=j0hanz on 2026-09-29.

These can be batched afterwards, each about 10 minutes:

- ModelScope "创建MCP" (row 8), plus a request to retire the old entry.
- MCP Market (row 11): claim the two stale entries, `filesystem-context` and
  `fs-context`, and point them at the current repo or ask for their
  removal. mcpservers.org (row 10) was submitted 2026-09-28.

**Waiting, nothing to do:**

- Claude plugin directory review (row 1). Publish the first version by hand
  once it is approved.
- cursor.directory moderation (row 4).
- punkpeye PR #15135 (row 2), until the next merge batch.

Leave Kilo, ToolHive, and Docker until their throughput picks up.

## Sources and method

**Live checks on 2026-09-28** ran with `curl` or `gh` against public JSON
APIs:

- npm registry and downloads.
- MCP Registry `v0` search.
- Smithery registry.
- LobeHub market API.
- ModelScope OpenAPI (`PUT /openapi/v1/mcp/servers`).
- TensorBlock index API.
- `api.mcp.github.com`.
- GitHub API for stars, archive flags, last push, PR and issue state, merge
  counts, and catalog contents (`claude-plugins-official` marketplace.json,
  Kilo `mcps/`, Docker `servers/`, TensorBlock `docs/filesystems.md`).

HTML pages were read with WebFetch: PulseMCP, mcp.so entry, Glama, the
Claude pre-submission checklist, and PulseMCP /submit. Pages that need
JavaScript were read in Chrome through `agent-browser`: cursor.directory,
ModelScope, mcp.so search, MCP Market, MCP.Directory, LobeHub, and Continue.

**Throughput measures:**

- punkpeye: count of "Merge pull request" commits since 2026-08-29.
- Cline: issues closed as completed since 2026-06-01.
- Kilo, TensorBlock, mcpm, and ToolHive: merged PRs since 2026-07-01 or
  2026-06-01.
- Docker: date of the last "Add" merge.
- mcp.so: latest "Added" times.

**Could not verify:**

- mcpservers.org served a Cloudflare challenge to every client, so its row
  says unverified rather than "not listed".
- The Claude developer portal is private. The Claude and cursor.directory
  submission statuses come from the 2026-09-27 working session, in which
  the maintainer reported each submission. The webhook's `200` delivery was
  checked through the GitHub API.
- The Continue Hub shutdown comes from secondary reports. The primary
  evidence is the dead domain.
