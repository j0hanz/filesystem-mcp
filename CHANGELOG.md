# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-09-11

Six architecture-audit findings land together, plus a correctness fix the
review of them turned up. No tool name, input schema, output schema, or
annotation changes shape. Two behaviors change deliberately and one bug in
file exclusion is fixed — see below before upgrading if you parse the `list`
text block or rely on `--log-level` to silence startup warnings.

### Fixed

- **Ignored files and directories could survive a walk.** Node's `fs.glob`
  drops a rejected entry when `exclude` is an array of patterns, but when it
  is a function it only prunes descent — it still yields the rejected entry
  itself, and any rejected entry below the top level. The internal filter
  returns an array when no `.gitignore` is found and a function when one is,
  so the mere presence of a `.gitignore` anywhere under the root silently
  changed which entries survived. In practice `find_files`, `search_text` and
  `replace_text` returned nested gitignored files — a `*.log` rule dropped
  `drop.log` but kept `sub/drop2.log`. The predicate is now re-applied before
  an entry is yielded, so both forms agree.
- **The `.gitignore` pre-walk ignores cancellation.** The discovery pass that
  collects `.gitignore` files prunes only `node_modules`, `.git`, `.hg` and
  `.svn` — not `dist`, `target` or `vendor` — so on a large tree it ran
  uninterruptibly and outside the calling tool's own timeout. It now receives
  the caller's `AbortSignal`.

### Changed

- **`list` reports its position on every page.** The text block now carries
  the same `// showing 1-20 of 57 entries.` trailer the other paged tools
  emit, including on the final page, which previously shipped a bare tree and
  read as the complete answer. The cursor moves into that line as
  `Next page: list {"cursor":"..."}`; the old bare `nextCursor: <value>` line
  is gone, and `_meta.nextCursor` is unchanged. The first-page resource
  pointer is now a plain `full tree at <uri>` line.
- **Invalid-setting warnings are no longer silenced by `--log-level`.** A
  rejected value for `FS_MAX_FILE_SIZE`, `FS_MAX_READ_MANY_BYTES`,
  `FS_SEARCH_TIMEOUT_MS`, `FS_MAX_WATCHERS`, `FS_MAX_REQUEST_BYTES`,
  `FS_RATE_LIMIT_RPM` or `FS_KEEPALIVE_TIMEOUT_MS` used to print through the
  logger, so `--log-level=error` hid it while the same typo in
  `FS_ALLOW_SENSITIVE` or `FS_LOG_LEVEL` still printed. All of them now reach
  stderr once per setting, regardless of level.
- **`list` prunes ignored directories during the walk** instead of
  enumerating everything and filtering afterwards, so the contents of an
  ignored directory are never visited.
- Five tool modules and seven export constants renamed to the wire name they
  register (`search-text.ts`/`SEARCH_TEXT`, `find-files.ts`/`FIND_FILES`,
  `replace-text.ts`/`REPLACE_TEXT`, `list-roots.ts`/`LIST_ROOTS`,
  `delete.ts`/`DELETE`, plus `STAT` and `READ`). Internal only — every
  `name:` string on the wire is byte-identical.

### Removed

- **The `excludePatterns` walk option.** It only ever received the default
  exclude list or an empty array, always selected by the same boolean that
  set `respectGitignore`, so the two fields encoded one decision. One
  `skipIgnored` flag now selects both, and `glob.ts` owns what it means. See
  [ADR-001](docs/adr/001-one-skipignored-flag-owns-both-exclusion-rules.md).
- **The `FilesystemServerContext` class.** It is the interface it already was
  to every consumer; two of its five constructor arguments fed fields only
  its own dispose read.
- **Two of three copies of the invalid-setting warning.** `primitives.ts`
  owns it now, which also removes `util.ts`'s only dependency on
  `observability.ts`.

### Added

- `docs/adr/` and its first record, fixing why a walk's exclusion rules are
  one flag rather than two fields, and what that costs.

## [2.1.8] - 2026-09-10

An internal-only release: the third pass over the over-engineering audit,
46 verified cuts across 47 files, net 605 lines removed. No tool, CLI
flag, environment variable, or wire payload changes shape; the OPTIONS
preflight stays endpoint-exact and still fires ahead of the rate limiter
and bearer auth.

