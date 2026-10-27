# ADR-004: Do not serve Agent Skills through the MCP skills extension yet

**Status**: proposed, 2026-10-27
**Deciders**: j0hanz, in the design spike for issue #133

## Context

SDK 2.4.0 ships `@modelcontextprotocol/server/ext/skills`, an implementation
of [SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension)
(status Final). `SkillsExtension.attach(mcp)` is marked `@experimental`. It
registers `skills/list`, `skills/get`, `resources/directory/read` and the
resource template `skill://{+path}`, and advertises
`extensions: { "io.modelcontextprotocol/skills": { directoryRead: true } }`.

Two shapes were on the table:

- **A.** Serve `SKILL.md` folders found inside the allowed roots (for
  example `<root>/.claude/skills/*`) as a skill catalog.
- **B.** Serve this server's own usage guide as one skill, next to the
  `get-help` prompt and `internal://instructions`.

The bar for building either was set before looking at support: a shipped,
stable client release must implement the extension. Preview, flag-gated or
nightly support does not count.

The official [client matrix](https://modelcontextprotocol.io/extensions/client-matrix),
read on 2026-10-27, lists Skills as "Partial" for ChatGPT, fast-agent and the
MCP Inspector (verify CLI only). Claude Desktop, Claude web, VS Code GitHub
Copilot, Cursor and Goose are blank. Claude Code and Codex are not listed,
and no changelog entry adding skills support to either was found. This
server reaches most users through coding-agent plugins (Claude Code, Codex,
Cursor), and none of those can consume the extension.

## Decision

**No-go.** Build neither shape now. One chat client with partial support
does not justify a new `@experimental` surface, a snapshot change and a
flag to maintain.

Revisit when Claude Code, Claude Desktop, Codex, Cursor or VS Code GitHub
Copilot shows Skills support on the client matrix.

## Design if revisited

The spike answered the five questions in #133 so a later build can start
here instead of repeating it.

- **Shape B first.** Build the skill from `memorySkillFiles(...)` rendered
  from `buildSectionsRecord` (`src/instructions.ts`), the same source as
  `internal://instructions` and `get-help`. It touches no filesystem. Keep
  the prompt and the resource while the extension is experimental.
- **Shape A only behind an opt-in that names the skill directories.**
  Discovery anywhere under the roots is ruled out: a cloned repository could
  plant a `SKILL.md` whose text the client then loads as instructions, where
  `read` today returns the same bytes only as data.
- **Reads go through `PathGuard`.** Never use `nodeSkillFiles`: it rejects
  `..` and symlinked entries but not symlinked parent directories, and it
  knows nothing of the sensitive-file denylist. Pass a custom `SkillFiles`
  adapter (`{ list(dir), read(path) }`) that calls `validateExistingPath`
  then `readFileBufferWithLimit` (`src/core/read.ts`) on every call.
- **No root-change hook.** `PathGuard` has no change event, and per-read
  validation is the security boundary. A stale catalog entry fails safe: it
  is listed, its read is refused. The catalog reloads on restart.
  `SkillCatalog.reload()` exists if a hook is ever worth adding.
- **Both eras.** The catalog holds metadata only and no per-session state.
  `attach` changes `getCapabilities()`, which feeds both `initialize` and
  `server/discover`. Share one catalog through `createServer`'s `extraDeps`
  and attach it on every instance, so the HTTP leg's per-request servers
  advertise it too. `attach` throws once a server is connected, so it must
  run inside `createServer` before `connect`.
- **Contract.** `capabilities.extensions` and the `skill://{+path}`
  resource template change in both the full and `--read-only` snapshots of
  `__tests__/contract.test.ts`. Serving skills is read-only, so they stay on
  under `--read-only`. Skill files also appear in `resources/list`, which
  the contract test does not snapshot.
- **Gate.** Off by default: `--experimental-skills` /
  `FS_EXPERIMENTAL_SKILLS`, following `--read-only`. Drop the
  `experimental` prefix once the SDK does.
- **Cost.** B is about one new file, the flag, one test and a snapshot
  update. A adds the adapter, directory configuration and symlink and
  denylist tests: roughly three to four files on top of B.

## Consequences

- Clients that do support the extension (ChatGPT, fast-agent) keep using
  `get-help` or `internal://instructions` for this server's guidance.
- Nothing changes in the advertised MCP surface, so the contract snapshots
  stay as they are.
- An SDK upgrade that changes the experimental `attach` API costs nothing
  here until the revisit trigger fires.
