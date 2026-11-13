# ADR-017: `src/core/config.ts` resolves every flagged Setting; readers stop reading `process.env`

**Status**: accepted, 2026-11-13
**Deciders**: j0hanz, in the architecture review of Candidate 1 (Deepen config into the owner of effective settings)

## Context

`src/core/config.ts` called itself "the one owner of the flag-beats-env rule" but held no logic: an override bag (`cli`), its type, and two constants. Each reader wrote the rule out itself as `cli.x ?? parse(process.env.FS_X)`: `util.ts` twice, `observability.ts` once, `sensitive.ts` once, `path.ts` three times. `FS_ALLOW_MISSING_ROOTS` was resolved in three places (`parseArgs`, the guard, `--print-config`), and `--print-config` copied the guard's expression by hand, so the printed policy could drift from the enforced one. Only one **Setting** (tool timeout) had a precedence test.

## Decision

- **`config.ts` owns the eight flagged scalar Settings** behind one named read each: log level, max file size, tool timeout, root boundary (raw value), allow-missing-roots, allow-sensitive, cwd-is-a-root, cwd-walk. Each read returns the parsed effective value and owns the invalid-value warning. `path.ts`, `util.ts`, `observability.ts`, `sensitive.ts`, `parseArgs` and `--print-config` ask it.
- **Reads are lazy.** A Setting is resolved on every read, never snapshotted: `--log-level` and `--tool-timeout` land after module load, and the tests change `process.env` per case.
- **`config.ts` imports only `path-utils.ts`**, which imports no repo module. The former "zero imports" rule becomes "leaf modules only"; the cycle guard it stood for is unchanged. The env parsers (`parseTrueEnvFlag`, `parseEnvInt`) and the log-level type move in with the reads.
- **The `cli` bag stays exported** as the write target for `cli.ts` and tests, and gains `allowCwd`. `sensitive.ts` still reads its two pattern lists.
- **No observable behaviour changes.** An invalid flag value still falls back to the default, never to the variable. `--root-boundary ''` still prints `""`. `FS_ALLOW_CWD_WALK` alone still makes cwd a root and walks up from it.

## Considered options

- **Raw values only, zero imports kept.** Rejected: readers would still know each parse rule, and a boolean Setting would need a boolean-or-string type.
- **One keyed read over a settings table.** Rejected: call sites lose grep-by-name and the return type needs a mapped type, for eight Settings.
- **Snapshot at startup.** Rejected: needs a reset hook for about 110 `withEnv` call sites and breaks any read made before the snapshot.
- **config owns the unions too** (`FS_DENYLIST`/`--deny`, `FS_ALLOWLIST`/`--allow`, `FS_READ_ONLY_DIRS`/`--read-only-root`). Rejected: each union has one site, so nothing is deduplicated, and the pattern and directory splitters would drag sensitive-file and path knowledge into config.
- **Startup-only flags join** (`--port`, `--http-host`, `--api-key`, `--read-only`). Rejected for now: one site each inside `parseArgs`. They, and the env-only variables in `http.ts`, `input-required.ts` and `watcher-registry.ts`, may join later behind the same named-read shape.
- **Hide the bag behind a setter.** Rejected: two more exports and a test rewrite, with no duplicate removed.

## Consequences

- The flag-beats-env rule, each default, each range and each warning live in one module; `--print-config` matches the guard by construction.
- `__tests__/config.test.ts` asserts precedence for all eight Settings in-process. The subprocess case in `cli.test.ts` stays as the wire check.
- `getMaxTextFileSize`, `getToolTimeoutMs`, `parseTrueEnvFlag` and `parseEnvInt` are imported from `config.ts`, not `util.ts`; `LoggingLevel` from `config.ts`, not `observability.ts`.
- Deferred, as its own change with a changelog entry: `FS_ALLOW_CWD_WALK` feeds two decisions (cwd is a root; walk up to the project root). Splitting them is a behaviour change and is not part of this refactor.
- No wire schema or tool description changes; `__tests__/contract.test.ts` stays unchanged.