### Removed

- **Three CORS middlewares collapsed into one.**
  `reflectAllowedOrigin`, `corsOriginMiddleware`, and
  `corsPreflightHandler` are one `corsMiddleware`: origin reflection on
  every request, preflight answered only on the exact mount-relative `/`
  (so `OPTIONS /mcp/sub` keeps falling through to its 404), via a single
  `app.use('/mcp', ...)` mount.
- **The HTTP per-request factory indirection.**
  `makeHttpModernFactory` and its `getNotifier` getter are inlined into
  `startHttpServer`, and process shutdown disposes the server through
  `http.Server`'s own `Symbol.asyncDispose` instead of a hand-rolled
  close-promise.
- **Dead exports across core and tools.** `timedSignal` (the
  `AbortSignal.timeout` pass-through it wrapped), `isIgnoredByGitignore`,
  `createSearchMatcher`, `toStatPerPathPayload`, `preFilterByBudget`,
  `buildReplacementPlan`, `getRelativeDepth` (inlined to one comparison),
  `isFilesystemRoot` (subsumed by the `isUnsafeCwdPath` root check), the
  `FileInfo` interface, and `server.ts`'s never-read `ctx.fs`/`ctx.resources`
  fields.
- **The delete reassembly's by-path map.** `delete_file` phase 2 writes
  results back by index into the preallocated result array; the
  `byPath`/plan-by-requested bookkeeping is gone.
- **Progress plumbing in `define.ts`.** The tick guard,
  `closeWithDone`/`closeWithFail`, and `composeSignal` — the timeout
  composes through `AbortSignal.any`, and `ProgressSession.complete/fail`
  are called where the removed wrappers stood.
- **Task-runner residue.** `scripts/tasks.mjs` is deleted — the npm
  scripts it wrapped are the documented surface now — and with it
  `docker-compose.yml`, whose only remaining job was referencing the old
  wrapper.
- **Test scaffolding nobody used.** `__tests__/inspector-fixtures.ts` (its
  two exports duplicated by `bootHttpTest` and a direct `writeFile`),
  `MockResponse.writeHead` and the `end(chunk)` body, and the `readOnly`
  options no caller ever passed to `createElicitationClientPair` or
  `createTestHttpHarness`.

### Changed

- `cli.ts` reads `util.parseArgs` values through their inferred type
  (dot access for the plain-named flags), and `CliExitError` carries no
  exit-code parameter — every construction site already exited 1.
- `core/store.ts` prunes expired entries in one loop and enforces size
  limits in one `while`; the second pass and the unreachable-state
  `Logger.error` are gone.
- README, AGENTS.md, and CONTRIBUTING.md document `npm run check` /
  `npm test` directly; CI invokes the same scripts.

## [2.1.7] - 2026-09-10

A single-defect release: file corruption in `replace_text` on any file
containing emoji. No tool, CLI flag, environment variable, or wire payload
changes shape.

### Fixed

- **`replace_text` no longer corrupts files containing astral characters.**
  re2-wasm reports `exec().index`, `lastIndex`, and the replace-callback
  offset in code points, while every JS string operation indexes in UTF-16
  code units. The two agree until the first astral character — most emoji —
  past which every offset is short by one per surrogate pair, so RE2's own
  `[Symbol.replace]` spliced into the middle of neighbouring words and
  silently dropped characters while reporting success and a correct match
  count. `edit` corrupted identically under `ignoreWhitespace: true`, and
  `search_text` reported a column short by the same amount; the
  case-sensitive literal paths of both were unaffected, matching on
  `indexOf`. One `execMatches` generator in `core/search.ts` is now the
  single owner of the conversion, and no caller reads `match.index` or
  `regex.lastIndex` any more. It also owns the advance between matches,
  which the wrapper computed by adding a UTF-16 length to a code-point
  index — an emoji inside a match could skip the one after it. Reported in
  [#24](https://github.com/j0hanz/filesystem-mcp/issues/24).
- **`` $` `` and `$'` in a `replace_text` template resolve against the right
  offset.** They slice the input around the match, and took the same
  uncorrected offset the splice did.

## [2.1.6] - 2026-09-09

An internal-only release: the second pass over the over-engineering audit's
residue list, 22 verified cuts across 22 files, net 308 lines removed. No
tool, CLI flag, environment variable, or wire payload changes shape; the
only behaviour change is that an aborted `FS_ROOT_BOUNDARY` check now
propagates the abort instead of silently dropping grant roots.

### Removed

- **Dead read knobs.** `ReadSpec`'s unreachable options (`skipBinary`,
  per-spec encodings), the write-only `truncated` field on full reads, the
  `ReadSpecCommon` intermediate, and a `ReadContentOptions` interface that
  was byte-identical to `NormalizedBase` with a converter between them.
  Range reads are now byte-bounded through one shape end to end.
