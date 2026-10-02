# Bug hunt: hooks — 2026-10-02

Scope from the brief: [`hooks.ts`](../../../exampels/clients/hooks/hooks.ts)
(347 lines) and [`check.ts`](../../../exampels/clients/hooks/check.ts)
(381 lines), both read in full; no exported symbols, so no blast radius.
`exampels/README.md` is prose and was not audited. Four candidates went to
blind refuters; all four came back `confirmed`.

**Verdict:** the snapshot trusts a `find_files` result that the server itself
marks as incomplete, so a slow or large workspace makes the model believe
files were deleted.

## Confirmed

### 1. Major — partial `find_files` becomes a complete snapshot; unreached files are reported "deleted"

- **Where**: [`hooks.ts:205-207`](../../../exampels/clients/hooks/hooks.ts#L205-L207) `snapshot()`, the filter `!l.startsWith('//')`.
- **Trigger**: the server's scan stops early on the 5 s timeout ([`util.ts:143`](../../../src/core/util.ts#L143)) or at `maxResults`; it returns the files found so far plus a `// scan stopped early: …` trailer ([`fmt.ts:143-146`](../../../src/core/fmt.ts#L143-L146)) with `isError` unset. A 10 000-file tree on a cold network drive is enough.
- **Impact**: `diff()` lists every unreached file as `deleted`; the turn's first message tells the model so; a standing task like "keep the index in sync" removes real entries. The next complete snapshot reports the same files as `created` — a second spurious turn.
- **Ruled out**: refuter grep of the app for `stopped early|truncated|partial` → no match; `nextCursor` never followed. The one line that could have caught it is the one that discards it: `.filter((l) => l && !l.startsWith('//') && !l.startsWith('No files matching'));`
- **Fix**: in `snapshot()`, keep the `//` lines and, if any contains `scan stopped early`, throw (or return `null`) so `onQuiet` logs "workspace too large/slow to snapshot" and skips the turn without touching `baseline`. Optionally raise the server timeout via its own knob if one exists; otherwise document the hard limit as a refusal, not a silent misreport. Add a check scenario with `FS_MCP_BIN` pointing at a wrapper that injects the trailer, or a stub asserting the skip.

### 2. Minor — a quiet timer that fires during a long post-turn snapshot is dropped

- **Where**: [`hooks.ts:277-278`](../../../exampels/clients/hooks/hooks.ts#L277-L278) `onQuiet()`: `if (running || closing) return;`
- **Trigger**: `running` stays true through `const after = await snapshot();` ([`:287`](../../../exampels/clients/hooks/hooks.ts#L287)). When a snapshot takes longer than `QUIET_MS` (the spec allows 2 s for 1 000 files), the timer fires inside it and nothing re-arms. An external write that landed after `stat` read that file's mtime is in neither `after` nor a pending timer.
- **Impact**: one change is missed until some later unrelated change fires a new notification.
- **Ruled out**: refuter: "`finally { running = false; }` at line 295 does not re-arm the timer or re-check for pending changes"; `schedule()` is called only from the notification handler ([`:321`](../../../exampels/clients/hooks/hooks.ts#L321)).
- **Fix**: replace the early return with `pending = true`; after the `while` loop (and in `finally`), if `pending`, clear it and call `schedule()` so the next quiet period re-snapshots.

### 3. Minor — a file the model renames comes back as an external "created" change (echo turn)

- **Where**: [`hooks.ts:231-235`](../../../exampels/clients/hooks/hooks.ts#L231-L235) `isOwn()`.
- **Trigger**: the server's `move` is a plain `fsOps.rename` ([`move.ts:486`](../../../src/tools/move.ts#L486)), which preserves mtime. After `move a.txt → b.txt`, the post-turn diff yields `deleted: a.txt` (own, via `ownDeletes`) and `created: b.txt` whose `modified` is the original write time — outside every `[started - 100, Date.now() + 100]` window.
- **Impact**: one extra turn per rename, with `created: b.txt` as its reason; the model re-runs the standing task on its own output. Bounded — the following snapshot is clean.
- **Ruled out**: refuter: `return ownWindows.some(([from, to]) => at >= from && at <= to);` is the only test for `created`/`modified`; `ownDeletes` covers only `deleted`.
- **Fix**: when a destructive call was `move` (or any call), also treat `created` entries as own if the turn had `ownDeletes > 0` and the created path's mtime predates the turn start (a rename signature), or — simpler and more honest — record the paths named in `move` arguments (`moves[].destination` / `destination`) and mark them own. Add a check scenario: `--yes`, script `[move a.txt → c.txt, done]`, assert exactly 2 requests.

### 4. Minor — own-write window assumes sub-100 ms mtime resolution

- **Where**: [`hooks.ts:166-167`](../../../exampels/clients/hooks/hooks.ts#L166-L167) `ownWindows.push([started - 100, Date.now() + 100]);`
- **Trigger**: FAT32 rounds mtime down to 2 s (ext3: 1 s). A write at `T` gets `floor(T, 2 s)`, up to 2 000 ms before `started`, so `isOwn` fails and the write is treated as external.
- **Impact**: on such a workspace every approved write starts another turn; if the task writes again, the loop repeats with model spend each cycle.
- **Ruled out**: refuter grep of `src/` for `utimes|futimes` → none; the server never sets mtime explicitly, so the filesystem's rounding stands.
- **Fix**: widen the lower bound to cover coarse timestamps (`started - 2_100`), and document that the window is a heuristic in the README's Limits (already partly there).

## Suspected

### 5. Clock skew on network filesystems defeats the own-write window

- **Why**: `stat.modified` on SMB/NFS mounts is the file server's clock; `Date.now()` is the client's. Skew above 100 ms (after the fix to #4, above ~2 s) misclassifies every own write as external — the same loop as #4, on a more common workspace type (Docker bind mounts, shared drives).
- **Settles it**: on an SMB-mounted workspace, run `--yes` with a one-edit script and watch for a second request; or compare `stat.modified` of a fresh write against `Date.now()` at the call site.

## Coverage

- Read fully: `hooks.ts`, `check.ts`.
- Pulled in from blast radius: `src/core/fmt.ts` (`pageTrailer`, `stoppedEarlyLine`), `src/core/util.ts` (`DEFAULT_SEARCH_TIMEOUT_MS`), `src/tools/find-files.ts` (text shape), `src/tools/move.ts:486` (rename), `src/core/watcher-registry.ts` (50 ms debounce) — each only far enough to settle one question.
- Not audited: `exampels/README.md` and `hooks/README.md` (prose); `package-lock.json`.
- Taken on trust: Node `fs.watch` recursive semantics on Linux ≥ 20.13; `@modelcontextprotocol/client@2.2.0` `listen()`/`close()` behavior beyond what the probe and check exercised; the OpenAI Chat Completions wire format.
- Security: the app's attack surface is the model's tool calls, which the server validates, and the LLM request carrying the bearer token over the configured base URL (gatekeeper-identical). No new surface; no findings.
- Dismissed: `PROVIDERS[values.provider]` resolving prototype keys (`--provider constructor`) — copied from gatekeeper, user-controlled input to their own process, not this change's defect.
