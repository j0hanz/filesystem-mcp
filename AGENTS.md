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

## Releases

Versions are bumped by the Release workflow (`workflow_dispatch`), which keeps
`package.json`, `server.json`, and `mcpb/manifest.json` in sync. Never
hand-edit any of those versions.

The maintainer decides when to release. Never suggest or plan a major version
bump; changes ship as minor or patch releases.