- **Duplicate regex work in search.** `search_text` no longer re-executes
  the pattern to compute a match's column offset — `findLineMatches`
  returns count and column from the single exec it already ran.
- **A second pass over replaced files.** `replace_in_files` counted matches
  with a separate `count()` call per file and re-detected MIME types with a
  lossy utf-8 roundtrip; the matcher now counts inside its own `replace`
  callback and reads the `mimeType` `readRaw` already computed.
- **The `edit` regex cache.** Patterns are compiled per edit and freed in
  `try/finally` — the cache reused a fixed 16 MB wasm heap across edits for
  nothing a per-edit compile does not do correctly.
- **Unreachable guards and flags.** `PathGuard`'s unfiltered-grant fallback
  path, `cli.ts`'s `assertDirectory` wrapper, `index.ts`'s
  `keepForceExitTimer` flag and its dead `shutdown_error` catch, the
  try/catch around the `get-help` prompt body (nothing in it can throw),
  `defaultValue` on `input_required` forms (no caller ever passed one),
  `ResourceEntry.storedAt` (only `expiresAt` was ever read), and
  `FsError`'s `path` getter (every `.path` reader reads `problem.path`).
- **Single-use indirection.** `sensitive.ts`'s `CompiledPattern` interface,
  `path-completer.ts`'s `getRootPrefix`, and `define.ts`'s optional
  `ctx` fallback and `ToolCtx.authInfo` field.

### Changed

- `filterRootsWithin` resolves root containment with `Promise.all`, so an
  aborted boundary check rejects instead of filtering every root out as
  "within=false" — a late abort no longer reports a grant as outside the
  boundary.
- `stoppedReason` narrows to `'maxResults' | 'timeout'` on both search
  tools, with the invariant documented at each `resolve()` site.

## [2.1.5] - 2026-09-06

An internal-only release: the over-engineering audit, 39 verified cuts across
45 files, net 299 lines removed. No tool, CLI flag, environment variable, or
wire payload changes behaviour.

### Removed

- **The error `details` channel.** `Problem.details` and the `FsError.details`
  getter carried `errno` and `syscall` that nothing read and no response ever
  rendered, and `FsError`'s constructor loses its `details` parameter. The
  client-visible error shape — `code`, `message`, `path`, `suggestion`,
  `issues` — is unchanged.
- **Dead internal surface.** `PathGuard.isServerContext`, `getRootBoundaries`,
  and the `fromAllowedDirectories` test factory; `fs.ts`'s `hash`,
  `createReadStream`, and `StatPath`; `parseEnvDirList` and the
  `pairFailureSchema` factory. Watcher-registry, resources, transport,
  prompts, and CLI exports are trimmed to their real consumers.
- **Unreachable configuration.** Progress total, batch concurrency, `stat` MIME
  knobs, `hasErrorShape`'s `code` parameter, and `fmt`'s stream parameter. None
  was reachable from a tool argument or an environment variable.

### Changed

- `edit` and `replace_in_files` call diff v9 synchronously — the library is
  sync, so the `await` bought nothing.
- Cursor first-page and replay handling folds into `paginate`; `search_text`
  drops its sort indirection and compiles the pattern once per request.

## [2.1.4] - 2026-09-06

