# ADR-009: TypeScript 7 native compiles; a `typescript@6` alias keeps typescript-eslint running

**Status**: accepted, 2026-10-30
**Deciders**: j0hanz

## Context

TypeScript 7.0 (the native Go port) ships `tsc` as platform binaries and, by
design, no JavaScript API; the first new API is promised for 7.1. This
server's build and test type-check are plain `tsc -p` calls, and TS 7.0.2
accepts both configs unchanged, but typescript-eslint still imports the
compiler as a JavaScript module, declares the peer range
`typescript >=4.8.4 <6.1.0`, and refuses to load at all against 7.0
(`typescript-eslint does not support TS 7.0`). The editor story and the
lint toolchain therefore cannot move with the build.

An npm `overrides` pin for a nested `typescript@6` does not work here: npm
overrides rewrite dependency edges, not peer resolution, and
typescript-eslint reaches `typescript` only as a peer. Installed with
`typescript@7` at the root, the whole typescript-eslint tree dedupes to
the root 7.0.2 and lint fails at startup.

## Options

- **Wait for typescript-eslint to support 7.x**: no date; the tracker is
  typescript-eslint#10940 and support depends on the 7.1 API that does not
  exist yet; rejected.
- **`overrides` with a nested `typescript@~6.0.0`**: tried; peers dedupe to
  the root and lint crashes on the 7.0 guard; rejected by evidence.
- **Alias swap, as documented by the TS team** (chosen): the
  `typescript` name (which every peer-consuming tool resolves) points at
  `@typescript/typescript6` (re-exports the 6.0.3 JavaScript API, ships only
  a `tsc6` bin), and the native compiler lives under a second alias
  providing `tsc`.

## Decision

In `package.json` devDependencies:

- `"typescript": "npm:@typescript/typescript6@~6.0.2"` is the 6.0 JavaScript
  API for typescript-eslint (and anything else that imports the module);
- `"@typescript/native": "npm:typescript@^7.0.2"` is the only package
  providing a `tsc` bin, so `npm run build` and `npm run type-check:test`
  compile natively with zero script changes.

The tilde on the 6.0.2 alias is deliberate: a caret would admit a 6.1 that
the typescript-eslint peer range forbids.

The emitted `dist/` is not byte-identical to the TS 6 build. Verified
differences, both accepted: module specifiers and string literal types emit
single quotes instead of double, and sourcemap segments are more granular
(mappings for `export` keywords and `.d.ts` members TS 6 left unmapped).
`sources`, `sourcesContent`, `file` and `sourceRoot` are identical and the
JS is semantically the same text; the full suite (1234 tests, 0 fail,
2026-10-30) passed against the TS 7-built `dist/`, `dist-smoke` included.

## Consequences

- Two TypeScript versions coexist in the lockfile until typescript-eslint
  supports the 7.1+ API; when it does, collapse both aliases back to a
  plain `typescript` entry.
- `tsc6` is installed but never invoked; `npx tsc` is 7.0.2 native.
- knip and prettier are unaffected (knip parses via oxc, no TypeScript
  dependency).
- CI needs no workflow changes: the native platform binaries arrive as
  optionalDependencies on all three OS images, and the node engines floor
  (>=16.20) is far below this repo's `>=24`.
- A future 7.x minor may change emit again; re-run a byte-diff of `dist/`
  when bumping the alias, and treat any new difference class the way this
  record treats quotes and map granularity: explain it before shipping.
