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
npm run tdqs         # score tool definitions on tdqs.dev into tdqs-report.md; needs TDQS_API_KEY, spends 1 of 30 daily calls
```

Tests run on Node's built-in test runner; `npm test --
--test-name-pattern="resources"` filters like the old wrapper did.

`__tests__/dist-smoke.test.ts` boots `dist/index.js`; it skips when `dist/`
is absent, so run `npm run build` (or `npm run check`) first to exercise it.

`__tests__/contract.test.ts` snapshots the advertised MCP surface (tools,
prompts, resource templates, capabilities, instructions, get-help text). When a contract
change is intended, run `node --test --test-update-snapshots __tests__/contract.test.ts`
with no `FS_*` variables set, and commit the `.snapshot` diff with the change.

`__tests__/tool-harness.ts` drives one tool's `run` with a minimal `ToolCtx`,
no MCP pair (`runToolBodyResult(STAT, args, { roots })`). Test payload assembly
through it in the tool's own file (`__tests__/stat.test.ts`) and keep the wire
(in-memory client) for what the executor adds.

## Releases

Versions are bumped by the Release workflow (`workflow_dispatch`), which keeps
`package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`,
and `.cursor-plugin/plugin.json` in sync. Never hand-edit any of those versions.
