# exampels/

Example MCP client apps for filesystem-mcp. Audience: developers building
their own client with `@modelcontextprotocol/client`. Each app must be useful
on its own, not a feature tour.

## Rules for apps

- One folder per app under `clients/`, with its own `package.json`, runnable
  with `node <file>.ts` on Node 24. No build step, no `tsx`, only erasable
  TypeScript (`import type`, no `enum`).
- Pin `@modelcontextprotocol/client` to the repository's devDependency
  version (currently `2.2.0`).
- Launch the server with `npx -y @j0hanz/filesystem-mcp <dir>`, and use
  `node $FS_MCP_BIN <dir>` instead when `FS_MCP_BIN` is set.
- Target at most 250 lines and 2 runtime dependencies per app.
- Each app has a `README.md` and one keyless check script. Never name it
  `*.test.ts`: the root `node --test` would discover it.
- Model access goes through the OpenAI-compatible Chat Completions API over
  `fetch` (see `clients/gatekeeper/agent.ts`), not vendor SDKs.
- Add the app to the table in `README.md`.

## Tooling

- The root ESLint config ignores `exampels/**`; Prettier still formats it.
- The root `npm run check` does not run app checks. Run
  `npm test --prefix exampels/clients/<app>` after `npm run build`.