A fix release for silent truncation in the text the two search tools return.
No tool, CLI flag, or environment variable changes behaviour and the structured
payload is untouched — only the text block gains trailing `//` lines.

### Fixed

- **`search_text` and `find_files` now say when a page hides results.** The
  position in the set, the next-page cursor, and the engine's stop state lived
  only in the structured half, which the SDK ships under `_meta` for a tool
  that authors its own text — and no client renders that, so a capped page read
  exactly like a complete answer. Both tools now append
  `// showing 5-8 of 9 matches. Next page: search_text {"cursor":"..."}`, on
  every page of a split set including the last one, which has no cursor. A scan
  the engine cut gets a second line,
  `// scan stopped early: hit the server's 10000-result scan cap`, which names
  the cap rather than echoing `maxResults` — that is also the caller's
  page-size argument. The stop line is independent of the cursor, so a
  truncation with too few results to page still says so.
- **`read`'s continuation echoes the path the caller wrote.** It carried the
  resolved absolute path instead, which on Windows is a backslash-doubling JSON
  string that also spells out the server root. Its hint now names the line to
  resume from (`More lines remain from 501.`) rather than the generic
  `File was truncated.`

## [2.1.3] - 2026-09-06

A release that lands the three seams from the 2026-09-05 architecture audit.
One tool behaviour changes — how `list`, `find_files`, and `search_text`
decide when to store their full result — and one environment variable is
deprecated. The wire format, CLI flags, and every other tool are untouched.

### Changed

- **`list`, `find_files`, and `search_text` externalize on one rule.** An
  incomplete first page — more pages follow, or the engine's hard cap cut the
  set — now carries `resourceUri` to the full result in the resource store, for
  all three tools. Before, `list` stored one only on hard-cap overflow,
  `find_files` on any incompleteness, and `search_text` whenever a page held
  more than `FS_MAX_INLINE_MATCHES` matches. Continuation pages never carry it
  and never mint a new one; `search_text` used to store a fresh copy on every
  continuation page that crossed the inline cap.
- **`search_text` shows a whole page inline.** `maxResults` is the page size and
  the inline count; the separate 50-match inline slice is gone. `truncated` now
  means only that the engine cut the match list (hard result cap or timeout) —
  a set that spans several pages has `nextCursor` and is not "truncated".

### Deprecated

- **`FS_MAX_INLINE_MATCHES`** is read only to log a startup warning; it has no
  effect. Use `maxResults` to set the `search_text` page size. The variable is
  removed in the next major release.

## [2.1.2] - 2026-09-05

A fix release for two transport-boundary defects. No tool, no CLI flag, and no
environment variable changes behaviour, and the wire format is untouched — an
MCP client needs to do nothing.

### Fixed

- **`FS_MAX_REQUEST_BYTES` now applies to every POST, not just JSON ones.** The
  Express body parser leaves `req.body` undefined for anything but
  `application/json`, and handing that undefined body to the Node adapter made
  it read the raw stream with no limit — so a `text/plain` upload, or one with
  no `Content-Type` at all, was buffered unbounded before being rejected. Such
  a POST is now answered `415` before its body is read, and a request with no
  body framing gets a JSON-RPC ParseError instead of being forwarded. The `415`
  envelope matches the one the SDK would have produced.
- **A stdio server no longer outlives its connection.** When the SDK closed the
  transport on a fatal read error — a `ReadBuffer` overflow, for one — nothing
  released the watchers the connection had acquired, and the process stayed
  alive after the client was gone. Teardown now also runs on the transport's
  own close, not only on an explicit `close()`, and it unrefs stdin: the SDK
  pauses stdin only when no other `'data'` listener remains, which otherwise
  holds the event loop open with nothing left to serve. A server instance whose
  construction finishes after teardown is disposed rather than published.

## [2.1.1] - 2026-09-05

A cleanup release. No tool, no CLI flag, and no environment variable changes
behaviour, and the wire format is untouched — an MCP client needs to do nothing.

