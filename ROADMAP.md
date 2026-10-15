# Roadmap

Written 2026-10-15 against v2.8.1 (`main` at `9dec437c`). It records an
evaluation of the project and what to build next. Update the status column
as items land, and re-evaluate when a phase is done.

## Where the project stands

The core is in very good shape. On Node 24 the full suite passes in about
60 seconds with 95.6% line and 90.8% branch coverage, CI is green on Ubuntu
and Windows, and the advertised MCP surface is pinned by a snapshot. The 13
tools cost about 18,700 characters (roughly 4,900 tokens) in `tools/list`.
Every call in a live probe answered quickly.

Strengths to keep:

- Security: path sandbox with symlink resolution, secret-file denylist,
  confirmations for overwrites, recursive deletes and new folders, RE2 regex,
  localhost-only HTTP by default.
- Reach: npm, Docker, the Claude Desktop extension, the MCP registry, and
  plugin marketplaces for Claude Code, Copilot CLI and Antigravity.
- Protocol: 2025-era clients and 2026-07-28 (`input_required`) over stdio and
  Streamable HTTP.
- Error messages that teach at the moment of the mistake, such as the
  zero-match hints added for [#55](https://github.com/j0hanz/filesystem-mcp/issues/55).

The weak spot is direction, not quality. Of the most recent 136 non-merge
commits, 41 are fixes and 7 are features, and the newest fixes chase narrow
races (a stalled directory read while `stat` counts entries). Hardening has
reached diminishing returns. The next gains come from helping models recover
from mistakes, making changes recoverable and auditable, the new protocol
extensions, and adoption.

## Gaps found

Each of these was reproduced against the built server.

| Gap                                  | What happens today                                                                                                                                              |
| :----------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A failed `edit` gives no help        | An `oldText` that differs only in whitespace, or has a one-character typo, returns `no match for oldText "…"; it must match the file exactly` and nothing more. |
| A wrong path gives no suggestion     | `read` of `src/ap.ts` returns `Path not found`, with `src/app.ts` next to it.                                                                                   |
| No compare-and-swap on writes        | `read` returns a SHA-256 with `includeHash`, but no write tool accepts it back to refuse a write over a changed file.                                           |
| Changes cannot be undone or reviewed | `delete` is permanent ("This cannot be undone"). Nothing keeps prior content, and nothing logs what the AI changed.                                             |
| Permissions are all or nothing       | `--read-only` applies to every root. There is no read-only root next to a writable one, and no way to turn off single tools.                                    |
| Documents and legacy encodings       | A PDF and a Latin-1 text file both return `Binary file detected.` The Latin-1 message is misleading.                                                            |
| No 2026-07-28 extensions             | The server negotiates no extensions: no Tasks for long calls, no MCP Apps.                                                                                      |
| Old Node fails cryptically           | On Node 20, startup dies with `does not provide an export named 'glob'` instead of naming the required version.                                                 |

## Now: housekeeping

| ID  | Item                                                                                                                                                                             | Status |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| N1  | Cut a release. 65 commits sit on `main` since v2.8.1, including the Unreleased security fix for glob patterns that froze the server. npm still serves 2.8.1.                     | TODO   |
| N2  | Triage GitHub: merge Dependabot PR #87, close the stale Copilot PR #59 and its issue #57, close spam issue #5.                                                                   | TODO   |
| N3  | Finish [plan 062](plans/062-ci-macos-and-node-next-legs.md): macOS and Node 26 CI legs. Node 26 enters LTS in October 2026. Plans 056 (flake root cause) and 061 are still open. | TODO   |
| N4  | Check the Node version before any import and exit with "needs Node.js 24 or later, found 20.x".                                                                                  | TODO   |

## Next: model ergonomics and trust (v2.9 / v3.0)

| ID  | Item                                                                                                                                                                                                                                                                                                         | Status |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| X1  | **Near-miss hints for `edit` and `patch`.** On no match, show the closest region as a short diff, and say when `ignoreWhitespace: true` would match. On several matches, list their line numbers. The most common agent failure loop, and the same teach-at-the-mistake approach as #55. Highest value item. | TODO   |
| X2  | **Did-you-mean on `NOT_FOUND`.** Suggest close names in the same folder, or the same basename elsewhere under the root, in the error's `suggestion`.                                                                                                                                                         | TODO   |
| X3  | **`expectedHash` on write tools** (`edit`, `patch`, `create`, `replace_text`). Refuse the write when the file no longer hashes to what the caller read. Matters most for a shared HTTP server and multi-agent use.                                                                                           | TODO   |
| X4  | **Audit log.** `--audit-log <file>` writes one JSON line per mutation: time, tool, path, hash before and after, and client. Small to build; teams value it.                                                                                                                                                  | TODO   |
| X5  | **Recoverable changes.** An opt-in trash for `delete`, and a short-lived journal of prior content per changed file that a `history` resource and one undo operation can use. The largest gap in a server whose pitch is safety.                                                                              | TODO   |
| X6  | **Finer permissions.** Per-root modes (for example `/docs:ro`) and a `--tools` allowlist. In clients that already have native read and edit tools, the allowlist also cuts `tools/list` tokens.                                                                                                              | TODO   |

Each item changes tool text or schemas, so each needs the contract snapshot
refreshed and the `tools/list` budget checked. Prefer new parameters,
resources, and error text over new tools.

## Later: bigger bets

| ID  | Item                                                                                                                                                                                                                                     | Status |
| :-- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----- |
| L1  | **MCP Tasks** for large searches and `replace_text`, which today stop at the per-call deadline (5 s by default) and most clients' 60 s timeout. Check what `@modelcontextprotocol/server` supports first.                                | TODO   |
| L2  | **MCP Apps diff review.** Render the diff of an overwrite, delete, or edit in the host with Approve and Decline, where the host supports MCP Apps. The [gatekeeper example](examples/clients/gatekeeper/) already does this out of host. | TODO   |
| L3  | **Documents and encodings.** Opt-in text extraction for PDF (and possibly DOCX) for the Claude Desktop audience, and a "not UTF-8 (looks like Latin-1)" refusal instead of "binary".                                                     | TODO   |
| L4  | **Agent eval harness.** Run real models through fixed tasks (rename a symbol, fix a bug, collect TODOs) and measure success, calls, and tokens. #51 and #55 were model misuse, so tool text changes should be measured, not guessed.     | TODO   |
| L5  | **Adoption.** A short demo GIF of the confirmation flow in the README, and a write-up or benchmark against the reference server built on the existing comparison table and the literal-search speedup.                                   | TODO   |

## Not doing, and limits

- **No shell or process execution.** That belongs to servers like Desktop
  Commander, and it would undercut the security story.
- **Keep about 13 tools.** Each costs 440 to 2,800 characters of `tools/list`
  on every request.
- **Slow the audit loop.** `docs/plan/` and `plans/` hold 197 files (about
  2.4 MB), more than `src/` (about 700 KB). Move finished plans to an archive
  branch, keep the ADRs, and set a "good enough" bar for rare edge cases
  before opening another audit round.
