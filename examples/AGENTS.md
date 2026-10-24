# examples/

Example MCP client apps for filesystem-mcp. Audience: developers building
their own client with `@modelcontextprotocol/client`, or with the Python
`mcp` SDK. Each app must be useful on its own, not a feature tour.

## Rules for apps

- One folder per app under `clients/`, with its own `package.json`, runnable
  with `node <file>.ts` on Node 24. No build step, no `tsx`, only erasable
  TypeScript (`import type`, no `enum`).
- Pin `@modelcontextprotocol/client` to the repository's devDependency
  version (currently `2.4.0`), and regenerate the app's `package-lock.json`
  with `npm install` when it changes.
- Launch the server with `npx -y @j0hanz/filesystem-mcp <dir>`, and use
  `node $FS_MCP_BIN <dir>` instead when `FS_MCP_BIN` is set.
- Target at most 250 lines and 2 runtime dependencies per app. A web app's
  page (`index.html`, plain JS and CSS, no framework) does not count toward
  the 250.
- Each app has a `README.md` and one keyless check script. Never name it
  `*.test.ts`: the root `node --test` would discover it.
- Model access goes through the OpenAI-compatible Chat Completions API over
  `fetch` (see `clients/gatekeeper/agent.ts`), not vendor SDKs.
- Add the app to both tables in `README.md`, and to the examples table in
  `docs/client-guide.md`.

## Python apps

- `clients/python/` holds the Python apps: one script each, runnable with
  `python <file>.py` on Python 3.10+, with `mcp` pinned in
  `requirements.txt` and no other dependencies.
- Same server launch, `README.md`, and keyless `check.py` rules as above.
- Format with `ruff format --line-length 100`.

## Tooling

- The root ESLint config ignores `examples/**`; Prettier still formats it
  (not the `.py` files).
- The root `npm run check` does not run app checks. Run
  `npm test --prefix examples/clients/<app>` after `npm run build`, and
  `python examples/clients/python/check.py` for the Python app.