**One `./transport` export narrows.** `RuntimeConfig` no longer accepts
`eventBus` or `deploymentMode`. This is shipped as a patch rather than a major
because neither field was reachable: `index.ts` builds its `RuntimeConfig` from
`httpHost` and `apiKey` alone, so no CLI invocation could ever set them, and
only a caller importing `startHttpServer` from `@j0hanz/filesystem-mcp/transport`
and passing one explicitly is affected. If that is you, drop both fields —
single-instance behaviour is identical.

### Removed

- **Fleet deployment mode.** `RuntimeConfig.eventBus` and
  `RuntimeConfig.deploymentMode`, the two boot guards that enforced them, and
  `assertFleetRequestStateKey`. The feature fanned change events across
  load-balanced instances, but two instances of a filesystem server either serve
  the same disk, where the fan-out buys nothing, or different disks, where the
  shared state is wrong. `FS_REQUEST_STATE_KEY` stays: it keeps in-flight
  `input_required` rounds alive across a restart, which has nothing to do with
  deployment topology.
- **The `qa` npm script** and the `scripts/qa*` harness behind it. It drove the
  MCP Inspector against `dist/` and rendered an HTML report, duplicating
  `__tests__/inspector-*.test.ts`, and no CI job ever ran it.
- **The `ProgressSink` interface.** `McpProgressSink` was its only
  implementation, so `ProgressSession` now holds that type directly instead of an
  array behind an abstraction. Progress notifications on the wire are unchanged.

### Changed

- The `get-help` prompt no longer rejects a `topic` for blankness or shell
  metacharacters. The handler resolves a topic by `Object.hasOwn` against a
  frozen record, so an unrecognized one already falls through to the not-found
  reply and nothing downstream interprets the string. A non-empty check remains.
- A CLI startup error for an unreadable allowed directory now carries Node's own
  message instead of a string rebuilt from `errno`, and attaches the original
  error as `cause`:

  ```text
  Cannot access directory /no/such/dir: ENOENT: no such file or directory, stat '/no/such/dir'
  ```

## [2.1.0] - 2026-09-05

A minor release, not a major one: the package's own API is untouched. Its
`./transport` exports and every CLI flag and environment variable are byte-for-
byte what 2.0.0 shipped. What changed is how tool results look on the wire, and
an MCP client reading them is not an npm dependent of this package.

**If you maintain a custom MCP client, read the first entry before upgrading.**
Nothing else here needs action.

### Changed

- **Where tool metadata lives.** Tools that return a text result (`read`,
  `list`, `diff`, `patch`, `edit`, `delete`, `move`, `replace_text`,
  `search_text`, `find_files`) now ship their metadata under `_meta` instead of
  `structuredContent`. Clients that treat `structuredContent` as the canonical
  model view — Claude Code among them — discard the text blocks whenever it is
  present, so the model never saw the file `read` returned or the tree from
  `list`. It is the same object under a different field: a client doing
  `result.structuredContent.results` reads `result._meta.results` instead.
  Only `stat`, `create` and `list_roots` keep `structuredContent`.
- `read` appends a `// truncated:` line carrying the continuation args, and a
  `// sha256:` line when `includeHash` is set, after a blank line so neither can
  be read as file bytes. `list` appends a `nextCursor:` line, and a `truncated:`
  notice on hard-cap overflow.
- No tool publishes an `outputSchema` any more. Publishing one obliges the
  result to carry `structuredContent`, which every publisher has stopped doing.
- `stat`, `create` and `list_roots` no longer return a one-line text summary.
  Their value is the metadata, so they return JSON text and keep
  `structuredContent`.

### Fixed

- `list_roots` returns a `hint` naming the three ways to configure a root when
  it has none to list. An unconfigured server used to answer `{"roots":[]}` and
  leave the caller to guess; the elicitation route out — call a tool with a
  concrete path and approve the grant — appeared in no tool description.
  Present only when `roots` is empty.

## [2.0.0] - 2026-08-27

This is a breaking release. Every tool name and every environment variable
changed, and neither has a compatibility fallback. Read the two migration
tables below before upgrading.

### Breaking — tool names

The tool surface was consolidated from 17 tools to 13. Batch behaviour moved
into the single-item tools rather than living in separate `*_many` tools, and
the remaining names were made consistent.

