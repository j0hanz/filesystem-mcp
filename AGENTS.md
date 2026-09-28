# filesystem-mcp

MCP server exposing guarded filesystem tools (read, write, search, diff, patch)
over stdio and Streamable HTTP.

## Commands

```bash
npm run check        # full repository check (static + tests)
npm run fix          # format and lint-fix, then run the full check
npm run check:static # static checks only, no tests
npm test             # Node test runner; pass native flags after --
```

Tests run on Node's built-in test runner; `npm test --
--test-name-pattern="resources"` filters like the old wrapper did.

`__tests__/dist-smoke.test.ts` boots `dist/index.js`; it skips when `dist/`
is absent, so run `npm run build` (or `npm run check`) first to exercise it.

## Releases

Versions are bumped by the Release workflow (`workflow_dispatch`), which keeps
`package.json`, `server.json`, and `mcpb/manifest.json` in sync. Never
hand-edit any of those versions.
