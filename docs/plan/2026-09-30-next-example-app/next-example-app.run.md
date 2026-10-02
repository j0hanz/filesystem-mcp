# Run: add `hooks`, an event-driven example client under `exampels/clients/`

Executing [`next-example-app.plan.md`](next-example-app.plan.md), started 2026-09-30 at `965de66b`.

- **1** 2026-09-30 — done. Drift check empty; `npm install` produced the lockfile; `import('@modelcontextprotocol/client')` → `function`; `git check-ignore -v node_modules` → `.gitignore:5:node_modules/`.
- **2** 2026-09-30 — done. `check.ts` written (15 scenarios, R2–R17, R21, R22); `npm test` → `ERR_MODULE_NOT_FOUND … hooks.ts`, exit 1 as expected.
- **3** 2026-09-30 — done with one STOP resolved. `npm test` → `check: ok` on the first run (346 lines after Prettier; first draft 369). Line budget: 346 > 250 — the plan's named STOP. Trimming comments/blank lines/merges reached 346; the rest is spec'd behavior. Routed to write-specs as [`next-example-app.spec-delta.md`](next-example-app.spec-delta.md) (R18 → ≤ 350). Plan-hunt C2 settled by a direct run: a server that exits at once yields only `filesystem-mcp exited` (`onclose` fires before `connect()` rejects); the check's either-message assertion was needed.
- **4** 2026-09-30 — done. `hooks/README.md` written; table row added; `npx prettier --check exampels` → `All matched files use Prettier code style!`; `grep clients/hooks/ exampels/README.md` → one line (20).
- **5** 2026-09-30 — done. gatekeeper `npm test` → `check: ok`; hooks `npm test` → `check: ok`; `git status --short` → `M exampels/README.md`, `?? docs/plan/2026-09-30-next-example-app/`, `?? exampels/clients/hooks/`.

## Done

- [x] hooks `npm test` → `check: ok`, exit 0; `check.ts` comments name R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R17, R21, R22.
- [ ] `hooks.ts` ≤ 250 lines — **346**; deviation carried by the R18 spec delta (≤ 350). `package.json` `dependencies` has exactly 1 entry.
- [x] `npx prettier --check exampels` → exit 0.
- [x] `exampels/README.md` has a `clients/hooks/` row (line 20).
- [x] gatekeeper `npm test` → `check: ok`.
- [x] `git status --short` lists only in-scope paths.
- [x] `node hooks.ts` (no args) → usage on stderr, exit 1.