| 1.x tool             | 2.0 equivalent                  |
| :------------------- | :------------------------------ |
| `ls`                 | `list`                          |
| `grep`               | `search_text`                   |
| `find`               | `find_files`                    |
| `mv`                 | `move`                          |
| `rm`                 | `delete`                        |
| `roots`              | `list_roots`                    |
| `apply_patch`        | `patch`                         |
| `diff_files`         | `diff`                          |
| `search_and_replace` | `replace_text`                  |
| `write`              | `create`                        |
| `tree`               | `list` with `maxDepth`          |
| `stat_many`          | `stat` with `paths[]`           |
| `calculate_hash`     | `read` with `includeHash: true` |
| `mkdir`              | removed — see below             |

`edit`, `read`, and `stat` keep their names. Both `read` and `stat` accept
either a single `path` or a `paths[]` batch.

**`mkdir` has no direct replacement.** `create` writes files and creates any
missing parent directories along the way, so a directory can be produced as a
side effect of writing a file inside it. Creating an empty directory on its own
is no longer possible through a tool call.

### Breaking — environment variables

Every environment variable is now prefixed `FS_`, with no fallback to the old
name. A configuration file carrying 1.x names will be read as entirely unset,
which for `FS_API_KEY` means an HTTP server starts unauthenticated. Audit
deployment configuration before upgrading.

| 1.19.1 variable                 | 2.0 variable             |
| :------------------------------ | :----------------------- |
| `FILESYSTEM_MCP_API_KEY`        | `FS_API_KEY`             |
| `FILESYSTEM_MCP_HTTP_HOST`      | `FS_HTTP_HOST`           |
| `FILESYSTEM_MCP_LOG_LEVEL`      | `FS_LOG_LEVEL`           |
| `FS_CONTEXT_ALLOW_SENSITIVE`    | `FS_ALLOW_SENSITIVE`     |
| `FS_CONTEXT_DENYLIST`           | `FS_DENYLIST`            |
| `FS_CONTEXT_MAX_REQUEST_BYTES`  | `FS_MAX_REQUEST_BYTES`   |
| `FS_CONTEXT_MAX_INLINE_MATCHES` | `FS_MAX_INLINE_MATCHES`  |
| `MAX_FILE_SIZE`                 | `FS_MAX_FILE_SIZE`       |
| `MAX_READ_MANY_TOTAL_SIZE`      | `FS_MAX_READ_MANY_BYTES` |
| `DEFAULT_SEARCH_TIMEOUT`        | `FS_SEARCH_TIMEOUT_MS`   |

`FS_ALLOWED_DIRS` and `NO_COLOR` keep their names.

These 1.19.1 variables are no longer read and have no replacement:
`FS_CONTEXT_ALLOWLIST`, `FS_CONTEXT_MAX_INLINE_CHARS`,
`FS_CONTEXT_STRIP_STRUCTURED`, `FS_CONTEXT_SEARCH_WORKERS`,
`FS_CONTEXT_SEARCH_WORKERS_DEBUG`, `FS_CONTEXT_LIST_CURSOR_TTL_MS`,
`FS_CONTEXT_DIAGNOSTICS`, `FS_CONTEXT_DIAGNOSTICS_DETAIL`,
`FS_CONTEXT_TOOL_LOG_ERRORS`, `MAX_SEARCH_SIZE`,
`FILESYSTEM_MCP_MAX_HTTP_SESSIONS`, `FILESYSTEM_MCP_MAX_TASK_TTL_MS`, and
`FILESYSTEM_MCP_MAX_CONCURRENT_TASKS`.

2.0 adds `FS_ROOT_BOUNDARY`, `FS_ALLOW_CWD_WALK`, `FS_ALLOW_MISSING_ROOTS`,
`FS_TRUST_PROXY`, `FS_ALLOWED_HOSTS`, `FS_ALLOWED_ORIGINS`,
`FS_ALLOW_UNRESTRICTED_HOSTS`, `FS_PUBLIC_URL`, `FS_RATE_LIMIT_RPM`,
`FS_MAX_WATCHERS`, and `FS_REQUEST_STATE_KEY`. The README documents every
variable with its default and accepted range.

