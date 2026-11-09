# TDQS low-score description refinements: design

Date: 2026-11-09. Repository: `filesystem-mcp`.

## Intent and why

The latest report gives the server A4.6. Purpose clarity, usage guidance, and
conciseness already score 5. The selected pass targets only the six tools with
parameter-semantics scores of 3: `create`, `diff`, `move`, `patch`,
`find_files`, and `stat`. It adds verified parameter interactions, partial
failure behavior, and exact result shapes without changing runtime behavior.

## Goals

- Address the report's parameter-semantics, behavioral-transparency, and
  contextual-completeness gaps in those six tools.
- Preserve the existing purpose, usage, and sibling-routing sentences.
- Keep every added claim traceable to the current implementation.
- Regenerate both advertised-surface snapshots and preserve surface guards.

## Non-goals

- No output schemas: `src/tools/define.ts` deliberately forbids them.
- No `move`/`delete` restructuring; coherence already rejected their shadow
  candidate warning.
- No `list_roots` rename or other tool-name changes.
- No edits to `search_text`, whose detailed score section is absent from the
  report, or to tools already scoring 4.7 or higher.
- No runtime code, dependencies, release versions, or hosted TDQS submission.

## Approaches

1. **Selected: six targeted description edits.** Small wire-text diff; directly
   addresses the lowest scored dimensions. Contract and surface tests pin it.
2. **Broad rewrite of every description.** Rejected: most dimensions already
   score 5, and added prose risks conciseness and session-start payload cost.
3. **Add output schemas.** Rejected: incompatible with the intentional response
   architecture and pinned by `TOOL-SURFACE-001`.

## Design

Replace only the six `description` strings. The implementation plan fixes the
exact copy. `create`, `move`, and `patch` explain mutation and undo results;
`diff`, `find_files`, and `stat` explain result layout and parameter behavior
without naming mutating tools. Partial success is stated where the batch
implementation permits it. No description promises a transaction or rollback
that the server does not provide.

Update `__tests__/contract.test.ts.snapshot` through Node's snapshot updater,
never manually. Run the affected tool tests and all `TOOL-SURFACE` tests. If
`TOOL-SURFACE-002` exceeds a budget, raise only the exceeded constant to the
next 50-character boundary and add a dated comment with measured full and
read-only sizes. Finish with `npm run check` and `graphify update .`.

## Verification and remaining choice

The builder may resolve formatting and budget arithmetic. Description wording,
scope, and runtime behavior are fixed. A fresh hosted score requires the owner
to run `npm run tdqs`; it spends one of 30 daily calls and is not part of this
implementation.
