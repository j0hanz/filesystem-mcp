# filesystem-mcp

MCP server exposing guarded filesystem tools (read, write, search, diff, patch)
over stdio and Streamable HTTP.

## Commands

```bash
npm run check        # full repository check (static + tests)
npm run fix          # format and lint-fix, then run the full check
npm run check:static # static checks only, no tests
npm test             # Node test runner; pass native flags after --
npm run test:coverage # tests + src coverage floor (CI enforces it on ubuntu)
```

Tests run on Node's built-in test runner; `npm test --
--test-name-pattern="resources"` filters like the old wrapper did.

`__tests__/dist-smoke.test.ts` boots `dist/index.js`; it skips when `dist/`
is absent, so run `npm run build` (or `npm run check`) first to exercise it.

`__tests__/contract.test.ts` snapshots the advertised MCP surface (tools,
prompts, resource templates, capabilities, instructions, get-help text). When a contract
change is intended, run `node --test --test-update-snapshots __tests__/contract.test.ts`
with no `FS_*` variables set, and commit the `.snapshot` diff with the change.

## Architecture

```text
index.ts ──cli──► transport.ts (facade)
  ├─► transport/stdio.ts   one pinned server per connection
  └─► transport/http.ts    fresh server per request, shared runtime state
        └─► server.ts createServer() ──► tools/ prompts/ resources/
                core/     PathGuard, stores, undo, errors, config
```

- `src/server.ts` `createServer()` builds the `McpServer` and registers
  tools/prompts/resources. Its `extraDeps` let the HTTP leg share one
  `PathGuard`/`ResourceStore`/`PageSnapshotStore`/`UndoJournal`/watcher
  registry across per-request instances; when omitted (stdio) the instance
  owns them and clears them on close.
- Two protocol eras: `legacy` (initialize handshake, pinned connection) and
  `modern` (stateless per-request HTTP). `ToolDeps.era` carries it; sunset
  plan in `docs/adr/002-legacy-protocol-paths-sunset.md`. Other decisions in
  `docs/adr/`.
- Every tool is a `ToolDef` (`src/tools/define.ts`); `ToolExecutor` wraps every
  call with relative-path resolution, the access-grant `input_required`
  round-trip, undo capture, progress, and the stdio 10 MiB oversize refusal.
  `src/tools/index.ts` owns the tool inventory and the `--read-only` gate.
- `src/core/path.ts` `PathGuard` owns allowed-roots assembly and per-path
  validation (symlink resolution, Windows path spellings); the sensitive-file
  denylist is `src/core/sensitive.ts`.
- No tool publishes an `outputSchema`; tools that author text ship metadata
  under `_meta`, the rest use `structuredContent` (see `buildSuccessResponse`).

## Releases

Versions are bumped by the Release workflow (`workflow_dispatch`), which keeps
`package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`,
and `.cursor-plugin/plugin.json` in sync. Never hand-edit any of those versions.