Boolean parsing also changed. `true` and `1` enable a variable; `false`, `0`,
and empty disable it. Any other value now logs a warning once and reads as
disabled, where 1.x accepted it silently as false.
`FS_ALLOW_UNRESTRICTED_HOSTS` goes through the same grammar as every other
boolean rather than its own.

### Breaking — package exports

The package root export was removed. `dist/index.js` is the CLI entry point: it
parses `process.argv` and starts a server on import, and its declaration file
was empty, so importing the package root never gave callers an API. The
`filesystem-mcp` binary and the `./transport` subpath export are unaffected.

### Added

- `FS_PORT` mirrors `--port`, so the HTTP transport can be enabled entirely
  from the environment. An empty string reads as unset.
- `FS_KEEPALIVE_TIMEOUT_MS` replaces the hard-coded 5-second HTTP keep-alive.
  `headersTimeout` is derived from it as the configured value plus 5 seconds.
  Set this above the idle timeout of any proxy in front of the server.
- The published `server.json` now declares `--read-only`, the `FS_ALLOWED_DIRS`
  environment variable, and the Docker runtime arguments (`-i`, `--rm`, and the
  volume mount), so registry clients generate a working install command for
  both the npm and container packages.

### Fixed

- **`--api-key` and `--http-host` had no effect.** Both were parsed and
  documented but never reached the HTTP server, so `--api-key <secret>` started
  an unauthenticated server. `--log-level`, `--max-file-size`,
  `--root-boundary`, `--allow-sensitive`, and `--deny` were dropped the same
  way. All seven now take precedence over their environment variable, as
  `--help` has always claimed.
- **`FS_LOG_LEVEL` / `--log-level` now filters output.** The value was parsed
  and ignored; every message reached stderr regardless. Messages below the
  configured severity are now suppressed — with the default of `info`, `debug`
  output no longer appears unless requested.
- A loopback HTTP bind rejected `Host: localhost` and `Host: [::1]` with
  `403 Invalid Host`, so `http://localhost:<port>/mcp` failed on a default
  server. All three loopback spellings are accepted.
- Host allow-list values consisting only of separators or whitespace read as an
  empty allow-list that rejected every request; they now read as unset.
- A `500` on the HTTP POST route replied with `id: null` even when the request
  carried an id, leaving clients waiting for a correlatable response.
- **`delete` reported a narrower error shape than every other tool.** Its
  `failures[].error` published only `code` and `message`, dropping the `path`
  and `suggestion` the handler had already computed. It now emits
  `PerFileError`, matching `create`, `move`, and `replace`.

### Changed

- Updated core dependencies.
- Refined internal schemas and agent configurations.
- `--api-key` is documented as development-only; `FS_API_KEY` is the supported
  channel, since argv is world-readable.

### Removed

- **Removed the experimental tasks subsystem.** The task store, task-augmented
  tool execution, and the `FILESYSTEM_MCP_MAX_TASK_TTL_MS` /
  `FILESYSTEM_MCP_MAX_CONCURRENT_TASKS` settings are gone. SEP-2663 removed
  tasks from the SDK; long operations report through progress notifications
  instead.
- **Removed the `logging` capability and the `logging/setLevel` handler.**
  Clients calling `logging/setLevel` now receive `METHOD_NOT_FOUND`. The
  handler only set a field nothing read, and SEP-2577 deprecates the subsystem;
  diagnostics go to stderr, controlled by `FS_LOG_LEVEL`.
- Removed dead diagnostics, tracing, and performance tests from `observability.test.ts`.
- Removed dead W3C trace surface and unreachable diagnostics config from `observability.ts`.
- Removed dead `startPerfMeasure`/`withOpsTrace` and `withToolDiagnostics` subsystems.
- Removed dead `RESOURCE_STORE_DIAGNOSTICS_CHANNEL` and `LIFECYCLE_CHANNEL` publishers.

[2.1.2]: https://github.com/j0hanz/filesystem-mcp/compare/v2.1.1...v2.1.2
[2.1.1]: https://github.com/j0hanz/filesystem-mcp/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/j0hanz/filesystem-mcp/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/j0hanz/filesystem-mcp/compare/v1.19.1...v2.0.0
